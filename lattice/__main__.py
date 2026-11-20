"""Entry point: python -m lattice [--port 7470] [--name NAME] [--home DIR] [--no-browser]"""
from __future__ import annotations

import argparse
import asyncio
import faulthandler
import socket
import sys
import time
import traceback
import webbrowser
from pathlib import Path

if sys.version_info < (3, 10):
    sys.exit("Lattice needs Python 3.10 or newer.")

from aiohttp import web  # noqa: E402

from .config import APP, DEFAULT_HTTP_PORT, LLAMA_LABEL, ROOT, VERSION  # noqa: E402
from .node import Node  # noqa: E402
from .server import build_app  # noqa: E402
from .util import high_resolution_timers  # noqa: E402

BOLD, DIM, CYAN, GREEN, RESET = "\033[1m", "\033[2m", "\033[36m", "\033[32m", "\033[0m"


def port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pick_port(preferred: int) -> int:
    # each node needs http, http+10 (gate), http+11 (rpc) and http+20 (llama-server)
    for p in [preferred] + list(range(preferred + 100, preferred + 1000, 100)):
        if all(port_free(x) for x in (p, p + 10, p + 11, p + 20)):
            return p
    raise SystemExit("no free port block found")


async def main_async(args) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    high_resolution_timers()
    asyncio.get_running_loop().set_exception_handler(_loop_exception)
    port = pick_port(args.port)
    home = Path(args.home).resolve() if args.home else ROOT
    node = Node(home, port, args.name, discovery=not args.no_discovery)
    app = build_app(node)
    runner = web.AppRunner(app, access_log=None, handle_signals=False)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port, reuse_address=False)
    await site.start()
    await node.start()
    url = f"http://127.0.0.1:{port}"
    lan = f"http://{node.lan_ip}:{port}"
    if sys.platform == "win32":
        import os
        os.system("")  # enable ANSI colours in the Windows console
    print(f"""
  {BOLD}{CYAN}◆ {APP}{RESET} {DIM}v{VERSION} · distributed LLM inference · {LLAMA_LABEL}{RESET}

  {BOLD}Node{RESET}        {node.name}  {DIM}({node.id}){RESET}
  {BOLD}Dashboard{RESET}   {GREEN}{url}{RESET}
  {BOLD}LAN{RESET}         {lan}   {DIM}← other laptops find this node automatically{RESET}
  {BOLD}New laptop{RESET}  open {lan}/get on it to download Lattice
  {DIM}Runtime: {'installed' if node.runtime.installed else 'not installed yet (fetched on first launch)'} · models: {len(node.models.models)} · data: {node.paths.home}{RESET}

  {DIM}Press Ctrl+C to stop.{RESET}
""", flush=True)
    if not args.no_browser and node.settings.data.get("auto_open_browser", True):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        print("\n  shutting down…", flush=True)
        await node.shutdown()
        await runner.cleanup()


def _loop_exception(loop, ctx) -> None:
    """A peer vanishing mid-transfer is normal in a cluster; don't spray tracebacks for it."""
    exc = ctx.get("exception")
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return
    loop.default_exception_handler(ctx)


def _crash_log(home: Path) -> Path:
    d = home / "data" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d / "crash.log"


def main() -> None:
    ap = argparse.ArgumentParser(prog="lattice", description="Pool nearby laptops into one LLM inference cluster.")
    ap.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT, help="dashboard/peer HTTP port (default 7470)")
    ap.add_argument("--name", help="display name for this node (default: computer name)")
    ap.add_argument("--home", help="state directory (data, models, runtime); default: the Lattice folder")
    ap.add_argument("--no-browser", action="store_true", help="do not open the dashboard automatically")
    ap.add_argument("--no-discovery", action="store_true", help="disable LAN discovery beacons")
    args = ap.parse_args()
    log = _crash_log(Path(args.home).resolve() if args.home else ROOT)
    fh = open(log, "a", encoding="utf-8")
    faulthandler.enable(fh)  # hard crashes (access violations in native code) leave a trace here
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except BaseException:
        tb = traceback.format_exc()
        fh.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} Lattice crashed ===\n{tb}")
        fh.flush()
        print(f"\n  Lattice crashed. Details were saved to {log}\n\n{tb}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
