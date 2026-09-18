// Consumer chat: streams an answer out of a stranger's browser and shows what it cost.
import {
  $, api, el, fmt, mountChrome, renderMarkdown, requireSignIn, streamSse, setBalance, pollProfile,
} from './common.js';

const STORE_KEY = 'bsw.conversations.v1';
const state = {
  conversations: [],
  activeId: null,
  streaming: false,
  controller: null,
  config: null,
};

const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } };
const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(state.conversations.slice(0, 50)));
const active = () => state.conversations.find((c) => c.id === state.activeId) || state.conversations[0];

async function boot() {
  const me = await mountChrome();
  if (!requireSignIn(me)) return;
  state.config = await api('/api/config');
  state.conversations = load();
  if (!state.conversations.length) newConversation();
  else state.activeId = state.conversations[0].id;

  $('#send').onclick = onSend;
  $('#stop').onclick = () => state.controller?.abort();
  $('#new-chat').onclick = () => { newConversation(); render(); $('#input').focus(); };
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  $('#input').addEventListener('input', autoGrow);
  $('#thinking').checked = localStorage.getItem('bsw.thinking') === '1';
  $('#thinking').onchange = (e) => localStorage.setItem('bsw.thinking', e.target.checked ? '1' : '0');

  setInterval(refreshNetwork, 12000);
  refreshNetwork();
  render();
  $('#input').focus();
}

function autoGrow() {
  const box = $('#input');
  box.style.height = 'auto';
  box.style.height = `${Math.min(220, box.scrollHeight)}px`;
}

function newConversation() {
  const conv = { id: crypto.randomUUID(), title: 'New chat', messages: [], createdAt: Date.now() };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  save();
  return conv;
}

function render() {
  $('#conversations').replaceChildren(...state.conversations.map((c) => {
    const row = el('div', { className: `conv${c.id === state.activeId ? ' active' : ''}` },
      el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', textContent: c.title }));
    row.onclick = () => { state.activeId = c.id; render(); };
    const x = el('span', { className: 'x', textContent: '×', title: 'Delete' });
    x.onclick = (e) => {
      e.stopPropagation();
      state.conversations = state.conversations.filter((o) => o.id !== c.id);
      if (!state.conversations.length) newConversation();
      if (state.activeId === c.id) state.activeId = state.conversations[0].id;
      save(); render();
    };
    row.append(x);
    return row;
  }));
  renderMessages();
}

function renderMessages() {
  const conv = active();
  const box = $('#messages');
  box.replaceChildren();
  if (!conv.messages.length) {
    box.append(el('div', { className: 'notice info' },
      'Ask anything. Your prompt goes to one volunteer\'s browser, which answers with Ternary Bonsai 2 27B '
      + 'and earns AI Coins for it. If no GPU is online, a free fallback model answers instead and says so. '
      + 'Please don\'t send personal or confidential data.'));
  }
  for (const m of conv.messages) box.append(messageNode(m));
  scrollDown();
}

const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

function messageNode(message) {
  const node = el('div', { className: `msg ${message.role}` },
    el('div', { className: 'av', textContent: message.role === 'user' ? 'You' : '🌳' }));
  const body = el('div', { className: 'body' });
  if (message.fallback) body.append(el('div', { className: 'notice warn fallback-note', textContent: message.fallback }));
  if (message.reasoning) {
    body.append(el('details', { className: 'think' },
      el('summary', { textContent: 'Reasoning' }),
      el('div', { className: 'txt', textContent: message.reasoning })));
  }
  const content = el('div', { className: 'content' });
  if (message.role === 'user') content.textContent = message.content;
  else content.innerHTML = renderMarkdown(message.content || '');
  body.append(content, el('div', { className: 'meta' }, message.meta || ''));
  node.append(body);
  return node;
}

async function onSend() {
  if (state.streaming) return;
  const box = $('#input');
  const text = box.value.trim();
  if (!text) return;
  const conv = active();
  conv.messages.push({ role: 'user', content: text });
  if (conv.title === 'New chat') conv.title = text.slice(0, 44);
  box.value = '';
  autoGrow();
  save();
  render();

  const assistant = { role: 'assistant', content: '', reasoning: '', meta: 'looking for a free GPU…' };
  conv.messages.push(assistant);
  const node = messageNode(assistant);
  $('#messages').append(node);
  const content = node.querySelector('.content');
  const meta = node.querySelector('.meta');
  const cursor = el('span', { className: 'cursor' });
  content.append(cursor);

  state.streaming = true;
  state.controller = new AbortController();
  $('#send').disabled = true;
  $('#stop').hidden = false;

  let inThinking = false;
  let raw = '';

  const finish = (nodes) => {
    state.streaming = false;
    state.controller = null;
    $('#send').disabled = false;
    $('#stop').hidden = true;
    cursor.remove();
    meta.replaceChildren(...[nodes].flat().map((n) => (n?.nodeType ? n : document.createTextNode(String(n)))));
    assistant.meta = meta.textContent;
    save();
    refreshNetwork();
  };

  try {
    await streamSse('/api/chat/stream', {
      messages: conv.messages.filter((m) => m.role !== 'assistant' || m.content).map(({ role, content: c }) => ({ role, content: c })),
      maxTokens: state.config.defaultMaxNewTokens,
      thinking: $('#thinking').checked,
    }, {
      queued: (d) => {
        const parts = [d.position > 1 ? `in the queue — position ${d.position}` : 'looking for a free GPU…'];
        meta.replaceChildren(document.createTextNode(parts[0]));
        if (d.requeued) meta.append(el('span', { className: 'pill rose', textContent: 'provider dropped — retrying' }));
        if (d.cappedByBalance) meta.append(el('span', { className: 'pill gold', textContent: `shortened to ${d.maxNewTokens} tokens (AI Coins)` }));
      },
      assigned: (d) => {
        meta.replaceChildren(document.createTextNode(
          `answering on ${d.providerLabel}${d.decodeTps ? ` · ~${d.decodeTps.toFixed(0)} tok/s` : ''}`));
      },
      // Nobody was online (or the volunteer vanished). Say so, above the answer, before
      // a single word of it arrives.
      fallback: (d) => {
        // Kept on the stored message, so the label survives a reload or a re-render and
        // nobody can later mistake this for a volunteer's answer.
        assistant.fallback = d.notice;
        let banner = node.querySelector('.fallback-note');
        if (!banner) {
          banner = el('div', { className: 'notice warn fallback-note' });
          node.querySelector('.body').prepend(banner);
        }
        banner.textContent = d.notice;
        meta.replaceChildren(document.createTextNode(`answering with ${d.model} — no volunteer GPU involved`));
      },
      // The volunteer dropped out mid-sentence and somebody else is starting over:
      // throw away the fragment rather than gluing two answers together.
      reset: () => {
        raw = '';
        inThinking = false;
        assistant.content = '';
        assistant.reasoning = '';
        node.querySelector('details.think')?.remove();
        content.innerHTML = '';
        content.append(cursor);
      },
      delta: (d) => {
        raw += d.delta;
        // The model emits its reasoning between <think> tags; show it collapsed.
        if (!inThinking && raw.includes('<think>')) inThinking = true;
        if (inThinking && raw.includes('</think>')) {
          const [thought, rest] = raw.split('</think>');
          assistant.reasoning = thought.replace('<think>', '').trim();
          assistant.content = rest;
          inThinking = false;
          raw = rest;
          const details = node.querySelector('details.think');
          if (details) { details.open = false; details.querySelector('summary').textContent = 'Reasoning'; }
        } else if (inThinking) {
          assistant.reasoning = raw.replace('<think>', '');
          let details = node.querySelector('details.think');
          if (!details) {
            details = el('details', { className: 'think', open: true },
              el('summary', { textContent: 'Thinking…' }), el('div', { className: 'txt' }));
            node.querySelector('.body').prepend(details);
          }
          details.querySelector('.txt').textContent = assistant.reasoning;
        } else {
          assistant.content = raw;
          content.innerHTML = renderMarkdown(assistant.content);
          content.append(cursor);
        }
        if (window.innerHeight + window.scrollY > document.body.scrollHeight - 220) scrollDown();
      },
      done: (d) => {
        finish([
          d.servedBy === 'fallback'
            ? el('span', { className: 'pill rose', textContent: `free fallback model${d.fallbackModel ? ` · ${d.fallbackModel}` : ''}` })
            : null,
          `${d.completionTokens} tokens`,
          el('span', { className: 'pill gold', textContent: `−${fmt.coins(d.coinsCharged)} AI Coins` }),
          d.servedBy === 'fallback' ? null : (d.decodeTps ? `${d.decodeTps.toFixed(1)} tok/s` : null),
        ].filter(Boolean));
        // The spend animation and any freshly unlocked badge come from the real ledger.
        pollProfile({ origin: node });
      },
      error: (d) => {
        content.innerHTML = '';
        content.append(el('div', { className: 'notice danger' },
          d.error || 'The swarm could not answer.',
          d.code === 'insufficient_coins'
            ? el('div', { className: 'row', style: 'margin-top:10px' }, el('a', { className: 'btn btn-sm primary', href: '/share.html', textContent: 'Earn AI Coins' }))
            : null));
        assistant.content = '';
        finish(d.code === 'insufficient_coins' ? 'not enough AI Coins' : 'failed');
      },
    }, state.controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') content.append(el('div', { className: 'notice danger', textContent: err.message }));
    finish('stopped');
  }
}

async function refreshNetwork() {
  try {
    const [stats, me] = await Promise.all([api('/api/stats'), api('/api/me')]);
    $('#network').textContent = `${stats.providersReady} GPU${stats.providersReady === 1 ? '' : 's'} ready`
      + `${stats.providersOnline > stats.providersReady ? `, ${stats.providersOnline - stats.providersReady} warming up` : ''}`
      + `${stats.queueLength ? ` · ${stats.queueLength} waiting` : ''}`;
    $('#network-dot').className = `dot ${stats.providersReady ? 'on' : 'bad'}`;
    if (me.signedIn) {
      setBalance(me.user.balance);
      $('#balance-hint').textContent = Number(me.user.balance) < 200 ? 'Low on AI Coins — earn more' : 'Earn AI Coins';
    }
  } catch { /* transient */ }
}

boot();
