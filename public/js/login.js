import { $, api, mountChrome } from './common.js';

const params = new URLSearchParams(location.search);
const next = params.get('next') || '/chat.html';
// Automated end-to-end runs pass the server's test key so throwaway accounts do not
// trip the per-connection signup limit. Normal visitors never have this value.
const testKey = params.get('testKey') || '';

const ERRORS = {
  google_disabled: 'Google sign-in is not configured on this server yet. Use a username and password.',
  oauth_state: 'That sign-in attempt expired. Please try again.',
  oauth_cancelled: 'Google sign-in was cancelled.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  disabled: 'This account is disabled.',
};

const me = await mountChrome();
if (me.signedIn) location.href = next;

const cfg = await api('/api/config');
$('#welcome').textContent = cfg.coins.welcome;
if (cfg.googleEnabled) $('#google-box').hidden = false;
if (params.get('error')) $('#li-error').textContent = ERRORS[params.get('error')] || 'Sign-in failed.';

const submit = (formId, path, errorId) => {
  $(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button');
    button.disabled = true;
    $(errorId).textContent = '';
    try {
      await api(path, {
        method: 'POST',
        headers: testKey ? { 'x-test-mode-key': testKey } : {},
        body: { username: form.username.value.trim(), password: form.password.value },
      });
      location.href = next;
    } catch (err) {
      $(errorId).textContent = err.message;
      button.disabled = false;
    }
  });
};

submit('#signup-form', '/api/auth/signup', '#su-error');
submit('#login-form', '/api/auth/login', '#li-error');
