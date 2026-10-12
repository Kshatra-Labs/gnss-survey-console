const $ = (id) => document.getElementById(id);

const SERVER_KEY = "gnss_server_url";
// This project's own known-stable relay address - autofilled so the page
// works with zero typing for the common case. The backend behind this URL
// is a pure byte relay (server/app.py's /ws/relay/{channel}) with no
// USB/serial access of its own; all GNSS work happens in this browser.
const DEFAULT_BACKEND = "https://gnss-relay.onrender.com";

let serverUrl = localStorage.getItem(SERVER_KEY) || DEFAULT_BACKEND;

$("serverUrl").value = serverUrl;
$("serverConnect").onclick = () => {
  serverUrl = $("serverUrl").value.trim();
  localStorage.setItem(SERVER_KEY, serverUrl);
};

function setBadge(prefix, state, isError) {
  const badge = $(prefix + "Badge");
  if (!badge) return;
  if (isError) { badge.textContent = "error"; badge.className = "badge"; badge.style.color = "var(--bad)"; badge.style.borderColor = "var(--bad)"; return; }
  badge.style.color = ""; badge.style.borderColor = "";
  if (!state) { badge.textContent = "idle"; badge.className = "badge"; }
  else { badge.textContent = state; badge.className = "badge live"; }
}

function renderPointResult(el, r) {
  if (r.cancelled) { el.innerHTML = "<i>cancelled</i>"; return; }
  let text = `label: ${r.label}\nlat: ${r.lat_deg.toFixed(8)}\nlon: ${r.lon_deg.toFixed(8)}\nheight_msl_m: ${r.height_msl_m.toFixed(3)}\nepochs: ${r.n}  spread: ${r.spread_m.toFixed(3)}m  fix=${r.all_fixed}  (fix=true means every collected epoch was RTK FIXED)`;
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

// ---------------------------------------------------------------------
// Rover (Web Serial, this device): reads the USB receiver directly and
// pulls corrections from the cloud relay channel.
// ---------------------------------------------------------------------

let usbConn = null;
let usbCorrBridge = null;
let usbStopRequested = false;

function usbSetStatus(text, isErr) {
  const el = $("usbStatus");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function usbSetBadge(state, isErr) { setBadge("usb", state, isErr); }

/** Builds the multi-line "clearly labeled stats" block shown in every
 * connected rover status - relay link health (bytes actually flowing, how
 * long ago) and the receiver's own fix stats (FIX=true/false is the carrier
 * solution reaching RTK FIXED, not just "has a position"). */
function roverStatsBlock(bridge, pvt) {
  const lines = [];
  if (bridge) {
    const s = bridge.stats();
    const age = s.ageS === null ? "never" : `${s.ageS.toFixed(1)}s ago`;
    lines.push(`relay: ${bridge.connected() ? "connected" : "reconnecting"}  bytes=${s.bytes}  last=${age}`);
  }
  if (pvt) {
    lines.push(`FIX=${pvt.carrSoln === 2}  (${Ubx.CARR_SOLN[pvt.carrSoln] ?? "?"}, fixType=${Ubx.FIX_TYPE[pvt.fixType] ?? pvt.fixType})  sv=${pvt.numSv}  hAcc=${pvt.hAccM.toFixed(3)}m  vAcc=${pvt.vAccM.toFixed(3)}m`);
  } else {
    lines.push("FIX: no NAV-PVT received yet");
  }
  return lines.join("\n");
}

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

    const channel = $("usbChannel").value.trim() || "default";
    usbCorrBridge = startRelayDownload(serverUrl || location.origin, channel, usbConn, (m) => usbSetStatus(m));

    if (mode === "monitor") {
      usbSetBadge("streaming", false);
      while (!usbStopRequested) {
        const pvt = await usbConn.readNavPvt(3000);
        usbSetStatus(roverStatsBlock(usbCorrBridge, pvt));
      }
    } else {
      const label = $("usbLabel").value || "point";
      const durationS = parseFloat($("usbDuration").value) || 60;
      const requireFixed = $("usbRequireFixed").checked;
      usbSetBadge("averaging", false);
      const lats = [], lons = [], heights = [];
      let allFixed = true;
      let framesSeen = 0;
      let bestCarrSoln = -1; // -1 = never saw a NAV-PVT at all
      const deadline = Date.now() + durationS * 1000;
      while (Date.now() < deadline && !usbStopRequested) {
        const remaining = Math.max(0, (deadline - Date.now()) / 1000);
        const pvt = await usbConn.readNavPvt(3000);
        usbSetStatus(`[${remaining.toFixed(1)}s left] collected=${lats.length}\n${roverStatsBlock(usbCorrBridge, pvt)}`);
        if (!pvt) continue;
        framesSeen++;
        if (pvt.carrSoln > bestCarrSoln) bestCarrSoln = pvt.carrSoln;
        if (pvt.carrSoln !== 2) {
          allFixed = false;
          if (requireFixed) continue;
        }
        lats.push(pvt.latDeg); lons.push(pvt.lonDeg); heights.push(pvt.heightMslM);
      }

      if (usbStopRequested) {
        $("usbResult").innerHTML = "<i>cancelled</i>";
      } else if (!lats.length && framesSeen === 0) {
        usbSetStatus("no NAV-PVT messages received at all - receiver isn't talking UBX over this port " +
          "(check baud/wiring; this is NOT a corrections problem, nothing GNSS-related was ever read)", true);
      } else if (!lats.length) {
        const bridgeStats = usbCorrBridge ? usbCorrBridge.stats() : null;
        const bytesNote = bridgeStats ? ` relay bytes received=${bridgeStats.bytes}` : "";
        usbSetStatus(`received ${framesSeen} fixes but corrections never reached RTK FIXED ` +
          `(best carrier solution seen: ${Ubx.CARR_SOLN[bestCarrSoln] ?? "none"}).${bytesNote} ` +
          (bridgeStats && bridgeStats.bytes === 0
            ? "Zero correction bytes arrived from the relay - check the Base is actually broadcasting and both sides use the same relay channel."
            : "Correction bytes are arriving but the fix never upgraded - check baseline distance and that the Base's own position is valid."), true);
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
        renderPointResult($("usbResult"), result);
        usbSetStatus("done");
      }
    }
  } catch (e) {
    usbSetStatus("ERROR: " + e.message, true);
  } finally {
    if (usbCorrBridge) { usbCorrBridge.stop(); usbCorrBridge = null; }
    usbSetBadge(null, false);
    $("usbStart").disabled = false;
    $("usbMonitor").disabled = false;
    $("usbStop").disabled = true;
  }
}

$("usbStart").onclick = () => usbRunSession("point");
$("usbMonitor").onclick = () => usbRunSession("monitor");
$("usbStop").onclick = () => { usbStopRequested = true; };

// ---------------------------------------------------------------------
// Base (Web Serial, this device): survey-in + RTCM3 output entirely in
// the browser, then uploads corrections to the cloud relay. The relay
// itself (server/app.py's /ws/relay) has no USB/serial dependency, so it's
// the one piece of this system that could genuinely run on ordinary free
// cloud compute instead of a machine wired to the GPS hardware.
// ---------------------------------------------------------------------

let baseUsbConn = null;
let baseUsbUpload = null;
let baseUsbStopRequested = false;
let baseUsbStatsTimer = null;

function baseUsbSetStatus(text, isErr) {
  const el = $("baseUsbStatus");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}
function baseUsbSetBadge(state, isErr) { setBadge("baseUsb", state, isErr); }

if (!("serial" in navigator)) {
  $("baseUsbUnsupported").style.display = "block";
  $("baseUsbConnectRow").style.display = "none";
} else {
  $("baseUsbConnect").onclick = async () => {
    try {
      const port = await navigator.serial.requestPort();
      const info = port.getInfo();
      baseUsbConn = new SerialGnssConnection(port);
      await baseUsbConn.open(115200);
      $("baseUsbConnectedInfo").style.display = "block";
      $("baseUsbConnectedInfo").textContent = `connected (VID ${info.usbVendorId?.toString(16) ?? "?"} PID ${info.usbProductId?.toString(16) ?? "?"})`;
      $("baseUsbControls").style.display = "block";
      $("baseUsbConnect").textContent = "Reconnect USB receiver";
      baseUsbSetStatus("ready");
    } catch (e) {
      baseUsbSetStatus("connect failed: " + e.message, true);
    }
  };
}

$("baseUsbStart").onclick = async () => {
  if (!baseUsbConn) { baseUsbSetStatus("connect a USB receiver first", true); return; }
  baseUsbStopRequested = false;
  $("baseUsbStart").disabled = true;
  $("baseUsbStop").disabled = false;
  baseUsbSetBadge("configuring", false);

  try {
    baseUsbSetStatus("configuring base...");
    const okOut = await baseUsbConn.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_SVIN, 1);
    const rtcmOk = await baseUsbConn.enableRtcmBaseOutput();
    if (!okOut || Object.values(rtcmOk).some((v) => !v)) {
      baseUsbSetStatus(`warning: some output messages failed: ${JSON.stringify(rtcmOk)}`);
    }

    const minDur = parseInt($("baseUsbMinDur").value, 10) || 60;
    const accLimit = parseFloat($("baseUsbAccLimit").value) || 2.0;
    const ok = await baseUsbConn.configureSurveyIn(minDur, accLimit);
    if (!ok) throw new Error("survey-in config rejected by receiver");

    baseUsbSetBadge("surveying", false);
    let svin = null;
    while (!baseUsbStopRequested) {
      svin = await baseUsbConn.readNavSvin(3000);
      if (!svin) { baseUsbSetStatus("...no NAV-SVIN yet"); continue; }
      baseUsbSetStatus(`dur=${svin.durationS}s meanAcc=${svin.meanAccM.toFixed(3)}m obs=${svin.observations} valid=${svin.valid} active=${svin.active}`);
      if (svin.valid && !svin.active) break;
    }
    if (baseUsbStopRequested) { baseUsbSetStatus("cancelled"); return; }

    const channel = $("baseUsbChannel").value.trim() || "default";
    baseUsbSetBadge("broadcasting", false);
    baseUsbUpload = startRelayUpload(serverUrl || location.origin, channel, baseUsbConn, (m) => baseUsbSetStatus(m));

    const svinFinal = svin;
    baseUsbStatsTimer = setInterval(() => {
      if (!baseUsbUpload) return;
      const s = baseUsbUpload.stats();
      const age = s.ageS === null ? "never" : `${s.ageS.toFixed(1)}s ago`;
      baseUsbSetStatus(
        `broadcasting on relay channel "${channel}"  meanAcc=${svinFinal.meanAccM.toFixed(3)}m\n` +
        `relay: ${baseUsbUpload.connected() ? "connected" : "reconnecting"}  bytes sent=${s.bytes}  last=${age}`
      );
    }, 2000);
  } catch (e) {
    baseUsbSetStatus("ERROR: " + e.message, true);
  } finally {
    if (baseUsbStopRequested || !baseUsbUpload) {
      baseUsbSetBadge(null, false);
      $("baseUsbStart").disabled = false;
      $("baseUsbStop").disabled = true;
    }
  }
};

$("baseUsbStop").onclick = () => {
  baseUsbStopRequested = true;
  if (baseUsbStatsTimer) { clearInterval(baseUsbStatsTimer); baseUsbStatsTimer = null; }
  if (baseUsbUpload) { baseUsbUpload.stop(); baseUsbUpload = null; }
  baseUsbSetBadge(null, false);
  baseUsbSetStatus("stopped");
  $("baseUsbStart").disabled = false;
  $("baseUsbStop").disabled = true;
};
