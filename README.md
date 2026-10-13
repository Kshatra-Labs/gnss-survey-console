# GNSS Survey Console

RTK GNSS surveying with two u-blox F9P receivers, from a web page or an
Android app. Both **Base** and **Rover** plug into USB on real devices and
are driven directly (browser via Web Serial, or the app). Only RTCM3
correction frames cross the network, through a small cloud relay that has
no hardware of its own.

One link: **https://kshatra-labs.github.io/gnss-survey-console/**
(Chrome or Edge - Web Serial isn't in Firefox/Safari). It's pre-filled with
the relay address, so opening it and connecting a receiver is the setup.

## What it does

Two RTK receivers - one fixed **base**, one **rover** you carry - measure a
position to a couple of centimetres (a phone GPS manages ~3-5 m):

1. **Base**: plug in, connect, Start. It surveys its own position
   ("survey-in", needs open sky), then streams corrections to the relay on a
   named **channel**.
2. **Rover**: plug in, connect, and it pulls corrections from the same
   channel. **Live monitor** shows the fix; **Survey this point** averages a
   run of RTK FIXED epochs into one lat/lon/height.

## Using the page

1. **Cloud relay** - leave the default. The line under it confirms the relay
   is reachable (a free-tier relay asleep for >15 min takes up to a minute to
   wake; the page waits for it).
2. **1. Base (USB)** - Connect (baud rate is detected automatically), set the
   channel if not `default`, **Start base**. It goes `surveying` ->
   `broadcasting`. Keep the tab open; the screen is kept awake.
3. **2. Rover** - Connect the other receiver, same channel. Use **Live
   monitor** until it shows `FIX=true  RTK FIXED`, then survey `origin`
   first (it fills the Origin fields), then each point - every later point
   gets its east/north/up offset from origin.

Every connected panel shows live stats, for example on the rover:

```
FIX=true  RTK FIXED  corrections used=true  fixType=3D  sv=24  hAcc=0.006m  vAcc=0.009m
relay: connected  bytes received=17388  last=0.2s ago
RTCM in: 1005x28 1074x28 1084x28 1094x28 1124x28 1230x28  (last valid frame 0.2s ago)
channel "default": base online=true  rovers=1  base data last=0.0s ago
```

and on the base: survey-in progress, the receiver's own RTCM output by
message type, bytes uploaded, and how many rovers are listening. When a
point run can't record anything, the error says why from what was actually
observed - no base on the channel, zero correction bytes, bytes that weren't
RTCM, or corrections arriving but never reaching FIXED.

Point results map one-to-one onto
`Ground_EO_Tracker/hawk_nest/config/cameras.local.yaml` (`local_frame`,
each camera's `origin_e/n/u`). The page can't write files on your PC, so
either copy them in, or let the **Site map** write the file for you (below).
That repo's `tools/gnss/survey.py point --write` is a separate CLI with its
own base+rover-over-TCP workflow.

## Site map

**https://kshatra-labs.github.io/gnss-survey-console/site.html** (the "Site
map" tab at the top of the console). It picks up the points surveyed in the
console in the same browser (**Load survey results**), or values you type or
read from `cameras.local.yaml`, and shows:

- **Between the poles** - ground distance, true bearing each way, height
  difference, camera-to-camera tilt, magnetic bearing (if you give the
  declination), and the bearing uncertainty from the survey spreads. Also
  each pole's `origin_e/n/u` in the tracker's frame.
- **Map** (satellite/street) and a **site plot** in exact metres - imagery is
  only good to a few metres, the plot and numbers are survey-grade.
- **Corrections** - enter the planned `pole_distance_m` /
  `pole_line_bearing_deg` and it says how far, and which way, to move each
  pole to match the plan (or keep the poles and use the surveyed positions).
- **Live rover** - with the console's rover running in another tab, its
  position shows live with directions ("0.31 m towards 172°") to a planned or
  surveyed spot: walk the rover there to place or check a pole.
- **cameras.local.yaml** - paste the file, **Write survey into it**, then copy
  or download the result. It makes exactly the edits `survey.py point
  --write` makes (origin, each camera's `origin_e/n/u`, `pole_distance_m:
  0.0`), keeping comments. The file never leaves the page.

"Mount" per pole is the camera's height above the surveyed spot; it's added
to `origin_u`, which the tracker uses as the camera height above the origin.

## The relay

`server/app.py` does three things: relays a channel's base bytes to its
rovers, reports channel status, and serves the page.

| | |
|---|---|
| `GET /healthz` | liveness + version |
| `GET /status/{channel}` | base online?, how many bases/rovers, bytes, age of last base data |
| `WS /ws/relay/{channel}?role=base\|rover` | the relay itself |

It runs on [Render](https://render.com)'s free tier at
**`https://gnss-relay.onrender.com`**, deployed from this repo by
`render.yaml` on every push to `main`. GitHub Pages is published from the
same repo (`.github/workflows/pages.yml` ships `web/`).

Free-tier tradeoff: Render sleeps after ~15 min without requests and takes
30-60 s to wake. While a session runs, each device polls `/status` every 5 s,
which also keeps it awake; connections retry every 3 s.

Behaviour worth knowing: the base uploads only CRC-valid RTCM3 frames (its
NMEA/UBX would otherwise land in every rover's receiver input). If two bases
use one channel, only the newest is relayed and both sides show a warning.
A rover that stops reading is dropped after 5 s so it can't stall the others.

**No authentication** - anyone with the relay address and a channel name can
send or receive on it. Use a non-obvious channel name if that matters.

Run your own: `pip install -r requirements.txt && python3 server/app.py`
(or fork and redo the Render blueprint), then put its address in the page's
Cloud relay field / `DEFAULT_BACKEND` in `web/app.js` and `MainActivity.kt`.
A bare `192.168.x.x:8765` is treated as `http://`, public names as `https://`.

## Android app

`android/` does the same natively and shares the relay - a base in the app
feeds a rover in a browser and vice versa. See `android/README.md`.

## Testing

```bash
tests/run_all.sh                 # everything
SKIP_ANDROID=1 tests/run_all.sh  # without the Android toolchain
```

| Suite | What it proves |
|---|---|
| `tests/oracle/` | UBX/RTCM test vectors generated by **pyubx2/pyrtcm** - independent implementations - so the parsers are checked against a third party, and our encoded frames are parsed back by pyubx2 |
| `tests/web/protocol.test.js` | `web/gnss.js` against those vectors, plus stream recovery from noise and false sync bytes |
| `tests/web/f9p_sim.js` | a ZED-F9P simulator written from the spec (verified by pyubx2 in `check_sim.py`): baud mismatch, ACK/NAK, input protocol masks, survey-in -> time mode, RTK that only fixes while valid RTCM keeps arriving |
| `tests/web/e2e.js` | the real page in jsdom, served by the real relay, with simulated receivers: auto-baud, ex-base receiver recovery, no-base diagnosis, survey-in -> broadcast -> RTK FIXED, origin + offset accuracy, both poles -> Site map distance/bearing, live rover directions, config writing, FLOAT handling, serial buffer overrun, relay restart mid-session, base restart, unplugging |
| `tests/web/sitecalc.test.js` | Site map math against **geographiclib** (distance/azimuth) and **PROJ** (ECEF/ENU), and against Ground_EO_Tracker's own `geolocation.LocalFrame`, `site_layout.camera_origins` and `survey.py` YAML writer (byte-identical output) |
| `tests/web/site_browser.js` | the Site map in real headless Chrome: Leaflet map + tiles, results and live rover shared between two tabs, written config identical to `survey.py`'s, state across reload, no sideways scroll on a phone |
| `tests/server/test_relay.py` | relay behaviour: fan-out, ordering, status, two-base conflict, isolation, stalled rover (also runs against a deployed URL) |
| `android/app/src/test/` | `Ubx.kt`/`Rtcm.kt` against the same vectors; the app's real session + relay code end to end against simulated receivers and a real relay process |

What isn't covered: real radio conditions and specific USB chip/driver
quirks, which only a field test with the actual receivers exercises.

## Layout

| Path | What |
|---|---|
| `server/app.py` | the relay (+ serves `web/`) |
| `web/` | `gnss.js` UBX/RTCM3 protocol, `wgs84.js` WGS84<->ENU, `webserial.js` Web Serial connection + relay client, `app.js` the console; `site.html`/`site.js` the Site map, `sitecalc.js` its geodesy + config read/write |
| `android/` | native app, same protocol (see `android/README.md`) |
| `tests/` | see Testing |
