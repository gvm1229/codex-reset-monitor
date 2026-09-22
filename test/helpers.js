export const NOW = Date.parse("2026-09-21T00:00:00Z");
export const ENV = {
  NOTIFICATIONS_ENABLED: "true", DISCORD_TEST_ENABLED: "false",
  SOURCE_CONTACT_URL: "https://monitor.example/contact",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test-only",
};

export function rawEvent(id = "1", fields = {}) {
  return { id, group: "reset", type: "reset", announcement_state: "announced",
    announced_at: new Date(NOW - 60_000).toISOString(),
    url: `https://x.com/thsottiaux/status/${id}`, ...fields };
}

export function sourceResponse(events = [], now = NOW, headers = {}) {
  return Response.json({ events }, { headers: {
    "x-published-checked-at": new Date(now - 1000).toISOString(),
    "x-published-expires-at": new Date(now + 180_000).toISOString(), ...headers,
  } });
}

export function publishedResponse(payload, now = NOW) {
  return Response.json(payload, { headers: sourceResponse([], now).headers });
}

export class MemoryStorage {
  data = new Map();
  failPut = null;
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    if (this.failPut?.(key, value)) throw new Error("injected storage failure");
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { return this.data.delete(key); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
  }
  async transaction(fn) {
    const txn = new MemoryStorage();
    txn.data = structuredClone(this.data);
    txn.failPut = this.failPut;
    const result = await fn(txn);
    this.data = txn.data;
    return result;
  }
}
