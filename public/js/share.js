// "Share my GPU" - loads Ternary Bonsai 2 in a worker and serves the network.
import {
  $, api, el, fmt, mountChrome, requireSignIn, setBalance, pollProfile, rollTo, toast, coinBurst,
} from './common.js';

const params = new URLSearchParams(location.search);
// Automated tests only: a deterministic fake model instead of a real WebGPU run.
// The server only treats it as a mock when the shared test key matches, so this does
// nothing for a normal visitor.
const MOCK = params.get('provider') === 'mock';
const TEST_KEY = params.get('testKey') || '';
const ADMIN_OVERRIDE = params.get('override') === '1';
// The downloadable client opens this page because the user typed `provide`; it does not
// need a second click. Never set for somebody who just browsed here.
const AUTOSTART = params.get('autostart') === '1';

const state = {
  sharing: false,
  paused: false,
  admitted: false,
  decodeTps: null,
  ws: null,
  worker: null,
  jobs: 0,
  tokens: 0,
  startedAt: null,
  reconnectTimer: null,
  benchmarkDone: false,
  sessionCoins: 0,
  balanceAtStart: null,
  profile: null,
};

const ui = {};

async function boot() {
  // The downloadable client opens this page with #code=... - a single-use, 60-second
  // hand-off code, never the API token itself. The fragment never reaches a log.
  if (location.hash.startsWith('#code=') || location.hash.startsWith('#token=')) {
    const isCode = location.hash.startsWith('#code=');
    const value = decodeURIComponent(location.hash.slice(isCode ? 6 : 7));
    history.replaceState(null, '', location.pathname + location.search);
    await api('/api/auth/token-session', { method: 'POST', body: isCode ? { code: value } : { token: value } })
      .catch((err) => { if (err.code === 'already_signed_in') alert(err.message); });
  }
  const me = await mountChrome();
  if (!requireSignIn(me)) return;
  const cfg = await api('/api/config');

  ui.status = $('#status');
  ui.statusDot = $('#status-dot');
  ui.progress = $('#progress');
  ui.bar = $('#progress .bar i');
  ui.log = $('#log');
  ui.startBtn = $('#start');
  ui.pauseBtn = $('#pause');
  ui.stopBtn = $('#stop');
  ui.stats = $('#live-stats');
  ui.tps = $('#tps');
  ui.badges = $('#badges');

  $('#download-size').textContent = fmt.bytes(cfg.model.downloadBytes);
  $('#min-tps').textContent = cfg.minDecodeTps;
  $('#per-minute').textContent = cfg.coins.providePerMinute;
  $('#per-token').textContent = cfg.coins.servePerToken;

  ui.startBtn.onclick = () => start(cfg);
  ui.pauseBtn.onclick = togglePause;
  ui.stopBtn.onclick = () => stop('you stopped sharing');

  window.addEventListener('beforeunload', () => { try { state.ws?.close(); } catch { /* closing anyway */ } });
  setInterval(refreshStats, 15000);
  refreshStats();
  if (AUTOSTART) start(cfg);
}

function log(message, kind = '') {
  const line = el('div', { className: `log-line ${kind}`, textContent: `${new Date().toLocaleTimeString()}  ${message}` });
  ui.log.prepend(line);
  while (ui.log.childElementCount > 60) ui.log.lastElementChild.remove();
}

function setStatus(text, dot = '') {
  ui.status.textContent = text;
  ui.statusDot.className = `dot ${dot}`;
}

async function start(cfg) {
  ui.startBtn.disabled = true;
  state.sharing = true;
  state.startedAt = Date.now();
  state.balanceAtStart = null;

  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persist().catch(() => false);
    log(persisted
      ? 'Browser storage marked as persistent - the 5.9 GB download is kept between visits.'
      : 'The browser would not mark storage as persistent; the model may have to be downloaded again later.');
  }

  setStatus('Starting the inference worker...', 'busy');
  state.worker = MOCK ? mockWorker() : new Worker('/js/bonsai-worker.js', { type: 'module' });
  state.worker.onmessage = (e) => onWorkerMessage(e.data, cfg);
  state.worker.onerror = (e) => { log(`Worker error: ${e.message}`, 'error'); stop('the worker crashed'); };
  state.worker.postMessage({ cmd: 'check' });
}

function onWorkerMessage(msg, cfg) {
  switch (msg.type) {
    case 'availability':
      if (!msg.ok) {
        setStatus('WebGPU is not available in this browser.', 'bad');
        log(msg.reason || 'WebGPU unavailable.', 'error');
        ui.startBtn.disabled = false;
        state.sharing = false;
        return;
      }
      log('WebGPU is available. Connecting to the network...');
      connect(cfg);
      setStatus('Loading the model (first time: about 5.9 GB)...', 'busy');
      ui.progress.hidden = false;
      send({ type: 'status', state: 'loading' });
      state.worker.postMessage({ cmd: 'load', maxLength: cfg.model.maxLength, enableThinking: false });
      return;

    case 'progress': {
      const pct = msg.total ? Math.round((msg.loaded / msg.total) * 100) : null;
      ui.bar.style.width = pct === null ? '40%' : `${pct}%`;
      ui.progress.querySelector('.label').textContent =
        `${msg.message || msg.status || 'working'}${pct === null ? '' : ` - ${pct}%`}${msg.fromCache ? ' (from cache)' : ''}`;
      return;
    }

    case 'loaded':
      ui.progress.hidden = true;
      log(`Model ready after ${fmt.duration(msg.ms)}${msg.gpuLabel ? ` on ${msg.gpuLabel}` : ''}.`);
      if (msg.gpuLabel) send({ type: 'status', state: 'loading', gpuLabel: msg.gpuLabel });
      setStatus('Measuring your GPU speed...', 'busy');
      state.worker.postMessage({ cmd: 'benchmark', maxNewTokens: cfg.benchmarkTokens });
      return;

    case 'benchmark':
      state.decodeTps = msg.decodeTps;
      state.benchmarkDone = true;
      ui.tps.textContent = `${msg.decodeTps.toFixed(1)} tok/s`;
      log(`Measured ${msg.decodeTps.toFixed(1)} tokens/s (first token after ${Math.round(msg.ttftMs)} ms).`);
      send({ type: 'benchmark', decodeTps: msg.decodeTps, ttftMs: msg.ttftMs });
      return;

    case 'job-delta':
      state.tokens += 1;
      send({ type: 'job.delta', jobId: msg.jobId, delta: msg.delta });
      return;

    case 'job-done':
      state.jobs += 1;
      rollTo($('#jobs-served'), state.jobs, { format: fmt.int, ms: 400 });
      rollTo($('#tokens-served'), state.tokens, { format: fmt.int, ms: 400 });
      coinBurst($('#jobs-served'), Math.min(10, 3 + Math.round(msg.tokens / 40)));
      send({ type: 'job.done', jobId: msg.jobId, stopReason: msg.stopReason });
      setStatus(state.paused ? 'Paused - finishing nothing new.' : 'Online and waiting for the next request.', state.paused ? 'busy' : 'on');
      log(`Served a request: ${msg.tokens} tokens in ${fmt.duration(msg.ms)}.`);
      refreshStats();
      return;

    case 'job-error':
      send({ type: 'job.error', jobId: msg.jobId, message: msg.message });
      log(`A request failed: ${msg.message}`, 'error');
      return;

    case 'error':
      log(`${msg.stage}: ${msg.message}`, 'error');
      setStatus('Something went wrong - see the log below.', 'bad');
      return;

    default:
  }
}

// ------------------------------------------------------------------ network

function connect(cfg) {
  const url = new URL('/ws/provider', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (MOCK) url.searchParams.set('mock', '1');
  if (TEST_KEY) url.searchParams.set('testKey', TEST_KEY);
  if (ADMIN_OVERRIDE) url.searchParams.set('override', '1');
  // The coordinator needs to know what time it is where this GPU stands (night-owl badge).
  url.searchParams.set('tz', String(-new Date().getTimezoneOffset()));

  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => log('Connected to the coordinator.');
  ws.onmessage = (e) => onServerMessage(JSON.parse(e.data), cfg);
  ws.onclose = () => {
    if (!state.sharing) return;
    setStatus('Connection lost - reconnecting...', 'busy');
    log('Connection to the coordinator lost, retrying in 5 s.', 'error');
    state.reconnectTimer = setTimeout(() => connect(cfg), 5000);
  };
  ws.onerror = () => log('WebSocket error.', 'error');
}

function send(msg) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg));
}

function onServerMessage(msg, cfg) {
  switch (msg.type) {
    case 'welcome':
      // After a reconnect the model is still loaded - just replay the measurement.
      if (state.benchmarkDone) {
        send({ type: 'benchmark', decodeTps: state.decodeTps, ttftMs: 0 });
      }
      return;
    case 'ping':
      send({ type: 'pong', t: msg.t });
      return;
    case 'admission':
      state.admitted = msg.admitted;
      ui.pauseBtn.hidden = !msg.admitted;
      if (msg.admitted) {
        setStatus(msg.viaOverride
          ? 'Online (admitted by an admin override - this GPU is below the normal bar).'
          : 'Online and waiting for requests.', 'on');
        log(`Admitted to the swarm at ${Number(msg.decodeTps).toFixed(1)} tokens/s.`);
        toast({ icon: '🌳', title: 'You are in the swarm', sub: `Admitted at ${Number(msg.decodeTps).toFixed(1)} tokens/s. Coins start ticking now.`, ms: 5000 });
        coinBurst($('#status'), 6);
        send({ type: 'status', state: 'ready' });
      } else {
        setStatus('Too slow to serve other people - but your own chat still works.', 'bad');
        log(msg.reason || 'Not admitted.', 'error');
      }
      return;
    case 'job.start':
      setStatus('Answering a request from the network...', 'busy');
      state.worker.postMessage({
        cmd: 'generate',
        jobId: msg.jobId,
        messages: msg.messages,
        maxNewTokens: msg.maxNewTokens,
        enableThinking: msg.enableThinking,
      });
      return;
    case 'job.cancel':
      state.worker.postMessage({ cmd: 'cancel', jobId: msg.jobId });
      return;
    default:
  }
}

function togglePause() {
  state.paused = !state.paused;
  ui.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  send({ type: 'status', state: state.paused ? 'paused' : 'ready' });
  setStatus(state.paused ? 'Paused - no new requests.' : 'Online and waiting for requests.', state.paused ? 'busy' : 'on');
  log(state.paused ? 'Paused.' : 'Resumed.');
}

function stop(reason) {
  state.sharing = false;
  clearTimeout(state.reconnectTimer);
  try { state.ws?.close(); } catch { /* closing anyway */ }
  state.worker?.postMessage({ cmd: 'dispose' });
  setTimeout(() => { state.worker?.terminate?.(); state.worker = null; }, 200);
  setStatus(`Not sharing (${reason}).`);
  ui.startBtn.disabled = false;
  ui.pauseBtn.hidden = true;
  log(`Stopped: ${reason}.`);
}

async function refreshStats() {
  try {
    const [stats, me] = await Promise.all([api('/api/stats'), api('/api/me')]);
    $('#net-providers').textContent = `${stats.providersReady} ready / ${stats.providersOnline} online`;
    $('#net-queue').textContent = fmt.int(stats.queueLength);
    if (!me.signedIn) return;

    const mine = me.providers?.[0];
    if (mine) rollTo($('#minutes'), mine.minutesCredited, { format: fmt.int, ms: 400 });

    // One source of truth: the balance from the ledger. Everything visible follows it.
    const balance = Number(me.user.balance);
    if (state.balanceAtStart === null && state.sharing) state.balanceAtStart = balance;
    rollTo($('#balance'), balance);
    setBalance(balance, { origin: $('#live-stats') });
    if (state.balanceAtStart !== null) {
      state.sessionCoins = Math.max(0, balance - state.balanceAtStart);
      rollTo($('#session-coins'), state.sessionCoins);
    }

    const profile = await pollProfile({ origin: $('#wallet-card') });
    if (profile) renderProfile(profile);
  } catch { /* transient */ }
}

/** Level ring, streak and badge wall - every value comes from the server. */
function renderProfile(p) {
  const first = state.profile === null;
  state.profile = p;
  $('#level-ring').style.setProperty('--p', Math.round((p.level.progress || 0) * 100));
  $('#level-num').textContent = p.level.level;
  $('#level-name').textContent = p.level.name;
  $('#level-progress').textContent = p.level.next
    ? `${fmt.coins(p.level.toNext)} AI Coins to level ${p.level.next.level} · ${p.level.next.name}`
    : 'Top level reached. The bonsai is old growth now.';

  const streak = $('#streak-box');
  streak.hidden = !p.streak.current;
  $('#streak-n').textContent = p.streak.current;

  $('#badges').replaceChildren(...p.achievements.map((a) => el('div', { className: `badge${a.unlocked ? ' got' : ''}` },
    el('div', { className: 'ico', textContent: a.icon }),
    el('div', { className: 'nm', textContent: a.name }),
    el('div', { className: 'ht', textContent: a.unlocked ? new Date(a.unlockedAt).toLocaleDateString() : a.hint }))));

  if (first && p.streak.current >= 2 && p.streak.activeToday) {
    toast({ icon: '🔥', title: `${p.streak.current} day streak`, sub: 'Keep sharing tomorrow to hold it.', ms: 5000 });
  }
}

// ------------------------------------------------------------------ mock

/** Stands in for the real worker in automated tests. Same message protocol. */
function mockWorker() {
  const listeners = {};
  const cancelled = new Set();
  const self_ = {
    postMessage(msg) { handle(msg); },
    terminate() {},
    set onmessage(fn) { listeners.message = fn; },
    set onerror(fn) { listeners.error = fn; },
  };
  const emit = (data) => listeners.message?.({ data });
  async function handle(msg) {
    if (msg.cmd === 'check') return emit({ type: 'availability', ok: true });
    if (msg.cmd === 'load') { emit({ type: 'progress', status: 'mock', loaded: 1, total: 1 }); return emit({ type: 'loaded', ms: 5, gpuLabel: 'Mock GPU (test mode)' }); }
    if (msg.cmd === 'benchmark') return emit({ type: 'benchmark', decodeTps: 42, ttftMs: 100, tokens: 24 });
    if (msg.cmd === 'cancel') return cancelled.add(msg.jobId);
    if (msg.cmd === 'generate') {
      const count = Math.min(8, msg.maxNewTokens);
      for (let i = 0; i < count; i += 1) {
        if (cancelled.has(msg.jobId)) return;
        await new Promise((r) => setTimeout(r, 10));
        emit({ type: 'job-delta', jobId: msg.jobId, delta: i === 0 ? 'mock' : ` t${i}` });
      }
      return emit({ type: 'job-done', jobId: msg.jobId, tokens: count, ms: count * 10, stopReason: 'stop' });
    }
    if (msg.cmd === 'dispose') return emit({ type: 'disposed' });
    return undefined;
  }
  return self_;
}

boot();
