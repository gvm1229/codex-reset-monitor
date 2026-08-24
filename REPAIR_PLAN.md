# X monitor repair plan — 2026-08-24

1. Inspect the Worker, tests, configuration, and deployed/logged state to determine why no X posts have been read since 2026-08-13.
2. Reproduce the supplied real-post cases as deterministic fixtures, including completed resets, relative future resets, banked-reset announcements, and follow-up timing posts.
3. Strengthen collection/state handling and reset-event correlation so follow-up posts can supply an exact time without treating preliminary announcements as actual resets.
4. Make Discord wording accurately distinguish completed and future resets while preserving the exact three-line alert contract.
5. Run static checks and the full test suite, deploy a numbered preview only if deployment is needed and authorized, and verify Cloudflare schedule/bindings/log evidence without exposing secrets.

## Completion criteria

- The Aug 13 collection failure has an evidence-backed cause and fix.
- All supplied post scenarios have regression coverage and correct notify/suppress behavior.
- Exact KST reset times are derived from post/follow-up timestamps without guessing.
- Local checks and tests pass; any live-only verification limits are explicitly recorded.

## Results

- Implemented full `note_tweet` ingestion and bounded timeline pagination. The
  cursor is not advanced on partial X API errors or an excessive backlog.
- Added KV-backed context correlation for timing-only follow-ups and a distinct
  two-notification flow for banked-reset announcements and clarifications.
- Added completed/scheduled three-line Discord wording and exact relative/PT
  time handling, including the observed `14pm PST tomorrow` form.
- Added regression coverage for both screenshots and all five supplied X post
  IDs/scenarios. The final suite passes 24/24 with Wrangler dry-run validation.
- Initial live Cloudflare verification was unavailable until the user restored
  Wrangler login; the later production evidence is recorded below.

## Requirement correction — banked resets

- Banked resets are a separate notification category, not a suppression case.
- A vague banked-reset announcement immediately produces its own notification
  with an explicitly unknown availability time and is retained as context.
- A later timing clarification produces a second notification that explicitly
  identifies the time as belonging to the previously announced banked reset.
- The alert explicitly says `BANKED 리셋` and uses `지급 시각(KST)` so it cannot
  be confused with an automatic usage-limit reset.

## Context and tense hardening

1. Store usage-reset and banked-reset pending contexts independently so one
   event type cannot overwrite the other.
2. Treat a timing-only reset follow-up as a banked clarification when a live
   banked announcement context exists, even when the follow-up omits the word
   `banked`.
3. Preserve the tense stated by Tibo: scheduled announcements remain scheduled
   until an explicit completed-reset post is observed; elapsed expected time is
   not proof of completion.
4. Add deterministic regression coverage, run local checks, deploy, temporarily
   use one-minute Cron verification, then restore the stable five-minute Cron.
5. Verify from official Cloudflare and X documentation whether pricing tier,
   AI inference, or partial long-form fields caused the historical misses.

## Context and tense hardening results

- Usage and banked pending contexts now use independent KV keys.
- A timing-only follow-up can clarify the newest banked announcement without
  repeating the word `banked`.
- Scheduled announcements remain scheduled even if their expected time has
  elapsed; only explicit completed wording produces a completed alert.
- Static check and 16 deterministic tests pass. Production verification on a
  temporary one-minute schedule passed three consecutive runs with zero errors,
  then the configuration was restored to five minutes.
- Source inspection confirmed there is no AI binding or model call. Official X
  documentation identifies `note_tweet` as the full long-form text field; the
  historical truncation was an API field-selection bug, not model quality.

## Workers AI hybrid classifier plan

1. Add a Workers AI binding and call a small instruction model only for newly
   retrieved posts, never for empty Cron runs.
2. Provide the complete `note_tweet.text`, post timestamp, and bounded pending
   usage/banked context; request a strict structured classification with event
   type, status, relationship, time expression, and confidence.
3. Treat AI output as advisory. Reuse deterministic relevance and exact-time
   parsing, reject unsupported or hallucinated time claims, and preserve the
   existing no-guess notification rules.
4. Fall back to the deterministic classifier on quota, capacity, model, JSON,
   timeout, or low-confidence failures so AI cannot stop monitoring.
5. Record aggregate AI use/fallback counts without tweet text or credentials,
   add deterministic mocked tests, deploy on a temporary one-minute schedule,
   verify production inference, then restore the stable five-minute schedule.

## Workers AI hybrid classifier results

- Added the `AI` binding and JSON Mode classification with
  `@cf/meta/llama-3.1-8b-instruct-fast`.
- AI calls occur only for newly retrieved posts; empty Cron runs consume no AI
  inference. Aggregate call, accepted, and fallback counts are recorded.
- Exact source evidence and confidence are required. Hallucinated time strings
  and nonexistent context relationships are discarded before policy handling.
- Model errors, quota/capacity failures, invalid output, low confidence, and
  deterministic conflicts fall back without stopping the monitor.
- A remote Workers AI health call passed with `aiAccepted: true` and no fallback.
  Local static checks and 21 tests pass, including novel wording, hallucinated
  time rejection, quota fallback, and ordinary-post handling.
- The AI-enabled production Worker passed three consecutive one-minute Cron
  runs. Each had no new posts and therefore correctly made zero AI calls. The
  stable schedule was then restored to `*/5 * * * *`.

## Live deployment evidence

- Deployed the corrected Worker as version
  `d6aaa9d8-c880-44e9-85d6-b8e9117f312e` with the `STATE` KV binding and
  `*/5 * * * *` schedule.
- The first observed production Cron at `2026-08-23T23:00:31Z` reached the X
  API and recorded `401 Unauthorized` in `monitor_run_state`.
- Production collection was blocked until the user replaced the invalid or
  revoked `X_BEARER_TOKEN`; credential values were never shared in chat.
- After token replacement, the X API authenticated successfully but exposed a
  backlog larger than the original 100-post safety cap. Recovery now reads
  newest-first pages until the full 36-hour event/context window is covered,
  then safely advances the cursor without paying to scan irrelevant old posts.
- During production verification only, Cron is temporarily changed from every
  five minutes to every minute. After consecutive successful runs establish
  stability, restore `*/5 * * * *` and deploy the final schedule.
- One-minute production verification passed three consecutive runs: the first
  recovered 20 recent posts with zero stale alerts, and the next two each read
  zero new posts with zero notifications. The stable schedule was then restored
  to `*/5 * * * *`.
- The final AI-enabled five-minute deployment is Worker version
  `40fa1176-bfb6-42d1-8c7f-288995562c5d`.
