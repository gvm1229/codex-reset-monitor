import test from "node:test";
import assert from "node:assert/strict";
import { MonitorService } from "../src/delivery.js";
import { HEAD_KEY, comparePosition, headFromRecords } from "../src/head.js";
import { ENV, MemoryStorage, NOW, rawEvent, publishedResponse, sourceResponse } from "./helpers.js";

function fixture() {
  const storage = new MemoryStorage();
  const h = { storage, now: NOW, events: [], forecast: { official_signal: null }, feed: { tweets: [] }, posts: [], discordReply: null };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/timeline") return sourceResponse(h.events, h.now);
    if (path === "/api/forecast") return publishedResponse(h.forecast, h.now);
    if (path === "/api/feed") return publishedResponse(h.feed, h.now);
    if (new URL(url).hostname === "discord.com") {
      h.posts.push(String(url));
      return h.discordReply ? h.discordReply() : Response.json({ id: String(h.posts.length) });
    }
    throw new Error("Unexpected outbound request");
  };
  h.service = new MonitorService(storage, ENV, { fetchImpl, clock: () => h.now });
  h.run = async (events = h.events) => { h.events = events; h.now += 60_001; return h.service.poll(); };
  return h;
}

test("head uses publication time then opaque ID, not a numeric maximum", () => {
  const earlier = { id: "zz", announcedAt: NOW - 1 };
  const later = { id: "a", announcedAt: NOW };
  assert.equal(comparePosition(later, earlier), 1);
  assert.equal(comparePosition({ id: "b", announcedAt: NOW }, later), 1);
  assert.equal(comparePosition({ id: "a", announcedAt: NOW }, later), 0);
});

test("an active Tibo commitment alerts despite an older ID and no precise window", async () => {
  const h = fixture();
  await h.storage.put("initialized", { at: NOW - 10 * 60_000 });
  await h.storage.put(HEAD_KEY, { "reset-watch": { id: "900", announcedAt: NOW - 60_000 } });
  const at = new Date(NOW - 6 * 3_600_000).toISOString();
  h.forecast = { official_signal: { tweet_id: "100", kind: "signal", signal_type: "plain_commitment", at,
    url: "https://x.com/thsottiaux/status/100" } };
  const first = await h.run([]);
  assert.equal(first.notifications, 1);
  assert.equal(h.posts.length, 1);
  assert.equal((await h.storage.get("event:100")).deliveries["reset-watch"].status, "sent");
  await h.run([]);
  assert.equal(h.posts.length, 1, "repeating the same commitment must not replay");
  assert.equal((await h.storage.get(HEAD_KEY))["reset-watch"].id, "900", "older active evidence cannot move the head backward");
});

test("first initialization stores event receipts and per-kind heads atomically", async () => {
  const h = fixture();
  await h.run([rawEvent("200"), rawEvent("300", { group: "credits", banked_state: "unknown" })]);
  const head = await h.storage.get(HEAD_KEY);
  assert.equal(head.reset.id, "200");
  assert.equal(head["banked-sign"].id, "300");
  assert.equal(h.posts.length, 0);
  const incomplete = fixture();
  await assert.rejects(incomplete.run([rawEvent("200"), rawEvent("bad", { url: "bad" })]), /incomplete_baseline/);
  assert.equal(await incomplete.storage.get(HEAD_KEY), undefined);
});

test("head blocks a late old ID yet sends each genuinely newer ID in one poll", async () => {
  const h = fixture();
  const at = new Date(NOW - 60_000).toISOString();
  await h.run([rawEvent("200", { announced_at: at })]);
  const result = await h.run([rawEvent("199", { announced_at: at }), rawEvent("200", { announced_at: at }), rawEvent("201", { announced_at: at }), rawEvent("202", { announced_at: at })]);
  assert.equal(result.notifications, 2);
  assert.equal(result.skipped.before_source_head, 1);
  assert.equal((await h.storage.get(HEAD_KEY)).reset.id, "202");
  assert.equal((await h.storage.get("event:199")).rank, 1);
  await h.run();
  assert.equal(h.posts.length, 2);
});

test("a restarted coordinator retains the head and cannot replay an older unseen ID", async () => {
  const h = fixture(); const at = new Date(NOW - 60_000).toISOString();
  await h.run([rawEvent("200", { announced_at: at })]);
  h.service = new MonitorService(h.storage, ENV, { clock: () => h.now,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/timeline") return sourceResponse(h.events, h.now);
      if (path === "/api/forecast") return publishedResponse(h.forecast, h.now);
      if (path === "/api/feed") return publishedResponse(h.feed, h.now);
      throw new Error("Discord must not be called");
    } });
  const result = await h.run([rawEvent("199", { announced_at: at })]);
  assert.equal(result.notifications, 0);
  assert.equal(result.skipped.before_source_head, 1);
});

test("migration reconstructs 0.8 heads without erasing receipts, keeping stages separate", async () => {
  const h = fixture();
  await h.storage.put("initialized", { at: NOW - 5 * 60_000 });
  await h.storage.put("event:900", { id: "900", group: "reset", announcedAt: NOW - 60_000,
    rank: 0, highestOffered: 0, deliveries: {} });
  await h.storage.put("event:100", { id: "100", group: "reset", announcedAt: NOW - 120_000,
    rank: 1, highestOffered: 1, deliveries: { reset: { status: "sent", messageId: "old" } } });
  await h.storage.put("event:700", { id: "700", group: "credits", announcedAt: NOW - 60_000,
    rank: 2, highestOffered: 2, deliveries: { "banked-arriving": { status: "sent", messageId: "old-credit" } } });
  assert.deepEqual(headFromRecords((await h.storage.list({ prefix: "event:" })).values()), {
    "reset-sign": { id: "900", announcedAt: NOW - 60_000 },
    reset: { id: "100", announcedAt: NOW - 120_000 },
    "banked-arriving": { id: "700", announcedAt: NOW - 60_000 },
  });
  await h.run([rawEvent("200", { announced_at: new Date(NOW - 90_000).toISOString() })]);
  assert.equal(h.posts.length, 1, "a later hint does not suppress a newer confirmed reset");
  assert.equal((await h.storage.get("event:100")).deliveries.reset.messageId, "old");
  assert.equal((await h.storage.get(HEAD_KEY)).reset.id, "200");
});

test("a partial Discord run advances only through fully processed events", async () => {
  const h = fixture(); await h.run([]);
  let sends = 0;
  h.discordReply = () => ++sends === 2 ? new Response("", { status: 503 }) : Response.json({ id: String(sends) });
  const at = new Date(NOW).toISOString();
  await h.run(["101", "102", "103"].map((id) => rawEvent(id, { announced_at: at })));
  assert.equal((await h.storage.get(HEAD_KEY)).reset.id, "101");
  assert.equal(await h.storage.get("event:103"), undefined);
  h.discordReply = null;
  await h.run();
  assert.equal((await h.storage.get("event:102")).blocked, "delivery-unknown");
  assert.equal((await h.storage.get(HEAD_KEY)).reset.id, "103");
  assert.equal(h.posts.length, 3);
});

test("invalid source entries cannot move a head past an item that may be fixed later", async () => {
  const h = fixture(); await h.run([]);
  const at = new Date(NOW).toISOString();
  await h.run([rawEvent("201", { announced_at: at }), rawEvent("bad", { url: "bad" })]);
  assert.equal((await h.storage.get(HEAD_KEY)).reset, undefined);
  await h.run([rawEvent("199", { announced_at: at })]);
  assert.equal(h.posts.length, 2, "both valid items survive a partially malformed snapshot");
});
