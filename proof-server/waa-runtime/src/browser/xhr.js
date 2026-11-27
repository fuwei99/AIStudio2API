'use strict';

/**
 * Real XMLHttpRequest on top of Node's fetch.
 *
 * The AI Studio bundle uses XHR (not fetch) for gRPC-web.  This class mimics
 * enough of the native XHR contract for the closure wrapper in the bundle:
 * readyState transitions, incremental responseText, headers, abort/timeout.
 *
 * Streaming matters: MakerSuiteService/GenerateContent is a server-streaming
 * RPC, and the bundle's frame decoder reads `responseText` after every
 * readystatechange while readyState === 3.
 */

const fs = require('node:fs');
const path = require('node:path');

function lowerHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const k of Object.keys(h)) out[String(k).toLowerCase()] = String(h[k]);
  }
  return out;
}

function createXHRClass(env) {
  return class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = null;
      this.responseText = '';
      this.responseType = '';
      this.responseURL = '';
      this.timeout = 0;
      this.withCredentials = env.options.withCredentials !== false;
      this.upload = {
        addEventListener() {}, removeEventListener() {},
        onprogress: null, onload: null, onerror: null,
      };
      this.onreadystatechange = null;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
      this.onabort = null;
      this.ontimeout = null;
      this.onprogress = null;
      this._method = 'GET';
      this._url = '';
      this._headers = Object.create(null);
      this._respHeaders = Object.create(null);
      this._listeners = Object.create(null);
      this._controller = null;
      this._timer = null;
      this._timedOut = false;
      this._sent = false;
      this._chunks = [];
    }

    open(method, url, async = true) {
      this._method = String(method || 'GET').toUpperCase();
      this._url = String(url);
      this.readyState = 1;
      this._fire('readystatechange');
    }

    setRequestHeader(name, value) {
      const k = String(name);
      const prev = this._headers[k];
      this._headers[k] = prev === undefined ? String(value) : `${prev}, ${value}`;
    }

    getResponseHeader(name) {
      const v = this._respHeaders[String(name).toLowerCase()];
      return v === undefined ? null : v;
    }

    getAllResponseHeaders() {
      return Object.entries(this._respHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    }

    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    }

    removeEventListener(type, fn) {
      const a = this._listeners[type];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }

    abort() {
      if (this._controller) {
        try { this._controller.abort(); } catch {}
      }
      this._fire('abort');
      this._fire('loadend');
    }

    send(body) {
      const url = new URL(this._url, env.url).href;
      this._sent = true;
      this.responseURL = url;
      const headers = new Headers();
      for (const k of Object.keys(this._headers)) headers.set(k, this._headers[k]);
      if (env.cookieString && !headers.has('cookie')) headers.set('cookie', env.cookieString);
      if (!headers.has('origin')) headers.set('origin', env.origin);
      if (!headers.has('referer')) headers.set('referer', env.origin + '/');
      if (!headers.has('accept')) headers.set('accept', '*/*');
      if (!headers.has('user-agent')) headers.set('user-agent', env.userAgent);
      if (!env.omitExtraHeaders && !headers.has('accept-language')) headers.set('accept-language', env.acceptLanguage || 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6');
      if (!headers.has('sec-ch-ua')) {
        const major = String(env.chromeVersion || '151').split('.')[0];
        const full = env.chromeVersion || '151.0.0.0';
        const isNew = Number(major) >= 155;
        headers.set('sec-ch-ua', isNew
          ? `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not(A:Brand";v="24"`
          : `"Not=A?Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`);
        headers.set('sec-ch-ua-arch', '"x86"');
        headers.set('sec-ch-ua-bitness', '"64"');
        headers.set('sec-ch-ua-form-factors', '"Desktop"');
        headers.set('sec-ch-ua-full-version', `"${full}"`);
        headers.set('sec-ch-ua-full-version-list', isNew
          ? `"Google Chrome";v="${full}", "Chromium";v="${full}", "Not(A:Brand";v="24.0.0.0"`
          : `"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="${full}", "Chromium";v="${full}"`);
        headers.set('sec-ch-ua-mobile', '?0');
        headers.set('sec-ch-ua-model', '""');
        headers.set('sec-ch-ua-platform', '"Windows"');
        headers.set('sec-ch-ua-platform-version', `"${env.platformVersion || '19.0.0'}"`);
        headers.set('sec-ch-ua-wow64', '?0');
      }
      if (!env.omitExtraHeaders) {
        if (!headers.has('sec-fetch-dest')) {
          headers.set('sec-fetch-dest', 'empty');
          headers.set('sec-fetch-mode', 'cors');
          headers.set('sec-fetch-site', 'same-site');
        }
        if (!headers.has('priority')) headers.set('priority', 'u=1, i');
      }
      const record = {
        url, method: this._method, headers: lowerHeaders(headers),
        bodyLength: body ? (typeof body === 'string' ? body.length : body.byteLength || body.length || 0) : 0,
        bodyPreview: typeof body === 'string' ? body.slice(0, 500) : (body && body.byteLength ? `[${body.byteLength} bytes]` : ''),
        at: Date.now(),
      };
      env.requests.push(record);
      this._record = record;

      // Offline challenge replay: useful for VM development without hitting
      // Google on every run.  The file is the raw `[null,"<base64>"]` body.
      if (env.challengeCache && url.includes('Waa/Create') && fs.existsSync(env.challengeCache)) {
        const raw = fs.readFileSync(env.challengeCache, 'utf8');
        record.cached = true;
        env.log('debug', `XHR ${this._method} ${url.slice(0, 180)} [cached challenge]`);
        this._deliverCached(200, 'OK', { 'content-type': 'application/json+protobuf' }, raw);
        return;
      }
      env.log('debug', `XHR ${this._method} ${url.slice(0, 180)}`);

      const init = { method: this._method, headers, redirect: 'follow' };
      const hasBody = body !== undefined && body !== null && this._method !== 'GET' && this._method !== 'HEAD';
      if (hasBody) init.body = body;
      this._controller = new AbortController();
      init.signal = this._controller.signal;
      if (this.timeout > 0) {
        this._timer = setTimeout(() => {
          this._timedOut = true;
          try { this._controller.abort(); } catch {}
        }, this.timeout);
      }

      const doFetch = async () => {
        try {
          return await globalThis.fetch(url, init);
        } catch (firstErr) {
          if (this._timedOut || (init.signal && init.signal.aborted)) throw firstErr;
          await new Promise((r) => setTimeout(r, 150));
          return await globalThis.fetch(url, init);
        }
      };

      doFetch().then(async (res) => {
        if (this._timedOut) return;
        this.status = res.status;
        this.statusText = res.statusText;
        res.headers.forEach((v, k) => { this._respHeaders[String(k).toLowerCase()] = v; });
        if (typeof env.onSetCookies === 'function' && res.headers && typeof res.headers.getSetCookie === 'function') {
          try {
            const sc = res.headers.getSetCookie();
            if (sc && sc.length) env.onSetCookies(sc, url);
          } catch {}
        }
        record.status = res.status;
        record.responseLength = 0;
        this.readyState = 2;
        this._fire('readystatechange');

        if (this.responseType === 'arraybuffer') {
          const buf = Buffer.from(await res.arrayBuffer());
          record.responseLength = buf.length;
          this._chunks.push(buf);
          this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          this.responseText = buf.toString('utf8');
          this.readyState = 3;
          this._fire('readystatechange');
          this.readyState = 4;
          this._fire('readystatechange');
          this._fire('load');
          this._fire('loadend');
          this._clearTimer();
          this._maybeSaveChallenge(url, this.responseText);
          return;
        }

        const decoder = new TextDecoder();
        let text = '';
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (this._timedOut) return;
            const chunk = decoder.decode(value, { stream: true });
            text += chunk;
            record.responseLength += value.byteLength || value.length || 0;
            this.responseText = text;
            this.response = text;
            this.readyState = 3;
            this._fire('readystatechange');
            this._fire('progress');
          }
          const tail = decoder.decode();
          if (tail) {
            text += tail;
            this.responseText = text;
            this.response = text;
            this.readyState = 3;
            this._fire('readystatechange');
          }
        } else {
          text = await res.text();
          record.responseLength = text.length;
          this.responseText = text;
          this.response = text;
          this.readyState = 3;
          this._fire('readystatechange');
        }

        this.readyState = 4;
        this._fire('readystatechange');
        this._fire('load');
        this._fire('loadend');
        this._clearTimer();
        this._maybeSaveChallenge(url, text);
      }).catch((err) => {
        this._clearTimer();
        if (this._timedOut) {
          this.readyState = 4;
          this._fire('readystatechange');
          this._fire('timeout');
          this._fire('loadend');
          return;
        }
        env.log('debug', `XHR error ${this._method} ${url.slice(0, 160)}: ${err && err.message}`);
        record.error = String(err && err.message || err);
        this.status = 0;
        this.readyState = 4;
        this._fire('readystatechange');
        this._fire('error');
        this._fire('loadend');
      });
    }

    _maybeSaveChallenge(url, text) {
      if (!env.saveChallengePath || !url.includes('Waa/Create') || !text) return;
      try {
        fs.mkdirSync(path.dirname(env.saveChallengePath), { recursive: true });
        fs.writeFileSync(env.saveChallengePath, text);
        env.log('debug', `saved Waa/Create challenge -> ${env.saveChallengePath} (${text.length} chars)`);
      } catch (e) {
        env.log('warn', `cannot save challenge: ${e.message}`);
      }
    }

    _deliverCached(status, statusText, headers, text) {
      Object.assign(this._respHeaders, lowerHeaders(headers));
      this.status = status;
      this.statusText = statusText;
      setTimeout(() => {
        this.readyState = 2;
        this._fire('readystatechange');
        this.responseText = text;
        this.response = text;
        this.readyState = 3;
        this._fire('readystatechange');
        this.readyState = 4;
        this._fire('readystatechange');
        this._fire('load');
        this._fire('loadend');
      }, 0);
    }

    _clearTimer() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    }

    _fire(type) {
      const ev = {
        type,
        target: this,
        currentTarget: this,
        lengthComputable: false,
        loaded: this.responseText ? this.responseText.length : 0,
        total: 0,
        timeStamp: Date.now(),
      };
      const handler = this['on' + type];
      if (typeof handler === 'function') {
        try { handler.call(this, ev); } catch (e) { env.log('warn', `XHR ${type} handler: ${e && e.message}`); }
      }
      for (const fn of (this._listeners[type] || [])) {
        try { fn.call(this, ev); } catch (e) { env.log('warn', `XHR ${type} listener: ${e && e.message}`); }
      }
    }
  };
}

module.exports = { createXHRClass };
