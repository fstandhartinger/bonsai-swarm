/**
 * Usage statistics.
 *
 * Two things are worth pinning down here. First, that the operator dashboard cannot be
 * read without the token - it reports on everyone who uses the site. Second, that the
 * numbers mean what the dashboard says they mean: our own rented GPUs must never be
 * counted as community volunteers, and the page counter must never write down anything
 * that could identify a visitor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, resetDb, client, signUp, pool, TEST_KEY } from '../helpers.js';
import { MockProvider } from '../mock-provider.js';
import { config } from '../../server/config.js';
import {
  classifyRequest, normalisePath, createAccumulator, flushRows, visitReport, dayOf,
  stopVisitCounter, flushVisitsForTest,
} from '../../server/visit-stats.js';
import { densify, operatorReport, publicStats, scalingSignal } from '../../server/stats.js';

let srv;
const providers = [];
const OPS = 'ops-token-for-tests-0123456789';

const spawnProvider = async (token, opts = {}) => {
  const p = new MockProvider({ url: srv.url, token, testKey: TEST_KEY, ...opts });
  providers.push(p);
  await p.connect();
  return p;
};

test.before(async () => {
  srv = await startTestServer();
  config.ops.token = OPS;
});
test.after(async () => {
  for (const p of providers) p.close();
  await stopVisitCounter();
  await srv?.close();
  await pool.end();
});
test.beforeEach(async () => {
  await resetDb();
  await pool.query('TRUNCATE visit_daily');
});

// ------------------------------------------------------------------ access control

test('the operator dashboard is unreachable without the token', async () => {
  const c = client(srv.url);
  assert.equal((await c.req('/api/ops/stats')).status, 401);
  assert.equal((await c.req('/api/ops/stats', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await c.req('/api/ops/scaling')).status, 401);
  const ok = await c.req('/api/ops/stats', { headers: { authorization: `Bearer ${OPS}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
});

test('a signed-in ordinary account still cannot read it', async () => {
  const c = client(srv.url);
  await signUp(c, 'nosy-user');
  assert.equal((await c.req('/api/ops/stats')).status, 401);
  assert.equal((await c.req('/api/ops/enabled')).json.admin, false);
});

test('an admin account opens the dashboard with no shared secret at all', async () => {
  config.ops.token = '';
  try {
    const c = client(srv.url);
    const user = await signUp(c, 'the-operator');
    assert.equal((await c.req('/api/ops/stats')).status, 401, 'not admin yet');
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
    assert.equal((await c.req('/api/ops/stats')).status, 200);
    assert.equal((await c.req('/api/ops/enabled')).json.admin, true);

    // and with one of that account's API tokens, which is what the autoscaler uses
    const apiToken = (await c.req('/api/tokens', { method: 'POST', body: { name: 'ops' } })).json.token;
    const bare = client(srv.url);
    const viaToken = await bare.req('/api/ops/scaling', { headers: { authorization: `Bearer ${apiToken}` } });
    assert.equal(viaToken.status, 200);
  } finally {
    config.ops.token = OPS;
  }
});

// ------------------------------------------------------------------ the numbers

test('house GPUs are counted apart from community GPUs and never rank', async () => {
  const c = client(srv.url);
  const volunteer = await signUp(c, 'a-real-volunteer');
  const house = await signUp(client(srv.url), 'house-gpu-test');
  await pool.query('UPDATE users SET is_house = true WHERE id = $1', [house.id]);
  await pool.query('UPDATE users SET leaderboard_opt_in = true');
  await pool.query(`
    INSERT INTO jobs (id, consumer_id, provider_user_id, status, completion_tokens, served_by, decode_tps, wait_ms)
    VALUES ('j1', $1, $1, 'done', 100, 'community', 30, 400),
           ('j2', $1, $2, 'done', 250, 'community', 34, 900),
           ('j3', $1, NULL, 'done', 40, 'fallback', NULL, 20100)`, [volunteer.id, house.id]);

  const report = await operatorReport({ days: 7 });
  const today = report.tokens.at(-1);
  assert.equal(today.community, 100, 'only the volunteer counts as community');
  assert.equal(today.house, 250);
  assert.equal(today.fallback, 40);
  assert.equal(report.users.house, 1);
  assert.equal(report.fallback.jobs, 1);

  const board = await client(srv.url).req('/api/leaderboard');
  assert.ok(board.json.entries.every((e) => e.name !== 'house-gpu-test'), 'a house account never appears');
  assert.ok(board.json.entries.some((e) => e.name === 'a-real-volunteer'));

  // The public strip does not count our own accounts as users either.
  const pub = await publicStats(srv.coordinator);
  assert.equal(pub.accounts, 1);
  assert.equal(pub.tokensToday, 390);
});

test('an hour with nobody online reads zero, not one', async () => {
  const c = client(srv.url);
  const user = await signUp(c, 'a-provider');
  await pool.query(`
    INSERT INTO provider_sessions (id, user_id, admitted, connected_at, disconnected_at)
    VALUES ('s1', $1, true, now() - interval '30 minutes', NULL)`, [user.id]);
  const report = await operatorReport({ days: 2 });
  const hours = report.providersOnline;
  assert.equal(hours.at(-1).community, 1, 'the current hour has the live session');
  // An outer join leaves NULL rows for empty hours; they must not be counted as GPUs.
  assert.ok(hours.slice(0, -2).every((h) => h.community === 0 && h.house === 0),
    'hours before the session must be empty');
});

test('the hourly provider series is labelled in UTC, whatever the server clock is set to', async () => {
  // This server's Postgres session is Europe/Berlin. An hour bucket that is built in UTC
  // and then formatted through the session zone comes out two hours ahead, and the
  // dashboard axis silently lies about when a GPU was online.
  await pool.query("SET TIME ZONE 'Europe/Berlin'");
  try {
    const report = await operatorReport({ days: 1 });
    const expected = new Date().toISOString().slice(0, 14) + '00';
    assert.equal(report.providersOnline.at(-1).hour, expected,
      'the last bucket must be the current UTC hour');
  } finally {
    await pool.query('SET TIME ZONE DEFAULT');
  }
});

test('the daily series has one entry per day, gaps filled with zero', async () => {
  const rows = [{ day: new Date().toISOString().slice(0, 10), jobs: 5 }];
  const series = densify(rows, 7, ['jobs']);
  assert.equal(series.length, 7);
  assert.equal(series.at(-1).jobs, 5);
  assert.equal(series[0].jobs, 0);
});

test('the scaling signal tells house GPUs from community GPUs', async () => {
  const c = client(srv.url);
  await signUp(c, 'house-provider');
  await pool.query('UPDATE users SET is_house = true');
  const tokenRes = await c.req('/api/tokens', { method: 'POST', body: { name: 't' } });
  await spawnProvider(tokenRes.json.token);

  const signal = await scalingSignal(srv.coordinator);
  assert.equal(signal.houseOnline, 1);
  assert.equal(signal.communityReady, 0);
  assert.equal(typeof signal.avgWaitSeconds, 'number');
  assert.equal(signal.oldestWaitSeconds, 0, 'nothing is waiting');

  const viaHttp = await c.req('/api/ops/scaling', { headers: { authorization: `Bearer ${OPS}` } });
  assert.equal(viaHttp.json.houseOnline, 1);
});

test('the public strip needs no account and exposes no account', async () => {
  const res = await client(srv.url).req('/api/stats/public');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [
    'accounts', 'accountsToday', 'capacityTps', 'coinsIssued', 'jobsToday',
    'providersOnline', 'providersReady', 'tokensToday', 'tokensTotal',
  ]);
});

// ------------------------------------------------------------------ page counting

test('page loads are counted, everything else is not', () => {
  const page = (over = {}) => classifyRequest({
    method: 'GET', path: '/', headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-dest': 'document', ...over },
  });
  assert.equal(page().path, '/');
  assert.equal(page().visit, true, 'no referrer means it came from outside');
  assert.equal(page({ referer: 'https://bonsai-swarm.app.mintapis.com/chat.html' }).visit, false);
  assert.equal(page({ referer: 'https://news.ycombinator.com/' }).referrerHost, 'news.ycombinator.com');

  // Objection signals, bots, prefetches and non-documents are never counted.
  assert.equal(page({ 'sec-gpc': '1' }), null);
  assert.equal(page({ dnt: '1' }), null);
  assert.equal(page({ 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.1)' }), null);
  assert.equal(page({ 'sec-purpose': 'prefetch' }), null);
  assert.equal(page({ 'sec-fetch-dest': 'script' }), null);
  assert.equal(classifyRequest({ method: 'POST', path: '/', headers: { 'user-agent': 'x', 'sec-fetch-dest': 'document' } }), null);
});

test('the API, the runtime and static files are not pages', () => {
  assert.equal(normalisePath('/api/stats'), null);
  assert.equal(normalisePath('/runtime/bonsai2-lib.js'), null);
  assert.equal(normalisePath('/app.css'), null);
  assert.equal(normalisePath('/js/chat.js'), null);
  assert.equal(normalisePath('/chat.html'), '/chat.html');
  assert.equal(normalisePath('/index.html'), '/');
  assert.equal(normalisePath('/wp-admin'), '(unknown route)', 'scanners collapse into one row');
});

test('only daily totals are stored - no identifier reaches the database', async () => {
  const acc = createAccumulator();
  const now = Date.parse('2026-09-18T10:00:00Z');
  acc.add({ path: '/', referrerHost: 'x.com', visit: true }, now);
  acc.add({ path: '/', referrerHost: 'x.com', visit: true }, now);
  acc.add({ path: '/', referrerHost: '', visit: false }, now);
  assert.equal(acc.size(), 2, 'one row per day, page and referring host');

  await flushRows((text, params) => pool.query(text, params), acc.take());
  const { rows } = await pool.query('SELECT * FROM visit_daily ORDER BY referrer_host');
  assert.deepEqual(rows.map((r) => [r.path, r.referrer_host, r.views, r.visits]),
    [['/', '', 1, 0], ['/', 'x.com', 2, 2]]);
  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'visit_daily' ORDER BY column_name");
  assert.deepEqual(columns.rows.map((r) => r.column_name),
    ['day', 'path', 'referrer_host', 'views', 'visits']);
});

test('a failed write is retried, but stale totals are dropped rather than kept', () => {
  const acc = createAccumulator();
  const now = Date.parse('2026-09-18T10:00:00Z');
  acc.restore([
    { day: dayOf(now), path: '/', referrerHost: '', views: 3, visits: 1 },
    { day: '2026-01-01', path: '/', referrerHost: '', views: 9, visits: 9 },
  ], now);
  assert.equal(acc.size(), 1);
  assert.equal(acc.take()[0].views, 3);
});

test('the report never names a page with fewer than three page loads', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await flushRows((t, p) => pool.query(t, p), [
    { day: today, path: '/', referrerHost: '', views: 12, visits: 9 },
    { day: today, path: '/chat.html', referrerHost: '', views: 1, visits: 1 },
    { day: today, path: '(unknown route)', referrerHost: '', views: 2, visits: 2 },
  ]);
  const report = await visitReport((t, p) => pool.query(t, p), 7);
  const named = report.topPages.map((r) => r.path);
  assert.ok(named.includes('/'));
  assert.ok(!named.includes('/chat.html'), 'a single visit is folded away');
  assert.equal(report.topPages.find((r) => r.path === '(other)').views, 3);
  assert.equal(report.uniqueVisitors, null);
  assert.equal(report.totals.views, 15);
});

test('a real page request is counted end to end', async () => {
  await fetch(`${srv.url}/`, { headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-dest': 'document', accept: 'text/html' } });
  await flushVisitsForTest();
  const { rows } = await pool.query("SELECT views FROM visit_daily WHERE path = '/'");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].views >= 1);
});
