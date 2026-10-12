// Web Serial rover: the browser talks directly to the USB-connected GPS
// receiver, no local server process needed for this at all. Only the
// correction bytes cross the network (from wherever the base actually is),
// via the /ws/corrections bridge on the backend. Requires Chrome/Edge
// (navigator.serial) over HTTPS or localhost - not Firefox/Safari.

class SerialGnssConnection {
  constructor(port) {
    this.port = port;
    this._buf = [];
    this._waiter = null;
    this._pumping = false;
    this._rawSink = null; // when set, incoming bytes bypass UBX parsing entirely (see enableRawMode)
  }

  async open(baud) {
    await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: "none" });
    this._reader = this.port.readable.getReader();
    this._writer = this.port.writable.getWriter();
    this._pumping = true;
    this._pumpPromise = this._pump();
  }

  async close() {
    this._pumping = false;
    try { await this._reader.cancel(); } catch (e) { /* ignore */ }
    try { this._reader.releaseLock(); } catch (e) { /* ignore */ }
    try { this._writer.releaseLock(); } catch (e) { /* ignore */ }
    try { await this._pumpPromise; } catch (e) { /* ignore */ }
    try { await this.port.close(); } catch (e) { /* ignore */ }
  }

  async _pump() {
    try {
      while (this._pumping) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) {
          if (this._rawSink) {
            // Base, post-survey-in: RTCM3 isn't UBX-framed, so forward raw
            // bytes verbatim instead of feeding the UBX parser (which would
            // silently discard them while hunting for sync bytes) - same
            // sequential handoff as the Python/Kotlin ports' base mode.
            this._rawSink(value);
          } else {
            for (let i = 0; i < value.length; i++) this._buf.push(value[i]);
            this._drain();
          }
        }
      }
    } catch (e) {
      // port unplugged mid-read, etc. - the caller's readMessage timeouts
      // will surface this as "no fix yet" rather than an unhandled rejection
    }
  }

  /** Switches this connection into raw-passthrough mode: every subsequent
   * incoming chunk goes straight to `sink(Uint8Array)`, no UBX parsing.
   * One-way - matches how the base role never needs to read UBX again once
   * it starts broadcasting. Flushes whatever's still sitting in the UBX
   * frame buffer first (e.g. a trailing NAV-SVIN fragment) so no bytes are
   * silently dropped at the handoff boundary. */
  enableRawMode(sink) {
    if (this._buf.length) {
      sink(new Uint8Array(this._buf));
      this._buf = [];
    }
    this._rawSink = sink;
  }

  _drain() {
    while (true) {
      const { message, rest } = Ubx.extractFrame(this._buf);
      this._buf = rest;
      if (!message) break;
      if (this._waiter) {
        const w = this._waiter;
        this._waiter = null;
        w.resolve(message);
      }
      // frames arriving with no pending waiter are dropped - same lossy-
      // between-explicit-reads behavior as the Python/Kotlin ports.
    }
  }

  /** Resolves with the next UBX message, or null after timeoutMs. Only one
   * outstanding call at a time (matches the sequential single-threaded
   * access pattern of the other two ports - the caller's own await chain
   * already guarantees this). */
  readMessage(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this._waiter = null;
        resolve(null);
      }, timeoutMs);
      this._waiter = {
        resolve: (msg) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(msg);
        },
      };
    });
  }

  async writeBytes(bytes) {
    await this._writer.write(bytes);
  }

  async sendAckWait(cls, id, payload = new Uint8Array(0), tries = 3) {
    const pkt = Ubx.frame(cls, id, payload);
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.writeBytes(pkt);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
        if (!msg) break;
        if (msg.cls === Ubx.CLS_ACK && msg.payload.length >= 2 && msg.payload[0] === cls && msg.payload[1] === id) {
          return msg.id === Ubx.ACK_ACK;
        }
      }
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

  /** CFG-PRT poll/modify/set: OR in the RTCM3X input-protocol bit,
   * preserving baud/other bits - matches ubx.py/Ubx.kt. */
  async enableRtcm3Input() {
    const payload = await this.poll(Ubx.CLS_CFG, Ubx.CFG_PRT);
    if (!payload || payload.length < 20) return false;
    const vals = new Uint8Array(payload);
    const dv = new DataView(vals.buffer);
    let inProto = dv.getUint16(12, true);
    inProto |= 0x20;
    dv.setUint16(12, inProto, true);
    return this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_PRT, vals);
  }

  async readNavPvt(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
      if (!msg) return null;
      if (msg.cls === Ubx.CLS_NAV && msg.id === Ubx.NAV_PVT && msg.payload.length >= 52) {
        return Ubx.parseNavPvt(msg.payload);
      }
    }
    return null;
  }

  async readMonVer(timeoutMs = 3000) {
    const payload = await this.poll(Ubx.CLS_MON, Ubx.MON_VER, timeoutMs);
    if (!payload) return null;
    return new TextDecoder("ascii").decode(payload).replace(/\0+$/, "");
  }

  // -- base-side ops (survey-in + RTCM3 output) --

  configureSurveyIn(minDurationS, accLimitM) {
    return this.sendAckWait(Ubx.CLS_CFG, Ubx.CFG_TMODE3, Ubx.surveyInPayload(minDurationS, accLimitM));
  }

  async enableRtcmBaseOutput(types = Object.keys(Ubx.RTCM_BASE_SET)) {
    const results = {};
    for (const name of types) {
      results[name] = await this.setMsgRateCurrentPort(Ubx.CLS_RTCM3, Ubx.RTCM_BASE_SET[name], 1);
    }
    return results;
  }

  async readNavSvin(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.readMessage(Math.max(50, deadline - Date.now()));
      if (!msg) return null;
      if (msg.cls === Ubx.CLS_NAV && msg.id === Ubx.NAV_SVIN && msg.payload.length >= 40) {
        return Ubx.parseNavSvin(msg.payload);
      }
    }
    return null;
  }
}

/** Pulls RTCM3 bytes from the backend's /ws/corrections bridge and writes
 * them into the local serial connection. backendUrl is the same "Backend
 * server" address used for Base control; host/port are the TCP relay's
 * (usually localhost:<base's relay port>, since the bridge runs server-side
 * next to the base). */
function startCorrectionsBridge(backendUrl, host, port, conn, onStatus) {
  let stopped = false;
  let ws = null;

  async function connectLoop() {
    while (!stopped) {
      try {
        const wsBase = backendUrl.replace(/^http/, "ws").replace(/\/$/, "");
        ws = new WebSocket(`${wsBase}/ws/corrections?host=${encodeURIComponent(host)}&port=${port}`);
        ws.binaryType = "arraybuffer";
        await new Promise((resolve, reject) => {
          ws.onopen = () => { onStatus(`corrections: connected via ${backendUrl}`); resolve(); };
          ws.onerror = () => reject(new Error("websocket error"));
          ws.onclose = () => resolve();
        });
        ws.onmessage = (ev) => {
          conn.writeBytes(new Uint8Array(ev.data)).catch(() => {});
        };
        await new Promise((resolve) => { ws.onclose = resolve; });
      } catch (e) {
        onStatus(`corrections: ${e.message}, retrying`);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  connectLoop();
  return { stop: () => { stopped = true; try { ws && ws.close(); } catch (e) {} } };
}

function relayWsUrl(backendUrl, channel, role) {
  const base = (backendUrl || location.origin).replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/ws/relay/${encodeURIComponent(channel)}?role=${role}`;
}

/** Free-tier relay hosts (Render) spin down after ~15min idle; the request
 * that wakes them back up can take 30-60s, and a WebSocket upgrade is a
 * flaky way to ride that out. Fire a plain GET in parallel with the actual
 * WS connect attempt so a sleeping backend is already waking up (or awake)
 * by the time the retry loop's 3s backoff comes back around. Best-effort -
 * errors here are expected and ignored. */
function warmUp(backendUrl) {
  try {
    const url = (backendUrl || location.origin).replace(/\/$/, "") + "/";
    fetch(url, { cache: "no-store", mode: "cors" }).catch(() => {});
  } catch (e) { /* ignore */ }
}

/** Live counters for a relay link, surfaced so the UI can show something
 * more concrete than "connected" - bytes actually flowing, and how long
 * ago the last one arrived (the fastest way to tell "corrections aren't
 * coming through" apart from "corrections are coming through but the
 * receiver still isn't fixing"). */
function relayStats(stats) {
  const ageS = stats.lastAt ? (Date.now() - stats.lastAt) / 1000 : null;
  return { bytes: stats.bytes, ageS };
}

/** Base side: uploads whatever bytes come out of `conn` (once it's in raw
 * mode, post-survey-in) to the cloud relay's /ws/relay/<channel>?role=base.
 * This is the piece that makes Base "run on the cloud" in the only sense
 * that's actually possible - the browser does all the USB/GPS work, the
 * backend just rebroadcasts bytes it never has to understand. */
function startRelayUpload(backendUrl, channel, conn, onStatus) {
  let stopped = false;
  let ws = null;
  let queue = [];
  const stats = { bytes: 0, lastAt: 0 };

  function connect() {
    if (stopped) return;
    warmUp(backendUrl);
    ws = new WebSocket(relayWsUrl(backendUrl, channel, "base"));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      onStatus(`relay: uploading on channel "${channel}"`);
      for (const chunk of queue) ws.send(chunk);
      queue = [];
    };
    ws.onclose = () => {
      if (!stopped) {
        onStatus("relay: upload link dropped, reconnecting");
        setTimeout(connect, 3000);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  connect();

  conn.enableRawMode((chunk) => {
    const copy = chunk.slice(); // own copy - the Uint8Array view may be reused by the reader
    stats.bytes += copy.length;
    stats.lastAt = Date.now();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(copy);
    else queue.push(copy);
  });

  return {
    stop: () => { stopped = true; try { ws && ws.close(); } catch (e) {} },
    stats: () => relayStats(stats),
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
  };
}

/** Rover side: pulls bytes from the cloud relay's /ws/relay/<channel> and
 * writes them into the local serial connection. */
function startRelayDownload(backendUrl, channel, conn, onStatus) {
  let stopped = false;
  let ws = null;
  const stats = { bytes: 0, lastAt: 0 };

  function connect() {
    if (stopped) return;
    warmUp(backendUrl);
    ws = new WebSocket(relayWsUrl(backendUrl, channel, "rover"));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => onStatus(`relay: receiving corrections on channel "${channel}"`);
    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data);
      stats.bytes += bytes.length;
      stats.lastAt = Date.now();
      conn.writeBytes(bytes).catch(() => {});
    };
    ws.onclose = () => {
      if (!stopped) {
        onStatus("relay: corrections link dropped, reconnecting");
        setTimeout(connect, 3000);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  connect();

  return {
    stop: () => { stopped = true; try { ws && ws.close(); } catch (e) {} },
    stats: () => relayStats(stats),
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
  };
}

if (typeof window !== "undefined") {
  window.SerialGnssConnection = SerialGnssConnection;
  window.startCorrectionsBridge = startCorrectionsBridge;
  window.startRelayUpload = startRelayUpload;
  window.startRelayDownload = startRelayDownload;
}
