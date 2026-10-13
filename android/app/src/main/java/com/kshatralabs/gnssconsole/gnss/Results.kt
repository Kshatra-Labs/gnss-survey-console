package com.kshatralabs.gnssconsole.gnss

import org.json.JSONObject
import java.time.Instant
import java.time.OffsetDateTime

/** Survey results shared between devices through the relay
 * (server/app.py /results/{channel}) - the same scheme as web/results.js.
 * This phone keeps its own copy per channel and re-uploads it on every sync:
 * the free relay forgets everything when it sleeps, and newest-`at`-wins
 * makes re-uploading safe.
 *
 * A result: {lat_deg, lon_deg, height_msl_m, n, spread_m, all_fixed, at, source}
 * or a deletion marker {deleted: true, at, source}. `at` is ISO-8601 UTC. */
class Results(private val kv: KeyValue) {
    /** Where this phone's copy lives (SharedPreferences in the app, a map in tests). */
    interface KeyValue {
        fun get(key: String): String?
        fun put(key: String, value: String)
        fun keys(): Set<String>
    }

    data class SyncOutcome(val results: JSONObject, val pushed: Int, val error: String?, val reachable: Boolean)

    private fun key(channel: String) = "results:$channel"

    /** Channels this phone holds results for. */
    fun channels(): List<String> = kv.keys().filter { it.startsWith("results:") }.map { it.removePrefix("results:") }

    @Synchronized
    fun load(channel: String): JSONObject = kv.get(key(channel))?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

    @Synchronized
    private fun store(channel: String, all: JSONObject) = kv.put(key(channel), all.toString())

    /** Records a result (or deletion) on this phone; returns the stored object. */
    @Synchronized
    fun record(channel: String, label: String, data: JSONObject, source: String): JSONObject {
        val r = JSONObject(data.toString()).put("at", Instant.now().toString()).put("source", source)
        val all = load(channel)
        all.put(label, r)
        store(channel, all)
        return r
    }

    fun record(channel: String, r: PointResult, source: String = "Android app"): JSONObject = record(
        channel, r.label,
        JSONObject().put("lat_deg", r.latDeg).put("lon_deg", r.lonDeg).put("height_msl_m", r.heightMslM)
            .put("n", r.n).put("spread_m", r.spreadM).put("all_fixed", r.allFixed),
        source,
    )

    /** Pulls the channel from the relay, merges, stores, uploads whatever the
     * relay is missing or has older. Blocking; never throws. */
    fun sync(backendUrl: String, channel: String): SyncOutcome {
        var remote: JSONObject? = null
        var error: String? = null
        try {
            remote = RelayClient.getResults(backendUrl, channel)
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        }
        // read-merge-write in one locked step: a result recorded while the
        // request was in flight is never overwritten by an older snapshot
        val merged = synchronized(this) {
            val m = merge(load(channel), remote ?: JSONObject())
            store(channel, m)
            m
        }
        var pushed = 0
        if (remote != null) {
            for (label in merged.keys()) {
                val r = merged.getJSONObject(label)
                if (!LABEL_RE.matches(label) || !newer(r, remote.optJSONObject(label))) continue
                try {
                    RelayClient.putResult(backendUrl, channel, label, r)
                    pushed++
                } catch (e: Exception) {
                    error = "upload of \"$label\" failed: ${e.message}"
                }
            }
        }
        return SyncOutcome(merged, pushed, error, remote != null)
    }

    companion object {
        val LABEL_RE = Regex("^[A-Za-z0-9_.-]{1,40}$")

        private fun time(r: JSONObject?): Long =
            r?.optString("at")?.takeIf { it.isNotEmpty() }
                ?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() } ?: 0L // "Z" or "+00:00"

        /** true if a should replace b */
        fun newer(a: JSONObject?, b: JSONObject?): Boolean = a != null && (b == null || time(a) > time(b))

        /** `into` with every newer entry of `from`; a new object. */
        fun merge(into: JSONObject, from: JSONObject): JSONObject {
            val out = JSONObject(into.toString())
            for (label in from.keys()) {
                val r = from.optJSONObject(label) ?: continue
                if (newer(r, out.optJSONObject(label))) out.put(label, r)
            }
            return out
        }
    }
}
