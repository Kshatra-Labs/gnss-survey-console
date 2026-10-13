// End-to-end test of the real web page (index.html + its scripts, served by
// the real relay process) in jsdom, with simulated F9P receivers behind a
// mock Web Serial API. Drives every flow and fault through the actual DOM.
//
//   NODE_PATH=<dir with jsdom> node tests/web/e2e.js            # local relay
//   NODE_PATH=... node tests/web/e2e.js --page https://... --relay https://...   # deployed
"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const assert = require("node:assert/strict");
const { JSDOM, ResourceLoader } = require("jsdom");
const SiteCalc = require("../../web/sitecalc.js");
const { F9pSim, MockSerialPort, MockSerial } = require("./f9p_sim.js");

const ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (m) => console.log(`[${String(++step).padStart(2, "0")}] ${m}`);

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function startRelay(port) {
  const proc = spawn("python3", [path.join(ROOT, "server", "app.py"), "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/healthz")).ok) return { url, proc }; } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("relay did not start");
}

function stopRelay(r) { return new Promise((res) => { r.proc.once("exit", res); r.proc.kill("SIGTERM"); }); }

// Only the page's own files load; CDN scripts (Leaflet on the Site map) are
// blocked, which also exercises the page's offline fallback.
class SameOriginLoader extends ResourceLoader {
  constructor(origin) { super(); this.origin = origin; }
  fetch(url, options) { return url.startsWith(this.origin) ? super.fetch(url, options) : null; }
}

async function loadPage(pageUrl, opts = {}) {
  const serial = new MockSerial();
  const dom = await JSDOM.fromURL(pageUrl, {
    runScripts: "dangerously",
    resources: new SameOriginLoader(new URL(pageUrl).origin),
    pretendToBeVisual: true,
    beforeParse(win) {
      Object.defineProperty(win.navigator, "serial", { value: serial, configurable: true });
      win.BroadcastChannel = BroadcastChannel; // Node's: shared by every page in this process, like tabs of one browser
      for (const [k, v] of Object.entries(opts.storage || {})) win.localStorage.setItem(k, v);
      win.fetch = (u, o = {}) => fetch(u, { ...o, signal: undefined });
      win.console.error = (...a) => console.error("  [page error]", ...a);
    },
  });
  await new Promise((r) => (dom.window.document.readyState === "complete" ? r() : dom.window.addEventListener("load", r)));
  const doc = dom.window.document;
  const $ = (id) => doc.getElementById(id);
  return { dom, win: dom.window, doc, $, serial };
}

function snapshot(p) {
  const s = (id) => (p.$(id) ? p.$(id).textContent : "");
  return `\n--- relayHealth ---\n${s("relayHealth")}\n--- base [${s("baseUsbBadge")}] ---\n${s("baseUsbStatus")}\n` +
    `--- rover [${s("usbBadge")}] ---\n${s("usbStatus")}\n--- result ---\n${s("usbResult")}`;
}

async function waitFor(p, fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for: ${what}${snapshot(p)}`);
    await sleep(100);
  }
}

const text = (p, id) => p.$(id).textContent;
const FTDI = { usbVendorId: 0x0403, usbProductId: 0x6015 };
const UBLOX = { usbVendorId: 0x1546, usbProductId: 0x01a9 };

function wgs84EastMeters(latDeg, dLonDeg) {
  const a = 6378137, e2 = 6.69437999014e-3, phi = latDeg * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return N * Math.cos(phi) * dLonDeg * Math.PI / 180;
}

async function connect(p, prefix, port) {
  p.serial.willPick(port);
  p.$(prefix + "Status").textContent = "(test: waiting for connect)";
  p.$(prefix + "Connect").click();
  await waitFor(p, () => /^ready/.test(text(p, prefix + "Status")) || /connect failed/.test(text(p, prefix + "Status")), 15000, `${prefix} connect`);
  return text(p, prefix + "Status");
}

async function main() {
  const external = argVal("--relay");
  let relay = null;
  let relayPort = null;
  if (!external) {
    relayPort = await freePort();
    relay = await startRelay(relayPort);
  }
  const relayUrl = external || relay.url;
  const pageUrl = argVal("--page") || relayUrl + "/";
  console.log(`page: ${pageUrl}\nrelay: ${relayUrl}`);

  const p = await loadPage(pageUrl);
  p.$("serverUrl").value = relayUrl.replace(/^https?:\/\//, "") + "/"; // no scheme + trailing slash: must be normalized
  p.$("serverConnect").click();
  await waitFor(p, () => /relay reachable/.test(text(p, "relayHealth")), 90000, "relay health ok");
  assert.equal(p.$("serverUrl").value, relayUrl);
  log(`relay health: ${text(p, "relayHealth")}`);

  // ---- receivers ----
  const baseSim = new F9pSim({ baud: 38400, seed: 11 });                         // FTDI board at the F9P's UART default
  const roverSim = new F9pSim({ baud: 115200, seed: 12, timeMode: true, rtcmOutOn: true, inProto: 0x03 }); // ex-base, RTCM input off
  const basePort = new MockSerialPort(baseSim, FTDI, p.win);
  const roverPort = new MockSerialPort(roverSim, UBLOX, p.win);

  // connect: no port chosen
  p.$("baseUsbConnect").click();
  await waitFor(p, () => /connect failed: no receiver selected/.test(text(p, "baseUsbStatus")), 5000, "cancelled picker message");
  log("cancelled port picker -> clear message");

  // connect: a device that never answers UBX at any baud
  const deadPort = new MockSerialPort(new F9pSim({ answers: false }), FTDI, p.win);
  await connect(p, "baseUsb", deadPort);
  assert.match(text(p, "baseUsbStatus"), /no u-blox reply at any baud rate/);
  assert.equal(deadPort.isOpen, false, "port left open after failed detection");
  log("non-answering device -> 'no u-blox reply at any baud' and port released");

  // connect base: auto-baud must find 38400
  let st = await connect(p, "baseUsb", basePort);
  assert.match(st, /^ready/, st);
  assert.match(text(p, "baseUsbConnectedInfo"), /0403:6015\s+38400 baud\s+receiver=ZED-F9P HPG 1\.32/);
  assert.deepEqual(basePort.openBauds, [115200, 38400]);
  log(`base auto-baud: tried ${basePort.openBauds.join(" -> ")}; ${text(p, "baseUsbConnectedInfo")}`);

  // rover panel must refuse the base's receiver
  await connect(p, "usb", basePort);
  assert.match(text(p, "usbStatus"), /already connected in the other panel/);
  log("same receiver in both panels -> refused with a clear message");

  st = await connect(p, "usb", roverPort);
  assert.match(st, /^ready/, st);
  assert.match(text(p, "usbConnectedInfo"), /1546:01a9\s+115200 baud/);
  log(`rover connected: ${text(p, "usbConnectedInfo")}`);

  // reconnecting the same panel to the same device must not hit "already open"
  st = await connect(p, "usb", roverPort);
  assert.match(st, /^ready/, st);
  log("reconnect same rover twice -> fine (old connection closed first)");

  // ---- rover with NO base: diagnosis must say so ----
  p.$("usbChannel").value = "nobody-here";
  p.$("usbLabel").value = "probe";
  p.$("usbDuration").value = "4";
  p.$("usbStart").click();
  await waitFor(p, () => /ERROR/.test(text(p, "usbStatus")), 20000, "no-base error");
  assert.match(text(p, "usbStatus"), /ZERO correction bytes/);
  assert.match(text(p, "usbStatus"), /No base is broadcasting on channel "nobody-here"/);
  assert.equal(roverSim.tmode, 0, "rover setup must take the receiver out of time mode");
  assert.ok(roverSim.inProto & 0x20, "rover setup must enable RTCM3 input");
  log(`no base on channel -> ${text(p, "usbStatus").slice(0, 170)}...`);

  // ---- base: survey-in -> broadcasting ----
  p.$("baseUsbChannel").value = "site-a";
  p.$("baseUsbMinDur").value = "5";
  p.$("baseUsbAccLimit").value = "2.0";
  p.$("baseUsbStart").click();
  await waitFor(p, () => /SURVEY-IN/.test(text(p, "baseUsbStatus")) && /active=true valid=false/.test(text(p, "baseUsbStatus")), 15000, "survey-in progress");
  const surveying = text(p, "baseUsbStatus");
  assert.match(surveying, /receiver: fixType=3D\s+sv=24/);
  assert.match(surveying, /RTCM out \(from receiver\): 1074x\d+/);
  log("base surveying:\n      " + surveying.split("\n").join("\n      "));
  await waitFor(p, () => /BROADCASTING/.test(text(p, "baseUsbStatus")) && /base online=true/.test(text(p, "baseUsbStatus")) && /bytes sent=[1-9]/.test(text(p, "baseUsbStatus")), 30000, "broadcasting");
  assert.match(text(p, "baseUsbStatus"), /1005x\d+/);
  assert.match(text(p, "baseUsbStatus"), /receiver: fixType=time only/);
  assert.equal(text(p, "baseUsbBadge"), "broadcasting");
  log("base broadcasting:\n      " + text(p, "baseUsbStatus").split("\n").join("\n      "));

  // ---- rover live monitor reaches FIX=true ----
  p.$("usbChannel").value = "site-a";
  p.$("usbMonitor").click();
  await waitFor(p, () => /FIX=true\s+RTK FIXED/.test(text(p, "usbStatus")), 30000, "monitor FIX=true");
  assert.match(text(p, "usbStatus"), /corrections used=true/);
  assert.match(text(p, "usbStatus"), /RTCM in: 1005x\d+ 1074x\d+ 1084x\d+ 1094x\d+ 1124x\d+ 1230x\d+/);
  await waitFor(p, () => /base online=true\s+rovers=1/.test(text(p, "usbStatus")), 10000, "rover sees itself counted on the channel");
  assert.match(text(p, "usbBadge"), /FIX=true/);
  await waitFor(p, () => /rovers=1/.test(text(p, "baseUsbStatus")), 15000, "base sees 1 rover");
  assert.equal(roverSim.stats.nmeaIn, 0, "base NMEA leaked through the relay into the rover's input");
  assert.ok(roverSim.stats.rtcmInFrames > 0);
  log(`rover input received ${roverSim.stats.rtcmInFrames} RTCM3 frames and 0 NMEA sentences (RTCM-only relay)`);
  log("rover monitor:\n      " + text(p, "usbStatus").split("\n").join("\n      "));

  // non-fatal serial read error mid-session: must keep going
  roverPort.injectOverrun();
  await sleep(1500);
  roverSim.corrLastAt = 0; roverSim.rtkEpochs = 0;
  await waitFor(p, () => /FIX=true/.test(text(p, "usbStatus")) && /last=0\.\ds ago/.test(text(p, "usbStatus")), 20000, "FIX=true after buffer overrun");
  log("BufferOverrunError injected mid-stream -> reader recovered, FIX=true again");

  // relay restart mid-session (only when we own the relay)
  if (relay) {
    await stopRelay(relay);
    await sleep(2500);
    await waitFor(p, () => /connecting\/reconnecting/.test(text(p, "usbStatus")), 15000, "rover notices relay down");
    relay = await startRelay(relayPort);
    await waitFor(p, () => /relay: connected/.test(text(p, "baseUsbStatus")) && /relay: connected/.test(text(p, "usbStatus")), 30000, "both reconnect");
    roverSim.rtkEpochs = 0;
    await waitFor(p, () => /FIX=true/.test(text(p, "usbStatus")) && /base online=true/.test(text(p, "usbStatus")), 30000, "FIX after relay restart");
    log("relay process killed and restarted mid-session -> base and rover reconnected, FIX=true again");
  }

  p.$("usbStop").click();
  await waitFor(p, () => /monitor stopped/.test(text(p, "usbStatus")) && !p.$("usbStart").disabled, 10000, "monitor stops");
  log("monitor stopped cleanly");

  // ---- survey "origin" ----
  p.$("usbLabel").value = "origin";
  p.$("usbDuration").value = "5";
  p.$("usbStart").click();
  await waitFor(p, () => /DONE "origin"/.test(text(p, "usbStatus")) || /ERROR/.test(text(p, "usbStatus")), 30000, "origin survey");
  assert.match(text(p, "usbStatus"), /DONE "origin": \d+ epochs averaged, fix=true/, text(p, "usbStatus"));
  const res = text(p, "usbResult");
  const lat = Number(/lat: ([-\d.]+)/.exec(res)[1]), lon = Number(/lon: ([-\d.]+)/.exec(res)[1]), h = Number(/height_msl_m: ([-\d.]+)/.exec(res)[1]);
  assert.ok(Math.abs(lat - 17.3850123) < 1e-7, `origin lat ${lat}`);
  assert.ok(Math.abs(lon - 78.4867456) < 1e-7, `origin lon ${lon}`);
  assert.ok(Math.abs(h - 540.1) < 0.01, `origin h ${h}`);
  assert.match(res, /fix=true/);
  assert.equal(Number(p.$("originLat").value).toFixed(6), lat.toFixed(6));
  log(`origin surveyed: lat ${lat} lon ${lon} h ${h} (truth 17.3850123 78.4867456 540.1); origin fields auto-filled`);

  // ---- survey a point 10 m east, 2 m north, 0.5 m up ----
  const dLon = 10 / (111320 * Math.cos(17.3850123 * Math.PI / 180));
  const dLat = 2 / 110574;
  roverSim.moveTo(17.3850123 + dLat, 78.4867456 + dLon, 540.6);
  p.$("usbLabel").value = "camera_a";
  p.$("usbStart").click();
  await waitFor(p, () => /DONE "camera_a"/.test(text(p, "usbStatus")) || /ERROR/.test(text(p, "usbStatus")), 30000, "camera_a survey");
  const r2 = text(p, "usbResult");
  const e = Number(/origin_e: ([-\d.]+)/.exec(r2)[1]), n = Number(/origin_n: ([-\d.]+)/.exec(r2)[1]), u = Number(/origin_u: ([-\d.]+)/.exec(r2)[1]);
  const wantE = wgs84EastMeters(17.3850123, dLon);
  assert.ok(Math.abs(e - wantE) < 0.01, `east ${e} vs ${wantE}`);
  assert.ok(Math.abs(n - 2) < 0.02, `north ${n}`);
  assert.ok(Math.abs(u - 0.5) < 0.02, `up ${u}`);
  log(`camera_a offset from origin: e=${e} n=${n} u=${u} (truth e=${wantE.toFixed(4)} n~2 u=0.5)`);

  // ---- survey camera_b, then the Site map page uses all three ----
  const liveSeen = [];
  const listener = new BroadcastChannel("gnss-live");
  listener.onmessage = (ev) => liveSeen.push(ev.data);
  const bLat = 17.3850123 - 5 / 110574, bLon = 78.4867456 + 40 / (111320 * Math.cos(17.3850123 * Math.PI / 180));
  roverSim.moveTo(bLat, bLon, 541.3);
  p.$("usbLabel").value = "camera_b";
  p.$("usbStart").click();
  await waitFor(p, () => /DONE "camera_b"/.test(text(p, "usbStatus")) || /ERROR/.test(text(p, "usbStatus")), 30000, "camera_b survey");
  assert.match(text(p, "usbResult"), /saved as "camera_b" for the Site map/);
  const saved = JSON.parse(p.win.localStorage.getItem("gnss_survey_results"));
  assert.deepEqual(Object.keys(saved).sort(), ["camera_a", "camera_b", "origin"]);
  for (const k of Object.keys(saved)) assert.equal(saved[k].all_fixed, true, k);
  assert.ok(Math.abs(saved.camera_b.lat_deg - bLat) < 2e-7 && Math.abs(saved.camera_b.lon_deg - bLon) < 2e-7, "camera_b saved position");
  assert.ok(liveSeen.length > 0 && liveSeen.every((m) => m.type === "pvt" && Number.isFinite(m.lat)), "console broadcasts live fixes");
  log(`console saved origin/camera_a/camera_b for the Site map and broadcast ${liveSeen.length} live fixes`);

  const sitePage = await loadPage(new URL("site.html", pageUrl).href, { storage: { gnss_survey_results: JSON.stringify(saved) } });
  const s$ = sitePage.$;
  assert.match(s$("mapNote").textContent, /couldn't load/, "no Leaflet -> fallback note, page still works");
  assert.equal(s$("plotView").hidden, false, "no map library -> the exact plot is shown instead");
  assert.match(s$("surveyNote").textContent, /in this browser: origin, camera_a, camera_b/);
  s$("loadSurvey").click();
  const site = {
    origin: { lat: saved.origin.lat_deg, lon: saved.origin.lon_deg, h: saved.origin.height_msl_m },
    poles: Object.fromEntries(["camera_a", "camera_b"].map((k) => [k, { lat: saved[k].lat_deg, lon: saved[k].lon_deg, h: saved[k].height_msl_m, mount: 0 }])),
    plan: null, declinationDeg: null,
  };
  const an = SiteCalc.analyzeSite(site);
  const pairText = s$("pairOut").textContent;
  const shownDist = Number(/Distance\s*([\d.]+) m/.exec(pairText)[1]);
  const shownBear = Number(/Bearing camera_a → camera_b\s*([\d.]+)°/.exec(pairText)[1]);
  assert.ok(Math.abs(shownDist - an.pair.horizM) < 1.5e-3, `distance shown ${shownDist} vs ${an.pair.horizM}`);
  assert.ok(Math.abs(shownBear - an.pair.trueBearingAB) < 2e-3, `bearing shown ${shownBear} vs ${an.pair.trueBearingAB}`);
  const truthDist = Math.hypot(40 - wantE, -5 - 2);
  assert.ok(Math.abs(an.pair.horizM - truthDist) < 0.03, `pole distance ${an.pair.horizM} vs truth ~${truthDist}`);
  // the table row "camera_b  e  n  u ..." (page keeps 0.1 mm, so compare numerically)
  const row = [...s$("pairOut").querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent)).find((r) => r[0] === "camera_b");
  assert.ok(row, "camera_b row in the table");
  row.slice(1, 4).map(Number).forEach((v, i) => assert.ok(Math.abs(v - an.poles.camera_b.enu[i]) < 1e-3, `camera_b origin_e/n/u ${row} vs ${an.poles.camera_b.enu}`));
  assert.equal(s$("plot").querySelectorAll("circle").length, 3, "site plot draws origin + 2 poles");
  log(`Site map: ${an.pair.horizM.toFixed(3)} m at ${an.pair.trueBearingAB.toFixed(3)}° between the poles (truth ~${truthDist.toFixed(3)} m)`);

  // plan + corrections
  s$("planDist").value = "37.5"; s$("planDist").dispatchEvent(new sitePage.win.Event("input"));
  s$("planBearing").value = "100"; s$("planBearing").dispatchEvent(new sitePage.win.Event("input"));
  assert.match(s$("planOut").textContent, /move camera_a: \d+\.\d{3} m towards/);
  assert.match(s$("planOut").textContent, /Distance vs plan/);
  log("plan entered -> per-pole corrections shown");

  // live rover from the console tab, directions to camera_b (where the rover sits)
  p.$("usbMonitor").click();
  s$("target").value = "pole:camera_b"; s$("target").dispatchEvent(new sitePage.win.Event("change"));
  await waitFor(sitePage, () => /FIX=true/.test(s$("liveOut").textContent) && /camera_b \(surveyed\):/.test(s$("liveOut").textContent), 15000, "live rover on the Site map");
  const liveText = s$("liveOut").textContent;
  const off = /camera_b \(surveyed\): (in place|(\d+\.\d+) m)/.exec(liveText);
  assert.ok(off && (off[1] === "in place (< 1 mm)" || Number(off[2]) < 0.02), `rover at camera_b should be ~0 m away:\n${liveText}`);
  log("live rover from the console tab -> " + s$("liveOut").querySelector(".big").textContent);
  p.$("usbStop").click();
  await waitFor(p, () => /monitor stopped/.test(text(p, "usbStatus")) && !p.$("usbStart").disabled, 10000, "monitor stops");
  listener.close();

  // write into a config file
  const yaml = "ground_tracker_node:\n  ros__parameters:\n    local_frame:\n      origin_lat_deg: 0.0\n      origin_lon_deg: 0.0\n      origin_alt_m: 0.0\n" +
    "    pole_distance_m: 50.0\n    camera_ids: [\"camera_a\", \"camera_b\"]\n    camera_a:\n      host: \"x\"\n      origin_e: 0.0\n      origin_n: 0.0\n      origin_u: 0.0   # m\n" +
    "    camera_b:\n      origin_e: 0.0\n      origin_n: 0.0\n      origin_u: 0.0\n";
  s$("cfgPaste").value = yaml;
  s$("cfgUsePaste").click();
  assert.match(s$("cfgMsg").textContent, /pasted text: cameras camera_a, camera_b; pole_distance_m 50; origin not set yet/);
  s$("cfgWrite").click();
  assert.equal(s$("cfgChanges").querySelectorAll("tr.changed").length, 10, "10 survey lines shown as changes");
  assert.equal(s$("cfgSave").hidden, true, "pasted text has no file to save to: Download/Copy only");
  const outYaml = sitePage.win.eval("cfg.pending");
  // same values as computing directly from the saved results (the page keeps 0.1 mm)
  const got = SiteCalc.parseConfig(outYaml);
  assert.equal(got.poleDistanceM, 0);
  assert.ok(Math.abs(got.origin.lat - site.origin.lat) < 1e-8 && Math.abs(got.origin.lon - site.origin.lon) < 1e-8 && Math.abs(got.origin.h - site.origin.h) < 1e-3);
  for (const id of ["camera_a", "camera_b"]) {
    const c = got.cameras[id], want = an.poles[id].enu;
    assert.ok(Math.abs(c.e - want[0]) < 1e-3 && Math.abs(c.n - want[1]) < 1e-3 && Math.abs(c.u - want[2]) < 1e-3, `${id}: ${JSON.stringify(c)} vs ${want}`);
  }
  assert.match(outYaml, /camera_a:\n      host: "x"\n      origin_e: [-\d.]+\n/, "unrelated lines untouched");
  assert.match(outYaml, /origin_u: [-\d.]+  # m\n/, "comments kept");
  log("Site map wrote origin + both poles + pole_distance_m: 0.0 into a pasted config");
  sitePage.win.eval("liveChannel.close()"); // Node's BroadcastChannel outlives a closed jsdom window; a browser tab's doesn't
  sitePage.win.close();

  // ---- FLOAT-only conditions ----
  roverSim.o.maxCarr = 1;
  p.$("usbLabel").value = "float_strict";
  p.$("usbDuration").value = "4";
  p.$("usbStart").click();
  await waitFor(p, () => /ERROR/.test(text(p, "usbStatus")) || /DONE/.test(text(p, "usbStatus")), 30000, "float-only strict");
  assert.match(text(p, "usbStatus"), /corrections ARE arriving .* best solution was RTK FLOAT, never RTK FIXED/s);
  log("corrections arriving but only FLOAT, FIXED-only ticked -> explained, nothing recorded");
  p.$("usbRequireFixed").checked = false;
  p.$("usbLabel").value = "float_ok";
  p.$("usbStart").click();
  await waitFor(p, () => /DONE "float_ok"/.test(text(p, "usbStatus")) || /ERROR/.test(text(p, "usbStatus")), 30000, "float allowed");
  assert.match(text(p, "usbStatus"), /fix=false/);
  assert.match(text(p, "usbResult"), /fix=false/);
  log("FIXED-only unticked -> FLOAT point recorded and clearly marked fix=false");
  roverSim.o.maxCarr = 2;
  p.$("usbRequireFixed").checked = true;

  // ---- base stop / restart (raw-mode regression) ----
  p.$("baseUsbStop").click();
  await waitFor(p, () => /stopped - no longer broadcasting/.test(text(p, "baseUsbStatus")), 5000, "base stop");
  await sleep(1500);
  const sentAfterStop = baseSim.stats.cmds.length;
  p.$("baseUsbStart").click();
  await waitFor(p, () => /BROADCASTING/.test(text(p, "baseUsbStatus")) && /bytes sent=[1-9]/.test(text(p, "baseUsbStatus")), 30000, "base restart broadcasting");
  assert.ok(baseSim.stats.cmds.length > sentAfterStop, "restart must re-configure the receiver");
  log("base stopped and restarted on the same connection -> configured and broadcasting again");

  // ---- unplug rover mid-monitor ----
  p.$("usbMonitor").click();
  await waitFor(p, () => /FIX=/.test(text(p, "usbStatus")), 15000, "monitor running again");
  roverPort.unplug(p.serial);
  await waitFor(p, () => /ERROR: USB receiver disconnected/.test(text(p, "usbStatus")), 10000, "unplug error");
  assert.equal(p.$("usbStart").disabled, false);
  assert.match(text(p, "usbConnectedInfo"), /unplugged/);
  log("rover unplugged mid-monitor -> 'USB receiver disconnected', controls re-enabled");

  // ---- unplug base while broadcasting ----
  basePort.unplug(p.serial);
  await waitFor(p, () => /corrections have STOPPED/.test(text(p, "baseUsbStatus")), 10000, "base unplug error");
  log("base unplugged while broadcasting -> 'corrections have STOPPED', badge stopped");

  console.log("\nALL WEB E2E CHECKS PASSED");
  p.win.close();
  if (relay) await stopRelay(relay);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("\nE2E FAILED:", e.message);
  process.exit(1);
});
