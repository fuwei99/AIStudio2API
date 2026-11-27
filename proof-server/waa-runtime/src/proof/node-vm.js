'use strict';

const { WaaService } = require('../waa/service');

/**
 * Pure-Node proof provider: Waa/Create + botguard program + VM inside
 * node:vm.  It produces real `!...` proofs locally after the iframe load
 * lifecycle was added to the DOM stub.
 *
 * Note: Google currently rejects these locally-minted proofs with 403.  The
 * proof string is structurally valid and content-bound; the remaining gap is
 * the VM proof's environment/attestation binding (the excluded core piece).
 */
class NodeVmProofProvider {
  constructor(options = {}) {
    this.options = options;
    this.log = options.log || (() => {});
    this.timeoutMs = options.timeoutMs || 180000;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs || 60000;
    this.allowInvalidProof = !!options.allowInvalidProof;
    this.ms = options.ms;
    this.apiKey = options.apiKey;
    this.cookies = options.cookies || '';
    this.cookieMap = options.cookieMap || null;
    this.authorization = options.authorization || '';
    this.authUser = options.authUser ?? 0;
    this.visitId = options.visitId || '';
    this.origin = options.origin || 'https://aistudio.google.com';
    this.waa = null;
    this.status = 'new';
    this.initStarted = 0;
    this.initFinished = 0;
  }

  async init() {
    if (this.waa) return this;
    this.initStarted = Date.now();
    this.status = 'initializing';
    this.waa = new WaaService({
      ms: this.ms,
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
      snapshotTimeoutMs: this.snapshotTimeoutMs,
      log: this.log,
      bundle: this.options.bundle,
      cookies: this.cookies,
      cookieMap: this.cookieMap,
      authorization: this.authorization || '',
      authUser: this.authUser,
      visitId: this.visitId,
      extraHeaders: this.options.extraHeaders || null,
      origin: this.origin,
      // E1 warmth/regime controls (all default-off).
      minAgeMs: this.options.minAgeMs,
      warmupMints: this.options.warmupMints,
      loggerAlways: this.options.loggerAlways,
    });
    await this.waa.init();
    this.initFinished = Date.now();
    this.status = 'ready';
    return this;
  }

  async snapshot(digest) {
    await this.init();
    const raw = await this.waa.snapshotRaw(digest);
    if (typeof raw === 'string' && raw.startsWith('!')) {
      this.status = 'ready';
      return raw;
    }
    this.status = 'fnl';
    const err = new Error(`Node VM returned a non-proof value (${raw.length} chars): ${raw.slice(0, 160)}`);
    err.code = raw.startsWith('FNL') ? 'WAA_FNL' : 'WAA_BAD_PROOF';
    err.raw = raw;
    if (this.allowInvalidProof) {
      this.log('warn', 'returning invalid proof because allowInvalidProof is set');
      return raw;
    }
    throw err;
  }

  async close() {
    if (this.waa) await this.waa.close();
    this.waa = null;
    this.status = 'closed';
  }

  describe() {
    return {
      type: 'node-vm',
      status: this.status,
      initMs: this.initFinished ? this.initFinished - this.initStarted : null,
      waa: this.waa ? this.waa.describe() : null,
      note: this.status === 'fnl'
        ? 'local proof was not a "!" proof'
        : 'local !proof is content-bound; Google acceptance is the remaining core VM issue',
    };
  }
}

module.exports = { NodeVmProofProvider };
