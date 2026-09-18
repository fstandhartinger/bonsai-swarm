import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, resetDb, client, signUp, createToken, openSse, waitFor, pool, TEST_KEY } from '../helpers.js';
import { MockProvider } from '../mock-provider.js';
import { auditBalance } from '../../server/coins.js';

let srv;
const providers = [];

const spawnProvider = async (token, opts = {}) => {
  const p = new MockProvider({ url: srv.url, token, testKey: TEST_KEY, ...opts });
  providers.push(p);
  await p.connect();
  return p;
};

const balanceOf = async (username) => {
  const { rows } = await pool.query('SELECT balance FROM users WHERE username_lower = $1', [username.toLowerCase()]);
  return Number(rows[0].balance);
};

test.before(async () => { srv = await startTestServer(); });
test.after(async () => {
  for (const p of providers) p.close();
  await srv.close();
  await pool.end();
});
test.beforeEach(async () => { for (const p of providers.splice(0)) p.close(); await resetDb(); });

test('a chat request is streamed by a volunteer provider and both balances move', async () => {
  const host = client(srv.url); await signUp(host, 'host1');
  const hostToken = await createToken(host);
  await spawnProvider(hostToken, { tokens: 6 });

  const user = client(srv.url); await signUp(user, 'user1');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie,
    body: { messages: [{ role: 'user', content: 'Hello network' }], maxTokens: 64 },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  const deltas = stream.events.filter((e) => e.event === 'delta');
  assert.equal(deltas.length, 6);
  assert.equal(deltas.map((d) => d.data.delta).join(''), 'mock t1 t2 t3 t4 t5');

  const done = stream.events.find((e) => e.event === 'done').data;
  assert.equal(done.status, 'done');
  assert.equal(done.completionTokens, 6);
  assert.ok(done.promptTokens > 0);
  // 6 generated tokens * 0.5 + prompt tokens * 0.1
  assert.equal(done.coinsCharged, Number((6 * 0.5 + done.promptTokens * 0.1).toFixed(6)));

  assert.equal(await balanceOf('user1'), 1000 - done.coinsCharged);
  assert.equal(await balanceOf('host1'), 1000 + 6 * 0.5);

  const { rows } = await pool.query('SELECT * FROM jobs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completion_tokens, 6);
  assert.equal(Object.keys(rows[0]).some((k) => /prompt_text|content|messages/.test(k)), false,
    'the jobs table must not be able to hold prompt text');
});

test('the cached balance always matches the append-only ledger', async () => {
  const host = client(srv.url); await signUp(host, 'host2');
  await spawnProvider(await createToken(host), { tokens: 4 });
  const user = client(srv.url); const u = await signUp(user, 'user2');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'audit me' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);
  const audit = await auditBalance(u.id);
  assert.equal(audit.ok, true, `cached ${audit.cached} vs ledger ${audit.ledger}`);
});

test('a user never gets their own prompts, so they cannot farm AI Coins', async () => {
  const solo = client(srv.url); await signUp(solo, 'solo');
  await spawnProvider(await createToken(solo), { tokens: 4 });

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: solo.cookie, body: { messages: [{ role: 'user', content: 'serve myself' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'queued'), 5000);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(srv.coordinator.stats().jobsRunning, 0);
  assert.equal(srv.coordinator.stats().queueLength, 1);
  assert.equal(stream.events.filter((e) => e.event === 'delta').length, 0);
  stream.abort();
  await waitFor(async () => srv.coordinator.stats().queueLength === 0, 5000);
});

test('a slow GPU is not admitted and is never given other people strangers prompts', async () => {
  const slow = client(srv.url); await signUp(slow, 'slowgpu');
  const p = await spawnProvider(await createToken(slow), { decodeTps: 2.5, tokens: 4 });
  assert.equal(p.admitted, false);

  const user = client(srv.url); await signUp(user, 'user3');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'anyone there' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'queued'), 5000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(stream.events.filter((e) => e.event === 'delta').length, 0);
  stream.abort();
  await waitFor(async () => srv.coordinator.stats().queueLength === 0, 5000);
});

test('the admin override admits a slow GPU (used for the real-browser test on the laptop)', async () => {
  const slow = client(srv.url); await signUp(slow, 'slowgpu2');
  const p = await spawnProvider(await createToken(slow), { decodeTps: 2.5, tokens: 3, override: true });
  assert.equal(p.admitted, true);
  const user = client(srv.url); await signUp(user, 'user4');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'slow but fine' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);
  assert.equal(stream.events.filter((e) => e.event === 'delta').length, 3);
});

test('one provider serves one job at a time; the second request waits in the queue', async () => {
  const host = client(srv.url); await signUp(host, 'host5');
  await spawnProvider(await createToken(host), { tokens: 8, delayMs: 120 });

  const a = client(srv.url); await signUp(a, 'usera');
  const b = client(srv.url); await signUp(b, 'userb');
  const sa = await openSse(srv.url, '/api/chat/stream', { cookie: a.cookie, body: { messages: [{ role: 'user', content: 'first' }] } });
  await sa.until((e) => e.some((x) => x.event === 'delta'), 10_000);
  const sb = await openSse(srv.url, '/api/chat/stream', { cookie: b.cookie, body: { messages: [{ role: 'user', content: 'second' }] } });
  await sb.until((e) => e.some((x) => x.event === 'queued'), 5000);

  assert.equal(srv.coordinator.stats().providersBusy, 1);
  assert.equal(sb.events.filter((e) => e.event === 'delta').length, 0, 'the second job must not start before the first finishes');

  await sa.until((e) => e.some((x) => x.event === 'done'), 20_000);
  await sb.until((e) => e.some((x) => x.event === 'done'), 20_000);
  assert.equal(sb.events.filter((e) => e.event === 'delta').length, 8);
});

test('when a provider drops before the first token the job is re-queued to another one', async () => {
  const flaky = client(srv.url); await signUp(flaky, 'flaky');
  const solid = client(srv.url); await signUp(solid, 'solid');
  const pFlaky = await spawnProvider(await createToken(flaky), { tokens: 5, delayMs: 1500, decodeTps: 99 });
  await spawnProvider(await createToken(solid), { tokens: 5, delayMs: 5, decodeTps: 50 });

  const user = client(srv.url); await signUp(user, 'user6');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'survive a drop' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'assigned'), 10_000);
  pFlaky.close();                                   // the fast provider vanishes mid-job

  await stream.until((e) => e.some((x) => x.event === 'done'), 20_000);
  const queued = stream.events.filter((e) => e.event === 'queued');
  assert.ok(queued.some((q) => q.data.requeued), 'expected a re-queue event');
  assert.equal(stream.events.filter((e) => e.event === 'delta').length, 5);
  assert.equal(await balanceOf('flaky'), 1000, 'a provider that delivered nothing earns nothing');
  assert.equal(await balanceOf('solid'), 1000 + 5 * 0.5);
});

test('cancelling stops the stream and only the delivered tokens are charged', async () => {
  const host = client(srv.url); await signUp(host, 'host7');
  await spawnProvider(await createToken(host), { tokens: 40, delayMs: 60 });
  const user = client(srv.url); await signUp(user, 'user7');

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'stop me' }], maxTokens: 40 },
  });
  await stream.until((e) => e.filter((x) => x.event === 'delta').length >= 3, 10_000);
  const jobId = stream.events.find((e) => e.event === 'queued').data.jobId;
  await client(srv.url).req('/api/chat/cancel', { method: 'POST', body: { jobId }, headers: { cookie: user.cookie } });

  await waitFor(async () => (await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n === 1, 8000);
  const { rows } = await pool.query('SELECT * FROM jobs');
  assert.equal(rows[0].status, 'cancelled');
  assert.ok(rows[0].completion_tokens < 40);
  const charged = Number((rows[0].completion_tokens * 0.5 + rows[0].prompt_tokens * 0.1).toFixed(6));
  assert.equal(await balanceOf('user7'), 1000 - charged);
});

test('another user cannot cancel someone else\'s job', async () => {
  const host = client(srv.url); await signUp(host, 'host8');
  await spawnProvider(await createToken(host), { tokens: 30, delayMs: 60 });
  const user = client(srv.url); await signUp(user, 'user8');
  const attacker = client(srv.url); await signUp(attacker, 'attacker8');

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'keep going' }], maxTokens: 30 },
  });
  await stream.until((e) => e.filter((x) => x.event === 'delta').length >= 2, 10_000);
  const jobId = stream.events.find((e) => e.event === 'queued').data.jobId;
  const res = await attacker.req('/api/chat/cancel', { method: 'POST', body: { jobId } });
  assert.equal(res.json.ok, false);
  await stream.until((e) => e.some((x) => x.event === 'done'), 20_000);
  assert.equal(stream.events.find((e) => e.event === 'done').data.status, 'done');
});

test('a balance can never go negative: the request is refused with a friendly message', async () => {
  const host = client(srv.url); await signUp(host, 'host9');
  await spawnProvider(await createToken(host), { tokens: 5 });
  const user = client(srv.url); const u = await signUp(user, 'poor');
  await pool.query('UPDATE users SET balance = 0 WHERE id = $1', [u.id]);
  await pool.query("INSERT INTO ledger (user_id, kind, coins) VALUES ($1,'admin_adjust',$2)", [u.id, -1000]);

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'can I still ask?' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'error'), 8000);
  const err = stream.events.find((e) => e.event === 'error').data;
  assert.equal(err.code, 'insufficient_coins');
  assert.match(err.error, /Share your GPU/);
  assert.equal(await balanceOf('poor'), 0);
});

test('a nearly empty balance clamps the answer length instead of overdrawing', async () => {
  const host = client(srv.url); await signUp(host, 'host10');
  await spawnProvider(await createToken(host), { tokens: 50, delayMs: 5 });
  const user = client(srv.url); const u = await signUp(user, 'nearlybroke');
  await pool.query('UPDATE users SET balance = 6 WHERE id = $1', [u.id]);
  await pool.query("INSERT INTO ledger (user_id, kind, coins) VALUES ($1,'admin_adjust',$2)", [u.id, 6 - 1000]);

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);
  const done = stream.events.find((e) => e.event === 'done').data;
  assert.ok(done.completionTokens < 50, 'answer must be clamped to what the balance can pay');
  assert.ok(await balanceOf('nearlybroke') >= 0);
});

test('prompts are rejected when they are too long, and roles are validated', async () => {
  const user = client(srv.url); await signUp(user, 'validator');
  const long = await user.req('/api/chat/stream', { method: 'POST', body: { messages: [{ role: 'user', content: 'x'.repeat(30000) }] } });
  assert.equal(long.status, 400);
  const badRole = await user.req('/api/chat/stream', { method: 'POST', body: { messages: [{ role: 'root', content: 'hi' }] } });
  assert.equal(badRole.status, 400);
  const empty = await user.req('/api/chat/stream', { method: 'POST', body: { messages: [] } });
  assert.equal(empty.status, 400);
});

test('an unauthenticated websocket is rejected before it becomes a provider', async () => {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws/provider`);
  const outcome = await new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.equal(outcome, 401);
  assert.equal(srv.coordinator.providers.size, 0);
});

test('the mock provider needs the shared test key; a normal account cannot fake one', async () => {
  const c = client(srv.url); await signUp(c, 'faker');
  const token = await createToken(c);
  const bad = new MockProvider({ url: srv.url, token, testKey: 'wrong-key', tokens: 3 });
  providers.push(bad);
  await bad.connect();
  const provider = [...srv.coordinator.providers.values()][0];
  assert.equal(provider.isMock, false, 'without the right key the connection is a normal provider, not a mock');
  assert.equal(provider.adminOverride, false);
});
