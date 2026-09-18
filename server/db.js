import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// numeric(20,6) must not become a float somewhere by accident - parse as Number here
// only for the columns we own, all of which stay far below 2^53 coins.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
  // Our own rented GPUs are marked here rather than by hand, so a rebuilt database keeps
  // telling house tokens and community tokens apart.
  const house = config.ops?.houseAccounts || [];
  if (house.length) {
    await pool.query('UPDATE users SET is_house = true WHERE username_lower = ANY($1) AND NOT is_house', [house]);
  }
  await lockAnonymousAccounts();
}

/**
 * Close the door behind the username-and-password era.
 *
 * Refusing `POST /api/auth/login` stops anyone signing in again, but a browser that
 * still holds a session cookie would keep full access for a month. Bumping
 * `session_version` ends those sessions too, which is what "sign-in with Google is
 * required" has to mean to be true.
 *
 * Only ever touches password accounts that are neither house nor admin - our own GPUs
 * and the operator tooling hold Bearer tokens, and a Bearer token does not carry a
 * session version. `anon_locked` makes it a one-off: a redeploy must not keep bumping
 * the version of accounts that were dealt with long ago.
 */
async function lockAnonymousAccounts() {
  if (!config.requireGoogleSignin) return;
  const { rowCount } = await pool.query(`
    UPDATE users SET anon_locked = true, session_version = session_version + 1
     WHERE NOT anon_locked AND google_sub IS NULL AND password_hash IS NOT NULL
       AND NOT COALESCE(is_house, false) AND NOT is_admin`);
  if (rowCount) console.log(`[db] locked ${rowCount} password account(s): sign-in is Google-only now`);
}
