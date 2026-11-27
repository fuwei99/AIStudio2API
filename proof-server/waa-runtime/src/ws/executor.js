'use strict';

/**
 * catiecli Playground WS executor, reimplemented in Node.
 *
 * Protocol (from pg_executor.user.js):
 *   -> {type:"register", clientVersion:"2.4.2", apiKey:"cat-...", executorType:"playground"}
 *   <- {type:"request", requestId, model, stream, requestBody:"{\"wire\":[...],\"binding\":\"...\"}"}
 *   -> {type:"stream-chunk", requestId, chunkBody} + {type:"stream-end", requestId, status:200}
 *   -> {type:"response", requestId, status:200, rawResponse}
 *   -> {type:"error", requestId, status, error:{code,message}}
 *   <- {type:"cancel", requestId}
 *
 * The backend builds the protobuf wire and the binding string; this executor
 * only computes SHA-256(binding), injects the WAA proof at wire[4], and POSTs
 * the raw JSON to MakerSuiteService/GenerateContent.
 */

class CatiecliExecutor {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.cfg = options.cfg || {};
    this.log = options.log || (() => {});
    this.onRequestDone = options.onRequestDone || null;
    this.wsUrl = options.wsUrl || this.cfg.wsUrl || 'wss://catiecli.sukaka.top/api/build/ws';
    this.apiKey = options.apiKey || '';
    this.clientVersion = options.clientVersion || this.cfg.wsClientVersion || '2.4.2';
    this.executorType = options.executorType || 'playground';
    this.carryContent = options.carryContent || this.cfg.carryContent || '';
    this.carryProof = options.carryProof || this.cfg.staticProof || '';
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.stopped = true;
    this.reconnectMs = 1000;
    this.reconnectTimer = null;
    this.queue = Promise.resolve();
    this.active = new Map();
    this.outbox = [];
    this.outboxHold = false;
    this.maxOutbox = options.maxOutbox || 500;
    this.stats = { requests: 0, ok: 0, failed: 0, reconnects: 0, startedAt: Date.now() };
    this.status = 'idle';
  }

  start() {
    if (!this.apiKey) throw new Error('catiecli API key is required (cat-...)');
    if (!this.WebSocketImpl) throw new Error('WebSocket is not available (Node >= 22 required)');
    this.stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.status = 'stopped';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws && this.ws.close(1000, 'client stop'); } catch {}
    this.ws = null;
  }

  _connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    this.log('info', `connecting to ${this.wsUrl}`);
    let ws;
    try {
      ws = new this.WebSocketImpl(this.wsUrl);
    } catch (e) {
      this.log('warn', `WebSocket create failed: ${e.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.status = 'connected';
      this.reconnectMs = 1000;
      this.log('info', 'WS connected, registering executor');
      this._send({
        type: 'register',
        clientVersion: this.clientVersion,
        apiKey: this.apiKey,
        executorType: this.executorType,
      });
      this._flushOutbox();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); }
      catch (e) { this.log('warn', `invalid WS message: ${e.message}`); return; }
      this.handleMessage(msg).catch((e) => this.log('warn', `message handler failed: ${e && (e.stack || e.message)}`));
    });
    ws.addEventListener('close', (ev) => {
      const code = ev && ev.code;
      this.status = 'disconnected';
      this.ws = null;
      if (this.stopped) return;
      if (code === 4001) this.log('warn', 'WS closed 4001: another executor replaced this API key');
      else if (code === 4002) this.log('warn', 'WS closed 4002: API key changed');
      else this.log('warn', `WS closed (${code || '?'}${ev && ev.reason ? ': ' + ev.reason : ''})`);
      this._scheduleReconnect();
    });
    ws.addEventListener('error', (ev) => {
      this.log('warn', `WS error: ${ev && (ev.message || ev.error && ev.error.message) || 'unknown'}`);
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 1.8, 30000);
    this.log('info', `reconnecting in ${Math.round(delay)} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) {
      this._enqueueOutbox(obj);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.log('warn', `WS send failed: ${e.message}`);
      this._enqueueOutbox(obj);
      return false;
    }
  }

  _enqueueOutbox(obj) {
    if (obj && obj.type === 'register') return;
    this.outbox.push({ msg: obj, ts: Date.now() });
    if (this.outbox.length > this.maxOutbox) this.outbox.shift();
    if (!this.outboxHold) {
      this.outboxHold = true;
      this.log('info', `executor disconnected; queueing results (${this.outbox.length})`);
    }
  }

  _flushOutbox() {
    if (!this.outbox.length) {
      this.outboxHold = false;
      return;
    }
    let sent = 0;
    while (this.outbox.length) {
      const item = this.outbox[0];
      if (!this.ws || this.ws.readyState !== 1) break;
      try {
        this.ws.send(JSON.stringify(item.msg));
        this.outbox.shift();
        sent++;
      } catch (e) {
        this.log('warn', `outbox flush failed: ${e.message}`);
        break;
      }
    }
    this.outboxHold = this.outbox.length > 0;
    if (sent) this.log('info', `flushed ${sent} queued result(s), ${this.outbox.length} left`);
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'request':
        return this._enqueueRequest(msg);
      case 'cancel': {
        const c = this.active.get(msg.requestId);
        if (c) {
          this.log('info', `cancel ${String(msg.requestId).slice(0, 8)}`);
          try { c.abort(); } catch {}
        }
        return;
      }
      case 'ping':
        return this._send({ type: 'pong', requestId: msg.requestId });
      default:
        this.log('debug', `ignoring WS message type=${msg.type}`);
    }
  }

  _enqueueRequest(msg) {
    const requestId = msg.requestId;
    if (this.active.has(requestId)) return;
    const controller = new AbortController();
    this.active.set(requestId, controller);
    const task = async () => {
      if (controller.signal.aborted) {
        this.active.delete(requestId);
        return;
      }
      await this._runRequest(msg, controller);
    };
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  async _runRequest(msg, controller) {
    const { requestId, stream } = msg;
    const started = Date.now();
    this.stats.requests++;
    this.log('info', `request ${String(requestId).slice(0, 8)} model=${msg.model}${stream ? ' (stream)' : ''}`);
    try {
      let payload;
      try { payload = JSON.parse(msg.requestBody); }
      catch (e) {
        throw Object.assign(new Error(`requestBody is not valid JSON: ${e.message}`), { httpStatus: 400, codeName: 'invalid_request_body' });
      }
      if (!payload || !Array.isArray(payload.wire) || typeof payload.binding !== 'string') {
        throw Object.assign(new Error('requestBody must contain {wire: [...], binding: "..."}'), { httpStatus: 400, codeName: 'invalid_payload' });
      }
      let wire = payload.wire;
      let binding = payload.binding;
      if (this.carryContent && this.carryProof) {
        // Proof-binding workaround for the WS protocol: keep a fixed content
        // in `contents` (the captured proof covers it) and carry the backend's
        // real prompt in systemInstruction.
        const original = extractWireText(wire);
        wire = Array.isArray(wire) ? wire.slice() : JSON.parse(JSON.stringify(wire));
        wire[1] = [[[[null, String(this.carryContent)]], 'user']];
        wire[5] = [[[null, original || '']], 'user'];
        binding = String(this.carryContent);
        this.log('debug', `carry-content wire rewritten (original ${String(original).length} chars)`);
      }
      const result = await this.runtime.generateWire(wire, binding, {
        signal: controller.signal,
        timeoutMs: this.cfg.generateTimeoutMs,
      });
      if (controller.signal.aborted) {
        this._sendError(requestId, 499, 'cancelled', 'request cancelled');
        return;
      }
      if (stream) {
        this._send({ type: 'stream-chunk', requestId, chunkBody: result.raw });
        this._send({ type: 'stream-end', requestId, status: 200 });
      } else {
        this._send({ type: 'response', requestId, status: 200, rawResponse: result.raw });
      }
      this.stats.ok++;
      this.log('info', `done ${String(requestId).slice(0, 8)} in ${Date.now() - started} ms (proof ${result.proofLength} chars)`);
    } catch (e) {
      this.stats.failed++;
      if (controller.signal.aborted) {
        this._sendError(requestId, 499, 'cancelled', 'request cancelled');
      } else {
        const status = e.httpStatus || e.status || 502;
        this._sendError(requestId, status, e.codeName || e.code || 'executor_error', e.message || String(e));
      }
      this.log('warn', `failed ${String(requestId).slice(0, 8)}: ${e.message}`);
    } finally {
      this.active.delete(requestId);
      try { this.onRequestDone && this.onRequestDone(); } catch {}
    }
  }

  _sendError(requestId, status, code, message) {
    this._send({
      type: 'error',
      requestId,
      status: Number(status) || 502,
      error: { code: String(code), message: String(message).slice(0, 1000) },
    });
  }

  describe() {
    return {
      status: this.status,
      wsUrl: this.wsUrl,
      stats: { ...this.stats, uptimeMs: Date.now() - this.stats.startedAt },
      active: this.active.size,
    };
  }
}

function extractWireText(wire) {
  try {
    const contents = wire && wire[1];
    if (!Array.isArray(contents)) return '';
    const lines = [];
    for (const c of contents) {
      if (!Array.isArray(c)) continue;
      const parts = c[0];
      const role = c[1] || 'user';
      if (!Array.isArray(parts)) continue;
      const text = parts.map((p) => (Array.isArray(p) && typeof p[1] === 'string' ? p[1] : '')).join('');
      if (text) lines.push(`${role === 'model' ? 'Assistant' : 'User'}: ${text}`);
    }
    return lines.join('\n\n');
  } catch { return ''; }
}

module.exports = { CatiecliExecutor, extractWireText };
