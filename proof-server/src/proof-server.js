'use strict';

/**
 * Pure Node.js (`node:vm`) WAA `!proof` Minting Server (Local Port 18801)
 *
 * Responsibilities:
 *   - Receives chat history + minimal Google cookies from the Relay Client.
 *   - Manages the in-memory AccountPool (1h hot VM, zero disk persistence).
 *   - Returns only the `!xxx` proof (no cookies/authorization are echoed).
 *   - Does NOT include any browser / cookie-login scraping functionality.
 */

const http = require('node:http');
const { AccountPool } = require('./account-pool');

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// --- 24h mint ledger (rolling, persisted) ---
// Every successful /v1/proof/mint (public via nginx or internal via 127.0.0.1) lands here,
// so this counter is the single source of truth for "how many proofs were actually minted".
// 同时追加写入磁盘（只追加、不压缩），进程重启后从文件恢复，不再归零。
const fs = require('node:fs');
const path = require('node:path');

const MINT_LEDGER_TTL_MS = 24 * 3600 * 1000;
const MINT_LEDGER_FILE =
  process.env.MINT_LEDGER_FILE || path.join(__dirname, '..', 'data', 'mint-ledger.log');
const mintLedger = [];

function ensureLedgerDir() {
  try {
    fs.mkdirSync(path.dirname(MINT_LEDGER_FILE), { recursive: true, mode: 0o700 });
  } catch {}
}

function loadMintLedger() {
  ensureLedgerDir();
  try {
    const raw = fs.readFileSync(MINT_LEDGER_FILE, 'utf8');
    const cutoff = Date.now() - MINT_LEDGER_TTL_MS;
    for (const line of raw.split('\n')) {
      const ts = Number(String(line).trim());
      if (Number.isFinite(ts) && ts >= cutoff) mintLedger.push(ts);
    }
    mintLedger.sort((a, b) => a - b);
    return mintLedger.length;
  } catch {
    return 0;
  }
}

function appendMintLine(ts) {
  try {
    fs.appendFileSync(MINT_LEDGER_FILE, ts + '\n');
  } catch {}
}


function pruneMintLedger(now = Date.now()) {
  const cutoff = now - MINT_LEDGER_TTL_MS;
  let drop = 0;
  while (drop < mintLedger.length && mintLedger[drop] < cutoff) drop += 1;
  if (drop > 0) mintLedger.splice(0, drop);
}

function recordMint(now = Date.now()) {
  mintLedger.push(now);
  appendMintLine(now);
  pruneMintLedger(now);
}

const restoredMints = loadMintLedger();
console.log(
  '[mint-ledger] restored ' + restoredMints + ' mints (<=24h) from ' + MINT_LEDGER_FILE,
);

function mintCount24h(now = Date.now()) {
  pruneMintLedger(now);
  return mintLedger.length;
}

function createProofServer(options = {}) {
  const pool = options.pool || new AccountPool(options);
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 18801);

  const server = http.createServer(async (req, res) => {
    const reqHost = req.headers.host || `${host}:${port}`;
    const url = new URL(req.url || '/', `http://${reqHost}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/v1/pool/summary') {
        pool.sweep();
        return sendJson(res, 200, {
          ok: true,
          hotCookies24h: pool.entries.size,
          accountIds24h: Array.from(pool.entries.keys()),
          mints24h: mintCount24h(),
        });
      }

      if (req.method === 'GET' && (pathname === '/health' || pathname === '/v1/pool/stats')) {
        const rawCookies =
          url.searchParams.get('cookies') || req.headers['x-google-cookies'] || '';
        if (!String(rawCookies).trim()) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing `cookies` query parameter or X-Google-Cookies header',
          });
        }
        const authUser =
          url.searchParams.get('authUser') ?? req.headers['x-goog-authuser'] ?? 0;
        return sendJson(res, 200, {
          ok: true,
          hotTtlMs: pool.hotTtlMs,
          account: pool.accountInfo(rawCookies, authUser),
        });
      }

      if (req.method === 'POST' && pathname === '/v1/proof/mint') {
        const body = await readJsonBody(req);
        const rawCookies = body.cookies || req.headers['x-google-cookies'] || '';
        if (!rawCookies) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Missing `cookies` in request body or X-Google-Cookies header',
          });
        }
        const result = await pool.mintProof({
          cookies: rawCookies,
          authUser: body.authUser ?? req.headers['x-goog-authuser'] ?? 0,
          g1Tier: body.g1Tier || null,
          model: body.model,
          wireContents: body.wireContents,
          messages: body.messages,
          contents: body.contents,
          systemInstruction: body.systemInstruction || body.system_instruction,
          generationConfig: body.generationConfig,
          prompt: body.prompt,
          digest: body.digest,
          forceRefresh: Boolean(body.forceRefresh),
        });
        if (!result || result.ok !== false) recordMint();
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${pathname}` });
    } catch (err) {
      const status = Number(err && err.httpStatus) || 500;
      return sendJson(res, status, {
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  });

  return {
    pool,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      return {
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await pool.closeAll();
    },
  };
}

module.exports = { createProofServer };
