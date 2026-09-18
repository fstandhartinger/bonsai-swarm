# bonsai-swarm-client

Join the [Bonsai Swarm](https://bonsai-swarm.app.mintapis.com) volunteer GPU network
from your own machine — both directions:

* **provide**: starts a real Chrome with the background-throttling switches turned off,
  loads Ternary Bonsai 2 27B onto your GPU and serves other people's prompts;
* **consume**: exposes **OpenAI Chat Completions**, **OpenAI Responses** and
  **Anthropic Messages** compatible endpoints on `127.0.0.1:4777`, so any tool you
  already own can talk to the swarm.

No install needed:

```bash
npx bonsai-swarm-client login      # paste an API token from your wallet page
npx bonsai-swarm-client provide    # share this machine's GPU
npx bonsai-swarm-client serve      # local API gateway on 127.0.0.1:4777
```

## Requirements

| To | You need |
| --- | --- |
| provide | a GPU with **≥ 12 GB** memory (16 GB comfortable), or Apple Silicon Pro/Max with ≥ 24 GB unified memory; Chrome/Chromium 121+; ~6 GB of disk for the weights; up to ~10 GB RAM while loaded |
| consume | Node 20+ and an account — nothing else |

An 8 GB laptop GPU measures ~2.5 tokens/s and will **not** be admitted as a provider
(the model spills out of VRAM). It can still chat.

## Commands

```
bonsai-swarm login [--url URL] [--token TOKEN]   store an API token
bonsai-swarm logout                              forget it again
bonsai-swarm status                              your AI Coins and the swarm's state
bonsai-swarm provide [--chrome PATH] [--override]
bonsai-swarm serve [--port 4777] [--host 127.0.0.1] [--verbose]
bonsai-swarm litellm [--port 4778] [--gateway-port 4777]
bonsai-swarm ask "question" [--max-tokens N]
```

Environment: `BONSAI_SWARM_URL`, `BONSAI_SWARM_TOKEN`, `BONSAI_SWARM_CHROME`,
`BONSAI_SWARM_HOME`.

## Providing

```bash
npx bonsai-swarm-client provide
```

The model can only run in a browser (WebGPU), so this launches one for you with
`--disable-background-timer-throttling --disable-backgrounding-occluded-windows
--disable-renderer-backgrounding`, a dedicated profile (so the 5.9 GB of weights are
kept between runs) and your token in the URL fragment, which never reaches a server log.
The CLI then prints live status: admission speed, requests served, AI Coins earned.

Close the browser window, or press Ctrl-C, to stop sharing.

## Consuming — three API shapes, one network

```bash
npx bonsai-swarm-client serve
```

| Endpoint | Shape |
| --- | --- |
| `POST http://127.0.0.1:4777/v1/chat/completions` | OpenAI Chat Completions |
| `POST http://127.0.0.1:4777/v1/responses` | OpenAI Responses |
| `POST http://127.0.0.1:4777/v1/messages` | Anthropic Messages |
| `GET  http://127.0.0.1:4777/v1/models` | model list |

Streaming works on all three. The gateway binds to localhost only, so nothing outside
your machine can spend your AI Coins. Your token stays on your machine; the gateway
takes no key of its own (`OPENAI_API_KEY=local` is fine).

```bash
export OPENAI_BASE_URL=http://127.0.0.1:4777/v1
export OPENAI_API_KEY=local
export ANTHROPIC_BASE_URL=http://127.0.0.1:4777
export ANTHROPIC_API_KEY=local
```

### With OpenCode

```json
{
  "provider": {
    "bonsai-swarm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:4777/v1", "apiKey": "local" },
      "models": { "bonsai-swarm/ternary-bonsai-2-27b": { "name": "Ternary Bonsai 2 27B (swarm)" } }
    }
  }
}
```

### With LiteLLM

`bonsai-swarm litellm` writes a config and runs LiteLLM in front of the gateway
(`pip install litellm[proxy]` first) if you prefer LiteLLM's own routing, logging and
key management:

```bash
npx bonsai-swarm-client litellm --port 4778
curl http://127.0.0.1:4778/v1/chat/completions -H 'authorization: Bearer local' \
  -d '{"model":"bonsai-swarm","messages":[{"role":"user","content":"hi"}]}'
```

## What to expect

The swarm is only as fast as the volunteer who picks up your request (typically
20–30 tokens/s on a card that passes admission), and your request waits in a queue when
every GPU is busy. If nobody is online, you get a friendly failure, not a hang.

## Privacy

**Your prompts are processed on a stranger's computer**, and while you provide, other
people's prompts run on yours. Nothing is stored on either side beyond token counts —
but do not send personal or confidential data through a volunteer network.

## Licence

MIT. Source: https://github.com/fstandhartinger/bonsai-swarm
