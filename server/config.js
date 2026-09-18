// All tunable constants live here. Everything can be overridden with env vars so the
// AI Coins economy can be retuned without a code change (the /coins page reads these).
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`env ${name} is not a number: ${raw}`);
  return v;
};
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

/**
 * One upstream for the free fallback model (see server/fallback.js): a plain
 * OpenAI-compatible endpoint. Endpoints and keys only ever come from the environment,
 * so neither is in this repository.
 */
export function normalizeUpstream(entry, index = 0) {
  if (!entry || typeof entry !== 'object') throw new Error('each fallback upstream must be an object');
  const baseUrl = String(entry.baseUrl ?? entry.base_url ?? '').trim().replace(/\/+$/, '');
  const model = String(entry.model ?? '').trim();
  if (!baseUrl) throw new Error(`fallback upstream #${index + 1} has no baseUrl`);
  if (!model) throw new Error(`fallback upstream #${index + 1} has no model`);
  return {
    // What a visitor is told produced the answer; defaults to the bare model id.
    label: String(entry.label ?? '').trim() || model.split('/').pop(),
    baseUrl,
    model,
    // `apiKeyEnv` names another environment variable to read the key from, so the
    // structural configuration can be edited without a key ever being written into it.
    apiKey: String(
      entry.apiKeyEnv || entry.api_key_env
        ? (process.env[String(entry.apiKeyEnv ?? entry.api_key_env)] ?? '')
        : (entry.apiKey ?? entry.api_key ?? ''),
    ).trim(),
    // Most free models worth having are reasoning models, and a reasoning model on a
    // small token budget spends all of it thinking and returns an empty answer. Where
    // the server understands the hint, ask for thinking to be switched off.
    noThinking: entry.noThinking ?? entry.no_thinking ?? true,
    headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
  };
}

/** `FALLBACK_UPSTREAMS` (a JSON array), or the single-upstream `FALLBACK_*` variables. */
export function parseUpstreams(env = process.env) {
  const raw = String(env.FALLBACK_UPSTREAMS || '').trim();
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      throw new Error(`FALLBACK_UPSTREAMS is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error('FALLBACK_UPSTREAMS must be a JSON array');
    return parsed.map(normalizeUpstream);
  }
  if (env.FALLBACK_BASE_URL && env.FALLBACK_MODEL) {
    return [normalizeUpstream({
      label: env.FALLBACK_LABEL,
      baseUrl: env.FALLBACK_BASE_URL,
      model: env.FALLBACK_MODEL,
      apiKey: env.FALLBACK_API_KEY,
      noThinking: env.FALLBACK_NO_THINKING !== '0',
    })];
  }
  return [];
}

const fallbackUpstreams = parseUpstreams();

export const config = {
  port: num('PORT', 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  trustProxy: bool('TRUST_PROXY', true),

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() { return Boolean(this.clientId && this.clientSecret); },
  },

  // Test mode: lets automated tests attach a deterministic fake provider and admit a
  // slow GPU. Never available to normal users - it needs this shared secret.
  testModeKey: process.env.TEST_MODE_KEY || '',

  coins: {
    welcome: num('COINS_WELCOME', 1000),
    providePerMinute: num('COINS_PROVIDE_PER_MINUTE', 2),
    servePerToken: num('COINS_SERVE_PER_TOKEN', 0.5),
    consumePromptPerToken: num('COINS_CONSUME_PROMPT_PER_TOKEN', 0.1),
    consumeCompletionPerToken: num('COINS_CONSUME_COMPLETION_PER_TOKEN', 0.5),
  },

  model: {
    id: process.env.MODEL_ID || 'prism-ml/Ternary-Bonsai-2-27B-gguf',
    file: process.env.MODEL_FILE || 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    downloadBytes: num('MODEL_DOWNLOAD_BYTES', 5946648928),
    maxLength: num('MODEL_MAX_LENGTH', 4096),
  },

  provider: {
    // Admission: measured decode speed must reach this, otherwise the browser may chat
    // but never serves strangers.
    minDecodeTps: num('PROVIDER_MIN_DECODE_TPS', 10),
    benchmarkTokens: num('PROVIDER_BENCHMARK_TOKENS', 24),
    heartbeatMs: num('PROVIDER_HEARTBEAT_MS', 20000),
    // A provider that has not been heard from for this long is dropped.
    staleMs: num('PROVIDER_STALE_MS', 75000),
    // A browser reports its own benchmark result, so the number is capped at something
    // physically plausible and is only ever a tie-breaker - never a licence to take
    // every job. See coordinator.pickProvider().
    maxClaimedTps: num('PROVIDER_MAX_CLAIMED_TPS', 120),
    // A single streamed delta is one token. Real tokens are short; anything longer is
    // a provider trying to bill a paragraph as one token.
    maxDeltaChars: num('PROVIDER_MAX_DELTA_CHARS', 48),
    // How many browsers one account may have connected at once.
    maxSessionsPerUser: num('PROVIDER_MAX_SESSIONS_PER_USER', 3),
    // Server-measured throughput below this, twice in a row, drops the admission.
    demoteAfterSlowJobs: num('PROVIDER_DEMOTE_AFTER_SLOW_JOBS', 2),
  },

  jobs: {
    maxNewTokens: num('JOB_MAX_NEW_TOKENS', 1024),
    defaultMaxNewTokens: num('JOB_DEFAULT_MAX_NEW_TOKENS', 512),
    maxPromptChars: num('JOB_MAX_PROMPT_CHARS', 24000),
    queueTimeoutMs: num('JOB_QUEUE_TIMEOUT_MS', 120000),
    firstTokenTimeoutMs: num('JOB_FIRST_TOKEN_TIMEOUT_MS', 120000),
    idleTimeoutMs: num('JOB_IDLE_TIMEOUT_MS', 60000),
    maxAttempts: num('JOB_MAX_ATTEMPTS', 3),
    maxConcurrentPerUser: num('JOB_MAX_CONCURRENT_PER_USER', 2),
  },

  limits: {
    // requests per window, per IP
    loginPerHour: num('RATE_LOGIN_PER_HOUR', 20),
    signupPerDay: num('RATE_SIGNUP_PER_DAY', 10),
    chatPerMinute: num('RATE_CHAT_PER_MINUTE', 20),
  },

  // The free fallback model that answers when the swarm cannot - see server/fallback.js.
  fallback: {
    // Off automatically when no upstream is configured; FALLBACK_ENABLED=0 turns it off
    // even when one is, for a purely peer-to-peer deployment.
    enabled: bool('FALLBACK_ENABLED', true) && fallbackUpstreams.length > 0,
    upstreams: fallbackUpstreams,
    // How long a job waits for a volunteer before the fallback takes it. When there is
    // no admitted GPU in the network at all, the fallback starts straight away.
    queueWaitMs: num('FALLBACK_QUEUE_WAIT_MS', 20000),
    maxNewTokens: num('FALLBACK_MAX_NEW_TOKENS', 512),
    // A fallback answer costs a flat, reduced amount: no volunteer did the work, so
    // nobody is paid for it and there is nothing to meter per token.
    coinsFlat: num('COINS_FALLBACK_FLAT', 5),
    perAccountPerHour: num('FALLBACK_PER_ACCOUNT_PER_HOUR', 20),
    perIpPerHour: num('FALLBACK_PER_IP_PER_HOUR', 30),
    globalPerDay: num('FALLBACK_GLOBAL_PER_DAY', 500),
    timeoutMs: num('FALLBACK_TIMEOUT_MS', 90000),
    firstTokenMs: num('FALLBACK_FIRST_TOKEN_MS', 30000),
  },

  runtime: {
    // The Hugging Face space we lift the WebGPU runtime from at request time.
    // The space declares no licence, so its code is not vendored into this repo -
    // the server fetches it and serves the library part from our own origin.
    spaceUrl: process.env.BONSAI_SPACE_URL
      || 'https://webml-community-ternary-bonsai-2-webgpu-kernels.static.hf.space/index.html',
    cacheDir: process.env.RUNTIME_CACHE_DIR || '/tmp/bonsai-runtime-cache',
    refreshMs: num('RUNTIME_REFRESH_MS', 6 * 60 * 60 * 1000),
    // Optional supply-chain pin. The space is somebody else's repository: if it ever
    // changed, that code would run in every volunteer's browser on our own origin.
    // Set RUNTIME_SHA256 to the sha reported by /api/stats to freeze it; a changed
    // upstream is then refused and the last good copy on disk keeps serving.
    pinnedSha: (process.env.RUNTIME_SHA256 || '').trim().toLowerCase(),
  },
};

export function requireSecrets() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (>=32 chars)');
  if (missing.length) throw new Error(`missing configuration: ${missing.join(', ')}`);
}
