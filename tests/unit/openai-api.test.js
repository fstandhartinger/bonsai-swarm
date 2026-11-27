import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, resetDb, client, signUp, createToken, pool, TEST_KEY, readSse } from '../helpers.js';
import { MockProvider } from '../mock-provider.js';

let srv;
const providers = [];

test.before(async () => { srv = await startTestServer(); });
test.after(async () => { for (const p of providers) p.close(); await srv.close(); await pool.end(); });
test.beforeEach(async () => { for (const p of providers.splice(0)) p.close(); await resetDb(); });

async function networkWithProvider(tokens = 5) {
  const host = client(srv.url); await signUp(host, `h${Math.random().toString(36).slice(2, 8)}`);
  const p = new MockProvider({ url: srv.url, token: await createToken(host), testKey: TEST_KEY, tokens });
  providers.push(p);
  await p.connect();
  const user = client(srv.url); await signUp(user, `u${Math.random().toString(36).slice(2, 8)}`);
  return { host, user, userToken: await createToken(user) };
}

test('GET /api/v1/models advertises the network model', async () => {
  const res = await client(srv.url).req('/api/v1/models');
  assert.equal(res.status, 200);
  assert.equal(res.json.data[0].id, 'bonsai-swarm/ternary-bonsai-2-27b');
});

test('the OpenAI endpoint needs a bearer token', async () => {
  const res = await client(srv.url).req('/api/v1/chat/completions', {
    method: 'POST', body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 401);
});

test('non-streaming chat completion returns the full answer and usage', async () => {
  const { userToken } = await networkWithProvider(5);
  const res = await client(srv.url).req('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${userToken}`, 'x-test-mode-key': TEST_KEY },
    body: { model: 'bonsai-swarm/ternary-bonsai-2-27b', messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.choices[0].message.content, 'mock t1 t2 t3 t4');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.equal(res.json.usage.completion_tokens, 5);
  assert.ok(res.json.usage.prompt_tokens > 0);
  assert.equal(res.json.bonsai_swarm.coins_charged > 0, true);
});

test('streaming chat completion emits OpenAI chunks and ends with [DONE]', async () => {
  const { userToken } = await networkWithProvider(4);
  const res = await fetch(`${srv.url}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}`, 'x-test-mode-key': TEST_KEY },
    body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = await readSse(res);
  const chunks = events.filter((e) => e.data !== '[DONE]' && e.data.object === 'chat.completion.chunk');
  const text = chunks.map((c) => c.data.choices[0].delta.content || '').join('');
  assert.equal(text, 'mock t1 t2 t3');
  assert.equal(chunks[0].data.choices[0].delta.role, 'assistant');
  const last = chunks.at(-1).data;
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.usage.completion_tokens, 4);
  assert.equal(events.at(-1).data, '[DONE]');
});

test('max_tokens is honoured and reported as finish_reason=length', async () => {
  const { userToken } = await networkWithProvider(20);
  const res = await client(srv.url).req('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${userToken}`, 'x-test-mode-key': TEST_KEY },
    body: { model: 'x', max_tokens: 3, messages: [{ role: 'user', content: 'be brief' }] },
  });
  assert.equal(res.json.usage.completion_tokens, 3);
  assert.equal(res.json.choices[0].finish_reason, 'length');
});

test('an empty balance produces a 402 with an OpenAI-shaped error', async () => {
  const { user, userToken } = await networkWithProvider(5);
  const me = await user.req('/api/me');
  await pool.query('UPDATE users SET balance = 0 WHERE id = $1', [me.json.user.id]);
  await pool.query("INSERT INTO ledger (user_id, kind, coins) VALUES ($1,'admin_adjust',$2)", [me.json.user.id, -1000]);
  const res = await client(srv.url).req('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${userToken}` },
    body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 402);
  assert.equal(res.json.error.code, 'insufficient_coins');
});

test('a revoked token stops working immediately', async () => {
  const { user, userToken } = await networkWithProvider(3);
  const list = await user.req('/api/tokens');
  await user.req(`/api/tokens/${list.json.tokens[0].id}`, { method: 'DELETE' });
  const res = await client(srv.url).req('/api/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${userToken}` },
    body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 401);
});

test('one user cannot read another user\'s ledger, tokens or jobs', async () => {
  const a = client(srv.url); const ua = await signUp(a, 'privacya');
  const b = client(srv.url); await signUp(b, 'privacyb');
  await a.req('/api/tokens', { method: 'POST', body: { name: 'secret' } });
  const bTokens = await b.req('/api/tokens');
  assert.equal(bTokens.json.tokens.length, 0);
  const bLedger = await b.req('/api/ledger');
  assert.equal(bLedger.json.entries.every((e) => e.kind === 'welcome'), true);
  const bJobs = await b.req('/api/jobs');
  assert.equal(bJobs.json.jobs.length, 0);
  assert.ok(ua.id);
});
