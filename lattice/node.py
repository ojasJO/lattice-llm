"""A Lattice node: wires discovery, peers, runtime, sessions and telemetry together."""
from __future__ import annotations

import asyncio
import platform
import sys
import time
from pathlib import Path

import aiohttp
import psutil

from .config import (LLAMA_TAG, PROTOCOL, RPC_PROTO, VERSION, Paths, Ports, load_identity,
                     load_settings)
from .discovery import Discovery
from .downloads import DownloadManager
from .experiments import Experiments
from .hub import Hub
from .inference import Inference
from .models import ModelLibrary
from .peers import PeerManager
from .runtime import Runtime
from .session import Session
from .telemetry import Telemetry
from .util import primary_ip


def cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
        except OSError:
            pass
    return platform.processor() or "CPU"


class Node:
    def __init__(self, home: Path, port: int, name: str | None = None, discovery: bool = True) -> None:
        self.paths = Paths(home)
        self.ports = Ports(port)
        self.identity = load_identity(self.paths, name)
        self.settings = load_settings(self.paths)
        self.hub = Hub()
        self.http: aiohttp.ClientSession | None = None
        self.peers = PeerManager(self)
        self.discovery = Discovery(self)
        self.discovery_enabled = discovery
        self.downloads = DownloadManager(self)
        self.models = ModelLibrary(self)
        self.runtime = Runtime(self)
        self.session = Session(self)
        self.inference = Inference(self)
        self.experiments = Experiments(self)
        self.telemetry = Telemetry(self.own_pids)
        self.lan_ip = primary_ip()
        self.started = time.time()
        self._hw: dict | None = None

    # ------------------------------------------------------------------ identity
    @property
    def id(self) -> str:
        return self.identity.data["id"]

    @property
    def name(self) -> str:
        return self.identity.data["name"]

    def rename(self, name: str) -> None:
        name = name.strip()[:40]
        if name:
            self.identity.data["name"] = name
            self.identity.save()
            self.emit_info()

    def own_pids(self) -> set[int]:
        return {p for p in (self.runtime.rpc.pid, self.session.llama.pid) if p}

    def hw(self) -> dict:
        if self._hw is None:
            vm = psutil.virtual_memory()
            self._hw = {
                "cpu": cpu_name(), "cores": psutil.cpu_count(logical=False), "threads": psutil.cpu_count(),
                "ram": vm.total, "gpus": self.telemetry.static_info(),
                "os": f"{platform.system()} {platform.release()} ({platform.version()})",
                "battery": psutil.sensors_battery() is not None if hasattr(psutil, "sensors_battery") else False,
            }
        return self._hw

    def role(self) -> str:
        if self.session.state in ("launching", "ready", "stopping"):
            return "coordinator"
        if self.runtime.worker and self.runtime.worker.get("remote"):
            return "worker"
        return "idle"

    def beacon_info(self) -> dict:
        hw = self.hw()
        return {"id": self.id, "name": self.name, "port": self.ports.http, "v": VERSION,
                "state": self.role(), "cpu": hw["cpu"], "ram": hw["ram"],
                "gpus": [g["name"] for g in hw["gpus"] if not g["integrated"]][:2],
                "runtime": self.runtime.installed}

    def public_info(self) -> dict:
        return {"id": self.id, "name": self.name, "port": self.ports.http, "version": VERSION,
                "proto": PROTOCOL, "rpc_proto": RPC_PROTO, "llama_tag": LLAMA_TAG, "hw": self.hw(),
                "devices": self.runtime.devices, "default_device": self.runtime.default_device() if self.runtime.devices else None,
                "runtime": self.runtime.installed, "role": self.role(),
                "serving_for": (self.runtime.worker or {}).get("coordinator_name") if self.role() == "worker" else None,
                "models": len(self.models.models)}

    def self_view(self) -> dict:
        return {**self.public_info(), "lan_ip": self.lan_ip, "ports": self.ports.as_dict(),
                "home": str(self.paths.home), "settings": self.settings.data,
                "discovery": self.discovery.status(), "worker": self.runtime.worker_view(),
                "runtime_status": self.runtime.status(), "uptime": time.time() - self.started}

    def emit_info(self) -> None:
        self.hub.emit("self", self.self_view())

    def snapshot(self) -> dict:
        return {
            "self": self.self_view(), "nearby": self.discovery.view(), "peers": self.peers.view(),
            "pairing": self.peers.pending_view(), "session": self.session.view(),
            "downloads": self.downloads.view(), "models": self.models.list(),
            "catalog": self.models.catalog_view(), "telemetry": list(self.telemetry.history)[-120:],
            "gate": self.runtime.gate.stats.snapshot(full=True) if self.runtime.gate.running else None,
            "events": list(self.hub.events)[-150:], "runs": self.inference.runs(100),
            "experiments": self.experiments.list(),
            "experiment": ({k: v for k, v in self.experiments.current.items() if k != "rows"}
                           if self.experiments.current else None),
            "logs": {"llama-server": self.session.llama.tail(300), "rpc-server": self.runtime.rpc.tail(300)},
        }

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self.hub.bind(loop)
        self.http = aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=64, force_close=False))
        await self.models.scan()
        if self.runtime.installed:
            await self.runtime.probe_devices()
        if self.discovery_enabled:
            try:
                await self.discovery.start()
            except OSError as e:
                self.discovery.errors.append(str(e))
        asyncio.create_task(self.telemetry.run(self._on_sample))
        asyncio.create_task(self.peers.heartbeat_loop())
        asyncio.create_task(self._peer_files_loop())
        asyncio.create_task(self._worker_watchdog())
        self.hub.event("node", f"{self.name} started on {self.lan_ip}:{self.ports.http}")

    def _on_sample(self, s: dict) -> None:
        gate = self.runtime.gate.stats.snapshot() if self.runtime.gate.running else None
        self.hub.emit("telemetry", {"id": self.id, "s": s, "gate": gate})

    async def _peer_files_loop(self) -> None:
        while True:
            for pid in list(self.peers.peers):
                if not self.peers.online(pid):
                    continue
                try:
                    files = await self.peers.call(pid, "GET", "/peer/files", timeout=4)
                    self.peers.live.setdefault(pid, {})["files"] = files
                except Exception:
                    pass
            self.hub.emit("catalog", self.models.catalog_view())
            await asyncio.sleep(8)

    async def _worker_watchdog(self) -> None:
        offline_since: float | None = None
        while True:
            await asyncio.sleep(5)
            w = self.runtime.worker
            if not w or not w.get("remote"):
                offline_since = None
                continue
            cid = w["coordinator_id"]
            if self.peers.online(cid) or self.runtime.gate.stats.connections > 0:
                offline_since = None
                continue
            offline_since = offline_since or time.time()
            if time.time() - offline_since > 45:
                await self.runtime.worker_stop("coordinator went offline")
                offline_since = None

    async def shutdown(self) -> None:
        try:
            if self.experiments.current:
                self.experiments.cancel()
            await self.session.stop("shutdown")
            await self.runtime.worker_stop()
        finally:
            if self.http:
                await self.http.close()
