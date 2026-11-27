'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Static proof provider.  Useful for:
 *   - unit tests / server development without Chrome;
 *   - replaying a proof captured from the browser;
 *   - feeding a proof generated out-of-band.
 *
 * A static proof is only valid for the exact digest it was generated over,
 * so this is not a general-purpose production provider.
 */
class StaticProofProvider {
  constructor(options = {}) {
    this.options = options;
    this.log = options.log || (() => {});
    this.proof = options.proof || '';
    this.file = options.proofFile || options.file || '';
    this.bindingContent = options.bindingContent;
    this.allowInvalidProof = !!options.allowInvalidProof;
    this.status = 'ready';
  }

  async init() { return this; }

  async snapshot(digest) {
    let proof = this.proof;
    if (!proof && this.file) proof = fs.readFileSync(this.file, 'utf8').trim();
    if (!proof) throw new Error('static proof provider has no proof (set --proof or --proof-file)');
    if (this.bindingContent !== undefined && this.bindingContent !== null && this.bindingContent !== '') {
      const expected = crypto.createHash('sha256').update(String(this.bindingContent), 'utf8').digest('hex');
      if (String(digest) !== expected) {
        throw new Error(`static proof binding mismatch: proof is bound to ${expected}, request digest is ${digest}`);
      }
    }
    if (!proof.startsWith('!') && !this.allowInvalidProof) {
      const err = new Error(`static proof does not start with "!": ${proof.slice(0, 80)}`);
      err.code = 'WAA_BAD_PROOF';
      throw err;
    }
    return proof;
  }

  async close() {}

  describe() {
    return { type: 'static', status: this.status, proofLength: (this.proof || '').length || undefined };
  }
}

module.exports = { StaticProofProvider };
