import test from "node:test";
import assert from "node:assert/strict";

import {
  determineResetTime,
  determineResetTimeFromClassification,
  buildAlertContent,
  formatKst,
  isRelevantLimitAnnouncement,
  normalizeClassification,
} from "../src/index.js";

test("recognizes an already-completed Codex reset", () => {
  const posted = "2026-07-15T09:30:00.000Z";
  const resetAt = determineResetTime("We have reset the usage limits across Codex.", posted);
  assert.equal(resetAt.toISOString(), posted);
  assert.equal(formatKst(resetAt), "2026-07-15 18:30 KST");
});

test("calculates a relative reset time from the post timestamp", () => {
  const resetAt = determineResetTime(
    "Codex usage limits will reset in 3 hours.",
    "2026-07-15T09:30:00.000Z",
  );
  assert.equal(formatKst(resetAt), "2026-07-15 21:30 KST");
});

test("converts an explicit PDT clock time to KST", () => {
  const resetAt = determineResetTime(
    "Codex rate limits will reset at 2 PM PT today.",
    "2026-07-15T16:00:00.000Z",
  );
  assert.equal(formatKst(resetAt), "2026-07-16 06:00 KST");
});

test("rejects irrelevant posts", () => {
  assert.equal(isRelevantLimitAnnouncement("Codex is great today."), false);
  assert.equal(determineResetTime("Codex is great today.", "2026-07-15T09:30:00.000Z"), null);
});

test("does not guess a past Pacific clock time", () => {
  const resetAt = determineResetTime(
    "Codex usage limits will reset at 2 PM PT.",
    "2026-07-15T23:00:00.000Z",
  );
  assert.equal(resetAt, null);
});

test("uses the post time for an LLM-confirmed reset with nonstandard wording", () => {
  const posted = "2026-07-16T04:22:00.000Z";
  const resetAt = determineResetTimeFromClassification(
    "We just gave Codex substantially more room to work.",
    posted,
    { decision: "alert", status: "already_effective" },
  );
  assert.equal(resetAt.toISOString(), posted);
  assert.equal(formatKst(resetAt), "2026-07-16 13:22 KST");
});

test("validates Workers AI structured output before acting on it", () => {
  assert.deepEqual(
    normalizeClassification('{"decision":"alert","status":"already_effective"}'),
    { decision: "alert", status: "already_effective" },
  );
  assert.equal(normalizeClassification("not json"), null);
  assert.equal(normalizeClassification({ decision: "alert", status: "invented" }), null);
});

test("announces an ambiguously timed scheduled reset in the future tense", () => {
  const content = buildAlertContent(
    { id: "123", created_at: "2026-07-16T04:14:09.000Z" },
    { decision: "alert", status: "scheduled" },
    null,
  );
  assert.match(content, /리셋 예정 감지/);
  assert.match(content, /곧 리셋될 예정입니다/);
  assert.match(content, /2026-07-16 13:14 KST/);
  assert.match(content, /감지!\*\* 🚨\n\n\*\*안내 시각/);
});
