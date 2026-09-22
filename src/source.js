import { absoluteTime, normalizeTimeline } from "./events.js";
import { MonitorError, readBoundedJson, retryAt } from "./http.js";
import { MONITOR_VERSION } from "./version.js";
import { normalizeSnapshot } from "./signals.js";

export const TIMELINE_URL = "https://codex-reset.com/api/timeline";
export const FORECAST_URL = "https://codex-reset.com/api/forecast";
export const FEED_URL = "https://codex-reset.com/api/feed";

export function sourceUserAgent(env) {
  const contact = env.SOURCE_CONTACT_URL;
  let url;
  try { url = new URL(contact); } catch { throw new MonitorError("source_contact_required"); }
  if (url.protocol !== "https:" || url.username || url.password || /[\r\n()]/.test(contact)) {
    throw new MonitorError("invalid_source_contact");
  }
  return `TiboCodexMonitor/${MONITOR_VERSION} (+${url.href})`;
}

async function fetchPublished(env, url, { fetchImpl = fetch, clock = Date.now, timeoutMs = 10_000 } = {}) {
  const userAgent = sourceUserAgent(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: controller.signal, redirect: "manual",
    });
    const now = clock();
    if (response.status === 429) {
      throw new MonitorError("source_rate_limited", { retryAt: retryAt(response.headers.get("retry-after"), now) });
    }
    if (!response.ok) throw new MonitorError("source_http_error", { status: response.status });
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      throw new MonitorError("source_not_json");
    }
    const checkedAt = absoluteTime(response.headers.get("x-published-checked-at"));
    const expiresAt = absoluteTime(response.headers.get("x-published-expires-at"));
    if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || checkedAt > now + 60_000 ||
        expiresAt <= checkedAt || expiresAt <= now) throw new MonitorError("source_not_fresh");
    const payload = await readBoundedJson(response, 1024 * 1024);
    if (clock() >= expiresAt) throw new MonitorError("source_not_fresh");
    return { payload, checkedAt, expiresAt };
  } catch (error) {
    if (controller.signal.aborted) throw new MonitorError("source_timeout");
    if (error instanceof MonitorError) throw error;
    throw new MonitorError("source_network_error");
  } finally { clearTimeout(timer); }
}

export async function fetchTimeline(env, options) {
  const { payload, ...freshness } = await fetchPublished(env, TIMELINE_URL, options);
  try { return { ...normalizeTimeline(payload), ...freshness }; }
  catch { throw new MonitorError("invalid_timeline"); }
}

export async function fetchSnapshot(env, options = {}) {
  const responses = await Promise.allSettled([TIMELINE_URL, FORECAST_URL, FEED_URL].map((url) => fetchPublished(env, url, options)));
  const failures = responses.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (failures.length) {
    // Preserve the longest Retry-After even when another endpoint failed first.
    failures.sort((a, b) => (b.retryAt || 0) - (a.retryAt || 0));
    throw failures[0];
  }
  const values = responses.map((r) => r.value);
  const expiresAt = Math.min(...values.map((r) => r.expiresAt));
  if ((options.clock ?? Date.now)() >= expiresAt) throw new MonitorError("source_not_fresh");
  try {
    return { ...normalizeSnapshot(...values.map((r) => r.payload)),
      checkedAt: Math.min(...values.map((r) => r.checkedAt)), expiresAt, sourceCount: 3 };
  } catch { throw new MonitorError("invalid_signal_snapshot"); }
}
