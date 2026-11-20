"""Static configuration, filesystem layout and persisted settings."""
from __future__ import annotations

import json
import os
import socket
import threading
import uuid
from pathlib import Path
from typing import Any

from . import __version__

APP = "Lattice"
VERSION = __version__
ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"

# Every node in a cluster must run the same llama.cpp build: the RPC protocol is
# versioned and mismatched builds refuse to talk to each other.
LLAMA_TAG = "b12359"
LLAMA_LABEL = "llama.cpp 1.0.0 (build 12359)"
LLAMA_ASSET = f"llama-{LLAMA_TAG}-bin-win-vulkan-x64.zip"
LLAMA_URL = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{LLAMA_ASSET}"
LLAMA_ASSET_SIZE = 38_090_643
RPC_PROTO = "10.0.0"

DISCOVERY_PORT = 7471
MCAST_GROUP = "239.255.74.71"
DEFAULT_HTTP_PORT = 7470
PROTOCOL = 1  # Lattice control-plane protocol version


class Ports:
    """All ports derive from the HTTP port so several nodes can share one machine."""

    def __init__(self, http: int):
        self.http = http

    @property
    def gate(self) -> int:  # LAN-facing metered RPC gate
        return self.http + 10

    @property
    def rpc(self) -> int:  # loopback-only ggml rpc-server
        return self.http + 11

    @property
    def llama(self) -> int:  # loopback-only llama-server (coordinator)
        return self.http + 20

    def as_dict(self) -> dict:
        return {"http": self.http, "gate": self.gate, "rpc": self.rpc, "llama": self.llama}


class Paths:
    def __init__(self, home: Path):
        self.home = home
        self.data = home / "data"
        self.models = home / "models"
        self.runtime = home / "runtime"
        self.dist = self.runtime / "dist"
        self.llama_dir = self.runtime / f"{LLAMA_TAG}-vulkan"
        self.llama_cache = self.data / "llama-cache"
        self.experiments = self.data / "experiments"
        self.logs = self.data / "logs"
        for p in (self.data, self.models, self.runtime, self.dist, self.llama_cache,
                  self.experiments, self.logs):
            p.mkdir(parents=True, exist_ok=True)

    @property
    def llama_server(self) -> Path:
        return self.llama_dir / "llama-server.exe"

    @property
    def rpc_server(self) -> Path:
        return self.llama_dir / "ggml-rpc-server.exe"

    @property
    def runtime_installed(self) -> bool:
        return self.llama_server.exists() and self.rpc_server.exists()


class JsonStore:
    """Tiny thread-safe JSON document persisted atomically."""

    def __init__(self, path: Path, default: Any):
        self.path = path
        self._lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self.data = default
            self.save()

    def save(self) -> None:
        with self._lock:
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)


DEFAULT_SETTINGS = {
    "worker_device": "auto",      # auto | <device name, e.g. Vulkan0 / CPU>
    "worker_threads": 0,          # 0 = let llama.cpp decide
    "allow_discovery": True,
    "auto_open_browser": True,
    "theme": "dark",
}


def load_identity(paths: Paths, name_override: str | None) -> JsonStore:
    store = JsonStore(paths.data / "node.json", {})
    changed = False
    if "id" not in store.data:
        store.data["id"] = uuid.uuid4().hex[:12]
        changed = True
    if name_override:
        store.data["name"] = name_override
        changed = True
    elif "name" not in store.data:
        store.data["name"] = socket.gethostname()
        changed = True
    if changed:
        store.save()
    return store


def load_settings(paths: Paths) -> JsonStore:
    store = JsonStore(paths.data / "settings.json", dict(DEFAULT_SETTINGS))
    for k, v in DEFAULT_SETTINGS.items():
        store.data.setdefault(k, v)
    return store
