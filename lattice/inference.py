"""Generation through the cluster with research-grade per-run measurements.

For every run we record client-side timings (TTFT, inter-token latency
distribution), llama.cpp's own timings (prefill/decode speed, draft
acceptance), Prometheus deltas (acceptance per draft position), per-node RPC
traffic and time attribution from the gates, and GPU energy on this node.
"""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import statistics
import time
from collections import deque
from typing import TYPE_CHECKING, Awaitable, Callable

import aiohttp

if TYPE_CHECKING:
    from .node import Node

_PROM_RE = re.compile(r'^llamacpp:([a-z_]+)(\{position="(\d+)"\})?\s+([0-9.eE+-]+)')


def _pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


class Inference:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.path = node.paths.data / "runs.jsonl"
        self.recent: deque[dict] = deque(maxlen=500)
        self.live: dict | None = None
        self._lock = asyncio.Lock()
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines()[-500:]:
                try:
                    self.recent.append(json.loads(line))
                except ValueError:
                    pass
        except FileNotFoundError:
            pass

    async def _prom(self) -> dict:
        out: dict = {"per_pos": {}}
        try:
            async with self.node.http.get(f"{self.node.session.base_url}/metrics",
                                          timeout=aiohttp.ClientTimeout(total=3)) as r:
                text = await r.text()
        except Exception:
            return out
        for line in text.splitlines():
            m = _PROM_RE.match(line)
            if not m:
                continue
            name, pos, val = m.group(1), m.group(3), float(m.group(4))
            if pos is not None:
                out["per_pos"][int(pos)] = val
            else:
                out[name] = val
        return out

    def _config_summary(self) -> dict:
        s = self.node.session
        cfg = s.config or {}
        plan = s.plan or []
        dp = s.draft_plan
        if len(plan) == 1 and not dp:
            mode = "single"
        elif len(plan) > 1 and not dp:
            mode = f"pooled×{len(plan)}"
        elif len(plan) == 1:
            mode = "speculative"
        else:
            mode = f"pooled×{len(plan)}+spec"
        if not dp and cfg.get("spec_type", "none").startswith("ngram"):
            mode += "+ngram"
        return {
            "mode": mode, "target": cfg.get("target"), "draft": cfg.get("draft"),
            "draft_node": dp["name"] if dp else None, "draft_device": dp["device"] if dp else None,
            "draft_max": cfg.get("draft_max") if dp else None,
            "stages": [{"name": p["name"], "device": p["device"], "weight": round(p["weight"], 3),
                        "layers": p["layers"], "direct": p["direct"]} for p in plan],
            "latency_ms": {self.node.session._node_name(k): v for k, v in (cfg.get("latency_ms") or {}).items() if v},
            "ctx": cfg.get("ctx"),
        }

    async def generate(self, messages: list[dict], params: dict,
                       on_event: Callable[[dict], Awaitable[None]] | None = None, tag: str = "chat") -> dict:
        s = self.node.session
        if not s.ready:
            raise RuntimeError("no cluster is running – launch one first")
        async with self._lock:
            return await self._generate(messages, params, on_event, tag)

    async def _generate(self, messages, params, on_event, tag) -> dict:
        s = self.node.session
        g0, p0 = await asyncio.gather(s.gate_counters(), self._prom())
        body = {
            "messages": messages, "stream": True,
            "max_tokens": int(params.get("max_tokens", 512)),
            "temperature": float(params.get("temperature", 0.7)),
            "top_p": float(params.get("top_p", 0.95)),
            "stream_options": {"include_usage": True},
            "cache_prompt": bool(params.get("cache_prompt", True)),
        }
        if params.get("seed") is not None:
            body["seed"] = int(params["seed"])
        t_start = time.perf_counter()
        wall0 = time.time() * 1000
        arrivals: list[float] = []
        pieces: list[str] = []
        reasoning: list[str] = []
        timings, usage, finish = {}, {}, None
        self.live = {"t0": wall0, "tokens": 0, "tps": 0.0, "tag": tag}
        last_emit = 0.0
        try:
            async with self.node.http.post(f"{s.base_url}/v1/chat/completions", json=body,
                                           timeout=aiohttp.ClientTimeout(total=None, sock_read=600)) as r:
                if r.status != 200:
                    raise RuntimeError(f"llama-server HTTP {r.status}: {(await r.text())[:300]}")
                buf = b""
                async for chunk in r.content.iter_any():
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line = line.strip()
                        if not line.startswith(b"data:"):
                            continue
                        data = line[5:].strip()
                        if data == b"[DONE]":
                            continue
                        try:
                            obj = json.loads(data)
                        except ValueError:
                            continue
                        if obj.get("timings"):
                            timings = obj["timings"]
                        if obj.get("usage"):
                            usage = obj["usage"]
                        for ch in obj.get("choices") or []:
                            delta = ch.get("delta") or {}
                            now = time.perf_counter()
                            if delta.get("content"):
                                arrivals.append(now)
                                pieces.append(delta["content"])
                                if on_event:
                                    await on_event({"type": "token", "text": delta["content"],
                                                    "t": (now - t_start) * 1000})
                            if delta.get("reasoning_content"):
                                arrivals.append(now)
                                reasoning.append(delta["reasoning_content"])
                                if on_event:
                                    await on_event({"type": "reasoning", "text": delta["reasoning_content"],
                                                    "t": (now - t_start) * 1000})
                            if ch.get("finish_reason"):
                                finish = ch["finish_reason"]
                        n = len(arrivals)
                        if n and time.perf_counter() - last_emit > 0.25:
                            last_emit = time.perf_counter()
                            el = last_emit - arrivals[0]
                            self.live.update(tokens=n, tps=(n - 1) / el if el > 0 else 0.0)
                            self.node.hub.emit("gen", self.live)
        finally:
            self.live = None
            self.node.hub.emit("gen", None)
        t_end = time.perf_counter()
        g1, p1 = await asyncio.gather(s.gate_counters(), self._prom())
        m = self._metrics(t_start, t_end, wall0, arrivals, timings, usage, g0, g1, p0, p1)
        m["finish"] = finish
        run = {
            "id": secrets.token_hex(5), "ts": wall0, "tag": tag, "config": self._config_summary(),
            "prompt": next((x.get("content", "") for x in reversed(messages) if x.get("role") == "user"), "")[:200],
            "output": ("".join(pieces))[:400], "params": {k: body[k] for k in ("max_tokens", "temperature", "top_p")},
            "metrics": m,
        }
        self.recent.append(run)
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(run) + "\n")
        except OSError:
            pass
        self.node.hub.emit("run", run)
        run["text"] = "".join(pieces)
        run["reasoning"] = "".join(reasoning)
        return run

    def _metrics(self, t_start, t_end, wall0, arrivals, timings, usage, g0, g1, p0, p1) -> dict:
        total_ms = (t_end - t_start) * 1000
        ttft = (arrivals[0] - t_start) * 1000 if arrivals else None
        itl = [(b - a) * 1000 for a, b in zip(arrivals, arrivals[1:])]
        gen_n = int(timings.get("predicted_n") or usage.get("completion_tokens") or len(arrivals))
        draft_n = timings.get("draft_n")
        draft_acc = timings.get("draft_n_accepted")
        m = {
            "total_ms": total_ms, "ttft_ms": ttft,
            "prompt_tokens": timings.get("prompt_n") or usage.get("prompt_tokens"),
            "cached_tokens": timings.get("cache_n"),
            "gen_tokens": gen_n,
            "prompt_tps": timings.get("prompt_per_second"),
            "gen_tps": timings.get("predicted_per_second"),
            "e2e_tps": gen_n / (total_ms / 1000) if total_ms > 0 else None,
            "itl_p50": _pct(itl, 0.5), "itl_p95": _pct(itl, 0.95), "itl_max": max(itl) if itl else None,
            "itl_mean": statistics.fmean(itl) if itl else None,
            "draft_n": draft_n, "draft_accepted": draft_acc,
            "accept_rate": (draft_acc / draft_n) if draft_n else None,
        }
        steps = p1.get("spec_decode_num_drafts_total", 0) - p0.get("spec_decode_num_drafts_total", 0)
        if steps > 0:
            m["spec_steps"] = steps
            m["tokens_per_step"] = gen_n / steps
            pos = sorted(set(p1["per_pos"]) | set(p0["per_pos"]))
            m["accept_by_pos"] = [(p1["per_pos"].get(i, 0) - p0["per_pos"].get(i, 0)) / steps for i in pos]
        nodes = {}
        net = 0
        for nid, a in g1.items():
            b = g0.get(nid, {})
            if not a:
                continue
            d = {k: a.get(k, 0) - b.get(k, 0) for k in ("bytes_c2s", "bytes_s2c", "wait_ms", "waits", "calls", "computes")}
            delay = float(a.get("delay_ms", 0))
            rtt = 0.0 if nid == self.node.id else float(self.node.peers.live.get(nid, {}).get("rtt_best_ms") or 0)
            d["delay_ms"] = delay
            d["rtt_ms"] = rtt
            d["est_compute_ms"] = max(0.0, d["wait_ms"] - d["waits"] * delay)
            d["est_network_ms"] = d["waits"] * (delay + rtt)
            d["name"] = self.node.session._node_name(nid)
            nodes[nid] = d
            net += d["bytes_c2s"] + d["bytes_s2c"]
        m["nodes"] = nodes
        m["net_bytes"] = net
        m["bytes_per_token"] = net / gen_n if gen_n else None
        # GPU energy on this node (NVML), integrated over the 1 Hz telemetry samples in the window
        hist = [x for x in self.node.telemetry.history if wall0 - 1000 <= x["ts"] <= wall0 + total_ms + 1000]
        watts = [sum(g.get("power_w") or 0 for g in x["gpus"]) for x in hist]
        if watts and any(watts):
            m["gpu_power_w"] = statistics.fmean(watts)
            m["gpu_energy_j"] = m["gpu_power_w"] * total_ms / 1000
            m["joules_per_token"] = m["gpu_energy_j"] / gen_n if gen_n else None
        return m

    def runs(self, limit: int = 200) -> list[dict]:
        return list(self.recent)[-limit:]


CSV_FIELDS = ["id", "ts", "tag", "mode", "target", "draft", "draft_node", "draft_max", "stages", "latency",
              "prompt_tokens", "gen_tokens", "ttft_ms", "total_ms", "prompt_tps", "gen_tps", "e2e_tps",
              "itl_p50", "itl_p95", "draft_n", "draft_accepted", "accept_rate", "tokens_per_step",
              "net_bytes", "bytes_per_token", "gpu_power_w", "joules_per_token"]


def run_row(run: dict) -> dict:
    c, m = run.get("config", {}), run.get("metrics", {})
    return {
        "id": run.get("id"), "ts": run.get("ts"), "tag": run.get("tag"), "mode": c.get("mode"),
        "target": c.get("target"), "draft": c.get("draft"), "draft_node": c.get("draft_node"),
        "draft_max": c.get("draft_max"),
        "stages": " | ".join(f"{s['name']}:{s['device']}:{s['weight']}" for s in c.get("stages", [])),
        "latency": json.dumps(c.get("latency_ms") or {}),
        **{k: m.get(k) for k in CSV_FIELDS if k in m},
    }
