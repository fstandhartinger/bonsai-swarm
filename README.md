# Bonsai Swarm

**A volunteer GPU network that runs a 27B language model in browser tabs.**
Open a tab, share your graphics card, earn **AI Coins**. Spend them when you need an
answer. No money, no crypto, no billing. Sign in with Google; MIT licensed.

Live: **https://bonsai-swarm.app.mintapis.com**

The model is [Ternary Bonsai 2 27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf)
by Prism ML, in its ternary (PTQ1_0) quantisation — 5.95 GB of weights. It runs
client-side through the WebGPU kernels published by the
[webml-community space](https://huggingface.co/spaces/webml-community/ternary-bonsai-2-webgpu-kernels)
(Xenova / the transformers.js community). This repository is the thin layer that lets
those browsers find each other: a coordinator, a ledger and two front ends.

---

## Why

A modern gaming laptop is idle all night. Somebody eight time zones away is awake and
wants to ask a model something. Bonsai Swarm connects the two, and keeps the exchange
roughly fair with a points ledger instead of a payment system.

## How it works

```
  volunteer browser                coordinator (this repo)              consumer
  ┌───────────────┐   WebSocket    ┌────────────────────┐   SSE      ┌─────────────┐
  │ Web Worker    │ ─────────────► │ queue + assignment │ ─────────► │ chat page   │
  │ WebGPU kernels│ ◄───────────── │ token counting     │            │ or local    │
  │ 5.9 GB weights│   job.start    │ append-only ledger │            │ OpenAI API  │
  └───────────────┘                └─────────┬──────────┘            └─────────────┘
                                             │
                                        PostgreSQL
```

* **Providers** connect over a WebSocket, run an admission benchmark in the browser
  (`benchmarkFixedTokenIds`) and must reach **10 decoded tokens/s** to be given
  strangers' work. One job at a time per provider — the library cannot batch.
* **Consumers** post to `/api/chat/stream` (SSE) from the web chat, or to
  `/api/v1/chat/completions` (OpenAI-compatible) with an API token.
* **The coordinator** counts the tokens it actually relayed. A modified browser cannot
  claim work it did not do, and never learns who the consumer is.
* **Prompts are never stored.** Only aggregate counters per job survive a request.
* **When the swarm is empty, a free fallback model answers** — and every such answer says
  so. See below; it is optional and off unless you configure an upstream.

### AI Coins

| Event | Coins |
| --- | --- |
| New account, once | `+1000` |
| Online, admitted, ready — per minute | `+2` |
| Generating for someone else — per token | `+0.5` |
| Your prompt — per token | `−0.1` |
| Your answer — per token | `−0.5` |
| An answer from the free fallback model — flat, per answer | `−5` |

Rules that are enforced, not just documented (see `tests/unit/network.test.js`):

* a balance can never go negative — answers are shortened, or the request is refused;
* you never get your own prompts, so you cannot mint coins in a circle;
* only live, admitted, heartbeat-answering minutes are credited; loading earns nothing;
* a provider that drops before the first token is paid nothing and the job is re-queued;
* a fallback answer pays nobody and costs a flat rate, whatever its length;
* the ledger is append-only, `users.balance` is only a cache, and
  `auditBalance()` re-derives it from the rows.

Levels, day streaks, achievements and the (opt-in) leaderboard are all **derived from
the same ledger** in `server/gamification.js` — there is no second set of numbers that
could drift, and a browser can never award itself a badge.

## When nobody is online

A peer-to-peer network is empty until it isn't, and somebody who watches a spinner for
two minutes before reading *"no GPU picked this up"* does not come back. So the
coordinator can hand a job to a **free fallback model** instead — when no admitted GPU
is in the network at all, when nobody has picked the job up after ~20 seconds, or when
the volunteer answering you disappears mid-sentence.

It is never a silent substitute:

* the chat shows, above the answer,
  *"No community GPU online right now — answered by a free fallback model (&lt;model&gt;)"*;
* the API sends `x-bonsai-served-by: fallback` and, in the body,
  `bonsai_swarm.served_by` plus `bonsai_swarm.fallback_model`. A real swarm answer says
  `community` and keeps its volunteer label;
* **no volunteer earns AI Coins for it** — nobody did the work — so it counts towards no
  level, badge, streak or leaderboard position;
* it costs a **flat, reduced** 5 AI Coins instead of the per-token price;
* it is rationed per account, per address and per day, because unlike the swarm it costs
  somebody real money. When the budget is gone the request waits for a real GPU, as before.

Any OpenAI-compatible endpoint works, and several can be listed and are tried in order —
an upstream that errors, stalls, or (like a reasoning model on a short budget) returns
nothing but thoughts is skipped. Endpoints and keys come from the environment only, so
none of them is in this repository; see `.env.example`. Configure nothing and the feature
is off, leaving a purely peer-to-peer network.

## Repository layout

```
server/           coordinator, auth, ledger, gamification, HTTP + WebSocket API
  runtime.js      fetches the WebGPU library from the HF space and serves it same-origin
public/           the web app (vanilla ES modules, no build step)
  js/bonsai-worker.js   the Web Worker that actually runs the model
client/           the downloadable CLI: provide from a real Chrome, consume via
                  OpenAI / OpenAI-Responses / Anthropic-Messages endpoints
  fallback.js     the free fallback model: upstreams tried in order, always labelled
tests/unit/       auth, ledger and coordinator tests against a real Postgres
tests/e2e/        Playwright tests against a running deployment
```

### Why the library is not vendored

The Hugging Face space declares **no licence**, so this repository contains no copy of
its code. `server/runtime.js` fetches the space's `index.html` at runtime, cuts out the
module that ends in `export { … TernaryBonsai2 … }`, caches it on disk and serves it
from our own origin — same origin matters, because the browser caches the 5.9 GB of
weights in IndexedDB per origin. The model weights themselves are Apache-2.0.

## Running it locally

Requirements: Node 22+, PostgreSQL 14+.

```bash
createdb bonsai_swarm
cp .env.example .env          # fill in DATABASE_URL and SESSION_SECRET
npm install
npm start                     # http://localhost:3000
```

Tests:

```bash
createdb bonsai_swarm_test    # TEST_DATABASE_URL in .env
npm test                      # unit + integration, real Postgres, mock provider
npm run test:e2e              # Playwright; BSW_BASE_URL + BSW_TEST_KEY
cd client && npm test         # the three API dialects against a fake network
```

`TEST_MODE_KEY` unlocks two things for automated tests only — a deterministic mock
provider (`?provider=mock`) and admission for a GPU below the speed bar
(`?override=1`). Both require the shared secret; a normal visitor can reach neither.

## Deployment

One container (`Dockerfile`) plus one PostgreSQL database. Environment:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | ≥ 32 random characters; signs session cookies |
| `PUBLIC_URL` | the canonical origin (one fixed origin — IndexedDB cache) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional Google sign-in |
| `TEST_MODE_KEY` | optional; unlocks the mock provider for tests |
| `COINS_*`, `PROVIDER_MIN_DECODE_TPS`, `JOB_*` | economy and limits, see `server/config.js` |

The schema is applied on boot and is idempotent.

## Honest numbers

| Machine | Decode speed | Admitted? |
| --- | --- | --- |
| RTX 4060 Laptop, 8 GB | **2.1–2.7 tok/s** (weights spill out of VRAM) | no |
| ≥ 12 GB VRAM | ~20–25 tok/s expected | yes |
| Apple Silicon Pro/Max, ≥ 24 GB unified | expected to pass | yes |

Cold start is a 5.9 GB download (about 15 minutes on a normal line); a warm start from
IndexedDB is ~50 s. Up to ~10 GB of extra system RAM is used while the model is loaded.

A 27B ternary model is small. Code and arithmetic are decent; factual questions —
especially in German — can be confidently wrong. The UI says so too.

## Privacy

* Prompts and answers are relayed, never stored. Jobs keep token counts only.
* A provider never learns who sent a prompt; a consumer never learns whose GPU answered.
* **Your prompts run on a stranger's computer.** Do not send personal or secret data.
  The same is true in reverse while you share.

## Support

Bonsai Swarm is a one-person hobby project, and the servers behind it are not free. If it is
useful to you, you can **[support this project](https://donate.stripe.com/fZu00i9ro0wmdF88sg1Jm01)** with whatever amount you like — it buys
no AI Coins and no priority. Payments go to productivity-boost.com Betriebs UG
(haftungsbeschränkt) & Co. KG, the one-person company behind these projects.

## Credits

* [Prism ML](https://huggingface.co/prism-ml) — Ternary Bonsai 2 27B
* [Xenova](https://huggingface.co/Xenova) and the transformers.js / webml-community
  people — the WebGPU kernels that make it run in a browser at all
* Everything else here: MIT, do what you like with it.
