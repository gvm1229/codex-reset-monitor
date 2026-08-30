# Tibo Codex monitor

Cloudflare Worker that polls Tibo's official X timeline every five minutes,
detects verified Codex usage-limit resets or increases, and posts a compact
Korean Discord alert.

Meaning and timing are determined locally by deterministic JavaScript. The
rules cover completed resets, scheduled relative or Pacific times, indirect
usage renewal, limit increases, BANKED reset credits, and timing-only replies.
Questions, wishes, negations, personal reset metaphors, and unrelated replies
are rejected. Cloudflare Workers AI is not used.

The monitor reads complete `note_tweet.text`, paginates before advancing its
`since_id` cursor, and validates explicit X reply linkage for timing follow-ups.
Usage and BANKED contexts use independent short-lived KV keys. Per-post markers
prevent duplicate notifications for 90 days.

## Required Worker secrets

- `X_BEARER_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `SMOKE_TEST_TOKEN` (optional; `/run` returns `401` when omitted)

Never commit those values. Configure them with `npx wrangler secret put <NAME>`.

## Check and deploy

```powershell
npm install
npm run check
npm test
npx wrangler deploy
```

The pinned `STATE` KV namespace stores only the cached X user ID, timeline
cursor, short-lived event contexts, and duplicate markers. Successful Cron runs
do not write a heartbeat, and there is no AI retry queue.

## Alert contract

Every normal reset alert contains exactly three lines:

```text
🚨 **Tibo로부터 Codex 리셋 {완료|예정} 감지!** 🚨
**리셋 시각(KST)**: YYYY-MM-DD HH:mm KST
https://fixupx.com/thsottiaux/status/{post-id}
```

Completed resets use the official X post timestamp. Relative times are derived
from that timestamp. Pacific times use `America/Los_Angeles`, including DST,
and are rendered in KST. Ambiguous timing is never guessed.

BANKED reset credits remain a distinct three-line notification type. An initial
announcement may state that the time is unknown; a later exact-time reply
produces a second clarification notification.

## Smoke test

```powershell
$token = Read-Host "SMOKE_TEST_TOKEN"
Invoke-RestMethod -Method Post -Uri "https://<worker>.workers.dev/run" -Headers @{ Authorization = "Bearer $token" }
```

The protected `/run` endpoint sends a diagnostic message only. It never sends a
production reset alert.
