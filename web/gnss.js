// UBX + RTCM3 protocol - pure functions, no I/O. Mirrored field-for-field by
// the Android app's gnss/Ubx.kt + gnss/Rtcm.kt. Payload offsets follow the
// u-blox ZED-F9P interface description and are checked against pyubx2
// (an independent implementation) by tests/oracle in this repo - never
// against frames built by this same file, which would only prove the code
// agrees with itself. Runs under Node and in the browser unchanged.

const SYNC1 = 0xb5, SYNC2 = 0x62;

const CLS_NAV = 0x01, CLS_ACK = 0x05, CLS_CFG = 0x06, CLS_MON = 0x0a, CLS_RTCM3 = 0xf5;
const NAV_PVT = 0x07, NAV_SVIN = 0x3b;
const ACK_NAK = 0x00, ACK_ACK = 0x01;
const CFG_PRT = 0x00, CFG_MSG = 0x01, CFG_TMODE3 = 0x71;
const MON_VER = 0x04;

// Every UBX message this app reads is well under this. A larger length
// field means the "sync" was really two bytes inside RTCM/NMEA data, so
// drop it at once instead of waiting for up to 64 KB of stream to arrive.
const MAX_UBX_PAYLOAD = 1024;

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

/** CFG-MSG short form: sets the rate on the port the command arrives on. */
function msgRatePayload(msgCls, msgId, rate) {
  return new Uint8Array([msgCls, msgId, rate]);
}

/** CFG-TMODE3 (40 bytes): 0 version, 2 flags (bits 0-7 mode: 0 off,
 * 1 survey-in, 2 fixed), 20 fixedPosAcc, 24 svinMinDur (s), 28 svinAccLimit (0.1 mm). */
function surveyInPayload(minDurationS, accLimitM) {
  const buf = new ArrayBuffer(40);
  const dv = new DataView(buf);
  dv.setUint16(2, 1, true);
  dv.setUint32(24, minDurationS, true);
  dv.setUint32(28, Math.round(accLimitM * 10000), true);
  return new Uint8Array(buf);
}

/** CFG-TMODE3 with mode=0. A receiver that was a base earlier stays in
 * time mode until power-cycled and can never RTK-fix as a rover. */
function tmodeDisabledPayload() {
  return new Uint8Array(40);
}

function u8(p, off) { return p[off]; }
function i32(p, off) { return new DataView(p.buffer, p.byteOffset + off, 4).getInt32(0, true); }
function u32(p, off) { return new DataView(p.buffer, p.byteOffset + off, 4).getUint32(0, true); }

const CARR_SOLN = { 0: "none", 1: "RTK FLOAT", 2: "RTK FIXED" };
const FIX_TYPE = { 0: "no fix", 1: "dead reckoning", 2: "2D", 3: "3D", 4: "GNSS+DR", 5: "time only" };

const NAV_PVT_MIN_LEN = 84;

/** NAV-PVT payload: 20 fixType, 21 flags, 23 numSV, 24 lon (1e-7 deg),
 * 28 lat, 32 height (mm), 36 hMSL (mm), 40 hAcc (mm), 44 vAcc (mm).
 * flags: bit 0 gnssFixOK, bit 1 diffSoln, bits 6-7 carrSoln. */
function parseNavPvt(p) {
  const fixType = u8(p, 20);
  const flags = u8(p, 21);
  const numSv = u8(p, 23);
  const lon = i32(p, 24) * 1e-7;
  const lat = i32(p, 28) * 1e-7;
  const height = i32(p, 32) / 1000.0;
  const hMsl = i32(p, 36) / 1000.0;
  const hAcc = u32(p, 40) / 1000.0;
  const vAcc = u32(p, 44) / 1000.0;
  const carrSoln = (flags >> 6) & 0x3;
  const diffSoln = (flags & 0x2) !== 0;
  return {
    fixType, numSv, latDeg: lat, lonDeg: lon,
    heightEllipsoidM: height, heightMslM: hMsl, hAccM: hAcc, vAccM: vAcc,
    carrSoln, diffSoln, gnssFixOk: (flags & 0x1) !== 0,
    statusStr: `${FIX_TYPE[fixType] ?? "?" + fixType}, carrier=${CARR_SOLN[carrSoln] ?? "?"}, sv=${numSv}, hAcc=${hAcc.toFixed(3)}m vAcc=${vAcc.toFixed(3)}m`,
  };
}

/** NAV-SVIN payload: 8 dur (s), 28 meanAcc (0.1 mm), 32 obs, 36 valid, 37 active. */
function parseNavSvin(p) {
  return {
    durationS: u32(p, 8),
    meanAccM: u32(p, 28) / 10000.0,
    observations: u32(p, 32),
    valid: p[36] !== 0,
    active: p[37] !== 0,
  };
}

function asciiField(p, start, len) {
  let s = "";
  for (let i = start; i < Math.min(start + len, p.length); i++) {
    if (p[i] === 0) break;
    s += String.fromCharCode(p[i]);
  }
  return s.trim();
}

/** MON-VER payload: 0 swVersion char[30], 30 hwVersion char[10], then
 * char[30] extensions ("FWVER=HPG 1.32", "MOD=ZED-F9P", ...). */
function parseMonVer(p) {
  const sw = asciiField(p, 0, 30);
  const hw = asciiField(p, 30, 10);
  const ext = [];
  for (let off = 40; off + 30 <= p.length; off += 30) {
    const e = asciiField(p, off, 30);
    if (e) ext.push(e);
  }
  const find = (prefix) => (ext.find((e) => e.startsWith(prefix)) || "").slice(prefix.length);
  const mod = find("MOD=");
  const fw = find("FWVER=");
  const summary = [mod || "u-blox", fw || sw].filter(Boolean).join(" ");
  return { sw, hw, ext, mod, fw, summary };
}

/** Pulls one UBX frame off the front of a growing byte buffer (array of
 * numbers). Returns {message, rest, needMore}: message is null when no
 * valid frame was taken. needMore=true means wait for more bytes; false
 * with a null message means a bogus sync was dropped and the caller
 * should call again on `rest` straight away. */
function extractFrame(buf) {
  let start = -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === SYNC1 && buf[i + 1] === SYNC2) { start = i; break; }
  }
  if (start === -1) {
    // keep a trailing SYNC1 in case its SYNC2 is in the next chunk
    const keep = buf.length && buf[buf.length - 1] === SYNC1 ? [SYNC1] : [];
    return { message: null, rest: keep, needMore: true };
  }
  const trimmed = start === 0 ? buf : buf.slice(start);
  if (trimmed.length < 6) return { message: null, rest: trimmed, needMore: true };
  const plen = trimmed[4] | (trimmed[5] << 8);
  if (plen > MAX_UBX_PAYLOAD) return { message: null, rest: trimmed.slice(1), needMore: false };
  const total = 6 + plen + 2;
  if (trimmed.length < total) return { message: null, rest: trimmed, needMore: true };
  const body = trimmed.slice(2, 6 + plen);
  const [ckA, ckB] = checksum(body);
  if (ckA === trimmed[6 + plen] && ckB === trimmed[7 + plen]) {
    return {
      message: { cls: trimmed[2], id: trimmed[3], payload: new Uint8Array(body.slice(4)) },
      rest: trimmed.slice(total),
      needMore: false,
    };
  }
  return { message: null, rest: trimmed.slice(1), needMore: false };
}

// ---------------------------------------------------------------------
// RTCM3 framing: 0xD3, 6 zero bits + 10-bit length, payload, CRC-24Q.
// Message type is the first 12 bits of the payload.
// ---------------------------------------------------------------------

const CRC24Q_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 16;
    for (let j = 0; j < 8; j++) {
      c <<= 1;
      if (c & 0x1000000) c ^= 0x1864cfb;
    }
    t[i] = c & 0xffffff;
  }
  return t;
})();

function crc24q(buf, start = 0, end = buf.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xffffff) ^ CRC24Q_TABLE[((crc >> 16) ^ buf[i]) & 0xff];
  }
  return crc;
}

/** Counts CRC-valid RTCM3 frames by message type in an arbitrary byte
 * stream (mixed with NMEA/UBX is fine) - proof that real corrections are
 * flowing, as opposed to just "some bytes". With onFrame, also hands each
 * complete frame out, which is how the base extracts just the RTCM3 from
 * its receiver's mixed output before uploading it. */
class RtcmScanner {
  constructor(onFrame = null) {
    this.buf = [];
    this.counts = {};
    this.frames = 0;
    this.lastAt = 0;
    this.onFrame = onFrame;
  }

  feed(chunk) {
    for (let k = 0; k < chunk.length; k++) this.buf.push(chunk[k]);
    const buf = this.buf;
    const n = buf.length;
    let i = 0;
    while (i < n) {
      if (buf[i] !== 0xd3) { i++; continue; }
      if (n - i < 3) break;
      if ((buf[i + 1] & 0xfc) !== 0) { i++; continue; }
      const len = ((buf[i + 1] & 0x03) << 8) | buf[i + 2];
      const total = 3 + len + 3;
      if (n - i < total) break;
      const got = (buf[i + 3 + len] << 16) | (buf[i + 4 + len] << 8) | buf[i + 5 + len];
      if (len >= 2 && crc24q(buf, i, i + 3 + len) === got) {
        const type = (buf[i + 3] << 4) | (buf[i + 4] >> 4);
        this.counts[type] = (this.counts[type] || 0) + 1;
        this.frames++;
        this.lastAt = Date.now();
        if (this.onFrame) this.onFrame(buf.slice(i, i + total), type);
        i += total;
      } else {
        i++;
      }
    }
    this.buf = i === 0 ? buf : buf.slice(i);
  }

  summary() {
    const types = Object.keys(this.counts).map(Number).sort((a, b) => a - b);
    if (!types.length) return "none yet";
    return types.map((t) => `${t}x${this.counts[t]}`).join(" ");
  }

  ageS() {
    return this.lastAt ? (Date.now() - this.lastAt) / 1000 : null;
  }
}

const Ubx = {
  SYNC1, SYNC2, CLS_NAV, CLS_ACK, CLS_CFG, CLS_MON, CLS_RTCM3,
  NAV_PVT, NAV_SVIN, ACK_NAK, ACK_ACK, CFG_PRT, CFG_MSG, CFG_TMODE3, MON_VER,
  MAX_UBX_PAYLOAD, NAV_PVT_MIN_LEN, RTCM_BASE_SET, CARR_SOLN, FIX_TYPE,
  checksum, frame, msgRatePayload, surveyInPayload, tmodeDisabledPayload,
  parseNavPvt, parseNavSvin, parseMonVer, extractFrame,
};

const Rtcm = { crc24q, RtcmScanner };

if (typeof module !== "undefined") module.exports = { Ubx, Rtcm };
if (typeof window !== "undefined") { window.Ubx = Ubx; window.Rtcm = Rtcm; }
