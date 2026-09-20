// One explicitly approved real test. This adapter is NOT the production entry point.
import { buildDiscordTestContent, discordUrl, sendDiscord } from "../src/discord.js";
import { readBoundedJson } from "../src/http.js";

export const TEST_KEY = "verification:0.8:discord-test:2026-09-21";

export function createApprovedDiscordTest({ tokenHash, expiresAt, fetchImpl = fetch, clock = Date.now }) {
  let claimed = false;
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path !== "/test-discord" || !["GET", "POST"].includes(request.method)) return new Response("Not found", { status: 404 });
      if (clock() >= expiresAt) return new Response("Unauthorized", { status: 401 });
      const authorization = request.headers.get("Authorization") ?? "";
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== tokenHash) return new Response("Unauthorized", { status: 401 });
      try {
        if (request.method === "GET") return Response.json({ receipt: JSON.parse(await env.STATE.get(TEST_KEY) || "null") });
        if (claimed) return Response.json({ skipped: "attempt_already_claimed" }, { status: 409 });
        claimed = true;
        const previous = await env.STATE.get(TEST_KEY);
        if (previous) return Response.json({ skipped: "durable_attempt_exists", receipt: JSON.parse(previous) }, { status: 409 });
        discordUrl(env); // Validate before latching or calling Discord.
        await env.STATE.put(TEST_KEY, JSON.stringify({ status: "attempting", at: clock() }));
        const content = buildDiscordTestContent(clock());
        const outcome = await sendDiscord(env, content, { fetchImpl, clock });
        const receipt = { ...outcome, at: clock(), contentVerified: false };
        // Persist success before attempting the read-only retrieval.
        await env.STATE.put(TEST_KEY, JSON.stringify(receipt));
        if (outcome.status === "sent") {
          try {
            const url = discordUrl(env);
            url.pathname += `/messages/${outcome.messageId}`;
            url.search = "";
            const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
            if (response.ok) {
              const message = await readBoundedJson(response, 16_384);
              receipt.contentVerified = message.id === outcome.messageId && message.content === content;
              await env.STATE.put(TEST_KEY, JSON.stringify(receipt));
            }
          } catch { /* Creation receipt remains valid; never resend. */ }
        }
        return Response.json({ receipt }, { status: outcome.status === "sent" ? 200 : 502 });
      } catch {
        return Response.json({ error: "test_result_uncertain_do_not_resend" }, { status: 503 });
      }
    },
  };
}
