/**
 * The one place that talks to the network. Everything the local server offers -
 * OpenAI Chat Completions, OpenAI Responses and Anthropic Messages - is a translation
 * of this single upstream call.
 */

export class UpstreamError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function chatCompletion({ url, token }, payload, { signal } = {}) {
  const res = await fetch(`${url}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    throw new UpstreamError(body?.error?.message || `Upstream returned ${res.status}`, res.status, body);
  }
  return res;
}

/** Async-iterates the upstream SSE stream as parsed OpenAI chunks. */
export async function* streamChunks(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* keep-alive or partial frame */ }
      }
    }
  }
}

/** Collects a streamed upstream response into one text + usage pair. */
export async function collect(res) {
  let text = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finish = 'stop';
  let error = null;
  for await (const chunk of streamChunks(res)) {
    if (chunk.error) { error = chunk.error; continue; }
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) text += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  return { text, usage, finish, error };
}

/** Splits `<think>…</think>` off the front of an answer. */
export function splitThinking(text) {
  const open = text.indexOf('<think>');
  const close = text.indexOf('</think>');
  if (open === -1 || close === -1 || close < open) return { thinking: '', answer: text };
  return {
    thinking: text.slice(open + 7, close).trim(),
    answer: text.slice(close + 8).replace(/^\n+/, ''),
  };
}
