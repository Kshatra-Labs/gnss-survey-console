// Web Serial connection to a u-blox receiver, plus the cloud relay clients.
// The browser talks to the USB receiver directly; only RTCM3 correction
// bytes cross the network, through the relay's /ws/relay/{channel}.
// Requires Chrome/Edge (navigator.serial) over HTTPS or localhost.

const BAUD_CANDIDATES = [115200, 38400, 9600, 230400, 460800, 57600, 921600];
const MSG_QUEUE_MAX = 64;

class SerialGnssConnection {
  constructor(port) {
    this.port = port;
    this.baud = null;
    this.monVer = null;
    this.alive = false;
    this.lastError = null;
    this.bytesIn = 0;
    this.latest = {}; // (cls << 8 | id) -> {payload, at}, kept up to date in both modes
    this.rtcm = new Rtcm.RtcmScanner(); // RTCM3 the receiver itself outputs
    this._buf = [];
    this._queue = [];
    this._waiter = null;
    this._rawSink = null;
    this._closing = false;
    this._reader = null;
    this._writer = null;
  }

  /** Opens at each candidate baud until the receiver answers a MON-VER
   * poll. FTDI/CP210x boards bridge to the F9P's UART (factory default
   * 38400), native USB ignores baud - either way this finds it. */
  static async openAuto(port, onTry = () => {}) {
    for (const baud of BAUD_CANDIDATES) {
      onTry(baud);
      const conn = new SerialGnssConnection(port);
      await conn.open(baud);
      const ver = await conn.readMonVer(1200);
      if (ver) {
        conn.monVer = ver;
        return conn;
      }
      await conn.close();
    }
    throw new Error(
      `no u-blox reply at any baud rate (tried ${BAUD_CANDIDATES.join(", ")}). ` +
      "Check it's a u-blox receiver and UBX protocol is enabled on this port."
    );
  }

  async open(baud) {
    // bufferSize: Chrome's default is 255 bytes, which overruns on any
    // brief main-thread stall at RTCM data rates.
    await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 65536 });
    this.baud = baud;
    this.alive = true;
    this._closing = false;
    this._writer = this.port.writable.getWriter();
    this._pumpPromise = this._pump();
  }

  async close() {
    this._closing = true;
    this.alive = false;
    this._rawSink = null;
    try { if (this._reader) await this._reader.cancel(); } catch (e) { /* ignore */ }
    try { await this._pumpPromise; } catch (e) { /* ignore */ }
    try { if (this._writer) this._writer.releaseLock(); } catch (e) { /* ignore */ }
    try { await this.port.close(); } catch (e) { /* ignore */ }
    this._resolveWaiter(null);
  }

  async _pump() {
    let ended = false;
    while (!this._closing && !ended && this.port.readable) {
      const reader = this.port.readable.getReader();
      this._reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { ended = true; break; }
          if (value && value.length) this._onBytes(value);
        }
      } catch (e) {
        // BufferOverrunError / FramingError / BreakError / ParityError are
        // non-fatal: port.readable is replaced and the loop picks it back
        // up. Unplugging leaves port.readable null, which ends the loop.
        this.lastError = e;
      } finally {
        try { reader.releaseLock(); } catch (e) { /* ignore */ }
        this._reader = null;
      }
    }
    if (!this._closing) {
      this.alive = false;
      this._resolveWaiter(null);
    }
  }

  _onBytes(value) {
    this.bytesIn += value.length;
    this.rtcm.feed(value);
    if (this._rawSink) this._rawSink(value);
    for (let i = 0; i < value.length; i++) this._buf.push(value[i]);
    this._drain(!this._rawSink);
  }

  _drain(deliver) {
    for (;;) {
      const r = Ubx.extractFrame(this._buf);
      this._buf = r.rest;
      if (r.message) {
        const m = r.message;
        this.latest[(m.cls << 8) | m.id] = { payload: m.payload, at: Date.now() };
        if (deliver) this._deliver(m);
      } else if (r.needMore) {
        return;
      }
    }
  }

  _deliver(m) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w(m);
      return;
    }
    this._queue.push(m);
    if (this._queue.length > MSG_QUEUE_MAX) this._queue.shift();
  }

  _resolveWaiter(v) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w(v);
    }
  }

  /** Raw passthrough for the base's RTCM upload. UBX frames are still
   * parsed on the side (so `latest` stays live for the stats display) but
   * no longer queued for readMessage. */
  enableRawMode(sink) { this._rawSink = sink; this._queue = []; }
  disableRawMode() { this._rawSink = null; }

  latestPvt(maxAgeMs = 3000) {
    const e = this.latest[(Ubx.CLS_NAV << 8) | Ubx.NAV_PVT];
    if (!e || Date.now() - e.at > maxAgeMs || e.payload.length < Ubx.NAV_PVT_MIN_LEN) return null;
    return Ubx.parseNavPvt(e.payload);
  }

  flushMessages() { this._queue = []; }

  /** Next UBX message, or null after timeoutMs (or at once if the port died). */
  readMessage(timeoutMs) {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    if (!this.alive) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._waiter = null; resolve(null); }, timeoutMs);
      this._waiter = (m) => { clearTimeout(timer); resolve(m); };
    });
  }

  async writeBytes(bytes) {
    if (!this.alive) throw new Error("USB receiver disconnected");
    await this._writer.write(bytes);
  }

  /** true on ACK-ACK, false on ACK-NAK or no answer after `tries`. */
  async sendAckWait(cls, id, payload = new Uint8Array(0), tries = 2) {
    const pkt = Ubx.frame(cls, id, payload);
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.writeBytes(pkt);
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
        if (!msg) break;
        if (msg.cls === Ubx.CLS_ACK && msg.payload.length >= 2 && msg.payload[0] === cls && msg.payload[1] === id) {
          return msg.id === Ubx.ACK_ACK;
        }
      }
      if (!this.alive) return false;
    }
    return false;
  }

  setMsgRateCurrentPort(msgCls, msgId, rate) {
    return this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_MSG, Ubx.msgRatePayload(msgCls, msgId, rate));
  }

  async poll(cls, id, timeoutMs = 2000) {
    await this.writeBytes(Ubx.frame(cls, id));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
      if (!msg) return null;
      if (msg.cls === cls && msg.id === id) return msg.payload;
    }
    return null;
  }

  /** CFG-PRT poll / OR in inRTCM3 (bit 5 of inProtoMask @12) / set back,
   * leaving baud and everything else as it was. */
  async enableRtcm3Input() {
    const payload = await this.poll(Ubx.CLS_CFG, Ubx.CFG_PRT);
    if (!payload || payload.length < 20) return false;
    const vals = new Uint8Array(payload);
    const dv = new DataView(vals.buffer);
    if (dv.getUint16(12, true) & 0x20) return true;
    dv.setUint16(12, dv.getUint16(12, true) | 0x20, true);
    return this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_PRT, vals);
  }

  async readNavPvt(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
      if (!msg) return null;
      if (msg.cls === Ubx.CLS_NAV && msg.id === Ubx.NAV_PVT && msg.payload.length >= Ubx.NAV_PVT_MIN_LEN) {
        return Ubx.parseNavPvt(msg.payload);
      }
    }
    return null;
  }

  async readMonVer(timeoutMs = 3000) {
    const payload = await this.poll(Ubx.CLS_MON, Ubx.MON_VER, timeoutMs);
    return payload && payload.length >= 40 ? Ubx.parseMonVer(payload) : null;
  }

  /** Rover setup. Also undoes base-mode leftovers: a receiver that was a
   * base earlier (without a power cycle) is still in time mode and still
   * emitting RTCM. Returns which steps the receiver ACKed. */
  async configureRover(onStep = () => {}) {
    const r = {};
    onStep("time mode off");
    r.timeModeOff = await this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.tmodeDisabledPayload());
    onStep("RTCM output off");
    let rtcmOff = true;
    for (const id of Object.values(Ubx.RTCM_BASE_SET)) rtcmOff = (await this.setMsgRateCurrentPort(Ubx.CLS_RTCM3, id, 0)) && rtcmOff;
    r.rtcmOutputOff = rtcmOff;
    onStep("position output (NAV-PVT) on");
    r.navPvt = await this.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1);
    onStep("RTCM3 correction input on");
    r.rtcmInput = await this.enableRtcm3Input();
    return r;
  }

  /** Base setup: NAV-PVT (for live stats), NAV-SVIN, RTCM3 output, then
   * survey-in. surveyIn=false means the receiver refused it. */
  async configureBase(minDurationS, accLimitM, onStep = () => {}) {
    const r = {};
    onStep("position output (NAV-PVT) on");
    r.navPvt = await this.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_PVT, 1);
    onStep("survey-in progress output (NAV-SVIN) on");
    r.navSvin = await this.setMsgRateCurrentPort(Ubx.CLS_NAV, Ubx.NAV_SVIN, 1);
    for (const [name, id] of Object.entries(Ubx.RTCM_BASE_SET)) {
      onStep(`RTCM ${name} output on`);
      r["rtcm" + name] = await this.setMsgRateCurrentPort(Ubx.CLS_RTCM3, id, 1);
    }
    onStep("start survey-in");
    r.surveyIn = await this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(minDurationS, accLimitM), 3);
    return r;
  }
}

// ---------------------------------------------------------------------
// Cloud relay
// ---------------------------------------------------------------------

/** "gnss-relay.onrender.com/" -> "https://gnss-relay.onrender.com";
 * "192.168.1.5:8765" -> "http://192.168.1.5:8765" (a relay on a local
 * network has no TLS certificate). */
function normalizeRelayUrl(url) {
  let u = (url || "").trim();
  if (!u) u = location.origin;
  if (!/^[a-z]+:\/\//i.test(u)) {
    const host = u.split(/[/:]/)[0].toLowerCase();
    const local = host === "localhost" || /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
    u = (local ? "http://" : "https://") + u;
  }
  return u.replace(/\/+$/, "");
}

function relayWsUrl(backendUrl, channel, role) {
  return `${normalizeRelayUrl(backendUrl).replace(/^http/i, "ws")}/ws/relay/${encodeURIComponent(channel)}?role=${role}`;
}

/** Polls GET /status/{channel} every 5s while a session runs: shows
 * whether a base is live on the channel and how many rovers listen, and
 * doubles as the keep-alive that stops a free-tier host idling to sleep
 * mid-survey (the first poll also wakes a sleeping one). */
function startChannelStatus(backendUrl, channel) {
  const state = { ok: null, data: null, error: null, at: 0 };
  let stopped = false;
  let timer = null;
  let polls = 0;
  async function tick() {
    polls++;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const r = await fetch(`${normalizeRelayUrl(backendUrl)}/status/${encodeURIComponent(channel)}`, {
        cache: "no-store", signal: ctl ? ctl.signal : undefined,
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.data = await r.json();
      state.ok = true;
      state.error = null;
      state.at = Date.now();
    } catch (e) {
      state.ok = false;
      state.error = e && e.name === "AbortError" ? "no answer in 8s (relay waking up?)" : (e && e.message) || String(e);
    } finally {
      if (t) clearTimeout(t);
    }
    // second poll soon after start, so this device's own just-opened relay
    // link shows up quickly; then every 5 s
    if (!stopped) timer = setTimeout(tick, polls === 1 ? 1500 : 5000);
  }
  tick();
  return { stop() { stopped = true; clearTimeout(timer); }, get: () => state };
}

function channelStatusLine(cs, channel, role) {
  if (!cs) return null;
  const s = cs.get();
  if (s.ok === null) return `channel "${channel}": checking...`;
  if (!s.ok) return `channel "${channel}": relay status unavailable (${s.error})`;
  const d = s.data;
  const age = d.last_base_data_age_s == null ? "never" : `${d.last_base_data_age_s.toFixed(1)}s ago`;
  let line = `channel "${channel}": base online=${d.base_online}  rovers=${d.rovers}  base data last=${age}`;
  if (d.bases > 1) line += `  WARNING: ${d.bases} bases on this channel - only the newest is relayed`;
  if (role === "rover" && !d.base_online) line += "  <- no base is broadcasting on this channel";
  return line;
}

function makeRelayLink(backendUrl, channel, role, onStatus, onMessage) {
  let stopped = false;
  let ws = null;
  let retryTimer = null;
  const stats = { bytes: 0, dropped: 0, lastAt: 0, connects: 0 };
  const status = startChannelStatus(backendUrl, channel);

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket(relayWsUrl(backendUrl, channel, role));
    } catch (e) {
      onStatus(`relay: bad relay address (${e.message})`);
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { stats.connects++; };
    ws.onmessage = (ev) => { if (typeof ev.data !== "string") onMessage(new Uint8Array(ev.data)); };
    ws.onclose = () => {
      if (!stopped) retryTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  connect();

  return {
    ws: () => ws,
    stats,
    channelStatus: status,
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      status.stop();
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    },
  };
}

function linkStatsLine(link, verb) {
  const s = link.stats;
  const age = s.lastAt ? `${((Date.now() - s.lastAt) / 1000).toFixed(1)}s ago` : "never";
  let line = `relay: ${link.connected() ? "connected" : "connecting/reconnecting"}  bytes ${verb}=${s.bytes}  last=${age}`;
  if (s.dropped) line += `  dropped while offline=${s.dropped}`;
  return line;
}

/** Base: uploads only the CRC-valid RTCM3 frames from the receiver's
 * output - its NMEA and UBX would otherwise land in every rover's command
 * input and eat rover UART bandwidth (an NTRIP caster carries RTCM only,
 * too). Frames produced while the link is down are dropped, not queued:
 * stale corrections are useless and a queue would grow without bound. */
function startRelayUpload(backendUrl, channel, conn, onStatus) {
  const link = makeRelayLink(backendUrl, channel, "base", onStatus, () => {});
  let batch = [];
  const extractor = new Rtcm.RtcmScanner((frameBytes) => { for (const b of frameBytes) batch.push(b); });
  conn.enableRawMode((chunk) => {
    extractor.feed(chunk);
    if (!batch.length) return;
    const out = new Uint8Array(batch);
    batch = [];
    const ws = link.ws();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(out);
      link.stats.bytes += out.length;
      link.stats.lastAt = Date.now();
    } else {
      link.stats.dropped += out.length;
    }
  });
  const stop = link.stop;
  link.stop = () => { conn.disableRawMode(); stop(); };
  link.statsLine = () => linkStatsLine(link, "sent");
  return link;
}

/** Rover: writes every byte from the relay into the receiver, counting
 * CRC-valid RTCM3 frames by type on the way through. */
function startRelayDownload(backendUrl, channel, conn, onStatus) {
  const rtcmIn = new Rtcm.RtcmScanner();
  const link = makeRelayLink(backendUrl, channel, "rover", onStatus, (bytes) => {
    link.stats.bytes += bytes.length;
    link.stats.lastAt = Date.now();
    rtcmIn.feed(bytes);
    conn.writeBytes(bytes).catch(() => {});
  });
  link.rtcmIn = rtcmIn;
  link.statsLine = () => linkStatsLine(link, "received");
  return link;
}

if (typeof window !== "undefined") {
  window.SerialGnssConnection = SerialGnssConnection;
  window.startRelayUpload = startRelayUpload;
  window.startRelayDownload = startRelayDownload;
  window.startChannelStatus = startChannelStatus;
  window.channelStatusLine = channelStatusLine;
  window.normalizeRelayUrl = normalizeRelayUrl;
}
