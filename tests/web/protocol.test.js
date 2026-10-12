// node --test tests/web/protocol.test.js
// Checks web/gnss.js against tests/oracle/vectors.json (built by pyubx2 /
// pyrtcm), and writes our own encoded frames to tests/oracle/js_frames.json
// for tests/oracle/check_encoders.py to verify in the other direction.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Ubx, Rtcm } = require("../../web/gnss.js");

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "../oracle/vectors.json"), "utf8"));
const hexBytes = (h) => Array.from(Buffer.from(h, "hex"));

function parseOne(hex) {
  const r = Ubx.extractFrame(hexBytes(hex));
  assert.ok(r.message, "frame should extract");
  assert.equal(r.rest.length, 0);
  return r.message;
}

test("NAV-PVT matches pyubx2 field-for-field", () => {
  for (const v of vectors.nav_pvt) {
    const m = parseOne(v.hex);
    assert.equal(m.cls, Ubx.CLS_NAV);
    assert.equal(m.id, Ubx.NAV_PVT);
    assert.ok(m.payload.length >= Ubx.NAV_PVT_MIN_LEN);
    const p = Ubx.parseNavPvt(m.payload);
    const e = v.expect;
    for (const k of ["fixType", "carrSoln", "diffSoln", "gnssFixOk", "numSv"]) assert.equal(p[k], e[k], k);
    assert.ok(Math.abs(p.latDeg - e.latDeg) < 1.5e-7, `lat ${p.latDeg} vs ${e.latDeg}`);
    assert.ok(Math.abs(p.lonDeg - e.lonDeg) < 1.5e-7, `lon ${p.lonDeg} vs ${e.lonDeg}`);
    for (const k of ["heightEllipsoidM", "heightMslM", "hAccM", "vAccM"]) assert.ok(Math.abs(p[k] - e[k]) < 1e-9, k);
  }
});

test("NAV-SVIN matches pyubx2", () => {
  for (const v of vectors.nav_svin) {
    const p = Ubx.parseNavSvin(parseOne(v.hex).payload);
    assert.deepEqual(
      { ...p, meanAccM: Math.round(p.meanAccM * 1e6) / 1e6 },
      { ...v.expect, meanAccM: Math.round(v.expect.meanAccM * 1e6) / 1e6 },
    );
  }
});

test("MON-VER matches pyubx2", () => {
  const v = vectors.mon_ver[0];
  const p = Ubx.parseMonVer(parseOne(v.hex).payload);
  for (const k of ["sw", "hw", "mod", "fw", "summary"]) assert.equal(p[k], v.expect[k], k);
});

test("UBX stream recovery: noise, false syncs, random chunking", () => {
  const rng = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const frames = [...vectors.nav_pvt, ...vectors.nav_svin, ...vectors.mon_ver].map((v) => v.hex);
  let stream = [];
  for (const f of frames) {
    stream.push(...Buffer.from("$GNGGA,1,2,3*00\r\n"));
    stream.push(0xb5, 0x62, 0x01, 0x07, 0xff, 0xff, 1, 2, 3); // false sync with an absurd length
    stream.push(0xb5, 0x62, 0x01, 0x07, 0x10, 0x00, ...new Array(18).fill(9)); // false sync, plausible length, bad checksum
    stream.push(...hexBytes(f));
  }
  let buf = [];
  const got = [];
  let i = 0;
  while (i < stream.length) {
    const n = 1 + Math.floor(rng() * 40);
    buf.push(...stream.slice(i, i + n));
    i += n;
    for (;;) {
      const r = Ubx.extractFrame(buf);
      buf = r.rest;
      if (r.message) got.push(Buffer.from(Ubx.frame(r.message.cls, r.message.id, r.message.payload)).toString("hex"));
      else if (r.needMore) break;
    }
  }
  assert.deepEqual(got, frames);
});

test("RTCM3: per-frame type + CRC, and mixed-stream counting under random chunking", () => {
  for (const v of vectors.rtcm) {
    const s = new Rtcm.RtcmScanner();
    s.feed(hexBytes(v.hex));
    assert.deepEqual(s.counts, { [v.type]: 1 });
  }
  const want = Object.fromEntries(Object.entries(vectors.rtcm_stream.counts).map(([k, n]) => [Number(k), n]));
  const bytes = hexBytes(vectors.rtcm_stream.hex);
  for (const chunk of [bytes.length, 1, 7, 64, 333]) {
    const s = new Rtcm.RtcmScanner();
    for (let i = 0; i < bytes.length; i += chunk) s.feed(bytes.slice(i, i + chunk));
    assert.deepEqual(s.counts, want, `chunk=${chunk}`);
  }
});

test("emit our encoded frames for pyubx2 to verify", () => {
  const hex = (u8) => Buffer.from(u8).toString("hex");
  const out = {
    cfg_msg_navpvt_1: hex(Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(Ubx.CLS_NAV, Ubx.NAV_PVT, 1))),
    cfg_msg_1074_0: hex(Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(Ubx.CLS_RTCM3, Ubx.RTCM_BASE_SET["1074"], 0))),
    cfg_tmode3_svin_60_2m: hex(Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(60, 2.0))),
    cfg_tmode3_off: hex(Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.tmodeDisabledPayload())),
    poll_mon_ver: hex(Ubx.frame(Ubx.CLS_MON, Ubx.MON_VER)),
    poll_cfg_prt: hex(Ubx.frame(Ubx.CLS_CFG, Ubx.CFG_PRT)),
    rtcm_msg_ids: Ubx.RTCM_BASE_SET,
  };
  fs.writeFileSync(path.join(__dirname, "../oracle/js_frames.json"), JSON.stringify(out, null, 1));
});
