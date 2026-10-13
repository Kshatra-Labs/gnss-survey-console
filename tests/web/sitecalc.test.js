// web/sitecalc.js + web/wgs84.js against reference vectors from geographiclib,
// PROJ and Ground_EO_Tracker's own code (tests/oracle/gen_site_vectors.py).
//   node --test tests/web/sitecalc.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const W = require("../../web/wgs84.js");
const C = require("../../web/sitecalc.js");

const V = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "oracle", "site_vectors.json"), "utf8"));
const angDiff = (a, b) => Math.abs(C.wrap180(a - b));

test("geodesic distance and azimuths match geographiclib", () => {
  let worstS = 0, worstAz = 0;
  for (const v of V.geodesic) {
    const r = C.inverse(v.lat1, v.lon1, v.lat2, v.lon2);
    const ds = Math.abs(r.distanceM - v.s12);
    worstS = Math.max(worstS, ds);
    worstAz = Math.max(worstAz, angDiff(r.azi1Deg, v.azi1), angDiff(r.azi2Deg, v.azi2));
    assert.ok(ds < 1e-6 + v.s12 * 1e-10, `distance ${r.distanceM} vs ${v.s12}`);
    assert.ok(angDiff(r.azi1Deg, v.azi1) < 1e-7 && angDiff(r.azi2Deg, v.azi2) < 1e-7, `azimuths ${r.azi1Deg}/${r.azi2Deg} vs ${v.azi1}/${v.azi2}`);
  }
  console.log(`  ${V.geodesic.length} pairs, worst distance error ${worstS.toExponential(2)} m, worst azimuth error ${worstAz.toExponential(2)} deg`);
});

test("coincident points don't produce garbage", () => {
  const r = C.inverse(12.97, 77.59, 12.97, 77.59);
  assert.equal(r.distanceM, 0);
  assert.ok(Number.isNaN(r.azi1Deg));
});

test("ECEF, ENU and the inverse ENU match PROJ", () => {
  let worst = 0;
  for (const v of V.frame) {
    const ecef = W.geodeticToEcef(...v.geo);
    ecef.forEach((x, i) => assert.ok(Math.abs(x - v.ecef[i]) < 1e-6, `ecef ${ecef} vs ${v.ecef}`));
    const back = W.ecefToGeodetic(...v.ecef);
    assert.ok(Math.abs(back[0] - v.geo[0]) < 1e-10 && Math.abs(back[1] - v.geo[1]) < 1e-10 && Math.abs(back[2] - v.geo[2]) < 1e-6, `geodetic ${back} vs ${v.geo}`);
    const f = new W.LocalFrame(...v.origin);
    const enu = f.geodeticToEnu(...v.geo);
    enu.forEach((x, i) => { worst = Math.max(worst, Math.abs(x - v.enu[i])); assert.ok(Math.abs(x - v.enu[i]) < 1e-6, `enu ${enu} vs ${v.enu}`); });
    const g = f.enuToGeodetic(...v.enu);
    assert.ok(Math.abs(g[0] - v.geo[0]) < 1e-10 && Math.abs(g[1] - v.geo[1]) < 1e-10 && Math.abs(g[2] - v.geo[2]) < 1e-6, `enu->geo ${g} vs ${v.geo}`);
  }
  console.log(`  ${V.frame.length} points, worst ENU error ${worst.toExponential(2)} m`);
});

test("sight angles agree with the geodesic azimuth and simple geometry", () => {
  for (const v of V.geodesic.slice(0, 28)) {
    const a = { lat: v.lat1, lon: v.lon1, h: 100 }, b = { lat: v.lat2, lon: v.lon2, h: 100 };
    const s = C.sight(a, b);
    // the local-level azimuth and the geodesic azimuth coincide to ~1e-5 deg at < 1 km
    if (v.s12 < 1000) assert.ok(angDiff(s.azDeg, v.azi1) < 1e-4, `sight az ${s.azDeg} vs ${v.azi1}`);
    // same height: the far point dips below the horizon by ~ d / 2R
    if (v.s12 < 1000 && v.s12 > 10) {
      const dip = (v.s12 / (2 * 6371000)) * (180 / Math.PI);
      assert.ok(Math.abs(s.elDeg + dip) < dip * 0.02 + 1e-9, `elevation ${s.elDeg} vs -${dip}`);
    }
  }
});

const haveTracker = !!V.tracker;
test("ENU frame matches Ground_EO_Tracker's geolocation.LocalFrame", { skip: !haveTracker && "Ground_EO_Tracker not found" }, () => {
  for (const v of V.tracker.frames) {
    const enu = new W.LocalFrame(...v.origin).geodeticToEnu(...v.geo);
    enu.forEach((x, i) => assert.ok(Math.abs(x - v.enu[i]) < 1e-7, `enu ${enu} vs ${v.enu}`));
  }
});

test("planned pole positions match site_layout.camera_origins", { skip: !haveTracker && "Ground_EO_Tracker not found" }, () => {
  for (const v of V.tracker.layouts) {
    const p = C.plannedPoles(v.dist, v.bearing);
    p.a.forEach((x, i) => assert.ok(Math.abs(x - v.a[i]) < 1e-8, `a ${p.a} vs ${v.a}`));
    p.b.forEach((x, i) => assert.ok(Math.abs(x - v.b[i]) < 1e-8, `b ${p.b} vs ${v.b}`));
  }
});

/** The site from the vectors as SiteCalc input (the page holds the same rounded values). */
function yamlSite(y) {
  const [olat, olon, oh] = y.origin;
  const site = { origin: { lat: olat, lon: olon, h: oh }, poles: {}, refs: [], plan: null, declinationDeg: null };
  for (const [id, [lat, lon, h]] of Object.entries(y.poles)) site.poles[id] = { lat, lon, h, mount: y.mounts[id], sigma: 0.008 };
  for (const r of y.refs) site.refs.push({ name: r.name, lat: r.geo[0], lon: r.geo[1], h: r.geo[2], above: r.above, sigma: 0.01 });
  return site;
}

test("writes the template's survey lines only; output handed to check_site_config.py", { skip: !haveTracker && "Ground_EO_Tracker not found" }, () => {
  const y = V.tracker.yaml;
  const site = yamlSite(y);
  const an = C.analyzeSite(site);
  const r = C.applyToConfig(y.template, an, site.origin);
  assert.deepEqual(r.written, ["camera_a", "camera_b"]);
  const changes = C.configChanges(y.template, r.text);
  assert.deepEqual(changes.map((c) => c.key).sort(),
    ["origin_alt_m", "origin_e", "origin_e", "origin_lat_deg", "origin_lon_deg", "origin_n", "origin_n", "origin_u", "origin_u", "pole_distance_m"]);
  assert.equal(r.text.split("\n").length, y.template.split("\n").length);
  // writing again over the written file changes nothing
  assert.deepEqual(C.configChanges(r.text, C.applyToConfig(r.text, an, site.origin).text), []);
  // reading it back gives the cameras (antenna + mount) to well under a millimetre
  const pts = C.pointsFromConfig(C.parseConfig(r.text));
  for (const [id, [lat, lon, h]] of Object.entries(y.poles)) {
    const d = C.inverse(lat, lon, pts.poles[id].lat, pts.poles[id].lon).distanceM;
    assert.ok(d < 2e-4 && Math.abs(pts.poles[id].h - (h + y.mounts[id])) < 2e-4, `${id} read back ${d} m / ${pts.poles[id].h - h} m off`);
  }
  const sightings = Object.fromEntries(Object.entries(an.sightings).map(([id, rows]) => [id, rows.map((x) => ({ name: x.name, csv: x.csv, azDeg: x.azDeg, elDeg: x.elDeg }))]));
  assert.deepEqual(sightings.camera_a.map((x) => x.name), ["camera_b (camera)", "mast", "stake1"]);
  fs.writeFileSync(path.join(__dirname, "..", "oracle", "js_site.json"),
    JSON.stringify({ template: y.template, written: r.text, origin: y.origin, poles: y.poles, mounts: y.mounts, sightings }));
});

test("sightings: az/el from each camera, ref_alt includes the sighted height, uncertainty", () => {
  const o = { lat: 12.9715987, lon: 77.5945627, h: 920.0 };
  const f = new W.LocalFrame(o.lat, o.lon, o.h);
  const geo = (e, n, u) => { const [lat, lon, h] = f.enuToGeodetic(e, n, u); return { lat, lon, h }; };
  const site = {
    origin: o,
    poles: { camera_a: { ...geo(-25, 0, 0), mount: 3, sigma: 0.01 }, camera_b: { ...geo(25, 0, 0), mount: 3, sigma: 0.01 } },
    refs: [{ name: "mast", ...geo(-25, 400, 0), above: 3, sigma: 0.01 }, { name: "bad", lat: 999, lon: 0, h: 0 }],
    plan: null, declinationDeg: null,
  };
  const an = C.analyzeSite(site);
  const mast = an.sightings.camera_a.find((x) => x.name === "mast");
  assert.ok(Math.abs(mast.azDeg - 0) < 1e-6 || Math.abs(mast.azDeg - 360) < 1e-6, `due north: ${mast.azDeg}`);
  // both built on the tracker's (flat) frame at u = 0, then raised 3 m: level with the camera
  assert.ok(Math.abs(mast.elDeg) < 1e-6, `elevation ${mast.elDeg}`);
  // the 3 m goes along the mast's own vertical, tilted 400 m / R from the frame's: ~0.2 mm sideways
  assert.ok(Math.abs(mast.horizM - 400) < 5e-4, `horizontal ${mast.horizM}`);
  assert.ok(Math.abs(mast.sigmaMrad - Math.atan2(Math.hypot(0.01, 0.01), mast.horizM) * 1000) < 1e-12);
  assert.match(mast.csv, /^12\.97\d+,77\.59\d+,923\.0\d\d$/);
  const other = an.sightings.camera_a.find((x) => x.name === "camera_b (camera)");
  assert.ok(Math.abs(other.azDeg - 90) < 1e-6 && Math.abs(other.horizM - 50) < 1e-4, `${other.azDeg} ${other.horizM}`); // mounts tilt apart by 50 m / R
  assert.equal(an.sightings.camera_a.length, 2, "an invalid reference point is skipped, a camera never sights itself");
  assert.equal(C.analyzeSite({ ...site, origin: null }).sightings.camera_a, undefined, "needs the origin");
});

test("analyzeSite: distances, bearings, corrections and warnings on a known layout", () => {
  // origin at the midpoint, poles planned 50 m apart at 90 deg; camera_b put 0.30 m north
  // and 0.10 m short of plan, camera_a exactly on plan, mounts 3 m / 2.5 m
  const o = { lat: 12.9715987, lon: 77.5945627, h: 920.0 };
  const f = new W.LocalFrame(o.lat, o.lon, o.h);
  const geo = (e, n, u) => { const [lat, lon, h] = f.enuToGeodetic(e, n, u); return { lat, lon, h }; };
  const site = {
    origin: o,
    poles: { camera_a: { ...geo(-25, 0, 0.4), mount: 3.0, sigma: 0.01 }, camera_b: { ...geo(24.9, 0.3, -0.2), mount: 2.5, sigma: 0.01 } },
    plan: { distanceM: 50, bearingDeg: 90 },
    declinationDeg: -0.5,
  };
  const an = C.analyzeSite(site);
  const p = an.pair;
  const de = 49.9, dn = 0.3;
  assert.ok(Math.abs(p.horizM - Math.hypot(de, dn)) < 1e-4, `horiz ${p.horizM}`);
  assert.ok(Math.abs(p.enuBearingAB - (Math.atan2(de, dn) * 180) / Math.PI) < 1e-4, `bearing ${p.enuBearingAB}`);
  assert.ok(angDiff(p.trueBearingAB, p.enuBearingAB) < 1e-3, "true vs ENU bearing");
  assert.ok(angDiff(p.trueBearingBA, p.trueBearingAB + 180) < 1e-3, "back bearing");
  assert.ok(Math.abs(p.dHeightM - (-0.2 + 2.5 - 0.4 - 3.0)) < 1e-4, `dh ${p.dHeightM}`);
  assert.ok(Math.abs(an.poles.camera_a.enu[2] - 3.4) < 1e-4, "origin_u includes the mount");
  assert.ok(Math.abs(p.magneticBearingAB - C.norm360(p.trueBearingAB + 0.5)) < 1e-9, "magnetic = true - declination");
  const sigma = (Math.atan2(Math.hypot(0.01, 0.01), p.horizM) * 180) / Math.PI;
  assert.ok(Math.abs(p.bearingSigmaDeg - sigma) < 1e-12);
  const mv = an.plan.moves;
  assert.ok(mv.camera_a.distM < 1e-4, `camera_a move ${mv.camera_a.distM}`);
  assert.ok(Math.abs(mv.camera_b.de - 0.1) < 1e-4 && Math.abs(mv.camera_b.dn + 0.3) < 1e-4, `camera_b move ${mv.camera_b.de},${mv.camera_b.dn}`);
  assert.match(mv.camera_b.text, /0\.316 m towards 161\.6° \(0\.300 m S, 0\.100 m E\)/);
  assert.ok(Math.abs(an.plan.distanceErrorM - (Math.hypot(de, dn) - 50)) < 1e-4);
  assert.ok(Math.abs(an.plan.bearingErrorDeg - ((Math.atan2(de, dn) * 180) / Math.PI - 90)) < 1e-4);
  assert.ok(Math.abs(an.midpoint.originOffsetM - Math.hypot(-0.05, 0.15)) < 1e-4);
  assert.deepEqual(an.warnings, []);

  site.poles.camera_b.allFixed = false;
  site.poles.camera_a.sigma = 0.2;
  const w = C.analyzeSite(site).warnings.join("\n");
  assert.match(w, /camera_b: not every averaged epoch was RTK FIXED/);
  assert.match(w, /camera_a: spread 0\.200 m/);
});

test("analyzeSite degrades cleanly with missing points", () => {
  const an = C.analyzeSite({ origin: null, poles: { camera_a: { lat: 12.97, lon: 77.59, h: 900 } }, plan: { distanceM: 50, bearingDeg: 90 }, declinationDeg: null });
  assert.equal(an.pair, null);
  assert.equal(an.frame, null);
  assert.deepEqual(an.plan.moves, {});
  const noOrigin = C.analyzeSite({ origin: null, poles: { camera_a: { lat: 12.97, lon: 77.59, h: 900 }, camera_b: { lat: 12.9701, lon: 77.5901, h: 901 } }, plan: null, declinationDeg: null });
  assert.ok(noOrigin.pair.geodesicM > 10 && noOrigin.pair.horizM === undefined);
  assert.throws(() => C.applyToConfig("x: 1\n", noOrigin, null), /origin first/);
  assert.match(C.configSnippet(noOrigin, null), /origin first/);
  const bad = C.analyzeSite({ origin: { lat: 95, lon: 0, h: 0 }, poles: {}, plan: null, declinationDeg: null });
  assert.equal(bad.frame, null, "an impossible latitude is not used as origin");
});

test("YAML editing keeps comments/CRLF and refuses missing blocks", () => {
  const t = "a:\r\n  local_frame:   # site\r\n    origin_lat_deg: 0.0   # deg\r\n    origin_lon_deg: 0.0\r\n";
  const r = C.replaceBlockScalar(t, "local_frame", "origin_lat_deg", "12.5");
  assert.equal(r, "a:\r\n  local_frame:   # site\r\n    origin_lat_deg: 12.5  # deg\r\n    origin_lon_deg: 0.0\r\n");
  assert.throws(() => C.replaceBlockScalar(t, "camera_c", "origin_e", "1"), /block 'camera_c:' not found/);
  assert.throws(() => C.replaceBlockScalar(t, "local_frame", "origin_alt_m", "1"), /field 'origin_alt_m:' not found/);
  // a field of the same name in a later sibling block is not touched
  const t2 = "camera_a:\n  user: x\ncamera_b:\n  origin_e: 0.0\n";
  assert.throws(() => C.replaceBlockScalar(t2, "camera_a", "origin_e", "1"), /not found inside block 'camera_a:'/);
  const cfg = C.parseConfig("    camera_ids: ['cam1', \"cam2\"]\n    pole_distance_m: 50.0\n");
  assert.deepEqual(cfg.ids, ["cam1", "cam2"]);
  assert.deepEqual(C.parseConfig("camera_ids: [\"<img src=x onerror=alert(1)>\", \"cam_b\"]\n").ids, ["cam_b"], "only ROS-style names");
});
