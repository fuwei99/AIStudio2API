'use strict';

/**
 * Local CLI.  Everything runs in Node; no browser is launched unless the
 * caller explicitly selects `--provider browser`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pkg = require('../package.json');
const { loadConfig, ROOT, WORKSPACE } = require('./config');
const { createLogger } = require('./logger');
const { loadMakerSuite } = require('./browser/loader');
const { Runtime } = require('./runtime');
const { buildRequest, digestRequest, setProof } = require('./waa/request');
const { proofMode, payloadBytes } = require('./waa/service');
const { buildAuthorization, parseCookieInput, summarizeCookies } = require('./google/auth');
const { applyProfile } = require('./google/profile');
const { startServer } = require('./server');
const { CatiecliExecutor } = require('./ws/executor');

const FLAG_TYPES = {
  'bundle': 'string', 'cache-dir': 'string', 'provider': 'string', 'model': 'string',
  'cookies': 'string', 'cookie': 'string', 'cookie-file': 'string', 'cookie-json': 'string',
  'google-api-key': 'string', 'auth-user': 'number', 'visit-id': 'string',
  'static-proof': 'string', 'proof-file': 'string', 'challenge-cache': 'string',
  'proof': 'string', 'digest': 'string', 'text': 'string', 'prompt': 'string',
  'prompt-file': 'string', 'system': 'string', 'temperature': 'number',
  'max-tokens': 'number', 'top-p': 'number', 'top-k': 'number',
  'log-level': 'string', 'timeout': 'number', 'port': 'number', 'host': 'string',
  'server-key': 'string', 'key': 'string', 'ws-url': 'string', 'ws-version': 'string',
  'wire-file': 'string', 'binding': 'string', 'binding-file': 'string',
  'out': 'string', 'proof-timeout': 'number', 'init-timeout': 'number',
  'chrome': 'string', 'parent-url': 'string', 'settle-ms': 'number',
  'authorization': 'string', 'profile': 'string', 'user-agent': 'string', 'ext': 'string',
  'carry-content': 'string', 'min-age': 'number', 'warmup': 'number',
  'extra-model': 'string[]', 'header': 'string[]', 'latency': 'number',
};

const BOOL_FLAGS = new Set([
  'json', 'stream', 'allow-invalid-proof', 'refresh-program', 'instrument',
  'no-save-challenge', 'deep', 'help', 'version', 'headful', 'no-init', 'always-log',
]);

function usage() {
  return `waa-runtime ${pkg.version} — local WAA / MakerSuite toolkit (no browser required)

Usage:
  waa <command> [options]

Commands:
  doctor                 Check bundle, cache, network, cookies and provider
  env                    Load the bundle and print the Node environment probes
  waa                    Run the local WAA flow (Waa/Create -> program -> VM)
  proof                  Compute a proof for a text/digest
  wire                   Build a GenerateContent wire array (no network)
  generate               Generate content (OpenAI-style prompt)
  replay                 POST a pre-built wire with a fresh proof injected
  serve                  Start the OpenAI-compatible HTTP server
  ws                     Connect the catiecli Playground WS executor
  version                Print version
  help                   Print this help

Key options:
  --provider node-vm|static|browser   Proof provider (default: node-vm)
  --text <s> / --digest <hex>         Input for proof
  --prompt <s> / --prompt-file <f>    Input for wire/generate
  --system <s>                        System instruction
  --model <name>                      Model name (default: gemini-3.8-flash)
  --cookies <s> | --cookie-file <f>   Google session cookies (for GenerateContent)
  --static-proof <p> | --proof-file   Replay a captured proof (provider=static)
  --carry-content <s>                 Keep this content in contents; real prompt goes to systemInstruction
  --challenge-cache <f>               Replay a cached Waa/Create response
  --min-age <ms>                      Warmth: wait this long after the VM is ready
  --warmup <n>                        Warmth: throw-away snapshots before minting
  --always-log                        Warmth: force the Qtb logger throttle F=0
  --refresh-program                   Re-download the botguard program
  --instrument                        Syntax-safe botguard diagnostics
  --allow-invalid-proof               Return FNL... instead of failing
  --json                              Machine-readable output
  --log-level silent|error|warn|info|debug|trace

Environment:
  WAA_BUNDLE, WAA_CACHE_DIR, WAA_PROOF_PROVIDER, WAA_COOKIE_FILE,
  WAA_CHALLENGE_CACHE, WAA_INSTRUMENT, WAA_LOG_LEVEL, WAA_PORT ...
`;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (arg === '-v' || arg === '--version') { flags.version = true; continue; }
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
      if (value === undefined) {
        const type = FLAG_TYPES[key];
        if (BOOL_FLAGS.has(key) || type === undefined) {
          if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && type === 'string') {
            value = argv[++i];
          } else {
            value = true;
          }
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          value = argv[++i];
        } else {
          value = true;
        }
      }
      if (type(key) === 'array') {
        (flags[key] || (flags[key] = [])).push(value);
      } else {
        flags[key] = value;
      }
      continue;
    }
    if (arg === '-') { positional.push(arg); continue; }
    positional.push(arg);
  }
  return { flags, positional };
}

function type(key) {
  const t = FLAG_TYPES[key];
  return t === 'string[]' ? 'array' : t;
}

function toConfig(flags) {
  const overrides = {};
  const map = {
    bundle: 'bundlePath', 'cache-dir': 'cacheDir', provider: 'proofProvider',
    model: 'defaultModel', cookies: 'cookies', cookie: 'cookies', 'cookie-file': 'cookieFile',
    'cookie-json': 'cookieJson', 'google-api-key': 'googleApiKey',
    'auth-user': 'authUser', 'visit-id': 'visitId', 'static-proof': 'staticProof',
    'authorization': 'authorization', 'user-agent': 'userAgent', 'profile': 'profile',
    'carry-content': 'carryContent',
    'proof-file': 'staticProofFile', 'proof': 'staticProof', 'challenge-cache': 'challengeCache',
    timeout: 'generateTimeoutMs', port: 'port', host: 'host',
    'server-key': 'serverApiKey', 'ws-url': 'wsUrl', 'ws-version': 'wsClientVersion',
    'proof-timeout': 'snapshotTimeoutMs', 'init-timeout': 'waaInitTimeoutMs',
    chrome: 'chromePath', 'parent-url': 'browserParentUrl', 'settle-ms': 'browserSettleMs',
    'min-age': 'minChallengeAgeMs', warmup: 'warmupMints',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (flags[flag] !== undefined && flags[flag] !== true) overrides[key] = flags[flag];
  }
  if (flags['allow-invalid-proof']) overrides.allowInvalidProof = true;
  if (flags['refresh-program']) overrides.refreshProgram = true;
  if (flags.instrument) overrides.instrumentProgram = true;
  if (flags['always-log']) overrides.loggerAlways = true;
  if (flags['no-save-challenge']) overrides.saveChallenge = false;
  if (flags.headful) overrides.browserHeadless = false;
  if (flags['extra-model']) overrides.extraModels = flags['extra-model'];
  return loadConfig(overrides);
}

function makeLog(flags) {
  const logger = createLogger({ level: flags['log-level'] || process.env.WAA_LOG_LEVEL || (flags.json ? 'warn' : 'info') });
  const fn = (level, msg) => (logger[level] || logger.info)(msg);
  fn.logger = logger;
  return fn;
}

async function readInput(value, file) {
  if (file) return fs.readFileSync(file, 'utf8');
  if (value === '-' || value === true || value === undefined) {
    return await new Promise((resolve) => {
      if (process.stdin.isTTY) return resolve('');
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
    });
  }
  return String(value);
}

function mask(key) {
  if (!key) return '';
  return key.length <= 12 ? key : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function print(flags, obj, human) {
  if (flags.json) console.log(JSON.stringify(obj, null, 2));
  else if (human) console.log(human);
  else console.log(JSON.stringify(obj, null, 2));
}

async function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

async function cmdDoctor(flags, cfg, log) {
  const report = {
    version: pkg.version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cwd: process.cwd(),
    bundle: { path: cfg.bundlePath, exists: fs.existsSync(cfg.bundlePath) },
    cacheDir: cfg.cacheDir,
    provider: cfg.proofProvider,
    browserRequired: false,
    network: {},
    cookies: null,
    waa: null,
  };
  let ms = null;
  if (report.bundle.exists) {
    report.bundle.size = fs.statSync(cfg.bundlePath).size;
    try {
      ms = loadMakerSuite({
        bundlePath: cfg.bundlePath, cacheDir: cfg.cacheDir, origin: cfg.origin,
        pageUrl: cfg.pageUrl, userAgent: cfg.userAgent, chromeVersion: cfg.chromeVersion,
        log: () => {}, challengeCache: cfg.challengeCache,
        saveChallengePath: cfg.saveChallenge ? (cfg.challengeCache || path.join(cfg.cacheDir, 'challenge.json')) : '',
        instrumentProgram: false,
      });
      report.bundle.symbols = ms.symbols.length;
      report.bundle.internal = Object.keys(ms.internal || {}).filter((k) => ms.internal[k]);
      report.bundle.apiKey = mask(ms.apiKey);
    } catch (e) {
      report.bundle.error = e.message;
    }
  }

  const check = async (name, url, method = 'HEAD') => {
    const t = Date.now();
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      report.network[name] = { ok: res.status < 500, status: res.status, ms: Date.now() - t };
    } catch (e) {
      report.network[name] = { ok: false, error: e.message, ms: Date.now() - t };
    }
  };
  await check('waa', 'https://waa-pa.clients6.google.com/', 'HEAD');
  await check('program', 'https://www.google.com/js/bg/Tugi1RcY_3ZkhGMD17tb7y41o-L5zk3MxWf1wGVXnrc.js', 'HEAD');
  await check('makersuite', 'https://alkalimakersuite-pa.clients6.google.com/', 'HEAD');

  try {
    const cookieMap = cfg.cookieFile
      ? parseCookieInput(fs.readFileSync(cfg.cookieFile, 'utf8'))
      : parseCookieInput(cfg.cookies || cfg.cookieJson || '');
    report.cookies = {
      ...summarizeCookies(cookieMap),
      source: cfg.cookieFile || (cfg.cookies || cfg.cookieJson ? 'inline' : 'none'),
      authorization: cookieMap.size ? buildAuthorization(cookieMap, cfg.origin).slice(0, 50) + '…' : '',
    };
  } catch (e) {
    report.cookies = { error: e.message, count: 0, hasSapisid: false, source: cfg.cookieFile || 'none' };
  }

  const cacheFiles = (() => {
    try { return fs.readdirSync(cfg.cacheDir).filter((f) => f.startsWith('botguard_') || f.startsWith('challenge')); }
    catch { return []; }
  })();
  report.cacheFiles = cacheFiles;
  report.staticProof = cfg.staticProofFile || cfg.staticProof ? { configured: true, file: cfg.staticProofFile || null } : { configured: false };
  report.summary = {
    bundleOk: report.bundle.exists && !report.bundle.error && report.bundle.symbols > 2000,
    networkOk: Object.values(report.network).every((x) => x.ok),
    authOk: !!report.cookies.hasSapisid,
    vmCoreMissing: true,
  };
  print(flags, report,
    [
      `waa-runtime ${report.version}  node ${report.node}  ${report.platform}`,
      `bundle   : ${report.bundle.path}`,
      `           exists=${report.bundle.exists} size=${report.bundle.size || '-'} symbols=${report.bundle.symbols || '-'} apiKey=${report.bundle.apiKey || '-'}`,
      `provider : ${report.provider} (browserRequired=false)`,
      `network  : ${Object.entries(report.network).map(([k, v]) => `${k}=${v.ok ? 'ok' : 'FAIL'}${v.status ? '/' + v.status : ''}${v.error ? ' (' + v.error + ')' : ''}`).join('  ')}`,
      `cookies  : count=${report.cookies.count} sapisid=${report.cookies.hasSapisid} source=${report.cookies.source || 'none'}`,
      `cache    : ${cacheFiles.join(', ') || '(empty)'}`,
      `static   : ${report.staticProof.configured ? 'configured' : 'not configured'}`,
      `summary  : bundle=${report.summary.bundleOk} network=${report.summary.networkOk} auth=${report.summary.authOk} vmCore=missing`,
    ].join('\n'));
  return report.summary.bundleOk ? 0 : 1;
}

async function cmdEnv(flags, cfg, log) {
  const ms = loadMakerSuite({
    bundlePath: cfg.bundlePath, cacheDir: cfg.cacheDir, origin: cfg.origin,
    pageUrl: cfg.pageUrl, userAgent: cfg.userAgent, chromeVersion: cfg.chromeVersion,
    log: () => {}, challengeCache: cfg.challengeCache,
    saveChallengePath: cfg.saveChallenge ? (cfg.challengeCache || path.join(cfg.cacheDir, 'challenge.json')) : '',
    instrumentProgram: false,
  });
  const sb = ms.sandbox;
  const info = {
    symbols: ms.symbols.length,
    internal: Object.keys(ms.internal || {}).filter((k) => ms.internal[k]),
    currentScript: sb.document.currentScript,
    location: sb.location && sb.location.href,
    documentElementLang: sb.document.documentElement.getAttribute('lang'),
    navigator: {
      userAgent: sb.navigator.userAgent,
      platform: sb.navigator.platform,
      hardwareConcurrency: sb.navigator.hardwareConcurrency,
      deviceMemory: sb.navigator.deviceMemory,
      languages: sb.navigator.languages,
      plugins: sb.navigator.plugins.length,
      hasUAData: !!sb.navigator.userAgentData,
    },
    screen: { width: sb.screen.width, height: sb.screen.height, colorDepth: sb.screen.colorDepth },
    viewport: { innerWidth: sb.innerWidth, innerHeight: sb.innerHeight, outerWidth: sb.outerWidth, outerHeight: sb.outerHeight },
    globals: ['atob', 'btoa', 'XMLHttpRequest', 'fetch', 'crypto', 'trustedTypes', 'chrome', 'MessageChannel', 'ReadableStream']
      .map((k) => [k, typeof sb[k]]),
    botguard: typeof sb.botguard,
  };
  print(flags, info);
  return 0;
}

async function cmdWaa(flags, cfg, log) {
  const rt = new Runtime(cfg, log);
  try {
    await rt.init();
    const digest = await sha256(flags.text ?? flags.prompt ?? 'hi');
    const raw = await rt.snapshotDigest(digest);
    const report = {
      ok: raw.startsWith('!'),
      digest,
      proof: raw,
      length: raw.length,
      botguard: rt.proof.describe().waa ? rt.proof.describe().waa.botguardKeys : undefined,
      describe: rt.describe(),
    };
    print(flags, report, [
      `digest : ${digest}`,
      `proof  : ${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}`,
      `length : ${raw.length}  valid=${raw.startsWith('!')}`,
      raw.startsWith('!') ? 'VM handshake succeeded' : 'VM returned FNL (the one remaining core-algorithm blocker)',
    ].join('\n'));
    return raw.startsWith('!') ? 0 : (cfg.allowInvalidProof ? 0 : 2);
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code, raw: e.raw, describe: rt.describe() }, null, 2));
    else {
      console.error(`local WAA stopped at the known checkpoint: ${e.message}`);
      if (e.raw) console.error(`raw: ${e.raw}`);
      console.error('Everything before the VM proof and everything after it is implemented; this is the one excluded core-algorithm piece.');
    }
    return e.code === 'WAA_FNL' ? 2 : 1;
  } finally { await rt.close(); }
}

async function cmdProof(flags, cfg, log) {
  const text = flags.text !== undefined ? flags.text : (flags.prompt !== undefined ? flags.prompt : 'hi');
  const digest = flags.digest || await sha256(text);
  const rt = new Runtime(cfg, log);
  try {
    await rt.init();
    const raw = await rt.snapshotDigest(digest);
    const report = { digest, proof: raw, length: raw.length, valid: raw.startsWith('!'), provider: cfg.proofProvider,
      mode: proofMode(raw), payloadBytes: payloadBytes(raw) };
    print(flags, report, [`digest=${digest}`, `proof(${raw.length})=${raw.slice(0, 160)}${raw.length > 160 ? '…' : ''}`, `valid=${raw.startsWith('!')}`].join('\n'));
    return raw.startsWith('!') || cfg.allowInvalidProof ? 0 : 2;
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code, raw: e.raw }, null, 2));
    else {
      console.error(`proof failed: ${e.message}`);
      if (e.code === 'WAA_FNL' || e.code === 'WAA_BAD_PROOF') {
        console.error('The provider did not return a "!" proof.');
        console.error('Use --provider static --proof-file <captured proof> to exercise the rest of the pipeline.');
      }
    }
    return 2;
  } finally { await rt.close(); }
}

async function cmdWire(flags, cfg, log) {
  const prompt = await readInput(flags.prompt !== undefined ? flags.prompt : flags.text, flags['prompt-file']);
  const ms = loadMakerSuite({
    bundlePath: cfg.bundlePath, cacheDir: cfg.cacheDir, origin: cfg.origin,
    pageUrl: cfg.pageUrl, userAgent: cfg.userAgent, chromeVersion: cfg.chromeVersion,
    log: () => {}, challengeCache: cfg.challengeCache,
    saveChallengePath: cfg.saveChallenge ? (cfg.challengeCache || path.join(cfg.cacheDir, 'challenge.json')) : '',
    instrumentProgram: false,
  });
  const messages = [];
  if (flags.system) messages.push({ role: 'system', content: flags.system });
  messages.push({ role: 'user', content: prompt });
  const req = buildRequest(ms.ns, {
    model: cfg.defaultModel,
    messages,
    generationConfig: {
      temperature: flags.temperature,
      topP: flags['top-p'],
      topK: flags['top-k'],
      maxOutputTokens: flags['max-tokens'],
    },
    carryContent: cfg.carryContent,
  });
  const digest = await digestRequest(ms.ns, req);
  if (flags.proof) setProof(ms.ns, req, flags.proof);
  const wire = JSON.parse(req.serialize());
  const out = { model: cfg.defaultModel, digest, wire, hasProof: !!flags.proof };
  if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(wire, null, 2));
  print(flags, out, [
    `model : ${cfg.defaultModel}`,
    `digest: ${digest}`,
    `wire  : ${JSON.stringify(wire).slice(0, 300)}${JSON.stringify(wire).length > 300 ? '…' : ''}`,
    flags.out ? `saved : ${flags.out}` : '',
  ].filter(Boolean).join('\n'));
  return 0;
}

async function cmdGenerate(flags, cfg, log) {
  const prompt = await readInput(flags.prompt !== undefined ? flags.prompt : flags.text, flags['prompt-file']);
  const rt = new Runtime(cfg, log);
  try {
    await rt.init();
    const messages = [];
    if (flags.system) messages.push({ role: 'system', content: flags.system });
    messages.push({ role: 'user', content: prompt });
    const options = {
      model: cfg.defaultModel,
      messages,
      generationConfig: {
        temperature: flags.temperature,
        topP: flags['top-p'],
        topK: flags['top-k'],
        maxOutputTokens: flags['max-tokens'],
      },
      carryContent: cfg.carryContent,
    };
    if (flags.stream) {
      const { req } = await rt.prepare(options);
      for await (const msg of rt.client.stream(req)) {
        for (const c of msg.candidates) {
          if (c.delta) process.stdout.write(c.delta);
        }
      }
      process.stdout.write('\n');
      return 0;
    }
    const result = await rt.generate(options);
    print(flags, result, result.text);
    return 0;
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code, httpStatus: e.httpStatus, metadata: e.metadata }, null, 2));
    else {
      console.error(`generate failed: ${e.message}`);
      if (e.httpStatus === 401) console.error('Google rejected the request: supply a valid Google session cookie (--cookie-file / --profile).');
      if (e.code === 'WAA_FNL' || e.code === 'WAA_BAD_PROOF') console.error('No valid proof from the provider; use --provider static --proof <captured proof> to exercise the rest of the pipeline.');
    }
    if (e.httpStatus === 401) return 3;
    if (e.code === 'WAA_FNL' || e.code === 'WAA_BAD_PROOF') return 2;
    return 1;
  } finally { await rt.close(); }
}

async function cmdReplay(flags, cfg, log) {
  if (!flags['wire-file']) throw new Error('--wire-file is required');
  const wire = JSON.parse(fs.readFileSync(flags['wire-file'], 'utf8'));
  const binding = flags.binding !== undefined
    ? flags.binding
    : await readInput(undefined, flags['binding-file']);
  if (typeof binding !== 'string' || binding.length === 0) throw new Error('--binding or --binding-file is required (non-empty)');
  const rt = new Runtime(cfg, log);
  try {
    await rt.init();
    const result = await rt.generateWire(wire, binding, { timeoutMs: cfg.generateTimeoutMs });
    print(flags, result, result.raw);
    return 0;
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code, httpStatus: e.httpStatus }, null, 2));
    else console.error(`replay failed: ${e.message}`);
    return e.httpStatus === 401 ? 3 : 1;
  } finally { await rt.close(); }
}

async function cmdServe(flags, cfg, log) {
  const rt = new Runtime(cfg, log);
  rt.init().catch((e) => log('error', `runtime init failed: ${e.message}`));
  const server = await startServer({ runtime: rt, cfg, log: (level, msg) => log(level, msg) });
  console.log(`waa-runtime server listening on ${server.url}`);
  console.log(`  provider=${cfg.proofProvider} model=${cfg.defaultModel} auth=${cfg.serverApiKey ? 'api-key' : 'none'}`);
  console.log(`  POST ${server.url}/v1/chat/completions`);
  console.log(`  GET  ${server.url}/health`);
  await new Promise((resolve) => {
    const stop = async () => {
      console.log('\nshutting down...');
      await server.close().catch(() => {});
      await rt.close().catch(() => {});
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function cmdWs(flags, cfg, log) {
  if (!flags.key) throw new Error('--key <cat-...> is required');
  if (cfg.carryContent) {
    if (!cfg.staticProof) throw new Error('--carry-content requires --proof <captured proof>');
    cfg.proofProvider = 'static';
  }
  const rt = new Runtime(cfg, log);
  await rt.init();
  const executor = new CatiecliExecutor({
    runtime: rt, cfg, log,
    wsUrl: cfg.wsUrl,
    apiKey: flags.key,
    clientVersion: flags['ws-version'] || cfg.wsClientVersion,
    carryContent: cfg.carryContent,
    carryProof: cfg.staticProof,
    onRequestDone: () => {},
  });
  executor.start();
  console.log(`catiecli executor started: ${cfg.wsUrl}`);
  await new Promise((resolve) => {
    const stop = async () => {
      console.log('\nshutting down...');
      executor.stop();
      await rt.close().catch(() => {});
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function runCli(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || positional.length === 0) { console.log(usage()); return flags.help ? 0 : 1; }
  if (flags.version || positional[0] === 'version') { console.log(pkg.version); return 0; }
  const command = positional[0];
  const cfg = toConfig(flags);
  if (flags.profile) applyProfile(cfg, flags.profile);
  if (flags.header) {
    for (const h of flags.header) {
      const i = String(h).indexOf(':');
      if (i > 0) cfg.extraHeaders[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim();
    }
  }
  if (flags.ext) cfg.extraHeaders['x-goog-ext-519733851-bin'] = String(flags.ext);
  if (flags['user-agent']) cfg.userAgent = String(flags['user-agent']);
  const log = makeLog(flags);
  try {
    switch (command) {
      case 'doctor': return await cmdDoctor(flags, cfg, log);
      case 'env': return await cmdEnv(flags, cfg, log);
      case 'waa': return await cmdWaa(flags, cfg, log);
      case 'proof': return await cmdProof(flags, cfg, log);
      case 'wire': return await cmdWire(flags, cfg, log);
      case 'generate': return await cmdGenerate(flags, cfg, log);
      case 'replay': return await cmdReplay(flags, cfg, log);
      case 'serve': return await cmdServe(flags, cfg, log);
      case 'ws': return await cmdWs(flags, cfg, log);
      case 'help': console.log(usage()); return 0;
      default:
        console.error(`unknown command: ${command}`);
        console.error(usage());
        return 1;
    }
  } catch (e) {
    if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
    else console.error(`error: ${e && (e.stack || e.message)}`);
    return 1;
  }
}

module.exports = { runCli, parseArgs, toConfig, usage };
