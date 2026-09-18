/**
 * The free fallback model.
 *
 * Bonsai Swarm is a peer-to-peer network, and a young peer-to-peer network is usually
 * empty. Somebody who types a question and then watches a spinner for two minutes
 * before reading "no GPU picked this up" does not come back. So when the swarm cannot
 * answer, a free hosted model answers instead.
 *
 * It is deliberately never a silent substitute:
 *   - every such answer says, in the chat and in the API, that it did not come from a
 *     volunteer's GPU and which model produced it;
 *   - nobody earns AI Coins for it, because nobody did any work;
 *   - it costs a flat, reduced amount rather than the per-token price;
 *   - it is rate-limited per account, per address and globally per day, because unlike
 *     the swarm it costs somebody real money (or at least real goodwill).
 *
 * Upstreams are plain OpenAI-compatible endpoints, tried in order, and they are
 * configured entirely through the environment - no endpoint and no key is ever in this
 * repository. See `.env.example` for the two ways to configure them.
 */
import { config } from './config.js';

export { normalizeUpstream, parseUpstreams } from './config.js';

/** Thrown when no upstream could produce an answer. */
export class FallbackFailed extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.code = 'fallback_failed';
    this.attempts = attempts;
  }
}

/** What may be shown to a browser: labels, never an endpoint and never a key. */
export function publicFallbackInfo() {
  const f = config.fallback;
  return {
    enabled: f.enabled,
    models: f.upstreams.map((u) => u.label),
    label: f.upstreams[0]?.label || null,
    coinsFlat: f.coinsFlat,
    queueWaitMs: f.queueWaitMs,
    perAccountPerHour: f.perAccountPerHour,
    perIpPerHour: f.perIpPerHour,
    globalPerDay: f.globalPerDay,
  };
}

/** The exact sentence that must accompany every fallback answer. */
export const fallbackNotice = (label) =>
  `No community GPU online right now — answered by a free fallback model (${label}).`;

/**
 * Streams one completion from the first upstream that manages to produce text.
 *
 * An upstream that errors, times out, or returns nothing but reasoning is treated as a
 * failure and the next one is tried. `onDelta` is only ever called for text that is
 * really going to the consumer, and it is called for the first time only after we know
 * this upstream is producing - so a failed first upstream cannot leave half a sentence
 * on the screen.
 */
export async function runFallbackCompletion({
  messages,
  maxTokens,
  signal,
  onUpstream,
  onDelta,
  upstreams = config.fallback.upstreams,
  fetchImpl = fetch,
}) {
  const attempts = [];
  for (const upstream of upstreams) {
    if (signal?.aborted) throw new FallbackFailed('cancelled', attempts);
    try {
      return await streamOne({ upstream, messages, maxTokens, signal, onUpstream, onDelta, fetchImpl });
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw new FallbackFailed('cancelled', attempts);
      attempts.push({ label: upstream.label, error: String(err?.message || err).slice(0, 200) });
    }
  }
  throw new FallbackFailed(
    attempts.length
      ? `every free fallback model failed (${attempts.map((a) => `${a.label}: ${a.error}`).join('; ')})`
      : 'no free fallback model is configured',
    attempts,
  );
}

async function streamOne({ upstream, messages, maxTokens, signal, onUpstream, onDelta, fetchImpl }) {
  const f = config.fallback;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const overall = setTimeout(() => controller.abort(), f.timeoutMs);
  overall.unref?.();

  const body = {
    model: upstream.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: true,
    max_tokens: Math.max(1, Math.min(maxTokens || f.maxNewTokens, f.maxNewTokens)),
    stream_options: { include_usage: true },
  };
  if (upstream.noThinking) body.chat_template_kwargs = { enable_thinking: false };

  try {
    const res = await fetchImpl(`${upstream.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
        ...upstream.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      // The upstream's own error text can contain anything; keep a short, safe slice for
      // the log and never let it reach the consumer verbatim.
      const detail = await res.text?.().catch(() => '') || '';
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`);
    }

    let chars = 0;
    let reportedTokens = null;
    let stopReason = 'stop';
    let announced = false;
    const firstToken = setTimeout(() => controller.abort(), f.firstTokenMs);
    firstToken.unref?.();

    for await (const chunk of iterateSse(res.body)) {
      const choice = chunk?.choices?.[0];
      const piece = choice?.delta?.content;
      if (chunk?.usage?.completion_tokens != null) reportedTokens = Number(chunk.usage.completion_tokens);
      if (choice?.finish_reason) stopReason = choice.finish_reason === 'length' ? 'length' : 'stop';
      if (typeof piece !== 'string' || piece === '') continue;
      if (!announced) {
        announced = true;
        clearTimeout(firstToken);
        onUpstream?.(upstream);
      }
      chars += piece.length;
      onDelta?.(piece);
    }
    clearTimeout(firstToken);

    // A reasoning model that spent its whole budget thinking produced nothing usable.
    // Treat that as a failure so the next upstream gets a turn.
    if (chars === 0) throw new Error('produced no answer text');

    return {
      label: upstream.label,
      model: upstream.model,
      chars,
      // Prefer what the upstream counted; otherwise the same estimate the rest of the
      // app uses, so the number in the UI is at least consistent with itself.
      completionTokens: Number.isFinite(reportedTokens) && reportedTokens > 0
        ? Math.round(reportedTokens)
        : Math.max(1, Math.ceil(chars / 3.7)),
      stopReason,
    };
  } finally {
    clearTimeout(overall);
    signal?.removeEventListener('abort', abort);
  }
}

/** Minimal `text/event-stream` reader: yields each parsed `data:` object. */
export async function* iterateSse(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch { /* a keep-alive or a partial frame */ }
      }
    }
  }
}
