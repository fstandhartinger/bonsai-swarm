# bonsai-swarm-client

Join the [Bonsai Swarm](https://bonsai-swarm.app.mintapis.com) volunteer GPU network
from your own machine — both directions:

* **provide --local**: relays other people's prompts to your own llama.cpp server
  running the Bonsai GGUF — the fastest way to share, especially on Windows;
* **provide**: or starts a real Chrome with the background-throttling switches turned off,
  loads Ternary Bonsai 2 27B onto your GPU with WebGPU and serves other people's prompts;
* **consume**: exposes **OpenAI Chat Completions**, **OpenAI Responses** and
  **Anthropic Messages** compatible endpoints on `127.0.0.1:4777`, so any tool you
  already own can talk to the swarm.

No install step and no dependencies — Node.js 22 or newer and this folder
([ZIP of the repository](https://github.com/fstandhartinger/bonsai-swarm/archive/refs/heads/main.zip),
or `git clone https://github.com/fstandhartinger/bonsai-swarm`):

```bash
cd bonsai-swarm/client
node bin/cli.js login                                  # paste an API token from your wallet page
node bin/cli.js provide --local http://127.0.0.1:8080  # share through your llama.cpp server
node bin/cli.js provide                                # or: share through a browser (WebGPU)
node bin/cli.js serve                                  # local API gateway on 127.0.0.1:4777
```

(The package is not on npm yet, so `npx bonsai-swarm-client` does not work.)

## Requirements

| To | You need |
| --- | --- |
| provide --local | the [PrismML build of llama.cpp](https://github.com/PrismML-Eng/llama.cpp/releases/latest) running `Ternary-Bonsai-2-27B-PQ2_0.gguf` (or `PTQ1_0`) on a GPU with ≥ 12 GB; Node 22+ |
| provide | a GPU with **≥ 12 GB** memory (16 GB comfortable), or Apple Silicon Pro/Max with ≥ 24 GB unified memory; Chrome/Chromium 121+; ~6 GB of disk for the weights; up to ~10 GB RAM while loaded |
| consume | Node 20+ and an account — nothing else |

Admission needs **5 tokens/s** (about reading speed); faster providers are always asked
first. Measured on 19 Sep 2026: RTX 3090 (Linux, browser) 42 · RTX 2000 Ada (Linux)
16.5 in the browser, 25.5 in llama.cpp · RTX 3060 12 GB (Windows, Edge) 5.5 in the browser,
30–35 in llama.cpp · an 8 GB laptop GPU that spills out of video memory 2.1–3.0 (not
admitted; it can still chat). In a browser on Windows the RTX 3060 was about three times
slower than a weaker card on Linux, so on Windows use `provide --local`.

## Commands

```
bonsai-swarm login [--url URL] [--token TOKEN]   store an API token
bonsai-swarm logout                              forget it again
bonsai-swarm status                              your AI Coins and the swarm's state
bonsai-swarm provide [--chrome PATH] [--override]
bonsai-swarm provide --local URL [--model ID] [--api-key KEY]
bonsai-swarm serve [--port 4777] [--host 127.0.0.1] [--verbose]
bonsai-swarm litellm [--port 4778] [--gateway-port 4777]
bonsai-swarm ask "question" [--max-tokens N]
```

Environment: `BONSAI_SWARM_URL`, `BONSAI_SWARM_TOKEN`, `BONSAI_SWARM_CHROME`,
`BONSAI_SWARM_HOME`.

## Providing through llama.cpp (`--local`)

```bash
# 1. the model server - PrismML build of llama.cpp; stock llama.cpp cannot read these files
llama-server -m Ternary-Bonsai-2-27B-PQ2_0.gguf -ngl 99 -fa on -c 8192 --port 8080

# 2. the relay
node bin/cli.js provide --local http://127.0.0.1:8080 [--model ID] [--api-key KEY]
```

The client connects to the swarm as a provider and forwards each prompt to your server's
`/v1/chat/completions`, streaming the tokens back. Nothing listens on a port and your
server never sees your API token. Because the client talks to the server directly (not a
web page), no CORS setting, `OLLAMA_ORIGINS` or browser permission is involved.

**Admission.** Before any prompt reaches it, the swarm sends six short prompts that your
server answers greedily (temperature 0, 32 tokens, thinking off); at least five answers
must match what Ternary Bonsai 2 27B says (recorded with llama.cpp PQ2_0 and PTQ1_0 and the
browser runtime — all identical). The model id your server reports must contain
"bonsai". Then one 128-token answer is timed **by the swarm's server**, frame by frame,
and must reach 5 tokens/s. The parent model Qwen3.8-27B matches 0 of 6 and is refused. This
catches the honest mistake — a wrong file — not a determined cheater, who could patch
the client; see SECURITY.md.

LM Studio (port 1234) and Ollama (port 11434) speak the same API and will work the same
way once they can load the Bonsai GGUF; as of 19 Sep 2026 they ship stock llama.cpp,
which rejects the `PQ2_0` / `PTQ1_0` formats.

## Providing through a browser

```bash
node bin/cli.js provide
```

The model can only run in a browser (WebGPU), so this launches one for you with
`--disable-background-timer-throttling --disable-backgrounding-occluded-windows
--disable-renderer-backgrounding`, a dedicated profile (so the 5.9 GB of weights are
kept between runs) and your token in the URL fragment, which never reaches a server log.
The CLI then prints live status: admission speed, requests served, AI Coins earned.

Close the browser window, or press Ctrl-C, to stop sharing.

## Consuming — three API shapes, one network

```bash
node bin/cli.js serve
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
node bin/cli.js litellm --port 4778
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
