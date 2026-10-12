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
}
