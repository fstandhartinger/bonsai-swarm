-- bonsai-swarm schema. Applied on boot (idempotent).

CREATE TABLE IF NOT EXISTS users (
  id              bigserial PRIMARY KEY,
  username        text UNIQUE,                 -- NULL for google-only accounts
  username_lower  text UNIQUE,
  password_hash   text,                        -- argon2id, NULL for google-only accounts
  google_sub      text UNIQUE,
  display_name    text NOT NULL,
  is_admin        boolean NOT NULL DEFAULT false,
  disabled        boolean NOT NULL DEFAULT false,
  session_version integer NOT NULL DEFAULT 1,
  -- cached balance; the ledger is the source of truth (see v_ledger_balance)
  balance         numeric(20,6) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  prefix      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id);

-- Append-only AI Coins ledger. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS ledger (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,      -- welcome | provide_minutes | serve_tokens | consume_tokens | admin_adjust
  coins       numeric(20,6) NOT NULL,   -- positive = credit, negative = debit
  job_id      text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ledger_created_idx ON ledger(created_at DESC);

CREATE OR REPLACE VIEW v_ledger_balance AS
  SELECT u.id AS user_id, COALESCE(SUM(l.coins), 0)::numeric(20,6) AS balance
  FROM users u LEFT JOIN ledger l ON l.user_id = u.id
  GROUP BY u.id;

-- One row per finished inference job. Prompts and answers are NEVER stored.
CREATE TABLE IF NOT EXISTS jobs (
  id                text PRIMARY KEY,
  consumer_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  provider_user_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  status            text NOT NULL,      -- done | cancelled | failed | expired
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  decode_tps        numeric(10,3),
  wait_ms           integer,
  duration_ms       integer,
  attempts          integer NOT NULL DEFAULT 1,
  is_mock           boolean NOT NULL DEFAULT false,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_consumer_idx ON jobs(consumer_id, created_at DESC);

-- One row per provider browser session.
CREATE TABLE IF NOT EXISTS provider_sessions (
  id               text PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  disconnected_at  timestamptz,
  admitted         boolean NOT NULL DEFAULT false,
  decode_tps       numeric(10,3),
  ttft_ms          integer,
  gpu_label        text,
  is_mock          boolean NOT NULL DEFAULT false,
  minutes_credited integer NOT NULL DEFAULT 0,
  tokens_served    bigint NOT NULL DEFAULT 0,
  jobs_served      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS provider_sessions_user_idx ON provider_sessions(user_id, connected_at DESC);

-- Simple login throttle, survives restarts.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_key_idx ON login_attempts(key, created_at DESC);

-- ---------------------------------------------------------------- gamification
-- Opt-in public leaderboard (display name only) and the timezone the provider's
-- browser reported, used for the "night owl" achievement and the streak calendar.
ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tz_offset_minutes integer NOT NULL DEFAULT 0;

-- Unlocked achievements. One row per user and badge, written once.
CREATE TABLE IF NOT EXISTS achievements (
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code)
);
CREATE INDEX IF NOT EXISTS achievements_user_idx ON achievements(user_id, unlocked_at DESC);

-- Lifetime earned AI Coins drive the level; the ledger stays the single source of truth.
CREATE OR REPLACE VIEW v_lifetime_earned AS
  SELECT user_id,
         COALESCE(SUM(coins) FILTER (WHERE kind IN ('provide_minutes','serve_tokens')), 0)::numeric(20,6) AS earned,
         COALESCE(-SUM(coins) FILTER (WHERE kind = 'consume_tokens'), 0)::numeric(20,6) AS spent
    FROM ledger GROUP BY user_id;
