# Security model

Bonsai Swarm hands strangers' prompts to strangers' browsers. That shapes every rule
here. An independent review of this code found four ways a malicious volunteer could
have taken over or minted coins; all four are fixed, and the tests in
`tests/unit/network.test.js` keep them fixed.

## What is trusted, and what is not

| | trusted? |
| --- | --- |
| The account behind a WebSocket (cookie or API token) | yes — it is authenticated |
| Anything that WebSocket *says* about its hardware | **no** |
| The number of tokens a provider claims to have produced | **no** — the coordinator counts what it relayed |
| The length of a streamed delta | **no** — capped, one frame is one token |
| `x-forwarded-for` | only when `TRUST_PROXY=1`, and then the last hop |

## The specific guarantees

* **A provider cannot buy traffic by lying.** The self-measured benchmark is clamped and
  never ranks providers: a job goes to a *random* ready provider, so a liar's share is
  1/N. The server then times every job it relays and drops the admission of a provider
  whose real throughput does not hold up.
* **One frame is one token, and a token is short.** Frames longer than
  `PROVIDER_MAX_DELTA_CHARS` are truncated, and the WebSocket has a 16 KB payload cap,
  so a provider cannot bill a paragraph as a token or flood the relay.
* **Minutes are paid per account, not per socket**, with at most three provider sockets
  per account: opening tabs does not multiply the reward.
* **Payouts come out of what was actually charged.** If a consumer's debit had to be
  clamped, the provider's credit shrinks by the same fraction — no coins are created.
* **One account's requests are serialised**, so two parallel requests cannot both pass
  the same balance check. A balance can never go negative.
* **You never serve your own prompts**, so you cannot farm coins in a circle.
* **Prompts are never stored.** Jobs keep token counts, timings and status — no text, on
  either side, in the database or in the logs.
* **A fallback answer cannot be passed off as a volunteer's.** The label is written by the
  coordinator, from the job record, in the chat and in the API
  (`x-bonsai-served-by`, `bonsai_swarm.served_by`), and the job row keeps `served_by` and
  `fallback_model` so a claim can be checked afterwards. No volunteer is ever paid for
  one, so it cannot be used to mint coins either.
* **A provider never learns who asked**, and a consumer never learns whose GPU answered
  beyond an anonymous label.
* **The CLI never puts an API token in a URL**: it exchanges it for a single-use,
  60-second hand-off code, and the hand-off refuses a browser already signed in as
  somebody else.

## The free fallback model

When no volunteer is online, a free hosted model answers instead (see the README). That
puts a third party on the path, and it is worth being explicit about what that means:

* **Your prompt leaves this network.** It is sent to whichever upstream the deployment
  has configured, under that provider's terms and retention, not ours. Which model
  answered is named on every such answer, so you always know when this happened — and it
  only happens when the swarm could not answer at all.
* **Nothing else is sent with it.** No account, no address, no identifier: the upstream
  receives the messages and nothing more.
* **The upstream is not trusted either.** Its reply is streamed as text and never
  inspected or executed, its own error text is never passed through to the consumer, and
  an upstream that stalls is cut off by a timeout rather than holding a request open.
* **It is rationed** per account, per address and per day, so a script cannot turn
  somebody else's free tier into a bill.
* **It is optional.** With no upstream configured the feature is off and the network is
  purely peer-to-peer.

## Known, accepted risks

* **A volunteer can return garbage.** Nothing here verifies that the text a browser
  produces is really the model's output. Random dispatch and the demotion rule limit the
  blast radius; a reputation or spot-check scheme would be the next step.
* **The WebGPU runtime is fetched from a third-party Hugging Face space** and served from
  our own origin under a CSP that needs `unsafe-eval` (WebAssembly). If that space were
  compromised, the code would run in every volunteer's browser. Set `RUNTIME_SHA256` to
  the sha shown by `/api/stats` to freeze the copy you reviewed.
* **Points are not money**, so the economics of abuse are mild by construction. Please
  still report anything you find.
* **The fallback's answers are as trustworthy as the upstream behind them.** Nothing here
  verifies them, exactly as nothing verifies a volunteer's output.

## Reporting

Open an issue at https://github.com/fstandhartinger/bonsai-swarm/issues, or, for
anything you would rather not post publicly, say so in the issue and ask for a contact.
