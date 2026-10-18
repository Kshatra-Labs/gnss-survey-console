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
 * or a deletion marker {deleted: true, at, source}. `at` is ISO-8601 UTC.
 * Under CLEARED ("*", never a label) the channel's clear {at, source}: every
 * entry up to its `at` is gone, here and on every device it reaches. */
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

    /** Records a result (or deletion) on this phone; returns the stored object.
     * It is newer than any clear this phone knows of - it was made after it,
     * even if this clock is behind the one that cleared. */
    @Synchronized
    fun record(channel: String, label: String, data: JSONObject, source: String): JSONObject {
        val all = load(channel)
        val at = maxOf(Instant.now(), Instant.ofEpochMilli(time(all.optJSONObject(CLEARED)) + 1))
        val r = JSONObject(data.toString()).put("at", at.toString()).put("source", source)
        all.put(label, r)
        store(channel, all)
        return r
    }

    /** Clears the channel on this phone, newer than every entry here; the next
     * sync takes it to the relay and from there to every device. Returns the clear. */
    @Synchronized
    fun clear(channel: String, source: String): JSONObject {
        val all = load(channel)
        val latest = all.keys().asSequence().maxOfOrNull { time(all.optJSONObject(it)) } ?: 0L
        val c = JSONObject().put("at", maxOf(Instant.now(), Instant.ofEpochMilli(latest + 1)).toString()).put("source", source)
        store(channel, prune(all.put(CLEARED, c)))
        return c
    }

    /** Takes in another copy of the channel (the Site map's), newest wins. */
    @Synchronized
    fun adopt(channel: String, from: JSONObject) = store(channel, merge(load(channel), from))

    fun record(channel: String, r: PointResult, source: String = "Android app"): JSONObject = record(
        channel, r.label,
        JSONObject().put("lat_deg", r.latDeg).put("lon_deg", r.lonDeg).put("height_msl_m", r.heightMslM)
            .put("n", r.n).put("spread_m", r.spreadM).put("all_fixed", r.allFixed),
        source,
    )

    /** Pulls the channel from the relay, merges, stores, uploads the clear and
     * whatever the relay is missing or has older. Blocking; never throws. */
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
            val c = merged.optJSONObject(CLEARED)
            if (c != null && newer(c, remote.optJSONObject(CLEARED))) { // first, so the relay drops what it covers
                try {
                    RelayClient.clearResults(backendUrl, channel, c)
                    pushed++
                } catch (e: Exception) {
                    error = "clearing the relay failed: ${e.message}"
                }
            }
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
        const val CLEARED = "*"

        private fun time(r: JSONObject?): Long =
            r?.optString("at")?.takeIf { it.isNotEmpty() }
                ?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() } ?: 0L // "Z" or "+00:00"

        /** true if a should replace b */
        fun newer(a: JSONObject?, b: JSONObject?): Boolean = a != null && (b == null || time(a) > time(b))

        /** `into` with every newer entry of `from`, minus what the clear covers; a new object. */
        fun merge(into: JSONObject, from: JSONObject): JSONObject {
            val out = JSONObject(into.toString())
            for (label in from.keys()) {
                val r = from.optJSONObject(label) ?: continue
                if (newer(r, out.optJSONObject(label))) out.put(label, r)
            }
            return prune(out)
        }

        /** `all` without the entries the channel's clear covers (in place). */
        fun prune(all: JSONObject): JSONObject {
            val c = time(all.optJSONObject(CLEARED) ?: return all)
            for (label in all.keys().asSequence().toList()) {
                if (label != CLEARED && time(all.optJSONObject(label)) <= c) all.remove(label)
            }
            return all
        }

        /** Labels that hold a result: no deletion markers, no clear. */
        fun labels(all: JSONObject): List<String> =
            all.keys().asSequence().filter { LABEL_RE.matches(it) && all.optJSONObject(it)?.optBoolean("deleted") != true }.toList()
    }
}
