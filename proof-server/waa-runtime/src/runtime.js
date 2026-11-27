'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadMakerSuite } = require('./browser/loader');
const { GeminiClient } = require('./waa/client');
const { buildRequest, digestRequest, setProof } = require('./waa/request');
const { createProofProvider } = require('./proof');
const { parseCookieInput, toCookieHeader, loadCookieFile, buildAuthorization, summarizeCookies, applySetCookies, rotateGoogleCookies } = require('./google/auth');

/**
 * Runtime = bundle + auth + request builder + proof provider.
 *
 * The proof provider is the only browser-dependent part; everything else is
 * pure Node.  `browser` runs Google's VM in headless Chrome, `node-vm` is the
 * incomplete pure-Node path, `static` replays a captured proof.
 */
class Runtime {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.ms = null;
    this.client = null;
    this.proof = null;
    this.startedAt = Date.now();
    this.cookieMap = new Map();
    this.cookieSource = 'none';
    this._initPromise = null;
    this.ready = false;
    this.initError = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const cfg = this.cfg;
      // Cookies must be loaded before the bundle so the Waa/Create request
      // (not just GenerateContent) is authenticated.  The live page's WAA
      // challenge is issued to an authenticated client; an anonymous challenge
      // is one of the suspected frozen-regime triggers.
      this.loadCookies();
      const rotateAge = Date.now() - Number(cfg.lastCookieRotateAt || 0);
      if (this.cookieMap.size > 0 && cfg.autoRotateCookies !== false && rotateAge > 480000) {
        await this.rotateCookies();
      }
      const cookieHeader = toCookieHeader(this.cookieMap);
      this.log('debug', `loading AI Studio bundle (cookies=${this.cookieMap.size})`);
      this.ms = loadMakerSuite({
        bundlePath: cfg.bundlePath,
        cacheDir: cfg.cacheDir,
        origin: cfg.origin,
        pageUrl: cfg.pageUrl,
        userAgent: cfg.userAgent,
        chromeVersion: cfg.chromeVersion,
        cookies: cookieHeader,
        log: this.log,
        refreshProgram: cfg.refreshProgram,
        challengeCache: cfg.challengeCache || '',
        saveChallengePath: cfg.saveChallenge
          ? (cfg.challengeCache || path.join(cfg.cacheDir, 'challenge.json'))
          : '',
        instrumentProgram: cfg.instrumentProgram,
      });
      if (!this.ms.ns || !this.ms.internal) throw new Error('bundle did not load default_MakerSuite/__internal');
      this.ms.env.onSetCookies = (sc) => {
        const upd = applySetCookies(this.cookieMap, sc);
        if (upd.length) this._syncCookies(upd, 'Set-Cookie');
      };
      this.log('debug', `bundle ready: ${this.ms.symbols.length} symbols, apiKey=${this.ms.apiKey ? this.ms.apiKey.slice(0, 8) + '…' : 'none'}`);

      this.client = new GeminiClient({
        ms: this.ms,
        apiKey: this.ms.apiKey,
        googleApiKey: cfg.googleApiKey,
        authorization: cfg.authorization,
        origin: cfg.origin,
        base: cfg.makerSuiteBase,
        cookies: cookieHeader,
        cookieMap: this.cookieMap,
        authUser: cfg.authUser,
        visitId: cfg.visitId,
        userAgent: cfg.userAgent,
        timeoutMs: cfg.generateTimeoutMs,
        extraHeaders: cfg.extraHeaders,
        log: this.log,
      });

      this.log('debug', `creating proof provider: ${cfg.proofProvider}`);
      this.proof = await createProofProvider(cfg.proofProvider, {
        ms: this.ms,
        apiKey: this.ms.apiKey,
        cookies: cookieHeader,
        cookieMap: this.cookieMap,
        authorization: this.client.authorization || cfg.authorization,
        authUser: cfg.authUser,
        visitId: cfg.visitId,
        origin: cfg.origin,
        userAgent: cfg.userAgent,
        bundlePath: cfg.bundlePath,
        chromePath: cfg.chromePath,
        headless: cfg.browserHeadless,
        userAgent: cfg.userAgent,
        timeoutMs: cfg.waaInitTimeoutMs,
        snapshotTimeoutMs: cfg.snapshotTimeoutMs,
        allowInvalidProof: cfg.allowInvalidProof,
        proof: cfg.staticProof,
        proofFile: cfg.staticProofFile,
        bindingContent: cfg.carryContent,
        // E1 warmth/regime controls (default 0 / false = no behaviour change).
        minAgeMs: cfg.minChallengeAgeMs,
        warmupMints: cfg.warmupMints,
        loggerAlways: cfg.loggerAlways,
        log: this.log,
        parentUrl: cfg.browserParentUrl,
        settleMs: cfg.browserSettleMs,
        extraArgs: cfg.chromeArgs,
        profileDir: cfg.chromeProfileDir,
      });
      this.log('info', `runtime ready: provider=${cfg.proofProvider}, auth=${this.client.hasAuth ? 'cookie' : 'none'}, model=${cfg.defaultModel}`);
      if (this.cookieMap.size > 0 && cfg.autoRotateCookies !== false) {
        const intervalMs = Number(cfg.cookieRotateIntervalMs || 540000);
        if (intervalMs > 0) {
          this._rotateTimer = setInterval(() => {
            this.rotateCookies().catch(() => {});
          }, intervalMs);
          if (this._rotateTimer && typeof this._rotateTimer.unref === 'function') {
            this._rotateTimer.unref();
          }
        }
      }
      this.ready = true;
      return this;
    })().catch((e) => {
      this.initError = e;
      throw e;
    });
    return this._initPromise;
  }

  loadCookies() {
    const cfg = this.cfg;
    let raw = cfg.cookies || '';
    if (cfg.cookieFile) {
      try {
        this.cookieMap = loadCookieFile(cfg.cookieFile);
        this.cookieSource = cfg.cookieFile;
        return this.cookieMap;
      } catch (e) {
        throw new Error(`cannot read cookie file ${cfg.cookieFile}: ${e.message}`);
      }
    }
    if (cfg.cookieJson) {
      raw = cfg.cookieJson;
      this.cookieSource = 'json';
    }
    this.cookieMap = parseCookieInput(raw);
    if (this.cookieMap.size) this.cookieSource = this.cookieSource === 'none' ? 'inline' : this.cookieSource;
    return this.cookieMap;
  }

  async rotateCookies() {
    if (!this.cookieMap || this.cookieMap.size === 0) return { ok: false, updated: [] };
    const res = await rotateGoogleCookies(this.cookieMap, { userAgent: this.cfg.userAgent });
    if (res.updated && res.updated.length) {
      this._syncCookies(res.updated, 'RotateCookies');
    }
    return res;
  }

  _syncCookies(updatedNames = [], via = 'rotate') {
    const header = toCookieHeader(this.cookieMap);
    this.cfg.cookies = header;
    if (this.client) this.client.setCookies(header);
    if (this.ms && this.ms.env && typeof this.ms.env.setCookies === 'function') {
      this.ms.env.setCookies(header);
    }
    if (this.proof && this.proof.service) {
      this.proof.service.cookies = header;
      this.proof.service.cookieMap = this.cookieMap;
      this.proof.service.authorization = buildAuthorization(this.cookieMap, this.cfg.origin);
    }
    this.log('debug', `cookies refreshed via ${via}: [${updatedNames.join(', ')}]`);
    const now = Date.now();
    this.cfg.lastCookieRotateAt = now;
    if (this.cfg.persistCookies === false) return;
    try {
      if (this.cfg.profile && fs.existsSync(this.cfg.profile)) {
        const p = JSON.parse(fs.readFileSync(this.cfg.profile, 'utf8'));
        p.cookies = header;
        p.lastCookieRotateAt = now;
        fs.writeFileSync(this.cfg.profile, JSON.stringify(p, null, 2));
      } else if (this.cfg.cookieFile && fs.existsSync(this.cfg.cookieFile)) {
        fs.writeFileSync(this.cfg.cookieFile, header + '\n');
      }
    } catch (e) {
      this.log('warn', `cannot persist refreshed cookies: ${e && e.message}`);
    }
  }

  async prepare(options = {}) {
    await this.init();
    const rawModel = options.model || this.cfg.defaultModel;
    const normModel = (rawModel && !rawModel.startsWith('models/') && !rawModel.includes('test'))
      ? `models/${rawModel}`
      : rawModel;
    const req = options.req || buildRequest(this.ms.ns, {
      model: normModel,
      messages: options.messages || [],
      generationConfig: options.generationConfig,
      system: options.system,
      carryContent: options.carryContent ?? this.cfg.carryContent,
    });
    const digest = await digestRequest(this.ms.ns, req);
    const proof = await this.proof.snapshot(digest);
    setProof(this.ms.ns, req, proof);
    return { req, digest, proof };
  }

  async *stream(options = {}) {
    const { req } = await this.prepare(options);
    yield* this.client.stream(req, { signal: options.signal, metadata: options.metadata });
  }

  async generate(options = {}) {
    const { req, digest, proof } = await this.prepare(options);
    try {
      const result = await this.client.generate(req, { signal: options.signal, metadata: options.metadata });
      return { ...result, digest, proofLength: proof.length };
    } catch (e) {
      if ((e && (e.code === 7 || e.code === 16 || e.httpStatus === 401 || e.httpStatus === 403)) && this.cookieMap.size > 0 && !options._retriedAfterRotate) {
        const rot = await this.rotateCookies();
        this.log('info', `retrying generate after refreshing session/WAA (rotated=${rot && rot.updated ? rot.updated.length : 0})`);
        if (this.proof && this.proof.service && this.proof.service.service && typeof this.proof.service.service.iA === 'function') {
          await this.proof.service.service.iA();
        }
        return await this.generate({ ...options, _retriedAfterRotate: true });
      }
      throw e;
    }
  }

  /**
   * WS-executor path: the backend already built the wire and the binding
   * string.  We only add the proof (wire[4]) and POST it.
   */
  async generateWire(wire, binding, options = {}) {
    await this.init();
    const digest = sha256Hex(String(binding));
    const proof = await this.proof.snapshot(digest);
    const w = Array.isArray(wire) ? wire.slice() : JSON.parse(JSON.stringify(wire));
    while (w.length < 5) w.push(null);
    w[4] = proof;
    const raw = await this.client.postWire(w, { timeoutMs: options.timeoutMs, headers: options.headers, signal: options.signal });
    return { raw, proofLength: proof.length, digest };
  }

  async snapshotDigest(digest) {
    await this.init();
    return this.proof.snapshot(String(digest));
  }

  authSummary() {
    return {
      ...summarizeCookies(this.cookieMap),
      source: this.cookieSource,
      authorization: this.cookieMap.size ? buildAuthorization(this.cookieMap, this.cfg.origin).slice(0, 60) + '…' : '',
    };
  }

  describe() {
    return {
      ready: this.ready,
      initError: this.initError ? this.initError.message : null,
      uptimeMs: Date.now() - this.startedAt,
      provider: this.cfg.proofProvider,
      model: this.cfg.defaultModel,
      bundle: {
        path: this.cfg.bundlePath,
        symbols: this.ms ? this.ms.symbols.length : null,
        apiKey: this.ms && this.ms.apiKey ? `${this.ms.apiKey.slice(0, 8)}…${this.ms.apiKey.slice(-4)}` : null,
      },
      auth: this.authSummary(),
      proof: this.proof ? this.proof.describe() : null,
    };
  }

  async close() {
    if (this._rotateTimer) {
      clearInterval(this._rotateTimer);
      this._rotateTimer = null;
    }
    if (this.proof) await this.proof.close();
    this.proof = null;
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

module.exports = { Runtime, sha256Hex };
