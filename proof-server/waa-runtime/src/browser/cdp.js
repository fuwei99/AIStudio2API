'use strict';

/**
 * Tiny Chrome DevTools Protocol client over the native WebSocket (Node >= 22).
 * Only what the browser proof provider needs: request/response + events.
 */

class CDPClient {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.timeoutMs = options.timeoutMs || 60000;
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        return;
      }
      const handlers = this.listeners.get(msg.method);
      if (handlers) for (const fn of handlers) { try { fn(msg.params, msg.sessionId); } catch {} }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(url, options = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (e) => { cleanup(); reject(new Error('WebSocket error: ' + (e && e.message || url))); };
      const cleanup = () => { ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onError); };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
    return new CDPClient(ws, options);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP closed, cannot send ${method}`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${this.timeoutMs} ms: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const a = this.listeners.get(method) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise === true,
      userGesture: true,
      includeCommandLineAPI: false,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const desc = d.exception && (d.exception.description || d.exception.value);
      throw new Error(`page exception: ${desc || d.text}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

module.exports = { CDPClient };
