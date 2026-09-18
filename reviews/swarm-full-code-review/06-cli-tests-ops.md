STATUS: ISSUES

SUMMARY: The shipping CLI’s happy path does exchange the API token for a 60-second hand-off code and the local gateway defaults to 127.0.0.1, and Docker is not running as root and does have a Postgres-touching HEALTHCHECK. Several documented security controls do not hold, and the tests that are supposed to keep them fixed often assert a weaker invariant. `?provider=mock` in the volunteer page runs a fake GPU in any visitor’s browser and is admitted at 42 tok/s without `TEST_MODE_KEY`; the unit test only checks that the `isMock` flag is false. The local gateway has no auth of its own, `serve` always prints “localhost only” even when `--host` is not loopback, and `litellm` is spawned without `--host 127.0.0.1` (LiteLLM’s default is 0.0.0.0) with `master_key: local`. Switching CLI accounts reuses a persistent Chrome profile, so a refused hand-off still autostarts sharing as the previous session. End-to-end tests are written to attach that same mock GPU to a live deployment. Dialect translations drop or leak `<think>` inconsistently, and SECURITY.md’s hand-off expiry / already-signed-in / “token never in a URL” claims are untested or contradicted by comments and README.

FINDINGS:

1. **HIGH** `public/js/share.js:10` / `public/js/share.js:102` / `public/js/share.js:325` / `server/index.js:134` / `tests/unit/network.test.js:253`
   - **Claim:** README says `TEST_MODE_KEY` is required for the mock provider and “a normal visitor can reach neither”; the unit test is titled “the mock provider needs the shared test key; a normal account cannot fake one”.
   - **Evidence:** `MOCK` is `params.get('provider') === 'mock'` with no key check. `start()` uses `mockWorker()` whenever `MOCK` is set. `mockWorker()` reports `decodeTps: 42` and streams `'mock' / ' tN'`. Server-side `isMock` is `testMode && mock=1`, but admission is `tps >= minDecodeTps || adminOverride` (`server/coordinator.js:178`). The unit test connects `MockProvider` with `testKey: 'wrong-key'`, then only asserts `provider.isMock === false` and `adminOverride === false` — it never asserts the faker was rejected or not admitted. Default mock tps is 42, so that connection is a fully admitted volunteer.
   - **Impact:** Anyone can open `/share.html?provider=mock`, click Start, get admitted without a GPU, earn provide-minutes and serve-tokens, and answer real users with `"mock t1 t2…"`. The test suite will stay green. This is a broken control, not the accepted “volunteer can return garbage” risk: garbage still assumed a real browser running the model; this is a first-party, one-click fake GPU.
   - **Fix:** Gate `mockWorker()` on a successful test-mode handshake (or remove the in-page mock entirely). Reject `mock=1` upgrades without the key. Change the unit test to assert `admitted === false` (or the socket is dropped) without the key, and that `pickProvider` never selects `isMock` when serving real users if you keep mocks at all.

2. **HIGH** `client/bin/cli.js:160` / `client/bin/cli.js:173` / `client/bin/cli.js:185` / `client/bin/cli.js:204` / `client/src/serve.js:23`
   - **Claim:** The local gateway “binds to 127.0.0.1 by default, so nothing outside this machine can spend your AI Coins”; `serve` always prints “This listens on localhost only.”
   - **Evidence:** `createLocalServer` has no caller authentication — `client/test/gateway.test.js:90` even locks that in (“never asks the caller for one”). `serve()` takes `--host` (`cli.js:141`) and still prints the localhost-only line (`cli.js:155`) for any host. `litellm()` binds the inner gateway to 127.0.0.1 but spawns `litellm --config … --port` with no `--host`, writes `master_key: local` and `api_key: local`. LiteLLM’s proxy default host is `0.0.0.0`.
   - **Impact:** On a GPU box, laptop on public Wi-Fi, or rented instance, `bonsai-swarm litellm` (and `serve --host 0.0.0.0`) is an unauthenticated OpenAI proxy that spends the operator’s AI Coins. The log line actively misleads.
   - **Fix:** Pass `--host 127.0.0.1` to LiteLLM; refuse or warn loudly on non-loopback `--host`; print the real bind address; consider a local shared secret even on loopback.

3. **HIGH** `client/src/provide.js:119` / `client/src/provide.js:105` / `public/js/share.js:39` / `server/routes/auth-routes.js:110`
   - **Claim:** SECURITY.md: the hand-off “refuses a browser already signed in as somebody else.”
   - **Evidence:** `launchBrowser` reuses `configDir()/browser-profile` forever. `buildArgs` always sets `autostart=1`. `share.js` on `already_signed_in` only `alert`s, then continues into `mountChrome()` / `requireSignIn()` / `if (AUTOSTART) start(cfg)`. The 409 leaves the existing session cookie in place.
   - **Impact:** `bonsai-swarm login` as account B after a previous `provide` as account A still opens Chrome, fails the hand-off, and autostarts sharing as A. Coins and jobs attach to the wrong account. Same-machine account switch is enough; no extra exploit.
   - **Fix:** On 409, do not autostart; or sign the profile out before applying a new code; or isolate profiles per user id. Fail the CLI if hand-off did not establish the expected session.

4. **HIGH** `tests/e2e/swarm.spec.js:3` / `tests/e2e/swarm.spec.js:62` / `tests/e2e/swarm.spec.js:111` / `server/coordinator.js:381`
   - **Claim:** Mock providers are “for automated tests only” and unreachable for normal users; e2e is documented to run against `https://bonsai-swarm.app.mintapis.com`.
   - **Evidence:** `pickProvider` does not skip `p.isMock`. E2E constructs `MockProvider({ url: BASE, … })` and `share.html?provider=mock&testKey=…` against `BSW_BASE_URL`. With `TEST_MODE_KEY` set on the live server (required for those tests not to `skip`), the mock is a real ready provider and will be randomly assigned to whoever is in the queue — including organic users.
   - **Impact:** Running the documented Playwright suite against production injects a garbage GPU into the live swarm, charges real consumers, and credits the test account. `TEST_MODE_KEY` is a production privilege key, not a test-only sandbox, and SECURITY.md never mentions it.
   - **Fix:** Exclude `isMock` from `pickProvider` unless the consumer is also in test mode; or run e2e only against an isolated staging database. Treat `TEST_MODE_KEY` as a secret in SECURITY.md. Do not put it in query strings (`share.js:186`, `login.html?testKey=`, `index.js:134`).

5. **MEDIUM** `client/src/provide.js:106` / `client/src/provide.js:114` / `client/README.md:54` / `server/routes/auth-routes.js:90` / `SECURITY.md:38`
   - **Claim:** “The CLI never puts an API token in a URL”; it exchanges it for a single-use 60-second code so the token never appears in history or the process list.
   - **Evidence:** `launchBrowser` does call `handoffCode` first. `buildArgs` still falls back to `#token=…` when `code` is missing, and the comment says “The token travels in the fragment”. Chrome argv includes that fragment (`/proc/…/cmdline`, Activity Monitor). `share.js` and `POST /api/auth/token-session` still accept a long-lived token in the fragment/body “for older clients”. `client/README.md` documents the token-in-fragment behaviour, contradicting SECURITY.md. There is no test that `buildArgs` / `launchBrowser` omit the token.
   - **Impact:** A regression, a caller of `buildArgs` without `code`, or anyone following the client README puts `bsw_…` in the process list and browser history. `login --token` (`cli.js:71`) also puts the token in argv and shell history.
   - **Fix:** Delete the `#token=` fallback; reject token-session bodies that carry a raw API token (or keep it only behind an explicit, tested compatibility flag); fix the README; add a unit test that spawned Chrome args contain `code=` and never `token=bsw_`.

6. **MEDIUM** `tests/unit/network.test.js:342`
   - **Claim:** Test name: “a hand-off code works once and only for a minute.” SECURITY.md: 60-second single-use codes; refuse a browser already signed in as somebody else.
   - **Evidence:** The test checks reuse → 401. It never waits past 60s, never freezes time, never hits `already_signed_in`. Expiry is implemented (`server/auth.js:58` / `:67`) and the 409 is implemented (`auth-routes.js:110`) but untested.
   - **Impact:** False confidence. A broken expiry or a missing already-signed-in check would not fail CI.
   - **Fix:** Assert expiry (fake timers or injected clock) and a 409 when `req.user.id !== handoff user`.

7. **MEDIUM** `client/src/serve.js:164` / `client/src/serve.js:179` / `client/src/serve.js:250` / `client/src/serve.js:292` / `client/test/gateway.test.js:136`
   - **Claim:** The gateway “speaks three dialects” on top of one upstream.
   - **Evidence:** Non-stream Responses and Anthropic run `splitThinking` and return stripped `output_text` / `type: thinking`. Stream Responses emit every delta including `<think>…` then the `response.completed` payload has stripped `output_text` (`gateway.test.js:144` vs `:145` encodes the split). Stream Anthropic never splits; all tokens including think tags go out as `text_delta`. Stream OpenAI chat does not special-case `chunk.error` (Responses/Anthropic do). `modelNameFor` echoes an arbitrary `body.model` if it is not an alias (`serve.js:315`). Client abort is not forwarded (`serve.js` has no `req.on('close')`); upstream keeps running and spending coins. `streamChunks` only splits on `\n\n`, not `\r\n\r\n`.
   - **Impact:** Tools that concatenate Responses/Anthropic stream deltas show chain-of-thought tags that the final object hides. A dropped local client still bills the user. Impersonating `gpt-4` in the `model` field is reflected back.
   - **Fix:** Split (or suppress) thinking on the streaming paths the same way as non-stream; cancel upstream on `close`; do not echo unknown model ids; add tests for error chunks, abort, and CRLF SSE.

8. **MEDIUM** `tests/helpers.js:14` / `tests/helpers.js:16` / `tests/helpers.js:52`
   - **Claim:** Unit tests use `TEST_DATABASE_URL` / a dedicated test database; `TEST_MODE_KEY` is only for tests.
   - **Evidence:** Helpers load `.env`, then `DATABASE_URL = TEST_DATABASE_URL || DATABASE_URL`. If `TEST_DATABASE_URL` is unset, `resetDb()` `TRUNCATE`s whatever `DATABASE_URL` points at — including a production URL sitting in `.env`. `TEST_MODE_KEY ||= 'test-mode-key'` is test-process only (does not change a running prod server), but it hides misconfiguration: tests always see a key even when production would have none.
   - **Impact:** One `npm test` against a filled production `.env` wipes users, ledger, jobs, tokens.
   - **Fix:** Refuse to start if `TEST_DATABASE_URL` is missing or equals `DATABASE_URL`; require an explicit `BSW_ALLOW_TEST_DB=1`. Do not default `TEST_MODE_KEY` without documenting it.

9. **MEDIUM** `Dockerfile:2` / `Dockerfile:13` / `server/index.js:165`
   - **Claim:** One container plus Postgres; HEALTHCHECK is “bounded, cheap, and it touches Postgres”.
   - **Evidence:** HEALTHCHECK is present and hits `/api/health` (`server/routes/api.js:71`), which does `SELECT 1` — good. Image runs as `USER node` — good. No secrets copied — good. Base is floating `node:22-alpine` (no digest). `COPY scripts ./scripts` puts `webgpu-probe.mjs` / demo recorders in the production image (they import Playwright, which is not in prod deps, so they are dead but widen the tree). Coordinator `listen(config.port)` binds all interfaces (expected in a container, worth noting next to the CLI bind story). `/api/health` on failure returns `err.message` (`api.js:77`), which can leak libpq DSN details to anyone who can hit the port.
   - **Impact:** Supply-chain drift on `node:22-alpine`; noisy health errors; extra attack surface from unused scripts.
   - **Fix:** Pin `node:22-alpine@sha256:…`; drop `scripts/` from the image; return a generic 503 body.

10. **MEDIUM** `client/src/provide.js:125` / `client/src/provide.js:77` / `LAPTOP-TEST.md:67`
    - **Claim:** Chrome is started only with the throttling flags needed to keep a background tab alive; `provide --override` is the laptop functional test.
    - **Evidence:** Root on Linux adds `--no-sandbox` and `--disable-dev-shm-usage`. Linux also gets `--enable-unsafe-webgpu` and `--ignore-gpu-blocklist`. `--override` only sets `?override=1`; server override still needs admin or `TEST_MODE_KEY` (`index.js:137`). The CLI never passes `testKey`, so `npx bonsai-swarm-client provide --override` on a normal account does nothing. LAPTOP-TEST.md does not say that.
    - **Impact:** Sandbox-off Chrome as root on a rented GPU box; documented override path that silently fails for non-admins.
    - **Fix:** Document the root flags as a real sandbox trade; pass override only with an explicit test key / admin confirmation; fix LAPTOP-TEST.md.

11. **LOW** `client/package.json:12` / `client/bin/cli.js:69` / `client/src/config.js:13`
    - **Claim:** Published package contains `bin`, `src`, `litellm.config.yaml`, README.
    - **Evidence:** There is no `client/litellm.config.yaml` in the tree (CLI generates one at runtime). `login` does not require HTTPS for `--url`. `configDir()` is created with default umask (file is `0o600`, directory may be `0o755`).
    - **Impact:** npm pack warning; token can be posted to `http://` if the user is phished via `--url`; directory listing of the config folder on a shared Unix box.
    - **Fix:** Drop the missing file from `"files"`; warn on non-HTTPS URLs; `mkdirSync(..., { mode: 0o700 })`.

12. **LOW** `tests/e2e/swarm.spec.js:53` / `playwright.config.js:8`
    - **Claim:** Playwright covers a live deployment.
    - **Evidence:** Three tests `test.skip(!TEST_KEY, …)`. CI without `BSW_TEST_KEY` is green with the actual swarm path skipped. Against a shared live site, `providersReady > 0` can be someone else’s GPU (`swarm.spec.js:72`). `workers: 1` and unique usernames reduce flakes; they do not isolate the live provider pool (see finding 4).
    - **Impact:** False confidence in CI; flaky or cross-talky runs on the public app.
    - **Fix:** Fail the suite if `TEST_KEY` is missing when a mock is required; point e2e at staging.

COVERAGE:
- `tests/unit/network.test.js` does cover the four previously reported coordinator bugs that SECURITY.md names: claimed tps clamp, long-delta = one token, minutes per account not per socket, fourth socket 429, no self-serve, no negative balance, clamped payout, unauthenticated WS 401, jobs table has no prompt columns.
- `tests/unit/auth.test.js` covers argon2id, rate-limited login, CSRF origin, hashed API tokens, logout-everywhere.
- `tests/unit/openai-api.test.js` covers bearer auth, stream `[DONE]`, 402, revoked tokens, cross-user isolation of ledger/tokens/jobs.
- `client/test/gateway.test.js` covers the three dialects against a fake coordinator, token forwarding, and 402 pass-through. It does not cover bind address, abort, hand-off, or token-in-URL.
- Docker: not root, HEALTHCHECK present and wired to a real `/api/health` that queries Postgres. Base image unpinned.
- CLI default bind is 127.0.0.1; token is not logged; config file is 0600.

GAPS: SECURITY.md claims with no test:
- “The CLI never puts an API token in a URL” / never in process list or history (no `provide.js` / `buildArgs` test; README and fallback still do the opposite).
- Hand-off expires in 60 seconds (test name claims it, body does not).
- Hand-off refuses a browser already signed in as somebody else (implemented, untested; CLI then autostarts anyway).
- Prompts are never stored **in logs** (only job table columns are checked; HTTP error logger could still print bodies).
- A provider never learns who asked, and a consumer never learns whose GPU answered beyond an anonymous label (no assertion on `job.start` payload identity fields or consumer-visible provider labels).
- `x-forwarded-for` is trusted only when `TRUST_PROXY=1` (default is actually `true` in `server/config.js:21`; no test).
- WebSocket 16 KB payload cap (`index.js:107`) — no test that a 17 KB frame is dropped.
- `RUNTIME_SHA256` pin / compromised HF space — no test.
- One frame is one token *and* the 16 KB cap together — delta truncation is tested; the WS cap is not.
- `TEST_MODE_KEY` as a production secret, mock exclusion from dispatch, and “normal visitors cannot reach mock/override” — tests assert the flag, not the user-visible behaviour (finding 1).
