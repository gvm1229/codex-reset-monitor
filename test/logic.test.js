import test from "node:test";
import assert from "node:assert/strict";

import worker, {
  analyzeResetAnnouncement,
  buildDiscordContent,
  formatKst,
  monitor,
} from "../src/index.js";

const FIRST_POST = {
  id: "2093801758665715784",
  created_at: "2026-08-29T20:43:34.000Z",
  conversation_id: "2093801758665715784",
  text: "We are reseting usage for all paid users of Codex and ChatGPT Work. Please continue reading for an update on Codex usage limits. Depending on how you use Codex, you should see your usage go between 10% and 50% further than before. Goes without saying that we’re resetting usage limits and I hope you enjoy a very nice Saturday!",
};

const FOLLOW_UP = {
  id: "2093801838504186008",
  created_at: "2026-08-29T20:43:53.000Z",
  conversation_id: FIRST_POST.id,
  referenced_tweets: [{ id: FIRST_POST.id, type: "replied_to" }],
  text: "Landing 2:30pm PST",
};

function createEnv(values = new Map()) {
  return {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };
}

test("the two missed official posts produce the exact two KST alerts", () => {
  const first = analyzeResetAnnouncement(FIRST_POST.text, FIRST_POST.created_at, null, FIRST_POST);
  assert.equal(first.kind, "reset");
  assert.equal(first.announcedAs, "completed");
  assert.equal(formatKst(first.resetAt), "2026-08-30 05:43 KST");

  const context = {
    sourcePostId: FIRST_POST.id,
    createdAt: FIRST_POST.created_at,
    expiresAt: Date.parse(FIRST_POST.created_at) + 36 * 60 * 60 * 1000,
    resetType: "usage",
  };
  const followUp = analyzeResetAnnouncement(
    FOLLOW_UP.text,
    FOLLOW_UP.created_at,
    { usage: context, banked: null },
    FOLLOW_UP,
  );
  assert.equal(followUp.kind, "reset");
  assert.equal(followUp.announcedAs, "scheduled");
  assert.equal(followUp.clarificationOf, FIRST_POST.id);
  assert.equal(followUp.resetAt.toISOString(), "2026-08-29T21:30:00.000Z");
  assert.equal(formatKst(followUp.resetAt), "2026-08-30 06:30 KST");

  assert.equal(buildDiscordContent(first, FIRST_POST.id), [
    "🚨 **Tibo로부터 Codex 리셋 완료 감지!** 🚨",
    "**리셋 시각(KST)**: 2026-08-30 05:43 KST",
    `https://fixupx.com/thsottiaux/status/${FIRST_POST.id}`,
  ].join("\n"));
  assert.equal(buildDiscordContent(followUp, FOLLOW_UP.id), [
    "🚨 **Tibo로부터 Codex 리셋 예정 감지!** 🚨",
    "**리셋 시각(KST)**: 2026-08-30 06:30 KST",
    `https://fixupx.com/thsottiaux/status/${FOLLOW_UP.id}`,
  ].join("\n"));
});

test("monitor sends both missed-post shapes once when they are fresh", async (t) => {
  const originalFetch = globalThis.fetch;
  const deliveries = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.x.com/")) {
      return Response.json({ data: [FOLLOW_UP, FIRST_POST], meta: {} });
    }
    deliveries.push(JSON.parse(init.body).content);
    return new Response(null, { status: 204 });
  };
  const values = new Map([["tibo_user_id", "123"]]);
  const result = await monitor(createEnv(values), { now: Date.parse("2026-08-29T20:50:00.000Z") });
  assert.equal(result.notifications, 2);
  assert.equal(result.classifier, "javascript");
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[0], /완료 감지[\s\S]*05:43 KST/);
  assert.match(deliveries[1], /예정 감지[\s\S]*06:30 KST/);
  assert.equal(deliveries[0].split("\n").length, 3);
  assert.equal(deliveries[1].split("\n").length, 3);
  assert.equal(values.get(`notified:${FIRST_POST.id}`), "1");
  assert.equal(values.get(`notified:${FOLLOW_UP.id}`), "1");
  assert.equal(values.get("last_seen_id"), FOLLOW_UP.id);
});

test("completed, relative and Pacific scheduled reset forms remain supported", () => {
  const completed = analyzeResetAnnouncement(
    "We have reset usage limits for all paid users of Codex.",
    "2026-07-15T09:30:00.000Z",
  );
  assert.equal(completed.announcedAs, "completed");
  assert.equal(completed.resetAt.toISOString(), "2026-07-15T09:30:00.000Z");

  const relative = analyzeResetAnnouncement(
    "Codex usage limits will reset in 3 hours.",
    "2026-07-15T09:30:00.000Z",
  );
  assert.equal(formatKst(relative.resetAt), "2026-07-15 21:30 KST");

  const pacific = analyzeResetAnnouncement(
    "Codex rate limits will reset at 2 PM PT today.",
    "2026-07-15T16:00:00.000Z",
  );
  assert.equal(formatKst(pacific.resetAt), "2026-07-16 06:00 KST");

  const renewed = analyzeResetAnnouncement(
    "Brand new usage for all ChatGPT Work and Codex users.",
    "2026-08-27T16:35:05.000Z",
  );
  assert.equal(renewed.announcedAs, "completed");

  const fast = analyzeResetAnnouncement(
    "Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
    "2026-08-13T01:01:37.748Z",
  );
  assert.equal(fast.resetAt.toISOString(), "2026-08-13T02:01:37.748Z");
});

test("questions, wishes, negations and unrelated posts do not alert", () => {
  for (const text of [
    "Will Codex usage limits reset at 2 PM PT?",
    "I wish Codex usage would reset in one hour.",
    "Codex usage limits will not reset today.",
    "Codex is great today.",
    "Feeling reset after a nap. Codex is fun.",
  ]) {
    assert.equal(analyzeResetAnnouncement(text, "2026-08-29T20:00:00.000Z"), null, text);
  }
});

test("a reply to a different post cannot inherit the newest reset context", () => {
  const context = {
    sourcePostId: FIRST_POST.id,
    createdAt: FIRST_POST.created_at,
    expiresAt: Date.parse(FIRST_POST.created_at) + 36 * 60 * 60 * 1000,
    resetType: "usage",
  };
  const unrelatedReply = { ...FOLLOW_UP, referenced_tweets: [{ id: "other", type: "replied_to" }] };
  assert.equal(analyzeResetAnnouncement(
    FOLLOW_UP.text,
    FOLLOW_UP.created_at,
    { usage: context },
    unrelatedReply,
  ), null);
});

test("banked reset announcement and later timing remain distinct", () => {
  const announced = analyzeResetAnnouncement(
    "We will credit every Codex user with a BANKED reset to use at your convenience.",
    "2026-08-21T11:43:19.287Z",
  );
  assert.equal(announced.kind, "banked-announcement");
  const context = {
    sourcePostId: "banked-root",
    createdAt: "2026-08-21T11:43:19.287Z",
    expiresAt: Date.parse("2026-08-22T23:43:19.287Z"),
    resetType: "banked",
  };
  const follow = analyzeResetAnnouncement(
    "The banked reset will be there by 8pm PST.",
    "2026-08-21T23:40:34.129Z",
    { banked: context },
  );
  assert.equal(follow.kind, "banked-reset");
  assert.equal(formatKst(follow.resetAt), "2026-08-22 12:00 KST");
});

test("Discord failure does not advance the X cursor or create a notification marker", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => String(input).startsWith("https://api.x.com/")
    ? Response.json({ data: [FIRST_POST], meta: {} })
    : new Response(null, { status: 503 });
  const values = new Map([["tibo_user_id", "123"], ["last_seen_id", "1"]]);
  await assert.rejects(
    monitor(createEnv(values), { now: Date.parse("2026-08-29T20:50:00.000Z") }),
    /Discord webhook failed: 503/,
  );
  assert.equal(values.get("last_seen_id"), "1");
  assert.equal(values.has(`notified:${FIRST_POST.id}`), false);
});

test("only /run exists and remains protected", async () => {
  const run = await worker.fetch(new Request("https://worker.invalid/run", { method: "POST" }), {});
  const removedAiHealth = await worker.fetch(new Request("https://worker.invalid/ai-health", { method: "POST" }), {});
  assert.equal(run.status, 401);
  assert.equal(removedAiHealth.status, 404);
});
