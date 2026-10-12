package com.kshatralabs.gnssconsole.gnss

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

/** A failure with a message written for the person in the field. */
class SessionException(message: String) : Exception(message)

fun usbLine(conn: UsbGnssConnection, deviceLabel: String): String =
    "USB: ${if (conn.alive) "connected" else "DISCONNECTED"}  $deviceLabel  ${conn.baud} baud  " +
        "receiver=${conn.monVer?.summary ?: "?"}"

fun fixLine(pvt: Ubx.NavPvt?): String =
    if (pvt == null) "FIX: no position message from the receiver in the last few seconds"
    else "FIX=${pvt.carrSoln == 2}  ${Ubx.CARR_SOLN[pvt.carrSoln]}  corrections used=${pvt.diffSoln}  " +
        "fixType=${Ubx.FIX_TYPE[pvt.fixType] ?: pvt.fixType}  sv=${pvt.numSv}  " +
        "hAcc=${fmt(pvt.hAccM, 3)}m  vAcc=${fmt(pvt.vAccM, 3)}m"

/** Short form for a badge next to the card title. */
fun fixBadgeText(pvt: Ubx.NavPvt?): String = when {
    pvt == null -> "no data"
    pvt.carrSoln == 2 -> "FIX=true  RTK FIXED"
    pvt.carrSoln == 1 -> "FIX=false  RTK FLOAT"
    else -> "FIX=false  no RTK"
}

private fun failed(cfg: Map<String, Boolean>): String? =
    cfg.filterValues { !it }.keys.takeIf { it.isNotEmpty() }?.let { "setup warning: receiver did not acknowledge ${it.joinToString(", ")}" }

/** Rover: live monitor (mode "monitor") or averaged point survey ("point"). */
class RoverSession(
    private val conn: UsbGnssConnection,
    private val deviceLabel: String,
    private val backendUrl: String,
    private val channel: String,
    private val isStopped: () -> Boolean,
    private val onStatus: (String) -> Unit,
    private val onFix: (Ubx.NavPvt?) -> Unit = {},
) {
    private fun block(link: RelayClient.Download, pvt: Ubx.NavPvt?, head: String, warn: String?) = buildList {
        add(head)
        add(usbLine(conn, deviceLabel))
        add(fixLine(pvt))
        add(link.statsLine())
        add("RTCM in: ${link.rtcmIn.summary()}  (last valid frame ${link.rtcmIn.ageText()})")
        add(link.status.line("rover"))
        if (warn != null) add(warn)
    }.joinToString("\n")

    private fun configure(): String? {
        val cfg = conn.configureRover { step -> onStatus("configuring rover: $step...\n${usbLine(conn, deviceLabel)}") }
        if (!conn.alive) throw SessionException("USB receiver disconnected during setup")
        return failed(cfg)
    }

    fun monitor() {
        val warn = configure()
        conn.discardInput()
        val link = RelayClient.startDownload(backendUrl, channel) { conn.writeRtcmBytes(it) }
        try {
            while (!isStopped()) {
                val pvt = conn.readNavPvt(2500)
                if (!conn.alive) throw SessionException("USB receiver disconnected")
                onStatus(block(link, pvt, "LIVE MONITOR (nothing recorded)", warn))
                onFix(pvt)
            }
            onStatus(block(link, conn.latestPvt(), "monitor stopped", warn))
        } finally {
            link.stop()
        }
    }

    fun point(label: String, durationS: Double, requireFixed: Boolean, origin: Origin?): PointResult {
        val warn = configure()
        conn.discardInput()
        val link = RelayClient.startDownload(backendUrl, channel) { conn.writeRtcmBytes(it) }
        try {
            val lats = ArrayList<Double>()
            val lons = ArrayList<Double>()
            val heights = ArrayList<Double>()
            var allFixed = true
            var framesSeen = 0
            var bestCarr = -1
            val deadline = System.nanoTime() + (durationS * 1e9).toLong()
            while (System.nanoTime() < deadline && !isStopped()) {
                val pvt = conn.readNavPvt(2500)
                if (!conn.alive) throw SessionException("USB receiver disconnected")
                val left = max(0.0, (deadline - System.nanoTime()) / 1e9)
                val head = "SURVEYING \"$label\": ${fmt(left, 0)}s left, epochs averaged=${lats.size}" +
                    if (requireFixed) " (RTK FIXED only)" else " (RTK FIXED or FLOAT)"
                onStatus(block(link, pvt, head, warn))
                onFix(pvt)
                if (pvt == null) continue
                framesSeen++
                if (pvt.carrSoln > bestCarr) bestCarr = pvt.carrSoln
                val usable = pvt.gnssFixOk && (pvt.carrSoln == 2 || (!requireFixed && pvt.carrSoln == 1))
                if (!usable) continue
                if (pvt.carrSoln != 2) allFixed = false
                lats.add(pvt.latDeg)
                lons.add(pvt.lonDeg)
                heights.add(pvt.heightMslM)
            }
            if (isStopped()) return PointResult(label, 0.0, 0.0, 0.0, 0, 0.0, false, cancelled = true)
            if (lats.isEmpty()) throw SessionException(diagnose(framesSeen, bestCarr, link, requireFixed))

            val meanLat = lats.average()
            val meanLon = lons.average()
            val meanH = heights.average()
            val mPerDegLat = 111320.0
            val mPerDegLon = 111320.0 * cos(Math.toRadians(meanLat))
            var spread = 0.0
            for (i in lats.indices) spread = max(spread, hypot((lats[i] - meanLat) * mPerDegLat, (lons[i] - meanLon) * mPerDegLon))
            var e: Double? = null
            var n: Double? = null
            var u: Double? = null
            if (origin != null && label != "origin") {
                val enu = Wgs84.LocalFrame(origin.lat, origin.lon, origin.alt).geodeticToEnu(meanLat, meanLon, meanH)
                e = enu.first; n = enu.second; u = enu.third
            }
            return PointResult(label, meanLat, meanLon, meanH, lats.size, spread, allFixed, e, n, u)
        } finally {
            link.stop()
        }
    }

    private fun diagnose(framesSeen: Int, bestCarr: Int, link: RelayClient.Download, requireFixed: Boolean): String {
        if (framesSeen == 0) {
            return "no position (NAV-PVT) messages arrived from the receiver during the run, so nothing could be " +
                "recorded. Unplug/replug it and start again."
        }
        val want = if (requireFixed) "RTK FIXED" else "RTK FLOAT/FIXED"
        val s = link.status.snapshot
        if (link.byteCount == 0L) {
            val why = when {
                s.ok == true && !s.baseOnline -> "No base is broadcasting on channel \"$channel\": start the Base and wait " +
                    "for \"broadcasting\", and check both sides use the same relay channel and relay address."
                s.ok == false -> "The relay itself didn't answer (${s.error})."
                else -> "The relay shows a base online but nothing reached this rover - check this phone's network."
            }
            return "the receiver gave $framesSeen fixes, but ZERO correction bytes arrived from the relay, so it could " +
                "never reach $want. $why"
        }
        if (link.rtcmIn.frames == 0L) {
            return "${link.byteCount} bytes arrived from the relay but none were valid RTCM3, so the base isn't " +
                "outputting corrections - check the Base's \"RTCM out\" line."
        }
        return "corrections ARE arriving (${link.rtcmIn.summary()}), but in $framesSeen fixes the best solution was " +
            "${if (bestCarr < 0) "none" else Ubx.CARR_SOLN[bestCarr]}, never $want. Usual causes: obstructed sky at rover " +
            "or base, baseline too long (>~20 km), or the base survey still poor. Run longer" +
            if (requireFixed) ", or untick FIXED-only to accept FLOAT." else "."
    }
}

/** Base: survey-in, then forward RTCM3 to the relay until stopped. */
class BaseSession(
    private val conn: UsbGnssConnection,
    private val deviceLabel: String,
    private val backendUrl: String,
    private val channel: String,
    private val isStopped: () -> Boolean,
    private val onStatus: (String) -> Unit,
    private val onPhase: (String) -> Unit = {},
) {
    private fun receiverLine(): String {
        val pvt = conn.latestPvt() ?: return "receiver: no position message in the last few seconds"
        return "receiver: fixType=${Ubx.FIX_TYPE[pvt.fixType] ?: pvt.fixType}  sv=${pvt.numSv}  fixOK=${pvt.gnssFixOk}"
    }

    private fun rtcmOutLine() = "RTCM out (from receiver): ${conn.rtcmOut.summary()}  (last valid frame ${conn.rtcmOut.ageText()})"

    fun run(minDurationS: Int, accLimitM: Double) {
        onPhase("configuring")
        val cfg = conn.configureBase(minDurationS, accLimitM) { step ->
            onStatus("configuring base: $step...\n${usbLine(conn, deviceLabel)}")
        }
        if (!conn.alive) throw SessionException("USB receiver disconnected during setup")
        if (cfg["surveyIn"] != true) throw SessionException("the receiver refused survey-in (CFG-TMODE3 not acknowledged)")
        val warn = failed(cfg)

        // Poll the channel during survey-in too: wakes a sleeping relay
        // before corrections exist, and shows any channel conflict early.
        val surveyStatus = RelayClient.ChannelStatus(backendUrl, channel)
        var svin: Ubx.NavSvin? = null
        try {
            conn.discardInput()
            onPhase("surveying")
            var lastSvinAt = System.currentTimeMillis()
            while (!isStopped()) {
                val msg = conn.readMessage(1000)
                if (!conn.alive) throw SessionException("USB receiver disconnected")
                if (msg != null && msg.cls == Ubx.CLS_NAV && msg.id == Ubx.NAV_SVIN && msg.payload.size >= 40) {
                    svin = Ubx.NavSvin.parse(msg.payload)
                    lastSvinAt = System.currentTimeMillis()
                }
                val lines = arrayListOf("SURVEY-IN (base working out its own position - needs open sky)", usbLine(conn, deviceLabel))
                val s = svin
                lines.add(
                    if (s == null) "survey-in: waiting for the first progress message..."
                    else "survey-in: active=${s.active} valid=${s.valid}  dur=${s.durationS}s (min ${minDurationS}s)  " +
                        "meanAcc=${fmt(s.meanAccM, 3)}m (target <= ${fmt(accLimitM, 3)}m)  obs=${s.observations}"
                )
                val silentS = (System.currentTimeMillis() - lastSvinAt) / 1000
                if (silentS > 6) lines.add("WARNING: no survey-in progress from the receiver for ${silentS}s")
                lines.add(receiverLine())
                lines.add(rtcmOutLine() + "  (1005 = base position, appears once survey-in completes)")
                lines.add(surveyStatus.line("base"))
                if (warn != null) lines.add(warn)
                onStatus(lines.joinToString("\n"))
                if (s != null && s.valid && !s.active) break
            }
        } finally {
            surveyStatus.stop()
        }
        if (isStopped()) {
            onStatus("cancelled during survey-in")
            return
        }
        val done = svin!!

        onPhase("broadcasting")
        val upload = RelayClient.startUpload(backendUrl, channel)
        try {
            val buf = ByteArray(4096)
            var lastRender = 0L
            while (!isStopped()) {
                val n = conn.readRawInto(buf, 500)
                if (n > 0) upload.feed(buf, n)
                val now = System.currentTimeMillis()
                if (now - lastRender >= 1000) {
                    lastRender = now
                    val rtcmSilent = conn.rtcmOut.lastAt == 0L || now - conn.rtcmOut.lastAt > 5000
                    val lines = arrayListOf(
                        "BROADCASTING corrections on channel \"$channel\"",
                        usbLine(conn, deviceLabel),
                        "survey-in result: meanAcc=${fmt(done.meanAccM, 3)}m after ${done.durationS}s (${done.observations} obs)",
                        receiverLine(), rtcmOutLine(), upload.statsLine(), upload.status.line("base"),
                    )
                    if (rtcmSilent) lines.add("WARNING: the receiver has not output any RTCM for over 5 s - no corrections are being produced")
                    if (!upload.isOpen) lines.add("WARNING: relay link down - reconnecting every 3 s")
                    if (warn != null) lines.add(warn)
                    onStatus(lines.joinToString("\n"))
                    onPhase(if (rtcmSilent || !upload.isOpen) "broadcasting (problem)" else "broadcasting")
                }
            }
            onStatus("stopped - no longer broadcasting")
        } finally {
            upload.stop()
        }
    }
}
