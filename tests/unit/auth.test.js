import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, resetDb, client, signUp, pool } from '../helpers.js';
import { safeNext } from '../../server/auth.js';

let srv;
test.before(async () => { srv = await startTestServer(); });
test.after(async () => { await srv.close(); await pool.end(); });
test.beforeEach(resetDb);

test('anonymous signup creates an account with the welcome budget', async () => {
  const c = client(srv.url);
  const user = await signUp(c, 'alice');
  assert.equal(user.username, 'alice');
  assert.equal(user.balance, 1000);
  const me = await c.req('/api/me');
  assert.equal(me.json.signedIn, true);
  assert.equal(me.json.user.username, 'alice');
});

test('username and password are validated', async () => {
  const c = client(srv.url);
  const short = await c.req('/api/auth/signup', { method: 'POST', body: { username: 'ab', password: 'correct-horse-battery' } });
  assert.equal(short.status, 400);
  const weak = await c.req('/api/auth/signup', { method: 'POST', body: { username: 'bob', password: 'short' } });
  assert.equal(weak.status, 400);
  const bad = await c.req('/api/auth/signup', { method: 'POST', body: { username: 'bad name!', password: 'correct-horse-battery' } });
  assert.equal(bad.status, 400);
});

test('usernames are unique regardless of case', async () => {
  const c = client(srv.url);
  await signUp(c, 'Carol');
  const again = await client(srv.url).req('/api/auth/signup', { method: 'POST', body: { username: 'carol', password: 'correct-horse-battery' } });
  assert.equal(again.status, 409);
});

test('passwords are stored as argon2id hashes, never in clear', async () => {
  const c = client(srv.url);
  await signUp(c, 'dave', 'super-secret-password');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE username = $1', ['dave']);
  assert.match(rows[0].password_hash, /^\$argon2id\$/);
  assert.ok(!rows[0].password_hash.includes('super-secret-password'));
});

test('login works and a wrong password is rejected with the same message', async () => {
  await signUp(client(srv.url), 'erin', 'correct-horse-battery');
  const c = client(srv.url);
  const bad = await c.req('/api/auth/login', { method: 'POST', body: { username: 'erin', password: 'wrong-password-here' } });
  assert.equal(bad.status, 401);
  const missing = await c.req('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'wrong-password-here' } });
  assert.equal(missing.status, 401);
  assert.equal(bad.json.message, missing.json.message);
  const ok = await c.req('/api/auth/login', { method: 'POST', body: { username: 'erin', password: 'correct-horse-battery' } });
  assert.equal(ok.status, 200);
});

test('login is rate limited per account', async () => {
  await signUp(client(srv.url), 'frank');
  const c = client(srv.url);
  let sawLimit = false;
  for (let i = 0; i < 14; i += 1) {
    const res = await c.req('/api/auth/login', { method: 'POST', body: { username: 'frank', password: 'definitely-wrong' } });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'expected a 429 after repeated failures');
});

test('a tampered session cookie is not accepted', async () => {
  const c = client(srv.url);
  await signUp(c, 'grace');
  const forged = client(srv.url);
  const res = await forged.req('/api/me', { headers: { cookie: 'bsw_session=eyJ1aWQiOjEsInN2IjoxfQ.deadbeef' } });
  assert.equal(res.json.signedIn, false);
});

test('ordinary logout emits Max-Age=0 with the same flags the session was issued with', async () => {
  const c = client(srv.url);
  await signUp(c, 'logoutflags');
  const res = await c.req('/api/auth/logout', { method: 'POST' });
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie?.() || [];
  const session = setCookie.find((line) => line.startsWith('bsw_session='));
  assert.ok(session, 'logout must Set-Cookie the session cookie');
  assert.match(session, /Max-Age=0/i);
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
  assert.match(session, /Path=\//i);
});

test('token-session rejects a raw API token', async () => {
  const c = client(srv.url);
  await signUp(c, 'handofftoken');
  const created = await c.req('/api/tokens', { method: 'POST', body: { name: 'cli' } });
  const rejected = await client(srv.url).req('/api/auth/token-session', { method: 'POST', body: { token: created.json.token } });
  assert.equal(rejected.status, 401);
});

test('a hand-off code cannot be reused', async () => {
  const c = client(srv.url);
  await signUp(c, 'handoffonce');
  const created = await c.req('/api/tokens', { method: 'POST', body: { name: 'cli' } });
  const handoff = await fetch(`${srv.url}/api/auth/handoff`, {
    method: 'POST', headers: { authorization: `Bearer ${created.json.token}`, origin: srv.url },
  });
  const { code } = await handoff.json();
  const first = await client(srv.url).req('/api/auth/token-session', { method: 'POST', body: { code } });
  assert.equal(first.status, 200);
  const again = await client(srv.url).req('/api/auth/token-session', { method: 'POST', body: { code } });
  assert.equal(again.status, 401);
});

test('token-session refuses a browser already signed in as somebody else', async () => {
  const c = client(srv.url);
  await signUp(c, 'handoffowner');
  const created = await c.req('/api/tokens', { method: 'POST', body: { name: 'cli' } });
  const handoff = await fetch(`${srv.url}/api/auth/handoff`, {
    method: 'POST', headers: { authorization: `Bearer ${created.json.token}`, origin: srv.url },
  });
  const { code } = await handoff.json();
  const other = client(srv.url);
  await signUp(other, 'alreadyhere');
  const clash = await other.req('/api/auth/token-session', { method: 'POST', body: { code } });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, 'already_signed_in');
});

test('safeNext rejects protocol-relative and control-character targets', () => {
  assert.equal(safeNext('/chat.html'), '/chat.html');
  assert.equal(safeNext('https://evil.example'), '/chat.html');
  assert.equal(safeNext('//evil.example'), '/chat.html');
  assert.equal(safeNext('/\n/evil.example'), '/chat.html');
  assert.equal(safeNext('/\t/evil.example'), '/chat.html');
});

test('logout everywhere invalidates the old cookie', async () => {
  const c = client(srv.url);
  await signUp(c, 'heidi');
  const stolen = c.cookie;
  await c.req('/api/auth/logout-everywhere', { method: 'POST' });
  const res = await client(srv.url).req('/api/me', { headers: { cookie: stolen } });
  assert.equal(res.json.signedIn, false);
});

test('api tokens authenticate, are stored hashed and can be revoked', async () => {
  const c = client(srv.url);
  await signUp(c, 'ivan');
  const created = await c.req('/api/tokens', { method: 'POST', body: { name: 'cli' } });
  const token = created.json.token;
  assert.match(token, /^bsw_/);
  const { rows } = await pool.query('SELECT token_hash FROM api_tokens');
  assert.ok(!rows.some((r) => r.token_hash.includes(token.slice(4))), 'token must not be stored in clear');

  const bearer = client(srv.url);
  const me = await bearer.req('/api/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.json.user.username, 'ivan');

  const list = await c.req('/api/tokens');
  await c.req(`/api/tokens/${list.json.tokens[0].id}`, { method: 'DELETE' });
  const after = await client(srv.url).req('/api/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.json.signedIn, false);
});

test('a cookie request from a foreign origin is refused', async () => {
  const c = client(srv.url);
  await signUp(c, 'judy');
  const res = await c.req('/api/tokens', { method: 'POST', body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('protected endpoints refuse anonymous callers', async () => {
  const c = client(srv.url);
  for (const path of ['/api/tokens', '/api/ledger', '/api/jobs']) {
    const res = await c.req(path);
    assert.equal(res.status, 401, path);
  }
  const chat = await c.req('/api/chat/stream', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(chat.status, 401);
});

test('admin endpoints are closed to normal accounts', async () => {
  const c = client(srv.url);
  await signUp(c, 'karl');
  const res = await c.req('/api/admin/overview');
  assert.equal(res.status, 403);
});
