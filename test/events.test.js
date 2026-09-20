import test from "node:test";
import assert from "node:assert/strict";
import { absoluteTime, normalizeTimeline, selectNotification, eventFreshness } from "../src/events.js";
import { buildDiscordContent, previewUrl } from "../src/discord.js";
import { formatKst } from "../src/time.js";
import { NOW, rawEvent } from "./helpers.js";

const normalize = (event) => normalizeTimeline({ events: [event] }).events[0];

test("documented fields alone select resets, boosts and known banked states", () => {
  const cases = [
    [{}, "reset"], [{ announcement_state: "none" }, null], [{ announcement_state: undefined }, null],
    [{ group: "boost", announcement_state: "none" }, "boost"],
    ...["announced", "arriving", "available"].map((s) => [{ group: "credits", banked_state: s }, `banked-${s}`]),
    [{ group: "credits", banked_state: "unknown", reset_kind: "banked" }, null],
    [{ group: "credits" }, null], [{ group: "unlock" }, null], [{ group: "new-group" }, null],
  ];
  for (const [fields, kind] of cases) assert.equal(selectNotification(normalize(rawEvent("1", fields)))?.kind ?? null, kind);
});

test("raw text cannot cause an alert and unknown fields never survive normalization", () => {
  const event = normalize(rawEvent("1", { announcement_state: "none", text: "Codex RESET now", summary: "@everyone", latest_alert: { state: "confirmed" } }));
  assert.equal(selectNotification(event), null);
  assert.equal(event.text, undefined);
  assert.equal(event.summary, undefined);
  assert.equal(event.latest_alert, undefined);
});

test("conflicting IDs and malformed events are quarantined, identical duplicates collapse", () => {
  const a = rawEvent("opaque-id");
  const result = normalizeTimeline({ events: [a, a, rawEvent("2"), rawEvent("2", { group: "boost" }), rawEvent("3", { announced_at: "yesterday" }), null] });
  assert.deepEqual(result.events.map((e) => e.id), ["opaque-id"]);
  assert.equal(result.conflicts, 2);
  assert.equal(result.invalid, 2);
  assert.throws(() => normalizeTimeline({}), /invalid_timeline/);
  assert.throws(() => normalizeTimeline({ events: new Array(5001) }), /invalid_timeline/);
});

test("invalid counterpart cannot leave a valid duplicate eligible", () => {
  assert.equal(normalizeTimeline({ events: [rawEvent("1"), rawEvent("1", { url: "bad" })] }).events.length, 0);
});

test("absolute times reject missing zones and impossible calendar values", () => {
  for (const value of [null, "2026-09-21", "2026-09-21T00:00:00", "2026-02-30T00:00:00Z", "2026-09-21T24:00:00Z", "2026-09-21T00:00:00+24:00"]) {
    assert.ok(Number.isNaN(absoluteTime(value)), String(value));
  }
  assert.equal(absoluteTime("2026-09-21T09:00:00+09:00"), NOW);
  assert.equal(eventFreshness(NOW - 3_600_000, NOW), null);
  assert.equal(eventFreshness(NOW - 3_600_001, NOW), "outside_notification_window");
  assert.equal(eventFreshness(NOW + 60_001, NOW), "future_announcement");
});

test("all notification kinds render three lines, announcement KST, attribution and no post text", () => {
  for (const fields of [{}, { group: "boost" }, ...["announced", "arriving", "available"].map((s) => ({ group: "credits", banked_state: s }))]) {
    const event = normalize(rawEvent("2098685367058612394", { ...fields, announced_at: "2026-09-12T08:09:17Z", text: "SECRET_TEXT" }));
    const content = buildDiscordContent(event, selectNotification(event));
    assert.equal(content.split("\n").length, 3);
    assert.match(content, /발표 시각\(KST\).*2026-09-12 17:09 KST/);
    assert.match(content, /출처: https:\/\/codex-reset.com\//);
    assert.match(content, /https:\/\/fixupx.com\/thsottiaux\/status\/2098685367058612394$/);
    assert.doesNotMatch(content, /SECRET_TEXT|리셋 완료/);
  }
  assert.equal(formatKst("2026-12-31T15:00:00Z"), "2027-01-01 00:00 KST");
});

test("links reject host spoofing and credentials and never echo unknown URLs", () => {
  for (const url of ["https://x.com.evil.test/a/status/1", "https://user:pass@x.com/a/status/1", "javascript:alert(1)", "https://example.test/@everyone"]) {
    assert.equal(previewUrl(url), "https://codex-reset.com/timeline");
  }
});
