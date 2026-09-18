/**
 * A fake OpenAI-compatible endpoint, standing in for whatever free model the deployment
 * points its fallback at. It can answer, stall, fail, or - like a real reasoning model
 * on a short budget - stream nothing but thoughts and no answer at all.
 */
import http from 'node:http';

export async function startFakeUpstream({
  text = 'Answered by the fallback model.',
  status = 200,
  mode = 'ok',            // ok | reasoning-only | error | hang
  chunkChars = 8,
  usageTokens = null,
} = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not json */ }
      calls.push({ url: req.url, auth: req.headers.authorization || null, body: parsed });

      if (mode === 'error' || status !== 200) {
        res.writeHead(status === 200 ? 500 : status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream is unhappy' } }));
      }
      if (mode === 'hang') return; // never answers; the client's timeout must fire

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: parsed?.model || 'fake' };

      if (mode === 'reasoning-only') {
        // The failure mode that matters: a reasoning model spends its whole budget
        // thinking, so `content` never arrives and the answer box would be empty.
        frame({ ...base, choices: [{ index: 0, delta: { reasoning_content: 'thinking hard' }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      for (let i = 0; i < text.length; i += chunkChars) {
        frame({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + chunkChars) }, finish_reason: null }] });
      }
      frame({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(usageTokens ? { usage: { completion_tokens: usageTokens } } : {}),
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
