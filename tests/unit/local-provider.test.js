import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, resetDb, client, signUp, createToken, openSse, waitFor, pool, TEST_KEY } from '../helpers.js';
import { startFakeLocalLlm } from '../fake-local-llm.js';
import { MockProvider } from '../mock-provider.js';
import { runLocalProvider } from '../../client/src/local.js';
import { INTEGRITY_PROMPTS, judgeIntegrity } from '../../server/integrity.js';

const BONSAI = Object.fromEntries(INTEGRITY_PROMPTS.map((p) => [p.prompt, p.accepted[0]]));
const QWEN = JSON.parse(readFileSync(new URL('../fixtures/qwen3.8-27b-answers.json', import.meta.url), 'utf8'));

let srv;
const cleanups = [];
const quiet = () => {};

test.before(async () => { srv = await startTestServer({ PROVIDER_VERIFY_TIMEOUT_MS: 8000 }); });
test.after(async () => { for (const c of cleanups.splice(0)) await c(); await srv.close(); await pool.end(); });
test.beforeEach(async () => { for (const c of cleanups.splice(0)) await c(); await resetDb(); });

async function localProvider(username, llmOptions, providerOptions = {}) {
  const llm = await startFakeLocalLlm(llmOptions);
  const c = client(srv.url); await signUp(c, username);
  const token = await createToken(c);
  const run = runLocalProvider({ url: srv.url, token, base: llm.url, model: llmOptions.modelId || 'Ternary-Bonsai-2-27B-PQ2_0.gguf', log: quiet, reconnectMs: 60_000, ...providerOptions });
  cleanups.push(async () => { run.stop(); await llm.close(); });
  return { llm, run };
}

const admissionOf = async (username) => {
  let view;
  await waitFor(async () => {
    view = [...srv.coordinator.providers.values()].find((p) => p.displayName === username && p.verification?.finished);
    return Boolean(view);
  }, 8000);
  return view;
};

test('the recorded answers: Bonsai passes the model check, its parent model Qwen3.8-27B does not', () => {
  assert.equal(judgeIntegrity(INTEGRITY_PROMPTS.map((p) => BONSAI[p.prompt])).passed, true);
  const qwen = judgeIntegrity(INTEGRITY_PROMPTS.map((p) => QWEN[p.prompt]));
  assert.equal(qwen.passed, false);
  assert.equal(qwen.matched, 0);
});

test('a local llama.cpp server running Bonsai is checked, timed by the server, admitted and then serves a request', async () => {
  const { llm } = await localProvider('localgood', { answers: BONSAI });
  const view = await admissionOf('localgood');
  assert.equal(view.admitted, true);
  assert.equal(view.kind, 'local');
  assert.ok(view.measuredTps > 5, `server-timed speed should be recorded, saw ${view.measuredTps}`);
  // the check ran greedy, without thinking
  assert.ok(llm.requests.slice(0, 6).every((b) => b.temperature === 0 && b.chat_template_kwargs.enable_thinking === false));

  const user = client(srv.url); await signUp(user, 'askslocal');
  const stream = await openSse(srv.url, '/api/chat/stream', {
    cookie: user.cookie, body: { messages: [{ role: 'user', content: 'hello local llama' }], maxTokens: 12 },
  });
  await stream.until((e) => e.some((x) => x.event === 'done'), 10_000);
  const assigned = stream.events.find((e) => e.event === 'assigned');
  assert.match(assigned.data.providerLabel, /llama\.cpp/);
  assert.ok(assigned.data.decodeTps > 0);
  assert.ok(stream.events.filter((e) => e.event === 'delta').length >= 1);
  assert.equal(llm.requests.at(-1).messages.at(-1).content, 'hello local llama');
});

test('a local server running a different model is refused with a clear reason', async () => {
  const { run } = await localProvider('localwrong', { answers: QWEN });
  const result = await run.done;
  assert.equal(result.admitted, false);
  assert.match(result.reason, /match Ternary Bonsai 2 27B on 0 of 6/);
  const view = [...srv.coordinator.providers.values()].find((p) => p.displayName === 'localwrong');
  assert.ok(!view || view.admitted === false);
});

test('a local server whose model id is not Bonsai is refused even with the right answers', async () => {
  const { run } = await localProvider('localname', { answers: BONSAI, modelId: 'llama-3.3-70b' });
  const result = await run.done;
  assert.equal(result.admitted, false);
  assert.match(result.reason, /llama-3\.3-70b/);
});

test('a slow local server is refused on the speed the server measured', async () => {
  const { run } = await localProvider('localslow', { answers: BONSAI, tokenDelayMs: 1, fallbackDelayMs: 400, fallbackTokens: 6 });
  const result = await run.done;
  assert.equal(result.admitted, false);
  assert.match(result.reason, /tokens\/s/);
});

test('faster providers are asked first; a slow one only when the fast one is busy', async () => {
  const mk = async (name, tps, tokens) => {
    const c = client(srv.url); await signUp(c, name);
    const p = new MockProvider({ url: srv.url, token: await createToken(c), testKey: TEST_KEY, decodeTps: tps, tokens, delayMs: 40, label: name });
    cleanups.push(async () => p.close());
    await p.connect();
    return p;
  };
  const fast = await mk('fastgpu', 18, 6);
  const slow = await mk('slowgpu5', 6, 6);
  assert.equal(slow.admitted, true, 'a 6 tok/s card is admitted under the 5 tok/s bar');
  const user = client(srv.url); await signUp(user, 'picky');
  const ask = () => openSse(srv.url, '/api/chat/stream', { cookie: user.cookie, body: { messages: [{ role: 'user', content: 'hi' }] } });
  for (let i = 0; i < 3; i += 1) {
    const s = await ask();
    await s.until((e) => e.some((x) => x.event === 'done'), 5000);
  }
  assert.equal(fast.served, 3);
  assert.equal(slow.served, 0);
  // two at once: the second has to go to the slow one
  const other = client(srv.url); await signUp(other, 'picky2');
  const [a, b] = await Promise.all([ask(), openSse(srv.url, '/api/chat/stream', { cookie: other.cookie, body: { messages: [{ role: 'user', content: 'hi' }] } })]);
  await a.until((e) => e.some((x) => x.event === 'done'), 5000);
  await b.until((e) => e.some((x) => x.event === 'done'), 5000);
  assert.equal(slow.served, 1);
});
