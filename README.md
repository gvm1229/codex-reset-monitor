# Tibo Codex monitor

Cloudflare Worker that polls Tibo's official X timeline hourly, detects verified
Codex usage-limit resets or increases, and posts a compact Korean Discord alert.

## Required Worker secrets

- `X_BEARER_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `SMOKE_TEST_TOKEN`

Never commit those values. Configure them with `npx wrangler secret put <NAME>`.

## Deploy

```powershell
npm install
npx wrangler login
npx wrangler deploy
```

The Worker configuration uses automatic KV provisioning for the `STATE` binding.
The first production run creates the stored X user ID and cursor.

## Smoke test

```powershell
$token = Read-Host "SMOKE_TEST_TOKEN"
Invoke-RestMethod -Method Post -Uri "https://<worker>.workers.dev/run" -Headers @{ Authorization = "Bearer $token" }
```

The `/run` endpoint is intentionally protected by `SMOKE_TEST_TOKEN` and only
sends a diagnostic test notification; it never sends a production alert.
