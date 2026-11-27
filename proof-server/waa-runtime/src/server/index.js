'use strict';

const { createApp } = require('./app');

async function startServer(options = {}) {
  const { runtime, cfg, log } = options;
  const app = createApp({ runtime, cfg, log });
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(cfg.port, cfg.host, () => {
      app.removeListener('error', reject);
      resolve();
    });
  });
  const address = app.address();
  const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  const url = `http://${host}:${address.port}`;
  return {
    server: app,
    url,
    port: address.port,
    async close() {
      await new Promise((resolve) => app.close(resolve));
    },
  };
}

module.exports = { startServer };
