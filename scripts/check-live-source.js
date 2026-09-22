// Read-only integration probe. Does not load credentials, Worker storage or Discord code.
import { readFile } from "node:fs/promises";
import { fetchSnapshot } from "../src/source.js";
import { selectNotification } from "../src/events.js";
import { previewUrl } from "../src/discord.js";
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const result = await fetchSnapshot(config.vars);
console.log(JSON.stringify({
  checkedAt: new Date(result.checkedAt).toISOString(),
  expiresAt: new Date(result.expiresAt).toISOString(),
  events: result.events.length, invalid: result.invalid, conflicts: result.conflicts,
  sourceCount: result.sourceCount,
  activeSignals: result.events.filter((event) => event.activeSignal).map((event) => ({ id: event.id, kind: selectNotification(event)?.kind, window: event.window })),
  eligibleInHistory: result.events.filter((event) => selectNotification(event) && previewUrl(event.url)).length,
  discordRequests: 0,
}, null, 2));
