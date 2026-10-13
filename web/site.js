// Site map page. Sections: state | survey results (relay sync) | points |
// results | map + plot | aiming | live rover | cameras.local.yaml.
// All math is in sitecalc.js. Inside the Android app the same page runs in a
// WebView, with window.AndroidSite for the relay address, the app's own
// results, and opening/saving files.
const $ = (id) => document.getElementById(id);
const C = window.SiteCalc;
const A = window.AndroidSite || null;

const STATE_KEY = "gnss_site_v2";
const DEFAULT_RELAY = "https://gnss-relay.onrender.com";
const COLORS = { origin: "#e6edf3", a: "#35c46b", b: "#f08a3c", ref: "#c58cff", live: "#4fa3ff" };

// ================================================================ state

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: this tab only */ } },
};
const blankPoint = () => ({ lat: "", lon: "", h: "", mount: "", src: "" });

// The current site's points/refs/plan are on `state`; other channels' are kept in state.sites.
let state = Object.assign({ ids: ["camera_a", "camera_b"], points: {}, refs: [], plan: { dist: "", bearing: "" }, decl: "", view: "map", channel: "", sites: {} },
  store.get(STATE_KEY) || {});
const startChannel = (A && A.channel()) || state.channel ||
  (() => { try { return localStorage.getItem("gnss_last_channel"); } catch (e) { return null; } })() || "default";
const labels = () => ["origin", ...state.ids];
for (const l of labels()) state.points[l] = Object.assign(blankPoint(), state.points[l] || {});
const save = () => store.set(STATE_KEY, state);

const num = (s) => {
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const fmt = (v, d) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const deg = (v, d = 3) => (Number.isFinite(v) ? `${v.toFixed(d)}°` : "-");
const signed = (v, d, unit) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}${unit}`;
const colorOf = (l) => (l === "origin" ? COLORS.origin : l === state.ids[0] ? COLORS.a : l === state.ids[1] ? COLORS.b : COLORS.ref);

/** Element helper: el("div", {class: "x"}, "text" | [children]). SVG tags get the SVG namespace. */
const SVG_TAGS = new Set(["svg", "line", "circle", "text", "path", "g", "rect"]);
function el(tag, attrs = {}, content) {
  const e = SVG_TAGS.has(tag) ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (Array.isArray(content)) e.append(...content.filter((c) => c != null));
  else if (content != null) e.textContent = content;
  return e;
}

/** The page's inputs as numbers, for SiteCalc. */
function siteInput() {
  const pt = (p) => {
    const v = { lat: num(p.lat), lon: num(p.lon), h: num(p.h), mount: num(p.mount) ?? 0, above: num(p.above) ?? 0, sigma: p.sigma ?? null, allFixed: p.allFixed };
    return v.lat == null || v.lon == null || v.h == null ? null : v;
  };
  const poles = {};
  for (const id of state.ids) poles[id] = pt(state.points[id]);
  const refs = state.refs.map((r) => { const v = pt(r); return v && Object.assign(v, { name: r.name || "ref" }); }).filter(Boolean);
  const dist = num(state.plan.dist), bearing = num(state.plan.bearing);
  return {
    origin: pt(state.points.origin), poles, refs,
    plan: dist != null && bearing != null ? { distanceM: dist, bearingDeg: bearing } : null,
    declinationDeg: num(state.decl),
  };
}

// ================================================================ points

function field(obj, key, label, placeholder) {
  const id = `f_${Math.random().toString(36).slice(2, 9)}`;
  const inp = el("input", { id, inputmode: "decimal", placeholder });
  inp.dataset.key = key;
  inp.value = obj[key] ?? "";
  inp.addEventListener("input", () => {
    obj[key] = inp.value;
    if (["lat", "lon", "h"].includes(key)) { // the position itself: no longer the surveyed one
      if (!obj.src) obj.src = "entered by hand";
      else if (!/(edited\)|by hand)$/.test(obj.src)) obj.src += " (edited)";
      obj.sigma = null;
      const src = inp.closest(".pt") && inp.closest(".pt").querySelector(".src");
      if (src) src.textContent = obj.src;
    }
    save(); update();
  });
  return el("div", {}, [el("label", { for: id }, label), inp]);
}

function pointCard(l, p) {
  const extra = l === "origin" ? null : field(p, "mount", "mount (m)", "0");
  return el("div", { class: "pt", "data-point": l }, [
    el("h3", {}, [el("span", { class: "dot", style: `background:${colorOf(l)}` }), l]),
    el("div", { class: "row" }, [field(p, "lat", "lat (°)", "12.971598700"), field(p, "lon", "lon (°)", "77.594562700")]),
    el("div", { class: "row" }, [field(p, "h", "height MSL (m)", "920.000"), extra]),
    el("div", { class: "src" + (/fix=false/.test(p.src) ? " bad" : "") }, p.src),
  ]);
}

function refCard(r, i) {
  const name = el("input", { "aria-label": "reference point name", placeholder: "name" });
  name.value = r.name;
  name.addEventListener("input", () => { r.name = name.value; save(); update(); });
  const del = el("button", { class: "secondary", title: "remove" }, "remove");
  del.onclick = () => {
    state.refs.splice(i, 1);
    if (r.at && Results.LABEL_RE.test(r.name)) { // a surveyed one: remove it everywhere, or the next sync brings it back
      results = Results.merge(results, { [r.name]: Results.record(state.channel, r.name, { deleted: true }, A ? "Android app" : "site map") }).results;
      syncNow();
    }
    save(); buildForms(); update();
  };
  return el("div", { class: "pt", "data-ref": i }, [
    el("h3", {}, [el("span", { class: "dot", style: `background:${COLORS.ref}` }), name, del]),
    el("div", { class: "row" }, [field(r, "lat", "lat (°)", ""), field(r, "lon", "lon (°)", "")]),
    el("div", { class: "row" }, [field(r, "h", "height MSL (m)", ""), field(r, "above", "sighted part above it (m)", "0")]),
    el("div", { class: "src" + (/fix=false/.test(r.src) ? " bad" : "") }, r.src),
  ]);
}

function buildForms() {
  $("pointForms").replaceChildren(...labels().map((l) => pointCard(l, state.points[l])));
  $("refForms").replaceChildren(...state.refs.map(refCard));
}

// ================================================================ survey results (relay sync)

const relayUrl = () => (A && A.relayUrl()) || (() => { try { return localStorage.getItem("gnss_server_url"); } catch (e) { return null; } })() || DEFAULT_RELAY;
const appResults = (ch) => { if (!A) return {}; try { return JSON.parse(A.results(ch)) || {}; } catch (e) { return {}; } };

let results = {};                       // merged: this device + the Android app + the relay
let sync = { at: 0, error: null, reachable: null, live: false };

const isHandEdited = (p) => /(edited\)|by hand)$|^from /.test(p.src || "");
const newerThan = (r, p) => !p.at || Date.parse(r.at) > Date.parse(p.at);

function fromSurvey(r) {
  return {
    lat: r.lat_deg.toFixed(9), lon: r.lon_deg.toFixed(9), h: r.height_msl_m.toFixed(4), // 0.1 mm
    sigma: r.spread_m, allFixed: r.all_fixed, at: r.at,
    src: `survey ${new Date(r.at).toLocaleString()}${r.source ? ` (${r.source})` : ""}: ${r.n} epochs, spread ${r.spread_m.toFixed(3)} m, fix=${r.all_fixed}`,
  };
}

/** Puts results into the points: new labels always; newer results only into
 * points not edited by hand - unless forced ("Load survey results"). */
function applyResults(force) {
  let changed = false;
  for (const [label, r] of Object.entries(results)) {
    const isMain = labels().includes(label);
    if (r.deleted) {
      const i = state.refs.findIndex((x) => x.name === label);
      if (i >= 0 && (force || !isHandEdited(state.refs[i])) && newerThan(r, state.refs[i])) { state.refs.splice(i, 1); changed = true; }
      continue;
    }
    let p = isMain ? state.points[label] : state.refs.find((x) => x.name === label);
    if (!p) state.refs.push(p = { name: label, above: "" });
    if (force || ((!p.lat || !isHandEdited(p)) && newerThan(r, p))) { Object.assign(p, fromSurvey(r)); changed = true; }
  }
  if (changed) { mapFitted = false; save(); buildForms(); update(); }
  return changed;
}

function renderSyncNote() {
  const names = Object.keys(results).filter((k) => !results[k].deleted);
  const parts = [names.length ? `${names.length} result(s): ${names.join(", ")}` : "no results on this channel yet"];
  if (sync.reachable === false) parts.push(`relay unreachable (${sync.error}) - showing what this device has`);
  else if (sync.at) parts.push(`synced ${new Date(sync.at).toLocaleTimeString()}${sync.error ? ` (${sync.error})` : ""}`);
  else parts.push("syncing with the relay...");
  parts.push(sync.live ? "live link on" : "live link connecting");
  $("syncNote").textContent = parts.join(" · ");
  $("syncNote").className = "src" + (sync.reachable === false ? " bad" : "");
}

let syncRun = 0;
async function syncNow() {
  const ch = state.channel, run = ++syncRun;
  const r = await Results.sync(relayUrl(), ch, appResults(ch));
  if (ch !== state.channel || run !== syncRun) return; // channel changed meanwhile
  results = r.results;
  sync = { ...sync, at: r.reachable ? Date.now() : sync.at, error: r.error, reachable: r.reachable };
  applyResults(false);
  renderSyncNote();
}

let watch = null;
function startWatch() {
  if (watch) watch.stop();
  sync.live = false;
  watch = window.startRelayWatch(relayUrl(), state.channel, (ev) => {
    if (ev.type === "pvt") setLive(ev);
    else if (ev.type === "result" && Results.LABEL_RE.test(ev.label)) {
      const m = Results.merge(results, { [ev.label]: ev.result });
      if (!m.changed.length) return;
      results = m.results;
      Results.saveLocal(state.channel, results);
      applyResults(false);
      renderSyncNote();
    }
  }, (up) => { sync.live = up; renderSyncNote(); });
}

function switchSite(ch) {
  if (state.channel) state.sites[state.channel] = { ids: state.ids, points: state.points, refs: state.refs, plan: state.plan };
  const s = state.sites[ch] || {};
  delete state.sites[ch];
  Object.assign(state, { channel: ch, ids: s.ids || ["camera_a", "camera_b"], points: s.points || {}, refs: s.refs || [], plan: s.plan || { dist: "", bearing: "" } });
  for (const l of labels()) state.points[l] = Object.assign(blankPoint(), state.points[l] || {});
  $("planDist").value = state.plan.dist; $("planBearing").value = state.plan.bearing;
  mapFitted = false;
  buildForms();
}

function useChannel(ch) {
  if (ch !== state.channel) switchSite(ch);
  save();
  results = Results.merge(Results.loadLocal(ch), appResults(ch)).results; // instant, before the relay answers
  sync = { at: 0, error: null, reachable: null, live: false };
  applyResults(false);
  renderSyncNote();
  startWatch();
  syncNow();
}

$("channel").value = startChannel;
let channelTimer = null;
$("channel").addEventListener("input", () => {
  clearTimeout(channelTimer);
  const ch = $("channel").value.trim();
  if (ch) channelTimer = setTimeout(() => useChannel(ch), 600);
});
setInterval(syncNow, 30000); // also keeps a free-tier relay awake while the page is open

$("loadSurvey").onclick = async () => {
  await syncNow();
  applyResults(true);
};

// the console in this browser saved a result
window.addEventListener("storage", (e) => {
  if (e.key !== `gnss_results:${state.channel}`) return;
  const m = Results.merge(results, Results.loadLocal(state.channel));
  if (m.changed.length) { results = m.results; applyResults(false); renderSyncNote(); syncNow(); }
});

$("clearPoints").onclick = () => {
  if (!confirm("Clear all points on this page? (Survey results stay on the relay and in the console; \"Load survey results\" brings them back.)")) return;
  for (const l of labels()) state.points[l] = blankPoint();
  state.refs = [];
  save(); buildForms(); update();
};

$("addRef").onclick = () => {
  state.refs.push({ name: `ref${state.refs.length + 1}`, lat: "", lon: "", h: "", above: "", src: "" });
  save(); buildForms(); update();
};

for (const [id, key] of [["planDist", "dist"], ["planBearing", "bearing"]]) {
  $(id).value = state.plan[key];
  $(id).addEventListener("input", () => { state.plan[key] = $(id).value; save(); update(); });
}
$("decl").value = state.decl;
$("decl").addEventListener("input", () => { state.decl = $("decl").value; save(); update(); });
if (state.plan.dist || state.plan.bearing || state.decl) $("planBox").open = true;

// ================================================================ results

const kpi = (k, v, s) => el("div", { class: "kpi" }, [el("div", { class: "k" }, k), el("div", { class: "v" }, v), s ? el("div", { class: "s" }, s) : null]);

function table(head, rows, opts = {}) {
  const cell = (c, i) => (c instanceof Node ? el("td", {}, [c]) : el("td", { class: i && opts.num !== false ? "num" : null }, c));
  return el("div", { class: "tablewrap" }, [el("table", {}, [
    el("tr", {}, head.map((h) => el("th", {}, h))),
    ...rows.map((r) => el("tr", { class: opts.rowClass || null }, r.map(cell))),
  ])]);
}

function renderPair(an) {
  const [ia, ib] = state.ids;
  const p = an.pair;
  if (!p) { $("pairOut").replaceChildren(el("div", { class: "empty" }, `Load or enter both ${ia} and ${ib}.`)); return; }
  const dist = Number.isFinite(p.horizM) ? p.horizM : p.geodesicM;
  const sig = Number.isFinite(p.bearingSigmaDeg) ? `true north, ±${p.bearingSigmaDeg.toFixed(3)}° from the survey spreads` : "true north";
  const nodes = [el("div", { class: "kpis" }, [
    kpi("Distance", `${dist.toFixed(3)} m`, "horizontal, pole to pole"),
    kpi(`Bearing ${ia} → ${ib}`, deg(p.trueBearingAB), sig),
    kpi(`Bearing ${ib} → ${ia}`, deg(p.trueBearingBA), "true north"),
    kpi("Height difference", signed(p.dHeightM, 3, " m"), `${ib}'s camera above ${ia}'s`),
  ])];
  const more = [`camera-to-camera tilt ${signed(p.sightAB.elDeg, 3, "°")} from ${ia}, ${signed(p.sightBA.elDeg, 3, "°")} from ${ib}`];
  if (Number.isFinite(p.slopeM)) more.push(`straight-line ${p.slopeM.toFixed(3)} m`);
  if (Number.isFinite(p.magneticBearingAB)) more.push(`magnetic ${deg(p.magneticBearingAB, 1)} / ${deg(p.magneticBearingBA, 1)}`);
  if (Number.isFinite(p.enuBearingAB)) more.push(`in the tracker's frame ${deg(p.enuBearingAB)} (= pole_line_bearing_deg)`);
  nodes.push(el("div", { class: "note" }, more.join(" · ")));

  if (an.frame) {
    const rows = state.ids.filter((id) => an.poles[id]).map((id) => {
      const r = an.poles[id];
      return [id, fmt(r.enu[0], 4), fmt(r.enu[1], 4), fmt(r.enu[2], 4)];
    });
    nodes.push(table(["written to the config", "origin_e", "origin_n", "origin_u"], rows));
  } else {
    nodes.push(el("div", { class: "note" }, "origin_e/n/u need the origin - survey or enter it."));
  }
  $("pairOut").replaceChildren(...nodes);
}

function renderPlan(an) {
  $("planPanel").hidden = !an.plan;
  if (!an.plan) return;
  const pl = an.plan;
  if (!an.frame) { $("planOut").replaceChildren(el("div", { class: "empty" }, "Needs the origin.")); return; }
  const nodes = [];
  if (Number.isFinite(pl.distanceErrorM)) {
    nodes.push(el("div", { class: "kpis" }, [
      kpi("Distance vs plan", signed(pl.distanceErrorM, 3, " m"), `surveyed ${an.pair.horizM.toFixed(3)} m, plan ${pl.distanceM} m`),
      kpi("Bearing vs plan", signed(pl.bearingErrorDeg, 3, "°"), `surveyed ${an.pair.enuBearingAB.toFixed(3)}°, plan ${pl.bearingDeg}°`),
    ]));
  }
  for (const id of state.ids) {
    const m = pl.moves[id];
    if (m) nodes.push(el("div", { class: "move" }, [el("span", { class: "dot", style: `background:${colorOf(id)};margin-right:6px` }), `To match the plan, move ${id}: `, el("b", {}, m.text)]));
  }
  nodes.push(el("div", { class: "note" }, "Or keep the poles where they are: writing the survey into the config (pole_distance_m: 0.0) makes the tracker use their real positions."));
  $("planOut").replaceChildren(...nodes);
}

// ================================================================ map + plot

let map = null, mapLayer = null, mapFitted = false;
const OFFSETS = { top: [0, -8], bottom: [0, 8], right: [8, 0], left: [-8, 0] };

/** Label sides that keep labels off the pole line: above/below an east-west line, beside a north-south one. */
function labelSides(an) {
  const b = an.pair ? (Number.isFinite(an.pair.enuBearingAB) ? an.pair.enuBearingAB : an.pair.trueBearingAB) : NaN;
  const ew = Number.isFinite(b) && Math.abs(Math.sin((b * Math.PI) / 180)) >= Math.SQRT1_2;
  return ew ? { main: "top", plan: "bottom", line: "bottom", rover: "right" } : { main: "right", plan: "left", line: "left", rover: "bottom" };
}

function initMap() {
  if (typeof L === "undefined") {
    $("map").hidden = true;
    $("fitMap").hidden = true;
    $("mapNote").textContent = "The map couldn't load (offline?) - use the exact plot; all numbers still work.";
    return;
  }
  map = L.map("map", { maxZoom: 23 });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 19, maxZoom: 23, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" });
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxNativeZoom: 19, maxZoom: 23, attribution: "&copy; OpenStreetMap contributors" });
  sat.addTo(map);
  L.control.layers({ Satellite: sat, Street: osm }, null, { position: "topright" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  map.setView([20, 78], 4);
  mapLayer = L.layerGroup().addTo(map);
}

/** Everything drawn on the map and the plot, as geodetic points. */
function drawables(an, site) {
  const items = [];
  if (site.origin) items.push({ label: "origin", color: COLORS.origin, ...site.origin });
  for (const id of state.ids) if (an.poles[id]) items.push({ label: id, color: colorOf(id), ...an.poles[id].antenna });
  for (const r of site.refs) items.push({ label: r.name, color: COLORS.ref, lat: r.lat, lon: r.lon, h: r.h, small: true });
  return items;
}

function drawMap(an, site) {
  if (!map || $("mapView").hidden) return;
  mapLayer.clearLayers();
  const side = labelSides(an);
  const mark = (lat, lon, color, label, kind) => {
    const hollow = kind === "plan";
    const dir = hollow ? side.plan : kind === "rover" ? side.rover : side.main;
    L.circleMarker([lat, lon], { radius: kind === "small" ? 5 : 6, color: kind === "rover" ? "#fff" : color, weight: 2, fillColor: color, fillOpacity: hollow ? 0 : 0.9, dashArray: hollow ? "3 3" : null })
      .bindTooltip(label, { permanent: true, direction: dir, className: "lbl", offset: OFFSETS[dir] }).addTo(mapLayer);
  };
  const items = drawables(an, site);
  for (const it of items) mark(it.lat, it.lon, it.color, it.label, it.small ? "small" : "point");
  const [ia, ib] = state.ids;
  if (an.pair) {
    const a = an.poles[ia].antenna, b = an.poles[ib].antenna;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#ffffff", weight: 2, opacity: 0.9 }).addTo(mapLayer);
    L.tooltip({ permanent: true, direction: side.line, className: "lbl", offset: OFFSETS[side.line] }) // 40% along: the midpoint is usually the origin
      .setLatLng([a.lat + 0.4 * (b.lat - a.lat), a.lon + 0.4 * (b.lon - a.lon)])
      .setContent(`${(an.pair.horizM ?? an.pair.geodesicM).toFixed(3)} m · ${an.pair.trueBearingAB.toFixed(3)}°`).addTo(mapLayer);
  }
  if (an.plan && an.frame) {
    for (const id of state.ids) {
      const [lat, lon] = an.frame.enuToGeodetic(...an.plan.planned[id], 0);
      mark(lat, lon, colorOf(id), `${id} plan`, "plan");
      const p = an.poles[id];
      if (p) L.polyline([[p.antenna.lat, p.antenna.lon], [lat, lon]], { color: colorOf(id), weight: 2, dashArray: "4 4" }).addTo(mapLayer);
    }
  }
  if (live && live.fresh) mark(live.lat, live.lon, COLORS.live, "rover", "rover");
  if (items.length && !mapFitted) fitMap(items.map((i) => [i.lat, i.lon]));
}

function fitMap(pts) {
  if (!map || !pts.length) return;
  mapFitted = true;
  if (pts.length === 1) map.setView(pts[0], 20);
  else map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 21 });
}
$("fitMap").onclick = () => { const site = siteInput(); fitMap(drawables(C.analyzeSite(site, state.ids), site).map((i) => [i.lat, i.lon])); };

function setView(v) {
  state.view = v; save();
  $("mapView").hidden = v !== "map";
  $("plotView").hidden = v !== "plot";
  $("tabMap").classList.toggle("on", v === "map");
  $("tabPlot").classList.toggle("on", v === "plot");
  if (map && v === "map") setTimeout(() => map.invalidateSize(), 0);
  update();
}
$("tabMap").onclick = () => setView("map");
$("tabPlot").onclick = () => setView("plot");

function niceStep(span) {
  const raw = span / 6, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function drawPlot(an, site) {
  if ($("plotView").hidden) return;
  const svg = $("plot");
  svg.replaceChildren();
  const W = svg.clientWidth || 600, H = svg.clientHeight || 360;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!an.frame) {
    svg.append(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "#8b98a5", "font-size": 13 }, "needs the origin"));
    $("plotScale").textContent = "";
    return;
  }
  const k = Number($("exag").value) || 1;
  const enu = (p) => an.frame.geodeticToEnu(p.lat, p.lon, p.h);
  const items = drawables(an, site).map((it) => {
    let [e, n] = enu(it);
    const plan = an.plan && an.plan.planned[it.label];
    if (plan && k !== 1) { e = plan[0] + k * (e - plan[0]); n = plan[1] + k * (n - plan[1]); } // exaggerate the offset from plan
    return { ...it, e, n };
  });
  const planned = an.plan ? state.ids.map((id) => ({ label: `${id} plan`, of: id, e: an.plan.planned[id][0], n: an.plan.planned[id][1], color: colorOf(id) })) : [];
  const rover = live && live.fresh ? (([e, n]) => ({ label: "rover", e, n, color: COLORS.live }))(enu(live)) : null;

  const all = [...items, ...planned, ...(rover ? [rover] : [])];
  const ext = 1.25 * Math.max(1, ...all.map((p) => Math.max(Math.abs(p.e), Math.abs(p.n))));
  const s = Math.min(W - 48, H - 48) / (2 * ext);
  const X = (e) => W / 2 + e * s, Y = (n) => H / 2 - n * s;
  const label = (x, y, t, fill, size) => { // centred, pulled inwards near the edges
    const half = t.length * size * 0.3;
    return el("text", { x: Math.min(Math.max(x, half + 4), W - half - 4), y, fill, "font-size": size, "text-anchor": "middle" }, t);
  };
  const side = labelSides(an);
  const place = (x, y, dir, t, fill, size) => {
    const half = t.length * size * 0.3;
    if (dir === "top") return label(x, y - 10, t, fill, size);
    if (dir === "bottom") return label(x, y + size + 8, t, fill, size);
    return label(dir === "right" ? x + 10 + half : x - 10 - half, y + 4, t, fill, size);
  };

  const step = niceStep(2 * ext);
  const grid = el("g", { stroke: "#1e2731", "stroke-width": 1 });
  for (let v = -Math.floor(ext / step) * step; v <= ext; v += step) {
    grid.append(el("line", { x1: X(v), y1: 0, x2: X(v), y2: H }), el("line", { x1: 0, y1: Y(v), x2: W, y2: Y(v) }));
  }
  svg.append(grid,
    el("line", { x1: X(0), y1: 0, x2: X(0), y2: H, stroke: "#33414f" }), el("line", { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: "#33414f" }),
    el("text", { x: W - 14, y: 20, fill: "#8b98a5", "font-size": 12, "text-anchor": "middle" }, "N"),
    el("path", { d: `M ${W - 14} 24 l -5 12 l 5 -3 l 5 3 z`, fill: "#8b98a5" }));
  $("plotScale").textContent = `grid ${step >= 1 ? step : step.toFixed(2)} m` + (k !== 1 && an.plan ? ` - offsets from plan drawn x${k}` : "");

  const [ia, ib] = state.ids;
  const A = items.find((i) => i.label === ia), B = items.find((i) => i.label === ib);
  if (A && B) {
    svg.append(el("line", { x1: X(A.e), y1: Y(A.n), x2: X(B.e), y2: Y(B.n), stroke: "#e6edf3", "stroke-width": 1.5 }));
    if (Number.isFinite(an.pair.horizM)) {
      svg.append(place(X(A.e) + 0.4 * (X(B.e) - X(A.e)), Y(A.n) + 0.4 * (Y(B.n) - Y(A.n)), side.line,
        `${an.pair.horizM.toFixed(3)} m · ${an.pair.enuBearingAB.toFixed(2)}°`, "#e6edf3", 12));
    }
  }
  for (const p of planned) {
    const it = items.find((i) => i.label === p.of);
    if (it) svg.append(el("line", { x1: X(it.e), y1: Y(it.n), x2: X(p.e), y2: Y(p.n), stroke: p.color, "stroke-dasharray": "4 3", "stroke-width": 1.5 }));
    svg.append(el("circle", { cx: X(p.e), cy: Y(p.n), r: 7, fill: "none", stroke: p.color, "stroke-dasharray": "3 2", "stroke-width": 1.5 }),
      place(X(p.e), Y(p.n), side.plan, p.label, "#8b98a5", 11));
  }
  for (const p of items) {
    svg.append(el("circle", { cx: X(p.e), cy: Y(p.n), r: p.label === "origin" ? 4 : p.small ? 5 : 6, fill: p.color }),
      place(X(p.e), Y(p.n), side.main, p.label, p.color, 12));
  }
  if (rover) {
    svg.append(el("circle", { cx: X(rover.e), cy: Y(rover.n), r: 6, fill: COLORS.live, stroke: "#fff", "stroke-width": 1.5 }),
      place(X(rover.e), Y(rover.n) + (side.rover === "right" ? 14 : 0), side.rover, "rover", COLORS.live, 12));
  }
}
$("exag").onchange = () => update();
window.addEventListener("resize", () => update());

// ================================================================ aiming (north alignment)

async function copyText(text, btn) {
  const label = btn.textContent;
  try {
    if (A) A.copy(text); else await navigator.clipboard.writeText(text);
    btn.textContent = "copied";
  }
  catch (e) { btn.textContent = "copy failed"; }
  setTimeout(() => { btn.textContent = label; }, 1500);
}

function renderAim(an) {
  const cams = state.ids.filter((id) => an.sightings[id]);
  if (!cams.length) { $("aimOut").replaceChildren(el("div", { class: "empty" }, "Needs the origin and a camera.")); return; }
  const nodes = [];
  for (const id of cams) {
    const rows = an.sightings[id].map((s) => {
      const b = el("button", { class: "secondary" }, "copy");
      b.onclick = () => copyText(s.csv, b);
      return [s.name, deg(s.azDeg, 3), signed(s.elDeg, 3, "°"), `${s.horizM.toFixed(1)} m`, s.sigmaMrad != null ? `±${s.sigmaMrad.toFixed(2)}` : "-",
        el("span", {}, [el("code", {}, s.csv), " ", b])];
    });
    nodes.push(el("h4", {}, [el("span", { class: "dot", style: `background:${colorOf(id)};margin-right:6px` }), `from ${id}`]));
    nodes.push(rows.length ? table(["target", "az (true)", "el", "distance", "mrad", "ref_lat,ref_lon,ref_alt"], rows)
      : el("div", { class: "empty" }, "add reference points (or the other pole) to aim at"));
  }
  nodes.push(el("div", { class: "note" }, "az/el are what the tracker computes for that camera (from its origin_e/n/u, mount included). " +
    "mrad = how much the two survey spreads alone could shift that bearing; under ~0.2 is good."));
  $("aimOut").replaceChildren(...nodes);
}

// ================================================================ live rover (from the console tab)

// From the console in this browser (BroadcastChannel), any device through
// the relay (watch link), or the Android app hosting this page.
let live = null;
function setLive(m) {
  if (!m || m.type !== "pvt" || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
  live = { ...m, receivedAt: Date.now() - (m.age_s || 0) * 1000, fresh: true };
  update();
}
const liveChannel = "BroadcastChannel" in window ? new BroadcastChannel("gnss-live") : null;
if (liveChannel) {
  liveChannel.onmessage = (ev) => setLive(ev.data);
  window.addEventListener("pagehide", () => liveChannel.close());
}
setInterval(() => { if (live && live.fresh && Date.now() - live.receivedAt > 4000) { live.fresh = false; update(); } }, 1000);

function targets(an, site) {
  const t = [];
  if (an.plan && an.frame) for (const id of state.ids) t.push({ key: `plan:${id}`, text: `${id} (planned)`, enu: an.plan.planned[id] });
  for (const id of state.ids) if (an.poles[id]) t.push({ key: `pole:${id}`, text: `${id} (surveyed)`, geo: an.poles[id].antenna });
  for (const r of site.refs) t.push({ key: `ref:${r.name}`, text: `${r.name} (reference)`, geo: r });
  if (site.origin) t.push({ key: "origin", text: "origin", geo: site.origin });
  return t;
}

function renderLive(an, site) {
  const ts = targets(an, site), sel = $("target"), keys = ts.map((t) => t.key).join("|");
  if (sel.dataset.keys !== keys) {
    const prev = sel.value;
    sel.replaceChildren(...ts.map((t) => el("option", { value: t.key }, t.text)));
    sel.dataset.keys = keys;
    if (ts.some((t) => t.key === prev)) sel.value = prev;
  }
  const out = $("liveOut");
  if (!live) { out.textContent = `waiting for a rover on channel "${state.channel}" (web console or Android app, Live monitor or a point survey running)...`; return; }
  const age = ((Date.now() - live.receivedAt) / 1000).toFixed(1);
  const fixed = live.carrSoln === 2;
  const lines = [
    el("div", { class: live.fresh ? (fixed ? "fix-true" : "fix-false") : "stale" }, live.fresh
      ? `FIX=${fixed}  ${["no RTK", "RTK FLOAT", "RTK FIXED"][live.carrSoln] ?? "?"}  hAcc=${fmt(live.hAccM, 3)} m  sv=${live.numSv ?? "?"}  (${age}s ago)`
      : `no rover update for ${age}s - is the console's Live monitor still running?`),
    el("div", {}, `rover${live.source ? ` (${live.source})` : ""}: lat ${live.lat.toFixed(9)}  lon ${live.lon.toFixed(9)}  h ${fmt(live.h, 3)} m`),
  ];
  const t = ts.find((x) => x.key === sel.value);
  if (!t) {
    lines.push(el("div", {}, "pick a target (needs points or a plan)"));
  } else {
    let de, dn, du = null;
    if (t.geo) { // offsets in the local level frame at the target
      const r = new window.Wgs84.LocalFrame(t.geo.lat, t.geo.lon, t.geo.h).geodeticToEnu(live.lat, live.lon, live.h);
      de = -r[0]; dn = -r[1]; du = -r[2];
    } else { // a planned spot: in the tracker's frame
      const r = an.frame.geodeticToEnu(live.lat, live.lon, live.h);
      de = t.enu[0] - r[0]; dn = t.enu[1] - r[1];
    }
    lines.push(el("div", { class: "big" }, `${t.text}: ${C.vectorText(de, dn)}`));
    if (du != null) lines.push(el("div", {}, `target is ${Math.abs(du).toFixed(3)} m ${du >= 0 ? "above" : "below"} the rover antenna`));
    if (!fixed) lines.push(el("div", { class: "fix-false" }, "not RTK FIXED - directions are only metre-level right now"));
  }
  out.replaceChildren(...lines);
}
$("target").onchange = () => update();

// ================================================================ cameras.local.yaml

const cfg = { text: null, name: null, handle: null, pending: null };

function cfgMsg(t, kind) { $("cfgMsg").textContent = t; $("cfgMsg").className = "msg" + (kind ? " " + kind : ""); }

function setConfig(text, name, handle) {
  Object.assign(cfg, { text, name, handle, pending: null });
  const c = C.parseConfig(text);
  if (c.ids.slice(0, 2).join() !== state.ids.join()) {
    state.ids = c.ids.slice(0, 2);
    for (const l of labels()) state.points[l] = Object.assign(blankPoint(), state.points[l] || {});
    save(); buildForms();
  }
  const hasOrigin = !!(c.origin.lat || c.origin.lon);
  cfgMsg(`${name}: cameras ${c.ids.join(", ")}; pole_distance_m ${c.poleDistanceM}; ` +
    (hasOrigin ? `origin ${c.origin.lat}, ${c.origin.lon}` : "origin not set yet"));
  $("cfgWrite").disabled = false;
  $("cfgReadPoints").style.display = hasOrigin ? "" : "none";
  $("cfgChanges").replaceChildren();
  $("cfgSaveRow").style.display = "none";
  update();
}

$("cfgOpen").onclick = async () => {
  if (A) { A.openConfig(); return; } // Android file picker; answers via siteAndroid.configOpened
  if (!window.showOpenFilePicker) { $("cfgFile").click(); return; } // no File System Access API: open, then download
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: [{ description: "YAML settings", accept: { "text/yaml": [".yaml", ".yml"] } }] });
  } catch (e) { if (e.name !== "AbortError") cfgMsg("could not open: " + e.message, "bad"); return; }
  const f = await handle.getFile();
  setConfig(await f.text(), f.name, handle);
};
$("cfgFile").onchange = async () => {
  const f = $("cfgFile").files[0];
  if (f) setConfig(await f.text(), f.name, null);
  $("cfgFile").value = "";
};
$("cfgUsePaste").onclick = () => {
  if (!$("cfgPaste").value.trim()) { cfgMsg("paste the file first", "bad"); return; }
  setConfig($("cfgPaste").value, "pasted text", null);
};

$("cfgWrite").onclick = () => {
  const site = siteInput();
  try {
    const r = C.applyToConfig(cfg.text, C.analyzeSite(site, state.ids), site.origin);
    cfg.pending = r.text;
    const changes = C.configChanges(cfg.text, r.text);
    $("cfgChanges").replaceChildren(changes.length
      ? table(["line", "now in the file", "after"], changes.map((c) => [String(c.line), c.before, c.after]), { num: false, rowClass: "changed" })
      : el("div", { class: "empty" }, "the file already holds exactly these values"));
    $("cfgSaveRow").style.display = changes.length ? "flex" : "none";
    $("cfgSave").hidden = !cfg.handle;
    const missing = state.ids.filter((i) => !r.written.includes(i));
    cfgMsg(`${changes.length} line(s) will change` + (missing.length ? ` - ${missing.join(", ")} not surveyed yet, left as is` : "") +
      (cfg.handle ? "" : " - download it and put it at hawk_nest/config/cameras.local.yaml"));
  } catch (e) {
    cfgMsg("could not write: " + e.message, "bad");
  }
};

$("cfgSave").onclick = async () => {
  if (A) { cfgMsg("saving..."); A.saveConfig(cfg.pending); return; } // answers via siteAndroid.configSaved
  try {
    const w = await cfg.handle.createWritable();
    await w.write(cfg.pending);
    await w.close();
    const back = await (await cfg.handle.getFile()).text(); // read back what is on disk
    if (back !== cfg.pending) throw new Error("the file on disk doesn't match after saving");
    cfg.text = back; cfg.pending = null;
    $("cfgSaveRow").style.display = "none";
    cfgMsg(`saved ${cfg.name} and read it back - it holds the survey now`, "good");
  } catch (e) {
    cfgMsg(`could not save (${e.message}) - use Download instead`, "bad");
  }
};
$("cfgDownload").onclick = () => {
  if (A) { A.saveConfigAs(cfg.pending); return; }
  const a = el("a", { href: URL.createObjectURL(new Blob([cfg.pending], { type: "text/yaml" })), download: "cameras.local.yaml" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("cfgCopy").onclick = () => copyText(cfg.pending, $("cfgCopy"));

$("cfgReadPoints").onclick = () => {
  const c = C.parseConfig(cfg.text);
  const pts = C.pointsFromConfig(c);
  const put = (p, v, src) => Object.assign(p, { lat: v.lat.toFixed(9), lon: v.lon.toFixed(9), h: v.h.toFixed(4), src, sigma: null, allFixed: undefined });
  if (pts.origin) put(state.points.origin, pts.origin, `from ${cfg.name}`);
  for (const id of state.ids) {
    if (pts.poles[id]) { put(state.points[id], pts.poles[id], `from ${cfg.name} (origin_u includes any mount height)`); state.points[id].mount = "0"; }
  }
  if (c.poleDistanceM > 0) {
    state.plan = { dist: String(c.poleDistanceM), bearing: String(c.poleLineBearingDeg ?? "") };
    $("planDist").value = state.plan.dist; $("planBearing").value = state.plan.bearing; $("planBox").open = true;
  }
  mapFitted = false;
  save(); buildForms(); update();
};

// ================================================================ refresh

function update() {
  const site = siteInput();
  const an = C.analyzeSite(site, state.ids);
  renderPair(an);
  $("warnings").replaceChildren(...an.warnings.map((w) => el("div", { class: "warn" }, "⚠ " + w)));
  renderPlan(an);
  renderAim(an);
  renderLive(an, site);
  drawMap(an, site);
  drawPlot(an, site);
  $("snippet").textContent = C.configSnippet(an, site.origin);
}

// ================================================================ Android app hooks

window.siteAndroid = {
  pvt: (m) => setLive(m),
  // the app's channel changed (Survey tab)
  useChannel: (ch) => { if (ch && ch !== state.channel) { $("channel").value = ch; useChannel(ch); } },
  resultsChanged: () => syncNow(),
  configOpened: (name, text) => setConfig(text, name, "android"),
  configError: (msg) => cfgMsg(msg, "bad"),
  configSaved: (ok, msg) => {
    if (!ok) { cfgMsg(`could not save (${msg})`, "bad"); return; }
    cfg.text = cfg.pending; cfg.pending = null;
    $("cfgSaveRow").style.display = "none";
    cfgMsg(msg || `saved ${cfg.name} and read it back - it holds the survey now`, "good");
  },
};

if (A) document.querySelector(".nav").hidden = true; // in the app, the console is the Survey tab

initMap();
buildForms();
useChannel(startChannel);
setView(state.view === "plot" || !map ? "plot" : "map"); // no map library (offline): the exact plot
