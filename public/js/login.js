// One way in: Google. The page's only other job is to say what the app is, because a
// visitor who has not seen the landing page should not have to sign in to find out.
import { $, api, fmt, mountChrome } from './common.js';

const params = new URLSearchParams(location.search);
const next = params.get('next') || '/chat.html';

const ERRORS = {
  google_disabled: 'Google sign-in is not configured on this server yet.',
  oauth_state: 'That sign-in attempt expired. Please try again.',
  oauth_cancelled: 'Google sign-in was cancelled.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  disabled: 'This account is disabled.',
};

const me = await mountChrome();
if (me.signedIn) location.href = next;

const cfg = await api('/api/config');
$('#welcome').textContent = `${fmt.int(cfg.coins.welcome)} AI Coins`;
if (params.get('error')) $('#error').textContent = ERRORS[params.get('error')] || 'Sign-in failed.';
if (!cfg.googleEnabled) {
  $('#google-btn').classList.add('disabled');
  $('#error').textContent = ERRORS.google_disabled;
}
// Carry the visitor back to where they were headed once Google sends them home.
$('#google-btn').href = `/api/auth/google/start?next=${encodeURIComponent(next)}`;

try {
  const s = await api('/api/stats/public');
  $('#s-providers').textContent = fmt.int(s.providersOnline);
  $('#k-providers').textContent = s.providersOnline === 1 ? 'GPU online' : 'GPUs online';
  $('#s-capacity').textContent = `${Number(s.capacityTps || 0).toFixed(1)} tok/s`;
  $('#s-tokens').textContent = fmt.int(s.tokensToday);
} catch { /* the strip is decoration; a failure must not block signing in */ }
