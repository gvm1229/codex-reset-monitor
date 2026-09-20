import { MONITOR_VERSION } from "./version.js";
export { MonitorCoordinator } from "./delivery.js";

export function monitor(env, action = "poll") {
  const mode = env.NOTIFICATIONS_ENABLED === "true" ? "live" : "observe";
  const namespace = env.MONITOR_NAMESPACE || "codex-reset:v1:production";
  const name = action === "discord-test" ? `${namespace}:discord-test` : `${namespace}:${mode}`;
  const stub = env.MONITOR.get(env.MONITOR.idFromName(name));
  return stub.fetch(new Request(`https://monitor.internal/${action}`, { method: "POST" }));
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await monitor(env);
      const result = await response.json();
      console.log("Monitor run", JSON.stringify({ version: MONITOR_VERSION, ...result }));
      if (!response.ok) {
        controller.noRetry();
        throw new Error("monitor_run_failed");
      }
    })());
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/run", "/test-discord"].includes(path)) {
      return new Response("Not found", { status: 404 });
    }
    if (!env.SMOKE_TEST_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.SMOKE_TEST_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (path === "/test-discord" && env.DISCORD_TEST_ENABLED !== "true") {
      return new Response("Discord test disabled", { status: 403 });
    }
    try {
      return await monitor(env, path === "/run" ? "diagnose" : "discord-test");
    } catch { return Response.json({ ok: false, error: "monitor_unavailable" }, { status: 503 }); }
  },
};
