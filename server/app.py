"""GNSS Survey Console - backend.

This is now a pure byte relay plus the static page - it has no USB/serial
access of its own. Base and Rover both run entirely in-browser (Web Serial)
or in the Android app, each uploading/downloading RTCM3 bytes on a named
channel; this process just rebroadcasts whatever the "base" role on a
channel sends to every "rover" role connected to the same channel. Because
it never touches hardware, this is the one piece of the system that could
genuinely run on ordinary free cloud compute (Render, Fly.io, ...) instead
of a machine wired to GPS receivers - see README for deploy notes.

Run with:  python3 server/app.py [--host 0.0.0.0] [--port 8765]
"""

from __future__ import annotations

import argparse
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="GNSS Survey Console")

# The control page is hosted separately from this backend (GitHub Pages) -
# CORS has to be open for its fetch()/WebSocket calls to reach here. There's
# no user data or cookie-based auth on this API for a cross-origin request
# to steal; the real access control is "do you know this backend's address"
# (see README's security note).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")

# channel name -> {"base": WebSocket | None, "rovers": set[WebSocket]}
_relay_channels: dict[str, dict] = {}


@app.websocket("/ws/relay/{channel}")
async def ws_relay(websocket: WebSocket, channel: str, role: str = "rover") -> None:
    await websocket.accept()
    chan = _relay_channels.setdefault(channel, {"base": None, "rovers": set()})
    if role == "base":
        chan["base"] = websocket
        try:
            while True:
                data = await websocket.receive_bytes()
                dead = set()
                for r in chan["rovers"]:
                    try:
                        await r.send_bytes(data)
                    except Exception:
                        dead.add(r)
                chan["rovers"] -= dead
        except WebSocketDisconnect:
            pass
        finally:
            if chan["base"] is websocket:
                chan["base"] = None
    else:
        chan["rovers"].add(websocket)
        try:
            while True:
                await websocket.receive_text()  # rovers never send anything meaningful; this just blocks until disconnect
        except WebSocketDisconnect:
            pass
        finally:
            chan["rovers"].discard(websocket)


# Static files are mounted last (after the one real route above) so that
# route takes precedence and only unmatched paths fall through to the
# files. html=True serves index.html for "/" and every .js file at its own
# root-relative path (app.js, gnss.js, ...), matching how GitHub Pages
# serves the same directory flat - the page's <script src="..."> paths
# work unchanged whichever one is actually serving it. Optional: a cloud
# deploy of just this relay (see README) may not ship web/ at all, since
# GitHub Pages already serves the page - don't fail startup over that.
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:
    @app.get("/")
    def root() -> dict:
        return {"service": "gnss-survey-console relay", "status": "ok"}


def main() -> None:
    import uvicorn

    p = argparse.ArgumentParser()
    p.add_argument("--host", default="0.0.0.0")
    # Render (and most PaaS free tiers) assign the port via $PORT and route
    # traffic to whatever that is - fall back to it before the local dev
    # default so the same command works unchanged in both places.
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
