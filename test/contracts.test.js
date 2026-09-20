import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("deployed code has no X client, text classifier, scraper or legacy recovery path", async () => {
  for (const directory of ["src", "scripts"]) {
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".js")) continue;
      const text = await readFile(`${directory}/${file}`, "utf8");
      assert.doesNotMatch(text, /X_BEARER_TOKEN|api\.x\.com|classifyPost|parseVerifiedResetTime|recoverApprovedPost|playwright|puppeteer/);
    }
  }
});

test("approved production enables monitoring, keeps tests off and preserves the five-minute schedule", async () => {
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  assert.equal(config.vars.NOTIFICATIONS_ENABLED, "true");
  assert.equal(config.vars.DISCORD_TEST_ENABLED, "false");
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *"]);
  assert.equal(config.durable_objects.bindings[0].class_name, "MonitorCoordinator");
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["MonitorCoordinator"]);
  assert.equal(config.vars.DISCORD_WEBHOOK_URL, undefined);
  const preview = JSON.parse(await readFile("wrangler.preview.jsonc", "utf8"));
  assert.notEqual(preview.name, config.name);
  assert.deepEqual(preview.triggers.crons, []);
  assert.equal(preview.kv_namespaces, undefined);
  assert.equal(preview.vars.NOTIFICATIONS_ENABLED, "false");
  assert.equal(preview.vars.DISCORD_TEST_ENABLED, "false");
});
