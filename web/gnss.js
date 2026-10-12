// UBX protocol - pure functions, no I/O. Third port of the same logic as
// Ground_EO_Tracker/tools/gnss/ubx.py and the Android app's gnss/Ubx.kt -
// kept field-for-field identical (message IDs, payload layouts, RTCM IDs
// verified against real hardware) so a browser-surveyed point matches one
// surveyed any other way. Runs under Node (this file) for testing and in
// the browser (webserial.js) unchanged - no browser-only APIs used here.

const SYNC1 = 0xb5, SYNC2 = 0x62;

const CLS_NAV = 0x01, CLS_ACK = 0x05, CLS_CFG = 0x06, CLS_MON = 0x0a, CLS_RTCM3 = 0xf5;
const NAV_PVT = 0x07, NAV_SVIN = 0x3b;
const ACK_ACK = 0x01;
const CFG_PRT = 0x00, CFG_MSG = 0x01, CFG_TMODE3 = 0x71;
const MON_VER = 0x04;

const RTCM_BASE_SET = { "1005": 0x05, "1074": 0x4a, "1084": 0x54, "1094": 0x5e, "1124": 0x7c, "1230": 0xe6 };

function checksum(body) {
  let ckA = 0, ckB = 0;
  for (let i = 0; i < body.length; i++) {
    ckA = (ckA + body[i]) & 0xff;
    ckB = (ckA + ckB) & 0xff;
  }
  return [ckA, ckB];
}

function frame(cls, id, payload = new Uint8Array(0)) {
  const body = new Uint8Array(4 + payload.length);
  body[0] = cls; body[1] = id;
  body[2] = payload.length & 0xff; body[3] = (payload.length >> 8) & 0xff;
  body.set(payload, 4);
  const [ckA, ckB] = checksum(body);
  const out = new Uint8Array(2 + body.length + 2);
  out[0] = SYNC1; out[1] = SYNC2;
  out.set(body, 2);
  out[out.length - 2] = ckA; out[out.length - 1] = ckB;
  return out;
}

function msgRatePayload(msgCls, msgId, rate) {
  return new Uint8Array([msgCls, msgId, rate]);
}

/** CFG-TMODE3, mode=1 (survey-in). Matches ubx.py's configure_survey_in / Ubx.kt's surveyInPayload. */
function surveyInPayload(minDurationS, accLimitM) {
  const accLimit01mm = Math.round(accLimitM * 10000);
  const buf = new ArrayBuffer(40);
  const dv = new DataView(buf);
  dv.setUint8(0, 0); dv.setUint8(1, 0);
  dv.setUint16(2, 1, true); // flags: mode=1, lla=0
  // bytes 4..19 (ecefXOrLat/Y/Z + HP + reserved2) stay zero
  dv.setUint32(20, 0, true); // fixedPosAcc
  dv.setUint32(24, minDurationS, true);
  dv.setUint32(28, accLimit01mm, true);
  return new Uint8Array(buf);
}

function u8(p, off) { return p[off]; }
function i32(p, off) { return new DataView(p.buffer, p.byteOffset + off, 4).getInt32(0, true); }
function u32(p, off) { return new DataView(p.buffer, p.byteOffset + off, 4).getUint32(0, true); }

const CARR_SOLN = { 0: "none", 1: "RTK FLOAT", 2: "RTK FIXED" };
const FIX_TYPE = { 0: "no fix", 1: "dead reckoning", 2: "2D", 3: "3D", 4: "GNSS+DR", 5: "time only" };

function parseNavPvt(p) {
  const fixType = u8(p, 24);
  const flags = u8(p, 25);
  const numSv = u8(p, 27);
  const lon = i32(p, 28) * 1e-7;
  const lat = i32(p, 32) * 1e-7;
  const height = i32(p, 36) / 1000.0;
  const hMsl = i32(p, 40) / 1000.0;
  const hAcc = u32(p, 44) / 1000.0;
  const vAcc = u32(p, 48) / 1000.0;
  const carrSoln = (flags >> 3) & 0x3;
  return {
    fixType, numSv, latDeg: lat, lonDeg: lon,
    heightEllipsoidM: height, heightMslM: hMsl, hAccM: hAcc, vAccM: vAcc,
    carrSoln, gnssFixOk: (flags & 0x1) !== 0,
    statusStr: `${FIX_TYPE[fixType] ?? "?" + fixType}, carrier=${CARR_SOLN[carrSoln] ?? "?"}, sv=${numSv}, hAcc=${hAcc.toFixed(3)}m vAcc=${vAcc.toFixed(3)}m`,
  };
}

function parseNavSvin(p) {
  const dur = u32(p, 8);
  const meanAcc = u32(p, 28) / 10000.0;
  const obs = u32(p, 32);
  return { durationS: dur, meanAccM: meanAcc, observations: obs, valid: p[36] !== 0, active: p[37] !== 0 };
}

/** Extracts one UBX frame from a growing byte buffer (array of numbers).
 * Returns {message: {cls,id,payload}, rest: remainingBytes} or null if no
 * complete, checksum-valid frame is present yet (same shape as ubx.py's
 * UbxReader / Ubx.kt's readMessage, but pull-based instead of blocking). */
function extractFrame(buf) {
  let start = -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === SYNC1 && buf[i + 1] === SYNC2) { start = i; break; }
  }
  if (start === -1) {
    // keep the last byte in case it's a lone SYNC1 waiting for SYNC2
    return { message: null, rest: buf.length > 1 ? buf.slice(buf.length - 1) : buf };
  }
  const trimmed = buf.slice(start);
  if (trimmed.length < 6) return { message: null, rest: trimmed };
  const plen = trimmed[4] | (trimmed[5] << 8);
  const total = 6 + plen + 2;
  if (trimmed.length < total) return { message: null, rest: trimmed };
  const body = trimmed.slice(2, 6 + plen);
  const [ckA, ckB] = checksum(new Uint8Array(body));
  const gotA = trimmed[6 + plen], gotB = trimmed[7 + plen];
  const rest = trimmed.slice(total);
  if (ckA === gotA && ckB === gotB) {
    return {
      message: { cls: trimmed[2], id: trimmed[3], payload: new Uint8Array(body.slice(4)) },
      rest,
    };
  }
  // bad checksum: drop the bogus SYNC1 and let the caller re-scan `rest`
  return { message: null, rest: trimmed.slice(1) };
}

const Ubx = {
  SYNC1, SYNC2, CLS_NAV, CLS_ACK, CLS_CFG, CLS_MON, CLS_RTCM3,
  NAV_PVT, NAV_SVIN, ACK_ACK, CFG_PRT, CFG_MSG, CFG_TMODE3, MON_VER,
  RTCM_BASE_SET, CARR_SOLN, FIX_TYPE,
  checksum, frame, msgRatePayload, surveyInPayload,
  parseNavPvt, parseNavSvin, extractFrame,
};

if (typeof module !== "undefined") module.exports = Ubx;
if (typeof window !== "undefined") window.Ubx = Ubx;
