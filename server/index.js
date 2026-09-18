import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parse as parseCookie } from 'cookie';
import { WebSocketServer } from 'ws';

import { config, requireSecrets } from './config.js';
import { migrate, pool } from './db.js';
import * as authModule from './auth.js';
import { authRouter } from './routes/auth-routes.js';
import { apiRouter } from './routes/api.js';
import { opsRouter } from './routes/ops.js';
import { openaiRouter } from './routes/openai.js';
import { mountRuntime, loadRuntime } from './runtime.js';
import { Coordinator } from './coordinator.js';
import { visitCounter } from './visit-stats.js';
import { timingSafeEqual } from './util.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function createServer({ migrateDb = true } = {}) {
  requireSecrets();
  if (migrateDb) await migrate();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    req.cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    next();
  });
  // minimal res.cookie / res.clearCookie without an extra dependency
  app.use((req, res, next) => {
    res.cookie = (name, value, opts = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`];
      if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
      parts.push(`Path=${opts.path || '/'}`);
      if (opts.httpOnly) parts.push('HttpOnly');
      if (opts.secure) parts.push('Secure');
      if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
      res.append('Set-Cookie', parts.join('; '));
      return res;
    };
    res.clearCookie = (name, opts = {}) => res.cookie(name, '', { ...opts, maxAge: 0 });
    next();
  });

  app.use((req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=(), microphone=(), camera=()',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "font-src 'self' data: https://cdn.jsdelivr.net",
        "img-src 'self' data: blob:",
        // model weights come from the Hugging Face CDN, straight into the volunteer's browser
        "connect-src 'self' https://huggingface.co https://cdn-lfs.hf.co https://cdn-lfs-us-1.hf.co https://*.hf.co https://*.huggingface.co wss: ws:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
      ].join('; '),
    });
    next();
  });

  const coordinator = new Coordinator();
  coordinator.start();
  app.set('coordinator', coordinator);

  // Counts page loads only, from headers the browser already sent. Mounted before the
  // routers so it sees every page request, and before auth so it never touches an account.
  app.use(visitCounter({ enabled: config.visitStats }));

  app.use(authModule.authMiddleware());
  app.use(authModule.csrfGuard);

  mountRuntime(app);
  app.use('/api/auth', authRouter());
  app.use('/api', apiRouter(coordinator));
  app.use('/api/ops', opsRouter(coordinator));
  app.use('/api/v1', openaiRouter(coordinator));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m', index: 'index.html' }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    res.status(404).sendFile(path.join(publicDir, '404.html'), (err) => { if (err) res.type('text/plain').send('Not found'); });
  });

  // eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
  app.use((err, req, res, next) => {
    console.error('[http]', err.stack || err.message);
    if (res.headersSent) return res.end();
    res.status(err.status || 500).json({ error: err.code || 'server_error', message: err.expose ? err.message : 'Something went wrong.' });
  });

  const server = http.createServer(app);
  attachProviderSocket(server, coordinator);
  return { app, server, coordinator };
}

/**
 * Providers connect here. The socket is authenticated before the upgrade completes,
 * so an unauthenticated peer never gets a WebSocket at all.
 */
function attachProviderSocket(server, coordinator) {
  // A provider frame carries one token plus a job id - a kilobyte is already generous.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/provider') return socket.destroy();
    try {
      const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
      let user = null;
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) user = await authModule.userFromApiToken(header.slice(7).trim());
      if (!user && cookies[authModule.SESSION_COOKIE]) user = await authModule.userFromSessionToken(cookies[authModule.SESSION_COOKIE]);
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }

      // Browsers send Origin on WebSocket handshakes; reject cross-site attempts.
      const origin = req.headers.origin;
      if (origin && !authModule.isSameSiteOrigin(req, origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
      }

      // One account may not open an unbounded number of provider sockets.
      const mine = coordinator.providerViewFor(user.id).length;
      if (mine >= config.provider.maxSessionsPerUser) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy();
      }

      // Test mode: a deterministic fake provider, and admission for a slow GPU.
      // Both need the shared TEST_MODE_KEY, so normal users can never reach them.
      const offeredKey = String(req.headers['x-test-mode-key'] || url.searchParams.get('testKey') || '');
      const testMode = Boolean(config.testModeKey) && offeredKey.length > 0 && timingSafeEqual(offeredKey, config.testModeKey);
      if (url.searchParams.get('mock') === '1' && !testMode) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
      }
      const isMock = testMode && url.searchParams.get('mock') === '1';
      const adminOverride = (testMode || user.is_admin) && url.searchParams.get('override') === '1';

      wss.handleUpgrade(req, socket, head, async (ws) => {
        const tzRaw = Number(url.searchParams.get('tz'));
        const provider = await coordinator.addProvider({
          ws, user, isMock, adminOverride, userAgent: req.headers['user-agent'] || '',
          tzOffsetMinutes: Number.isFinite(tzRaw) ? tzRaw : 0,
        });
        ws.on('message', (data) => {
          coordinator.handleProviderMessage(provider, data.toString())
            .catch((e) => console.error('[ws] message failed', e.message));
        });
        ws.on('close', () => coordinator.removeProvider(provider.id, 'closed').catch((e) => console.error(e.message)));
        ws.on('error', (e) => console.error('[ws] socket error', e.message));
      });
    } catch (err) {
      console.error('[ws] upgrade failed', err.message);
      socket.destroy();
    }
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const { server, coordinator } = await createServer();
  // warm the runtime cache so the first volunteer does not wait for Hugging Face
  loadRuntime().then((r) => console.log(`[runtime] ${r.code.length} bytes from ${r.source}`))
    .catch((e) => console.error('[runtime] warmup failed:', e.message));
  server.listen(config.port, () => console.log(`bonsai-swarm listening on :${config.port} (${config.publicUrl})`));

  const shutdown = async (signal) => {
    console.log(`[server] ${signal}, shutting down`);
    coordinator.stop();
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
