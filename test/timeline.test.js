import test from "node:test";
import assert from "node:assert/strict";

import { monitor } from "../src/index.js";

function createEnv(values = new Map()) {
  return {
    X_BEARER_TOKEN: "test-only-token",
    DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
    AI: {
      run: async () => ({ response: { decision: "ignore", status: "unclear" } }),
    },
    STATE: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    },
  };
}

test("reads full note text and paginates before advancing the cursor", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith("https://api.x.com/")) return new Response(null, { status: 204 });
    requests.push(url);
    if (!new URL(url).searchParams.has("pagination_token")) {
      return Response.json({
        data: [
          { id: "106", text: "ordinary", created_at: "2026-08-24T00:29:00.000Z" },
          { id: "105", text: "ordinary", created_at: "2026-08-24T00:28:00.000Z" },
          { id: "104", text: "ordinary", created_at: "2026-08-24T00:27:00.000Z" },
          { id: "103", text: "ordinary", created_at: "2026-08-24T00:26:00.000Z" },
          { id: "102", text: "ordinary", created_at: "2026-08-24T00:25:00.000Z" },
        ],
        meta: { next_token: "older-page" },
      });
    }
    return Response.json({
      data: [{
        id: "101",
        text: "truncated preview",
        note_tweet: { text: "ordinary full text" },
        created_at: "2026-08-24T00:20:00.000Z",
      }],
      meta: {},
    });
  };

  const values = new Map([["tibo_user_id", "123"], ["last_seen_id", "100"]]);
  const result = await monitor(createEnv(values), {
    now: Date.parse("2026-08-24T00:30:00.000Z"),
  });

  assert.equal(result.posts, 6);
  assert.equal(values.get("last_seen_id"), "106");
  assert.equal(requests.length, 2);
  assert.match(requests[0], /note_tweet/);
  assert.match(requests[1], /pagination_token=older-page/);
});

test("does not advance the cursor on a partial timeline response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({
    data: [{ id: "201", text: "ordinary", created_at: "2026-08-24T00:29:00.000Z" }],
    errors: [{ title: "PartialError" }],
  });

  const values = new Map([["tibo_user_id", "123"], ["last_seen_id", "200"]]);
  await assert.rejects(
    monitor(createEnv(values), { now: Date.parse("2026-08-24T00:30:00.000Z") }),
    /X API timeline returned errors/,
  );
  assert.equal(values.get("last_seen_id"), "200");
});

test("stops backlog recovery after covering the context window", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return Response.json({
        data: [{ id: "302", text: "recent", created_at: "2026-08-24T00:00:00.000Z" }],
        meta: { next_token: "older" },
      });
    }
    if (requests === 2) {
      return Response.json({
        data: [{ id: "301", text: "old", created_at: "2026-08-20T00:00:00.000Z" }],
        meta: { next_token: "deep-history" },
      });
    }
    throw new Error("fetched irrelevant deep history");
  };

  const values = new Map([["tibo_user_id", "123"], ["last_seen_id", "300"]]);
  const result = await monitor(createEnv(values), {
    now: Date.parse("2026-08-24T01:00:00.000Z"),
  });

  assert.equal(result.posts, 2);
  assert.equal(requests, 2);
  assert.equal(values.get("last_seen_id"), "302");
});
