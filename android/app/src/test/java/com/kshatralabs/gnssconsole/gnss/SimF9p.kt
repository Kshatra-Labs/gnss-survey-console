package com.kshatralabs.gnssconsole.gnss

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Random
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.cos

/** A ZED-F9P stand-in behind SerialIo, written from the UBX/RTCM3 specs with
 * its own encoders (no use of Ubx.kt's frame/parse code). Same behaviour
 * as tests/web/f9p_sim.js, which pyubx2 verifies (tests/web/check_sim.py). */
class SimF9p(
    val deviceBaud: Int = 38400,
    @Volatile var lat: Double = 17.3850123,
    @Volatile var lon: Double = 78.4867456,
    @Volatile var hMsl: Double = 540.1,
    private val epochMs: Long = 200,
    initialInProto: Int = 0x03,
    timeMode: Boolean = false,
    rtcmOutOn: Boolean = false,
    @Volatile var maxCarr: Int = 2,
    private val answers: Boolean = true,
    private val noise: Boolean = true,
    seed: Long = 1,
) : SerialIo {
    private val rnd = Random(seed)
    private val out = LinkedBlockingQueue<ByteArray>()
    private var pending: ByteArray? = null
    private val sched = Executors.newSingleThreadScheduledExecutor { r -> Thread(r).apply { isDaemon = true } }
    private val rates = HashMap<String, Int>()
    @Volatile var inProto = initialInProto
    private var outProto = 0x23
    @Volatile var tmode = if (timeMode) 2 else 0
    private var svDur = 0
    private var svMin = 0
    private var svAccLimit = 0.0
    private var svAcc = 4.0
    private var svValid = 0
    private var svActive = 0
    private var svinOn = false
    @Volatile private var corrLastAt = 0L
    private val corrTypes = HashSet<Int>()
    private var rtkEpochs = 0
    private var lastCarr = 0
    private var epoch = 0
    private var rx = ByteArray(0)
    @Volatile private var portBaud = 115200
    @Volatile var unplugged = false
    @Volatile var nmeaIn = 0
    @Volatile var rtcmInFrames = 0

    init {
        if (rtcmOutOn) for (id in listOf(0x05, 0x4A, 0x54, 0x5E, 0x7C, 0xE6)) rates["245,$id"] = 1
        sched.scheduleAtFixedRate({ synchronized(this) { tick() } }, epochMs, epochMs, TimeUnit.MILLISECONDS)
    }

    private val baudOk get() = answers && portBaud == deviceBaud

    // ---- SerialIo ----
    override fun read(dest: ByteArray, timeoutMs: Int): Int {
        if (unplugged) throw IOException("device lost")
        val chunk = pending ?: out.poll(timeoutMs.toLong(), TimeUnit.MILLISECONDS) ?: return if (unplugged) throw IOException("device lost") else 0
        val n = minOf(dest.size, chunk.size)
        chunk.copyInto(dest, 0, 0, n)
        pending = if (n < chunk.size) chunk.copyOfRange(n, chunk.size) else null
        return n
    }

    override fun write(src: ByteArray, timeoutMs: Int) {
        if (unplugged) throw IOException("device lost")
        if (baudOk) synchronized(this) { input(src) }
    }

    override fun setBaud(baud: Int) {
        portBaud = baud
        out.clear()
        pending = null
    }

    override fun close() {
        sched.shutdownNow()
    }

    fun unplug() {
        unplugged = true
        sched.shutdownNow()
    }

    fun moveTo(lat: Double, lon: Double, hMsl: Double) {
        this.lat = lat; this.lon = lon; this.hMsl = hMsl
    }

    // ---- encoders (independent of Ubx.kt) ----
    private fun ubx(cls: Int, id: Int, p: ByteArray): ByteArray {
        val body = byteArrayOf(cls.toByte(), id.toByte(), (p.size and 0xFF).toByte(), (p.size shr 8).toByte()) + p
        var a = 0
        var b = 0
        for (x in body) { a = (a + (x.toInt() and 0xFF)) and 0xFF; b = (b + a) and 0xFF }
        return byteArrayOf(0xB5.toByte(), 0x62) + body + byteArrayOf(a.toByte(), b.toByte())
    }

    private fun crc24(bytes: ByteArray, n: Int): Int {
        var crc = 0
        for (i in 0 until n) {
            crc = crc xor ((bytes[i].toInt() and 0xFF) shl 16)
            repeat(8) { crc = crc shl 1; if (crc and 0x1000000 != 0) crc = crc xor 0x1864CFB }
        }
        return crc and 0xFFFFFF
    }

    private fun rtcm(type: Int, len: Int): ByteArray {
        val f = ByteArray(len + 6)
        f[0] = 0xD3.toByte(); f[1] = ((len shr 8) and 3).toByte(); f[2] = (len and 0xFF).toByte()
        for (i in 0 until len) f[3 + i] = rnd.nextInt(256).toByte()
        f[3] = (type shr 4).toByte()
        f[4] = (((type and 0xF) shl 4) or (f[4].toInt() and 0xF)).toByte()
        val c = crc24(f, len + 3)
        f[len + 3] = (c shr 16).toByte(); f[len + 4] = (c shr 8).toByte(); f[len + 5] = c.toByte()
        return f
    }

    private fun emit(bytes: ByteArray) {
        if (bytes.isEmpty() || unplugged) return
        if (!baudOk) {
            out.add(ByteArray(maxOf(4, bytes.size / 4)) { rnd.nextInt(256).toByte() })
            return
        }
        var i = 0
        while (i < bytes.size) {
            val n = minOf(1 + rnd.nextInt(300), bytes.size - i)
            out.add(bytes.copyOfRange(i, i + n))
            i += n
        }
    }

    private fun later(ms: Long, f: () -> Unit) {
        try { sched.schedule({ synchronized(this) { f() } }, ms, TimeUnit.MILLISECONDS) } catch (_: Exception) { }
    }

    // ---- receiver ----
    private fun input(chunk: ByteArray) {
        rx += chunk
        var i = 0
        while (i < rx.size) {
            val b0 = rx[i].toInt() and 0xFF
            if (b0 == 0xB5 && i + 1 < rx.size && rx[i + 1] == 0x62.toByte()) {
                if (rx.size - i < 8) break
                val len = (rx[i + 4].toInt() and 0xFF) or ((rx[i + 5].toInt() and 0xFF) shl 8)
                if (len > 4096) { i++; continue }
                if (rx.size - i < 8 + len) break
                var a = 0
                var b = 0
                for (k in i + 2 until i + 6 + len) { a = (a + (rx[k].toInt() and 0xFF)) and 0xFF; b = (b + a) and 0xFF }
                if (inProto and 1 != 0 && a.toByte() == rx[i + 6 + len] && b.toByte() == rx[i + 7 + len]) {
                    command(rx[i + 2].toInt() and 0xFF, rx[i + 3].toInt() and 0xFF, rx.copyOfRange(i + 6, i + 6 + len))
                    i += 8 + len
                } else i++
            } else if (b0 == 0xD3) {
                if (rx.size - i < 3) break
                val len = ((rx[i + 1].toInt() and 3) shl 8) or (rx[i + 2].toInt() and 0xFF)
                if (rx.size - i < len + 6) break
                val f = rx.copyOfRange(i, i + len + 6)
                val got = ((f[len + 3].toInt() and 0xFF) shl 16) or ((f[len + 4].toInt() and 0xFF) shl 8) or (f[len + 5].toInt() and 0xFF)
                val ok = (f[1].toInt() and 0xFC) == 0 && crc24(f, len + 3) == got
                if (ok && inProto and 0x20 != 0) {
                    corrTypes.add(((f[3].toInt() and 0xFF) shl 4) or ((f[4].toInt() and 0xFF) shr 4))
                    corrLastAt = System.currentTimeMillis()
                    rtcmInFrames++
                }
                i += if (ok) len + 6 else 1
            } else {
                if (b0 == 0x24) nmeaIn++
                i++
            }
        }
        rx = rx.copyOfRange(i, rx.size)
    }

    private fun le(n: Long, size: Int): ByteArray = ByteArray(size) { ((n shr (8 * it)) and 0xFF).toByte() }

    private fun ack(cls: Int, id: Int, ok: Boolean) {
        val f = ubx(0x05, if (ok) 1 else 0, byteArrayOf(cls.toByte(), id.toByte()))
        later(10L + rnd.nextInt(60)) {
            if (rnd.nextBoolean() && (rates["1,7"] ?: 0) > 0) emit(navPvt() + f) else emit(f)
        }
    }

    private fun command(cls: Int, id: Int, p: ByteArray) {
        when {
            cls == 6 && id == 1 && p.size == 3 -> {
                rates["${p[0].toInt() and 0xFF},${p[1].toInt() and 0xFF}"] = p[2].toInt() and 0xFF
                ack(cls, id, true)
            }
            cls == 6 && id == 0 && p.isEmpty() -> {
                val pl = byteArrayOf(1, 0, 0, 0) + le(0x8C0, 4) + le(deviceBaud.toLong(), 4) + le(inProto.toLong(), 2) + le(outProto.toLong(), 2) + ByteArray(4)
                later(15) { emit(ubx(6, 0, pl)) }
            }
            cls == 6 && id == 0 && p.size == 20 -> {
                inProto = (p[12].toInt() and 0xFF) or ((p[13].toInt() and 0xFF) shl 8)
                outProto = (p[14].toInt() and 0xFF) or ((p[15].toInt() and 0xFF) shl 8)
                ack(cls, id, true)
            }
            cls == 6 && id == 0x71 && p.size == 40 -> {
                val mode = p[2].toInt() and 0xFF
                if (mode == 0) { tmode = 0; svinOn = false }
                if (mode == 1) {
                    val bb = ByteBuffer.wrap(p).order(ByteOrder.LITTLE_ENDIAN)
                    tmode = 1; svinOn = true; svDur = 0; svMin = bb.getInt(24); svAccLimit = bb.getInt(28) / 10000.0
                    svAcc = 4.0; svValid = 0; svActive = 1
                }
                ack(cls, id, mode <= 1)
            }
            cls == 0x0A && id == 4 && p.isEmpty() -> {
                fun pad(s: String, n: Int) = s.toByteArray().copyOf(n)
                val pl = pad("EXT CORE 1.00 (61b2dd)", 30) + pad("00190000", 10) + pad("ROM BASE 0x118B2060", 30) +
                    pad("FWVER=HPG 1.32", 30) + pad("PROTVER=27.31", 30) + pad("MOD=ZED-F9P", 30)
                later(15) { emit(ubx(0x0A, 4, pl)) }
            }
            else -> ack(cls, id, false)
        }
    }

    private fun carr(): Int {
        if (tmode != 0) return 0
        val fresh = System.currentTimeMillis() - corrLastAt < 2500 && 1005 in corrTypes &&
            listOf(1074, 1077, 1084, 1087, 1094, 1097, 1124, 1127).any { it in corrTypes }
        if (!fresh) { rtkEpochs = 0; return 0 }
        rtkEpochs++
        return if (rtkEpochs >= 4 && maxCarr >= 2) 2 else 1
    }

    private fun navPvt(): ByteArray {
        val c = lastCarr
        val timeOnly = tmode == 2
        val err = when (c) { 2 -> 0.005; 1 -> 0.2; else -> 1.5 }
        val dLat = (rnd.nextDouble() - 0.5) * 2 * err / 111320
        val dLon = (rnd.nextDouble() - 0.5) * 2 * err / (111320 * cos(Math.toRadians(lat)))
        val h = hMsl + (rnd.nextDouble() - 0.5) * 2 * err
        val diff = if (System.currentTimeMillis() - corrLastAt < 2500 && tmode == 0) 1 else 0
        val hAccMm = Math.round((if (timeOnly) 0.0 else err) * 1000) + 1
        val bb = ByteBuffer.allocate(92).order(ByteOrder.LITTLE_ENDIAN)
        bb.putInt(0, epoch * 1000)
        bb.put(20, (if (timeOnly) 5 else 3).toByte())
        bb.put(21, (0x01 or (diff shl 1) or (c shl 6)).toByte())
        bb.put(23, 24)
        bb.putInt(24, Math.round((lon + dLon) * 1e7).toInt())
        bb.putInt(28, Math.round((lat + dLat) * 1e7).toInt())
        bb.putInt(32, Math.round((h - 27.8) * 1000).toInt())
        bb.putInt(36, Math.round(h * 1000).toInt())
        bb.putInt(40, hAccMm.toInt())
        bb.putInt(44, (hAccMm * 3 / 2).toInt())
        return ubx(1, 7, bb.array())
    }

    private fun tick() {
        epoch++
        val o = java.io.ByteArrayOutputStream()
        if (tmode == 1 && svinOn) {
            svDur++
            svAcc = maxOf(0.6, 4.0 - 0.5 * svDur)
            if (svDur >= svMin && svAcc <= svAccLimit) { svValid = 1; svActive = 0; tmode = 2 }
        }
        lastCarr = carr()
        if ((rates["1,7"] ?: 0) > 0) o.write(navPvt())
        if ((rates["1,59"] ?: 0) > 0 && svinOn) {
            val bb = ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN)
            bb.putInt(4, epoch * 1000); bb.putInt(8, svDur); bb.putInt(28, Math.round(svAcc * 10000).toInt()); bb.putInt(32, svDur)
            bb.put(36, svValid.toByte()); bb.put(37, svActive.toByte())
            o.write(ubx(1, 0x3B, bb.array()))
        }
        if (outProto and 0x20 != 0) {
            for ((type, id) in listOf(1005 to 0x05, 1074 to 0x4A, 1084 to 0x54, 1094 to 0x5E, 1124 to 0x7C, 1230 to 0xE6)) {
                if ((rates["245,$id"] ?: 0) <= 0) continue
                if (type == 1005 && tmode != 2) continue
                o.write(rtcm(type, if (type == 1005) 19 else if (type == 1230) 6 else 140))
            }
        }
        if (outProto and 0x02 != 0) o.write("\$GNGGA,093015.$epoch,1723.10074,N,07829.20473,E,1,24,0.6,540.1,M,-27.8,M,,*4F\r\n".toByteArray())
        if (noise && rnd.nextDouble() < 0.3) {
            o.write(byteArrayOf(0xB5.toByte(), 0x62, 1, 7, 0xFE.toByte(), 0xFF.toByte(), 1, 2, 3, 4))
            o.write(byteArrayOf(0xD3.toByte(), 0, 0x40, 9, 9, 9))
        }
        emit(o.toByteArray())
    }
}
