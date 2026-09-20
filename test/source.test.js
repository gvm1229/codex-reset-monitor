import test from "node:test";
import assert from "node:assert/strict";
import { fetchTimeline, TIMELINE_URL } from "../src/source.js";
import { NOW, ENV, rawEvent, sourceResponse } from "./helpers.js";

test("one attributed GET loads the API, even when the last event is old", async () => {
  let calls = 0;
  const result = await fetchTimeline(ENV, { clock: () => NOW, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, TIMELINE_URL);
    assert.equal(options.redirect, "manual");
    assert.match(options.headers["User-Agent"], /TiboCodexMonitor\/0.8.*monitor.example\/contact/);
    assert.equal(options.headers.Authorization, undefined);
    return sourceResponse([rawEvent("1", { announced_at: "2025-01-01T00:00:00Z" })]);
  } });
  assert.equal(calls, 1);
  assert.equal(result.events.length, 1);
});

test("invalid, expired, future and missing publication headers fail closed", async () => {
  const cases = [
    { "x-published-expires-at": new Date(NOW).toISOString() },
    { "x-published-checked-at": "bad" },
    { "x-published-checked-at": new Date(NOW + 60_001).toISOString() },
    { "x-published-expires-at": "" },
  ];
  for (const headers of cases) await assert.rejects(fetchTimeline(ENV, {
    clock: () => NOW, fetchImpl: async () => sourceResponse([], NOW, headers),
  }), /source_not_fresh/);
});

test("malformed, HTML, oversize and HTTP errors are safe failures", async () => {
  const headers = Object.fromEntries(sourceResponse().headers);
  const cases = [
    [() => new Response("{", { headers }), "invalid_json"],
    [() => new Response("<html>", { headers: { ...headers, "content-type": "text/html" } }), "source_not_json"],
    [() => new Response('"' + "x".repeat(1024 * 1024) + '"', { headers }), "response_too_large"],
    [() => new Response("sensitive upstream detail", { status: 503 }), "source_http_error"],
    [() => Response.json({}, { headers }), "invalid_timeline"],
  ];
  for (const [response, message] of cases) await assert.rejects(fetchTimeline(ENV, {
    clock: () => NOW, fetchImpl: async () => response(),
  }), new RegExp(message));
});

test("429 respects Retry-After seconds and HTTP date", async () => {
  for (const retry of ["600", new Date(NOW + 600_000).toUTCString()]) {
    await assert.rejects(fetchTimeline(ENV, { clock: () => NOW,
      fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": retry } }),
    }), (error) => error.code === "source_rate_limited" && error.retryAt === NOW + 600_000);
  }
});

test("network errors and timeout cannot expose caller or remote credentials", async () => {
  await assert.rejects(fetchTimeline(ENV, { fetchImpl: async () => { throw new Error("credential-in-error"); } }), /^MonitorError: source_network_error$/);
  await assert.rejects(fetchTimeline(ENV, { timeoutMs: 5, fetchImpl: async (_, { signal }) => {
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
  } }), /source_timeout/);
});
