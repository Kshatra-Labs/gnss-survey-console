// A u-blox ZED-F9P stand-in for end-to-end tests, written straight from
// the UBX/RTCM3 specs and deliberately sharing NO code with web/gnss.js,
// so a misread spec in the app can't be mirrored here and cancel out.
// Its own output is cross-checked with pyubx2 by tests/web/check_sim.py.
//
// Models what matters for this app: baud-rate mismatch (garbage), command
// ACK/NAK, CFG-PRT input-protocol masks, TMODE3 survey-in -> fixed time
// mode (and the classic trap of a former base stuck in time mode), RTCM3
// output by message type, and a rover whose carrier solution climbs
// none -> FLOAT -> FIXED only while valid RTCM3 corrections keep arriving.

"use strict";

function ubxChecksum(bytes) {
  let a = 0, b = 0;
  for (const x of bytes) { a = (a + x) & 0xff; b = (b + a) & 0xff; }
  return [a, b];
}

function ubxFrame(cls, id, payload) {
  const body = [cls, id, payload.length & 0xff, payload.length >> 8, ...payload];
  return [0xb5, 0x62, ...body, ...ubxChecksum(body)];
}

function le(n, size, signed = false) {
  const out = [];
  let v = signed && n < 0 ? (2 ** (8 * size)) + n : n;
  for (let i = 0; i < size; i++) { out.push(v % 256); v = Math.floor(v / 256); }
  return out;
}

function readU32(p, o) { return p[o] + p[o + 1] * 256 + p[o + 2] * 65536 + p[o + 3] * 16777216; }

function crc24q(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

function rtcmFrame(type, len, rnd) {
  const payload = [];
  for (let i = 0; i < len; i++) payload.push(Math.floor(rnd() * 256));
  payload[0] = type >> 4;
  payload[1] = ((type & 0xf) << 4) | (payload[1] & 0xf);
  const head = [0xd3, (len >> 8) & 3, len & 0xff, ...payload];
  const c = crc24q(head);
  return [...head, c >> 16, (c >> 8) & 0xff, c & 0xff];
}

// RTCM3 message type -> UBX CFG-MSG id in class 0xF5 (u-blox spec table)
const RTCM_IDS = { 1005: 0x05, 1074: 0x4a, 1077: 0x4d, 1084: 0x54, 1087: 0x57, 1094: 0x5e, 1097: 0x61, 1124: 0x7c, 1127: 0x7f, 1230: 0xe6 };
const RTCM_LEN = { 1005: 19, 1074: 140, 1077: 220, 1084: 110, 1087: 180, 1094: 150, 1097: 230, 1124: 130, 1127: 200, 1230: 6 };

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class F9pSim {
  constructor(opts = {}) {
    this.o = Object.assign({
      baud: 38400,
      lat: 17.3850123, lon: 78.4867456, hMsl: 540.1, sep: -27.8,
      epochMs: 200,
      numSv: 24,
      inProto: 0x03,          // UBX+NMEA in, RTCM3 input OFF: the app must turn it on
      timeMode: false,        // true: a former base still in fixed time mode
      rtcmOutOn: false,       // true: still emitting RTCM like a former base
      maxCarr: 2,             // 1: corrections only ever reach FLOAT
      svinAccStart: 4.0,      // m, survey-in mean accuracy at t=0 (improves 0.5 m/epoch)
      answers: true,          // false: never speaks UBX (not a u-blox / UBX disabled)
      noise: true,
      seed: 1,
    }, opts);
    this.rnd = mulberry32(this.o.seed);
    this.rates = new Map();
    this.inProto = this.o.inProto;
    this.outProto = 0x23;
    this.tmode = this.o.timeMode ? 2 : 0;
    this.svin = null;
    this.corrLastAt = 0;
    this.corrTypes = new Set();
    this.rtkEpochs = 0;
    this.rxBuf = [];
    this.sink = null;
    this.portBaud = null;
    this.timer = null;
    this.epoch = 0;
    this.stats = { cmds: [], rtcmInFrames: 0, nmeaIn: 0 };
    if (this.o.rtcmOutOn) for (const t of [1005, 1074, 1084, 1094, 1124, 1230]) this.rates.set(`245,${RTCM_IDS[t]}`, 1);
  }

  // --- port side ---
  attach(baud, sink) {
    this.portBaud = baud;
    this.sink = sink;
    this.timer = setInterval(() => this._epoch(), this.o.epochMs);
  }

  detach() {
    clearInterval(this.timer);
    this.timer = null;
    this.sink = null;
  }

  moveTo(lat, lon, hMsl) { Object.assign(this.o, { lat, lon, hMsl }); }

  _baudOk() { return this.o.answers && this.portBaud === this.o.baud; }

  _emit(bytes) {
    if (!this.sink || !bytes.length) return;
    if (!this._baudOk()) {
      // wrong baud: the UART sees framing garbage, not our bytes
      const g = [];
      for (let i = 0; i < Math.max(4, bytes.length >> 2); i++) g.push(Math.floor(this.rnd() * 256));
      this.sink(g);
      return;
    }
    // split into random-size chunks, like USB packets / OS reads
    let i = 0;
    while (i < bytes.length) {
      const n = 1 + Math.floor(this.rnd() * 300);
      this.sink(bytes.slice(i, i + n));
      i += n;
    }
  }

  input(chunk) {
    if (!this._baudOk()) return;
    for (const b of chunk) this.rxBuf.push(b);
    this._parseInput();
  }

  // --- receiver side ---
  _parseInput() {
    const buf = this.rxBuf;
    let i = 0;
    while (i < buf.length) {
      if (buf[i] === 0xb5 && buf[i + 1] === 0x62) {
        if (buf.length - i < 8) break;
        const len = buf[i + 4] | (buf[i + 5] << 8);
        if (len > 4096) { i++; continue; }               // real receivers bound UBX input length too
        if (buf.length - i < 8 + len) break;
        const body = buf.slice(i + 2, i + 6 + len);
        const [a, b] = ubxChecksum(body);
        if ((this.inProto & 0x01) && a === buf[i + 6 + len] && b === buf[i + 7 + len]) {
          this._command(body[0], body[1], body.slice(4));
          i += 8 + len;
        } else {
          i++;
        }
      } else if (buf[i] === 0xd3) {
        if (buf.length - i < 3) break;
        const len = ((buf[i + 1] & 3) << 8) | buf[i + 2];
        if (buf.length - i < len + 6) break;
        const frame = buf.slice(i, i + len + 6);
        const ok = (buf[i + 1] & 0xfc) === 0 && crc24q(frame.slice(0, len + 3)) === ((frame[len + 3] << 16) | (frame[len + 4] << 8) | frame[len + 5]);
        if (ok && (this.inProto & 0x20)) {
          const type = (frame[3] << 4) | (frame[4] >> 4);
          this.corrTypes.add(type);
          this.corrLastAt = Date.now();
          this.stats.rtcmInFrames++;
        }
        i += ok ? len + 6 : 1;
      } else {
        if (buf[i] === 0x24) this.stats.nmeaIn++;        // '$': an NMEA sentence reached our input
        i++;
      }
    }
    this.rxBuf = buf.slice(i);
  }

  _ack(cls, id, ok) {
    const f = ubxFrame(0x05, ok ? 0x01 : 0x00, [cls, id]);
    // answer a little later, sometimes glued to a NAV-PVT in the same chunk
    setTimeout(() => {
      if (this.rnd() < 0.5 && (this.rates.get("1,7") || 0) > 0) this._emit([...this._navPvt(), ...f]);
      else this._emit(f);
    }, 10 + Math.floor(this.rnd() * 60));
  }

  _command(cls, id, p) {
    this.stats.cmds.push(`${cls},${id},${p.length}`);
    if (cls === 0x06 && id === 0x01 && p.length === 3) {            // CFG-MSG (current port)
      this.rates.set(`${p[0]},${p[1]}`, p[2]);
      this._ack(cls, id, true);
    } else if (cls === 0x06 && id === 0x00 && p.length === 0) {     // CFG-PRT poll
      const pl = [1, 0, 0, 0, ...le(0x8c0, 4), ...le(this.o.baud, 4), ...le(this.inProto, 2), ...le(this.outProto, 2), 0, 0, 0, 0];
      setTimeout(() => this._emit(ubxFrame(0x06, 0x00, pl)), 15);
    } else if (cls === 0x06 && id === 0x00 && p.length === 20) {    // CFG-PRT set
      this.inProto = p[12] | (p[13] << 8);
      this.outProto = p[14] | (p[15] << 8);
      this._ack(cls, id, true);
    } else if (cls === 0x06 && id === 0x71 && p.length === 40) {    // CFG-TMODE3
      const mode = p[2];
      if (mode === 0) { this.tmode = 0; this.svin = null; }
      else if (mode === 1) {
        this.tmode = 1;
        this.svin = { dur: 0, minDur: readU32(p, 24), accLimit: readU32(p, 28) / 10000, valid: 0, active: 1, acc: this.o.svinAccStart };
      }
      this._ack(cls, id, mode <= 1);
    } else if (cls === 0x0a && id === 0x04 && p.length === 0) {     // MON-VER poll
      const pad = (s, n) => { const a = Array.from(Buffer.from(s, "ascii")); while (a.length < n) a.push(0); return a; };
      const pl = [...pad("EXT CORE 1.00 (61b2dd)", 30), ...pad("00190000", 10),
        ...pad("ROM BASE 0x118B2060", 30), ...pad("FWVER=HPG 1.32", 30), ...pad("PROTVER=27.31", 30), ...pad("MOD=ZED-F9P", 30)];
      setTimeout(() => this._emit(ubxFrame(0x0a, 0x04, pl)), 15);
    } else {
      this._ack(cls, id, false);
    }
  }

  _carr() {
    if (this.tmode !== 0) return 0;
    const fresh = Date.now() - this.corrLastAt < 2500 && this.corrTypes.has(1005) &&
      [1074, 1077, 1084, 1087, 1094, 1097, 1124, 1127].some((t) => this.corrTypes.has(t));
    if (!fresh) { this.rtkEpochs = 0; return 0; }
    this.rtkEpochs++;
    if (this.rtkEpochs >= 4 && this.o.maxCarr >= 2) return 2;
    return this.rtkEpochs >= 1 ? 1 : 0;
  }

  _navPvt() {
    const carr = this._lastCarr || 0;
    const timeOnly = this.tmode === 2;
    const err = carr === 2 ? 0.005 : carr === 1 ? 0.2 : 1.5;               // m
    const dLat = (this.rnd() - 0.5) * 2 * err / 111320;
    const dLon = (this.rnd() - 0.5) * 2 * err / (111320 * Math.cos(this.o.lat * Math.PI / 180));
    const hMsl = this.o.hMsl + (this.rnd() - 0.5) * 2 * err;
    const fixType = timeOnly ? 5 : 3;
    const diff = Date.now() - this.corrLastAt < 2500 && this.tmode === 0 ? 1 : 0;
    const flags = 0x01 | (diff << 1) | (carr << 6);
    const hAccMm = Math.round((timeOnly ? 0.0 : err) * 1000) + 1;
    const p = [
      ...le(this.epoch * 1000, 4), ...le(2026, 2), 10, 12, 9, 30, 15, 0x07,
      ...le(25, 4), ...le(0, 4, true),
      fixType, flags, 0xe0, this.o.numSv,
      ...le(Math.round((this.o.lon + dLon) * 1e7), 4, true),
      ...le(Math.round((this.o.lat + dLat) * 1e7), 4, true),
      ...le(Math.round((hMsl + this.o.sep) * 1000), 4, true),        // ellipsoid = MSL + geoid separation
      ...le(Math.round(hMsl * 1000), 4, true),
      ...le(hAccMm, 4), ...le(Math.round(hAccMm * 1.5), 4),
      ...new Array(92 - 48).fill(0),
    ];
    return ubxFrame(0x01, 0x07, p);
  }

  _epoch() {
    this.epoch++;
    const out = [];
    if (this.tmode === 1 && this.svin) {
      const s = this.svin;
      s.dur++;
      s.acc = Math.max(0.6, this.o.svinAccStart - 0.5 * s.dur);
      if (s.dur >= s.minDur && s.acc <= s.accLimit) { s.valid = 1; s.active = 0; this.tmode = 2; }
    }
    this._lastCarr = this._carr();
    if ((this.rates.get("1,7") || 0) > 0) out.push(...this._navPvt());
    if ((this.rates.get("1,59") || 0) > 0 && this.svin) {
      const s = this.svin;
      const p = [0, 0, 0, 0, ...le(this.epoch * 1000, 4), ...le(s.dur, 4), ...le(123456, 4, true), ...le(-654321, 4, true), ...le(345678, 4, true),
        0, 0, 0, 0, ...le(Math.round(s.acc * 10000), 4), ...le(s.dur, 4), s.valid, s.active, 0, 0];
      out.push(...ubxFrame(0x01, 0x3b, p));
    }
    if (this.outProto & 0x20) {
      for (const [type, id] of Object.entries(RTCM_IDS)) {
        if ((this.rates.get(`245,${id}`) || 0) <= 0) continue;
        if (Number(type) === 1005 && this.tmode !== 2) continue; // base position only exists after survey-in
        out.push(...rtcmFrame(Number(type), RTCM_LEN[type], this.rnd));
      }
    }
    if (this.outProto & 0x02) {
      out.push(...Buffer.from(`$GNGGA,093015.${this.epoch % 100},1723.10074,N,07829.20473,E,1,24,0.6,540.1,M,-27.8,M,,*4F\r\n`, "ascii"));
    }
    if (this.o.noise && this.rnd() < 0.3) {
      out.push(0xb5, 0x62, 0x01, 0x07, 0xfe, 0xff, 1, 2, 3, 4);           // false UBX sync, absurd length
      out.push(0xd3, 0x00, 0x40, 9, 9, 9);                                // false RTCM preamble
    }
    this._emit(out);
  }
}

/** Web Serial SerialPort stand-in backed by an F9pSim. Chunks are made in
 * the page's own realm, as Chrome would. */
class MockSerialPort extends EventTarget {
  constructor(sim, info, win) {
    super();
    this.sim = sim;
    this.info = info;
    this.win = win;
    this.readable = null;
    this.writable = null;
    this.isOpen = false;
    this.openBauds = [];
  }

  getInfo() { return this.info; }

  _newReadable() {
    const self = this;
    this.readable = new ReadableStream({
      start(c) { self._ctl = c; },
      cancel() { self._ctl = null; },
    });
  }

  async open({ baudRate }) {
    if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
    if (this.unplugged) throw new DOMException("The device has been lost.", "NetworkError");
    this.isOpen = true;
    this.openBauds.push(baudRate);
    this._newReadable();
    this.writable = new WritableStream({ write: (chunk) => { if (!this.unplugged) this.sim.input(Array.from(chunk)); } });
    this.sim.attach(baudRate, (bytes) => {
      if (this._ctl) {
        try { this._ctl.enqueue(new this.win.Uint8Array(bytes)); } catch (e) { /* stream closed */ }
      }
    });
  }

  async close() {
    if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
    if ((this.readable && this.readable.locked) || (this.writable && this.writable.locked)) {
      throw new TypeError("Cannot close a port with locked streams");
    }
    this.sim.detach();
    this.isOpen = false;
    this.readable = null;
    this.writable = null;
  }

  /** Non-fatal read error (Chrome: BufferOverrunError) - a fresh readable replaces the old one. */
  injectOverrun() {
    const c = this._ctl;
    this._newReadable();
    if (c) c.error(new DOMException("Buffer overrun", "BufferOverrunError"));
  }

  /** Physical unplug: fatal read error, readable gone, 'disconnect' event. */
  unplug(serial) {
    this.unplugged = true;
    this.sim.detach();
    const c = this._ctl;
    this._ctl = null;
    this.readable = null;
    if (c) c.error(new DOMException("The device has been lost.", "NetworkError"));
    const ev = new this.win.Event("disconnect");
    Object.defineProperty(ev, "target", { value: this });
    serial._dispatch(ev);
  }
}

class MockSerial {
  constructor() { this.queue = []; this.listeners = []; }
  willPick(port) { this.queue.push(port); }
  async requestPort() {
    if (!this.queue.length) throw new DOMException("No port selected by the user.", "NotFoundError");
    return this.queue.shift();
  }
  async getPorts() { return []; }
  addEventListener(type, fn) { if (type === "disconnect") this.listeners.push(fn); }
  removeEventListener() {}
  _dispatch(ev) { for (const fn of this.listeners) fn(ev); }
}

module.exports = { F9pSim, MockSerialPort, MockSerial, crc24q, ubxFrame };
