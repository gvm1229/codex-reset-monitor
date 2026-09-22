// Read-only tail. Retain only bounded Cron results, never raw requests or headers.
import { spawn } from "node:child_process";
import { writeFile, access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url));
const output = new URL("../.wrangler/production-0-9-held.json", import.meta.url);
const stopFile = new URL("../.wrangler/production-tail-stop", import.meta.url);
await mkdir(new URL("../.wrangler/", import.meta.url), { recursive: true });
const child = spawn(process.execPath, [cli, "tail", "tibo-codex-monitor", "--format", "json"], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let buffer = "", depth = 0, quoted = false, escaped = false;
const observations = [];
let pendingWrite = Promise.resolve();
function consume(value) {
  if (!value.event?.cron) return;
  const log = value.logs?.find((entry) => entry.message?.[0] === "Monitor run");
  let result;
  try { result = log ? JSON.parse(log.message[1]) : null; } catch { result = null; }
  const allowed = ["ok", "version", "events", "invalid", "conflicts", "checkedAt", "expiresAt", "initialized", "notifications", "wouldNotify", "expected", "held", "skipped", "mode", "error"];
  const observation = {
    observedAt: new Date().toISOString(), eventTimestamp: value.eventTimestamp,
    cron: value.event.cron, scheduledTime: value.event.scheduledTime,
    versionId: value.scriptVersion?.id, outcome: value.outcome,
    exceptions: value.exceptions?.length ?? 0,
    result: result ? Object.fromEntries(allowed.filter((key) => key in result).map((key) => [key, result[key]])) : null,
  };
  observations.push(observation);
  const serialized = JSON.stringify(observations.slice(-100), null, 2);
  pendingWrite = pendingWrite.then(() => writeFile(output, serialized));
  console.log(JSON.stringify(observation));
}
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  if (/Successfully|Connected|connected/.test(chunk) && depth === 0) console.log("Tail connected");
  for (const char of chunk) {
    if (depth === 0) {
      if (char === "{") { buffer = char; depth = 1; quoted = false; escaped = false; }
      continue;
    }
    buffer += char;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth === 0) { try { consume(JSON.parse(buffer)); } catch { /* Ignore non-event output. */ } buffer = ""; }
  }
});
child.stderr.on("data", () => console.error("Tail diagnostic output received (raw text suppressed)"));
const stop = () => child.kill();
const timeout = setTimeout(stop, 20 * 60_000);
const stopCheck = setInterval(() => { access(stopFile).then(stop).catch(() => {}); }, 1000);
process.on("SIGTERM", stop);
process.stdin.on("data", stop);
child.on("error", () => { console.error("Tail process failed"); process.exitCode = 1; });
child.on("exit", async (code) => {
  clearTimeout(timeout); clearInterval(stopCheck); process.stdin.pause(); await pendingWrite;
  console.log(JSON.stringify({ tailStopped: true, observations: observations.length, exitCode: code }));
});
