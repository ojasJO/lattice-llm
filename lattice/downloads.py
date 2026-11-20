"""Resumable downloads that prefer LAN peers and fall back to the Internet."""
from __future__ import annotations

import asyncio
import os
import secrets
import time
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable

import aiohttp

if TYPE_CHECKING:
    from .node import Node


class Download:
    def __init__(self, kind: str, name: str, dest: Path, sources: list[dict], expected: int | None,
                 on_done: Callable[["Download"], Awaitable[None]] | None) -> None:
        self.id = secrets.token_hex(6)
        self.kind, self.name, self.dest = kind, name, dest
        self.sources = sources
        self.expected = expected
        self.on_done = on_done
        self.total = expected or 0
        self.done = 0
        self.speed = 0.0
        self.status = "queued"
        self.error: str | None = None
        self.source: str | None = None
        self.started = time.time()
        self.finished: float | None = None
        self.cancelled = False
        self.task: asyncio.Task | None = None
        self.waiters: list[asyncio.Future] = []

    def view(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name, "total": self.total, "done": self.done,
                "speed": self.speed, "status": self.status, "error": self.error, "source": self.source,
                "started": self.started, "finished": self.finished}


class DownloadManager:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.items: dict[str, Download] = {}

    def active_for(self, kind: str, name: str) -> Download | None:
        for d in self.items.values():
            if d.kind == kind and d.name == name and d.status in ("queued", "running"):
                return d
        return None

    def add(self, kind: str, name: str, dest: Path, sources: list[dict], expected: int | None = None,
            on_done=None) -> Download:
        existing = self.active_for(kind, name)
        if existing:
            return existing
        d = Download(kind, name, dest, sources, expected, on_done)
        self.items[d.id] = d
        d.task = asyncio.create_task(self._run(d))
        self.emit()
        return d

    async def wait(self, d: Download) -> Download:
        if d.task:
            await asyncio.shield(d.task)
        return d

    def cancel(self, did: str) -> None:
        d = self.items.get(did)
        if d and d.status in ("queued", "running"):
            d.cancelled = True

    def clear_finished(self) -> None:
        for k in [k for k, d in self.items.items() if d.status not in ("queued", "running")]:
            del self.items[k]
        self.emit()

    def view(self) -> list[dict]:
        return [d.view() for d in sorted(self.items.values(), key=lambda x: -x.started)]

    def emit(self) -> None:
        self.node.hub.emit("downloads", self.view())

    async def _run(self, d: Download) -> None:
        d.status = "running"
        errors = []
        for src in d.sources:
            if d.cancelled:
                break
            try:
                await self._fetch(d, src)
                d.status = "done"
                break
            except asyncio.CancelledError:
                raise
            except Exception as e:
                errors.append(f"{src.get('label', src.get('url'))}: {e}")
                self.node.hub.event("download", f"{d.name}: source failed ({e}); trying next", level="warn")
        if d.cancelled:
            d.status = "cancelled"
        elif d.status != "done":
            d.status = "error"
            d.error = "; ".join(errors) or "no sources"
        d.finished = time.time()
        if d.status == "done":
            self.node.hub.event("download", f"Downloaded {d.name} from {d.source}", level="success", toast=True)
            if d.on_done:
                try:
                    await d.on_done(d)
                except Exception as e:
                    d.status, d.error = "error", f"post-processing failed: {e}"
        elif d.status == "error":
            self.node.hub.event("download", f"Download of {d.name} failed: {d.error}", level="error", toast=True)
        self.emit()

    async def _fetch(self, d: Download, src: dict) -> None:
        part = d.dest.with_name(d.dest.name + ".part")
        have = part.stat().st_size if part.exists() else 0
        headers = {}
        if src["type"] == "peer":
            peer = self.node.peers.peers.get(src["peer_id"])
            if not peer or not self.node.peers.online(src["peer_id"]):
                raise RuntimeError("peer offline")
            path = f"/peer/files/{d.kind}/{d.name}"
            url = self.node.peers.url(peer, path)
            headers.update(self.node.peers.headers(peer, "GET", path))
            d.source = f"{peer['name']} (LAN)"
        else:
            url = src["url"]
            d.source = src.get("label") or url.split("/")[2]
        if have:
            headers["Range"] = f"bytes={have}-"
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60)
        async with self.node.http.get(url, headers=headers, timeout=timeout) as r:
            if r.status == 416:  # already complete
                pass
            elif r.status not in (200, 206):
                raise RuntimeError(f"HTTP {r.status}")
            if r.status == 200 and have:
                have = 0
            length = r.content_length
            d.total = (length + have) if length is not None else (d.expected or 0)
            d.done = have
            mode = "ab" if have else "wb"
            last_emit = t_prev = time.time()
            b_prev = have
            loop = asyncio.get_running_loop()
            with open(part, mode) as f:
                if r.status != 416:
                    async for chunk in r.content.iter_chunked(1 << 20):
                        if d.cancelled:
                            raise RuntimeError("cancelled")
                        await loop.run_in_executor(None, f.write, chunk)
                        d.done += len(chunk)
                        now = time.time()
                        if now - t_prev >= 0.5:
                            inst = (d.done - b_prev) / (now - t_prev)
                            d.speed = inst if not d.speed else 0.5 * inst + 0.5 * d.speed
                            t_prev, b_prev = now, d.done
                        if now - last_emit >= 0.3:
                            last_emit = now
                            self.emit()
        size = part.stat().st_size
        if d.expected and size != d.expected:
            raise RuntimeError(f"size mismatch: got {size}, expected {d.expected}")
        os.replace(part, d.dest)
        d.done = d.total = size
