import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApprovedDiscordTest, TEST_KEY } from "../scripts/approved-discord-test.js";
import { ENV, NOW, MemoryStorage } from "./helpers.js";

const authorization = "Bearer unit-test-only";
const tokenHash = createHash("sha256").update(authorization).digest("hex");
const request = (method = "POST", auth = authorization) => new Request("https://test/test-discord", { method, headers: { Authorization: auth } });

test("approved adapter checks authentication and expiry before all state or network work", async () => {
  const handler = createApprovedDiscordTest({ tokenHash, expiresAt: NOW + 1, clock: () => NOW });
  assert.equal((await handler.fetch(request("POST", "wrong"), {})).status, 401);
  const expired = createApprovedDiscordTest({ tokenHash, expiresAt: NOW, clock: () => NOW });
  assert.equal((await expired.fetch(request(), {})).status, 401);
});

test("approved adapter sends one mocked message and reads it back exactly", async () => {
  const storage = new MemoryStorage();
  const env = { ...ENV, STATE: storage };
  let posts = 0;
  let content;
  const handler = createApprovedDiscordTest({ tokenHash, expiresAt: NOW + 1000, clock: () => NOW,
    fetchImpl: async (url, options) => {
      if (options.method === "POST") {
        posts++;
        content = JSON.parse(options.body).content;
        return Response.json({ id: "123" });
      }
      assert.match(String(url), /\/messages\/123$/);
      return Response.json({ id: "123", content });
    },
  });
  const first = await handler.fetch(request(), env);
  assert.equal((await first.json()).receipt.contentVerified, true);
  assert.deepEqual(content.match(/https?:\/\/\S+/g), ["https://fixupx.com/thsottiaux/status/2098685367058612394"]);
  assert.equal((await handler.fetch(request(), env)).status, 409);
  assert.equal(posts, 1);
  assert.equal((await (await handler.fetch(request("GET"), env)).json()).receipt.status, "sent");
  assert.equal(JSON.parse(await storage.get(TEST_KEY)).messageId, "123");
});

test("an existing attempt or unknown send forbids another send, including a new isolate", async () => {
  const env = { ...ENV, STATE: new MemoryStorage() };
  let posts = 0;
  const options = { tokenHash, expiresAt: NOW + 1000, clock: () => NOW,
    fetchImpl: async () => { posts++; throw new Error("private-network-detail"); } };
  assert.equal((await createApprovedDiscordTest(options).fetch(request(), env)).status, 502);
  assert.equal((await createApprovedDiscordTest(options).fetch(request(), env)).status, 409);
  assert.equal(posts, 1);
});
