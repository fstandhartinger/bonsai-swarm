import express from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import * as auth from '../auth.js';
import { publicUser } from './auth-routes.js';
import { recentLedger, auditBalance } from '../coins.js';
import { RateLimiter, clientIp } from '../util.js';
import { runtimeStatus } from '../runtime.js';
import { publicFallbackInfo } from '../fallback.js';
import * as game from '../gamification.js';
import { publicStats } from '../stats.js';

export const accountChatLimiter = new RateLimiter(config.limits.chatPerMinute, 60_000);

/** Collects coordinator events until the HTTP status is decided, then forwards. */
export function bufferingSink() {
  const events = [];
  const sink = {
    canReset: true,
    onQueued: (d) => events.push(['onQueued', d]),
    onAssigned: (d) => events.push(['onAssigned', d]),
    onFallback: (d) => events.push(['onFallback', d]),
    onReset: (d) => events.push(['onReset', d]),
    onDelta: (d) => events.push(['onDelta', d]),
    onDone: (d) => events.push(['onDone', d]),
    onError: (d) => events.push(['onError', d]),
  };
  return {
    sink,
    attach(live) {
      for (const [name, data] of events) live[name]?.(data);
      events.length = 0;
      sink.canReset = live.canReset;
      for (const name of ['onQueued', 'onAssigned', 'onFallback', 'onReset', 'onDelta', 'onDone', 'onError']) {
        sink[name] = (d) => live[name]?.(d);
      }
    },
  };
}

const ROLES = new Set(['system', 'user', 'assistant']);

/** Validates and flattens whatever the caller sent into plain {role, content} messages. */
export function normalizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw badRequest('messages must be a non-empty array');
  const out = [];
  let chars = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw badRequest('each message must be an object');
    const role = String(raw.role || '');
    if (!ROLES.has(role)) throw badRequest(`unsupported message role "${role}"`);
    let content = raw.content;
    if (Array.isArray(content)) {
      // OpenAI/Anthropic content-part arrays: keep the text parts.
      content = content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('');
    }
    if (typeof content !== 'string') throw badRequest('message content must be text');
    chars += content.length;
    if (chars > config.jobs.maxPromptChars) {
      throw badRequest(`prompt too long (limit ${config.jobs.maxPromptChars} characters)`);
    }
    out.push({ role, content });
  }
  if (!out.some((m) => m.role === 'user')) throw badRequest('at least one user message is required');
  return out;
}

export function badRequest(message) {
  const err = new Error(message);
  err.code = 'bad_request';
  err.status = 400;
  return err;
}

/** Shared SSE plumbing: one job, one HTTP response, cancel on client disconnect. */
export function sseSink(res, { onDoneExtra } = {}) {
  let closed = false;
  const write = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    write,
    close: () => { closed = true; try { res.end(); } catch { /* already ended */ } },
    isClosed: () => closed,
    sink: {
      // The browser keeps only what it has been sent, so it can always start the answer
      // over - which is what lets a job that lost its volunteer move to the fallback.
      canReset: true,
      onQueued: (d) => write('queued', d),
      onAssigned: (d) => write('assigned', d),
      // The swarm could not answer; a free hosted model is answering instead, and the
      // consumer is told so before the first word of it arrives.
      onFallback: (d) => write('fallback', d),
      onReset: (d) => write('reset', d),
      onDelta: (d) => write('delta', d),
      onDone: (d) => { write('done', { ...d, ...(onDoneExtra?.(d) || {}) }); closed = true; try { res.end(); } catch { /* already ended */ } },
      onError: (d) => { write('error', d); closed = true; try { res.end(); } catch { /* already ended */ } },
    },
  };
}

export function apiRouter(coordinator) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, uptime: Math.round(process.uptime()), ...coordinator.stats() });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  router.get('/stats', async (req, res) => {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(completion_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS tokens_today,
        COALESCE(SUM(completion_tokens), 0)::bigint AS tokens_total,
        COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS jobs_today
      FROM jobs WHERE status IN ('done','cancelled')`);
    const users = await pool.query("SELECT count(*)::int AS n FROM users");
    res.json({
      ...coordinator.stats(),
      tokensToday: Number(rows[0].tokens_today),
      tokensTotal: Number(rows[0].tokens_total),
      jobsToday: rows[0].jobs_today,
      accounts: users.rows[0].n,
      coins: config.coins,
      model: config.model,
      minDecodeTps: config.provider.minDecodeTps,
      runtime: runtimeStatus(),
      fallback: publicFallbackInfo(),
    });
  });

  // The landing page's statistics strip. Totals only - see server/stats.js.
  router.get('/stats/public', async (req, res, next) => {
    try {
      res.set('cache-control', 'public, max-age=30');
      res.json(await publicStats(coordinator));
    } catch (err) { next(err); }
  });

  router.get('/config', (req, res) => {
    res.json({
      coins: config.coins,
      model: config.model,
      minDecodeTps: config.provider.minDecodeTps,
      benchmarkTokens: config.provider.benchmarkTokens,
      maxNewTokens: config.jobs.maxNewTokens,
      defaultMaxNewTokens: config.jobs.defaultMaxNewTokens,
      maxPromptChars: config.jobs.maxPromptChars,
      googleEnabled: config.google.enabled,
      // The login page needs to know whether to show a password form at all.
      requireGoogleSignin: config.requireGoogleSignin,
      // Labels and limits only - never an endpoint and never a key.
      fallback: publicFallbackInfo(),
    });
  });

  router.get('/me', async (req, res) => {
    if (!req.user) return res.json({ signedIn: false });
    const fresh = await auth.findUserById(req.user.id);
    res.json({ signedIn: true, user: publicUser(fresh), providers: coordinator.providerViewFor(fresh.id) });
  });

  /**
   * The display name is the only thing about an account a person can change, and the
   * sign-in screen promises they can - the address Google gave us is not editable and
   * is not shown to anybody else.
   */
  router.patch('/me', auth.requireAuth, async (req, res) => {
    const name = String(req.body?.displayName ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 40) {
      return res.status(400).json({ error: 'bad_name', message: 'Pick a name between 2 and 40 characters.' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [req.user.id, name]);
    res.json({ ok: true, user: publicUser(rows[0]) });
  });

  router.get('/ledger', auth.requireAuth, async (req, res) => {
    const entries = await recentLedger(req.user.id, Number(req.query.limit) || 50);
    const summary = await pool.query(`
      SELECT kind, SUM(coins)::numeric(20,6) AS total, COUNT(*)::int AS n
      FROM ledger WHERE user_id = $1 GROUP BY kind`, [req.user.id]);
    res.json({ balance: Number(req.user.balance), entries, summary: summary.rows });
  });

  router.get('/tokens', auth.requireAuth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, prefix, created_at, last_used_at FROM api_tokens
        WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC`, [req.user.id]);
    res.json({ tokens: rows });
  });

  router.post('/tokens', auth.requireAuth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL', [req.user.id]);
    if (rows[0].n >= 10) return res.status(400).json({ error: 'too_many', message: 'Revoke an old token first (limit 10).' });
    const token = await auth.createApiToken(req.user.id, req.body?.name);
    res.json({ ok: true, token, note: 'Copy it now - it is not shown again.' });
  });

  router.delete('/tokens/:id', auth.requireAuth, async (req, res) => {
    await pool.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2',
      [Number(req.params.id), req.user.id]);
    res.json({ ok: true });
  });

  router.get('/jobs', auth.requireAuth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, status, prompt_tokens, completion_tokens, decode_tps, duration_ms, created_at,
              served_by, fallback_model, (consumer_id = $1) AS as_consumer
         FROM jobs WHERE consumer_id = $1 OR provider_user_id = $1
        ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
    res.json({ jobs: rows });
  });

  // ------------------------------------------------------- AI Coins & game

  /** Level, streak, badges and lifetime stats - all derived from the ledger. */
  router.get('/gamification', auth.requireAuth, async (req, res) => {
    const data = await game.profile(req.user.id);
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  });

  /** Opt-in only: display name, level and lifetime earned AI Coins. Nothing else. */
  router.get('/leaderboard', async (req, res) => {
    res.json({ entries: await game.leaderboard(Number(req.query.limit) || 25) });
  });

  router.post('/leaderboard/opt-in', auth.requireAuth, async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    await pool.query('UPDATE users SET leaderboard_opt_in=$2 WHERE id=$1', [req.user.id, enabled]);
    res.json({ ok: true, enabled });
  });

  router.get('/levels', (req, res) => {
    res.json({ levels: game.LEVELS, achievements: game.ACHIEVEMENTS.map(({ code, icon, name, hint }) => ({ code, icon, name, hint })) });
  });

  // ---------------------------------------------------------------- chat

  router.post('/chat/stream', auth.requireAuth, async (req, res, next) => {
    const key = `chat:${req.user.id}`;
    if (!accountChatLimiter.take(key)) {
      return res.status(429).json({ error: 'rate_limited', message: `At most ${config.limits.chatPerMinute} messages per minute.` });
    }
    let messages;
    try { messages = normalizeMessages(req.body?.messages); }
    catch (err) { return res.status(400).json({ error: 'bad_request', message: err.message }); }

    const buf = bufferingSink();
    let job = null;
    let closed = false;
    res.on('close', () => {
      closed = true;
      if (job) coordinator.cancel(job.id, req.user.id).catch(() => {});
    });
    try {
      job = await coordinator.submit({
        user: req.user,
        messages,
        maxNewTokens: req.body?.maxTokens,
        enableThinking: Boolean(req.body?.thinking),
        clientIp: clientIp(req, { trustProxy: config.trustProxy }),
        allowMock: auth.isTestMode(req),
        sink: buf.sink,
      });
    } catch (err) {
      const status = err.code === 'insufficient_coins' ? 402 : err.code === 'too_many_requests' ? 429 : 503;
      return res.status(status).json({ error: err.code || 'error', message: err.message, ...(err.details || {}) });
    }
    if (closed) {
      await coordinator.cancel(job.id, req.user.id).catch(() => {});
      return res.status(499).end();
    }
    res.set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-bonsai-served-by': coordinator.likelyRoute(),
    });
    res.flushHeaders?.();
    const { sink } = sseSink(res);
    buf.attach(sink);
  });

  router.post('/chat/cancel', auth.requireAuth, async (req, res) => {
    const ok = await coordinator.cancel(String(req.body?.jobId || ''), req.user.id);
    res.json({ ok });
  });

  // ---------------------------------------------------------------- admin

  router.get('/admin/overview', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const providers = [...coordinator.providers.values()].map((p) => ({
      id: p.id, user: p.displayName, state: p.state, admitted: p.admitted,
      decodeTps: p.decodeTps, isMock: p.isMock, connectedAt: p.connectedAt,
    }));
    const audit = await auditBalance(req.user.id);
    res.json({ providers, stats: coordinator.stats(), audit });
  });

  router.post('/admin/adjust', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const { userId, coins, reason } = req.body || {};
    const { postOne } = await import('../coins.js');
    const result = await postOne({
      userId: Number(userId), kind: 'admin_adjust', coins: Number(coins),
      meta: { reason: String(reason || '').slice(0, 200), by: req.user.id }, allowNegative: true,
    });
    res.json(result);
  });

  return router;
}

export { clientIp };
