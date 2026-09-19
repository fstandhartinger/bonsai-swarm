/**
 * The volunteer's inference worker.
 *
 * Everything model-related runs here, in a Web Worker, on purpose: the upstream runtime
 * yields with requestAnimationFrame when it exists, and rAF stalls in a hidden or
 * occluded tab - which is exactly the state a "share my GPU in the background" tab is
 * in. Inside a worker there is no rAF, so the library falls back to setTimeout and keeps
 * generating while the tab sits behind other windows.
 *
 * The runtime itself is served from our own origin by /runtime/bonsai2-lib.js (see
 * server/runtime.js for why it is not vendored).
 */

let TernaryBonsai2 = null;
let model = null;
const aborts = new Map(); // jobId -> AbortController

const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const errText = (err) => (err instanceof Error ? err.message : String(err));

async function runtime() {
  if (!TernaryBonsai2) ({ TernaryBonsai2 } = await import('/runtime/bonsai2-lib.js'));
  return TernaryBonsai2;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    switch (msg.cmd) {
      case 'check': return await check();
      case 'load': return await load(msg);
      case 'benchmark': return await benchmark(msg);
      case 'generate': return await generate(msg);
      case 'cancel': return cancel(msg.jobId);
      case 'dispose': return dispose();
      default: return;
    }
  } catch (err) {
    if (msg.jobId) post('job-error', { jobId: msg.jobId, message: errText(err) });
    else post('error', { stage: msg.cmd, message: errText(err) });
  }
};

async function check() {
  if (!('gpu' in navigator)) {
    return post('availability', { ok: false, reason: 'This browser has no WebGPU. Chrome or Edge 121+ on a desktop works; Safari needs 18+.' });
  }
  const lib = await runtime();
  const result = await lib.checkAvailability();
  post('availability', { ok: Boolean(result?.ok ?? result === true), reason: result?.reason ?? null, raw: result ?? null });
}

async function load({ maxLength = 4096, enableThinking = false }) {
  const lib = await runtime();
  const started = Date.now();
  model = await lib.load(null, {
    maxLength,
    chatTemplateArgs: { enable_thinking: enableThinking, preserve_thinking: false },
    onProgress: (e) => post('progress', {
      status: e?.status ?? '', kind: e?.kind ?? '', message: e?.message ?? '',
      loaded: e?.loaded ?? null, total: e?.total ?? null, fromCache: Boolean(e?.fromCache),
    }),
  });
  let device = null;
  try { device = model.deviceInfo?.() ?? null; } catch { /* optional */ }
  post('loaded', {
    ms: Date.now() - started,
    gpuLabel: gpuLabelFrom(device),
    maxLength,
  });
}

function gpuLabelFrom(device) {
  if (!device) return null;
  const parts = [device.vendor, device.architecture, device.description].filter(Boolean);
  return parts.length ? parts.join(' ').slice(0, 120) : null;
}

/**
 * The admission test. It decodes a fixed, tiny prompt so every machine is measured the
 * same way, and reports the real decode speed - the only reliable way to notice that a
 * model has spilled out of VRAM into system RAM.
 */
async function benchmark({ maxNewTokens = 24 }) {
  if (!model) throw new Error('model not loaded');
  const prompt = [{ role: 'user', content: 'Count from one to ten.' }];
  // load() has already compiled every kernel and tuned the decode pipeline, so this is a
  // warm measurement. It runs twice and keeps the better run, so one hiccup (another
  // program grabbing the GPU for a second) does not decide admission; on the test pod
  // the two runs agreed within 1 %. The server times every real answer anyway.
  let best = null;
  for (let run = 0; run < 2; run += 1) {
    let result;
    if (typeof model.benchmark === 'function') {
      result = await model.benchmark(prompt, { maxNewTokens });
    } else {
      const ids = model.encodePrompt(prompt);
      result = await model.benchmarkFixedTokenIds(ids, maxNewTokens, {});
    }
    model.reset?.();
    if (!best || Number(result?.decodeTps ?? 0) > Number(best?.decodeTps ?? 0)) best = result;
  }
  post('benchmark', {
    decodeTps: Number(best?.decodeTps ?? 0),
    ttftMs: Number(best?.ttftMs ?? 0),
    tokens: Number(best?.tokens ?? 0),
  });
}

async function generate({ jobId, messages, maxNewTokens = 512, enableThinking = false }) {
  if (!model) throw new Error('model not loaded');
  const controller = new AbortController();
  aborts.set(jobId, controller);
  // Never carry one stranger's conversation into the next one: the KV cache is wiped
  // before and after every job.
  model.reset?.();
  model.chatTemplateArgs = { enable_thinking: enableThinking, preserve_thinking: false };
  const started = Date.now();
  let count = 0;
  try {
    for await (const step of model.generate(messages, { maxNewTokens, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      const delta = step?.delta ?? '';
      if (!delta) continue;
      count += 1;
      post('job-delta', { jobId, delta });
    }
    post('job-done', {
      jobId,
      tokens: count,
      ms: Date.now() - started,
      stopReason: controller.signal.aborted ? 'cancelled' : 'stop',
    });
  } catch (err) {
    if (controller.signal.aborted) post('job-done', { jobId, tokens: count, ms: Date.now() - started, stopReason: 'cancelled' });
    else post('job-error', { jobId, message: errText(err) });
  } finally {
    aborts.delete(jobId);
    try { model.reset?.(); } catch { /* model may be disposed */ }
  }
}

function cancel(jobId) {
  aborts.get(jobId)?.abort();
}

function dispose() {
  for (const c of aborts.values()) c.abort();
  aborts.clear();
  try { model?.dispose?.(); } catch { /* already gone */ }
  model = null;
  post('disposed');
}
