# Tibo Codex monitor

Cloudflare Worker that polls Tibo's official X timeline every five minutes, detects verified
Codex usage-limit resets or increases, and posts a compact Korean Discord alert.

This Worker uses Workers AI as a bounded semantic classifier for newly retrieved
posts. AI output is accepted only when confidence and exact source evidence pass
validation; deterministic JavaScript remains authoritative for time extraction,
KST conversion, state, freshness, and duplicate prevention. AI failures fall
back to the deterministic classifier.

The monitor requests the full `note_tweet` field for long-form X posts, follows
timeline pagination before advancing its cursor, and keeps short-lived KV
context so a timing-only follow-up can be correlated with a preceding Codex
rate-limit announcement. Banked-reset credits use their own notification type
and are never presented as an automatic usage-limit reset.

Usage-reset and banked-reset contexts are stored under independent KV keys. A
timing-only follow-up is assigned to the newest compatible pending context, so
an intervening usage event cannot erase a banked-reset announcement.

## Required Worker secrets

- `X_BEARER_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `SMOKE_TEST_TOKEN` (optional; `/run` returns `401` when omitted)

Never commit those values. Configure them with `npx wrangler secret put <NAME>`.

## Deploy

```powershell
npm install
npx wrangler login
npx wrangler deploy
```

The Worker configuration pins the `STATE` KV namespace. The first production
run creates the stored X user ID and cursor. It also records a non-secret
`monitor_run_state` heartbeat so scheduled X API failures are visible during
operational diagnosis.

## Alert format

Alerts always contain exactly three lines. The first line says either
`리셋 완료 감지` or `리셋 예정 감지` according to the announcement and the
derived reset time. The second line is the exact KST reset time, and the third
line is the FixupX preview URL.

Banked-reset alerts also contain exactly three lines. An initial announcement
is sent immediately even when its time is unknown. A later exact-time post
produces a second alert that explicitly identifies itself as the clarification
for the previously announced banked reset.

## Smoke test

```powershell
$token = Read-Host "SMOKE_TEST_TOKEN"
Invoke-RestMethod -Method Post -Uri "https://<worker>.workers.dev/run" -Headers @{ Authorization = "Bearer $token" }
```

The `/run` endpoint is intentionally protected by `SMOKE_TEST_TOKEN` and only
sends a diagnostic test notification; it never sends a production alert.

`POST /ai-health` uses the same protection and classifies a fixed synthetic
reset sentence without reading X, writing KV, or sending Discord. It returns
only aggregate classifier status and is unavailable when `SMOKE_TEST_TOKEN` is
not configured.
