# Ship concern map — 2026-08-24

## 1. Reliable X timeline ingestion

- Intent: read complete long-form posts, recover bounded backlog pages, and
  refuse cursor advancement on partial API responses.
- Hunks: timeline request/pagination and monitor clock plumbing in
  `src/index.js`; focused integration coverage in `test/timeline.test.js`.
- Verification: `node --check src/index.js` and `node --test test/timeline.test.js`.
- Commit: `fix: recover complete X timeline posts`

## 2. Reset event state and safe classification

- Intent: distinguish completed/scheduled usage resets and two-stage banked
  resets, preserve independent pending contexts, calculate exact KST times, and
  replace the repository's original permissive AI gate with evidence-bound
  structured classification plus deterministic fallback.
- Hunks: event analysis, AI schema/validation, KV context handling, Discord
  rendering, and corresponding cases in `src/index.js` and
  `test/logic.test.js`. These replace the same original classifier pipeline and
  are mechanically inseparable without a broken intermediate revision.
- Verification: `npm run check` and the complete logic test file.
- Commit: `fix: validate reset events and context`

## 3. Operational diagnostics

- Intent: expose the protected synthetic AI health check, record aggregate AI
  counters and scheduled success/error state, without logging post text.
- Hunks: `/ai-health`, scheduled heartbeat, and aggregate monitor result fields
  in `src/index.js`.
- Verification: full tests, Wrangler dry-run, remote AI health result, and
  previously observed production Cron evidence.
- Commit: `feat: add monitor diagnostics`

## 4. Operational documentation

- Intent: document runtime contracts, alert behavior, verification workflow,
  repair evidence, and the shipped concern map.
- Files: `README.md`, `AGENTS.md`, `REPAIR_PLAN.md`, `SHIP_PLAN.md`.
- Verification: `git diff --check` and documentation review.
- Commit: `docs: document reset monitor operation`
