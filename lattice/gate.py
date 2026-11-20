"""Metered, access-controlled TCP gate in front of ggml's rpc-server.

The rpc-server binds to 127.0.0.1 only; remote coordinators reach it through this
gate, which
  * admits only paired peers that hold an active lease (rpc-server has no auth),
  * decodes the ggml RPC framing (protocol 10.x) to attribute bytes and
    round-trip latency to individual commands (SET_TENSOR, GRAPH_COMPUTE, ...),
  * optionally injects symmetric one-way delay to emulate slower networks.

Wire format (ggml-rpc.cpp):
  request : | cmd u8 | size u64 LE | payload(size) |
  response: | size u64 LE | payload(size) |   (only for commands in RESP_CMDS)
"""
from __future__ import annotations

import asyncio
import time
from collections import deque

from .util import is_loopback, set_nodelay

CMD_NAMES = [
    "ALLOC_BUFFER", "GET_ALIGNMENT", "GET_MAX_SIZE", "BUFFER_GET_BASE", "FREE_BUFFER",
    "BUFFER_CLEAR", "SET_TENSOR", "SET_TENSOR_HASH", "GET_TENSOR", "COPY_TENSOR",
    "GRAPH_COMPUTE", "GET_DEVICE_MEMORY", "INIT_TENSOR", "GET_ALLOC_SIZE", "HELLO",
    "DEVICE_COUNT", "GRAPH_RECOMPUTE", "MEMSET_TENSOR", "SET_TENSOR_2D", "GET_TENSOR_2D",
    "COMM_INIT", "COMM_ALLREDUCE", "COMM_FREE", "NONE",
]
N_CMDS = len(CMD_NAMES)
RESP_CMDS = {0, 1, 2, 3, 7, 8, 9, 11, 13, 14, 15, 19, 20}
WEIGHT_CMDS = {6, 7, 18}           # tensor uploads
COMPUTE_CMDS = {10, 16}            # graph (re)compute
MAX_FRAME = 1 << 38


class _Framer:
    """Incremental length-prefixed frame tracker (never copies payloads)."""

    def __init__(self, header: int, on_frame) -> None:
        self.header = header
        self.on_frame = on_frame
        self.buf = bytearray()
        self.remaining = 0
        self.cur: tuple | None = None
        self.ok = True

    def feed(self, data: bytes, t: float) -> None:
        i, n = 0, len(data)
        while i < n and self.ok:
            if self.remaining:
                take = min(self.remaining, n - i)
                self.remaining -= take
                i += take
                if not self.remaining:
                    self.on_frame(self.cur, t)
                continue
            take = min(self.header - len(self.buf), n - i)
            self.buf += data[i:i + take]
            i += take
            if len(self.buf) < self.header:
                continue
            if self.header == 9:
                cmd, size = self.buf[0], int.from_bytes(self.buf[1:9], "little")
            else:
                cmd, size = None, int.from_bytes(self.buf[0:8], "little")
            self.buf.clear()
            if (cmd is not None and cmd >= N_CMDS) or size > MAX_FRAME:
                self.ok = False
                return
            self.cur = (cmd, size)
            self.remaining = size
            if size == 0:
                self.on_frame(self.cur, t)


class GateStats:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.bytes_c2s = 0
        self.bytes_s2c = 0
        self.cmd_count = [0] * N_CMDS
        self.cmd_bytes = [0] * N_CMDS
        self.resp_count = [0] * N_CMDS
        self.resp_ms = [0.0] * N_CMDS
        self.wait_ms = 0.0
        self.waits = 0
        self.computes = 0
        self.connections = 0
        self.total_connections = 0
        self.rejected = 0
        self.parse_ok = True
        self.rate_c2s = 0.0
        self.rate_s2c = 0.0
        self.rate_calls = 0.0
        self.phase = "idle"
        self.last_active = 0.0
        self.activity: deque[dict] = deque(maxlen=90)
        self._win = self._new_window()
        self._prev = (time.perf_counter(), 0, 0, 0)
        self.recent_latency: deque[float] = deque(maxlen=256)

    @staticmethod
    def _new_window() -> dict:
        return {"c2s": 0, "s2c": 0, "cmds": {}, "lat_ms": 0.0, "lat_n": 0}

    def tick(self) -> None:
        """Called every 0.5 s: rates, phase and the activity window."""
        now = time.perf_counter()
        t0, c0, s0, k0 = self._prev
        dt = max(now - t0, 1e-6)
        calls = sum(self.cmd_count)
        a = 0.6
        self.rate_c2s = a * (self.bytes_c2s - c0) / dt + (1 - a) * self.rate_c2s
        self.rate_s2c = a * (self.bytes_s2c - s0) / dt + (1 - a) * self.rate_s2c
        self.rate_calls = a * (calls - k0) / dt + (1 - a) * self.rate_calls
        self._prev = (now, self.bytes_c2s, self.bytes_s2c, calls)
        w = self._win
        if w["c2s"] or w["s2c"]:
            weights = sum(v[1] for k, v in w["cmds"].items() if k in ("SET_TENSOR", "SET_TENSOR_HASH", "SET_TENSOR_2D"))
            computes = sum(v[0] for k, v in w["cmds"].items() if k in ("GRAPH_COMPUTE", "GRAPH_RECOMPUTE"))
            self.phase = "loading" if weights > 4 << 20 else ("computing" if computes else "syncing")
            self.last_active = now
            self.activity.append({
                "ts": time.time() * 1000, "c2s": w["c2s"], "s2c": w["s2c"],
                "cmds": w["cmds"], "lat_ms": (w["lat_ms"] / w["lat_n"]) if w["lat_n"] else None,
            })
        elif now - self.last_active > 1.5:
            self.phase = "idle" if self.connections == 0 else "connected"
        self._win = self._new_window()

    def on_request(self, frame: tuple, t: float, pending: deque) -> None:
        cmd, size = frame
        self.cmd_count[cmd] += 1
        self.cmd_bytes[cmd] += size + 9
        if cmd in COMPUTE_CMDS:
            self.computes += 1
        name = CMD_NAMES[cmd]
        c = self._win["cmds"].setdefault(name, [0, 0])
        c[0] += 1
        c[1] += size + 9
        if cmd in RESP_CMDS:
            pending.append((cmd, t))

    def on_response(self, frame: tuple, t: float, pending: deque) -> bool:
        if not pending:
            return False
        cmd, t0 = pending.popleft()
        ms = (t - t0) * 1000.0
        self.resp_count[cmd] += 1
        self.resp_ms[cmd] += ms
        self.wait_ms += ms
        self.waits += 1
        self.recent_latency.append(ms)
        self._win["lat_ms"] += ms
        self._win["lat_n"] += 1
        return True

    def counters(self) -> dict:
        """Monotonic counters used to compute per-run deltas."""
        return {
            "bytes_c2s": self.bytes_c2s, "bytes_s2c": self.bytes_s2c,
            "wait_ms": self.wait_ms, "waits": self.waits, "computes": self.computes,
            "calls": sum(self.cmd_count),
        }

    def snapshot(self, full: bool = False) -> dict:
        d = {
            **self.counters(),
            "rate_c2s": self.rate_c2s, "rate_s2c": self.rate_s2c, "rate_calls": self.rate_calls,
            "connections": self.connections, "total_connections": self.total_connections,
            "rejected": self.rejected, "parse_ok": self.parse_ok, "phase": self.phase,
            "activity": list(self.activity)[-12:],
        }
        lat = sorted(self.recent_latency)
        if lat:
            d["lat_p50"] = lat[len(lat) // 2]
            d["lat_p95"] = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
        if full:
            d["by_cmd"] = {
                CMD_NAMES[i]: {
                    "count": self.cmd_count[i], "bytes": self.cmd_bytes[i],
                    "responses": self.resp_count[i],
                    "avg_ms": (self.resp_ms[i] / self.resp_count[i]) if self.resp_count[i] else None,
                }
                for i in range(N_CMDS) if self.cmd_count[i]
            }
            d["activity"] = list(self.activity)
        return d


class Gate:
    def __init__(self, listen_port: int, upstream_port: int) -> None:
        self.listen_port = listen_port
        self.upstream_port = upstream_port
        self.allow: set[str] = set()
        self.delay_ms = 0.0
        self.stats = GateStats()
        self.server: asyncio.base_events.Server | None = None
        self._ticker: asyncio.Task | None = None
        self._conns: set[asyncio.StreamWriter] = set()

    @property
    def running(self) -> bool:
        return self.server is not None

    async def start(self) -> None:
        if self.server:
            return
        self.server = await asyncio.start_server(self._handle, "0.0.0.0", self.listen_port)
        self._ticker = asyncio.create_task(self._tick())

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            for w in list(self._conns):
                w.close()
            try:
                await asyncio.wait_for(self.server.wait_closed(), 3)
            except Exception:
                pass
            self.server = None
        if self._ticker:
            self._ticker.cancel()
            self._ticker = None
        self.allow.clear()

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            self.stats.tick()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        ip = peer[0] if peer else None
        if not (is_loopback(ip) or ip in self.allow):
            self.stats.rejected += 1
            writer.close()
            return
        try:
            ureader, uwriter = await asyncio.open_connection("127.0.0.1", self.upstream_port)
        except OSError:
            writer.close()
            return
        for w in (writer, uwriter):
            sock = w.get_extra_info("socket")
            if sock is not None:
                set_nodelay(sock)
        st = self.stats
        st.connections += 1
        st.total_connections += 1
        self._conns.add(writer)
        pending: deque = deque()

        def on_req(frame, t):
            st.on_request(frame, t, pending)

        def on_resp(frame, t):
            if not st.on_response(frame, t, pending):
                resp_framer.ok = False

        req_framer = _Framer(9, on_req)
        resp_framer = _Framer(8, on_resp)

        async def pump(src, dst, upstream: bool):
            loop = asyncio.get_running_loop()
            q: asyncio.Queue = asyncio.Queue(maxsize=64)

            async def sender():
                while True:
                    item = await q.get()
                    if item is None:
                        break
                    release, data = item
                    wait = release - loop.time()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    dst.write(data)
                    if dst.transport.get_write_buffer_size() > (1 << 20):
                        await dst.drain()
                    if not upstream:  # response leaves the gate now (after injected delay)
                        st.bytes_s2c += len(data)
                        st._win["s2c"] += len(data)
                        if resp_framer.ok:
                            resp_framer.feed(data, time.perf_counter())
                        elif st.parse_ok:
                            st.parse_ok = False
                    elif not q.qsize():
                        await dst.drain()

            task = asyncio.create_task(sender())
            try:
                while True:
                    data = await src.read(1 << 20)
                    if not data:
                        break
                    if upstream:  # request entered the gate now
                        st.bytes_c2s += len(data)
                        st._win["c2s"] += len(data)
                        if req_framer.ok:
                            req_framer.feed(data, time.perf_counter())
                        elif st.parse_ok:
                            st.parse_ok = False
                    await q.put((loop.time() + self.delay_ms / 2000.0, data))
            except (ConnectionError, OSError):
                pass
            finally:
                await q.put(None)
                try:
                    await task
                except Exception:
                    pass
                try:
                    dst.close()
                except Exception:
                    pass

        try:
            await asyncio.gather(pump(reader, uwriter, True), pump(ureader, writer, False))
        finally:
            st.connections -= 1
            self._conns.discard(writer)
            for w in (writer, uwriter):
                try:
                    w.close()
                except Exception:
                    pass

    def status(self) -> dict:
        return {
            "running": self.running, "port": self.listen_port, "delay_ms": self.delay_ms,
            "allow": sorted(self.allow),
        }
