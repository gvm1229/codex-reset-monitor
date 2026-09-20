import { formatKst } from "./time.js";
import { MonitorError, readBoundedJson, retryAt } from "./http.js";

const HEADLINES = {
  reset: "🚨 **Codex 리셋 발표 감지!**",
  boost: "📈 **Codex 사용량 확대 안내!**",
  "banked-announced": "🏦 **Codex 리셋권 지급 예고!**",
  "banked-arriving": "🏦 **Codex 리셋권 지급 진행 안내!**",
  "banked-available": "🏦 **Codex 리셋권 사용 가능 안내!**",
};

export function previewUrl(value) {
  try {
    const url = new URL(value);
    const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/.exec(url.pathname);
    if (url.protocol === "https:" && !url.username && !url.password &&
        ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) && match) {
      return `https://fixupx.com/${match[1]}/status/${match[2]}`;
    }
  } catch { /* Unknown sources link to the site's timeline. */ }
  return "https://codex-reset.com/timeline";
}

export function buildDiscordContent(event, notification) {
  const headline = HEADLINES[notification.kind];
  if (!headline) throw new MonitorError("invalid_notification_kind");
  return [headline, `**발표 시각(KST)**: ${formatKst(event.announcedAt)}`,
    `출처: https://codex-reset.com/ · ${previewUrl(event.url)}`].join("\n");
}

export function buildDiscordTestContent(now) {
  return ["🧪 **Codex 알림 연결 시험 — 실제 리셋 아님**",
    `**시험 시각(KST)**: ${formatKst(now)}`, "출처: https://codex-reset.com/"].join("\n");
}

export function discordUrl(env) {
  let url;
  try { url = new URL(env.DISCORD_WEBHOOK_URL); }
  catch { throw new MonitorError("discord_webhook_required"); }
  if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname) ||
      url.port || url.username || url.password ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new MonitorError("invalid_discord_webhook");
  }
  url.searchParams.set("wait", "true");
  return url;
}

// Never propagate a fetch error or server body: either may contain the webhook secret.
export async function sendDiscord(env, content, { fetchImpl = fetch, clock = Date.now, timeoutMs = 10_000 } = {}) {
  const url = discordUrl(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal, redirect: "manual",
    });
    if (response.status === 429) {
      const now = clock();
      let next = retryAt(response.headers.get("retry-after"), now);
      try {
        const body = await readBoundedJson(response, 16_384);
        if (Number.isFinite(body.retry_after) && body.retry_after >= 0) {
          next = Math.max(next, now + body.retry_after * 1000);
        }
      } catch { /* A rate-limit header or conservative delay is sufficient. */ }
      return { status: "pending", retryAt: next };
    }
    if (response.status >= 400 && response.status < 500) return { status: "rejected", httpStatus: response.status };
    if (!response.ok) return { status: "delivery-unknown" };
    const body = await readBoundedJson(response, 16_384);
    if (typeof body.id !== "string" || !/^\d+$/.test(body.id)) return { status: "delivery-unknown" };
    return { status: "sent", messageId: body.id };
  } catch { return { status: "delivery-unknown" }; }
  finally { clearTimeout(timer); }
}
