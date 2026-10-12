const $ = (id) => document.getElementById(id);

const SERVER_KEY = "gnss_server_url";
const DEFAULT_BACKEND = "https://gnss-relay.onrender.com";

function loadServerUrl() {
  try { return localStorage.getItem(SERVER_KEY) || DEFAULT_BACKEND; } catch (e) { return DEFAULT_BACKEND; }
}

let serverUrl = normalizeRelayUrl(loadServerUrl());
$("serverUrl").value = serverUrl;

let relayCheckSeq = 0;
let relayCheckAbort = null;

async function checkRelay() {
  const seq = ++relayCheckSeq;
  if (relayCheckAbort) relayCheckAbort.abort();
  const ctl = new AbortController();
  relayCheckAbort = ctl;
  const el = $("relayHealth");
  el.className = "status";
  el.textContent = "checking relay... (a sleeping free-tier relay can take up to a minute to wake)";
  const url = normalizeRelayUrl(serverUrl);
  const t = setTimeout(() => ctl.abort(), 75000);
  const t0 = Date.now();
  let msg, isErr = false;
  try {
    const r = await fetch(url + "/healthz", { cache: "no-store", signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const h = await r.json();
    msg = `relay reachable: ${url}  (version ${h.version}${h.commit ? " / " + h.commit : ""}, ` +
      `answered in ${Date.now() - t0} ms, active channels=${h.channels})`;
  } catch (e) {
    isErr = true;
    msg = `relay NOT reachable at ${url}: ${e.name === "AbortError" ? "no answer in 75 s" : e.message}`;
  } finally {
    clearTimeout(t);
  }
  if (seq !== relayCheckSeq) return; // a newer check (address changed) owns the display
  el.className = isErr ? "status err" : "status";
  el.textContent = msg;
}

$("serverConnect").onclick = () => {
  serverUrl = normalizeRelayUrl($("serverUrl").value);
  $("serverUrl").value = serverUrl;
  try { localStorage.setItem(SERVER_KEY, serverUrl); } catch (e) { /* private mode - still used for this tab */ }
  checkRelay();
};
checkRelay();

function setBadge(prefix, text, kind) {
  const badge = $(prefix + "Badge");
  if (!badge) return;
  badge.textContent = text || "idle";
  badge.className = "badge" + (kind ? " " + kind : "");
}

function setStatus(prefix, text, isErr) {
  const el = $(prefix + "Status");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

// Keep the screen (and with it USB + network) awake while a session runs.
let wakeLock = null;
const activeSessions = new Set();
async function syncWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (activeSessions.size && !wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!activeSessions.size && wakeLock) {
      const w = wakeLock;
      wakeLock = null;
      await w.release();
    }
  } catch (e) { /* denied or tab hidden - harmless */ }
}
function holdWake(name, on) {
  if (on) activeSessions.add(name); else activeSessions.delete(name);
  syncWakeLock();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncWakeLock(); });

const hex4 = (n) => (n == null ? "????" : n.toString(16).padStart(4, "0"));
const ago = (ms) => (ms ? `${((Date.now() - ms) / 1000).toFixed(1)}s ago` : "never");

function usbLine(conn) {
  const info = conn.port.getInfo ? conn.port.getInfo() : {};
  return `USB: ${conn.alive ? "connected" : "DISCONNECTED"}  ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}  ` +
    `${conn.baud} baud  receiver=${conn.monVer ? conn.monVer.summary : "?"}`;
}

function fixLine(pvt) {
  if (!pvt) return "FIX: no position message from the receiver in the last few seconds";
  return `FIX=${pvt.carrSoln === 2}  ${Ubx.CARR_SOLN[pvt.carrSoln]}  corrections used=${pvt.diffSoln}  ` +
    `fixType=${Ubx.FIX_TYPE[pvt.fixType] ?? pvt.fixType}  sv=${pvt.numSv}  ` +
    `hAcc=${pvt.hAccM.toFixed(3)}m  vAcc=${pvt.vAccM.toFixed(3)}m`;
}

function fixBadge(prefix, pvt) {
  if (!pvt) setBadge(prefix, "no data", "bad");
  else if (pvt.carrSoln === 2) setBadge(prefix, "FIX=true  RTK FIXED", "live");
  else if (pvt.carrSoln === 1) setBadge(prefix, "FIX=false  RTK FLOAT", "warn");
  else setBadge(prefix, "FIX=false  no RTK", "bad");
}

function failedSteps(cfg) {
  return Object.entries(cfg).filter(([, ok]) => !ok).map(([k]) => k);
}

async function pickAndOpen(otherConn, prefix) {
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    throw new Error(e.name === "NotFoundError" ? "no receiver selected" : e.message);
  }
  if (otherConn && otherConn.alive && otherConn.port === port) {
    throw new Error("that receiver is already connected in the other panel - pick the other one");
  }
  setStatus(prefix, "detecting receiver...");
  try {
    return await SerialGnssConnection.openAuto(port, (b) => setStatus(prefix, `detecting receiver: trying ${b} baud...`));
  } catch (e) {
    if (e.name === "InvalidStateError") throw new Error("that port is already open (other panel or another tab)");
    throw e;
  }
}

function showConnected(prefix, conn) {
  $(prefix + "ConnectedInfo").style.display = "block";
  $(prefix + "ConnectedInfo").textContent = usbLine(conn);
  $(prefix + "Controls").style.display = "block";
  $(prefix + "Connect").textContent = "Reconnect / switch receiver";
}

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", (e) => {
    for (const [conn, prefix] of [[usbConn, "usb"], [baseUsbConn, "baseUsb"]]) {
      if (conn && e.target === conn.port) {
        conn.alive = false;
        $(prefix + "ConnectedInfo").textContent = usbLine(conn) + " - unplugged, reconnect it";
      }
    }
  });
}

// ---------------------------------------------------------------------
// Rover
// ---------------------------------------------------------------------

let usbConn = null;
let usbLink = null;
let usbStopRequested = false;
let usbRunning = false;

function roverBlock(conn, link, channel, pvt, head, warn) {
  const lines = [head, usbLine(conn), fixLine(pvt)];
  if (link) {
    lines.push(link.statsLine());
    lines.push(`RTCM in: ${link.rtcmIn.summary()}  (last valid frame ${ago(link.rtcmIn.lastAt)})`);
    lines.push(channelStatusLine(link.channelStatus, channel, "rover"));
  }
  if (warn) lines.push(warn);
  return lines.join("\n");
}

/** Why a point run collected nothing, from what was actually observed. */
function diagnoseNoFix(framesSeen, bestCarr, link, channel, requireFixed) {
  if (framesSeen === 0) {
    return "no position (NAV-PVT) messages arrived from the receiver during the run, so nothing could be recorded. " +
      "Unplug/replug it and press Reconnect.";
  }
  const cs = link.channelStatus.get();
  const want = requireFixed ? "RTK FIXED" : "RTK FLOAT/FIXED";
  if (link.stats.bytes === 0) {
    let why = `the receiver gave ${framesSeen} fixes, but ZERO correction bytes arrived from the relay, so it could never reach ${want}. `;
    if (cs.ok && cs.data && !cs.data.base_online) why += `No base is broadcasting on channel "${channel}": start the Base and wait for "broadcasting", and check both sides use the same relay channel and relay address.`;
    else if (cs.ok === false) why += `The relay itself didn't answer (${cs.error}).`;
    else why += "The relay shows a base online but nothing reached this rover - check this device's network.";
    return why;
  }
  if (link.rtcmIn.frames === 0) {
    return `${link.stats.bytes} bytes arrived from the relay but none were valid RTCM3, so the base isn't outputting corrections - check the Base panel's "RTCM out" line.`;
  }
  return `corrections ARE arriving (${link.rtcmIn.summary()}), but in ${framesSeen} fixes the best solution was ` +
    `${bestCarr < 0 ? "none" : Ubx.CARR_SOLN[bestCarr]}, never ${want}. Usual causes: obstructed sky at rover or base, ` +
    "baseline too long (>~20 km), or the base survey still poor. Run longer" +
    (requireFixed ? ", or untick FIXED-only to accept FLOAT." : ".");
}

function renderPointResult(el, r) {
  if (r.cancelled) { el.innerHTML = "<i>cancelled</i>"; return; }
  let text = `label: ${r.label}\nlat: ${r.lat_deg.toFixed(9)}\nlon: ${r.lon_deg.toFixed(9)}\n` +
    `height_msl_m: ${r.height_msl_m.toFixed(3)}\nepochs: ${r.n}  spread: ${r.spread_m.toFixed(3)}m  ` +
    `fix=${r.all_fixed}  (fix=true: every averaged epoch was RTK FIXED)`;
  if (r.origin_e !== undefined) {
    text += `\n\norigin_e: ${r.origin_e.toFixed(4)}\norigin_n: ${r.origin_n.toFixed(4)}\norigin_u: ${r.origin_u.toFixed(4)}`;
  }
  const code = document.createElement("code");
  code.textContent = text;
  el.replaceChildren(code);
  if (r.label === "origin") {
    $("originLat").value = r.lat_deg.toFixed(9);
    $("originLon").value = r.lon_deg.toFixed(9);
    $("originAlt").value = r.height_msl_m.toFixed(3);
  }
}

function readOrigin() {
  const vals = [$("originLat").value, $("originLon").value, $("originAlt").value].map((v) => v.trim());
  if (vals.every((v) => v === "")) return null;
  const nums = vals.map(Number);
  if (vals.some((v) => v === "") || nums.some((n) => !Number.isFinite(n))) {
    throw new Error("origin lat/lon/alt must all be numbers (or all empty)");
  }
  return nums;
}

if (!("serial" in navigator)) {
  $("usbUnsupported").style.display = "block";
  $("usbConnectRow").style.display = "none";
} else {
  $("usbConnect").onclick = async () => {
    if (usbRunning) { setStatus("usb", "stop the running session first", true); return; }
    const prev = usbConn;
    usbConn = null;
    $("usbControls").style.display = "none";
    try {
      if (prev) await prev.close();
      usbConn = await pickAndOpen(baseUsbConn, "usb");
      showConnected("usb", usbConn);
      setStatus("usb", `ready\n${usbLine(usbConn)}`);
    } catch (e) {
      setStatus("usb", "connect failed: " + e.message, true);
    }
  };
}

async function usbRunSession(mode) {
  const conn = usbConn;
  if (!conn || !conn.alive) { setStatus("usb", "connect a USB receiver first", true); return; }
  const channel = $("usbChannel").value.trim() || "default";
  const label = $("usbLabel").value.trim() || "point";
  const durationS = parseFloat($("usbDuration").value);
  const requireFixed = $("usbRequireFixed").checked;
  let origin = null;
  try {
    if (mode === "point") {
      if (!(durationS > 0)) throw new Error("duration must be a positive number of seconds");
      if (label !== "origin") origin = readOrigin();
    }
  } catch (e) { setStatus("usb", e.message, true); return; }

  usbStopRequested = false;
  usbRunning = true;
  holdWake("rover", true);
  $("usbStart").disabled = true;
  $("usbMonitor").disabled = true;
  $("usbConnect").disabled = true;
  $("usbStop").disabled = false;
  $("usbResult").replaceChildren();
  setBadge("usb", "configuring", "live");

  let warn = null;
  try {
    const cfg = await conn.configureRover((step) => setStatus("usb", `configuring rover: ${step}...\n${usbLine(conn)}`));
    if (!conn.alive) throw new Error("USB receiver disconnected during setup");
    const failed = failedSteps(cfg);
    if (failed.length) warn = `setup warning: receiver did not acknowledge ${failed.join(", ")}`;
    conn.flushMessages();
    usbLink = startRelayDownload(serverUrl, channel, conn, () => {});

    if (mode === "monitor") {
      while (!usbStopRequested) {
        const pvt = await conn.readNavPvt(2500);
        if (!conn.alive) throw new Error("USB receiver disconnected");
        setStatus("usb", roverBlock(conn, usbLink, channel, pvt, "LIVE MONITOR (nothing recorded)", warn));
        fixBadge("usb", pvt);
      }
      setStatus("usb", roverBlock(conn, usbLink, channel, conn.latestPvt(), "monitor stopped", warn));
    } else {
      const lats = [], lons = [], heights = [];
      let allFixed = true;
      let framesSeen = 0;
      let bestCarr = -1;
      const deadline = Date.now() + durationS * 1000;
      while (Date.now() < deadline && !usbStopRequested) {
        const pvt = await conn.readNavPvt(2500);
        if (!conn.alive) throw new Error("USB receiver disconnected");
        const left = Math.max(0, (deadline - Date.now()) / 1000);
        const head = `SURVEYING "${label}": ${left.toFixed(0)}s left, epochs averaged=${lats.length}` +
          (requireFixed ? " (RTK FIXED only)" : " (RTK FIXED or FLOAT)");
        setStatus("usb", roverBlock(conn, usbLink, channel, pvt, head, warn));
        fixBadge("usb", pvt);
        if (!pvt) continue;
        framesSeen++;
        if (pvt.carrSoln > bestCarr) bestCarr = pvt.carrSoln;
        const usable = pvt.gnssFixOk && (pvt.carrSoln === 2 || (!requireFixed && pvt.carrSoln === 1));
        if (!usable) continue;
        if (pvt.carrSoln !== 2) allFixed = false;
        lats.push(pvt.latDeg); lons.push(pvt.lonDeg); heights.push(pvt.heightMslM);
      }

      if (usbStopRequested) {
        renderPointResult($("usbResult"), { cancelled: true });
        setStatus("usb", "cancelled");
      } else if (!lats.length) {
        throw new Error(diagnoseNoFix(framesSeen, bestCarr, usbLink, channel, requireFixed));
      } else {
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
        const meanLat = mean(lats), meanLon = mean(lons), meanH = mean(heights);
        const mPerDegLat = 111320.0, mPerDegLon = 111320.0 * Math.cos((meanLat * Math.PI) / 180);
        let spread = 0;
        for (let i = 0; i < lats.length; i++) {
          spread = Math.max(spread, Math.hypot((lats[i] - meanLat) * mPerDegLat, (lons[i] - meanLon) * mPerDegLon));
        }
        const result = { label, lat_deg: meanLat, lon_deg: meanLon, height_msl_m: meanH, n: lats.length, spread_m: spread, all_fixed: allFixed };
        if (origin) {
          const [e, n, u] = new Wgs84.LocalFrame(origin[0], origin[1], origin[2]).geodeticToEnu(meanLat, meanLon, meanH);
          result.origin_e = e; result.origin_n = n; result.origin_u = u;
        }
        renderPointResult($("usbResult"), result);
        setStatus("usb", `DONE "${label}": ${lats.length} epochs averaged, fix=${allFixed}\n${usbLine(conn)}`);
      }
    }
  } catch (e) {
    setStatus("usb", "ERROR: " + e.message, true);
  } finally {
    if (usbLink) { usbLink.stop(); usbLink = null; }
    usbRunning = false;
    holdWake("rover", false);
    setBadge("usb", null);
    $("usbStart").disabled = false;
    $("usbMonitor").disabled = false;
    $("usbConnect").disabled = false;
    $("usbStop").disabled = true;
  }
}

$("usbStart").onclick = () => usbRunSession("point");
$("usbMonitor").onclick = () => usbRunSession("monitor");
$("usbStop").onclick = () => { usbStopRequested = true; };

// ---------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------

let baseUsbConn = null;
let baseUsbLink = null;
let baseSurveyStatus = null;
let baseUsbTimer = null;
let baseUsbStopRequested = false;
let baseRunning = false;

function rtcmOutLine(conn) {
  return `RTCM out (from receiver): ${conn.rtcm.summary()}  (last valid frame ${ago(conn.rtcm.lastAt)})`;
}

function receiverLine(conn) {
  const pvt = conn.latestPvt();
  if (!pvt) return "receiver: no position message in the last few seconds";
  return `receiver: fixType=${Ubx.FIX_TYPE[pvt.fixType] ?? pvt.fixType}  sv=${pvt.numSv}  fixOK=${pvt.gnssFixOk}`;
}

function baseCleanup() {
  if (baseUsbTimer) { clearInterval(baseUsbTimer); baseUsbTimer = null; }
  if (baseUsbLink) { baseUsbLink.stop(); baseUsbLink = null; }
  if (baseSurveyStatus) { baseSurveyStatus.stop(); baseSurveyStatus = null; }
  if (baseUsbConn) baseUsbConn.disableRawMode();
  baseRunning = false;
  holdWake("base", false);
  $("baseUsbStart").disabled = false;
  $("baseUsbConnect").disabled = false;
  $("baseUsbStop").disabled = true;
}

if (!("serial" in navigator)) {
  $("baseUsbUnsupported").style.display = "block";
  $("baseUsbConnectRow").style.display = "none";
} else {
  $("baseUsbConnect").onclick = async () => {
    if (baseRunning) { setStatus("baseUsb", "stop the base first", true); return; }
    const prev = baseUsbConn;
    baseUsbConn = null;
    $("baseUsbControls").style.display = "none";
    try {
      if (prev) await prev.close();
      baseUsbConn = await pickAndOpen(usbConn, "baseUsb");
      showConnected("baseUsb", baseUsbConn);
      setStatus("baseUsb", `ready\n${usbLine(baseUsbConn)}`);
    } catch (e) {
      setStatus("baseUsb", "connect failed: " + e.message, true);
    }
  };
}

$("baseUsbStart").onclick = async () => {
  const conn = baseUsbConn;
  if (!conn || !conn.alive) { setStatus("baseUsb", "connect a USB receiver first", true); return; }
  const channel = $("baseUsbChannel").value.trim() || "default";
  const minDur = parseInt($("baseUsbMinDur").value, 10);
  const accLimit = parseFloat($("baseUsbAccLimit").value);
  if (!(minDur > 0) || !(accLimit > 0)) { setStatus("baseUsb", "min duration and accuracy limit must be positive numbers", true); return; }

  baseUsbStopRequested = false;
  baseRunning = true;
  holdWake("base", true);
  $("baseUsbStart").disabled = true;
  $("baseUsbConnect").disabled = true;
  $("baseUsbStop").disabled = false;
  setBadge("baseUsb", "configuring", "live");

  try {
    const cfg = await conn.configureBase(minDur, accLimit, (step) => setStatus("baseUsb", `configuring base: ${step}...\n${usbLine(conn)}`));
    if (!conn.alive) throw new Error("USB receiver disconnected during setup");
    if (!cfg.surveyIn) throw new Error("the receiver refused survey-in (CFG-TMODE3 not acknowledged)");
    const failed = failedSteps(cfg);
    const warn = failed.length ? `setup warning: receiver did not acknowledge ${failed.join(", ")}` : null;
    // Poll the channel during survey-in too: wakes a sleeping relay well
    // before corrections exist, and shows any channel conflict early.
    baseSurveyStatus = startChannelStatus(serverUrl, channel);
    conn.flushMessages();
    setBadge("baseUsb", "surveying", "warn");

    let svin = null;
    let lastSvinAt = Date.now();
    while (!baseUsbStopRequested) {
      const msg = await conn.readMessage(1000);
      if (!conn.alive) throw new Error("USB receiver disconnected");
      if (msg && msg.cls === Ubx.CLS_NAV && msg.id === Ubx.NAV_SVIN && msg.payload.length >= 40) {
        svin = Ubx.parseNavSvin(msg.payload);
        lastSvinAt = Date.now();
      }
      const lines = ["SURVEY-IN (base working out its own position - needs open sky)", usbLine(conn)];
      lines.push(svin
        ? `survey-in: active=${svin.active} valid=${svin.valid}  dur=${svin.durationS}s (min ${minDur}s)  ` +
          `meanAcc=${svin.meanAccM.toFixed(3)}m (target <= ${accLimit.toFixed(3)}m)  obs=${svin.observations}`
        : "survey-in: waiting for the first progress message...");
      if (Date.now() - lastSvinAt > 6000) lines.push(`WARNING: no survey-in progress from the receiver for ${((Date.now() - lastSvinAt) / 1000).toFixed(0)}s`);
      lines.push(receiverLine(conn));
      lines.push(rtcmOutLine(conn) + "  (1005 = base position, appears once survey-in completes)");
      lines.push(channelStatusLine(baseSurveyStatus, channel, "base"));
      if (warn) lines.push(warn);
      setStatus("baseUsb", lines.join("\n"));
      if (svin && svin.valid && !svin.active) break;
    }
    if (baseUsbStopRequested) {
      setStatus("baseUsb", "cancelled during survey-in");
      setBadge("baseUsb", null);
      baseCleanup();
      return;
    }

    baseSurveyStatus.stop();
    baseSurveyStatus = null;
    baseUsbLink = startRelayUpload(serverUrl, channel, conn, () => {});
    const svinFinal = svin;
    const render = () => {
      if (!conn.alive) {
        setStatus("baseUsb", "ERROR: USB receiver disconnected - corrections have STOPPED. Reconnect and start the base again.", true);
        setBadge("baseUsb", "stopped", "bad");
        baseCleanup();
        return;
      }
      const lines = [`BROADCASTING corrections on channel "${channel}"`, usbLine(conn),
        `survey-in result: meanAcc=${svinFinal.meanAccM.toFixed(3)}m after ${svinFinal.durationS}s (${svinFinal.observations} obs)`,
        receiverLine(conn), rtcmOutLine(conn), baseUsbLink.statsLine(),
        channelStatusLine(baseUsbLink.channelStatus, channel, "base")];
      const rtcmAge = conn.rtcm.lastAt ? Date.now() - conn.rtcm.lastAt : Infinity;
      if (rtcmAge > 5000) lines.push("WARNING: the receiver has not output any RTCM for over 5 s - no corrections are being produced");
      if (!baseUsbLink.connected()) lines.push("WARNING: relay link down - reconnecting every 3 s");
      if (warn) lines.push(warn);
      setStatus("baseUsb", lines.join("\n"));
      if (rtcmAge > 5000 || !baseUsbLink.connected()) setBadge("baseUsb", "broadcasting (problem)", "warn");
      else setBadge("baseUsb", "broadcasting", "live");
    };
    render();
    baseUsbTimer = setInterval(render, 1000);
  } catch (e) {
    setStatus("baseUsb", "ERROR: " + e.message, true);
    setBadge("baseUsb", "error", "bad");
    baseCleanup();
  }
};

$("baseUsbStop").onclick = () => {
  baseUsbStopRequested = true;
  if (baseUsbTimer || baseUsbLink) {
    baseCleanup();
    setBadge("baseUsb", null);
    setStatus("baseUsb", "stopped - no longer broadcasting");
  }
};
