// WGS84 <-> ENU, fourth port of the same math (Python gnss_core/wgs84.py,
// Kotlin Wgs84.kt) - kept numerically identical.
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.694379990141316e-3;

function geodeticToEcef(latDeg, lonDeg, altM) {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) * Math.sin(lat));
  return [
    (n + altM) * Math.cos(lat) * Math.cos(lon),
    (n + altM) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + altM) * Math.sin(lat),
  ];
}

function enuRotationRows(latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  return [
    [-Math.sin(lon), Math.cos(lon), 0.0],
    [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)],
    [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
  ];
}

/** ECEF -> [latDeg, lonDeg, altM]; same iteration as Ground_EO_Tracker's geolocation.py. */
function ecefToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let alt = 0.0;
  for (let i = 0; i < 5; i++) {
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    alt = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * n) / (n + alt)));
  }
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  alt = p / Math.cos(lat) - n;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI, alt];
}

class LocalFrame {
  constructor(originLatDeg, originLonDeg, originAltM) {
    this.originEcef = geodeticToEcef(originLatDeg, originLonDeg, originAltM);
    this.rotation = enuRotationRows(originLatDeg, originLonDeg);
  }

  /** Returns [east, north, up] metres from the origin. */
  geodeticToEnu(latDeg, lonDeg, altM) {
    const ecef = geodeticToEcef(latDeg, lonDeg, altM);
    const d = [ecef[0] - this.originEcef[0], ecef[1] - this.originEcef[1], ecef[2] - this.originEcef[2]];
    return this.rotation.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
  }

  /** Inverse of geodeticToEnu: [latDeg, lonDeg, altM]. */
  enuToGeodetic(e, n, u) {
    const R = this.rotation, o = this.originEcef;
    return ecefToGeodetic(
      o[0] + R[0][0] * e + R[1][0] * n + R[2][0] * u,
      o[1] + R[0][1] * e + R[1][1] * n + R[2][1] * u,
      o[2] + R[0][2] * e + R[1][2] * n + R[2][2] * u,
    );
  }
}

const Wgs84 = { geodeticToEcef, ecefToGeodetic, LocalFrame };
if (typeof module !== "undefined") module.exports = Wgs84;
if (typeof window !== "undefined") window.Wgs84 = Wgs84;
