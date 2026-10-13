// The Android app's Site map tab on a real Android (emulator or device via
// adb): the installed APK, its WebView with the bundled page, the
// window.AndroidSite bridge, the app's own stored results, the relay, and
// opening/saving a real file through Android's document picker.
//
//   NODE_PATH=<dir with ws> node tests/android/site_in_app.js [--apk PATH] [--shots DIR]
// Needs: adb on PATH or $ANDROID_HOME/platform-tools, one booted device, python3 + server deps.
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const C = require("../../web/sitecalc.js");

const ROOT = path.resolve(__dirname, "..", "..");
const PKG = "com.kshatralabs.gnssconsole";
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APK = argVal("--apk") || path.join(ROOT, "android/app/build/outputs/apk/debug/app-debug.apk");
const SHOTS = argVal("--shots");
const ADB = process.env.ADB || (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools/adb") : "adb");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (m) => console.log(`[${String(++step).padStart(2, "0")}] ${m}`);

const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", maxBuffer: 64 << 20 });
const adbIn = (input, ...a) => execFileSync(ADB, a, { input, encoding: "utf8" });

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(300);
  }
}

/** UI tree via uiautomator; returns nodes {text, desc, res, bounds:[x1,y1,x2,y2]}. */
function uiNodes() {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("shell", "cat", "/sdcard/ui.xml");
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const a = (k) => { const r = new RegExp(`${k}="([^"]*)"`).exec(m[0]); return r ? r[1] : ""; };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a("bounds"));
    nodes.push({ text: a("text"), desc: a("content-desc"), res: a("resource-id"), bounds: b ? b.slice(1).map(Number) : null });
  }
  return nodes;
}
function tapNode(n) { const [x1, y1, x2, y2] = n.bounds; adb("shell", "input", "tap", String((x1 + x2) >> 1), String((y1 + y2) >> 1)); }
async function tapText(re, ms = 15000) {
  const n = await waitFor(() => uiNodes().find((x) => re.test(x.text) || re.test(x.desc)), ms, `UI element ${re}`);
  tapNode(n);
  return n;
}

class Cdp {
  static async attach(port) {
    const pages = await waitFor(async () => {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return l.find((p) => /site\.html/.test(p.url)) && l;
    }, 20000, "the Site map page in the app's WebView");
    const page = pages.find((p) => /site\.html/.test(p.url));
    const c = new Cdp(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { c.ws.once("open", res); c.ws.once("error", rej); });
    return c;
  }
  constructor(u) {
    this.ws = new WebSocket(u, { perMessageDeflate: false });
    this.id = 0; this.pending = new Map();
    this.ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.pending.set(id, r)); }
  async eval(expr) {
    const m = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(m.error.message);
    if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
    return m.result.result.value;
  }
}

const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const prefsXml = (entries) => `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${Object.entries(entries).map(([k, v]) => `    <string name="${xmlEsc(k)}">${xmlEsc(v)}</string>`).join("\n")}\n</map>\n`;

async function main() {
  assert.match(adb("devices"), /\tdevice\b/, "no booted device/emulator for adb");
  const external = argVal("--relay");           // e.g. https://gnss-relay.onrender.com
  const port = await freePort();
  const relay = external ? null : spawn("python3", [path.join(ROOT, "server/app.py"), "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
  const relayHost = external || `http://127.0.0.1:${port}`;
  if (!external) adb("reverse", `tcp:${port}`, `tcp:${port}`); // the device reaches this relay as its own 127.0.0.1
  const relayApp = external || `127.0.0.1:${port}`;             // typed form: the app/page normalize it to http://
  const CH = "app-" + Math.random().toString(36).slice(2, 8);
  let fwd = null;
  try {
    await waitFor(async () => (await fetch(relayHost + "/healthz")).ok, 15000, "relay");

    // a site surveyed elsewhere (web console) is on the relay; one reference point only in the app
    const tpl = fs.readFileSync(path.join(ROOT, "tests/oracle/site_vectors.json"), "utf8");
    const y = JSON.parse(tpl).tracker.yaml;
    const now = () => new Date().toISOString();
    for (const [label, [lat, lon, h]] of [["origin", y.origin], ["camera_a", y.poles.camera_a], ["camera_b", y.poles.camera_b]]) {
      const r = await fetch(`${relayHost}/results/${CH}/${label}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat_deg: lat, lon_deg: lon, height_msl_m: h, n: 60, spread_m: 0.008, all_fixed: true, at: now(), source: "web console" }) });
      assert.ok(r.ok);
    }
    const appOnly = { lat_deg: y.refs[0].geo[0], lon_deg: y.refs[0].geo[1], height_msl_m: y.refs[0].geo[2], n: 30, spread_m: 0.009, all_fixed: true, at: now(), source: "Android app" };

    adb("install", "-r", APK);
    adb("shell", "am", "force-stop", PKG);
    adb("shell", "pm", "clear", PKG);
    adb("shell", "run-as", PKG, "mkdir", "-p", "shared_prefs");
    adbIn(prefsXml({ backend_url: relayApp, channel: CH }), "exec-in", "run-as", PKG, "sh", "-c", "cat > shared_prefs/gnss_console_prefs.xml");
    adbIn(prefsXml({ [`results:${CH}`]: JSON.stringify({ app_mast: appOnly }) }), "exec-in", "run-as", PKG, "sh", "-c", "cat > shared_prefs/gnss_results.xml");
    const tmpl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "site-app-")), "cameras.local.yaml");
    fs.writeFileSync(tmpl, y.template); // the committed template only - never a real cameras.local.yaml
    adb("push", tmpl, "/sdcard/Download/cameras.local.yaml");
    log(`installed ${path.basename(APK)}; relay ${relayHost}${external ? "" : " (adb reverse)"}, channel ${CH}; template pushed to Download/`);

    adb("shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`);
    await tapText(/^Site map$/);
    const pid = (await waitFor(() => adb("shell", "pidof", PKG).trim(), 10000, "app pid"));
    const sock = await waitFor(() => (adb("shell", "cat", "/proc/net/unix").match(new RegExp(`webview_devtools_remote_${pid}`)) || [])[0], 20000, "WebView devtools socket");
    const dport = await freePort();
    adb("forward", `tcp:${dport}`, `localabstract:${sock}`);
    fwd = dport;
    const page = await Cdp.attach(dport);
    log("app open on the Site map tab; attached to its WebView");

    await waitFor(() => page.eval("document.readyState === 'complete' && !!window.AndroidSite && getComputedStyle(document.querySelector('.nav')).display === 'none'"), 20000, "bridge present, web nav not shown in the app");
    await waitFor(() => page.eval(`document.getElementById('channel').value === ${JSON.stringify(CH)} && document.getElementById('pairOut').innerText.includes('Distance')`), 30000, "results from the relay in the app");
    const pair = await page.eval("document.getElementById('pairOut').innerText");
    const site = { origin: { lat: y.origin[0], lon: y.origin[1], h: y.origin[2] }, poles: {}, refs: [], plan: null, declinationDeg: null };
    for (const id of ["camera_a", "camera_b"]) site.poles[id] = { lat: y.poles[id][0], lon: y.poles[id][1], h: y.poles[id][2], mount: 0 };
    const an = C.analyzeSite(site);
    assert.ok(pair.includes(`${an.pair.horizM.toFixed(3)} m`) && pair.includes(`${an.pair.trueBearingAB.toFixed(3)}°`), pair);
    assert.equal(await page.eval("state.refs.map((r) => r.name).join()"), "app_mast", "the app's own stored result appears");
    await waitFor(async () => (await (await fetch(`${relayHost}/results/${CH}`)).json()).results.app_mast, 20000, "app-only result uploaded");
    log(`app Site map: relay settings + channel from the app, web-console results shown (${an.pair.horizM.toFixed(3)} m), the app's own result shown and uploaded`);

    // a rover elsewhere: its live fix reaches the app's Site map through the relay
    const rover = new WebSocket(`${relayHost.replace(/^http/, "ws")}/ws/relay/${CH}?role=rover`);
    await new Promise((r) => rover.once("open", r));
    rover.send(JSON.stringify({ type: "pvt", lat: y.poles.camera_b[0], lon: y.poles.camera_b[1], h: y.poles.camera_b[2], carrSoln: 2, hAccM: 0.01, numSv: 21, source: "laptop rover" }));
    await page.eval("const t = document.getElementById('target'); t.value = 'pole:camera_b'; t.dispatchEvent(new Event('change')); 1");
    const live = await waitFor(async () => { const t = await page.eval("document.getElementById('liveOut').innerText"); return /laptop rover/.test(t) && t; }, 15000, "live fix in the app");
    assert.match(live, /camera_b \(surveyed\): in place/);
    rover.close();
    log("a rover elsewhere shows live in the app's Site map (via the relay)");

    // Open file... -> Android picker -> Write survey into it -> Save to the file -> the real file on the device
    await page.eval("document.getElementById('cfgOpen').click(); 1");
    let picked = false;
    for (let i = 0; i < 6 && !picked; i++) {
      await sleep(1500);
      const nodes = uiNodes();
      const file = nodes.find((n) => n.text === "cameras.local.yaml");
      if (file) { tapNode(file); picked = true; break; }
      const dl = nodes.find((n) => /^Downloads?$/.test(n.text));
      if (dl) { tapNode(dl); continue; }
      const roots = nodes.find((n) => /Show roots/i.test(n.desc));
      if (roots) tapNode(roots);
    }
    assert.ok(picked, "could not find cameras.local.yaml in the document picker");
    await waitFor(() => page.eval("!document.getElementById('cfgWrite').disabled"), 15000, "file opened through the picker");
    assert.match(await page.eval("document.getElementById('cfgMsg').innerText"), /cameras\.local\.yaml: cameras camera_a, camera_b; pole_distance_m 50; origin not set yet/);
    await page.eval("document.getElementById('cfgWrite').click(); 1");
    assert.equal(await page.eval("document.querySelectorAll('#cfgChanges tr.changed').length"), 10);
    await page.eval("document.getElementById('cfgSave').click(); 1");
    const msg = await waitFor(async () => { const t = await page.eval("document.getElementById('cfgMsg').innerText"); return /saved|could not/.test(t) && t; }, 15000, "save result");
    assert.match(msg, /saved cameras\.local\.yaml and read it back/, msg);
    const onDevice = adb("shell", "cat", "/sdcard/Download/cameras.local.yaml");
    const want = C.applyToConfig(y.template, an, site.origin).text;
    assert.equal(onDevice, want, "the file on the device is exactly the verified output");
    log("Open file... (Android picker) -> Write survey into it -> Save to the file: the file on the device is byte-identical to the verified output");

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.eval("window.scrollTo(0, 0); 1");
      fs.writeFileSync(path.join(SHOTS, "app-site.png"), execFileSync(ADB, ["exec-out", "screencap", "-p"]));
      await tapText(/^Survey$/);
      await sleep(1200);
      fs.writeFileSync(path.join(SHOTS, "app-survey.png"), execFileSync(ADB, ["exec-out", "screencap", "-p"]));
      log(`screenshots in ${SHOTS}`);
    }
    page.ws.close();
    console.log("\nALL IN-APP SITE MAP CHECKS PASSED");
  } finally {
    if (fwd) try { adb("forward", "--remove", `tcp:${fwd}`); } catch (e) { /* gone */ }
    if (!external) try { adb("reverse", "--remove", `tcp:${port}`); } catch (e) { /* gone */ }
    if (relay) relay.kill();
  }
}

main().then(() => process.exit(0), (e) => { console.error("\nIN-APP TEST FAILED:", e.message); process.exit(1); });
