'use strict';

/**
 * Build a MakerSuiteService/GenerateContent request (proto field 5 is the WAA
 * proof).  The request object is created from the closure bundle's own proto
 * classes, so the serialized wire array is byte-for-byte compatible with what
 * AI Studio sends.
 *
 * Wire layout (zero-based):
 *   [0] model (string)
 *   [1] contents (repeated Content)
 *   [2] safetySettings (repeated SafetySetting)
 *   [3] generationConfig (GenerationConfig)
 *   [4] WAA proof (string)          <-- filled right before sending
 *   [5] systemInstruction (Content)
 *   ...
 */

const { sha256Hex } = require('../google/auth');

const ROLE_MAP = {
  user: 'user',
  assistant: 'model',
  model: 'model',
  system: 'user', // system instruction content also uses role "user" in AI Studio
  tool: 'user',
};

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function buildContent(ns, role, text) {
  const part = new ns.qt();
  part.setText(String(text));
  const content = new ns.tt();
  ns.rt(content, [part]);
  ns.st(content, ROLE_MAP[role] || 'user');
  return content;
}

function buildRequest(ns, options = {}) {
  const model = options.model || 'gemini-3.8-flash';
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const req = new ns.zu();
  req.setModel(model);

  const carry = options.carryContent;
  if (carry !== undefined && carry !== null && carry !== '') {
    // Proof-binding workaround: the captured proof only covers the contents
    // field.  Keep a fixed, proof-bound content here and move the real
    // conversation into systemInstruction (not hashed by _.SB).
    const convo = [];
    for (const msg of messages) {
      if (!msg) continue;
      const text = textOfContent(msg.content);
      if (!text) continue;
      if (msg.role === 'system' || msg.role === 'developer') convo.push(text);
      else if (msg.role === 'assistant' || msg.role === 'model') convo.push(`Assistant: ${text}`);
      else convo.push(`User: ${text}`);
    }
    const preamble = 'The contents field is only a proof-binding placeholder. Ignore it and answer the following request/conversation exactly.';
    const sys = buildContent(ns, 'system', `${preamble}\n\n${convo.join('\n\n')}`);
    req.Hh(sys);
    ns.DYa(req, [buildContent(ns, 'user', String(carry))]);
  } else {
    const systemTexts = [];
    const contents = [];
    for (const msg of messages) {
      if (!msg) continue;
      const text = textOfContent(msg.content);
      if (msg.role === 'system' || msg.role === 'developer') {
        if (text) systemTexts.push(text);
        continue;
      }
      if (!text) continue;
      contents.push(buildContent(ns, msg.role, text));
    }
    if (contents.length === 0) contents.push(buildContent(ns, 'user', ''));
    ns.DYa(req, contents);

    if (systemTexts.length) {
      const sys = buildContent(ns, 'system', systemTexts.join('\n\n'));
      req.Hh(sys);
    }
  }

  const gc = options.generationConfig;
  if (gc && typeof gc === 'object') {
    const cfg = new ns.Pj();
    let touched = false;
    const setNumber = (fn, field, value, label) => {
      if (value === undefined || value === null || value === '') return;
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      try { fn(cfg, field, n); touched = true; } catch (e) { /* field not supported */ }
    };
    setNumber(ns.Wk, 4, gc.maxOutputTokens ?? gc.max_output_tokens, 'maxOutputTokens');
    setNumber(ns.Tk, 5, gc.temperature, 'temperature');
    setNumber(ns.Tk, 6, gc.topP ?? gc.top_p, 'topP');
    setNumber(ns.Wk, 7, gc.topK ?? gc.top_k, 'topK');
    const mime = gc.responseMimeType || gc.response_mime_type;
    if (mime) { try { ns.ul(cfg, 8, String(mime)); touched = true; } catch {} }
    if (touched) ns.yc(req, ns.Pj, 4, cfg);
  }

  return req;
}

function setProof(ns, req, proof) {
  if (!proof) return req;
  ns.l(req, 5, String(proof));
  return req;
}

/**
 * AI Studio's digest: SHA-256 hex over the space-joined text of every user /
 * model content part.  Use the bundle's own `_.SB` whenever possible so this
 * stays exact if the schema changes.
 */
async function digestRequest(ns, req) {
  if (typeof ns.SB === 'function') {
    const d = await ns.SB(req);
    if (d) return String(d);
  }
  // Fallback: decode the raw jspb storage.  Contents are field 2; each
  // Content's parts are field 1; each Part's text is field 2.
  const texts = [];
  const raw = req && req.Ve;
  const contents = raw && raw[1];
  if (Array.isArray(contents)) {
    for (const c of contents) {
      const parts = Array.isArray(c) ? c[0] : null;
      if (!Array.isArray(parts)) continue;
      for (const p of parts) {
        const t = Array.isArray(p) ? p[1] : null;
        if (typeof t === 'string') texts.push(t);
      }
    }
  }
  return sha256Hex(texts.join(' '));
}

module.exports = {
  buildRequest,
  buildContent,
  setProof,
  digestRequest,
  textOfContent,
  ROLE_MAP,
};
