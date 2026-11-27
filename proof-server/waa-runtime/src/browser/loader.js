'use strict';

/**
 * Loads `b0.patched.js` (AI Studio closure bundle) into a vm context and wires
 * up the script loader used by the WAA challenge flow.
 *
 * The patched bundle exports the WAA internals on
 * `default_MakerSuite.__internal` right before `_._ModuleManager_initialize`.
 * Everything else we need (`zu`, `Hw`, `Mv`, `Cn`, `SB`, `bo`, ...) is already
 * on the `default_MakerSuite` namespace.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createBrowserEnv } = require('./env');

const PROGRAM_RE = /\/js\/bg\/([A-Za-z0-9_-]+)\.js/;
const MEMORY_PROGRAM_CACHE = new Map();
const BUNDLE_SCRIPT_CACHE = new Map();

/**
 * Syntax-safe, minimal instrumentation of the botguard program.
 *
 * The program is a single minified line; rewriting whole catch blocks breaks
 * the parser.  Only exact string substitutions are used, and each one is
 * reported so a changed program simply logs "anchor not found" instead of
 * producing invalid JavaScript.
 */
function instrumentBotguardProgram(code, log) {
  let out = String(code);
  const rules = [
    {
      name: 'catch',
      from: 'catch(c){if(K==97)throw c;K==86&&(k=c,x=66)}',
      to: 'catch(c){try{console.log("[VM-CAUGHT]",c&&c.name,c&&c.message)}catch(e){}if(K==97)throw c;K==86&&(k=c,x=66)}',
    },
    {
      name: 'fnl',
      from: 'else if(x==41)E="FNL"+L,x=29;',
      to: 'else if(x==41){try{console.log("[VM-FNL-L]",typeof L,String(L).slice(0,240))}catch(e){}E="FNL"+L,x=29;}',
    },
  ];
  for (const rule of rules) {
    if (out.includes(rule.from)) {
      out = out.split(rule.from).join(rule.to);
      log('info', `instrumented botguard ${rule.name} anchor`);
    } else {
      log('warn', `instrumentation anchor not found: ${rule.name}`);
    }
  }
  return out;
}

// The closure bundle initialises modules asynchronously and one of them
// (`jLa` -> WIZ_global_data["Im6cmf"]) rejects when the host page's bootstrap
// data is absent.  Node would turn that into a fatal unhandled rejection, so
// keep a bounded record instead.  This is expected and documented in the
// report (2761 of 3378 symbols load).
const unhandled = [];
let guardsInstalled = false;
function installProcessGuards(log) {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const msg = reason && (reason.stack || reason.message || String(reason));
    unhandled.push({ at: Date.now(), message: msg });
    if (unhandled.length > 50) unhandled.shift();
    log('debug', `unhandledRejection (bundle bootstrap, expected): ${String(msg).split('\n')[0]}`);
  });
}

function resolveScriptUrl(raw, base) {
  let s = String(raw);
  if (s.startsWith('//')) s = 'https:' + s;
  try { return new URL(s, base).href; } catch { return s; }
}

function programCachePath(cacheDir, url) {
  const m = PROGRAM_RE.exec(url);
  if (!m) return null;
  return path.join(cacheDir, `botguard_${m[1]}.js`);
}

function loadMakerSuite(options = {}) {
  const log = options.log || (() => {});
  if (options.catchProcessErrors !== false) installProcessGuards(log);
  const env = createBrowserEnv({
    userAgent: options.userAgent,
    chromeVersion: options.chromeVersion,
    platform: options.platform,
    platformVersion: options.platformVersion,
    language: options.language,
    languages: options.languages,
    acceptLanguage: options.acceptLanguage,
    omitExtraHeaders: options.omitExtraHeaders,
    hardwareConcurrency: options.hardwareConcurrency,
    deviceMemory: options.deviceMemory,
    maxTouchPoints: options.maxTouchPoints,
    connection: options.connection,
    gpu: options.gpu,
    userActivation: options.userActivation,
    memory: options.memory,
    navEntryCount: options.navEntryCount,
    resourceEntryCount: options.resourceEntryCount,
    screenWidth: options.screenWidth,
    screenHeight: options.screenHeight,
    innerWidth: options.innerWidth,
    innerHeight: options.innerHeight,
    outerWidth: options.outerWidth,
    outerHeight: options.outerHeight,
    devicePixelRatio: options.devicePixelRatio,
    origin: options.origin,
    pageUrl: options.pageUrl,
    cookies: options.cookies || '',
    programCacheDir: options.cacheDir,
    saveProgram: options.saveProgram !== false,
    challengeCache: options.challengeCache || '',
    saveChallengePath: options.saveChallengePath || '',
    log,
  });

  const host = {
    ctx: null,
    runningScripts: 0,
  };
  env.host = host;

  const sandbox = env.sandbox;
  const ctx = vm.createContext(sandbox, { name: 'ai-studio' });
  host.ctx = ctx;

  function runInContext(code, filename) {
    const srcStr = String(code);
    const fname = filename || 'injected.js';
    if (fname === 'iframe-eval.js' && srcStr.length > 1000) {
      let script = MEMORY_PROGRAM_CACHE.get(srcStr);
      if (!script) {
        script = new vm.Script(srcStr, { filename: fname });
        MEMORY_PROGRAM_CACHE.set(srcStr, script);
      }
      return script.runInContext(ctx, {
        timeout: options.scriptTimeoutMs || 120000,
        displayErrors: true,
      });
    }
    return vm.runInContext(srcStr, ctx, {
      filename: fname,
      timeout: options.scriptTimeoutMs || 120000,
      displayErrors: true,
    });
  }
  host.runInContext = runInContext;
  env.runInContext = runInContext;

  function finishScript(el, err) {
    if (!el) return;
    try { el.readyState = 'complete'; } catch {}
    try {
      if (err && typeof el.onerror === 'function') el.onerror.call(el, { type: 'error', target: el, error: err, message: err.message });
      else if (typeof el.onload === 'function') el.onload.call(el, { type: 'load', target: el });
    } catch (e) {
      log('warn', `script callback threw: ${e && e.message}`);
    }
    try { el.dispatchEvent({ type: err ? 'error' : 'load', target: el }); } catch {}
  }

  function prepareProgramCode(code, url) {
    if (options.instrumentProgram && PROGRAM_RE.test(url)) return instrumentBotguardProgram(code, log);
    return code;
  }

  function reportBotguard(url) {
    if (!PROGRAM_RE.test(url)) return;
    const bg = env.sandbox.botguard;
    const keys = bg && typeof bg === 'object' ? Object.keys(bg) : [];
    log('info', `botguard registered: [${keys.join(',')}] successCriterion(f=${keys.includes('f')})`);
    if (typeof options.onProgram === 'function') {
      try { options.onProgram(bg, env); } catch (e) { log('warn', `onProgram threw: ${e.message}`); }
    }
  }

  async function fetchScript(url) {
    const headers = {
      'user-agent': env.userAgent,
      referer: env.origin + '/',
      origin: env.origin,
      'accept-language': 'en-US,en;q=0.9',
    };
    if (env.cookieString) headers.cookie = env.cookieString;
    const res = await globalThis.fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }

  host.loadScriptElement = (el, parent) => {
    if (!el || el.tagName !== 'SCRIPT') return el;
    const inline = String(el.textContent || '').trim();
    if (inline) {
      setTimeout(() => {
        const name = `inline-script-${env.scripts.length}.js`;
        log('debug', `inline script ${inline.length} bytes`);
        try {
          env.hostCurrentScript(el);
          runInContext(inline, name);
          finishScript(el, null);
        } catch (e) {
          env.errors.push(e);
          log('warn', `inline script failed: ${e && e.message}`);
          finishScript(el, e);
        } finally {
          env.hostCurrentScript(null);
        }
      }, 0);
      return el;
    }

    const rawSrc = el.src || el.getAttribute('src');
    if (!rawSrc) {
      finishScript(el, null);
      return el;
    }
    const url = resolveScriptUrl(rawSrc, env.url);
    const entry = { url, at: Date.now(), bytes: 0, cached: false };
    env.scripts.push(entry);
    log('debug', `script src ${url.slice(0, 180)}`);

    // Skip non-WAA decorative/help scripts (e.g. feedback/js/help/prod/service/lazy.min.js)
    // to save ~150-300 ms of external HTTPS download + 128 KB JS execution on cold start.
    if (url.includes('feedback/js/help/') || url.includes('lazy.min.js')) {
      entry.cached = true;
      setTimeout(() => finishScript(el, null), 0);
      return el;
    }

    const cachePath = env.programCacheDir ? programCachePath(env.programCacheDir, url) : null;
    const useCache = (MEMORY_PROGRAM_CACHE.has(url) || (cachePath && fs.existsSync(cachePath))) && !options.refreshProgram;
    if (useCache) {
      entry.cached = true;
      let cachedProg = MEMORY_PROGRAM_CACHE.get(url);
      if (!cachedProg && cachePath) {
        const rawCode = fs.readFileSync(cachePath, 'utf8');
        const code = prepareProgramCode(rawCode, url);
        cachedProg = {
          code,
          script: new vm.Script(code, { filename: url }),
        };
        MEMORY_PROGRAM_CACHE.set(url, cachedProg);
      }
      entry.bytes = cachedProg.code.length;
      setTimeout(() => {
        try {
          env.hostCurrentScript(el);
          if (PROGRAM_RE.test(url)) env.sandbox.botguard = undefined;
          cachedProg.script.runInContext(ctx, { timeout: options.scriptTimeoutMs || 120000, displayErrors: true });
          reportBotguard(url);
          finishScript(el, null);
        } catch (e) {
          env.errors.push(e);
          log('warn', `cached program failed: ${e && (e.stack || e.message)}`);
          finishScript(el, e);
        } finally {
          env.hostCurrentScript(null);
        }
      }, 0);
      return el;
    }

    fetchScript(url).then((rawCode) => {
      const code = prepareProgramCode(rawCode, url);
      entry.bytes = code.length;
      const cachedProg = {
        code,
        script: new vm.Script(code, { filename: url }),
      };
      MEMORY_PROGRAM_CACHE.set(url, cachedProg);
      if (cachePath) {
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, rawCode);
          log('debug', `cached program -> ${cachePath} (${rawCode.length} bytes)`);
        } catch (e) {
          log('warn', `cannot cache program: ${e.message}`);
        }
      }
      try {
        env.hostCurrentScript(el);
        if (PROGRAM_RE.test(url)) env.sandbox.botguard = undefined;
        cachedProg.script.runInContext(ctx, { timeout: options.scriptTimeoutMs || 120000, displayErrors: true });
        reportBotguard(url);
        finishScript(el, null);
      } catch (e) {
        env.errors.push(e);
        log('warn', `program failed: ${e && (e.stack || e.message)}`);
        finishScript(el, e);
      } finally {
        env.hostCurrentScript(null);
      }
    }).catch((e) => {
      env.errors.push(e);
      log('warn', `script fetch failed: ${url} (${e.message})`);
      finishScript(el, e);
    });
    return el;
  };

  // Ensure a program cache directory exists when caching is enabled.
  if (options.cacheDir && options.saveProgram !== false) {
    try { fs.mkdirSync(options.cacheDir, { recursive: true }); } catch {}
  }

  const bundlePath = options.bundlePath;
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error(`bundle not found: ${bundlePath}`);
  }
  let cachedBundle = BUNDLE_SCRIPT_CACHE.get(bundlePath);
  if (!cachedBundle) {
    const src = fs.readFileSync(bundlePath, 'utf8');
    const m = src.match(/"X-Goog-Api-Key"\s*:\s*"(AIza[^"]+)"/) ||
      src.match(/\b(AIza[0-9A-Za-z_-]{30,})/);
    const script = new vm.Script(src, { filename: 'b0.patched.js' });
    cachedBundle = { srcLength: src.length, apiKey: m ? m[1] : null, script };
    BUNDLE_SCRIPT_CACHE.set(bundlePath, cachedBundle);
  }
  const apiKey = options.apiKey || cachedBundle.apiKey;

  log('debug', `loading bundle ${bundlePath} (${(cachedBundle.srcLength / 1024 / 1024).toFixed(2)} MB)`);
  const started = Date.now();
  let topError = null;
  try {
    cachedBundle.script.runInContext(ctx, { timeout: options.scriptTimeoutMs || 120000, displayErrors: true });
  } catch (e) {
    topError = e;
    log('debug', `bundle top-level error (usually harmless): ${e && e.message}`);
  }
  const loadMs = Date.now() - started;

  const ns = sandbox.default_MakerSuite;
  const internal = ns && ns.__internal;
  const symbols = ns ? Object.keys(ns) : [];
  log('debug', `bundle loaded in ${loadMs} ms, ${symbols.length} symbols, internal: ${internal ? Object.keys(internal).filter((k) => internal[k]).join(',') : 'none'}`);

  return {
    env,
    sandbox,
    ctx,
    ns,
    internal,
    apiKey,
    symbols,
    topError,
    loadMs,
    evaluate: runInContext,
    unhandled,
    async close() {},
  };
}

module.exports = { loadMakerSuite, resolveScriptUrl, programCachePath, instrumentBotguardProgram };
