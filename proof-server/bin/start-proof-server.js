#!/usr/bin/env node
'use strict';

const { createProofServer } = require('../src/proof-server');

async function main() {
  const host = process.env.PROOF_HOST || '127.0.0.1';
  const port = Number(process.env.PROOF_PORT || 18801);
  const srv = createProofServer({
    host,
    port,
    hotTtlMs: Number(process.env.HOT_TTL_MS || 60 * 60 * 1000),
    maxConcurrentInits: Number(process.env.MAX_CONCURRENT_INITS || 16),
  });
  const info = await srv.listen();
  console.log(`[WAA Proof Server] Listening on ${info.url} (Zero Disk Persistence: true)`);
}

main().catch((err) => {
  console.error('[WAA Proof Server] Fatal error:', err);
  process.exit(1);
});
