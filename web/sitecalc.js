// Site-layout math for the Site map page (site.html): geodesic distance and
// bearing between the poles, each pole in the tracker's ENU frame, where to
// aim each camera at a reference point (north alignment), plan-vs-survey
// corrections, and reading/writing Ground_EO_Tracker's cameras.*.yaml.
// Pure functions - no DOM - so the tests run them under Node against
// geographiclib, PROJ and Ground_EO_Tracker's own code.
(function () {
  const W = typeof module !== "undefined" ? require("./wgs84.js") : window.Wgs84;

  const A = 6378137.0;
  const F = 1 / 298.257223563;
  const B = A * (1 - F);
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const wrap180 = (d) => norm360(d + 180) - 180;

  /** Vincenty inverse on WGS84. azi1Deg = true bearing at point 1 towards 2,
   * azi2Deg = forward azimuth at point 2 (geographiclib convention), so the
   * bearing from 2 back to 1 is azi2Deg + 180. */
  function inverse(lat1, lon1, lat2, lon2) {
    const L = rad(lon2 - lon1);
    const U1 = Math.atan((1 - F) * Math.tan(rad(lat1)));
    const U2 = Math.atan((1 - F) * Math.tan(rad(lat2)));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    // cosU1 sinU2 - sinU1 cosU2 cos(lambda), and its mirror, written without
    // the catastrophic cancellation the textbook form has on metre-scale lines
    const sinDU = Math.sin(U2 - U1);
    let lambda = L, prev, iter = 0;
    let sinS, cosS, sigma, cos2a, cos2Sm, sinL, cosL, oneMinusCosL;
    do {
      sinL = Math.sin(lambda); cosL = Math.cos(lambda);
      oneMinusCosL = 2 * Math.sin(lambda / 2) ** 2;
      sinS = Math.hypot(cosU2 * sinL, sinDU + sinU1 * cosU2 * oneMinusCosL);
      if (sinS === 0) return { distanceM: 0, azi1Deg: NaN, azi2Deg: NaN };
      cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
      sigma = Math.atan2(sinS, cosS);
      const sinA = (cosU1 * cosU2 * sinL) / sinS;
      cos2a = 1 - sinA * sinA;
      cos2Sm = cos2a !== 0 ? cosS - (2 * sinU1 * sinU2) / cos2a : 0;
      const C = (F / 16) * cos2a * (4 + F * (4 - 3 * cos2a));
      prev = lambda;
      lambda = L + (1 - C) * F * sinA * (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    } while (Math.abs(lambda - prev) > Math.abs(lambda) * 1e-15 && ++iter < 200); // relative: metre-scale lines have lambda ~ 1e-7
    const u2 = (cos2a * (A * A - B * B)) / (B * B);
    const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dSigma = bigB * sinS * (cos2Sm + (bigB / 4) * (cosS * (-1 + 2 * cos2Sm * cos2Sm) -
      (bigB / 6) * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
    return {
      distanceM: B * bigA * (sigma - dSigma),
      azi1Deg: norm360(deg(Math.atan2(cosU2 * sinL, sinDU + sinU1 * cosU2 * oneMinusCosL))),
      azi2Deg: norm360(deg(Math.atan2(cosU1 * sinL, sinDU - cosU1 * sinU2 * oneMinusCosL))),
    };
  }

  /** Bearing (true, 0 = north, clockwise) and elevation of `to` seen from `from`,
   * both {lat, lon, h}, in the local level frame at `from`. */
  function sight(from, to) {
    const [e, n, u] = new W.LocalFrame(from.lat, from.lon, from.h).geodeticToEnu(to.lat, to.lon, to.h);
    return { azDeg: norm360(deg(Math.atan2(e, n))), elDeg: deg(Math.atan2(u, Math.hypot(e, n))), rangeM: Math.hypot(e, n, u) };
  }

  /** Pole positions the tracker derives from a tape-measure layout
   * (Ground_EO_Tracker hawk_nest/site_layout.py, pole_distance_m > 0). */
  function plannedPoles(distanceM, bearingDeg) {
    const half = distanceM / 2, b = rad(bearingDeg);
    const e = Math.sin(b) * half, n = Math.cos(b) * half;
    return { a: [-e, -n], b: [e, n] };
  }

  function vectorText(de, dn) {
    const d = Math.hypot(de, dn);
    if (d < 0.0005) return "in place (< 1 mm)";
    return `${d.toFixed(3)} m towards ${norm360(deg(Math.atan2(de, dn))).toFixed(1)}° ` +
      `(${Math.abs(dn).toFixed(3)} m ${dn >= 0 ? "N" : "S"}, ${Math.abs(de).toFixed(3)} m ${de >= 0 ? "E" : "W"})`;
  }

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const validPoint = (p) => p && isNum(p.lat) && isNum(p.lon) && isNum(p.h) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

  /**
   * site = { origin: {lat, lon, h} | null,
   *          poles: { camera_a: {lat, lon, h, mount, sigma}, camera_b: {...} },
   *          refs: [{name, lat, lon, h, above, sigma}],   reference points to sight
   *          plan: {distanceM, bearingDeg} | null, declinationDeg: number | null }
   * Heights are the receiver's MSL heights (what the console records); mount
   * is the camera's height above the surveyed antenna position, `above` the
   * sighted feature's height above a reference point's surveyed spot.
   */
  function analyzeSite(site, ids = ["camera_a", "camera_b"]) {
    const out = { ids, poles: {}, pair: null, plan: null, midpoint: null, frame: null, sightings: {}, warnings: [] };
    const origin = validPoint(site.origin) ? site.origin : null;
    // The frame is built from the origin as it will be written to the config
    // (8 / 8 / 3 decimals), so the tracker gets exactly these pole offsets.
    const frame = origin ? new W.LocalFrame(+origin.lat.toFixed(8), +origin.lon.toFixed(8), +origin.h.toFixed(3)) : null;
    out.frame = frame;

    for (const id of ids) {
      const p = site.poles[id];
      if (!validPoint(p)) continue;
      const mount = isNum(p.mount) ? p.mount : 0;
      const cam = { lat: p.lat, lon: p.lon, h: p.h + mount };
      const r = { id, antenna: p, camera: cam, mount, sigma: isNum(p.sigma) ? p.sigma : null };
      if (frame) {
        r.enuAntenna = frame.geodeticToEnu(p.lat, p.lon, p.h);
        r.enu = frame.geodeticToEnu(cam.lat, cam.lon, cam.h); // origin_e/n/u for the config
        r.fromOrigin = { distanceM: Math.hypot(r.enu[0], r.enu[1]), bearingDeg: norm360(deg(Math.atan2(r.enu[0], r.enu[1]))) };
      }
      out.poles[id] = r;
    }

    const pa = out.poles[ids[0]], pb = out.poles[ids[1]];
    if (pa && pb) {
      const g = inverse(pa.antenna.lat, pa.antenna.lon, pb.antenna.lat, pb.antenna.lon);
      const pair = {
        geodesicM: g.distanceM,
        trueBearingAB: g.azi1Deg,
        trueBearingBA: isNum(g.azi2Deg) ? norm360(g.azi2Deg + 180) : NaN,
        sightAB: sight(pa.camera, pb.camera),
        sightBA: sight(pb.camera, pa.camera),
        dHeightM: pb.camera.h - pa.camera.h,
      };
      if (frame) {
        const de = pb.enu[0] - pa.enu[0], dn = pb.enu[1] - pa.enu[1], du = pb.enu[2] - pa.enu[2];
        pair.horizM = Math.hypot(de, dn);
        pair.slopeM = Math.hypot(de, dn, du);
        pair.enuBearingAB = norm360(deg(Math.atan2(de, dn))); // the frame ground_tracker_node works in
        pair.enuBearingBA = norm360(pair.enuBearingAB + 180);
        const mid = [(pa.enu[0] + pb.enu[0]) / 2, (pa.enu[1] + pb.enu[1]) / 2];
        out.midpoint = { enu: mid, originOffsetM: Math.hypot(mid[0], mid[1]), text: vectorText(mid[0], mid[1]) };
      }
      const base = isNum(pair.horizM) ? pair.horizM : g.distanceM;
      if (pa.sigma !== null && pb.sigma !== null && base > 0) {
        pair.bearingSigmaDeg = deg(Math.atan2(Math.hypot(pa.sigma, pb.sigma), base));
      }
      if (isNum(site.declinationDeg)) {
        pair.magneticBearingAB = norm360(g.azi1Deg - site.declinationDeg);
        pair.magneticBearingBA = norm360(pair.trueBearingBA - site.declinationDeg);
      }
      out.pair = pair;
    }

    const plan = site.plan;
    if (plan && isNum(plan.distanceM) && plan.distanceM > 0 && isNum(plan.bearingDeg)) {
      const pp = plannedPoles(plan.distanceM, plan.bearingDeg);
      const res = { distanceM: plan.distanceM, bearingDeg: plan.bearingDeg, planned: { [ids[0]]: pp.a, [ids[1]]: pp.b }, moves: {} };
      if (frame) {
        for (const [id, target] of [[ids[0], pp.a], [ids[1], pp.b]]) {
          const p = out.poles[id];
          if (!p) continue;
          const de = target[0] - p.enuAntenna[0], dn = target[1] - p.enuAntenna[1];
          res.moves[id] = { de, dn, distM: Math.hypot(de, dn), text: vectorText(de, dn) };
        }
        if (out.pair && isNum(out.pair.horizM)) {
          res.distanceErrorM = out.pair.horizM - plan.distanceM;
          res.bearingErrorDeg = wrap180(out.pair.enuBearingAB - plan.bearingDeg);
        }
      }
      out.plan = res;
    }

    // North alignment (calibrate_ptz.py boresight): for each camera, every
    // other pole's camera and every reference point, with the az/el the
    // tracker will compute (ENU at the origin, camera_enu -> target_enu, as
    // camera_model.bearing_from_position) and the ref_lat,ref_lon,ref_alt
    // that go into the sightings CSV.
    if (frame) {
      const targets = [];
      for (const id of ids) {
        const p = out.poles[id];
        if (p) targets.push({ name: `${id} (camera)`, of: id, geo: p.camera, enu: p.enu, sigma: p.sigma });
      }
      for (const r of site.refs || []) {
        if (!validPoint(r)) continue;
        const geo = { lat: r.lat, lon: r.lon, h: r.h + (isNum(r.above) ? r.above : 0) };
        targets.push({ name: r.name, geo, enu: frame.geodeticToEnu(geo.lat, geo.lon, geo.h), sigma: isNum(r.sigma) ? r.sigma : null, allFixed: r.allFixed });
      }
      for (const id of ids) {
        const cam = out.poles[id];
        if (!cam) continue;
        out.sightings[id] = targets.filter((t) => t.of !== id).map((t) => {
          const de = t.enu[0] - cam.enu[0], dn = t.enu[1] - cam.enu[1], du = t.enu[2] - cam.enu[2];
          const horizM = Math.hypot(de, dn);
          const row = {
            name: t.name, azDeg: norm360(deg(Math.atan2(de, dn))), elDeg: deg(Math.atan2(du, horizM)), horizM,
            csv: `${t.geo.lat.toFixed(9)},${t.geo.lon.toFixed(9)},${t.geo.h.toFixed(3)}`,
          };
          if (cam.sigma !== null && t.sigma !== null && horizM > 0) row.sigmaMrad = Math.atan2(Math.hypot(cam.sigma, t.sigma), horizM) * 1000;
          return row;
        });
      }
      for (const r of site.refs || []) {
        if (validPoint(r) && r.allFixed === false) out.warnings.push(`${r.name}: not every averaged epoch was RTK FIXED - lower accuracy`);
      }
    }

    for (const id of ids) {
      const p = out.poles[id];
      if (!p) continue;
      if (p.antenna.allFixed === false) out.warnings.push(`${id}: not every averaged epoch was RTK FIXED - lower accuracy`);
      if (p.sigma !== null && p.sigma > 0.05) out.warnings.push(`${id}: spread ${p.sigma.toFixed(3)} m is large for RTK FIXED - consider re-surveying`);
    }
    if (origin && origin.allFixed === false) out.warnings.push("origin: not every averaged epoch was RTK FIXED - lower accuracy");
    if (out.midpoint && out.midpoint.originOffsetM > 0.5) {
      out.warnings.push(`origin is ${out.midpoint.originOffsetM.toFixed(2)} m from the pole midpoint - fine for GPS-surveyed positions, ` +
        "but a tape-measure layout (pole_distance_m > 0) assumes the origin IS the midpoint");
    }
    return out;
  }

  // --- cameras.*.yaml. The survey fields are single `key: number` lines,
  //     edited in place (comments, formatting and line count kept):
  //       local_frame: origin_lat_deg / origin_lon_deg / origin_alt_m
  //       <camera>: origin_e / origin_n / origin_u   (u = camera height above the origin)
  //       ros__parameters: pole_distance_m           (0 = use the surveyed positions) ---

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function findBlockScalar(lines, blockKey, fieldKey) {
    const blockRe = new RegExp(`^([ \\t]*)${reEsc(blockKey)}:\\s*(#.*)?$`);
    const fieldRe = new RegExp(`^([ \\t]*)${reEsc(fieldKey)}:([ \\t]*)([^#\\n]*)(#.*)?$`);
    let start = -1, indent = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = blockRe.exec(lines[i]);
      if (m) { start = i; indent = m[1].length; break; }
    }
    if (start < 0) throw new Error(`block '${blockKey}:' not found in file`);
    for (let i = start + 1; i < lines.length; i++) {
      const s = lines[i];
      if (s.trim() === "") continue;
      const ind = s.length - s.replace(/^[ \t]+/, "").length;
      if (ind <= indent) break;
      const m = fieldRe.exec(s);
      if (m) return { index: i, m };
    }
    throw new Error(`field '${fieldKey}:' not found inside block '${blockKey}:'`);
  }

  function splitLines(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function replaceBlockScalar(text, blockKey, fieldKey, value) {
    const lines = splitLines(text);
    const { index, m } = findBlockScalar(lines, blockKey, fieldKey);
    let line = `${m[1]}${fieldKey}:${m[2] || " "}${value}`;
    if (m[4]) line += `  ${m[4]}`;
    lines[index] = line;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return lines.join(eol) + (/\n$/.test(text) ? eol : "");
  }

  function readBlockScalar(text, blockKey, fieldKey) {
    try {
      const { m } = findBlockScalar(splitLines(text), blockKey, fieldKey);
      const v = parseFloat(m[3]);
      return Number.isFinite(v) ? v : null;
    } catch (e) { return null; }
  }

  function parseConfig(text) {
    const ids = (() => {
      const m = /^[ \t]*camera_ids:\s*\[([^\]]*)\]/m.exec(text);
      if (!m) return null;
      // ROS parameter names only - they also end up as map labels (HTML)
      const list = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
      return list.length ? list : null;
    })() || ["camera_a", "camera_b"];
    const origin = {
      lat: readBlockScalar(text, "local_frame", "origin_lat_deg"),
      lon: readBlockScalar(text, "local_frame", "origin_lon_deg"),
      h: readBlockScalar(text, "local_frame", "origin_alt_m"),
    };
    const cameras = {};
    for (const id of ids) {
      cameras[id] = { e: readBlockScalar(text, id, "origin_e"), n: readBlockScalar(text, id, "origin_n"), u: readBlockScalar(text, id, "origin_u") };
    }
    return {
      ids, origin, cameras,
      poleDistanceM: readBlockScalar(text, "ros__parameters", "pole_distance_m"),
      poleLineBearingDeg: readBlockScalar(text, "ros__parameters", "pole_line_bearing_deg"),
    };
  }

  /** Writes the origin, each pole's origin_e/n/u and pole_distance_m: 0.0
   * into a cameras.*.yaml text. Nothing else in the file changes. */
  function applyToConfig(text, analysis, origin) {
    if (!validPoint(origin)) throw new Error("survey (or enter) the origin first");
    let t = text;
    t = replaceBlockScalar(t, "local_frame", "origin_lat_deg", origin.lat.toFixed(8));
    t = replaceBlockScalar(t, "local_frame", "origin_lon_deg", origin.lon.toFixed(8));
    t = replaceBlockScalar(t, "local_frame", "origin_alt_m", origin.h.toFixed(3));
    const written = [];
    for (const id of analysis.ids) {
      const p = analysis.poles[id];
      if (!p || !p.enu) continue;
      t = replaceBlockScalar(t, id, "origin_e", p.enu[0].toFixed(4));
      t = replaceBlockScalar(t, id, "origin_n", p.enu[1].toFixed(4));
      t = replaceBlockScalar(t, id, "origin_u", p.enu[2].toFixed(4));
      written.push(id);
    }
    if (written.length) {
      try { t = replaceBlockScalar(t, "ros__parameters", "pole_distance_m", "0.0"); } catch (e) { /* not in this file */ }
    }
    return { text: t, written };
  }

  /** Lines that differ between two versions of the file (same line count). */
  function configChanges(before, after) {
    const a = splitLines(before), b = splitLines(after), out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        const key = /^\s*([\w-]+):/.exec(b[i] || a[i] || "");
        out.push({ line: i + 1, key: key ? key[1] : "", before: (a[i] ?? "").trim(), after: (b[i] ?? "").trim() });
      }
    }
    return out;
  }

  /** Paste-able values when no config file is at hand. */
  function configSnippet(analysis, origin) {
    if (!validPoint(origin)) return "# survey (or enter) the origin first";
    const lines = [
      "local_frame:",
      `  origin_lat_deg: ${origin.lat.toFixed(8)}`,
      `  origin_lon_deg: ${origin.lon.toFixed(8)}`,
      `  origin_alt_m: ${origin.h.toFixed(3)}`,
      "pole_distance_m: 0.0            # use the surveyed positions below",
    ];
    for (const id of analysis.ids) {
      const p = analysis.poles[id];
      if (!p || !p.enu) continue;
      lines.push(`${id}:`, `  origin_e: ${p.enu[0].toFixed(4)}`, `  origin_n: ${p.enu[1].toFixed(4)}`,
        `  origin_u: ${p.enu[2].toFixed(4)}` + (p.mount ? `   # includes ${p.mount.toFixed(3)} m mount height` : ""));
    }
    return lines.join("\n");
  }

  /** Config values -> geodetic points (inverse of what applyToConfig writes). */
  function pointsFromConfig(cfg) {
    const o = cfg.origin;
    if (![o.lat, o.lon, o.h].every(isNum) || (o.lat === 0 && o.lon === 0)) return { origin: null, poles: {} };
    const frame = new W.LocalFrame(o.lat, o.lon, o.h);
    const poles = {};
    for (const id of cfg.ids) {
      const c = cfg.cameras[id];
      if (!c || ![c.e, c.n, c.u].every(isNum)) continue;
      const [lat, lon, h] = frame.enuToGeodetic(c.e, c.n, c.u);
      poles[id] = { lat, lon, h, mount: 0 };
    }
    return { origin: { lat: o.lat, lon: o.lon, h: o.h }, poles };
  }

  const SiteCalc = {
    inverse, sight, plannedPoles, analyzeSite, vectorText, wrap180, norm360,
    replaceBlockScalar, readBlockScalar, parseConfig, applyToConfig, configChanges, configSnippet, pointsFromConfig,
  };
  if (typeof module !== "undefined") module.exports = SiteCalc;
  if (typeof window !== "undefined") window.SiteCalc = SiteCalc;
})();
