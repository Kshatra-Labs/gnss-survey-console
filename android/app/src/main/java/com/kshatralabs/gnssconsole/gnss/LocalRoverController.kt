package com.kshatralabs.gnssconsole.gnss

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.IOException

/** Rover receiver on this phone's USB port: live monitor or point survey
 * (RoverSession), with corrections from the cloud relay. `name` identifies
 * it in PortLocks; a live monitor yields its receiver to a point survey. */
class LocalRoverController(private val name: String, private val preemptible: Boolean) {
    var running: Boolean by mutableStateOf(false)
        private set
    var statusText: String by mutableStateOf("idle")
        private set
    var fixBadge: String? by mutableStateOf(null)
        private set
    var fixed: Boolean by mutableStateOf(false)
        private set
    var result: PointResult? by mutableStateOf(null)
        private set
    var error: String? by mutableStateOf(null)
        private set

    @Volatile private var stopRequested = false

    /** Every live fix (for the in-app Site map); a finished point and its channel. */
    @Volatile var onPvt: (Ubx.NavPvt?) -> Unit = {}
    @Volatile var onResult: (PointResult, String) -> Unit = { _, _ -> }

    fun stop() { stopRequested = true }

    /** Stops showing the last result: its stored copy was deleted. */
    fun forgetResult() { if (!running) result = null }

    private fun launch(context: Context, portRef: UsbPortRef, body: (UsbGnssConnection) -> Unit) {
        if (running) return
        stopRequested = false
        error = null
        result = null
        fixBadge = null
        running = true
        Thread {
            var conn: UsbGnssConnection? = null
            var locked = false
            try {
                statusText = "waiting for the receiver..."
                PortLocks.acquire(portRef.key, name, preemptible, ::stop)?.let {
                    throw SessionException("this receiver is already in use by: $it - stop that first")
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
                body(c)
            } catch (e: SessionException) {
                error = e.message
            } catch (e: IOException) {
                error = e.message
            } catch (e: Exception) {
                error = "${e.javaClass.simpleName}: ${e.message}"
            } finally {
                conn?.close()
                if (locked) PortLocks.release(portRef.key, name)
                fixBadge = null
                running = false
            }
        }.apply { isDaemon = true; start() }
    }

    private fun session(conn: UsbGnssConnection, portRef: UsbPortRef, backendUrl: String, channel: String) =
        RoverSession(conn, portRef.label, backendUrl, channel, { stopRequested }, { statusText = it }, { pvt ->
            fixBadge = fixBadgeText(pvt)
            fixed = pvt?.carrSoln == 2
            onPvt(pvt)
        })

    fun startMonitor(context: Context, portRef: UsbPortRef, backendUrl: String, channel: String) =
        launch(context, portRef) { conn -> session(conn, portRef, backendUrl, channel).monitor() }

    fun startPoint(
        context: Context, portRef: UsbPortRef, backendUrl: String, channel: String,
        label: String, durationS: Double, requireFixed: Boolean, origin: Origin?,
    ) = launch(context, portRef) { conn ->
        val r = session(conn, portRef, backendUrl, channel).point(label, durationS, requireFixed, origin)
        result = r
        statusText = if (r.cancelled) "cancelled" else "DONE \"${r.label}\": ${r.n} epochs averaged, fix=${r.allFixed}"
        if (!r.cancelled) onResult(r, channel)
    }
}
