// Survey results shared between devices through the relay (server/app.py
// /results/{channel}). Each device keeps its own copy per channel in
// localStorage and re-uploads it on every sync: the free relay forgets
// everything when it sleeps, and newest-`at`-wins makes re-uploading safe.
//
// A result: {lat_deg, lon_deg, height_msl_m, n, spread_m, all_fixed, at, source}
// or a deletion marker {deleted: true, at, source}. `at` is ISO-8601 UTC.
(function () {
  const OLD_KEY = "gnss_survey_results"; // before results were per channel
  const key = (channel) => `gnss_results:${channel}`;
  const LABEL_RE = /^[A-Za-z0-9_.-]{1,40}$/;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  // one-time: results saved before channels existed belong to "default"
  try {
    const old = store.get(OLD_KEY);
    if (old && !store.get(key("default"))) store.set(key("default"), old);
    if (old) localStorage.removeItem(OLD_KEY);
  } catch (e) { /* no storage */ }

  const time = (r) => (r && r.at ? Date.parse(r.at) || 0 : 0);
  /** true if a should replace b */
  const newer = (a, b) => !!a && (!b || time(a) > time(b));

  /** Merges `from` into a copy of `into`, newest per label wins. */
  function merge(into, from) {
    const out = { ...(into || {}) };
    const changed = [];
    for (const [label, r] of Object.entries(from || {})) {
      if (newer(r, out[label])) { out[label] = r; changed.push(label); }
    }
    return { results: out, changed };
  }

  const loadLocal = (channel) => store.get(key(channel)) || {};
  const saveLocal = (channel, results) => store.set(key(channel), results);

  /** Records a result (or deletion) on this device; returns the stored object. */
  function record(channel, label, data, source) {
    const r = { ...data, at: new Date().toISOString(), source: source || "web" };
    const all = loadLocal(channel);
    all[label] = r;
    saveLocal(channel, all);
    return r;
  }

  function url(relay, channel, label) {
    const base = window.normalizeRelayUrl ? window.normalizeRelayUrl(relay) : relay.replace(/\/+$/, "");
    return `${base}/results/${encodeURIComponent(channel)}` + (label ? `/${encodeURIComponent(label)}` : "");
  }

  async function timed(u, opts = {}, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(u, { ...opts, cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "relay didn't answer (waking up?)" : e.message);
    } finally {
      clearTimeout(t);
    }
  }

  /** Pulls the channel's results from the relay, merges them with this
   * device's (plus `extra`, e.g. the Android app's), stores the merge, and
   * uploads every entry the relay is missing or has older. Never throws:
   * {results, changed, pushed, error}. */
  async function sync(relay, channel, extra) {
    let remote = null, error = null, pushed = 0;
    try {
      remote = (await timed(url(relay, channel))).results || {};
    } catch (e) {
      error = e.message;
    }
    // Read this device's copy only now, right before writing it back (no
    // await in between): a result recorded while the request was in flight
    // must not be overwritten by an older snapshot.
    const local = merge(loadLocal(channel), extra || {});
    const m = merge(local.results, remote || {});
    m.changed = [...new Set([...local.changed, ...m.changed])];
    saveLocal(channel, m.results);
    if (remote) {
      for (const [label, r] of Object.entries(m.results)) {
        if (!LABEL_RE.test(label) || !newer(r, remote[label])) continue;
        try {
          await timed(url(relay, channel, label), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
          pushed++;
        } catch (e) { error = `upload of "${label}" failed: ${e.message}`; }
      }
    }
    return { results: m.results, changed: m.changed, pushed, error, reachable: !!remote };
  }

  const Results = { merge, newer, loadLocal, saveLocal, record, sync, LABEL_RE };
  if (typeof module !== "undefined") module.exports = Results;
  if (typeof window !== "undefined") window.Results = Results;
})();
