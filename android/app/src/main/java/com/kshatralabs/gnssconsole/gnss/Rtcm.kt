package com.kshatralabs.gnssconsole.gnss

/** RTCM3 framing (0xD3, 6 zero bits + 10-bit length, payload, CRC-24Q).
 * Mirrors Rtcm in web/gnss.js. */
object Rtcm {
    private val TABLE = IntArray(256).also { t ->
        for (i in 0 until 256) {
            var c = i shl 16
            repeat(8) {
                c = c shl 1
                if (c and 0x1000000 != 0) c = c xor 0x1864CFB
            }
            t[i] = c and 0xFFFFFF
        }
    }

    fun crc24q(buf: ByteArray, start: Int = 0, end: Int = buf.size): Int {
        var crc = 0
        for (i in start until end) {
            crc = ((crc shl 8) and 0xFFFFFF) xor TABLE[((crc shr 16) xor (buf[i].toInt() and 0xFF)) and 0xFF]
        }
        return crc
    }

    /** Counts CRC-valid RTCM3 frames by type in a mixed byte stream and,
     * with onFrame, hands each complete frame out. Thread-safe: fed from
     * one thread, read for display from another. */
    class Scanner(private val onFrame: ((ByteArray, Int) -> Unit)? = null) {
        private var buf = ByteArray(0)
        private val counts = sortedMapOf<Int, Int>()
        @Volatile var frames = 0L
            private set
        @Volatile var lastAt = 0L
            private set

        @Synchronized
        fun feed(data: ByteArray, len: Int = data.size) {
            buf = buf + data.copyOf(len)
            val n = buf.size
            var i = 0
            while (i < n) {
                if (buf[i] != 0xD3.toByte()) { i++; continue }
                if (n - i < 3) break
                val b1 = buf[i + 1].toInt() and 0xFF
                if (b1 and 0xFC != 0) { i++; continue }
                val plen = ((b1 and 0x03) shl 8) or (buf[i + 2].toInt() and 0xFF)
                val total = 3 + plen + 3
                if (n - i < total) break
                val got = ((buf[i + 3 + plen].toInt() and 0xFF) shl 16) or
                    ((buf[i + 4 + plen].toInt() and 0xFF) shl 8) or (buf[i + 5 + plen].toInt() and 0xFF)
                if (plen >= 2 && crc24q(buf, i, i + 3 + plen) == got) {
                    val type = ((buf[i + 3].toInt() and 0xFF) shl 4) or ((buf[i + 4].toInt() and 0xFF) shr 4)
                    counts[type] = (counts[type] ?: 0) + 1
                    frames++
                    lastAt = System.currentTimeMillis()
                    onFrame?.invoke(buf.copyOfRange(i, i + total), type)
                    i += total
                } else {
                    i++
                }
            }
            buf = if (i == 0) buf else buf.copyOfRange(i, n)
        }

        @Synchronized
        fun counts(): Map<Int, Int> = HashMap(counts)

        @Synchronized
        fun summary(): String =
            if (counts.isEmpty()) "none yet" else counts.entries.joinToString(" ") { "${it.key}x${it.value}" }

        fun ageText(): String {
            val at = lastAt
            return if (at == 0L) "never" else "${fmt((System.currentTimeMillis() - at) / 1000.0, 1)}s ago"
        }
    }
}
