# Code review: AI Coins ledger, cache, gamification, schema

STATUS: ISSUES

SUMMARY: The ledger primitive in `server/coins.js` is sound: parameterized SQL, `roundCoins` to 6 dp, debit `UPDATE` guarded so the cache cannot go negative, and the ledger row is written in the same caller transaction. Welcome, minute credits, consume, serve, and admin adjust are the only production writes, and self-serve payout is blocked twice. The hole is not `post()` — it is that affordability is an in-memory reservation, not a hold. `reservedFor` drops already-generated but still-uncharged tokens, and `finishJob` deletes the job from that map *before* the debit awaits the pool, so a second request can pass the same balance check. The SQL guard then clamps; the consumer keeps the extra tokens and the second provider is underpaid. That violates the documented serialisation guarantee. Schema does not enforce `balance >= 0`, kind/sign, one welcome, or append-only. Gamification is not ledger-only. Streak history is capped at 2000 *timestamps*, so the 7-day badge cannot work for an active sharer. Tests lock several README rules but never assert that a clamped debit shrinks the provider credit, and they never fire the mid-job second submit.

FINDINGS:

1. severity: HIGH
   file:line: server/coordinator.js:363, server/coordinator.js:529, server/coordinator.js:580, server/coordinator.js:286
   claim: Parallel requests from one account can both pass the affordability check and over-commit the same coins. Reservation is released (and undercounted) before settlement debits.
   evidence: `submit` (`307:331:server/coordinator.js`) reads `users.balance` and subtracts `reservedFor`, which charges `costForJob(prompt, maxNewTokens - completionTokens)` (`367:367:server/coordinator.js`). Tokens already streamed are still uncharged — debit happens only in `finishJob`'s transaction (`589:606:server/coordinator.js`) — so reservation shrinks as the stream proceeds. Worse, `finishJob` does `this.jobs.delete(jobId)` at line 529, then later `await withTransaction(...)` at line 580 (`pool.connect` yields). After the delete, `reservedFor` is 0 and `maxConcurrentPerUser` no longer counts the job, while `users.balance` is still the pre-debit value. `withUserLock` (`286:305:server/coordinator.js`) wraps only `submit`, not settlement. `JOB_MAX_CONCURRENT_PER_USER` defaults to 2 (`77:77:server/config.js`). The parallel test (`317:340:tests/unit/network.test.js`) starts both streams together, so both submits see a full reservation; it never submits during or after the first job's last delta.
   impact: A client can start job A, wait until tokens are flowing (or until A is removed from `this.jobs`), then start job B against the same cached balance. Job B is authorised. Job A's later debit succeeds; job B hits `applied: false` and the clamp path (`595:605:server/coordinator.js`). Balance stays non-negative, but the consumer received tokens they did not pay for and provider B is paid a fraction (possibly 0). This is the double-spend the user lock was written to prevent (`281:284:server/coordinator.js`, SECURITY.md:31-32).
   fix: Treat in-flight liability as `costForJob(prompt, maxNewTokens)` until settlement commits. Do not `jobs.delete` until after the debit (or keep a `pendingDebit` map). Hold `withUserLock(consumerId)` across settlement, or `SELECT ... FOR UPDATE` the consumer at submit and insert a reservation row. Add a test: low balance, start a long job, submit the second request after N deltas / after `jobs.delete`, assert the second is refused *or* that combined `coinsCharged` never exceeds the starting balance and no provider is paid for uncharged tokens.

2. severity: MEDIUM
   file:line: server/coordinator.js:608
   claim: "Payouts come out of what was actually charged" is not mechanically enforced. The provider is paid `earned * charged/cost`, which exceeds `charged` whenever `servePerToken > consumeCompletionPerToken` (prompt fee not enough to cover the gap).
   evidence: `earned = earningsForJob(completionTokens)` (`572:572:server/coordinator.js`) uses `COINS_SERVE_PER_TOKEN` (default 0.5). `cost` uses prompt 0.1 + completion 0.5. `payout = roundCoins(earned * settledShare)` with `settledShare = charged/cost` (`612:613:server/coordinator.js`). There is no `min(payout, charged)`. At defaults, `earned < cost` so net is a sink. `config.js` exposes the two rates as independent env vars (`36:38:server/config.js`). No test compares host `serve_tokens` to consumer `consume_tokens` after a clamp (`215:228:tests/unit/network.test.js` only checks `completionTokens < 50` and `balance >= 0`).
   impact: Retuning serve above consume mints coins on every successful job, including unclamped ones. The clamp path scales a number that may already exceed the debit. SECURITY.md:29-30 is then false.
   fix: `payout = roundCoins(Math.min(earned, charged) * (cost > 0 ? charged/cost : 0))` or simply `min(earned * share, charged)`. Default-rate test: after a clamped job, `SUM(serve_tokens)` for the host ≤ `-SUM(consume_tokens)` for the consumer. Env-rate test with serve=1, consume completion=0.5.

3. severity: MEDIUM
   file:line: server/schema.sql:14, server/schema.sql:32, server/schema.sql:35
   claim: Economy invariants live only in JS. The database will store a negative cache, an unknown kind, a second welcome, a positive `consume_tokens`, or an in-place ledger edit.
   evidence: `users.balance numeric(20,6) NOT NULL DEFAULT 0` — no `CHECK (balance >= 0)` (`14:14:server/schema.sql`). `ledger.kind text NOT NULL` with a comment listing five values, no `CHECK` (`35:35:server/schema.sql`). No unique `(user_id) WHERE kind = 'welcome'`. No unique `(job_id, user_id, kind)` to make settlement idempotent. No `CHECK` that `consume_tokens` is negative and the credit kinds are positive. Append-only is a comment (`31:31:server/schema.sql`); there is no `REVOKE UPDATE, DELETE ON ledger`. `ON DELETE CASCADE` from `users` wipes the audit trail (`34:34:server/schema.sql`). `post()` is the only kind/sign gate (`16:16:server/coins.js`); tests and any future raw SQL bypass it (`203:203:tests/unit/network.test.js`). `admin_adjust` with `allowNegative: true` (`241:241:server/routes/api.js`) can write a negative cache that the debit guard then treats as "take nothing" (`597:598:server/coordinator.js` uses `Math.max(0, balance)`), so a negative account consumes for free.
   impact: A bug, admin mistake, or one-off SQL can desync cache vs ledger, mint via a second welcome, or double-pay a job if `finishJob` were ever invoked twice from two processes. JS `post()` is careful; the table is not.
   fix: `CHECK (balance >= 0)` (admin credits only; refuse negative adjusts). `CHECK (kind IN (...))`. Partial unique index on welcome. Unique `(job_id, user_id, kind)` where `job_id IS NOT NULL`. Sign checks per kind. `REVOKE UPDATE, DELETE` from the app role. Keep `allowNegative` off the default path.

4. severity: MEDIUM
   file:line: server/gamification.js:88, server/gamification.js:94, README.md:65
   claim: Levels/streaks/achievements/leaderboard are not "derived from the same ledger" with "no second set of numbers".
   evidence: README.md:65-67 and `public/coins.html:49` say badges come from ledger rows only. `statsFor` pulls `tokens_served` / `jobs_served` / consumed counts from `jobs` (`88:93:server/gamification.js`) and `best_tps` from `provider_sessions` (`94:94:server/gamification.js`). `ACHIEVEMENTS` `first_light`, `thousand`, `hundred_k`, `first_answer`, `speed_demon` test those fields (`42:51:server/gamification.js`). `leaderboard` joins `v_lifetime_earned` (ledger) with a `jobs` aggregate (`193:195:server/gamification.js`). A clamped payout writes full `completion_tokens` on `jobs` and a partial `serve_tokens` row — the two counters diverge by design (`581:621:server/coordinator.js`). `speed_demon` uses the *claimed* benchmark stored on the session (`180:182:server/coordinator.js`), which SECURITY.md:13 says is untrusted.
   impact: Cosmetic, not a mint, but the documented architecture is false. A liar gets Speed Demon without serving. Token badges unlock when the provider was paid nothing. Leaderboard rank by `earned` can disagree with `tokens_served`.
   fix: Drive token/job badges from `ledger.meta` on `serve_tokens` / `consume_tokens` (and `provide_minutes` for marathon/streaks, which already happens). Drive Speed Demon from server-measured `jobs.decode_tps`. Align README/coins.html. If `jobs` remains a source, say so.

5. severity: MEDIUM
   file:line: server/gamification.js:95
   claim: Seven-day streaks cannot be computed for anyone who actually shares.
   evidence: `SELECT DISTINCT created_at FROM ledger WHERE ... kind='provide_minutes' ORDER BY created_at DESC LIMIT 2000` (`95:95:server/gamification.js`). `creditOnlineMinutes` inserts about one row per elapsed minute (`256:267:server/coordinator.js`). 2000 timestamps ≈ 33 hours of continuous sharing, or ~4 days at 8 h/day. `streak_7` requires `s.streak >= 7` (`47:47:server/gamification.js`). `streakFrom` only sees that truncated set (`101:101:server/gamification.js`).
   impact: Week of Giving is effectively unreachable for the users it is aimed at; `bestStreak` is wrong. Not a coin bug; it is a broken advertised feature.
   fix: Aggregate distinct local days in SQL (`date_trunc` after applying `tz_offset_minutes`), `LIMIT` days not rows, or scan without a 2000-row cap for this query.

6. severity: MEDIUM
   file:line: server/gamification.js:199, server/routes/api.js:167, public/coins.html:50
   claim: Opt-in leaderboard is not "display name only".
   evidence: Comment at `183:184:server/gamification.js` and `public/coins.html:50` promise display name, level, earned coins, nothing else. The query returns `u.id`, `tokens_served`, `jobs_served` (`187:207:server/gamification.js`). `GET /leaderboard` is unauthenticated (`168:169:server/routes/api.js`). Opt-in default is false (`97:97:server/schema.sql`) and the write is cookie-CSRF-guarded (`172:175:server/routes/api.js`, `75:75:server/index.js`) — that part is fine.
   impact: Public, stable user ids plus production volume. Username and wallet balance are not exposed. Still wider than the privacy copy.
   fix: Drop `userId` from the public JSON (keep it server-side if needed). Drop token/job counts or document them. Match coins.html to the payload.

7. severity: MEDIUM
   file:line: server/schema.sql:66, server/gamification.js:88, server/gamification.js:194
   claim: `jobs.provider_user_id` is filtered and grouped with no supporting index.
   evidence: Indexes are `jobs_created_idx` and `jobs_consumer_idx` (`66:67:server/schema.sql`). `statsFor` and the leaderboard subquery both constrain/group on `provider_user_id` (`88:93:server/gamification.js`, `194:195:server/gamification.js`).
   impact: `GET /api/gamification` (on every profile poll) and `GET /leaderboard` sequential-scan `jobs` as volume grows. Not a correctness bug; it will show up as coordinator-adjacent latency.
   fix: `CREATE INDEX ... ON jobs (provider_user_id, created_at DESC)` and/or a partial index `WHERE completion_tokens > 0`.

8. severity: MEDIUM
   file:line: server/coordinator.js:624, server/coordinator.js:529
   claim: Settlement failure after the in-memory job is dropped delivers tokens for free and never retries.
   evidence: `this.jobs.delete(jobId)` is unconditional (`529:529:server/coordinator.js`). The `try` around `withTransaction` logs and swallows (`624:626:server/coordinator.js`). `onDone` still fires with `coinsCharged: 0` (`645:645:server/coordinator.js`). There is no unique `(job_id, kind)` to make a retry safe, and no outbox.
   impact: A transient PG error after the stream has finished = consumer unpaid, provider unpaid, no `jobs` row (rolled back), no way to replay. Opposite of minting; burns volunteer work and desyncs "what the user saw" from the ledger.
   fix: Persist the job (or a settlement outbox) before deleting from memory; retry; or fail the sink only after COMMIT.

9. severity: LOW
   file:line: server/coordinator.js:258, server/coins.js:49
   claim: Two smaller correctness nits: minute credits can be skipped after a failed post, and `auditBalance` compares IEEE floats.
   evidence: `creditedFrom` and `minutesCredited` are advanced *before* `await withTransaction` (`258:267:server/coordinator.js`). A thrown `post` loses those minutes forever (no mint). `auditBalance` uses `Number(cached) === Number(ledger)` (`53:53:server/coins.js`) after a global `numeric` → `Number` parser (`7:8:server/db.js`). Fine below 2^53 as commented; a 6dp ledger vs JS can still fail `===` on larger histories.
   impact: Lost minutes under errors; a false `ok: false` on `/api/admin/overview` if equality ever flakes.
   fix: Move `creditedFrom +=` to after successful `post`. Compare numeric text or integer micro-coins.

10. severity: LOW
    file:line: server/index.js:127, server/gamification.js:51, server/coordinator.js:11
    claim: Residual abuse that does not mint coins.
    evidence: Session cap is checked then `await addProvider` (`127:144:server/index.js`) — two concurrent upgrades can both see `mine < 3`. Minute pay is still per account (`246:254:server/coordinator.js`, tested at `291:306:tests/unit/network.test.js`). `speed_demon` trusts claimed tps (`51:51:server/gamification.js`). `isNightFor` and streaks use browser `tz` (`189:189:public/js/share.js`). `GET /leaderboard?limit=-1` becomes `LIMIT -1` (`186:198:server/gamification.js`); PG 14+ errors (500), it does not dump the table.
    impact: Extra sockets, fake badges, noisy 500. Not an economy break.
    fix: Increment the session count synchronously before the await; use measured tps; clamp `limit` to `[1, 100]`.

COVERAGE

Read end-to-end: `server/coins.js`, `server/gamification.js`, `server/db.js`, `server/schema.sql`. Related: `server/coordinator.js` (every `post` caller except auth/admin), `server/auth.js` welcome, `server/routes/api.js` admin + leaderboard, `server/config.js` rates, `server/util.js` `roundCoins`, `server/index.js` session cap + migrate-on-boot, `README.md`, `SECURITY.md`, `public/coins.html`, `tests/unit/network.test.js`, `tests/unit/auth.test.js` (welcome), `tests/unit/openai-api.test.js` (empty balance 402).

Every production ledger write:

| Site | Kind | Transaction |
| --- | --- | --- |
| `server/auth.js:106` `createUser` | `welcome` +cache | yes (`withTransaction`) |
| `server/coordinator.js:262` `creditOnlineMinutes` | `provide_minutes` +cache | yes |
| `server/coordinator.js:590` `finishJob` | `consume_tokens` −cost | yes, same txn as `jobs` insert |
| `server/coordinator.js:600` clamp branch | `consume_tokens` −avail | same txn, `FOR UPDATE` |
| `server/coordinator.js:615` | `serve_tokens` +payout | same txn, skipped if same user |
| `server/routes/api.js:239` admin | `admin_adjust` | `postOne` |

No other `INSERT INTO ledger` in `server/`. Tests insert `admin_adjust` raw and keep the cache in sync by hand.

Not locked by tests: mid-stream second submit (finding 1); provider credit ≤ consumer debit after clamp (finding 2); welcome uniqueness; `auditBalance` after minutes-only; streak/badge derivation; leaderboard privacy payload; schema CHECKs.

INVARIANTS:

| Rule | Source | Code | Tests |
| --- | --- | --- | --- |
| Signup +1000 | README table; `config.coins.welcome` | `auth.js:105-111` posts `welcome` in the user insert txn | `auth.test.js:10-17` balance 1000; e2e signup |
| Online admitted ready +2 / min | README; coins.html | `creditOnlineMinutes` requires admitted + ready/busy + fresh `lastSeen`; `creditedFrom` null while loading/paused/rejected | `network.test.js:291-306` three sockets ≤ one account's minutes |
| Minutes per account not per socket | SECURITY.md:27-28 | sibling with older `connectedAt` + `paidThisPass` (`250:255:server/coordinator.js`); max 3 sockets (`127:129:server/index.js`) | minutes test yes; 4th socket 429 yes; concurrent 4th-socket race untested |
| Serve +0.5 / token, counted by coordinator | README; SECURITY.md:14-15 | `handleDelta` increments here, truncates to `maxDeltaChars`; `earningsForJob` | long-delta = 1 token (`276:289`); chat test host +3.0 for 6 tokens |
| Prompt −0.1, answer −0.5 | README | `costForJob` | chat test `coinsCharged === 6*0.5 + prompt*0.1` |
| Balance never negative | README:57-58; SECURITY.md:32 | `post` `AND balance + $2 >= 0`; `affordableCompletionTokens`; clamp | refuse at 0 (`198:213`); clamp length (`215:228`); parallel `balance >= 0` (`317:339`). Schema does **not** CHECK. Admin can go negative. |
| Answers shortened or refused if poor | README:57-58 | submit cap via `affordableCompletionTokens`; refuse if 0 | both tests exist |
| Never serve own prompts / no self-mint | README:59; SECURITY.md:33 | `pickProvider` skip same `userId` (`385`); payout skip (`614`) | `network.test.js:75-89` stays queued |
| Loading earns nothing | README:60 | `creditedFrom` only on ready/busy (`156:161`) | not directly asserted (only the 3-tab ready case) |
| Drop before first token: pay nothing, requeue | README:61 | `removeProvider` requeue if `completionTokens === 0` (`206`); `billable` requires completion > 0 (`570`) | `network.test.js:138-159` flaky stays 1000 |
| Ledger append-only; `users.balance` is a cache; `auditBalance` re-derives | README:62-63 | `post` UPDATE+INSERT; view `v_ledger_balance`; no app UPDATE/DELETE on ledger | `network.test.js:63-73` and parallel test `audit.ok`. Append-only **not** enforced in SQL. |
| One account's requests serialised; two parallel requests cannot both pass the same check | SECURITY.md:31-32 | `withUserLock` on submit only; reservation in memory | parallel test at t=0 only. **Broken mid-job / pre-debit (finding 1).** |
| Payouts from what was charged; clamp shrinks provider by the same fraction | SECURITY.md:29-30 | `settledShare = charged/cost` (`612`) | **no test.** Not capped at `charged` (finding 2). True at default rates because serve ≤ completion consume. |
| Levels/streaks/achievements/leaderboard from the ledger only | README:65-67; coins.html:47-50 | earned/spent/minutes/night/streak from ledger; tokens/jobs/tps from `jobs` + `provider_sessions` | **no gamification unit tests.** Claim is false (finding 4). Streak window wrong (finding 5). |
| Opt-in leaderboard: display name only, never username/balance/prompts | SECURITY.md-adjacent; gamification.js:183-184 | `WHERE leaderboard_opt_in AND NOT disabled`; default false | untested. Payload includes `userId`, tokens, jobs (finding 6). |
| Schema apply idempotent | README:127 | `CREATE IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW`; `migrate()` runs the file (`37:39:server/db.js`) | boot path in tests. New columns on old `CREATE TABLE IF NOT EXISTS` tables still need `ALTER` (the two user columns do). |
| SQL injection | review item | all ledger/gamification queries use `$n`; `kind` allow-listed before bind; guard SQL is a constant | no finding |
| Rounding | review item | `roundCoins` = 1e6; PG `numeric(20,6)`; `affordableCompletionTokens` does **not** round the prompt subtraction | no failing case at default rates; FP mismatch possible if rates change |

WHAT HOLDS: `post()` + transaction callers, debit guard, self-serve skip, server-side token count, per-account minutes (single process), welcome in the signup txn, parameterized SQL, opt-in default off, idempotent schema apply for the current file, coordinator never stores prompt text.
