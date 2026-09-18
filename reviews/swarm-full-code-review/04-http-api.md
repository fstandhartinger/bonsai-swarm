# API routes review (HTTP / SSE / OpenAI-compatible)

STATUS: ISSUES

SUMMARY: Authz on private routes is generally sound: cookie or Bearer via global `authMiddleware`, `requireAuth` on chat/completions/tokens/ledger/jobs/cancel/admin, admin gated separately, and job cancel/token delete are scoped to `req.user.id`. Consumer identity is not sent on `job.start`; prompts are not written to `jobs` or logs. Body size is capped at 1mb, prompt chars at `JOB_MAX_PROMPT_CHARS`, and SSE event payloads are `JSON.stringify`'d. Cost/balance is checked in `Coordinator.submit` under a per-account lock before dispatch. The slice still has several ship-blocking mediums: the web and OpenAI doors use separate rate-limit maps despite an explicit “one budget” comment; streaming OpenAI flushes HTTP 200 before `submit`, so `insufficient_coins` / `too_many_requests` become SSE error chunks instead of 402/429; `requireAuth` 401 is not OpenAI-shaped; disconnect abort is racy (`jobRef` / listener registered after `submit`); and non-coin coordinator errors are mapped to HTTP 503. No CORS is set (secure default for this same-origin + CLI design). `/api/stats` is intentionally public and does not leak prompts or identities.

FINDINGS:

1. severity: medium
   file:line: `server/routes/openai.js:8-10`, `server/routes/openai.js:39`, `server/routes/api.js:11`, `server/routes/api.js:185-187`
   claim: Chat and OpenAI completions do not share the advertised per-account rate budget.
   evidence: `openai.js` comments “Same budget as the web chat: one account, so many requests a minute, whichever door it comes through” but constructs a second `RateLimiter` (`apiLimiter`) keyed `api:${req.user.id}`, while `/api/chat/stream` uses `chatLimiter` keyed `chat:${req.user.id}`. Keys and instances are independent, so one account can send `chatPerMinute` on each door (default 20+20).
   impact: Documented abuse control is twice as loose as claimed. Combined with `maxConcurrentPerUser` (2) this is not unbounded, but it is a real bypass of the stated cap.
   fix: Share one `RateLimiter` (or one key prefix `chat:${userId}`) across both routers.

2. severity: medium
   file:line: `server/routes/openai.js:89-96`, `server/routes/openai.js:123-127`, `server/routes/openai.js:72-75`
   claim: Streaming `/api/v1/chat/completions` cannot return HTTP 402/429/503 for pre-dispatch failures; empty-balance streaming is an HTTP 200 SSE error. Non-stream maps every non-coin failure to 503.
   evidence: `streaming()` calls `res.flushHeaders()` then `coordinator.submit()`. On throw it writes `data: {"error":...}` and `data: [DONE]` with status already 200. Tests only assert 402 for non-stream (`tests/unit/openai-api.test.js:82-94`). Non-stream uses `code === 'insufficient_coins' ? 402 : 503`, so `too_many_requests` (coordinator concurrent cap) is 503 `server_error`, not 429. Rate-limit 429 is correctly returned only because it runs before the flush.
   impact: LiteLLM / OpenAI SDKs / `client/src/upstream.js` treat `res.ok` as success (`upstream.js:22-27`). Streaming callers with no coins see a 200 stream, not payment required. Concurrent-cap failures look like an outage.
   fix: Run `submit` (or an equivalent balance/concurrency check) before flushing SSE. Map `too_many_requests` to 429. For mid-stream failures, omit `[DONE]` or use a documented error-before-done convention and test it.

3. severity: medium
   file:line: `server/auth.js:211-213`, `server/routes/openai.js:38`, `server/routes/openai.js:14-15`
   claim: Unauthenticated OpenAI completions return the web `{error, message}` object, not the OpenAI `{error:{message,type,code}}` envelope.
   evidence: `POST /api/v1/chat/completions` uses generic `requireAuth`, which does `res.status(401).json({ error: 'not_signed_in', message: 'Please sign in first.' })`. `openaiError()` is only used after that middleware. `tests/unit/openai-api.test.js:28-33` checks status 401 only, not body shape. `client/src/upstream.js:26` reads `body?.error?.message`, which is undefined when `error` is the string `'not_signed_in'`.
   impact: Compatible clients that display `error.message` show a generic “Upstream returned 401” (or fail to parse). The endpoint is advertised as OpenAI-compatible.
   fix: A completions-specific 401 (or an `requireAuth` option) that calls `openaiError(res, 401, '...', 'invalid_request_error', 'invalid_api_key')`.

4. severity: medium
   file:line: `server/routes/openai.js:59-70`, `server/routes/openai.js:123-129`, `server/routes/api.js:201-217`
   claim: Client disconnect can fail to cancel the job, so the account is still charged.
   evidence: Non-stream registers `res.on('close')` immediately but only cancels if `jobRef` is set; `jobRef` is assigned in `submit().then(...)`, so a close during `submit` (including `withUserLock` wait) skips cancel. Streaming OpenAI and `/api/chat/stream` register `res.on('close')` only after `await submit()`. If the client is already gone, Node will not re-emit `close`, so `cancel` never runs. `/api/chat/stream` comment correctly avoids `req` ‘close’, but does not check `res.writableEnded` / `req.aborted` when attaching. `sseSink.write` no-ops after close; OpenAI `send()` does not (`res.write` on a destroyed socket). Network tests abort after a `queued` event (`tests/unit/network.test.js:87-88`), which is after the listener exists — the race is untested.
   impact: Hung-up clients can pay for a full `maxNewTokens` completion (default 512). OpenAI `res.write` after abort can throw into the provider-message path.
   fix: Register `close`/`aborted` before `submit`; cancel by id once submit returns; if already closed, cancel immediately. Guard `send`/`write` with `ended`/`writableEnded`.

5. severity: medium
   file:line: `server/routes/openai.js:48`, `server/routes/openai.js:25-36`, `server/routes/openai.js:66`
   claim: OpenAI dialect silently drops or remaps fields in ways that look like success.
   evidence: `Boolean(body.stream)` makes `stream: "false"` (string) true. `body.model` is ignored; tests pass `model: 'x'` (`openai-api.test.js:30, 56, 76`). `n`, `tools`, `tool_choice`, `stop`, `temperature`, `response_format`, image parts, and `user` are not rejected; image content-parts become `''` in `normalizeMessages` (`api.js:25-27`). Unknown model still bills the swarm model. Coordinator `too_many_requests` / unexpected `err.message` are returned as OpenAI `server_error` (and streamed as HTTP 200, finding 2).
   impact: Clients can believe they selected another model, enabled tools, or set `stream=false` while the swarm still runs. Not a privilege bypass, but unsafe/misleading mapping for a compatibility gateway.
   fix: Reject unknown models (or only advertised aliases). Treat `stream` as true only for boolean `true` / `'true'`. 400 on `tools`/`n>1`/non-text parts. Do not put raw `err.message` from `submit` into the public error body.

6. severity: low
   file:line: `server/index.js:28`, `server/index.js:49-67`, `server/routes/api.js:114-157`
   claim: Authenticated JSON GET responses have no `Cache-Control: private, no-store`.
   evidence: Global middleware sets CSP / nosniff / referrer / permissions-policy, not cache. SSE sets `cache-control: no-cache, no-transform` (`api.js:193-198`, `openai.js:90-95`). `express.static` uses `maxAge: '5m'`. `/api/me`, `/api/ledger`, `/api/tokens`, `/api/jobs`, `/api/gamification` are cache-default. No `Vary` / `private`.
   impact: A misconfigured reverse proxy could cache a user’s balance, token prefixes, or job list. Browsers usually skip this; shared caches are the risk.
   fix: Set `Cache-Control: private, no-store` on authenticated JSON (or all `/api/*` except `/stats` `/config` `/models`).

7. severity: low
   file:line: `server/routes/api.js:71-77`, `server/routes/openai.js:66-68`, `server/routes/api.js:211-213`
   claim: Failure paths can echo driver/`Error.message` to the caller.
   evidence: `/api/health` 503 body is `{ ok: false, error: err.message }` for `SELECT 1` failures. Chat SSE `onError` uses `error: err.message` plus `...(err.details || {})`. OpenAI non-stream `catch` forwards `err.message` as `error.message`. `insufficient_coins.details` is `{ balance, reserved, promptTokens }` (consumer’s own figures, not the prompt text).
   impact: DB connectivity errors can leak host/port or similar. Not prompt leakage. `/healthz` (`server/index.js:81`) is the safer liveness probe.
   fix: `/api/health` should return a stable `{ ok: false }` without `err.message`. Map unexpected submit errors to a generic string.

8. severity: low
   file:line: `server/auth.js:194-205`, `server/routes/openai.js:38`, `README.md:40-41`
   claim: Completions are documented as API-token-only but any signed-in session works.
   evidence: README/SECURITY: consumers post to `/api/v1/chat/completions` with an API token. `requireAuth` accepts `req.user` from cookie fallback when Bearer is missing/invalid. CSRF still applies to cookie POSTs (`auth.js:226-234`); SameSite=lax + Origin check makes CSRF unlikely. `GET /api/v1/models` is unauthenticated (normal).
   impact: Invariant is weaker than claimed; XSS on the origin can spend coins via completions as well as `/api/chat/stream` (same origin, same session). Not a new authz hole.
   fix: Require `req.authKind === 'token'` on `/api/v1/chat/completions` if that is the product rule.

9. severity: low
   file:line: `server/routes/api.js:168-170`, `server/gamification.js:182-207`
   claim: Public leaderboard comment says display name only, but the JSON includes stable `userId`.
   evidence: Route is unauthenticated. `leaderboard()` maps `userId: Number(r.id)` plus name, earned, tokens, jobs, level.
   impact: Opt-in users are correlatable across name changes. No prompts, usernames, or balances.
   fix: Drop `userId` or hash it if the comment is the policy.

10. severity: low
    file:line: `server/routes/api.js:47-65`, `server/routes/openai.js:97-100`
    claim: Long-lived SSE has no comment/ping keepalive.
    evidence: Queue timeout is 120s (`config.js:73`). Streams set `x-accel-buffering: no` but never write `: ping` / `event: ping`. Anthropic local gateway pings every 15s (`client/src/serve.js:284`); the coordinator origin does not.
    impact: Idle queue waits can be cut by proxies/load balancers, leaving jobs running until timeout (related to finding 4).
    fix: Heartbeat comments on both SSE dialects while queued/running.

COVERAGE:
- Read fully: `server/routes/api.js`, `server/routes/openai.js`.
- Mount/middleware: `server/index.js` `createServer` (`express.json` 1mb, security headers, `authMiddleware`, `csrfGuard`, `/api` + `/api/v1` mounts, 404, error handler). WebSocket `TEST_MODE_KEY` is not an HTTP route in this slice (`server/index.js:132-137`).
- Auth: `server/auth.js` `authMiddleware` / `requireAuth` / `csrfGuard` / `userFromApiToken`.
- Coordinator as called from routes: `submit` / `submitLocked` / `reservedFor` / `dispatch` `job.start` / `cancel` / `finishJob` insert / `stats` / `providerViewFor`.
- Tests: `tests/unit/openai-api.test.js` (models, 401, non-stream usage, SSE `[DONE]`, `max_tokens` length, 402, revoke, IDOR on ledger/tokens/jobs). `tests/unit/network.test.js` (SSE chat, cancel, cancel-IDOR, prompt length/roles, abort-after-queued). `tests/unit/auth.test.js` (anonymous 401, CSRF origin, admin 403).
- Client of the API (not a full CLI review): `client/src/upstream.js` Bearer to `/api/v1/chat/completions`; `client/src/serve.js` local dialect translation; `public/js/chat.js` POST `/api/chat/stream`.
- SECURITY.md consumer anonymity / no prompt storage checked against route + `job.start` + `jobs` INSERT.
- Not in this slice: auth-routes, WS provider protocol internals, coin ledger math beyond submit/finish as invoked from routes.

INVARIANTS:
- Consumer anonymity: HOLDS at the API/coordinator boundary. `job.start` sends `{ type, jobId, messages, maxNewTokens, enableThinking }` only (`server/coordinator.js:420-426`). `/api/jobs` returns `id, status, token counts, timings, as_consumer` and not `consumer_id` / `provider_user_id` (`server/routes/api.js:149-156`). `onAssigned` exposes `providerLabel` + `decodeTps`, matching SECURITY.md “anonymous label”. Leaderboard is opt-in aggregates, not chat identity.
- No prompt storage: HOLDS for durable state. Schema comment and `INSERT INTO jobs` persist ids, status, token counts, timings, optional error — not message text (`server/schema.sql:49-65`, `server/coordinator.js:581-587`). Route logs do not print `messages`. Prompts exist in memory on the job until `finishJob` deletes it, which is required to relay.
- API token required where claimed: PARTIAL. Completions require *some* `req.user` (token or session), not specifically a Bearer token. `/api/v1/models` is public. Web chat correctly requires session/token via `requireAuth`. Token revoke is tested and stops completions (`openai-api.test.js:96-105`).
- Cost/balance before dispatch: HOLDS. `submitLocked` reads balance, adds in-flight reservation, refuses `affordable <= 0` with `insufficient_coins`, caps `maxNewTokens` by balance (`server/coordinator.js:307-331`). Serialized with `withUserLock`.
- IDOR: HOLDS for this slice. Ledger/tokens/jobs queries bind `req.user.id`. Cancel returns false unless `byUserId === job.consumerId` (`coordinator.js:511-514`); tested. Token delete uses `id AND user_id`.
- TEST_MODE_KEY: no HTTP handlers in `api.js` / `openai.js`. Signup bypass and WS mock/override live elsewhere.
- CORS: none (`Access-Control-*` absent). Browser cross-origin JS cannot read the API; CLI/Bearer is unaffected. Secure default.
- Request size: `express.json({ limit: '1mb' })` plus `normalizeMessages` cumulative `maxPromptChars` (default 24000). Roles whitelist `system|user|assistant`.
- Injection: SSE/OpenAI frames are `JSON.stringify` of server-built objects; event names are literals. Message content is not interpolated into SQL (parameterized queries).
- `/api/stats` disclosure: public aggregates (provider counts, queue length, token totals, account count, coin rates, model id, runtime sha). Matches SECURITY.md (`RUNTIME_SHA256` from `/api/stats`) and the marketing dashboard. No prompts, no user rows, no job text. Acceptable; do not put per-user fields here.
