"""Reference vectors for the Site map math (web/sitecalc.js), from code that
shares nothing with it:

  geographiclib   geodesic distance + azimuths (Karney's algorithm)
  pyproj / PROJ   geodetic <-> ECEF, and ENU via PROJ's topocentric pipeline
  Ground_EO_Tracker itself (if checked out next to this repo, or at
  $GROUND_EO_TRACKER): geolocation.LocalFrame (the frame the tracker uses),
  site_layout.camera_origins (planned pole positions), and survey.py's own
  YAML writer applied to its committed cameras.yaml template.

    PYTHONPATH=.test-deps/py python3 tests/oracle/gen_site_vectors.py > tests/oracle/site_vectors.json
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
import tempfile
from types import SimpleNamespace

from geographiclib.geodesic import Geodesic
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GEO = Geodesic.WGS84
rng = random.Random(20261013)

to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
from_ecef = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)


def topocentric(lat0, lon0, h0):
    return Transformer.from_pipeline(
        f"+proj=pipeline +step +proj=cart +ellps=WGS84 "
        f"+step +proj=topocentric +ellps=WGS84 +lat_0={lat0!r} +lon_0={lon0!r} +h_0={h0!r}")


def site_points():
    """Realistic pole layouts (tens to hundreds of metres) all over the globe."""
    out = []
    for lat0, lon0 in [(12.9715987, 77.5945627), (-33.8688197, 151.2092955), (51.4778, -0.0015),
                       (64.1466, -21.9426), (0.0001, 179.9999), (-54.8019, -68.3030), (37.7749, -122.4194)]:
        h0 = rng.uniform(-20, 3000)
        frame = topocentric(lat0, lon0, h0)
        for _ in range(4):
            pts = []
            for _ in range(3):
                e, n, u = rng.uniform(-300, 300), rng.uniform(-300, 300), rng.uniform(-15, 15)
                lon, lat, h = frame.transform(e, n, u, direction="INVERSE")
                pts.append((lat, lon, h))
            out.append({"origin": (lat0, lon0, h0), "pts": pts})
    return out


def geodesic_cases():
    cases = []
    for s in site_points():
        a, b = s["pts"][0], s["pts"][1]
        cases.append((a[0], a[1], b[0], b[1]))
    for _ in range(60):  # wider spread: 0.5 m .. 50 km, any latitude below 80 deg
        lat1, lon1 = rng.uniform(-80, 80), rng.uniform(-180, 180)
        d = 10 ** rng.uniform(-0.3, 4.7)
        g = GEO.Direct(lat1, lon1, rng.uniform(0, 360), d)
        cases.append((lat1, lon1, g["lat2"], ((g["lon2"] + 180) % 360) - 180))
    vectors = []
    for lat1, lon1, lat2, lon2 in cases:
        g = GEO.Inverse(lat1, lon1, lat2, lon2)
        vectors.append({"lat1": lat1, "lon1": lon1, "lat2": lat2, "lon2": lon2,
                        "s12": g["s12"], "azi1": g["azi1"] % 360, "azi2": g["azi2"] % 360})
    return vectors


def frame_cases():
    vectors = []
    for s in site_points():
        lat0, lon0, h0 = s["origin"]
        frame = topocentric(lat0, lon0, h0)
        for lat, lon, h in s["pts"]:
            e, n, u = frame.transform(lon, lat, h)
            x, y, z = to_ecef.transform(lon, lat, h)
            vectors.append({"origin": [lat0, lon0, h0], "geo": [lat, lon, h], "enu": [e, n, u], "ecef": [x, y, z]})
    return vectors


def tracker_dir():
    d = os.environ.get("GROUND_EO_TRACKER") or os.path.join(os.path.dirname(ROOT), "Ground_EO_Tracker")
    return d if os.path.isfile(os.path.join(d, "tools", "gnss", "survey.py")) else None


def tracker_cases(tdir):
    sys.path.insert(0, os.path.join(tdir, "hawk_nest", "hawk_nest"))
    sys.path.insert(0, os.path.join(tdir, "tools", "gnss"))
    import geolocation  # noqa: E402
    import site_layout  # noqa: E402
    import survey  # noqa: E402

    frames = []
    for s in site_points():
        f = geolocation.LocalFrame(*s["origin"])
        for lat, lon, h in s["pts"]:
            frames.append({"origin": list(s["origin"]), "geo": [lat, lon, h], "enu": [float(v) for v in f.geodetic_to_enu(lat, lon, h)]})

    layouts = []
    for dist, bearing in [(50.0, 90.0), (200.0, 37.5), (120.0, 271.25), (75.0, 0.0), (10.0, 180.0)]:
        o = site_layout.camera_origins(["camera_a", "camera_b"], dist, bearing, {"camera_a": (0, 0, 2.0), "camera_b": (0, 0, 3.0)})
        layouts.append({"dist": dist, "bearing": bearing, "a": list(o["camera_a"][:2]), "b": list(o["camera_b"][:2])})

    # survey.py's own writer on the committed template: origin first, then each pole
    template_path = os.path.join(tdir, "hawk_nest", "config", "cameras.yaml")
    template = open(template_path).read()
    s = site_points()[0]
    # rounded to what the Site map page keeps (1e-9 deg, 0.1 mm), so a browser
    # run of the page can be compared byte for byte too
    (olat, olon, oh) = (round(s["origin"][0], 9), round(s["origin"][1], 9), round(s["origin"][2], 4))
    pts = [(round(a, 9), round(b, 9), round(c, 4)) for a, b, c in s["pts"]]
    origin = SimpleNamespace(lat_deg=olat, lon_deg=olon, height_msl_m=oh)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "cameras.yaml")
        with open(path, "w") as f:
            f.write(template)
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            survey._write_survey_point(path, "origin", origin)
            for label, (lat, lon, h) in zip(["camera_a", "camera_b"], pts):
                survey._write_survey_point(path, label, SimpleNamespace(lat_deg=lat, lon_deg=lon, height_msl_m=h))
        expected = open(path).read()
    yaml_case = {"template": template, "origin": [olat, olon, oh],
                 "poles": {"camera_a": list(pts[0]), "camera_b": list(pts[1])}, "expected": expected}
    return {"frames": frames, "layouts": layouts, "yaml": yaml_case}


def main() -> None:
    out = {"geodesic": geodesic_cases(), "frame": frame_cases(), "tracker": None}
    tdir = tracker_dir()
    if tdir:
        out["tracker"] = tracker_cases(tdir)
    else:
        print("note: Ground_EO_Tracker not found - tracker cross-checks skipped", file=sys.stderr)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
