"""GNSS Survey Console - cloud relay.

A pure byte relay plus the static page: no USB/serial access of its own.
Base and Rover run entirely in the browser (Web Serial) or the Android app;
on a named channel, whatever the "base" connection sends is rebroadcast to
every "rover" connection.

    GET  /healthz             liveness + version
    GET  /status/{channel}    is a base live on this channel, how many rovers
    WS   /ws/relay/{channel}?role=base|rover

Run with:  python3 server/app.py [--host 0.0.0.0] [--port 8765]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

VERSION = "3"
SEND_TIMEOUT_S = 5.0
IDLE_CHANNEL_TTL_S = 600.0

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
        self.bytes_from_base = 0
        self.last_base_data_at = 0.0
        self.last_activity = time.monotonic()


_channels: dict[str, Channel] = {}


def _channel(name: str) -> Channel:
    now = time.monotonic()
    for key in [k for k, c in _channels.items()
                if not c.bases and not c.rovers and now - c.last_activity > IDLE_CHANNEL_TTL_S]:
        del _channels[key]
    chan = _channels.setdefault(name, Channel())
    chan.last_activity = now
    return chan


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
        return {"channel": channel, "base_online": False, "bases": 0, "rovers": 0,
                "bytes_from_base": 0, "last_base_data_age_s": None}
    return {
        "channel": channel,
        "base_online": bool(chan.bases),
        "bases": len(chan.bases),
        "rovers": len(chan.rovers),
        "bytes_from_base": chan.bytes_from_base,
        "last_base_data_age_s": (time.time() - chan.last_base_data_at) if chan.last_base_data_at else None,
    }


@app.websocket("/ws/relay/{channel}")
async def ws_relay(websocket: WebSocket, channel: str, role: str = "rover") -> None:
    if role not in ("base", "rover"):
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
    else:
        chan.rovers.add(websocket)
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
        finally:
            chan.rovers.discard(websocket)
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
