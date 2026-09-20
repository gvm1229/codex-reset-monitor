export class MonitorError extends Error {
  constructor(code, { status, retryAt } = {}) {
    super(code);
    this.name = "MonitorError";
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function safeFailure(error) {
  return error instanceof MonitorError ? error.code : "internal_error";
}

export function retryAt(value, now, fallbackMs = 300_000) {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const delay = Number(value) * 1000;
    if (Number.isFinite(delay)) return now + Math.max(60_000, delay);
  }
  const date = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > now ? date : now + fallbackMs;
}

export async function readBoundedJson(response, maxBytes) {
  if (!response.body) throw new MonitorError("empty_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new MonitorError("response_too_large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof MonitorError) throw error;
    throw new MonitorError("invalid_json");
  } finally {
    reader.releaseLock();
  }
}
