import crypto from 'node:crypto';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { post, costForJob, earningsForJob, affordableCompletionTokens } from './coins.js';
import { estimatePromptTokens, roundCoins } from './util.js';
import * as game from './gamification.js';

const now = () => Date.now();

/** 22:00-06:00 at the provider's own desk, from the offset its browser reported. */
export function isNightFor(tzOffsetMinutes = 0) {
  const local = new Date(Date.now() + (Number(tzOffsetMinutes) || 0) * 60_000);
  const hour = local.getUTCHours();
  return hour >= 22 || hour < 6;
}
const newId = () => crypto.randomUUID();

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
  }

  start() {
    this.timers.push(setInterval(() => this.sweep(), 10_000));
    this.timers.push(setInterval(() => this.creditOnlineMinutes().catch((e) => this.log.error('[coord] minute credit failed', e.message)), 30_000));
    this.timers.push(setInterval(() => this.pingAll(), config.provider.heartbeatMs));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
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
        return this.finishJob(provider.currentJobId, 'failed', { error: String(msg.message || 'provider error').slice(0, 300) });
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

  async handleBenchmark(provider, msg) {
    const tps = Number(msg.decodeTps);
    const ttft = Number(msg.ttftMs);
    provider.decodeTps = Number.isFinite(tps) ? Math.round(tps * 1000) / 1000 : null;
    provider.ttftMs = Number.isFinite(ttft) ? Math.round(ttft) : null;
    const fast = (provider.decodeTps ?? 0) >= config.provider.minDecodeTps;
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
        else await this.finishJob(job.id, 'failed', { error: `The GPU that was answering you went offline (${reason}).` });
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
    for (const p of list) {
      const eligible = p.admitted && (p.state === 'ready' || p.state === 'busy') && now() - p.lastSeen < config.provider.staleMs;
      if (!eligible || p.creditedFrom === null) continue;
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
  async submit({ user, messages, maxNewTokens, enableThinking = false, sink }) {
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
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    sink.onQueued?.({ jobId: job.id, position: this.queue.indexOf(job.id) + 1, maxNewTokens: cap, promptTokens, cappedByBalance: job.cappedByBalance });
    this.dispatch();
    return job;
  }

  /** AI Coins that in-flight jobs of this user could still cost, so parallel requests cannot overdraw. */
  reservedFor(userId) {
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.consumerId !== Number(userId)) continue;
      total += costForJob(job.promptTokens, job.maxNewTokens - job.completionTokens);
    }
    return roundCoins(total);
  }

  pickProvider(job) {
    let best = null;
    for (const p of this.providers.values()) {
      if (p.state !== 'ready' || !p.admitted) continue;
      if (p.userId === job.consumerId) continue;          // no self-serving: own prompts never earn AI Coins
      if (job.triedProviders.has(p.id)) continue;
      if (now() - p.lastSeen > config.provider.staleMs) continue;
      if (!best || (p.decodeTps ?? 0) > (best.decodeTps ?? 0)) best = p;
    }
    return best;
  }

  dispatch() {
    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') { this.queue = this.queue.filter((id) => id !== jobId); continue; }
      const provider = this.pickProvider(job);
      if (!provider) continue;

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
      else this.finishJob(job.id, 'failed', { error: 'The volunteer GPU stopped responding.' }).catch((e) => this.log.error(e.message));
    }, ms);
    job.idleTimer.unref?.();
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
    const delta = typeof msg.delta === 'string' ? msg.delta : '';
    if (!delta) return;

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
    await this.finishJob(job.id, 'cancelled', { stopReason: 'cancelled' });
    return true;
  }

  /**
   * Settle a job exactly once: charge the consumer for what was delivered, pay the
   * provider for the same tokens, and record aggregate counts only - never the prompt
   * or the answer.
   */
  async finishJob(jobId, status, { error = null, stopReason = null } = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    this.queue = this.queue.filter((id) => id !== jobId);
    if (job.idleTimer) { clearTimeout(job.idleTimer); job.idleTimer = null; }
    job.status = status;

    const provider = this.providers.get(job.providerId);
    if (provider && provider.currentJobId === job.id) {
      provider.jobsServed += 1;
      this.releaseProvider(provider);
    }

    const completionTokens = job.completionTokens;
    // Nothing was delivered -> nothing is charged and nothing is earned.
    const billable = completionTokens > 0;
    const cost = billable ? costForJob(job.promptTokens, completionTokens) : 0;
    const earned = billable ? earningsForJob(completionTokens) : 0;
    const durationMs = job.startedAt ? now() - job.startedAt : null;
    const decodeTps = job.firstTokenAt && completionTokens > 1
      ? Math.round((completionTokens / ((now() - job.firstTokenAt) / 1000)) * 1000) / 1000
      : null;

    let charged = 0;
    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO jobs (id, consumer_id, provider_user_id, status, prompt_tokens, completion_tokens,
                             decode_tps, wait_ms, duration_ms, attempts, is_mock, error, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
          [job.id, job.consumerId, job.providerUserId, status, job.promptTokens, completionTokens,
            decodeTps, job.startedAt ? job.startedAt - job.createdAt : null, durationMs, job.attempts,
            job.isMock, error ? String(error).slice(0, 300) : null],
        );
        if (cost > 0) {
          const res = await post(client, {
            userId: job.consumerId, kind: 'consume_tokens', coins: -cost, jobId: job.id,
            meta: { prompt_tokens: job.promptTokens, completion_tokens: completionTokens, status },
          });
          if (res.applied) charged = cost;
          else {
            // Balance moved under us (parallel jobs); take what is there, never below zero.
            const { rows } = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [job.consumerId]);
            const avail = Math.max(0, Number(rows[0]?.balance ?? 0));
            if (avail > 0) {
              await post(client, {
                userId: job.consumerId, kind: 'consume_tokens', coins: -avail, jobId: job.id,
                meta: { prompt_tokens: job.promptTokens, completion_tokens: completionTokens, status, clamped_from: cost },
              });
              charged = avail;
            }
          }
        }
        if (earned > 0 && job.providerUserId && job.providerUserId !== job.consumerId) {
          await post(client, {
            userId: job.providerUserId, kind: 'serve_tokens', coins: earned, jobId: job.id,
            meta: { completion_tokens: completionTokens, mock: job.isMock, night: job.servedAtNight === true },
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
    };
    if (status === 'done' || status === 'cancelled') job.sink.onDone?.(summary);
    else job.sink.onError?.(summary);
    this.dispatch();
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
    };
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
