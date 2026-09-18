/**
 * The free fallback model: what happens when the swarm is empty.
 *
 * The rules being pinned down here are the ones a user could be cheated by if they
 * silently broke - that a fallback answer is always labelled as one, that no volunteer
 * is paid for work they did not do, that the swarm still gets first refusal, and that
 * the thing which costs real money cannot be used without limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, resetDb, client, signUp, createToken, openSse, waitFor, pool, TEST_KEY } from '../helpers.js';
import { MockProvider } from '../mock-provider.js';
import { startFakeUpstream } from '../fake-upstream.js';
import { config } from '../../server/config.js';

let srv;
const providers = [];
const upstreams = [];

const spawnProvider = async (token, opts = {}) => {
  const p = new MockProvider({ url: srv.url, token, testKey: TEST_KEY, ...opts });
  providers.push(p);
  await p.connect();
  return p;
};

const fakeUpstream = async (opts) => {
  const u = await startFakeUpstream(opts);
  upstreams.push(u);
  return u;
};

const balanceOf = async (username) => {
  const { rows } = await pool.query('SELECT balance FROM users WHERE username_lower = $1', [username.toLowerCase()]);
  return Number(rows[0].balance);
};

/**
 * The config is read at import time, so a test points the live object at its own fake
 * upstream. Every read in the coordinator goes through this object, so this is exactly
 * what a deployment with FALLBACK_UPSTREAMS set would look like.
 */
const useFallback = (upstreamList, overrides = {}) => {
  Object.assign(config.fallback, {
    enabled: true,
    upstreams: upstreamList,
    queueWaitMs: 150,
    coinsFlat: 5,
    perAccountPerHour: 20,
    perIpPerHour: 30,
    globalPerDay: 500,
    maxNewTokens: 512,
    timeoutMs: 5000,
    firstTokenMs: 2000,
    ...overrides,
  });
};

const upstreamEntry = (u, label = 'Fake Free Model', extra = {}) => ({
  label, baseUrl: u.baseUrl, model: 'free/fake-model', apiKey: 'test-key', noThinking: true, headers: {}, ...extra,
});

let originalFallback;
test.before(async () => {
  srv = await startTestServer();
  originalFallback = { ...config.fallback };
});
test.after(async () => {
  for (const p of providers) p.close();
  for (const u of upstreams) await u.close();
  Object.assign(config.fallback, originalFallback);
  await srv.close();
  await pool.end();
});
test.beforeEach(async () => {
  for (const p of providers.splice(0)) p.close();
  for (const u of upstreams.splice(0)) await u.close();
  Object.assign(config.fallback, originalFallback);
  srv.coordinator.fallbackToday = { day: new Date().toISOString().slice(0, 10), used: 0 };
  srv.coordinator.fallbackByAccount.hits.clear();
  srv.coordinator.fallbackByIp.hits.clear();
  await resetDb();
});

test('with nobody online the free fallback answers, says so, and charges the flat rate', async () => {
  const u = await fakeUpstream({ text: 'The swarm was empty, so I answered.' });
  useFallback([upstreamEntry(u)]);

  const user = client(srv.url); await signUp(user, 'fbuser1');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'anybody there?' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  // The label is not optional: it must arrive before the answer does.
  const notice = stream.events.find((e) => e.event === 'fallback');
  assert.ok(notice, `expected a fallback event, saw ${JSON.stringify(stream.events.map((e) => e.event))}`);
  assert.equal(notice.data.servedBy, 'fallback');
  assert.equal(notice.data.model, 'Fake Free Model');
  assert.equal(notice.data.notice,
    'No community GPU online right now — answered by a free fallback model (Fake Free Model).');
  const firstDelta = stream.events.findIndex((e) => e.event === 'delta');
  assert.ok(stream.events.indexOf(notice) < firstDelta, 'the notice must precede the first token');

  const text = stream.events.filter((e) => e.event === 'delta').map((e) => e.data.delta).join('');
  assert.equal(text, 'The swarm was empty, so I answered.');

  const done = stream.events.find((e) => e.event === 'done').data;
  assert.equal(done.status, 'done');
  assert.equal(done.servedBy, 'fallback');
  assert.equal(done.fallbackModel, 'Fake Free Model');
  // Flat, regardless of how long the answer was.
  assert.equal(done.coinsCharged, 5);
  assert.equal(await balanceOf('fbuser1'), 1000 - 5);

  const { rows } = await pool.query('SELECT served_by, fallback_model, provider_user_id FROM jobs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].served_by, 'fallback');
  assert.equal(rows[0].fallback_model, 'Fake Free Model');
  assert.equal(rows[0].provider_user_id, null, 'no volunteer may be credited with a fallback answer');

  const ledger = await pool.query("SELECT kind, coins FROM ledger WHERE kind LIKE 'consume%'");
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].kind, 'consume_fallback');
  assert.equal(Number(ledger.rows[0].coins), -5);
  const paid = await pool.query("SELECT count(*)::int AS n FROM ledger WHERE kind = 'serve_tokens'");
  assert.equal(paid.rows[0].n, 0, 'nobody may earn AI Coins for a fallback answer');
});

test('a volunteer who is online still gets the job - the fallback does not steal traffic', async () => {
  const u = await fakeUpstream({ text: 'I should not be used.' });
  useFallback([upstreamEntry(u)]);

  const host = client(srv.url); await signUp(host, 'fbhost');
  await spawnProvider(await createToken(host), { tokens: 5 });

  const user = client(srv.url); await signUp(user, 'fbuser2');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'hello swarm' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  assert.equal(stream.events.filter((e) => e.event === 'fallback').length, 0);
  const done = stream.events.find((e) => e.event === 'done').data;
  assert.equal(done.servedBy, 'community');
  assert.equal(u.calls.length, 0, 'the fallback upstream must not have been called at all');
  // The volunteer is paid as before.
  assert.equal(await balanceOf('fbhost'), 1000 + 5 * 0.5);
});

test('a volunteer who dies mid-answer is replaced by the fallback, and the half answer is dropped', async () => {
  const u = await fakeUpstream({ text: 'A complete answer from the fallback.' });
  useFallback([upstreamEntry(u)]);

  const host = client(srv.url); await signUp(host, 'fbhost2');
  // Streams three tokens, then the lid closes.
  await spawnProvider(await createToken(host), { tokens: 9, dropAfter: 3 });

  const user = client(srv.url); await signUp(user, 'fbuser3');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'finish this' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 20_000);

  // The consumer is told to throw away what the dead volunteer sent, so the two answers
  // are never glued together.
  const resetAt = stream.events.findIndex((e) => e.event === 'reset');
  assert.ok(resetAt !== -1, `expected a reset event, saw ${JSON.stringify(stream.events.map((e) => e.event))}`);
  const after = stream.events.slice(resetAt).filter((e) => e.event === 'delta').map((e) => e.data.delta).join('');
  assert.equal(after, 'A complete answer from the fallback.');

  const done = stream.events.find((e) => e.event === 'done').data;
  assert.equal(done.servedBy, 'fallback');
  assert.equal(done.coinsCharged, 5);
  // The volunteer who dropped out earns nothing for the fragment.
  assert.equal(await balanceOf('fbhost2'), 1000);
});

test('the OpenAI API labels a fallback answer in the header and in the body', async () => {
  const u = await fakeUpstream({ text: 'API fallback answer.', usageTokens: 7 });
  useFallback([upstreamEntry(u, 'Fake Free Model')]);

  const user = client(srv.url); await signUp(user, 'fbapi');
  const token = await createToken(user);
  const res = await user.req('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { model: 'bonsai-swarm/ternary-bonsai-2-27b', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-bonsai-served-by'), 'fallback');
  assert.equal(res.headers.get('x-bonsai-fallback-model'), 'Fake Free Model');
  assert.equal(res.json.choices[0].message.content, 'API fallback answer.');
  assert.equal(res.json.bonsai_swarm.served_by, 'fallback');
  assert.equal(res.json.bonsai_swarm.fallback_model, 'Fake Free Model');
  assert.equal(res.json.bonsai_swarm.coins_charged, 5);
  // The upstream's own count is preferred over our character estimate.
  assert.equal(res.json.usage.completion_tokens, 7);
  // The model id stays the network's, so existing clients keep working.
  assert.equal(res.json.model, 'bonsai-swarm/ternary-bonsai-2-27b');
});

test('a community answer still says served_by community', async () => {
  const u = await fakeUpstream();
  useFallback([upstreamEntry(u)]);
  const host = client(srv.url); await signUp(host, 'fbhost3');
  await spawnProvider(await createToken(host), { tokens: 4 });

  const user = client(srv.url); await signUp(user, 'fbapi2');
  const token = await createToken(user);
  const res = await user.req('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { model: 'bonsai-swarm/ternary-bonsai-2-27b', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-bonsai-served-by'), 'community');
  assert.equal(res.json.bonsai_swarm.served_by, 'community');
  assert.equal(res.json.bonsai_swarm.fallback_model, null);
});

test('a dead first upstream falls through to the next one', async () => {
  const broken = await fakeUpstream({ mode: 'error' });
  const good = await fakeUpstream({ text: 'Second upstream speaking.' });
  useFallback([upstreamEntry(broken, 'Broken Model'), upstreamEntry(good, 'Working Model')]);

  const user = client(srv.url); await signUp(user, 'fbchain');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'try again' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  const notice = stream.events.find((e) => e.event === 'fallback');
  assert.equal(notice.data.model, 'Working Model', 'the label must name the model that actually answered');
  const text = stream.events.filter((e) => e.event === 'delta').map((e) => e.data.delta).join('');
  assert.equal(text, 'Second upstream speaking.');
  assert.equal(broken.calls.length, 1);
  assert.equal(good.calls.length, 1);
});

test('an upstream that only thinks and never answers counts as a failure', async () => {
  const thinker = await fakeUpstream({ mode: 'reasoning-only' });
  const good = await fakeUpstream({ text: 'An actual answer.' });
  useFallback([upstreamEntry(thinker, 'Thinker'), upstreamEntry(good, 'Answerer')]);

  const user = client(srv.url); await signUp(user, 'fbthink');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'think about it' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  assert.equal(stream.events.find((e) => e.event === 'fallback').data.model, 'Answerer');
  const text = stream.events.filter((e) => e.event === 'delta').map((e) => e.data.delta).join('');
  assert.equal(text, 'An actual answer.');
  // Thinking is asked to be switched off in the first place.
  assert.deepEqual(thinker.calls[0].body.chat_template_kwargs, { enable_thinking: false });
});

test('the per-account hourly limit stops one account from using the whole budget', async () => {
  const u = await fakeUpstream({ text: 'ok' });
  useFallback([upstreamEntry(u)], { perAccountPerHour: 2 });

  const user = client(srv.url); await signUp(user, 'fblimit');
  for (let i = 0; i < 2; i += 1) {
    const s = await openSse(srv.url, '/api/chat/stream', {
      cookie: user.cookie, body: { messages: [{ role: 'user', content: `q${i}` }] },
    });
    await s.until((e) => e.some((x) => x.event === 'done'), 15_000);
    assert.equal(s.events.find((e) => e.event === 'done').data.servedBy, 'fallback');
  }
  const blocked = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'one too many' }] },
  });
  await blocked.until((e) => e.some((x) => x.event === 'error'), 15_000);
  const err = blocked.events.find((e) => e.event === 'error').data;
  assert.equal(err.code, 'fallback_account_limit');
  assert.match(err.error, /2 times this hour/);
  assert.equal(u.calls.length, 2, 'the upstream must not be called once the limit is reached');
});

test('the global daily cap stops the whole site, and is restored from the database', async () => {
  const u = await fakeUpstream({ text: 'ok' });
  useFallback([upstreamEntry(u)], { globalPerDay: 1 });

  const a = client(srv.url); await signUp(a, 'fbglobal1');
  const first = await openSse(srv.url, '/api/chat/stream', {
    cookie: a.cookie, body: { messages: [{ role: 'user', content: 'first' }] },
  });
  await first.until((e) => e.some((x) => x.event === 'done'), 15_000);
  assert.equal(first.events.find((e) => e.event === 'done').data.servedBy, 'fallback');

  // A different account, so only the site-wide cap can stop this one.
  const b = client(srv.url); await signUp(b, 'fbglobal2');
  const second = await openSse(srv.url, '/api/chat/stream', {
    cookie: b.cookie, body: { messages: [{ role: 'user', content: 'second' }] },
  });
  await second.until((e) => e.some((x) => x.event === 'error'), 15_000);
  assert.equal(second.events.find((e) => e.event === 'error').data.code, 'fallback_daily_cap');
  assert.equal(u.calls.length, 1);

  // A restart must not hand out a fresh daily budget.
  srv.coordinator.fallbackToday = { day: 'stale', used: 0 };
  await srv.coordinator.loadFallbackUsage();
  assert.equal(srv.coordinator.fallbackUsedToday(), 1);
});

test('with no upstream configured the old behaviour is untouched', async () => {
  Object.assign(config.fallback, { ...originalFallback, enabled: false, upstreams: [] });
  const user = client(srv.url); await signUp(user, 'fbnone');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'nobody home' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'queued'), 5000);
  await new Promise((r) => setTimeout(r, 400));
  // Still queued, waiting for a volunteer, exactly as before the fallback existed.
  assert.equal(stream.events.filter((e) => e.event === 'fallback').length, 0);
  assert.equal(srv.coordinator.stats().queueLength, 1);
  stream.abort();
  await waitFor(async () => srv.coordinator.stats().queueLength === 0, 5000);
});

test('the fallback is never sent a prompt it was not given, and never sees the account', async () => {
  const u = await fakeUpstream({ text: 'ok' });
  useFallback([upstreamEntry(u)]);
  const user = client(srv.url); await signUp(user, 'fbprivacy');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'a private question' }] },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 15_000);

  const sent = u.calls[0].body;
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'a private question' }]);
  const asText = JSON.stringify(sent);
  assert.equal(asText.includes('fbprivacy'), false, 'the upstream must not learn who asked');
  // And the prompt is still not stored on our side.
  const { rows } = await pool.query('SELECT * FROM jobs');
  assert.equal(Object.keys(rows[0]).some((k) => /prompt_text|content|messages/.test(k)), false);
});
