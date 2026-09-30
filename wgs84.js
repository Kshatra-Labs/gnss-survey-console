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
}

const Wgs84 = { geodeticToEcef, LocalFrame };
if (typeof module !== "undefined") module.exports = Wgs84;
if (typeof window !== "undefined") window.Wgs84 = Wgs84;
