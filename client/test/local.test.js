import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { frames, normaliseBase, streamLocal, probeLocalServer } from '../src/local.js';

test('a local server address is accepted with or without scheme and /v1', () => {
  assert.equal(normaliseBase('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normaliseBase('http://localhost:1234/v1/'), 'http://localhost:1234');
});

test('long pieces are split so no frame is longer than a token may be', () => {
  assert.deepEqual(frames('abc', 2), ['ab', 'c']);
  assert.ok(frames('x'.repeat(100)).every((f) => f.length <= 48));
});

function server(chunks, models = [{ id: 'Ternary-Bonsai-2-27B-PQ2_0.gguf' }]) {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: models })); }
    let raw = ''; for await (const c of req) raw += c; seen.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: c }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() })));
}

test('reasoning from llama-server is wrapped in <think> tags, like the browser runtime emits it', async () => {
  const s = await server([{ reasoning_content: 'hmm' }, { reasoning_content: ' ok' }, { content: 'Answer' }]);
  let text = '';
  await streamLocal(s.url, { model: 'm', messages: [{ role: 'user', content: 'q' }], maxTokens: 9, enableThinking: true }, (t) => { text += t; });
  s.close();
  assert.equal(text, '<think>\nhmm ok\n</think>\n\nAnswer');
  assert.equal(s.seen[0].chat_template_kwargs.enable_thinking, true);
});

test('the admission check asks for greedy decoding', async () => {
  const s = await server([{ content: 'x' }]);
  await streamLocal(s.url, { model: 'm', messages: [], maxTokens: 3, greedy: true }, () => {});
  s.close();
  assert.equal(s.seen[0].temperature, 0);
  assert.equal(s.seen[0].top_k, 1);
});

test('the Bonsai model is picked when a server lists several', async () => {
  const s = await server([], [{ id: 'qwen3-4b' }, { id: 'ternary-bonsai-2-27b' }]);
  const probe = await probeLocalServer(s.url);
  s.close();
  assert.equal(probe.modelId, 'ternary-bonsai-2-27b');
});

test('a server that is not running gives a helpful message', async () => {
  await assert.rejects(probeLocalServer('http://127.0.0.1:9'), /Start llama-server first/);
});
