# GNSS Survey Console - Android app

Both **Base** and **Rover** plug into USB ports on real devices (this phone,
another phone, a USB hub for two at once) and the app talks to them
directly over UBX - no laptop, no "remote base" mode, nothing dependent on
one specific always-on machine. The only thing that crosses the network is
the RTCM3 correction bytes themselves, via a cloud relay that has no
USB/serial access of its own - the same relay the web console's Base (USB)
panel uses, so a base running here can feed a rover in a browser and vice
versa.

Built and verified with a real Gradle build (Android SDK cmdline-tools +
Gradle 8.7, JDK 21) against the actual `usb-serial-for-android` and
AndroidX/Compose libraries - `BUILD SUCCESSFUL`. **APK:**
`android/app/build/outputs/apk/debug/app-debug.apk`. I could not test it
against a real phone + USB OTG + F9P in this environment (no device
attached here), so the compile is verified but the on-device USB behavior
is not - if anything misbehaves once you plug a receiver in, tell me
exactly what happened and I'll fix it.

## Install the already-built APK

```
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

or copy `app-debug.apk` to the phone and open it (allow "install unknown
apps" for whatever app you copied it with).

## Rebuild after changes

Open in Android Studio (`File > Open` → this `android/` folder) and hit Run,
or from the command line:

```bash
export ANDROID_HOME=~/android-sdk   # wherever your SDK lives
cd android
./gradlew assembleDebug             # if the wrapper jar isn't present yet,
                                     # Android Studio's first sync creates it,
                                     # or run `gradle wrapper` with any local Gradle
```

## What you need

- A phone with USB-C and OTG support (most Android phones since ~2016 have
  this; a few budget models disable it).
- A USB-C OTG adapter/cable to each receiver's own port (a USB hub if you
  want both base and rover on one phone at once).

## Using the app

1. **Cloud relay**: autofilled with this project's known address
   (`DEFAULT_BACKEND` in `MainActivity.kt`) - no typing needed unless
   you're running your own relay.
2. **USB devices**: plug in your receiver(s), tap **Rescan USB devices**.
   First time, Android asks for USB permission per device - allow it (check
   "always" so it doesn't ask again).
3. **Base (USB)**: pick the receiver staying put, **Start base**. Needs
   real open sky - watch it go `surveying` → `broadcasting`. Corrections
   only exist once it says `broadcasting`.
4. **Rover - survey a point**: pick the other receiver, confirm the **Relay
   channel** matches Base's (both default to `"default"` - only change it
   if you're running more than one base/rover pair at once), label it,
   **Survey this point**. Survey `origin` first - it auto-fills the Origin
   fields for every point after that.
5. **Rover - live monitor** (collapsed): raw fix without recording, useful
   to confirm RTK FIXED first. Starting step 4 on the same USB device stops
   this monitor automatically.

## Why there's no "remote base" option

An earlier version of this app could control a receiver plugged into a
separate laptop over the network (REST + WebSocket to a Python backend that
did the actual USB/serial work). That's gone now: once both Base and Rover
read their receivers directly over USB, the only thing that still needs to
cross a network at all is the correction *bytes*, and those can go through
a plain relay that never has to understand GNSS, USB, or serial - which is
simpler, and means that relay piece could genuinely run on ordinary cloud
compute instead of being tied to whichever machine happens to have a GPS
plugged into it.

## Supported USB-serial chips

`app/src/main/res/xml/device_filter.xml` lists the chip this project's own
boards use (FTDI FT231X, confirmed via `MON-VER` on the real hardware) plus
the other common ones (CP210x, CH340, PL2303) so this isn't hard-locked to
one specific board. If your receiver uses something else, add its
vendor/product ID there.

## Layout

| Path | What |
|---|---|
| `app/src/main/java/.../gnss/Ubx.kt` | UBX protocol - frames, checksums, NAV-PVT/NAV-SVIN parsing, RTCM message IDs (port of `ubx.py`) |
| `app/src/main/java/.../gnss/UsbGnssConnection.kt` | frame extraction + request/ACK logic over a `UsbSerialPort` |
| `app/src/main/java/.../gnss/UsbRover.kt` | USB device discovery, permission flow, opening the port |
| `app/src/main/java/.../gnss/RelayClient.kt` | WebSocket client for the cloud relay (`/ws/relay/{channel}`) - upload (Base) and download (Rover) |
| `app/src/main/java/.../gnss/Wgs84.kt` | WGS84↔ENU math, matching `web/wgs84.js` numerically |
| `app/src/main/java/.../gnss/LocalBaseController.kt` | drives a local Base session (survey-in, RTCM output, relay upload) as Compose state |
| `app/src/main/java/.../gnss/LocalRoverController.kt` | drives a local Rover session (live monitor or averaged point) as Compose state |
| `app/src/main/java/.../MainActivity.kt` | the screen |
