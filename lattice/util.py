"""Small shared helpers: time, networking, Windows timer resolution."""
from __future__ import annotations

import ctypes
import ipaddress
import socket
import sys
import time

import psutil


def now_ms() -> float:
    return time.time() * 1000.0


def mono() -> float:
    return time.perf_counter()


def fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


def ipv4_interfaces() -> list[dict]:
    """Up, non-loopback IPv4 interfaces with their directed broadcast address."""
    out = []
    stats = psutil.net_if_stats()
    for name, addrs in psutil.net_if_addrs().items():
        st = stats.get(name)
        if st is not None and not st.isup:
            continue
        for a in addrs:
            if a.family != socket.AF_INET or not a.address or not a.netmask:
                continue
            ip = ipaddress.IPv4Address(a.address)
            if ip.is_loopback or ip.is_link_local:
                continue
            try:
                net = ipaddress.IPv4Network(f"{a.address}/{a.netmask}", strict=False)
            except ValueError:
                continue
            out.append({
                "name": name,
                "address": a.address,
                "netmask": a.netmask,
                "broadcast": str(net.broadcast_address),
                "virtual": any(k in name.lower() for k in ("vethernet", "virtual", "vmware", "vbox", "hyper-v", "wsl", "loopback")),
            })
    return out


def primary_ip() -> str:
    """The source address the OS would use for LAN/Internet traffic (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        ifs = [i for i in ipv4_interfaces() if not i["virtual"]]
        return ifs[0]["address"] if ifs else "127.0.0.1"
    finally:
        s.close()


def is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def high_resolution_timers() -> None:
    """Ask Windows for 1 ms timer resolution so asyncio sleeps (used for latency
    injection) are accurate to ~1 ms instead of the default 15.6 ms tick."""
    if sys.platform == "win32":
        try:
            ctypes.WinDLL("winmm").timeBeginPeriod(1)
        except OSError:
            pass


def set_nodelay(sock) -> None:
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
