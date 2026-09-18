STATUS: ISSUES

SUMMARY: The coordinator/runtime slice is a coherent untrusted-provider design: jobs are FIFO, one per ready socket, re-queued on a drop before the first token, tokens are counted from relayed frames, deltas are truncated, the WebSocket is payload-capped, self-serve is excluded, submits are serialised per account, and minutes are paid per account not per tab. Those core economy rules match the tests in `tests/unit/network.test.js`. Three ship-blocking holes remain. `RUNTIME_SHA256` is not enforced on the disk fallback, so the documented supply-chain pin fails in the exact “upstream changed / we pin the copy we reviewed” case. Admission demotion is undone by another self-reported `benchmark` frame, so the “we time the job and drop liars” control does not stick. `jobs.error` stores provider-chosen text, which breaks “prompts are never stored.” Dispatch is weighted by server-measured TPS, not uniform random. Several medium races (session-limit TOCTOU, unbounded runtime fetch, 0-token jobs never charged) should be fixed before calling the security model closed.

FINDINGS:

1. **high** — `server/runtime.js:64-86` — `RUNTIME_SHA256` is not enforced on the copy that is actually served when upstream fails the pin.
   Evidence: `loadRuntime` hashes the extracted library and throws if it does not match `config.runtime.pinnedSha` (`runtime.js:64-67`). The catch path then reads `/tmp/bonsai-runtime-cache/bonsai2-lib.js` (or `RUNTIME_CACHE_DIR`) and returns it with no pin check (`runtime.js:75-85`). Config claims the opposite: “a changed upstream is then refused and the last good copy on disk keeps serving” (`config.js:95-99`). Incident-response case: unpinned process caches compromised bytes, operator sets `RUNTIME_SHA256` to the reviewed digest, restart fetches the new upstream, pin throws, poisoned disk is served. `runtimeStatus()` still reports `pinned: true` (`runtime.js:21-25`).
   Why it matters: SECURITY.md presents the pin as the mitigation for a compromised Hugging Face space running in every volunteer origin. As written, the pin only gates a successful fetch, not the bytes volunteers execute.
   Suggested fix: after every disk read (and before publishing `cache`), require `sha === config.runtime.pinnedSha` when a pin is set; otherwise refuse with 502. Write the cache via temp file + rename.

2. **high** — `server/coordinator.js:171-196` vs `540-566` — Demotion is not sticky; a provider re-admits itself with another claimed benchmark.
   Evidence: After two slow jobs (`completionTokens >= 4` and measured TPS `< 0.6 * minDecodeTps`) the coordinator sets `admitted = false` and `state = 'rejected'` (`coordinator.js:547-552`). `handleBenchmark` then sets `admitted = (claimedTps >= minDecodeTps) || adminOverride` from the next `benchmark` frame (`coordinator.js:172-179, 194`) with no regard for `slowJobs` or `measuredTps`. The honest UI only re-sends benchmark on reconnect (`public/js/share.js:210-214`); a modified client can send `{type:'benchmark', decodeTps:120}` immediately after the demotion message. There is no test for demotion.
   Why it matters: SECURITY.md’s “the server then times every job and drops the admission of a provider whose real throughput does not hold up” and “the demotion rule limit[s] the blast radius” are not actually lasting controls. Self-measured admission was already untrusted; demotion was the intended backstop.
   Suggested fix: do not re-admit from a claimed number. Keep a per-socket (or per-user) strike that only decays on server-measured jobs above the bar, or require a new WebSocket plus a cooldown. Ignore `benchmark` once `slowJobs >= demoteAfterSlowJobs`.

3. **high** — `server/coordinator.js:140-141` and `581-587` — Provider-chosen text is persisted on `jobs.error`, so a volunteer can write the prompt into the database.
   Evidence: `job.error` takes `String(msg.message || 'provider error').slice(0, 300)` and `finishJob` inserts that string into `jobs.error` (`schema.sql:62`, `coordinator.js:581-587`). The job object still has `job.messages` in memory at that point. SECURITY.md: “Prompts are never stored. Jobs keep token counts, timings and status — no text, on either side, in the database or in the logs.” The unit test only asserts that no column *name* matches `/prompt_text|content|messages/` (`tests/unit/network.test.js:59-60`); it does not assert that `error` cannot hold prompt bytes.
   Why it matters: The volunteer already saw the prompt. The invariant is that *this* operator’s disk, backups, and `/api` do not. `jobs.error` is a 300-character exfil path into Postgres.
   Suggested fix: persist only a short allow-listed code (`provider_error`, `timeout`, `disconnected`). Never write `msg.message` or any slice of `job.messages`.

4. **medium** — `server/coordinator.js:381-399` — Dispatch is weighted by `measuredTps`, not uniform random among ready providers.
   Evidence: `weightOf` is `clamp(measuredTps / minDecodeTps, 0.5, 3)` when the server has timed the socket, else 1, then weighted `Math.random()` (`coordinator.js:391-398`). SECURITY.md: “a job goes to a *random* ready provider, so a liar’s share is 1/N.” `config.js:56-58` still calls the *claimed* benchmark “only ever a tie-breaker”; claimed TPS is not used in `pickProvider` at all. A client that dumps frames as fast as the 16 KB socket allows inflates `measuredTps` (`coordinator.js:541-546`) and then receives up to 3× the jobs of a 0.5-weight peer, times up to 3 sockets.
   Why it matters: The “cannot buy traffic by lying” story holds for the admission number, not for job share. Garbage is an accepted quality risk; using it as a ranking signal is not.
   Suggested fix: pick uniformly among ready candidates (`candidates[Math.floor(Math.random() * candidates.length)]`), or document a bounded measured-TPS bias and cap it well below 3×. Do not feed `measuredTps` from jobs with absurd inter-token times.

5. **medium** — `server/index.js:126-141` — `maxSessionsPerUser` is checked before `handleUpgrade` / `addProvider` with no lock (TOCTOU).
   Evidence: `providerViewFor(user.id).length` is read on the HTTP upgrade (`index.js:127-130`); `addProvider` inserts into the map only inside the upgrade callback (`index.js:139-144`, `coordinator.js:81`). Parallel handshakes can all see `length < 3` and all succeed. Minutes stay per-account (`coordinator.js:243-254`) so this does not multiply the idle reward; it *does* multiply concurrent `serve_tokens` jobs (one job per socket, `coordinator.js:384, 417-418`). The test opens sockets sequentially (`tests/unit/network.test.js:308-315`).
   Why it matters: The documented “at most three provider sockets per account” cap is the main brake on one account eating the queue.
   Suggested fix: count + insert under a per-user lock (the existing `withUserLock`, or an atomic `providers` mutation) and re-check immediately before `this.providers.set`.

6. **medium** — `server/runtime.js:59-62` — Upstream fetch has no timeout and no body-size cap.
   Evidence: `fetch(config.runtime.spaceUrl)` then `res.text()` with no `AbortSignal` and no `Content-Length` / byte limit. Pinning happens only after extract (`runtime.js:62-67`). A hung or multi-GB HF response stalls every `/runtime/bonsai2-lib.js` request (and the boot warmup in `index.js:163-164`) and can OOM the process. That is the same third party the pin is meant to distrust.
   Why it matters: Availability of the volunteer origin, and the pin never runs if the process dies first.
   Suggested fix: `AbortSignal.timeout(10_000)` and a max read of a few MB before `extractLibrary`.

7. **medium** — `server/coordinator.js:568-572` — Prompt tokens (and prefill work) are free unless at least one completion frame was relayed.
   Evidence: `billable = completionTokens > 0`; `cost` and `earned` are 0 otherwise. Cancel (`index.js` SSE `res.on('close')` → `cancel`, `coordinator.js:511-518`), `job.done` with no deltas, first-token timeout, and queue expiry all take this path. `reservedFor` is in-memory only and is released when the job is deleted (`coordinator.js:362-369, 529`). `maxConcurrentPerUser` is 2 (`config.js:77`) and chat is 20 req/min, so one account can occupy GPUs for `firstTokenTimeoutMs` (120 s default) in a loop without a debit.
   Why it matters: The advertised prompt price is supposed to pay for prefill. As written it only applies if the volunteer emits one byte.
   Suggested fix: always debit `promptTokens * consumePromptPerToken` once a provider was assigned (or once the consumer cancels after assignment). Keep completion debit on relayed frames.

8. **medium** — `server/index.js:139-151` — `addProvider` failure leaves an authenticated WebSocket with no coordinator record or `close` handler.
   Evidence: `wss.handleUpgrade(..., async (ws) => { const provider = await coordinator.addProvider(...)` then registers `message`/`close`/`error`. `addProvider` awaits a DB insert (`coordinator.js:82-85`). If that throws, the callback rejects, the socket stays open, `removeProvider` will never run, and the session-limit TOCTOU (finding 5) is worse.
   Suggested fix: wrap the callback in try/catch, `ws.close()` on failure, register `close` before the await.

9. **medium** — `server/config.js:21` and `server/util.js:89-97` — `TRUST_PROXY` defaults to true, so a directly exposed Node process trusts client `X-Forwarded-For` / `X-Real-Ip`.
   Evidence: `trustProxy: bool('TRUST_PROXY', true)` and `createServer` sets Express `trust proxy` from it (`index.js:26`). `clientIp` uses the last XFF hop or raw `x-real-ip` whenever `trustProxy` is true (`util.js:89-97`). SECURITY.md says XFF is consulted “only when `TRUST_PROXY=1`”, which is the default, not an opt-in. Dockerfile exposes port 3000 with no sidecar (`Dockerfile:17-25`). Chat rate limits are per user id (out of this slice) so this mainly affects auth throttles that call `clientIp`.
   Why it matters: Classic last-hop footgun; SECURITY.md reads as if the operator must turn this on.
   Suggested fix: default `TRUST_PROXY` to false; only enable behind a proxy that *appends* the connecting hop.

10. **medium** — `server/coordinator.js:526-626` — Settlement is fire-and-forget: on DB failure the consumer already received the stream and nobody is billed.
    Evidence: `this.jobs.delete(jobId)` is synchronous at the top of `finishJob` (`coordinator.js:529`). Deltas were already pushed (`coordinator.js:494`). The `withTransaction` is in try/catch that only logs (`coordinator.js:624-626`), then `onDone`/`onError` still fire with `coinsCharged: 0`. No retry, no in-memory remainder.
    Why it matters: Not a mint (provider is also unpaid) but it is free inference whenever Postgres blips, and the job row may never exist.
    Suggested fix: keep the job in a `settling` map until commit; retry; do not ack `onDone` until the ledger write succeeds (or explicitly mark `unbilled`).

11. **low** — `server/coordinator.js:461-470` and `216-223` / `447-457` — `requeue` can push the same `jobId` twice.
    Evidence: `requeue` returns only if status is `done`/`failed`, not if already `queued` (`coordinator.js:462`). Idle-timer timeout and `removeProvider` can both requeue a 0-token job. `dispatch` de-dupes by skipping non-`queued` status and filtering all copies (`coordinator.js:403-408`), so this should not double-assign, but queue positions lie.
    Suggested fix: no-op `requeue` when `job.status === 'queued'` or when `this.queue.includes(job.id)`.

12. **low** — `server/coordinator.js:652-670` — Public `avgDecodeTps` / `capacityTps` sum the *claimed* `decodeTps`, which is the clamped self-report.
    Evidence: `if (p.admitted && p.decodeTps) { tpsSum += p.decodeTps; ...}` (`coordinator.js:660, 669-670`). A liar at the 120 cap (`config.js:59`, test at `network.test.js:268-274`) inflates `/api/stats`.
    Suggested fix: prefer `measuredTps`, or omit capacity until measured.

13. **low** — `server/coordinator.js:45-50` and `server/index.js:167-172` — `stop()` closes sockets then `providers.clear()` without finishing jobs; shutdown then `process.exit(0)`.
    Evidence: in-flight jobs are not settled; `removeProvider` no-ops if the map was already cleared before the `close` event. Process exit drops reservations, idle timers, and ledger writes.
    Suggested fix: iterate providers, `removeProvider` each, await in-flight `finishJob`, then exit.

14. **low** — `server/index.js:134-135` and `public/js/share.js:186` — Test-mode key is accepted from `?testKey=` (and the share page puts it in the URL).
    Evidence: `url.searchParams.get('testKey')` (`index.js:134`). Access logs, `Referer`, and browser history see the secret that unlocks mock providers and admission override.
    Suggested fix: header only (`x-test-mode-key`).

15. **low** — `server/util.js:61-68` — `RateLimiter` only sweeps when `hits.size > 10_000`; expired keys below that stay forever.
    Evidence: `if (this.hits.size > 10_000) this.sweep(now)` on insert (`util.js:66`). Chat/API limiters live for process lifetime.
    Suggested fix: sweep on a timer or on every `take`.

16. **nit** — `server/coordinator.js:33` — `tokensServedToday` is incremented (`coordinator.js:493`) and never read or reset.

17. **nit** — `server/runtime.js:38` — `extractLibrary` picks among `<script type="module">` blocks with `match.index > best.length`, comparing an offset to a previous slice length. Brittle; the 100 kB + `TernaryBonsai2` checks are the real filter.

18. **nit** — `server/coordinator.js:307-308` — `submitLocked` does not enforce `maxPromptChars` / roles; both HTTP doors go through `normalizeMessages` (`server/routes/api.js:16-37`, `openai.js:45`). Keep the check in the coordinator if anything else ever calls `submit`.

COVERAGE:
- Read end-to-end: `server/coordinator.js`, `server/runtime.js`, `server/index.js`, `server/config.js`, `server/util.js`.
- Cross-checked: `SECURITY.md`, `README.md` (relevant sections), `server/coins.js` (settlement helpers), `server/schema.sql` (`jobs` / `provider_sessions`), `server/routes/api.js` and `server/routes/openai.js` (the only `submit`/`cancel` callers, prompt cap), `tests/unit/network.test.js`, `tests/mock-provider.js`, `tests/helpers.js`. Skimmed `public/js/share.js` only to confirm how an honest client sends `benchmark` / `job.error`.
- Callers of exports: `Coordinator` constructed in `index.js` and used from `api.js` / `openai.js` (`submit`, `cancel`, `stats`, `providerViewFor`, `providers` for admin). `loadRuntime` / `mountRuntime` / `runtimeStatus` from `index.js` and `api.js`. `config` / `requireSecrets` from the whole server. `timingSafeEqual` from `index.js` (test key) and auth. `estimatePromptTokens` / `roundCoins` from coordinator. `clientIp` / `RateLimiter` from routes (this slice owns the implementation).
- Did not run the test suite (no product changes; several claims are obvious from source). Did not review auth, coins, or the WebGPU worker as primary artifacts.
- Tests that exist and actually cover the invariant: happy-path stream + balances; ledger audit; self-serve exclusion; slow GPU not admitted; admin override; one job per provider; re-queue on drop before first token; cancel charges delivered tokens; cannot cancel another user; insufficient coins; nearly-empty clamp; prompt length/roles at HTTP; unauthenticated WS 401; mock requires test key; claimed TPS cap; long-delta truncation + one frame = one token; minutes per account; 4th sequential socket 429; parallel submit does not go negative.
- Tests that do not cover a claimed invariant: demotion; re-benchmark after demote; `RUNTIME_SHA256` / disk fallback; uniform random dispatch; `jobs.error` contents; session-limit TOCTOU; 0-token cancel still charging the prompt; settlement failure.

INVARIANTS:

| Claim | Enforced? |
| --- | --- |
| One job per provider (`state === 'ready'` + `currentJobId`) | **Yes.** `pickProvider` requires `ready` (`coordinator.js:384`); assign sets `busy` + `currentJobId` (`417-418`); `setState` will not leave `busy` while a job is held (`149-154`). Nested `dispatch` from failed `send` does not double-assign. Test: `network.test.js:119-136`. |
| Re-queue on provider drop before first token; else fail and pay nothing for 0 tokens | **Yes.** `removeProvider` `206-207`; attempts capped by `jobs.maxAttempts`. Test: `network.test.js:138-159`. |
| Admission benchmark required; below `minDecodeTps` not given strangers’ jobs unless override | **Yes** on first benchmark (`171-196`, `384`). **No** as a lasting control — see finding 2. Slow-GPU test covers only the first claim. |
| Heartbeat / stale drop | **Yes.** App-level `ping` every `heartbeatMs` (`113-115`, `41`); any typed message refreshes `lastSeen` (`121`); `sweep` closes after `staleMs` (`216-223`). Honest client pongs (`share.js:216-218`). |
| Random, not ranked, dispatch | **No.** Weighted by server-measured TPS 0.5–3× (finding 4). Claimed TPS is not used for ranking (that half of the claim holds). |
| Completion tokens counted from relayed frames, not provider claims | **Yes.** `job.completionTokens += 1` per non-empty delta (`480-494`); `job.done` does not add tokens (`504-508`). Test: long-delta case expects 3 tokens not 1 paragraph. |
| Delta truncated to `maxDeltaChars` (default 48) | **Yes.** `487`. Test: `network.test.js:276-289`. |
| WebSocket `maxPayload` 16 KB | **Yes.** `index.js:107`. |
| Self-prompt exclusion (same `userId` never assigned) | **Yes.** `coordinator.js:385`. Test: `network.test.js:75-89`. Two *accounts* can still trade coins (net burn of prompt fees); not claimed otherwise. |
| Minutes paid per account, not per socket | **Yes.** Oldest eligible sibling wins; others rewind `creditedFrom` (`243-254`). `creditedFrom` is advanced synchronously before `await post`, so the interval vs `removeProvider` race does not double-pay. Test: `network.test.js:291-306`. |
| Payouts shrink if consumer debit is clamped; no mint | **Yes.** `settledShare = charged/cost`, `payout = earned * settledShare`, and `providerUserId !== consumerId` (`612-622`). Relies on `coins.post` SQL `balance + amount >= 0` (out of slice, read for this check). Parallel-submit test checks non-negative, not the shrink formula itself. |
| One account’s submits serialised; balance never negative | **Yes** for `submit` (`withUserLock` `286-305`, `303-305`). Finishes are not on that lock; over-accept is possible while a job is settling, then clamp (`596-606`) prevents a negative cached balance. Test: `network.test.js:317-340`. |
| Prompts never stored in DB or logs | **No.** `jobs.error` stores provider text (finding 3). Job INSERT otherwise has only counts/timings (`581-587`). Coordinator logs ids and `e.message` from exceptions, not `job.messages`. HTTP `normalizeMessages` is the prompt cap; coordinator keeps `messages` in RAM until GC after `finishJob`. |
| Provider never learns consumer identity; consumer never learns provider identity beyond a label | **Yes** in this slice. `job.start` sends `jobId`, `messages`, `maxNewTokens`, `enableThinking` only (`420-426`). `onAssigned` uses `gpuLabel \|\| 'a volunteer GPU'` (`429-434`). (Admin overview in `api.js` lists `displayName` — out of this slice.) |
| `RUNTIME_SHA256` freeze | **Partial.** Enforced only on a successful upstream extract, not on disk fallback or in-memory cache populated from disk (finding 1). Unpinned operation is the documented default. |
| CSP / same-origin runtime | **As documented.** `/runtime/bonsai2-lib.js` served same-origin (`runtime.js:92-106`). CSP in `index.js:54-65` includes `'unsafe-eval'` / `'unsafe-inline'` / `blob:` — accepted risk in SECURITY.md. `connect-src` also allows any `wss:`/`ws:`. |
| Config defaults (economy / timeouts / caps) | Sensible and env-overridable (`config.js`). Notable footguns: `TRUST_PROXY` default true (finding 9); `RUNTIME_SHA256` empty; `TEST_MODE_KEY` empty (mock/override off). `requireSecrets` demands `DATABASE_URL` and `SESSION_SECRET >= 32`. |
| Unauthenticated peer never gets a WebSocket | **Yes.** 401 before `handleUpgrade` (`index.js:118`). Test: `network.test.js:241-251`. Origin checked when present (`120-124`); missing Origin allowed (CLI). |
| Test/mock / override unreachable without shared secret | **Yes** for mock and for non-admin override (`index.js:134-137`, timing-safe compare). Admins can `?override=1` without the key. Mock sockets still earn `serve_tokens` / minutes if the key is set in production. |
| Garbage output | **Accepted**, and wider than advertised: `job.done` with 0 tokens is `status: 'done'`, not demoted (`540` requires `firstTokenAt` and `>= 4` tokens). |

STATUS is ISSUES because of findings 1–3 (high). Findings 4–10 would be enough to ship-block the security writeup even if the highs were downgraded.
