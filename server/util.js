import crypto from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Sign a small JSON payload into a cookie-safe string. */
export function signPayload(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/** Verify and decode; returns null on any tampering or expiry. */
export function verifyPayload(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!timingSafeEqual(sig, hmac(secret, body))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (payload && typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

/**
 * Server-side prompt token estimate. The browsers doing the work could lie about how
 * many prompt tokens they saw, so the coordinator never trusts them: it derives the
 * number from the text it relayed. ~3.7 characters per token for this tokenizer family.
 */
export const CHARS_PER_TOKEN = 3.7;
export function estimatePromptTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += String(m.content ?? '').length + String(m.role ?? '').length + 4;
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export function roundCoins(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Fixed-window in-memory limiter. One process, so a plain Map is enough. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  /** @returns {boolean} true when the call is allowed */
  take(key, cost = 1) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: cost, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return cost <= this.limit;
    }
    entry.count += cost;
    return entry.count <= this.limit;
  }
  retryAfterSeconds(key) {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }
  sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
