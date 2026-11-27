'use strict';

/**
 * GenerateContent client.
 *
 * Uses the closure bundle's own gRPC-web stack (`_.Hw`) and protobuf schema
 * (`_.zu` / `_.Mv`).  That gives us the exact framing, JSON serialization and
 * error propagation AI Studio uses, including `grpc-web-status-details-bin`.
 */

const { parseCookieInput, toCookieHeader, buildAuthorization } = require('../google/auth');
const { digestRequest, setProof } = require('./request');

const FINISH_REASON = {
  0: 'FINISH_REASON_UNSPECIFIED',
  1: 'STOP',
  2: 'MAX_TOKENS',
  3: 'SAFETY',
  4: 'RECITATION',
  5: 'OTHER',
  6: 'BLOCKLIST',
  7: 'PROHIBITED_CONTENT',
  8: 'SPII',
};

const RPC_TO_HTTP = {
  1: 499, 2: 500, 3: 400, 4: 504, 5: 404, 6: 409, 7: 403, 8: 429,
  9: 400, 10: 409, 11: 400, 12: 501, 13: 500, 14: 503, 15: 500, 16: 401,
};

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function rawField(msg, field) {
  if (!msg) return undefined;
  const v = msg.Ve || msg;
  if (!Array.isArray(v)) return undefined;
  return v[field - 1];
}

function parseUsage(ns, msg) {
  const u = rawField(msg, 3);
  if (!u) return null;
  if (Array.isArray(u)) {
    return {
      promptTokenCount: Number(rawField(u, 1) || 0),
      candidatesTokenCount: Number(rawField(u, 2) || 0),
      totalTokenCount: Number(rawField(u, 3) || 0),
    };
  }
  return null;
}

function parseMessage(ns, msg) {
  const out = { candidates: [], usage: null };
  let cands = [];
  try { cands = ns.Lv(msg) || []; } catch { cands = []; }
  for (const c of cands) {
    let index = 0;
    try { index = Number(c.getIndex ? c.getIndex() : 0) || 0; } catch {}
    let content = null;
    try { content = c.ub ? c.ub() : null; } catch {}
    let parts = [];
    try { parts = content && content.tg ? content.tg() : []; } catch {}
    let text = '';
    let thought = false;
    for (const p of parts) {
      try {
        const t = p.getText ? p.getText() : '';
        if (t) text += t;
        if (p.Rh && p.Rh()) thought = true;
      } catch {}
    }
    let finishReason;
    try { finishReason = c.qA ? c.qA() : undefined; } catch {}
    out.candidates.push({
      index,
      text,
      thought,
      finishReason,
      finishReasonName: finishReason !== undefined ? FINISH_REASON[finishReason] || String(finishReason) : undefined,
      content,
    });
  }
  out.usage = parseUsage(ns, msg);
  return out;
}

class GenerateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GenerateError';
    this.code = options.code;
    this.httpStatus = options.httpStatus || (RPC_TO_HTTP[options.code] || 502);
    this.metadata = options.metadata;
    this.retryable = [4, 8, 10, 14].includes(options.code);
  }
}

class GeminiClient {
  constructor(options = {}) {
    this.ms = options.ms;
    this.ns = options.ms.ns;
    this.log = options.log || (() => {});
    this.base = options.base || 'https://alkalimakersuite-pa.clients6.google.com';
    this.origin = options.origin || 'https://aistudio.google.com';
    this.apiKey = options.apiKey || options.ms.apiKey;
    this.googleApiKey = options.googleApiKey || '';
    this.authUser = options.authUser ?? 0;
    this.visitId = options.visitId || '';
    this.userAgent = options.userAgent || '';
    this.extraHeaders = options.extraHeaders || {};
    this.cookieMap = options.cookieMap || parseCookieInput(options.cookies || '');
    this.cookieHeader = options.cookieHeader || toCookieHeader(this.cookieMap);
    this.authorizationOverride = options.authorization || '';
    this.timeoutMs = options.timeoutMs || 180000;
    this.service = null;
  }

  get authorization() {
    // SAPISIDHASH embeds a unix timestamp; refresh it on every request so a
    // long-running server does not start sending stale hashes.
    return this.authorizationOverride || buildAuthorization(this.cookieMap, this.origin);
  }

  get hasAuth() {
    return !!this.authorization;
  }

  setCookies(cookies) {
    this.cookieMap = parseCookieInput(cookies || '');
    this.cookieHeader = toCookieHeader(this.cookieMap);
  }

  metadata() {
    const h = {
      Authorization: this.authorization || '',
      Cookie: this.cookieHeader || '',
      'X-Goog-AuthUser': String(this.authUser),
      'X-Goog-Api-Key': this.googleApiKey || '',
      'x-aistudio-visit-id': this.visitId || '',
      // Browser requests carry these automatically; Node's fetch does not.
      Origin: this.origin,
      Referer: this.origin + '/',
      'User-Agent': this.userAgent || '',
      ...this.extraHeaders,
    };
    for (const k of Object.keys(h)) {
      if (h[k] === '' || h[k] === undefined || h[k] === null) delete h[k];
    }
    return h;
  }

  getService() {
    if (this.service) return this.service;
    if (!this.ns || !this.ns.Hw) throw new Error('bundle does not expose _.Hw');
    this.service = new this.ns.Hw(this.base, undefined, { yMd: true, withCredentials: true });
    return this.service;
  }

  async digest(req) {
    return digestRequest(this.ns, req);
  }

  prepare(req, proof) {
    if (proof) setProof(this.ns, req, proof);
    return req;
  }

  /**
   * Async iterator over parsed GenerateContentResponse messages.
   * Yields { candidates:[{index,text,delta,...}], usage, raw }.
   */
  async *stream(req, options = {}) {
    if (!req) throw new Error('request is required');
    const svc = this.getService();
    const metadata = { ...this.metadata(), ...(options.metadata || {}) };
    const queue = [];
    const waiters = [];
    let ended = false;
    let failure = null;
    let statusInfo = null;
    let streamObj = null;
    let timeoutTimer = null;

    const wake = () => { while (waiters.length) waiters.shift()(); };
    const push = (msg) => { queue.push(msg); wake(); };
    const fail = (err) => { failure = err; ended = true; wake(); };
    const end = () => { ended = true; wake(); };

    const setTimeoutGuard = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (this.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (ended) return;
          try { streamObj?.cancel?.(); } catch {}
          fail(new GenerateError(`GenerateContent timeout after ${this.timeoutMs} ms`, { code: 4, httpStatus: 504 }));
        }, this.timeoutMs);
      }
    };
    const cleanup = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    };

    try {
      streamObj = svc.generateContent(req, metadata);
    } catch (e) {
      throw new GenerateError(`generateContent failed: ${e && e.message}`, { code: 2, httpStatus: 500 });
    }

    setTimeoutGuard();
    streamObj.on('data', (msg) => push(msg));
    streamObj.on('status', (s) => { statusInfo = s; });
    streamObj.on('metadata', () => {});
    streamObj.on('end', () => { cleanup(); end(); });
    streamObj.on('error', (e) => {
      cleanup();
      const code = e && e.code;
      const details = e && e.message;
      fail(new GenerateError(details || 'GenerateContent RPC failed', {
        code,
        httpStatus: RPC_TO_HTTP[code] || 502,
        metadata: { ...(e && e.metadata), statusInfo },
      }));
    });

    const onAbort = () => {
      try { streamObj?.cancel?.(); } catch {}
      cleanup();
      fail(new GenerateError('aborted', { code: 1, httpStatus: 499 }));
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const lastText = new Map();
    try {
      for (;;) {
        if (queue.length) {
          const msg = queue.shift();
          const parsed = parseMessage(this.ns, msg);
          for (const c of parsed.candidates) {
            const prev = lastText.get(c.index) || '';
            let delta = c.text;
            if (c.text.startsWith(prev)) delta = c.text.slice(prev.length);
            else if (prev.startsWith(c.text)) delta = '';
            lastText.set(c.index, c.text);
            c.delta = delta;
          }
          yield { ...parsed, raw: msg };
          continue;
        }
        if (failure) throw failure;
        if (ended) break;
        await new Promise((r) => waiters.push(r));
      }
    } finally {
      cleanup();
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      try { streamObj?.cancel?.(); } catch {}
    }
  }

  async generate(req, options = {}) {
    const parts = [];
    let usage = null;
    let finishReason;
    let candidateIndex = 0;
    for await (const msg of this.stream(req, options)) {
      if (msg.usage) usage = msg.usage;
      for (const c of msg.candidates) {
        if (c.index !== candidateIndex) continue;
        if (c.delta) parts.push(c.delta);
        if (c.finishReason !== undefined) finishReason = c.finishReasonName;
      }
    }
    return {
      text: parts.join(''),
      finishReason: finishReason || 'STOP',
      usage,
    };
  }

  /**
   * Low-level path used by the catiecli WS executor: the backend hands us a
   * ready-made wire array plus a binding string; we only inject the proof and
   * POST the raw JSON.
   */
  async postWire(wire, options = {}) {
    const body = JSON.stringify(wire);
    const headers = {
      'content-type': 'application/json+protobuf',
      'x-user-agent': 'grpc-web-javascript/0.1',
      ...this.metadata(),
      ...(options.headers || {}),
    };
    const controller = new AbortController();
    const timer = options.timeoutMs === 0 ? null : setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    const onAbort = () => { try { controller.abort(); } catch {} };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await globalThis.fetch(
        `${this.base}/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent`,
        { method: 'POST', headers, body, signal: controller.signal, redirect: 'follow' },
      );
      const text = await res.text();
      if (!res.ok) {
        const err = new GenerateError(`HTTP ${res.status}: ${text.slice(0, 300)}`, { httpStatus: res.status, code: res.status === 401 ? 16 : 2 });
        err.body = text;
        throw err;
      }
      return text;
    } finally {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { GeminiClient, GenerateError, parseMessage, FINISH_REASON, RPC_TO_HTTP };
