import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import * as auth from '../auth.js';
import { clientIp, randomToken, signPayload, verifyPayload } from '../util.js';

const OAUTH_STATE_COOKIE = 'bsw_oauth';

export function authRouter() {
  const router = express.Router();

  /**
   * Both password routes stay in the code but answer 403 once a Google client is
   * configured - see `config.requireGoogleSignin`. They are not deleted because the
   * escape hatch (REQUIRE_GOOGLE_SIGNIN=0) has to lead somewhere, and because the
   * automated end-to-end run still needs to make throwaway accounts; that run presents
   * TEST_MODE_KEY, which only the operator has.
   */
  const passwordSignInClosed = (req, res) => {
    if (!config.requireGoogleSignin || auth.isTestMode(req)) return false;
    res.status(403).json({
      error: 'google_required',
      message: 'Bonsai Swarm uses Google to sign in. Continue with Google instead.',
    });
    return true;
  };

  router.post('/signup', async (req, res) => {
    if (passwordSignInClosed(req, res)) return;
    const { username, password } = req.body || {};
    const ip = clientIp(req, { trustProxy: config.trustProxy });
    const testMode = auth.isTestMode(req);
    if (!testMode && await auth.tooManyAttempts(`signup:${ip}`, config.limits.signupPerDay, 24 * 60)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many new accounts from this connection today.' });
    }
    const usernameError = auth.validateUsername(username);
    if (usernameError) return res.status(400).json({ error: 'bad_username', message: usernameError });
    const passwordError = auth.validatePassword(password);
    if (passwordError) return res.status(400).json({ error: 'bad_password', message: passwordError });

    if (!testMode) await auth.recordAttempt(`signup:${ip}`);
    if (await auth.findUserByUsername(username)) {
      return res.status(409).json({ error: 'taken', message: 'That username is already taken.' });
    }
    try {
      const user = await auth.createUser({ username, password, displayName: username });
      auth.issueSession(res, user);
      res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'taken', message: 'That username is already taken.' });
      throw err;
    }
  });

  router.post('/login', async (req, res) => {
    if (passwordSignInClosed(req, res)) return;
    const { username, password } = req.body || {};
    const ip = clientIp(req, { trustProxy: config.trustProxy });
    const ipKey = `login-ip:${ip}`;
    const userKey = `login-user:${String(username || '').toLowerCase().slice(0, 64)}`;
    if (await auth.tooManyAttempts(ipKey, config.limits.loginPerHour, 60)
      || await auth.tooManyAttempts(userKey, 10, 60)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please wait an hour.' });
    }
    await auth.recordAttempt(ipKey);
    await auth.recordAttempt(userKey);

    const user = typeof username === 'string' ? await auth.findUserByUsername(username) : null;
    const ok = user && await auth.verifyPassword(user.password_hash, String(password ?? ''));
    if (!ok || user.disabled || user.anon_locked) {
      // Same answer whether the account exists or the password was wrong.
      return res.status(401).json({ error: 'bad_credentials', message: 'Wrong username or password.' });
    }
    await auth.clearAttempts(userKey);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    auth.issueSession(res, user);
    res.json({ ok: true, user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
  });

  router.post('/logout-everywhere', auth.requireAuth, async (req, res) => {
    await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [req.user.id]);
    auth.clearSession(res);
    res.json({ ok: true });
  });

  /**
   * Browser hand-off for the downloadable client.
   *
   * The CLI holds a long-lived API token. It does not put that token in a URL - it
   * exchanges it here for a **single-use code that expires in 60 seconds** and starts
   * the browser with the code in the fragment. Worst case for a leaked code is one
   * session, one minute; a leaked token would be the whole account.
   */
  router.post('/handoff', async (req, res) => {
    const header = req.headers.authorization || '';
    const user = header.startsWith('Bearer ') ? await auth.userFromApiToken(header.slice(7).trim()) : null;
    if (!user) return res.status(401).json({ error: 'bad_token', message: 'A valid API token is required.' });
    res.json({ code: auth.createHandoffCode(user.id), expiresInSeconds: 60 });
  });

  /**
   * The provider page trades the hand-off code (or, for older clients, the token
   * itself) for a normal session cookie.
   *
   * It refuses when this browser is already signed in as somebody else: otherwise a
   * crafted link could quietly move a visitor into the attacker's account, where their
   * GPU would earn for the attacker and their chats would be paid from - and visible
   * in - the attacker's ledger.
   */
  router.post('/token-session', async (req, res) => {
    const ip = clientIp(req, { trustProxy: config.trustProxy });
    if (await auth.tooManyAttempts(`handoff:${ip}`, 30, 60)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' });
    }
    await auth.recordAttempt(`handoff:${ip}`);

    const code = String(req.body?.code || '');
    const token = String(req.body?.token || '');
    const user = code ? await auth.userFromHandoffCode(code) : await auth.userFromApiToken(token);
    if (!user) return res.status(401).json({ error: 'bad_token', message: 'That sign-in link is not valid any more.' });

    if (req.user && Number(req.user.id) !== Number(user.id)) {
      return res.status(409).json({
        error: 'already_signed_in',
        message: 'This browser is signed in as somebody else. Sign out first, then run the client again.',
      });
    }
    auth.issueSession(res, user);
    res.json({ ok: true, user: publicUser(user) });
  });

  // ---------------------------------------------------------- google

  /**
   * Where to send somebody after Google sends them back.
   *
   * Only a path on this site is ever accepted. Anything else - an absolute URL, a
   * protocol-relative `//evil.example`, a backslash that some parsers read as a slash -
   * falls back to the chat, because a sign-in flow that will forward to an arbitrary
   * destination is a phishing tool with our domain in the address bar.
   */
  const safeNext = (value) => {
    const raw = String(value ?? '');
    return /^\/[^/\\]/.test(raw) ? raw : '/chat.html';
  };

  router.get('/google/start', (req, res) => {
    if (!config.google.enabled) {
      return res.status(503).json({ error: 'google_disabled', message: 'Google sign-in is not configured on this server.' });
    }
    const state = randomToken(16);
    const verifier = randomToken(32);
    res.cookie(OAUTH_STATE_COOKIE, signPayload(config.sessionSecret, {
      state, verifier, next: safeNext(req.query.next), exp: Math.floor(Date.now() / 1000) + 600,
    }), { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https://'), maxAge: 600_000, path: '/' });
    res.redirect(auth.googleAuthUrl(state, verifier));
  });

  router.get('/google/callback', async (req, res) => {
    if (!config.google.enabled) return res.redirect('/login.html?error=google_disabled');
    const stored = verifyPayload(config.sessionSecret, req.cookies?.[OAUTH_STATE_COOKIE]);
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    if (!stored || !req.query.state || !auth.timingSafeEqual(stored.state, String(req.query.state))) {
      return res.redirect('/login.html?error=oauth_state');
    }
    if (!req.query.code) return res.redirect('/login.html?error=oauth_cancelled');
    try {
      const claims = await auth.googleExchange(String(req.query.code), stored.verifier);
      const email = typeof claims.email === 'string' ? claims.email.slice(0, 200) : null;
      let user = await auth.findUserByGoogleSub(claims.sub);
      if (!user) {
        user = await auth.createUser({
          googleSub: claims.sub,
          email,
          // The name Google knows them by is only the starting point - `PATCH /api/me`
          // lets them change it, and the address is never shown to anybody else.
          displayName: String(claims.name || claims.given_name || 'Google user').slice(0, 60),
        });
      }
      if (user.disabled) return res.redirect('/login.html?error=disabled');
      await pool.query('UPDATE users SET last_login_at = now(), email = COALESCE($2, email) WHERE id = $1',
        [user.id, email]);
      auth.issueSession(res, user);
      res.redirect(safeNext(stored.next));
    } catch (err) {
      console.error('[auth] google callback failed', err.message);
      res.redirect('/login.html?error=oauth_failed');
    }
  });

  return router;
}

export function publicUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    displayName: user.display_name,
    isAdmin: Boolean(user.is_admin),
    balance: Number(user.balance),
    createdAt: user.created_at,
    viaGoogle: Boolean(user.google_sub),
    // Shown back to the owner of the account only - `/api/me` and the sign-in response
    // are the only places it appears, and no endpoint returns another person's.
    email: user.email || null,
  };
}

export { crypto };
