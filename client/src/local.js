/**
 * Share a GPU through your own llama.cpp server instead of a browser tab.
 *
 *   bonsai-swarm provide --local http://127.0.0.1:8080
 *
 * The model keeps running in the program you already tuned (llama.cpp's llama-server,
 * or anything else that speaks the OpenAI chat API and can load the Bonsai GGUF); this
 * only relays. It connects to the coordinator as a provider, answers the admission check
 * the coordinator sends (six fixed prompts that must come back as Ternary Bonsai 2 27B
 * would answer them, and one longer answer the coordinator times), and then passes
 * other people's prompts to the local server and streams the tokens back.
 *
 * Nothing here listens on a port, and the local server never sees your API token.
 */
import { streamChunks } from './upstream.js';

/** The coordinator bills one frame as one token, and refuses frames longer than this. */
const MAX_FRAME_CHARS = 48;

export function normaliseBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base.replace(/\/v1$/, '');
}

/** Splits a text into pieces no longer than a token frame may be. */
export function frames(text, max = MAX_FRAME_CHARS) {
  const out = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** Asks the local server which model it serves. */
export async function probeLocalServer(base, { apiKey = null, model = null, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  } catch (err) {
    throw new Error(`Nothing answered at ${base} (${err.cause?.code || err.message}). Start llama-server first, `
      + 'for example:\n  llama-server -m Ternary-Bonsai-2-27B-PQ2_0.gguf -ngl 99 -fa on -c 8192 --port 8080');
  }
  if (!res.ok) throw new Error(`${base}/v1/models returned ${res.status}. Is this an OpenAI-compatible server?`);
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || body.models || []).map((m) => m.id || m.name || m.model).filter(Boolean);
  if (model) return { modelId: model, available: ids };
  if (!ids.length) throw new Error(`${base}/v1/models lists no model.`);
  return { modelId: ids.find((id) => /bonsai/i.test(id)) || ids[0], available: ids };
}

/**
 * One streamed chat completion against the local server. Calls onText for every piece
 * of visible text (reasoning wrapped in <think> tags, the way the browser runtime emits
 * it) and returns the model id the server reported.
 */
export async function streamLocal(base, { model, messages, maxTokens, enableThinking = false, greedy = false, apiKey = null, signal, fetchImpl = fetch }, onText) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
    // llama.cpp and LM Studio read the chat-template switch; Ollama reads `think`.
    chat_template_kwargs: { enable_thinking: Boolean(enableThinking) },
    think: Boolean(enableThinking),
  };
  if (greedy) Object.assign(body, { temperature: 0, top_k: 1, top_p: 1, seed: 1 });
  const res = await fetchImpl(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`local server returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  let reportedModel = null;
  let inThinking = false;
  let finish = 'stop';
  for await (const chunk of streamChunks(res)) {
    if (chunk.error) throw new Error(chunk.error.message || 'local server error');
    reportedModel ||= chunk.model || null;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning || '';
    if (reasoning) {
      if (!inThinking) { onText('<think>\n'); inThinking = true; }
      onText(reasoning);
    }
    if (delta.content) {
      if (inThinking) { onText('\n</think>\n\n'); inThinking = false; }
      onText(delta.content);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (inThinking) onText('\n</think>\n\n');
  return { reportedModel, finish };
}

/**
 * Connects to the coordinator and relays. Resolves when the connection ends for good
 * (admission refused, or stop() called); reconnects after network hiccups.
 */
export function runLocalProvider({
  url, token, base, model, apiKey = null, log = console.log, override = false,
  WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch, reconnectMs = 5000,
}) {
  if (!WebSocketImpl) {
    throw new Error('This needs Node.js 22 or newer (it uses the built-in WebSocket). Check with: node --version');
  }
  let stopped = false;
  let ws = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const aborts = new Map();

  const send = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
  const emit = (type, extra) => (text) => { for (const f of frames(text)) send({ type, ...extra, delta: f }); };

  async function verify(msg) {
    log('Checking that your server really runs Ternary Bonsai 2 27B, then timing it…');
    for (const task of msg.tasks) {
      try {
        const { reportedModel } = await streamLocal(base, {
          model, messages: task.messages, maxTokens: task.maxTokens, enableThinking: false,
          greedy: true, apiKey, fetchImpl,
        }, emit('verify.delta', { index: task.index }));
        send({ type: 'verify.done', index: task.index, modelId: reportedModel || model });
      } catch (err) {
        send({ type: 'verify.done', index: task.index, modelId: model, error: err.message });
        return;
      }
    }
  }

  async function runJob(msg) {
    const controller = new AbortController();
    aborts.set(msg.jobId, controller);
    const started = Date.now();
    let pieces = 0;
    const out = emit('job.delta', { jobId: msg.jobId });
    try {
      await streamLocal(base, {
        model, messages: msg.messages, maxTokens: msg.maxNewTokens, enableThinking: msg.enableThinking,
        apiKey, signal: controller.signal, fetchImpl,
      }, (text) => { pieces += 1; out(text); });
      send({ type: 'job.done', jobId: msg.jobId, stopReason: controller.signal.aborted ? 'cancelled' : 'stop' });
      log(`[${new Date().toLocaleTimeString()}] served a request: ${pieces} tokens in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (err) {
      if (controller.signal.aborted) send({ type: 'job.done', jobId: msg.jobId, stopReason: 'cancelled' });
      else { send({ type: 'job.error', jobId: msg.jobId, message: err.message }); log(`A request failed: ${err.message}`); }
    } finally {
      aborts.delete(msg.jobId);
    }
  }

  function connect() {
    const target = new URL('/ws/provider', url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.searchParams.set('kind', 'local');
    target.searchParams.set('tz', String(-new Date().getTimezoneOffset()));
    if (override) target.searchParams.set('override', '1');
    ws = new WebSocketImpl(target.toString(), { headers: { authorization: `Bearer ${token}` } });
    ws.onopen = () => log(`Connected to ${url} as a local-server provider (${model} at ${base}).`);
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
      switch (msg.type) {
        case 'ping': send({ type: 'pong', t: msg.t }); return;
        case 'verify': verify(msg); return;
        case 'admission':
          if (msg.admitted) {
            log(`Admitted: ${msg.decodeTps} tokens/s measured by the swarm`
              + `${msg.integrity ? `, model check ${msg.integrity.matched}/${msg.integrity.total}` : ''}. Waiting for requests…`);
            send({ type: 'status', state: 'ready' });
          } else {
            log(`Not admitted. ${msg.reason || ''}`);
            stopped = true;
            try { ws.close(); } catch { /* closing anyway */ }
            resolveDone({ admitted: false, reason: msg.reason });
          }
          return;
        case 'job.start': runJob(msg); return;
        case 'job.cancel': aborts.get(msg.jobId)?.abort(); return;
        default:
      }
    };
    ws.onclose = () => {
      for (const c of aborts.values()) c.abort();
      if (stopped) { resolveDone({ admitted: null }); return; }
      log(`Connection to the swarm lost, reconnecting in ${Math.round(reconnectMs / 1000)} s…`);
      setTimeout(() => { if (!stopped) connect(); }, reconnectMs);
    };
    ws.onerror = () => {};
  }

  connect();
  return {
    done,
    stop() { stopped = true; for (const c of aborts.values()) c.abort(); try { ws?.close(); } catch { /* closing */ } },
  };
}
