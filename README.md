# GNSS Survey Console

A web app (and Android app) to run RTK GNSS survey with u-blox F9P
receivers. Both **Base** and **Rover** plug into USB ports on real devices
and run entirely on-device (browser via Web Serial, or the Android app) -
there is no "remote base" mode and no local backend process that touches
USB/serial. The only thing that crosses the network is the RTCM3
correction bytes, through a thin cloud relay that has no hardware
dependency of its own.

## What it does, in plain terms

Two RTK GPS receivers, one acting as a fixed **base** and one as a
**rover** you carry around, can measure a position to within a couple of
centimetres - far better than a phone GPS (~3-5 m):

1. **Base**: plug a receiver into a USB port (phone or laptop, via USB-C/
   OTG), connect it, click Start. It sits still and works out its own
   position precisely over a minute or two ("survey-in"), then uploads
   correction data to the cloud relay on a named **channel**.
2. **Rover**: plug the second receiver into a USB port on whatever device
   you're carrying around, connect it, and pull corrections from the same
   relay channel. Live RTK-corrected position, no server round-trip.
3. **Point**: like rover, but it also averages a run of readings and hands
   back one clean lat/lon/height - what you actually use to record a survey
   point.

One link to remember: **https://kshatra-labs.github.io/gnss-survey-console/**
- it's autofilled with this project's relay address already, so opening it
  and connecting a USB receiver is the entire setup. Requires Chrome or
  Edge (Web Serial API) - not Firefox or Safari.

## The relay, and where it runs

The backend (`server/app.py`) does two things only: serves the static page,
and relays RTCM3 bytes between whichever browser/app has "base" open on a
channel and whichever has "rover" open on the same channel. It never
touches a serial port - that's deliberate, and it's why this piece (unlike
an actual GPS receiver) can run on ordinary free cloud compute instead of
needing to be near the hardware.

It's pushed to its own repo, **https://github.com/Kshatra-Labs/gnss-relay**
(private), with a `render.yaml` blueprint so [Render](https://render.com)'s
free tier can deploy it with no credit card. To stand it up:

1. Go to **https://dashboard.render.com/blueprints** (sign in with GitHub -
   first time only), click **New Blueprint Instance**, pick the
   `Kshatra-Labs/gnss-relay` repo. Render reads `render.yaml` and creates
   the free web service automatically - nothing to configure.
2. Once it deploys, copy the `https://<something>.onrender.com` URL Render
   gives it, and put that in `DEFAULT_BACKEND` in `web/app.js` and
   `MainActivity.kt` (and in the **Cloud relay** field on the page/app for
   anyone already using the old address), then push/rebuild.

Free-tier tradeoff: Render spins the service down after ~15 minutes idle
and takes 30-60s to wake on the next connection - fine here, since nothing
survey-related happens instantly anyway, and both the web page and the
Android app already auto-reconnect with a short backoff. If that cold
start ever becomes annoying, a free
[cron-job.org](https://cron-job.org) ping every 10 minutes keeps it warm.

Until that one-time Render setup is done, this machine keeps running it as
a systemd user service (`gnss-backend.service`, auto-restarts on crash),
exposed via [Tailscale Funnel](https://tailscale.com/kb/1223/funnel):

**`https://harshill-2.tail14e3a.ts.net`**

That's the current default the page and the Android app are pre-filled
with. Point it elsewhere only if you're running your own relay.

**No authentication** on the relay - anyone with its address can push bytes
onto a channel, so don't use a guessable channel name if that matters to
you, and don't post the relay URL publicly if you'd rather it stayed
private.

## Using the page

1. **Cloud relay** field at the top - leave it on the default.
2. **1. Base (USB)** - connect the receiver staying put, set the relay
   channel if you're not using `"default"`, **Start base**. Watch it move
   `surveying` → `broadcasting` (needs real open sky); corrections only
   exist once it says `broadcasting`.
3. **2. Rover - survey a point** - connect the receiver you're carrying,
   confirm the channel matches Base's, give it a **Label**, **Start**. Let
   it run the full duration. Survey `origin` first - its result auto-fills
   the Origin fields below, so every point after that gets its east/north/
   up offset computed automatically.
4. **Rover - live monitor** (collapsed, under the Rover panel) - same live
   feed without averaging, useful to confirm RTK FIXED before a timed run.

The result's numbers are meant to be copied straight into
`Ground_EO_Tracker/hawk_nest/config/cameras.local.yaml`'s `local_frame` /
`origin_e/n/u` fields (or run `Ground_EO_Tracker/tools/gnss/survey.py point
--write ...` - same math, writes the file for you - a separate CLI tool
with its own base+rover-over-TCP workflow, unrelated to this project's
cloud relay).

## Only one receiver?

For single-receiver surveying against a real NTRIP correction service
instead of your own base, use
`Ground_EO_Tracker/tools/gnss/survey.py point --corrections ntrip://...`
directly - that mode lives in that repo's CLI, not here.

## Android app

`android/` runs the same USB-direct Base/Rover model natively, sharing the
cloud relay with the web page - a base running in the app can feed a rover
in a browser, or vice versa. See `android/README.md` to build and run it.

## Layout

| Path | What |
|---|---|
| `server/app.py` | the entire backend: CORS + the `/ws/relay/{channel}` byte relay + serving `web/` as static files |
| `web/` | the browser page - `gnss.js` (UBX protocol), `wgs84.js` (WGS84↔ENU math), `webserial.js` (Web Serial + relay client), `app.js` (UI wiring) |
| `android/` | native phone client, same relay protocol (see `android/README.md`) |

## Possible next step

Finish the one manual step above (click through Render's blueprint page
for `Kshatra-Labs/gnss-relay` and update `DEFAULT_BACKEND`) to fully
decouple the relay's uptime from this machine. I can't complete that sign-in
step myself - it needs your GitHub-authenticated browser session.
