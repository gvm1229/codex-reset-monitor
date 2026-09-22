// Reads only the public source in an isolated preview; NEVER calls /test-discord.
// The generated diagnostic credential exists in memory and on the preview only,
// and is removed in finally. No production secret or KV is read or changed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MONITOR_VERSION } from "../src/version.js";

const configPath = fileURLToPath(new URL("../wrangler.preview.jsonc", import.meta.url));
const config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.name, `tibo-codex-monitor-v${MONITOR_VERSION.replaceAll(".", "-")}-preview`);
assert.equal(config.vars.NOTIFICATIONS_ENABLED, "false");
assert.equal(config.vars.DISCORD_TEST_ENABLED, "false");
assert.equal(config.vars.PREVIEW_POLL_ENABLED, "true");
assert.deepEqual(config.triggers.crons, []);
assert.equal(config.kv_namespaces, undefined);
const base = `https://${config.name}.hojini1229.workers.dev`;
const token = randomBytes(32).toString("hex");
const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
function wrangler(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args, "--config", configPath], {
    input, encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) {
    console.error((result.stderr || result.stdout || "Wrangler failed").replaceAll(token, "[redacted]"));
    throw new Error("preview_secret_operation_failed");
  }
}

const unauthorized = await fetch(`${base}/run`, { method: "POST" });
assert.equal(unauthorized.status, 401);
async function authorizedPost(path) {
  let response;
  for (let attempt = 0; attempt < 45; attempt++) {
    response = await fetch(`${base}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 401) return response;
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("preview credential has not propagated");
}
try {
  wrangler(["secret", "put", "SMOKE_TEST_TOKEN"], `${token}\n`);
  // A newly published secret can briefly lag at another edge. Retry only 401;
  // rejected authentication never reaches the source API or delivery logic.
  const response = await authorizedPost("/run");
  const body = await response.json();
  console.log(JSON.stringify({ preview: config.name, httpStatus: response.status, result: body }, null, 2));
  assert.equal(response.status, 200);
  assert.equal(body.diagnostic, true);
  assert.equal(body.notifications, 0);
  assert.equal(body.invalid, 0);
  assert.equal(body.conflicts, 0);
  const pollResponse = await authorizedPost("/preview-poll");
  const pollBody = await pollResponse.json();
  console.log(JSON.stringify({ previewPoll: config.name, httpStatus: pollResponse.status, result: pollBody }, null, 2));
  assert.equal(pollResponse.status, 200);
  assert.equal(pollBody.mode, "observe");
  assert.equal(pollBody.notifications, 0);
  assert.ok(pollBody.head && typeof pollBody.head === "object", "head was not persisted");
} finally {
  wrangler(["secret", "delete", "SMOKE_TEST_TOKEN"], "y\n");
}
console.log("Preview diagnostic credential removed; no Discord request made.");
