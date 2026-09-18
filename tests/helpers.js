/**
 * Test harness: boots a real server (real Postgres, real WebSockets) on a random port
 * with the mock provider standing in for a volunteer GPU.
 */
import { readFileSync, existsSync } from 'node:fs';

if (existsSync(new URL('../.env', import.meta.url))) {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.SESSION_SECRET ||= 'test-secret-that-is-long-enough-000000';
process.env.TEST_MODE_KEY ||= 'test-mode-key';
process.env.PUBLIC_URL = 'http://127.0.0.1:0';
process.env.PROVIDER_HEARTBEAT_MS ||= '60000';
process.env.JOB_QUEUE_TIMEOUT_MS ||= '5000';
process.env.JOB_FIRST_TOKEN_TIMEOUT_MS ||= '3000';
process.env.JOB_IDLE_TIMEOUT_MS ||= '3000';

const { createServer } = await import('../server/index.js');
const { pool } = await import('../server/db.js');

export { pool };
export const TEST_KEY = process.env.TEST_MODE_KEY;

export async function startTestServer(overrides = {}) {
  for (const [k, v] of Object.entries(overrides)) process.env[k] = String(v);
  const { server, coordinator, app } = await createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url, server, coordinator, app, port,
    async close() {
      coordinator.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Settlement and badge evaluation run after a job finishes, so a TRUNCATE right after a
 * test can collide with a transaction that is still committing. Retry rather than fail.
 */
export async function resetDb() {
  const attempts = 6;   // no parameter: node:test passes the test context to beforeEach hooks
  for (let i = 0; i < attempts; i += 1) {
    try {
      await pool.query('TRUNCATE ledger, achievements, jobs, provider_sessions, api_tokens, login_attempts, users RESTART IDENTITY CASCADE');
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

/** Tiny fetch wrapper that keeps cookies, like a browser would. */
export function client(baseUrl) {
  let cookie = '';
  const origin = baseUrl;
  return {
    get cookie() { return cookie; },
    async req(path, { method = 'GET', body, headers = {}, raw = false, noOrigin = false, redirect = 'follow' } = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        // `redirect: 'manual'` is how a test inspects where a sign-in flow sends people
        // instead of being taken there.
        redirect,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...(noOrigin ? {} : { origin }),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie?.() || [];
      for (const c of setCookie) {
        const [pair] = c.split(';');
        const [name] = pair.split('=');
        const others = cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`));
        cookie = [...others, pair].join('; ');
      }
      if (raw) return res;
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
}

/** Reads a text/event-stream response into a list of {event, data}. */
export async function readSse(res) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* [DONE] */ }
        events.push({ event, data: parsed });
      }
    }
  }
  return events;
}

export async function signUp(c, username, password = 'correct-horse-battery') {
  const res = await c.req('/api/auth/signup', { method: 'POST', body: { username, password } });
  if (res.status !== 200) throw new Error(`signup failed: ${res.text}`);
  return res.json.user;
}

export async function createToken(c, name = 'test') {
  const res = await c.req('/api/tokens', { method: 'POST', body: { name } });
  if (res.status !== 200) throw new Error(`token creation failed: ${res.text}`);
  return res.json.token;
}

/** Opens an SSE POST and yields events as they arrive, so a test can act mid-stream. */
export async function openSse(baseUrl, path, { body, headers = {}, cookie = '' }) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const events = [];
  const waiters = [];
  let done = false;
  (async () => {
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* [DONE] */ }
          const ev = { event, data: parsed };
          events.push(ev);
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch { /* aborted */ }
    done = true;
    for (const w of waiters.splice(0)) w();
  })();

  return {
    status: res.status,
    events,
    abort: () => controller.abort(),
    /** Waits until `predicate(events)` is true or the timeout expires. */
    async until(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        if (done) return events;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for SSE condition; saw ${JSON.stringify(events.map((e) => e.event))}`);
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, Math.min(50, left)); });
      }
      return events;
    },
    get done() { return done; },
  };
}

export const waitFor = async (fn, timeoutMs = 5000, step = 25) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
};
