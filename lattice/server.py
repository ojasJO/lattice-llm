"""HTTP surface.

/            dashboard (static SPA)          - loopback only
/api/*, /ws  dashboard API + live stream     - loopback only, CSRF-guarded
/peer/*      node-to-node API                - LAN, HMAC-signed (except hello/pairing)
/get         download Lattice itself          - LAN (bootstraps new laptops)
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from typing import TYPE_CHECKING

from aiohttp import WSMsgType, web

from .bundle import build_zip
from .config import LLAMA_ASSET, ROOT, VERSION, WEB_DIR
from .experiments import PROMPTS, ExperimentError, to_csv
from .inference import CSV_FIELDS, run_row
from .models import CATALOG, HF, safe_name
from .peers import PeerError
from .session import LaunchError
from .util import is_loopback, now_ms

if TYPE_CHECKING:
    from .node import Node

OPEN_PEER = {"/peer/hello", "/peer/pair/request", "/peer/pair/status"}


def jerr(msg: str, status: int = 400) -> web.Response:
    return web.json_response({"error": msg}, status=status)


def build_app(node: "Node") -> web.Application:
    @web.middleware
    async def guard(request: web.Request, handler):
        path = request.path
        remote = request.remote
        if path.startswith("/peer/"):
            if path not in OPEN_PEER:
                peer = node.peers.verify(request.method, path, request.headers)
                if not peer:
                    return jerr("unauthorized peer", 401)
                request["peer"] = peer
                if remote and not is_loopback(remote) and peer["host"] != remote and not node.peers.online(peer["id"]):
                    node.peers.observe_address(peer["id"], remote, None)
        elif path == "/get" or path.startswith("/get/"):
            pass
        else:
            if not is_loopback(remote):
                return web.Response(status=403, text="The Lattice dashboard is only served to this computer.\n"
                                                     "Open http://127.0.0.1:%d on the machine itself.\n"
                                                     "New laptop? Download Lattice from /get" % node.ports.http)
            if path.startswith("/api/") and request.method in ("POST", "PUT", "DELETE"):
                if request.headers.get("X-Lattice-UI") != "1":
                    return jerr("missing X-Lattice-UI header", 403)
            origin = request.headers.get("Origin")
            if origin and not any(origin == f"http://{h}:{node.ports.http}" for h in ("127.0.0.1", "localhost", "[::1]")):
                return jerr("cross-origin request blocked", 403)
        try:
            resp = await handler(request)
            if path.startswith("/static/"):
                resp.headers["Cache-Control"] = "no-cache"
            return resp
        except web.HTTPException:
            raise
        except (LaunchError, ExperimentError, PeerError, ValueError, RuntimeError) as e:
            return jerr(str(e), 400)

    app = web.Application(middlewares=[guard], client_max_size=64 * 1024 * 1024)
    r = app.router

    # ================================================================ dashboard
    async def index(_):
        resp = web.FileResponse(WEB_DIR / "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    r.add_get("/", index)
    r.add_static("/static/", WEB_DIR, append_version=False)

    async def ws_handler(request: web.Request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        await ws.send_str(json.dumps({"t": "snapshot", "d": node.snapshot()}, default=str))
        node.hub.clients.add(ws)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT and msg.data == "ping":
                    await ws.send_str('{"t":"pong"}')
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        finally:
            node.hub.clients.discard(ws)
        return ws

    r.add_get("/ws", ws_handler)

    async def api_state(_):
        return web.json_response(node.snapshot(), dumps=lambda o: json.dumps(o, default=str))

    r.add_get("/api/state", api_state)

    async def api_settings(request):
        body = await request.json()
        if "name" in body:
            node.rename(str(body.pop("name")))
        for k in ("worker_device", "worker_threads", "allow_discovery", "theme"):
            if k in body:
                node.settings.data[k] = body[k]
        node.settings.save()
        node.emit_info()
        return web.json_response(node.self_view())

    r.add_post("/api/settings", api_settings)

    # ---------------------------------------------------------------- discovery & pairing
    async def api_add_manual(request):
        body = await request.json()
        host = str(body.get("host", "")).strip()
        if ":" in host and host.count(":") == 1:
            host, p = host.split(":")
            port = int(p)
        else:
            port = int(body.get("port") or 7470)
        if not host:
            return jerr("enter an IP address")
        try:
            info = await node.discovery.add_manual(host, port)
        except Exception as e:
            return jerr(f"no Lattice node answered at {host}:{port} ({type(e).__name__})")
        return web.json_response(info)

    r.add_post("/api/discovery/add", api_add_manual)

    async def api_pair(request):
        body = await request.json()
        nid = body.get("id")
        target = node.discovery.nearby.get(nid) if nid else None
        host = body.get("host") or (target or {}).get("host")
        port = int(body.get("port") or (target or {}).get("port") or 7470)
        if not host:
            return jerr("unknown device")
        out = await node.peers.request_pair(host, port)
        return web.json_response(out)

    r.add_post("/api/pair/request", api_pair)

    async def api_pair_respond(request):
        body = await request.json()
        return web.json_response(node.peers.respond(body["request_id"], bool(body.get("approve"))))

    r.add_post("/api/pair/respond", api_pair_respond)

    async def api_pair_cancel(request):
        body = await request.json()
        node.peers.cancel_outgoing(body.get("request_id", ""))
        return web.json_response({"ok": True})

    r.add_post("/api/pair/cancel", api_pair_cancel)

    async def api_unpair(request):
        await node.peers.unpair(request.match_info["id"])
        return web.json_response({"ok": True})

    r.add_post("/api/peers/{id}/unpair", api_unpair)

    # ---------------------------------------------------------------- models & runtime
    async def api_models(_):
        await node.models.scan()
        node.hub.emit("models", node.models.list())
        return web.json_response({"models": node.models.list(), "catalog": node.models.catalog_view()})

    r.add_get("/api/models", api_models)

    async def api_model_inspect(request):
        m = node.models.get(request.match_info["name"])
        if not m:
            return jerr("not found", 404)
        return web.json_response(m, dumps=lambda o: json.dumps(o, default=str))

    r.add_get("/api/models/{name}", api_model_inspect)

    async def api_model_delete(request):
        name = request.match_info["name"]
        if node.session.state in ("ready", "launching") and name in ((node.session.config or {}).get("target"),
                                                                    (node.session.config or {}).get("draft")):
            return jerr("model is in use by the running cluster")
        node.models.delete(name)
        await node.models.scan()
        node.hub.emit("models", node.models.list())
        node.hub.emit("catalog", node.models.catalog_view())
        return web.json_response({"ok": True})

    r.add_delete("/api/models/{name}", api_model_delete)

    async def _after_model_download(_d):
        await node.models.scan()
        node.hub.emit("models", node.models.list())
        node.hub.emit("catalog", node.models.catalog_view())
        node.emit_info()

    async def api_model_download(request):
        body = await request.json()
        file = safe_name(body.get("file", ""))
        cat = next((c for c in CATALOG if c["file"] == file), None)
        lan = node.models.lan_index().get(file, [])
        sources = []
        pref = body.get("peer_id")
        for p in sorted(lan, key=lambda x: x["id"] != pref):
            sources.append({"type": "peer", "peer_id": p["id"], "label": p["name"]})
        if cat and body.get("allow_internet", True):
            sources.append({"type": "url", "url": HF.format(repo=cat["repo"], file=cat["file"]), "label": "huggingface.co"})
        elif body.get("url"):
            sources.append({"type": "url", "url": body["url"], "label": body["url"].split("/")[2]})
        if not sources:
            return jerr("no source has this file")
        size = cat["size"] if cat else (lan[0]["size"] if lan else None)
        d = node.downloads.add("models", file, node.paths.models / file, sources, size, _after_model_download)
        return web.json_response(d.view())

    r.add_post("/api/models/download", api_model_download)

    async def api_download_cancel(request):
        node.downloads.cancel(request.match_info["id"])
        return web.json_response({"ok": True})

    r.add_post("/api/downloads/{id}/cancel", api_download_cancel)

    async def api_download_clear(_):
        node.downloads.clear_finished()
        return web.json_response({"ok": True})

    r.add_post("/api/downloads/clear", api_download_clear)

    async def api_runtime_install(_):
        async def go():
            try:
                await node.runtime.ensure()
            except Exception as e:
                node.hub.event("runtime", f"Runtime install failed: {e}", level="error", toast=True)
            node.emit_info()
        asyncio.create_task(go())
        return web.json_response({"ok": True})

    r.add_post("/api/runtime/install", api_runtime_install)

    async def api_runtime_probe(_):
        await node.runtime.probe_devices()
        node.emit_info()
        return web.json_response(node.runtime.status())

    r.add_post("/api/runtime/probe", api_runtime_probe)

    # ---------------------------------------------------------------- session
    async def api_launch(request):
        cfg = await request.json()
        node.session.launch(cfg)
        return web.json_response({"ok": True})

    r.add_post("/api/session/launch", api_launch)

    async def api_stop(_):
        await node.session.stop()
        return web.json_response({"ok": True})

    r.add_post("/api/session/stop", api_stop)

    async def api_latency(request):
        body = await request.json()
        await node.session.set_latency(body["id"], float(body.get("ms", 0)))
        return web.json_response({"ok": True})

    r.add_post("/api/session/latency", api_latency)

    async def api_worker_stop(_):
        await node.runtime.worker_stop("stopped locally")
        return web.json_response({"ok": True})

    r.add_post("/api/worker/stop", api_worker_stop)

    # ---------------------------------------------------------------- inference
    async def api_chat(request):
        body = await request.json()
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                           "X-Accel-Buffering": "no"})
        await resp.prepare(request)

        async def send(ev: dict):
            await resp.write(f"data: {json.dumps(ev)}\n\n".encode())

        try:
            run = await node.inference.generate(body.get("messages", []), body.get("params", {}), send, tag="chat")
            await send({"type": "done", "run": run})
        except (ConnectionResetError, asyncio.CancelledError):
            raise
        except Exception as e:
            try:
                await send({"type": "error", "error": str(e)})
            except Exception:
                pass
        try:
            await resp.write_eof()
        except Exception:
            pass
        return resp

    r.add_post("/api/chat", api_chat)

    async def api_runs(_):
        return web.json_response(node.inference.runs(500))

    r.add_get("/api/runs", api_runs)

    async def api_runs_csv(_):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        for run in node.inference.runs(10_000):
            w.writerow(run_row(run))
        return web.Response(text=buf.getvalue(), content_type="text/csv",
                            headers={"Content-Disposition": 'attachment; filename="lattice-runs.csv"'})

    r.add_get("/api/runs.csv", api_runs_csv)

    async def api_runs_clear(_):
        node.inference.recent.clear()
        try:
            node.inference.path.unlink()
        except FileNotFoundError:
            pass
        node.hub.emit("runs", [])
        return web.json_response({"ok": True})

    r.add_post("/api/runs/clear", api_runs_clear)

    # ---------------------------------------------------------------- experiments
    async def api_exp_prompts(_):
        return web.json_response({k: {"label": v[0], "text": v[1]} for k, v in PROMPTS.items()})

    r.add_get("/api/experiments/prompts", api_exp_prompts)

    async def api_exp_list(_):
        return web.json_response(node.experiments.list())

    r.add_get("/api/experiments", api_exp_list)

    async def api_exp_start(request):
        exp = node.experiments.start(await request.json())
        return web.json_response({"id": exp["id"]})

    r.add_post("/api/experiments", api_exp_start)

    async def api_exp_get(request):
        eid = request.match_info["id"]
        if eid.endswith(".csv"):
            exp = node.experiments.get(eid[:-4])
            if not exp:
                return jerr("not found", 404)
            return web.Response(text=to_csv(exp), content_type="text/csv",
                                headers={"Content-Disposition": f'attachment; filename="lattice-{exp["id"]}.csv"'})
        if eid.endswith(".json"):
            exp = node.experiments.get(eid[:-5])
            if not exp:
                return jerr("not found", 404)
            return web.Response(text=json.dumps(exp, indent=1, default=str), content_type="application/json",
                                headers={"Content-Disposition": f'attachment; filename="lattice-{exp["id"]}.json"'})
        exp = node.experiments.get(eid)
        if not exp:
            return jerr("not found", 404)
        return web.json_response(exp, dumps=lambda o: json.dumps(o, default=str))

    r.add_get("/api/experiments/{id}", api_exp_get)

    async def api_exp_cancel(_):
        node.experiments.cancel()
        return web.json_response({"ok": True})

    r.add_post("/api/experiments/cancel", api_exp_cancel)

    async def api_exp_delete(request):
        node.experiments.delete(request.match_info["id"])
        node.hub.emit("experiments", node.experiments.list())
        return web.json_response({"ok": True})

    r.add_delete("/api/experiments/{id}", api_exp_delete)

    # ================================================================ peer API
    async def peer_hello(_):
        return web.json_response({"app": "lattice", "version": VERSION, "node": node.public_info()})

    r.add_get("/peer/hello", peer_hello)

    async def peer_pair_request(request):
        body = await request.json()
        info = body.get("node") or {}
        req = node.peers.create_incoming(info, request.remote or "")
        return web.json_response({"request_id": req["id"], "code": req["code"], "node": node.public_info()})

    r.add_post("/peer/pair/request", peer_pair_request)

    async def peer_pair_status(request):
        return web.json_response(node.peers.poll_incoming(request.query.get("request_id", "")))

    r.add_get("/peer/pair/status", peer_pair_status)

    async def peer_unpair(request):
        await node.peers.unpair(request["peer"]["id"], notify=False)
        return web.json_response({"ok": True})

    r.add_post("/peer/unpair", peer_unpair)

    async def peer_heartbeat(request):
        t1 = now_ms()
        gate = None
        if node.runtime.gate.running:
            gate = node.runtime.gate.stats.snapshot() | {"delay_ms": node.runtime.gate.delay_ms}
        body = {
            "t1": t1, "info": node.public_info(), "telemetry": node.telemetry.compact(),
            "gate": gate, "worker": node.runtime.worker_view(),
            "downloads": [d for d in node.downloads.view() if d["status"] == "running"],
        }
        body["t2"] = now_ms()
        return web.json_response(body)

    r.add_get("/peer/heartbeat", peer_heartbeat)

    async def peer_files(_):
        return web.json_response({"models": node.models.files_listing(), "runtime": node.runtime.files_listing()})

    r.add_get("/peer/files", peer_files)

    async def peer_file(request):
        kind, name = request.match_info["kind"], safe_name(request.match_info["name"])
        if kind == "models":
            path = node.paths.models / name
        elif kind == "runtime" and name == LLAMA_ASSET:
            path = node.runtime.dist_zip
        else:
            return jerr("not found", 404)
        if not path.exists():
            return jerr("not found", 404)
        node.hub.event("share", f"Sending {name} to {request['peer']['name']}")
        return web.FileResponse(path, chunk_size=1 << 20)

    r.add_get("/peer/files/{kind}/{name}", peer_file)

    async def peer_worker_prepare(request):
        await node.runtime.ensure(prefer_peer=request["peer"]["id"])
        return web.json_response({"devices": node.runtime.devices, "default": node.runtime.default_device()})

    r.add_post("/peer/worker/prepare", peer_worker_prepare)

    async def peer_worker_start(request):
        body = await request.json()
        coord = body.get("coordinator") or {}
        if coord.get("id") != request["peer"]["id"]:
            return jerr("coordinator identity mismatch", 403)
        res = await node.runtime.worker_start(coord, body.get("device"), int(body.get("threads") or 0),
                                              float(body.get("delay_ms") or 0), request.remote or "")
        return web.json_response(res)

    r.add_post("/peer/worker/start", peer_worker_start)

    async def peer_worker_stop(request):
        w = node.runtime.worker
        if w and w["coordinator_id"] != request["peer"]["id"]:
            return jerr("not your worker", 403)
        await node.runtime.worker_stop("coordinator released it")
        return web.json_response({"ok": True})

    r.add_post("/peer/worker/stop", peer_worker_stop)

    async def peer_worker_latency(request):
        w = node.runtime.worker
        if not w or w["coordinator_id"] != request["peer"]["id"]:
            return jerr("not your worker", 403)
        body = await request.json()
        node.runtime.set_delay(float(body.get("ms", 0)))
        return web.json_response({"ok": True})

    r.add_post("/peer/worker/latency", peer_worker_latency)

    async def peer_gate_stats(_):
        g = node.runtime.gate
        return web.json_response({"counters": g.stats.counters(), "delay_ms": g.delay_ms, "running": g.running})

    r.add_get("/peer/gate/stats", peer_gate_stats)

    # ================================================================ bootstrap
    zip_cache: dict = {}

    async def get_page(request):
        host = request.host
        return web.Response(content_type="text/html", text=f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Get Lattice</title>
<style>body{{font-family:Segoe UI,system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}}
.c{{max-width:560px;padding:32px;border:1px solid #232836;border-radius:16px;background:#11141b}}a.b{{display:inline-block;background:#6c8cff;color:#fff;
padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600}}code{{background:#1b2030;padding:2px 6px;border-radius:6px}}li{{margin:8px 0}}</style></head>
<body><div class="c"><h2>Join the Lattice cluster</h2><p>{node.name} is sharing Lattice {VERSION} with this network.</p>
<p><a class="b" href="/get/lattice.zip">Download lattice.zip</a></p><ol>
<li>Extract the zip anywhere (right-click → Extract All).</li>
<li>Open the folder, then run <code>start.bat</code> (or <code>.\\start.bat</code> in a terminal).</li>
<li>Allow Python through the firewall on <b>private networks</b> when Windows asks.</li>
<li>Your browser opens the dashboard: find <b>{node.name}</b> under Devices and press Connect.</li></ol>
<p style="color:#8b93a7">The llama.cpp runtime and models are fetched from {host} over the LAN, not the Internet.</p></div></body></html>""")

    async def get_zip(_):
        now = time.time()
        if not zip_cache or now - zip_cache["t"] > 30:
            data = await asyncio.get_running_loop().run_in_executor(None, build_zip, ROOT)
            zip_cache.update(t=now, data=data)
        return web.Response(body=zip_cache["data"], content_type="application/zip",
                            headers={"Content-Disposition": 'attachment; filename="lattice.zip"'})

    r.add_get("/get", get_page)
    r.add_get("/get/lattice.zip", get_zip)
    return app
