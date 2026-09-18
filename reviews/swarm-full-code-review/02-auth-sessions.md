# Auth / sessions / API tokens / CLI hand-off — code review

STATUS: ISSUES

SUMMARY: Cookie sessions and API tokens are mostly built the right way: HttpOnly + SameSite=Lax (Secure when PUBLIC_URL is https), HMAC-signed payloads with expiry and session_version, Argon2id at the OWASP minimum, API tokens stored as SHA-256 of 256-bit secrets, parameterized SQL, no default admin, and `/handoff` requires a Bearer token. Two ship-blocking holes remain. First, `clearCookie` never emits `Max-Age=0` (`0` is falsy) and omits `Secure`/`HttpOnly`/`SameSite`, so HTTPS logout can leave the 30-day session cookie in the browser; only logout-everywhere actually invalidates it, via `session_version`. Second, `/api/auth/token-session` still accepts a long-lived API token (and `share.js` still consumes `#token=`), which is a durable login-as-attacker URL and undoes the 60-second hand-off guarantee for anyone not already signed in as someone else. Several documented invariants are untested: hand-off TTL, `already_signed_in`, cookie flags, and ordinary logout. CSRF, rate limits, and TEST_MODE_KEY handling have additional medium issues.

FINDINGS:

1. severity: high
   file:line: server/index.js:37, server/index.js:45, server/auth.js:151-153, server/routes/auth-routes.js:63-65
   claim: Ordinary logout does not reliably delete the session cookie on HTTPS, so a 30-day credential can survive “Sign out”.
   evidence: `res.cookie` only writes `Max-Age` when `opts.maxAge` is truthy, so `maxAge: 0` from `clearCookie` is dropped. `clearSession` passes only `{ path: '/' }`, so the clearing header is `bsw_session=; Path=/` with no `Max-Age`, `Secure`, `HttpOnly`, or `SameSite`. Session cookies are issued with `httpOnly`, `sameSite: 'lax'`, and `secure: config.publicUrl.startsWith('https://')`. Chromium’s strict-secure-cookies rule refuses a non-Secure `Set-Cookie` overwriting a Secure cookie. Tests run on `http://127.0.0.1` (`tests/helpers.js:17,33`), where `Secure` is off, so they cannot catch this. Logout-everywhere still works because it bumps `session_version` before clearing.
   impact: On production HTTPS, “Sign out” can leave the user authenticated on the next page load (shared computer / “I logged out”). Cookie theft is unaffected by ordinary logout.
   fix: Emit `Max-Age=0` when `maxAge === 0`. Pass the same `httpOnly`, `secure`, `sameSite`, and `path` used at issue. Add an HTTPS test that logout actually drops `/api/me`.

2. severity: high
   file:line: server/routes/auth-routes.js:89-117, public/js/share.js:39-44, client/src/provide.js:101-115
   claim: The server still trades a long-lived API token for a session cookie, so a crafted `#token=` link is a permanent login-as-attacker URL. That is the attack 60-second hand-off codes were built to close.
   evidence: `token-session` does `code ? userFromHandoffCode(code) : userFromApiToken(token)`. `share.js` still accepts `location.hash` starting with `#token=` and POSTs the raw token. `already_signed_in` only fires when `req.user` exists and the ids differ — a signed-out visitor is switched into the token’s account. `?autostart=1` then starts GPU sharing as that account. `buildArgs` still falls back to `#token=` if no code is passed. SECURITY.md:38-40 claims the CLI never puts an API token in a URL and that hand-off is single-use / 60 seconds; the live HTTP API does not enforce that.
   impact: Anyone with an API token (the attacker’s own is enough) can mint `https://<origin>/share.html?autostart=1#token=bsw_…`. A signed-out volunteer who opens it is logged into the attacker’s account; their GPU earns for the attacker and subsequent chat is billed on that ledger. Unlike a hand-off code, the link does not expire in 60 seconds and is not single-use.
   fix: Stop accepting `token` on `/token-session` (or require a short-lived token-exchange that is not the API token). Remove `#token=` from `share.js` and the `buildArgs` fallback. Test: signed-out client posting `{ token }` must 401; `{ code }` still 200 once.

3. severity: medium
   file:line: server/routes/auth-routes.js:68-72, server/routes/api.js:128-147, public/wallet.html:85
   claim: “Sign out everywhere” does not revoke API tokens, and a surviving token can immediately mint a new browser session.
   evidence: The handler only `session_version = session_version + 1` and `clearSession`. Token rows are untouched. `userFromApiToken` does not consult `session_version`. `/handoff` and `/token-session` then `issueSession` with the current `session_version`, producing a fresh valid cookie. Wallet copy is “Sign out everywhere”; token revocation is a separate “Revoke” button.
   impact: Stolen CLI token survives the only server-side session kill switch. After the victim clicks the button, the thief calls `/token-session` or `/handoff` and is back in the browser.
   fix: Revoke all `api_tokens` for the user in the same transaction as the version bump, or rename the control and say tokens must be revoked separately. Test that a Bearer token fails `/api/me` after logout-everywhere if you choose the first option.

4. severity: medium
   file:line: server/routes/auth-routes.js:42-47, server/auth.js:73-79
   claim: Failed logins are throttled globally per username (10 / 60 minutes), so an attacker can lock any account from any set of IPs.
   evidence: `userKey = login-user:${username.toLowerCase()…}` is checked with `tooManyAttempts(userKey, 10, 60)` with no IP in the key. The per-IP cap (`login-ip`, `config.limits.loginPerHour`) is separate. Tests (`tests/unit/auth.test.js:57-66`) only assert that a 429 appears, not that a third IP can still try.
   impact: One unauthenticated client can deny password login for a chosen username for an hour. There is no password-change endpoint to recover by another factor (finding 8).
   fix: Key the password throttle `(ip, username)` or require a higher bar plus CAPTCHA/backoff. Keep a looser per-username cap if you want stuffing protection, but do not make 10 failures a hard global lockout.

5. severity: medium
   file:line: server/config.js:21, server/util.js:89-99, server/auth.js:242-249
   claim: Rate-limit identity and CSRF origin checks trust client-controlled forwarding headers more loosely than SECURITY.md describes.
   evidence: `TRUST_PROXY` defaults to true and is not in `.env.example` or the README deployment table. `clientIp` with `trustProxy` uses the last `X-Forwarded-For` hop, then the entire `X-Real-IP` header. A client that can reach Node without a stripping proxy picks its own bucket for signup, login, and hand-off consume. `isSameSiteOrigin` always prefers the first `X-Forwarded-Host` hop and is not gated on `trustProxy`, unlike `clientIp`. SECURITY.md:16 says `x-forwarded-for` is used only when `TRUST_PROXY=1`, and then the last hop — it does not mention `X-Real-IP` or `X-Forwarded-Host`.
   impact: Direct-to-process deploys (or a proxy that forwards `X-Real-IP` / first `X-Forwarded-Host`) bypass auth rate limits and can make `Origin: https://evil` look same-site. SameSite=Lax still blocks most browser CSRF; the rate-limit bypass is the practical hit.
   fix: Default `TRUST_PROXY` to false; document it. Ignore `X-Forwarded-*` / `X-Real-IP` unless trust is on. For Host, use the last hop (the one your proxy appended), consistent with `clientIp`.

6. severity: medium
   file:line: public/js/login.js:7-8,35, public/js/share.js:10-11, server/index.js:134-137, server/auth.js:42-45, server/routes/auth-routes.js:16-18
   claim: When `TEST_MODE_KEY` is configured, it is accepted from URL query strings, so it lands in access logs, browser history, and Referer to same-origin resources, and it disables signup throttling.
   evidence: `login.js` copies `?testKey=` onto `x-test-mode-key` for `/signup` and `/login`. E2E does this on purpose (`tests/e2e/swarm.spec.js:21`). WS upgrade also takes `url.searchParams.get('testKey')`. `isTestMode` skips the per-IP signup cap. `/api/config` does not echo the key (good). `.env.example` says leave it empty in production; LAPTOP-TEST.md tells operators to put it in page URLs against a deployed host.
   impact: A leaked key (log line, screenshot, shared e2e command) lets anyone mint unbounded welcome-budget accounts and attach the mock provider / `override=1` admission. Coin minting, not session takeover, but it is exactly the test-only door the comments say normal users must never reach.
   fix: Never take the key from a query string. Header or env only. Refuse test mode unless `NODE_ENV=test` (or a dedicated flag). Do not set `TEST_MODE_KEY` on the public origin.

7. severity: medium
   file:line: server/routes/auth-routes.js:134-154, server/routes/auth-routes.js:13-18
   claim: Google callback creates accounts with no signup rate limit, so welcome coins can be farmed with many Google accounts.
   evidence: `/signup` records `signup:${ip}` against `config.limits.signupPerDay`. `/google/callback` calls `createUser` on a new `google_sub` with no `tooManyAttempts` / `recordAttempt`. `config.coins.welcome` defaults to 1000 (`server/config.js:34`) and is posted in the same transaction (`server/auth.js:105-112`).
   impact: Each new Google identity is a funded account. Not session takeover, but it bypasses the only account-creation throttle.
   fix: Apply the same per-IP signup limiter (and a per-IP Google-start limiter) before `createUser`.

8. severity: medium
   file:line: server/routes/auth-routes.js:39-72, server/auth.js:20-26
   claim: There is no password-change (or reset) path, and login/logout does not rotate `session_version`, so a stolen password or cookie is valid for up to 30 days unless the user finds “Sign out everywhere”.
   evidence: Grep shows `validatePassword` / login / signup only — no change-password route. `issueSession` TTL is `60 * 60 * 24 * 30` (`server/auth.js:9,139`). Login updates `last_login_at` but not `session_version`. Ordinary logout only clears this browser’s cookie (and may fail; finding 1).
   impact: Password leak or cookie theft has no self-service recovery other than logout-everywhere, which still leaves API tokens alive (finding 3).
   fix: Add a change-password endpoint that re-hashes, bumps `session_version`, and optionally revokes tokens. Bump `session_version` on login if you want one-session-per-password-use.

9. severity: medium
   file:line: server/auth.js:54-61, server/routes/auth-routes.js:82-87
   claim: Hand-off codes sit in an unbounded process-local Map, and `/handoff` is unthrottled, so any valid API token can grow heap until the process dies.
   evidence: `handoffCodes = new Map()`; `createHandoffCode` inserts then lazily deletes expired entries. `/handoff` authenticates the Bearer token and returns a code with no `tooManyAttempts`. One user may hold 10 tokens (`server/routes/api.js:138`).
   impact: Authenticated memory DoS of the coordinator process. Codes also vanish on restart and do not replicate across instances (fail-closed, not a takeover).
   fix: Cap outstanding codes per user (e.g. 3), rate-limit `/handoff`, and optionally store codes in Redis/Postgres with TTL if you run more than one replica.

10. severity: low
    file:line: server/auth.js:226-234
    claim: CSRF origin check allows a missing `Origin` on cookie-authenticated mutating requests.
    evidence: `if (!origin) return next();` with a comment that this is a non-browser client. SameSite=Lax plus JSON-only bodies (no `urlencoded` parser) block typical form CSRF and cross-site `fetch`. Residual risk is older clients / Lax+POST edge cases.
    impact: Defense in depth only; not exploitable in current Chrome/Firefox with Lax cookies and `express.json`.
    fix: For `authKind === 'session'`, require `Origin` or `Sec-Fetch-Site: same-origin`. Keep the exemption for Bearer.

11. severity: low
    file:line: server/routes/auth-routes.js:51-52, server/auth.js:32-35
    claim: Login short-circuits Argon2 when the username is unknown, so existence is visible in timing (and signup already returns 409 `taken`).
    evidence: `const ok = user && await auth.verifyPassword(...)`. Missing users skip `argonVerify`. Error strings are aliased (good; tested).
    impact: Username enumeration. Mild for anonymous accounts whose names are already enumerable at signup.
    fix: Dummy-verify a precomputed hash when `user` is null.

12. severity: low
    file:line: server/auth.js:63-68, server/routes/auth-routes.js:107-117
    claim: A disabled account can still be turned into a Set-Cookie via a live hand-off code; subsequent requests then fail `userFromSessionToken`.
    evidence: `userFromHandoffCode` returns `findUserById` with no `disabled` check. `userFromApiToken` and `userFromSessionToken` both reject disabled users, so `/handoff` cannot mint a new code for them, but an already-issued code still calls `issueSession`.
    impact: Confusing 200 then 401; not a privilege gain.
    fix: Reject `user.disabled` in `userFromHandoffCode` (and in `token-session` before `issueSession`).

13. severity: low
    file:line: public/js/login.js:4,18,38
    claim: After login, `location.href = params.get('next')` is an open redirect (cookie consumer).
    evidence: `next` is taken from the query string with no `startsWith('/')` / same-origin check. HttpOnly + Lax means the session cookie is not sent to a third-party `next`, so this is phishing, not theft.
    impact: `login.html?next=https://evil.example` after a successful sign-in.
    fix: Allow only relative paths on this origin.

14. severity: nit
    file:line: server/auth.js:28, tests/unit/auth.test.js:37-42
    claim: Argon2id parameters are the OWASP minimum (`m=19456, t=2, p=1`), and tests only check the `$argon2id$` prefix, not the cost fields.
    evidence: `const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }`. Acceptable, not a failure.
    impact: Cheaper offline cracking than a higher `m`/`t` if the hash table leaks. Tokens are SHA-256 of 32 random bytes — that part is fine.
    fix: Optional: raise `memoryCost` / `timeCost` and assert them in the unit test.

15. severity: nit
    file:line: client/README.md:54, client/src/provide.js:114, SECURITY.md:38-40
    claim: Client README still says the API token goes in the URL fragment; current `launchBrowser` does exchange a code first.
    evidence: README: “your token in the URL fragment”. `launchBrowser` awaits `handoffCode` then passes `code` into `buildArgs`, which only uses `#token=` if `code` is missing.
    impact: Docs drift; the fallback in `buildArgs` is the real bug (finding 2).
    fix: Update the README; delete the `#token=` branch.

COVERAGE:

Read in full:
- `server/auth.js`
- `server/routes/auth-routes.js`
- `server/schema.sql` (users, api_tokens, login_attempts, session_version, is_admin)
- `tests/unit/auth.test.js`
- `SECURITY.md`
- `public/js/login.js` (cookie / testKey consumer only)

Read as call sites / wiring (not a full review of coordinator, coins, or frontend):
- `server/index.js` (cookie helper, middleware order, WS auth, TEST_MODE_KEY on upgrade)
- `server/util.js` (`randomToken`, `sha256`, `signPayload`/`verifyPayload`, `timingSafeEqual`, `clientIp`)
- `server/config.js` / `.env.example` / `README.md`
- `server/routes/api.js` (token CRUD, `/me`, `/admin/*`, requireAuth)
- `server/routes/openai.js` (Bearer/cookie via `requireAuth`)
- `public/js/share.js` (`#code=` / `#token=` → `/token-session`)
- `public/js/common.js` (`fetch` credentials default, logout)
- `public/js/wallet.js` / `public/wallet.html` (token create/revoke, logout-everywhere)
- `client/src/provide.js` / `client/bin/cli.js` (handoff, `#token=` fallback)
- `tests/unit/network.test.js` (hand-off single-use test)
- `tests/helpers.js`, `tests/e2e/swarm.spec.js`

Grep: `cookie`, `token`, `handoff`, `hand-off`, `session`, `TEST_MODE_KEY`, `csrf`, `is_admin`, `session_version`, `logout`.

Untested relative to `tests/unit/auth.test.js` (and the one hand-off test in `network.test.js`):

| Claim | Tested? |
| --- | --- |
| Signup welcome budget, username/password validation, case-insensitive uniqueness | yes (`auth.test.js`) |
| Passwords stored as argon2id, not plaintext | yes (prefix only, not m/t/p) |
| Login same error for missing user vs bad password | yes |
| Login per-account 429 | yes (not that it is global vs per-IP) |
| Tampered session cookie rejected | yes |
| logout-everywhere invalidates cookies | yes |
| API tokens hashed, authenticate, revoke | yes (`token_hash` must not contain the secret) |
| Cookie POST from foreign Origin → 403 | yes |
| Anonymous 401 / non-admin 403 | yes |
| Hand-off code works once | yes (`network.test.js:342-356`) |
| Hand-off expires in 60 seconds | **no** — test name says “only for a minute”, body never waits or freezes time |
| Hand-off refuses a browser signed in as someone else | **no** |
| `/token-session` with a raw API token | **no** (and it currently succeeds) |
| `/handoff` requires Bearer, rejects cookie-only | **no** |
| Ordinary `/logout` clears the cookie | **no** |
| Cookie flags HttpOnly / Secure / SameSite / Path | **no** |
| Session `exp` / 30-day TTL | **no** |
| Signup rate limit; TEST_MODE_KEY bypass | **no** |
| Google OAuth state / PKCE / disabled user | **no** |
| Disabled password login | **no** |
| logout-everywhere vs API tokens | **no** |
| CSRF when `Origin` is absent | **no** |

INVARIANTS: SECURITY.md auth / hand-off claims vs actual code

| Claim | Actual |
| --- | --- |
| “The CLI never puts an API token in a URL: it exchanges it for a single-use, 60-second hand-off code” | `launchBrowser` does exchange (`client/src/provide.js:122`). `buildArgs` still encodes `#token=` if `code` is falsy. Server `/token-session` still accepts the long-lived token (`auth-routes.js:107`). `share.js` still consumes `#token=`. **Partial — CLI happy path matches; HTTP API and fallback do not.** |
| “the hand-off refuses a browser already signed in as somebody else” | Implemented at `auth-routes.js:110-115` (`409 already_signed_in`). Not tested. Does not apply when the browser has no session (logged-out GPU hijack via `#token=`). **Holds only for an existing different session.** |
| Single-use code | `userFromHandoffCode` deletes before TTL check (`auth.js:64-67`). Map.get/delete is sync (no race in one process). **Holds.** |
| 60-second TTL | `exp: Date.now() + 60_000` (`auth.js:58`). Expired entries still deleted on read. **Holds in code; untested.** |
| Worst case for a leaked code is one session, one minute | True for codes. False for the still-live token path (finding 2). |
| Cookie or API token authenticates a WebSocket | `server/index.js:115-118`. Origin checked when present. **Holds.** |
| `x-forwarded-for` only when `TRUST_PROXY=1`, last hop | Default is true. Last XFF hop matches. Extra `X-Real-IP` fallback is not in SECURITY.md. CSRF uses first `X-Forwarded-Host` always. **Partial.** |
| Argon2 for secrets (passwords) | Argon2id via `@node-rs/argon2` with m=19456,t=2,p=1. API tokens are SHA-256 of high-entropy secrets, not Argon2 — appropriate. **Holds.** |

What is in good shape (not findings): no default/admin seed (`is_admin` default false, no SQL seed); token list/delete scoped by `user_id` (no IDOR); auth queries parameterized (no SQLi in this slice); `requireSecrets` demands `SESSION_SECRET` ≥ 32 chars; HMAC compare is timing-safe; session fixation in the classic sense is avoided (login issues a new signed payload, it does not bind a pre-set id); `/handoff` ignores cookies and requires Bearer; Google OAuth uses PKCE S256 + signed state cookie + timing-safe state compare + aud/iss/exp checks.

STATUS rules: two highs (logout cookie deletion on HTTPS; durable `#token=` session exchange) plus several mediums that affect lockout, revocation, and test-key leakage → ISSUES.
