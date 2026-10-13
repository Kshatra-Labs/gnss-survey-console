"""Checks a cameras.yaml written by the Site map (sitecalc.js), using
Ground_EO_Tracker's own code to read it - the way the tracker will:

  - PyYAML parses it, and local_frame is the surveyed origin;
  - pole_distance_m is 0.0, so site_layout.camera_origins uses origin_e/n/u,
    and those equal geolocation.LocalFrame(origin).geodetic_to_enu(pole),
    with the camera mount added to up;
  - every other setting is unchanged from the template, and on the text side
    only the survey lines changed (comments and line count kept);
  - for north alignment, camera_model.bearing_from_position from each camera
    to each ref_lat,ref_lon,ref_alt the page offers gives the az/el it shows.

    python3 tests/oracle/check_site_config.py tests/oracle/js_site.json [GROUND_EO_TRACKER_DIR]
"""

from __future__ import annotations

import copy
import json
import os
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> None:
    case = json.load(open(sys.argv[1]))
    tdir = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("GROUND_EO_TRACKER") or os.path.join(os.path.dirname(ROOT), "Ground_EO_Tracker")
    sys.path.insert(0, os.path.join(tdir, "hawk_nest"))
    from hawk_nest.camera_model import bearing_from_position
    from hawk_nest.geolocation import LocalFrame
    from hawk_nest.site_layout import camera_origins

    before = yaml.safe_load(case["template"])["ground_tracker_node"]["ros__parameters"]
    after = yaml.safe_load(case["written"])["ground_tracker_node"]["ros__parameters"]
    ids = after["camera_ids"]
    olat, olon, oh = case["origin"]

    lf = after["local_frame"]
    assert abs(lf["origin_lat_deg"] - olat) < 5e-9 and abs(lf["origin_lon_deg"] - olon) < 5e-9 and abs(lf["origin_alt_m"] - oh) <= 5.001e-4, lf  # written to 1 mm
    assert after["pole_distance_m"] == 0.0, after["pole_distance_m"]
    print(f"ok  local_frame = surveyed origin, pole_distance_m = 0.0")

    frame = LocalFrame(lf["origin_lat_deg"], lf["origin_lon_deg"], lf["origin_alt_m"])
    origins = camera_origins(ids, after["pole_distance_m"], after["pole_line_bearing_deg"],
                             {c: (after[c]["origin_e"], after[c]["origin_n"], after[c]["origin_u"]) for c in ids})
    worst = 0.0
    for cid in ids:
        lat, lon, h = case["poles"][cid]
        want = frame.geodetic_to_enu(lat, lon, h + case["mounts"][cid])
        err = max(abs(float(a) - float(b)) for a, b in zip(origins[cid], want))
        worst = max(worst, err)
        assert err < 1e-4, f"{cid}: tracker reads {origins[cid]}, survey gives {list(want)}"
    print(f"ok  camera_origins() = surveyed camera positions (mount on up), worst {worst * 1000:.3f} mm")

    # nothing else changed
    expect = copy.deepcopy(before)
    for k in ("origin_lat_deg", "origin_lon_deg", "origin_alt_m"):
        expect["local_frame"][k] = after["local_frame"][k]
    expect["pole_distance_m"] = after["pole_distance_m"]
    for cid in ids:
        for k in ("origin_e", "origin_n", "origin_u"):
            expect[cid][k] = after[cid][k]
    assert expect == after, "a setting other than the survey fields changed"
    a, b = case["template"].split("\n"), case["written"].split("\n")
    assert len(a) == len(b), "line count changed"
    changed = [y.strip().split(":")[0] for x, y in zip(a, b) if x != y]
    assert sorted(changed) == sorted(["origin_lat_deg", "origin_lon_deg", "origin_alt_m", "pole_distance_m"] + ["origin_e", "origin_n", "origin_u"] * len(ids)), changed
    print(f"ok  every other setting unchanged; only the {len(changed)} survey lines differ, comments and line count kept")

    # north alignment: what the page shows vs what calibrate_ptz.py boresight will compute
    n = 0
    worst = 0.0
    for cid, rows in case["sightings"].items():
        for r in rows:
            ref_lat, ref_lon, ref_alt = (float(x) for x in r["csv"].split(","))
            az, el = bearing_from_position(origins[cid], frame.geodetic_to_enu(ref_lat, ref_lon, ref_alt))
            d = max(abs((az - r["azDeg"] + 180) % 360 - 180), abs(el - r["elDeg"]))
            worst = max(worst, d)
            assert d < 2e-4, f"{cid} -> {r['name']}: tracker az/el {az:.6f}/{el:.6f}, page {r['azDeg']:.6f}/{r['elDeg']:.6f}"
            n += 1
    print(f"ok  {n} sightings: page az/el = bearing_from_position() on the copied ref_lat,ref_lon,ref_alt (worst {worst:.1e} deg)")
    print("SITE CONFIG CHECKS PASSED")


if __name__ == "__main__":
    main()
