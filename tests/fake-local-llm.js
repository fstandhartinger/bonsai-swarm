/**
 * A stand-in for a volunteer's llama.cpp server (OpenAI chat API, streamed).
 *
 * `answers` maps a prompt to the text this "model" gives for it. With the Bonsai
 * reference answers it plays a correctly set-up llama-server; with the answers the parent
 * model Qwen3.8-27B really gave (tests/fixtures, recorded on the RTX 2000 Ada test pod on
 * 19 Sep 2026) it plays somebody who loaded the wrong GGUF.
 */
import http from 'node:http';

export function startFakeLocalLlm({ modelId = 'Ternary-Bonsai-2-27B-PQ2_0.gguf', answers = {}, tokenDelayMs = 4, fallbackTokens = 40, fallbackDelayMs = null } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    const prompt = body.messages.at(-1).content;
    const text = answers[prompt] ?? Array.from({ length: Math.min(body.max_tokens, fallbackTokens) }, (_, i) => ` word${i}`).join('');
    // roughly one token per word piece, the way llama-server streams
    const pieces = text.match(/\s*\S+|\s+/g) || [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let closed = false;
    req.on('close', () => { closed = true; });
    for (const piece of pieces.slice(0, body.max_tokens)) {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, prompt in answers ? tokenDelayMs : (fallbackDelayMs ?? tokenDelayMs)));
    }
    res.write(`data: ${JSON.stringify({ model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
