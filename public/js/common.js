// Shared for every page: chrome (header/footer), theme, API helper, and the
// AI-Coins game feel (rolling wallet, flying coins, achievement toasts).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const el = (tag, { dataset, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  // `dataset` is a read-only accessor, so Object.assign would throw on it in a module.
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c?.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
};

export const svg = (markup) => {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function testModeHeaders() {
  try {
    const fromQuery = new URLSearchParams(location.search).get('testKey');
    if (fromQuery) sessionStorage.setItem('bsw-test-key', fromQuery);
    const key = fromQuery || sessionStorage.getItem('bsw-test-key');
    return key ? { 'x-test-mode-key': key } : {};
  } catch {
    return {};
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...testModeHeaders(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(json?.message || json?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.error;
    throw err;
  }
  return json;
}

export const fmt = {
  coins: (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 }),
  int: (n) => Number(n || 0).toLocaleString('en-US'),
  compact: (n) => Number(n || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }),
  bytes: (n) => `${(n / 1e9).toFixed(2)} GB`,
  when: (iso) => new Date(iso).toLocaleString(),
  day: (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  duration: (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`),
  minutes: (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`),
};

// ------------------------------------------------------------------- brand

export const MARK = `
<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <path d="M16 29V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <path d="M16 19.5 10 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <path d="M16 18 22 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55"/>
  <circle cx="16" cy="8" r="4.2" fill="#4ade9b"/>
  <circle cx="8" cy="14" r="3" fill="#4ade9b" opacity=".8"/>
  <circle cx="24" cy="12" r="3.4" fill="#ffc751"/>
  <rect x="11" y="28" width="10" height="2.6" rx="1.3" fill="currentColor" opacity=".45"/>
</svg>`;

export const COIN = `
<svg viewBox="0 0 24 24" class="coin-ico" aria-hidden="true">
  <circle cx="12" cy="12" r="10" fill="url(#cg)"/>
  <circle cx="12" cy="12" r="7.4" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="1.1"/>
  <!-- A sprout, not a dollar sign. The old glyph was an S over a bar, which on a page
       promising "no money, no crypto" said exactly the opposite. -->
  <path d="M12 17.4V9.6" fill="none" stroke="rgba(60,34,0,.78)" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M12 11.4c0-2 1.5-3.5 3.5-3.5 0 2-1.5 3.5-3.5 3.5z" fill="rgba(60,34,0,.72)"/>
  <path d="M12 13.4c0-2-1.5-3.5-3.5-3.5 0 2 1.5 3.5 3.5 3.5z" fill="rgba(60,34,0,.55)"/>
  <defs><linearGradient id="cg" x1="3" y1="3" x2="20" y2="21">
    <stop offset="0" stop-color="#ffe6a3"/><stop offset=".45" stop-color="#ffc751"/><stop offset="1" stop-color="#e09417"/>
  </linearGradient></defs>
</svg>`;

// ------------------------------------------------------------------- theme

const THEME_KEY = 'bsw-theme';
export function applyTheme(theme) {
  const t = theme || localStorage.getItem(THEME_KEY)
    || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
  if (theme) localStorage.setItem(THEME_KEY, t);
  return t;
}
applyTheme();

// ------------------------------------------------------------------- chrome

const NAV = [
  ['/chat.html', 'Chat', false],
  ['/share.html', 'Share GPU', false],
  ['/leaderboard.html', 'Leaderboard', true],
  ['/coins.html', 'AI Coins', true],
  ['/wallet.html', 'Wallet', false],
];

let walletEl = null;
let walletValue = 0;

async function signOut(event) {
  event.preventDefault();
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}

export async function mountChrome({ me: preloaded } = {}) {
  const me = preloaded || await api('/api/me').catch(() => ({ signedIn: false }));
  const here = location.pathname === '/index.html' ? '/' : location.pathname;

  const nav = el('nav', { className: 'main' },
    NAV.map(([href, label, hideSmall]) => el('a', {
      href,
      className: `nav${href === here ? ' active' : ''}${hideSmall ? ' hide-sm' : ''}`,
      textContent: label,
    })));

  const menuBtn = el('button', { className: 'icon-btn ghost nav-toggle', ariaLabel: 'Menu', title: 'Menu' });
  menuBtn.append(svg('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'));
  const sheet = el('div', { className: 'sheet', hidden: true },
    NAV.map(([href, label]) => el('a', { href, className: href === here ? 'active' : '', textContent: label })),
    me.signedIn
      ? el('a', { href: '#', textContent: 'Sign out', onclick: signOut })
      : el('a', { href: '/login.html', textContent: 'Sign in' }));
  menuBtn.onclick = () => { sheet.hidden = !sheet.hidden; };
  nav.append(menuBtn);

  const themeBtn = el('button', { className: 'icon-btn ghost', title: 'Light / dark', ariaLabel: 'Toggle theme' });
  themeBtn.append(svg(`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`));
  themeBtn.onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  nav.append(themeBtn);

  if (me.signedIn) {
    nav.append(el('a', { href: '#', className: 'nav hide-sm', textContent: 'Sign out', onclick: signOut }));
    walletValue = Number(me.user.balance) || 0;
    walletEl = el('a', { className: 'wallet', href: '/wallet.html', title: 'Your AI Coins' });
    walletEl.append(svg(COIN), el('span', { className: 'num roll', textContent: fmt.coins(walletValue) }));
    nav.append(walletEl);
  } else {
    nav.append(el('a', { href: '/login.html', className: 'btn btn-sm primary', textContent: 'Sign in' }));
  }

  const header = el('header', { className: 'site' },
    el('div', { className: 'wrap' },
      el('a', { className: 'brand', href: '/' }, svg(MARK), el('span', { textContent: 'Bonsai Swarm' })),
      nav));
  document.body.prepend(header);
  header.after(sheet);

  document.body.append(el('footer', { className: 'site' },
    el('div', { className: 'wrap' },
      el('span', {}, 'A free community GPU network. No money, no crypto — just AI Coins.'),
      el('a', { href: '/coins.html', textContent: 'How AI Coins work' }),
      el('a', { href: '/impressum.html', textContent: 'Impressum' }),
      el('a', { href: '/datenschutz.html', textContent: 'Datenschutz' }),
      el('a', { href: 'https://github.com/fstandhartinger/bonsai-swarm', textContent: 'GitHub' }),
      el('a', { href: 'https://donate.stripe.com/fZu00i9ro0wmdF88sg1Jm01', rel: 'noopener', title: 'Pay what you want — helps cover the servers', textContent: '♥ Support this project' }),
      el('span', { className: 'muted', style: 'margin-left:auto', textContent: 'Model: Ternary Bonsai 2 27B · Prism ML · WebGPU kernels by Xenova' }))));

  if (!$('#toasts')) document.body.append(el('div', { id: 'toasts' }));
  return me;
}

export function requireSignIn(me) {
  if (me.signedIn) return true;
  location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
  return false;
}

// ------------------------------------------------------- the good feelings

/** Counts a number up (or down) over ~700 ms, tabular figures, no layout jump. */
export function rollTo(node, to, { format = fmt.coins, ms = 700 } = {}) {
  if (!node) return;
  const from = Number(node.dataset.value ?? to);
  node.dataset.value = String(to);
  if (reducedMotion() || from === to) { node.textContent = format(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - k) ** 3;
    node.textContent = format(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Coins fly from `origin` into the wallet chip, the counter rolls up and the chip
 * pops. This is the one moment the whole thing is designed around.
 */
export function coinBurst(origin, count = 7) {
  if (!walletEl || reducedMotion()) return;
  const target = walletEl.getBoundingClientRect();
  const tx = target.left + target.width / 2 - 11;
  const ty = target.top + target.height / 2 - 11;
  const src = (origin?.getBoundingClientRect?.() || { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 });
  const sx = src.left + src.width / 2 - 11;
  const sy = src.top + src.height / 2 - 11;

  for (let i = 0; i < Math.min(count, 14); i += 1) {
    const coin = svg(COIN);
    coin.classList.add('coin-fly');
    coin.style.left = `${sx}px`;
    coin.style.top = `${sy}px`;
    document.body.append(coin);
    const spread = (Math.random() - 0.5) * 140;
    const lift = 60 + Math.random() * 90;
    const delay = i * 55;
    coin.animate([
      { transform: 'translate(0,0) scale(.6) rotate(0deg)', opacity: 0 },
      { transform: `translate(${spread * 0.5}px, ${-lift}px) scale(1.15) rotate(180deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${tx - sx}px, ${ty - sy}px) scale(.55) rotate(540deg)`, opacity: 0 },
    ], { duration: 950, delay, easing: 'cubic-bezier(.35,.1,.25,1)' }).onfinish = () => coin.remove();
    setTimeout(() => popWallet(), delay + 780);
  }
}

function popWallet() {
  if (!walletEl) return;
  walletEl.classList.add('pop');
  setTimeout(() => walletEl.classList.remove('pop'), 200);
}

/**
 * Single source of truth for the header counter. Call it with a fresh balance;
 * it animates upward earnings (with coins) and downward spends (with a shake).
 */
export function setBalance(balance, { origin = null, silent = false } = {}) {
  const next = Number(balance) || 0;
  const prev = walletValue;
  walletValue = next;
  if (!walletEl) return { delta: next - prev };
  const num = $('.num', walletEl);
  rollTo(num, next);
  const delta = next - prev;
  if (silent || Math.abs(delta) < 0.0005) return { delta };
  if (delta > 0) { num.classList.add('bump'); setTimeout(() => num.classList.remove('bump'), 460); coinBurst(origin, Math.min(12, 3 + Math.round(delta / 8))); }
  else if (!reducedMotion()) { walletEl.classList.add('spend'); setTimeout(() => walletEl.classList.remove('spend'), 430); }
  return { delta };
}

export const currentBalance = () => walletValue;

/** Toast, used for achievements and level-ups. */
export function toast({ icon = '✨', title, sub = '', kind = 'gold', ms = 6000 } = {}) {
  const host = $('#toasts') || document.body.appendChild(el('div', { id: 'toasts' }));
  const node = el('div', { className: `toast ${kind}` },
    el('div', { className: 'ico', textContent: icon }),
    el('div', {}, el('div', { className: 't', textContent: title }), sub ? el('div', { className: 's', textContent: sub }) : null));
  host.append(node);
  if (!reducedMotion() && navigator.vibrate) { try { navigator.vibrate(18); } catch { /* not allowed */ } }
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 320); }, ms);
  return node;
}

/**
 * Shows the badges the server just unlocked, and a level-up when the tier moved.
 * The server decides what is unlocked; the browser only celebrates it.
 */
let lastLevel = null;
export function celebrate(profile, { origin = null } = {}) {
  if (!profile) return;
  for (const a of profile.justUnlocked || []) {
    toast({ icon: a.icon, title: `Achievement unlocked — ${a.name}`, sub: a.hint });
    coinBurst(origin, 10);
  }
  const lvl = profile.level?.level;
  if (lastLevel !== null && lvl > lastLevel) {
    toast({ icon: '🌳', title: `Level ${lvl} — ${profile.level.name}`, sub: 'Your bonsai grew. Keep sharing.' });
    coinBurst(origin, 12);
  }
  lastLevel = lvl;
}

/** Fetches the profile, celebrates anything new, returns it. */
export async function pollProfile({ origin = null } = {}) {
  const p = await api('/api/gamification').catch(() => null);
  if (!p) return null;
  setBalance(p.coins, { origin, silent: lastLevel === null });
  celebrate(p, { origin });
  return p;
}

// ------------------------------------------------------------------- SSE

/** Reads a POSTed SSE stream and calls handlers per event name. */
export async function streamSse(path, body, handlers, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...testModeHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    handlers.error?.({ error: parsed?.message || `Request failed (${res.status})`, code: parsed?.error });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
      try { handlers[event]?.(JSON.parse(data)); } catch { /* ignore malformed frame */ }
    }
  }
}

/**
 * Minimal markdown renderer. Everything is HTML-escaped first, so text produced by a
 * stranger's browser can never inject markup into another user's page.
 */
export function renderMarkdown(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const blocks = [];
  const PH = (i) => `@@BSWBLOCK${i}@@`;
  let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return PH(blocks.length - 1);
  });
  out = out
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/^#{2,3} (.*)$/gm, '<h3>$1</h3>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br><br>');
  return out.replace(/@@BSWBLOCK(\d+)@@/g, (_m, i) => blocks[Number(i)]);
}

/** The drifting-dot swarm behind the hero. Cheap, paused when hidden. */
export function swarmCanvas(canvas) {
  if (!canvas || reducedMotion()) return;
  const ctx = canvas.getContext('2d');
  const dots = [];
  let raf = null;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);
  const N = Math.min(46, Math.round(canvas.offsetWidth / 26));
  for (let i = 0; i < N; i += 1) {
    dots.push({
      x: Math.random() * canvas.offsetWidth,
      y: Math.random() * canvas.offsetHeight,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: 1 + Math.random() * 1.8,
      gold: Math.random() < 0.22,
    });
  }
  const draw = () => {
    const w = canvas.offsetWidth; const h = canvas.offsetHeight;
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;
    }
    for (let i = 0; i < dots.length; i += 1) {
      for (let j = i + 1; j < dots.length; j += 1) {
        const dx = dots[i].x - dots[j].x; const dy = dots[i].y - dots[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist > 128) continue;
        ctx.strokeStyle = `rgba(74,222,155,${(1 - dist / 128) * 0.16})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(dots[j].x, dots[j].y); ctx.stroke();
      }
    }
    for (const d of dots) {
      ctx.fillStyle = d.gold ? 'rgba(255,199,81,.75)' : 'rgba(74,222,155,.6)';
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  };
  draw();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = null; }
    else if (!raf) draw();
  });
}
