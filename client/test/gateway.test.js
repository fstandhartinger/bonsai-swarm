/**
 * The local gateway speaks three dialects on top of one upstream call. These tests
 * put a fake network in front of it - a tiny HTTP server that answers
 * /api/v1/chat/completions exactly the way the coordinator does - and check the
 * translations, streaming and non-streaming.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalServer, MODEL_ID } from '../src/serve.js';
import { messagesFromResponsesInput, messagesFromAnthropic } from '../src/serve.js';

const TOKENS = ['<think>', 'brief', '</think>', 'Hello', ' from', ' the', ' swarm'];
const ANSWER = 'Hello from the swarm';

/** Stands in for the coordinator: records what it was asked, streams fixed tokens. */
function fakeNetwork() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ path: req.url, auth: req.headers.authorization, body });

      if (req.url !== '/api/v1/chat/completions') { res.writeHead(404).end('{}'); return; }
      // The gateway only forwards known fields, so the trigger has to be in the prompt.
      if (JSON.stringify(body.messages || '').includes('BROKE')) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not enough AI Coins.', type: 'insufficient_coins' } }));
        return;
      }

      const usage = { prompt_tokens: 7, completion_tokens: TOKENS.length, total_tokens: 7 + TOKENS.length };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: TOKENS.join('') }, finish_reason: 'stop' }],
          usage, bonsai_swarm: { coins_charged: 3.5, decode_tps: 31.5 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of TOKENS) {
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage, bonsai_swarm: { coins_charged: 3.5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, seen };
}

let net;
let gateway;
let base;

test.before(async () => {
  net = fakeNetwork();
  await new Promise((r) => net.server.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${net.server.address().port}`;
  gateway = createLocalServer({ url: upstreamUrl, token: 'bsw_test_token', log: () => {} });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
});

test.after(() => { gateway.close(); net.server.close(); });

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** Reads an SSE body into [{event, data}]. */
async function sse(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    let event = 'message'; let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    let parsed = data;
    try { parsed = JSON.parse(data); } catch { /* [DONE] */ }
    return { event, data: parsed };
  });
}

test('the gateway forwards the stored token and never asks the caller for one', async () => {
  await post('/v1/chat/completions', { model: 'bonsai', messages: [{ role: 'user', content: 'hi' }] });
  const last = net.seen.at(-1);
  assert.equal(last.auth, 'Bearer bsw_test_token');
  assert.equal(last.path, '/api/v1/chat/completions');
});

test('GET /v1/models lists the swarm model', async () => {
  const res = await fetch(`${base}/v1/models`);
  const json = await res.json();
  assert.equal(json.data[0].id, MODEL_ID);
});

test('OpenAI chat completions, non-streaming', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'bonsai-swarm/ternary-bonsai-2-27b',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.choices[0].message.content, TOKENS.join(''));
  assert.equal(json.usage.completion_tokens, TOKENS.length);
  assert.equal(net.seen.at(-1).body.max_tokens, 64);
  assert.equal(net.seen.at(-1).body.stream, false);
});

test('OpenAI chat completions, streaming, ends with [DONE]', async () => {
  const res = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }], stream: true });
  const events = await sse(res);
  assert.equal(events.at(-1).data, '[DONE]');
  const text = events.filter((e) => e.data?.choices).map((e) => e.data.choices[0].delta?.content || '').join('');
  assert.equal(text, TOKENS.join(''));
});

test('OpenAI Responses, non-streaming, splits off the reasoning', async () => {
  const res = await post('/v1/responses', { input: 'hi', max_output_tokens: 40 });
  const json = await res.json();
  assert.equal(json.object, 'response');
  assert.equal(json.status, 'completed');
  assert.equal(json.output_text, ANSWER);
  assert.equal(json.output[0].reasoning, 'brief');
  assert.equal(json.usage.output_tokens, TOKENS.length);
  assert.equal(net.seen.at(-1).body.max_tokens, 40);
});

test('OpenAI Responses, streaming, emits the documented event sequence', async () => {
  const res = await post('/v1/responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true });
  const events = await sse(res);
  const names = events.map((e) => e.event);
  assert.ok(names.includes('response.created'));
  assert.ok(names.includes('response.output_text.delta'));
  assert.equal(names.at(-1), 'response.completed');
  const text = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join('');
  assert.equal(text, TOKENS.join(''));
  assert.equal(events.at(-1).data.response.output_text, ANSWER);
});

test('Anthropic messages, non-streaming', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-whatever',
    system: 'be short',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    max_tokens: 50,
  });
  const json = await res.json();
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.equal(json.content.find((c) => c.type === 'text').text, ANSWER);
  assert.equal(json.stop_reason, 'end_turn');
  assert.equal(json.usage.output_tokens, TOKENS.length);
  // the system prompt has to arrive as a system message upstream
  assert.deepEqual(net.seen.at(-1).body.messages[0], { role: 'system', content: 'be short' });
});

test('Anthropic messages, streaming', async () => {
  const res = await post('/v1/messages', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, stream: true });
  const events = await sse(res);
  const names = events.map((e) => e.event);
  assert.equal(names[0], 'message_start');
  assert.ok(names.includes('content_block_delta'));
  assert.equal(names.at(-1), 'message_stop');
  const text = events.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text).join('');
  assert.equal(text, TOKENS.join(''));
});

test('an upstream refusal is passed through with its status', async () => {
  const res = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'BROKE' }] });
  assert.equal(res.status, 402);
  const json = await res.json();
  assert.match(json.error.message, /AI Coins/);
});

test('input shapes are normalised', () => {
  assert.deepEqual(messagesFromResponsesInput({ instructions: 'sys', input: 'hello' }), [
    { role: 'system', content: 'sys' }, { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(messagesFromAnthropic({ messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] }), [
    { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' },
  ]);
});
