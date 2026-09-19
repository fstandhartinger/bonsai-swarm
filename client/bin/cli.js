#!/usr/bin/env node
/**
 * bonsai-swarm - join the volunteer GPU network from your own machine.
 *
 *   bonsai-swarm login            store an API token from the website
 *   bonsai-swarm provide          share this machine's GPU (starts a browser)
 *   bonsai-swarm provide --local http://127.0.0.1:8080
 *                                 share it through your own llama.cpp server instead
 *   bonsai-swarm serve            local OpenAI / Responses / Anthropic endpoints
 *   bonsai-swarm litellm          the same three shapes through LiteLLM
 *   bonsai-swarm status           what the network and your account look like
 *   bonsai-swarm ask "question"   one-off question from the terminal
 */
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

import { readConfig, writeConfig, requireAuth, DEFAULT_URL, configDir } from '../src/config.js';
import { createLocalServer, MODEL_ID } from '../src/serve.js';
import { launchBrowser, watchStatus, findChrome } from '../src/provide.js';
import { runLocalProvider, probeLocalServer, normaliseBase } from '../src/local.js';
import { chatCompletion, streamChunks } from '../src/upstream.js';

const argv = process.argv.slice(2);
const command = argv[0];

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const has = (name) => argv.includes(`--${name}`);

const USAGE = `bonsai-swarm - the Bonsai Swarm volunteer GPU network

  login [--url URL] [--token TOKEN]   store an API token (create one on the Account page)
  logout                              forget the stored token
  status                              show your AI Coins and the state of the network
  provide [--chrome PATH] [--override]
                                      share this machine's GPU: starts a browser that
                                      loads the model and serves the network
  provide --local URL [--model ID] [--api-key KEY]
                                      share through your own llama.cpp server (or another
                                      OpenAI-compatible server running the Bonsai GGUF):
                                      no browser, usually 2-5x faster on Windows
  serve [--port 4777] [--host 127.0.0.1] [--verbose]
                                      local API gateway:
                                        POST /v1/chat/completions  (OpenAI)
                                        POST /v1/responses         (OpenAI Responses)
                                        POST /v1/messages          (Anthropic Messages)
  litellm [--port 4778] [--gateway-port 4777]
                                      run LiteLLM in front of this client
  ask "question" [--max-tokens N]     one question, streamed to the terminal
  help                                this text

Environment: BONSAI_SWARM_URL, BONSAI_SWARM_TOKEN, BONSAI_SWARM_CHROME, BONSAI_SWARM_HOME`;

const die = (message) => { console.error(message); process.exit(1); };

switch (command) {
  case 'login': await login(); break;
  case 'logout': await logout(); break;
  case 'status': await status(); break;
  case 'provide': await provide(); break;
  case 'serve': await serve(); break;
  case 'litellm': await litellm(); break;
  case 'ask': await ask(); break;
  case 'help': case '--help': case '-h': case undefined: console.log(USAGE); break;
  default: die(`Unknown command "${command}".\n\n${USAGE}`);
}

// ---------------------------------------------------------------- commands

async function login() {
  const url = String(flag('url', readConfig().url || DEFAULT_URL)).replace(/\/+$/, '');
  let token = flag('token');
  if (typeof token !== 'string') {
    console.log(`Create an API token here:  ${url}/wallet.html`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('Paste the token (bsw_…): ')).trim();
    rl.close();
  }
  if (!token.startsWith('bsw_')) die('That does not look like a Bonsai Swarm token (they start with "bsw_").');

  const res = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  const me = await res.json().catch(() => ({}));
  if (!me.signedIn) die('The server did not accept that token.');

  const file = writeConfig({ url, token });
  console.log(`Signed in as ${me.user.displayName} (${Number(me.user.balance).toFixed(0)} AI Coins).`);
  console.log(`Token stored in ${file} (readable only by you).`);
}

async function logout() {
  writeConfig({ url: readConfig().url, token: null });
  console.log('Token removed from this machine. Revoke it on the website if it may have leaked.');
}

async function status() {
  const { url, token } = requireAuth();
  const [me, stats] = await Promise.all([
    fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()),
    fetch(`${url}/api/stats`).then((r) => r.json()),
  ]);
  if (!me.signedIn) die('The stored token is not valid any more. Run "bonsai-swarm login".');
  console.log(`Account   ${me.user.displayName}`);
  console.log(`Coins     ${Number(me.user.balance).toFixed(1)}`);
  console.log(`Network   ${stats.providersReady} of ${stats.providersOnline} GPUs ready, ${stats.queueLength} request(s) waiting`);
  console.log(`Speed     ${stats.avgDecodeTps ? `${stats.avgDecodeTps} tok/s average per GPU` : 'no GPU online'}`);
  console.log(`Today     ${stats.tokensToday} tokens served`);
  if (me.providers?.length) {
    for (const p of me.providers) {
      console.log(`Your GPU  ${p.state}, ${p.admitted ? 'admitted' : 'not admitted'}, `
        + `${p.decodeTps ? `${Number(p.decodeTps).toFixed(1)} tok/s` : 'measuring'}, `
        + `${p.jobsServed} requests served`);
    }
  }
}

async function provide() {
  const { url, token } = requireAuth();
  if (flag('local')) return provideLocal({ url, token });
  console.log('Sharing this machine\'s GPU with the Bonsai Swarm network.');
  console.log('First run downloads about 5.9 GB of model weights into the browser profile below.');
  console.log('Other people\'s prompts will be processed on this computer. Close the browser window to stop.\n');
  try { console.log(`Browser: ${findChrome(flag('chrome'))}`); } catch (err) { die(err.message); }

  const child = await launchBrowser({
    url,
    token,
    chromePath: typeof flag('chrome') === 'string' ? flag('chrome') : null,
    override: has('override'),
  });
  const controller = new AbortController();
  child.on('exit', (code) => {
    controller.abort();
    console.log(`\nBrowser closed (exit code ${code}). No longer sharing.`);
    process.exit(0);
  });
  process.on('SIGINT', () => { controller.abort(); child.kill(); process.exit(0); });
  await watchStatus({ url, token, signal: controller.signal });
}

async function provideLocal({ url, token }) {
  const raw = flag('local');
  if (typeof raw !== 'string') die('Usage: bonsai-swarm provide --local http://127.0.0.1:8080');
  const base = normaliseBase(raw);
  const apiKey = typeof flag('api-key') === 'string' ? flag('api-key') : null;
  let probe;
  try {
    probe = await probeLocalServer(base, { apiKey, model: typeof flag('model') === 'string' ? flag('model') : null });
  } catch (err) { die(err.message); }
  console.log('Sharing your local model server with the Bonsai Swarm network.');
  console.log(`  server   ${base}`);
  console.log(`  model    ${probe.modelId}`);
  console.log('Other people\'s prompts will be answered by that server. Ctrl-C to stop.\n');
  if (!/bonsai/i.test(probe.modelId)) {
    console.log(`Warning: "${probe.modelId}" does not look like Ternary Bonsai 2 27B. The swarm will check the answers`);
    console.log('and refuse any other model.\n');
  }
  const run = runLocalProvider({ url, token, base, model: probe.modelId, apiKey, override: has('override') });
  process.on('SIGINT', () => { run.stop(); process.exit(0); });
  const result = await run.done;
  process.exit(result.admitted === false ? 2 : 0);
}

async function serve() {
  const { url, token } = requireAuth();
  const port = Number(flag('port', 4777));
  const host = String(flag('host', '127.0.0.1'));
  const server = createLocalServer({ url, token, verbose: has('verbose') });
  server.listen(port, host, () => {
    const addr = server.address();
    const boundHost = addr && typeof addr === 'object' ? addr.address : host;
    const boundPort = addr && typeof addr === 'object' ? addr.port : port;
    const displayHost = boundHost === '::' ? '0.0.0.0' : boundHost === '::1' ? '127.0.0.1' : boundHost;
    console.log(`Bonsai Swarm gateway on http://${displayHost}:${boundPort}`);
    console.log(`  upstream            ${url}`);
    console.log(`  model               ${MODEL_ID}`);
    console.log('  OpenAI chat         POST /v1/chat/completions');
    console.log('  OpenAI responses    POST /v1/responses');
    console.log('  Anthropic messages  POST /v1/messages');
    console.log('\nPoint a tool at it, for example:');
    console.log(`  export OPENAI_BASE_URL=http://${displayHost}:${boundPort}/v1`);
    console.log('  export OPENAI_API_KEY=local');
    console.log(`  export ANTHROPIC_BASE_URL=http://${displayHost}:${boundPort}`);
    console.log('  export ANTHROPIC_API_KEY=local');
    const loopback = boundHost === '127.0.0.1' || boundHost === '::1' || boundHost === 'localhost'
      || boundHost === '::ffff:127.0.0.1';
    if (loopback) console.log('\nThis listens on localhost only. Ctrl-C to stop.');
    else console.log(`\nWARNING: bound to ${boundHost}. Anyone who can reach this port can spend your AI Coins.`);
  });
  process.on('SIGINT', () => { server.close(); process.exit(0); });
}

async function litellm() {
  const { url, token } = requireAuth();
  const gatewayPort = Number(flag('gateway-port', 4777));
  const litellmPort = Number(flag('port', 4778));

  const server = createLocalServer({ url, token, verbose: has('verbose') });
  await new Promise((resolve) => server.listen(gatewayPort, '127.0.0.1', resolve));
  console.log(`Gateway up on http://127.0.0.1:${gatewayPort}`);

  const configPath = path.join(configDir(), 'litellm.config.yaml');
  writeFileSync(configPath, litellmConfig(gatewayPort), 'utf8');
  console.log(`LiteLLM config written to ${configPath}`);

  const child = spawn('litellm', ['--config', configPath, '--port', String(litellmPort), '--host', '127.0.0.1'], {
    stdio: 'inherit',
    env: { ...process.env, BONSAI_SWARM_LOCAL_KEY: 'local' },
  });
  child.on('error', () => {
    console.error('\nLiteLLM is not installed. Install it with:  pipx install "litellm[proxy]"');
    console.error(`The plain gateway is still running on http://127.0.0.1:${gatewayPort} and already speaks`);
    console.error('OpenAI, OpenAI Responses and Anthropic Messages without LiteLLM.');
  });
  process.on('SIGINT', () => { child.kill(); server.close(); process.exit(0); });
}

function litellmConfig(gatewayPort) {
  return `# Generated by "bonsai-swarm litellm". LiteLLM in front of the local gateway.
model_list:
  - model_name: bonsai-swarm
    litellm_params:
      model: openai/${MODEL_ID}
      api_base: http://127.0.0.1:${gatewayPort}/v1
      api_key: local
  - model_name: ${MODEL_ID}
    litellm_params:
      model: openai/${MODEL_ID}
      api_base: http://127.0.0.1:${gatewayPort}/v1
      api_key: local

litellm_settings:
  drop_params: true

general_settings:
  # Everything stays on this machine; the network itself authenticates with your token.
  master_key: local
`;
}

async function ask() {
  const { url, token } = requireAuth();
  const question = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!question) die('Usage: bonsai-swarm ask "your question"');
  const res = await chatCompletion({ url, token }, {
    messages: [{ role: 'user', content: question }],
    max_tokens: Number(flag('max-tokens', 512)),
    stream: true,
  }).catch((err) => die(err.message));

  let usage = null;
  for await (const chunk of streamChunks(res)) {
    if (chunk.error) die(`\n${chunk.error.message}`);
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
    if (chunk.usage) usage = { ...chunk.usage, ...chunk.bonsai_swarm };
  }
  process.stdout.write('\n');
  if (usage) {
    console.error(`\n[${usage.completion_tokens} tokens, ${usage.coins_charged ?? '?'} coins`
      + `${usage.decode_tps ? `, ${usage.decode_tps} tok/s` : ''}]`);
  }
}
