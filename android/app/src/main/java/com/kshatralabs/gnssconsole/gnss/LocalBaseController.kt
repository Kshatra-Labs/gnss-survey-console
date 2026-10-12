package com.kshatralabs.gnssconsole.gnss

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Drives a base receiver plugged into THIS phone's USB-C/OTG port directly
 * - the "connect both base and rover on the app" option: with a USB hub (or
 * one now, one later), a single phone can run both roles with no laptop at
 * all. Survey-in + RTCM3 output over USB, then corrections are uploaded to
 * the cloud relay (RelayClient - server/app.py's /ws/relay/{channel}) so
 * any rover on the same channel can use them - this app's own
 * LocalRoverController, another phone, or the web console, all the same
 * way. The relay has no USB/serial dependency of its own; only this
 * connection's USB side does. Mirrors LocalRoverController and the web
 * console's Base (USB) panel in app.js. */
class LocalBaseController {
    var running: Boolean by mutableStateOf(false)
        private set
    var statusText: String by mutableStateOf("idle")
        private set
    var error: String? by mutableStateOf(null)
        private set
    var startError: String? by mutableStateOf(null)
        private set

    @Volatile private var stopRequested = false
    private var worker: Thread? = null

    private fun setStatus(s: String) { statusText = s }

    fun stop() { stopRequested = true }

    fun start(
        context: Context, portRef: UsbPortRef, baud: Int,
        minDurationS: Int, accLimitM: Double, backendUrl: String, channel: String,
    ) {
        stopRequested = false
        startError = null
        error = null
        running = true
        worker = Thread {
            var conn: UsbGnssConnection? = null
            var upload: RelayClient.Upload? = null
            try {
                setStatus("requesting USB permission...")
                if (!UsbRover.requestPermissionBlocking(context, portRef.device)) {
                    throw IllegalStateException("USB permission denied for ${portRef.label}")
                }
                setStatus("opening ${portRef.label}...")
                conn = UsbRover.open(context, portRef, baud)

                setStatus("configuring base...")
                val okOut = conn.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_SVIN, 1)
                val rtcmOk = conn.enableRtcmBaseOutput()
                if (!okOut || rtcmOk.values.any { !it }) setStatus("warning: some output messages failed: $rtcmOk")

                if (!conn.configureSurveyIn(minDurationS, accLimitM)) {
                    throw IllegalStateException("survey-in config rejected by receiver")
                }

                setStatus("surveying... (needs open sky)")
                var svin: Ubx.NavSvin? = null
                while (!stopRequested) {
                    svin = conn.readNavSvin(3000)
                    if (svin == null) { setStatus("...no NAV-SVIN yet"); continue }
                    setStatus("dur=${svin.durationS}s meanAcc=${"%.3f".format(svin.meanAccM)}m " +
                        "obs=${svin.observations} valid=${svin.valid} active=${svin.active}")
                    if (svin.valid && !svin.active) break
                }
                if (stopRequested) { running = false; return@Thread }

                setStatus("connecting to relay...")
                upload = RelayClient.startUpload(backendUrl, channel) { setStatus(it) }
                val meanAcc = svin?.meanAccM ?: 0.0

                // Post-survey-in: stop polling for UBX messages entirely and
                // forward raw bytes (RTCM3, not UBX-framed) straight to the
                // relay - same sequential handoff tools/gnss/survey.py's
                // cmd_base uses.
                val buf = ByteArray(4096)
                val u = upload
                var lastStatusAt = 0L
                while (!stopRequested) {
                    val n = conn.readRawInto(buf, 1000)
                    if (n > 0) u.feed(buf, n)
                    val now = System.currentTimeMillis()
                    if (now - lastStatusAt > 2000) {
                        lastStatusAt = now
                        val s = u.stats()
                        val age = if (s.ageS == null) "never" else "%.1fs ago".format(s.ageS)
                        setStatus(
                            "broadcasting on relay channel \"$channel\"  meanAcc=${"%.3f".format(meanAcc)}m\n" +
                                "relay: ${if (u.connected()) "connected" else "reconnecting"}  bytes sent=${s.bytes}  last=$age"
                        )
                    }
                }
            } catch (e: Exception) {
                if (statusText.startsWith("requesting") || statusText.startsWith("opening")) {
                    startError = "Can't start: ${e.message}"
                } else {
                    error = e.message
                }
            } finally {
                upload?.stop()
                conn?.close()
                running = false
            }
        }.also { it.isDaemon = true; it.start() }
    }
}
