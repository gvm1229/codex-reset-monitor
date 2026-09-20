// Read-only integration probe. Does not load credentials, Worker storage or Discord code.
import { readFile } from "node:fs/promises";
import { fetchTimeline } from "../src/source.js";
import { selectNotification } from "../src/events.js";
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const result = await fetchTimeline(config.vars);
console.log(JSON.stringify({
  checkedAt: new Date(result.checkedAt).toISOString(),
  expiresAt: new Date(result.expiresAt).toISOString(),
  events: result.events.length, invalid: result.invalid, conflicts: result.conflicts,
  eligibleInHistory: result.events.filter(selectNotification).length,
  discordRequests: 0,
}, null, 2));
