import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeSnapshot } from "../src/signals.js";
import { activeSignal, normalizeWindow, selectNotification, notificationKey } from "../src/events.js";
import { buildDiscordContent } from "../src/discord.js";
import { fetchSnapshot } from "../src/source.js";
import { NOW, ENV, rawEvent, publishedResponse } from "./helpers.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/dated-reset-signal.json", import.meta.url)));
const post = (id = "1", fields = {}) => ({ id, at: new Date(NOW - 60_000).toISOString(), url: `https://x.com/thsottiaux/status/${id}`, ...fields });
const window = (end = NOW + 86_400_000) => ({ start_at: new Date(NOW - 60_000).toISOString(), end_at: new Date(end).toISOString(), target_at: new Date(end).toISOString(), target_kind: "deadline" });

test("observed Tuesday fixture combines three APIs into one watch and the exact KST deadline", () => {
  const result = normalizeSnapshot(fixture.timeline, fixture.forecast, fixture.feed);
  assert.equal(result.events.length, 1);
  const event = result.events[0], notification = selectNotification(event);
  assert.equal(notification.kind, "reset-watch");
  assert.equal(activeSignal(event, Date.parse(fixture.observed_at)), true, "14-hour-old open promise remains actionable");
  const content = buildDiscordContent(event, notification);
  assert.match(content, /예고 마감\(KST\).*2026-09-23 15:59:59 KST까지/);
  assert.match(content, /Tibo가 약속한 Codex 리셋 예고/);
  assert.match(content, /확정 시각 아님/);
  assert.equal(content.split("\n").length, 3);
  assert.equal(event.summary, undefined);
});

test("weak hints and banked unknown claims are included without using raw prose", () => {
  const result = normalizeSnapshot({ events: [] }, { official_signal: null, latest_hint: post("1") }, {
    tweets: [post("2", { kind: "banked", banked_state: "unknown" }), post("3", { kind: "codex", tease_classification: { status: "ok", teasing: true } }),
      post("4", { kind: "codex", text: "reset tomorrow", tease_classification: { status: "pending", teasing: true } }), post("5", { kind: "candidate" })],
  });
  assert.deepEqual(result.events.map((e) => selectNotification(e).kind), ["reset-sign", "banked-sign", "reset-sign", "reset-sign"]);
});

test("model probabilities and historical likely-hours alone cannot manufacture a reset signal", () => {
  assert.equal(normalizeSnapshot({ events: [] }, { official_signal: null, probabilities: { rounded_24h: 99 }, time_window: { start_hour: 15 } }, { tweets: [] }).events.length, 0);
});

test("an explicitly active undated official promise does not expire at an invented age limit", () => {
  const result = normalizeSnapshot({ events: [] }, { official_signal: post("1", { kind: "signal", at: new Date(NOW - 10 * 86_400_000).toISOString() }) }, { tweets: [] });
  assert.equal(activeSignal(result.events[0], NOW), true);
});

test("latest banked alerts and explicitly banked forecast hints retain their own family", () => {
  const forecast = { official_signal: null, latest_hint: post("1", { kind: "banked" }),
    latest_alert: { ...post("2"), kind: "banked", state: "arriving" } };
  assert.deepEqual(normalizeSnapshot({ events: [] }, forecast, { tweets: [] }).events.map((e) => selectNotification(e).kind), ["banked-sign", "banked-arriving"]);
});

test("expired and superseded forecasts never turn into completed resets", () => {
  const forecast = { official_signal: post("1", { kind: "signal", window: window(NOW - 1) }) };
  let result = normalizeSnapshot({ events: [] }, forecast, { tweets: [] });
  assert.equal(activeSignal(result.events[0], NOW), false);
  assert.equal(selectNotification(result.events[0]).kind, "reset-watch");
  forecast.last_reset_at = new Date(NOW).toISOString();
  assert.equal(normalizeSnapshot({ events: [] }, forecast, { tweets: [] }).events.length, 0);
});

test("a newer confirmed reset suppresses old unconfirmed feed/timeline hints but never banked grants", () => {
  const result = normalizeSnapshot({ events: [rawEvent("1", { announcement_state: "none" }), rawEvent("2", { group: "credits", banked_state: "unknown" })] },
    { official_signal: null, last_reset_at: new Date(NOW).toISOString() }, { tweets: [post("1", { kind: "signal" })] });
  assert.deepEqual(result.events.map((event) => event.id), ["2"]);
});

test("deadline, center and range are validated distinctly; invalid or conflicting clocks are withheld", () => {
  assert.equal(normalizeWindow(window()).kind, "deadline");
  const center = { ...window(), target_kind: "center", target_at: new Date(NOW + 3_600_000).toISOString() };
  assert.equal(normalizeWindow(center).kind, "center");
  const range = { start_at: center.start_at, end_at: center.end_at };
  assert.equal(normalizeWindow(range).kind, "range");
  assert.equal(normalizeWindow({ ...window(), target_at: new Date(NOW).toISOString() }), null);
  const official = post("1", { kind: "signal", window: window() });
  const latest = { ...post("1"), kind: "watch", state: "active", window: window(NOW + 2 * 86_400_000) };
  const result = normalizeSnapshot({ events: [rawEvent("1", { announcement_state: "none", official_window: window() })] }, { official_signal: official, latest_alert: latest }, { tweets: [post("1", { kind: "signal", window: window() })] });
  assert.equal(result.events[0].window, null, "later duplicate cannot restore a disputed deadline");
  assert.equal(result.events[0].windowInvalid, true);
  assert.match(buildDiscordContent(result.events[0], selectNotification(result.events[0])), /適用|적용 시각 미정/);
});

test("same ID contradictions cannot bypass timeline quarantine via another endpoint", () => {
  const result = normalizeSnapshot({ events: [rawEvent("1"), rawEvent("1", { url: "bad" })] }, { official_signal: post("1", { kind: "signal" }) }, { tweets: [] });
  assert.equal(result.events.length, 0);
  assert.ok(result.conflicts > 0);
});

test("clock revisions change identity but prose, probability and confirmation clocks do not", () => {
  const a = normalizeSnapshot({ events: [] }, { official_signal: post("1", { kind: "signal", window: window() }) }, { tweets: [] }).events[0];
  const b = { ...a, window: normalizeWindow(window(NOW + 2 * 86_400_000)) };
  assert.notEqual(notificationKey(a, selectNotification(a)), notificationKey(b, selectNotification(b)));
  const done = { ...a, announcementState: "announced" };
  assert.equal(notificationKey(done, selectNotification(done)), "reset");
  assert.doesNotMatch(buildDiscordContent(done, selectNotification(done)), /예고 마감/);
});

test("all three reads are bounded and atomic, including longest Retry-After on mixed failures", async () => {
  const requested = [];
  await assert.rejects(fetchSnapshot(ENV, { clock: () => NOW, fetchImpl: async (url) => {
    requested.push(url);
    if (url.endsWith("timeline")) return new Response("", { status: 503 });
    if (url.endsWith("forecast")) return new Response("", { status: 429, headers: { "retry-after": "900" } });
    return publishedResponse({ tweets: [] });
  } }), (error) => error.code === "source_rate_limited" && error.retryAt === NOW + 900_000);
  assert.equal(requested.length, 3);
});
