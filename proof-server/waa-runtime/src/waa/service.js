'use strict';

/**
 * WAA service wrapper: Waa/Create -> download+execute botguard program ->
 * Qtb handshake -> snapshot(content) -> proof string.
 *
 * This is the exact flow that already works in the report; the remaining
 * blocker is the VM's `FNL...` production guard, which is a host-environment
 * probe issue and deliberately out of scope here.
 */

const { loadMakerSuite } = require('../browser/loader');
const { parseCookieInput, buildAuthorization, toCookieHeader } = require('../google/auth');
const crypto = require('node:crypto');

const PROOF_RE = /^!/;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decode the proof payload (no secrets leave the process; callers only use the
 * returned lengths/bytes for regime classification).
 *   proof := "!" || base64url_nopad(payload)
 */
function decodePayload(proof) {
  if (typeof proof !== 'string' || proof[0] !== '!') return null;
  const b = proof.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
  try {
    return Buffer.from(b + pad, 'base64');
  } catch {
    return null;
  }
}

/**
 * Cheap local health check (proof-bytes.md §3.1, program-crypto.md §5.1):
 *   p1 ^ p4 == 0x5a  -> frozen regime (content-free, cannot be accepted)
 *   p1 ^ p4 == 0x64  -> live-like regime (the only shape worth submitting)
 * In the envelope layout this byte is the low byte of the serialized register
 * length S, so it is a structural regime switch, not a random byte.
 */
function proofMode(proof) {
  const p = decodePayload(proof);
  if (!p || p.length < 6) return 'none';
  const x = p[1] ^ p[4];
  return x === 0x5a ? 'F' : x === 0x64 ? 'V' : 'x' + x.toString(16);
}

function payloadBytes(proof) {
  const p = decodePayload(proof);
  return p ? p.length : 0;
}

/** sha256 prefix of the post-header body (bytes 5..end), for A/B comparison. */
function bodySha16(proof) {
  const p = decodePayload(proof);
  if (!p || p.length <= 5) return null;
  return crypto.createHash('sha256').update(p.subarray(5)).digest('hex').slice(0, 16);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class WaaService {
  constructor(options = {}) {
    this.options = options;
    this.log = options.log || (() => {});
    this.apiKey = options.apiKey;
    this.metadata = options.metadata || null;
    this.cookies = options.cookies || '';
    this.cookieMap = options.cookieMap || parseCookieInput(this.cookies);
    this.origin = options.origin || 'https://aistudio.google.com';
    this.authUser = options.authUser ?? 0;
    this.visitId = options.visitId || '';
    this.extraHeaders = options.extraHeaders || null;
    this.authorization = options.authorization || buildAuthorization(this.cookieMap, this.origin);
    this.timeoutMs = options.timeoutMs || 180000;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs || 60000;
    // E1 warmth/regime controls.  Every default preserves the historical
    // behaviour, so existing commands are byte-for-byte unaffected.
    this.minAgeMs = Number(options.minAgeMs || 0);        // wait this long after the VM is ready before minting
    this.warmupMints = Number(options.warmupMints || 0);  // throw-away snapshots before the real one
    this.loggerAlways = !!options.loggerAlways;           // force Qtb logger throttle F=0 on every mint
    this.readyAt = 0;
    this.mints = 0;
    this.loggerForced = 0;
    this.warmupLog = [];
    this.lastMode = null;
    this.lastPayloadBytes = null;
    this.lastBodySha16 = null;
    this.ms = null;
    this.client = null;
    this.fetcher = null;
    this.service = null;
    this.qtb = null;
    this.ready = null;
    this.initStarted = 0;
    this.initFinished = 0;
    this.status = 'new';
    this.lastRaw = null;
  }

  getMetadata() {
    if (typeof this.metadata === 'function') return this.metadata();
    if (this.metadata) return this.metadata;
    const md = {
      'X-Goog-Api-Key': this.apiKey,
      'X-Goog-AuthUser': String(this.authUser ?? 0),
    };
    if (this.authorization) md['Authorization'] = this.authorization;
    if (this.visitId) md['x-aistudio-visit-id'] = this.visitId;
    return md;
  }

  async init() {
    if (this.ready) return this.ready;
    this.status = 'loading-bundle';
    this.initStarted = Date.now();
    if (this.options.ms) {
      this.log('debug', 'reusing already-loaded AI Studio bundle for WAA');
      this.ms = this.options.ms;
    } else {
      this.log('debug', 'loading AI Studio bundle for WAA');
      this.ms = loadMakerSuite({
        ...(this.options.bundle || {}),
        cookies: this.options.bundle?.cookies || this.cookies,
      });
    }
    if (this.cookies && this.ms.env && typeof this.ms.env.setCookies === 'function') {
      this.ms.env.setCookies(this.cookies);
    }
    if (!this.ms.ns || !this.ms.internal) throw new Error('bundle did not expose default_MakerSuite/__internal');
    const missing = ['jub', 'oub', 'qDa'].filter((k) => !this.ms.internal[k]);
    if (missing.length) throw new Error(`bundle is missing WAA internals: ${missing.join(',')}`);

    if (!this.apiKey) {
      this.apiKey = this.ms.apiKey;
      this.log('debug', `using bundle-embedded API key ${maskKey(this.apiKey)}`);
    }
    this.status = 'creating-service';

    const I = this.ms.internal;
    this.client = new I.oub();
    if (this.options.waaBase) this.client.F = String(this.options.waaBase).replace(/\/+$/, '');
    this.fetcher = new I.qDa(this.client, () => this.getMetadata());
    // Surface the RPC that is about to be sent.
    const origCreate = this.client.create.bind(this.client);
    this.client.create = (a, b, c) => {
      this.log('debug', 'Waa/Create request');
      return origCreate(a, b, c);
    };
    this.service = new I.jub({ fetcher: this.fetcher });

    this.ready = (async () => {
      this.status = 'initializing-vm';
      await this.waitForService();
      // The real page's `Cn` awaits `hub(service)` before snapshotting.  Only
      // waiting for Qtb.H can snapshot too early and yield a short proof.
      if (I.hub) {
        this.log('debug', 'waiting for hub(service)');
        await withTimeout(I.hub(this.service), this.timeoutMs, 'WAA hub');
        this.log('debug', 'hub(service) resolved');
      }
      this.qtb = this.service.H;
      if (!this.qtb) {
        if (this.service.X) throw this.service.X;
        throw new Error('WAA service has no Qtb instance');
      }
      this.log('debug', 'waiting for VM data callback (Qtb.H)');
      const res = await withTimeout(this.qtb.H, this.timeoutMs, 'Qtb VM callback');
      if (!res || typeof res.Rnc !== 'function') throw new Error('Qtb.H did not resolve to {Rnc}');
      this.vmResult = res;
      // Dispatch synthetic user interaction events on document.body so BotGuard's
      // 32-bucket DOM event histogram (tag 235 in 0x99) records realistic activity.
      this.simulateUserInteraction();
      // Trigger the initial snapshot so BotGuard starts its 61-frame requestAnimationFrame
      // sampler (~976ms total), then wait 1050ms for all 61 frames to complete before
      // exposing the VM as ready.
      if (this.service && typeof this.service.snapshot === 'function') {
        try {
          await withTimeout(
            Promise.resolve(this.service.snapshot({ Krc: { content: '0'.repeat(64) } })),
            this.snapshotTimeoutMs,
            'init warm-up snapshot',
          );
          await delay(1050);
          this.simulateUserInteraction();
        } catch {}
      }
      this.readyAt = Date.now();
      this.status = 'ready';
      this.initFinished = Date.now();
      const bg = this.ms.sandbox.botguard;
      this.botguardKeys = bg && typeof bg === 'object' ? Object.keys(bg) : [];
      // `f` was reported as a handshake-success signal, but Node runs have
      // been observed with f=true and FNL at the same time.  Treat it as a
      // hint only; the real success criterion is a proof starting with "!".
      this.log('info', `WAA ready in ${this.initFinished - this.initStarted} ms (VM callback registered, botguard=[${this.botguardKeys.join(',')}], f=${this.botguardKeys.includes('f')} — not a reliable proof criterion)`);
      return this;
    })();

    return this.ready;
  }

  simulateUserInteraction() {
    try {
      const sb = this.ms && this.ms.sandbox;
      const body = sb && sb.document && sb.document.body;
      if (!body || typeof body.dispatchEvent !== 'function') return;
      const now = () => (sb.performance && typeof sb.performance.now === 'function' ? sb.performance.now() : Date.now());
      this._simSeq = (this._simSeq || 0) + 1;
      const seq = this._simSeq;
      const t0 = Math.max(now(), (this._lastClickTs || 0) + 1);
      const t1 = t0 + 11 + (seq % 6);
      this._lastClickTs = t1;
      const target = {
        tagName: 'BUTTON',
        nodeType: 1,
        getBoundingClientRect: () => ({ x: 800, y: 600, left: 800, top: 600, width: 80, height: 36 }),
      };
      body.dispatchEvent({ type: 'input', target, currentTarget: body, isTrusted: true, timeStamp: t0 });
      body.dispatchEvent({
        type: 'click',
        target,
        currentTarget: body,
        isTrusted: true,
        timeStamp: t1,
        clientX: 815 + (seq % 13),
        clientY: 610 + (seq % 9),
        pointerType: 'mouse',
      });
    } catch {}
  }

  async waitForService() {
    const started = Date.now();
    let lastLog = 0;
    for (;;) {
      if (this.service.H) return this.service.H;
      if (this.service.X) throw this.service.X;
      const elapsed = Date.now() - started;
      if (elapsed > this.timeoutMs) {
        throw new Error(`WAA service init timeout after ${elapsed} ms (status=${this.status})`);
      }
      if (elapsed - lastLog > 5000) {
        lastLog = elapsed;
        this.log('debug', `still initializing WAA (${(elapsed / 1000).toFixed(0)}s): ${this.status}, requests=${this.ms?.env?.requests?.length ?? 0}`);
      }
      await delay(5);
    }
  }

  /**
   * Qtb holds a per-instance logger throttle (`this.F = random*200`); its
   * snapshot logger only records an event when `F <= 0`, then re-rolls it.
   * Setting it to 0 forces record capture (browser-oracle.md §2).
   */
  forceLogger() {
    if (this.qtb && 'F' in this.qtb) {
      this.qtb.F = 0;
      this.loggerForced += 1;
    }
  }

  /**
   * Apply the E1 warmth controls immediately before a real mint: optional
   * throw-away warm-up snapshots, then the minimum-age wait measured from the
   * moment the VM became ready.  With all options at defaults this is a no-op.
   */
  async beforeMint(content) {
    await this.ready;
    this.simulateUserInteraction();
    const started = Date.now();
    if (this.loggerAlways) this.forceLogger();
    if (this.warmupMints > 0 && this.service && typeof this.service.snapshot === 'function') {
      const n = this.warmupMints;
      this.warmupMints = 0; // never warm up twice for the same service
      for (let i = 0; i < n; i++) {
        if (this.loggerAlways) this.forceLogger();
        const t = Date.now();
        try {
          const v = String(await withTimeout(
            Promise.resolve(this.service.snapshot({ Krc: { content: String(content) } })),
            this.snapshotTimeoutMs,
            'warm-up snapshot',
          ));
          this.warmupLog.push({ i, ms: Date.now() - t, len: v.length, mode: proofMode(v), bytes: payloadBytes(v) });
        } catch (e) {
          this.warmupLog.push({ i, ms: Date.now() - t, error: e && e.message });
        }
      }
      this.log('debug', `warm-up mints: ${JSON.stringify(this.warmupLog)}`);
    }
    if (this.loggerAlways) this.forceLogger();
    const wait = this.minAgeMs - (Date.now() - (this.readyAt || Date.now()));
    if (wait > 0) {
      this.log('debug', `waiting ${wait} ms for minAgeMs=${this.minAgeMs}`);
      await delay(wait);
    }
    return { waitMs: Date.now() - started };
  }

  /**
   * Ask the VM for a proof over `content` (normally a SHA-256 hex digest).
   * Returns the raw string.  Callers decide whether `!...` is required.
   */
  async snapshotRaw(content) {
    const run = () => this._snapshotRawImpl(content);
    const p = (this._snapshotQueue || Promise.resolve()).then(run, run);
    this._snapshotQueue = p.catch(() => {});
    return p;
  }

  async _snapshotRawImpl(content) {
    if (!this.ready) await this.init();
    await this.ready;
    if (!this.vmResult) throw new Error('WAA VM is not ready');
    const started = Date.now();
    await this.beforeMint(content);
    // Prefer the bundle's own `jub.snapshot` -> `Qtb.snapshot` path.  It adds
    // the Ctb logger wrapper around the VM callback, exactly like the page's
    // `Cn` does.  The direct `Rnc` path is kept as a fallback.
    if (this.service && typeof this.service.snapshot === 'function') {
      try {
        const value = String(await withTimeout(
          Promise.resolve(this.service.snapshot({ Krc: { content: String(content) } })),
          this.snapshotTimeoutMs,
          'snapshot',
        ));
        this.lastRaw = value;
        this.recordMint(value);
        this.log('debug', `snapshot(${String(content).slice(0, 12)}...) -> len=${value.length} mode=${this.lastMode} bytes=${this.lastPayloadBytes} in ${Date.now() - started} ms (jub.snapshot)`);
        return value;
      } catch (e) {
        this.log('warn', `jub.snapshot failed, falling back to Rnc: ${e && e.message}`);
      }
    }
    const fn = this.vmResult.Rnc;
    const value = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`snapshot timeout after ${this.snapshotTimeoutMs} ms`));
      }, this.snapshotTimeoutMs);
      const cb = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lastRaw = String(v);
        resolve(String(v));
      };
      try {
        fn(cb, [{ content: String(content) }, undefined, undefined, undefined]);
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    this.log('debug', `snapshot(${String(content).slice(0, 12)}...) -> len=${value.length} head=${value.slice(0, 24)} in ${Date.now() - started} ms`);
    this.recordMint(value);
    return value;
  }

  /** Regime/health telemetry for the mint that just happened (no secrets). */
  recordMint(value) {
    this.mints += 1;
    this.lastRaw = value;
    this.lastMode = proofMode(value);
    this.lastPayloadBytes = payloadBytes(value);
    this.lastBodySha16 = bodySha16(value);
  }

  async snapshot(content) {
    const value = await this.snapshotRaw(content);
    if (!PROOF_RE.test(value)) {
      const err = new Error(`WAA VM returned a non-proof value (${value.length} chars): ${value.slice(0, 120)}`);
      err.code = value.startsWith('FNL') ? 'WAA_FNL' : 'WAA_BAD_PROOF';
      err.raw = value;
      throw err;
    }
    return value;
  }

  async close() {
    try { this.service?.dispose?.(); } catch {}
  }

  describe() {
    return {
      status: this.status,
      apiKey: maskKey(this.apiKey),
      initMs: this.initFinished ? this.initFinished - this.initStarted : null,
      botguardKeys: this.botguardKeys || [],
      vmHandshake: !!(this.botguardKeys || []).includes('f'),
      requests: this.ms?.env?.requests?.map((r) => ({
        method: r.method, url: r.url, status: r.status, bytes: r.responseLength || r.bodyLength,
      })) || [],
      lastRaw: this.lastRaw ? { length: this.lastRaw.length, head: this.lastRaw.slice(0, 80) } : null,
      // E1 regime telemetry (lengths / hashes / enum labels only).
      readyAt: this.readyAt || null,
      minAgeMs: this.minAgeMs,
      warmupMints: this.warmupMints,
      warmupLog: this.warmupLog,
      loggerAlways: this.loggerAlways,
      loggerForced: this.loggerForced,
      mints: this.mints,
      lastMode: this.lastMode,
      lastPayloadBytes: this.lastPayloadBytes,
      lastBodySha16: this.lastBodySha16,
    };
  }
}

function maskKey(key) {
  if (!key) return '(none)';
  const s = String(key);
  return s.length <= 12 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

module.exports = { WaaService, withTimeout, maskKey, PROOF_RE, decodePayload, proofMode, payloadBytes, bodySha16 };
