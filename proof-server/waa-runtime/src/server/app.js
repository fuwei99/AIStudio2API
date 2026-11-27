'use strict';

/**
 * OpenAI-compatible and Gemini-native HTTP front-end.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /status
 *   GET  /v1/models
 *   POST /v1/chat/completions          (OpenAI, stream or JSON)
 *   POST /v1/proof                     (debug: {text} -> {digest, proof})
 *   POST /v1beta/models/<m>:generateContent
 *   POST /v1beta/models/<m>:streamGenerateContent
 *   GET  /v1beta/models
 */

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 32 * 1024 * 1024;

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function apiError(res, status, message, type = 'invalid_request_error', code = null) {
  json(res, status, { error: { message: String(message), type, code } });
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-max-age', '86400');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) {
    throw Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 });
  }
}

function checkAuth(req, cfg) {
  if (!cfg.serverApiKey) return true;
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  return token === cfg.serverApiKey;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

const FINISH_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  OTHER: 'stop',
};

function mapUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokenCount || 0,
    completion_tokens: usage.candidatesTokenCount || 0,
    total_tokens: usage.totalTokenCount || 0,
  };
}

function openAiMessagesFromGemini(body) {
  const messages = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys) {
    const text = (sys.parts || []).map((p) => p && p.text || '').join('');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const c of body.contents || []) {
    const role = c.role === 'model' ? 'assistant' : (c.role || 'user');
    const text = (c.parts || []).map((p) => p && p.text || '').join('');
    if (text) messages.push({ role, content: text });
  }
  return messages;
}

function generationConfigFromOpenAI(body) {
  const gc = {};
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.max_tokens !== undefined) gc.maxOutputTokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) gc.maxOutputTokens = body.max_completion_tokens;
  if (body.response_format && body.response_format.type === 'json_object') gc.responseMimeType = 'application/json';
  return Object.keys(gc).length ? gc : undefined;
}

function generationConfigFromGemini(body) {
  const g = body.generationConfig || body.generation_config || {};
  const gc = {};
  if (g.temperature !== undefined) gc.temperature = g.temperature;
  if (g.topP !== undefined) gc.topP = g.topP;
  if (g.top_p !== undefined) gc.topP = g.top_p;
  if (g.topK !== undefined) gc.topK = g.topK;
  if (g.top_k !== undefined) gc.topK = g.top_k;
  if (g.maxOutputTokens !== undefined) gc.maxOutputTokens = g.maxOutputTokens;
  if (g.max_output_tokens !== undefined) gc.maxOutputTokens = g.max_output_tokens;
  if (g.responseMimeType) gc.responseMimeType = g.responseMimeType;
  return Object.keys(gc).length ? gc : undefined;
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseData(res, obj) {
  res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
}

async function handleChatCompletions(req, res, runtime, cfg) {
  const body = await readJson(req);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, 'messages must be a non-empty array');
  }
  if (body.n && body.n !== 1) return apiError(res, 400, 'only n=1 is supported');
  const model = body.model || cfg.defaultModel;
  const stream = !!body.stream;
  const options = {
    model,
    messages: body.messages,
    generationConfig: generationConfigFromOpenAI(body),
    carryContent: cfg.carryContent,
  };
  const id = newId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const result = await runtime.generate(options);
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: FINISH_MAP[result.finishReason] || 'stop',
      }],
      usage: mapUsage(result.usage),
    });
  }

  // Prepare (build request + proof) before committing the SSE response so
  // authentication/proof failures still produce a clean JSON error.
  const { req: generateReq } = await runtime.prepare(options);
  const controller = new AbortController();
  let closed = false;
  req.on('close', () => { closed = true; controller.abort(); });
  sseHead(res);
  sseData(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  let finish = 'stop';
  let sentAny = false;
  try {
    for await (const msg of runtime.client.stream(generateReq, { signal: controller.signal })) {
      if (closed) break;
      for (const c of msg.candidates) {
        if (c.index !== 0) continue;
        if (c.delta) {
          sentAny = true;
          sseData(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: c.delta }, finish_reason: null }],
          });
        }
        if (c.finishReasonName) finish = FINISH_MAP[c.finishReasonName] || 'stop';
      }
    }
    sseData(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    });
    sseData(res, '[DONE]');
    res.end();
  } catch (e) {
    if (!closed) {
      sseData(res, { error: { message: e.message, type: 'upstream_error', code: e.code || null } });
      sseData(res, '[DONE]');
      res.end();
    }
  }
}

async function handleGeminiGenerate(req, res, runtime, cfg, model, stream) {
  const body = await readJson(req);
  const messages = openAiMessagesFromGemini(body);
  if (messages.length === 0) messages.push({ role: 'user', content: '' });
  const options = { model: model || cfg.defaultModel, messages, generationConfig: generationConfigFromGemini(body), carryContent: cfg.carryContent };

  if (!stream) {
    const result = await runtime.generate(options);
    const candidate = {
      content: { parts: [{ text: result.text }], role: 'model' },
      finishReason: result.finishReason || 'STOP',
      index: 0,
    };
    const out = { candidates: [candidate] };
    if (result.usage) {
      out.usageMetadata = {
        promptTokenCount: result.usage.promptTokenCount,
        candidatesTokenCount: result.usage.candidatesTokenCount,
        totalTokenCount: result.usage.totalTokenCount,
      };
    }
    return json(res, 200, out);
  }

  const { req: generateReq } = await runtime.prepare(options);
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  sseHead(res);
  try {
    for await (const msg of runtime.client.stream(generateReq, { signal: controller.signal })) {
      for (const c of msg.candidates) {
        if (c.index !== 0) continue;
        const candidate = {
          content: { parts: [{ text: c.delta || '' }], role: 'model' },
          index: 0,
        };
        if (c.finishReasonName) candidate.finishReason = c.finishReasonName;
        sseData(res, { candidates: [candidate] });
      }
      if (msg.usage) {
        sseData(res, {
          usageMetadata: {
            promptTokenCount: msg.usage.promptTokenCount,
            candidatesTokenCount: msg.usage.candidatesTokenCount,
            totalTokenCount: msg.usage.totalTokenCount,
          },
        });
      }
    }
    res.end();
  } catch (e) {
    sseData(res, { error: { code: e.code || 500, message: e.message, status: 'INTERNAL' } });
    res.end();
  }
}

function createApp(options) {
  const { runtime, cfg, log } = options;
  const models = [cfg.defaultModel, ...(cfg.extraModels || [])].filter(Boolean);
  const created = Math.floor(Date.now() / 1000);

  return http.createServer(async (req, res) => {
    const started = Date.now();
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    res.on('finish', () => log('debug', `${route} -> ${res.statusCode} (${Date.now() - started}ms)`));

    try {
      if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
        if (!runtime.ready && !runtime.initError) {
          await Promise.race([
            runtime.init().catch(() => {}),
            new Promise((r) => setTimeout(r, 250)),
          ]);
        }
        const ok = !!runtime.ready;
        const error = runtime.initError ? runtime.initError.message : (ok ? null : 'starting');
        return json(res, ok ? 200 : (runtime.initError ? 500 : 503), {
          ok, error, model: cfg.defaultModel, provider: cfg.proofProvider,
          uptimeMs: Date.now() - runtime.startedAt,
        });
      }
      if (req.method === 'GET' && path === '/status') {
        return json(res, 200, runtime.describe());
      }

      if (path.startsWith('/v1/') || path.startsWith('/v1beta/')) {
        if (!checkAuth(req, cfg)) {
          return apiError(res, 401, 'invalid API key', 'authentication_error', 'invalid_api_key');
        }
      }

      if (req.method === 'GET' && path === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: models.map((id) => ({ id, object: 'model', created, owned_by: 'google' })),
        });
      }
      if (req.method === 'GET' && path === '/v1beta/models') {
        return json(res, 200, { models: models.map((m) => ({ name: `models/${m}`, displayName: m })) });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        await runtime.init();
        return await handleChatCompletions(req, res, runtime, cfg);
      }

      if (req.method === 'POST' && path === '/v1/proof') {
        const body = await readJson(req);
        const text = body.text ?? body.digest ?? '';
        const digest = crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
        await runtime.init();
        const proof = await runtime.snapshotDigest(digest);
        return json(res, 200, { digest, proof, length: proof.length, valid: proof.startsWith('!') });
      }

      const gem = path.match(/^\/v1beta\/models\/(.+?):(generateContent|streamGenerateContent)$/);
      if (req.method === 'POST' && gem) {
        await runtime.init();
        const model = decodeURIComponent(gem[1]);
        return await handleGeminiGenerate(req, res, runtime, cfg, model, gem[2] === 'streamGenerateContent');
      }

      return apiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
    } catch (e) {
      log('warn', `${route} failed: ${e && (e.stack || e.message)}`);
      if (res.headersSent) {
        try { sseData(res, { error: { message: e.message, type: 'upstream_error', code: e.code || null } }); res.end(); } catch {}
        return;
      }
      const status = e.status || e.httpStatus || 502;
      return apiError(res, status, e.message || String(e), e.type || 'upstream_error', e.code ?? null);
    }
  });
}

module.exports = {
  createApp,
  readJson,
  json,
  apiError,
  handleChatCompletions,
  handleGeminiGenerate,
  mapUsage,
  FINISH_MAP,
};
