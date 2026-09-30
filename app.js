const $ = (id) => document.getElementById(id);

const FINAL_STATES = new Set(["done", "error", "closed"]);
const SERVER_KEY = "gnss_server_url";
// This project's own known-stable backend address - autofilled so the page
// works with zero typing for the common case (this backend). Only needs to
// be changed if pointing at a different machine.
const DEFAULT_BACKEND = "https://harshill-2.tail14e3a.ts.net";

let serverUrl = localStorage.getItem(SERVER_KEY) || DEFAULT_BACKEND;

function apiUrl(path) {
  return serverUrl ? serverUrl.replace(/\/$/, "") + path : path;
}

function wsUrl(path) {
  const base = serverUrl || location.origin;
  return base.replace(/^http/, "ws").replace(/\/$/, "") + path;
}

function setConnected(ok, message) {
  $("connDot").className = "dot " + (ok ? "ok" : "bad");
  $("connText").textContent = message;
}

async function refreshPorts() {
  try {
    const res = await fetch(apiUrl("/api/ports"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const sel of [$("basePort"), $("roverPort"), $("pointPort")]) {
      const prev = sel.value;
      sel.innerHTML = "";
      for (const p of data.ports) {
        const opt = document.createElement("option");
        opt.value = p; opt.textContent = p;
        sel.appendChild(opt);
      }
      // autofill: keep the previous choice if still valid, else default to
      // the first port found, so nothing needs picking by hand normally
      if (data.ports.includes(prev)) sel.value = prev;
      else if (data.ports.length) sel.value = data.ports[0];
    }
    setConnected(true, `connected to ${serverUrl || "this page's own server"} - ${data.ports.length} port(s) on it`);
    return true;
  } catch (e) {
    setConnected(false, `can't reach backend${serverUrl ? " (" + serverUrl + ")" : ""}: ${e.message}`);
    return false;
  }
}

$("backendToggle").onclick = () => $("backendPanel").classList.toggle("show");
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
      if (kind === "point" && final.result) renderPointResult($("pointResult"), final.result, false);
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

function renderPointResult(el, r, isOrigin) {
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

// Autofill the network-rover corrections fields from the backend + base
// relay port, so they're right without typing unless the setup is unusual.
function autofillCorrections() {
  let host = "localhost";
  try { host = new URL(serverUrl || location.origin).hostname; } catch (e) { /* keep localhost */ }
  const relay = $("baseRelayPort").value || "6000";
  const val = `${host}:${relay}`;
  for (const id of ["pointCorr", "roverCorr"]) {
    const el = $(id);
    if (!el.dataset.touched) el.value = val;
  }
  $("usbCorrHost").value = $("usbCorrHost").dataset.touched ? $("usbCorrHost").value : host;
  $("usbCorrPort").value = $("usbCorrPort").dataset.touched ? $("usbCorrPort").value : relay;
}
for (const id of ["pointCorr", "roverCorr", "usbCorrHost", "usbCorrPort"]) {
  $(id).addEventListener("input", () => { $(id).dataset.touched = "1"; });
}
$("baseRelayPort").addEventListener("input", autofillCorrections);

// Reconcile with the server on load: a session started before a page
// refresh keeps running in the background, so re-attach to it instead of
// letting the page think everything is idle.
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
autofillCorrections();
refreshPorts().then((ok) => { if (ok) resumeSessions(); });

// ---------------------------------------------------------------------
// USB rover (Web Serial) - the primary rover path: this browser talks
// directly to the receiver, only pulling corrections over the network.
// ---------------------------------------------------------------------

let usbConn = null;
let usbCorrBridge = null;
let usbStopRequested = false;
let usbRunning = false;

function usbSetStatus(text, isErr) {
  const el = $("usbStatus");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function usbSetBadge(state, isErr) { setBadge("usb", state, isErr); }

if (!("serial" in navigator)) {
  $("usbUnsupported").style.display = "block";
  $("usbConnectRow").style.display = "none";
} else {
  $("usbConnect").onclick = async () => {
    try {
      const port = await navigator.serial.requestPort();
      const info = port.getInfo();
      usbConn = new SerialGnssConnection(port);
      await usbConn.open(115200);
      $("usbConnectedInfo").style.display = "block";
      $("usbConnectedInfo").textContent = `connected (VID ${info.usbVendorId?.toString(16) ?? "?"} PID ${info.usbProductId?.toString(16) ?? "?"})`;
      $("usbControls").style.display = "block";
      $("usbConnect").textContent = "Reconnect USB receiver";
      usbSetStatus("ready");
    } catch (e) {
      usbSetStatus("connect failed: " + e.message, true);
    }
  };
}

async function usbRunSession(mode) {
  if (!usbConn) { usbSetStatus("connect a USB receiver first", true); return; }
  usbStopRequested = false;
  usbRunning = true;
  $("usbStart").disabled = true;
  $("usbMonitor").disabled = true;
  $("usbStop").disabled = false;
  $("usbResult").innerHTML = "";
  usbSetBadge("configuring", false);

  try {
    usbSetStatus("configuring rover...");
    const okOut = await usbConn.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1);
    const okIn = await usbConn.enableRtcm3Input();
    if (!okOut || !okIn) usbSetStatus(`warning: rover setup incomplete (out=${okOut} in=${okIn})`);

    const corrHost = $("usbCorrHost").value.trim();
    const corrPort = parseInt($("usbCorrPort").value, 10);
    if (corrHost && corrPort) {
      usbCorrBridge = startCorrectionsBridge(serverUrl || location.origin, corrHost, corrPort, usbConn, (m) => usbSetStatus(m));
    }

    if (mode === "monitor") {
      usbSetBadge("streaming", false);
      while (!usbStopRequested) {
        const pvt = await usbConn.readNavPvt(3000);
        if (!pvt) { usbSetStatus("...no fix yet"); continue; }
        usbSetStatus(pvt.statusStr);
      }
    } else {
      const label = $("usbLabel").value || "point";
      const durationS = parseFloat($("usbDuration").value) || 60;
      const requireFixed = $("usbRequireFixed").checked;
      usbSetBadge("averaging", false);
      const lats = [], lons = [], heights = [];
      let allFixed = true;
      const deadline = Date.now() + durationS * 1000;
      while (Date.now() < deadline && !usbStopRequested) {
        const remaining = Math.max(0, (deadline - Date.now()) / 1000);
        const pvt = await usbConn.readNavPvt(3000);
        if (!pvt) { usbSetStatus(`[${remaining.toFixed(1)}s left] ...no fix yet`); continue; }
        usbSetStatus(`[${remaining.toFixed(1)}s left] ${pvt.statusStr} collected=${lats.length}`);
        if (pvt.carrSoln !== 2) {
          allFixed = false;
          if (requireFixed) continue;
        }
        lats.push(pvt.latDeg); lons.push(pvt.lonDeg); heights.push(pvt.heightMslM);
      }

      if (usbStopRequested) {
        $("usbResult").innerHTML = "<i>cancelled</i>";
      } else if (!lats.length) {
        usbSetStatus("no usable fixes collected - corrections never reached RTK FLOAT/FIXED", true);
      } else {
        const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
        const meanH = heights.reduce((a, b) => a + b, 0) / heights.length;
        const mPerDegLat = 111320.0, mPerDegLon = 111320.0 * Math.cos((meanLat * Math.PI) / 180);
        let spread = 0;
        for (let i = 0; i < lats.length; i++) {
          const d = Math.hypot((lats[i] - meanLat) * mPerDegLat, (lons[i] - meanLon) * mPerDegLon);
          if (d > spread) spread = d;
        }
        const result = { label, lat_deg: meanLat, lon_deg: meanLon, height_msl_m: meanH, n: lats.length, spread_m: spread, all_fixed: allFixed };
        const oLat = $("originLat").value, oLon = $("originLon").value, oAlt = $("originAlt").value;
        if (oLat && oLon && oAlt && label !== "origin") {
          const frame = new Wgs84.LocalFrame(parseFloat(oLat), parseFloat(oLon), parseFloat(oAlt));
          const [e, n, u] = frame.geodeticToEnu(meanLat, meanLon, meanH);
          result.origin_e = e; result.origin_n = n; result.origin_u = u;
        }
        renderPointResult($("usbResult"), result, label === "origin");
        usbSetStatus("done");
      }
    }
  } catch (e) {
    usbSetStatus("ERROR: " + e.message, true);
  } finally {
    if (usbCorrBridge) { usbCorrBridge.stop(); usbCorrBridge = null; }
    usbRunning = false;
    usbSetBadge(null, false);
    $("usbStart").disabled = false;
    $("usbMonitor").disabled = false;
    $("usbStop").disabled = true;
  }
}

$("usbStart").onclick = () => usbRunSession("point");
$("usbMonitor").onclick = () => usbRunSession("monitor");
$("usbStop").onclick = () => { usbStopRequested = true; };
