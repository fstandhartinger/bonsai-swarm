/**
 * Usage statistics.
 *
 * Two audiences, two shapes:
 *
 *  - `publicStats()` is the handful of numbers on the landing page. Totals only, nothing
 *    about any individual, no authentication needed.
 *  - `operatorReport()` is the dashboard behind the operator token: signups, daily active
 *    accounts, jobs and tokens per day split by who answered, providers online over time
 *    split into house and community GPUs, waiting times, the AI Coins economy, and the
 *    aggregate page counts from server/visit-stats.js.
 *
 * Everything is derived from rows the app already keeps (the ledger, the jobs table, the
 * provider sessions) - no prompt, answer or IP address is read anywhere in this file, and
 * "active" means "this account sent or served a request that day", nothing finer.
 *
 * House accounts (our own rented GPUs) are flagged `users.is_house`, so the dashboard can
 * show honestly how much of the network is us and how much is real volunteers.
 */
import { pool } from './db.js';
import { config } from './config.js';
import { visitReport } from './visit-stats.js';

const clampDays = (days, max = 180) => Math.max(1, Math.min(max, Math.floor(Number(days) || 30)));

/** A YYYY-MM-DD -> value map turned into a dense series, so a chart has no gaps. */
export function densify(rows, days, keys, today = new Date()) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const row = byDay.get(d) || {};
    const entry = { day: d };
    for (const k of keys) entry[k] = Number(row[k] || 0);
    out.push(entry);
  }
  return out;
}

/** The small strip on the landing page: no identifiers, no per-account anything. */
export async function publicStats(coordinator) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users WHERE NOT COALESCE(is_house, false))::int AS accounts,
      (SELECT count(*) FROM users WHERE NOT COALESCE(is_house, false)
         AND created_at > now() - interval '24 hours')::int AS accounts_today,
      (SELECT COALESCE(sum(completion_tokens), 0) FROM jobs
         WHERE created_at > now() - interval '24 hours' AND NOT is_mock)::bigint AS tokens_today,
      (SELECT COALESCE(sum(completion_tokens), 0) FROM jobs WHERE NOT is_mock)::bigint AS tokens_total,
      (SELECT count(*) FROM jobs WHERE created_at > now() - interval '24 hours' AND NOT is_mock)::int AS jobs_today,
      (SELECT COALESCE(sum(coins), 0) FROM ledger WHERE coins > 0)::numeric AS coins_issued`);
  const r = rows[0];
  const live = coordinator ? coordinator.stats() : {};
  return {
    accounts: r.accounts,
    accountsToday: r.accounts_today,
    tokensToday: Number(r.tokens_today),
    tokensTotal: Number(r.tokens_total),
    jobsToday: r.jobs_today,
    coinsIssued: Math.round(Number(r.coins_issued)),
    providersOnline: live.providersOnline ?? 0,
    providersReady: live.providersReady ?? 0,
    capacityTps: live.capacityTps ?? 0,
  };
}

/**
 * Live supply and demand for the autoscaler on Sandy (`~/bin/bonsai-autoscale`).
 * Small, cheap and stable on purpose: it is polled every two minutes forever.
 */
export async function scalingSignal(coordinator) {
  const live = coordinator.stats();
  const waiting = coordinator.queueWaits ? coordinator.queueWaits() : [];
  const { rows } = await pool.query(`
    SELECT COALESCE(avg(wait_ms), 0)::int AS avg_wait_ms
      FROM jobs WHERE created_at > now() - interval '10 minutes' AND NOT is_mock AND wait_ms IS NOT NULL`);
  const house = await pool.query('SELECT id FROM users WHERE COALESCE(is_house, false)');
  const houseIds = new Set(house.rows.map((r) => Number(r.id)));
  const providers = coordinator.providerSnapshot ? coordinator.providerSnapshot() : [];
  const houseLive = providers.filter((p) => houseIds.has(Number(p.userId)));
  return {
    ...live,
    // seconds, because that is what the autoscaler's thresholds are written in
    avgWaitSeconds: Math.round(Number(rows[0].avg_wait_ms) / 100) / 10,
    oldestWaitSeconds: waiting.length ? Math.round(Math.max(...waiting) / 100) / 10 : 0,
    houseOnline: houseLive.length,
    houseReady: houseLive.filter((p) => p.state === 'ready').length,
    houseBusy: houseLive.filter((p) => p.state === 'busy').length,
    communityReady: providers.filter((p) => !houseIds.has(Number(p.userId)) && p.state === 'ready').length,
    at: new Date().toISOString(),
  };
}

/** Everything the operator dashboard draws. One call, so the page is one request. */
export async function operatorReport({ days = 30 } = {}) {
  const n = clampDays(days);
  const window = `now() - interval '${n} days'`;

  const [users, signupSeries, activeSeries, jobSeries, tokenSeries, providerSeries,
    coinSeries, coinTotals, fallbackTotals, visits] = await Promise.all([
    pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7,
             count(*) FILTER (WHERE COALESCE(is_house, false))::int AS house,
             count(*) FILTER (WHERE last_login_at > now() - interval '7 days')::int AS returning7
        FROM users`),
    pool.query(`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS signups
        FROM users WHERE created_at > ${window} GROUP BY 1 ORDER BY 1`),
    // Active = sent a prompt or served one that day. Both sides count as "using it".
    pool.query(`
      SELECT day, count(DISTINCT user_id)::int AS active FROM (
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, consumer_id AS user_id
          FROM jobs WHERE created_at > ${window} AND consumer_id IS NOT NULL AND NOT is_mock
        UNION ALL
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, provider_user_id AS user_id
          FROM jobs WHERE created_at > ${window} AND provider_user_id IS NOT NULL AND NOT is_mock
      ) t GROUP BY day ORDER BY day`),
    pool.query(`
      SELECT to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             count(*)::int AS jobs,
             count(*) FILTER (WHERE j.status = 'done')::int AS done,
             count(*) FILTER (WHERE j.status <> 'done')::int AS failed,
             COALESCE(avg(j.wait_ms) FILTER (WHERE j.wait_ms IS NOT NULL), 0)::int AS avg_wait_ms,
             -- only GPU answers: a hosted fallback model's speed is not the swarm's speed
             COALESCE(avg(j.decode_tps) FILTER (
               WHERE j.decode_tps IS NOT NULL AND j.served_by = 'community'), 0)::numeric(10,1) AS avg_tps
        FROM jobs j WHERE j.created_at > ${window} AND NOT j.is_mock GROUP BY 1 ORDER BY 1`),
    // Who actually produced the tokens: a volunteer, one of our own rented GPUs, or the
    // free hosted fallback. The distinction is the honest part of the whole project.
    pool.query(`
      SELECT to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COALESCE(sum(j.completion_tokens) FILTER (
               WHERE j.served_by = 'community' AND NOT COALESCE(u.is_house, false)), 0)::bigint AS community,
             COALESCE(sum(j.completion_tokens) FILTER (
               WHERE j.served_by = 'community' AND COALESCE(u.is_house, false)), 0)::bigint AS house,
             COALESCE(sum(j.completion_tokens) FILTER (WHERE j.served_by = 'fallback'), 0)::bigint AS fallback
        FROM jobs j LEFT JOIN users u ON u.id = j.provider_user_id
       WHERE j.created_at > ${window} AND NOT j.is_mock GROUP BY 1 ORDER BY 1`),
    // Providers online over time, from the session rows - a session counts for every hour
    // it overlapped, so the shape of the curve is real and not a sampling artefact.
    pool.query(`
      SELECT to_char(h.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00') AS hour,
             count(s.id) FILTER (WHERE COALESCE(u.is_house, false))::int AS house,
             count(s.id) FILTER (WHERE NOT COALESCE(u.is_house, false))::int AS community
        FROM generate_series(date_trunc('hour', now() AT TIME ZONE 'UTC') - interval '${Math.min(n, 14)} days',
                             date_trunc('hour', now() AT TIME ZONE 'UTC'), interval '1 hour') AS h(hour)
        -- count(s.id), not count(*): an hour with no session at all must read zero, and
        -- an outer-joined NULL row is not a community GPU.
        LEFT JOIN provider_sessions s
               ON s.admitted AND NOT s.is_mock
              AND (s.connected_at AT TIME ZONE 'UTC') < h.hour + interval '1 hour'
              AND (s.disconnected_at IS NULL OR (s.disconnected_at AT TIME ZONE 'UTC') >= h.hour)
        LEFT JOIN users u ON u.id = s.user_id
       GROUP BY 1 ORDER BY 1`),
    pool.query(`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COALESCE(sum(coins) FILTER (WHERE coins > 0), 0)::numeric(20,1) AS issued,
             COALESCE(-sum(coins) FILTER (WHERE coins < 0), 0)::numeric(20,1) AS spent
        FROM ledger WHERE created_at > ${window} GROUP BY 1 ORDER BY 1`),
    pool.query(`
      SELECT kind, sum(coins)::numeric(20,1) AS coins, count(*)::int AS entries
        FROM ledger GROUP BY kind ORDER BY kind`),
    pool.query(`
      SELECT count(*)::int AS jobs,
             count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS jobs_today,
             COALESCE(sum(completion_tokens), 0)::bigint AS tokens
        FROM jobs WHERE served_by = 'fallback'`),
    visitReport((text, params) => pool.query(text, params), n),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    days: n,
    users: {
      total: users.rows[0].total,
      house: users.rows[0].house,
      today: users.rows[0].today,
      last7: users.rows[0].last7,
      returning7: users.rows[0].returning7,
    },
    signups: densify(signupSeries.rows, n, ['signups']),
    activeUsers: densify(activeSeries.rows, n, ['active']),
    jobs: densify(jobSeries.rows, n, ['jobs', 'done', 'failed', 'avg_wait_ms', 'avg_tps']),
    tokens: densify(tokenSeries.rows, n, ['community', 'house', 'fallback']),
    providersOnline: providerSeries.rows,
    coins: densify(coinSeries.rows, n, ['issued', 'spent']),
    coinTotals: coinTotals.rows,
    fallback: {
      jobs: fallbackTotals.rows[0].jobs,
      jobsToday: fallbackTotals.rows[0].jobs_today,
      tokens: Number(fallbackTotals.rows[0].tokens),
      enabled: config.fallback.enabled,
    },
    visits,
  };
}
