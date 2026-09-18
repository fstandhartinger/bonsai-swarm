/**
 * Operator endpoints: the statistics dashboard and the live signal the autoscaler on
 * Sandy polls every two minutes.
 *
 * Two ways in, both of which already exist in this app:
 *
 *  - signed in on an **admin account**, with the session cookie or one of that
 *    account's API tokens. This is the normal route: open /ops.html while signed in and
 *    the dashboard is simply there, with no shared secret to hand around.
 *  - a standalone **`OPS_TOKEN`** bearer token, for a deployment that wants a dashboard
 *    without an admin account, and for scripts. Unset by default.
 *
 * Nothing here is cached by a browser or a proxy and there is no CORS header, so a page
 * on another origin can never read it even with a token.
 */
import express from 'express';
import { config } from '../config.js';
import { timingSafeEqual } from '../util.js';
import { operatorReport, scalingSignal } from '../stats.js';

function requireOperator(req, res, next) {
  // The auth middleware has already resolved a session cookie or API token.
  if (req.user?.is_admin) {
    res.set('cache-control', 'no-store');
    return next();
  }
  if (config.ops.token) {
    const header = String(req.headers.authorization || '');
    const offered = header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : String(req.headers['x-ops-token'] || '');
    if (offered && timingSafeEqual(offered, config.ops.token)) {
      res.set('cache-control', 'no-store');
      return next();
    }
  }
  return res.status(401).json({
    error: 'unauthorized',
    message: 'Sign in with an operator account, or send the OPS_TOKEN as a bearer token.',
  });
}

export function opsRouter(coordinator) {
  const router = express.Router();

  /** What the dashboard page needs to explain itself before it has any access. */
  router.get('/enabled', (req, res) => res.json({
    enabled: true,
    admin: Boolean(req.user?.is_admin),
    tokenConfigured: Boolean(config.ops.token),
  }));

  router.get('/stats', requireOperator, async (req, res, next) => {
    try {
      res.json(await operatorReport({ days: req.query.days }));
    } catch (err) { next(err); }
  });

  router.get('/scaling', requireOperator, async (req, res, next) => {
    try {
      res.json(await scalingSignal(coordinator));
    } catch (err) { next(err); }
  });

  return router;
}
