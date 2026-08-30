# JS Intent Restore and Missed-Alert Recovery Plan

- Run ID: `js-intent-restore-2026-08-30`
- Target: `tibo-codex-monitor` Cloudflare Worker and its existing Discord webhook
- Retry budget: at most two implementation/test correction attempts per failed criterion; no repeated live Discord send
- Usage budget: no subagents or model dispatches; local deterministic tests only; one production deploy for recovery and one cleanup deploy after delivery evidence

## Dependency graph and criteria

1. `evidence` — Verify the Cloudflare KV alert, the two official Tibo posts, their timestamps/text, and the current deployed/source behavior.
   - Evidence: sanitized email facts, official X post payloads, and source/deployment inspection.
   - Verifier: deterministic comparison against exact post IDs and timestamps.
2. `restore-js` (depends on `evidence`) — Remove Workers AI classification/retry behavior and restore deterministic JavaScript intent and time parsing without weakening source, freshness, duplicate, or pagination rules.
   - Evidence: no runtime `env.AI.run`, AI model, or AI retry queue; targeted unit tests cover both posts.
   - Verifier: syntax checks, static search, and unit tests.
3. `verify-alerts` (depends on `restore-js`) — Prove the two posts produce two distinct three-line notifications with exact KST times and FixupX links.
   - Evidence: exact expected strings in deterministic tests.
   - Verifier: independent test assertions over line count, status wording, timestamp, and post ID.
4. `recover-live` (depends on `verify-alerts`) — Deploy a bounded one-time missed-alert recovery, observe exactly one delivery per post, then remove recovery-only behavior.
   - Evidence: deployment output, live run/marker evidence, and no duplicate delivery on re-run.
   - Verifier: production KV/observability state without exposing secrets.
5. `close` (depends on `recover-live`) — Restore `*/5 * * * *`, confirm bindings contain KV but no Workers AI, rerun checks/tests, and update project documentation.
   - Evidence: final deploy output, schedule/binding inspection, clean static search, and passing test suite.
   - Verifier: deterministic local checks plus Cloudflare deployment metadata.

## Boundaries

- Do not expose or copy the X bearer token or Discord webhook.
- Do not use web search, third-party summaries, or FixupX as evidence; official X content is authoritative.
- Do not send more than one recovery notification for either requested post.
- Stable publishing beyond the existing Worker deployment is out of scope.

## Ship concern map — 2026-08-30

1. **Deterministic monitor runtime and regression coverage**
   - Intent: remove Workers AI and its retry/heartbeat behavior; split
     deterministic classification and exact-time parsing into focused modules;
     retain safe timeline collection, context linkage, duplicate prevention,
     and the protected smoke-test route.
   - Files: `src/index.js`, `src/classifier.js`, `src/time.js`,
     `wrangler.jsonc`, `package.json`, `test/logic.test.js`, and
     `test/timeline.test.js`.
   - Verification: `npm run check`, `npm test`, and `npx wrangler deploy --dry-run`.
   - Commit: `fix: restore deterministic reset detection`
2. **Runtime-contract documentation**
   - Intent: make the project instructions, public README, and repair record
     accurately describe the JavaScript-only classifier, no-success-heartbeat
     operation, and completed recovery evidence.
   - Files: `README.md`, `AGENTS.md`, `REPAIR_PLAN.md`, and this plan.
   - Verification: documentation review and `git diff --check`.
   - Commit: `docs: document deterministic monitor logic`

## Completion evidence

- Official X/KV evidence fixed the source posts at `2026-08-29T20:43:34Z`
  and `2026-08-29T20:43:53Z`; the second explicitly replies to the first.
- JavaScript regression tests produce `2026-08-30 05:43 KST` completed and
  `2026-08-30 06:30 KST` scheduled alerts, each with exactly three lines.
- Temporary recovery version `b41ae1d4-0245-41c0-9307-81d9dc5f7545` ran on a
  one-minute Cron. Both Discord success markers were observed as `1` afterward.
- Recovery-only code was removed. Final version
  `07ea6697-c177-4477-a661-d5cc89bdb198` exposes only the `STATE` binding and
  runs on `*/5 * * * *`.
- The final live Cron completed successfully with `classifier: javascript`,
  zero new posts, and zero duplicate notifications.
- The obsolete `ai_retry_posts_v1` and stale `monitor_run_state` KV keys were
  deleted. Successful Cron runs no longer write a heartbeat.
