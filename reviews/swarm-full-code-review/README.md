# Full code review (swarm, 2026-09-18)

Six isolated worktrees reviewed `main` at `6bf4960`. Each worker wrote `REVIEW.md`; those reports are committed here as one file per slice. There was no product-code diff in any worktree.

**Verdict:** the untrusted-provider design is real. Several documented controls are not.

| Slice | Status | Report |
|---|---|---|
| Coordinator / runtime | ISSUES | [01-coordinator-runtime.md](./01-coordinator-runtime.md) |
| Auth / sessions | ISSUES | [02-auth-sessions.md](./02-auth-sessions.md) |
| Coins / ledger | ISSUES | [03-coins-ledger.md](./03-coins-ledger.md) |
| HTTP / OpenAI API | ISSUES | [04-http-api.md](./04-http-api.md) |
| Public frontend | ISSUES | [05-public-frontend.md](./05-public-frontend.md) |
| CLI / tests / ops | ISSUES | [06-cli-tests-ops.md](./06-cli-tests-ops.md) |

No worker dropped. Highs below were spot-checked against the tree after aggregation.

## High

1. Public fake GPU: `share.html?provider=mock` runs `mockWorker()` without `TEST_MODE_KEY`.
2. Login CSRF + GPU hijack: `#token=` plus `?autostart=1` signs a logged-out visitor into the token’s account and starts sharing.
3. HTTPS logout does not clear the session cookie (`maxAge: 0` is dropped; `Secure`/`HttpOnly` omitted on clear).
4. `RUNTIME_SHA256` is not checked on the disk-cache fallback.
5. Admission demotion is undone by the next `benchmark` frame.
6. `jobs.error` stores up to 300 characters of provider-chosen text.
7. In-flight coin reservation shrinks with streamed tokens and is deleted before debit.
8. Local `serve` / `litellm` can spend coins with no caller auth; logs still say localhost-only.
9. Persistent Chrome profile plus autostart after a 409 hand-off keeps sharing as the previous account.
10. E2E mock providers are eligible in `pickProvider` against a live deployment.

## What holds

One job per socket, re-queue on drop before the first token, self-serve skip, server-side token count, delta truncation, 16 KB WebSocket cap, minutes paid per account, `post()` debit guard, Argon2id, hashed API tokens, parameterized SQL, HttpOnly + SameSite=Lax, consumer identity not on `job.start`.
