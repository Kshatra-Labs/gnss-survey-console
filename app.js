const $ = (id) => document.getElementById(id);

const FINAL_STATES = new Set(["done", "error", "closed"]);
const SERVER_KEY = "gnss_server_url";

// This page can now be hosted anywhere (e.g. GitHub Pages) separately from
// the backend, which has to run on a machine physically wired to the GPS
// receivers. serverUrl is that backend's address - entered once, saved in
// this browser's localStorage. Empty means "same origin as this page"
// (still works if you're running the server locally and opening it directly).
let serverUrl = localStorage.getItem(SERVER_KEY) || "";

function apiUrl(path) {
  return serverUrl ? serverUrl.replace(/\/$/, "") + path : path;
}

function wsUrl(path) {
  if (serverUrl) {
    return serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + path;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function setConnected(ok, message) {
  const el = $("serverStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("err", !ok);
}

async function refreshPorts() {
  try {
    const res = await fetch(apiUrl("/api/ports"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    $("portsList").textContent = data.ports.length ? data.ports.join("\n") : "(none found)";
    for (const sel of [$("basePort"), $("roverPort"), $("pointPort")]) {
      const prev = sel.value;
      sel.innerHTML = "";
      for (const p of data.ports) {
        const opt = document.createElement("option");
        opt.value = p; opt.textContent = p;
        sel.appendChild(opt);
      }
      if (data.ports.includes(prev)) sel.value = prev;
    }
    setConnected(true, `connected - ${data.ports.length} port(s) found`);
    return true;
  } catch (e) {
    $("portsList").textContent = "-";
    setConnected(false, `Can't reach server${serverUrl ? " at " + serverUrl : ""}: ${e.message}`);
    return false;
  }
}
$("refreshPorts").onclick = refreshPorts;

$("serverConnect").onclick = async () => {
  serverUrl = $("serverUrl").value.trim();
  localStorage.setItem(SERVER_KEY, serverUrl);
  const ok = await refreshPorts();
  if (ok) resumeSessions();
};

function fmtStatus(kind, s) {
  if (!s) return "idle";
  if (s.error) return "ERROR: " + s.error;
  const lines = [];
  lines.push("state: " + (s.state || "?"));
  if (kind === "base") {
    if (s.duration_s !== undefined) lines.push(`dur=${s.duration_s}s  meanAcc=${s.mean_acc_m}m  obs=${s.observations}  valid=${s.valid}  active=${s.active}`);
    if (s.relay_port) lines.push(`broadcasting corrections on :${s.relay_port} - rover can now use this`);
    if (s.warning) lines.push("warning: " + s.warning);
  } else if (kind === "rover") {
    if (s.carr_soln_str) lines.push(`${s.carr_soln_str}  sv=${s.num_sv}  hAcc=${(s.h_acc_m ?? 0).toFixed?.(3) ?? s.h_acc_m}m`);
    if (s.lat_deg !== undefined) lines.push(`lat=${s.lat_deg.toFixed(8)} lon=${s.lon_deg.toFixed(8)} h=${s.height_msl_m.toFixed(3)}m`);
  } else if (kind === "point") {
    if (s.remaining_s !== undefined) lines.push(`[${s.remaining_s}s left] ${s.carr_soln_str || ""}  sv=${s.num_sv}  collected=${s.n_collected}`);
  }
  return lines.join("\n");
}

function setBadge(prefix, state, isError) {
  const badge = $(prefix + "Badge");
  if (!badge) return;
  if (isError) { badge.textContent = "error"; badge.className = "badge"; badge.style.color = "var(--bad)"; badge.style.borderColor = "var(--bad)"; return; }
  badge.style.color = ""; badge.style.borderColor = "";
  if (!state || FINAL_STATES.has(state)) { badge.textContent = "idle"; badge.className = "badge"; }
  else { badge.textContent = state; badge.className = "badge live"; }
}

function connect(sessionId, kind, prefix, statusEl, onDone) {
  const ws = new WebSocket(wsUrl(`/ws/session/${sessionId}`));
  ws.onmessage = (ev) => {
    const s = JSON.parse(ev.data);
    statusEl.textContent = fmtStatus(kind, s);
    statusEl.classList.toggle("err", !!s.error);
    setBadge(prefix, s.state, !!s.error);
    if (FINAL_STATES.has(s.state)) onDone(s);
  };
  ws.onerror = () => { statusEl.textContent += "\n(websocket error)"; };
  return ws;
}

function wireRunner(prefix, kind, buildBody) {
  const startBtn = $(prefix + "Start");
  const stopBtn = $(prefix + "Stop");
  const statusEl = $(prefix + "Status");
  let sessionId = null;

  function attach(id, resuming) {
    sessionId = id;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (!resuming) statusEl.textContent = "starting...";
    connect(id, kind, prefix, statusEl, (final) => {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      sessionId = null;
      if (kind === "point" && final.result) renderPointResult(final.result);
    });
  }

  startBtn.onclick = async () => {
    const body = buildBody();
    const res = await fetch(apiUrl(`/api/${kind}/start`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.text();
      statusEl.textContent = res.status === 409
        ? "Can't start: " + JSON.parse(msg).detail
        : "start failed: " + msg;
      statusEl.classList.add("err");
      return;
    }
    statusEl.classList.remove("err");
    const data = await res.json();
    attach(data.session_id, false);
  };

  stopBtn.onclick = async () => {
    if (!sessionId) return;
    await fetch(apiUrl(`/api/session/${sessionId}/stop`), { method: "POST" });
    stopBtn.disabled = true;
  };

  return { attach };
}

function renderPointResult(r) {
  const el = $("pointResult");
  if (r.cancelled) { el.innerHTML = "<i>cancelled</i>"; return; }
  let text = `label: ${r.label}\nlat: ${r.lat_deg.toFixed(8)}\nlon: ${r.lon_deg.toFixed(8)}\nheight_msl_m: ${r.height_msl_m.toFixed(3)}\nepochs: ${r.n}  spread: ${r.spread_m.toFixed(3)}m  all_fixed: ${r.all_fixed}`;
  if (r.origin_e !== undefined) {
    text += `\n\norigin_e: ${r.origin_e.toFixed(4)}\norigin_n: ${r.origin_n.toFixed(4)}\norigin_u: ${r.origin_u.toFixed(4)}`;
  }
  el.innerHTML = `<code>${text}</code>`;
  if (r.label === "origin") {
    $("originLat").value = r.lat_deg.toFixed(8);
    $("originLon").value = r.lon_deg.toFixed(8);
    $("originAlt").value = r.height_msl_m.toFixed(3);
  }
}

const baseRunner = wireRunner("base", "base", () => ({
  port: $("basePort").value,
  baud: parseInt($("baseBaud").value, 10),
  min_duration: parseInt($("baseMinDur").value, 10),
  acc_limit: parseFloat($("baseAccLimit").value),
  relay_port: parseInt($("baseRelayPort").value, 10),
}));

const roverRunner = wireRunner("rover", "rover", () => {
  const corr = $("roverCorr").value.trim();
  const [host, port] = corr ? corr.split(":") : [null, null];
  return {
    port: $("roverPort").value,
    baud: parseInt($("roverBaud").value, 10),
    corrections_host: host || null,
    corrections_port: port ? parseInt(port, 10) : null,
  };
});

const pointRunner = wireRunner("point", "point", () => {
  const corr = $("pointCorr").value.trim();
  const [host, port] = corr ? corr.split(":") : [null, null];
  const oLat = $("originLat").value, oLon = $("originLon").value, oAlt = $("originAlt").value;
  const origin = (oLat && oLon && oAlt) ? { lat_deg: parseFloat(oLat), lon_deg: parseFloat(oLon), alt_m: parseFloat(oAlt) } : null;
  return {
    port: $("pointPort").value,
    baud: parseInt($("pointBaud").value, 10),
    corrections_host: host || null,
    corrections_port: port ? parseInt(port, 10) : null,
    label: $("pointLabel").value || "point",
    duration_s: parseFloat($("pointDuration").value),
    require_fixed: $("pointRequireFixed").checked,
    origin,
  };
});

// Reconcile with the server on load: a session started before a page
// refresh keeps running in the background, so re-attach to it instead of
// letting the page think everything is idle (and instead of letting the
// user accidentally start a second session on the same port).
async function resumeSessions() {
  const res = await fetch(apiUrl("/api/sessions"));
  const data = await res.json();
  const runners = { base: baseRunner, rover: roverRunner, point: pointRunner };
  for (const s of data.sessions) {
    if (FINAL_STATES.has(s.status.state)) continue;
    const runner = runners[s.kind];
    if (!runner) continue;
    const statusEl = $(s.kind + "Status");
    statusEl.textContent = fmtStatus(s.kind, s.status) + "\n(resumed after page reload)";
    runner.attach(s.id, true);
  }
}

$("serverUrl").value = serverUrl;
if (serverUrl) {
  refreshPorts().then((ok) => { if (ok) resumeSessions(); });
} else {
  setConnected(false, "enter the backend server's address above and tap Connect");
}
