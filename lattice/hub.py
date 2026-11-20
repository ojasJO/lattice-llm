"""WebSocket fan-out to dashboard clients plus an in-memory event log."""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from typing import Any

from aiohttp import web


class Hub:
    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.events: deque[dict] = deque(maxlen=400)
        self.loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def emit(self, t: str, d: Any = None) -> None:
        """Broadcast a message. Safe to call from the event loop or any thread."""
        if self.loop is None or not self.clients:
            return
        msg = json.dumps({"t": t, "d": d}, default=str)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.loop.create_task(self._broadcast(msg))
        else:
            asyncio.run_coroutine_threadsafe(self._broadcast(msg), self.loop)

    def event(self, kind: str, text: str, level: str = "info", toast: bool = False, **extra: Any) -> None:
        """Record a human-readable event (shown in the activity log, optionally as a toast)."""
        ev = {"ts": time.time() * 1000, "kind": kind, "text": text, "level": level, "toast": toast, **extra}
        self.events.append(ev)
        self.emit("event", ev)

    async def _broadcast(self, msg: str) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_str(msg), timeout=2)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
