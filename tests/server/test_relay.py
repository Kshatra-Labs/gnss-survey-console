"""Relay tests against a real server process.

    python3 tests/server/test_relay.py                 # starts server/app.py locally
    python3 tests/server/test_relay.py https://host    # runs against a deployed relay
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import websockets

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def get_json(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=60) as r:
        return json.loads(r.read())


def put_json(base: str, path: str, body) -> tuple[int, dict]:
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="PUT",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}


def ws_url(base: str, channel: str, role: str) -> str:
    return base.replace("http", "ws", 1) + f"/ws/relay/{channel}?role={role}"


async def recv_n(ws, n: int, timeout: float = 20.0) -> list[bytes]:
    out = []
    while len(out) < n:
        out.append(await asyncio.wait_for(ws.recv(), timeout))
    return out


async def wait_status(base: str, ch: str, pred, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while True:
        s = await asyncio.to_thread(get_json, base, f"/status/{ch}")
        if pred(s) or time.time() > deadline:
            return s
        await asyncio.sleep(0.2)


async def run(base: str, local: bool) -> None:
    h = get_json(base, "/healthz")
    assert h["ok"] is True and h["version"], h
    print("ok  healthz", h)

    ch = "t-" + uuid.uuid4().hex[:8]
    s = get_json(base, f"/status/{ch}")
    assert s["base_online"] is False and s["rovers"] == 0 and s["last_base_data_age_s"] is None, s
    print("ok  status for an unused channel")

    # 1 base -> 2 rovers, order and content preserved
    async with websockets.connect(ws_url(base, ch, "rover")) as r1, \
               websockets.connect(ws_url(base, ch, "rover")) as r2, \
               websockets.connect(ws_url(base, ch, "base")) as b:
        await asyncio.sleep(0.3)
        msgs = [os.urandom(50 + i) for i in range(200)]
        for m in msgs:
            await b.send(m)
        assert await recv_n(r1, 200) == msgs
        assert await recv_n(r2, 200) == msgs
        print("ok  base -> 2 rovers, 200 messages, exact bytes and order")

        s = await wait_status(base, ch, lambda s: s["bytes_from_base"] == sum(map(len, msgs)))
        assert s["base_online"] is True and s["bases"] == 1 and s["rovers"] == 2, s
        assert s["bytes_from_base"] == sum(map(len, msgs)), s
        assert s["last_base_data_age_s"] is not None and s["last_base_data_age_s"] < 10, s
        print("ok  status reflects live base/rovers/bytes", s)

        # text from a base and binary from a rover are ignored, not fatal
        await b.send("not rtcm")
        await r1.send(b"rovers never send")
        await b.send(b"still-flowing")
        assert await recv_n(r1, 1) == [b"still-flowing"]
        assert await recv_n(r2, 1) == [b"still-flowing"]
        print("ok  stray text/binary frames ignored, relay keeps flowing")

        # a second base on the same channel: newest wins, old one muted
        async with websockets.connect(ws_url(base, ch, "base")) as b2:
            await asyncio.sleep(0.3)
            await b.send(b"from-old-base")
            await b2.send(b"from-new-base")
            assert await recv_n(r1, 1) == [b"from-new-base"]
            s = await wait_status(base, ch, lambda s: s["bases"] == 2)
            assert s["bases"] == 2, s
            print("ok  two bases: only the newest is relayed, status reports the conflict")
        # over the internet the close takes a moment to reach the server
        s = await wait_status(base, ch, lambda s: s["bases"] == 1)
        assert s["bases"] == 1, s
        await b.send(b"old-base-again")
        assert await recv_n(r1, 1) == [b"old-base-again"]
        print("ok  when the newer base leaves, the remaining one is relayed again")

    s = await wait_status(base, ch, lambda s: s["rovers"] == 0 and not s["base_online"])
    assert s["rovers"] == 0 and s["base_online"] is False, s
    print("ok  disconnects reflected in status")

    # invalid role is refused
    try:
        async with websockets.connect(ws_url(base, ch, "admin")) as w:
            await asyncio.wait_for(w.recv(), 5)
        raise AssertionError("invalid role was accepted")
    except (websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed, websockets.exceptions.InvalidHandshake):
        print("ok  invalid role refused")

    # channels are isolated
    other = ch + "-x"
    async with websockets.connect(ws_url(base, other, "rover")) as rx, \
               websockets.connect(ws_url(base, ch, "rover")) as rc, \
               websockets.connect(ws_url(base, ch, "base")) as b:
        await asyncio.sleep(0.3)
        await b.send(b"only-for-ch")
        assert await recv_n(rc, 1) == [b"only-for-ch"]
        try:
            await asyncio.wait_for(rx.recv(), 1.5)
            raise AssertionError("message leaked into another channel")
        except asyncio.TimeoutError:
            print("ok  channels are isolated")

    # ---- survey results: stored per label, newest `at` wins, deletion markers ----
    rc = "r-" + uuid.uuid4().hex[:8]
    res = {"lat_deg": 12.9715987, "lon_deg": 77.5945627, "height_msl_m": 920.123, "n": 60,
           "spread_m": 0.008, "all_fixed": True, "at": "2026-10-13T10:00:00.000Z", "source": "test"}
    assert put_json(base, f"/results/{rc}/origin", res) == (200, {"stored": True, "result": res})
    older = {**res, "lat_deg": 1.0, "at": "2026-10-13T09:00:00Z"}
    code, body = put_json(base, f"/results/{rc}/origin", older)
    assert code == 200 and body["stored"] is False and body["result"]["lat_deg"] == res["lat_deg"], body
    newer = {**res, "height_msl_m": 921.0, "at": "2026-10-13T10:05:00+00:00"}
    assert put_json(base, f"/results/{rc}/origin", newer)[1]["stored"] is True
    got = get_json(base, f"/results/{rc}")["results"]
    assert got == {"origin": newer}, got
    print("ok  results: stored, an older copy never overwrites a newer one")

    tomb = {"deleted": True, "at": "2026-10-13T10:06:00Z", "source": "test"}
    assert put_json(base, f"/results/{rc}/origin", tomb)[1]["stored"] is True
    assert put_json(base, f"/results/{rc}/origin", newer)[1]["stored"] is False, "a re-upload of the old copy must not undo a deletion"
    assert get_json(base, f"/results/{rc}")["results"]["origin"]["deleted"] is True
    assert get_json(base, f"/status/{rc}")["results"] == 0
    print("ok  results: deletion marker wins over older re-uploads")

    for bad_label, bad_body in [("bad label!", res), ("x" * 41, res), ("p", {**res, "lat_deg": 91}),
                                ("p", {**res, "lat_deg": "12"}), ("p", {**res, "at": "yesterday"}),
                                ("p", {**res, "at": "2026-10-13T10:00:00"}), ("p", {**res, "n": 0}),
                                ("p", {**res, "all_fixed": "yes"}), ("p", {**res, "spread_m": float("nan")}),
                                ("p", [1, 2])]:
        code, _ = put_json(base, f"/results/{rc}/{urllib.parse.quote(bad_label)}", bad_body)
        assert code == 422, (bad_label, bad_body, code)
    print("ok  results: malformed labels / values / times refused (422)")

    # ---- live fix: rover text -> watchers (the Site map), and results pushed to watchers ----
    lc = "l-" + uuid.uuid4().hex[:8]
    async with websockets.connect(ws_url(base, lc, "watch")) as watcher, \
               websockets.connect(ws_url(base, lc, "rover")) as rover:
        await asyncio.sleep(0.3)
        pvt = {"type": "pvt", "lat": 12.97, "lon": 77.59, "h": 921.3, "carrSoln": 2, "hAccM": 0.011, "numSv": 22, "source": "app"}
        await rover.send(json.dumps(pvt))
        got = json.loads(await asyncio.wait_for(watcher.recv(), 10))
        assert got == pvt, got
        await rover.send("not json")
        await rover.send(json.dumps({**pvt, "lat": 200}))
        await asyncio.sleep(0.25)
        await rover.send(json.dumps({**pvt, "h": 1.0}))
        got = json.loads(await asyncio.wait_for(watcher.recv(), 10))
        assert got["h"] == 1.0, f"junk must be skipped, next valid fix delivered: {got}"
        for _ in range(20):  # a flood is thinned to <= 5/s
            await rover.send(json.dumps(pvt))
        n = 0
        try:
            while True:
                await asyncio.wait_for(watcher.recv(), 0.5)
                n += 1
        except asyncio.TimeoutError:
            pass
        assert n <= 2, f"{n} fixes passed through a burst"
        s = await wait_status(base, lc, lambda s: s["watchers"] == 1)
        assert s["watchers"] == 1 and s["rovers"] == 1, s
        print("ok  live fix: rover JSON -> watcher; junk skipped; bursts rate-limited; status counts watchers")

        r2 = {**res, "at": "2026-10-13T11:00:00Z"}
        await asyncio.to_thread(put_json, base, f"/results/{lc}/camera_a", r2)
        got = json.loads(await asyncio.wait_for(watcher.recv(), 10))
        assert got == {"type": "result", "label": "camera_a", "result": r2}, got
        print("ok  a new result is pushed to watchers immediately")

    # a watcher that connects later gets the last fresh fix straight away
    async with websockets.connect(ws_url(base, lc, "watch")) as late:
        got = json.loads(await asyncio.wait_for(late.recv(), 10))
        assert got["type"] == "pvt" and got["age_s"] < 10, got
        print("ok  a late watcher gets the last fix at once")

    if local:
        # a stalled rover (stops reading) must not stall a healthy one
        ch2 = ch + "-stall"
        async with websockets.connect(ws_url(base, ch2, "rover"), max_queue=1) as stalled, \
                   websockets.connect(ws_url(base, ch2, "rover")) as healthy, \
                   websockets.connect(ws_url(base, ch2, "base"), max_size=None) as b:
            await asyncio.sleep(0.3)
            blob = os.urandom(256 * 1024)
            n = 160  # 40 MB: far more than socket buffers hold for a non-reader

            async def reader():
                got = 0
                while got < n:
                    await asyncio.wait_for(healthy.recv(), 30)
                    got += 1
                return got

            rt = asyncio.create_task(reader())
            t0 = time.time()
            for _ in range(n):
                await b.send(blob)
            assert await rt == n
            s = await wait_status(base, ch2, lambda s: s["rovers"] == 1, timeout=15)
            assert s["rovers"] == 1, s
            print(f"ok  stalled rover dropped after timeout, healthy rover got all {n} x 256KB in {time.time() - t0:.1f}s")
            del stalled

    print("ALL RELAY TESTS PASSED against", base)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main() -> None:
    if len(sys.argv) > 1:
        asyncio.run(run(sys.argv[1].rstrip("/"), local=False))
        return
    port = free_port()
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server", "app.py"), "--host", "127.0.0.1", "--port", str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                get_json(base, "/healthz")
                break
            except Exception:
                time.sleep(0.1)
        asyncio.run(run(base, local=True))
    finally:
        proc.terminate()
        proc.wait(5)


if __name__ == "__main__":
    main()
