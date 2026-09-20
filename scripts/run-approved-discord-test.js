// Explicitly authorized single-send runner. It only uploads an inactive Worker version.
// Authentication plaintext stays in memory; generated code contains its hash only.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.ok(process.argv.includes("--approved-discord-test-0-8"), "Explicit approval flag required");
const root = new URL("../", import.meta.url);
const marker = new URL(".wrangler/discord-test-0-8-attempt.json", root);
const entry = new URL(".wrangler/discord-test-0-8-entry.js", root);
const configFile = new URL(".wrangler/discord-test-0-8.json", root);
const markerHandle = await open(marker, "wx");
await markerHandle.writeFile(JSON.stringify({ phase: "preparing", at: new Date().toISOString() }));
await markerHandle.close();

const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
const digest = createHash("sha256").update(authorization).digest("hex");
const expiresAt = Date.now() + 10 * 60_000;
const base = JSON.parse(await readFile(new URL("wrangler.jsonc", root), "utf8"));
assert.equal(base.name, "tibo-codex-monitor");
const cli = fileURLToPath(new URL("node_modules/wrangler/bin/wrangler.js", root));
const wrangler = (...args) => execFileSync(process.execPath, [cli, ...args], {
  encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
});
try {
  const before = wrangler("deployments", "list", "--name", base.name);
  assert.match(before.slice(-1600), /0c4fb73b-bf82-42a1-a387-c59a4ee0e17e/);
  await writeFile(entry, `import { createApprovedDiscordTest } from '../scripts/approved-discord-test.js';\nexport default createApprovedDiscordTest({ tokenHash: '${digest}', expiresAt: ${expiresAt} });\n`);
  await writeFile(configFile, JSON.stringify({
    name: base.name, main: "discord-test-0-8-entry.js", compatibility_date: base.compatibility_date,
    workers_dev: true, preview_urls: true, observability: { enabled: false },
    kv_namespaces: base.kv_namespaces,
  }, null, 2));
  const uploaded = wrangler("versions", "upload", "--config", fileURLToPath(configFile),
    "--tag", "0.8", "--message", "Approved single Discord connection test only; NOT production 0.8; expires in ten minutes");
  const version = uploaded.match(/Worker Version ID:\s*([a-f0-9-]+)/)?.[1];
  assert.ok(version, "Missing inactive version ID; no test request sent");
  const url = `https://${version.slice(0, 8)}-${base.name}.hojini1229.workers.dev/test-discord`;
  console.log(JSON.stringify({ stage: "inactive_test_version", version, expiresAt: new Date(expiresAt).toISOString() }));
  await writeFile(marker, JSON.stringify({ phase: "armed_do_not_repeat", version, at: new Date().toISOString() }));
  // Exactly one send-capable request, no retries, even on timeout.
  let result;
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: authorization }, signal: AbortSignal.timeout(30_000) });
    result = { status: response.status, body: await response.json() };
  } catch { result = { status: "unknown", instruction: "Do not resend" }; }
  console.log(JSON.stringify({ stage: "discord_result", ...result }));
  await writeFile(marker, JSON.stringify({ phase: "finished_do_not_repeat", version, result, at: new Date().toISOString() }, null, 2));
  const after = wrangler("deployments", "list", "--name", base.name);
  assert.equal(after, before, "Production deployment list changed unexpectedly");
  console.log("Production deployment unchanged.");
  if (result.body?.receipt?.status !== "sent") process.exitCode = 1;
} finally {
  await unlink(entry).catch(() => {});
  await unlink(configFile).catch(() => {});
}
