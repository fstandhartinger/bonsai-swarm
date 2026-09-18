/**
 * Levels, streaks, achievements and the opt-in leaderboard.
 *
 * Everything in here is *derived* from the append-only ledger and the jobs table -
 * nothing is ever written by a browser, and no counter exists that the real numbers
 * could drift away from. `evaluate()` only ever inserts achievement rows.
 */
import { pool } from './db.js';

/** Lifetime *earned* AI Coins decide the tier. Bonsai grows, so do you. */
export const LEVELS = [
  { level: 1, name: 'Seedling', at: 0 },
  { level: 2, name: 'Sprout', at: 500 },
  { level: 3, name: 'Sapling', at: 2_500 },
  { level: 4, name: 'Bonsai', at: 10_000 },
  { level: 5, name: 'Grove', at: 40_000 },
  { level: 6, name: 'Canopy', at: 150_000 },
  { level: 7, name: 'Old Growth', at: 500_000 },
];

export function levelFor(earned) {
  const e = Number(earned) || 0;
  let current = LEVELS[0];
  for (const l of LEVELS) if (e >= l.at) current = l;
  const next = LEVELS.find((l) => l.at > e) || null;
  const span = next ? next.at - current.at : 1;
  return {
    level: current.level,
    name: current.name,
    at: current.at,
    next: next ? { level: next.level, name: next.name, at: next.at } : null,
    progress: next ? Math.min(1, Math.max(0, (e - current.at) / span)) : 1,
    toNext: next ? Math.max(0, next.at - e) : 0,
  };
}

/**
 * Badges. `test` gets the stats object below and returns true when the badge is earned.
 * Adding a badge is safe: it is unlocked the next time the user's stats are evaluated.
 */
export const ACHIEVEMENTS = [
  { code: 'first_light', icon: '✨', name: 'First Light', hint: 'Serve your first request for a stranger', test: (s) => s.jobsServed >= 1 },
  { code: 'thousand', icon: '🧵', name: 'Thousand Tokens', hint: 'Generate 1,000 tokens for other people', test: (s) => s.tokensServed >= 1_000 },
  { code: 'hundred_k', icon: '🏭', name: 'Token Factory', hint: 'Generate 100,000 tokens for other people', test: (s) => s.tokensServed >= 100_000 },
  { code: 'night_owl', icon: '🦉', name: 'Night Owl', hint: 'Serve a request while it is night where you are', test: (s) => s.servedAtNight },
  { code: 'marathon', icon: '⏳', name: 'Marathon', hint: 'Share your GPU for six hours in total', test: (s) => s.minutesShared >= 360 },
  { code: 'streak_3', icon: '🔥', name: 'Three in a Row', hint: 'Share on three days in a row', test: (s) => s.streak >= 3 },
  { code: 'streak_7', icon: '🌋', name: 'Week of Giving', hint: 'Share on seven days in a row', test: (s) => s.streak >= 7 },
  { code: 'first_answer', icon: '💬', name: 'First Answer', hint: 'Get your first answer out of the swarm', test: (s) => s.jobsConsumed >= 1 },
  { code: 'net_positive', icon: '⚖️', name: 'Net Giver', hint: 'Earn more AI Coins than you spend (at least 1,000 earned)', test: (s) => s.earned >= 1_000 && s.earned > s.spent },
  { code: 'speed_demon', icon: '🚀', name: 'Speed Demon', hint: 'Pass admission at 30 tokens/s or more', test: (s) => s.bestDecodeTps >= 30 },
  { code: 'pioneer', icon: '🌱', name: 'Pioneer', hint: 'Be one of the first 100 accounts', test: (s) => s.userId <= 100 },
];

const ACHIEVEMENT_BY_CODE = new Map(ACHIEVEMENTS.map((a) => [a.code, a]));

/** Days (in the user's own timezone) on which they earned provider AI Coins. */
function streakFrom(days, tzOffsetMinutes) {
  if (!days.length) return { current: 0, best: 0, activeToday: false };
  const dayNumber = (date) => Math.floor((date.getTime() + tzOffsetMinutes * 60_000) / 86_400_000);
  const set = new Set(days.map((d) => dayNumber(new Date(d))));
  const today = dayNumber(new Date());
  const activeToday = set.has(today);

  let current = 0;
  for (let d = activeToday ? today : today - 1; set.has(d); d -= 1) current += 1;

  const sorted = [...set].sort((a, b) => a - b);
  let best = 0; let run = 0; let prev = null;
  for (const d of sorted) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, activeToday, days: sorted.length };
}

/** Everything the badges and the profile card need, in three queries. */
export async function statsFor(userId) {
  const id = Number(userId);
  const [totals, jobs, sessions, days, user] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(coins) FILTER (WHERE kind IN ('provide_minutes','serve_tokens')),0)::float AS earned,
              COALESCE(-SUM(coins) FILTER (WHERE kind IN ('consume_tokens','consume_fallback')),0)::float AS spent,
              COALESCE(SUM((meta->>'minutes')::int) FILTER (WHERE kind='provide_minutes'),0)::int AS minutes_shared,
              BOOL_OR(COALESCE((meta->>'night')::boolean,false)) FILTER (WHERE kind='serve_tokens') AS served_at_night
         FROM ledger WHERE user_id=$1`, [id]),
    pool.query(
      `SELECT COALESCE(SUM(completion_tokens) FILTER (WHERE provider_user_id=$1),0)::int AS tokens_served,
              COUNT(*) FILTER (WHERE provider_user_id=$1 AND completion_tokens>0)::int AS jobs_served,
              COALESCE(SUM(completion_tokens) FILTER (WHERE consumer_id=$1),0)::int AS tokens_consumed,
              COUNT(*) FILTER (WHERE consumer_id=$1 AND completion_tokens>0)::int AS jobs_consumed
         FROM jobs WHERE provider_user_id=$1 OR consumer_id=$1`, [id]),
    pool.query('SELECT COALESCE(MAX(decode_tps),0)::float AS best_tps FROM provider_sessions WHERE user_id=$1', [id]),
    pool.query("SELECT DISTINCT created_at FROM ledger WHERE user_id=$1 AND kind='provide_minutes' ORDER BY created_at DESC LIMIT 2000", [id]),
    pool.query('SELECT balance, tz_offset_minutes, leaderboard_opt_in, display_name, created_at FROM users WHERE id=$1', [id]),
  ]);
  if (!user.rows.length) return null;

  const tz = Number(user.rows[0].tz_offset_minutes) || 0;
  const streak = streakFrom(days.rows.map((r) => r.created_at), tz);
  return {
    userId: id,
    balance: Number(user.rows[0].balance),
    displayName: user.rows[0].display_name,
    memberSince: user.rows[0].created_at,
    leaderboardOptIn: user.rows[0].leaderboard_opt_in,
    earned: Number(totals.rows[0].earned),
    spent: Number(totals.rows[0].spent),
    minutesShared: Number(totals.rows[0].minutes_shared),
    servedAtNight: Boolean(totals.rows[0].served_at_night),
    tokensServed: Number(jobs.rows[0].tokens_served),
    jobsServed: Number(jobs.rows[0].jobs_served),
    tokensConsumed: Number(jobs.rows[0].tokens_consumed),
    jobsConsumed: Number(jobs.rows[0].jobs_consumed),
    bestDecodeTps: Number(sessions.rows[0].best_tps),
    streak: streak.current,
    bestStreak: streak.best,
    streakActiveToday: streak.activeToday,
    daysShared: streak.days || 0,
  };
}

/**
 * Unlocks every badge whose condition is now met.
 * @returns {{stats:object, unlocked:string[], all:object[]}} `unlocked` = newly earned this call.
 */
export async function evaluate(userId) {
  const stats = await statsFor(userId);
  if (!stats) return { stats: null, unlocked: [], all: [] };

  const have = new Map((await pool.query('SELECT code, unlocked_at FROM achievements WHERE user_id=$1', [userId]))
    .rows.map((r) => [r.code, r.unlocked_at]));

  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.code)) continue;
    let earned = false;
    try { earned = Boolean(a.test(stats)); } catch { earned = false; }
    if (!earned) continue;
    const res = await pool.query(
      'INSERT INTO achievements (user_id, code) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING unlocked_at',
      [userId, a.code]);
    if (res.rowCount) { unlocked.push(a.code); have.set(a.code, res.rows[0].unlocked_at); }
  }

  const all = ACHIEVEMENTS.map((a) => ({
    code: a.code, icon: a.icon, name: a.name, hint: a.hint,
    unlocked: have.has(a.code), unlockedAt: have.get(a.code) || null,
  }));
  return { stats, unlocked, all };
}

/** The whole profile card in one object, for GET /api/gamification. */
export async function profile(userId) {
  const { stats, unlocked, all } = await evaluate(userId);
  if (!stats) return null;
  return {
    coins: stats.balance,
    earned: stats.earned,
    spent: stats.spent,
    level: levelFor(stats.earned),
    streak: { current: stats.streak, best: stats.bestStreak, activeToday: stats.streakActiveToday, days: stats.daysShared },
    stats: {
      tokensServed: stats.tokensServed,
      jobsServed: stats.jobsServed,
      tokensConsumed: stats.tokensConsumed,
      jobsConsumed: stats.jobsConsumed,
      minutesShared: stats.minutesShared,
      bestDecodeTps: stats.bestDecodeTps,
      memberSince: stats.memberSince,
    },
    achievements: all,
    justUnlocked: unlocked.map((code) => {
      const a = ACHIEVEMENT_BY_CODE.get(code);
      return { code, icon: a.icon, name: a.name, hint: a.hint };
    }),
    leaderboardOptIn: stats.leaderboardOptIn,
  };
}

/**
 * Public provider leaderboard. Opt-in only, display name only - never a username,
 * never a balance, never anything about what anybody asked the network.
 */
export async function leaderboard(limit = 25) {
  const { rows } = await pool.query(`
    SELECT u.id, u.display_name,
           COALESCE(e.earned, 0)::float AS earned,
           COALESCE(j.tokens, 0)::int  AS tokens_served,
           COALESCE(j.jobs, 0)::int    AS jobs_served
      FROM users u
      LEFT JOIN v_lifetime_earned e ON e.user_id = u.id
      LEFT JOIN (SELECT provider_user_id, SUM(completion_tokens) AS tokens, COUNT(*) AS jobs
                   FROM jobs WHERE completion_tokens > 0 GROUP BY provider_user_id) j ON j.provider_user_id = u.id
     WHERE u.leaderboard_opt_in AND NOT u.disabled AND NOT COALESCE(u.is_house, false)
     ORDER BY earned DESC, tokens_served DESC
     LIMIT $1`, [Math.min(100, Number(limit) || 25)]);
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: Number(r.id),
    name: r.display_name,
    earned: Number(r.earned),
    tokensServed: r.tokens_served,
    jobsServed: r.jobs_served,
    level: levelFor(r.earned),
  }));
}

/**
 * Cheap fire-and-forget evaluation after a job or a minute credit. At most one run
 * per user every 20 s, so a busy provider does not hammer Postgres.
 */
const lastRun = new Map();
export function touch(userId, { minIntervalMs = 20_000 } = {}) {
  const id = Number(userId);
  if (!id) return;
  const now = Date.now();
  if (now - (lastRun.get(id) || 0) < minIntervalMs) return;
  lastRun.set(id, now);
  if (lastRun.size > 5_000) for (const [k, t] of lastRun) if (now - t > 600_000) lastRun.delete(k);
  evaluate(id).catch(() => { /* badges are cosmetic; never break a job over one */ });
}
