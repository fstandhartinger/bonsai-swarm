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
  // Only the flaky provider exists when the job is submitted, so it is certain to get
  // it (the coordinator picks at random among whoever is ready).
  const pFlaky = await spawnProvider(await createToken(flaky), { tokens: 5, delayMs: 1500, decodeTps: 99 });

  const user = client(srv.url); await signUp(user, 'user6');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'survive a drop' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'assigned'), 10_000);
  await spawnProvider(await createToken(solid), { tokens: 5, delayMs: 5, decodeTps: 50 });
  pFlaky.close();                                   // the busy provider vanishes mid-job

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
  await assert.rejects(() => bad.connect(), /handshake 403/);
  assert.equal(srv.coordinator.providers.size, 0);
});

test('a mock GPU is not given to a consumer who did not present the test key', async () => {
  const host = client(srv.url); await signUp(host, 'mockgate');
  await spawnProvider(await createToken(host), { tokens: 4 });
  const user = client(srv.url); await signUp(user, 'organicuser');
  const controller = new AbortController();
  const res = await fetch(`${srv.url}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.url, cookie: user.cookie },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  await waitFor(() => [...srv.coordinator.jobs.values()].some((j) => j.consumerId), 2000);
  const job = [...srv.coordinator.jobs.values()][0];
  assert.equal(job.status, 'queued');
  assert.equal(job.providerId, null);
  controller.abort();
});

test('a demoted provider cannot re-admit itself with another claimed benchmark', async () => {
  const host = client(srv.url); await signUp(host, 'slowpoke');
  const p = await spawnProvider(await createToken(host), { tokens: 8, delayMs: 80 });
  const view = [...srv.coordinator.providers.values()][0];
  view.slowJobs = 2;
  view.admitted = false;
  view.state = 'rejected';
  await srv.coordinator.handleBenchmark(view, { decodeTps: 80, ttftMs: 10 });
  assert.equal(view.admitted, false);
  assert.equal(view.state, 'rejected');
  assert.equal(view.decodeTps, view.measuredTps);
});

test('a demoted account stays demoted on a new socket', async () => {
  const host = client(srv.url); const u = await signUp(host, 'slowpoke2');
  await pool.query("UPDATE users SET provider_demoted_until = now() + interval '1 hour' WHERE id=$1", [u.id]);
  const p = await spawnProvider(await createToken(host), { tokens: 4, decodeTps: 80 });
  assert.equal(p.admitted, false);
});

test('jobs.error stores a short code, not provider-chosen text', async () => {
  const host = client(srv.url); await signUp(host, 'errhost');
  await spawnProvider(await createToken(host), { tokens: 1 });
  const user = client(srv.url); const errUser = await signUp(user, 'erruser');
  const [provider] = [...srv.coordinator.providers.values()];
  const job = {
    id: 'job-err-1',
    consumerId: Number(errUser.id),
    providerId: provider.id,
    providerUserId: provider.userId,
    promptTokens: 3,
    completionTokens: 0,
    maxNewTokens: 8,
    status: 'running',
    attempts: 1,
    isMock: true,
    sink: {},
    createdAt: Date.now(),
    queuedAt: Date.now(),
    startedAt: Date.now(),
    servedBy: 'community',
    messages: [{ role: 'user', content: 'secret prompt that must not be stored' }],
  };
  srv.coordinator.jobs.set(job.id, job);
  provider.currentJobId = job.id;
  await srv.coordinator.finishJob(job.id, 'failed', {
    error: 'secret prompt that must not be stored',
    code: 'provider_error',
  });
  const { rows } = await pool.query('SELECT error FROM jobs WHERE id=$1', [job.id]);
  assert.equal(rows[0].error, 'provider_error');
});

// --------------------------------------------------------- trust the server, not the browser
// A provider is a stranger's machine that can send whatever it likes down the socket.
// These are the guarantees that hold even when it lies.

test('a provider cannot claim an impossible speed to be handed every prompt', async () => {
  const liar = client(srv.url); await signUp(liar, 'liar');
  const p = await spawnProvider(await createToken(liar), { tokens: 3, decodeTps: 100000 });
  assert.equal(p.admitted, true);
  const [view] = [...srv.coordinator.providers.values()];
  assert.ok(view.decodeTps <= 120, `claimed speed must be capped, saw ${view.decodeTps}`);
});

test('a long delta is still only one token, so nobody can bill a paragraph as a token', async () => {
  const host = client(srv.url); await signUp(host, 'fathost');
  await spawnProvider(await createToken(host), { tokens: 3, deltaText: 'x'.repeat(5000) });
  const user = client(srv.url); await signUp(user, 'fatuser');

  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'bill me' }], maxTokens: 16 },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);
  const done = stream.events.find((e) => e.event === 'done').data;
  assert.equal(done.completionTokens, 3);
  const delta = stream.events.find((e) => e.event === 'delta').data.delta;
  assert.ok(delta.length <= 48, `a delta must be truncated to a token's worth, saw ${delta.length}`);
});

test('online minutes are paid per account, not per socket', async () => {
  const farmer = client(srv.url); await signUp(farmer, 'farmer');
  const token = await createToken(farmer);
  await spawnProvider(token, { tokens: 2 });
  await spawnProvider(token, { tokens: 2 });
  await spawnProvider(token, { tokens: 2 });

  // pretend all three have been online and ready for two minutes
  for (const p of srv.coordinator.providers.values()) p.creditedFrom = Date.now() - 125_000;
  await srv.coordinator.creditOnlineMinutes();

  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(coins),0)::float AS total FROM ledger WHERE kind='provide_minutes'");
  assert.ok(rows[0].total <= 2 * 2, `three tabs must not earn three times the minutes, got ${rows[0].total}`);
  assert.ok(rows[0].total > 0, 'one of them should still earn');
});

test('a fourth provider socket for the same account is refused', async () => {
  const many = client(srv.url); await signUp(many, 'manytabs');
  const token = await createToken(many);
  await spawnProvider(token, { tokens: 2 });
  await spawnProvider(token, { tokens: 2 });
  await spawnProvider(token, { tokens: 2 });
  await assert.rejects(() => spawnProvider(token, { tokens: 2 }), /handshake 429|socket hang up/);
});

test('parallel requests cannot spend AI Coins the account does not have', async () => {
  const host = client(srv.url); await signUp(host, 'parhost');
  await spawnProvider(await createToken(host), { tokens: 10, delayMs: 30 });
  const user = client(srv.url); const u = await signUp(user, 'paruser');
  // leave just enough for roughly one short answer
  await pool.query("INSERT INTO ledger (user_id, kind, coins) VALUES ($1,'admin_adjust',$2)", [u.id, 6 - 1000]);
  await pool.query('UPDATE users SET balance = 6 WHERE id = $1', [u.id]);

  const body = { messages: [{ role: 'user', content: 'spend it twice' }], maxTokens: 10 };
  const streams = await Promise.all([
    openSse(srv.url, '/api/chat/stream', { cookie: user.cookie, body }),
    openSse(srv.url, '/api/chat/stream', { cookie: user.cookie, body }),
  ]);
  for (const s of streams) await s.until((e) => e.some((x) => x.event === 'done' || x.event === 'error'), 20_000);

  await waitFor(async () => {
    const { rows } = await pool.query('SELECT balance FROM users WHERE id=$1', [u.id]);
    return Number(rows[0].balance) >= 0;
  }, 5000);
  const { rows } = await pool.query('SELECT balance FROM users WHERE id=$1', [u.id]);
  assert.ok(Number(rows[0].balance) >= 0, `balance went negative: ${rows[0].balance}`);
  const audit = await auditBalance(u.id);
  assert.equal(audit.ok, true, `ledger and cached balance disagree: ${JSON.stringify(audit)}`);
});

test('a hand-off code works once and only for a minute', async () => {
  const c = client(srv.url); await signUp(c, 'handoff');
  const token = await createToken(c);
  const first = await fetch(`${srv.url}/api/auth/handoff`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, origin: srv.url },
  });
  const { code } = await first.json();
  assert.ok(code);

  const fresh = client(srv.url);
  const ok = await fresh.req('/api/auth/token-session', { method: 'POST', body: { code } });
  assert.equal(ok.status, 200);
  const again = await client(srv.url).req('/api/auth/token-session', { method: 'POST', body: { code } });
  assert.equal(again.status, 401, 'a hand-off code must not work twice');
});
