import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from "miniflare";
import { ENV } from "./helpers.js";

async function runtime(t, { enabled = false, testEnabled = false } = {}) {
  const bundle = await build({ entryPoints: ["src/index.js"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
  const calls = [];
  const now = Date.now();
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "monitor-test",
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-15",
    durableObjects: { MONITOR: { className: "MonitorCoordinator", useSQLite: true } },
    bindings: { ...ENV, NOTIFICATIONS_ENABLED: String(enabled), DISCORD_TEST_ENABLED: String(testEnabled), SMOKE_TEST_TOKEN: "test-token" },
    outboundService: async (request) => {
      const url = new URL(request.url);
      calls.push(url.hostname);
      if (url.href === "https://codex-reset.com/api/timeline") {
        return RuntimeResponse.json({ events: [{ id: "2098685367058612394", group: "reset", type: "reset",
          announcement_state: "announced", announced_at: new Date(now - 60_000).toISOString(),
          url: "https://x.com/thsottiaux/status/2098685367058612394" }] }, { headers: {
          "x-published-checked-at": new Date(now - 1000).toISOString(),
          "x-published-expires-at": new Date(now + 180_000).toISOString(),
        } });
      }
      if (url.hostname === "discord.com" && testEnabled) {
        assert.equal(url.searchParams.get("wait"), "true");
        const body = await request.json();
        assert.match(body.content, /실제 리셋 아님/);
        assert.deepEqual(body.allowed_mentions, { parse: [] });
        return RuntimeResponse.json({ id: "12345" });
      }
      throw new Error(`Unmocked outbound request denied: ${url.hostname}`);
    },
  }));
  t.after(() => mf.dispose());
  return { mf, calls };
}

test("workerd: protected diagnostic runs without sending or initializing the live baseline", async (t) => {
  const { mf, calls } = await runtime(t, { enabled: true });
  const unauthorized = await mf.dispatchFetch("https://worker.test/run", { method: "POST" });
  assert.equal(unauthorized.status, 401);
  const diagnostic = await mf.dispatchFetch("https://worker.test/run", { method: "POST", headers: { Authorization: "Bearer test-token" } });
  const body = await diagnostic.json();
  assert.equal(body.diagnostic, true, JSON.stringify({ body, calls }));
  assert.equal(body.notifications, 0);
  const bindings = await mf.getBindings();
  const stub = bindings.MONITOR.get(bindings.MONITOR.idFromName("codex-reset:v1:production:live"));
  const results = await Promise.all([1, 2, 3].map(async () => (await stub.fetch("https://internal/poll", { method: "POST" })).json()));
  assert.equal(results.filter((r) => r.initialized).length, 1);
  assert.equal(results.reduce((n, r) => n + r.notifications, 0), 0);
  assert.deepEqual(calls, ["codex-reset.com"]);
});

test("workerd: default-off test endpoint never makes an outbound Discord request", async (t) => {
  const { mf, calls } = await runtime(t);
  const response = await mf.dispatchFetch("https://worker.test/test-discord", { method: "POST", headers: { Authorization: "Bearer test-token" } });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("workerd: explicitly enabled test uses a mocked Discord once, even with overlapping requests", async (t) => {
  const { mf, calls } = await runtime(t, { testEnabled: true });
  const responses = await Promise.all([1, 2, 3].map(async () => {
    const r = await mf.dispatchFetch("https://worker.test/test-discord", { method: "POST", headers: { Authorization: "Bearer test-token" } });
    return r.json();
  }));
  assert.equal(responses.reduce((n, r) => n + r.notifications, 0), 1, JSON.stringify({ responses, calls }));
  assert.deepEqual(calls, ["discord.com"]);
});
