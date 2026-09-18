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
}
