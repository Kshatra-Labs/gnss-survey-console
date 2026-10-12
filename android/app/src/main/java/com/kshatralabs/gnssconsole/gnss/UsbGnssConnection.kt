package com.kshatralabs.gnssconsole.gnss

import com.hoho.android.usbserial.driver.UsbSerialPort
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** The byte pipe to a receiver: the phone's USB port in the app, a
 * simulated receiver in unit tests. */
interface SerialIo {
    /** Up to dest.size bytes; 0 on timeout. Throws IOException once the device is gone. */
    fun read(dest: ByteArray, timeoutMs: Int): Int
    fun write(src: ByteArray, timeoutMs: Int)
    fun setBaud(baud: Int)
    fun close()
}

class UsbSerialIo(private val port: UsbSerialPort) : SerialIo {
    override fun read(dest: ByteArray, timeoutMs: Int): Int = port.read(dest, timeoutMs)
    override fun write(src: ByteArray, timeoutMs: Int) = port.write(src, timeoutMs)
    override fun setBaud(baud: Int) = port.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
    override fun close() {
        try { port.close() } catch (_: IOException) { }
    }
}

/** One open connection to a u-blox receiver. Reads happen on one session
 * thread; writes have their own lock so RTCM corrections arriving on the
 * network thread are never stuck behind a blocking read. */
class UsbGnssConnection(private val io: SerialIo) {
    companion object {
        val BAUD_CANDIDATES = listOf(115200, 38400, 9600, 230400, 460800, 57600, 921600)
    }

    var baud = 0
        private set
    var monVer: Ubx.MonVer? = null
        private set
    @Volatile var alive = true
        private set
    @Volatile var bytesIn = 0L
        private set

    /** RTCM3 the receiver itself outputs (base). */
    val rtcmOut = Rtcm.Scanner()

    @Volatile private var lastPvt: Ubx.NavPvt? = null
    @Volatile private var lastPvtAt = 0L

    private val readLock = Any()
    private val writeLock = Any()
    private var rbuf = ByteArray(8192)
    private var rlen = 0
    private val chunk = ByteArray(4096)
    private val sideParser = Ubx.FrameParser(::observe)

    fun close() {
        io.close()
    }

    private fun observe(m: Ubx.Message) {
        if (m.cls == Ubx.CLS_NAV && m.id == Ubx.NAV_PVT && m.payload.size >= Ubx.NAV_PVT_MIN_LEN) {
            lastPvt = Ubx.NavPvt.parse(m.payload)
            lastPvtAt = System.currentTimeMillis()
        }
    }

    fun latestPvt(maxAgeMs: Long = 3000): Ubx.NavPvt? =
        lastPvt?.takeIf { System.currentTimeMillis() - lastPvtAt <= maxAgeMs }

    private fun ioRead(dest: ByteArray, timeoutMs: Int): Int {
        val n = try {
            io.read(dest, timeoutMs)
        } catch (e: IOException) {
            alive = false
            throw IOException("USB receiver disconnected (${e.message})", e)
        }
        if (n > 0) {
            bytesIn += n
            rtcmOut.feed(dest, n)
        }
        return n
    }

    fun write(data: ByteArray) {
        synchronized(writeLock) {
            try {
                io.write(data, 2000)
            } catch (e: IOException) {
                alive = false
                throw IOException("USB receiver disconnected (${e.message})", e)
            }
        }
    }

    fun writeRtcmBytes(data: ByteArray) = write(data)

    private fun consume(n: Int) {
        System.arraycopy(rbuf, n, rbuf, 0, rlen - n)
        rlen -= n
    }

    private fun append(src: ByteArray, n: Int) {
        if (rlen + n > rbuf.size) rbuf = rbuf.copyOf(maxOf(rbuf.size * 2, rlen + n))
        System.arraycopy(src, 0, rbuf, rlen, n)
        rlen += n
    }

    /** Forget anything buffered (stale messages from before a session). */
    fun discardInput() {
        synchronized(readLock) { rlen = 0 }
    }

    /** Next valid UBX message, or null once timeoutMs passes. */
    fun readMessage(timeoutMs: Long): Ubx.Message? = synchronized(readLock) { readMessageLocked(timeoutMs) }

    private fun readMessageLocked(timeoutMs: Long): Ubx.Message? {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (true) {
            var i = 0
            while (i < rlen - 1 && !(rbuf[i] == Ubx.SYNC1 && rbuf[i + 1] == Ubx.SYNC2)) i++
            if (i > 0) consume(i)
            if (rlen >= 6) {
                val plen = (rbuf[4].toInt() and 0xFF) or ((rbuf[5].toInt() and 0xFF) shl 8)
                if (plen > Ubx.MAX_UBX_PAYLOAD) { consume(1); continue }
                val total = 8 + plen
                if (rlen >= total) {
                    val (a, b) = Ubx.checksum(rbuf, 2, 6 + plen)
                    if (a == rbuf[6 + plen] && b == rbuf[7 + plen]) {
                        val m = Ubx.Message(rbuf[2].toInt() and 0xFF, rbuf[3].toInt() and 0xFF, rbuf.copyOfRange(6, 6 + plen))
                        consume(total)
                        observe(m)
                        return m
                    }
                    consume(1)
                    continue
                }
            }
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            if (remainingMs <= 0) return null
            val n = ioRead(chunk, remainingMs.coerceIn(1, 500).toInt())
            if (n > 0) append(chunk, n)
        }
    }

    /** Raw passthrough for the base's RTCM upload; UBX is still watched on
     * the side so latestPvt() stays live for the stats display. */
    fun readRawInto(dest: ByteArray, timeoutMs: Int): Int = synchronized(readLock) {
        val n = if (rlen > 0) {
            val k = minOf(dest.size, rlen)
            System.arraycopy(rbuf, 0, dest, 0, k)
            consume(k)
            k
        } else {
            ioRead(dest, timeoutMs)
        }
        if (n > 0) sideParser.feed(dest, n)
        n
    }

    /** true on ACK-ACK; false on ACK-NAK or no answer. */
    fun sendAckWait(cls: Int, msgId: Int, payload: ByteArray = ByteArray(0), tries: Int = 2): Boolean {
        val pkt = Ubx.frame(cls, msgId, payload)
        repeat(tries) {
            write(pkt)
            val deadline = System.nanoTime() + 1200L * 1_000_000L
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
        write(Ubx.frame(cls, msgId))
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: return null
            if (msg.cls == cls && msg.id == msgId) return msg.payload
        }
        return null
    }

    /** CFG-PRT poll / OR in inRTCM3 (bit 5 of inProtoMask @12) / set back. */
    fun enableRtcm3Input(): Boolean {
        val payload = poll(Ubx.CLS_CFG, Ubx.CFG_PRT) ?: return false
        if (payload.size < 20) return false
        val bb = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        val inProto = bb.getShort(12).toInt() and 0xFFFF
        if (inProto and 0x20 != 0) return true
        bb.putShort(12, (inProto or 0x20).toShort())
        return sendAckWait(Ubx.CLS_CFG, Ubx.CFG_PRT, payload)
    }

    fun readNavPvt(timeoutMs: Long = 3000): Ubx.NavPvt? {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000L
        while (System.nanoTime() < deadline) {
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            val msg = readMessage(remainingMs.coerceAtLeast(50)) ?: return null
            if (msg.cls == Ubx.CLS_NAV && msg.id == Ubx.NAV_PVT && msg.payload.size >= Ubx.NAV_PVT_MIN_LEN) {
                return Ubx.NavPvt.parse(msg.payload)
            }
        }
        return null
    }

    fun readMonVer(timeoutMs: Long = 3000): Ubx.MonVer? =
        poll(Ubx.CLS_MON, Ubx.MON_VER, timeoutMs)?.takeIf { it.size >= 40 }?.let(Ubx.MonVer::parse)

    /** Tries each baud until the receiver answers MON-VER. */
    fun detectBaud(onTry: (Int) -> Unit = {}): Boolean {
        for (b in BAUD_CANDIDATES) {
            onTry(b)
            io.setBaud(b)
            baud = b
            discardInput()
            val v = readMonVer(1200)
            if (v != null) {
                monVer = v
                return true
            }
        }
        return false
    }

    /** Rover setup, undoing base-mode leftovers (see web/webserial.js). */
    fun configureRover(onStep: (String) -> Unit = {}): Map<String, Boolean> {
        val r = linkedMapOf<String, Boolean>()
        onStep("time mode off")
        r["timeModeOff"] = sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.tmodeDisabledPayload())
        onStep("RTCM output off")
        var off = true
        for (id in Ubx.RTCM_BASE_SET.values) off = setMsgRateCurrentPort(Ubx.CLS_RTCM3, id, 0) && off
        r["rtcmOutputOff"] = off
        onStep("position output (NAV-PVT) on")
        r["navPvt"] = setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1)
        onStep("RTCM3 correction input on")
        r["rtcmInput"] = enableRtcm3Input()
        return r
    }

    fun configureBase(minDurationS: Int, accLimitM: Double, onStep: (String) -> Unit = {}): Map<String, Boolean> {
        val r = linkedMapOf<String, Boolean>()
        onStep("position output (NAV-PVT) on")
        r["navPvt"] = setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1)
        onStep("survey-in progress output (NAV-SVIN) on")
        r["navSvin"] = setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_SVIN, 1)
        for ((name, id) in Ubx.RTCM_BASE_SET) {
            onStep("RTCM $name output on")
            r["rtcm$name"] = setMsgRateCurrentPort(Ubx.CLS_RTCM3, id, 1)
        }
        onStep("start survey-in")
        r["surveyIn"] = sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(minDurationS, accLimitM), tries = 3)
        return r
    }
}
