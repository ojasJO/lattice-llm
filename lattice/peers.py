"""Pairing, authenticated peer RPC, liveness and NTP-style clock-offset estimation.

Pairing is Bluetooth-style: the initiator asks, the target's dashboard shows an
approval prompt with a 6-digit code that both screens display. On approval both
sides store a shared 256-bit secret. Every subsequent peer request is signed with
HMAC-SHA256(secret, ts \n METHOD \n path).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import time
from collections import deque
from typing import TYPE_CHECKING, Any

import aiohttp

from .config import JsonStore
from .util import now_ms

if TYPE_CHECKING:
    from .node import Node

SIG_WINDOW_MS = 15 * 60 * 1000
PAIR_TTL_S = 120


def sign(token: str, ts: str, method: str, path: str) -> str:
    msg = f"{ts}\n{method.upper()}\n{path}".encode()
    return hmac.new(bytes.fromhex(token), msg, hashlib.sha256).hexdigest()


class PeerError(Exception):
    pass


class PeerManager:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.store = JsonStore(node.paths.data / "peers.json", {"peers": {}})
        self.live: dict[str, dict] = {}
        self.incoming: dict[str, dict] = {}
        self.outgoing: dict[str, dict] = {}

    @property
    def peers(self) -> dict[str, dict]:
        return self.store.data["peers"]

    # ---------------------------------------------------------------- signing
    def headers(self, peer: dict, method: str, path: str) -> dict:
        ts = str(int(now_ms()))
        return {"X-Lattice-Id": self.node.id, "X-Lattice-Ts": ts,
                "X-Lattice-Sig": sign(peer["token"], ts, method, path)}

    def verify(self, method: str, path: str, hdrs) -> dict | None:
        pid = hdrs.get("X-Lattice-Id")
        ts = hdrs.get("X-Lattice-Ts", "")
        sig = hdrs.get("X-Lattice-Sig", "")
        peer = self.peers.get(pid or "")
        if not peer or not ts.isdigit():
            return None
        if abs(now_ms() - int(ts)) > SIG_WINDOW_MS:
            return None
        if not hmac.compare_digest(sign(peer["token"], ts, method, path), sig):
            return None
        return peer

    def url(self, peer: dict, path: str) -> str:
        return f"http://{peer['host']}:{peer['port']}{path}"

    async def call(self, peer_id: str, method: str, path: str, json: Any = None,
                   timeout: float = 5.0) -> Any:
        peer = self.peers.get(peer_id)
        if not peer:
            raise PeerError(f"unknown peer {peer_id}")
        route = path.split("?", 1)[0]
        try:
            async with self.node.http.request(
                    method, self.url(peer, path), json=json, headers=self.headers(peer, method, route),
                    timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                if r.status >= 400:
                    try:
                        body = await r.json()
                        msg = body.get("error") or str(body)
                    except Exception:
                        msg = await r.text()
                    raise PeerError(f"{peer['name']}: {r.status} {msg}")
                if r.content_type == "application/json":
                    return await r.json()
                return await r.read()
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            raise PeerError(f"{peer['name']} unreachable ({type(e).__name__})") from e

    # ---------------------------------------------------------------- address book
    def observe_address(self, peer_id: str, host: str, port: int | None) -> None:
        p = self.peers.get(peer_id)
        if not p:
            return
        live = self.live.get(peer_id, {})
        # move to a new address only if the current one stopped answering
        if (p["host"] != host or (port and p["port"] != port)) and not live.get("online"):
            p["host"] = host
            if port:
                p["port"] = port
            self.store.save()

    def online(self, peer_id: str) -> bool:
        return bool(self.live.get(peer_id, {}).get("online"))

    # ---------------------------------------------------------------- pairing (target side)
    def create_incoming(self, info: dict, remote_ip: str) -> dict:
        self._expire()
        if not info.get("id") or info["id"] == self.node.id:
            raise PeerError("invalid node")
        for r in self.incoming.values():  # de-duplicate repeated clicks
            if r["from"]["id"] == info["id"] and r["status"] == "pending":
                return r
        rid = secrets.token_hex(16)
        req = {"id": rid, "from": info, "host": remote_ip, "code": f"{secrets.randbelow(10**6):06d}",
               "created": time.time(), "status": "pending"}
        self.incoming[rid] = req
        self.node.hub.emit("pair_request", self._public_req(req))
        self.node.hub.event("pair", f"{info.get('name')} ({remote_ip}) wants to connect", toast=False)
        return req

    @staticmethod
    def _public_req(r: dict) -> dict:
        return {k: v for k, v in r.items() if k != "token"}

    def respond(self, rid: str, approve: bool) -> dict:
        req = self.incoming.get(rid)
        if not req or req["status"] != "pending":
            raise PeerError("request not found or already handled")
        if approve:
            info = req["from"]
            # Reuse an existing secret: if both laptops pressed Connect at the same time and both
            # approve, the two pairings must converge on one shared key.
            existing = self.peers.get(info["id"])
            token = existing["token"] if existing else secrets.token_hex(32)
            self.peers[info["id"]] = {
                "id": info["id"], "name": info.get("name", "?"), "host": req["host"],
                "port": int(info.get("port", 7470)), "token": token, "paired_at": time.time(),
                "hw": info.get("hw", {}),
            }
            self.store.save()
            req.update(status="approved", token=token)
            self.node.hub.event("pair", f"Paired with {info.get('name')}", level="success", toast=True)
        else:
            req["status"] = "denied"
            self.node.hub.event("pair", f"Denied connection from {req['from'].get('name')}", level="warn")
        self.node.hub.emit("pair_update", self._public_req(req))
        self.emit()
        return self._public_req(req)

    def poll_incoming(self, rid: str) -> dict:
        self._expire()
        req = self.incoming.get(rid)
        if not req:
            return {"status": "expired"}
        if req["status"] == "approved" and req.get("token"):
            out = {"status": "approved", "token": req.pop("token"), "node": self.node.public_info()}
            req["status"] = "completed"
            return out
        return {"status": req["status"]}

    def _expire(self) -> None:
        now = time.time()
        for rid, r in list(self.incoming.items()):
            if now - r["created"] > PAIR_TTL_S:
                if r["status"] == "pending":
                    r["status"] = "expired"
                    self.node.hub.emit("pair_update", self._public_req(r))
                if now - r["created"] > PAIR_TTL_S * 2:
                    del self.incoming[rid]

    # ---------------------------------------------------------------- pairing (initiator side)
    async def request_pair(self, host: str, port: int) -> dict:
        url = f"http://{host}:{port}/peer/pair/request"
        try:
            async with self.node.http.post(url, json={"node": self.node.public_info()},
                                           timeout=aiohttp.ClientTimeout(total=5)) as r:
                body = await r.json()
                if r.status >= 400:
                    raise PeerError(body.get("error", f"HTTP {r.status}"))
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            raise PeerError(f"cannot reach {host}:{port} ({type(e).__name__}). "
                            "Is Lattice running there and allowed through the firewall?") from e
        rid = body["request_id"]
        target = body["node"]
        out = {"id": rid, "to": target, "host": host, "port": port, "code": body["code"],
               "created": time.time(), "status": "waiting"}
        self.outgoing[rid] = out
        self.node.hub.emit("pair_outgoing", out)
        asyncio.create_task(self._await_approval(out))
        return out

    async def _await_approval(self, out: dict) -> None:
        url = f"http://{out['host']}:{out['port']}/peer/pair/status?request_id={out['id']}"
        deadline = time.time() + PAIR_TTL_S
        while time.time() < deadline and out["status"] == "waiting":
            await asyncio.sleep(1.0)
            try:
                async with self.node.http.get(url, timeout=aiohttp.ClientTimeout(total=4)) as r:
                    st = await r.json()
            except Exception:
                continue
            if st["status"] == "approved":
                info = st["node"]
                self.peers[info["id"]] = {
                    "id": info["id"], "name": info.get("name", "?"), "host": out["host"],
                    "port": int(out["port"]), "token": st["token"], "paired_at": time.time(),
                    "hw": info.get("hw", {}),
                }
                self.store.save()
                out["status"] = "approved"
                self.node.hub.event("pair", f"Paired with {info.get('name')}", level="success", toast=True)
            elif st["status"] in ("denied", "expired", "completed"):
                out["status"] = st["status"]
                if st["status"] == "denied":
                    self.node.hub.event("pair", f"{out['to'].get('name')} declined the connection",
                                        level="warn", toast=True)
        if out["status"] == "waiting":
            out["status"] = "expired"
        self.node.hub.emit("pair_outgoing", out)
        self.emit()

    def cancel_outgoing(self, rid: str) -> None:
        o = self.outgoing.get(rid)
        if o:
            o["status"] = "cancelled"
            self.node.hub.emit("pair_outgoing", o)

    async def unpair(self, peer_id: str, notify: bool = True) -> None:
        if peer_id not in self.peers:
            return
        name = self.peers[peer_id]["name"]
        if notify:
            try:
                await self.call(peer_id, "POST", "/peer/unpair", timeout=3)
            except PeerError:
                pass
        self.peers.pop(peer_id, None)
        self.live.pop(peer_id, None)
        self.store.save()
        self.node.hub.event("pair", f"Unpaired {name}", level="warn", toast=True)
        self.emit()

    # ---------------------------------------------------------------- heartbeats
    async def heartbeat_loop(self) -> None:
        while True:
            ids = list(self.peers)
            if ids:
                await asyncio.gather(*(self._beat(pid) for pid in ids), return_exceptions=True)
                self.emit()
            await asyncio.sleep(1.0)

    async def _beat(self, pid: str) -> None:
        live = self.live.setdefault(pid, {"online": False, "misses": 0, "samples": deque(maxlen=16)})
        t0 = now_ms()
        try:
            r = await self.call(pid, "GET", f"/peer/heartbeat?t0={t0:.3f}", timeout=2.5)
        except PeerError as e:
            live["misses"] += 1
            live["error"] = str(e)
            if live["misses"] >= 3 and live["online"]:
                live["online"] = False
                self.node.hub.event("peer", f"{self.peers.get(pid, {}).get('name', pid)} went offline", level="warn")
            return
        t3 = now_ms()
        t1, t2 = float(r["t1"]), float(r["t2"])
        rtt = max((t3 - t0) - (t2 - t1), 0.0)
        offset = ((t1 - t0) + (t2 - t3)) / 2.0
        live["samples"].append((rtt, offset, t3))
        best = min(list(live["samples"])[-8:], key=lambda x: x[0])  # NTP clock-filter
        was = live["online"]
        live.update({
            "online": True, "misses": 0, "error": None, "last_ok": t3,
            "rtt_ms": rtt, "rtt_best_ms": best[0], "offset_ms": best[1], "offset_err_ms": best[0] / 2.0,
            "info": r.get("info"), "telemetry": r.get("telemetry"), "gate": r.get("gate"),
            "worker": r.get("worker"),
        })
        p = self.peers[pid]
        info = r.get("info") or {}
        if info.get("name") and info["name"] != p["name"]:
            p["name"] = info["name"]
            self.store.save()
        if not was:
            self.node.hub.event("peer", f"{p['name']} is online", level="success")

    # ---------------------------------------------------------------- views
    def view(self) -> list[dict]:
        out = []
        for pid, p in self.peers.items():
            live = self.live.get(pid, {})
            out.append({
                "id": pid, "name": p["name"], "host": p["host"], "port": p["port"],
                "paired_at": p.get("paired_at"), "hw": (live.get("info") or {}).get("hw") or p.get("hw"),
                "online": live.get("online", False), "rtt_ms": live.get("rtt_ms"),
                "rtt_best_ms": live.get("rtt_best_ms"), "offset_ms": live.get("offset_ms"),
                "offset_err_ms": live.get("offset_err_ms"), "error": live.get("error"),
                "info": live.get("info"), "telemetry": live.get("telemetry"),
                "gate": live.get("gate"), "worker": live.get("worker"),
            })
        return out

    def emit(self) -> None:
        self.node.hub.emit("peers", self.view())

    def pending_view(self) -> dict:
        self._expire()
        return {
            "incoming": [self._public_req(r) for r in self.incoming.values() if r["status"] == "pending"],
            "outgoing": [o for o in self.outgoing.values() if o["status"] == "waiting"],
        }
