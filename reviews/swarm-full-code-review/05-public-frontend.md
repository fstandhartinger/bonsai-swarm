STATUS: ISSUES

SUMMARY: The public app is a small vanilla ES-module surface and it gets several hard things right: DOM writes go through `el()`/`textContent`, volunteer output is HTML-escaped before markdown, session cookies are HttpOnly + SameSite=Lax, cookie POSTs are origin-checked, the provider WebSocket is authenticated before upgrade, and the coordinator (not the browser) counts tokens, admits, pays, and unlocks badges. Two client issues are still ship-blocking. `share.html` will take a `#token=` or `#code=` fragment from any link, mint a session for a logged-out visitor, and with `?autostart=1` start the GPU worker with no click — that is login CSRF / GPU hijack into the attacker’s account. `login.js` assigns `location.href` from an unsanitised `next` query param. On top of that, the official share page will run a fake worker on `?provider=mock` without the test key, reconnect can overlap two `generate` jobs on one model, chat history (including prompts) is written to `localStorage`, and a clean SSE drop leaves the composer stuck streaming. CSP `connect-src` also allows WebSocket to any host, which matters if the Hugging Face runtime is ever compromised.

FINDINGS:

1. **High — login CSRF / GPU hijack via hash auth + autostart**
   - **file:line:** `public/js/share.js:15`, `public/js/share.js:39-45`, `public/js/share.js:74`
   - **claim:** A logged-out visitor who opens a crafted `share.html` link is signed into the attacker’s account. `?autostart=1` then starts sharing without a further click, so the victim’s GPU earns AI Coins for the attacker and runs strangers’ prompts under that session.
   - **evidence:** `boot()` treats `#code=` and `#token=` as credentials, POSTs them to `/api/auth/token-session`, then continues into `mountChrome()` / `requireSignIn()`. The server only refuses when the browser is *already* signed in as someone else (`server/routes/auth-routes.js:110-115`). A logged-out victim is switched. `AUTOSTART` is a public query flag and calls `start(cfg)` at line 74. `#token=` still accepts a long-lived API token, despite the comment at lines 37-38 and SECURITY.md saying the CLI uses 60-second codes.
   - **impact:** One link (`/share.html?autostart=1#token=bsw_…` or a fresh `#code=`) hijacks GPU time and coin credit. Logged-in victims are protected; logged-out ones are not. Autostart is visible in the URL but does not require understanding the hash.
   - **fix:** Drop `#token=` in the browser path (handoff codes only). Do not autostart unless this document already had a session for the same user *before* the handoff. Show the target account and require a click for any cold session. Bind codes to the creating client where possible.

2. **Medium — open redirect after sign-in**
   - **file:line:** `public/js/login.js:4`, `public/js/login.js:18`, `public/js/login.js:38`
   - **claim:** `next` is taken from the query string and assigned to `location.href` with no allowlist.
   - **evidence:** `const next = params.get('next') || '/chat.html'` then `location.href = next` both when already signed in and after a successful password login. `requireSignIn()` only ever sets `next` to `location.pathname` (`public/js/common.js:166`), so first-party navigation is safe; a crafted `/login.html?next=https://evil.example` or `next=//evil.example` is not. Google’s callback is hardcoded to `/chat.html` and is not affected.
   - **impact:** Phishing after a real login on the real origin. Session cookie is HttpOnly so it is not leaked through the redirect, but the user arrives at the attacker’s page already authenticated to Bonsai Swarm.
   - **fix:** Accept only same-origin relative paths: `next` must start with `/` and must not start with `//`.

3. **Medium — official mock worker is not gated on TEST_MODE_KEY**
   - **file:line:** `public/js/share.js:7-11`, `public/js/share.js:102`, `public/js/share.js:185-186`
   - **claim:** `?provider=mock` swaps in `mockWorker()` for any signed-in visitor. The comment that this “does nothing for a normal visitor” is true only of the server’s `isMock` bit, not of the client.
   - **evidence:** `MOCK` is solely `params.get('provider') === 'mock'`. `start()` uses `mockWorker()` whenever `MOCK` is set, and that fake worker reports `decodeTps: 42` (`share.js:338`) and emits `mock t1 t2…`. The test key is only forwarded as a query param (`share.js:186`). Server-side `isMock` requires the key (`server/index.js:134-136`), so this tab is treated as a *real* provider: admitted on the claimed 42 tok/s, paid per minute and per relayed token, while consumers are charged for garbage.
   - **impact:** Zero-skill coin farming and network pollution from the published page, no GPU, no `TEST_MODE_KEY`. A modified client can already lie (accepted in SECURITY.md); shipping the liar as a public query flag is different.
   - **fix:** Use `mockWorker()` only when a test key is present *and* the server echoed `isMock` on `welcome`. Ignore `provider=mock` otherwise.

4. **Medium — reconnect overlaps jobs; worker is not one-job-at-a-time; pause is dropped**
   - **file:line:** `public/js/share.js:182-201`, `public/js/share.js:210-214`, `public/js/share.js:219-229`, `public/js/share.js:235-244`, `public/js/bonsai-worker.js:16`, `public/js/bonsai-worker.js:102-133`
   - **claim:** The coordinator serialises work per socket (`currentJobId` / `busy`), but the page and worker do not. After a drop, a new socket can receive `job.start` while the previous `generate()` is still running on the same model. Pause does not survive reconnect.
   - **evidence:** `connect()` never closes an existing `state.ws`, never `clearTimeout`s `reconnectTimer`, and `onclose` always schedules another `connect` while `state.sharing` is true (`share.js:195-199`). It does not `cancel` the in-flight worker job. On `welcome`, a still-loaded model immediately replays `benchmark` (`share.js:210-214`). On `admission`, it always sends `status: ready`, ignoring `state.paused` (`share.js:229`). `job.start` always `postMessage`s `generate` with no busy guard (`share.js:235-244`). The worker stores many AbortControllers (`aborts` Map) and `generate()` calls `model.reset()` then `model.generate()` without refusing an active job (`bonsai-worker.js:102-118`). Two overlapping generators share one KV cache; deltas are tagged with each call’s `jobId` and forwarded on the new socket.
   - **impact:** Mixed or corrupted completions for two consumers; possible cross-tenant token bleed; a user who paused sharing is put back online after a blip. Server `handleDelta` drops frames whose `jobId` is not this socket’s current job, so billing is not the failure mode — output integrity is.
   - **fix:** One `currentJobId` in share.js and the worker; reject or queue a second `generate`. On `onclose`, `cancel` / abort the active job. Close the old socket and clear the timer before opening a new one. Replay `paused` on `welcome`/`admission`.

5. **Medium — consumer prompts (and volunteer answers) persist in localStorage**
   - **file:line:** `public/js/chat.js:5-16`, `public/js/chat.js:114-118`, `public/js/chat.js:146`
   - **claim:** Full conversation text is stored under `bsw.conversations.v1` (up to 50 threads). This fails the review invariant “prompts not persisted in localStorage”.
   - **evidence:** `save()` does `localStorage.setItem(STORE_KEY, JSON.stringify(state.conversations.slice(0, 50)))`. `onSend` writes the user message before the request (`chat.js:114-118`) and `finish()` saves again after the stream (`chat.js:146`), including assistant content and reasoning. SECURITY.md’s “prompts are never stored” is worded for DB/logs; Datenschutz says prompt text exists “only ephemerally in RAM … and in the participants’ browsers,” which can be read as allowing this. Theme and the thinking toggle are the only other keys (`common.js:79-84`, `chat.js:34-35`).
   - **impact:** Shared computers, XSS, backups, and extension access recover prompts the UI told the user not to send. Volunteer-generated text is persisted on the consumer too.
   - **fix:** If history is required, keep it in memory or a user-explicit export; otherwise sessionStorage with a clear-on-logout, or store titles only. Document the client store in Datenschutz if it stays.

6. **Medium — chat UI can remain “streaming” if the SSE ends without `done`/`error`**
   - **file:line:** `public/js/chat.js:138-217`, `public/js/common.js:288-323`
   - **claim:** `finish()` runs from the `done`/`error` handlers or from `catch`. A clean EOF (proxy idle timeout, server crash after headers) makes `streamSse` return normally and leaves Send disabled.
   - **evidence:** `streamSse` reads until `reader.read()` yields `done` and then returns (`common.js:305-322`). `onSend`’s `try` has no `finally`. `state.streaming` is only cleared in `finish()`. Stop still works because abort throws `AbortError` into `catch` (`chat.js:214-217`).
   - **impact:** Composer stuck; user can recover by clicking Stop if they notice. Looks like a hung swarm.
   - **fix:** `try/finally`: if `state.streaming` is still true after `streamSse` returns, `finish('disconnected')`.

7. **Medium — CSP `connect-src` allows WebSocket to any host**
   - **file:line:** `server/index.js:54-65`
   - **claim:** `'self'` already covers the provider socket. `ws:` and `wss:` are scheme-wide.
   - **evidence:** `connect-src 'self' https://huggingface.co https://cdn-lfs.hf.co … wss: ws:`. The page WebSocket is same-origin `/ws/provider` (`share.js:183-191`). Worker weights use the HF hosts. SECURITY.md already treats a compromised Hugging Face space as RCE in every volunteer tab; arbitrary WebSocket is the easy exfil path for prompts that live in that worker, without needing an HF-controlled endpoint (`https://*.hf.co` is also already allowed).
   - **impact:** Defense-in-depth only, until `RUNTIME_SHA256` is pinned. Prompt confidentiality for volunteers depends on this CSP if the extracted library goes bad.
   - **fix:** Drop `ws:`/`wss:`. Keep `'self'` plus the HF HTTPS hosts. Pin `RUNTIME_SHA256` in production.

8. **Low — WebSocket `onmessage` JSON.parse is unguarded; reconnect timer can stack**
   - **file:line:** `public/js/share.js:194-199`
   - **claim:** One malformed coordinator frame throws out of `onmessage`. `onclose` assigns `reconnectTimer` without clearing a prior timer.
   - **evidence:** `ws.onmessage = (e) => onServerMessage(JSON.parse(e.data), cfg)` with no try/catch. `setTimeout` at line 199 overwrites the handle.
   - **impact:** A bad frame is unlikely from your coordinator; stacked timers plus finding 4 make double-connect easier.
   - **fix:** try/catch around parse; `clearTimeout` at the start of `connect()`.

COVERAGE

Read end-to-end:
- `public/js/bonsai-worker.js`, `chat.js`, `common.js`, `login.js`, `share.js`, `wallet.js`
- `public/index.html`, `chat.html`, `coins.html`, `login.html`, `share.html`, `wallet.html`, `leaderboard.html`, `404.html`, `datenschutz.html`, `impressum.html`
- `public/app.css` (jsdelivr `@import` vs CSP `style-src`/`font-src` only)
- Context: `server/index.js` (CSP, static, WS upgrade), `server/runtime.js` (same-origin library, IndexedDB origin), `server/auth.js` (cookie flags, CSRF), `server/routes/auth-routes.js` (token-session, OAuth), `server/coordinator.js` (benchmark clamp, random pick, one job per socket, server-side token count), `server/routes/api.js` (SSE, leaderboard opt-in), `SECURITY.md`, `server/schema.sql` (`leaderboard_opt_in` default false)

Traced message types:
- Client → server: `status`, `benchmark`, `pong`, `job.delta`, `job.done`, `job.error`
- Server → client: `welcome`, `ping`, `admission`, `job.start`, `job.cancel`
- Ignored / not sent by this UI: anything else (`handleProviderMessage` default return)
- Chat SSE: `queued`, `assigned`, `delta`, `done`, `error` via `streamSse`

Not in this slice: OpenAI routes, CLI, coordinator settlement math beyond what the client must assume.

INVARIANTS

- **Client cannot award itself coins/badges — HOLD.** Header balance, wallet ledger, share-page session coins, levels, streaks, and badge walls are all fetched from `/api/me`, `/api/ledger`, `/api/gamification`. `celebrate()` only toasts `profile.justUnlocked` from the server (`common.js:261-274`). Share.js sends `benchmark` / `job.done` but coordinator clamps TPS, counts deltas itself, and does not rank by the claim (`coordinator.js:164-196`, `381-389`, `480-492`).
- **Prompts not persisted in localStorage — FAIL.** See finding 5. `bsw.conversations.v1` holds user + assistant text. Theme (`bsw-theme`) and thinking (`bsw.thinking`) do not.
- **Cookies not readable by JS if HttpOnly — HOLD.** `bsw_session` is set with `httpOnly: true`, `sameSite: 'lax'`, `secure` when `publicUrl` is https (`server/auth.js:141-147`). No `document.cookie` in `public/`. OAuth state cookie is also HttpOnly (`auth-routes.js:128-130`).

Other checks (not invariant-listed):
- **XSS:** `el()` appends text nodes (`common.js:7-14`). User chat is `textContent` (`chat.js:101`). Assistant HTML goes through `renderMarkdown`, which escapes `&<>"` first (`common.js:329-346`); no link/image rendering. SSE `d.error` and provider labels are text. Leaderboard names are `textContent`. Residual risk is CSP `script-src 'unsafe-inline' 'unsafe-eval'` (needed for inline modules + WASM) so a future innerHTML bug would not be contained.
- **CSRF:** `api()`/`streamSse()` are same-origin `fetch` with JSON. Guard checks `Origin` for cookie POSTs (`auth.js:226-234`). SameSite=Lax stops cross-site POST cookies. Form CSRF cannot populate `express.json()`. Finding 1 is login CSRF via a *same-origin* page the victim navigated to, not a cross-site POST.
- **TEST_MODE_KEY:** not hardcoded. `login.js:7,35` and `share.js:11,186` copy a query param. Server compares with `timingSafeEqual` (`index.js:134-136`, `auth.js:42-46`).
- **WebSocket auth:** upgrade requires session cookie or Bearer (`index.js:113-118`); unauthenticated peers never get a socket. Browser `Origin` is checked (`index.js:120-124`). Missing `Origin` is allowed (CLI).
- **Benchmark spoofing:** expected. Client can lie; server clamps, does not dispatch by claim, times real jobs, demotes (`coordinator.js:171-196`, `540-562`). Finding 3 is the *built-in* liar, not the general spoof.
- **One-job-at-a-time:** held on the server per socket; **not** held in the worker or share.js (finding 4).
- **Weights / origin / IndexedDB:** worker imports `/runtime/bonsai2-lib.js` from this origin (`bonsai-worker.js:21-23`). Runtime is extracted and served here so the cache is per this origin (`runtime.js:10-12, 92-106`). Weights then come from HF under CSP `connect-src`.
- **Open redirects:** finding 2. `requireSignIn` itself is safe. Sign-out goes to `/`.
- **Leaderboard opt-in:** default `false` in schema; wallet checkbox is bound to server `leaderboardOptIn` and POSTs `/api/leaderboard/opt-in` (`wallet.js:16-18,84`; `api.js:172-175`). Programmatic `.checked` does not fire `change`.
- **Prompt leak into volunteer UI/logs:** share activity log never prints `job.start` messages or deltas (`share.js:150-163`). No `console.log` of prompt text in `public/`. DevTools can still see worker messages (accepted: prompts run on the volunteer machine).
- **Secrets in JS:** none. API tokens are shown once on the wallet page via `textContent` (`wallet.js:106`).
