package com.kshatralabs.gnssconsole.gnss

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Client for the cloud relay (server/app.py) - same protocol as
 * web/webserial.js, so app and browser bases/rovers interoperate. */
object RelayClient {
    // No read timeout on the socket itself: a rover's link is legitimately
    // silent while no base is broadcasting. Liveness comes from pings - a
    // missed pong fails the socket and the reconnect loop takes over.
    private val wsClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val httpClient = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .build()

    /** "gnss-relay.onrender.com/" -> https://..., "192.168.1.5:8765" -> http://... */
    fun normalizeUrl(url: String): String {
        var u = url.trim()
        if (!Regex("^[a-zA-Z]+://").containsMatchIn(u)) {
            val host = u.split('/', ':').first().lowercase()
            val local = host == "localhost" || host.startsWith("127.") || host.startsWith("10.") ||
                host.startsWith("192.168.") || Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host) || host.endsWith(".local")
            u = (if (local) "http://" else "https://") + u
        }
        return u.trimEnd('/')
    }

    /** Throws IllegalArgumentException for an unusable address. */
    fun baseUrl(backendUrl: String): HttpUrl = normalizeUrl(backendUrl).toHttpUrl()

    private fun wsUrl(backendUrl: String, channel: String, role: String): HttpUrl =
        baseUrl(backendUrl).newBuilder().addPathSegments("ws/relay").addPathSegment(channel)
            .addQueryParameter("role", role).build()

    private fun ago(at: Long): String =
        if (at == 0L) "never" else "${fmt((System.currentTimeMillis() - at) / 1000.0, 1)}s ago"

    /** GET /status/{channel} - immediately, after 1.5 s, then every 5 s.
     * Shows whether a base is live on the channel and doubles as the
     * keep-alive that stops a free-tier relay host idling to sleep. */
    class ChannelStatus(private val backendUrl: String, private val channel: String) {
        data class Snapshot(
            val ok: Boolean?, val baseOnline: Boolean = false, val bases: Int = 0, val rovers: Int = 0,
            val lastBaseDataAgeS: Double? = null, val error: String? = null,
        )

        @Volatile var snapshot = Snapshot(ok = null)
            private set
        @Volatile private var stopped = false
        private val thread = Thread {
            var polls = 0
            while (!stopped) {
                poll()
                polls++
                try { Thread.sleep(if (polls == 1) 1500L else 5000L) } catch (_: InterruptedException) { }
            }
        }.apply { isDaemon = true; start() }

        private fun poll() {
            snapshot = try {
                val url = baseUrl(backendUrl).newBuilder().addPathSegment("status").addPathSegment(channel).build()
                httpClient.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                    val j = JSONObject(r.body!!.string())
                    Snapshot(
                        ok = true,
                        baseOnline = j.getBoolean("base_online"),
                        bases = j.getInt("bases"),
                        rovers = j.getInt("rovers"),
                        lastBaseDataAgeS = if (j.isNull("last_base_data_age_s")) null else j.getDouble("last_base_data_age_s"),
                    )
                }
            } catch (e: Exception) {
                snapshot.copy(ok = false, error = e.message ?: e.javaClass.simpleName)
            }
        }

        fun line(role: String): String {
            val s = snapshot
            return when (s.ok) {
                null -> "channel \"$channel\": checking..."
                false -> "channel \"$channel\": relay status unavailable (${s.error})"
                true -> buildString {
                    val age = s.lastBaseDataAgeS?.let { "${fmt(it, 1)}s ago" } ?: "never"
                    append("channel \"$channel\": base online=${s.baseOnline}  rovers=${s.rovers}  base data last=$age")
                    if (s.bases > 1) append("  WARNING: ${s.bases} bases on this channel - only the newest is relayed")
                    if (role == "rover" && !s.baseOnline) append("  <- no base is broadcasting on this channel")
                }
            }
        }

        fun stop() {
            stopped = true
            thread.interrupt()
        }
    }

    abstract class Link(protected val backendUrl: String, protected val channel: String, private val role: String) {
        val status = ChannelStatus(backendUrl, channel)
        protected val bytes = AtomicLong(0)
        protected val dropped = AtomicLong(0)
        @Volatile protected var lastAt = 0L
        @Volatile protected var socket: WebSocket? = null
        @Volatile var isOpen = false
            protected set
        @Volatile var lastError: String? = null
            protected set
        @Volatile private var stopped = false
        // Callbacks from an older socket are ignored by generation, not by
        // comparing to `socket`: OkHttp can call onOpen before
        // newWebSocket() has even returned and been assigned.
        @Volatile private var generation = 0

        val byteCount: Long get() = bytes.get()

        protected abstract fun onBinary(data: ByteArray)

        @Synchronized
        fun connect() {
            if (stopped) return
            val url = try {
                wsUrl(backendUrl, channel, role)
            } catch (e: IllegalArgumentException) {
                lastError = "bad relay address \"$backendUrl\""
                return
            }
            val gen = ++generation
            socket = wsClient.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (gen != generation) return
                    socket = webSocket
                    isOpen = true
                    lastError = null
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (gen == generation) onBinary(bytes.toByteArray())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onDropped(gen, "closed ($code)")

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    onDropped(gen, t.message ?: t.javaClass.simpleName)
            })
        }

        private fun onDropped(gen: Int, why: String) {
            if (gen != generation) return
            isOpen = false
            lastError = why
            if (stopped) return
            Thread {
                try { Thread.sleep(3000) } catch (_: InterruptedException) { }
                if (!stopped) connect()
            }.apply { isDaemon = true; start() }
        }

        protected fun linkLine(verb: String): String = buildString {
            append("relay: ${if (isOpen) "connected" else "connecting/reconnecting"}  bytes $verb=${bytes.get()}  last=${ago(lastAt)}")
            if (dropped.get() > 0) append("  dropped while offline=${dropped.get()}")
            if (!isOpen && lastError != null) append("  ($lastError)")
        }

        open fun stop() {
            stopped = true
            status.stop()
            try { socket?.close(1000, null) } catch (_: Exception) { }
            isOpen = false
        }
    }

    /** Base side: feed() the receiver's raw output; only CRC-valid RTCM3
     * frames are uploaded (its NMEA/UBX would otherwise flood rovers'
     * command inputs). Dropped, not queued, while the link is down. */
    class Upload(backendUrl: String, channel: String) : Link(backendUrl, channel, "base") {
        private val batch = ByteArrayOutputStream()
        private val extractor = Rtcm.Scanner { frame, _ -> batch.write(frame) }

        override fun onBinary(data: ByteArray) {}

        fun feed(raw: ByteArray, len: Int) {
            batch.reset()
            extractor.feed(raw, len)
            if (batch.size() == 0) return
            val out = batch.toByteArray()
            val s = socket
            if (isOpen && s != null && s.send(out.toByteString())) {
                bytes.addAndGet(out.size.toLong())
                lastAt = System.currentTimeMillis()
            } else {
                dropped.addAndGet(out.size.toLong())
            }
        }

        fun statsLine(): String = linkLine("sent")
    }

    /** Rover side: every chunk from the relay goes to onBytes (the
     * receiver), with CRC-valid RTCM3 frames counted by type on the way.
     * The rover's live fix goes back up as JSON text, for the Site map. */
    class Download(backendUrl: String, channel: String, private val onBytes: (ByteArray) -> Unit) :
        Link(backendUrl, channel, "rover") {
        val rtcmIn = Rtcm.Scanner()
        @Volatile private var lastPvtSent = 0L

        /** At most once a second; skipped while the link is down. */
        fun sendPvt(pvt: Ubx.NavPvt?, source: String) {
            val s = socket
            val now = System.currentTimeMillis()
            if (pvt == null || pvt.fixType < 2 || !isOpen || s == null || now - lastPvtSent < 1000) return
            lastPvtSent = now
            s.send(pvtJson(pvt, source).toString())
        }

        override fun onBinary(data: ByteArray) {
            bytes.addAndGet(data.size.toLong())
            lastAt = System.currentTimeMillis()
            rtcmIn.feed(data)
            try { onBytes(data) } catch (_: Exception) { /* receiver unplugged: the session loop reports it */ }
        }

        fun statsLine(): String = linkLine("received")
    }

    fun pvtJson(pvt: Ubx.NavPvt, source: String): JSONObject = JSONObject()
        .put("type", "pvt").put("lat", pvt.latDeg).put("lon", pvt.lonDeg).put("h", pvt.heightMslM)
        .put("carrSoln", pvt.carrSoln).put("hAccM", pvt.hAccM).put("numSv", pvt.numSv).put("source", source)

    private fun resultsUrl(backendUrl: String, channel: String, label: String? = null): HttpUrl =
        baseUrl(backendUrl).newBuilder().addPathSegment("results").addPathSegment(channel)
            .apply { if (label != null) addPathSegment(label) }.build()

    /** GET /results/{channel}: label -> result. Blocking; throws IOException. */
    fun getResults(backendUrl: String, channel: String): JSONObject =
        httpClient.newCall(Request.Builder().url(resultsUrl(backendUrl, channel)).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            JSONObject(r.body!!.string()).optJSONObject("results") ?: JSONObject()
        }

    /** PUT /results/{channel}/{label}. Blocking; throws IOException. */
    fun putResult(backendUrl: String, channel: String, label: String, result: JSONObject) {
        val body = result.toString().toRequestBody("application/json".toMediaType())
        httpClient.newCall(Request.Builder().url(resultsUrl(backendUrl, channel, label)).put(body).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
        }
    }

    private val healthClient = OkHttpClient.Builder()
        .callTimeout(75, TimeUnit.SECONDS) // a sleeping free-tier relay can take ~1 min to wake
        .build()

    /** GET /healthz: (reachable, human-readable line). Blocking - call off the main thread. */
    fun health(backendUrl: String): Pair<Boolean, String> {
        val shown = normalizeUrl(backendUrl)
        return try {
            val url = baseUrl(backendUrl).newBuilder().addPathSegment("healthz").build()
            val t0 = System.currentTimeMillis()
            healthClient.newCall(Request.Builder().url(url).build()).execute().use { r ->
                if (!r.isSuccessful) return false to "relay NOT reachable at $shown: HTTP ${r.code}"
                val j = JSONObject(r.body!!.string())
                val commit = j.optString("commit").takeIf { it.isNotEmpty() }?.let { " / $it" } ?: ""
                true to "relay reachable: $shown  (version ${j.optString("version")}$commit, answered in " +
                    "${System.currentTimeMillis() - t0} ms, active channels=${j.optInt("channels")})"
            }
        } catch (e: Exception) {
            false to "relay NOT reachable at $shown: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    fun startUpload(backendUrl: String, channel: String): Upload = Upload(backendUrl, channel).also { it.connect() }

    fun startDownload(backendUrl: String, channel: String, onBytes: (ByteArray) -> Unit): Download =
        Download(backendUrl, channel, onBytes).also { it.connect() }
}
