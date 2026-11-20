"""Minimal GGUF (v2/v3) reader: metadata + per-layer byte sizes, no tensor data loaded."""
from __future__ import annotations

import hashlib
import re
import struct
from pathlib import Path

_SCALAR = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_SIZE = {k: struct.calcsize(v) for k, v in _SCALAR.items()}

FILE_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K",
    11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S",
    17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS",
    23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S",
    29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "TQ1_0", 37: "TQ2_0", 38: "MXFP4",
}
_BLK = re.compile(r"^blk\.(\d+)\.")


class _R:
    def __init__(self, f):
        self.f = f

    def u32(self) -> int:
        return struct.unpack("<I", self.f.read(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.f.read(8))[0]

    def string(self) -> str:
        n = self.u64()
        return self.f.read(n).decode("utf-8", errors="replace")

    def skip_string(self) -> None:
        self.f.seek(self.u64(), 1)


def read_gguf(path: Path) -> dict:
    size = path.stat().st_size
    kv: dict = {}
    tokens_head: list[str] = []
    n_vocab = None
    with open(path, "rb", buffering=1 << 20) as f:
        r = _R(f)
        if f.read(4) != b"GGUF":
            raise ValueError("not a GGUF file")
        version = r.u32()
        n_tensors = r.u64()
        n_kv = r.u64()
        for _ in range(n_kv):
            key = r.string()
            vtype = r.u32()
            if vtype == 8:
                kv[key] = r.string()
            elif vtype == 9:
                atype = r.u32()
                alen = r.u64()
                if key == "tokenizer.ggml.tokens":
                    n_vocab = alen
                if atype == 8:
                    keep = key == "tokenizer.ggml.tokens"
                    for i in range(alen):
                        if keep and i < 2000:
                            tokens_head.append(r.string())
                        else:
                            r.skip_string()
                elif atype in _SIZE:
                    if alen <= 16:
                        kv[key] = [struct.unpack(_SCALAR[atype], f.read(_SIZE[atype]))[0] for _ in range(alen)]
                    else:
                        f.seek(alen * _SIZE[atype], 1)
                        kv[key] = f"<array {alen}>"
                else:
                    raise ValueError(f"nested array in {key}")
            elif vtype in _SCALAR:
                kv[key] = struct.unpack(_SCALAR[vtype], f.read(_SIZE[vtype]))[0]
            else:
                raise ValueError(f"bad value type {vtype} for {key}")
        tensors = []
        n_params = 0
        for _ in range(n_tensors):
            name = r.string()
            nd = r.u32()
            dims = [r.u64() for _ in range(nd)]
            r.u32()  # tensor type (not needed: sizes come from offsets)
            off = r.u64()
            tensors.append((name, off))
            p = 1
            for d in dims:
                p *= d
            n_params += p
        align = int(kv.get("general.alignment", 32))
        data_start = (f.tell() + align - 1) // align * align

    tensors.sort(key=lambda t: t[1])
    data_len = size - data_start
    arch = kv.get("general.architecture", "?")
    n_layers = int(kv.get(f"{arch}.block_count", 0))
    layer_bytes = [0] * n_layers
    embd_bytes = out_bytes = 0
    for i, (name, off) in enumerate(tensors):
        nbytes = (tensors[i + 1][1] if i + 1 < len(tensors) else data_len) - off
        m = _BLK.match(name)
        if m and int(m.group(1)) < n_layers:
            layer_bytes[int(m.group(1))] += nbytes
        elif name.startswith("token_embd") or name.startswith("per_layer"):
            embd_bytes += nbytes
        else:
            out_bytes += nbytes

    n_embd = int(kv.get(f"{arch}.embedding_length", 0))
    n_head = int(kv.get(f"{arch}.attention.head_count", 0) or 0) if not isinstance(
        kv.get(f"{arch}.attention.head_count"), (list, str)) else 0
    hkv = kv.get(f"{arch}.attention.head_count_kv", n_head)
    n_head_kv = int(hkv) if isinstance(hkv, (int, float)) else n_head
    head_dim = int(kv.get(f"{arch}.attention.key_length", (n_embd // n_head) if n_head else 0))
    vhead_dim = int(kv.get(f"{arch}.attention.value_length", head_dim))
    kv_per_tok_layer = n_head_kv * (head_dim + vhead_dim) * 2  # f16 K + V
    ft = kv.get("general.file_type")
    quant = FILE_TYPES.get(ft, None) if isinstance(ft, int) else None
    if not quant:
        m = re.search(r"(I?Q\d_[A-Z0-9_]+|F16|BF16|F32|Q8_0)", path.name.upper())
        quant = m.group(1) if m else "?"
    vocab_sig = hashlib.sha1("\x00".join(tokens_head[5:2000]).encode()).hexdigest()[:16]
    return {
        "file": path.name, "size": size, "gguf_version": version,
        "arch": arch, "name": kv.get("general.name") or path.stem,
        "size_label": kv.get("general.size_label"), "quant": quant,
        "n_params": n_params, "n_tensors": n_tensors,
        "n_layers": n_layers, "n_embd": n_embd, "n_head": n_head, "n_head_kv": n_head_kv,
        "head_dim": head_dim, "ctx_train": int(kv.get(f"{arch}.context_length", 0) or 0),
        "vocab_size": n_vocab, "tokenizer": kv.get("tokenizer.ggml.model"),
        "bos": kv.get("tokenizer.ggml.bos_token_id"), "eos": kv.get("tokenizer.ggml.eos_token_id"),
        "vocab_sig": vocab_sig, "has_chat_template": "tokenizer.chat_template" in kv,
        "layer_bytes": layer_bytes, "embd_bytes": embd_bytes, "output_bytes": out_bytes,
        "kv_bytes_per_token_layer": kv_per_tok_layer,
        "meta": {k: v for k, v in kv.items() if not k.startswith("tokenizer.ggml.") and k != "tokenizer.chat_template"},
    }


def draft_compatible(draft: dict, target: dict) -> tuple[bool, str]:
    """Mirror llama.cpp's speculative vocab checks (type, size within 128, special ids, tokens)."""
    if draft.get("tokenizer") != target.get("tokenizer"):
        return False, f"tokenizer mismatch ({draft.get('tokenizer')} vs {target.get('tokenizer')})"
    dv, tv = draft.get("vocab_size") or 0, target.get("vocab_size") or 0
    if abs(dv - tv) > 128:
        return False, f"vocab size differs by {abs(dv - tv)} (> 128)"
    if draft.get("bos") != target.get("bos") or draft.get("eos") != target.get("eos"):
        return False, "BOS/EOS token ids differ"
    if draft.get("vocab_sig") != target.get("vocab_sig"):
        return False, "token tables differ"
    return True, "vocabularies match"
