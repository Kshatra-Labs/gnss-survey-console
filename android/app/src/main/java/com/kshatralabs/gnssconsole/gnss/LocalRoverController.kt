package com.kshatralabs.gnssconsole.gnss

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max

data class Origin(val lat: Double, val lon: Double, val alt: Double)

data class PointResult(
    val label: String,
    val latDeg: Double,
    val lonDeg: Double,
    val heightMslM: Double,
    val n: Int,
    val spreadM: Double,
    val allFixed: Boolean,
    val originE: Double? = null,
    val originN: Double? = null,
    val originU: Double? = null,
    val cancelled: Boolean = false,
)

/** Drives the rover receiver plugged into this phone's USB-C/OTG port
 * directly - every byte of GNSS I/O happens locally against the USB device.
 * Only the RTCM3 correction stream comes from the network, via the cloud
 * relay (RelayClient) - the same channel-based hub the web console's Base
 * (USB) panel uploads to, so this rover can use corrections from a base
 * running on this phone, another phone, or a browser, interchangeably. */
class LocalRoverController {
    var running: Boolean by mutableStateOf(false)
        private set
    var statusText: String by mutableStateOf("idle")
        private set
    var result: PointResult? by mutableStateOf(null)
        private set
    var error: String? by mutableStateOf(null)
        private set
    var startError: String? by mutableStateOf(null)
        private set

    @Volatile private var stopRequested = false
    private var worker: Thread? = null

    private fun setStatus(s: String) { statusText = s }

    fun stop() {
        stopRequested = true
    }

    /** mode: "monitor" streams live status only; "point" also averages
     * `durationS` seconds of fixes into a PointResult. */
    private fun run(
        context: Context, portRef: UsbPortRef, baud: Int,
        backendUrl: String, channel: String,
        mode: String, label: String, durationS: Double, requireFixed: Boolean, origin: Origin?,
    ) {
        stopRequested = false
        startError = null
        error = null
        result = null
        running = true
        var conn: UsbGnssConnection? = null
        var download: RelayClient.Download? = null
        try {
            setStatus("requesting USB permission...")
            if (!UsbRover.requestPermissionBlocking(context, portRef.device)) {
                throw IllegalStateException("USB permission denied for ${portRef.label}")
            }
            setStatus("opening ${portRef.label}...")
            conn = UsbRover.open(context, portRef, baud)

            setStatus("configuring rover...")
            val okOut = conn.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1)
            val okIn = conn.enableRtcm3Input()
            if (!okOut || !okIn) setStatus("warning: rover setup did not fully succeed (out=$okOut in=$okIn)")

            val c = conn
            download = RelayClient.startDownload(
                backendUrl, channel,
                onBytes = { bytes -> c.writeRtcmBytes(bytes) },
                onStatus = { setStatus(it) },
            )

            if (mode == "monitor") {
                setStatus("streaming")
                while (!stopRequested) {
                    val pvt = conn.readNavPvt(3000)
                    if (pvt == null) { setStatus("...no fix yet"); continue }
                    setStatus(pvt.statusStr)
                }
                result = PointResult(label, 0.0, 0.0, 0.0, 0, 0.0, false, cancelled = true)
            } else {
                setStatus("averaging ${durationS}s for '$label'")
                val lats = ArrayList<Double>()
                val lons = ArrayList<Double>()
                val heights = ArrayList<Double>()
                var allFixed = true
                val deadline = System.nanoTime() + (durationS * 1e9).toLong()
                while (System.nanoTime() < deadline && !stopRequested) {
                    val remainingS = max(0.0, (deadline - System.nanoTime()) / 1e9)
                    val pvt = conn.readNavPvt(3000)
                    if (pvt == null) { setStatus("[%.1fs left] ...no fix yet".format(remainingS)); continue }
                    setStatus("[%.1fs left] %s sv=%d collected=%d".format(remainingS, pvt.statusStr, pvt.numSv, lats.size))
                    if (pvt.carrSoln != 2) {
                        allFixed = false
                        if (requireFixed) continue
                    }
                    lats.add(pvt.latDeg)
                    lons.add(pvt.lonDeg)
                    heights.add(pvt.heightMslM)
                }

                if (stopRequested) {
                    result = PointResult(label, 0.0, 0.0, 0.0, 0, 0.0, false, cancelled = true)
                } else if (lats.isEmpty()) {
                    throw IllegalStateException("no usable fixes collected - corrections never reached RTK FLOAT/FIXED")
                } else {
                    val meanLat = lats.average()
                    val meanLon = lons.average()
                    val meanH = heights.average()
                    val mPerDegLat = 111320.0
                    val mPerDegLon = 111320.0 * cos(Math.toRadians(meanLat))
                    var spread = 0.0
                    for (i in lats.indices) {
                        val d = hypot((lats[i] - meanLat) * mPerDegLat, (lons[i] - meanLon) * mPerDegLon)
                        if (d > spread) spread = d
                    }
                    var originE: Double? = null
                    var originN: Double? = null
                    var originU: Double? = null
                    if (origin != null && label != "origin") {
                        val frame = Wgs84.LocalFrame(origin.lat, origin.lon, origin.alt)
                        val (e, n, u) = frame.geodeticToEnu(meanLat, meanLon, meanH)
                        originE = e; originN = n; originU = u
                    }
                    result = PointResult(label, meanLat, meanLon, meanH, lats.size, spread, allFixed, originE, originN, originU)
                }
            }
        } catch (e: Exception) {
            if (result == null) {
                if (statusText.startsWith("requesting") || statusText.startsWith("opening")) {
                    startError = "Can't start: ${e.message}"
                } else {
                    error = e.message
                }
            }
        } finally {
            download?.stop()
            conn?.close()
            running = false
        }
    }

    fun startMonitor(context: Context, portRef: UsbPortRef, baud: Int, backendUrl: String, channel: String) {
        worker = Thread {
            run(context, portRef, baud, backendUrl, channel, "monitor", "monitor", 0.0, false, null)
        }.also { it.isDaemon = true; it.start() }
    }

    fun startPoint(
        context: Context, portRef: UsbPortRef, baud: Int, backendUrl: String, channel: String,
        label: String, durationS: Double, requireFixed: Boolean, origin: Origin?,
    ) {
        worker = Thread {
            run(context, portRef, baud, backendUrl, channel, "point", label, durationS, requireFixed, origin)
        }.also { it.isDaemon = true; it.start() }
    }
}
