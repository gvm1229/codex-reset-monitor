import { ONE_HOUR_MS, activeSignal, notificationKey, selectNotification } from "./events.js";
import { fetchSnapshot } from "./source.js";
import { buildDiscordContent, buildDiscordTestContent, discordUrl, sendDiscord } from "./discord.js";
import { MonitorError, safeFailure } from "./http.js";
import { MONITOR_VERSION } from "./version.js";
import { HEAD_KEY, advanceHead, comparePosition, headFromRecords } from "./head.js";

const eventKey = (id) => `event:${id}`;

// The queue spans external awaits. Storage transactions alone cannot serialize a webhook call.
export class MonitorCoordinator {
  constructor(ctx, env) {
    this.service = new MonitorService(ctx.storage, env);
    this.queue = Promise.resolve();
  }
  fetch(request) {
    const task = this.queue.then(() => this.service.handle(new URL(request.url).pathname));
    this.queue = task.catch(() => {});
    return task;
  }
}

export class MonitorService {
  constructor(storage, env, { fetchImpl = fetch, clock = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.snapshot = null;
  }

  async handle(path) {
    try {
      let result;
      if (path === "/discord-test") result = await this.testDiscord();
      else if (["/poll", "/diagnose"].includes(path)) result = await this.poll(path === "/diagnose");
      else return new Response("Not found", { status: 404 });
      return Response.json({ ok: true, version: MONITOR_VERSION, ...result });
    } catch (error) {
      const failure = { code: safeFailure(error), at: this.clock() };
      try { await this.storage.put("last_error", failure); } catch { /* Fail without exposing storage internals. */ }
      return Response.json({ ok: false, version: MONITOR_VERSION, error: failure.code }, { status: 503 });
    }
  }

  async getSnapshot() {
    const now = this.clock();
    const nextFetchAt = await this.storage.get("next_fetch_at") || 0;
    if (nextFetchAt > now) {
      if (this.snapshot?.expiresAt > now) return this.snapshot;
      return null;
    }
    // Persist before network I/O so a restart cannot bypass the one-minute limit.
    await this.storage.put("next_fetch_at", now + 60_000);
    this.snapshot = null;
    try {
      const snapshot = await fetchSnapshot(this.env, { fetchImpl: this.fetchImpl, clock: this.clock });
      this.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (error instanceof MonitorError && error.retryAt) await this.storage.put("next_fetch_at", error.retryAt);
      throw error;
    }
  }

  async poll(diagnostic = false) {
    const snapshot = await this.getSnapshot();
    if (!snapshot) return { skipped: "source_cooldown", notifications: 0 };
    const overview = {
      events: snapshot.events.length, invalid: snapshot.invalid, conflicts: snapshot.conflicts,
      sourceCount: snapshot.sourceCount, invalidWindows: snapshot.events.filter((e) => e.windowInvalid).length,
      checkedAt: new Date(snapshot.checkedAt).toISOString(),
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
    };
    if (diagnostic) {
      const records = await this.storage.list({ prefix: "event:" });
      const reviews = [...records.values()].filter((r) => r.blocked || Object.values(r.deliveries).some((d) => d.status === "attempting"));
      return { ...overview, diagnostic: true, notifications: 0, reviewCount: reviews.length,
        head: await this.storage.get(HEAD_KEY) ?? null,
        reviewIds: reviews.slice(0, 20).map((r) => r.id),
        activeSignals: snapshot.events.filter((event) => activeSignal(event, this.clock()))
          .filter((event) => selectNotification(event)).slice(0, 20)
          .map((event) => ({ id: event.id, kind: selectNotification(event).kind,
            preview: buildDiscordContent(event, selectNotification(event)) })),
      };
    }
    const enabled = this.env.NOTIFICATIONS_ENABLED === "true";
    if (enabled) discordUrl(this.env); // Reject bad configuration before advancing any event.
    let initialized = await this.storage.get("initialized");
    let seeded = false;
    let head = await this.storage.get(HEAD_KEY);
    if (!initialized) {
      if (snapshot.invalid || snapshot.conflicts) throw new MonitorError("incomplete_baseline");
      await this.storage.transaction(async (txn) => {
        const seededHead = {};
        for (const event of snapshot.events) {
          const notification = selectNotification(event);
          advanceHead(seededHead, event, notification?.kind);
          if (activeSignal(event, this.clock())) continue;
          await txn.put(eventKey(event.id), {
            id: event.id, group: event.group, announcedAt: event.announcedAt,
            rank: notification?.rank ?? 0, highestOffered: 0, deliveries: {}, baseline: true,
            seenKeys: notification ? [notificationKey(event, notification)] : [],
          });
        }
        await txn.put(HEAD_KEY, seededHead);
        await txn.put("initialized", { at: this.clock() });
      });
      initialized = await this.storage.get("initialized");
      head = await this.storage.get(HEAD_KEY);
      seeded = true;
    } else if (!head) {
      // Preserve every 0.8 receipt. Only reconstruct the missing positions once.
      await this.storage.transaction(async (txn) => {
        const records = await txn.list({ prefix: "event:" });
        head = headFromRecords(records.values());
        await txn.put(HEAD_KEY, head);
      });
    }
    const oldHead = structuredClone(head);
    const candidateHead = structuredClone(head);
    const canAdvanceHead = snapshot.invalid === 0 && snapshot.conflicts === 0;
    const result = { ...overview, ...(seeded ? { initialized: true } : {}), notifications: 0, wouldNotify: 0, skipped: {}, mode: enabled ? "live" : "observe" };
    const skip = (reason) => { result.skipped[reason] = (result.skipped[reason] || 0) + 1; };
    for (const event of snapshot.events) {
      const now = this.clock();
      if (snapshot.expiresAt <= now) { skip("source_expired_during_run"); break; }
      const key = eventKey(event.id);
      let record = await this.storage.get(key);
      const wasKnown = !!record;
      if (!record) {
        record = { id: event.id, group: event.group, announcedAt: event.announcedAt,
          rank: 0, highestOffered: 0, deliveries: {}, seenKeys: [] };
        await this.storage.put(key, record);
      }
      if (record.group !== event.group) {
        if (!record.blocked) { record.blocked = "reclassified"; await this.storage.put(key, record); }
      }
      if (!record.blocked && Object.values(record.deliveries).some((d) => d.status === "attempting")) {
        record.blocked = "delivery-unknown";
        await this.storage.put(key, record);
      }
      if (record.blocked) { skip(record.blocked); continue; }
      const notification = selectNotification(event);
      if (!notification) { skip("ineligible"); continue; }
      const position = { id: event.id, announcedAt: Math.min(record.announcedAt, event.announcedAt) };
      const advance = () => { if (canAdvanceHead) advanceHead(candidateHead, position, notification.kind); };
      const deliveryKey = notificationKey(event, notification);
      const priorKeys = record.seenKeys ?? Object.entries(record.deliveries).filter(([, value]) => value.status === "sent").map(([key]) => key);
      const timeUpdate = notification.rank === record.rank && deliveryKey !== notification.kind &&
        event.window?.endAt > now && !priorKeys.includes(deliveryKey);
      if ((notification.rank <= record.rank && !timeUpdate) || notification.rank < record.highestOffered || priorKeys.includes(deliveryKey)) { advance(); skip("already_seen"); continue; }
      const active = activeSignal(event, now);
      const freshness = event.announcedAt > now + 60_000 ? "future_announcement"
        : event.activeSignal && !active ? "expired_signal"
        : event.window && notification.rank < 1 && event.window.endAt <= now ? "expired_signal"
        : !wasKnown && !active && comparePosition(position, oldHead[notification.kind]) <= 0 ? "before_source_head"
        : (!wasKnown || (!record.seenKeys && record.rank === 0 && notification.rank < 1)) && !active &&
          Math.min(record.announcedAt, event.announcedAt) < initialized.at - ONE_HOUR_MS ? "historical_backfill" : null;
      if (freshness) {
        if (["historical_backfill", "expired_signal", "before_source_head"].includes(freshness)) {
          record.rank = Math.max(record.rank, notification.rank);
          record.seenKeys = [...new Set([...priorKeys, deliveryKey])];
          await this.storage.put(key, record);
        }
        advance();
        skip(freshness);
        continue;
      }
      if (!enabled) {
        record.rank = notification.rank;
        record.seenKeys = [...new Set([...priorKeys, deliveryKey])];
        await this.storage.put(key, record);
        advance();
        result.wouldNotify++;
        continue;
      }
      const discordRetryAt = await this.storage.get("discord_retry_at") || 0;
      if (discordRetryAt > now) { skip("discord_cooldown"); break; }
      // Build and validate everything before creating the irreversible attempt latch.
      const content = buildDiscordContent(event, notification);
      record.highestOffered = notification.rank;
      const pending = record.deliveries[deliveryKey];
      if (pending?.status === "pending" && now - (pending.firstSeenAt ?? pending.at) > ONE_HOUR_MS) {
        record.rank = Math.max(record.rank, notification.rank);
        record.seenKeys = [...new Set([...priorKeys, deliveryKey])];
        record.deliveries[deliveryKey] = { ...pending, status: "expired" };
        await this.storage.put(key, record);
        advance();
        skip("delivery_retry_expired"); continue;
      }
      const firstSeenAt = pending?.firstSeenAt ?? pending?.at ?? now;
      record.deliveries[deliveryKey] = { status: "pending", at: now, firstSeenAt };
      await this.storage.put(key, record);
      await this.storage.transaction(async (txn) => {
        const claimed = await txn.get(key);
        claimed.deliveries[deliveryKey] = { status: "attempting", at: now, firstSeenAt };
        await txn.put(key, claimed);
      });
      const outcome = await sendDiscord(this.env, content, { fetchImpl: this.fetchImpl, clock: this.clock });
      record.deliveries[deliveryKey] = { ...outcome, at: this.clock(), firstSeenAt };
      if (outcome.status === "sent") {
        record.rank = notification.rank; record.seenKeys = [...new Set([...priorKeys, deliveryKey])]; result.notifications++;
      }
      else if (outcome.status === "pending") await this.storage.put("discord_retry_at", outcome.retryAt);
      else record.blocked = outcome.status;
      // If this write fails, durable 'attempting' remains: the next run must NOT resend.
      await this.storage.put(key, record);
      if (outcome.status !== "sent") { skip(outcome.status); break; }
      advance();
    }
    if (canAdvanceHead && JSON.stringify(candidateHead) !== JSON.stringify(head)) await this.storage.put(HEAD_KEY, candidateHead);
    result.head = await this.storage.get(HEAD_KEY);
    if (await this.storage.get("last_error")) await this.storage.delete("last_error");
    return result;
  }

  async testDiscord() {
    if (this.env.DISCORD_TEST_ENABLED !== "true") throw new MonitorError("discord_test_disabled");
    discordUrl(this.env);
    const key = `discord_test:${MONITOR_VERSION}`;
    const previous = await this.storage.get(key);
    if (previous && !(previous.status === "pending" && previous.retryAt <= this.clock())) {
      return { skipped: previous.status, notifications: 0 };
    }
    await this.storage.put(key, { status: "attempting", at: this.clock() });
    const outcome = await sendDiscord(this.env, buildDiscordTestContent(this.clock()), {
      fetchImpl: this.fetchImpl, clock: this.clock,
    });
    await this.storage.put(key, { ...outcome, at: this.clock() });
    return { test: true, delivery: outcome.status, notifications: outcome.status === "sent" ? 1 : 0 };
  }
}
