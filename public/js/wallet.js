import { $, api, el, fmt, mountChrome, requireSignIn, setBalance, celebrate, rollTo } from './common.js';

const KIND_LABEL = {
  welcome: 'Welcome budget',
  provide_minutes: 'Online minutes',
  serve_tokens: 'Answered for someone',
  consume_tokens: 'Your request',
  admin_adjust: 'Manual adjustment',
};

const me = await mountChrome();
if (requireSignIn(me)) {
  $('#api-base').textContent = `${location.origin}/api/v1`;
  await refresh();
  $('#create-token').onclick = createToken;
  $('#lb-opt').onchange = async (e) => {
    await api('/api/leaderboard/opt-in', { method: 'POST', body: { enabled: e.target.checked } });
  };
  $('#logout-all').onclick = async () => {
    await api('/api/auth/logout-everywhere', { method: 'POST' });
    location.href = '/';
  };
}

async function refresh() {
  const [ledger, tokens, jobs, game] = await Promise.all([
    api('/api/ledger'), api('/api/tokens'), api('/api/jobs'), api('/api/gamification'),
  ]);

  renderGame(game);
  setBalance(game.coins, { silent: true });

  const sum = (kinds) => ledger.summary.filter((s) => kinds.includes(s.kind))
    .reduce((acc, s) => acc + Number(s.total), 0);
  rollTo($('#a-balance'), ledger.balance);
  rollTo($('#a-earned'), sum(['provide_minutes', 'serve_tokens']));
  rollTo($('#a-spent'), Math.abs(sum(['consume_tokens'])));

  $('#ledger').replaceChildren(...ledger.entries.map((e) => el('tr', {},
    el('td', { className: 'small muted', textContent: fmt.when(e.created_at) }),
    el('td', { textContent: KIND_LABEL[e.kind] || e.kind }),
    el('td', {
      className: `num ${Number(e.coins) > 0 ? 'ok' : ''}`,
      textContent: `${Number(e.coins) > 0 ? '+' : ''}${fmt.coins(e.coins)}`,
    }),
    el('td', { className: 'small muted', textContent: detailOf(e) }))));

  $('#tokens').replaceChildren(...tokens.tokens.map((t) => el('tr', {},
    el('td', { textContent: t.name }),
    el('td', { className: 'mono small', textContent: `${t.prefix}…` }),
    el('td', { className: 'small muted', textContent: fmt.when(t.created_at) }),
    el('td', { className: 'small muted', textContent: t.last_used_at ? fmt.when(t.last_used_at) : 'never' }),
    el('td', {}, el('button', {
      className: 'btn-sm ghost',
      textContent: 'Revoke',
      onclick: async () => { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); refresh(); },
    })))));

  $('#jobs').replaceChildren(...jobs.jobs.map((j) => el('tr', {},
    el('td', { className: 'small muted', textContent: fmt.when(j.created_at) }),
    el('td', {}, el('span', { className: `pill ${j.as_consumer ? '' : 'jade'}`, textContent: j.as_consumer ? 'you asked' : 'you answered' })),
    el('td', { className: 'small muted', textContent: j.status }),
    el('td', { className: 'num', textContent: fmt.int(j.prompt_tokens) }),
    el('td', { className: 'num', textContent: fmt.int(j.completion_tokens) }),
    el('td', { className: 'num', textContent: j.decode_tps ? Number(j.decode_tps).toFixed(1) : '–' }))));
}

function renderGame(p) {
  $('#level-ring').style.setProperty('--p', Math.round((p.level.progress || 0) * 100));
  $('#level-num').textContent = p.level.level;
  $('#level-name').textContent = p.level.name;
  $('#level-progress').textContent = p.level.next
    ? `${fmt.coins(p.level.toNext)} AI Coins to level ${p.level.next.level} · ${p.level.next.name}`
    : 'Top level reached. The bonsai is old growth now.';
  $('#member-since').textContent = `Level ${p.level.level} · ${p.level.name} · member since ${fmt.day(p.stats.memberSince)}`;

  $('#a-streak').textContent = p.streak.current;
  $('#a-tokens-served').textContent = fmt.int(p.stats.tokensServed);
  $('#a-jobs-served').textContent = fmt.int(p.stats.jobsServed);
  $('#a-minutes').textContent = fmt.int(p.stats.minutesShared);
  $('#a-tokens-used').textContent = fmt.int(p.stats.tokensConsumed);
  $('#a-best-tps').textContent = p.stats.bestDecodeTps ? `${p.stats.bestDecodeTps.toFixed(1)}` : '–';
  $('#a-days').textContent = fmt.int(p.streak.days);
  $('#lb-opt').checked = Boolean(p.leaderboardOptIn);

  $('#badges').replaceChildren(...p.achievements.map((a) => el('div', { className: `badge${a.unlocked ? ' got' : ''}` },
    el('div', { className: 'ico', textContent: a.icon }),
    el('div', { className: 'nm', textContent: a.name }),
    el('div', { className: 'ht', textContent: a.unlocked ? `unlocked ${fmt.day(a.unlockedAt)}` : a.hint }))));

  celebrate(p, { origin: $('#badges') });
}

function detailOf(entry) {
  const m = entry.meta || {};
  if (entry.kind === 'provide_minutes') return `${m.minutes} minute(s)`;
  if (entry.kind === 'serve_tokens') return `${m.completion_tokens} tokens${m.night ? ' · at night 🦉' : ''}`;
  if (entry.kind === 'consume_tokens') return `${m.prompt_tokens} prompt + ${m.completion_tokens} answer tokens`;
  return m.reason || '';
}

async function createToken() {
  const name = $('#token-name').value.trim() || 'token';
  const res = await api('/api/tokens', { method: 'POST', body: { name } });
  $('#new-token').hidden = false;
  $('#new-token-value').textContent = res.token;
  $('#token-name').value = '';
  refresh();
}
