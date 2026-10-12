package com.kshatralabs.gnssconsole.gnss

import com.hoho.android.usbserial.driver.UsbSerialPort
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One open connection to an F9P over the phone's USB-C/OTG port, via
 * usb-serial-for-android's UsbSerialPort. Sequential, single-threaded access
 * only (exactly like Ground_EO_Tracker's ubx.py GnssDevice) - callers must
 * not call read/send methods from more than one thread concurrently; the
 * corrections writer is the one exception, since it only ever calls write(). */
class UsbGnssConnection(private val port: UsbSerialPort, baud: Int) {
    private val buf = ArrayDeque<Byte>()
    private val chunk = ByteArray(4096)

    init {
        port.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
    }

    fun close() {
        try { port.close() } catch (_: IOException) { }
    }

    @Synchronized
    fun writeRtcmBytes(data: ByteArray) {
        port.write(data, 2000)
    }

    /** Raw bytes, no UBX parsing - for the base's post-survey-in handoff to
     * the RTCM relay (mirrors ubx.py's serve_base_corrections reading
     * base_ser directly instead of through UbxReader, since RTCM3 isn't
     * UBX-framed and would otherwise get silently discarded while the frame
     * parser hunts for UBX sync bytes). Drains anything already buffered
     * from the last readMessage() call first, so nothing at the handoff
     * boundary is lost, then falls back to a fresh port read. */
    @Synchronized
    fun readRawInto(dest: ByteArray, timeoutMs: Int): Int {
        if (buf.isNotEmpty()) {
            val n = minOf(dest.size, buf.size)
            for (i in 0 until n) dest[i] = buf.removeFirst()
            return n
        }
        return port.read(dest, timeoutMs)
    }

    // -- frame extraction, byte-for-byte port of tools/gnss/ubx.py's UbxReader --

    private fun fill(deadlineNanos: Long) {
        val remainingMs = (deadlineNanos - System.nanoTime()) / 1_000_000L
        if (remainingMs <= 0) throw java.util.concurrent.TimeoutException()
        val n = port.read(chunk, remainingMs.toInt().coerceAtLeast(1))
        for (i in 0 until n) buf.addLast(chunk[i])
        // n == 0 just means this slice timed out with no data; the caller loops
        // and calls fill() again, and the overall deadline check above is what
        // eventually gives up - same shape as ubx.py's _fill()/read_message().
    }

    /** Index of the first SYNC1,SYNC2 pair in buf, or -1 if none present yet. */
    private fun findSync(): Int {
        var prev: Byte? = null
        var pos = 0
        for (b in buf) {
            if (prev == Ubx.SYNC1 && b == Ubx.SYNC2) return pos - 1
            prev = b
            pos++
        }
        return -1
    }

    @Synchronized
    fun readMessage(timeoutMs: Long): Ubx.Message? {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        try {
            while (true) {
                val idx = findSync()
                if (idx == -1) {
                    if (buf.size > 1) repeat(buf.size - 1) { buf.removeFirst() }
                    fill(deadline)
                    continue
                }
                repeat(idx) { buf.removeFirst() }
                if (buf.size < 6) {
                    fill(deadline)
                    continue
                }
                val header = buf.toByteArray()
                val plen = (header[4].toInt() and 0xFF) or ((header[5].toInt() and 0xFF) shl 8)
                val total = 6 + plen + 2
                while (buf.size < total) fill(deadline)
                val full = buf.toByteArray()
                val body = full.copyOfRange(2, 6 + plen)
                val (ckA, ckB) = Ubx.checksum(body)
                val gotA = full[6 + plen]
                val gotB = full[7 + plen]
                repeat(total) { buf.removeFirst() }
                if (ckA == gotA && ckB == gotB) {
                    return Ubx.Message(
                        cls = full[2].toInt() and 0xFF,
                        id = full[3].toInt() and 0xFF,
                        payload = body.copyOfRange(4, body.size),
                    )
                }
                // bad checksum: loop, resync on whatever sync bytes remain
            }
        } catch (e: java.util.concurrent.TimeoutException) {
            return null
        }
    }

    private fun ArrayDeque<Byte>.toByteArray(): ByteArray = ByteArray(size) { this[it] }

    // -- higher-level ops, matching ubx.py's GnssDevice methods the rover needs --

    fun sendAckWait(cls: Int, msgId: Int, payload: ByteArray = ByteArray(0), tries: Int = 3): Boolean {
        val pkt = Ubx.frame(cls, msgId, payload)
        repeat(tries) {
            port.write(pkt, 2000)
            val deadline = System.nanoTime() + 2000L * 1_000_000L
            while (System.nanoTime() < deadline) {
                val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
                val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: break
                if (msg.cls == Ubx.CLS_ACK && msg.payload.size >= 2 &&
                    (msg.payload[0].toInt() and 0xFF) == cls && (msg.payload[1].toInt() and 0xFF) == msgId
                ) {
                    return msg.id == Ubx.ACK_ACK
                }
            }
        }
        return false
    }

    fun setMsgRateCurrentPort(msgCls: Int, msgId: Int, rate: Int): Boolean =
        sendAckWait(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(msgCls, msgId, rate))

    fun poll(cls: Int, msgId: Int, timeoutMs: Long = 2000): ByteArray? {
        port.write(Ubx.frame(cls, msgId), 2000)
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: return null
            if (msg.cls == cls && msg.id == msgId) return msg.payload
        }
        return null
    }

    /** CFG-PRT poll/modify/set: OR in the RTCM3X input-protocol bit on
     * whichever port this connection is on, preserving everything else
     * (baud, other protocol bits) - matches ubx.py's enable_rtcm3_input(). */
    fun enableRtcm3Input(): Boolean {
        val payload = poll(Ubx.CLS_CFG, Ubx.CFG_PRT) ?: return false
        if (payload.size < 20) return false
        val vals = payload.copyOf()
        val bb = ByteBuffer.wrap(vals).order(ByteOrder.LITTLE_ENDIAN)
        var inProto = bb.getShort(12).toInt() and 0xFFFF
        inProto = inProto or 0x20
        bb.putShort(12, inProto.toShort())
        return sendAckWait(Ubx.CLS_CFG, Ubx.CFG_PRT, vals)
    }

    fun readNavPvt(timeoutMs: Long = 3000): Ubx.NavPvt? {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: return null
            if (msg.cls == Ubx.CLS_NAV && msg.id == Ubx.NAV_PVT && msg.payload.size >= 52) {
                return Ubx.NavPvt.parse(msg.payload)
            }
        }
        return null
    }

    fun readMonVer(timeoutMs: Long = 3000): String? {
        val payload = poll(Ubx.CLS_MON, Ubx.MON_VER, timeoutMs) ?: return null
        return String(payload, Charsets.US_ASCII).trimEnd('\u0000')
    }

    // -- base-side ops (survey-in + RTCM3 output), for LocalBaseController --

    fun configureSurveyIn(minDurationS: Int, accLimitM: Double): Boolean =
        sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(minDurationS, accLimitM))

    fun enableRtcmBaseOutput(types: List<String> = Ubx.RTCM_BASE_SET.keys.toList()): Map<String, Boolean> =
        types.associateWith { name -> setMsgRateCurrentPort(Ubx.CLS_RTCM3, Ubx.RTCM_BASE_SET.getValue(name), 1) }

    fun readNavSvin(timeoutMs: Long = 3000): Ubx.NavSvin? {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: return null
            if (msg.cls == Ubx.CLS_NAV && msg.id == Ubx.NAV_SVIN && msg.payload.size >= 40) {
                return Ubx.NavSvin.parse(msg.payload)
            }
        }
        return null
    }
}
