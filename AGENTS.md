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
  -> deterministic JavaScript intent and time classification
  -> Cloudflare KV duplicate/state store
  -> Discord webhook
```

- Worker: `tibo-codex-monitor`
- Public Worker URL: `https://tibo-codex-monitor.hojini1229.workers.dev`
- Schedule: `*/5 * * * *` (UTC), running every five minutes. The same minute
  offsets apply in KST.
- KV binding: `STATE`; it is pinned in `wrangler.jsonc`.
- Cloudflare Observability is enabled.
- Cloudflare Workers AI is not used. `src/classifier.js` deterministically
  decides relevance, event type, tense, follow-up linkage, and supported
  equivalent renewal wording; `src/time.js` performs exact time arithmetic.
- Successful Cron runs do not write a KV heartbeat. Errors are recorded only
  when they occur, and there is no persistent classification retry queue.

## Source-of-truth and detection rules

- The only source of truth is Tibo's official X account/posts.
- The Worker uses the official X API, never web search, Reddit, blogs, RSS, or
  third-party monitoring summaries.
- It caches Tibo's numeric user ID, then reads the user timeline using
  `since_id`; retweets are excluded, each page requests at most 5 posts, and
  all available pages are consumed before the cursor advances so recovery
  after downtime cannot silently skip posts.
- Long-form posts use X API v2's `note_tweet.text`. A short-lived KV context
  connects a Codex rate-limit announcement to a later timing-only follow-up.
- Usage and banked contexts use independent KV keys. JavaScript selects a
  compatible context and requires an explicit reply ID to match when present.
- Banked-reset credits are not automatic usage-limit resets. They produce a
  distinct three-line BANKED-reset notification immediately, even if the exact
  availability time is unknown. A later time clarification produces a second
  notification explicitly tied to the preceding banked-reset announcement.
- JavaScript rules recognize explicit resets, increases, supported indirect
  renewal wording, and timing-only follow-ups. Questions, wishes, negations,
  personal metaphors, and replies to a different post must not alert.
- A notification is sent only for posts created within the preceding hour.
- KV stores `last_seen_id` and per-post notification markers for 90 days to
  prevent duplicate alerts.

## Reset-time and Discord output contract

The Worker must derive an exact reset time in KST:

- Already-completed resets use the X post timestamp.
- Relative times such as `in N hours` are calculated from the post timestamp.
- Explicit Pacific times such as `2 PM PT` are converted using
  `America/Los_Angeles`, including DST, then rendered in KST.
- If timing is ambiguous, do not notify; never guess.

For a real detection, Discord content must contain exactly three lines. The
headline must reflect whether the reset is complete or still scheduled:

```text
🚨 **Tibo로부터 Codex 리셋 {완료|예정} 감지!** 🚨
**리셋 시각(KST)**: YYYY-MM-DD HH:mm KST
https://fixupx.com/thsottiaux/status/{post-id}
```

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
6. For live Cron verification, temporarily use `* * * * *` so tests run every
   minute. After consecutive successful runs establish stability, restore
   `*/5 * * * *`, redeploy, and verify the final schedule before closing work.

Deleting `node_modules` is safe. The source directory is not needed for the
already-deployed Worker to keep running, but retain it (or back it up in a
private repository) for future maintenance. Deleting the local Wrangler auth
configuration only logs the developer out locally; it does not affect Cloudflare
deployment, Cron, KV, or secrets.
