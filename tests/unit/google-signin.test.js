/**
 * Sign-in is Google-only (18 Sep 2026). These tests run a server that *has* an OAuth
 * client, which the other suites deliberately do not, so both worlds stay covered:
 * there, passwords still work; here, they must not.
 *
 * Google itself is stood in for by a stubbed `fetch`. The code path under test is the
 * one that matters - state, PKCE, the claims check, what ends up in the database and
 * where the visitor is sent - and none of that needs a real round trip to Google.
 */
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const { startTestServer, resetDb, client, pool } = await import('../helpers.js');
const { migrate } = await import('../../server/db.js');
const { hashPassword } = await import('../../server/auth.js');

let srv;
const realFetch = globalThis.fetch;

test.before(async () => { srv = await startTestServer(); });
test.after(async () => { globalThis.fetch = realFetch; await srv.close(); await pool.end(); });
test.beforeEach(resetDb);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Answers the one call `googleExchange` makes, with the claims a test asks for. */
function stubGoogle(claims, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://oauth2.googleapis.com/token') return realFetch(url, init);
    const idToken = `${b64({ alg: 'RS256' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...claims,
    })}.signature-not-checked`;
    return new Response(JSON.stringify({ id_token: idToken }), {
      status, headers: { 'content-type': 'application/json' },
    });
  };
}

/** Walks /google/start then /google/callback the way a browser would, cookies and all. */
async function signInWithGoogle(c, claims, { next } = {}) {
  const start = await c.req(`/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`,
    { raw: true, redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  stubGoogle(claims);
  return c.req(`/api/auth/google/callback?state=${state}&code=an-authorization-code`,
    { raw: true, redirect: 'manual' });
}

test('password sign-up and sign-in are refused once Google is the only way in', async () => {
  const c = client(srv.url);
  const up = await c.req('/api/auth/signup', { method: 'POST', body: { username: 'alice', password: 'correct-horse-battery' } });
  assert.equal(up.status, 403);
  assert.equal(up.json.error, 'google_required');

  const inn = await c.req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'correct-horse-battery' } });
  assert.equal(inn.status, 403);
  assert.equal(inn.json.error, 'google_required');

  // and nothing was created on the way past
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0].n, 0);
});

test('the config the login page reads says the password form is gone', async () => {
  const cfg = await client(srv.url).req('/api/config');
  assert.equal(cfg.json.googleEnabled, true);
  assert.equal(cfg.json.requireGoogleSignin, true);
});

test('/google/start asks Google for the three basic scopes and nothing else', async () => {
  const res = await client(srv.url).req('/api/auth/google/start', { raw: true, redirect: 'manual' });
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), ['email', 'openid', 'profile']);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('state'));
  assert.match(url.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/);
});

test('a first callback creates the account with its address and the welcome coins', async () => {
  const c = client(srv.url);
  const res = await signInWithGoogle(c, { sub: 'google-sub-1', email: 'erin@example.com', name: 'Erin' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/chat.html');

  const me = await c.req('/api/me');
  assert.equal(me.json.signedIn, true);
  assert.equal(me.json.user.displayName, 'Erin');
  assert.equal(me.json.user.email, 'erin@example.com');
  assert.equal(me.json.user.viaGoogle, true);
  assert.equal(me.json.user.balance, 1000);

  const { rows } = await pool.query('SELECT google_sub, email, password_hash FROM users');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].google_sub, 'google-sub-1');
  assert.equal(rows[0].password_hash, null, 'a Google account has no password to steal');
});

test('signing in again reuses the account instead of making a second one', async () => {
  await signInWithGoogle(client(srv.url), { sub: 'google-sub-2', email: 'f@example.com', name: 'Fay' });
  const second = client(srv.url);
  await signInWithGoogle(second, { sub: 'google-sub-2', email: 'f-new@example.com', name: 'Fay' });

  const { rows } = await pool.query('SELECT email FROM users');
  assert.equal(rows.length, 1, 'the same Google subject is the same account');
  assert.equal(rows[0].email, 'f-new@example.com', 'a changed address is carried over');

  const balance = await second.req('/api/me');
  assert.equal(balance.json.user.balance, 1000, 'the welcome budget is paid once, not per sign-in');
});

test('a callback whose state does not match the cookie is thrown away', async () => {
  const c = client(srv.url);
  await c.req('/api/auth/google/start', { raw: true, redirect: 'manual' });
  stubGoogle({ sub: 'attacker', email: 'a@example.com' });
  const res = await c.req('/api/auth/google/callback?state=not-the-one&code=x', { raw: true, redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/login.html?error=oauth_state');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0].n, 0);
});

test('an id_token minted for somebody else is refused', async () => {
  const c = client(srv.url);
  const start = await c.req('/api/auth/google/start', { raw: true, redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  stubGoogle({ sub: 'x', email: 'x@example.com', aud: 'a-different-clients-id' });
  const res = await c.req(`/api/auth/google/callback?state=${state}&code=x`, { raw: true, redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/login.html?error=oauth_failed');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0].n, 0);
});

test('the sign-in flow will not forward to another site', async () => {
  for (const hostile of ['https://evil.example/steal', '//evil.example', '\\\\evil.example']) {
    const c = client(srv.url);
    const res = await signInWithGoogle(c, { sub: `s-${hostile}`, email: 'g@example.com' }, { next: hostile });
    assert.equal(res.headers.get('location'), '/chat.html', `refused: ${hostile}`);
  }
  const ok = client(srv.url);
  const res = await signInWithGoogle(ok, { sub: 'local', email: 'h@example.com' }, { next: '/wallet.html' });
  assert.equal(res.headers.get('location'), '/wallet.html', 'a path on this site is kept');
});

test('a leftover password account is locked out and keeps its ledger', async () => {
  const { rows: [legacy] } = await pool.query(
    `INSERT INTO users (username, username_lower, password_hash, display_name)
     VALUES ('oldtimer','oldtimer',$1,'oldtimer') RETURNING *`, [await hashPassword('correct-horse-battery')]);
  await pool.query("INSERT INTO ledger (user_id, kind, coins) VALUES ($1,'welcome',1000)", [legacy.id]);

  await migrate();   // the lock runs on boot

  const { rows: [after] } = await pool.query('SELECT anon_locked, session_version FROM users WHERE id=$1', [legacy.id]);
  assert.equal(after.anon_locked, true);
  assert.equal(after.session_version, legacy.session_version + 1, 'open sessions end too');

  const { rows: [led] } = await pool.query('SELECT count(*)::int AS n FROM ledger WHERE user_id=$1', [legacy.id]);
  assert.equal(led.n, 1, 'the history is kept - only the way in is gone');

  // even with the escape hatch open, a locked account stays out
  const c = client(srv.url);
  const res = await c.req('/api/auth/login', {
    method: 'POST',
    headers: { 'x-test-mode-key': process.env.TEST_MODE_KEY },
    body: { username: 'oldtimer', password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 401);
});

test('our own GPUs and the operator account are never locked out', async () => {
  const hash = await hashPassword('correct-horse-battery');
  await pool.query(
    `INSERT INTO users (username, username_lower, password_hash, display_name, is_house)
     VALUES ('house-gpu-1','house-gpu-1',$1,'house-gpu-1', true)`, [hash]);
  await pool.query(
    `INSERT INTO users (username, username_lower, password_hash, display_name, is_admin)
     VALUES ('bonsai-ops','bonsai-ops',$1,'bonsai-ops', true)`, [hash]);

  await migrate();

  const { rows } = await pool.query('SELECT username, anon_locked FROM users ORDER BY username');
  assert.deepEqual(rows, [
    { username: 'bonsai-ops', anon_locked: false },
    { username: 'house-gpu-1', anon_locked: false },
  ]);
});

test('the display name can be changed, the address cannot', async () => {
  const c = client(srv.url);
  await signInWithGoogle(c, { sub: 'google-sub-9', email: 'ivy@example.com', name: 'Ivy' });

  const ok = await c.req('/api/me', { method: 'PATCH', body: { displayName: '  Ivy   the   Night Owl ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.displayName, 'Ivy the Night Owl');
  assert.equal(ok.json.user.email, 'ivy@example.com');

  const tooShort = await c.req('/api/me', { method: 'PATCH', body: { displayName: 'x' } });
  assert.equal(tooShort.status, 400);

  // the address is not a field the caller can set
  await c.req('/api/me', { method: 'PATCH', body: { displayName: 'Ivy', email: 'someone@else.example' } });
  const { rows } = await pool.query('SELECT email FROM users');
  assert.equal(rows[0].email, 'ivy@example.com');
});

test('signing out ends the session the callback issued', async () => {
  const c = client(srv.url);
  await signInWithGoogle(c, { sub: 'google-sub-10', email: 'j@example.com' });
  assert.equal((await c.req('/api/me')).json.signedIn, true);
  await c.req('/api/auth/logout', { method: 'POST' });
  assert.equal((await c.req('/api/me')).json.signedIn, false);
});
