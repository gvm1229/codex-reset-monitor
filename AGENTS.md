# Tibo Codex Monitor — Project Context

## Purpose

This project is a fully cloud-hosted Cloudflare Worker that monitors the public
X posts of OpenAI Product Lead Tibo (`@thsottiaux`) for verified announcements
about OpenAI Codex usage-limit resets or quota/limit increases.

It was created to replace a local Codex scheduled task. The local task has been
deleted; this Worker is the only active scheduler and must remain independent
of the user's PC.

## Runtime architecture

```text
Cloudflare Cron (every five minutes)
  -> Cloudflare Worker
  -> official X API v2 (Bearer Token)
  -> Cloudflare Workers AI (new-post semantic classification)
  -> Cloudflare KV duplicate/state store
  -> Discord webhook
```

- Worker: `tibo-codex-monitor`
- Public Worker URL: `https://tibo-codex-monitor.hojini1229.workers.dev`
- Schedule: `*/5 * * * *` (UTC), running every five minutes. The same minute
  offsets apply in KST.
- KV binding: `STATE`; it is pinned in `wrangler.jsonc`.
- Cloudflare Observability is enabled.

## Source-of-truth and detection rules

- The only source of truth is Tibo's official X account/posts.
- The Worker uses the official X API, never web search, Reddit, blogs, RSS, or
  third-party monitoring summaries.
- It caches Tibo's numeric user ID, then reads the user timeline using
  `since_id`; retweets are excluded, and at most 5 posts are requested per
  check to control X API usage.
- Each newly returned post is classified by Cloudflare Workers AI using
  `@cf/meta/llama-3.1-8b-instruct-fast`; empty X API polls never invoke AI.
- The LLM is a semantic gate only. X remains the source of truth, and the
  Worker calculates KST timestamps and duplicate prevention deterministically.
- If Workers AI fails or emits invalid structured output, the previous strict
  regex logic remains as the safe fallback.
- A post is relevant only when it mentions `Codex`, a usage/rate/quota/limit
  concept, and a reset or increase concept.
- A notification is sent only for posts created within the preceding hour.
- KV stores `last_seen_id` and per-post notification markers for 90 days to
  prevent duplicate alerts.

## Reset-time and Discord output contract

The Worker must derive an exact reset time in KST:

- Already-completed resets use the X post timestamp.
- Relative times such as `in N hours` are calculated from the post timestamp.
- Explicit Pacific times such as `2 PM PT` are converted using
  `America/Los_Angeles`, including DST, then rendered in KST.
- For a completed reset, never guess its time; only use the X post timestamp
  or an exact, parseable time expression.
- A confirmed scheduled reset whose wording provides only an imprecise near-future
  time (for example, "in a few minutes") is still alert-worthy. The alert must
  say it is imminent and show the announcement time in KST, rather than invent
  an exact reset timestamp.

For a completed reset, Discord content must contain three text lines separated
by blank lines:

```text
🚨 **Tibo로부터 Codex 리셋 감지!** 🚨

**리셋 시각(KST)**: YYYY-MM-DD HH:mm KST

https://fixupx.com/thsottiaux/status/{post-id}
```

For a confirmed imminent reset without an exact time, use the future-tense
title `Codex 리셋 예정 감지!`, show the announcement time in KST, and say
`곧 리셋될 예정입니다.` The three text lines must likewise be separated by
blank lines.

FixupX is a preview-only link. It is not used for discovery, verification, or
classification. Do not include the X post text or original X link in alerts.

## Secrets and security

Configured Cloudflare Worker secrets:

- `X_BEARER_TOKEN`
- `DISCORD_WEBHOOK_URL`

Never place credential values in source files, `.dev.vars`, `wrangler.jsonc`,
chat, logs, or commits. The Discord webhook was previously exposed during
setup; regenerate it if exposure is suspected again.

`SMOKE_TEST_TOKEN` is optional. The protected `POST /run` smoke-test endpoint
returns `401` when it is not configured; do not make it public merely to test
the Worker.

## Local development and deployment

From this directory:

```powershell
npm install
npm run check
npm test
npx wrangler deploy
```

Use `npx wrangler tail` for live logs. In Cloudflare, use
**Workers & Pages -> tibo-codex-monitor -> Observability** for stored logs.

When changing behavior:

1. Update `src/index.js` and add/update unit tests under `test/`.
2. Keep the source-of-truth, exact-KST, and three-line Discord-output contracts
   unless the user explicitly changes them.
3. Run `npm run check` and `npm test` before deploying.
4. Deploy with `npx wrangler deploy` and confirm the expected schedule/bindings
   in output.
5. Use a protected, temporary test route only when necessary; remove it and
   redeploy immediately after testing.

Deleting `node_modules` is safe. The source directory is not needed for the
already-deployed Worker to keep running, but retain it (or back it up in a
private repository) for future maintenance. Deleting the local Wrangler auth
configuration only logs the developer out locally; it does not affect Cloudflare
deployment, Cron, KV, or secrets.
