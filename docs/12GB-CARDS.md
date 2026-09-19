# Why a 12 GB card was "too slow", and what changed (19 Sep 2026)

A volunteer with an **RTX 3060 12 GB** (i5-12600K, 64 GB RAM, Windows, Edge 153) was
refused as a provider: the browser benchmark said **5.4–5.6 tokens/s** (four sessions:
5.59, 5.53, 1.71, 5.37; time to first token ~2.4 s) against a bar of 10. The same card
runs `Ternary-Bonsai-2-27B-PQ2_0.gguf` at **30–35 tokens/s** in llama.cpp. Video memory
went from 0.7 to 9.2 of 12 GB, so the model fitted — no spill.

## What was checked, and what it showed

Test machine: RunPod **RTX 2000 Ada 16 GB** (224 GB/s memory bandwidth — *less* than the
3060's 360 GB/s, similar compute), Google Chrome 153 under Xvfb, WebGPU on Vulkan, the
same runtime and the same calls as `public/js/bonsai-worker.js`.

| Suspect | Test | Result |
| --- | --- | --- |
| Benchmark measures warm-up / shader compile | 24-token benchmark three times in a row, then 128 tokens | 16.6 / 15.7 / 16.6 / 16.6 tok/s — no warm-up effect. `load()` already compiles every kernel and tunes the decode pipeline before the benchmark runs |
| Context length (`maxLength`) | 1,024 / 4,096 / 16,384 | 16.5 / 16.5 / 16.5 tok/s — decode speed does not depend on it |
| Missing `chromium-experimental-subgroup-matrix` (his Edge does not have it; our earlier RTX 3090 test ran with `--enable-unsafe-webgpu`, which adds it) | disabled it on the pod | 16.6 → 16.4 tok/s — no effect on decode |
| `shader-f16` kernel path (his D3D12 adapter has f16; the Linux Vulkan adapter does not by default) | forced f16 on with `--enable-dawn-features=vulkan_enable_f16_on_nvidia`, and off | 16.5 either way. First token: 2.34 s with f16, 1.03 s without — the 2.4 s in his sessions is this f16 prompt path, so his browser takes the same kernels |
| requestAnimationFrame stalls in a background tab | — | not applicable: the model already runs in a Web Worker, which has no rAF |
| Real answers vs. the benchmark | 92-token answer through `generate()` | 14.0 tok/s including the first token |
| llama.cpp on the same card | `llama-bench` tg128, PrismML build b10709 | PQ2_0 25.5, PTQ1_0 24.4 tok/s |

His `chrome://gpu`: D3D12 backend, NVIDIA driver 32.0.16.1692, `shader-f16` and
`subgroups` present, `subgroup-matrix` absent, no software fallback — a healthy adapter.

**Conclusion.** Nothing in our code slows a 12 GB card down: the kernel path, the context
length and the benchmark method all measure the same on the test card. A card with 38 %
less memory bandwidth than his reaches 16.5 tok/s in Chrome on Linux, his reaches 5.5 in
Edge on Windows. The other NVIDIA browsers in the database measured 0.8–3.0 tok/s (their
operating system is not recorded), an Apple M-series 15.7. The remaining factor is the WebGPU
path on Windows (Dawn's D3D12 backend or the NVIDIA driver under it), which is outside
this repository. We could not reproduce Windows itself: no Windows GPU machine was
available for the test. This is a measured correlation, not a proven root cause.

## What changed

1. **Admission bar 10 → 5 tokens/s.** 5 tok/s is about 220 words a minute — the speed
   people read — so an answer at that speed streams no slower than it is read. Measured:
   RTX 3090 42 · RTX 2000 Ada 16.5 · Apple M-series 15.7 · RTX 3060 on Windows 5.4–5.6 ·
   8 GB laptop that spills out of VRAM 2.1–3.0 (still refused) · older NVIDIA cards (Turing,
   Pascal) 0.8–1.0 (still refused). The server still times every real answer and drops a provider after
   two answers below 3 tok/s.
2. **Faster providers first.** The coordinator ranks ready providers by the speed *it*
   has timed (a browser's own claim counts for at most 20 tok/s until it has been timed)
   and picks at random among those within 75 % of the fastest. A 5 tok/s machine only
   gets a prompt when every faster one is busy.
3. **The requester sees the speed** ("answering on … · ~N tok/s"), using the server's own
   measurement when there is one.
4. **An honest refusal.** A slow browser is told the number, the bar, that on Windows
   this is often the browser and not the card, and what to do instead; the model is
   unloaded so the graphics memory is freed.
5. **Share from llama.cpp** (the volunteer's idea): `node bin/cli.js provide --local
   http://127.0.0.1:8080`. The swarm checks the model (six greedy answers must match Bonsai
   2 27B's — `server/integrity.js`; the parent Qwen3.8-27B matches 0 of 6) and times it
   before admitting it.
6. **Storage.** `navigator.storage.persist()` is still requested on the Start click; the
   page now explains in plain words what a "no" means (the browser *may* delete the model
   when the disk runs low) and how to make it permanent (install the site as an app —
   there is now a web app manifest — or bookmark it).
7. The benchmark runs twice and keeps the better run, so a one-second hiccup does not
   decide admission.

## Why the command-line relay and not the browser tab

A tab on `https://bonsai-swarm.app.mintapis.com` *could* call `http://127.0.0.1:8080`
itself, but it would need CORS on the local server (llama-server allows it by default,
LM Studio needs "Enable CORS", Ollama `OLLAMA_ORIGINS=https://bonsai-swarm.app.mintapis.com`),
Chrome's local-network-access permission prompt, and a tab that stays open and unthrottled
— different in every browser. The command-line client needs none of that: it talks to
the local server as a normal program and to the swarm over the same WebSocket a browser
uses, with the API token it already stores. Nothing on the volunteer's machine is opened
to the network.

## Raw data

The pod logs (JSON lines per measurement) are kept with the job notes on Sandy
(`~/jobs/bonsai-12gb-fix-20260919/pod/`).
