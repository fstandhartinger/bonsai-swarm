import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { pool, withTransaction } from './db.js';
import { config } from './config.js';
import { post } from './coins.js';
import { randomToken, sha256, signPayload, verifyPayload, timingSafeEqual, clientIp } from './util.js';

export const SESSION_COOKIE = 'bsw_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3-32 characters: letters, digits, dot, dash or underscore.';
  }
  return null;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (password.length > 200) return 'Password must be at most 200 characters long.';
  return null;
}

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw) => argonHash(pw, ARGON);

export async function verifyPassword(storedHash, pw) {
  if (!storedHash) return false;
  try { return await argonVerify(storedHash, pw); } catch { return false; }
}

/**
 * True when the caller presented the server's shared TEST_MODE_KEY. Used to let the
 * automated end-to-end run create throwaway accounts without tripping the per-IP signup
 * limit. Without the key (which only the operator has) this is always false.
 */
export function isTestMode(req) {
  if (!config.testModeKey) return false;
  const offered = String(req.headers['x-test-mode-key'] || '');
  return offered.length > 0 && timingSafeEqual(offered, config.testModeKey);
}

// ------------------------------------------------------------ browser hand-off

/**
 * Single-use, 60-second codes that let the CLI hand a browser a session without ever
 * putting the long-lived API token into a URL or a process list.
 */
const handoffCodes = new Map();   // code -> { userId, exp }

export function createHandoffCode(userId) {
  const code = randomToken(24);
  handoffCodes.set(code, { userId: Number(userId), exp: Date.now() + 60_000 });
  for (const [k, v] of handoffCodes) if (v.exp < Date.now()) handoffCodes.delete(k);
  return code;
}

export async function userFromHandoffCode(code) {
  const entry = handoffCodes.get(String(code));
  if (!entry) return null;
  handoffCodes.delete(String(code));           // single use, even if expired
  if (entry.exp < Date.now()) return null;
  return findUserById(entry.userId);
}

// ---------------------------------------------------------------- login throttle

export async function tooManyAttempts(key, limit, windowMinutes) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE key = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [key, String(windowMinutes)],
  );
  return rows[0].n >= limit;
}

export async function recordAttempt(key) {
  await pool.query('INSERT INTO login_attempts (key) VALUES ($1)', [key]);
  // opportunistic cleanup, cheap because of the index
  if (Math.random() < 0.02) {
    await pool.query("DELETE FROM login_attempts WHERE created_at < now() - interval '2 days'");
  }
}

export async function clearAttempts(key) {
  await pool.query('DELETE FROM login_attempts WHERE key = $1', [key]);
}

// ---------------------------------------------------------------- accounts

export async function createUser({ username = null, password = null, googleSub = null, email = null, displayName }) {
  const passwordHash = password ? await hashPassword(password) : null;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (username, username_lower, password_hash, google_sub, email, display_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [username, username ? username.toLowerCase() : null, passwordHash, googleSub, email, displayName],
    );
    const user = rows[0];
    if (config.coins.welcome > 0) {
      await post(client, {
        userId: user.id,
        kind: 'welcome',
        coins: config.coins.welcome,
        meta: { reason: 'new account' },
      });
      user.balance = config.coins.welcome;
    }
    return user;
  });
}

export async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username_lower = $1', [String(username).toLowerCase()]);
  return rows[0] || null;
}

export async function findUserByGoogleSub(sub) {
  const { rows } = await pool.query('SELECT * FROM users WHERE google_sub = $1', [sub]);
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// ---------------------------------------------------------------- sessions

export function sessionCookieOpts({ maxAge = SESSION_TTL_SECONDS * 1000 } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge,
    path: '/',
  };
}

export function issueSession(res, user) {
  const token = signPayload(config.sessionSecret, {
    uid: Number(user.id),
    sv: user.session_version,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  res.cookie(SESSION_COOKIE, token, sessionCookieOpts());
  return token;
}

export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, sessionCookieOpts({ maxAge: 0 }));
}

export async function userFromSessionToken(token) {
  const payload = verifyPayload(config.sessionSecret, token);
  if (!payload || typeof payload.uid !== 'number') return null;
  const user = await findUserById(payload.uid);
  if (!user || user.disabled) return null;
  if (user.session_version !== payload.sv) return null;
  return user;
}

// ---------------------------------------------------------------- api tokens

export const API_TOKEN_PREFIX = 'bsw_';

export async function createApiToken(userId, name) {
  const secret = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  await pool.query(
    'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES ($1,$2,$3,$4)',
    [userId, String(name || 'token').slice(0, 60), sha256(secret), secret.slice(0, 12)],
  );
  return secret; // shown once
}

export async function userFromApiToken(token) {
  if (typeof token !== 'string' || !token.startsWith(API_TOKEN_PREFIX)) return null;
  const { rows } = await pool.query(
    `SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [sha256(token)],
  );
  const user = rows[0];
  if (!user || user.disabled) return null;
  pool.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [user.token_id])
    .catch((e) => console.error('[auth] last_used_at update failed', e.message));
  return user;
}

// ---------------------------------------------------------------- middleware

/** Populates req.user from the session cookie or an Authorization: Bearer token. */
export function authMiddleware() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (header && header.startsWith('Bearer ')) {
        req.user = await userFromApiToken(header.slice(7).trim());
        req.authKind = req.user ? 'token' : null;
      }
      if (!req.user && req.cookies?.[SESSION_COOKIE]) {
        req.user = await userFromSessionToken(req.cookies[SESSION_COOKIE]);
        req.authKind = req.user ? 'session' : null;
      }
      next();
    } catch (err) { next(err); }
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not_signed_in', message: 'Please sign in first.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'forbidden', message: 'Admins only.' });
  next();
}

/**
 * Cookie-authenticated state changes must come from our own origin. Bearer-token calls
 * are exempt: they are not sent automatically by a browser, so they cannot be forged
 * by a third-party page.
 */
export function csrfGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.authKind === 'token') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser client without a cookie session
  if (!isSameSiteOrigin(req, origin)) {
    return res.status(403).json({ error: 'bad_origin', message: 'Request blocked: wrong origin.' });
  }
  next();
}

/**
 * Same-origin check for browser-initiated requests. The request's own host is the
 * authority (behind the Coolify proxy that is X-Forwarded-Host); the configured public
 * URL is accepted as well so a custom domain keeps working.
 */
export function isSameSiteOrigin(req, origin) {
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  const forwarded = req.headers['x-forwarded-host'];
  const host = (typeof forwarded === 'string' && forwarded.length ? forwarded.split(',')[0].trim() : req.headers.host) || '';
  if (originHost && originHost === host) return true;
  try { if (originHost === new URL(config.publicUrl).host) return true; } catch { /* unparseable config */ }
  return false;
}

// ---------------------------------------------------------------- google oauth

export function googleAuthUrl(state, codeVerifier) {
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: `${config.publicUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function googleExchange(code, codeVerifier) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: `${config.publicUrl}/api/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
  const data = await res.json();
  const claims = decodeIdToken(data.id_token);
  if (!claims?.sub) throw new Error('google id_token had no subject');
  if (claims.aud !== config.google.clientId) throw new Error('google id_token audience mismatch');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw new Error('google id_token issuer mismatch');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('google id_token expired');
  return claims;
}

/**
 * The id_token comes straight from Google's TLS-protected token endpoint in the
 * authorization-code flow, so the signature adds nothing here - but issuer, audience
 * and expiry are still checked above.
 */
function decodeIdToken(idToken) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

export { clientIp, timingSafeEqual };
