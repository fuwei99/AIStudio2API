'use strict';

const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');

const DEFAULTS = {
  // AI Studio closure bundle (contains WAA service, protobuf schema, RPC stack)
  bundlePath: process.env.WAA_BUNDLE ||
    path.join(WORKSPACE, 'ms_bundles', 'b0.patched.js'),

  // Where downloaded botguard programs / raw challenge responses are cached.
  cacheDir: process.env.WAA_CACHE_DIR || path.join(ROOT, 'cache'),

  // Fake document origin.  Must stay a *.google.com origin: the WAA challenge
  // program is bound to `/app/_/bscframe` and the RPC endpoints only accept
  // Google origins.
  origin: process.env.WAA_ORIGIN || 'https://aistudio.google.com',
  pageUrl: process.env.WAA_PAGE_URL || 'https://aistudio.google.com/prompts/new_chat',

  waaBase: 'https://waa-pa.clients6.google.com',
  makerSuiteBase: 'https://alkalimakersuite-pa.clients6.google.com',

  // Chrome UA used for the fake environment.  Keep navigator.userAgentData
  // consistent with this string.
  userAgent: process.env.WAA_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  chromeVersion: '151.0.7922.137',

  // WAA service bootstrap timeout (seconds).  First run downloads and JITs the
  // 66 KB botguard program; on slow machines this can take a while.
  waaInitTimeoutMs: Number(process.env.WAA_INIT_TIMEOUT_MS || 180000),
  snapshotTimeoutMs: Number(process.env.WAA_SNAPSHOT_TIMEOUT_MS || 60000),

  // GenerateContent request timeout.
  generateTimeoutMs: Number(process.env.WAA_GENERATE_TIMEOUT_MS || 180000),

  // Default model advertised by the local OpenAI-compatible server.
  defaultModel: process.env.WAA_MODEL || 'gemini-3.8-flash',

  // Proof provider: node-vm is the local-only path (currently ends at FNL),
  // static replays a captured proof, browser is an optional out-of-band
  // fallback and is never used unless explicitly selected.
  proofProvider: process.env.WAA_PROOF_PROVIDER || 'node-vm',

  // Challenge/program caching for local VM work.  A cached challenge lets the
  // whole Waa/Create step run offline; the program is cached by program id.
  challengeCache: process.env.WAA_CHALLENGE_CACHE || '',
  saveChallenge: process.env.WAA_SAVE_CHALLENGE === '1',
  refreshProgram: process.env.WAA_REFRESH_PROGRAM === '1',

  // Minimal, syntax-safe botguard instrumentation for local VM diagnostics.
  instrumentProgram: process.env.WAA_INSTRUMENT === '1',

  // E1 warmth/regime controls (default off: behaviour is unchanged).
  //   minChallengeAgeMs — wait this long after the VM is ready before minting
  //   warmupMints       — throw-away snapshots before the first real mint
  //   loggerAlways      — force Qtb logger throttle F=0 so records accumulate
  minChallengeAgeMs: Number(process.env.WAA_MIN_AGE_MS || 0),
  warmupMints: Number(process.env.WAA_WARMUP_MINTS || 0),
  loggerAlways: process.env.WAA_ALWAYS_LOG === '1',

  // Model list exposed by the HTTP server (first one is the default).
  extraModels: process.env.WAA_EXTRA_MODELS ? process.env.WAA_EXTRA_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : [],

  // Google session cookies.  Only needed for MakerSuite GenerateContent; the
  // WAA challenge itself only uses the AI Studio API key baked into the bundle.
  cookieFile: process.env.WAA_COOKIE_FILE || '',
  cookieJson: process.env.WAA_COOKIE_JSON || '',
  cookies: process.env.WAA_COOKIE || '',
  googleApiKey: process.env.WAA_GOOGLE_API_KEY || "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
  authorization: process.env.WAA_AUTHORIZATION || '',
  authUser: Number(process.env.WAA_AUTH_USER || 0),
  visitId: process.env.WAA_VISIT_ID || '',
  profile: process.env.WAA_PROFILE || '',
  extraHeaders: {},

  // Static proof provider
  staticProof: process.env.WAA_STATIC_PROOF || '',
  staticProofFile: process.env.WAA_STATIC_PROOF_FILE || '',
  // Proof-binding workaround: keep this content in `contents` and carry the
  // real conversation in systemInstruction (not hashed by _.SB).
  carryContent: process.env.WAA_CARRY_CONTENT || '',

  // Browser provider tuning
  browserParentUrl: process.env.WAA_BROWSER_PARENT || '',
  browserSettleMs: Number(process.env.WAA_BROWSER_SETTLE_MS || 1500),
  chromeArgs: process.env.WAA_CHROME_ARGS ? process.env.WAA_CHROME_ARGS.split(' ').filter(Boolean) : [],
  chromeProfileDir: process.env.WAA_CHROME_PROFILE || '',

  // Local HTTP server.
  host: process.env.WAA_HOST || '127.0.0.1',
  port: Number(process.env.WAA_PORT || 8787),
  serverApiKey: process.env.WAA_SERVER_API_KEY || '',

  // catiecli executor endpoint
  wsUrl: process.env.WAA_WS_URL || 'wss://catiecli.sukaka.top/api/build/ws',
  wsClientVersion: '2.4.2',

  // Browser proof provider
  chromePath: process.env.WAA_CHROME || '',
  browserHeadless: process.env.WAA_BROWSER_HEADLESS !== '0',
  browserTimeoutMs: Number(process.env.WAA_BROWSER_TIMEOUT_MS || 180000),

  // Node VM proof provider currently hits the FNL production guard.  Set to
  // false once the environment layer is complete.
  allowInvalidProof: process.env.WAA_ALLOW_INVALID_PROOF === '1',
  autoRotateCookies: process.env.WAA_AUTO_ROTATE_COOKIES !== '0',
  cookieRotateIntervalMs: Number(process.env.WAA_COOKIE_ROTATE_INTERVAL_MS || 540000),
  lastCookieRotateAt: 0,
  persistCookies: process.env.WAA_PERSIST_COOKIES === '1',
};

function loadConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.origin = String(cfg.origin).replace(/\/+$/, '');
  cfg.pageUrl = cfg.pageUrl || cfg.origin + '/';
  cfg.cacheDir = path.resolve(cfg.cacheDir);
  cfg.bundlePath = path.resolve(cfg.bundlePath);
  return cfg;
}

module.exports = { DEFAULTS, ROOT, WORKSPACE, loadConfig };
