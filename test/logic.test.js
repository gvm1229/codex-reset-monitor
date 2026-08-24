import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResetAnnouncement,
  buildDiscordContent,
  classifyPost,
  determineResetTime,
  formatKst,
  isRelevantLimitAnnouncement,
  monitor,
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

test("recognizes the Aug 13 /fast reset and schedules it one hour after the post", () => {
  const posted = "2026-08-13T01:01:37.748Z";
  const resetAt = determineResetTime(
    "Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone. Landing in the next hour or so, go /fast.",
    posted,
  );

  assert.equal(resetAt.toISOString(), "2026-08-13T02:01:37.748Z");
  assert.equal(formatKst(resetAt), "2026-08-13 11:01 KST");
});

test("uses completed wording for a reset that the post says is already done", () => {
  const posted = "2026-08-08T20:29:00.000Z";
  const analysis = analyzeResetAnnouncement(
    "I have reset usage limits for all paid users of ChatGPT Work and Codex.",
    posted,
  );
  const content = buildDiscordContent(analysis, "2086188036493344823", Date.parse(posted));

  assert.equal(
    content,
    [
      "🚨 **Tibo로부터 Codex 리셋 완료 감지!** 🚨",
      "**리셋 시각(KST)**: 2026-08-09 05:29 KST",
      "https://fixupx.com/thsottiaux/status/2086188036493344823",
    ].join("\n"),
  );
});

test("uses scheduled wording and the future time for a reset landing in the next hour", () => {
  const posted = "2026-07-21T16:47:00.000Z";
  const analysis = analyzeResetAnnouncement(
    "New day, new usage reset for paid users of Codex and ChatGPT Work. Lands in the next hour. Enjoy.",
    posted,
  );
  const content = buildDiscordContent(analysis, "2079609157934886975", Date.parse(posted));

  assert.match(content, /Codex 리셋 예정 감지/);
  assert.match(content, /2026-07-22 02:47 KST/);
  assert.doesNotMatch(content, /완료 감지/);
});

test("does not infer completion merely because a scheduled reset time has elapsed", () => {
  const analysis = analyzeResetAnnouncement(
    "Codex usage limits will reset in 1 hour.",
    "2026-07-21T16:47:00.000Z",
  );
  const content = buildDiscordContent(
    analysis,
    "scheduled-post",
    Date.parse("2026-07-21T18:47:00.000Z"),
  );

  assert.match(content, /Codex 리셋 예정 감지/);
  assert.doesNotMatch(content, /완료 감지/);
});

test("accepts a high-confidence AI classification for a novel explicit completion phrase", async () => {
  const env = {
    AI: {
      run: async () => ({
        response: {
          event_type: "usage_reset",
          status: "completed",
          related_pending_event: "none",
          time_expression: "",
          evidence: "It is done",
          confidence: 0.96,
        },
      }),
    },
  };

  const result = await classifyPost(env, {
    id: "novel-completed",
    text: "Good news for everyone using /fast. It is done.",
    created_at: "2026-08-24T01:00:00.000Z",
  });

  assert.equal(result.aiCalled, true);
  assert.equal(result.aiAccepted, true);
  assert.equal(result.analysis.kind, "reset");
  assert.equal(result.analysis.announcedAs, "completed");
  assert.equal(result.analysis.resetAt.toISOString(), "2026-08-24T01:00:00.000Z");
});

test("uses AI meaning classification but deterministic timing for a novel future phrase", async () => {
  const env = {
    AI: {
      run: async () => ({
        response: JSON.stringify({
          event_type: "usage_reset",
          status: "scheduled",
          related_pending_event: "none",
          time_expression: "in the next hour",
          evidence: "Limits land in the next hour",
          confidence: 0.93,
        }),
      }),
    },
  };

  const result = await classifyPost(env, {
    id: "novel-future",
    text: "Celebration incoming. Limits land in the next hour.",
    created_at: "2026-08-24T01:00:00.000Z",
  });

  assert.equal(result.aiAccepted, true);
  assert.equal(result.analysis.announcedAs, "scheduled");
  assert.equal(result.analysis.resetAt.toISOString(), "2026-08-24T02:00:00.000Z");
});

test("falls back to deterministic classification when Workers AI fails", async () => {
  const env = {
    AI: {
      run: async () => {
        throw new Error("AI quota unavailable");
      },
    },
  };

  const result = await classifyPost(env, {
    id: "fallback",
    text: "Codex usage limits will reset in 1 hour.",
    created_at: "2026-08-24T01:00:00.000Z",
  });

  assert.equal(result.aiCalled, true);
  assert.equal(result.aiFallback, true);
  assert.equal(result.analysis.resetAt.toISOString(), "2026-08-24T02:00:00.000Z");
});

test("discards an AI time expression that is not present in the source post", async () => {
  const env = {
    AI: {
      run: async () => ({
        response: {
          event_type: "usage_reset",
          status: "scheduled",
          related_pending_event: "none",
          time_expression: "at 2 PM PT",
          evidence: "Codex limits",
          confidence: 0.99,
        },
      }),
    },
  };

  const result = await classifyPost(env, {
    id: "hallucinated-time",
    text: "Codex limits will change later.",
    created_at: "2026-08-24T01:00:00.000Z",
  });

  assert.equal(result.aiAccepted, true);
  assert.equal(result.aiFallback, false);
  assert.equal(result.analysis.kind, "context");
});

test("accepts an AI other classification without treating it as a failure", async () => {
  const env = {
    AI: {
      run: async () => ({
        response: {
          event_type: "other",
          status: "other",
          related_pending_event: "none",
          time_expression: "",
          evidence: "",
          confidence: 0.98,
        },
      }),
    },
  };

  const result = await classifyPost(env, {
    id: "ordinary",
    text: "A normal product update with no usage-limit event.",
    created_at: "2026-08-24T01:00:00.000Z",
  });

  assert.equal(result.analysis, null);
  assert.equal(result.aiAccepted, true);
  assert.equal(result.aiFallback, false);
});

test("sends separate banked-reset announcement and timing-clarification messages", () => {
  const announced = analyzeResetAnnouncement(
    "During the day we will credit every Codex and ChatGPT Work user with a BANKED reset that you can use at your own convenience.",
    "2026-08-21T11:43:19.287Z",
  );
  const landed = analyzeResetAnnouncement(
    "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.",
    "2026-08-21T23:40:34.129Z",
    {
      sourcePostId: "2090766694897619318",
      createdAt: "2026-08-21T11:43:19.287Z",
      expiresAt: Date.parse("2026-08-22T23:43:19.287Z"),
      resetType: "banked",
    },
  );

  assert.equal(announced.kind, "banked-announcement");
  assert.equal(
    buildDiscordContent(announced, "2090766694897619318", Date.parse("2026-08-21T11:43:19.287Z")),
    [
      "🏦 **Tibo로부터 Codex BANKED 리셋 지급 예정 감지!** 🏦",
      "**지급 시각(KST)**: 미정 (추후 안내 예정)",
      "https://fixupx.com/thsottiaux/status/2090766694897619318",
    ].join("\n"),
  );
  assert.equal(landed.kind, "banked-reset");
  assert.equal(landed.clarificationOf, "2090766694897619318");
  assert.equal(landed.resetAt.toISOString(), "2026-08-22T03:00:00.000Z");
  assert.equal(formatKst(landed.resetAt), "2026-08-22 12:00 KST");
  assert.equal(
    buildDiscordContent(landed, "2090947196107764189", Date.parse("2026-08-21T23:40:34.129Z")),
    [
      "🏦 **앞서 안내된 Codex BANKED 리셋 지급 시각 확인!** 🏦",
      "**지급 시각(KST)**: 2026-08-22 12:00 KST",
      "https://fixupx.com/thsottiaux/status/2090947196107764189",
    ].join("\n"),
  );
});

test("treats a timing-only follow-up as the previous banked reset clarification", () => {
  const followUp = analyzeResetAnnouncement(
    "Reset will land at 8pm PT.",
    "2026-08-21T23:40:34.129Z",
    {
      usage: {
        sourcePostId: "older-usage-announcement",
        createdAt: "2026-08-20T10:00:00.000Z",
        expiresAt: Date.parse("2026-08-22T00:00:00.000Z"),
        resetType: "usage",
      },
      banked: {
        sourcePostId: "2090766694897619318",
        createdAt: "2026-08-21T11:43:19.287Z",
        expiresAt: Date.parse("2026-08-22T23:43:19.287Z"),
        resetType: "banked",
      },
    },
  );

  assert.equal(followUp.kind, "banked-reset");
  assert.equal(followUp.resetType, "banked");
  assert.equal(followUp.clarificationOf, "2090766694897619318");
  assert.equal(formatKst(followUp.resetAt), "2026-08-22 12:00 KST");
});

test("emits two Discord notifications when a banked reset is later clarified", async (t) => {
  const originalFetch = globalThis.fetch;
  const discordBodies = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.x.com/")) {
      return Response.json({
        data: [
          {
            id: "2090947196107764189",
            text: "The banked reset will be there by 8pm PST. For all paid users of ChatGPT Work and Codex.",
            created_at: "2026-08-21T23:40:34.129Z",
          },
          {
            id: "2090766694897619318",
            text: "During the day we will credit every Codex and ChatGPT Work user with a BANKED reset that you can use at your own convenience.",
            created_at: "2026-08-21T23:30:34.129Z",
          },
        ],
        meta: {},
      });
    }

    discordBodies.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };

  const values = new Map([["tibo_user_id", "123"]]);
  const env = {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };

  const result = await monitor(env, { now: Date.parse("2026-08-21T23:45:00.000Z") });

  assert.equal(result.notifications, 2);
  assert.match(discordBodies[0].content, /지급 시각\(KST\).*미정/);
  assert.match(discordBodies[1].content, /앞서 안내된 Codex BANKED 리셋 지급 시각 확인/);
});

test("correlates a Codex rate-limit post with its standalone timing follow-up", () => {
  const context = analyzeResetAnnouncement(
    "Update on rate limits in Codex. We found several sources of unexpectedly fast usage drain. Fixes are coming tomorrow.",
    "2026-08-23T06:11:36.368Z",
  );
  assert.equal(context.kind, "context");

  const followUp = analyzeResetAnnouncement(
    "Reset will land around 14pm PST tomorrow.",
    "2026-08-23T06:29:05.799Z",
    {
      usage: {
        sourcePostId: "2091407991736332689",
        createdAt: "2026-08-23T06:11:36.368Z",
        expiresAt: Date.parse("2026-08-24T18:11:36.368Z"),
        resetType: "usage",
      },
      banked: null,
    },
  );

  assert.equal(followUp.kind, "reset");
  assert.equal(followUp.announcedAs, "scheduled");
  assert.equal(followUp.resetAt.toISOString(), "2026-08-23T21:00:00.000Z");
  assert.equal(formatKst(followUp.resetAt), "2026-08-24 06:00 KST");
});

test("reads full note_tweet text and paginates before advancing the cursor", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const discordBodies = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.x.com/")) {
      requests.push(url);
      const parsed = new URL(url);
      if (!parsed.searchParams.has("pagination_token")) {
        return Response.json({
          data: [
            { id: "106", text: "ordinary post", created_at: "2026-08-24T00:29:00.000Z" },
            { id: "105", text: "ordinary post", created_at: "2026-08-24T00:28:00.000Z" },
            { id: "104", text: "ordinary post", created_at: "2026-08-24T00:27:00.000Z" },
            { id: "103", text: "ordinary post", created_at: "2026-08-24T00:26:00.000Z" },
            { id: "102", text: "ordinary post", created_at: "2026-08-24T00:25:00.000Z" },
          ],
          meta: { next_token: "older-page" },
        });
      }

      return Response.json({
        data: [
          {
            id: "101",
            text: "This visible preview is truncated before the important part…",
            note_tweet: {
              text: "I have reset usage limits for all paid users of ChatGPT Work and Codex.",
            },
            created_at: "2026-08-24T00:20:00.000Z",
          },
        ],
        meta: {},
      });
    }

    discordBodies.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };

  const values = new Map([
    ["tibo_user_id", "123"],
    ["last_seen_id", "100"],
  ]);
  const env = {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };

  const result = await monitor(env, { now: Date.parse("2026-08-24T00:30:00.000Z") });

  assert.equal(result.posts, 6);
  assert.equal(result.notifications, 1);
  assert.equal(values.get("last_seen_id"), "106");
  assert.equal(requests.length, 2);
  assert.match(requests[0], /note_tweet/);
  assert.match(requests[1], /pagination_token=older-page/);
  assert.match(discordBodies[0].content, /리셋 완료 감지/);
});

test("does not advance the cursor when X returns a partial timeline error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json({
    data: [{ id: "201", text: "ordinary post", created_at: "2026-08-24T00:29:00.000Z" }],
    errors: [{ title: "PartialError", detail: "timeline was incomplete" }],
  });

  const values = new Map([
    ["tibo_user_id", "123"],
    ["last_seen_id", "200"],
  ]);
  const env = {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };

  await assert.rejects(
    monitor(env, { now: Date.parse("2026-08-24T00:30:00.000Z") }),
    /X API timeline returned errors/,
  );
  assert.equal(values.get("last_seen_id"), "200");
});

test("stops backlog recovery after covering the full context window", async (t) => {
  const originalFetch = globalThis.fetch;
  let timelineRequests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    if (!String(input).startsWith("https://api.x.com/")) {
      return new Response(null, { status: 204 });
    }

    timelineRequests += 1;
    if (timelineRequests === 1) {
      return Response.json({
        data: [{ id: "302", text: "recent ordinary post", created_at: "2026-08-24T00:00:00.000Z" }],
        meta: { next_token: "older" },
      });
    }
    if (timelineRequests === 2) {
      return Response.json({
        data: [{ id: "301", text: "old ordinary post", created_at: "2026-08-20T00:00:00.000Z" }],
        meta: { next_token: "irrelevant-deep-history" },
      });
    }
    throw new Error("monitor fetched history older than its context window");
  };

  const values = new Map([
    ["tibo_user_id", "123"],
    ["last_seen_id", "300"],
  ]);
  const env = {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };

  const result = await monitor(env, { now: Date.parse("2026-08-24T01:00:00.000Z") });

  assert.equal(result.posts, 2);
  assert.equal(timelineRequests, 2);
  assert.equal(values.get("last_seen_id"), "302");
});
