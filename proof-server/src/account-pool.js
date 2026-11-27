'use strict';

// VM 初始化硬超时：2.17MB bundle 编译 + Waa/Create 正常 2~5s，压满时最多 ~75s。
// 没有这个超时，一个卡死的 init 会永久占住 initSemaphore 槽位（sweep 还会跳过 initPromise 非空的条目），
// 槽位占满后所有 mint 永久排队、池内存持续膨胀（线上曾因此静默停摆 19 小时）。
const INIT_TIMEOUT_MS = Math.max(10000, Number(process.env.INIT_TIMEOUT_MS || 120000));

/**
 * Multi-Account In-Memory WAA Pool (single tier: 1h hot VM)
 *
 * Security & Privacy:
 *   - ZERO disk persistence: Cookies are never written to any file.
 *   - Minimal Cookie Filter: strips non-essential tracking cookies and keeps
 *     only the required Google authentication cookies.
 *   - Cookies are owned by the caller: every request mirrors the caller's
 *     cookies into the pool, which never rotates or echoes them.
 *
 * Lifecycle:
 *   - Hot (default 1 hour): one initialized `node:vm` context per account
 *     (~1.5-3 MB heap), minting `!proof` in ~10-30 ms.
 *   - Idle > hotTtlMs: VM disposed and the account entry deleted; the next
 *     request pays a fresh cold start (~600 ms - 1 s).
 */

const crypto = require('node:crypto');
const path = require('node:path');

const RUNTIME_ROOT = path.resolve(__dirname, '..', 'waa-runtime');
const { loadConfig } = require(path.join(RUNTIME_ROOT, 'src/config'));
const { Runtime } = require(path.join(RUNTIME_ROOT, 'src/runtime'));
const {
  parseCookieInput,
  toCookieHeader,
  buildAuthorization,
} = require(path.join(RUNTIME_ROOT, 'src/google/auth'));

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const MINIMAL_COOKIE_WHITELIST = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  'NID',
  'LSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  '__Host-GAPS',
  'ACCOUNT_CHOOSER',
]);

function extractMinimalCookies(rawInput) {
  const fullMap = parseCookieInput(rawInput || '');
  const minMap = new Map();
  for (const [k, v] of fullMap.entries()) {
    if (MINIMAL_COOKIE_WHITELIST.has(k) && v) {
      minMap.set(k, v);
    }
  }
  return {
    map: minMap,
    header: toCookieHeader(minMap, { includeAccountHost: true }),
    rpcHeader: toCookieHeader(minMap, { includeAccountHost: false }),
  };
}

function computeAccountId(cookieMap, authUser = 0) {
  const anchor =
    cookieMap.get('SAPISID') ||
    cookieMap.get('__Secure-3PAPISID') ||
    cookieMap.get('__Secure-1PAPISID') ||
    cookieMap.get('SID') ||
    cookieMap.get('__Secure-3PSID') ||
    toCookieHeader(cookieMap);
  const digest = crypto
    .createHash('sha256')
    .update(`${anchor}|u=${Number(authUser || 0)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `acc_${digest}`;
}

function extractTextFromPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function parseBase64Data(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const m = trimmed.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (m) return m[2].replace(/\s+/g, '');
    return '';
  }
  if (typeof input === 'object') {
    const raw = input.data || input.base64 || input.file_data || input.url || '';
    if (typeof raw === 'string' && raw.length > 0) {
      const m = raw.trim().match(/^data:([^;,]+);base64,([\s\S]+)$/i);
      if (m) return m[2].replace(/\s+/g, '');
      return raw.replace(/\s+/g, '');
    }
  }
  return '';
}

/**
 * Compute the exact array of per-Part `_.Wm(part)` strings for `_.SB(req)` (`texts.join(' ')` -> SHA-256)
 * from any of `wireContents`, `messages` (OpenAI), `contents` (Gemini), or `prompt`.
 */
function extractPartTextsForDigest(payload = {}) {
  const texts = [];

  // 1. If `wireContents` (`wire[1]`) is provided directly, walk every wire part
  if (Array.isArray(payload.wireContents) && payload.wireContents.length > 0) {
    for (const c of payload.wireContents) {
      const parts = Array.isArray(c) ? c[0] : null;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        if (!Array.isArray(p)) continue;
        let t = '';
        if (typeof p[1] === 'string' && p[1].length > 0) {
          t = p[1];
        } else if (Array.isArray(p[2]) && typeof p[2][1] === 'string') {
          t = p[2][1];
        } else if (Array.isArray(p[5]) && typeof p[5][0] === 'string') {
          t = p[5][0];
        }
        texts.push(t);
      }
    }
    return texts;
  }

  // 2. Top-level systemInstruction / system_instruction / system -> prepended as 1 text part
  const topSys = payload.systemInstruction ?? payload.system_instruction ?? payload.system;
  if (topSys) {
    let sysText = '';
    if (typeof topSys === 'string') {
      sysText = topSys.trim();
    } else if (Array.isArray(topSys.parts)) {
      sysText = topSys.parts.map(extractTextFromPart).join('\n').trim();
    } else if (typeof topSys === 'object') {
      sysText = extractTextFromPart(topSys).trim();
    }
    if (sysText) {
      texts.push(sysText);
    }
  }

  // 3. OpenAI `messages` (supports text, multimodal `image_url`/`input_audio`/`file`, `tool_calls`, and `role: "tool"`)
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const m of payload.messages) {
      if (!m) continue;
      const rawRole = String(m.role || 'user').toLowerCase();
      if (rawRole === 'tool' || rawRole === 'function') {
        // Main `functionResponse` part (`part[11]`) produces `""` in `_.Wm(part)`
        texts.push('');
        if (Array.isArray(m.content)) {
          for (const item of m.content) {
            if (!item || typeof item !== 'object') continue;
            const itemType = String(item.type || '').toLowerCase();
            if (itemType === 'image_url' || itemType === 'input_image') {
              const b64 = parseBase64Data(item.image_url ?? item.input_image);
              if (b64) texts.push(b64);
            }
          }
        }
        continue;
      }

      const rawToolCalls = Array.isArray(m.tool_calls)
        ? m.tool_calls
        : m.function_call && typeof m.function_call === 'object'
          ? [m.function_call]
          : [];
      const hasToolCalls = rawToolCalls.length > 0;
      let addedCount = 0;

      if (typeof m.content === 'string') {
        if (m.content.length > 0 || !hasToolCalls) {
          texts.push(m.content);
          addedCount += 1;
        }
      } else if (Array.isArray(m.content)) {
        for (const item of m.content) {
          if (!item) continue;
          if (typeof item === 'string') {
            texts.push(item);
            addedCount += 1;
            continue;
          }
          const itemType = String(item.type || '').toLowerCase();
          if (itemType === 'image_url' || itemType === 'input_image') {
            const b64 = parseBase64Data(item.image_url ?? item.input_image);
            if (b64) {
              texts.push(b64);
              addedCount += 1;
            }
            continue;
          }
          if (itemType === 'input_audio' && item.input_audio) {
            const b64 = parseBase64Data(item.input_audio);
            if (b64) {
              texts.push(b64);
              addedCount += 1;
            }
            continue;
          }
          if (itemType === 'file' && item.file) {
            const b64 = parseBase64Data(item.file.file_data || item.file);
            if (b64) {
              texts.push(b64);
              addedCount += 1;
            }
            continue;
          }
          const t = extractTextFromPart(item);
          if (t) {
            texts.push(t);
            addedCount += 1;
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const t = extractTextFromPart(m.content);
        if (t) {
          texts.push(t);
          addedCount += 1;
        }
      }

      for (const tc of rawToolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        // Each `functionCall` part (`part[10]`, including any attached `part[14]` signature) produces `""` in `_.Wm(part)`
        texts.push('');
        addedCount += 1;
      }

      if (Array.isArray(m.thoughtSignatures)) {
        for (const s of m.thoughtSignatures) {
          const sigStr = typeof s === 'string' ? s : s && s.signature;
          if (sigStr) {
            texts.push('');
            addedCount += 1;
          }
        }
      }

      if (addedCount === 0) {
        texts.push('');
      }
    }
    return texts;
  }

  // 4. Gemini `contents` (supports text, `inlineData`, `functionCall`, `functionResponse`, `thought`, `thoughtSignature`)
  if (Array.isArray(payload.contents) && payload.contents.length > 0) {
    for (const c of payload.contents) {
      if (!c) continue;
      if (Array.isArray(c) && Array.isArray(c[0])) {
        for (const p of c[0]) {
          if (!Array.isArray(p)) continue;
          if (typeof p[1] === 'string' && p[1].length > 0) texts.push(p[1]);
          else if (Array.isArray(p[2]) && typeof p[2][1] === 'string') texts.push(p[2][1]);
          else if (Array.isArray(p[5]) && typeof p[5][0] === 'string') texts.push(p[5][0]);
          else texts.push('');
        }
        continue;
      }
      const parts = Array.isArray(c.parts) ? c.parts : [];
      let trailingSigCount = 0;
      for (const p of parts) {
        if (!p) continue;
        if (Array.isArray(p)) {
          if (typeof p[1] === 'string' && p[1].length > 0) texts.push(p[1]);
          else if (Array.isArray(p[2]) && typeof p[2][1] === 'string') texts.push(p[2][1]);
          else if (Array.isArray(p[5]) && typeof p[5][0] === 'string') texts.push(p[5][0]);
          else texts.push('');
          continue;
        }
        const sig = p.thoughtSignature || p.thought_signature || null;
        const isThought = !!p.thought;
        const fc = p.functionCall || p.function_call;
        const fr = p.functionResponse || p.function_response;
        const inl = p.inlineData || p.inline_data;

        if (fc && typeof fc === 'object') {
          texts.push('');
          continue;
        }
        if (fr && typeof fr === 'object') {
          texts.push('');
          if (Array.isArray(fr.parts)) {
            for (const sub of fr.parts) {
              const b64 = parseBase64Data(sub && (sub.inlineData || sub.inline_data));
              if (b64) texts.push(b64);
            }
          }
          if (fr.response && typeof fr.response === 'object') {
            const b64 = parseBase64Data(fr.response.inlineData || fr.response.inline_data);
            if (b64) texts.push(b64);
            if (Array.isArray(fr.response.parts)) {
              for (const sub of fr.response.parts) {
                const subB64 = parseBase64Data(sub && (sub.inlineData || sub.inline_data));
                if (subB64) texts.push(subB64);
              }
            }
          }
          if (sig) trailingSigCount += 1;
          continue;
        }
        if (inl && typeof inl === 'object') {
          const b64 = parseBase64Data(inl);
          if (b64) texts.push(b64);
          if (sig) trailingSigCount += 1;
          continue;
        }
        if (isThought) {
          if (sig) trailingSigCount += 1;
          continue;
        }
        const t = extractTextFromPart(p);
        if (t) {
          texts.push(t);
          if (sig) trailingSigCount += 1;
        } else if (sig) {
          trailingSigCount += 1;
        }
      }
      for (let i = 0; i < trailingSigCount; i += 1) {
        texts.push('');
      }
    }
    return texts;
  }

  if (typeof payload.prompt === 'string') {
    texts.push(payload.prompt);
  }
  return texts;
}

function normalizeMessages(payload = {}) {
  const out = [];
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (!m) continue;
      const role = String(m.role || 'user').toLowerCase();
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content.map(extractTextFromPart).join('');
      } else if (m.content && typeof m.content === 'object') {
        text = extractTextFromPart(m.content);
      }
      out.push({ role, content: text });
    }
    return out;
  }

  const sys = payload.systemInstruction || payload.system_instruction;
  if (sys) {
    const sysParts = Array.isArray(sys.parts) ? sys.parts : [sys];
    const sysText = sysParts.map(extractTextFromPart).join('\n').trim();
    if (sysText) out.push({ role: 'system', content: sysText });
  }
  if (Array.isArray(payload.contents)) {
    for (const c of payload.contents) {
      if (!c) continue;
      const role = String(c.role || 'user').toLowerCase() === 'model' ? 'assistant' : 'user';
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const text = parts.map(extractTextFromPart).join('');
      out.push({ role, content: text });
    }
    return out;
  }

  if (typeof payload.prompt === 'string') {
    out.push({ role: 'user', content: payload.prompt });
  }
  return out;
}

class Semaphore {
  constructor(maxConcurrent = 16) {
    this.max = Math.max(1, Number(maxConcurrent) || 16);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

class AccountPool {
  constructor(options = {}) {
    this.hotTtlMs = Number(options.hotTtlMs ?? 60 * 60 * 1000);
    this.sweepIntervalMs = Number(options.sweepIntervalMs ?? 60 * 1000);
    this.initSemaphore = new Semaphore(options.maxConcurrentInits || 16);
    this.entries = new Map();
    global.__LAST_POOL__ = this;

    this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    if (this._sweepTimer && typeof this._sweepTimer.unref === 'function') {
      this._sweepTimer.unref();
    }
  }

  /**
   * Single-tier pool: an entry lives exactly as long as its hot VM. Once the
   * VM has been idle for `hotTtlMs` it is disposed and the entry is dropped —
   * the caller always re-sends cookies, so nothing is retained in between.
   */
  sweep(now = Date.now()) {
    for (const [id, entry] of this.entries.entries()) {
      if (entry.initPromise) continue;
      const initStarted =
        entry.runtime && entry.runtime.proof && entry.runtime.proof.waa
          ? entry.runtime.proof.waa.initStarted
          : 0;
      const idleExpired = now - entry.lastActiveAt >= this.hotTtlMs;
      const ageExpired = Boolean(initStarted && now - initStarted >= this.hotTtlMs);
      if (idleExpired || ageExpired) {
        this._disposeRuntime(entry);
        this.entries.delete(id);
      }
    }
  }

  _disposeRuntime(entry) {
    if (entry.runtime) {
      const rt = entry.runtime;
      entry.runtime = null;
      try {
        rt.close().catch(() => {});
      } catch {}
    }
  }

  async acquireHotAccount(rawCookies, authUser = 0, g1TierHint = null, forceRefresh = false) {
    const { map: incomingMap } = extractMinimalCookies(rawCookies);
    if (incomingMap.size === 0) {
      const err = new Error('Cookie 信息为空：未检测到有效的 Google 鉴权 Cookie');
      err.httpStatus = 400;
      throw err;
    }
    const requiredKeys = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'];
    const missingKeys = requiredKeys.filter((k) => !incomingMap.has(k));
    if (missingKeys.length > 0) {
      const err = new Error(
        `Cookie 信息不完整（当前仅 ${incomingMap.size} 项，缺少核心 HttpOnly 凭证: ${missingKeys.join(', ')}），请使用油猴脚本（开启 Cookie All 权限）重新获取完整 Cookie`,
      );
      err.httpStatus = 400;
      throw err;
    }
    const accountId = computeAccountId(incomingMap, authUser);
    const now = Date.now();
    let entry = this.entries.get(accountId);

    if (!entry) {
      entry = {
        accountId,
        authUser: Number(authUser || 0),
        g1Tier: g1TierHint || null,
        cookieMap: incomingMap,
        initPsidts: `${incomingMap.get('__Secure-1PSIDTS') || ''}|${incomingMap.get('__Secure-3PSIDTS') || ''}`,
        lastActiveAt: now,
        mints: 0,
        runtime: null,
        initPromise: null,
      };
      this.entries.set(accountId, entry);
    } else {
      entry.lastActiveAt = now;
      if (g1TierHint && g1TierHint !== 'TIER0') {
        entry.g1Tier = g1TierHint;
      }
      // Compare incoming __Secure-1PSIDTS / __Secure-3PSIDTS against BOTH `entry.cookieMap` AND `entry.initPsidts`
      // (the PSIDTS that was actually used when `entry.runtime` started initializing),
      // preventing a mid-init cookie update from masking a stale anonymous VM.
      const prevPsidts = `${entry.cookieMap.get('__Secure-1PSIDTS') || ''}|${entry.cookieMap.get('__Secure-3PSIDTS') || ''}`;
      const nextPsidts = `${incomingMap.get('__Secure-1PSIDTS') || ''}|${incomingMap.get('__Secure-3PSIDTS') || ''}`;
      const psidtsRotated = Boolean(
        nextPsidts !== '|' &&
          (nextPsidts !== prevPsidts ||
            (entry.initPsidts !== undefined && nextPsidts !== entry.initPsidts)),
      );

      for (const [k, v] of incomingMap.entries()) {
        if (v) entry.cookieMap.set(k, v);
      }
      if ((forceRefresh || psidtsRotated) && entry.runtime) {
        this._disposeRuntime(entry);
      }
      const initStarted = entry.runtime && entry.runtime.proof && entry.runtime.proof.waa ? entry.runtime.proof.waa.initStarted : 0;
      if (initStarted && now - initStarted > this.hotTtlMs) {
        this._disposeRuntime(entry);
      }
      if (entry.runtime && entry.runtime.ready) {
        entry.runtime._syncCookies([], 'acquireHotAccount');
        return { entry, poolState: 'hot', initMs: 0 };
      }
    }

    if (entry.initPromise) {
      const t0 = Date.now();
      await entry.initPromise;
      const latestPsidts = `${entry.cookieMap.get('__Secure-1PSIDTS') || ''}|${entry.cookieMap.get('__Secure-3PSIDTS') || ''}`;
      if (latestPsidts !== '|' && entry.initPsidts !== undefined && latestPsidts !== entry.initPsidts) {
        this._disposeRuntime(entry);
      } else if (entry.runtime && entry.runtime.ready) {
        return { entry, poolState: 'singleflight-joined', initMs: Date.now() - t0 };
      }
    }

    const tInit0 = Date.now();
    entry.initPromise = this.initSemaphore.run(async () => {
      try {
        entry.initPsidts = `${entry.cookieMap.get('__Secure-1PSIDTS') || ''}|${entry.cookieMap.get('__Secure-3PSIDTS') || ''}`;
        const cookieHeader = toCookieHeader(entry.cookieMap);
        const cfg = loadConfig({
          cookies: cookieHeader,
          authUser: entry.authUser,
          proofProvider: 'node-vm',
          persistCookies: false,
          saveChallenge: false,
          // Cookies are owned (and rotated) by the caller; the pool never
          // touches them on its own.
          autoRotateCookies: false,
          cookieRotateIntervalMs: 0,
          lastCookieRotateAt: 0,
          log: () => {},
        });
        const rt = new Runtime(cfg);
        rt.cookieMap = entry.cookieMap;
        let initTimer = null;
        await Promise.race([
          rt.init(),
          new Promise((_, reject) => {
            initTimer = setTimeout(() => {
              const e = new Error(`VM init timeout after ${INIT_TIMEOUT_MS}ms`);
              e.httpStatus = 504;
              reject(e);
            }, INIT_TIMEOUT_MS);
            if (initTimer && typeof initTimer.unref === 'function') initTimer.unref();
          }),
        ]).finally(() => {
          if (initTimer) clearTimeout(initTimer);
        });
        entry.cookieMap = rt.cookieMap;
        entry.runtime = rt;
        entry.lastActiveAt = Date.now();

        if (!entry.g1Tier || entry.g1Tier === 'TIER0') {
          entry.g1Tier = entry.g1Tier || 'TIER0';
          try {
            const origin = rt.cfg.origin || 'https://aistudio.google.com';
            const tierRes = await globalThis.fetch(
              'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GetAiStudioBenefitTier',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json+protobuf',
                  'x-user-agent': 'grpc-web-javascript/0.1',
                  'x-goog-api-key': rt.cfg.googleApiKey,
                  'x-goog-authuser': String(entry.authUser || 0),
                  authorization: buildAuthorization(entry.cookieMap, origin),
                  cookie: toCookieHeader(entry.cookieMap, { includeAccountHost: false }),
                  origin,
                  referer: origin + '/',
                  'user-agent': rt.cfg.userAgent,
                },
                body: '[]',
                signal: AbortSignal.timeout(4000),
              },
            );
            if (tierRes.ok) {
              const tierArr = await tierRes.json();
              const code = Array.isArray(tierArr) ? tierArr[0] : 0;
              if (code === 1) entry.g1Tier = 'TIER1';
              else if (code === 2) entry.g1Tier = 'TIER2';
              else entry.g1Tier = 'TIER0';
            }
          } catch {}
        }
        return rt;
      } catch (err) {
        entry.runtime = null;
        // 初始化失败/超时的条目立即丢弃，否则它会以 runtime=null 的形态留在池里直到 TTL，
        // 既占内存，又会让后续请求反复重试同一条死链路。
        try {
          this.entries.delete(entry.accountId);
        } catch {}
        throw err;
      } finally {
        entry.initPromise = null;
      }
    });

    await entry.initPromise;
    return { entry, poolState: 'cold', initMs: Date.now() - tInit0 };
  }

  async mintProof(params = {}) {
    const authUser = Number(params.authUser ?? 0);
    const { entry, poolState } = await this.acquireHotAccount(
      params.cookies,
      authUser,
      params.g1Tier || null,
      Boolean(params.forceRefresh),
    );

    const rt = entry.runtime;
    const messages = normalizeMessages(params);
    const rawModel = String(params.model || rt.cfg.defaultModel || 'models/gemini-3.8-flash').trim();
    const lower = rawModel.toLowerCase();
    let model = rawModel;
    if (lower === 'argon' || lower === '4-argon' || lower === 'gemini-4-argon') {
      model = 'models/gemini-4-argon';
    } else if (!rawModel.startsWith('models/')) {
      model = `models/${rawModel}`;
    }

    const partTexts = extractPartTextsForDigest(params);
    let prep;
    if (typeof params.digest === 'string' && /^[0-9a-f]{64}$/i.test(params.digest.trim())) {
      const digest = params.digest.trim().toLowerCase();
      const proof = await rt.proof.snapshot(digest);
      prep = { digest, proof };
    } else if (partTexts.length > 0) {
      const digest = sha256Hex(partTexts.join(' '));
      const proof = await rt.proof.snapshot(digest);
      prep = { digest, proof };
    } else {
      prep = await rt.prepare({
        model,
        messages,
        generationConfig: params.generationConfig,
      });
    }
    entry.mints += 1;
    entry.lastActiveAt = Date.now();

    return {
      ok: true,
      proof: prep.proof,
      poolState,
      g1Tier: entry.g1Tier || 'TIER0',
    };
  }

  /**
   * Look up a single account in the pool by its cookies.
   * Returns `null` when that cookie (account) is not present in the pool.
   */
  accountInfo(rawCookies, authUser = 0) {
    this.sweep();
    const { map } = extractMinimalCookies(rawCookies || '');
    if (map.size === 0) return null;
    const accountId = computeAccountId(map, Number(authUser || 0));
    const entry = this.entries.get(accountId);
    if (!entry) return null;
    return {
      accountId: entry.accountId,
      state: entry.initPromise ? 'initializing' : 'hot',
      authUser: entry.authUser,
      g1Tier: entry.g1Tier || 'TIER0',
      mints: entry.mints,
      lastActiveAt: entry.lastActiveAt,
      expiresAt: entry.lastActiveAt + this.hotTtlMs,
    };
  }

  async closeAll() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const entry of this.entries.values()) {
      this._disposeRuntime(entry);
    }
    this.entries.clear();
  }
}

module.exports = {
  AccountPool,
  MINIMAL_COOKIE_WHITELIST,
  extractMinimalCookies,
  computeAccountId,
  normalizeMessages,
};
