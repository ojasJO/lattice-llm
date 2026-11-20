"""1 Hz system sampler: CPU, memory, GPUs, network, battery and Lattice's own share."""
from __future__ import annotations

import asyncio
import os
from collections import deque
from typing import Callable

import psutil

from .util import now_ms
from .winmetrics import Nvml, Pdh, dxgi_adapters


class Telemetry:
    def __init__(self, own_pids: Callable[[], set[int]]) -> None:
        self.own_pids = own_pids
        self.adapters = dxgi_adapters()
        self.pdh = Pdh()
        self.nvml = Nvml()
        self.history: deque[dict] = deque(maxlen=600)
        self.latest: dict | None = None
        self._procs: dict[int, psutil.Process] = {}
        self._net_prev: tuple[float, int, int] | None = None
        self.ncpu = psutil.cpu_count(logical=True) or 1
        psutil.cpu_percent(percpu=True)

    def static_info(self) -> list[dict]:
        return [{"name": a["name"], "vendor": a["vendor"], "vram": a["vram"], "integrated": a["integrated"]}
                for a in self.adapters]

    def sample(self) -> dict:
        ts = now_ms()
        per = psutil.cpu_percent(percpu=True)
        vm = psutil.virtual_memory()
        pids = set(self.own_pids()) | {os.getpid()}
        pd = self.pdh.sample(pids) if self.pdh.ok else {}
        nv = self.nvml.sample() if self.nvml.ok else {}

        gpus = []
        for a in self.adapters:
            pa = pd.get("adapters", {}).get(a["luid"], {})
            integrated = a["integrated"]
            g = {
                "name": a["name"], "vendor": a["vendor"], "integrated": integrated,
                "util": pa.get("util"), "ours": pa.get("ours"),
                "mem_used": pa.get("shared" if integrated else "dedicated"),
                "mem_total": a["shared"] if integrated else a["vram"],
            }
            nd = nv.get(a["name"])
            if nd:
                g.update({k: nd[k] for k in ("temp_c", "power_w", "clock_mhz") if k in nd})
                if g["util"] is None:
                    g["util"] = nd.get("util")
                if g["mem_used"] is None:
                    g["mem_used"] = nd.get("mem_used")
            gpus.append(g)

        lat_cpu, lat_rss = 0.0, 0
        for pid in pids:
            p = self._procs.get(pid)
            try:
                if p is None:
                    p = self._procs[pid] = psutil.Process(pid)
                    p.cpu_percent(None)
                    continue
                lat_cpu += p.cpu_percent(None) / self.ncpu
                lat_rss += p.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                self._procs.pop(pid, None)
        for pid in list(self._procs):
            if pid not in pids:
                self._procs.pop(pid, None)

        net = psutil.net_io_counters()
        tx = rx = 0.0
        if self._net_prev:
            dt = max((ts - self._net_prev[0]) / 1000.0, 1e-3)
            tx = (net.bytes_sent - self._net_prev[1]) / dt
            rx = (net.bytes_recv - self._net_prev[2]) / dt
        self._net_prev = (ts, net.bytes_sent, net.bytes_recv)

        batt = None
        try:
            b = psutil.sensors_battery()
            if b is not None:
                batt = {"pct": b.percent, "plugged": b.power_plugged}
        except Exception:
            pass

        s = {
            "ts": ts,
            "cpu": {
                "util": sum(per) / len(per) if per else 0.0,
                "cores": [round(x) for x in per],
                "eff_mhz": pd.get("cpu_eff_mhz"),
                "base_mhz": pd.get("cpu_base_mhz"),
                "perf_pct": pd.get("cpu_perf_pct"),
            },
            "mem": {"total": vm.total, "used": vm.total - vm.available, "avail": vm.available, "pct": vm.percent},
            "gpus": gpus,
            "lattice": {"cpu": lat_cpu, "rss": lat_rss,
                        "gpu": max((g["ours"] or 0.0) for g in gpus) if gpus else 0.0},
            "net": {"tx": tx, "rx": rx},
            "battery": batt,
        }
        self.latest = s
        self.history.append(s)
        return s

    async def run(self, on_sample: Callable[[dict], None]) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                s = await loop.run_in_executor(None, self.sample)
                on_sample(s)
            except Exception as e:  # never let telemetry kill the node
                print(f"[telemetry] {e!r}")
            await asyncio.sleep(1.0)

    def compact(self, s: dict | None = None) -> dict | None:
        """Smaller sample for peer heartbeats."""
        s = s or self.latest
        if not s:
            return None
        return {k: v for k, v in s.items() if k != "cpu"} | {
            "cpu": {k: v for k, v in s["cpu"].items() if k != "cores"} | {"n": len(s["cpu"]["cores"])}
        }
