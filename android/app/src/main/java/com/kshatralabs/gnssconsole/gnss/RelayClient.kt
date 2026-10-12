package com.kshatralabs.gnssconsole.gnss

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/** Client for the backend's pure byte relay (server/app.py's
 * /ws/relay/{channel}) - the same cloud hub the web console's
 * webserial.js's startRelayUpload/startRelayDownload talk to, so a base
 * running in this app can feed a rover in a browser and vice versa. The
 * relay itself has no USB/serial dependency; only this app's own USB
 * connection does. */
object RelayClient {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) // keeps the socket alive through idle periods / NAT timeouts
        .build()

    private fun wsUrl(backendUrl: String, channel: String, role: String): String {
        val base = backendUrl.trimEnd('/').replaceFirst(Regex("^http"), "ws")
        return "$base/ws/relay/$channel?role=$role"
    }

    /** Base side: call feed(bytes) with raw receiver output (post-survey-in)
     * to upload it to the relay. Returns a handle whose stop() closes the
     * link; reconnects automatically on drop, same as the web version. */
    fun startUpload(backendUrl: String, channel: String, onStatus: (String) -> Unit): Upload {
        val upload = Upload(backendUrl, channel, onStatus)
        upload.connect()
        return upload
    }

    class Upload(private val backendUrl: String, private val channel: String, private val onStatus: (String) -> Unit) {
        @Volatile private var stopped = false
        @Volatile private var socket: WebSocket? = null
        private val pending = java.util.concurrent.ConcurrentLinkedQueue<ByteString>()

        fun connect() {
            if (stopped) return
            val req = Request.Builder().url(wsUrl(backendUrl, channel, "base")).build()
            socket = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    onStatus("relay: uploading on channel \"$channel\"")
                    var b = pending.poll()
                    while (b != null) { webSocket.send(b); b = pending.poll() }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = reconnect()
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onStatus("relay: upload error (${t.message}), reconnecting")
                    reconnect()
                }
            })
        }

        private fun reconnect() {
            if (stopped) return
            Thread {
                Thread.sleep(3000)
                if (!stopped) connect()
            }.also { it.isDaemon = true; it.start() }
        }

        fun feed(bytes: ByteArray, len: Int) {
            if (stopped) return
            val bs = bytes.copyOf(len).toByteString()
            val s = socket
            if (s != null) s.send(bs) else pending.add(bs)
        }

        fun stop() {
            stopped = true
            try { socket?.close(1000, null) } catch (e: Exception) { }
        }
    }

    /** Rover side: onBytes is called with every chunk the relay forwards
     * from whichever base is uploading on this channel. */
    fun startDownload(backendUrl: String, channel: String, onBytes: (ByteArray) -> Unit, onStatus: (String) -> Unit): Download {
        val download = Download(backendUrl, channel, onBytes, onStatus)
        download.connect()
        return download
    }

    class Download(
        private val backendUrl: String, private val channel: String,
        private val onBytes: (ByteArray) -> Unit, private val onStatus: (String) -> Unit,
    ) {
        @Volatile private var stopped = false
        @Volatile private var socket: WebSocket? = null

        fun connect() {
            if (stopped) return
            val req = Request.Builder().url(wsUrl(backendUrl, channel, "rover")).build()
            socket = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    onStatus("relay: receiving corrections on channel \"$channel\"")
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    onBytes(bytes.toByteArray())
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = reconnect()
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onStatus("relay: corrections link error (${t.message}), reconnecting")
                    reconnect()
                }
            })
        }

        private fun reconnect() {
            if (stopped) return
            Thread {
                Thread.sleep(3000)
                if (!stopped) connect()
            }.also { it.isDaemon = true; it.start() }
        }

        fun stop() {
            stopped = true
            try { socket?.close(1000, null) } catch (e: Exception) { }
        }
    }
}
