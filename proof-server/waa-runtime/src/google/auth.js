'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Google cookie parsing + SAPISIDHASH generation.
 *
 * Supported inputs:
 *   - Playwright / Puppeteer JSON:  [{name,value,domain,...}, ...]
 *   - plain JSON object:            {"SAPISID": "...", ...}
 *   - Netscape cookies.txt:         .google.com\tTRUE\t/\tTRUE\t...\tSAPISID\t...
 *   - any Set-Cookie-ish text:      "SAPISID=...; __Secure-1PSID=..."
 *   - a raw Cookie header:          "SAPISID=...; SID=..."
 */

const IMPORTANT = [
  'SAPISID', 'APISID', '__Secure-3PAPISID', '__Secure-1PAPISID',
  '__Secure-3PSID', '__Secure-1PSID', 'SID', 'HSID', 'SSID', 'OSID',
  '__Secure-OSID', 'NID', 'AEC', 'SOCS', 'SEARCH_SAMESITE',
];

function normalizeCookieObject(obj) {
  const map = new Map();
  if (Array.isArray(obj)) {
    for (const c of obj) {
      if (!c) continue;
      const name = c.name ?? c.Name ?? c.key;
      const value = c.value ?? c.Value ?? c.val;
      if (name !== undefined && value !== undefined) map.set(String(name), String(value));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && 'value' in v) map.set(k, String(v.value));
      else if (typeof v === 'string' || typeof v === 'number') map.set(k, String(v));
    }
  }
  return map;
}

function parseNetscape(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    if (name) map.set(name, value);
  }
  return map;
}

function parseHeaderCookies(text) {
  const map = new Map();
  // Both "Cookie: a=b; c=d" and Set-Cookie blocks work if we split on the
  // first '=' of each segment and ignore attributes.
  for (const segment of String(text).split(/;\s*|\r?\n/)) {
    const s = segment.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    let value = s.slice(i + 1).trim();
    if (/^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i.test(name)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(name, value);
  }
  return map;
}

function parseCookieInput(input) {
  const text = String(input ?? '');
  if (!text.trim()) return new Map();
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return normalizeCookieObject(JSON.parse(trimmed)); } catch {}
  }
  if (/Netscape HTTP Cookie File/i.test(text) || text.includes('\t')) {
    const map = parseNetscape(text);
    if (map.size) return map;
  }
  return parseHeaderCookies(text);
}

function loadCookieFile(file) {
  return parseCookieInput(fs.readFileSync(file, 'utf8'));
}

const ACCOUNT_HOST_ONLY_COOKIES = new Set([
  'LSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  '__Host-GAPS',
  'ACCOUNT_CHOOSER',
]);

function toCookieHeader(map, options = {}) {
  const includeAccountHost = !!options.includeAccountHost;
  const pairs = [];
  for (const [k, v] of map) {
    if (!includeAccountHost && ACCOUNT_HOST_ONLY_COOKIES.has(k)) continue;
    pairs.push(`${k}=${v}`);
  }
  return pairs.join('; ');
}

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

function sapisidHash(sapisid, origin, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  return `${ts}_${sha1Hex(`${ts} ${sapisid} ${origin}`)}`;
}

/**
 * Build the `Authorization` header exactly the way Google's own `_.bo([])`
 * helper does: SAPISIDHASH for the current origin plus the optional 1P/3P
 * variants when the corresponding cookies are present.
 */
function buildAuthorization(map, origin = 'https://aistudio.google.com') {
  const sapisid = map.get('SAPISID') || map.get('__Secure-3PAPISID') || map.get('APISID');
  if (!sapisid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const parts = [`SAPISIDHASH ${sapisidHash(sapisid, origin, ts)}`];
  const one = map.get('__Secure-1PAPISID');
  if (one) parts.push(`SAPISID1PHASH ${sapisidHash(one, origin, ts)}`);
  const three = map.get('__Secure-3PAPISID');
  if (three && three !== sapisid) parts.push(`SAPISID3PHASH ${sapisidHash(three, origin, ts)}`);
  return parts.join(' ');
}

function summarizeCookies(map) {
  const names = Array.from(map.keys());
  return {
    count: names.length,
    hasSapisid: !!(map.get('SAPISID') || map.get('__Secure-3PAPISID')),
    important: IMPORTANT.filter((n) => map.has(n)),
    names: names.slice(0, 80),
  };
}

function applySetCookies(map, setCookieHeaders) {
  const updated = [];
  if (!map || !Array.isArray(setCookieHeaders)) return updated;
  for (const raw of setCookieHeaders) {
    if (!raw || typeof raw !== 'string') continue;
    const parts = raw.split(';').map((s) => s.trim());
    const [nv, ...attrs] = parts;
    if (!nv) continue;
    const eq = nv.indexOf('=');
    if (eq <= 0) continue;
    const name = nv.slice(0, eq).trim();
    const val = nv.slice(eq + 1).trim();
    if (!val || val === 'deleted') continue;
    const attrStr = attrs.join('; ');
    if (/domain=[^;]*gstatic\.com/i.test(attrStr)) continue;
    if (/expires=[^;]*19[789]\d/i.test(attrStr)) continue;
    if (map.get(name) !== val) {
      map.set(name, val);
      updated.push(name);
    }
  }
  return updated;
}

/**
 * Call Google's background session rotation endpoint (`accounts.google.com/RotateCookies`)
 * to refresh short-lived `__Secure-1PSIDTS`, `__Secure-3PSIDTS`, `SIDCC`,
 * `__Secure-1PSIDCC`, `__Secure-3PSIDCC` cookies using the long-lived (400-day)
 * `SID` / `__Secure-1PSID` / `__Secure-3PSID` master cookies.
 */
async function rotateGoogleCookies(map, options = {}) {
  if (!map || map.size === 0) return { ok: false, status: 0, updated: [] };
  // Never call accounts.google.com/RotateCookies unless the accounts.google.com
  // host-only session cookies (LSID / __Host-1PLSID / __Host-3PLSID) are present,
  // because calling RotateCookies with only .google.com cookies can cause Google
  // to invalidate the SID session.
  if (
    !map.has('LSID') &&
    !map.has('__Host-1PLSID') &&
    !map.has('__Host-3PLSID') &&
    !map.has('__Secure-1PSIDTS') &&
    !map.has('__Secure-3PSIDTS')
  ) {
    return { ok: false, status: 0, updated: [], skipped: 'missing_lsid' };
  }
  const ua = options.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  try {
    const res = await globalThis.fetch('https://accounts.google.com/RotateCookies', {
      method: 'POST',
      headers: {
        cookie: toCookieHeader(map, { includeAccountHost: true }),
        'user-agent': ua,
        'content-type': 'application/json',
        origin: 'https://accounts.google.com',
        referer: 'https://accounts.google.com/RotateCookiesPage',
      },
      body: JSON.stringify([null, '-1234567890', 0]),
      signal: AbortSignal.timeout(options.timeoutMs || 15000),
    });
    const sc = (res.headers && typeof res.headers.getSetCookie === 'function')
      ? res.headers.getSetCookie()
      : [];
    const updated = applySetCookies(map, sc);
    return { ok: res.status === 200, status: res.status, updated };
  } catch (e) {
    return { ok: false, status: 0, updated: [], error: e && e.message };
  }
}

module.exports = {
  parseCookieInput,
  loadCookieFile,
  toCookieHeader,
  buildAuthorization,
  sapisidHash,
  sha1Hex,
  summarizeCookies,
  applySetCookies,
  rotateGoogleCookies,
  IMPORTANT,
};
