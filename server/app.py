"""GNSS Survey Console - cloud relay.

A byte relay plus a small meeting point for survey results, and the static
page: no USB/serial access of its own. Base and Rover run entirely in the
browser (Web Serial) or the Android app. On a named channel (one per site):

  - whatever the "base" connection sends is rebroadcast to every "rover";
  - a rover may send its live fix as JSON text; it goes to every "watch"
    connection (the Site map), wherever that is;
  - finished point results are stored per label, newest `at` wins, so the
    Site map on any device sees what any console or app surveyed;
  - a channel can be cleared: everything surveyed up to the clear's `at` is
    gone, and an older copy a device uploads later is refused.

    GET    /healthz                         liveness + version
    GET    /status/{channel}                base live?, rovers, watchers, results
    GET    /results/{channel}               every stored result (and deletion marker), the clear
    PUT    /results/{channel}/{label}       store one (kept only if newer)
    DELETE /results/{channel}?at=&source=   clear the channel (newest clear wins)
    WS     /ws/relay/{channel}?role=base|rover|watch

Results live in memory: a free host that sleeps forgets them, so every
client keeps its own copy and re-uploads it (newest-wins makes that safe;
the clear is re-uploaded the same way).

Run with:  python3 server/app.py [--host 0.0.0.0] [--port 8765]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import time
from datetime import datetime

from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

VERSION = "5"
SEND_TIMEOUT_S = 5.0
IDLE_CHANNEL_TTL_S = 600.0
MAX_RESULTS_PER_CHANNEL = 200
MAX_CHANNELS_WITH_RESULTS = 500
PVT_MIN_INTERVAL_S = 0.2       # a rover's live fix: at most 5 per second
PVT_FRESH_S = 10.0             # a new watcher gets the last fix if younger than this
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")

app = FastAPI(title="GNSS Survey Console relay")

# The page is served from GitHub Pages, so CORS must be open. There's no
# cookie auth or user data for a cross-origin request to steal; access
# control is knowing the relay address and channel name (see README).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")


class Channel:
    def __init__(self) -> None:
        # Newest base last. Only the newest is forwarded: a base that
        # reconnects after a network blip supersedes its half-dead old
        # socket, and two different bases never get interleaved into one
        # unusable RTCM stream.
        self.bases: list[WebSocket] = []
        self.rovers: set[WebSocket] = set()
        self.watchers: set[WebSocket] = set()
        self.bytes_from_base = 0
        self.last_base_data_at = 0.0
        self.last_activity = time.monotonic()
        self.results: dict[str, dict] = {}
        self.cleared: dict | None = None  # {at, source}: results up to `at` are gone
        self.last_pvt: dict | None = None
        self.last_pvt_at = 0.0


_channels: dict[str, Channel] = {}


def _channel(name: str) -> Channel:
    now = time.monotonic()
    for key in [k for k, c in _channels.items()
                if not c.bases and not c.rovers and not c.watchers and not c.results and not c.cleared
                and now - c.last_activity > IDLE_CHANNEL_TTL_S]:
        del _channels[key]
    chan = _channels.setdefault(name, Channel())
    chan.last_activity = now
    return chan


def _room_for(channel: str) -> None:
    if channel not in _channels and sum(1 for c in _channels.values() if c.results or c.cleared) >= MAX_CHANNELS_WITH_RESULTS:
        raise HTTPException(507, "relay full")


_background: set[asyncio.Task] = set()


async def _close_quietly(ws: WebSocket) -> None:
    try:
        await asyncio.wait_for(ws.close(), SEND_TIMEOUT_S)
    except Exception:
        pass


async def _send_or_drop(chan: Channel, rover: WebSocket, data: bytes) -> None:
    try:
        await asyncio.wait_for(rover.send_bytes(data), SEND_TIMEOUT_S)
    except Exception:
        chan.rovers.discard(rover)
        # Close in the background: a stalled rover's close handshake is
        # stuck behind the same full buffer, and awaiting it here would
        # stall the base (and every other rover) along with it.
        task = asyncio.create_task(_close_quietly(rover))
        _background.add(task)
        task.add_done_callback(_background.discard)


async def _send_text(chan: Channel, ws: WebSocket, text: str) -> None:
    try:
        await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT_S)
    except Exception:
        chan.watchers.discard(ws)
        task = asyncio.create_task(_close_quietly(ws))
        _background.add(task)
        task.add_done_callback(_background.discard)


async def _to_watchers(chan: Channel, event: dict) -> None:
    if chan.watchers:
        text = json.dumps(event)
        await asyncio.gather(*(_send_text(chan, w, text) for w in list(chan.watchers)))


def _num(d: dict, key: str, lo: float, hi: float) -> float:
    v = d.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"{key} must be a number in [{lo}, {hi}]")
    return float(v)


def _when(d: dict) -> datetime:
    at = d.get("at")
    if not isinstance(at, str) or len(at) > 40:
        raise ValueError("at must be an ISO-8601 time")
    t = datetime.fromisoformat(at.replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError("at needs a time zone (e.g. ...Z)")
    return t


def _clean_result(d: dict) -> dict:
    """A point result as the console/app record it, or a deletion marker."""
    if not isinstance(d, dict):
        raise ValueError("expected a JSON object")
    _when(d)
    source = d.get("source", "")
    if not isinstance(source, str) or len(source) > 60:
        raise ValueError("source must be a short string")
    if d.get("deleted") is True:
        return {"deleted": True, "at": d["at"], "source": source}
    n = d.get("n")
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 1_000_000:
        raise ValueError("n must be a positive integer")
    if not isinstance(d.get("all_fixed"), bool):
        raise ValueError("all_fixed must be true/false")
    return {
        "lat_deg": _num(d, "lat_deg", -90, 90), "lon_deg": _num(d, "lon_deg", -180, 180),
        "height_msl_m": _num(d, "height_msl_m", -1000, 20000), "spread_m": _num(d, "spread_m", 0, 1000),
        "n": n, "all_fixed": d["all_fixed"], "at": d["at"], "source": source,
    }


def _clean_clear(at: str, source: str) -> dict:
    d = {"at": at, "source": source}
    _when(d)
    if len(source) > 60:
        raise ValueError("source must be a short string")
    return d


def _clean_pvt(d: dict) -> dict:
    out = {"type": "pvt", "lat": _num(d, "lat", -90, 90), "lon": _num(d, "lon", -180, 180),
           "h": _num(d, "h", -1000, 20000), "carrSoln": int(_num(d, "carrSoln", 0, 2)),
           "hAccM": _num(d, "hAccM", 0, 1e6), "numSv": int(_num(d, "numSv", 0, 255))}
    source = d.get("source", "")
    out["source"] = source[:60] if isinstance(source, str) else ""
    return out


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "service": "gnss-relay",
        "version": VERSION,
        "commit": os.environ.get("RENDER_GIT_COMMIT", "")[:7],
        "channels": sum(1 for c in _channels.values() if c.bases or c.rovers),
    }


@app.get("/status/{channel}")
def status(channel: str) -> dict:
    chan = _channels.get(channel)
    if chan is None:
        return {"channel": channel, "base_online": False, "bases": 0, "rovers": 0, "watchers": 0,
                "bytes_from_base": 0, "last_base_data_age_s": None, "results": 0}
    return {
        "channel": channel,
        "base_online": bool(chan.bases),
        "bases": len(chan.bases),
        "rovers": len(chan.rovers),
        "watchers": len(chan.watchers),
        "bytes_from_base": chan.bytes_from_base,
        "last_base_data_age_s": (time.time() - chan.last_base_data_at) if chan.last_base_data_at else None,
        "results": sum(1 for r in chan.results.values() if not r.get("deleted")),
    }


@app.get("/results/{channel}")
def get_results(channel: str) -> dict:
    chan = _channels.get(channel)
    return {"channel": channel, "results": dict(chan.results) if chan else {}, "cleared": chan.cleared if chan else None}


@app.put("/results/{channel}/{label}")
async def put_result(channel: str, label: str, body: dict = Body(...)) -> dict:
    if not LABEL_RE.match(label):
        raise HTTPException(422, "label: letters, digits, _ . - only (max 40)")
    try:
        new = _clean_result(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    _room_for(channel)
    chan = _channel(channel)
    if chan.cleared is not None and _when(new) <= _when(chan.cleared):
        # from before the channel was cleared: a device that missed the clear
        return {"stored": False, "result": chan.results.get(label), "cleared": chan.cleared}
    old = chan.results.get(label)
    if old is not None and _when(old) >= _when(new):
        return {"stored": False, "result": old}  # what's here is as new or newer
    if old is None and len(chan.results) >= MAX_RESULTS_PER_CHANNEL:
        raise HTTPException(507, f"at most {MAX_RESULTS_PER_CHANNEL} results per channel")
    chan.results[label] = new
    await _to_watchers(chan, {"type": "result", "label": label, "result": new})
    return {"stored": True, "result": new}


@app.delete("/results/{channel}")
async def clear_results(channel: str, at: str, source: str = "") -> dict:
    """Clears the channel up to `at`. Each result it covers becomes a deletion
    marker, so a client that predates clearing drops its copy too."""
    try:
        new = _clean_clear(at, source)
    except ValueError as e:
        raise HTTPException(422, str(e))
    _room_for(channel)
    chan = _channel(channel)
    if chan.cleared is not None and _when(chan.cleared) >= _when(new):
        return {"cleared": False, "marker": chan.cleared}  # cleared as late or later already
    chan.cleared = new
    for label, r in list(chan.results.items()):
        if _when(r) <= _when(new):
            chan.results[label] = {"deleted": True, "at": new["at"], "source": new["source"]}
    await _to_watchers(chan, {"type": "cleared", "cleared": new})
    return {"cleared": True, "marker": new}


@app.websocket("/ws/relay/{channel}")
async def ws_relay(websocket: WebSocket, channel: str, role: str = "rover") -> None:
    if role not in ("base", "rover", "watch"):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    chan = _channel(channel)

    if role == "base":
        chan.bases.append(websocket)
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                if not data or chan.bases[-1] is not websocket:
                    continue
                chan.bytes_from_base += len(data)
                chan.last_base_data_at = time.time()
                chan.last_activity = time.monotonic()
                if chan.rovers:
                    await asyncio.gather(*(_send_or_drop(chan, r, data) for r in list(chan.rovers)))
        finally:
            if websocket in chan.bases:
                chan.bases.remove(websocket)
            chan.last_activity = time.monotonic()
    elif role == "rover":
        # Binary in = corrections out to the receiver; text from the rover =
        # its live fix as JSON, passed on to the channel's watchers.
        chan.rovers.add(websocket)
        last_pvt = 0.0
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                text = msg.get("text")
                if not text or len(text) > 2048 or time.monotonic() - last_pvt < PVT_MIN_INTERVAL_S:
                    continue
                try:
                    pvt = _clean_pvt(json.loads(text))
                except (ValueError, TypeError, AttributeError):
                    continue
                last_pvt = time.monotonic()
                chan.last_pvt, chan.last_pvt_at = pvt, time.time()
                await _to_watchers(chan, pvt)
        finally:
            chan.rovers.discard(websocket)
            chan.last_activity = time.monotonic()
    else:
        # watch: receives rovers' live fixes and new results as JSON text
        chan.watchers.add(websocket)
        try:
            if chan.last_pvt and time.time() - chan.last_pvt_at < PVT_FRESH_S:
                await _send_text(chan, websocket, json.dumps({**chan.last_pvt, "age_s": time.time() - chan.last_pvt_at}))
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
        finally:
            chan.watchers.discard(websocket)
            chan.last_activity = time.monotonic()


# Mounted last so the routes above take precedence. Optional: a relay-only
# deploy may not ship web/, since GitHub Pages serves the page.
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:
    @app.get("/")
    def root() -> dict:
        return {"service": "gnss-relay", "version": VERSION}


def main() -> None:
    import uvicorn

    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
