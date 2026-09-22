import test from "node:test";
import assert from "node:assert/strict";
import { MonitorService, MonitorCoordinator } from "../src/delivery.js";
import { sendDiscord } from "../src/discord.js";
import worker, { monitor } from "../src/index.js";
import { NOW, ENV, MemoryStorage, rawEvent, sourceResponse, publishedResponse } from "./helpers.js";

function harness(env = {}) {
  const storage = new MemoryStorage();
  const h = { now: NOW, events: [], forecast: { official_signal: null }, feed: { tweets: [] }, posts: [], gets: 0, sourceReply: null, discordReply: null };
  const fetchImpl = async (url, options) => {
    if (String(url) === "https://codex-reset.com/api/forecast") return publishedResponse(h.forecast, h.now);
    if (String(url) === "https://codex-reset.com/api/feed") return publishedResponse(h.feed, h.now);
    if (String(url) === "https://codex-reset.com/api/timeline") {
      h.gets++;
      return h.sourceReply ? h.sourceReply() : sourceResponse(h.events, h.now);
    }
    assert.equal(new URL(url).hostname, "discord.com", "unexpected network call");
    assert.equal(new URL(url).searchParams.get("wait"), "true");
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    h.posts.push(payload.content);
    return h.discordReply ? h.discordReply() : Response.json({ id: String(1000 + h.posts.length) });
  };
  const service = new MonitorService(storage, { ...ENV, ...env }, { clock: () => h.now, fetchImpl });
  h.service = service;
  h.storage = storage;
  h.run = async (events = h.events) => {
    h.events = events;
    h.now += 60_001;
    return service.poll();
  };
  return h;
}

function promise(id, at = NOW - 14 * 3_600_000, end = NOW + 86_400_000) {
  return { tweet_id: id, kind: "signal", at: new Date(at).toISOString(), url: `https://x.com/thsottiaux/status/${id}`,
    window: { start_at: new Date(at).toISOString(), end_at: new Date(end).toISOString(), target_at: new Date(end).toISOString(), target_kind: "deadline" } };
}

test("bootstrap announces a currently open promise older than one hour, but not archived resets", async () => {
  const h = harness(); h.forecast.official_signal = promise("100");
  const result = await h.run([rawEvent("1", { announced_at: "2025-01-01T00:00:00Z" })]);
  assert.equal(result.initialized, true);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0], /리셋 예고/);
  await h.run(); assert.equal(h.posts.length, 1);
});

test("0.8 receipt and rank remain valid while an existing unannounced record gains its first watch", async () => {
  const h = harness();
  await h.storage.put("initialized", { at: NOW - 86_400_000 });
  await h.storage.put("event:1", { id: "1", group: "reset", announcedAt: NOW - 60_000, rank: 1, highestOffered: 1,
    deliveries: { reset: { status: "sent", messageId: "old-message" } } });
  await h.storage.put("event:100", { id: "100", group: "reset", announcedAt: NOW - 14 * 3_600_000,
    rank: 0, highestOffered: 0, deliveries: {}, baseline: true });
  h.forecast.official_signal = promise("100");
  await h.run([rawEvent("1")]);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0], /status\/100$/);
  assert.equal((await h.storage.get("event:1")).deliveries.reset.messageId, "old-message");
});

test("0.8 archived unknown credits do not replay merely because the newly added signal stage is eligible", async () => {
  const h = harness();
  await h.storage.put("initialized", { at: NOW - 86_400_000 });
  await h.storage.put("event:1", { id: "1", group: "credits", announcedAt: NOW - 10 * 86_400_000,
    rank: 0, highestOffered: 0, deliveries: {}, baseline: true });
  await h.run([rawEvent("1", { group: "credits", banked_state: "unknown", announced_at: new Date(NOW - 10 * 86_400_000).toISOString() })]);
  assert.equal(h.posts.length, 0);
  await h.run([rawEvent("1", { group: "credits", banked_state: "available", announced_at: new Date(NOW - 10 * 86_400_000).toISOString() })]);
  assert.equal(h.posts.length, 1, "an actual later state transition is still announced");
});

test("hint to promise, deadline correction and later confirmation each notify once", async () => {
  const h = harness(); await h.run([]);
  const at = NOW - 60_000;
  h.forecast.latest_hint = { id: "1", at: new Date(at).toISOString(), url: "https://x.com/thsottiaux/status/1" };
  await h.run();
  h.forecast.official_signal = promise("1", at);
  await h.run(); await h.run();
  h.forecast.official_signal = promise("1", at, NOW + 2 * 86_400_000);
  await h.run();
  h.forecast.official_signal = promise("1", at); await h.run();
  assert.equal(h.posts.length, 3, "reverting to an already announced deadline does not replay");
  h.now += 3 * 86_400_000;
  h.forecast = { official_signal: null, last_reset_at: new Date(h.now).toISOString() };
  await h.run([rawEvent("1")]);
  assert.equal(h.posts.length, 4);
  assert.match(h.posts[3], /리셋 발표/);
  assert.doesNotMatch(h.posts[3], /예고 마감/);
});

test("a prior hint does not swallow Tibo's new undated commitment for the same ID", async () => {
  const h = harness(); await h.run([]);
  const post = { id: "1", at: new Date(NOW - 60_000).toISOString(), url: "https://x.com/thsottiaux/status/1" };
  h.forecast.latest_hint = post;
  await h.run();
  h.forecast.official_signal = { ...post, tweet_id: post.id, kind: "signal", signal_type: "plain_commitment" };
  await h.run(); await h.run();
  assert.equal(h.posts.length, 2);
  assert.match(h.posts[1], /Tibo가 약속한 Codex 리셋 예고/);
  assert.match(h.posts[1], /적용 시각 미정/);
});

test("a reset discovered late after source downtime is not lost to the old post-age cutoff", async () => {
  const h = harness(); await h.run([]);
  const announced = h.now + 10 * 60_000;
  h.now += 3 * 3_600_000;
  await h.run([rawEvent("1", { announced_at: new Date(announced).toISOString() })]);
  assert.equal(h.posts.length, 1);
});

test("elapsed window never creates a completion or replays a promise", async () => {
  const h = harness(); h.forecast.official_signal = promise("1", NOW - 60_000, NOW + 180_000);
  await h.run(); assert.equal(h.posts.length, 1);
  h.now += 300_000; await h.run();
  assert.equal(h.posts.length, 1);
  assert.doesNotMatch(h.posts[0], /리셋 완료/);
});

test("an expired initial signal stays silent but an extended future window can notify", async () => {
  const h = harness(); h.forecast.official_signal = promise("1", NOW - 3_600_000, NOW - 1);
  await h.run(); assert.equal(h.posts.length, 0);
  h.forecast.official_signal = promise("1", NOW - 3_600_000, NOW + 86_400_000);
  await h.run(); assert.equal(h.posts.length, 1);
});

test("a 0.8 pending rate-limit receipt is retried, not mistaken for a sent notification", async () => {
  const h = harness();
  await h.storage.put("initialized", { at: NOW - 3600_000 });
  await h.storage.put("event:1", { id: "1", group: "reset", announcedAt: NOW - 60_000, rank: 0, highestOffered: 1,
    deliveries: { reset: { status: "pending", at: NOW - 60_000 } } });
  await h.run([rawEvent("1")]); assert.equal(h.posts.length, 1);
});

test("rate-limit retry budget is measured from discovery, not restarted on each poll", async () => {
  const h = harness(); await h.run([]);
  h.discordReply = () => Response.json({ retry_after: 60 }, { status: 429 });
  await h.run([rawEvent("1")]);
  h.now += 2 * 3_600_000; h.discordReply = null;
  await h.run(); assert.equal(h.posts.length, 1);
  assert.equal((await h.storage.get("event:1")).deliveries.reset.status, "expired");
});

test("first snapshot seeds historical and fresh events without a Discord call", async () => {
  const h = harness();
  const result = await h.run([rawEvent("1"), rawEvent("2", { announced_at: "2025-01-01T00:00:00Z" })]);
  assert.equal(result.initialized, true);
  assert.equal(h.posts.length, 0);
  assert.equal((await h.run()).notifications, 0);
});

test("new events send once, text/time edits and remove/reappear do not replay", async () => {
  const h = harness();
  await h.run([]);
  assert.equal((await h.run([rawEvent("1"), rawEvent("2", { group: "boost" })])).notifications, 2);
  await h.run([]);
  await h.run([rawEvent("1", { summary: "edited", announced_at: new Date(h.now).toISOString() }), rawEvent("2", { group: "boost" })]);
  assert.equal(h.posts.length, 2);
  assert.equal((await h.storage.get("event:1")).deliveries.reset.messageId, "1001");
});

test("pending baseline reset can become announced; old and future posts stay silent", async () => {
  const h = harness();
  await h.run([rawEvent("1", { announcement_state: "none" })]);
  await h.run([rawEvent("1"), rawEvent("old", { announced_at: "2025-01-01T00:00:00Z" }),
    rawEvent("future", { announced_at: new Date(NOW + 86_400_000).toISOString() })]);
  assert.equal(h.posts.length, 1);
  await h.run([rawEvent("old", { announced_at: new Date(h.now).toISOString() })]);
  assert.equal(h.posts.length, 1, "editing an old timestamp cannot resurrect an event");
});

test("banked unknown is a distinct signal; forward stages notify and regressions stay silent", async () => {
  const h = harness();
  await h.run([]);
  for (const state of ["unknown", "announced", "announced", "arriving", "unknown", "announced", "available", "arriving", "available"]) {
    await h.run([rawEvent("1", { group: "credits", banked_state: state })]);
  }
  assert.equal(h.posts.length, 4);
  assert.match(h.posts[0], /지급 미확인/);
  assert.match(h.posts[1], /지급 예고/);
  assert.match(h.posts[2], /지급 진행/);
  assert.match(h.posts[3], /사용 가능/);
});

test("reclassification quarantines permanently instead of generating a second category alert", async () => {
  const h = harness();
  await h.run([]);
  await h.run([rawEvent("1")]);
  await h.run([rawEvent("1", { group: "credits", banked_state: "available" })]);
  await h.run([rawEvent("1")]);
  assert.equal(h.posts.length, 1);
  assert.equal((await h.storage.get("event:1")).blocked, "reclassified");
});

test("observe mode needs no webhook and cannot send; diagnostics cannot seed delivery state", async () => {
  const h = harness({ NOTIFICATIONS_ENABLED: "false", DISCORD_WEBHOOK_URL: undefined });
  h.events = [rawEvent("1")];
  assert.equal((await h.service.poll(true)).notifications, 0);
  assert.equal(await h.storage.get("initialized"), undefined);
  await h.run([]);
  assert.equal((await h.run([rawEvent("2")])).wouldNotify, 1);
  assert.equal(h.posts.length, 0);
});

test("partial or conflicting baseline aborts atomically", async () => {
  const h = harness();
  await assert.rejects(h.run([rawEvent("1"), rawEvent("2", { url: "bad" })]), /incomplete_baseline/);
  assert.equal(await h.storage.get("initialized"), undefined);
  assert.equal((await h.storage.list({ prefix: "event:" })).size, 0);
  h.storage.failPut = (key) => key === "event:2";
  await assert.rejects(h.run([rawEvent("1"), rawEvent("2")]), /storage failure/);
  assert.equal(await h.storage.get("initialized"), undefined);
  assert.equal(await h.storage.get("event:1"), undefined);
});

test("source failure and restart respect persistent cooldown without advancing event state", async () => {
  const h = harness();
  await h.run([]);
  h.sourceReply = () => new Response("", { status: 429, headers: { "retry-after": "600" } });
  await assert.rejects(h.run([rawEvent("1")]), /source_rate_limited/);
  assert.equal(await h.storage.get("event:1"), undefined);
  const restarted = new MonitorService(h.storage, ENV, { clock: () => h.now, fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal((await restarted.poll()).skipped, "source_cooldown");
  assert.equal(h.posts.length, 0);
});

test("API response cache prevents repeated manual or concurrent polling inside a minute", async () => {
  const h = harness();
  await h.service.poll(true);
  await h.service.poll(true);
  assert.equal(h.gets, 1);
});

test("Discord 429 waits globally, then retries current fresh event only", async () => {
  const h = harness();
  await h.run([]);
  h.discordReply = () => Response.json({ retry_after: 600 }, { status: 429, headers: { "retry-after": "600" } });
  await h.run([rawEvent("1"), rawEvent("2")]);
  assert.equal(h.posts.length, 1);
  await h.run();
  assert.equal(h.posts.length, 1);
  h.now += 600_000;
  h.discordReply = null;
  await h.run();
  assert.equal(h.posts.length, 3);
  assert.equal((await h.storage.get("event:1")).deliveries.reset.status, "sent");
});

test("ambiguous send latches one event, later events resume without duplicating earlier success", async () => {
  const h = harness();
  await h.run([]);
  h.discordReply = () => {
    if (h.posts.length === 2) throw new Error("https://secret-in-webhook-error");
    return Response.json({ id: String(1000 + h.posts.length) });
  };
  await h.run([rawEvent("1"), rawEvent("2"), rawEvent("3")]);
  assert.equal(h.posts.length, 2);
  assert.equal((await h.storage.get("event:2")).blocked, "delivery-unknown");
  await h.run();
  assert.equal(h.posts.length, 3);
  assert.match(h.posts[2], /status\/3$/);
  assert.equal((await h.service.poll(true)).reviewCount, 1);
});

test("a sent message whose receipt cannot be saved is never blindly retried", async () => {
  const h = harness();
  await h.run([]);
  h.storage.failPut = (key, value) => key === "event:1" && value.deliveries?.reset?.status === "sent";
  await assert.rejects(h.run([rawEvent("1")]), /storage failure/);
  assert.equal((await h.storage.get("event:1")).deliveries.reset.status, "attempting");
  h.storage.failPut = null;
  await h.run();
  assert.equal(h.posts.length, 1);
  assert.equal((await h.storage.get("event:1")).blocked, "delivery-unknown");
});

test("coordinator serializes across network awaits", async () => {
  const h = harness();
  await h.run([]);
  h.events = [rawEvent("1")]; h.now += 60_001;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  h.discordReply = async () => { await waiting; return Response.json({ id: "55" }); };
  const coordinator = new MonitorCoordinator({ storage: h.storage }, ENV);
  coordinator.service = h.service;
  const request = () => new Request("https://internal/poll", { method: "POST" });
  const a = coordinator.fetch(request());
  const b = coordinator.fetch(request());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.posts.length, 1);
  release();
  await Promise.all([a, b]);
  assert.equal(h.posts.length, 1);
});

test("a future timestamp correction cannot borrow the older cached announcement time", async () => {
  const h = harness();
  await h.run([rawEvent("1", { announcement_state: "none" })]);
  await h.run([rawEvent("1", { announced_at: new Date(NOW + 86_400_000).toISOString() })]);
  assert.equal(h.posts.length, 0);
});

test("a source snapshot expiring during a batch leaves remaining events for another fresh poll", async () => {
  const h = harness();
  await h.run([]);
  h.discordReply = () => { h.now += 180_001; return Response.json({ id: "123" }); };
  const result = await h.run([rawEvent("1"), rawEvent("2")]);
  assert.equal(h.posts.length, 1);
  assert.equal(result.skipped.source_expired_during_run, 1);
  h.discordReply = null;
  await h.run();
  assert.equal(h.posts.length, 2);
});

test("a coordinator failure is sanitized and does not poison the next queued request", async () => {
  const h = harness();
  h.sourceReply = () => { throw new Error("credential-in-error"); };
  const coordinator = new MonitorCoordinator({ storage: h.storage }, ENV);
  coordinator.service = h.service;
  const first = await coordinator.fetch(new Request("https://internal/poll"));
  assert.equal(first.status, 503);
  assert.doesNotMatch(await first.text(), /credential/);
  h.sourceReply = null; h.now += 60_001;
  const next = await coordinator.fetch(new Request("https://internal/poll"));
  assert.equal(next.status, 200);
});

test("Discord transport distinguishes rejection, ambiguous success and server failures", async () => {
  for (const [response, status] of [
    [() => new Response("", { status: 401 }), "rejected"],
    [() => new Response("", { status: 503 }), "delivery-unknown"],
    [() => Response.json({}), "delivery-unknown"],
    [() => Response.json({ id: "123" }), "sent"],
  ]) {
    assert.equal((await sendDiscord(ENV, "test", { fetchImpl: async () => response() })).status, status);
  }
});

test("public route protection and default-off Discord test gate", async () => {
  const request = (path, token) => new Request(`https://worker.test${path}`, {
    method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await worker.fetch(request("/run"), {})).status, 401);
  assert.equal((await worker.fetch(request("/run", "bad"), { SMOKE_TEST_TOKEN: "test-token" })).status, 401);
  assert.equal((await worker.fetch(request("/test-discord", "test-token"), { SMOKE_TEST_TOKEN: "test-token" })).status, 403);
  assert.equal((await worker.fetch(request("/unknown"), {})).status, 404);
  assert.equal((await worker.fetch(request("/preview-poll"), {})).status, 404);
  assert.equal((await worker.fetch(request("/preview-poll", "test-token"), { SMOKE_TEST_TOKEN: "test-token", PREVIEW_POLL_ENABLED: "true", NOTIFICATIONS_ENABLED: "true" })).status, 403);
  const names = [];
  const env = { MONITOR: { idFromName: (name) => { names.push(name); return name; }, get: () => ({ fetch: async () => Response.json({}) }) } };
  await monitor(env); await monitor({ ...env, NOTIFICATIONS_ENABLED: "true" }); await monitor(env, "discord-test");
  assert.equal(new Set(names).size, 3, "observe, live and test state must be separate");
});

test("explicit test permission is required and a completed or uncertain test cannot replay", async () => {
  const h = harness();
  await assert.rejects(h.service.testDiscord(), /discord_test_disabled/);
  assert.equal(h.posts.length, 0);
  h.service.env.DISCORD_TEST_ENABLED = "true";
  assert.equal((await h.service.testDiscord()).notifications, 1);
  assert.equal((await h.service.testDiscord()).notifications, 0);
  assert.match(h.posts[0], /실제 리셋 아님/);
  assert.equal(h.posts[0].split("\n").length, 3);
});
