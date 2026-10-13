// The Site map in real headless Chrome (DevTools protocol): Leaflet map with
// tiles, two tabs of one browser sharing survey results (localStorage) and the
// live rover (BroadcastChannel) through the console's real functions, and the
// written cameras.yaml compared byte for byte with survey.py's own writer.
//
//   NODE_PATH=<dir with ws> node tests/web/site_browser.js [--page https://...] [--shots DIR]
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "oracle", "site_vectors.json"), "utf8"));
let step = 0;
const log = (m) => console.log(`[${String(++step).padStart(2, "0")}] ${m}`);

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function waitHttp(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return r; } catch (e) { /* not up */ }
    if (Date.now() - t0 > ms) throw new Error("no answer from " + url);
    await sleep(100);
  }
}

class Tab {
  static async open(port, url) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: "PUT" });
    const info = await r.json();
    const t = new Tab(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { t.ws.once("open", res); t.ws.once("error", rej); });
    await t.send("Runtime.enable");
    await t.send("Page.enable");
    return t;
  }
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0; this.pending = new Map(); this.errors = [];
    this.ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  for: ${expr.slice(0, 200)}`);
    return r.result.value;
  }
  async waitFor(expr, ms, what) {
    const t0 = Date.now();
    for (;;) {
      let v; try { v = await this.eval(expr); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(150);
    }
  }
  async shot(file, width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(800);
    const h = await this.eval("Math.ceil(document.documentElement.scrollHeight)");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(1500);
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    const sw = await this.eval("document.documentElement.scrollWidth");
    return { height: h, scrollWidth: sw };
  }
}

async function main() {
  let relay = null, pageBase = argVal("--page");
  if (!pageBase) {
    const port = await freePort();
    relay = spawn("python3", [path.join(ROOT, "server", "app.py"), "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
    pageBase = `http://127.0.0.1:${port}/`;
    await waitHttp(pageBase + "healthz", 15000);
  }
  if (!pageBase.endsWith("/")) pageBase += "/";
  const shots = argVal("--shots");
  console.log("page:", pageBase);

  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "site-chrome-"));
  const chrome = spawn(process.env.CHROME || "google-chrome", [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  const cleanup = async () => {
    const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
    try { chrome.kill("SIGKILL"); } catch (e) { /* gone */ }
    await exited;
    if (relay) relay.kill();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { /* temp dir, harmless */ }
  };

  try {
    await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000);
    const y = V.tracker && V.tracker.yaml;
    assert.ok(y, "needs tests/oracle/site_vectors.json generated with Ground_EO_Tracker present");

    // tab 1: the console, saving three results through its real function
    const consoleTab = await Tab.open(cdpPort, pageBase + "index.html");
    await consoleTab.waitFor("typeof saveSurveyResult === 'function' && document.readyState === 'complete'", 15000, "console loaded");
    const pts = { origin: y.origin, camera_a: y.poles.camera_a, camera_b: y.poles.camera_b };
    for (const [label, [lat, lon, h]] of Object.entries(pts)) {
      assert.equal(await consoleTab.eval(`saveSurveyResult(${JSON.stringify({ label, lat_deg: lat, lon_deg: lon, height_msl_m: h, n: 60, spread_m: 0.008, all_fixed: true })})`), true);
    }
    assert.equal(await consoleTab.eval("document.querySelector('.nav a[href=\"site.html\"]') !== null"), true);
    log("console tab saved origin / camera_a / camera_b via saveSurveyResult(); nav links to Site map");

    // tab 2: the Site map
    const site = await Tab.open(cdpPort, pageBase + "site.html");
    await site.waitFor("document.readyState === 'complete' && typeof SiteCalc === 'object'", 15000, "site loaded");
    assert.equal(await site.eval("typeof L"), "object", "Leaflet loaded from cdnjs (SRI ok)");
    await site.eval("document.getElementById('loadSurvey').click()");
    const pair = await site.eval("document.getElementById('pairOut').innerText");
    const expect = (() => {
      const C = require("../../web/sitecalc.js");
      const s = { origin: { lat: y.origin[0], lon: y.origin[1], h: y.origin[2] }, poles: {}, plan: null, declinationDeg: null };
      for (const id of ["camera_a", "camera_b"]) s.poles[id] = { lat: pts[id][0], lon: pts[id][1], h: pts[id][2], mount: 0, sigma: 0.008 };
      return C.analyzeSite(s);
    })();
    assert.ok(pair.includes(`${expect.pair.horizM.toFixed(3)} m`), `distance missing:\n${pair}`);
    assert.ok(pair.includes(`${expect.pair.trueBearingAB.toFixed(3)}°`) && pair.includes(`${expect.pair.trueBearingBA.toFixed(3)}°`), "bearings missing");
    log(`Site map tab: ${expect.pair.horizM.toFixed(3)} m, ${expect.pair.trueBearingAB.toFixed(3)}° / ${expect.pair.trueBearingBA.toFixed(3)}° between the poles`);

    const nShapes = await site.waitFor("document.querySelectorAll('#map .leaflet-interactive').length >= 4 && document.querySelectorAll('#map .leaflet-interactive').length", 10000, "map markers");
    const tiles = await site.waitFor("document.querySelectorAll('#map img.leaflet-tile-loaded').length", 20000, "satellite tiles");
    log(`Leaflet map: ${nShapes} shapes drawn, ${tiles} satellite tiles loaded`);

    // plan + declination + mount, through the real inputs
    await site.eval(`(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
      set('planDist', '${(expect.pair.horizM + 0.25).toFixed(2)}'); set('planBearing', '${Math.round(expect.pair.enuBearingAB)}'); set('decl', '-1.2');
    })()`);
    const planText = await site.eval("document.getElementById('planOut').innerText");
    assert.match(planText, /Distance vs plan[\s\S]*Bearing vs plan[\s\S]*move camera_a: [\s\S]*move camera_b: /);
    const svgN = await site.eval("document.querySelectorAll('#plot circle').length");
    assert.equal(svgN, 5, "site plot: origin, 2 poles, 2 planned");
    log("plan entered -> corrections + plan markers on map and site plot");

    // live rover: the console's real shareLive() -> other tab
    const [lat, lon, h] = pts.camera_b;
    await consoleTab.eval(`shareLive({ fixType: 3, latDeg: ${lat} + 0.3 / 110600, lonDeg: ${lon}, heightMslM: ${h} + 1.0, carrSoln: 2, hAccM: 0.012, numSv: 22 })`);
    await site.eval("const t = document.getElementById('target'); t.value = 'pole:camera_b'; t.dispatchEvent(new Event('change')); 1");
    const live = await site.waitFor("/FIX=true/.test(document.getElementById('liveOut').innerText) && document.getElementById('liveOut').innerText", 5000, "live rover in the Site map tab");
    assert.match(live, /camera_b \(surveyed\): 0\.(29|30)\d m towards 180\.0° \(0\.(29|30)\d m S, 0\.000 m [EW]\)/, live);
    assert.match(live, /target is 1\.000 m below the rover antenna/);
    log("live rover crossed tabs (BroadcastChannel): " + live.split("\n").find((l) => /camera_b/.test(l)));

    // write the committed cameras.yaml template; must equal survey.py point --write
    await site.eval(`(() => { const e = document.getElementById('cfgIn'); e.value = ${JSON.stringify(y.template)}; document.getElementById('cfgWrite').click(); })()`);
    const out = await site.eval("document.getElementById('cfgOut').value");
    if (out !== y.expected) {
      const a = out.split("\n"), b = y.expected.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) assert.fail(`cameras.yaml line ${i + 1}:\n  page:      ${a[i]}\n  survey.py: ${b[i]}`);
    }
    log(`written cameras.yaml is byte-identical to survey.py point --write (${out.length} bytes)`);

    // reading it back restores the same points
    await site.eval("document.getElementById('cfgIn').value = document.getElementById('cfgOut').value; document.getElementById('cfgRead').click(); 1");
    assert.match(await site.eval("document.getElementById('cfgMsg').innerText"), /read origin \+ 2 pole\(s\)/);
    const pair2 = await site.eval("document.getElementById('pairOut').innerText");
    assert.ok(pair2.includes(`${expect.pair.horizM.toFixed(3)} m`), "distance after reading the config back");
    log("reading the written config back gives the same distance");

    // reload keeps the page state; errors none
    await site.send("Page.reload");
    await site.waitFor("document.readyState === 'complete' && document.getElementById('pairOut').innerText.includes('Ground distance')", 15000, "state after reload");
    log("page state survives a reload");

    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await consoleTab.eval(`shareLive({ fixType: 3, latDeg: ${lat} + 0.3 / 110600, lonDeg: ${lon}, heightMslM: ${h} + 1.0, carrSoln: 2, hAccM: 0.012, numSv: 22 })`);
      // a typical site for the pictures: origin at the midpoint, poles ~50 m apart near 90 deg
      await site.eval(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
        const f = new Wgs84.LocalFrame(${y.origin[0]}, ${y.origin[1]}, ${y.origin[2]});
        const put = (l, e, n, u, mount) => { const g = f.enuToGeodetic(e, n, u); set('pt_' + l + '_lat', g[0].toFixed(9)); set('pt_' + l + '_lon', g[1].toFixed(9)); set('pt_' + l + '_h', g[2].toFixed(4)); if (mount != null) set('pt_' + l + '_mount', mount); };
        put('origin', 0, 0, 0); put('camera_a', -24.93, -0.42, 0.31, '3.2'); put('camera_b', 25.12, 0.18, -0.12, '3.2');
        set('planDist', '50'); set('planBearing', '90'); })()`);
      await consoleTab.eval(`(() => { const g = new Wgs84.LocalFrame(${y.origin[0]}, ${y.origin[1]}, ${y.origin[2]}).enuToGeodetic(24.6, 3.1, 0.2);
        shareLive({ fixType: 3, latDeg: g[0], lonDeg: g[1], heightMslM: g[2], carrSoln: 2, hAccM: 0.011, numSv: 23 }); })()`);
      await site.eval("const t = document.getElementById('target'); t.value = 'plan:camera_b'; t.dispatchEvent(new Event('change')); 1");
      await site.eval("document.getElementById('fitMap').click(); 1");
      const d = await site.shot(path.join(shots, "site-desktop.png"), 1280, 900);
      const m = await site.shot(path.join(shots, "site-mobile.png"), 390, 844);
      assert.ok(m.scrollWidth <= 390, `horizontal scroll on a phone: ${m.scrollWidth}px`);
      const c = await consoleTab.shot(path.join(shots, "console-top.png"), 1280, 600);
      log(`screenshots in ${shots} (desktop ${d.height}px, phone ${m.height}px tall, no sideways scroll; console ${c.height}px)`);
    }

    const errs = [...consoleTab.errors, ...site.errors];
    assert.deepEqual(errs, [], "page errors");
    console.log("\nALL SITE MAP BROWSER CHECKS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0), (e) => { console.error("\nSITE BROWSER TEST FAILED:", e.message); process.exit(1); });
