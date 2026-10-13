# GNSS Survey Console

Centimetre-accurate RTK surveying with two u-blox F9P receivers, straight
from USB in a browser or the Android app, and the result written into
Ground_EO_Tracker's `cameras.local.yaml`. This is the only survey tool for
that project. Every device on the same **channel** shares the survey through
the relay: a point surveyed in the app shows up in the Site map on a laptop,
and the other way round.

**https://kshatra-labs.github.io/gnss-survey-console/** - Chrome or Edge
(Web Serial isn't in Firefox/Safari). Nothing to install or configure.

## Surveying a site

1. **Base** - the receiver that stays put (open sky): **Connect**, **Start
   base**, wait for `broadcasting`.
2. **Rover** - the receiver you carry: **Connect**, **Live monitor** until it
   shows `FIX=true  RTK FIXED`.
3. Survey each spot with **Survey this point** and a label:
   - `origin` - the site reference point (halfway between the poles), first;
   - `camera_a`, `camera_b` - at each pole;
   - anything else (`mast`, `stake1`, ...) - reference points the cameras can
     sight, for north alignment.
4. Open the **Site map** tab (website or app), on the same channel:
   - the points arrive by themselves; enter each camera's **mount** height
     (the camera above the surveyed spot);
   - check the pole distance and bearing;
   - **cameras.local.yaml**: **Open file...**, **Write survey into it** (it
     lists every changed line), **Save to the file**.

## What goes into cameras.local.yaml

| Field | Value |
|---|---|
| `local_frame: origin_lat_deg / origin_lon_deg / origin_alt_m` | the surveyed `origin` (height = MSL) |
| `<camera>: origin_e / origin_n / origin_u` | each camera in metres east/north/up of the origin, in the tracker's own frame; `origin_u` includes the mount height |
| `pole_distance_m` | `0.0` - the tracker then uses the surveyed positions |

Each of these is a single `key: number` line, edited in place. Comments and
every other setting stay as they are. The north-alignment numbers
(`pan_offset_deg`, `tilt_offset_deg`, `bearing_sigma_rad`) come from
`calibrate_ptz.py boresight` at the site. The Site map's **Aim the cameras**
panel feeds that step: for each camera and each reference point (the other
pole included) it shows where to point, and the `ref_lat,ref_lon,ref_alt` to
paste into the sightings file.

## Site map

**https://kshatra-labs.github.io/gnss-survey-console/site.html**

- **Between the poles** - distance, true bearing both ways, height
  difference, camera-to-camera tilt, and each camera's `origin_e/n/u`.
- **Satellite map / exact plot** - imagery is only good to a few metres; the
  plot (in metres) and the numbers are survey-grade.
- **Aim the cameras** - az/el from each camera to each reference point, as
  the tracker computes them, plus the values for the boresight sightings file.
- **Corrections vs plan** (optional) - give the planned `pole_distance_m` /
  `pole_line_bearing_deg`, and it says how far, and which way, to move each
  pole.
- **Live rover** - any rover on the channel (web or app, any device) shows
  live, with directions ("0.31 m towards 172°") to any planned or surveyed
  spot.

Results and live fixes travel through the relay. Nothing else is uploaded:
the config file is only read and written on your device. The map needs
internet; without it the exact plot and every number still work.

### How results are shared

- Every finished point is kept **on the device that surveyed it** (per
  channel) and uploaded to the relay. The Site map pulls the channel's
  results, takes new ones automatically, and listens for new ones.
- **Newest wins:** a point surveyed again replaces the older one everywhere.
  A point you edited by hand in the Site map is never overwritten
  automatically; **Load survey results** forces the latest.
- **Removing a reference point** removes it on every device.
- **The relay keeps results only in memory.** The free host forgets them
  when it sleeps, so every device keeps its own copy and re-uploads it on
  the next sync (every minute, and whenever a page or the app opens).
- **No sign-in:** anyone who knows a channel name can read it, so use a
  non-obvious channel for a real site.

## Status lines

Every connected panel in the console shows live stats, for example the rover:

```
FIX=true  RTK FIXED  corrections used=true  fixType=3D  sv=24  hAcc=0.006m  vAcc=0.009m
relay: connected  bytes received=17388  last=0.2s ago
RTCM in: 1005x28 1074x28 1084x28 1094x28 1124x28 1230x28  (last valid frame 0.2s ago)
channel "default": base online=true  rovers=1  base data last=0.0s ago
```

If a point can't be recorded, the error says why, from what was actually
seen:
- no base on the channel;
- no correction bytes arrived;
- the bytes weren't RTCM;
- corrections arrived but the rover never reached FIXED.

## The relay

Corrections travel Base -> Rover through `server/app.py` on Render's free
tier (**https://gnss-relay.onrender.com**), deployed by `render.yaml` on every
push to `main`. GitHub Pages serves `web/` (`.github/workflows/pages.yml`).

| | |
|---|---|
| `GET /healthz` | liveness + version |
| `GET /status/{channel}` | base online?, bases/rovers/watchers, bytes, age of last base data, results |
| `GET /results/{channel}` | the channel's survey results |
| `PUT /results/{channel}/{label}` | store one (kept only if newer) |
| `WS /ws/relay/{channel}?role=base\|rover\|watch` | base -> rovers (RTCM); rover -> watchers (live fix, JSON) |

- **Waking up:** it sleeps after ~15 min idle and takes 30-60 s to wake; the
  page waits. While a session runs, the devices' status polls keep it awake.
- **What it forwards:** only CRC-valid RTCM3 frames.
- **Two bases on one channel:** only the newest is relayed, and both sides
  are warned.
- **A rover that stops reading** is dropped after 5 s, so it can't stall the
  others.
- **No authentication:** anyone with a channel name can listen, so pick a
  non-obvious channel if that matters.
- **Running your own:** `pip install -r requirements.txt && python3
  server/app.py`, then put its address in the console's relay box or in
  `DEFAULT_BACKEND` (`web/app.js`, `MainActivity.kt`).

## Android app

`android/` drives Base and Rover over USB-OTG and shares the relay; a base
in the app feeds a rover in a browser and vice versa. Its **Site map** tab is
the same page as the website, bundled into the app, and it opens and saves
`cameras.local.yaml` through Android's file picker. See
`android/README.md`.

## Testing

```bash
tests/run_all.sh                 # everything
SKIP_ANDROID=1 tests/run_all.sh  # without the Android toolchain
```

Checked against independent implementations, not against itself:

| Suite | What it proves |
|---|---|
| `tests/oracle/` | UBX/RTCM vectors from **pyubx2/pyrtcm**; our encoded frames parsed back by pyubx2 |
| `tests/web/protocol.test.js` | `web/gnss.js` against those vectors, plus recovery from noise and false sync |
| `tests/web/f9p_sim.js` | an F9P simulator written from the spec (itself verified by pyubx2) |
| `tests/web/e2e.js` | the real page + relay with simulated receivers: auto-baud, survey-in -> broadcast -> RTK FIXED, origin and pole accuracy, Site map, live rover, config writing, faults (buffer overrun, relay restart, unplugging) |
| `tests/web/sitecalc.test.js` | Site map math against **geographiclib** and **PROJ**, and against Ground_EO_Tracker's `geolocation.py` / `site_layout.py` |
| `tests/oracle/check_site_config.py` | a config written by the Site map, read with the tracker's own code: origin, `camera_origins()`, every other setting unchanged, boresight az/el |
| `tests/web/site_browser.js` | the Site map in real headless Chrome: map, two tabs, Open -> Write -> Save |
| `tests/server/test_relay.py` | relay fan-out, status, two bases, isolation, stalled rover, results (newest wins, deletions, validation), live fixes to watchers (also against the live URL) |
| `android/app/src/test/` | the app's protocol, session and result-sync code against the same vectors and a real relay |
| `tests/android/site_in_app.js` | the installed app on a device/emulator: the Site map tab's WebView and bridge, results from the relay and from the app, live fix, and Open/Save through Android's file picker on a real file |

The checks against Ground_EO_Tracker run when it's checked out next to this
repo (or `GROUND_EO_TRACKER=<path>`); only its template `cameras.yaml` is
read. Not covered: real radio conditions and USB chip quirks - that takes a
field test.

## Layout

| Path | What |
|---|---|
| `web/index.html`, `app.js` | the console |
| `web/site.html`, `site.js` | the Site map |
| `web/gnss.js`, `webserial.js` | UBX/RTCM3 protocol; Web Serial connection + relay client |
| `web/wgs84.js`, `sitecalc.js` | WGS84 <-> ENU; site geometry and `cameras.yaml` read/write |
| `web/results.js` | survey results shared through the relay |
| `server/app.py` | the relay (+ serves `web/`) |
| `android/` | the native app |
| `tests/` | see Testing |
