'use strict';

const fs = require('node:fs');

/**
 * Local request profile: a JSON file holding the session material needed for
 * a live MakerSuite request.  It is never written by the runtime and never
 * logged; treat it like a password.
 *
 * {
 *   "cookies": "SAPISID=...; ...",           // or "cookieFile": "cookies.txt"
 *   "googleApiKey": "AIza...",
 *   "authorization": "SAPISIDHASH ...",      // optional; otherwise derived
 *   "visitId": "v1_...",
 *   "userAgent": "Mozilla/5.0 ... Chrome/155 ...",
 *   "model": "models/gemini-3.8-flash",
 *   "extraHeaders": {
 *     "x-goog-ext-519733851-bin": "...",
 *     "x-browser-channel": "stable",
 *     "x-browser-validation": "...",
 *     "x-browser-copyright": "...",
 *     "x-browser-year": "2026",
 *     "sec-ch-ua": "...",
 *     "sec-ch-ua-mobile": "?0",
 *     "sec-ch-ua-platform": "\"Windows\""
 *   }
 * }
 */
function applyProfile(cfg, file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = {
    cookies: 'cookies',
    cookieFile: 'cookieFile',
    cookieJson: 'cookieJson',
    googleApiKey: 'googleApiKey',
    authorization: 'authorization',
    visitId: 'visitId',
    userAgent: 'userAgent',
    model: 'defaultModel',
    carryContent: 'carryContent',
    proofProvider: 'proofProvider',
    staticProof: 'staticProof',
    staticProofFile: 'staticProofFile',
    authUser: 'authUser',
    origin: 'origin',
    lastCookieRotateAt: 'lastCookieRotateAt',
  };
  for (const [key, target] of Object.entries(map)) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') cfg[target] = raw[key];
  }
  if (raw.extraHeaders && typeof raw.extraHeaders === 'object') {
    cfg.extraHeaders = { ...(cfg.extraHeaders || {}), ...raw.extraHeaders };
  }
  if (raw.serverApiKey) cfg.serverApiKey = raw.serverApiKey;
  if (raw.proof) cfg.staticProof = raw.proof;
  return raw;
}

module.exports = { applyProfile };
