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

  runtime: {
    // The Hugging Face space we lift the WebGPU runtime from at request time.
    // The space declares no licence, so its code is not vendored into this repo -
    // the server fetches it and serves the library part from our own origin.
    spaceUrl: process.env.BONSAI_SPACE_URL
      || 'https://webml-community-ternary-bonsai-2-webgpu-kernels.static.hf.space/index.html',
    cacheDir: process.env.RUNTIME_CACHE_DIR || '/tmp/bonsai-runtime-cache',
    refreshMs: num('RUNTIME_REFRESH_MS', 6 * 60 * 60 * 1000),
  },
};

export function requireSecrets() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET (>=32 chars)');
  if (missing.length) throw new Error(`missing configuration: ${missing.join(', ')}`);
}
