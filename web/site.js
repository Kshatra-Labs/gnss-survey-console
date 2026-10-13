// Site map page: pole distance/bearing, map, exact site plot, plan
// corrections, live rover stakeout and cameras.local.yaml writing.
const $ = (id) => document.getElementById(id);
const C = window.SiteCalc;

const STATE_KEY = "gnss_site_v1";
const RESULTS_KEY = "gnss_survey_results"; // written by the Survey console (app.js)
const COLORS = { origin: "#e6edf3", a: "#35c46b", b: "#f08a3c", live: "#4fa3ff", plan: "#c9d1d9" };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: this tab only */ } },
};

const blankPoint = () => ({ lat: "", lon: "", h: "", mount: "", sigma: "", src: "" });
let state = Object.assign({ ids: ["camera_a", "camera_b"], points: {}, plan: { dist: "", bearing: "" }, decl: "" }, store.get(STATE_KEY) || {});
const labels = () => ["origin", ...state.ids];
for (const l of labels()) state.points[l] = Object.assign(blankPoint(), state.points[l] || {});

const num = (s) => {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const t = String(s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const fmt = (v, d) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d));
const deg = (v, d = 3) => (Number.isFinite(v) ? `${v.toFixed(d)}°` : "-");
const colorOf = (l) => (l === "origin" ? COLORS.origin : l === state.ids[0] ? COLORS.a : COLORS.b);

function el(tag, attrs = {}, text) {
  const svg = ["svg", "line", "circle", "text", "path", "g", "rect", "polygon"].includes(tag) && attrs.svg !== false;
  const e = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k !== "svg" && v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- inputs

function buildForms() {
  const host = $("pointForms");
  host.replaceChildren();
  for (const l of labels()) {
    const p = state.points[l];
    const box = el("div", { class: "pt", svg: false });
    const h3 = el("h3", { svg: false });
    h3.append(el("span", { class: "dot", style: `background:${colorOf(l)}`, svg: false }), document.createTextNode(l));
    box.append(h3);
    const field = (key, label, ph) => {
      const w = el("div", { svg: false });
      const id = `pt_${l}_${key}`;
      w.append(el("label", { for: id, svg: false }, label));
      const inp = el("input", { id, inputmode: "decimal", placeholder: ph, svg: false });
      inp.value = p[key];
      inp.addEventListener("input", () => {
        p[key] = inp.value;
        if (!p.src) p.src = "entered by hand";
        else if (!p.src.endsWith("(edited)") && p.src !== "entered by hand") p.src += " (edited)";
        save(); update();
      });
      w.append(inp);
      return w;
    };
    const r1 = el("div", { class: "row", svg: false });
    r1.append(field("lat", "lat (°)", "12.97159870"), field("lon", "lon (°)", "77.59456270"));
    const r2 = el("div", { class: "row", svg: false });
    r2.append(field("h", "height MSL (m)", "920.000"));
    if (l !== "origin") r2.append(field("mount", "mount (m)", "0"), field("sigma", "σ (m)", "spread"));
    box.append(r1, r2, el("div", { class: "src" + (/fix=false/.test(p.src) ? " bad" : ""), id: `src_${l}`, svg: false }, p.src));
    host.append(box);
  }
}

function setPoint(l, v, src) {
  const p = state.points[l] = state.points[l] || blankPoint();
  p.lat = v.lat.toFixed(9); p.lon = v.lon.toFixed(9); p.h = v.h.toFixed(4); // 0.1 mm
  if (l !== "origin") {
    if (v.mount != null) p.mount = String(v.mount);
    if (v.sigma != null) p.sigma = v.sigma.toFixed(3);
  }
  p.allFixed = v.allFixed;
  p.src = src;
}

function surveyResults() { return store.get(RESULTS_KEY) || {}; }

function showSurveyNote() {
  const r = surveyResults();
  const have = labels().filter((l) => r[l]);
  const extra = Object.keys(r).filter((l) => !labels().includes(l));
  let t = have.length ? `survey results in this browser: ${have.map((l) => `${l} (${new Date(r[l].at).toLocaleString()})`).join(", ")}`
    : "no survey results in this browser yet - survey origin and the poles on the Survey console first, or type the values";
  if (extra.length) t += `; other labels not shown here: ${extra.join(", ")}`;
  $("surveyNote").textContent = t;
}

$("loadSurvey").onclick = () => {
  const r = surveyResults();
  let n = 0;
  for (const l of labels()) {
    const s = r[l];
    if (!s) continue;
    setPoint(l, { lat: s.lat_deg, lon: s.lon_deg, h: s.height_msl_m, sigma: s.spread_m, allFixed: s.all_fixed },
      `survey ${new Date(s.at).toLocaleString()}: ${s.n} epochs, spread ${s.spread_m.toFixed(3)} m, fix=${s.all_fixed}`);
    n++;
  }
  $("surveyNote").textContent = n ? `loaded ${n} survey result(s)` : "no survey results for origin / " + state.ids.join(" / ") + " in this browser yet";
  save(); buildForms(); update(true);
};

$("clearPoints").onclick = () => {
  if (!confirm("Clear all point values on this page? (Survey results stay saved.)")) return;
  for (const l of labels()) state.points[l] = blankPoint();
  save(); buildForms(); update();
};

for (const [id, key] of [["planDist", "dist"], ["planBearing", "bearing"]]) {
  $(id).value = state.plan[key];
  $(id).addEventListener("input", () => { state.plan[key] = $(id).value; save(); update(); });
}
$("decl").value = state.decl;
$("decl").addEventListener("input", () => { state.decl = $("decl").value; save(); update(); });

function save() { store.set(STATE_KEY, state); }

function siteInput() {
  const pt = (l) => {
    const p = state.points[l];
    if (!p) return null;
    const v = { lat: num(p.lat), lon: num(p.lon), h: num(p.h), mount: num(p.mount) ?? 0, sigma: num(p.sigma), allFixed: p.allFixed };
    return v.lat == null || v.lon == null || v.h == null ? null : v;
  };
  const poles = {};
  for (const id of state.ids) poles[id] = pt(id);
  return {
    origin: pt("origin"),
    poles,
    plan: num(state.plan.dist) != null && num(state.plan.bearing) != null ? { distanceM: num(state.plan.dist), bearingDeg: num(state.plan.bearing) } : null,
    declinationDeg: num(state.decl),
  };
}

// ---------------------------------------------------------------- results

function kpi(k, v, s) {
  const d = el("div", { class: "kpi", svg: false });
  d.append(el("div", { class: "k", svg: false }, k), el("div", { class: "v", svg: false }, v));
  if (s) d.append(el("div", { class: "s", svg: false }, s));
  return d;
}

function renderPair(an) {
  const host = $("pairOut");
  const [ia, ib] = state.ids;
  if (!an.pair) {
    host.replaceChildren(el("div", { class: "empty", svg: false }, `Enter or load both ${ia} and ${ib} to see distance and bearing.`));
    return;
  }
  const p = an.pair;
  const sig = Number.isFinite(p.bearingSigmaDeg) ? `±${p.bearingSigmaDeg.toFixed(3)}° (${(p.bearingSigmaDeg * Math.PI / 0.18).toFixed(2)} mrad) from the survey spreads` : "add σ for an uncertainty";
  const grid = el("div", { class: "kpis", svg: false });
  grid.append(
    kpi("Ground distance", Number.isFinite(p.horizM) ? `${p.horizM.toFixed(3)} m` : `${p.geodesicM.toFixed(3)} m`,
      Number.isFinite(p.horizM) ? `ellipsoid ${p.geodesicM.toFixed(3)} m` : "survey the origin for the tracker's frame"),
    kpi(`Bearing ${ia} → ${ib}`, deg(p.trueBearingAB), `true north; ${sig}`),
    kpi(`Bearing ${ib} → ${ia}`, deg(p.trueBearingBA), "true north"),
    kpi("Height difference", `${p.dHeightM >= 0 ? "+" : ""}${p.dHeightM.toFixed(3)} m`, `${ib}'s camera above ${ia}'s`),
  );
  if (Number.isFinite(p.slopeM)) grid.append(kpi("Camera-to-camera", `${p.slopeM.toFixed(3)} m`, "straight line, incl. height"));
  grid.append(
    kpi(`Tilt ${ia} → ${ib}`, `${p.sightAB.elDeg >= 0 ? "+" : ""}${deg(p.sightAB.elDeg)}`, `camera-to-camera elevation; az ${deg(p.sightAB.azDeg)}`),
    kpi(`Tilt ${ib} → ${ia}`, `${p.sightBA.elDeg >= 0 ? "+" : ""}${deg(p.sightBA.elDeg)}`, `camera-to-camera elevation; az ${deg(p.sightBA.azDeg)}`),
  );
  if (Number.isFinite(p.magneticBearingAB)) {
    grid.append(kpi("Magnetic bearing", `${deg(p.magneticBearingAB, 1)} / ${deg(p.magneticBearingBA, 1)}`, `${ia}→${ib} / ${ib}→${ia}, compass`));
  }
  const nodes = [grid];
  if (Number.isFinite(p.enuBearingAB)) {
    nodes.push(el("div", { class: "note", svg: false },
      `In the tracker's frame (ENU at origin) the line runs ${deg(p.enuBearingAB)} - the value for pole_line_bearing_deg; ` +
      `it differs from the true bearing at ${ia} by ${(C.wrap180(p.enuBearingAB - p.trueBearingAB) * 3600).toFixed(2)}″ (meridian convergence).`));
  }

  const rows = [];
  for (const l of labels()) {
    const r = l === "origin" ? null : an.poles[l];
    if (l === "origin") {
      if (an.frame) rows.push([l, "0.0000", "0.0000", "0.0000", "-", "-"]);
      continue;
    }
    if (!r) continue;
    rows.push([l, r.enu ? fmt(r.enu[0], 4) : "-", r.enu ? fmt(r.enu[1], 4) : "-", r.enu ? fmt(r.enu[2], 4) : "-",
      r.fromOrigin ? fmt(r.fromOrigin.distanceM, 3) : "-", r.fromOrigin ? deg(r.fromOrigin.bearingDeg, 2) : "-"]);
  }
  if (rows.length) {
    const wrap = el("div", { class: "tablewrap", svg: false });
    const t = el("table", { svg: false });
    const hr = el("tr", { svg: false });
    for (const h of ["", "origin_e", "origin_n", "origin_u", "from origin (m)", "bearing"]) hr.append(el("th", { svg: false }, h));
    t.append(hr);
    for (const r of rows) {
      const tr = el("tr", { svg: false });
      r.forEach((c, i) => tr.append(el("td", { class: i ? "num" : "", svg: false }, c)));
      t.append(tr);
    }
    wrap.append(t);
    nodes.push(wrap);
    if (!an.frame) nodes.push(el("div", { class: "note", svg: false }, "origin_e/n/u need the origin - survey or enter it."));
  }
  host.replaceChildren(...nodes);
}

function renderWarnings(an) {
  $("warnings").replaceChildren(...an.warnings.map((w) => el("div", { class: "warn", svg: false }, "⚠ " + w)));
}

function renderPlan(an) {
  const host = $("planOut");
  if (!an.plan) { host.replaceChildren(el("div", { class: "empty", svg: false }, "Fill in the plan to see how far each pole is from it.")); return; }
  const pl = an.plan, nodes = [];
  if (!an.frame) { host.replaceChildren(el("div", { class: "empty", svg: false }, "Corrections are measured from the origin - survey or enter it first.")); return; }
  if (Number.isFinite(pl.distanceErrorM)) {
    const g = el("div", { class: "kpis", svg: false });
    g.append(
      kpi("Distance vs plan", `${pl.distanceErrorM >= 0 ? "+" : ""}${pl.distanceErrorM.toFixed(3)} m`, `surveyed ${an.pair.horizM.toFixed(3)} m, plan ${pl.distanceM} m`),
      kpi("Bearing vs plan", `${pl.bearingErrorDeg >= 0 ? "+" : ""}${pl.bearingErrorDeg.toFixed(3)}°`, `surveyed ${an.pair.enuBearingAB.toFixed(3)}°, plan ${pl.bearingDeg}°`),
    );
    nodes.push(g);
  }
  for (const id of state.ids) {
    const m = pl.moves[id];
    if (!m) continue;
    const d = el("div", { class: "move", svg: false });
    d.append(el("span", { class: "dot", style: `background:${colorOf(id)};margin-right:6px`, svg: false }), document.createTextNode(`To match the plan, move ${id}: `), el("b", { svg: false }, m.text));
    nodes.push(d);
  }
  nodes.push(el("div", { class: "note", svg: false },
    "Or leave the poles where they are and write the surveyed positions into the config (panel on the left) - " +
    "with pole_distance_m: 0.0 the tracker uses them exactly, so the plan no longer matters."));
  host.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- map

let map = null, mapLayer = null, mapFitted = false;

// Where labels go, so they stay off the pole line and off each other: above/
// below an east-west line, left/right of a north-south one.
const OFFSETS = { top: [0, -8], bottom: [0, 8], right: [8, 0], left: [-8, 0] };
function labelSides(an) {
  const b = an.pair ? (Number.isFinite(an.pair.enuBearingAB) ? an.pair.enuBearingAB : an.pair.trueBearingAB) : NaN;
  if (Number.isFinite(b) && Math.abs(Math.sin((b * Math.PI) / 180)) >= Math.SQRT1_2) {
    return { main: "top", plan: "bottom", line: "bottom", rover: "right" };
  }
  return { main: "right", plan: "left", line: "left", rover: "bottom" };
}
function initMap() {
  if (typeof L === "undefined") {
    $("map").style.display = "none";
    $("mapNote").textContent = "Map tiles/library didn't load (offline?) - the numbers and the site plot below still work.";
    $("fitMap").style.display = "none";
    return;
  }
  try {
    map = L.map("map", { zoomControl: true, maxZoom: 23 });
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, maxZoom: 23, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    });
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19, maxZoom: 23, attribution: "&copy; OpenStreetMap contributors",
    });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Street: osm }, null, { position: "topright" }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    map.setView([20, 78], 4);
    mapLayer = L.layerGroup().addTo(map);
  } catch (e) {
    map = null;
    $("map").style.display = "none";
    $("mapNote").textContent = "Map unavailable here (" + e.message + ") - the numbers and the site plot still work.";
  }
}

function drawMap(an, site) {
  if (!map) return;
  mapLayer.clearLayers();
  const pts = [];
  const side = labelSides(an);
  const mark = (lat, lon, color, label, hollow) => {
    const m = L.circleMarker([lat, lon], { radius: hollow ? 7 : 6, color, weight: 2, fillColor: color, fillOpacity: hollow ? 0 : 0.9, dashArray: hollow ? "3 3" : null });
    // planned positions labelled on the left so they don't sit on top of the surveyed pole's label
    const dir = hollow ? side.plan : side.main;
    m.bindTooltip(label, { permanent: true, direction: dir, className: "lbl", offset: OFFSETS[dir] });
    m.addTo(mapLayer);
    pts.push([lat, lon]);
  };
  if (site.origin) mark(site.origin.lat, site.origin.lon, COLORS.origin, "origin");
  for (const id of state.ids) {
    const p = an.poles[id];
    if (p) mark(p.antenna.lat, p.antenna.lon, colorOf(id), id);
  }
  const [ia, ib] = state.ids;
  if (an.pair) {
    const a = an.poles[ia].antenna, b = an.poles[ib].antenna;
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#ffffff", weight: 2, opacity: 0.9 }).addTo(mapLayer);
    // label 40% along the line: the midpoint is usually where the origin is
    L.tooltip({ permanent: true, direction: side.line, className: "lbl", offset: OFFSETS[side.line] })
      .setLatLng([a.lat + 0.4 * (b.lat - a.lat), a.lon + 0.4 * (b.lon - a.lon)])
      .setContent(`${(an.pair.horizM ?? an.pair.geodesicM).toFixed(3)} m · ${an.pair.trueBearingAB.toFixed(3)}°`)
      .addTo(mapLayer);
  }
  if (an.plan && an.frame) {
    for (const id of state.ids) {
      const [e, n] = an.plan.planned[id];
      const [lat, lon] = an.frame.enuToGeodetic(e, n, 0);
      mark(lat, lon, colorOf(id), `${id} plan`, true);
      const p = an.poles[id];
      if (p) L.polyline([[p.antenna.lat, p.antenna.lon], [lat, lon]], { color: colorOf(id), weight: 2, dashArray: "4 4" }).addTo(mapLayer);
    }
  }
  if (live && live.fresh) {
    L.circleMarker([live.lat, live.lon], { radius: 6, color: "#fff", weight: 2, fillColor: COLORS.live, fillOpacity: 1 })
      .bindTooltip("rover", { permanent: true, direction: side.rover, className: "lbl", offset: OFFSETS[side.rover] }).addTo(mapLayer);
  }
  if (pts.length && !mapFitted) fitMap(pts);
}

function fitMap(pts) {
  if (!map || !pts.length) return;
  mapFitted = true;
  if (pts.length === 1) map.setView(pts[0], 20);
  else map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 21 });
}
$("fitMap").onclick = () => {
  const site = siteInput(), pts = [];
  if (site.origin) pts.push([site.origin.lat, site.origin.lon]);
  for (const id of state.ids) if (site.poles[id]) pts.push([site.poles[id].lat, site.poles[id].lon]);
  fitMap(pts);
};

// ---------------------------------------------------------------- site plot (SVG, metres)

function niceStep(span) {
  const raw = span / 6, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function drawPlot(an) {
  const svg = $("plot");
  svg.replaceChildren();
  const W = svg.clientWidth || 600, H = svg.clientHeight || 360;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!an.frame) {
    svg.append(el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "#8b98a5", "font-size": 13 }, "survey or enter the origin to draw the site in metres"));
    $("plotScale").textContent = "";
    return;
  }
  const k = Number($("exag").value) || 1;
  const items = [{ label: "origin", e: 0, n: 0, color: COLORS.origin }];
  const planned = [];
  for (const id of state.ids) {
    const p = an.poles[id];
    const plan = an.plan && an.plan.planned[id];
    if (plan) planned.push({ label: `${id} plan`, e: plan[0], n: plan[1], color: colorOf(id) });
    if (!p) continue;
    let [e, n] = p.enuAntenna;
    if (plan && k !== 1) { e = plan[0] + k * (e - plan[0]); n = plan[1] + k * (n - plan[1]); }
    items.push({ label: id, e, n, color: colorOf(id), real: p.enuAntenna });
  }
  let liveItem = null;
  if (live && live.fresh) {
    const [e, n] = an.frame.geodeticToEnu(live.lat, live.lon, live.h);
    liveItem = { label: "rover", e, n, color: COLORS.live };
  }
  const all = [...items, ...planned, ...(liveItem ? [liveItem] : [])];
  let ext = Math.max(1, ...all.map((p) => Math.max(Math.abs(p.e), Math.abs(p.n))));
  ext *= 1.25;
  const pad = 24, s = Math.min(W - 2 * pad, H - 2 * pad) / (2 * ext);
  const X = (e) => W / 2 + e * s, Y = (n) => H / 2 - n * s;

  // centred labels, pulled inwards near the edges so they never get clipped
  const label = (x, y, t, fill, size) => {
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
  const g = el("g", { stroke: "#1e2731", "stroke-width": 1 });
  for (let v = -Math.floor(ext / step) * step; v <= ext; v += step) {
    g.append(el("line", { x1: X(v), y1: 0, x2: X(v), y2: H }), el("line", { x1: 0, y1: Y(v), x2: W, y2: Y(v) }));
  }
  svg.append(g);
  svg.append(el("line", { x1: X(0), y1: 0, x2: X(0), y2: H, stroke: "#33414f" }), el("line", { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: "#33414f" }));
  svg.append(el("text", { x: W - 14, y: 20, fill: "#8b98a5", "font-size": 12, "text-anchor": "middle" }, "N"),
    el("path", { d: `M ${W - 14} 24 l -5 12 l 5 -3 l 5 3 z`, fill: "#8b98a5" }));
  $("plotScale").textContent = `grid ${step >= 1 ? step : step.toFixed(2)} m` + (k !== 1 && an.plan ? ` - pole offsets from plan drawn x${k}` : "");

  const [ia, ib] = state.ids;
  const A = items.find((i) => i.label === ia), Bp = items.find((i) => i.label === ib);
  if (A && Bp) {
    svg.append(el("line", { x1: X(A.e), y1: Y(A.n), x2: X(Bp.e), y2: Y(Bp.n), stroke: "#e6edf3", "stroke-width": 1.5 }));
    if (an.pair && Number.isFinite(an.pair.horizM)) {
      const t = `${an.pair.horizM.toFixed(3)} m · ${an.pair.enuBearingAB.toFixed(2)}°`;
      const lx = X(A.e) + 0.4 * (X(Bp.e) - X(A.e)), ly = Y(A.n) + 0.4 * (Y(Bp.n) - Y(A.n));
      svg.append(place(lx, ly, side.line, t, "#e6edf3", 12)); // 40% along: the midpoint is usually the origin
    }
  }
  for (const p of planned) {
    const it = items.find((i) => i.label === p.label.replace(/ plan$/, ""));
    if (it) svg.append(el("line", { x1: X(it.e), y1: Y(it.n), x2: X(p.e), y2: Y(p.n), stroke: p.color, "stroke-dasharray": "4 3", "stroke-width": 1.5 }));
    svg.append(el("circle", { cx: X(p.e), cy: Y(p.n), r: 7, fill: "none", stroke: p.color, "stroke-dasharray": "3 2", "stroke-width": 1.5 }),
      place(X(p.e), Y(p.n), side.plan, p.label, "#8b98a5", 11));
  }
  for (const p of items) {
    svg.append(el("circle", { cx: X(p.e), cy: Y(p.n), r: p.label === "origin" ? 4 : 6, fill: p.color }),
      place(X(p.e), Y(p.n), side.main, p.label, p.color, 12));
  }
  if (liveItem) {
    svg.append(el("circle", { cx: X(liveItem.e), cy: Y(liveItem.n), r: 6, fill: COLORS.live, stroke: "#fff", "stroke-width": 1.5 }),
      place(X(liveItem.e), Y(liveItem.n) + (side.rover === "right" ? 14 : 0), side.rover, "rover", COLORS.live, 12));
  }
}
$("exag").onchange = () => update();
window.addEventListener("resize", () => update());

// ---------------------------------------------------------------- live rover (from the console tab)

let live = null;
const liveChannel = "BroadcastChannel" in window ? new BroadcastChannel("gnss-live") : null;
if (liveChannel) {
  liveChannel.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.type !== "pvt" || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return;
    live = Object.assign({}, m, { receivedAt: Date.now(), fresh: true });
    update();
  };
  window.addEventListener("pagehide", () => liveChannel.close());
} else {
  $("liveOut").textContent = "this browser can't share the rover between tabs (no BroadcastChannel)";
}
setInterval(() => {
  if (live && live.fresh && Date.now() - live.receivedAt > 4000) { live.fresh = false; update(); }
}, 1000);

function buildTargets(an) {
  const sel = $("target"), prev = sel.value;
  const opts = [];
  for (const id of state.ids) if (an.plan && an.frame) opts.push([`plan:${id}`, `${id} - planned position`]);
  for (const id of state.ids) if (an.poles[id]) opts.push([`pole:${id}`, `${id} - surveyed position`]);
  if (an.frame) opts.push(["origin", "origin"]);
  const key = opts.map((o) => o[0]).join("|");
  if (sel.dataset.key !== key) {
    sel.replaceChildren(...opts.map(([v, t]) => { const o = el("option", { value: v, svg: false }, t); return o; }));
    sel.dataset.key = key;
    if (opts.some((o) => o[0] === prev)) sel.value = prev;
  }
}
$("target").onchange = () => update();

function targetPoint(an) {
  const v = $("target").value;
  if (!v) return null;
  if (v === "origin") return an.frame ? { label: "origin", enu: [0, 0, 0] } : null;
  const [kind, id] = v.split(":");
  if (kind === "plan" && an.plan && an.frame) { const [e, n] = an.plan.planned[id]; return { label: `${id} (planned)`, enu: [e, n, null] }; }
  const p = an.poles[id];
  if (!p) return null;
  return { label: `${id} (surveyed)`, geo: p.antenna, enu: p.enuAntenna };
}

function renderLive(an) {
  const out = $("liveOut");
  if (!liveChannel) return;
  if (!live) { out.textContent = "waiting for the console's rover... (Survey console tab, rover connected, Live monitor running)"; return; }
  const age = ((Date.now() - live.receivedAt) / 1000).toFixed(1);
  const fixed = live.carrSoln === 2;
  out.replaceChildren();
  const head = el("div", { class: live.fresh ? (fixed ? "fix-true" : "fix-false") : "stale", svg: false },
    live.fresh ? `FIX=${fixed}  ${["no RTK", "RTK FLOAT", "RTK FIXED"][live.carrSoln] ?? "?"}  hAcc=${fmt(live.hAccM, 3)} m  sv=${live.numSv ?? "?"}  (${age}s ago)`
      : `no rover update for ${age}s - is the console's Live monitor still running?`);
  out.append(head, document.createTextNode(`rover: lat ${live.lat.toFixed(9)}  lon ${live.lon.toFixed(9)}  h ${fmt(live.h, 3)} m\n`));
  const t = targetPoint(an);
  if (!t) { out.append(document.createTextNode("pick a target (needs surveyed points or a plan)")); return; }
  let de, dn, du = null;
  if (an.frame) {
    const r = an.frame.geodeticToEnu(live.lat, live.lon, live.h);
    de = t.enu[0] - r[0]; dn = t.enu[1] - r[1];
    if (t.enu[2] != null) du = t.enu[2] - r[2];
  } else {
    const r = new window.Wgs84.LocalFrame(t.geo.lat, t.geo.lon, t.geo.h).geodeticToEnu(live.lat, live.lon, live.h);
    de = -r[0]; dn = -r[1]; du = -r[2];
  }
  out.append(el("div", { class: "big", svg: false }, `${t.label}: ${C.vectorText(de, dn)}`));
  if (du != null) out.append(el("div", { svg: false }, `target is ${Math.abs(du).toFixed(3)} m ${du >= 0 ? "above" : "below"} the rover antenna`));
  if (!fixed) out.append(el("div", { class: "fix-false", svg: false }, "not RTK FIXED - directions are only metre-level right now"));
}

// ---------------------------------------------------------------- cameras.local.yaml

function cfgMsg(t, bad) { $("cfgMsg").textContent = t; $("cfgMsg").className = "src" + (bad ? " bad" : ""); }

$("cfgRead").onclick = () => {
  const text = $("cfgIn").value;
  if (!text.trim()) { cfgMsg("paste the file first", true); return; }
  const cfg = C.parseConfig(text);
  state.ids = cfg.ids.slice(0, 2);
  const pts = C.pointsFromConfig(cfg);
  for (const l of labels()) if (!state.points[l]) state.points[l] = blankPoint();
  if (pts.origin) setPoint("origin", pts.origin, "from cameras.local.yaml");
  for (const id of state.ids) if (pts.poles[id]) setPoint(id, Object.assign(pts.poles[id], { mount: 0 }), "from cameras.local.yaml (origin_u includes any mount height)");
  if (cfg.poleDistanceM != null) state.plan.dist = String(cfg.poleDistanceM);
  if (cfg.poleLineBearingDeg != null) state.plan.bearing = String(cfg.poleLineBearingDeg);
  $("planDist").value = state.plan.dist; $("planBearing").value = state.plan.bearing;
  const n = Object.keys(pts.poles).length;
  cfgMsg(pts.origin
    ? `read origin + ${n} pole(s) (cameras: ${cfg.ids.join(", ")}; pole_distance_m=${cfg.poleDistanceM})` +
      (cfg.poleDistanceM > 0 ? " - the tracker is using the tape-measure plan, so origin_e/n there are ignored" : "")
    : `origin is still 0.0 in that file - nothing surveyed yet (cameras: ${cfg.ids.join(", ")})`, !pts.origin);
  mapFitted = false;
  save(); buildForms(); update();
};

let lastOut = "";
$("cfgWrite").onclick = () => {
  const text = $("cfgIn").value;
  if (!text.trim()) { cfgMsg("paste the file first", true); return; }
  const site = siteInput();
  const an = C.analyzeSite(site, state.ids);
  try {
    const r = C.applyToConfig(text, an, site.origin);
    lastOut = r.text;
    $("cfgOut").value = r.text;
    $("cfgOutWrap").style.display = "block";
    cfgMsg(`wrote origin${r.written.length ? " + " + r.written.join(", ") : " (no poles entered yet)"}` +
      (r.written.length ? " and pole_distance_m: 0.0" : "") + " - copy or download it over hawk_nest/config/cameras.local.yaml");
  } catch (e) {
    $("cfgOutWrap").style.display = "none";
    cfgMsg("could not write: " + e.message, true);
  }
};
$("cfgCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(lastOut); cfgMsg("copied"); }
  catch (e) { $("cfgOut").select(); cfgMsg("select-all done - press Ctrl+C"); }
};
$("cfgDownload").onclick = () => {
  const a = el("a", { href: URL.createObjectURL(new Blob([lastOut], { type: "text/yaml" })), download: "cameras.local.yaml", svg: false });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------------------------------------------------------------- refresh

function update() {
  const site = siteInput();
  const an = C.analyzeSite(site, state.ids);
  renderPair(an);
  renderWarnings(an);
  renderPlan(an);
  buildTargets(an);
  renderLive(an);
  drawMap(an, site);
  drawPlot(an);
  $("snippet").textContent = C.configSnippet(an, site.origin);
  for (const l of labels()) { const s = $(`src_${l}`); if (s) { s.textContent = state.points[l].src; s.className = "src" + (/fix=false/.test(state.points[l].src) ? " bad" : ""); } }
}

window.addEventListener("storage", (e) => { if (e.key === RESULTS_KEY) showSurveyNote(); });

initMap();
buildForms();
showSurveyNote();
update();
