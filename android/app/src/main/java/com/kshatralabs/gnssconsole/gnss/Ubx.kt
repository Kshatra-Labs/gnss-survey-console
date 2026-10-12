package com.kshatralabs.gnssconsole.gnss

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.experimental.and

/** Pure UBX protocol logic - no I/O. Direct Kotlin port of
 * Ground_EO_Tracker/tools/gnss/ubx.py and GNSS_Survey_Console/gnss_core/ubx.py,
 * kept field-for-field identical (message IDs, payload layouts) so behavior
 * matches the already-verified Python implementation exactly. RTCM message
 * IDs below were confirmed against a live NEO-F9P (see that file's comments). */
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

    val RTCM_BASE_SET: Map<String, Int> = mapOf(
        "1005" to 0x05, "1074" to 0x4A, "1084" to 0x54,
        "1094" to 0x5E, "1124" to 0x7C, "1230" to 0xE6,
    )

    fun checksum(body: ByteArray): Pair<Byte, Byte> {
        var ckA = 0
        var ckB = 0
        for (b in body) {
            ckA = (ckA + (b.toInt() and 0xFF)) and 0xFF
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

    data class Message(val cls: Int, val id: Int, val payload: ByteArray)

    /** CFG-TMODE3 with mode=1 (survey-in), matching ubx.py's configure_survey_in. */
    fun surveyInPayload(minDurationS: Int, accLimitM: Double): ByteArray {
        val accLimit01mm = Math.round(accLimitM * 10000.0).toInt()
        val buf = ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN)
        buf.put(0)              // version
        buf.put(0)              // reserved1
        buf.putShort(1)         // flags: mode=1 (survey-in), lla bit=0
        buf.putInt(0); buf.putInt(0); buf.putInt(0) // ecefXOrLat/Y/Z
        buf.put(0); buf.put(0); buf.put(0) // HP components
        buf.put(0)               // reserved2
        buf.putInt(0)            // fixedPosAcc
        buf.putInt(minDurationS)
        buf.putInt(accLimit01mm)
        buf.put(ByteArray(8))    // reserved3
        return buf.array()
    }

    /** 3-byte CFG-MSG: sets the output rate on whichever port this arrives on. */
    fun msgRatePayload(msgCls: Int, msgId: Int, rate: Int): ByteArray =
        byteArrayOf(msgCls.toByte(), msgId.toByte(), rate.toByte())

    fun u8(b: ByteArray, off: Int): Int = b[off].toInt() and 0xFF
    fun i32(b: ByteArray, off: Int): Int =
        ByteBuffer.wrap(b, off, 4).order(ByteOrder.LITTLE_ENDIAN).int
    fun u32(b: ByteArray, off: Int): Long =
        ByteBuffer.wrap(b, off, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xFFFFFFFFL

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
        val gnssFixOk: Boolean,
    ) {
        val statusStr: String
            get() {
                val base = FIX_TYPE[fixType] ?: "?$fixType"
                val carr = CARR_SOLN[carrSoln] ?: "?"
                return "$base, carrier=$carr, sv=$numSv, hAcc=${"%.3f".format(hAccM)}m vAcc=${"%.3f".format(vAccM)}m"
            }

        companion object {
            fun parse(p: ByteArray): NavPvt {
                val fixType = u8(p, 24)
                val flags = u8(p, 25)
                val numSv = u8(p, 27)
                val lon = i32(p, 28) * 1e-7
                val lat = i32(p, 32) * 1e-7
                val height = i32(p, 36) / 1000.0
                val hMsl = i32(p, 40) / 1000.0
                val hAcc = u32(p, 44) / 1000.0
                val vAcc = u32(p, 48) / 1000.0
                return NavPvt(
                    fixType = fixType, numSv = numSv, latDeg = lat, lonDeg = lon,
                    heightEllipsoidM = height, heightMslM = hMsl, hAccM = hAcc, vAccM = vAcc,
                    carrSoln = (flags shr 3) and 0x3, gnssFixOk = (flags and 0x1) != 0,
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
            fun parse(p: ByteArray): NavSvin {
                val dur = u32(p, 8)
                val meanAcc = u32(p, 28) / 10000.0
                val obs = u32(p, 32)
                return NavSvin(dur, meanAcc, obs, p[36].toInt() != 0, p[37].toInt() != 0)
            }
        }
    }
}
