import { pool, withTransaction } from './db.js';
import { config } from './config.js';
import { roundCoins } from './util.js';

export const KINDS = ['welcome', 'provide_minutes', 'serve_tokens', 'consume_tokens', 'consume_fallback', 'admin_adjust'];

/**
 * Append one row to the ledger and move the cached balance in the same transaction.
 * The ledger is append-only; `users.balance` is only a cache and is re-checked by
 * `auditBalance()` in the tests.
 *
 * Debits (coins < 0) never take an account below zero: the UPDATE carries the
 * guard, and a caller that asked for more than is there gets `{ applied: false }`.
 */
export async function post(client, { userId, kind, coins, jobId = null, meta = {}, allowNegative = false }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown ledger kind ${kind}`);
  const amount = roundCoins(Number(coins));
  if (!Number.isFinite(amount)) throw new Error('coins must be a finite number');
  if (amount === 0) return { applied: true, balance: null, skipped: true };

  const guard = amount < 0 && !allowNegative ? 'AND balance + $2::numeric >= 0' : '';
  const upd = await client.query(
    `UPDATE users SET balance = balance + $2::numeric WHERE id = $1 ${guard} RETURNING balance`,
    [userId, amount],
  );
  if (upd.rowCount === 0) return { applied: false, balance: null };

  await client.query(
    `INSERT INTO ledger (user_id, kind, coins, job_id, meta) VALUES ($1,$2,$3,$4,$5)`,
    [userId, kind, amount, jobId, meta],
  );
  return { applied: true, balance: Number(upd.rows[0].balance) };
}

/** Convenience wrapper for a single-entry posting outside an existing transaction. */
export function postOne(entry) {
  return withTransaction((client) => post(client, entry));
}

export async function getBalance(userId) {
  const { rows } = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
  return rows.length ? Number(rows[0].balance) : null;
}

/** Cross-check the cached balance against the append-only ledger. Used by tests and /api/admin. */
export async function auditBalance(userId) {
  const { rows } = await pool.query(
    `SELECT u.balance AS cached, COALESCE(v.balance, 0) AS ledger
       FROM users u JOIN v_ledger_balance v ON v.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  if (!rows.length) return null;
  return { cached: Number(rows[0].cached), ledger: Number(rows[0].ledger), ok: Number(rows[0].cached) === Number(rows[0].ledger) };
}

export function costForJob(promptTokens, completionTokens) {
  const p = config.coins;
  return roundCoins(promptTokens * p.consumePromptPerToken + completionTokens * p.consumeCompletionPerToken);
}

export function earningsForJob(completionTokens) {
  return roundCoins(completionTokens * config.coins.servePerToken);
}

/**
 * How many new tokens this balance can pay for after the prompt is accounted for.
 * Returns 0 when the account cannot even afford the prompt.
 */
export function affordableCompletionTokens(balance, promptTokens) {
  const p = config.coins;
  const left = balance - promptTokens * p.consumePromptPerToken;
  if (left <= 0) return 0;
  if (p.consumeCompletionPerToken <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(left / p.consumeCompletionPerToken);
}

export async function recentLedger(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, kind, coins, job_id, meta, created_at FROM ledger
      WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(200, limit)],
  );
  return rows;
}
