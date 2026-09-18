import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { requireAuth, isTestMode } from '../auth.js';
import { normalizeMessages, accountChatLimiter, bufferingSink, servedByHeader } from './api.js';
import { clientIp } from '../util.js';

export const MODEL_NAME = 'bonsai-swarm/ternary-bonsai-2-27b';

const openaiError = (res, status, message, type = 'invalid_request_error', code = null) =>
  res.status(status).json({ error: { message, type, code, param: null } });

/**
 * OpenAI Chat Completions on top of the volunteer network. This is the single upstream
 * the downloadable client (and LiteLLM inside it) talks to; the Responses and Anthropic
 * Messages shapes are translated in the client.
 */
export function openaiRouter(coordinator) {
  const router = express.Router();

  router.get('/models', (req, res) => {
    res.json({
      object: 'list',
      data: [{
        id: MODEL_NAME,
        object: 'model',
        created: 1758000000,
        owned_by: 'bonsai-swarm',
        description: 'Ternary Bonsai 2 27B running in volunteers\' browsers on WebGPU',
      }],
    });
  });

  router.post('/chat/completions', requireAuth, async (req, res) => {
    if (!accountChatLimiter.take(`chat:${req.user.id}`)) {
      return openaiError(res, 429, `At most ${config.limits.chatPerMinute} requests per minute.`,
        'rate_limit_error', 'rate_limited');
    }
    const body = req.body || {};
    let messages;
    try { messages = normalizeMessages(body.messages); }
    catch (err) { return openaiError(res, 400, err.message); }

    const stream = Boolean(body.stream);
    const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens) || config.jobs.defaultMaxNewTokens;
    const enableThinking = body.reasoning_effort ? body.reasoning_effort !== 'none' : Boolean(body.thinking);
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) return nonStreaming();
    return streaming();

    async function nonStreaming() {
      let text = '';
      let jobRef = null;
      const done = new Promise((resolve) => {
        const sink = {
          // Nothing has been sent yet, so a half-finished answer can simply be dropped:
          // a job whose volunteer disappears can still be completed by the fallback.
          canReset: true,
          onReset: () => { text = ''; },
          onDelta: (d) => { text += d.delta; },
          onDone: (d) => resolve({ ok: true, summary: d }),
          onError: (d) => resolve({ ok: false, summary: d }),
        };
        coordinator.submit({
          user: req.user, messages, maxNewTokens: maxTokens, enableThinking, sink,
          clientIp: clientIp(req, { trustProxy: config.trustProxy }),
          allowMock: isTestMode(req),
        })
          .then((job) => { jobRef = job; })
          .catch((err) => resolve({ ok: false, summary: { error: err.message, code: err.code } }));
      });
      res.on('close', () => { if (jobRef) coordinator.cancel(jobRef.id, req.user.id).catch(() => {}); });
      const result = await done;
      if (!result.ok) {
        const status = result.summary.code === 'insufficient_coins' ? 402
          : result.summary.code === 'too_many_requests' ? 429 : 503;
        res.set('x-bonsai-served-by', result.summary.servedBy || 'community');
        return openaiError(res, status, result.summary.error || 'The network could not answer this request.',
          'server_error', result.summary.code || null);
      }
      // Headers are written last on this path, so this one is always exact.
      res.set('x-bonsai-served-by', result.summary.servedBy || 'community');
      if (result.summary.servedBy === 'fallback') res.set('x-bonsai-fallback-model', result.summary.fallbackModel || '');
      res.json({
        id, object: 'chat.completion', created, model: MODEL_NAME,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: result.summary.stopReason === 'length' ? 'length' : 'stop',
        }],
        usage: usageOf(result.summary),
        bonsai_swarm: extras(result.summary),
      });
    }

    async function streaming() {
      const buf = bufferingSink();
      buf.sink.canReset = false;
      let job = null;
      let closed = false;
      res.on('close', () => {
        closed = true;
        if (job) coordinator.cancel(job.id, req.user.id).catch(() => {});
      });
      try {
        job = await coordinator.submit({
          user: req.user, messages, maxNewTokens: maxTokens, enableThinking, sink: buf.sink,
          clientIp: clientIp(req, { trustProxy: config.trustProxy }),
          allowMock: isTestMode(req),
        });
      } catch (err) {
        const status = err.code === 'insufficient_coins' ? 402
          : err.code === 'too_many_requests' ? 429 : 503;
        return openaiError(res, status, err.message, 'invalid_request_error', err.code || null);
      }
      if (closed) {
        await coordinator.cancel(job.id, req.user.id).catch(() => {});
        return;
      }
      res.set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-bonsai-served-by': servedByHeader(job, coordinator),
      });
      res.flushHeaders?.();
      const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      let first = true;
      let ended = false;
      const end = () => { if (ended) return; ended = true; if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };

      const sink = {
        canReset: false,
        onFallback: (d) => {
          send({
            id, object: 'chat.completion.chunk', created, model: MODEL_NAME,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            bonsai_swarm: { served_by: 'fallback', fallback_model: d.model, notice: d.notice },
          });
        },
        onDelta: (d) => {
          const delta = first ? { role: 'assistant', content: d.delta } : { content: d.delta };
          first = false;
          send({ id, object: 'chat.completion.chunk', created, model: MODEL_NAME, choices: [{ index: 0, delta, finish_reason: null }] });
        },
        onDone: (summary) => {
          send({
            id, object: 'chat.completion.chunk', created, model: MODEL_NAME,
            choices: [{ index: 0, delta: {}, finish_reason: summary.stopReason === 'length' ? 'length' : 'stop' }],
            usage: usageOf(summary),
            bonsai_swarm: extras(summary),
          });
          end();
        },
        onError: (summary) => {
          send({ error: { message: summary.error || 'network error', type: 'server_error', code: summary.code || null } });
          end();
        },
      };
      buf.attach(sink);
    }
  });

  return router;
}

function usageOf(summary) {
  return {
    prompt_tokens: summary.promptTokens ?? 0,
    completion_tokens: summary.completionTokens ?? 0,
    total_tokens: (summary.promptTokens ?? 0) + (summary.completionTokens ?? 0),
  };
}

function extras(summary) {
  return {
    coins_charged: summary.coinsCharged ?? 0,
    decode_tps: summary.decodeTps ?? null,
    job_id: summary.jobId ?? null,
    // 'community' = a volunteer's GPU produced this; 'fallback' = the swarm was empty
    // and a free hosted model answered instead. Always present, always authoritative.
    served_by: summary.servedBy ?? 'community',
    fallback_model: summary.fallbackModel ?? null,
  };
}
