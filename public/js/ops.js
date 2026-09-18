// Operator dashboard. Hand-drawn SVG charts - no chart library, no build step, and
// nothing here is loaded from another origin.
//
// The token is typed once and kept in sessionStorage, so it dies with the tab and never
// reaches a server log (it travels in an Authorization header, never in a URL).

import { $, el, fmt, mountChrome } from '/js/common.js';

await mountChrome();

// Signed in as an operator account, the dashboard just works. The token box below is
// the fallback for a deployment that uses OPS_TOKEN instead; it is kept in
// sessionStorage, so it dies with the tab, and travels in an Authorization header.
const KEY = 'bsw_ops_token';
const token = () => sessionStorage.getItem(KEY) || '';

const SERIES = {
  community: { label: 'Community GPUs', color: 'var(--jade)' },
  house: { label: 'House GPUs', color: 'var(--sky)' },
  fallback: { label: 'Free fallback model', color: 'var(--violet)' },
  issued: { label: 'AI Coins issued', color: 'var(--jade)' },
  spent: { label: 'AI Coins spent', color: 'var(--gold)' },
  jobs: { label: 'Requests', color: 'var(--jade)' },
  active: { label: 'Active accounts', color: 'var(--sky)' },
  signups: { label: 'New accounts', color: 'var(--gold)' },
  views: { label: 'Page loads', color: 'var(--jade)' },
  visits: { label: 'Arrivals from outside', color: 'var(--gold)' },
};

const NS = 'http://www.w3.org/2000/svg';
const node = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const niceMax = (v) => {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / pow * 2) / 2 * pow;
};

/**
 * One chart: stacked bars per day (or hour) with a value axis and a hover title.
 * `rows` are objects with a label key plus one numeric key per series.
 */
function chart(rows, keys, { labelKey = 'day', height = 150, stacked = true, format = fmt.int } = {}) {
  const w = 720;
  const padL = 46; const padB = 22; const padT = 8;
  const inner = w - padL - 8;
  const h = height - padB - padT;
  const totals = rows.map((r) => (stacked
    ? keys.reduce((a, k) => a + Number(r[k] || 0), 0)
    : Math.max(...keys.map((k) => Number(r[k] || 0)))));
  const max = niceMax(Math.max(1, ...totals));
  const band = inner / Math.max(rows.length, 1);
  const barW = Math.max(2, Math.min(band - 2, 26));

  const svg = node('svg', {
    viewBox: `0 0 ${w} ${height}`, class: 'chart', role: 'img',
    'aria-label': keys.map((k) => SERIES[k]?.label || k).join(', '),
  });

  for (let i = 0; i <= 2; i += 1) {
    const value = (max / 2) * i;
    const y = padT + h - (value / max) * h;
    svg.append(node('line', { x1: padL, x2: w - 8, y1: y, y2: y, class: 'grid' }));
    const text = node('text', { x: padL - 8, y: y + 4, class: 'axis', 'text-anchor': 'end' });
    text.textContent = fmt.compact(value);
    svg.append(text);
  }

  rows.forEach((row, i) => {
    const x = padL + i * band + (band - barW) / 2;
    let acc = 0;
    keys.forEach((k, ki) => {
      const v = Number(row[k] || 0);
      if (v <= 0) return;
      const barH = (v / max) * h;
      const y = stacked
        ? padT + h - ((acc + v) / max) * h
        : padT + h - barH;
      const rect = node('rect', {
        x: stacked ? x : x + (ki * barW) / keys.length,
        width: stacked ? barW : barW / keys.length,
        y, height: Math.max(1, barH), rx: 2,
        fill: SERIES[k]?.color || 'var(--jade)',
        opacity: stacked ? 1 : 0.9 - ki * 0.15,
      });
      rect.append(node('title')).textContent = `${row[labelKey]} · ${SERIES[k]?.label || k}: ${format(v)}`;
      svg.append(rect);
      acc += v;
    });
  });

  // Only a handful of tick labels, so they never collide at 390 px.
  const every = Math.ceil(rows.length / 6);
  rows.forEach((row, i) => {
    if (i % every && i !== rows.length - 1) return;
    const label = node('text', {
      x: padL + i * band + band / 2, y: height - 6, class: 'axis', 'text-anchor': 'middle',
    });
    label.textContent = String(row[labelKey]).slice(5).replace('T', ' ');
    svg.append(label);
  });
  return svg;
}

const legend = (keys) => el('div', { className: 'legend' }, ...keys.map((k) => el('span', {},
  el('i', { style: `background:${SERIES[k]?.color || 'var(--jade)'}` }), SERIES[k]?.label || k)));

const panel = (title, note, ...content) => el('section', { className: 'card chart-card' },
  el('div', { className: 'spread' }, el('h3', { textContent: title }),
    note ? el('span', { className: 'small muted', textContent: note }) : null),
  ...content);

const tile = (value, label, className = '') =>
  el('div', { className: `stat ${className}` }, el('div', { className: 'v', textContent: value }),
    el('div', { className: 'k', textContent: label }));

function table(rows, columns) {
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', {
    textContent: c.head, className: c.num ? 'num' : '',
  })))));
  t.append(el('tbody', {}, ...rows.map((r) => el('tr', {}, ...columns.map((c) => el('td', {
    textContent: c.value(r), className: c.num ? 'num' : '',
  }))))));
  return t;
}

async function load(days) {
  const res = await fetch(`/api/ops/stats?days=${days}`,
    token() ? { headers: { authorization: `Bearer ${token()}` } } : {});
  if (res.status === 401) {
    sessionStorage.removeItem(KEY);
    throw new Error('Not an operator. Sign in with the operator account, or paste the OPS_TOKEN.');
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return res.json();
}

function render(d) {
  const out = $('#dash');
  const tokensTotal = d.tokens.reduce((a, r) => a + r.community + r.house + r.fallback, 0);
  const community = d.tokens.reduce((a, r) => a + r.community, 0);
  const activeToday = d.activeUsers.at(-1)?.active ?? 0;
  const jobsToday = d.jobs.at(-1)?.jobs ?? 0;
  const waits = d.jobs.filter((r) => r.jobs > 0);
  const avgWait = waits.length ? waits.reduce((a, r) => a + r.avg_wait_ms, 0) / waits.length : 0;
  const speeds = d.jobs.filter((r) => r.avg_tps > 0);
  const avgTps = speeds.length ? speeds.reduce((a, r) => a + Number(r.avg_tps), 0) / speeds.length : 0;
  const coinsIssued = d.coinTotals.filter((r) => r.coins > 0).reduce((a, r) => a + Number(r.coins), 0);
  const coinsSpent = d.coinTotals.filter((r) => r.coins < 0).reduce((a, r) => a - Number(r.coins), 0);

  out.replaceChildren(
    el('div', { className: 'grid cols-4' },
      tile(fmt.int(d.users.total - d.users.house), 'Accounts', 'hero-tile accent'),
      tile(`+${fmt.int(d.users.today)}`, 'New today', 'hero-tile'),
      tile(`+${fmt.int(d.users.last7)}`, 'New in 7 days', 'hero-tile'),
      tile(fmt.int(activeToday), 'Active today', 'hero-tile coin')),

    el('div', { className: 'grid cols-4', style: 'margin-top:12px' },
      tile(fmt.compact(tokensTotal), `Tokens in ${d.days} days`),
      tile(`${tokensTotal ? Math.round((community / tokensTotal) * 100) : 0}%`, 'of them by volunteers'),
      tile(fmt.int(jobsToday), 'Requests today'),
      tile(avgTps ? `${avgTps.toFixed(1)}` : '–', 'Average tokens/s')),

    panel('Who generated the tokens', 'volunteers vs. our own rented GPUs vs. the free fallback',
      chart(d.tokens, ['community', 'house', 'fallback']),
      legend(['community', 'house', 'fallback'])),

    panel('Accounts', 'new sign-ups and how many accounts were active that day',
      chart(d.signups.map((r, i) => ({ ...r, active: d.activeUsers[i]?.active || 0 })),
        ['signups', 'active'], { stacked: false }),
      legend(['signups', 'active'])),

    panel('Requests per day', `average wait ${fmt.duration(avgWait)}`,
      chart(d.jobs, ['jobs'], { stacked: false }),
      legend(['jobs'])),

    panel('GPUs online', 'one bar per hour, house GPUs stacked on top of community GPUs',
      chart(d.providersOnline, ['community', 'house'], { labelKey: 'hour' }),
      legend(['community', 'house'])),

    panel('AI Coins', `${fmt.compact(coinsIssued)} issued, ${fmt.compact(coinsSpent)} spent in total`,
      chart(d.coins, ['issued', 'spent'], { stacked: false, format: fmt.coins }),
      legend(['issued', 'spent']),
      table(d.coinTotals, [
        { head: 'Ledger entry', value: (r) => r.kind },
        { head: 'Entries', num: true, value: (r) => fmt.int(r.entries) },
        { head: 'AI Coins', num: true, value: (r) => fmt.coins(r.coins) },
      ])),

    panel('Page visits', d.visits.uniqueVisitorsNote,
      chart(d.visits.daily.length ? d.visits.daily : [{ day: '–', views: 0, visits: 0 }],
        ['views', 'visits'], { stacked: false }),
      legend(['views', 'visits']),
      table(d.visits.topPages, [
        { head: 'Page', value: (r) => r.path },
        { head: 'Page loads', num: true, value: (r) => fmt.int(r.views) },
        { head: 'From outside', num: true, value: (r) => fmt.int(r.visits) },
      ]),
      d.visits.topReferrers.length
        ? table(d.visits.topReferrers, [
          { head: 'Came from', value: (r) => r.referrer_host },
          { head: 'Arrivals', num: true, value: (r) => fmt.int(r.visits) },
        ])
        : el('p', { className: 'small muted', textContent: 'No referring sites yet.' })),

    el('p', {
      className: 'small muted',
      textContent: `Generated ${fmt.when(d.generatedAt)} · ${d.users.house} house account(s) are counted `
        + `separately and never appear on the leaderboard · fallback answered ${fmt.int(d.fallback.jobs)} `
        + `request(s) (${fmt.int(d.fallback.jobsToday)} today).`,
    }),
  );
}

async function show(days) {
  $('#error').hidden = true;
  $('#gate').hidden = true;
  $('#dash').hidden = false;
  $('#controls').hidden = false;
  try {
    render(await load(days));
  } catch (err) {
    $('#dash').hidden = true;
    $('#controls').hidden = true;
    $('#gate').hidden = false;
    $('#error').hidden = false;
    $('#error').textContent = err.message;
  }
}

$('#gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY, $('#token').value.trim());
  $('#token').value = '';
  show(Number($('#days').value) || 30);
});

$('#days').addEventListener('change', () => show(Number($('#days').value) || 30));
$('#signout').addEventListener('click', () => { sessionStorage.removeItem(KEY); location.reload(); });

const who = await fetch('/api/ops/enabled').then((r) => r.json()).catch(() => ({}));
if (who.admin || token()) show(30);
else $('#gate').hidden = false;
