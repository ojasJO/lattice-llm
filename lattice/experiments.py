"""Automated sweeps: topology × draft length × injected network latency.

Each arm runs a fixed prompt suite with greedy decoding and a fixed seed so the
arms are comparable; results are aggregated (mean, std) and saved as JSON/CSV.
"""
from __future__ import annotations

import asyncio
import copy
import csv
import io
import json
import secrets
import statistics
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .node import Node

PROMPTS = {
    "code": ("Code", "Write a Python function that returns the n-th Fibonacci number using memoization. "
                     "Include a docstring and three doctest examples."),
    "json": ("Structured", "Return a JSON array containing the first 25 prime numbers. Output only the JSON."),
    "explain": ("Explanation", "Explain how the TCP three-way handshake works and why it is needed, in about 150 words."),
    "story": ("Creative", "Write the opening paragraph of a mystery story set in a lighthouse during a storm."),
    "math": ("Reasoning", "A train leaves at 9:40 and travels 210 km at 84 km/h. At what time does it arrive? "
                          "Show your reasoning step by step."),
    "translate": ("Translation", "Translate into French: \"Distributed systems are collections of independent "
                                 "computers that appear to their users as a single coherent system.\""),
}

AGG_KEYS = ["gen_tps", "e2e_tps", "ttft_ms", "accept_rate", "tokens_per_step", "itl_p50", "itl_p95",
            "bytes_per_token", "joules_per_token", "gen_tokens"]


class ExperimentError(Exception):
    pass


class Experiments:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.dir = node.paths.experiments
        self.current: dict | None = None
        self._task: asyncio.Task | None = None
        self._cancel = False

    # ------------------------------------------------------------------ storage
    def list(self) -> list[dict]:
        out = []
        cur = self.current
        if cur:
            out.append({k: cur.get(k) for k in ("id", "name", "status", "created", "finished", "progress", "error")}
                       | {"arms": len(cur.get("arms", []))})
        for p in sorted(self.dir.glob("*.json"), key=lambda x: -x.stat().st_mtime):
            if cur and p.stem == cur["id"]:
                continue
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                out.append({k: d.get(k) for k in ("id", "name", "status", "created", "finished", "progress", "error")}
                           | {"arms": len(d.get("arms", []))})
            except (OSError, ValueError):
                continue
        return out

    def get(self, eid: str) -> dict | None:
        if self.current and self.current["id"] == eid:
            return self.current
        p = self.dir / f"{eid}.json"
        if not p.exists() or "/" in eid or "\\" in eid:
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def delete(self, eid: str) -> None:
        if self.current and self.current["id"] == eid:
            raise ExperimentError("experiment is running")
        p = self.dir / f"{eid}.json"
        if p.exists() and "/" not in eid and "\\" not in eid:
            p.unlink()

    def _save(self, exp: dict) -> None:
        (self.dir / f"{exp['id']}.json").write_text(json.dumps(exp, indent=1), encoding="utf-8")

    def emit(self) -> None:
        exp = self.current
        if exp:
            self.node.hub.emit("experiment", {k: v for k, v in exp.items() if k != "rows"} | {"n_rows": len(exp["rows"])})

    # ------------------------------------------------------------------ control
    def start(self, spec: dict) -> dict:
        s = self.node.session
        if self.current and self.current["status"] == "running":
            raise ExperimentError("an experiment is already running")
        if not s.ready or not s.config:
            raise ExperimentError("launch a cluster first; experiments sweep around the running configuration")
        base = copy.deepcopy(s.config)
        prompts = [p for p in spec.get("prompts", []) if p in PROMPTS] or ["code", "json", "explain"]
        custom = [c.strip() for c in spec.get("custom_prompts", []) if c and c.strip()]
        draft_vals = [int(x) for x in spec.get("draft_max", []) if str(x).strip()] if base.get("draft") else []
        lat_vals = [float(x) for x in spec.get("latency_ms", []) if str(x).strip()]
        topologies = [("cluster", "Current cluster", base)]
        if spec.get("include_single"):
            single = copy.deepcopy(base)
            me = next((n for n in base["nodes"] if n["id"] == self.node.id), None)
            single["nodes"] = [{"id": self.node.id, "device": (me or {}).get("device") or self.node.runtime.default_device(),
                                "weight": 1}]
            if single.get("draft"):
                single["draft_node"] = self.node.id
                single["draft_device"] = single["nodes"][0]["device"]
            single["latency_ms"] = {}
            topologies.append(("single", f"Single node ({self.node.name})", single))
        if spec.get("include_no_draft") and base.get("draft"):
            nd = copy.deepcopy(base)
            nd["draft"] = None
            nd["draft_node"] = None
            topologies.append(("nodraft", "Cluster without draft", nd))
        remote = [p["id"] for p in s.plan if not p["direct"]]
        if s.draft_plan and not s.draft_plan["direct"] and s.draft_plan["id"] not in remote:
            remote.append(s.draft_plan["id"])
        lat_target = spec.get("latency_target", "all")
        lat_nodes = remote if lat_target == "all" else [n for n in remote if n == lat_target]

        arms = []
        for key, label, cfg in topologies:
            dvals = draft_vals if (cfg.get("draft") and draft_vals) else [cfg.get("draft_max", 8) if cfg.get("draft") else None]
            has_remote = key != "single" and bool(lat_nodes)
            lvals = lat_vals if (lat_vals and has_remote) else [None]
            for dv in dvals:
                for lv in lvals:
                    c = copy.deepcopy(cfg)
                    if dv is not None:
                        c["draft_max"] = dv
                    name = label + (f" · draft {dv}" if dv is not None else "") + (f" · +{lv:g} ms" if lv is not None else "")
                    arms.append({"key": f"{key}|{dv}|{lv}", "label": name, "topology": key, "draft_max": dv,
                                 "latency_ms": lv, "config": c})
        n_rep = max(1, min(int(spec.get("repeats", 2)), 20))
        total = len(arms) * (len(prompts) + len(custom)) * n_rep
        if total > 2000:
            raise ExperimentError(f"too many runs ({total}); reduce the sweep")
        exp = {
            "id": time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2),
            "name": spec.get("name") or "Sweep", "status": "running", "created": time.time(), "finished": None,
            "spec": {"prompts": prompts, "custom_prompts": custom, "max_tokens": int(spec.get("max_tokens", 128)),
                     "repeats": n_rep, "warmup": bool(spec.get("warmup", True)), "latency_nodes": lat_nodes,
                     "seed": int(spec.get("seed", 42))},
            "base_config": base, "arms": [{k: v for k, v in a.items() if k != "config"} for a in arms],
            "rows": [], "summary": [], "progress": {"done": 0, "total": total}, "current_arm": None, "error": None,
            "node": {"id": self.node.id, "name": self.node.name},
        }
        self.current = exp
        self._cancel = False
        self._task = asyncio.create_task(self._run(exp, arms))
        self.node.hub.event("experiment", f"Experiment '{exp['name']}' started: {len(arms)} arm(s), {total} runs",
                            toast=True)
        self.emit()
        self.node.hub.emit("experiments", self.list())
        return exp

    def cancel(self) -> None:
        if self.current and self.current["status"] == "running":
            self._cancel = True

    async def _ensure_config(self, cfg: dict) -> None:
        s = self.node.session
        keys = ("target", "nodes", "draft", "draft_node", "draft_device", "draft_max", "draft_min", "draft_p_min",
                "spec_type", "ctx", "self_via_rpc")
        if s.ready and s.config and all(s.config.get(k) == cfg.get(k) for k in keys):
            return
        if s.state not in ("idle", "error"):
            await s.stop("reconfiguring for experiment")
        s.launch(copy.deepcopy(cfg))
        while s.state == "launching":
            await asyncio.sleep(0.5)
            if self._cancel:
                raise ExperimentError("cancelled")
        if not s.ready:
            raise ExperimentError(f"relaunch failed: {s.error}")

    async def _run(self, exp: dict, arms: list[dict]) -> None:
        s = self.node.session
        spec = exp["spec"]
        prompts = [(pid, PROMPTS[pid][1]) for pid in spec["prompts"]] + \
                  [(f"custom{i + 1}", p) for i, p in enumerate(spec["custom_prompts"])]
        original_lat = dict((exp["base_config"].get("latency_ms") or {}))
        try:
            for arm in arms:
                if self._cancel:
                    raise ExperimentError("cancelled")
                exp["current_arm"] = arm["label"]
                self.emit()
                cfg = arm["config"]
                await self._ensure_config(cfg)
                if arm["latency_ms"] is not None:
                    for nid in spec["latency_nodes"]:
                        await s.set_latency(nid, arm["latency_ms"])
                elif arm["topology"] != "single":
                    for nid in spec["latency_nodes"]:
                        await s.set_latency(nid, original_lat.get(nid, 0))
                if spec["warmup"]:
                    await self.node.inference.generate([{"role": "user", "content": "Say OK."}],
                                                       {"max_tokens": 8, "temperature": 0, "seed": spec["seed"]},
                                                       tag=f"exp-warmup:{exp['id']}")
                for pid, text in prompts:
                    for rep in range(spec["repeats"]):
                        if self._cancel:
                            raise ExperimentError("cancelled")
                        run = await self.node.inference.generate(
                            [{"role": "user", "content": text}],
                            {"max_tokens": spec["max_tokens"], "temperature": 0, "seed": spec["seed"],
                             "cache_prompt": False},
                            tag=f"exp:{exp['id']}")
                        m = run["metrics"]
                        exp["rows"].append({
                            "arm": arm["key"], "arm_label": arm["label"], "topology": arm["topology"],
                            "draft_max": arm["draft_max"], "latency_ms": arm["latency_ms"], "prompt": pid, "rep": rep,
                            "run_id": run["id"],
                            **{k: m.get(k) for k in AGG_KEYS + ["total_ms", "draft_n", "draft_accepted", "net_bytes"]},
                            "accept_by_pos": m.get("accept_by_pos"),
                            "nodes": {v["name"]: {"compute_ms": v["est_compute_ms"], "network_ms": v["est_network_ms"],
                                                  "bytes": v["bytes_c2s"] + v["bytes_s2c"]}
                                      for v in (m.get("nodes") or {}).values()},
                        })
                        exp["progress"]["done"] += 1
                        exp["summary"] = summarize(exp)
                        self.emit()
                        self.node.hub.emit("experiment_row", {"id": exp["id"], "row": exp["rows"][-1],
                                                              "summary": exp["summary"]})
            exp["status"] = "done"
            self.node.hub.event("experiment", f"Experiment '{exp['name']}' finished", level="success", toast=True)
        except Exception as e:
            exp["status"] = "cancelled" if str(e) == "cancelled" else "error"
            exp["error"] = str(e)
            self.node.hub.event("experiment", f"Experiment '{exp['name']}' {exp['status']}: {e}",
                                level="warn" if exp["status"] == "cancelled" else "error", toast=True)
        finally:
            exp["finished"] = time.time()
            exp["current_arm"] = None
            exp["summary"] = summarize(exp)
            try:
                if exp["status"] != "error" or s.ready:
                    self._cancel = False
                    await self._ensure_config(exp["base_config"])  # leave the cluster as we found it
            except Exception:
                pass
            try:
                if s.ready:
                    for nid, ms in original_lat.items():
                        await s.set_latency(nid, ms)
                    for nid in spec["latency_nodes"]:
                        if nid not in original_lat:
                            await s.set_latency(nid, 0)
            except Exception:
                pass
            self._save(exp)
            self.emit()
            self.current = None
            self.node.hub.emit("experiments", self.list())


def summarize(exp: dict) -> list[dict]:
    out = []
    for arm in exp["arms"]:
        rows = [r for r in exp["rows"] if r["arm"] == arm["key"]]
        if not rows:
            continue
        agg = {"arm": arm["key"], "label": arm["label"], "topology": arm["topology"],
               "draft_max": arm["draft_max"], "latency_ms": arm["latency_ms"], "n": len(rows)}
        for k in AGG_KEYS:
            vals = [r[k] for r in rows if isinstance(r.get(k), (int, float))]
            if vals:
                agg[k] = statistics.fmean(vals)
                agg[k + "_std"] = statistics.stdev(vals) if len(vals) > 1 else 0.0
        by_prompt = {}
        for r in rows:
            if isinstance(r.get("accept_rate"), (int, float)):
                by_prompt.setdefault(r["prompt"], []).append(r["accept_rate"])
        agg["accept_by_prompt"] = {k: statistics.fmean(v) for k, v in by_prompt.items()}
        pos_rows = [r["accept_by_pos"] for r in rows if r.get("accept_by_pos")]
        if pos_rows:
            L = max(len(p) for p in pos_rows)
            agg["accept_by_pos"] = [statistics.fmean([p[i] for p in pos_rows if i < len(p)]) for i in range(L)]
        nodes: dict[str, dict] = {}
        for r in rows:
            for name, v in (r.get("nodes") or {}).items():
                n = nodes.setdefault(name, {"compute_ms": [], "network_ms": [], "bytes": []})
                for k in n:
                    n[k].append(v[k])
        agg["nodes"] = {name: {k: statistics.fmean(v) for k, v in d.items()} for name, d in nodes.items()}
        out.append(agg)
    return out


def to_csv(exp: dict) -> str:
    buf = io.StringIO()
    fields = ["arm_label", "topology", "draft_max", "latency_ms", "prompt", "rep", "run_id"] + AGG_KEYS + \
             ["total_ms", "draft_n", "draft_accepted", "net_bytes"]
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for r in exp["rows"]:
        w.writerow(r)
    return buf.getvalue()
