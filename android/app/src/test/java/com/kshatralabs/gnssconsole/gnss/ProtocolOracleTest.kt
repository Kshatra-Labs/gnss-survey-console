package com.kshatralabs.gnssconsole.gnss

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/** Ubx.kt / Rtcm.kt against tests/oracle/vectors.json (built by pyubx2 /
 * pyrtcm), plus our encoded frames written out for check_encoders.py. */
class ProtocolOracleTest {
    private val repo = File("../..").canonicalFile
    private val vectors = JSONObject(File(repo, "tests/oracle/vectors.json").readText())

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    private fun parseOne(hexStr: String): Ubx.Message {
        val msgs = ArrayList<Ubx.Message>()
        Ubx.FrameParser { msgs.add(it) }.feed(hex(hexStr))
        assertEquals(1, msgs.size)
        return msgs[0]
    }

    @Test
    fun navPvtMatchesPyubx2() {
        val arr = vectors.getJSONArray("nav_pvt")
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val e = v.getJSONObject("expect")
            val m = parseOne(v.getString("hex"))
            assertEquals(Ubx.CLS_NAV, m.cls)
            assertEquals(Ubx.NAV_PVT, m.id)
            val p = Ubx.NavPvt.parse(m.payload)
            assertEquals("fixType[$i]", e.getInt("fixType"), p.fixType)
            assertEquals("carrSoln[$i]", e.getInt("carrSoln"), p.carrSoln)
            assertEquals("diffSoln[$i]", e.getBoolean("diffSoln"), p.diffSoln)
            assertEquals("gnssFixOk[$i]", e.getBoolean("gnssFixOk"), p.gnssFixOk)
            assertEquals("numSv[$i]", e.getInt("numSv"), p.numSv)
            assertTrue("lat[$i]", abs(p.latDeg - e.getDouble("latDeg")) < 1.5e-7)
            assertTrue("lon[$i]", abs(p.lonDeg - e.getDouble("lonDeg")) < 1.5e-7)
            assertEquals(e.getDouble("heightEllipsoidM"), p.heightEllipsoidM, 1e-9)
            assertEquals(e.getDouble("heightMslM"), p.heightMslM, 1e-9)
            assertEquals(e.getDouble("hAccM"), p.hAccM, 1e-9)
            assertEquals(e.getDouble("vAccM"), p.vAccM, 1e-9)
        }
    }

    @Test
    fun navSvinMatchesPyubx2() {
        val arr = vectors.getJSONArray("nav_svin")
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val e = v.getJSONObject("expect")
            val p = Ubx.NavSvin.parse(parseOne(v.getString("hex")).payload)
            assertEquals(e.getLong("durationS"), p.durationS)
            assertEquals(e.getDouble("meanAccM"), p.meanAccM, 1e-9)
            assertEquals(e.getLong("observations"), p.observations)
            assertEquals(e.getBoolean("valid"), p.valid)
            assertEquals(e.getBoolean("active"), p.active)
        }
    }

    @Test
    fun monVerMatchesPyubx2() {
        val v = vectors.getJSONArray("mon_ver").getJSONObject(0)
        val e = v.getJSONObject("expect")
        val p = Ubx.MonVer.parse(parseOne(v.getString("hex")).payload)
        assertEquals(e.getString("sw"), p.sw)
        assertEquals(e.getString("hw"), p.hw)
        assertEquals(e.getString("mod"), p.mod)
        assertEquals(e.getString("fw"), p.fw)
        assertEquals(e.getString("summary"), p.summary)
    }

    @Test
    fun rtcmFramesAndStream() {
        val frames = vectors.getJSONArray("rtcm")
        for (i in 0 until frames.length()) {
            val f = frames.getJSONObject(i)
            val bytes = hex(f.getString("hex"))
            val out = ArrayList<ByteArray>()
            val s = Rtcm.Scanner { fr, _ -> out.add(fr) }
            s.feed(bytes)
            assertEquals(mapOf(f.getInt("type") to 1), s.counts())
            assertTrue("extracted frame must be byte-identical", out.single().contentEquals(bytes))
        }
        val st = vectors.getJSONObject("rtcm_stream")
        val want = st.getJSONObject("counts").let { c -> c.keys().asSequence().associate { it.toInt() to c.getInt(it) } }
        val stream = hex(st.getString("hex"))
        for (chunk in listOf(stream.size, 1, 7, 64, 333)) {
            val s = Rtcm.Scanner()
            var i = 0
            while (i < stream.size) {
                val n = minOf(chunk, stream.size - i)
                s.feed(stream.copyOfRange(i, i + n))
                i += n
            }
            assertEquals("chunk=$chunk", want, s.counts())
        }
    }

    @Test
    fun ubxStreamRecoveryWithFalseSyncs() {
        val frames = listOf("nav_pvt", "nav_svin", "mon_ver").flatMap { k ->
            val a = vectors.getJSONArray(k); (0 until a.length()).map { a.getJSONObject(it).getString("hex") }
        }
        val stream = java.io.ByteArrayOutputStream()
        for (f in frames) {
            stream.write("\$GNGGA,1,2,3*00\r\n".toByteArray())
            stream.write(byteArrayOf(0xB5.toByte(), 0x62, 1, 7, 0xFF.toByte(), 0xFF.toByte(), 1, 2, 3))
            stream.write(byteArrayOf(0xB5.toByte(), 0x62, 1, 7, 0x10, 0) + ByteArray(18) { 9 })
            stream.write(hex(f))
        }
        val all = stream.toByteArray()
        val rnd = java.util.Random(7)
        val got = ArrayList<String>()
        val parser = Ubx.FrameParser { got.add(Ubx.frame(it.cls, it.id, it.payload).hex()) }
        var i = 0
        while (i < all.size) {
            val n = minOf(1 + rnd.nextInt(40), all.size - i)
            parser.feed(all.copyOfRange(i, i + n))
            i += n
        }
        assertEquals(frames, got)
    }

    @Test
    fun emitEncodedFramesForPyubx2() {
        val ids = JSONObject()
        Ubx.RTCM_BASE_SET.forEach { (k, v) -> ids.put(k, v) }
        val out = JSONObject()
            .put("cfg_msg_navpvt_1", Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(Ubx.CLS_NAV, Ubx.NAV_PVT, 1)).hex())
            .put("cfg_msg_1074_0", Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(Ubx.CLS_RTCM3, Ubx.RTCM_BASE_SET.getValue("1074"), 0)).hex())
            .put("cfg_tmode3_svin_60_2m", Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(60, 2.0)).hex())
            .put("cfg_tmode3_off", Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.tmodeDisabledPayload()).hex())
            .put("poll_mon_ver", Ubx.frame(Ubx.CLS_MON, Ubx.MON_VER).hex())
            .put("poll_cfg_prt", Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_PRT).hex())
            .put("rtcm_msg_ids", ids)
        val f = File(repo, "tests/oracle/kt_frames.json")
        f.writeText(out.toString(1))
        assertNotNull(f)
    }

    @Test
    fun relayUrlNormalization() {
        assertEquals("https://gnss-relay.onrender.com", RelayClient.normalizeUrl(" gnss-relay.onrender.com/ "))
        assertEquals("http://192.168.1.5:8765", RelayClient.normalizeUrl("192.168.1.5:8765"))
        assertEquals("http://localhost:8765", RelayClient.normalizeUrl("localhost:8765/"))
        assertEquals("http://172.20.0.2", RelayClient.normalizeUrl("172.20.0.2"))
        assertEquals("https://172.40.0.2", RelayClient.normalizeUrl("172.40.0.2"))
        assertEquals("http://x.example", RelayClient.normalizeUrl("http://x.example///"))
    }
}
