"""Local model library, curated catalog and memory/placement estimation."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

from .config import JsonStore
from .gguf import draft_compatible, read_gguf

if TYPE_CHECKING:
    from .node import Node

HF = "https://huggingface.co/{repo}/resolve/main/{file}"

# Verified against the Hugging Face API (sizes in bytes). Families share a tokenizer,
# so any smaller member can draft for a larger one.
CATALOG = [
    {"id": "qwen2.5-0.5b", "title": "Qwen2.5 0.5B Instruct", "family": "Qwen2.5", "params": "0.5B", "quant": "Q4_K_M",
     "repo": "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "file": "qwen2.5-0.5b-instruct-q4_k_m.gguf", "size": 491_400_032, "role": "draft"},
    {"id": "qwen2.5-1.5b", "title": "Qwen2.5 1.5B Instruct", "family": "Qwen2.5", "params": "1.5B", "quant": "Q4_K_M",
     "repo": "Qwen/Qwen2.5-1.5B-Instruct-GGUF", "file": "qwen2.5-1.5b-instruct-q4_k_m.gguf", "size": 1_117_320_736, "role": "both"},
    {"id": "qwen2.5-3b", "title": "Qwen2.5 3B Instruct", "family": "Qwen2.5", "params": "3B", "quant": "Q4_K_M",
     "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF", "file": "qwen2.5-3b-instruct-q4_k_m.gguf", "size": 2_104_932_768, "role": "target"},
    {"id": "qwen2.5-7b", "title": "Qwen2.5 7B Instruct", "family": "Qwen2.5", "params": "7B", "quant": "Q4_K_M",
     "repo": "bartowski/Qwen2.5-7B-Instruct-GGUF", "file": "Qwen2.5-7B-Instruct-Q4_K_M.gguf", "size": 4_683_074_240, "role": "target"},
    {"id": "qwen3-0.6b", "title": "Qwen3 0.6B", "family": "Qwen3", "params": "0.6B", "quant": "Q8_0",
     "repo": "Qwen/Qwen3-0.6B-GGUF", "file": "Qwen3-0.6B-Q8_0.gguf", "size": 639_446_688, "role": "draft"},
    {"id": "qwen3-1.7b", "title": "Qwen3 1.7B", "family": "Qwen3", "params": "1.7B", "quant": "Q8_0",
     "repo": "Qwen/Qwen3-1.7B-GGUF", "file": "Qwen3-1.7B-Q8_0.gguf", "size": 1_834_426_016, "role": "both"},
    {"id": "qwen3-4b", "title": "Qwen3 4B", "family": "Qwen3", "params": "4B", "quant": "Q4_K_M",
     "repo": "Qwen/Qwen3-4B-GGUF", "file": "Qwen3-4B-Q4_K_M.gguf", "size": 2_497_280_256, "role": "target"},
    {"id": "qwen3-8b", "title": "Qwen3 8B", "family": "Qwen3", "params": "8B", "quant": "Q4_K_M",
     "repo": "Qwen/Qwen3-8B-GGUF", "file": "Qwen3-8B-Q4_K_M.gguf", "size": 5_027_783_488, "role": "target"},
    {"id": "llama3.2-1b", "title": "Llama 3.2 1B Instruct", "family": "Llama 3", "params": "1B", "quant": "Q4_K_M",
     "repo": "bartowski/Llama-3.2-1B-Instruct-GGUF", "file": "Llama-3.2-1B-Instruct-Q4_K_M.gguf", "size": 807_694_464, "role": "draft"},
    {"id": "llama3.1-8b", "title": "Llama 3.1 8B Instruct", "family": "Llama 3", "params": "8B", "quant": "Q4_K_M",
     "repo": "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", "file": "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", "size": 4_920_739_232, "role": "target"},
]
CATALOG_BY_FILE = {c["file"]: c for c in CATALOG}
COMPUTE_OVERHEAD = 320 << 20  # rough per-device compute-buffer allowance


def safe_name(name: str) -> str:
    if not name or "/" in name or "\\" in name or ".." in name or ":" in name:
        raise ValueError("invalid file name")
    return name


class ModelLibrary:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.dir: Path = node.paths.models
        self.cache = JsonStore(node.paths.data / "model_meta.json", {})
        self.models: dict[str, dict] = {}

    async def scan(self) -> list[dict]:
        loop = asyncio.get_running_loop()
        found: dict[str, dict] = {}
        for p in sorted(self.dir.glob("*.gguf")):
            st = p.stat()
            key = f"{p.name}|{st.st_size}|{int(st.st_mtime)}"
            meta = self.cache.data.get(key)
            if meta is None:
                try:
                    meta = await loop.run_in_executor(None, read_gguf, p)
                except Exception as e:
                    meta = {"file": p.name, "size": st.st_size, "error": str(e)}
                self.cache.data = {k: v for k, v in self.cache.data.items() if not k.startswith(p.name + "|")}
                self.cache.data[key] = meta
                self.cache.save()
            cat = CATALOG_BY_FILE.get(p.name)
            found[p.name] = {**meta, "family": cat["family"] if cat else None,
                             "title": cat["title"] if cat else meta.get("name", p.stem)}
        self.models = found
        return self.list()

    def list(self) -> list[dict]:
        return [{k: v for k, v in m.items() if k != "meta"} for m in self.models.values()]

    def get(self, name: str) -> dict | None:
        return self.models.get(name)

    def path(self, name: str) -> Path:
        return self.dir / safe_name(name)

    def delete(self, name: str) -> None:
        p = self.path(name)
        if p.exists():
            p.unlink()
        self.models.pop(name, None)

    def files_listing(self) -> list[dict]:
        return [{"name": m["file"], "size": m["size"]} for m in self.models.values() if "error" not in m]

    def catalog_view(self) -> list[dict]:
        lan = self.lan_index()
        out = []
        for c in CATALOG:
            out.append({**c, "local": c["file"] in self.models, "on_peers": lan.get(c["file"], [])})
        return out

    def lan_index(self) -> dict[str, list[dict]]:
        """file name -> peers that can serve it."""
        idx: dict[str, list[dict]] = {}
        for pid, live in self.node.peers.live.items():
            if not live.get("online"):
                continue
            for f in (live.get("files") or {}).get("models", []):
                idx.setdefault(f["name"], []).append({"id": pid, "name": self.node.peers.peers.get(pid, {}).get("name"),
                                                      "size": f["size"]})
        return idx

    def compat(self, draft: str, target: str) -> tuple[bool, str]:
        d, t = self.get(draft), self.get(target)
        if not d or not t:
            return False, "model not found"
        return draft_compatible(d, t)


def layer_assignment(n_layers: int, weights: list[float]) -> list[tuple[int, int]]:
    """Replicates llama.cpp's layer split (llama-model.cpp): layer il goes to the first
    device whose cumulative split fraction exceeds il / (n_layers + 1) with -ngl all."""
    total = sum(weights) or 1.0
    cum, acc = [], 0.0
    for w in weights:
        acc += w / total
        cum.append(acc)
    n_off = n_layers + 1
    ranges: list[list[int]] = [[-1, -1] for _ in weights]
    for il in range(n_layers):
        x = il / n_off
        dev = next((i for i, c in enumerate(cum) if c > x), len(weights) - 1)
        if ranges[dev][0] < 0:
            ranges[dev][0] = il
        ranges[dev][1] = il
    return [tuple(r) for r in ranges]


def estimate_placement(meta: dict, weights: list[float], ctx: int) -> list[dict]:
    """Per-device bytes for weights + KV cache under a layer split."""
    ranges = layer_assignment(meta["n_layers"], weights)
    lb = meta["layer_bytes"]
    kv_layer = meta.get("kv_bytes_per_token_layer", 0) * ctx
    out = []
    for i, (a, b) in enumerate(ranges):
        n = (b - a + 1) if a >= 0 else 0
        wbytes = sum(lb[a:b + 1]) if n else 0
        if i == len(ranges) - 1:
            wbytes += meta.get("output_bytes", 0)
        out.append({"layers": [a, b] if n else None, "n_layers": n, "weights": wbytes,
                    "kv": kv_layer * n, "total": wbytes + kv_layer * n + (COMPUTE_OVERHEAD if n else 0)})
    return out
