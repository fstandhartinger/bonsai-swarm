/**
 * The local API gateway.
 *
 * Browsers isolate the volunteer's tab, so the network itself can only offer one HTTP
 * shape (OpenAI Chat Completions). This process fills the gap: it listens on localhost
 * and speaks three dialects on top of that single upstream -
 *
 *   POST /v1/chat/completions   OpenAI Chat Completions   (stream + non-stream)
 *   POST /v1/responses          OpenAI Responses          (stream + non-stream)
 *   POST /v1/messages           Anthropic Messages        (stream + non-stream)
 *
 * It binds to 127.0.0.1 by default, so nothing outside this machine can spend your AI Coins.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { chatCompletion, streamChunks, collect, UpstreamError, splitThinking } from './upstream.js';

export const MODEL_ID = 'bonsai-swarm/ternary-bonsai-2-27b';
const MODEL_ALIASES = new Set([MODEL_ID, 'bonsai-swarm', 'ternary-bonsai-2-27b', 'bonsai']);

const id = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

export function createLocalServer({ url, token, log = console.log, verbose = false }) {
  const auth = { url, token };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      await route(req, res, auth, { log, verbose });
    } catch (err) {
      if (!res.headersSent) sendJson(res, err instanceof UpstreamError ? err.status : 500, {
        error: { message: err.message, type: 'api_error' },
      });
      else res.end();
    }
    if (verbose) log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });
  return server;
}

async function route(req, res, auth, opts) {
  const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return sendJson(res, 200, { ok: true, upstream: auth.url, model: MODEL_ID });
  }
  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    return sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 1758000000, owned_by: 'bonsai-swarm' }],
    });
  }
  if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });

  const body = await readJson(req);
  switch (path) {
    case '/v1/chat/completions':
    case '/chat/completions':
      return chatCompletions(res, auth, body, opts);
    case '/v1/responses':
    case '/responses':
      return responses(res, auth, body, opts);
    case '/v1/messages':
    case '/messages':
      return anthropicMessages(res, auth, body, opts);
    default:
      return sendJson(res, 404, { error: { message: `Unknown endpoint ${path}`, type: 'invalid_request_error' } });
  }
}

// ------------------------------------------------------------------ OpenAI chat

async function chatCompletions(res, auth, body, opts) {
  const payload = {
    messages: body.messages,
    max_tokens: body.max_completion_tokens ?? body.max_tokens,
    stream: Boolean(body.stream),
    reasoning_effort: body.reasoning_effort,
  };
  const upstream = await chatCompletion(auth, payload);
  if (!payload.stream) {
    const json = await upstream.json();
    return sendJson(res, 200, { ...json, model: modelNameFor(body) });
  }
  startSse(res);
  for await (const chunk of streamChunks(upstream)) {
    res.write(`data: ${JSON.stringify({ ...chunk, model: modelNameFor(body) })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  if (opts.verbose) opts.log('chat.completions stream finished');
}

// ------------------------------------------------------------------ OpenAI Responses

/** `input` may be a plain string, a list of messages, or a list of content parts. */
export function messagesFromResponsesInput(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) throw new Error('`input` must be a string or an array');
  for (const item of input) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
    if (item?.type === 'message' || item?.role) {
      messages.push({ role: item.role || 'user', content: partsToText(item.content) });
    }
  }
  return messages;
}

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : String(p.text ?? ''))).join('');
}

async function responses(res, auth, body, opts) {
  const messages = messagesFromResponsesInput(body);
  const payload = {
    messages,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    stream: Boolean(body.stream),
    reasoning_effort: body.reasoning?.effort,
  };
  const responseId = id('resp');
  const itemId = id('msg');
  const model = modelNameFor(body);

  if (!payload.stream) {
    const upstream = await chatCompletion(auth, { ...payload, stream: true });
    const { text, usage, finish, error } = await collect(upstream);
    if (error) return sendJson(res, 502, { error: { message: error.message, type: 'server_error' } });
    const { thinking, answer } = splitThinking(text);
    return sendJson(res, 200, responseObject({ responseId, itemId, model, answer, thinking, usage, finish }));
  }

  const upstream = await chatCompletion(auth, payload);
  startSse(res);
  let seq = 0;
  const event = (type, data) => {
    seq += 1;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...data })}\n\n`);
  };

  const skeleton = responseObject({ responseId, itemId, model, answer: '', thinking: '', usage: null, finish: null, status: 'in_progress' });
  event('response.created', { response: skeleton });
  event('response.in_progress', { response: skeleton });
  event('response.output_item.added', {
    output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  event('response.content_part.added', {
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });

  let text = '';
  let usage = null;
  let finish = 'stop';
  for await (const chunk of streamChunks(upstream)) {
    if (chunk.error) {
      event('response.failed', { response: { ...skeleton, status: 'failed', error: { code: chunk.error.code || 'server_error', message: chunk.error.message } } });
      return res.end();
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      text += delta;
      event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta });
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const { thinking, answer } = splitThinking(text);
  event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: answer });
  event('response.content_part.done', {
    item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: answer, annotations: [] },
  });
  event('response.output_item.done', {
    output_index: 0,
    item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [] }] },
  });
  event('response.completed', { response: responseObject({ responseId, itemId, model, answer, thinking, usage, finish }) });
  res.end();
  if (opts.verbose) opts.log('responses stream finished');
}

function responseObject({ responseId, itemId, model, answer, thinking, usage, finish, status = 'completed' }) {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : null,
    model,
    output: status === 'completed'
      ? [{
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
        ...(thinking ? { reasoning: thinking } : {}),
      }]
      : [],
    output_text: status === 'completed' ? answer : '',
    usage: usage
      ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      }
      : null,
  };
}

// ------------------------------------------------------------------ Anthropic Messages

export function messagesFromAnthropic(body) {
  const messages = [];
  if (body.system) {
    messages.push({ role: 'system', content: typeof body.system === 'string' ? body.system : partsToText(body.system) });
  }
  for (const m of body.messages || []) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: partsToText(m.content) });
  }
  return messages;
}

const anthropicStop = (finish) => (finish === 'length' ? 'max_tokens' : 'end_turn');

async function anthropicMessages(res, auth, body, opts) {
  const messages = messagesFromAnthropic(body);
  const model = modelNameFor(body);
  const messageId = id('msg');
  const payload = {
    messages,
    max_tokens: body.max_tokens,
    stream: Boolean(body.stream),
    reasoning_effort: body.thinking?.type === 'enabled' ? 'medium' : undefined,
  };

  if (!payload.stream) {
    const upstream = await chatCompletion(auth, { ...payload, stream: true });
    const { text, usage, finish, error } = await collect(upstream);
    if (error) return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: error.message } });
    const { thinking, answer } = splitThinking(text);
    return sendJson(res, 200, {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        ...(thinking ? [{ type: 'thinking', thinking }] : []),
        { type: 'text', text: answer },
      ],
      stop_reason: anthropicStop(finish),
      stop_sequence: null,
      usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
    });
  }

  const upstream = await chatCompletion(auth, payload);
  startSse(res);
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  event('message_start', {
    message: {
      id: messageId, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });

  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let finish = 'stop';
  let pingTimer = setInterval(() => event('ping', {}), 15000);
  try {
    for await (const chunk of streamChunks(upstream)) {
      if (chunk.error) {
        event('error', { error: { type: 'api_error', message: chunk.error.message } });
        return res.end();
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: choice.delta.content } });
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  } finally {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: anthropicStop(finish), stop_sequence: null },
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  });
  event('message_stop', {});
  res.end();
  if (opts.verbose) opts.log('anthropic stream finished');
}

// ------------------------------------------------------------------ helpers

function modelNameFor(body) {
  const asked = String(body.model || '');
  return MODEL_ALIASES.has(asked) || !asked ? MODEL_ID : asked;
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4_000_000) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}
