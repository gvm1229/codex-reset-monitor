import { absoluteTime, normalizeTimeline } from "./events.js";
import { MonitorError, readBoundedJson, retryAt } from "./http.js";
import { MONITOR_VERSION } from "./version.js";

export const TIMELINE_URL = "https://codex-reset.com/api/timeline";

export function sourceUserAgent(env) {
  const contact = env.SOURCE_CONTACT_URL;
  let url;
  try { url = new URL(contact); } catch { throw new MonitorError("source_contact_required"); }
  if (url.protocol !== "https:" || url.username || url.password || /[\r\n()]/.test(contact)) {
    throw new MonitorError("invalid_source_contact");
  }
  return `TiboCodexMonitor/${MONITOR_VERSION} (+${url.href})`;
}

export async function fetchTimeline(env, { fetchImpl = fetch, clock = Date.now, timeoutMs = 10_000 } = {}) {
  const userAgent = sourceUserAgent(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TIMELINE_URL, {
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
    let normalized;
    try { normalized = normalizeTimeline(payload); }
    catch { throw new MonitorError("invalid_timeline"); }
    return { ...normalized, checkedAt, expiresAt };
  } catch (error) {
    if (controller.signal.aborted) throw new MonitorError("source_timeout");
    if (error instanceof MonitorError) throw error;
    throw new MonitorError("source_network_error");
  } finally { clearTimeout(timer); }
}
