// The Site map in real headless Chrome (DevTools protocol): Leaflet map with
// tiles, two tabs of one browser sharing survey results (localStorage) and the
// live rover (BroadcastChannel) through the console's real functions, the aim
// panel, and Open file... -> Write survey into it -> Save to the file giving
// exactly the text that check_site_config.py verified with the tracker's code.
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
    const C = require("../../web/sitecalc.js");

    // what the page must show / write: the same inputs through sitecalc.js under Node
    // (whose output check_site_config.py verifies with the tracker's own code)
    const site = { origin: { lat: y.origin[0], lon: y.origin[1], h: y.origin[2] }, poles: {}, refs: [], plan: null, declinationDeg: null };
    for (const id of ["camera_a", "camera_b"]) site.poles[id] = { lat: y.poles[id][0], lon: y.poles[id][1], h: y.poles[id][2], mount: y.mounts[id], sigma: 0.008 };
    for (const r of y.refs) site.refs.push({ name: r.name, lat: r.geo[0], lon: r.geo[1], h: r.geo[2], above: r.above, sigma: 0.01 });
    const expect = C.analyzeSite(site);
    const expectedYaml = C.applyToConfig(y.template, expect, site.origin).text;

    // tab 1: the console saves every point through its real function
    const consoleTab = await Tab.open(cdpPort, pageBase + "index.html");
    await consoleTab.waitFor("typeof saveSurveyResult === 'function' && document.readyState === 'complete'", 15000, "console loaded");
    const results = [["origin", y.origin, 0.008], ["camera_a", y.poles.camera_a, 0.008], ["camera_b", y.poles.camera_b, 0.008],
      ...y.refs.map((r) => [r.name, r.geo, 0.01])];
    for (const [label, [lat, lon, h], spread] of results) {
      assert.equal(await consoleTab.eval(`saveSurveyResult(${JSON.stringify({ label, lat_deg: lat, lon_deg: lon, height_msl_m: h, n: 60, spread_m: spread, all_fixed: true })})`), true);
    }
    assert.equal(await consoleTab.eval("document.querySelector('.nav a[href=\"site.html\"]') !== null"), true);
    log(`console tab saved ${results.map((r) => r[0]).join(", ")} via saveSurveyResult()`);

    // tab 2: the Site map - load, then type the mounts / sighted height like a user
    const site2 = await Tab.open(cdpPort, pageBase + "site.html");
    const tab = site2;
    await tab.waitFor("document.readyState === 'complete' && typeof SiteCalc === 'object'", 15000, "site loaded");
    assert.equal(await tab.eval("typeof L"), "object", "Leaflet loaded from cdnjs (SRI ok)");
    await tab.eval("document.getElementById('loadSurvey').click(); 1");
    await tab.eval(`(() => {
      const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input')); };
      set('[data-point="camera_a"] input[data-key="mount"]', '${y.mounts.camera_a}');
      set('[data-point="camera_b"] input[data-key="mount"]', '${y.mounts.camera_b}');
      ${y.refs.map((r, i) => `set('[data-ref="${i}"] input[data-key="above"]', '${r.above}');`).join("\n")}
    })()`);
    assert.equal(await tab.eval("state.points.camera_a.sigma"), 0.008, "typing a mount keeps the survey spread");
    assert.equal(await tab.eval("state.refs.map((r) => r.name).join()"), y.refs.map((r) => r.name).join(), "other labels became reference points");

    const pair = await tab.eval("document.getElementById('pairOut').innerText");
    assert.ok(pair.includes(`${expect.pair.horizM.toFixed(3)} m`), `distance missing:\n${pair}`);
    assert.ok(pair.includes(`${expect.pair.trueBearingAB.toFixed(3)}°`) && pair.includes(`${expect.pair.trueBearingBA.toFixed(3)}°`), "bearings missing");
    for (const id of ["camera_a", "camera_b"]) assert.ok(pair.includes(expect.poles[id].enu[2].toFixed(4)), `${id} origin_u (with mount) missing`);
    log(`Site map: ${expect.pair.horizM.toFixed(3)} m, ${expect.pair.trueBearingAB.toFixed(3)}° / ${expect.pair.trueBearingBA.toFixed(3)}°, origin_u with mounts`);

    const aim = await tab.eval("document.getElementById('aimOut').innerText");
    for (const id of ["camera_a", "camera_b"]) {
      for (const sgt of expect.sightings[id]) {
        assert.ok(aim.includes(sgt.csv) && aim.includes(`${sgt.azDeg.toFixed(3)}°`) && aim.includes(`±${sgt.sigmaMrad.toFixed(2)}`), `${id} -> ${sgt.name} missing:\n${aim}`);
      }
    }
    log(`aim panel: ${expect.sightings.camera_a.length} targets per camera with az/el and ref_lat,ref_lon,ref_alt (as check_site_config.py verified)`);

    const nShapes = await tab.waitFor("document.querySelectorAll('#map .leaflet-interactive').length >= 6 && document.querySelectorAll('#map .leaflet-interactive').length", 10000, "map markers");
    const tiles = await tab.waitFor("document.querySelectorAll('#map img.leaflet-tile-loaded').length", 20000, "satellite tiles");
    log(`Leaflet map: ${nShapes} shapes, ${tiles} satellite tiles loaded`);

    // plan -> corrections panel appears; exact plot draws everything
    await tab.eval(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
      set('planDist', '${(expect.pair.horizM + 0.25).toFixed(2)}'); set('planBearing', '${Math.round(expect.pair.enuBearingAB)}'); })()`);
    assert.equal(await tab.eval("document.getElementById('planPanel').hidden"), false);
    assert.match(await tab.eval("document.getElementById('planOut').innerText"), /Distance vs plan[\s\S]*move camera_a: [\s\S]*move camera_b: /);
    await tab.eval("document.getElementById('tabPlot').click(); 1");
    assert.equal(await tab.eval("document.querySelectorAll('#plot circle').length"), 3 + 2 + y.refs.length, "plot: origin, 2 poles, 2 planned, refs");
    await tab.eval("document.getElementById('tabMap').click(); 1");
    log("plan -> corrections panel; exact plot draws origin, poles, plan and reference points");

    // live rover: the console's real shareLive() -> this tab
    const [lat, lon, h] = y.poles.camera_b;
    await consoleTab.eval(`shareLive({ fixType: 3, latDeg: ${lat} + 0.3 / 110600, lonDeg: ${lon}, heightMslM: ${h} + 1.0, carrSoln: 2, hAccM: 0.012, numSv: 22 })`);
    await tab.eval("const t = document.getElementById('target'); t.value = 'pole:camera_b'; t.dispatchEvent(new Event('change')); 1");
    const live = await tab.waitFor("/FIX=true/.test(document.getElementById('liveOut').innerText) && document.getElementById('liveOut').innerText", 5000, "live rover");
    assert.match(live, /camera_b \(surveyed\): 0\.(29|30)\d m towards 180\.0° \(0\.(29|30)\d m S, 0\.000 m [EW]\)/, live);
    assert.match(live, /target is 1\.000 m below the rover antenna/);
    log("live rover crossed tabs: " + live.split("\n").find((l) => /camera_b/.test(l)));

    // the guide's flow: Open file... -> Write survey into it -> Save to the file
    // (a stand-in file handle: the native picker can't be clicked headless)
    await tab.eval(`(() => {
      window.__disk = ${JSON.stringify(y.template)};
      const handle = {
        getFile: async () => new File([window.__disk], "cameras.local.yaml"),
        createWritable: async () => { let buf = ""; return { write: async (t) => { buf += t; }, close: async () => { window.__disk = buf; } }; },
      };
      window.showOpenFilePicker = async () => [handle];
    })()`);
    await tab.eval("document.getElementById('cfgOpen').click(); 1");
    await tab.waitFor("!document.getElementById('cfgWrite').disabled", 5000, "file opened");
    assert.match(await tab.eval("document.getElementById('cfgMsg').innerText"), /cameras\.local\.yaml: cameras camera_a, camera_b; pole_distance_m 50; origin not set yet/);
    await tab.eval("document.getElementById('cfgWrite').click(); 1");
    const changes = await tab.eval("[...document.querySelectorAll('#cfgChanges tr.changed')].map((r) => r.innerText)");
    assert.equal(changes.length, 10, `changed lines:\n${changes.join("\n")}`);
    assert.match(await tab.eval("document.getElementById('cfgMsg').innerText"), /10 line\(s\) will change/);
    assert.equal(await tab.eval("document.getElementById('cfgSave').hidden"), false);
    await tab.eval("document.getElementById('cfgSave').click(); 1");
    await tab.waitFor("/saved .* read it back/.test(document.getElementById('cfgMsg').innerText)", 5000, "saved");
    const disk = await tab.eval("window.__disk");
    if (disk !== expectedYaml) {
      const a = disk.split("\n"), b = expectedYaml.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) assert.fail(`saved file line ${i + 1}:\n  page: ${a[i]}\n  node: ${b[i]}`);
    }
    log(`Open file... -> Write survey into it (10 changed lines shown) -> Save to the file: saved text identical to the verified output`);
    await tab.eval("document.getElementById('cfgWrite').click(); 1");
    assert.match(await tab.eval("document.getElementById('cfgChanges').innerText"), /already holds exactly these values/);
    log("writing again: 'the file already holds exactly these values'");

    // reload keeps the page state
    await tab.send("Page.reload");
    await tab.waitFor("document.readyState === 'complete' && document.getElementById('pairOut').innerText.includes('Height difference')", 15000, "state after reload");
    log("page state survives a reload");

    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      // a typical site for the pictures: origin at the midpoint, poles ~50 m apart near 90 deg, two far references
      await tab.eval(`(() => { const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input')); };
        const f = new Wgs84.LocalFrame(${y.origin[0]}, ${y.origin[1]}, ${y.origin[2]});
        const put = (sel, e, n, u) => { const g = f.enuToGeodetic(e, n, u); set(sel + ' input[data-key="lat"]', g[0].toFixed(9)); set(sel + ' input[data-key="lon"]', g[1].toFixed(9)); set(sel + ' input[data-key="h"]', g[2].toFixed(4)); };
        put('[data-point="camera_a"]', -24.93, -0.42, 0.31); put('[data-point="camera_b"]', 25.12, 0.18, -0.12);
        put('[data-ref="0"]', 60, 140, 8); put('[data-ref="1"]', -90, 110, -1);
        set('#planDist', '50'); set('#planBearing', '90'); })()`);
      await consoleTab.eval(`(() => { const g = new Wgs84.LocalFrame(${y.origin[0]}, ${y.origin[1]}, ${y.origin[2]}).enuToGeodetic(24.6, 3.1, 0.2);
        shareLive({ fixType: 3, latDeg: g[0], lonDeg: g[1], heightMslM: g[2], carrSoln: 2, hAccM: 0.011, numSv: 23 }); })()`);
      await tab.eval("const t = document.getElementById('target'); t.value = 'plan:camera_b'; t.dispatchEvent(new Event('change')); document.getElementById('fitMap').click(); 1");
      const d = await tab.shot(path.join(shots, "site-desktop.png"), 1280, 900);
      const m = await tab.shot(path.join(shots, "site-mobile.png"), 390, 844);
      assert.ok(m.scrollWidth <= 390, `horizontal scroll on a phone: ${m.scrollWidth}px`);
      const c = await consoleTab.shot(path.join(shots, "console.png"), 1280, 900);
      log(`screenshots in ${shots} (desktop ${d.height}px, phone ${m.height}px, no sideways scroll; console ${c.height}px)`);
    }

    const errs = [...consoleTab.errors, ...tab.errors];
    assert.deepEqual(errs, [], "page errors");
    console.log("\nALL SITE MAP BROWSER CHECKS PASSED");
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0), (e) => { console.error("\nSITE BROWSER TEST FAILED:", e.message); process.exit(1); });
