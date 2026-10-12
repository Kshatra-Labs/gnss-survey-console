package com.kshatralabs.gnssconsole.gnss

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.IOException

/** Base receiver on this phone's USB port: survey-in, then RTCM3 to the
 * cloud relay (BaseSession). Holds Compose state for the UI. */
class LocalBaseController {
    var running: Boolean by mutableStateOf(false)
        private set
    var statusText: String by mutableStateOf("idle")
        private set
    var phase: String by mutableStateOf("idle")
        private set
    var error: String? by mutableStateOf(null)
        private set

    @Volatile private var stopRequested = false

    fun stop() { stopRequested = true }

    fun start(context: Context, portRef: UsbPortRef, minDurationS: Int, accLimitM: Double, backendUrl: String, channel: String) {
        if (running) return
        stopRequested = false
        error = null
        running = true
        phase = "starting"
        Thread {
            var conn: UsbGnssConnection? = null
            var locked = false
            try {
                PortLocks.acquire(portRef.key, "Base", preemptible = false, stop = ::stop)?.let {
                    throw SessionException("this receiver is already in use by: $it")
                }
                locked = true
                statusText = "requesting USB permission..."
                if (!UsbRover.requestPermissionBlocking(context, portRef.device)) {
                    throw SessionException("USB permission was not granted for ${portRef.label}")
                }
                statusText = "opening ${portRef.label}..."
                conn = UsbRover.open(context, portRef)
                val c = conn
                if (!c.detectBaud { statusText = "detecting receiver: trying $it baud..." }) {
                    throw SessionException("no u-blox reply at any baud rate (tried ${UsbGnssConnection.BAUD_CANDIDATES.joinToString()}) - is UBX enabled on this receiver's port?")
                }
                BaseSession(c, portRef.label, backendUrl, channel, { stopRequested }, { statusText = it }, { phase = it })
                    .run(minDurationS, accLimitM)
                phase = "idle"
            } catch (e: SessionException) {
                error = e.message
                phase = "error"
            } catch (e: IOException) {
                error = "${e.message} - corrections have STOPPED. Plug it back in and start the base again."
                phase = "stopped"
            } catch (e: Exception) {
                error = "${e.javaClass.simpleName}: ${e.message}"
                phase = "error"
            } finally {
                conn?.close()
                if (locked) PortLocks.release(portRef.key, "Base")
                running = false
            }
        }.apply { isDaemon = true; start() }
    }
}
