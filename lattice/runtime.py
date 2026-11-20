"""llama.cpp runtime: install (LAN-first), device probing, and the worker role
(ggml rpc-server on loopback + metered gate on the LAN)."""
from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import sys
import time
import zipfile
from typing import TYPE_CHECKING

from .config import LLAMA_ASSET, LLAMA_ASSET_SIZE, LLAMA_LABEL, LLAMA_TAG, LLAMA_URL, RPC_PROTO
from .gate import Gate
from .procs import ManagedProcess

if TYPE_CHECKING:
    from .node import Node

_DEV_RE = re.compile(r"^\s+(\S+):\s+(.*)\s+\((\d+) MiB,\s+(\d+) MiB free\)\s*$")


def classify_device(name: str, desc: str) -> str:
    if name.upper().startswith("CPU"):
        return "cpu"
    d = desc.lower()
    if ("intel" in d and "arc" not in d) or re.search(r"radeon(\(tm\))? graphics$|vega \d+ graphics", d):
        return "igpu"
    return "gpu"


class Runtime:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.paths = node.paths
        self.devices: list[dict] = []
        self.rpc = ManagedProcess("rpc-server", node.hub)
        self.gate = Gate(node.ports.gate, node.ports.rpc)
        self.worker: dict | None = None
        self._lock = asyncio.Lock()
        self.install_error: str | None = None

    # ------------------------------------------------------------------ install
    @property
    def installed(self) -> bool:
        return self.paths.runtime_installed

    @property
    def dist_zip(self):
        return self.paths.dist / LLAMA_ASSET

    def has_dist(self) -> bool:
        return self.dist_zip.exists() and self.dist_zip.stat().st_size == LLAMA_ASSET_SIZE

    def files_listing(self) -> list[dict]:
        return [{"name": LLAMA_ASSET, "size": LLAMA_ASSET_SIZE}] if self.has_dist() else []

    async def ensure(self, prefer_peer: str | None = None) -> None:
        if self.installed:
            if not self.devices:
                await self.probe_devices()
            return
        async with self._lock:
            if self.installed:
                return
            self.install_error = None
            self.node.hub.event("runtime", f"Installing {LLAMA_LABEL}…")
            if not self.has_dist():
                sources = []
                peer_ids = [p for p in self.node.peers.peers if self.node.peers.online(p)]
                if prefer_peer in peer_ids:
                    peer_ids.remove(prefer_peer)
                    peer_ids.insert(0, prefer_peer)
                for pid in peer_ids:
                    files = (self.node.peers.live.get(pid, {}).get("files") or {}).get("runtime", [])
                    if pid == prefer_peer or any(f["name"] == LLAMA_ASSET for f in files):
                        sources.append({"type": "peer", "peer_id": pid,
                                        "label": self.node.peers.peers[pid]["name"]})
                sources.append({"type": "url", "url": LLAMA_URL, "label": "github.com"})
                d = self.node.downloads.add("runtime", LLAMA_ASSET, self.dist_zip, sources, LLAMA_ASSET_SIZE)
                await self.node.downloads.wait(d)
                if d.status != "done":
                    self.install_error = d.error or d.status
                    raise RuntimeError(f"runtime download failed: {self.install_error}")
            await asyncio.get_running_loop().run_in_executor(None, self._extract)
            await self.probe_devices()
            self.node.hub.event("runtime", f"{LLAMA_LABEL} installed", level="success", toast=True)
            self.node.emit_info()

    def _extract(self) -> None:
        tmp = self.paths.llama_dir.with_name(self.paths.llama_dir.name + ".tmp")
        if tmp.exists():
            shutil.rmtree(tmp)
        with zipfile.ZipFile(self.dist_zip) as z:
            z.extractall(tmp)
        # some archives nest everything in a folder
        inner = [p for p in tmp.iterdir()]
        if len(inner) == 1 and inner[0].is_dir():
            inner[0].rename(tmp.with_name(tmp.name + "2"))
            shutil.rmtree(tmp)
            tmp = tmp.with_name(tmp.name + "2")
        if self.paths.llama_dir.exists():
            shutil.rmtree(self.paths.llama_dir)
        tmp.rename(self.paths.llama_dir)

    async def probe_devices(self) -> list[dict]:
        if not self.installed:
            return []
        kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
        proc = await asyncio.create_subprocess_exec(
            str(self.paths.rpc_server), "-d", "__lattice_probe__", cwd=str(self.paths.llama_dir),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, **kw)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 30)
        except asyncio.TimeoutError:
            proc.kill()
            return self.devices
        devs = []
        for line in out.decode(errors="replace").splitlines():
            m = _DEV_RE.match(line)
            if m:
                name, desc = m.group(1), m.group(2).strip()
                devs.append({"name": name, "desc": desc, "total_mb": int(m.group(3)),
                             "free_mb": int(m.group(4)), "kind": classify_device(name, desc)})
        self.devices = devs
        return devs

    def default_device(self) -> str:
        pref = self.node.settings.data.get("worker_device", "auto")
        names = {d["name"] for d in self.devices}
        if pref != "auto" and pref in names:
            return pref
        gpus = [d for d in self.devices if d["kind"] == "gpu" and d["total_mb"] >= 3000]
        if gpus:
            return max(gpus, key=lambda d: d["total_mb"])["name"]
        return "CPU"

    def device(self, name: str) -> dict | None:
        return next((d for d in self.devices if d["name"] == name), None)

    # ------------------------------------------------------------------ worker role
    async def worker_start(self, coordinator: dict, device: str | None, threads: int | None,
                           delay_ms: float, allow_ip: str) -> dict:
        if self.worker and self.worker["coordinator_id"] != coordinator["id"] and self.rpc.running:
            raise RuntimeError(f"busy: already serving {self.worker['coordinator_name']}")
        remote = coordinator["id"] != self.node.id
        await self.ensure(prefer_peer=coordinator["id"] if remote else None)
        if not self.devices:
            await self.probe_devices()
        dev = device if device and self.device(device) else self.default_device()
        threads = threads or int(self.node.settings.data.get("worker_threads") or 0)
        args = [str(self.paths.rpc_server), "-H", "127.0.0.1", "-p", str(self.node.ports.rpc), "-d", dev, "-c"]
        if threads:
            args += ["-t", str(threads)]
        if not self.rpc.running or self.rpc.args[:len(args)] != args:
            await self.rpc.start(args, cwd=self.paths.llama_dir, env={"LLAMA_CACHE": str(self.paths.llama_cache)},
                                 log_file=self.paths.logs / "rpc-server.log")
            await self._wait_port(self.node.ports.rpc, 30)
        await self.gate.start()
        self.gate.allow = {allow_ip} if allow_ip else set()
        self.gate.delay_ms = float(delay_ms or 0)
        self.worker = {
            "coordinator_id": coordinator["id"], "coordinator_name": coordinator.get("name", "?"),
            "device": dev, "device_info": self.device(dev), "since": time.time(), "remote": remote,
        }
        if remote:
            self.node.hub.event("worker", f"Serving compute for {coordinator.get('name')} on {dev}",
                                level="info", toast=True)
        self.node.emit_info()
        return {"gate_port": self.node.ports.gate, "device": dev, "device_info": self.device(dev),
                "rpc_proto": RPC_PROTO, "tag": LLAMA_TAG}

    async def _wait_port(self, port: int, timeout: float) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.rpc.running:
                raise RuntimeError("rpc-server exited: " + " | ".join(self.rpc.tail(5)))
            try:
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.close()
                return
            except OSError:
                await asyncio.sleep(0.25)
        raise RuntimeError("rpc-server did not start listening")

    async def worker_stop(self, reason: str = "") -> None:
        was = self.worker
        await self.gate.stop()
        await self.rpc.stop()
        self.worker = None
        if was and was.get("remote"):
            self.node.hub.event("worker", f"Stopped serving {was['coordinator_name']}{(' – ' + reason) if reason else ''}",
                                level="info", toast=True)
        self.node.emit_info()

    def set_delay(self, ms: float) -> None:
        self.gate.delay_ms = max(0.0, float(ms))

    def worker_view(self) -> dict | None:
        if not self.worker:
            return None
        return {**self.worker, "rpc": self.rpc.status(), "gate": self.gate.status()}

    def status(self) -> dict:
        return {"installed": self.installed, "tag": LLAMA_TAG, "label": LLAMA_LABEL, "rpc_proto": RPC_PROTO,
                "devices": self.devices, "default_device": self.default_device() if self.devices else None,
                "has_dist": self.has_dist(), "error": self.install_error}
