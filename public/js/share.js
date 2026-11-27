// "Share my GPU" - loads Ternary Bonsai 2 in a worker and serves the network.
import {
  $, api, el, fmt, mountChrome, requireSignIn, setBalance, pollProfile, rollTo, toast, coinBurst,
} from './common.js';

const params = new URLSearchParams(location.search);
// Automated tests only: a deterministic fake model instead of a real WebGPU run.
// Both the query flag and the shared test key are required; a visitor who only has
// `?provider=mock` still loads the real worker (and the server will refuse mock=1).
const TEST_KEY = params.get('testKey') || '';
const MOCK = params.get('provider') === 'mock' && Boolean(TEST_KEY);
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
  currentJobId: null,
  benchmarkDone: false,
  sessionCoins: 0,
  balanceAtStart: null,
  profile: null,
};

const ui = {};

async function boot() {
  // The downloadable client opens this page with #code=... - a single-use, 60-second
  // hand-off code. A long-lived #token= is ignored: that would be a durable login URL.
  let refuseAutostart = false;
  if (location.hash.startsWith('#code=')) {
    const value = decodeURIComponent(location.hash.slice(6));
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await api('/api/auth/token-session', { method: 'POST', body: { code: value } });
    } catch (err) {
      if (err.code === 'already_signed_in') {
        alert(err.message);
        refuseAutostart = true;
      }
    }
  } else if (location.hash.startsWith('#token=')) {
    history.replaceState(null, '', location.pathname + location.search);
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
  await preflight(cfg);
  ui.pauseBtn.onclick = togglePause;
  ui.stopBtn.onclick = () => stop('you stopped sharing');

  window.addEventListener('beforeunload', () => { try { state.ws?.close(); } catch { /* closing anyway */ } });
  setInterval(refreshStats, 15000);
  refreshStats();
  if (AUTOSTART && !refuseAutostart) start(cfg);
}

/**
 * The honest requirement check, before a single byte of the model is downloaded.
 *
 * A browser cannot be asked how much video memory a card has - no API exposes it - so
 * this checks what it *can* check and says plainly which part it cannot: WebGPU exists
 * and is not a software fallback, the browser will give us the ~6 GB of storage the
 * weights need, and this is not a phone. The real verdict is still the speed benchmark
 * after loading, and the card says so rather than pretending otherwise.
 */
async function preflight(cfg) {
  const checks = [];
  const need = cfg.model.downloadBytes;

  if (!('gpu' in navigator)) {
    checks.push({ ok: false, blocking: true, title: 'No WebGPU in this browser',
      detail: 'Chrome or Edge 121+ on a desktop works; Safari needs 18+. On Linux, Chrome may need --enable-unsafe-webgpu --enable-features=Vulkan.' });
  } else {
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* reported below */ }
    if (!adapter) {
      checks.push({ ok: false, blocking: true, title: 'WebGPU exists, but no graphics adapter was offered',
        detail: 'Usually a blocklisted driver or a virtual machine without GPU passthrough.' });
    } else {
      const info = (await adapter.requestAdapterInfo?.().catch(() => null)) || adapter.info || {};
      const name = [info.vendor, info.architecture].filter(Boolean).join(' ') || 'an unnamed adapter';
      if (adapter.isFallbackAdapter) {
        checks.push({ ok: false, blocking: true, title: 'Only a software renderer is available',
          detail: 'The browser offered a CPU fallback adapter. That is far too slow to be admitted.' });
      } else {
        checks.push({ ok: true, title: `WebGPU is available on ${name}`,
          detail: `Buffer limit ${fmt.bytes(adapter.limits.maxBufferSize)} · storage binding ${fmt.bytes(adapter.limits.maxStorageBufferBindingSize)}.` });
      }
    }
  }

  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate?.quota) {
    const free = estimate.quota - (estimate.usage || 0);
    checks.push({
      ok: free > need * 1.1,
      blocking: free <= need * 1.1,
      title: free > need * 1.1
        ? `Room for the model: ${fmt.bytes(free)} of browser storage free`
        : `Not enough browser storage: ${fmt.bytes(free)} free, ${fmt.bytes(need)} needed`,
      detail: 'The weights are cached in this browser, so the download happens only once.',
    });
  }

  // Whether the 5.9 GB stay put. Only asking, not requesting: the request is made when
  // the visitor presses Start, a user gesture, which is when Chrome and Edge decide.
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  if (persisted === true) {
    checks.push({ ok: true, title: 'The model is kept between visits',
      detail: 'This browser has marked the site\'s storage as persistent, so it will not be deleted to make room.' });
  }

  const mobile = navigator.userAgentData?.mobile ?? /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (mobile) {
    checks.push({ ok: false, blocking: true, title: 'This looks like a phone or tablet',
      detail: 'No mobile GPU has the memory for a 27B model. You can still chat here.' });
  }

  checks.push({ ok: null, title: 'Graphics memory cannot be measured from a browser',
    detail: `No web API reports it. We measure the real thing instead: after the model loads, your browser is `
      + `benchmarked and needs ${cfg.minDecodeTps} tokens/s to be admitted. Measured so far: RTX 3090 on Linux 42, `
      + 'RTX 2000 Ada on Linux 16.5, RTX 3060 in Edge on Windows 5.5, an 8 GB laptop that runs out of video memory 2.5.' });

  const windows = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase().includes('win');
  if (windows) {
    checks.push({ ok: null, title: 'On Windows, llama.cpp is much faster than the browser',
      detail: 'In our tests an RTX 3060 ran this model at 5.5 tokens/s in Edge on Windows and 30-35 in llama.cpp. '
        + 'The browser works, but sharing from llama.cpp (see below) is several times faster.' });
  }

  const found = checks.filter((c) => c.blocking);
  // The mock provider and the admin override exist to exercise this page where there is
  // no GPU at all (CI, the screenshot run, Sandy). When one is on, a failed check is a
  // note and not a verdict - a red ✕ beside a green "Online and waiting for requests"
  // is the page contradicting itself, and a first-time visitor cannot tell which half
  // to believe.
  const overridden = MOCK || ADMIN_OVERRIDE;
  const blockers = overridden ? [] : found;

  const icon = (ok) => (ok === null ? '•' : ok ? '✓' : '✕');
  const kind = (c) => {
    if (c.ok === null || (c.blocking && overridden)) return 'note';
    return c.ok ? 'ok' : 'bad';
  };
  $('#checks').replaceChildren(...checks.map((c) => el('li', { className: `check ${kind(c)}` },
    el('span', { className: 'mark', textContent: kind(c) === 'note' ? '•' : icon(c.ok) }),
    el('div', {}, el('b', { textContent: c.title }), el('div', { className: 'small muted', textContent: c.detail })))));

  // One verdict, in one place, in plain words.
  const verdict = overridden ? 'test mode' : blockers.length ? 'not on this machine' : 'ready';
  $('#preflight-note').textContent = verdict;
  $('#preflight-card').querySelector('h3').textContent = blockers.length
    ? 'This machine cannot share yet'
    : 'This machine can share';
  ui.startBtn.disabled = blockers.length > 0;
  ui.startBtn.textContent = `Start sharing — downloads ${fmt.bytes(need)}`;
  $('#start-hint').textContent = blockers.length
    ? 'Sharing is switched off because of the points above. Chatting works regardless.'
    : `You earn ${cfg.coins.providePerMinute} AI Coins a minute while you are online, plus `
      + `${cfg.coins.servePerToken} for every token you generate for somebody else.`;
  if (blockers.length) {
    $('#force-wrap').hidden = false;
    $('#force').onchange = (e) => { ui.startBtn.disabled = !e.target.checked; };
  }
}

function log(message, kind = '') {
  const line = el('div', { className: `log-line ${kind}`, textContent: `${new Date().toLocaleTimeString()}  ${message}` });
  ui.log.prepend(line);
  while (ui.log.childElementCount > 60) ui.log.lastElementChild.remove();
}

/**
 * One status, said once. The small note in the card header used to keep whatever the
 * last step wrote ("starting…") while the pill beside it already said "Online and
 * waiting for requests", so the page disagreed with itself; it now follows the pill.
 */
const NOTE_FOR_DOT = { on: 'online', busy: 'working', bad: 'stopped' };

function setStatus(text, dot = '') {
  ui.status.textContent = text;
  ui.statusDot.className = `dot ${dot}`;
  const note = NOTE_FOR_DOT[dot];
  if (note && state.sharing) $('#preflight-note').textContent = note;
}

async function start(cfg) {
  // The checklist answered "can this machine do it?"; once it is doing it, the answer is
  // on screen below and the list is only in the way.
  $('#checks').hidden = true;
  $('#slow-card').hidden = true;
  $('#force-wrap').hidden = true;
  $('#start-hint').hidden = true;
  $('#preflight-note').textContent = 'starting…';
  $('#preflight-card').querySelector('h3').textContent = 'Sharing your GPU';
  ui.pauseBtn.hidden = false;
  ui.stopBtn.hidden = false;
  ui.startBtn.hidden = true;      // hidden, not greyed: it is not a choice right now
  ui.startBtn.disabled = true;
  state.sharing = true;
  state.startedAt = Date.now();
  state.balanceAtStart = null;

  // Asked here because this runs from the Start click: Chrome and Edge decide on a user
  // gesture (and on whether the site is bookmarked or installed as an app).
  if (navigator.storage?.persist) {
    const persisted = await navigator.storage.persist().catch(() => false);
    log(persisted
      ? 'The browser will keep the model between visits.'
      : 'The model is stored in this browser. It stays there, but the browser may delete it if your disk runs low - '
        + 'installing this site as an app (install icon in the address bar) or bookmarking it makes it permanent. See Tips below.');
  }

  if (MOCK) {
    // The fake worker only starts after the coordinator confirms isMock. A visitor
    // with `?provider=mock&testKey=anything` must not earn as a real GPU.
    setStatus('Checking test mode with the coordinator...', 'busy');
    connect(cfg);
    return;
  }
  setStatus('Starting the inference worker...', 'busy');
  state.worker = new Worker('/js/bonsai-worker.js', { type: 'module' });
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
      if (state.currentJobId === msg.jobId) state.currentJobId = null;
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
      if (state.currentJobId === msg.jobId) state.currentJobId = null;
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
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.ws && state.ws.readyState < 2) {
    try { state.ws.onclose = null; state.ws.close(); } catch { /* replacing this socket */ }
  }
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
    if (state.currentJobId) {
      state.worker?.postMessage({ cmd: 'cancel', jobId: state.currentJobId });
      state.currentJobId = null;
    }
    if (MOCK && !state.worker) {
      log('The coordinator refused mock mode (missing or wrong test key).', 'error');
      stop('mock refused');
      return;
    }
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
      if (MOCK) {
        if (!msg.config?.isMock) {
          log('The coordinator refused mock mode. The test key must match TEST_MODE_KEY.', 'error');
          stop('mock refused');
          return;
        }
        if (!state.worker) {
          state.worker = mockWorker();
          state.worker.onmessage = (e) => onWorkerMessage(e.data, cfg);
          state.worker.onerror = (e) => { log(`Worker error: ${e.message}`, 'error'); stop('the worker crashed'); };
          state.worker.postMessage({ cmd: 'check' });
        }
      }
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
        log(msg.reason || 'Not admitted.', 'error');
        showSlow(msg);
        // Nothing to do with the model any more: give the graphics memory back.
        stop(`measured ${Number(msg.decodeTps || 0).toFixed(1)} tokens/s, the swarm needs ${msg.minDecodeTps}`);
        setStatus('Too slow to serve other people - but your own chat still works.', 'bad');
      }
      return;
    case 'job.start':
      if (state.currentJobId && state.currentJobId !== msg.jobId) {
        send({ type: 'job.error', jobId: msg.jobId, message: 'busy' });
        return;
      }
      state.currentJobId = msg.jobId;
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
      if (state.currentJobId === msg.jobId) state.currentJobId = null;
      state.worker.postMessage({ cmd: 'cancel', jobId: msg.jobId });
      return;
    default:
  }
}

/** The honest answer to "why not me?": the number, the bar, the likely reason and what to do. */
function showSlow(msg) {
  $('#slow-title').textContent = `Measured ${Number(msg.decodeTps || 0).toFixed(1)} tokens/s — the swarm needs ${msg.minDecodeTps}. `
    + 'Your own chat still works.';
  $('#slow-reason').textContent = msg.reason || '';
  $('#slow-card').hidden = false;
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
  ui.startBtn.hidden = false;
  ui.startBtn.disabled = false;
  ui.pauseBtn.hidden = true;
  ui.stopBtn.hidden = true;
  // Back to the question the page opened with, so a second attempt starts informed.
  $('#checks').hidden = false;
  $('#start-hint').hidden = false;
  $('#preflight-card').querySelector('h3').textContent = 'This machine can share';
  $('#preflight-note').textContent = 'not sharing';
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
