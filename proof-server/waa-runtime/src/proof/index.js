'use strict';

const { NodeVmProofProvider } = require('./node-vm');
const { StaticProofProvider } = require('./static');

async function createProofProvider(type, options = {}) {
  const kind = String(type || 'node-vm').toLowerCase();
  let provider;
  if (kind === 'node-vm' || kind === 'node' || kind === 'vm') {
    provider = new NodeVmProofProvider(options);
  } else if (kind === 'static' || kind === 'file') {
    provider = new StaticProofProvider(options);
  } else {
    throw new Error(`unknown proof provider: ${type} (expected node-vm or static)`);
  }
  if (options.init !== false) await provider.init();
  return provider;
}

module.exports = { createProofProvider, NodeVmProofProvider, StaticProofProvider };
