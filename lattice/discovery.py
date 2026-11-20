"""Zero-config LAN discovery.

Each node multicasts (239.255.74.71:7471) and broadcasts a small JSON beacon every
2 s on every IPv4 interface. Multicast loopback means several nodes on the same
machine also see each other. Nodes can additionally be added by IP when a network
blocks multicast/broadcast (common on campus Wi-Fi with client isolation).
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import struct
import time
from typing import TYPE_CHECKING

import aiohttp

from .config import DISCOVERY_PORT, MCAST_GROUP, PROTOCOL
from .util import ipv4_interfaces, primary_ip

if TYPE_CHECKING:
    from .node import Node

STALE_S = 8.0


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, disc: "Discovery") -> None:
        self.disc = disc

    def datagram_received(self, data: bytes, addr) -> None:
        self.disc.on_packet(data, addr)

    def error_received(self, exc) -> None:
        pass


class Discovery:
    def __init__(self, node: "Node") -> None:
        self.node = node
        self.nearby: dict[str, dict] = {}
        self.manual: dict[str, dict] = {}   # "host:port" -> {host, port}
        self.sock: socket.socket | None = None
        self.transport = None
        self.joined: set[str] = set()
        self.listening = False
        self.errors: list[str] = []
        self._last_emit = 0.0

    # ------------------------------------------------------------------ setup
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        try:
            s.bind(("", DISCOVERY_PORT))
            self.listening = True
        except OSError as e:
            self.errors.append(f"cannot bind UDP {DISCOVERY_PORT}: {e}")
            s.bind(("", 0))
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        s.setblocking(False)
        self.sock = s
        self._join_groups()
        self.transport, _ = await loop.create_datagram_endpoint(lambda: _Proto(self), sock=s)
        asyncio.create_task(self._beacon_loop())
        asyncio.create_task(self._maintain_loop())

    def _join_groups(self) -> None:
        if not self.sock:
            return
        for iface in ipv4_interfaces():
            a = iface["address"]
            if a in self.joined:
                continue
            try:
                mreq = struct.pack("4s4s", socket.inet_aton(MCAST_GROUP), socket.inet_aton(a))
                self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
                self.joined.add(a)
            except OSError:
                pass

    # ------------------------------------------------------------------ send
    def _payload(self, kind: str = "beacon") -> bytes:
        return json.dumps({"app": "lattice", "proto": PROTOCOL, "kind": kind,
                           "node": self.node.beacon_info()}, separators=(",", ":")).encode()

    def _send_all(self, kind: str = "beacon") -> None:
        if not self.sock or not self.node.settings.data.get("allow_discovery", True):
            return
        data = self._payload(kind)
        for iface in ipv4_interfaces():
            try:
                self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface["address"]))
                self.sock.sendto(data, (MCAST_GROUP, DISCOVERY_PORT))
            except OSError:
                pass
            try:
                self.sock.sendto(data, (iface["broadcast"], DISCOVERY_PORT))
            except OSError:
                pass

    async def _beacon_loop(self) -> None:
        self._send_all("probe")
        while True:
            self._send_all("beacon")
            await asyncio.sleep(2.0)

    async def _maintain_loop(self) -> None:
        n = 0
        while True:
            await asyncio.sleep(2.0)
            n += 1
            now = time.time()
            changed = False
            for nid, e in list(self.nearby.items()):
                if e.get("via") == "lan" and now - e["last_seen"] > STALE_S * 4:
                    del self.nearby[nid]
                    changed = True
            if n % 15 == 0:
                self._join_groups()
            if self.manual:
                await self._probe_manual()
            if changed or now - self._last_emit > 4:
                self.emit()

    # ------------------------------------------------------------------ receive
    def _score(self, host: str) -> int:
        try:
            ip = ipaddress.IPv4Address(host)
        except ValueError:
            return 0
        if ip.is_loopback:
            return 1
        for iface in ipv4_interfaces():
            net = ipaddress.IPv4Network(f"{iface['address']}/{iface['netmask']}", strict=False)
            if ip in net:
                return 3 if not iface["virtual"] else 1
        return 2

    def on_packet(self, data: bytes, addr) -> None:
        try:
            msg = json.loads(data)
        except ValueError:
            return
        if not isinstance(msg, dict) or msg.get("app") != "lattice":
            return
        info = msg.get("node") or {}
        nid = info.get("id")
        if not nid or nid == self.node.id:
            return
        if msg.get("kind") == "probe" and self.transport:
            try:
                self.transport.sendto(self._payload("beacon"), addr)
            except OSError:
                pass
        self.observe(info, addr[0], "lan")

    def observe(self, info: dict, host: str, via: str) -> None:
        nid = info["id"]
        now = time.time()
        prev = self.nearby.get(nid)
        if prev and prev["host"] != host:
            stale = now - prev["last_seen"] > 6
            if not stale and self._score(host) < self._score(prev["host"]):
                host = prev["host"]  # keep the better route
        entry = {**info, "host": host, "last_seen": now, "via": via if not prev else prev.get("via", via)}
        if via == "manual":
            entry["via"] = "manual"
        self.nearby[nid] = entry
        self.node.peers.observe_address(nid, host, info.get("port"))
        if not prev or prev.get("name") != info.get("name") or prev.get("host") != host \
                or prev.get("state") != info.get("state"):
            self.emit()

    # ------------------------------------------------------------------ manual
    async def add_manual(self, host: str, port: int) -> dict:
        info = await self._hello(host, port)
        self.manual[f"{host}:{port}"] = {"host": host, "port": port}
        self.observe(info, host, "manual")
        return info

    async def _hello(self, host: str, port: int) -> dict:
        url = f"http://{host}:{port}/peer/hello"
        async with self.node.http.get(url, timeout=aiohttp.ClientTimeout(total=3)) as r:
            r.raise_for_status()
            info = await r.json()
        if info.get("app") != "lattice":
            raise ValueError("not a Lattice node")
        return info["node"]

    async def _probe_manual(self) -> None:
        for key, m in list(self.manual.items()):
            try:
                info = await self._hello(m["host"], m["port"])
                if info["id"] == self.node.id:
                    self.manual.pop(key, None)
                    continue
                self.observe(info, m["host"], "manual")
            except Exception:
                pass

    # ------------------------------------------------------------------ view
    def view(self) -> list[dict]:
        now = time.time()
        out = []
        for e in self.nearby.values():
            age = now - e["last_seen"]
            out.append({**e, "age": age, "online": age < STALE_S,
                        "paired": e["id"] in self.node.peers.peers})
        out.sort(key=lambda x: (not x["online"], x.get("name", "")))
        return out

    def emit(self) -> None:
        self._last_emit = time.time()
        self.node.hub.emit("nearby", self.view())

    def status(self) -> dict:
        return {"listening": self.listening, "port": DISCOVERY_PORT, "group": MCAST_GROUP,
                "interfaces": [i["address"] for i in ipv4_interfaces()], "lan_ip": primary_ip(),
                "errors": self.errors}
