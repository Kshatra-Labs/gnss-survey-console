package com.kshatralabs.gnssconsole.gnss

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Pure UBX protocol logic, no I/O. Mirrors web/gnss.js field-for-field.
 * Payload offsets follow the u-blox ZED-F9P interface description and are
 * checked against pyubx2 test vectors (tests/oracle) by UbxOracleTest. */
object Ubx {
    const val SYNC1: Byte = 0xB5.toByte()
    const val SYNC2: Byte = 0x62.toByte()

    const val CLS_NAV = 0x01
    const val CLS_ACK = 0x05
    const val CLS_CFG = 0x06
    const val CLS_MON = 0x0A
    const val CLS_RTCM3 = 0xF5

    const val NAV_PVT = 0x07
    const val NAV_SVIN = 0x3B
    const val ACK_NAK = 0x00
    const val ACK_ACK = 0x01
    const val CFG_PRT = 0x00
    const val CFG_MSG = 0x01
    const val CFG_TMODE3 = 0x71
    const val MON_VER = 0x04

    /** Larger lengths are false syncs inside RTCM/NMEA data - see web/gnss.js. */
    const val MAX_UBX_PAYLOAD = 1024
    const val NAV_PVT_MIN_LEN = 84

    val RTCM_BASE_SET: Map<String, Int> = linkedMapOf(
        "1005" to 0x05, "1074" to 0x4A, "1084" to 0x54,
        "1094" to 0x5E, "1124" to 0x7C, "1230" to 0xE6,
    )

    fun checksum(body: ByteArray, from: Int = 0, to: Int = body.size): Pair<Byte, Byte> {
        var ckA = 0
        var ckB = 0
        for (i in from until to) {
            ckA = (ckA + (body[i].toInt() and 0xFF)) and 0xFF
            ckB = (ckA + ckB) and 0xFF
        }
        return Pair(ckA.toByte(), ckB.toByte())
    }

    fun frame(cls: Int, msgId: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        val body = ByteArray(4 + payload.size)
        body[0] = cls.toByte()
        body[1] = msgId.toByte()
        body[2] = (payload.size and 0xFF).toByte()
        body[3] = ((payload.size shr 8) and 0xFF).toByte()
        payload.copyInto(body, 4)
        val (ckA, ckB) = checksum(body)
        val out = ByteArray(2 + body.size + 2)
        out[0] = SYNC1
        out[1] = SYNC2
        body.copyInto(out, 2)
        out[out.size - 2] = ckA
        out[out.size - 1] = ckB
        return out
    }

    class Message(val cls: Int, val id: Int, val payload: ByteArray)

    /** CFG-TMODE3 (40 bytes): flags@2 mode=1 survey-in, svinMinDur@24 (s), svinAccLimit@28 (0.1 mm). */
    fun surveyInPayload(minDurationS: Int, accLimitM: Double): ByteArray {
        val buf = ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN)
        buf.putShort(2, 1)
        buf.putInt(24, minDurationS)
        buf.putInt(28, Math.round(accLimitM * 10000.0).toInt())
        return buf.array()
    }

    /** CFG-TMODE3 mode=0: takes a former base out of time mode (see web/gnss.js). */
    fun tmodeDisabledPayload(): ByteArray = ByteArray(40)

    /** CFG-MSG short form: sets the rate on the port this arrives on. */
    fun msgRatePayload(msgCls: Int, msgId: Int, rate: Int): ByteArray =
        byteArrayOf(msgCls.toByte(), msgId.toByte(), rate.toByte())

    fun u8(b: ByteArray, off: Int): Int = b[off].toInt() and 0xFF
    fun i32(b: ByteArray, off: Int): Int = ByteBuffer.wrap(b, off, 4).order(ByteOrder.LITTLE_ENDIAN).int
    fun u32(b: ByteArray, off: Int): Long = i32(b, off).toLong() and 0xFFFFFFFFL

    val CARR_SOLN = mapOf(0 to "none", 1 to "RTK FLOAT", 2 to "RTK FIXED")
    val FIX_TYPE = mapOf(0 to "no fix", 1 to "dead reckoning", 2 to "2D", 3 to "3D", 4 to "GNSS+DR", 5 to "time only")

    data class NavPvt(
        val fixType: Int,
        val numSv: Int,
        val latDeg: Double,
        val lonDeg: Double,
        val heightEllipsoidM: Double,
        val heightMslM: Double,
        val hAccM: Double,
        val vAccM: Double,
        val carrSoln: Int, // 0 none, 1 float, 2 fixed
        val diffSoln: Boolean,
        val gnssFixOk: Boolean,
    ) {
        companion object {
            /** 20 fixType, 21 flags (b0 gnssFixOK, b1 diffSoln, b6-7 carrSoln), 23 numSV,
             * 24 lon, 28 lat (1e-7 deg), 32 height, 36 hMSL, 40 hAcc, 44 vAcc (mm). */
            fun parse(p: ByteArray): NavPvt {
                val flags = u8(p, 21)
                return NavPvt(
                    fixType = u8(p, 20),
                    numSv = u8(p, 23),
                    lonDeg = i32(p, 24) * 1e-7,
                    latDeg = i32(p, 28) * 1e-7,
                    heightEllipsoidM = i32(p, 32) / 1000.0,
                    heightMslM = i32(p, 36) / 1000.0,
                    hAccM = u32(p, 40) / 1000.0,
                    vAccM = u32(p, 44) / 1000.0,
                    carrSoln = (flags shr 6) and 0x3,
                    diffSoln = (flags and 0x2) != 0,
                    gnssFixOk = (flags and 0x1) != 0,
                )
            }
        }
    }

    data class NavSvin(
        val durationS: Long,
        val meanAccM: Double,
        val observations: Long,
        val valid: Boolean,
        val active: Boolean,
    ) {
        companion object {
            /** 8 dur (s), 28 meanAcc (0.1 mm), 32 obs, 36 valid, 37 active. */
            fun parse(p: ByteArray): NavSvin =
                NavSvin(u32(p, 8), u32(p, 28) / 10000.0, u32(p, 32), p[36].toInt() != 0, p[37].toInt() != 0)
        }
    }

    data class MonVer(val sw: String, val hw: String, val ext: List<String>) {
        val mod: String get() = ext.firstOrNull { it.startsWith("MOD=") }?.removePrefix("MOD=") ?: ""
        val fw: String get() = ext.firstOrNull { it.startsWith("FWVER=") }?.removePrefix("FWVER=") ?: ""
        val summary: String get() = listOf(mod.ifEmpty { "u-blox" }, fw.ifEmpty { sw }).filter { it.isNotEmpty() }.joinToString(" ")

        companion object {
            private fun field(p: ByteArray, start: Int, len: Int): String {
                val end = minOf(start + len, p.size)
                var stop = start
                while (stop < end && p[stop].toInt() != 0) stop++
                return String(p, start, stop - start, Charsets.US_ASCII).trim()
            }

            /** char[30] sw, char[10] hw, then char[30] extensions. */
            fun parse(p: ByteArray): MonVer {
                val ext = ArrayList<String>()
                var off = 40
                while (off + 30 <= p.size) {
                    field(p, off, 30).takeIf { it.isNotEmpty() }?.let(ext::add)
                    off += 30
                }
                return MonVer(field(p, 0, 30), field(p, 30, 10), ext)
            }
        }
    }

    /** Push-based frame extractor for a byte stream (used to watch the
     * base's raw output for NAV-PVT while it's being forwarded). */
    class FrameParser(private val onMessage: (Message) -> Unit) {
        private var buf = ByteArray(0)

        fun feed(data: ByteArray, len: Int = data.size) {
            buf = buf + data.copyOf(len)
            var i = 0
            while (true) {
                while (i < buf.size - 1 && !(buf[i] == SYNC1 && buf[i + 1] == SYNC2)) i++
                if (buf.size - i < 6) break
                val plen = (buf[i + 4].toInt() and 0xFF) or ((buf[i + 5].toInt() and 0xFF) shl 8)
                if (plen > MAX_UBX_PAYLOAD) { i++; continue }
                val total = 8 + plen
                if (buf.size - i < total) break
                val (a, b) = checksum(buf, i + 2, i + 6 + plen)
                if (a == buf[i + 6 + plen] && b == buf[i + 7 + plen]) {
                    onMessage(Message(buf[i + 2].toInt() and 0xFF, buf[i + 3].toInt() and 0xFF, buf.copyOfRange(i + 6, i + 6 + plen)))
                    i += total
                } else {
                    i++
                }
            }
            buf = if (i >= buf.size) ByteArray(0) else buf.copyOfRange(i, buf.size)
        }
    }
}
