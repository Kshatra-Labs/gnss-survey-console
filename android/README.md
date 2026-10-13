# GNSS Survey Console - Android app

Base and Rover receivers plug into the phone's USB-C port (OTG) and the app
drives them directly over UBX. Corrections, survey results and the rover's
live fix travel through the same cloud relay the web page uses: a base in
the app feeds a rover in a browser, and a point surveyed here shows up in
the Site map on any device (and the other way round).

**APK:** `android/app/build/outputs/apk/debug/app-debug.apk`

```
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to the phone and open it (allow "install unknown apps").

## What you need

- A phone with USB-C and OTG (most since ~2016; a few budget models disable it).
- A USB-C OTG adapter or cable; a powered hub to run Base and Rover on one phone.

## Using the app

1. **Cloud relay** - pre-filled; the line below it says whether the relay
   answered (a sleeping free-tier relay can take up to a minute).
2. **USB devices** - plug receivers in; the list refreshes on plug/unplug.
   First time, Android asks for USB permission - allow it ("always").
3. **1. Base** - pick the receiver staying put and **Start base**. Baud rate
   is detected automatically. The badge goes `surveying` -> `broadcasting`.
4. **2. Rover** - defaults to a different receiver from the Base. Same
   channel. The badge shows `FIX=true  RTK FIXED` once corrections are
   working; survey `origin` first, then `camera_a`, `camera_b` (the chips
   fill the label), and any reference points. Each result is kept on the
   phone and uploaded; the line under it says whether the relay has it
   (if not, it is retried every minute).
5. **Rover - live monitor** - watch the fix without recording. Starting a
   point survey on the same receiver stops the monitor automatically; the
   Base's receiver can't be taken by a rover.

**Site map** tab - the website's Site map page, bundled into the app, on
the app's relay and channel: distance and bearing between the poles, where
to aim the cameras, the live rover, and **cameras.local.yaml**: **Open
file...** (Android's file picker) -> **Write survey into it** -> **Save to
the file** (written in place and read back), or **Download** a copy.

Every status box shows the same live stats as the web page (FIX state,
satellites, accuracy, relay link, RTCM frames by type, channel status). The
screen stays on while anything runs, and a running session survives
rotating the phone.

## Rebuild

```bash
export ANDROID_HOME=~/android-sdk
cd android
gradle -p . :app:assembleDebug          # APK
gradle -p . :app:testDebugUnitTest      # unit + end-to-end tests (needs python3 + server deps)
gradle -p . :app:lintDebug
```

Kotlin 1.9.24 + Compose compiler 1.5.14 are a matched pair; newer Compose
releases need the Kotlin 2.x compose plugin, so the versions are pinned on
purpose (lint lists newer AndroidX versions - upgrading them means that
toolchain move too).

## Supported USB-serial chips

`app/src/main/res/xml/device_filter.xml`: u-blox native USB (VID 0x1546),
FTDI FT231X/FT232R (this project's boards), CP210x, CH340, PL2303. Another
chip: add its vendor/product ID there.

## Layout

| Path | What |
|---|---|
| `gnss/Ubx.kt`, `gnss/Rtcm.kt` | UBX + RTCM3 protocol, mirroring `web/gnss.js` |
| `gnss/UsbGnssConnection.kt` | framing, ACKs, auto-baud, rover/base setup over a `SerialIo` (USB port, or a simulator in tests) |
| `gnss/UsbRover.kt` | USB discovery, permission, opening; `PortLocks` (which session owns which receiver) |
| `gnss/RelayClient.kt` | relay WebSocket (RTCM-only upload / download, live fix up), channel status, results GET/PUT, health check |
| `gnss/Results.kt` | the phone's survey results per channel, synced with the relay (same scheme as `web/results.js`) |
| `SiteMapHost.kt` | the Site map tab: the bundled `web/site.html` in a WebView, and its `AndroidSite` bridge (relay, channel, results, file picker) |
| `gnss/Sessions.kt` | `BaseSession` and `RoverSession` - the actual survey logic, plain Kotlin |
| `gnss/LocalBaseController.kt`, `gnss/LocalRoverController.kt` | run sessions on a thread, expose Compose state |
| `gnss/Wgs84.kt` | WGS84<->ENU, matching `web/wgs84.js` |
| `MainActivity.kt` | the screen (`ConsoleViewModel` holds the controllers) |
| `app/src/test/` | protocol tests against pyubx2 vectors, `SimF9p` simulator, end-to-end session and result-sync tests |
| `../tests/android/site_in_app.js` | the installed app on a device/emulator (Site map tab, bridge, file picker) |
