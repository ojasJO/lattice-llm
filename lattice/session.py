"""Coordinator: turns a launch config into a running distributed llama-server.

Topology
  * target model split by layers (pipeline parallel) across 1..N nodes
  * optional draft model (speculative decoding) on any one node
  * this node's GPU is used directly; remote nodes (and this node's CPU when it is
    one stage of a multi-node split) are reached through ggml RPC via metered gates.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import TYPE_CHECKING

import aiohttp

from .models import estimate_placement
from .procs import ManagedProcess

if TYPE_CHECKING:
    from .node import Node

STEPS = [
    ("validate", "Validate plan"),
    ("runtime", "Prepare runtimes"),
    ("workers", "Start RPC workers"),
    ("devices", "Discover devices"),
    ("load", "Load weights"),
    ("ready", "Serving"),
]
_RPC_DEV_RE = re.compile(r"^\s+(RPC\d+):\s+(\S+)\s+\((\d+) MiB,\s+(\d+) MiB free\)")
_BUF_RE = re.compile(r"(\S+?)\s+(model|KV|compute) buffer size\s*=\s*([\d.]+) MiB")


class LaunchError(Exception):
    pass


class Session:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.llama = ManagedProcess("llama-server", node.hub)
        self.llama.watchers.append(self._on_log)
        self.state = "idle"
        self.config: dict | None = None
        self.plan: list[dict] = []
        self.draft_plan: dict | None = None
        self.steps: list[dict] = []
        self.error: str | None = None
        self.started_at: float | None = None
        self.ready_at: float | None = None
        self.args: list[str] = []
        self.alloc: dict[str, dict] = {}
        self.baseline: dict[str, int] = {}
        self.progress: dict[str, int] = {}
        self._task: asyncio.Task | None = None
        self._watch: asyncio.Task | None = None
        self.target_meta: dict | None = None
        self.draft_meta: dict | None = None

    # ------------------------------------------------------------------ helpers
    @property
    def busy(self) -> bool:
        return self.state in ("launching", "stopping")

    @property
    def ready(self) -> bool:
        return self.state == "ready" and self.llama.running

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.node.ports.llama}"

    def _step(self, key: str, status: str, detail: str = "") -> None:
        for s in self.steps:
            if s["key"] == key:
                s["status"] = status
                if detail:
                    s["detail"] = detail
                if status == "running":
                    s["t0"] = time.time()
                if status in ("done", "error"):
                    s["t1"] = time.time()
        self.emit()

    def _node_name(self, nid: str) -> str:
        if nid == self.node.id:
            return self.node.name
        return self.node.peers.peers.get(nid, {}).get("name", nid)

    def emit(self) -> None:
        self.node.hub.emit("session", self.view())

    def view(self) -> dict:
        return {
            "state": self.state, "config": self.config, "plan": self.plan, "draft": self.draft_plan,
            "steps": self.steps, "error": self.error, "started_at": self.started_at, "ready_at": self.ready_at,
            "args": self.args, "alloc": self.alloc, "progress": self.progress,
            "process": self.llama.status(), "api": f"{self.base_url}/v1" if self.ready else None,
            "target_meta": _slim(self.target_meta), "draft_meta": _slim(self.draft_meta),
        }

    # ------------------------------------------------------------------ launch
    def launch(self, cfg: dict) -> None:
        if self.busy:
            raise LaunchError("a launch is already in progress")
        self._validate_shape(cfg)
        self.state = "launching"  # set synchronously so callers can wait on it immediately
        self.error = None
        self._task = asyncio.create_task(self._run(cfg))

    def _validate_shape(self, cfg: dict) -> None:
        lib = self.node.models
        if not cfg.get("target") or not lib.get(cfg["target"]):
            raise LaunchError("choose a target model that exists on this node")
        nodes = [n for n in cfg.get("nodes", []) if float(n.get("weight", 1)) > 0]
        if not nodes:
            raise LaunchError("select at least one node for the target model")
        ids = [n["id"] for n in nodes]
        if len(ids) != len(set(ids)):
            raise LaunchError("a node appears twice in the target split")
        if len(ids) > 15:
            raise LaunchError("ggml RPC supports at most 16 servers")
        draft = cfg.get("draft")
        if draft:
            if not lib.get(draft):
                raise LaunchError("draft model not found on this node")
            ok, why = lib.compat(draft, cfg["target"])
            if not ok:
                raise LaunchError(f"draft model is not compatible with the target: {why}")
            if not cfg.get("draft_node"):
                raise LaunchError("choose where the draft model runs")
        for nid in set(ids + ([cfg["draft_node"]] if draft else [])):
            if nid != self.node.id:
                if nid not in self.node.peers.peers:
                    raise LaunchError(f"{nid} is not paired")
                if not self.node.peers.online(nid):
                    raise LaunchError(f"{self._node_name(nid)} is offline")

    def _device_kind(self, nid: str, dev: str | None) -> str:
        if nid == self.node.id:
            d = self.node.runtime.device(dev or "") if dev else None
            return d["kind"] if d else ("cpu" if (dev or "").upper().startswith("CPU") else "gpu")
        info = (self.node.peers.live.get(nid, {}).get("info") or {})
        for d in info.get("devices") or []:
            if d["name"] == dev:
                return d["kind"]
        return "cpu" if (dev or "").upper().startswith("CPU") else "gpu"

    async def _run(self, cfg: dict) -> None:
        # Relaunching over a live cluster: release the old llama-server and workers first. An rpc-server
        # serves one client at a time, so a stale connection would make the new launch hang.
        if self.llama.running or self.plan:
            await self._teardown()
            self.plan, self.draft_plan = [], None
        self.config = cfg
        self.state = "launching"
        self.error = None
        self.alloc, self.progress, self.baseline = {}, {}, {}
        self.args = []
        self.started_at, self.ready_at = time.time(), None
        self.steps = [{"key": k, "label": label, "status": "pending", "detail": "", "nodes": {}} for k, label in STEPS]
        self.node.emit_info()
        current = "validate"
        try:
            # ---------------------------------------------------------- validate & plan
            self._step(current, "running")
            if not self.node.runtime.installed:
                self._step(current, "running", "installing llama.cpp runtime on this node")
            await self.node.runtime.ensure()
            lib = self.node.models
            self.target_meta = lib.get(cfg["target"])
            self.draft_meta = lib.get(cfg["draft"]) if cfg.get("draft") else None
            ctx = int(cfg.get("ctx") or 4096)
            nodes = [n for n in cfg["nodes"] if float(n.get("weight", 1)) > 0]
            weights = [float(n.get("weight", 1)) for n in nodes]
            est = estimate_placement(self.target_meta, weights, ctx)
            via_rpc_self = bool(cfg.get("self_via_rpc"))
            plan = []
            for n, w, e in zip(nodes, weights, est):
                nid = n["id"]
                dev = n.get("device") or (self.node.runtime.default_device() if nid == self.node.id else None)
                kind = self._device_kind(nid, dev) if dev else "gpu"
                direct = nid == self.node.id and not via_rpc_self and (kind != "cpu" or len(nodes) == 1)
                plan.append({"id": nid, "name": self._node_name(nid), "device": dev, "kind": kind,
                             "weight": w, "direct": direct, "layers": e["layers"], "n_layers": e["n_layers"],
                             "est_weights": e["weights"], "est_kv": e["kv"], "est_total": e["total"],
                             "endpoint": None, "rpc_name": None, "roles": ["target"]})
            self.plan = plan
            dp = None
            if self.draft_meta:
                dn = cfg["draft_node"]
                ddev = cfg.get("draft_device") or (self.node.runtime.default_device() if dn == self.node.id else None)
                dkind = self._device_kind(dn, ddev) if ddev else "gpu"
                dp = {"id": dn, "name": self._node_name(dn), "device": ddev, "kind": dkind,
                      "direct": dn == self.node.id and not via_rpc_self, "endpoint": None, "rpc_name": None,
                      "est_weights": self.draft_meta["size"]}
                for p in plan:
                    if p["id"] == dn:
                        p["roles"].append("draft")
            self.draft_plan = dp
            self._step(current, "done", f"{len(plan)} stage(s)" + (" + draft" if dp else ""))

            # nodes that must expose an rpc-server (one device each)
            rpc_nodes: dict[str, dict] = {}
            for p in plan:
                if not p["direct"]:
                    rpc_nodes.setdefault(p["id"], {"device": p["device"]})
            if dp and not dp["direct"]:
                if dp["id"] in rpc_nodes and rpc_nodes[dp["id"]]["device"] not in (None, dp["device"]):
                    raise LaunchError("draft and target on the same remote node must use the same device")
                rpc_nodes.setdefault(dp["id"], {"device": dp["device"]})

            # ---------------------------------------------------------- runtimes
            current = "runtime"
            self._step(current, "running")
            st = self.steps[1]["nodes"]

            async def prep(nid: str):
                st[nid] = {"status": "running", "detail": "checking runtime"}
                self.emit()
                if nid == self.node.id:
                    await self.node.runtime.ensure()
                    devs = self.node.runtime.devices
                else:
                    r = await self.node.peers.call(nid, "POST", "/peer/worker/prepare", json={}, timeout=900)
                    devs = r.get("devices", [])
                st[nid] = {"status": "done", "detail": f"{len(devs)} device(s)"}
                self.emit()

            await asyncio.gather(*(prep(n) for n in {self.node.id, *rpc_nodes}))
            self._step(current, "done")

            # ---------------------------------------------------------- workers
            current = "workers"
            self._step(current, "running")
            wt = self.steps[2]["nodes"]
            lat = cfg.get("latency_ms") or {}
            endpoints: dict[str, str] = {}

            async def start_worker(nid: str, spec: dict):
                wt[nid] = {"status": "running", "detail": "starting rpc-server"}
                self.emit()
                body = {"coordinator": self.node.public_info(), "device": spec["device"],
                        "threads": int(cfg.get("worker_threads") or 0), "delay_ms": float(lat.get(nid, 0))}
                if nid == self.node.id:
                    r = await self.node.runtime.worker_start(self.node.public_info(), spec["device"],
                                                             body["threads"], body["delay_ms"], "127.0.0.1")
                    endpoints[nid] = f"127.0.0.1:{r['gate_port']}"
                else:
                    r = await self.node.peers.call(nid, "POST", "/peer/worker/start", json=body, timeout=900)
                    endpoints[nid] = f"{self.node.peers.peers[nid]['host']}:{r['gate_port']}"
                for p in plan:
                    if p["id"] == nid and not p["direct"]:
                        p["device"] = r["device"]
                        p["endpoint"] = endpoints[nid]
                if dp and dp["id"] == nid and not dp["direct"]:
                    dp["device"] = r["device"]
                    dp["endpoint"] = endpoints[nid]
                wt[nid] = {"status": "done", "detail": f"{r['device']} via {endpoints[nid]}"}
                self.emit()

            if rpc_nodes:
                await asyncio.gather(*(start_worker(n, s) for n, s in rpc_nodes.items()))
                self._step(current, "done", f"{len(rpc_nodes)} worker(s)")
            else:
                self._step(current, "done", "not needed (single node, direct device)")
            order = [p["id"] for p in plan if not p["direct"]]
            if dp and not dp["direct"] and dp["id"] not in order:
                order.append(dp["id"])
            eps = [endpoints[n] for n in order]

            # ---------------------------------------------------------- devices
            current = "devices"
            self._step(current, "running")
            names: dict[str, str] = {}
            if eps:
                names = await self._list_rpc_devices(eps)
                for p in plan:
                    if not p["direct"]:
                        p["rpc_name"] = names.get(p["endpoint"])
                        if not p["rpc_name"]:
                            raise LaunchError(f"no RPC device reported for {p['name']} ({p['endpoint']})")
                if dp and not dp["direct"]:
                    dp["rpc_name"] = names.get(dp["endpoint"])
                self._step(current, "done", ", ".join(f"{k}→{v}" for k, v in names.items()))
            else:
                self._step(current, "done", "local devices only")

            # ---------------------------------------------------------- llama-server
            current = "load"
            self._step(current, "running")
            self.args = self._build_args(cfg, plan, dp, eps)
            env = {"GGML_RPC_NO_COMM": "1", "LLAMA_CACHE": str(self.node.paths.llama_cache)}
            for nid in order:
                self.baseline[nid] = (await self._gate_counters(nid)).get("bytes_c2s", 0)
            await self.llama.start(self.args, cwd=self.node.paths.llama_dir, env=env,
                                   log_file=self.node.paths.logs / "llama-server.log")
            await self._wait_healthy(order)
            self._step(current, "running", "warming up (shader compilation, first graph)")
            await self._warmup()
            self._step(current, "done", f"{time.time() - self.steps[4]['t0']:.1f}s incl. warm-up")
            self.state = "ready"
            self.ready_at = time.time()
            self._step("ready", "done", f"OpenAI-compatible API at {self.base_url}/v1")
            self.node.hub.event("session", f"Cluster ready: {cfg['target']} on {len(plan)} stage(s)"
                                + (f" + draft on {dp['name']}" if dp else ""), level="success", toast=True)
            self._watch = asyncio.create_task(self._watchdog())
        except Exception as e:
            msg = str(e) or type(e).__name__
            self.error = msg
            self.state = "error"
            self._step(current, "error", msg)
            self.node.hub.event("session", f"Launch failed: {msg}", level="error", toast=True)
            await self._teardown()
            self.state = "error"
        finally:
            self.emit()
            self.node.emit_info()

    def _build_args(self, cfg: dict, plan: list[dict], dp: dict | None, eps: list[str]) -> list[str]:
        p = self.node.paths
        args = [str(p.llama_server), "-m", str(self.node.models.path(cfg["target"])),
                "--host", "127.0.0.1", "--port", str(self.node.ports.llama),
                "-c", str(int(cfg.get("ctx") or 4096)), "-np", "1", "--metrics", "--no-webui",
                "--fit", "off", "--log-colors", "off", "-lv", "4"]
        if eps:
            args += ["--rpc", ",".join(eps)]
        devs = []
        for s in plan:
            if s["direct"]:
                devs.append("none" if s["kind"] == "cpu" else s["device"])
            else:
                devs.append(s["rpc_name"])
        if devs == ["none"]:
            args += ["--device", "none", "-ngl", "0"]
        else:
            args += ["--device", ",".join(devs), "-ngl", "all", "-sm", "layer"]
            if len(devs) > 1:
                args += ["-ts", ",".join(f"{s['weight']:.4f}" for s in plan)]
        if dp:
            if dp["direct"]:
                ddev, ngld = ("none", "0") if dp["kind"] == "cpu" else (dp["device"], "all")
            else:
                ddev, ngld = dp["rpc_name"], "all"
            args += ["-md", str(self.node.models.path(cfg["draft"])), "--spec-type", "draft-simple",
                     "--spec-draft-device", ddev, "-ngld", ngld,
                     "--spec-draft-n-max", str(int(cfg.get("draft_max", 8))),
                     "--spec-draft-n-min", str(int(cfg.get("draft_min", 0))),
                     "--spec-draft-p-min", f"{float(cfg.get('draft_p_min', 0.0)):.2f}"]
        elif cfg.get("spec_type", "none").startswith("ngram"):
            args += ["--spec-type", cfg["spec_type"]]
        if int(cfg.get("threads") or 0):
            args += ["-t", str(int(cfg["threads"]))]
        return args

    async def _list_rpc_devices(self, eps: list[str]) -> dict[str, str]:
        import subprocess
        import sys
        kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
        proc = await asyncio.create_subprocess_exec(
            str(self.node.paths.llama_server), "--rpc", ",".join(eps), "--list-devices",
            cwd=str(self.node.paths.llama_dir), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env={**__import__("os").environ, "GGML_RPC_NO_COMM": "1"}, **kw)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 60)
        except asyncio.TimeoutError:
            proc.kill()
            raise LaunchError("timed out while listing RPC devices (is a worker unreachable?)")
        text = out.decode(errors="replace")
        names: dict[str, str] = {}
        for line in text.splitlines():
            m = _RPC_DEV_RE.match(line)
            if m and m.group(2) not in names:
                names[m.group(2)] = m.group(1)
        missing = [e for e in eps if e not in names]
        if missing:
            tail = " | ".join(text.strip().splitlines()[-4:])
            raise LaunchError(f"could not reach RPC worker(s) {', '.join(missing)}: {tail}")
        return names

    def _on_log(self, line: str) -> None:
        m = _BUF_RE.search(line)
        if m:
            dev, kind, mib = m.group(1), m.group(2).lower(), float(m.group(3))
            self.alloc.setdefault(dev, {})[kind] = self.alloc.get(dev, {}).get(kind, 0.0) + mib

    async def _gate_counters(self, nid: str) -> dict:
        if nid == self.node.id:
            return self.node.runtime.gate.stats.counters() | {"delay_ms": self.node.runtime.gate.delay_ms}
        try:
            r = await self.node.peers.call(nid, "GET", "/peer/gate/stats", timeout=3)
            return r.get("counters", {}) | {"delay_ms": r.get("delay_ms", 0)}
        except Exception:
            return {}

    async def gate_counters(self) -> dict[str, dict]:
        nids = sorted({p["id"] for p in self.plan if not p["direct"]}
                      | ({self.draft_plan["id"]} if self.draft_plan and not self.draft_plan["direct"] else set()))
        res = await asyncio.gather(*(self._gate_counters(n) for n in nids))
        return dict(zip(nids, res))

    async def _wait_healthy(self, rpc_order: list[str]) -> None:
        deadline = time.time() + 30 * 60
        last_progress = 0.0
        while time.time() < deadline:
            if not self.llama.running:
                tail = [l for l in self.llama.tail(30) if " E " in l or "error" in l.lower()][-3:] or self.llama.tail(3)
                raise LaunchError("llama-server exited: " + " | ".join(tail))
            try:
                async with self.node.http.get(f"{self.base_url}/health",
                                              timeout=aiohttp.ClientTimeout(total=2)) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            if time.time() - last_progress > 0.5:
                last_progress = time.time()
                for nid in rpc_order:
                    if nid == self.node.id:
                        c = self.node.runtime.gate.stats.bytes_c2s
                    else:
                        c = ((self.node.peers.live.get(nid, {}).get("gate") or {}).get("bytes_c2s") or 0)
                    self.progress[nid] = max(0, c - self.baseline.get(nid, 0))
                self.emit()
            await asyncio.sleep(0.4)
        raise LaunchError("model load timed out")

    async def _warmup(self) -> None:
        """One tiny generation so GPU pipelines/graphs are built before anyone measures."""
        body = {"messages": [{"role": "user", "content": "Hi"}], "max_tokens": 4, "temperature": 0,
                "cache_prompt": False}
        try:
            async with self.node.http.post(f"{self.base_url}/v1/chat/completions", json=body,
                                           timeout=aiohttp.ClientTimeout(total=180)) as r:
                await r.read()
        except Exception:
            pass

    async def _watchdog(self) -> None:
        while self.state == "ready":
            await asyncio.sleep(1.0)
            if not self.llama.running and self.state == "ready":
                self.state = "error"
                self.error = "llama-server stopped unexpectedly: " + " | ".join(self.llama.tail(3))
                self.node.hub.event("session", self.error, level="error", toast=True)
                await self._teardown()
                self.state = "error"
                self.emit()
                self.node.emit_info()

    # ------------------------------------------------------------------ control
    async def set_latency(self, nid: str, ms: float) -> None:
        ms = max(0.0, min(float(ms), 2000.0))
        if self.config is not None:
            self.config.setdefault("latency_ms", {})[nid] = ms
        if nid == self.node.id:
            self.node.runtime.set_delay(ms)
        else:
            await self.node.peers.call(nid, "POST", "/peer/worker/latency", json={"ms": ms}, timeout=3)
        self.emit()

    async def stop(self, reason: str = "stopped by user") -> None:
        if self.state == "idle":
            return
        self.state = "stopping"
        self.emit()
        await self._teardown()
        self.state = "idle"
        self.ready_at = None
        self.node.hub.event("session", f"Cluster stopped ({reason})")
        self.emit()
        self.node.emit_info()

    async def _teardown(self) -> None:
        if self._watch and self._watch is not asyncio.current_task():
            self._watch.cancel()
        await self.llama.stop()
        nids = {p["id"] for p in self.plan if not p.get("direct")}
        if self.draft_plan and not self.draft_plan.get("direct"):
            nids.add(self.draft_plan["id"])
        for nid in nids:
            try:
                if nid == self.node.id:
                    await self.node.runtime.worker_stop()
                else:
                    await self.node.peers.call(nid, "POST", "/peer/worker/stop", json={}, timeout=5)
            except Exception:
                pass


def _slim(meta: dict | None) -> dict | None:
    if not meta:
        return None
    keys = ("file", "name", "arch", "size", "quant", "size_label", "n_params", "n_layers", "n_embd",
            "n_head", "n_head_kv", "ctx_train", "vocab_size", "layer_bytes", "embd_bytes", "output_bytes",
            "kv_bytes_per_token_layer")
    return {k: meta.get(k) for k in keys}
