'use strict';

/**
 * Minimal-but-faithful browser environment for running the AI Studio closure
 * bundle inside `node:vm`.
 *
 * The goal is NOT to reimplement a browser: it is to satisfy every probe the
 * WAA botguard program and the closure runtime perform, while keeping all
 * network traffic in Node.  Everything that is observable in a real Chrome
 * (DOM shape, navigator, screen, storage, script loader, XHR) is provided here.
 *
 * Lessons baked in (see report §5.3):
 *   - document.currentScript must be null while the bundle initialises
 *   - document.documentElement.getAttribute('lang') must return a string
 *   - navigator.userAgentData.getHighEntropyValues() must return a Promise
 *   - atob/btoa must exist
 *   - XMLHttpRequest must be real (the bundle uses it, not fetch)
 *   - appended <script> elements must actually execute
 *   - protocol-relative script URLs (//www.google.com/...) need an origin
 *   - document must not be a catch-all Proxy
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createXHRClass } = require('./xhr');

let CHROME_SCHEMA = null;
try {
  CHROME_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'chrome-schema.json'), 'utf8'));
} catch {}

const JS_CORE_BUILTINS = new Set([
  'Object', 'Function', 'Array', 'String', 'Boolean', 'Number', 'BigInt',
  'Math', 'Date', 'RegExp', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'SuppressedError',
  'JSON', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Reflect', 'Proxy', 'Intl', 'WebAssembly',
  'eval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape', 'undefined',
  'NaN', 'Infinity', 'globalThis', 'Iterator', 'Temporal', 'DisposableStack', 'AsyncDisposableStack',
]);

let CACHED_SCHEMA_GLOBALS = null;

const makeNativeGetter = (name, fn) => {
  Object.defineProperty(fn, 'name', { value: 'get ' + name });
  fn.toString = () => `function get ${name}() { [native code] }`;
  return fn;
};
const makeNativeSetter = (name, fn) => {
  Object.defineProperty(fn, 'name', { value: 'set ' + name });
  fn.toString = () => `function set ${name}() { [native code] }`;
  return fn;
};
const makeNativeMethod = (name, fn) => {
  Object.defineProperty(fn, 'name', { value: name });
  fn.toString = () => `function ${name}() { [native code] }`;
  return fn;
};

function getSchemaGlobalsForSandbox(makeProtoWithNames) {
  if (CACHED_SCHEMA_GLOBALS) return CACHED_SCHEMA_GLOBALS;
  if (!CHROME_SCHEMA || !CHROME_SCHEMA.winProps) return null;
  const schemaGlobals = {};
  for (const [k, info] of Object.entries(CHROME_SCHEMA.winProps)) {
    if (JS_CORE_BUILTINS.has(k)) continue;
    if (info.t === 'function') {
      if (info.proto) {
        schemaGlobals[k] = makeProtoWithNames(k, info.proto);
      } else {
        const fn = () => {};
        Object.defineProperty(fn, 'name', { value: k });
        fn.toString = () => `function ${k}() { [native code] }`;
        schemaGlobals[k] = fn;
      }
    } else if (info.t === 'object') {
      schemaGlobals[k] = k.startsWith('on') ? null : {};
    } else if (info.t === 'number') {
      schemaGlobals[k] = 0;
    } else if (info.t === 'boolean') {
      schemaGlobals[k] = false;
    } else if (info.t === 'string') {
      schemaGlobals[k] = '';
    }
  }
  CACHED_SCHEMA_GLOBALS = schemaGlobals;
  return CACHED_SCHEMA_GLOBALS;
}

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function nowMs() { return performance.now(); }

// Cookies a browser would hide from `document.cookie`.  The HTTP Cookie
// header still carries all of them; this only affects what page JavaScript
// (and therefore the botguard environment probe) can see.
const HTTPONLY_COOKIE_RE = /^(?:SID|HSID|SSID|APISID|SAPISID|NID|AEC|__Secure-(?:1P|3P)?(?:SID|PSID|PAPISID).*)$/i;

function computeDocumentCookie(cookieString) {
  return String(cookieString || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((pair) => !HTTPONLY_COOKIE_RE.test(pair.split('=')[0]))
    .join('; ');
}

function binaryAtob(input) {
  const s = String(input).replace(/[\t\n\f\r ]/g, '');
  return Buffer.from(s, 'base64').toString('latin1');
}
function binaryBtoa(input) {
  return Buffer.from(String(input), 'latin1').toString('base64');
}

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const on = force === undefined ? !set.has(n) : !!force;
      if (on) set.add(n); else set.delete(n);
      return on;
    },
    item: (i) => Array.from(set)[i] ?? null,
    get length() { return set.size; },
    toString: () => Array.from(set).join(' '),
    _set: set,
    _el: el,
  };
}

function makeStyle() {
  const props = new Map();
  const styleTypes = (CHROME_SCHEMA && CHROME_SCHEMA.styleTypes) || null;
  return new Proxy({
    setProperty(k, v) { props.set(String(k), String(v)); },
    getPropertyValue(k) { return props.get(String(k)) || ''; },
    getPropertyPriority() { return ''; },
    item() { return ''; },
    removeProperty(k) { const v = props.get(String(k)) || ''; props.delete(String(k)); return v; },
    get length() { return props.size; },
    get parentRule() { return null; },
    get cssFloat() { return props.get('cssFloat') || ''; },
    get cssText() { return Array.from(props, ([k, v]) => `${k}: ${v}`).join('; '); },
    set cssText(v) { for (const part of String(v).split(';')) { const i = part.indexOf(':'); if (i > 0) props.set(part.slice(0, i).trim(), part.slice(i + 1).trim()); } },
  }, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'symbol') return t[p];
      const k = String(p);
      if ( props.has(k)) return props.get(k);
      if (k.startsWith('epub')) return undefined;
      if (styleTypes) {
        const st = styleTypes[k];
        if (st === 'string') return '';
        if (st === 'number') return 0;
        if (st === 'function') return function () {};
        if (st === 'object') return null;
        if (st === undefined) return undefined;
      }
      return '';
    },
    set(t, p, v) { props.set(String(p), String(v)); return true; },
    has(t, p) { return p in t || props.has(String(p)) || !!(styleTypes && String(p) in styleTypes && !String(p).startsWith('epub')); },
  });
}

function makeNodeList(tag = 'NodeList', initial = null) {
  const list = {
    length: 0,
    item(i) { return this[i] || null; },
    [Symbol.toStringTag]: tag,
    *[Symbol.iterator]() {
      for (let i = 0; i < this.length; i++) yield this[i];
    },
  };
  Object.defineProperties(list, {
    push: {
      value(...items) {
        for (const it of items) this[this.length++] = it;
        return this.length;
      },
    },
    includes: {
      value(x) { return this.indexOf(x) >= 0; },
    },
    indexOf: {
      value(x) {
        for (let i = 0; i < this.length; i++) if (this[i] === x) return i;
        return -1;
      },
    },
    filter: {
      value(fn) {
        const out = makeNodeList('HTMLCollection');
        for (let i = 0; i < this.length; i++) if (fn(this[i], i, this)) out.push(this[i]);
        return out;
      },
    },
    forEach: {
      value(fn, thisArg) {
        for (let i = 0; i < this.length; i++) fn.call(thisArg, this[i], i, this);
      },
    },
    _splice: {
      value(start, del, ...ins) {
        const a = Array.from({ length: this.length }, (_, i) => this[i]);
        const r = a.splice(start, del, ...ins);
        for (let i = 0; i < this.length; i++) delete this[i];
        this.length = 0;
        this.push(...a);
        return r;
      },
    },
  });
  if (initial && initial.length) list.push(...initial);
  return list;
}

class DOMElement {
  constructor(tagName, env, opts = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.ownerDocument = env.document;
    this.parentNode = null;
    this.childNodes = makeNodeList('NodeList');
    this.attributes = Object.create(null);
    this.dataset = {};
    this.style = makeStyle();
    this.classList = makeClassList(this);
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.innerText = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.src = opts.src || '';
    this.href = opts.href || '';
    this.type = opts.type || '';
    this.async = false;
    this.defer = false;
    this.crossOrigin = null;
    this.referrerPolicy = '';
    this.integrity = '';
    this.nonce = '';
    this.readyState = 'complete';
    this._listeners = Object.create(null);
    this._env = env;
    this._isScript = this.tagName === 'SCRIPT';
    this._isCanvas = this.tagName === 'CANVAS';
    this._isImage = this.tagName === 'IMG';
    this._isVideo = this.tagName === 'VIDEO';
    this._isAudio = this.tagName === 'AUDIO';
    this._isInput = this.tagName === 'INPUT';
    this._isTextarea = this.tagName === 'TEXTAREA';
    if (this._isCanvas) {
      this.width = 300;
      this.height = 150;
    }
    if (this._isImage) {
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.complete = true;
    }
    if (this._isVideo || this._isAudio) {
      this.duration = 0;
      this.paused = true;
      this.readyState = 0;
      this.videoWidth = 0;
      this.videoHeight = 0;
    }
    if (this.tagName === 'A' && env.sandbox && env.sandbox.HTMLAnchorElement) {
      Object.setPrototypeOf(this, env.sandbox.HTMLAnchorElement.prototype);
    }
    if ((this._isVideo || this._isAudio) && env.sandbox && env.sandbox.HTMLMediaElement) {
      Object.setPrototypeOf(this, env.sandbox.HTMLMediaElement.prototype);
    }
    if (this.tagName === 'IFRAME' || this.tagName === 'FRAME') {
      const childLocation = {
        href: 'about:blank',
        origin: 'null',
        protocol: 'about:',
        host: '',
        hostname: '',
        port: '',
        pathname: 'blank',
        search: '',
        hash: '',
        ancestorOrigins: makeNodeList('DOMStringList'),
        assign() {}, replace() {}, reload() {}, toString() { return this.href; },
      };
      const childDocument = Object.create(env.document);
      const childWindow = {
        location: childLocation,
        document: childDocument,
        history: env.sandbox.history,
        name: '',
        closed: false,
        frameElement: this,
        length: 0,
        origin: 'null',
        isSecureContext: true,
        innerWidth: 1280,
        innerHeight: 900,
        devicePixelRatio: 1,
        navigator: env.navigator,
        screen: env.sandbox.screen,
        performance: env.sandbox.performance,
        trustedTypes: env.sandbox.trustedTypes,
        chrome: env.sandbox.chrome,
        OAuthConsent: {},
        fence: null,
        setTimeout, clearTimeout, setInterval, clearInterval,
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        postMessage() {}, focus() {}, blur() {}, close() {},
        alert() {}, confirm() { return false; }, prompt() { return null; },
        getComputedStyle: env.sandbox.getComputedStyle,
        matchMedia: env.sandbox.matchMedia,
        requestAnimationFrame: env.sandbox.requestAnimationFrame,
        cancelAnimationFrame: env.sandbox.cancelAnimationFrame,
        eval: (code) => env.runInContext ? env.runInContext(String(code), 'iframe-eval.js') : (0, eval)(code),
        Function: Function,
        Object, Array, String, Number, Boolean, BigInt, Symbol,
        Date, Math, JSON, Promise, RegExp,
        Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
        AggregateError: globalThis.AggregateError, SuppressedError: globalThis.SuppressedError,
        Map, Set, WeakMap, WeakSet, WeakRef, FinalizationRegistry,
        ArrayBuffer, SharedArrayBuffer, DataView, Atomics,
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float16Array: globalThis.Float16Array, Float32Array, Float64Array,
        BigInt64Array, BigUint64Array,
        Reflect, Proxy, Intl, WebAssembly,
        TextEncoder: (env.sandbox && env.sandbox.TextEncoder) || TextEncoder,
        TextDecoder: (env.sandbox && env.sandbox.TextDecoder) || TextDecoder,
        Iterator: globalThis.Iterator, Temporal: globalThis.Temporal,
        DisposableStack: globalThis.DisposableStack, AsyncDisposableStack: globalThis.AsyncDisposableStack,
        parseInt, parseFloat, isNaN, isFinite,
        encodeURI, decodeURI, encodeURIComponent, decodeURIComponent,
        escape: globalThis.escape, unescape: globalThis.unescape,
        NaN, Infinity, undefined,
        RTCStatsReport: env.sandbox.RTCStatsReport,
        XRProjectionLayer: env.sandbox.XRProjectionLayer,
        PageTransitionEvent: env.sandbox.PageTransitionEvent,
        DOMMatrixReadOnly: env.sandbox.DOMMatrixReadOnly,
        SVGTextContentElement: env.sandbox.SVGTextContentElement,
        Navigation: env.sandbox.Navigation,
        MouseEvent: env.sandbox.MouseEvent,
        MIDIMessageEvent: env.sandbox.MIDIMessageEvent,
        MediaKeySession: env.sandbox.MediaKeySession,
        SharedStorageWorklet: env.sandbox.SharedStorageWorklet,
        ProtectedAudience: env.sandbox.ProtectedAudience,
        Permissions: env.sandbox.Permissions,
        Navigator: env.sandbox.Navigator,
        HTMLMediaElement: env.sandbox.HTMLMediaElement,
        HTMLAnchorElement: env.sandbox.HTMLAnchorElement,
        HTMLIFrameElement: env.sandbox.HTMLIFrameElement,
        top: env.sandbox,
        parent: env.sandbox,
        self: null,
        window: null,
        frames: null,
        opener: null,
        __child: true,
      };
      Object.defineProperty(childDocument, 'defaultView', {
        get: makeNativeGetter('defaultView', () => childWindow),
        enumerable: true,
        configurable: true,
      });
      if (env.runInContext) {
        try {
          if (!env._vmBuiltins) {
            env._vmBuiltins = env.runInContext('({ Function, Object, Array, String, Number, Boolean, BigInt, Symbol, Date, Math, JSON, Promise, RegExp, Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, Map, Set, WeakMap, WeakSet, WeakRef, FinalizationRegistry, ArrayBuffer, SharedArrayBuffer, DataView, Atomics, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, Reflect, Proxy, Intl, WebAssembly })');
          }
          Object.assign(childWindow, env._vmBuiltins);
        } catch {}
      }
      childWindow.self = childWindow;
      childWindow.window = childWindow;
      childWindow.frames = childWindow;
      childWindow.globalThis = childWindow;
      if (env.sandbox && env.sandbox.__chromeWinSchema) {
        for (const [k, v] of Object.entries(env.sandbox.__chromeWinSchema)) {
          if (!(k in childWindow)) childWindow[k] = v;
        }
      }
      childWindow.fence = null;
      this._childWindow = childWindow;
      this._childDocument = childDocument;
      if (env.sandbox && env.sandbox.HTMLIFrameElement) {
        Object.setPrototypeOf(this, env.sandbox.HTMLIFrameElement.prototype);
      }
    }
  }

  set src(v) {
    this._src = String(v);
    if ((this.tagName === 'IFRAME' || this.tagName === 'FRAME') && this._childWindow) {
      try {
        const u = new URL(this._src, this._env.url);
        this._childWindow.location.href = u.href;
        this._childWindow.location.origin = u.origin;
        this._childWindow.location.protocol = u.protocol;
      } catch {
        this._childWindow.location.href = this._src;
      }
    }
  }
  get src() { return this._src || ''; }
  get contentWindow() {
    if (this.tagName === 'IFRAME' || this.tagName === 'FRAME') {
      return this.parentNode ? (this._childWindow || null) : null;
    }
    return undefined;
  }
  get contentDocument() {
    if (this.tagName === 'IFRAME' || this.tagName === 'FRAME') {
      return this.parentNode ? (this._childDocument || null) : null;
    }
    return undefined;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get offsetWidth() { return 0; }
  get offsetHeight() {
    if (this.tagName === 'DIV' && this.style && this.style.width === '5ch' && this.textContent && this.textContent.length > 5) {
      const h = this.style.hyphens || this.style.webkitHyphens || '';
      return h === 'auto' ? 140 : 20;
    }
    return 0;
  }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  get scrollWidth() { return 0; }
  get scrollHeight() { return 0; }
  get scrollTop() { return 0; }
  set scrollTop(_) {}
  get scrollLeft() { return 0; }
  set scrollLeft(_) {}
  get isConnected() { return true; }
  get shadowRoot() { return null; }

  setAttribute(name, value) {
    if (!this.attributes) this.attributes = Object.create(null);
    const k = String(name).toLowerCase();
    this.attributes[k] = String(value);
    if (k === 'src') this.src = String(value);
    if (k === 'href') this.href = String(value);
    if (k === 'id') this.id = String(value);
    if (k === 'class') { this.className = String(value); value = String(value); }
    if (k === 'type') this.type = String(value);
    if (k === 'style') this.style.cssText = String(value);
  }
  getAttribute(name) {
    if (!this.attributes) return null;
    const k = String(name).toLowerCase();
    if (k === 'class') return this.className || null;
    return this.attributes[k] !== undefined ? this.attributes[k] : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { if (this.attributes) delete this.attributes[String(name).toLowerCase()]; }

  get parentElement() {
    return (this.parentNode && this.parentNode.nodeType === 1) ? this.parentNode : null;
  }
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    if (!this.childNodes.includes(child)) {
      this.childNodes.push(child);
    }
    if (this._isScript) return child;
    if (this.tagName === 'HEAD' || this.tagName === 'HTML') {
      this._env.host.loadScriptElement(child, this);
    } else if (child.tagName === 'IFRAME' || child.tagName === 'FRAME') {
      this._env.scheduleIframeLoad?.(child);
    }
    return child;
  }
  insertBefore(child, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(child);
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes._splice(i, 0, child);
    if (this.tagName === 'HEAD' || this.tagName === 'HTML') return this._env.host.loadScriptElement(child, this);
    if (child.tagName === 'IFRAME' || child.tagName === 'FRAME') this._env.scheduleIframeLoad?.(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes._splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(newNode, oldNode) {
    const i = this.childNodes.indexOf(oldNode);
    if (i >= 0) { this.childNodes[i] = newNode; newNode.parentNode = this; oldNode.parentNode = null; }
    return oldNode;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(el) {
    let cur = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  cloneNode() { return new DOMElement(this.tagName, this._env); }

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
  dispatchEvent(event) {
    const type = event && event.type;
    if (!type) return true;
    const handlers = [...(this._listeners[type] || [])];
    if (typeof this['on' + type] === 'function') handlers.unshift(this['on' + type]);
    for (const h of handlers) {
      try { h.call(this, event); } catch (e) { this._env.log('warn', `DOM listener ${type} threw: ${e && e.message}`); }
    }
    return true;
  }

  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  getElementsByClassName() { return []; }
  getBoundingClientRect() {
    if (this.tagName === 'BODY' || this.tagName === 'HTML') {
      return { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 900, width: 1280, height: 900 };
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  getClientRects() { return []; }
  scrollIntoView() {}
  focus() {}
  blur() {}
  click() {
    this.dispatchEvent({
      type: 'click',
      target: this,
      currentTarget: this,
      isTrusted: false,
      bubbles: true,
      cancelable: true,
      timeStamp: nowMs(),
      clientX: 0,
      clientY: 0,
      screenX: 0,
      screenY: 0,
      button: 0,
      buttons: 0,
      preventDefault() {},
      stopPropagation() {},
    });
  }
  checkVisibility() { return true; }
  setPointerCapture() {}
  releasePointerCapture() {}
  animate() { return { cancel() {}, finish() {}, play() {}, pause() {} }; }

  // ---- canvas ---------------------------------------------------------
  getContext(kind) {
    if (!this._isCanvas) return null;
    if (this._context) return this._context;
    const env = this._env;
    const glExt = {
      UNMASKED_VENDOR_WEBGL: 0x9245,
      UNMASKED_RENDERER_WEBGL: 0x9246,
    };
    const ctx = {
      canvas: this,
      drawingBufferWidth: this.width,
      drawingBufferHeight: this.height,
      getParameter(p) {
        switch (p) {
          case 0x1F00: return 'WebKit';
          case 0x1F01: return 'WebKit WebGL';
          case 0x1F02: return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
          case 0x1F03: return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
          case 0x0D33: return 8192;
          case 0x0D3A: return new Int32Array([8192, 8192]);
          case 0x9245: return 'Google Inc. (Google)';
          case 0x9246: return 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
          case 0x8B8C: return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
          default: return 0;
        }
      },
      getExtension(name) {
        if (String(name) === 'WEBGL_debug_renderer_info') return glExt;
        if (String(name) === 'EXT_texture_filter_anisotropic') return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF };
        if (String(name) === 'WEBGL_lose_context') return { loseContext() {}, restoreContext() {} };
        return { loseContext() {}, restoreContext() {} };
      },
      getSupportedExtensions() {
        return ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_texture_filter_anisotropic',
          'WEBGL_debug_renderer_info', 'WEBGL_lose_context', 'OES_texture_float', 'OES_standard_derivatives'];
      },
      getShaderPrecisionFormat() { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
      getContextAttributes() { return { alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true }; },
      isContextLost() { return false; },
      readPixels() {},
      getError() { return 0; },
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(Math.max(1, w * h * 4));
        return { data, width: w, height: h };
      },
      createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
      measureText(text) { return { width: String(text).length * 7.2, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; },
      toDataURL() { return PNG_1X1; },
      fillText() {}, strokeText() {}, fillRect() {}, clearRect() {}, drawImage() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {},
      createLinearGradient() { return { addColorStop() {} }; },
      createRadialGradient() { return { addColorStop() {} }; },
      createPattern() { return {}; },
      putImageData() {},
    };
    for (const name of ['createBuffer', 'createFramebuffer', 'createProgram', 'createRenderbuffer',
      'createShader', 'createTexture', 'deleteBuffer', 'deleteFramebuffer', 'deleteProgram',
      'deleteRenderbuffer', 'deleteShader', 'deleteTexture', 'bindBuffer', 'bindFramebuffer',
      'bindRenderbuffer', 'bindTexture', 'bufferData', 'shaderSource', 'compileShader', 'attachShader',
      'linkProgram', 'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer', 'drawArrays',
      'drawElements', 'viewport', 'clearColor', 'clear', 'disable', 'enable', 'blendFunc', 'depthFunc',
      'cullFace', 'texImage2D', 'texParameteri', 'framebufferTexture2D', 'renderbufferStorage',
      'framebufferRenderbuffer', 'pixelStorei', 'finish', 'flush']) {
      if (!ctx[name]) ctx[name] = () => ({});
    }
    ctx.getShaderParameter = () => true;
    ctx.getProgramParameter = () => true;
    ctx.getShaderInfoLog = () => '';
    ctx.getProgramInfoLog = () => '';
    ctx.getAttribLocation = () => 0;
    ctx.getUniformLocation = () => ({});
    ctx.checkFramebufferStatus = () => 36053;
    ctx.getActiveAttrib = () => ({ name: 'a', size: 1, type: 5126 });
    ctx.getActiveUniform = () => ({ name: 'u', size: 1, type: 5126 });
    ctx.uniform1f = ctx.uniform1i = ctx.uniform2f = ctx.uniform3f = ctx.uniform4f = ctx.uniformMatrix4fv = () => {};
    this._context = ctx;
    return ctx;
  }
  toDataURL() { return PNG_1X1; }
  getContext2D() { return this.getContext('2d'); }

  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  canPlayType() { return ''; }
}

if (CHROME_SCHEMA) {
  const sampleEl = new DOMElement('DIV', {});
  const domTypes = { ...(CHROME_SCHEMA.divTypes || {}), ...(CHROME_SCHEMA.imgTypes || {}) };
  const nonNullElObjects = new Set(['attributeStyleMap', 'focusGroup', 'part', 'customElementRegistry']);
  for (const [k, t] of Object.entries(domTypes)) {
    if (k in sampleEl || k in DOMElement.prototype) continue;
    if (t === 'function') DOMElement.prototype[k] = function () {};
    else if (t === 'number') DOMElement.prototype[k] = 0;
    else if (t === 'string') DOMElement.prototype[k] = '';
    else if (t === 'boolean') DOMElement.prototype[k] = false;
    else if (t === 'object') DOMElement.prototype[k] = nonNullElObjects.has(k) ? {} : null;
  }
}

class CanvasElement extends DOMElement {}

function makeUserAgentData(env) {
  const major = String(env.chromeVersion || '151').split('.')[0];
  const isNewMajor = Number(major) >= 155;
  const greaseBrand = isNewMajor ? 'Not(A:Brand' : 'Not=A?Brand';
  const greaseVersion = isNewMajor ? '24' : '99';
  const brands = [
    { brand: greaseBrand, version: greaseVersion },
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
  ];
  const fullVersionList = [
    { brand: greaseBrand, version: `${greaseVersion}.0.0.0` },
    { brand: 'Google Chrome', version: env.chromeVersion },
    { brand: 'Chromium', version: env.chromeVersion },
  ];
  const isLinux = String(env.platform || '').startsWith('Linux') || String(env.userAgent || '').includes('Linux');
  const uaPlatform = isLinux ? 'Linux' : 'Windows';
  const uaPlatformVersion = isLinux ? '' : (env.platformVersion || '19.0.0');
  return {
    brands,
    mobile: false,
    platform: uaPlatform,
    getHighEntropyValues: async (hints = []) => {
      const all = {
        architecture: 'x86',
        bitness: '64',
        brands,
        formFactors: ['Desktop'],
        fullVersionList,
        mobile: false,
        model: '',
        platform: uaPlatform,
        platformVersion: uaPlatformVersion,
        uaFullVersion: env.chromeVersion,
        wow64: false,
      };
      const out = {};
      const wanted = Array.isArray(hints) && hints.length ? hints : Object.keys(all);
      for (const h of wanted) if (h in all) out[h] = all[h];
      return out;
    },
    toJSON() { return { brands, mobile: false, platform: uaPlatform }; },
  };
}

function makeNavigator(env) {
  const plugins = makeNodeList('PluginArray', [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
  ]);
  const mimeTypes = makeNodeList('MimeTypeArray', [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
  ]);
  return {
    userAgent: env.userAgent,
    appName: 'Netscape',
    appVersion: env.userAgent.replace('Mozilla/', ''),
    appCodeName: 'Mozilla',
    product: 'Gecko',
    productSub: '20030107',
    vendor: 'Google Inc.',
    vendorSub: '',
    platform: env.platform || 'Win32',
    language: env.language || 'zh-CN',
    languages: env.languages || ['zh-CN', 'zh', 'en-US', 'en', 'en-GB'],
    onLine: true,
    cookieEnabled: true,
    doNotTrack: null,
    webdriver: false,
    hardwareConcurrency: env.hardwareConcurrency ?? 8,
    deviceMemory: env.deviceMemory ?? 8,
    maxTouchPoints: env.maxTouchPoints ?? 0,
    pdfViewerEnabled: true,
    plugins,
    mimeTypes,
    userAgentData: makeUserAgentData(env),
    connection: {
      effectiveType: (env.connection && env.connection.effectiveType) || '4g',
      rtt: env.connection && env.connection.rtt != null ? env.connection.rtt : 50,
      downlink: env.connection && env.connection.downlink != null ? env.connection.downlink : 10,
      saveData: !!(env.connection && env.connection.saveData),
      onchange: null, addEventListener() {}, removeEventListener() {},
    },
    gpu: env.gpu === false ? undefined : {
      requestAdapter: async () => null,
      getPreferredCanvasFormat: () => 'bgra8unorm',
      wgslLanguageFeatures: new Set(),
    },
    userActivation: env.userActivation === false ? undefined : {
      isActive: true,
      hasBeenActive: true,
    },
    permissions: {
      query: async () => ({ state: 'granted', onchange: null, addEventListener() {}, removeEventListener() {} }),
    },
    mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => { throw new Error('NotAllowedError'); } },
    getBattery: async () => ({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 }),
    sendBeacon: () => true,
    javaEnabled: () => false,
    requestMIDIAccess: async () => ({ inputs: new Map(), outputs: new Map() }),
    clearAppBadge: async () => {},
    setAppBadge: async () => {},
  };
}

function createBrowserEnv(options = {}) {
  const env = {
    options,
    userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    chromeVersion: options.chromeVersion || '151.0.7922.137',
    platform: options.platform || 'Win32',
    platformVersion: options.platformVersion || '19.0.0',
    language: options.language || 'zh-CN',
    languages: options.languages || ['zh-CN', 'zh', 'en-US', 'en', 'en-GB'],
    acceptLanguage: options.acceptLanguage || 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6',
    omitExtraHeaders: !!options.omitExtraHeaders,
    hardwareConcurrency: options.hardwareConcurrency ?? 8,
    deviceMemory: options.deviceMemory ?? 8,
    maxTouchPoints: options.maxTouchPoints ?? 0,
    connection: options.connection || null,
    gpu: options.gpu,
    userActivation: options.userActivation,
    memory: options.memory || null,
    navEntryCount: options.navEntryCount ?? 1,
    resourceEntryCount: options.resourceEntryCount ?? 0,
    screenWidth: options.screenWidth || 1920,
    screenHeight: options.screenHeight || 1080,
    innerWidth: options.innerWidth || 1280,
    innerHeight: options.innerHeight || 900,
    outerWidth: options.outerWidth || 1280,
    outerHeight: options.outerHeight || 900,
    devicePixelRatio: options.devicePixelRatio || 1,
    origin: options.origin || 'https://aistudio.google.com',
    url: options.pageUrl || options.origin,
    cookieString: options.cookies || '',
    documentCookie: '',
    cookieJar: new Map(),
    log: options.log || (() => {}),
    requests: [],
    scripts: [],
    errors: [],
    programCacheDir: options.programCacheDir || '',
    challengeCache: options.challengeCache || '',
    saveChallengePath: options.saveChallengePath || '',
    saveProgram: options.saveProgram !== false,
    host: null,
    sandbox: null,
    document: null,
    location: null,
    navigator: null,
  };

  // Parse an initial cookie string into a jar (HttpOnly cookies are passed as
  // headers anyway; the jar is only used for document.cookie / SAPISIDHASH).
  for (const part of String(env.cookieString).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) env.cookieJar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  env.documentCookie = computeDocumentCookie(env.cookieString);

  const sandbox = {};
  env.sandbox = sandbox;

  // ---- timers ---------------------------------------------------------
  let timerSeq = 1;
  const timers = new Map();
  const setTimer = (fn, ms, ...args) => {
    const id = timerSeq++;
    const t = setTimeout(() => {
      timers.delete(id);
      try { if (typeof fn === 'function') fn(...args); else if (typeof fn === 'string') sandbox.eval?.(fn); }
      catch (e) { env.log('warn', `timer callback threw: ${e && (e.stack || e.message)}`); }
    }, Math.max(0, Number(ms) || 0));
    timers.set(id, t);
    return id;
  };
  const clearTimer = (id) => {
    const t = timers.get(id);
    if (t) { clearTimeout(t); timers.delete(id); }
  };
  sandbox.setTimeout = setTimer;
  sandbox.clearTimeout = clearTimer;
  sandbox.setInterval = (fn, ms, ...args) => {
    const id = timerSeq++;
    const t = setInterval(() => {
      try { if (typeof fn === 'function') fn(...args); } catch (e) { env.log('warn', `interval threw: ${e && e.message}`); }
    }, Math.max(1, Number(ms) || 1));
    timers.set(id, t);
    return id;
  };
  sandbox.clearInterval = clearTimer;
  sandbox.setImmediate = (fn, ...args) => setTimer(fn, 0, ...args);
  sandbox.clearImmediate = clearTimer;
  sandbox.queueMicrotask = (fn) => queueMicrotask(fn);
  sandbox.requestAnimationFrame = (fn) => setTimer(() => fn(nowMs()), 16);
  sandbox.cancelAnimationFrame = clearTimer;
  sandbox.requestIdleCallback = (fn) => setTimer(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);
  sandbox.cancelIdleCallback = clearTimer;

  // ---- core host APIs -------------------------------------------------
  const g = globalThis;
  sandbox.console = {
    log: (...a) => env.log('debug', a.map(stringifyArg).join(' ')),
    info: (...a) => env.log('debug', a.map(stringifyArg).join(' ')),
    warn: (...a) => env.log('warn', a.map(stringifyArg).join(' ')),
    error: (...a) => env.log('error', a.map(stringifyArg).join(' ')),
    debug: (...a) => env.log('trace', a.map(stringifyArg).join(' ')),
    trace: (...a) => env.log('trace', a.map(stringifyArg).join(' ')),
    dir: (...a) => env.log('debug', a.map(stringifyArg).join(' ')),
    group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
    time: () => {}, timeEnd: () => {}, count: () => {}, assert: () => {},
    table: () => {}, clear: () => {},
  };
  sandbox.atob = binaryAtob;
  sandbox.btoa = binaryBtoa;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.Headers = Headers;
  sandbox.Request = Request;
  sandbox.Response = Response;
  sandbox.FormData = FormData;
  sandbox.Blob = Blob;
  sandbox.File = File;
  sandbox.URLPattern = g.URLPattern;
  sandbox.ReadableStream = ReadableStream;
  sandbox.WritableStream = WritableStream;
  sandbox.TransformStream = TransformStream;
  sandbox.ByteLengthQueuingStrategy = g.ByteLengthQueuingStrategy;
  sandbox.CountQueuingStrategy = g.CountQueuingStrategy;
  sandbox.CompressionStream = g.CompressionStream;
  sandbox.DecompressionStream = g.DecompressionStream;
  sandbox.AbortController = AbortController;
  sandbox.AbortSignal = AbortSignal;
  sandbox.DOMException = DOMException;
  sandbox.Event = Event;
  sandbox.EventTarget = EventTarget;
  sandbox.CustomEvent = g.CustomEvent || class CustomEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
  };
  sandbox.MessageEvent = g.MessageEvent || class MessageEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.data = init.data; this.origin = init.origin || ''; this.ports = init.ports || []; }
  };
  sandbox.ErrorEvent = g.ErrorEvent || class ErrorEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.message = init.message || ''; this.filename = init.filename || ''; this.lineno = init.lineno || 0; }
  };
  sandbox.ProgressEvent = g.ProgressEvent || class ProgressEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.lengthComputable = !!init.lengthComputable; this.loaded = init.loaded || 0; this.total = init.total || 0; }
  };
  sandbox.MessageChannel = g.MessageChannel;
  sandbox.MessagePort = g.MessagePort;
  sandbox.BroadcastChannel = g.BroadcastChannel || class BroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; }
    postMessage() {} close() {} addEventListener() {} removeEventListener() {}
  };
  sandbox.Worker = class Worker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage() {} terminate() {} addEventListener() {} removeEventListener() {}
  };
  sandbox.SharedWorker = class SharedWorker { constructor() { this.port = { start() {}, postMessage() {}, onmessage: null }; } };
  sandbox.ServiceWorker = class ServiceWorker {};
  sandbox.WebSocket = g.WebSocket;
  sandbox.EventSource = class EventSource {
    constructor() { this.readyState = 0; }
    close() {} addEventListener() {} removeEventListener() {}
  };
  sandbox.XMLHttpRequest = createXHRClass(env);
  sandbox.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url);
    env.log('debug', `fetch ${String(url).slice(0, 180)}`);
    return g.fetch(input, init);
  };
  sandbox.crypto = g.crypto;
  const basePerf = performance;
  const navEntries = Array.from({ length: env.navEntryCount }, (_, i) => ({
    name: i === 0 ? env.url : '', entryType: 'navigation',
    startTime: 0, duration: 120 + i, initiatorType: 'navigation', transferSize: 0,
    domainLookupStart: 85.9, domainLookupEnd: 605.2,
    connectStart: 605.2, secureConnectionStart: 690.1, connectEnd: 801.3,
    requestStart: 802.0, responseStart: 1120.5, responseEnd: 1165.0,
    domInteractive: 1450.0, domContentLoadedEventStart: 1455.0, domContentLoadedEventEnd: 1460.0,
    domComplete: 2100.0, loadEventStart: 2101.0, loadEventEnd: 2105.0,
  }));
  const resEntries = Array.from({ length: env.resourceEntryCount }, (_, i) => ({
    name: `${new URL(env.url).origin}/resource-${i}.js`, entryType: 'resource',
    startTime: i, duration: 1 + (i % 20), initiatorType: 'script', transferSize: 1000 + i,
  }));
  const defaultMemory = {
    jsHeapSizeLimit: 2172649472,
    totalJSHeapSize: 97358573,
    usedJSHeapSize: 79488825,
  };
  const markEntries = [];
  sandbox.performance = {
    now: () => basePerf.now(),
    timeOrigin: basePerf.timeOrigin,
    mark: (...a) => {
      const m = { name: String(a[0] || ''), entryType: 'mark', startTime: basePerf.now(), duration: 0 };
      markEntries.push(m);
      return m;
    },
    measure: (...a) => basePerf.measure(...a),
    clearMarks: (n) => {
      if (!n) markEntries.length = 0;
      else for (let i = markEntries.length - 1; i >= 0; i--) if (markEntries[i].name === n) markEntries.splice(i, 1);
    },
    clearMeasures: (...a) => basePerf.clearMeasures(...a),
    getEntries: () => [...navEntries, ...resEntries, ...markEntries],
    getEntriesByType: (t) => (t === 'navigation' ? navEntries.slice() : t === 'resource' ? resEntries.slice() : t === 'mark' ? markEntries.slice() : []),
    getEntriesByName: (n, t) => [...navEntries, ...resEntries, ...markEntries].filter((e) => e.name === n && (!t || e.entryType === t)),
    memory: env.memory !== false ? (env.memory || defaultMemory) : undefined,
    timing: {},
    navigation: {},
    eventCounts: {},
    toJSON: () => ({ timeOrigin: basePerf.timeOrigin }),
  };
  sandbox.structuredClone = g.structuredClone;
  sandbox.reportError = (e) => env.log('error', `reportError: ${e && (e.stack || e.message || e)}`);
  sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat;
  sandbox.isNaN = isNaN;
  sandbox.isFinite = isFinite;
  sandbox.encodeURIComponent = encodeURIComponent;
  sandbox.decodeURIComponent = decodeURIComponent;
  sandbox.encodeURI = encodeURI;
  sandbox.decodeURI = decodeURI;
  sandbox.escape = g.escape;
  sandbox.unescape = g.unescape;
  sandbox.AggregateError = g.AggregateError;
  sandbox.SuppressedError = g.SuppressedError;
  sandbox.FinalizationRegistry = g.FinalizationRegistry;
  sandbox.WeakRef = g.WeakRef;
  sandbox.BigInt = g.BigInt;
  sandbox.WebAssembly = g.WebAssembly;
  sandbox.Atomics = g.Atomics;
  sandbox.SharedArrayBuffer = g.SharedArrayBuffer;
  sandbox.queueMicrotask = g.queueMicrotask;
  sandbox.Image = class Image extends DOMElement {
    constructor(w, h) { super('IMG', env); this.width = w || 0; this.height = h || 0; }
  };
  sandbox.ImageBitmap = g.ImageBitmap || class ImageBitmap {};
  sandbox.OffscreenCanvas = g.OffscreenCanvas || class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return new CanvasElement('CANVAS', env).getContext('2d'); }
  };
  sandbox.Path2D = g.Path2D || class Path2D {};
  sandbox.AudioContext = g.AudioContext || class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; }
    createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  sandbox.RTCPeerConnection = g.RTCPeerConnection || class RTCPeerConnection {
    constructor() { this.localDescription = null; }
    createDataChannel() { return { close() {}, send() {} }; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    setLocalDescription() { return Promise.resolve(); }
    close() {}
  };
  sandbox.Notification = class Notification {
    static permission = 'denied';
    static requestPermission() { return Promise.resolve('denied'); }
    constructor() { this.onclick = null; }
    close() {}
  };
  sandbox.FileReader = class FileReader {
    constructor() { this.result = null; this.onload = null; this.onerror = null; this.readyState = 0; }
    readAsDataURL(blob) {
      Promise.resolve().then(async () => {
        const buf = Buffer.from(await blob.arrayBuffer());
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${buf.toString('base64')}`;
        this.readyState = 2;
        if (this.onload) this.onload({ target: this });
      });
    }
    readAsText(blob) {
      Promise.resolve().then(async () => { this.result = await blob.text(); this.readyState = 2; if (this.onload) this.onload({ target: this }); });
    }
    readAsArrayBuffer(blob) {
      Promise.resolve().then(async () => { this.result = await blob.arrayBuffer(); this.readyState = 2; if (this.onload) this.onload({ target: this }); });
    }
    abort() {}
  };
  sandbox.Storage = class Storage {};
  sandbox.localStorage = makeStorage(env);
  sandbox.sessionStorage = makeStorage(env);
  sandbox.indexedDB = makeIDB(env);
  sandbox.caches = { open: async () => ({ match: async () => undefined, put: async () => {}, addAll: async () => {} }), keys: async () => [], delete: async () => false };
  sandbox.trustedTypes = {
    createPolicy: (name, rules = {}) => ({
      name,
      createHTML: (s) => (rules.createHTML ? rules.createHTML(s) : String(s)),
      createScript: (s) => (rules.createScript ? rules.createScript(s) : String(s)),
      createScriptURL: (s) => (rules.createScriptURL ? rules.createScriptURL(s) : String(s)),
      createURL: (s) => (rules.createURL ? rules.createURL(s) : String(s)),
    }),
    getPolicyNames: () => [],
    emptyHTML: '',
    emptyScript: '',
    defaultPolicy: null,
  };
  sandbox.chrome = {
    loadTimes: () => ({ requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }),
    csi: () => ({ onloadT: Date.now(), startE: Date.now(), pageT: nowMs() + 0.147, tran: 15 }),
    app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails: () => null, getIsInstalled: () => false, installState: () => 'not_installed', runningState: () => 'cannot_run' },
  };
  sandbox.external = { AddSearchProvider() {}, IsSearchProviderInstalled() { return 0; } };
  sandbox.screen = {
    width: env.screenWidth, height: env.screenHeight,
    availWidth: env.screenWidth, availHeight: env.screenHeight - 40,
    colorDepth: 24, pixelDepth: 24, availLeft: 0, availTop: 0,
    orientation: { type: 'landscape-primary', angle: 0, addEventListener() {}, removeEventListener() {} },
    isExtended: false,
  };
  sandbox.devicePixelRatio = env.devicePixelRatio;
  sandbox.innerWidth = env.innerWidth;
  sandbox.innerHeight = env.innerHeight;
  sandbox.outerWidth = env.outerWidth;
  sandbox.outerHeight = env.outerHeight;
  sandbox.screenX = 0;
  sandbox.screenY = 0;
  sandbox.scrollX = 0;
  sandbox.scrollY = 0;
  sandbox.pageXOffset = 0;
  sandbox.pageYOffset = 0;
  sandbox.name = '';
  sandbox.closed = false;
  sandbox.isSecureContext = true;
  sandbox.crossOriginIsolated = false;
  sandbox.opener = null;
  sandbox.length = 0;
  sandbox.origin = env.origin;
  sandbox.originAgentCluster = true;
  sandbox.clientInformation = null;
  sandbox.status = '';
  sandbox.statusbar = { visible: true };
  sandbox.locationbar = { visible: true };
  sandbox.menubar = { visible: true };
  sandbox.personalbar = { visible: true };
  sandbox.scrollbars = { visible: true };
  sandbox.toolbar = { visible: true };
  sandbox.history = {
    length: 2, state: null, scrollRestoration: 'auto',
    back() {}, forward() {}, go() {}, pushState(s) { this.state = s; }, replaceState(s) { this.state = s; },
  };

  // ---- Native-like DOM/WebIDL constructors for BotGuard probes --------
  const makeNativeGetter = (name, fn) => {
    Object.defineProperty(fn, 'name', { value: 'get ' + name });
    fn.toString = () => `function get ${name}() { [native code] }`;
    return fn;
  };
  const makeNativeSetter = (name, fn) => {
    Object.defineProperty(fn, 'name', { value: 'set ' + name });
    fn.toString = () => `function set ${name}() { [native code] }`;
    return fn;
  };
  const makeNativeMethod = (name, fn) => {
    Object.defineProperty(fn, 'name', { value: name });
    fn.toString = () => `function ${name}() { [native code] }`;
    return fn;
  };
  const makeProtoWithNames = (name, propNames) => {
    const fn = { [name]: function () {} }[name];
    fn.toString = () => `function ${name}() { [native code] }`;
    const proto = {};
    for (const k of propNames) {
      Object.defineProperty(proto, k, {
        value: k === 'constructor' ? fn : undefined,
        writable: true,
        enumerable: k !== 'constructor',
        configurable: true,
      });
    }
    fn.prototype = proto;
    return fn;
  };

  sandbox.RTCStatsReport = makeProtoWithNames('RTCStatsReport', ['entries', 'forEach', 'get', 'has', 'keys', 'values', 'size', 'constructor']);
  sandbox.XRProjectionLayer = makeProtoWithNames('XRProjectionLayer', ['textureWidth', 'textureHeight', 'textureArrayLength', 'ignoreDepthValues', 'fixedFoveation', 'deltaPose', 'constructor']);
  sandbox.PageTransitionEvent = makeProtoWithNames('PageTransitionEvent', ['persisted', 'constructor']);
  sandbox.DOMMatrixReadOnly = makeProtoWithNames('DOMMatrixReadOnly', ['a', 'b', 'c', 'd', 'e', 'f', 'm11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44', 'is2D', 'isIdentity', 'flipX', 'flipY', 'inverse', 'multiply', 'rotate', 'rotateAxisAngle', 'rotateFromVector', 'scale', 'scale3d', 'scaleNonUniform', 'skewX', 'skewY', 'toFloat32Array', 'toFloat64Array', 'toJSON', 'transformPoint', 'translate', 'constructor', 'toString']);
  sandbox.SVGTextContentElement = makeProtoWithNames('SVGTextContentElement', ['textLength', 'lengthAdjust', 'LENGTHADJUST_UNKNOWN', 'LENGTHADJUST_SPACING', 'LENGTHADJUST_SPACINGANDGLYPHS', 'getCharNumAtPosition', 'getComputedTextLength', 'getEndPositionOfChar', 'getExtentOfChar', 'getNumberOfChars', 'getRotationOfChar', 'getStartPositionOfChar', 'getSubStringLength', 'selectSubString', 'constructor']);
  sandbox.Navigation = makeProtoWithNames('Navigation', ['currentEntry', 'transition', 'activation', 'canGoBack', 'canGoForward', 'onnavigate', 'onnavigatesuccess', 'onnavigateerror', 'oncurrententrychange', 'back', 'entries', 'forward', 'navigate', 'reload', 'traverseTo', 'updateCurrentEntry', 'constructor']);
  sandbox.MouseEvent = makeProtoWithNames('MouseEvent', ['screenX', 'screenY', 'clientX', 'clientY', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY', 'fromElement', 'toElement', 'layerX', 'layerY', 'getModifierState', 'initMouseEvent', 'constructor']);
  sandbox.MIDIMessageEvent = makeProtoWithNames('MIDIMessageEvent', ['data', 'constructor']);
  sandbox.MediaKeySession = makeProtoWithNames('MediaKeySession', ['sessionId', 'expiration', 'closed', 'keyStatuses', 'onkeystatuseschange', 'onmessage', 'close', 'generateRequest', 'load', 'remove', 'update', 'constructor']);
  sandbox.SharedStorageWorklet = makeProtoWithNames('SharedStorageWorklet', ['addModule', 'constructor', 'run', 'selectURL']);
  sandbox.ProtectedAudience = makeProtoWithNames('ProtectedAudience', ['queryFeatureSupport', 'constructor']);
  sandbox.Permissions = makeProtoWithNames('Permissions', ['query', 'constructor']);

  const makeElementSubProto = (name, fallbackNames = ['constructor']) => {
    const propNames = (CHROME_SCHEMA && CHROME_SCHEMA.winProps && CHROME_SCHEMA.winProps[name] && CHROME_SCHEMA.winProps[name].proto) || fallbackNames;
    const fn = { [name]: function () {} }[name];
    fn.toString = () => `function ${name}() { [native code] }`;
    const proto = Object.create(DOMElement.prototype);
    for (const k of propNames) {
      const domDesc = Object.getOwnPropertyDescriptor(DOMElement.prototype, k);
      if (domDesc) {
        Object.defineProperty(proto, k, { ...domDesc, enumerable: k !== 'constructor', configurable: true });
      } else {
        Object.defineProperty(proto, k, {
          value: k === 'constructor' ? fn : undefined,
          writable: true,
          enumerable: k !== 'constructor',
          configurable: true,
        });
      }
    }
    fn.prototype = proto;
    return fn;
  };

  const applySchemaTypes = (target, typeMap) => {
    if (!target || !typeMap) return;
    for (const [k, t] of Object.entries(typeMap)) {
      if (k === 'constructor' || k in target) continue;
      let val = undefined;
      if (t === 'function') {
        val = { [k]: function () {} }[k];
        val.toString = () => `function ${k}() { [native code] }`;
      } else if (t === 'string') val = '';
      else if (t === 'number') val = 0;
      else if (t === 'boolean') val = false;
      else if (t === 'object') val = null;
      try {
        Object.defineProperty(target, k, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
  };

  const Navigator = (CHROME_SCHEMA && CHROME_SCHEMA.winProps && CHROME_SCHEMA.winProps.Navigator)
    ? makeProtoWithNames('Navigator', CHROME_SCHEMA.winProps.Navigator.proto)
    : function Navigator() {};
  Navigator.toString = () => 'function Navigator() { [native code] }';
  if (CHROME_SCHEMA && CHROME_SCHEMA.navTypes) {
    for (const [k, t] of Object.entries(CHROME_SCHEMA.navTypes)) {
      if (k === 'constructor' || k === 'plugins' || k === 'mimeTypes' || k === 'webdriver') continue;
      let val = undefined;
      if (t === 'function') {
        val = { [k]: function () {} }[k];
        val.toString = () => `function ${k}() { [native code] }`;
      } else if (t === 'string') val = '';
      else if (t === 'number') val = 0;
      else if (t === 'boolean') val = false;
      else if (t === 'object') val = k === 'doNotTrack' ? null : {};
      try {
        Object.defineProperty(Navigator.prototype, k, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
  }
  Object.defineProperty(Navigator.prototype, 'plugins', {
    get: makeNativeGetter('plugins', function () {
      if (!(this instanceof Navigator)) throw new TypeError('Illegal invocation');
      return this._plugins;
    }),
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, 'mimeTypes', {
    get: makeNativeGetter('mimeTypes', function () {
      if (!(this instanceof Navigator)) throw new TypeError('Illegal invocation');
      return this._mimeTypes;
    }),
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: makeNativeGetter('webdriver', function () {
      if (!(this instanceof Navigator)) throw new TypeError('Illegal invocation');
      return false;
    }),
    enumerable: true,
    configurable: true,
  });
  sandbox.Navigator = Navigator;

  const HTMLAnchorElement = makeElementSubProto('HTMLAnchorElement', ['hrefTranslate', 'constructor']);
  Object.defineProperty(HTMLAnchorElement.prototype, 'hrefTranslate', {
    get: makeNativeGetter('hrefTranslate', function () {
      if (!(this instanceof HTMLAnchorElement)) throw new TypeError('Illegal invocation');
      return this._hrefTranslate || '';
    }),
    set: makeNativeSetter('hrefTranslate', function (v) {
      if (!(this instanceof HTMLAnchorElement)) throw new TypeError('Illegal invocation');
      this._hrefTranslate = String(v);
    }),
    enumerable: true,
    configurable: true,
  });
  sandbox.HTMLAnchorElement = HTMLAnchorElement;

  const HTMLMediaElement = makeElementSubProto('HTMLMediaElement', ['canPlayType', 'constructor']);
  HTMLMediaElement.prototype.canPlayType = makeNativeMethod('canPlayType', function () {
    if (!(this instanceof HTMLMediaElement)) throw new TypeError('Illegal invocation');
    return 'maybe';
  });
  sandbox.HTMLMediaElement = HTMLMediaElement;

  const HTMLIFrameElement = makeElementSubProto('HTMLIFrameElement', ['srcdoc', 'contentWindow', 'contentDocument', 'constructor']);
  Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
    get: makeNativeGetter('srcdoc', function () {
      if (!(this instanceof HTMLIFrameElement)) throw new TypeError('Illegal invocation');
      return this._srcdoc || '';
    }),
    set: makeNativeSetter('srcdoc', function (v) {
      if (!(this instanceof HTMLIFrameElement)) throw new TypeError('Illegal invocation');
      this._srcdoc = String(v);
    }),
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: makeNativeGetter('contentWindow', function () {
      if (!(this instanceof HTMLIFrameElement)) throw new TypeError('Illegal invocation');
      return this.parentNode ? (this._childWindow || null) : null;
    }),
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    get: makeNativeGetter('contentDocument', function () {
      if (!(this instanceof HTMLIFrameElement)) throw new TypeError('Illegal invocation');
      return this.parentNode ? (this._childDocument || null) : null;
    }),
    enumerable: true,
    configurable: true,
  });
  sandbox.HTMLIFrameElement = HTMLIFrameElement;

  const navObj = makeNavigator(env);
  navObj._plugins = navObj.plugins;
  navObj._mimeTypes = navObj.mimeTypes;
  delete navObj.plugins;
  delete navObj.mimeTypes;
  delete navObj.webdriver;
  Object.setPrototypeOf(navObj, Navigator.prototype);
  sandbox.navigator = navObj;
  env.navigator = sandbox.navigator;

  // ---- window event plumbing -----------------------------------------
  let winListeners = Object.create(null);
  sandbox.addEventListener = (type, fn) => { if (typeof fn === 'function') (winListeners[type] || (winListeners[type] = [])).push(fn); };
  sandbox.removeEventListener = (type, fn) => {
    const a = winListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  sandbox.dispatchEvent = (ev) => {
    const type = ev && ev.type;
    for (const h of (winListeners[type] || [])) { try { h.call(sandbox, ev); } catch (e) { env.log('warn', `window listener ${type}: ${e.message}`); } }
    return true;
  };
  env.clearEventListeners = () => {
    winListeners = Object.create(null);
    if (env.document) {
      env.document._listeners = Object.create(null);
      if (env.document.body) {
        env.document.body._listeners = Object.create(null);
        env.document.body.childNodes.length = 0;
      }
      if (env.document.head) {
        env.document.head.childNodes.length = 0;
      }
      if (Array.isArray(env.document.scripts)) {
        env.document.scripts.length = 0;
      }
    }
  };
  sandbox.postMessage = (data, targetOrigin) => {
    const ev = { type: 'message', data, origin: String(targetOrigin || '*'), source: sandbox, ports: [] };
    setTimeout(() => sandbox.dispatchEvent(ev), 0);
  };
  sandbox.alert = (msg) => env.log('warn', `alert: ${msg}`);
  sandbox.confirm = () => false;
  sandbox.prompt = () => null;
  sandbox.open = () => null;
  sandbox.close = () => {};
  sandbox.focus = () => {};
  sandbox.blur = () => {};
  sandbox.print = () => {};
  sandbox.stop = () => {};
  sandbox.scrollTo = () => {};
  sandbox.scrollBy = () => {};
  sandbox.getSelection = () => ({
    rangeCount: 0, isCollapsed: true, type: 'None', anchorNode: null, focusNode: null,
    toString: () => '', removeAllRanges() {}, addRange() {}, getRangeAt() { return null; },
  });
  sandbox.matchMedia = (query) => {
    const q = String(query);
    const matches = q.includes('any-pointer:fine') || q.includes('pointer:fine') || q.includes('any-hover:hover') || q.includes('hover:hover');
    return {
      matches, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    };
  };
  sandbox.getComputedStyle = () => new Proxy({ getPropertyValue: () => '' }, {
    get(t, p) { return p in t ? t[p] : ''; },
  });
  sandbox.requestAnimationFrame = sandbox.requestAnimationFrame;
  sandbox.MutationObserver = class MutationObserver {
    constructor(cb) { this._cb = cb; }
    observe() {} disconnect() {} takeRecords() { return []; }
  };
  sandbox.IntersectionObserver = class IntersectionObserver {
    constructor(cb) { this._cb = cb; }
    observe(target) {
      if (typeof this._cb === 'function') {
        setTimer(() => {
          try {
            const rect = target && typeof target.getBoundingClientRect === 'function'
              ? target.getBoundingClientRect()
              : { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 900, width: 1280, height: 900 };
            this._cb([{
              time: nowMs(),
              isIntersecting: true,
              isVisible: true,
              intersectionRatio: 1,
              target,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: rect,
            }], this);
          } catch {}
        }, 1);
      }
    }
    unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  sandbox.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; }
    observe() {} unobserve() {} disconnect() {}
  };
  sandbox.PerformanceObserver = class PerformanceObserver {
    constructor(cb) { this._cb = cb; }
    observe() {} disconnect() {} takeRecords() { return []; }
  };
  sandbox.ReportingObserver = class ReportingObserver {
    constructor() {} observe() {} disconnect() {} takeRecords() { return []; }
  };

  sandbox.customElements = {
    define() {},
    get() { return undefined; },
    upgrade() {},
    whenDefined() { return Promise.resolve(); },
  };
  Object.defineProperty(sandbox, 'frameElement', {
    get: makeNativeGetter('frameElement', () => null),
    set: undefined,
    enumerable: true,
    configurable: true,
  });
  const schemaGlobals = getSchemaGlobalsForSandbox(makeProtoWithNames);
  if (schemaGlobals && CHROME_SCHEMA && CHROME_SCHEMA.winProps) {
    for (const [k, info] of Object.entries(CHROME_SCHEMA.winProps)) {
      if (JS_CORE_BUILTINS.has(k)) continue;
      const existing = sandbox[k];
      if (typeof existing === 'function' && existing.prototype && !(existing.prototype instanceof DOMElement) && Array.isArray(info.proto)) {
        for (const pk of info.proto) {
          if (!(pk in existing.prototype)) {
            try {
              Object.defineProperty(existing.prototype, pk, {
                value: pk === 'constructor' ? existing : undefined,
                writable: true,
                enumerable: pk !== 'constructor',
                configurable: true,
              });
            } catch {}
          }
        }
      }
      if (!(k in sandbox)) {
        sandbox[k] = schemaGlobals[k];
      }
    }
    Object.defineProperty(sandbox, '__chromeWinSchema', { value: schemaGlobals, enumerable: false, configurable: true });
  }

  // ---- location -------------------------------------------------------
  let current = new URL(env.url);
  const location = {
    get href() { return current.href; },
    set href(v) { try { current = new URL(String(v), current.href); } catch {} },
    get origin() { return current.origin; },
    get protocol() { return current.protocol; },
    get host() { return current.host; },
    get hostname() { return current.hostname; },
    get port() { return current.port; },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
    set hash(v) { current.hash = v; },
    ancestorOrigins: makeNodeList('DOMStringList'),
    assign(v) { this.href = v; },
    replace(v) { this.href = v; },
    reload() {},
    toString() { return current.href; },
  };
  sandbox.location = location;
  env.location = location;
  Object.defineProperty(sandbox, 'document', { value: null, writable: true, configurable: true });

  // ---- document -------------------------------------------------------
  const document = createDocument(env, location, current);
  if (CHROME_SCHEMA) {
    applySchemaTypes(document, CHROME_SCHEMA.docTypes);
    applySchemaTypes(sandbox.screen, CHROME_SCHEMA.screenTypes);
    applySchemaTypes(sandbox.performance, CHROME_SCHEMA.perfTypes);
    applySchemaTypes(sandbox.history, CHROME_SCHEMA.histTypes);
    applySchemaTypes(location, CHROME_SCHEMA.locTypes);
  }
  env.document = document;
  sandbox.document = document;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.frames = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.document.defaultView = sandbox;

  // SAPISID globals used by the bundle's auth generator (__SAPISID etc.)
  for (const name of ['__SAPISID', '__APISID', '__3PSAPISID', '__1PSAPISID', '__OVERRIDE_SID']) {
    if (env.cookieJar.has(name)) sandbox[name] = env.cookieJar.get(name);
  }

  env.setCookies = (cookieString) => {
    env.cookieString = String(cookieString || '');
    env.documentCookie = computeDocumentCookie(env.cookieString);
    env.cookieJar.clear();
    for (const part of env.cookieString.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) env.cookieJar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    for (const name of ['__SAPISID', '__APISID', '__3PSAPISID', '__1PSAPISID', '__OVERRIDE_SID']) {
      if (env.cookieJar.has(name)) sandbox[name] = env.cookieJar.get(name);
    }
  };

  env.setUrl = (url) => {
    current = new URL(String(url), current.href);
    env.url = current.href;
    sandbox.origin = current.origin;
  };

  // botguard creates an iframe and waits for its load/error event; without
  // this it sits in a retry loop until a 20 s timeout.
  env.scheduleIframeLoad = (el) => {
    setTimeout(() => {
      if (!el || el._loadFired) return;
      el._loadFired = true;
      el.readyState = 'complete';
      try { el.dispatchEvent({ type: 'load', target: el, currentTarget: el }); }
      catch (e) { env.log('debug', `iframe load handler threw: ${e && e.message}`); }
    }, 1);
  };

  return env;
}

function stringifyArg(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function makeStorage(env) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

function makeIDB(env) {
  const makeRequest = (result) => {
    const req = { result, onsuccess: null, onerror: null, readyState: 'done' };
    setTimeout(() => { try { req.onsuccess && req.onsuccess({ target: req }); } catch {} }, 0);
    return req;
  };
  return {
    open() { return makeRequest({ result: { objectStoreNames: [], createObjectStore: () => ({}), transaction: () => ({ objectStore: () => ({ get: () => makeRequest(undefined), put: () => makeRequest(undefined) }) }), close() {} }, onupgradeneeded: null }); },
    deleteDatabase() { return makeRequest(undefined); },
    databases: async () => [],
  };
}

function createDocument(env, location, url) {
  const document = {
    nodeType: 9,
    nodeName: '#document',
    contentType: 'text/html',
    compatMode: 'CSS1Compat',
    characterSet: 'UTF-8',
    charset: 'UTF-8',
    inputEncoding: 'UTF-8',
    title: '',
    domain: url.hostname,
    referrer: 'https://linux.do/',
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    prerendering: false,
    fullscreenEnabled: true,
    fullscreenElement: null,
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    designMode: 'off',
    lastModified: new Date().toUTCString(),
    dir: 'ltr',
    URL: url.href,
    documentURI: url.href,
    baseURI: url.href,
    location,
    defaultView: null,
    ownerDocument: null,
    currentScript: null,
    scripts: makeNodeList('HTMLCollection'),
    styleSheets: makeNodeList('StyleSheetList'),
    implementation: {},
    featurePolicy: {},
    fragmentDirective: {},
    customElementRegistry: {},
    embeds: makeNodeList('HTMLCollection'),
    plugins: makeNodeList('HTMLCollection'),
    anchors: makeNodeList('HTMLCollection'),
    applets: makeNodeList('HTMLCollection'),
    fonts: { ready: Promise.resolve(), status: 'loaded', check: () => true, add() {}, delete() {}, clear() {}, addEventListener() {}, removeEventListener() {} },
    timeline: { currentTime: 0 },
    cookie: '',
    _listeners: Object.create(null),
    _cookieJar: env.cookieJar,
    _env: env,
  };

  // currentScript is driven by the script loader; while the bundle is being
  // evaluated it must be null (otherwise closure's `ka` assertion fires).
  let currentScript = null;
  Object.defineProperty(document, 'currentScript', {
    get() { return currentScript; },
    set(v) { currentScript = v; },
    enumerable: true,
    configurable: true,
  });
  env.hostCurrentScript = (v) => { currentScript = v; };

  Object.defineProperty(document, 'cookie', {
    get() { return env.documentCookie; },
    set(v) {
      const s = String(v);
      const first = s.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) {
        const name = first.slice(0, i).trim();
        const value = first.slice(i + 1).trim();
        env.cookieJar.set(name, value);
        const others = env.cookieString.split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(name + '='));
        others.push(`${name}=${value}`);
        env.cookieString = others.join('; ');
        env.documentCookie = computeDocumentCookie(env.cookieString);
      }
    },
    enumerable: true,
    configurable: true,
  });

  const html = new DOMElement('HTML', env);
  html.lang = 'en';
  html.dir = 'ltr';
  html.getAttribute = function (name) {
    const k = String(name).toLowerCase();
    if (k === 'lang') return this.lang;
    if (k === 'dir') return this.dir;
    if (k === 'class') return this.className || null;
    return this.attributes[k] !== undefined ? this.attributes[k] : null;
  };
  const head = new DOMElement('HEAD', env);
  const body = new DOMElement('BODY', env);
  html.childNodes.push(head, body);
  head.parentNode = html;
  body.parentNode = html;
  document.documentElement = html;
  document.head = head;
  document.body = body;
  document.scrollingElement = html;
  document.activeElement = body;
  document.firstChild = html;
  document.lastChild = html;
  document.firstElementChild = html;
  document.lastElementChild = html;
  document.childNodes = makeNodeList('NodeList', [html]);
  document.children = makeNodeList('HTMLCollection', [html]);
  document.forms = makeNodeList('HTMLCollection');
  document.images = makeNodeList('HTMLCollection');
  document.links = makeNodeList('HTMLCollection');

  document.createElement = (tag) => {
    const name = String(tag).toUpperCase();
    const el = name === 'CANVAS' ? new CanvasElement(name, env) : new DOMElement(name, env);
    if (name === 'SCRIPT') document.scripts.push(el);
    return el;
  };
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  document.createTextNode = (text) => ({ nodeType: 3, nodeName: '#text', data: String(text), textContent: String(text), parentNode: null });
  document.createComment = (text) => ({ nodeType: 8, nodeName: '#comment', data: String(text), textContent: String(text), parentNode: null });
  document.createDocumentFragment = () => {
    const frag = new DOMElement('#fragment', env);
    frag.nodeType = 11;
    return frag;
  };
  document.createEvent = (type) => {
    const ev = {
      type: '',
      target: null,
      currentTarget: null,
      screenX: 0,
      screenY: 0,
      clientX: 0,
      clientY: 0,
      pageX: 0,
      pageY: 0,
      button: 0,
      buttons: 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      detail: 0,
      view: null,
      bubbles: false,
      cancelable: false,
      timeStamp: 0,
      isTrusted: false,
      initEvent(t) { this.type = t; },
      preventDefault() {},
      stopPropagation() {},
    };
    if (String(type) === 'MouseEvents') ev.initMouseEvent = function (t) { this.type = t; };
    if (CHROME_SCHEMA && CHROME_SCHEMA.mouseEvTypes) {
      for (const [k, t] of Object.entries(CHROME_SCHEMA.mouseEvTypes)) {
        if (k in ev) continue;
        if (t === 'function') ev[k] = function () {};
        else if (t === 'number') ev[k] = 0;
        else if (t === 'string') ev[k] = '';
        else if (t === 'boolean') ev[k] = false;
        else if (t === 'object') ev[k] = null;
      }
    }
    return ev;
  };
  document.elementFromPoint = () => null;
  document.elementsFromPoint = () => [];
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  document.getElementsByTagName = (tag) => {
    const t = String(tag).toUpperCase();
    if (t === 'HEAD') return [head];
    if (t === 'BODY') return [body];
    if (t === 'HTML') return [html];
    if (t === 'SCRIPT') return document.scripts;
    return [];
  };
  document.getElementsByTagNameNS = () => [];
  document.getElementsByClassName = () => [];
  document.getElementById = () => null;
  document.getElementsByName = () => [];
  document.hasFocus = () => true;
  document.exitFullscreen = async () => {};
  document.exitPictureInPicture = async () => {};
  document.addEventListener = (type, fn) => {
    if (typeof fn !== 'function') return;
    (document._listeners[type] || (document._listeners[type] = [])).push(fn);
  };
  document.removeEventListener = (type, fn) => {
    const a = document._listeners[type]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  document.dispatchEvent = (ev) => {
    for (const h of (document._listeners[ev.type] || [])) { try { h.call(document, ev); } catch {} }
    return true;
  };
  document.getSelection = () => ({ rangeCount: 0, toString: () => '', removeAllRanges() {} });
  document.caretRangeFromPoint = () => null;
  document.adoptedStyleSheets = [];
  document.addEventListener('visibilitychange', () => {});

  return document;
}

module.exports = {
  createBrowserEnv,
  DOMElement,
  binaryAtob,
  binaryBtoa,
  PNG_1X1,
};
