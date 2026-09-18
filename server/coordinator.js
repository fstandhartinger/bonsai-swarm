import crypto from 'node:crypto';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { post, costForJob, earningsForJob, affordableCompletionTokens } from './coins.js';
import { estimatePromptTokens, roundCoins, RateLimiter } from './util.js';
import { runFallbackCompletion, fallbackNotice } from './fallback.js';
import * as game from './gamification.js';

const now = () => Date.now();

/** 22:00-06:00 at the provider's own desk, from the offset its browser reported. */
export function isNightFor(tzOffsetMinutes = 0) {
  const local = new Date(Date.now() + (Number(tzOffsetMinutes) || 0) * 60_000);
  const hour = local.getUTCHours();
  return hour >= 22 || hour < 6;
}
const newId = () => crypto.randomUUID();
const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Tokens per second, safe to store. An answer that arrives inside the same millisecond
 * divides by zero, and `jobs.decode_tps` is numeric(10,3) - an Infinity there aborts the
 * whole settlement transaction, so the consumer would silently not be charged.
 */
function clampTps(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(value, 999_999) * 1000) / 1000;
}

/**
 * The coordinator owns every provider browser and every in-flight job.
 *
 * Trust model: a provider is a stranger's browser tab. It is never trusted for
 * anything that touches the ledger. Completion tokens are counted here, from the
 * deltas that actually reached the consumer; prompt tokens are derived from the text
 * the coordinator itself sent. A provider only ever sees jobs assigned to it, and
 * never the identity of the consumer.
 */
export class Coordinator {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this.providers = new Map();   // providerId -> provider
    this.jobs = new Map();        // jobId -> job
    this.queue = [];              // job ids, FIFO
    this.tokensServedToday = 0;
    this.timers = [];
    this.userLocks = new Map();   // userId -> tail of that account's submit chain

    // The free fallback model is the one thing here that costs somebody real money, so
    // it is metered three ways: per account, per address, and for the whole site per day.
    this.fallbackByAccount = new RateLimiter(config.fallback.perAccountPerHour, 3_600_000);
    this.fallbackByIp = new RateLimiter(config.fallback.perIpPerHour, 3_600_000);
    this.fallbackToday = { day: utcDay(), used: 0 };
  }

  /** Fallback answers served since UTC midnight, with the day rolled over if needed. */
  fallbackUsedToday() {
    const today = utcDay();
    if (this.fallbackToday.day !== today) this.fallbackToday = { day: today, used: 0 };
    return this.fallbackToday.used;
  }

  /**
   * Restores today's global fallback count from the jobs table, so a restart does not
   * hand out a fresh daily budget.
   */
  async loadFallbackUsage() {
    if (!config.fallback.enabled) return;
    try {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM jobs
          WHERE served_by = 'fallback' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`);
      this.fallbackToday = { day: utcDay(), used: Number(rows[0]?.n || 0) };
    } catch (err) {
      this.log.error('[coord] could not read today\'s fallback usage', err.message);
    }
  }

  start() {
    this.timers.push(setInterval(() => this.sweep(), 10_000));
    this.timers.push(setInterval(() => this.creditOnlineMinutes().catch((e) => this.log.error('[coord] minute credit failed', e.message)), 30_000));
    this.timers.push(setInterval(() => this.pingAll(), config.provider.heartbeatMs));
    for (const t of this.timers) t.unref?.();
    this.loadFallbackUsage().catch(() => {});
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const job of this.jobs.values()) {
      this.clearFallbackTimer(job);
      if (job.fallbackAbort) { try { job.fallbackAbort.abort(); } catch { /* already done */ } }
    }
    for (const p of this.providers.values()) { try { p.ws.close(); } catch { /* already closing */ } }
    this.providers.clear();
  }

  // ------------------------------------------------------------- providers

  async addProvider({ ws, user, isMock = false, adminOverride = false, userAgent = '', tzOffsetMinutes = null }) {
    const provider = {
      id: newId(),
      userId: Number(user.id),
      displayName: user.display_name,
      isAdmin: Boolean(user.is_admin),
      ws,
      isMock,
      adminOverride,
      userAgent: String(userAgent).slice(0, 200),
      tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0,
      state: 'connecting',      // connecting | loading | ready | busy | paused | rejected
      admitted: false,
      decodeTps: null,
      ttftMs: null,
      gpuLabel: null,
      currentJobId: null,
      connectedAt: now(),
      lastSeen: now(),
      creditedFrom: null,       // timestamp from which online minutes are still uncredited
      minutesCredited: 0,
      tokensServed: 0,
      jobsServed: 0,
      claimedTps: null,
      measuredTps: null,      // what this server timed while the provider answered
      slowJobs: 0,
    };
    this.providers.set(provider.id, provider);
    await pool.query(
      `INSERT INTO provider_sessions (id, user_id, is_mock) VALUES ($1,$2,$3)`,
      [provider.id, provider.userId, isMock],
    );
    // Remembered so the "night owl" badge can ask what time it was where the GPU stands.
    if (Number.isFinite(tzOffsetMinutes)) {
      await pool.query('UPDATE users SET tz_offset_minutes=$2 WHERE id=$1',
        [provider.userId, Math.max(-840, Math.min(840, Math.round(tzOffsetMinutes)))]).catch(() => {});
    }
    this.send(provider, {
      type: 'welcome',
      providerId: provider.id,
      config: {
        model: config.model,
        benchmarkTokens: config.provider.benchmarkTokens,
        minDecodeTps: config.provider.minDecodeTps,
        maxLength: config.model.maxLength,
        heartbeatMs: config.provider.heartbeatMs,
        adminOverride,
        isMock,
      },
    });
    return provider;
  }

  send(provider, message) {
    if (provider.ws.readyState !== 1) return false;
    try { provider.ws.send(JSON.stringify(message)); return true; }
    catch (err) { this.log.error('[coord] send failed', err.message); return false; }
  }

  pingAll() {
    for (const p of this.providers.values()) this.send(p, { type: 'ping', t: now() });
  }

  async handleProviderMessage(provider, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    provider.lastSeen = now();

    switch (msg.type) {
      case 'pong':
        return;
      case 'status': {
        const state = String(msg.state || '');
        if (state === 'loading') this.setState(provider, 'loading');
        else if (state === 'paused') this.setState(provider, 'paused');
        else if (state === 'ready' && provider.admitted) this.setState(provider, 'ready');
        if (msg.gpuLabel) provider.gpuLabel = String(msg.gpuLabel).slice(0, 120);
        return;
      }
      case 'benchmark':
        return this.handleBenchmark(provider, msg);
      case 'job.delta':
        return this.handleDelta(provider, msg);
      case 'job.done':
        return this.handleJobDone(provider, msg);
      case 'job.error':
        return this.finishJob(provider.currentJobId, 'failed', {
          error: 'The volunteer GPU failed.',
          code: 'provider_error',
        });
      default:
        return;
    }
  }

  setState(provider, state) {
    if (provider.state === state) return;
    // Never move a provider out of `busy` through a status message; only job
    // completion releases it.
    if (provider.state === 'busy' && state !== 'busy' && provider.currentJobId) {
      if (state === 'paused') provider.pauseRequested = true;
      return;
    }
    provider.state = state;
    if (state === 'ready' || state === 'busy') {
      if (provider.creditedFrom === null) provider.creditedFrom = now();
      if (state === 'ready') this.dispatch();
    } else {
      provider.creditedFrom = null;
    }
  }

  /**
   * A provider measures itself, so this number is a *claim*. It is clamped to something
   * physically possible, it only decides admission (there is no way to verify a
   * volunteer's hardware from here), and it deliberately does NOT decide who gets the
   * next job - see pickProvider(). Every job is then timed by this server, and a
   * provider whose real throughput does not hold up loses its admission.
   */
  async handleBenchmark(provider, msg) {
    const raw = Number(msg.decodeTps);
    const tps = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), config.provider.maxClaimedTps) : 0;
    const ttft = Number(msg.ttftMs);
    provider.claimedTps = tps;
    provider.decodeTps = Math.round(tps * 1000) / 1000;
    provider.ttftMs = Number.isFinite(ttft) ? Math.round(ttft) : null;
    const fast = tps >= config.provider.minDecodeTps;
    const demoted = (provider.slowJobs || 0) >= config.provider.demoteAfterSlowJobs;
    if (demoted && !provider.adminOverride) {
      provider.admitted = false;
      provider.decodeTps = Math.round(tps * 1000) / 1000;
      await pool.query(
        'UPDATE provider_sessions SET admitted=$2, decode_tps=$3, ttft_ms=$4, gpu_label=$5 WHERE id=$1',
        [provider.id, false, provider.decodeTps, provider.ttftMs, provider.gpuLabel],
      );
      this.send(provider, {
        type: 'admission',
        admitted: false,
        decodeTps: provider.decodeTps,
        minDecodeTps: config.provider.minDecodeTps,
        reason: `This GPU was demoted after slow jobs. Claimed ${provider.decodeTps} tokens/s does not restore admission.`,
      });
      provider.state = 'rejected';
      provider.creditedFrom = null;
      return;
    }
    provider.admitted = fast || provider.adminOverride;
    await pool.query(
      'UPDATE provider_sessions SET admitted=$2, decode_tps=$3, ttft_ms=$4, gpu_label=$5 WHERE id=$1',
      [provider.id, provider.admitted, provider.decodeTps, provider.ttftMs, provider.gpuLabel],
    );
    this.send(provider, {
      type: 'admission',
      admitted: provider.admitted,
      decodeTps: provider.decodeTps,
      minDecodeTps: config.provider.minDecodeTps,
      viaOverride: provider.admitted && !fast,
      reason: provider.admitted
        ? null
        : `Measured ${provider.decodeTps ?? 0} tokens/s, the network needs at least ${config.provider.minDecodeTps}. You can still chat, but your GPU will not be given other people's prompts.`,
    });
    if (provider.admitted) this.setState(provider, 'ready');
    else { provider.state = 'rejected'; provider.creditedFrom = null; }
  }

  async removeProvider(providerId, reason = 'disconnected') {
    const provider = this.providers.get(providerId);
    if (!provider) return;
    this.providers.delete(providerId);
    await this.creditOnlineMinutes(provider).catch(() => {});
    if (provider.currentJobId) {
      const job = this.jobs.get(provider.currentJobId);
      if (job) {
        if (job.completionTokens === 0 && job.attempts < config.jobs.maxAttempts) this.requeue(job, `provider ${reason}`);
        else await this.giveUpOrFallback(job, `The GPU that was answering you went offline (${reason}).`);
      }
    }
    await pool.query(
      `UPDATE provider_sessions SET disconnected_at = now(), minutes_credited=$2, tokens_served=$3, jobs_served=$4 WHERE id=$1`,
      [provider.id, provider.minutesCredited, provider.tokensServed, provider.jobsServed],
    ).catch((e) => this.log.error('[coord] provider_sessions close failed', e.message));
  }

  sweep() {
    const cutoff = now() - config.provider.staleMs;
    for (const p of [...this.providers.values()]) {
      if (p.lastSeen < cutoff) {
        this.log.warn?.(`[coord] provider ${p.id.slice(0, 8)} timed out`);
        try { p.ws.close(); } catch { /* already closed */ }
        this.removeProvider(p.id, 'timeout').catch((e) => this.log.error(e.message));
      }
    }
    // queued jobs that nobody picked up
    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (!job) { this.queue = this.queue.filter((id) => id !== jobId); continue; }
      if (now() - job.queuedAt > config.jobs.queueTimeoutMs) {
        this.finishJob(job.id, 'expired', {
          error: 'No GPU in the network picked this up in time. Try again in a moment, or share your own GPU.',
        }).catch((e) => this.log.error(e.message));
      }
    }
  }

  /**
   * AI Coins for simply being online, admitted and responsive. Time is accumulated from
   * `creditedFrom`, so nothing is credited for minutes spent loading, paused or
   * unresponsive, and nothing is lost to the 30s tick granularity.
   */
  async creditOnlineMinutes(only = null) {
    const list = only ? [only] : [...this.providers.values()];
    // Minutes are paid per *account*, not per socket: ten tabs (or ten fake sockets)
    // from one account are still one machine's worth of time.
    const paidThisPass = new Set();
    for (const p of list) {
      const eligible = p.admitted && (p.state === 'ready' || p.state === 'busy') && now() - p.lastSeen < config.provider.staleMs;
      if (!eligible || p.creditedFrom === null) continue;
      const earningSibling = [...this.providers.values()].find(
        (o) => o.userId === p.userId && o.id !== p.id && o.admitted && o.creditedFrom !== null
          && (o.state === 'ready' || o.state === 'busy') && o.connectedAt < p.connectedAt,
      );
      if (earningSibling || paidThisPass.has(p.userId)) { p.creditedFrom = now(); continue; }
      paidThisPass.add(p.userId);
      const elapsedMinutes = Math.floor((now() - p.creditedFrom) / 60_000);
      if (elapsedMinutes < 1) continue;
      p.creditedFrom += elapsedMinutes * 60_000;
      p.minutesCredited += elapsedMinutes;
      const coins = roundCoins(elapsedMinutes * config.coins.providePerMinute);
      if (coins <= 0) continue;
      await withTransaction((client) => post(client, {
        userId: p.userId,
        kind: 'provide_minutes',
        coins,
        meta: { minutes: elapsedMinutes, provider_session: p.id, mock: p.isMock },
      }));
      game.touch(p.userId);
    }
  }

  // ------------------------------------------------------------- jobs

  /**
   * @param {object} opts
   * @param {object} opts.user       consumer account row
   * @param {Array}  opts.messages   chat messages
   * @param {object} opts.sink       { onQueued, onAssigned, onDelta, onDone, onError }
   */
  /**
   * Serialises everything one account does, so the "can you afford this?" check and the
   * reservation that answers it cannot interleave with a second request from the same
   * account. Without this, two parallel requests both read the old balance and the
   * account can spend coins it does not have.
   */
  async withUserLock(userId, fn) {
    const key = Number(userId);
    const previous = this.userLocks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.userLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Drop the entry once nobody is queued behind us, so the map cannot grow forever.
      if (this.userLocks.get(key) === tail) this.userLocks.delete(key);
    }
  }

  submit(opts) {
    return this.withUserLock(opts.user.id, () => this.submitLocked(opts));
  }

  async submitLocked({ user, messages, maxNewTokens, enableThinking = false, sink, clientIp = null }) {
    const promptTokens = estimatePromptTokens(messages);
    const balance = Number((await pool.query('SELECT balance FROM users WHERE id=$1', [user.id])).rows[0]?.balance ?? 0);
    const reserved = this.reservedFor(user.id);
    const affordable = affordableCompletionTokens(balance - reserved, promptTokens);

    if (affordable <= 0) {
      const err = new Error('Not enough AI Coins. Share your GPU on the "Share GPU" page to earn more.');
      err.code = 'insufficient_coins';
      err.details = { balance, reserved, promptTokens };
      throw err;
    }

    const running = [...this.jobs.values()].filter((j) => j.consumerId === Number(user.id)).length;
    if (running >= config.jobs.maxConcurrentPerUser) {
      const err = new Error(`Only ${config.jobs.maxConcurrentPerUser} requests at a time per account.`);
      err.code = 'too_many_requests';
      throw err;
    }

    const cap = Math.min(
      config.jobs.maxNewTokens,
      Math.max(1, Number(maxNewTokens) || config.jobs.defaultMaxNewTokens),
      affordable,
    );

    const job = {
      id: newId(),
      consumerId: Number(user.id),
      messages,
      maxNewTokens: cap,
      enableThinking: Boolean(enableThinking),
      promptTokens,
      completionTokens: 0,
      status: 'queued',
      attempts: 0,
      triedProviders: new Set(),
      providerId: null,
      providerUserId: null,
      isMock: false,
      sink,
      createdAt: now(),
      queuedAt: now(),
      startedAt: null,
      firstTokenAt: null,
      idleTimer: null,
      cappedByBalance: cap < Math.min(config.jobs.maxNewTokens, Number(maxNewTokens) || config.jobs.defaultMaxNewTokens),
      clientIp,
      servedBy: 'community',
      fallbackTimer: null,
      fallbackModel: null,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    sink.onQueued?.({ jobId: job.id, position: this.queue.indexOf(job.id) + 1, maxNewTokens: cap, promptTokens, cappedByBalance: job.cappedByBalance });
    this.dispatch();
    if (job.status === 'queued') this.armFallbackTimer(job);
    return job;
  }

  // --------------------------------------------------------- free fallback

  /**
   * Is there a volunteer who could plausibly answer this job - now or in a moment?
   *
   * A browser that is still loading the weights counts: it is minutes from being
   * useful, not hours, and the point of the wait is to give the swarm its chance.
   */
  couldServe(job) {
    for (const p of this.providers.values()) {
      if (!p.admitted) continue;
      if (p.userId === job.consumerId) continue;
      if (now() - p.lastSeen > config.provider.staleMs) continue;
      if (['ready', 'busy', 'loading', 'connecting'].includes(p.state)) return true;
    }
    return false;
  }

  /**
   * Starts the clock after which a queued job stops waiting for the swarm. With nobody
   * online it fires on the next tick - there is nothing to wait for.
   */
  armFallbackTimer(job) {
    if (!config.fallback.enabled || job.fallbackTimer || job.servedBy === 'fallback') return;
    const waiting = this.couldServe(job);
    const delay = waiting ? config.fallback.queueWaitMs : 0;
    const reason = waiting ? 'waited' : 'nobody-online';
    job.fallbackTimer = setTimeout(() => {
      job.fallbackTimer = null;
      this.startFallback(job, reason).catch((e) => this.log.error('[coord] fallback failed', e.message));
    }, delay);
    job.fallbackTimer.unref?.();
  }

  /**
   * The route a request submitted right now would most likely take, for the
   * `x-bonsai-served-by` header - which has to be written before the answer exists.
   */
  likelyRoute() {
    if (!config.fallback.enabled) return 'community';
    if (this.fallbackUsedToday() >= config.fallback.globalPerDay) return 'community';
    const ready = [...this.providers.values()].some((p) => p.admitted && p.state === 'ready'
      && now() - p.lastSeen <= config.provider.staleMs);
    return ready ? 'community' : 'fallback';
  }

  clearFallbackTimer(job) {
    if (job?.fallbackTimer) { clearTimeout(job.fallbackTimer); job.fallbackTimer = null; }
  }

  /**
   * May this job be answered by the free fallback model right now? Returns the reason
   * when it may not, so the consumer can be told something true instead of "no GPU".
   */
  fallbackGate(job) {
    if (!config.fallback.enabled) return { ok: false, code: 'fallback_disabled', message: 'No fallback model is configured.' };
    const f = config.fallback;
    if (this.fallbackUsedToday() >= f.globalPerDay) {
      return {
        ok: false,
        code: 'fallback_daily_cap',
        message: `The free fallback model has answered its ${f.globalPerDay} questions for today.`,
      };
    }
    // The limits are configuration, like the coin rates, so they are read here rather
    // than frozen into the limiter when the coordinator was constructed.
    this.fallbackByAccount.limit = f.perAccountPerHour;
    this.fallbackByIp.limit = f.perIpPerHour;
    if (!this.fallbackByAccount.take(`fb:user:${job.consumerId}`)) {
      return {
        ok: false,
        code: 'fallback_account_limit',
        message: `You have used the free fallback model ${f.perAccountPerHour} times this hour.`,
      };
    }
    if (job.clientIp && !this.fallbackByIp.take(`fb:ip:${job.clientIp}`)) {
      return {
        ok: false,
        code: 'fallback_ip_limit',
        message: `This connection has used the free fallback model ${f.perIpPerHour} times this hour.`,
      };
    }
    return { ok: true };
  }

  /**
   * Hands a job to the free fallback model.
   *
   * Called when the swarm is empty, when nobody picked the job up in time, or when the
   * volunteer who had it went away. The consumer is always told; see fallbackNotice().
   */
  async startFallback(job, reason) {
    if (!this.jobs.has(job.id) || job.servedBy === 'fallback') return;
    if (job.status === 'done' || job.status === 'failed') return;

    const gate = this.fallbackGate(job);
    if (!gate.ok) {
      // Somebody is online and merely busy: keep waiting for them, as before.
      if (this.couldServe(job)) return;
      await this.finishJob(job.id, 'failed', {
        error: `No community GPU is online right now. ${gate.message} `
          + 'Try again later, or share your own GPU to keep the swarm alive.',
        code: gate.code,
      });
      return;
    }

    this.clearFallbackTimer(job);
    if (job.idleTimer) { clearTimeout(job.idleTimer); job.idleTimer = null; }
    this.queue = this.queue.filter((id) => id !== job.id);

    // A volunteer that died mid-answer has already put half a sentence on the screen.
    // The fallback starts a fresh answer, so tell the consumer to drop what it has.
    if (job.completionTokens > 0) {
      job.sink.onReset?.({ jobId: job.id, reason: 'the volunteer GPU dropped out' });
      job.completionTokens = 0;
    }

    const previousProvider = this.providers.get(job.providerId);
    if (previousProvider && previousProvider.currentJobId === job.id) this.releaseProvider(previousProvider);

    job.servedBy = 'fallback';
    job.status = 'running';
    job.providerId = null;
    job.providerUserId = null;
    job.isMock = false;
    job.startedAt = job.startedAt || now();
    job.firstTokenAt = null;
    this.fallbackToday.used += 1;

    const controller = new AbortController();
    job.fallbackAbort = controller;

    try {
      const result = await runFallbackCompletion({
        messages: job.messages,
        maxTokens: Math.min(job.maxNewTokens, config.fallback.maxNewTokens),
        signal: controller.signal,
        onUpstream: (upstream) => {
          job.fallbackModel = upstream.label;
          job.sink.onFallback?.({
            jobId: job.id,
            servedBy: 'fallback',
            model: upstream.label,
            reason,
            notice: fallbackNotice(upstream.label),
            coinsFlat: config.fallback.coinsFlat,
          });
        },
        onDelta: (delta) => {
          if (!job.firstTokenAt) job.firstTokenAt = now();
          job.sink.onDelta?.({ jobId: job.id, delta, servedBy: 'fallback' });
        },
      });
      job.completionTokens = result.completionTokens;
      await this.finishJob(job.id, 'done', { stopReason: result.stopReason });
    } catch (err) {
      this.log.error('[coord] fallback model failed', err.message);
      await this.finishJob(job.id, 'failed', {
        // The upstream's own message can say anything; the consumer gets ours.
        error: 'No community GPU is online, and the free fallback model could not answer either. '
          + 'Please try again in a moment.',
        code: 'fallback_failed',
      });
    }
  }

  /** AI Coins that in-flight jobs of this user could still cost, so parallel requests cannot overdraw. */
  reservedFor(userId) {
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.consumerId !== Number(userId)) continue;
      // Hold the original cap until settlement commits. Shrinking this as tokens
      // stream (or deleting the job before the debit) lets a second request pass
      // the same balance check.
      total += costForJob(job.promptTokens, job.maxNewTokens);
    }
    return roundCoins(total);
  }

  /**
   * Picks a provider at random among those that are ready.
   *
   * Deliberately NOT "the fastest": the speed a browser reports is self-declared, so
   * ranking by it would hand every prompt in the network to whoever lies hardest.
   * Random choice bounds a liar's share to 1/N and keeps prompts spread across
   * volunteers. Server-measured throughput (measuredTps) is used only as a mild
   * weight, and only after this server has timed the provider itself.
   */
  pickProvider(job) {
    const candidates = [];
    for (const p of this.providers.values()) {
      if (p.state !== 'ready' || !p.admitted) continue;
      if (p.userId === job.consumerId) continue;          // no self-serving: own prompts never earn AI Coins
      if (job.triedProviders.has(p.id)) continue;
      if (now() - p.lastSeen > config.provider.staleMs) continue;
      candidates.push(p);
    }
    if (!candidates.length) return null;
    const weightOf = (p) => (p.measuredTps ? Math.min(3, Math.max(0.5, p.measuredTps / config.provider.minDecodeTps)) : 1);
    const total = candidates.reduce((sum, p) => sum + weightOf(p), 0);
    let pick = Math.random() * total;
    for (const p of candidates) {
      pick -= weightOf(p);
      if (pick <= 0) return p;
    }
    return candidates[candidates.length - 1];
  }

  dispatch() {
    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') { this.queue = this.queue.filter((id) => id !== jobId); continue; }
      const provider = this.pickProvider(job);
      if (!provider) continue;

      // A volunteer took it after all - stop the fallback clock.
      this.clearFallbackTimer(job);
      this.queue = this.queue.filter((id) => id !== jobId);
      job.status = 'running';
      job.attempts += 1;
      job.providerId = provider.id;
      job.providerUserId = provider.userId;
      job.isMock = provider.isMock;
      job.servedAtNight = isNightFor(provider.tzOffsetMinutes);
      job.startedAt = now();
      job.triedProviders.add(provider.id);
      provider.state = 'busy';
      provider.currentJobId = job.id;

      const ok = this.send(provider, {
        type: 'job.start',
        jobId: job.id,
        messages: job.messages,
        maxNewTokens: job.maxNewTokens,
        enableThinking: job.enableThinking,
      });
      if (!ok) { this.releaseProvider(provider); this.requeue(job, 'send failed'); continue; }

      job.sink.onAssigned?.({
        jobId: job.id,
        providerLabel: provider.gpuLabel || 'a volunteer GPU',
        decodeTps: provider.decodeTps,
        attempt: job.attempts,
      });
      this.armIdleTimer(job, config.jobs.firstTokenTimeoutMs);
    }
    this.broadcastQueuePositions();
  }

  broadcastQueuePositions() {
    this.queue.forEach((jobId, index) => {
      const job = this.jobs.get(jobId);
      job?.sink.onQueued?.({ jobId, position: index + 1, update: true });
    });
  }

  armIdleTimer(job, ms) {
    if (job.idleTimer) clearTimeout(job.idleTimer);
    job.idleTimer = setTimeout(() => {
      const provider = this.providers.get(job.providerId);
      if (provider) {
        this.send(provider, { type: 'job.cancel', jobId: job.id, reason: 'timeout' });
        this.releaseProvider(provider);
      }
      if (job.completionTokens === 0 && job.attempts < config.jobs.maxAttempts) this.requeue(job, 'timeout');
      else this.giveUpOrFallback(job, 'The volunteer GPU stopped responding.').catch((e) => this.log.error(e.message));
    }, ms);
    job.idleTimer.unref?.();
  }

  /**
   * The volunteer path has run out of options for this job. If the free fallback model
   * can take it, it answers; otherwise the consumer gets the error.
   *
   * A consumer that has already been shown part of an answer can only be handed a fresh
   * one if it is able to throw the fragment away - the web chat and the non-streaming
   * API can (`sink.canReset`), a half-sent streamed HTTP response cannot.
   */
  async giveUpOrFallback(job, error) {
    if (config.fallback.enabled && job.servedBy !== 'fallback'
        && (job.completionTokens === 0 || job.sink.canReset)) {
      return this.startFallback(job, 'provider-dropped');
    }
    return this.finishJob(job.id, 'failed', { error });
  }

  requeue(job, reason) {
    if (job.status === 'done' || job.status === 'failed') return;
    if (job.idleTimer) { clearTimeout(job.idleTimer); job.idleTimer = null; }
    job.status = 'queued';
    job.queuedAt = now();
    job.providerId = null;
    job.providerUserId = null;
    this.queue.push(job.id);
    job.sink.onQueued?.({ jobId: job.id, position: this.queue.indexOf(job.id) + 1, requeued: true, reason });
    this.dispatch();
    // Still nobody: start (or restart) the clock towards the free fallback model.
    if (job.status === 'queued') this.armFallbackTimer(job);
  }

  releaseProvider(provider) {
    if (!provider) return;
    provider.currentJobId = null;
    if (provider.pauseRequested) { provider.pauseRequested = false; provider.state = 'paused'; provider.creditedFrom = null; return; }
    if (provider.state === 'busy') provider.state = 'ready';
  }

  handleDelta(provider, msg) {
    const job = this.jobs.get(msg.jobId);
    if (!job || job.providerId !== provider.id || job.status !== 'running') return;
    let delta = typeof msg.delta === 'string' ? msg.delta : '';
    if (!delta) return;
    // One frame is billed as one token, so a frame may not be longer than a token can
    // be: without this a provider could bill a whole paragraph as a single token.
    if (delta.length > config.provider.maxDeltaChars) delta = delta.slice(0, config.provider.maxDeltaChars);

    // The coordinator - not the provider - decides how many tokens were produced.
    job.completionTokens += 1;
    if (!job.firstTokenAt) job.firstTokenAt = now();
    provider.tokensServed += 1;
    this.tokensServedToday += 1;
    job.sink.onDelta?.({ jobId: job.id, delta, index: job.completionTokens });

    if (job.completionTokens >= job.maxNewTokens) {
      this.send(provider, { type: 'job.cancel', jobId: job.id, reason: 'length' });
      this.finishJob(job.id, 'done', { stopReason: 'length' }).catch((e) => this.log.error(e.message));
      return;
    }
    this.armIdleTimer(job, config.jobs.idleTimeoutMs);
  }

  handleJobDone(provider, msg) {
    const job = this.jobs.get(msg.jobId);
    if (!job || job.providerId !== provider.id) return;
    return this.finishJob(job.id, 'done', { stopReason: String(msg.stopReason || 'stop').slice(0, 40) })
      .catch((e) => this.log.error('[coord] finishJob failed', e.message));
  }

  async cancel(jobId, byUserId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (Number(byUserId) !== job.consumerId) return false;
    const provider = this.providers.get(job.providerId);
    if (provider) this.send(provider, { type: 'job.cancel', jobId: job.id, reason: 'user' });
    // A fallback request is an open HTTP stream to somebody else's API - close it, so a
    // consumer who walks away does not keep burning the daily budget.
    if (job.fallbackAbort) { try { job.fallbackAbort.abort(); } catch { /* already done */ } }
    await this.finishJob(job.id, 'cancelled', { stopReason: 'cancelled' });
    return true;
  }

  /**
   * Settle a job exactly once: charge the consumer for what was delivered, pay the
   * provider for the same tokens, and record aggregate counts only - never the prompt
   * or the answer.
   */
  async finishJob(jobId, status, { error = null, stopReason = null, code = null } = {}) {
    const job = this.jobs.get(jobId);
    if (!job || job.settling) return;
    job.settling = true;
    this.queue = this.queue.filter((id) => id !== jobId);
    if (job.idleTimer) { clearTimeout(job.idleTimer); job.idleTimer = null; }
    this.clearFallbackTimer(job);
    job.status = status;

    const provider = this.providers.get(job.providerId);
    if (provider && provider.currentJobId === job.id) {
      provider.jobsServed += 1;
      this.releaseProvider(provider);
    }

    // What this server actually timed, as opposed to what the browser claimed.
    if (provider && job.firstTokenAt && job.completionTokens >= 4) {
      const seconds = (now() - job.firstTokenAt) / 1000;
      const measured = seconds > 0 ? job.completionTokens / seconds : 0;
      provider.measuredTps = provider.measuredTps
        ? provider.measuredTps * 0.5 + measured * 0.5
        : measured;
      if (measured < config.provider.minDecodeTps * 0.6) {
        provider.slowJobs = (provider.slowJobs || 0) + 1;
        if (provider.slowJobs >= config.provider.demoteAfterSlowJobs && provider.admitted) {
          provider.admitted = false;
          provider.state = 'rejected';
          provider.creditedFrom = null;
          this.send(provider, {
            type: 'admission',
            admitted: false,
            decodeTps: Math.round(measured * 10) / 10,
            minDecodeTps: config.provider.minDecodeTps,
            reason: `Measured ${measured.toFixed(1)} tokens/s while actually answering, `
              + `below the ${config.provider.minDecodeTps} the swarm needs. You can still chat.`,
          });
          this.log.warn?.(`[coord] demoted provider ${provider.id.slice(0, 8)} at ${measured.toFixed(1)} tok/s`);
        }
      } else {
        provider.slowJobs = 0;
      }
    }

    const completionTokens = job.completionTokens;
    // Nothing was delivered -> nothing is charged and nothing is earned.
    const billable = completionTokens > 0;
    const viaFallback = job.servedBy === 'fallback';
    // A fallback answer is a flat, reduced charge no matter how long it is, and it pays
    // nobody: no volunteer's GPU produced it, so there is no work to reward.
    const cost = billable
      ? (viaFallback ? roundCoins(config.fallback.coinsFlat) : costForJob(job.promptTokens, completionTokens))
      : 0;
    const earned = billable && !viaFallback ? earningsForJob(completionTokens) : 0;
    const durationMs = job.startedAt ? now() - job.startedAt : null;
    // Only meaningful for a volunteer's GPU: the fallback's speed is somebody else's
    // datacentre and says nothing about the swarm. Guarded against a zero-millisecond
    // elapsed time, which would divide by zero and overflow numeric(10,3).
    const decodeTps = !viaFallback && job.firstTokenAt && completionTokens > 1
      ? clampTps(completionTokens / ((now() - job.firstTokenAt) / 1000))
      : null;

    let charged = 0;
    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO jobs (id, consumer_id, provider_user_id, status, prompt_tokens, completion_tokens,
                             decode_tps, wait_ms, duration_ms, attempts, is_mock, error, finished_at,
                             served_by, fallback_model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13, $14)`,
          [job.id, job.consumerId, job.providerUserId, status, job.promptTokens, completionTokens,
            decodeTps, job.startedAt ? job.startedAt - job.createdAt : null, durationMs, job.attempts,
            job.isMock, code ? String(code).slice(0, 40) : (error ? 'job_error' : null),
            job.servedBy || 'community', job.fallbackModel || null],
        );
        if (cost > 0) {
          const res = await post(client, {
            userId: job.consumerId,
            kind: viaFallback ? 'consume_fallback' : 'consume_tokens',
            coins: -cost,
            jobId: job.id,
            meta: {
              prompt_tokens: job.promptTokens, completion_tokens: completionTokens, status,
              ...(viaFallback ? { fallback_model: job.fallbackModel } : {}),
            },
          });
          if (res.applied) charged = cost;
          else {
            // Balance moved under us (parallel jobs); take what is there, never below zero.
            const { rows } = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [job.consumerId]);
            const avail = Math.max(0, Number(rows[0]?.balance ?? 0));
            if (avail > 0) {
              await post(client, {
                userId: job.consumerId,
                kind: viaFallback ? 'consume_fallback' : 'consume_tokens',
                coins: -avail,
                jobId: job.id,
                meta: {
                  prompt_tokens: job.promptTokens, completion_tokens: completionTokens, status, clamped_from: cost,
                  ...(viaFallback ? { fallback_model: job.fallbackModel } : {}),
                },
              });
              charged = avail;
            }
          }
        }
        // The provider is paid out of what the consumer actually paid. If the consumer
        // could only be charged part of the cost (a balance that moved under us), the
        // payout shrinks by the same fraction - otherwise the difference would be new
        // coins minted out of nothing.
        const settledShare = cost > 0 ? Math.min(1, charged / cost) : 0;
        const payout = roundCoins(earned * settledShare);
        if (payout > 0 && job.providerUserId && job.providerUserId !== job.consumerId) {
          await post(client, {
            userId: job.providerUserId, kind: 'serve_tokens', coins: payout, jobId: job.id,
            meta: {
              completion_tokens: completionTokens, mock: job.isMock, night: job.servedAtNight === true,
              ...(settledShare < 1 ? { partial: Math.round(settledShare * 1000) / 1000 } : {}),
            },
          });
        }
      });
    } catch (err) {
      this.log.error('[coord] settlement failed', err.message);
    }

    // Badges and levels are recomputed from the ledger, never incremented here.
    if (billable) {
      game.touch(job.consumerId, { minIntervalMs: 0 });
      if (job.providerUserId && job.providerUserId !== job.consumerId) game.touch(job.providerUserId, { minIntervalMs: 0 });
    }

    const summary = {
      jobId: job.id,
      status,
      stopReason,
      promptTokens: job.promptTokens,
      completionTokens,
      coinsCharged: charged,
      decodeTps,
      durationMs,
      error,
      code,
      // 'community' = a volunteer's GPU, 'fallback' = the free hosted model.
      servedBy: job.servedBy || 'community',
      fallbackModel: job.fallbackModel || null,
    };
    try {
      if (status === 'done' || status === 'cancelled') job.sink.onDone?.(summary);
      else job.sink.onError?.(summary);
      this.dispatch();
    } finally {
      this.jobs.delete(jobId);
    }
  }

  // ------------------------------------------------------------- stats

  stats() {
    let online = 0; let ready = 0; let busy = 0; let loading = 0;
    let tpsSum = 0; let tpsCount = 0;
    for (const p of this.providers.values()) {
      online += 1;
      if (p.state === 'ready') ready += 1;
      else if (p.state === 'busy') busy += 1;
      else if (p.state === 'loading' || p.state === 'connecting') loading += 1;
      if (p.admitted && p.decodeTps) { tpsSum += p.decodeTps; tpsCount += 1; }
    }
    return {
      providersOnline: online,
      providersReady: ready,
      providersBusy: busy,
      providersLoading: loading,
      queueLength: this.queue.length,
      jobsRunning: [...this.jobs.values()].filter((j) => j.status === 'running').length,
      avgDecodeTps: tpsCount ? Math.round((tpsSum / tpsCount) * 10) / 10 : null,
      capacityTps: Math.round(tpsSum * 10) / 10,
      // Additive only: `providersReady` keeps its old meaning, so anything that watches
      // the network (the auto-router demo does) is unaffected by the fallback existing.
      fallbackEnabled: config.fallback.enabled,
      fallbackUsedToday: this.fallbackUsedToday(),
      fallbackRemainingToday: config.fallback.enabled
        ? Math.max(0, config.fallback.globalPerDay - this.fallbackUsedToday())
        : 0,
      jobsOnFallback: [...this.jobs.values()].filter((j) => j.servedBy === 'fallback').length,
    };
  }

  /**
   * How long each waiting job has already waited, in milliseconds. Used by the operator
   * scaling endpoint: a queue of one that has waited a minute is a different problem
   * from a queue of ten that all arrived a second ago.
   */
  queueWaits() {
    const t = now();
    return this.queue
      .map((id) => this.jobs.get(id))
      .filter((job) => job && job.status === 'queued')
      .map((job) => t - job.queuedAt);
  }

  /** Every connected provider, flat, for operator views. No prompt or account detail. */
  providerSnapshot() {
    return [...this.providers.values()].map((p) => ({
      id: p.id, userId: p.userId, state: p.state, admitted: p.admitted,
      decodeTps: p.decodeTps, jobsServed: p.jobsServed, isMock: p.isMock,
    }));
  }

  providerViewFor(userId) {
    return [...this.providers.values()]
      .filter((p) => p.userId === Number(userId))
      .map((p) => ({
        id: p.id, state: p.state, admitted: p.admitted, decodeTps: p.decodeTps,
        ttftMs: p.ttftMs, minutesCredited: p.minutesCredited, tokensServed: p.tokensServed,
        jobsServed: p.jobsServed, connectedAt: p.connectedAt, isMock: p.isMock,
      }));
  }
}
