#!/usr/bin/env node
/**
 * Deterministic fake volunteer GPU.
 *
 * Sandy has no GPU, so every automated test (unit, integration and the Playwright run
 * against the deployed app) uses this instead of a real browser running Bonsai 2.
 * It speaks exactly the provider protocol and streams a fixed number of tokens.
 *
 * It can only attach when the server was started with TEST_MODE_KEY and the same key is
 * presented here, so it is unreachable for normal users.
 */
import WebSocket from 'ws';

export class MockProvider {
  constructor({ url, token, testKey, decodeTps = 42, tokens = 8, delayMs = 5, override = false, label = 'Mock GPU' }) {
    Object.assign(this, { url, token, testKey, decodeTps, tokens, delayMs, override, label });
    this.served = 0;
    this.cancelled = new Set();
    this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
  }

  connect() {
    const wsUrl = new URL(this.url);
    wsUrl.pathname = '/ws/provider';
    wsUrl.searchParams.set('mock', '1');
    if (this.override) wsUrl.searchParams.set('override', '1');
    this.ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${this.token}`, 'x-test-mode-key': this.testKey },
    });
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    this.ws.on('error', (err) => this._rejectReady(err));
    this.ws.on('unexpected-response', (_req, res) => this._rejectReady(new Error(`handshake ${res.statusCode}`)));
    return this.ready;
  }

  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.providerId = msg.providerId;
        this.send({ type: 'status', state: 'loading', gpuLabel: this.label });
        setTimeout(() => this.send({ type: 'benchmark', decodeTps: this.decodeTps, ttftMs: 120 }), 10);
        break;
      case 'admission':
        this.admitted = msg.admitted;
        this.send({ type: 'status', state: 'ready', gpuLabel: this.label });
        this._resolveReady(msg);
        break;
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        break;
      case 'job.start':
        this.runJob(msg);
        break;
      case 'job.cancel':
        this.cancelled.add(msg.jobId);
        break;
      default:
        break;
    }
  }

  async runJob(job) {
    const count = Math.max(1, Math.min(this.tokens, job.maxNewTokens));
    for (let i = 0; i < count; i += 1) {
      if (this.cancelled.has(job.jobId)) return;
      await new Promise((r) => setTimeout(r, this.delayMs));
      this.send({ type: 'job.delta', jobId: job.jobId, delta: i === 0 ? 'mock' : ` t${i}` });
    }
    if (this.cancelled.has(job.jobId)) return;
    this.served += 1;
    this.send({ type: 'job.done', jobId: job.jobId, stopReason: 'stop' });
  }

  pause() { this.send({ type: 'status', state: 'paused' }); }
  resume() { this.send({ type: 'status', state: 'ready' }); }
  close() { try { this.ws?.close(); } catch { /* already closed */ } }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.BSW_URL || 'http://localhost:3000';
  const provider = new MockProvider({
    url,
    token: process.env.BSW_TOKEN,
    testKey: process.env.BSW_TEST_KEY,
    decodeTps: Number(process.env.BSW_MOCK_TPS || 42),
    tokens: Number(process.env.BSW_MOCK_TOKENS || 8),
    override: process.env.BSW_MOCK_OVERRIDE === '1',
    label: process.env.BSW_MOCK_LABEL || 'Mock GPU',
  });
  const admission = await provider.connect();
  console.log(`[mock] connected to ${url}, admitted=${admission.admitted}, tps=${admission.decodeTps}`);
  process.on('SIGINT', () => { provider.close(); process.exit(0); });
  process.on('SIGTERM', () => { provider.close(); process.exit(0); });
}
