package com.kshatralabs.gnssconsole.gnss

import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Base -> real relay process -> rover, through the app's actual session,
 * connection and relay-client code, with simulated receivers. */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class SessionE2ETest {
    companion object {
        private lateinit var relay: Process
        lateinit var url: String

        @BeforeClass @JvmStatic
        fun startRelay() {
            val port = ServerSocket(0).use { it.localPort }
            val script = File("../../server/app.py").canonicalFile
            relay = ProcessBuilder("python3", script.path, "--host", "127.0.0.1", "--port", "$port")
                .redirectErrorStream(true).redirectOutput(File("/dev/null")).start()
            url = "http://127.0.0.1:$port"
            repeat(100) {
                try {
                    (URL("$url/healthz").openConnection() as HttpURLConnection).apply { connectTimeout = 300 }.inputStream.close()
                    return
                } catch (_: Exception) { Thread.sleep(100) }
            }
            fail("relay did not start")
        }

        @AfterClass @JvmStatic
        fun stopRelay() { relay.destroy() }
    }

    private fun waitUntil(ms: Long, what: String, cond: () -> Boolean) {
        val t0 = System.currentTimeMillis()
        while (!cond()) {
            if (System.currentTimeMillis() - t0 > ms) fail("timed out waiting for: $what")
            Thread.sleep(100)
        }
    }

    private fun connect(sim: SimF9p): UsbGnssConnection {
        val c = UsbGnssConnection(sim)
        assertTrue("baud detection", c.detectBaud())
        return c
    }

    @Test
    fun a_baudDetectionAndReceiverIdentity() {
        val sim = SimF9p(deviceBaud = 38400)
        val c = connect(sim)
        assertEquals(38400, c.baud)
        assertEquals("ZED-F9P HPG 1.32", c.monVer?.summary)
        c.close()
        val dead = UsbGnssConnection(SimF9p(answers = false))
        assertFalse(dead.detectBaud())
        dead.close()
    }

    @Test
    fun b_correctionWritesAreNotStarvedByBlockingReads() {
        val sim = SimF9p(deviceBaud = 115200, noise = false)
        val c = connect(sim)
        val reader = Thread { repeat(20) { c.readMessage(3000) } }.apply { start() }
        Thread.sleep(200)
        var worst = 0L
        repeat(20) {
            val t0 = System.nanoTime()
            c.writeRtcmBytes(ByteArray(200))
            worst = maxOf(worst, (System.nanoTime() - t0) / 1_000_000)
            Thread.sleep(20)
        }
        assertTrue("a correction write waited ${worst} ms behind a read", worst < 100)
        reader.interrupt()
        c.close()
    }

    @Test
    fun c_portLocks() {
        var monitorStopped = false
        assertEquals(null, PortLocks.acquire("dev1", "Rover live monitor", true, { monitorStopped = true }))
        val t = Thread { Thread.sleep(300); PortLocks.release("dev1", "Rover live monitor") }.apply { start() }
        assertEquals(null, PortLocks.acquire("dev1", "Rover point survey", false, {}))
        assertTrue("point survey must stop the monitor on the same receiver", monitorStopped)
        t.join()
        assertEquals("Rover point survey", PortLocks.acquire("dev1", "Base", false, {}, waitMs = 300))
        PortLocks.release("dev1", "Rover point survey")
        assertEquals(null, PortLocks.acquire("dev1", "Base", false, {}))
        assertEquals("Base", PortLocks.acquire("dev1", "Rover live monitor", true, {}, waitMs = 300))
        PortLocks.release("dev1", "Base")
    }

    @Test
    fun d_fullChain() {
        val baseSim = SimF9p(deviceBaud = 38400, seed = 11)
        val roverSim = SimF9p(deviceBaud = 115200, seed = 12, timeMode = true, rtcmOutOn = true, initialInProto = 0x03)
        val base = connect(baseSim)
        val rover = connect(roverSim)

        // no base on the channel yet: the diagnosis must say exactly that
        try {
            RoverSession(rover, "rover", url, "nobody-here", { false }, {}).point("probe", 4.0, true, null)
            fail("point survey without corrections must fail")
        } catch (e: SessionException) {
            assertTrue(e.message, e.message!!.contains("ZERO correction bytes"))
            assertTrue(e.message, e.message!!.contains("No base is broadcasting on channel \"nobody-here\""))
        }
        assertEquals("rover setup must leave time mode", 0, roverSim.tmode)
        assertTrue("rover setup must enable RTCM3 input", roverSim.inProto and 0x20 != 0)

        // base: survey-in then broadcast
        val baseStatusRef = AtomicReference("")
        val baseStopFlag = AtomicBoolean(false)
        val baseErrorRef = AtomicReference<Throwable?>(null)
        val baseThread = Thread {
            try {
                BaseSession(base, "base", url, "site-a", { baseStopFlag.get() }, { baseStatusRef.set(it) }).run(5, 2.0)
            } catch (t: Throwable) { baseErrorRef.set(t) }
        }.apply { start() }
        waitUntil(15000, "survey-in progress") { baseStatusRef.get().contains("active=true valid=false") }
        assertTrue(baseStatusRef.get(), baseStatusRef.get().contains("receiver: fixType=3D  sv=24"))
        waitUntil(30000, "broadcasting with data") {
            baseStatusRef.get().contains("BROADCASTING") && Regex("bytes sent=[1-9]").containsMatchIn(baseStatusRef.get()) && baseStatusRef.get().contains("base online=true")
        }
        assertTrue(baseStatusRef.get(), Regex("1005x\\d+").containsMatchIn(baseStatusRef.get()))
        assertTrue(baseStatusRef.get(), baseStatusRef.get().contains("receiver: fixType=time only"))
        println("BASE:\n${baseStatusRef.get()}\n")

        // a Site map watching the channel (role=watch) gets the app rover's live fix
        val watched = java.util.concurrent.LinkedBlockingQueue<String>()
        val watcher = okhttp3.OkHttpClient().newWebSocket(
            okhttp3.Request.Builder().url("${url.replace("http", "ws")}/ws/relay/site-a?role=watch").build(),
            object : okhttp3.WebSocketListener() {
                override fun onMessage(webSocket: okhttp3.WebSocket, text: String) { watched.add(text) }
            })

        // rover live monitor reaches FIX=true
        val monStatusRef = AtomicReference("")
        val monStopFlag = AtomicBoolean(false)
        val mon = Thread { RoverSession(rover, "rover", url, "site-a", { monStopFlag.get() }, { monStatusRef.set(it) }).monitor() }.apply { start() }
        waitUntil(30000, "FIX=true") { monStatusRef.get().contains("FIX=true  RTK FIXED") }
        waitUntil(10000, "rover counted on channel") { monStatusRef.get().contains("base online=true  rovers=1") }
        assertTrue(monStatusRef.get(), Regex("RTCM in: 1005x\\d+ 1074x\\d+ 1084x\\d+ 1094x\\d+ 1124x\\d+ 1230x\\d+").containsMatchIn(monStatusRef.get()))
        assertTrue(monStatusRef.get(), monStatusRef.get().contains("corrections used=true"))
        waitUntil(10000, "base sees the rover") { baseStatusRef.get().contains("rovers=1") }
        println("ROVER:\n${monStatusRef.get()}\n")
        var fixed: org.json.JSONObject? = null
        val tw = System.currentTimeMillis()
        while (fixed == null && System.currentTimeMillis() - tw < 10000) {
            val m = watched.poll(1, java.util.concurrent.TimeUnit.SECONDS)?.let { org.json.JSONObject(it) } ?: continue
            if (m.getString("type") == "pvt" && m.getInt("carrSoln") == 2) fixed = m
        }
        assertNotNull("the watcher never got an RTK FIXED live fix from the app's rover", fixed)
        assertEquals(LIVE_SOURCE, fixed!!.getString("source"))
        assertEquals(17.3850123, fixed.getDouble("lat"), 1e-6)
        watcher.close(1000, null)
        monStopFlag.set(true)
        mon.join(10000)
        assertEquals("base NMEA leaked into the rover's input", 0, roverSim.nmeaIn)
        assertTrue(roverSim.rtcmInFrames > 0)

        // survey origin
        val origin = RoverSession(rover, "rover", url, "site-a", { false }, {}).point("origin", 5.0, true, null)
        assertTrue(origin.allFixed)
        assertTrue("lat ${origin.latDeg}", abs(origin.latDeg - 17.3850123) < 1e-7)
        assertTrue("lon ${origin.lonDeg}", abs(origin.lonDeg - 78.4867456) < 1e-7)
        assertEquals(540.1, origin.heightMslM, 0.01)

        // a point 10 m east, ~2 m north, 0.5 m up
        val dLon = 10 / (111320 * cos(17.3850123 * PI / 180))
        val dLat = 2 / 110574.0
        roverSim.moveTo(17.3850123 + dLat, 78.4867456 + dLon, 540.6)
        val o = Origin(origin.latDeg, origin.lonDeg, origin.heightMslM)
        val cam = RoverSession(rover, "rover", url, "site-a", { false }, {}).point("camera_a", 5.0, true, o)
        val phi = 17.3850123 * PI / 180
        val wantE = 6378137 / sqrt(1 - 6.69437999014e-3 * sin(phi) * sin(phi)) * cos(phi) * dLon * PI / 180
        assertEquals(wantE, cam.originE!!, 0.01)
        assertEquals(2.0, cam.originN!!, 0.02)
        assertEquals(0.5, cam.originU!!, 0.02)
        println("camera_a: e=${cam.originE} n=${cam.originN} u=${cam.originU} (want e=$wantE)")

        // FLOAT only: strict fails with an explanation, relaxed records fix=false
        roverSim.maxCarr = 1
        try {
            RoverSession(rover, "rover", url, "site-a", { false }, {}).point("strict", 4.0, true, null)
            fail("FLOAT-only with FIXED required must fail")
        } catch (e: SessionException) {
            assertTrue(e.message, e.message!!.contains("corrections ARE arriving") && e.message!!.contains("RTK FLOAT, never RTK FIXED"))
        }
        val relaxed = RoverSession(rover, "rover", url, "site-a", { false }, {}).point("relaxed", 4.0, false, null)
        assertFalse(relaxed.allFixed)
        assertTrue(relaxed.n > 0)
        roverSim.maxCarr = 2

        // unplug the rover mid-monitor
        monStopFlag.set(false)
        val monErrRef = AtomicReference<Throwable?>(null)
        val mon2 = Thread {
            try { RoverSession(rover, "rover", url, "site-a", { monStopFlag.get() }, { monStatusRef.set(it) }).monitor() } catch (t: Throwable) { monErrRef.set(t) }
        }.apply { start() }
        waitUntil(15000, "monitor running") { monStatusRef.get().contains("LIVE MONITOR") }
        roverSim.unplug()
        mon2.join(10000)
        val monErr = monErrRef.get()
        assertTrue("unplug must surface as a disconnect: $monErr", monErr is IOException || monErr is SessionException)
        assertTrue(monErr!!.message, monErr.message!!.contains("disconnected"))

        // stop the base cleanly
        baseStopFlag.set(true)
        baseThread.join(10000)
        assertEquals(null, baseErrorRef.get())
        assertTrue(baseStatusRef.get(), baseStatusRef.get().contains("stopped - no longer broadcasting"))

        base.close()
        rover.close()
        assertNotNull(baseSim)
    }

    private class MemKv : Results.KeyValue {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) { map[key] = value }
        override fun keys(): Set<String> = map.keys
    }

    private fun startExtraRelay(): Pair<Process, String> {
        val port = ServerSocket(0).use { it.localPort }
        val p = ProcessBuilder("python3", File("../../server/app.py").canonicalFile.path, "--host", "127.0.0.1", "--port", "$port")
            .redirectErrorStream(true).redirectOutput(File("/dev/null")).start()
        val u = "http://127.0.0.1:$port"
        waitUntil(10000, "second relay") {
            try { (URL("$u/healthz").openConnection() as HttpURLConnection).inputStream.close(); true } catch (_: Exception) { false }
        }
        return p to u
    }

    @Test
    fun e_resultsSync() {
        val ch = "res-" + System.nanoTime()
        val app = Results(MemKv())
        val origin = PointResult("origin", 17.3850123, 78.4867456, 540.1, 60, 0.008, true)
        val camA = PointResult("camera_a", 17.3850304, 78.4868399, 540.6, 60, 0.007, true)
        app.record(ch, origin)
        app.record(ch, camA)
        val first = app.sync(url, ch)
        assertTrue(first.reachable); assertEquals(null, first.error); assertEquals(2, first.pushed)
        val onRelay = RelayClient.getResults(url, ch)
        assertEquals(17.3850123, onRelay.getJSONObject("origin").getDouble("lat_deg"), 0.0)
        assertEquals("Android app", onRelay.getJSONObject("camera_a").getString("source"))
        assertEquals("a second sync uploads nothing", 0, app.sync(url, ch).pushed)

        // the web console re-surveys camera_a later: the app takes the newer one
        Thread.sleep(5)
        val web = org.json.JSONObject().put("lat_deg", 17.0).put("lon_deg", 78.0).put("height_msl_m", 541.0).put("n", 30)
            .put("spread_m", 0.01).put("all_fixed", true).put("at", java.time.Instant.now().toString()).put("source", "web console")
        RelayClient.putResult(url, ch, "camera_a", web)
        val merged = app.sync(url, ch).results
        assertEquals("web console", merged.getJSONObject("camera_a").getString("source"))
        assertEquals("web console", app.load(ch).getJSONObject("camera_a").getString("source"))

        // a deletion from the Site map reaches the app and wins over its older copy
        Thread.sleep(5)
        RelayClient.putResult(url, ch, "camera_a", org.json.JSONObject().put("deleted", true).put("at", java.time.Instant.now().toString()).put("source", "site map"))
        assertTrue(app.sync(url, ch).results.getJSONObject("camera_a").getBoolean("deleted"))

        // relay unreachable: nothing lost, the error is reported
        app.record(ch, PointResult("mast", 17.39, 78.49, 560.0, 60, 0.009, true))
        val down = app.sync("http://127.0.0.1:1", ch)
        assertFalse(down.reachable); assertNotNull(down.error)
        assertTrue(app.load(ch).has("mast"))

        // a relay that forgot everything (free host slept) is refilled from the phone
        val (fresh, freshUrl) = startExtraRelay()
        try {
            val refill = app.sync(freshUrl, ch)
            assertEquals(3, refill.pushed) // origin, the deletion marker, mast
            val got = RelayClient.getResults(freshUrl, ch)
            assertTrue(got.has("origin") && got.has("mast") && got.getJSONObject("camera_a").getBoolean("deleted"))
        } finally { fresh.destroy() }

        // back on the main relay: "mast" (surveyed while it was unreachable) goes up;
        // a label the relay would refuse never leaves the phone
        app.record(ch, PointResult("bad label!", 1.0, 1.0, 1.0, 1, 0.0, true))
        assertEquals(1, app.sync(url, ch).pushed)
        val end = RelayClient.getResults(url, ch)
        assertTrue(end.has("mast") && !end.has("bad label!"))
    }

    @Test
    fun g_clearEverywhere() {
        val ch = "clr-" + System.nanoTime()
        val phone = Results(MemKv())
        val other = Results(MemKv()) // a second phone on the channel
        phone.record(ch, PointResult("origin", 17.3850123, 78.4867456, 540.1, 60, 0.008, true))
        phone.record(ch, PointResult("camera_a", 17.3850304, 78.4868399, 540.6, 60, 0.007, true))
        assertEquals(2, phone.sync(url, ch).pushed)
        other.sync(url, ch)
        assertEquals(listOf("camera_a", "origin"), Results.labels(other.load(ch)).sorted())
        other.record(ch, PointResult("mast", 17.39, 78.49, 560.0, 60, 0.009, true)) // surveyed offline: never reached the relay
        Thread.sleep(5)

        // "Delete everywhere" on this phone
        val clear = phone.clear(ch, "Android app")
        assertTrue(Results.labels(phone.load(ch)).isEmpty())
        val up = phone.sync(url, ch)
        assertEquals(null, up.error); assertEquals(1, up.pushed)
        val onRelay = RelayClient.getResults(url, ch)
        assertEquals(clear.getString("at"), onRelay.getJSONObject(Results.CLEARED).getString("at"))
        assertTrue(Results.labels(onRelay).isEmpty())

        // the other phone comes back: drops all of it, its offline "mast" too, and uploads none of it
        assertEquals(0, other.sync(url, ch).pushed)
        assertTrue(Results.labels(other.load(ch)).isEmpty())
        assertTrue(Results.labels(RelayClient.getResults(url, ch)).isEmpty())

        // surveyed after the clear: kept and shared
        Thread.sleep(5)
        phone.record(ch, PointResult("camera_b", 17.3849671, 78.4870218, 541.3, 60, 0.008, true))
        assertEquals(1, phone.sync(url, ch).pushed)
        assertEquals(listOf("camera_b"), Results.labels(other.sync(url, ch).results))

        // a device whose clock is an hour ahead clears: a phone that has seen that clear
        // still keeps what it surveys afterwards
        val ahead = org.json.JSONObject().put("at", java.time.Instant.now().plusSeconds(3600).toString()).put("source", "fast clock")
        RelayClient.clearResults(url, ch, ahead)
        assertTrue(Results.labels(other.sync(url, ch).results).isEmpty())
        other.record(ch, PointResult("stake", 17.38, 78.48, 540.0, 30, 0.01, true))
        assertEquals(1, other.sync(url, ch).pushed)
        assertEquals(listOf("stake"), Results.labels(RelayClient.getResults(url, ch)))

        // a relay that forgot everything gets an old copy first, then this phone's clear
        val (fresh, freshUrl) = startExtraRelay()
        try {
            val stale = org.json.JSONObject().put("lat_deg", 17.0).put("lon_deg", 78.0).put("height_msl_m", 540.0).put("n", 60)
                .put("spread_m", 0.01).put("all_fixed", true).put("at", "2026-01-01T00:00:00Z").put("source", "missed the clear")
            RelayClient.putResult(freshUrl, ch, "origin", stale)
            assertEquals(2, phone.sync(freshUrl, ch).pushed) // the clear, camera_b
            val got = RelayClient.getResults(freshUrl, ch)
            assertEquals(clear.getString("at"), got.getJSONObject(Results.CLEARED).getString("at"))
            assertEquals(listOf("camera_b"), Results.labels(got))
            assertTrue("the stale copy is now a deletion marker", got.getJSONObject("origin").getBoolean("deleted"))
        } finally { fresh.destroy() }
    }

    @Test
    fun f_mergeRules() {
        fun r(at: String, v: Double) = org.json.JSONObject().put("at", at).put("lat_deg", v)
        val a = org.json.JSONObject().put("x", r("2026-10-13T10:00:00Z", 1.0)).put("y", r("2026-10-13T10:00:00.500Z", 2.0))
        val b = org.json.JSONObject().put("x", r("2026-10-13T10:00:00+00:00", 9.0)).put("y", r("2026-10-13T10:00:01Z", 3.0)).put("z", r("2026-10-13T09:00:00Z", 4.0))
        val m = Results.merge(a, b)
        assertEquals("same time: keep what we have", 1.0, m.getJSONObject("x").getDouble("lat_deg"), 0.0)
        assertEquals(3.0, m.getJSONObject("y").getDouble("lat_deg"), 0.0)
        assertEquals(4.0, m.getJSONObject("z").getDouble("lat_deg"), 0.0)
        assertTrue(Results.LABEL_RE.matches("camera_a") && Results.LABEL_RE.matches("ref.1-b") && !Results.LABEL_RE.matches("a b"))
        assertFalse("the clear's key is never a label", Results.LABEL_RE.matches(Results.CLEARED))

        // a clear removes what it covers and stays itself; an older copy can't come back
        fun clearAt(at: String) = org.json.JSONObject().put(Results.CLEARED, org.json.JSONObject().put("at", at))
        val c = Results.merge(m, clearAt("2026-10-13T10:00:00.500Z"))
        assertEquals(listOf(Results.CLEARED, "y"), c.keys().asSequence().sorted().toList())
        assertEquals(listOf("y"), Results.labels(c))
        assertEquals(listOf("y"), Results.labels(Results.merge(c, a)))
        assertTrue("a tie goes to the clear", Results.labels(Results.merge(c, clearAt("2026-10-13T10:00:01+00:00"))).isEmpty())
        assertTrue(Results.labels(org.json.JSONObject().put("x", org.json.JSONObject().put("deleted", true).put("at", "2026-10-13T11:00:00Z"))).isEmpty())
    }
}
