// Versioned adapter for observed public JSON fields. No natural-language classification.
import { absoluteTime, normalizeEvent, normalizeTimeline, selectNotification } from "./events.js";

function fromPost(post, fields = {}) {
  if (!post) return null;
  const banked = post.kind === "banked" || post.reset_kind === "banked" || post.group === "credits";
  const event = normalizeEvent({ id: post.tweet_id ?? post.id, url: post.url,
    announced_at: post.at ?? post.source_at, type: "reset", group: "reset",
    announcement_state: "none", official_window: post.window,
    ...(banked ? { group: "credits", type: "credits", banked_state: post.banked_state ?? "unknown" } : {}), ...fields });
  return event;
}

export function normalizeSignals(forecast, feed) {
  if (!forecast || typeof forecast !== "object" || !Object.hasOwn(forecast, "official_signal")) throw new Error("invalid_forecast");
  if (!feed || !Array.isArray(feed.tweets) || feed.tweets.length > 5000 || feed.stale === true) throw new Error("invalid_feed");
  const events = [];
  let invalid = 0;
  const add = (post, fields, active = false, level = null, expires = null) => {
    if (!post) return;
    const event = fromPost(post, fields);
    if (!event) { invalid++; return; }
    if (expires != null && !Number.isFinite(absoluteTime(expires))) { invalid++; return; }
    event.activeSignal = active;
    event.signalLevel = level;
    event.validUntil = expires == null ? event.window?.endAt ?? null : absoluteTime(expires);
    events.push(event);
  };
  const official = forecast.official_signal;
  if (official && ["signal", "banked"].includes(official.kind)) {
    // Only an explicit banked kind changes the family; nothing is inferred from summary text.
    const banked = official.kind === "banked";
    add(official, banked ? { group: "credits", type: "credits", banked_state: official.banked_state ?? "unknown" } : {}, true, "official");
  } else if (official) invalid++;
  const lastReset = absoluteTime(forecast.last_reset_at);
  const hint = forecast.latest_hint;
  if (hint && (!Number.isFinite(lastReset) || absoluteTime(hint.at) > lastReset)) add(hint, {}, true, "hint");
  if (forecast.tease_signal?.post) {
    const tease = forecast.tease_signal;
    if (!Number.isFinite(lastReset) || absoluteTime(tease.post.at) > lastReset) add(tease.post, {}, true, "hint", tease.expires_at);
  }
  const context = forecast.context?.primary_post;
  if (context?.signal === "TEASE" && (!Number.isFinite(lastReset) || absoluteTime(context.at) > lastReset)) {
    add(context, {}, true, "hint");
  }
  const latest = forecast.latest_alert;
  if (latest?.kind === "watch" && latest.state === "active") add(latest, {}, true, "official");
  else if (latest?.kind === "reset" && latest.state === "confirmed") add(latest, { announcement_state: "announced" });
  else if (latest?.kind === "banked" && ["announced", "arriving", "available", "unknown"].includes(latest.state)) {
    add(latest, { group: "credits", type: "credits", banked_state: latest.state }, latest.state !== "available");
  }
  const headline = feed.signal;
  if (headline?.active === true && ["signal", "candidate", "banked"].includes(headline.kind)) {
    add(headline, {}, true, headline.kind === "signal" ? "official" : "hint");
  }
  for (const post of feed.tweets) {
    if (post?.kind === "signal") add(post, {}, false, "official");
    else if (post?.kind === "banked" || post?.reset_kind === "banked") add(post, { group: "credits", type: "credits", banked_state: post.banked_state ?? "unknown" });
    else if (post?.kind === "reset") add(post, { announcement_state: "announced" });
    else if (post?.kind === "candidate") add(post, {}, false, "hint");
    else if (post?.tease_classification?.status === "ok" && post.tease_classification.teasing === true) {
      // Read only the site's published verdict; never classify its text ourselves.
      add(post, {}, false, "hint");
    }
    // candidate is only a possible reset, never a completion; limits/codex alone are not signals.
  }
  // A landed reset supersedes an older generic reset forecast, but not banked grants.
  return { events: events.filter((event) => !(event.group === "reset" && event.activeSignal &&
    Number.isFinite(lastReset) && event.announcedAt <= lastReset)), invalid };
}

export function normalizeSnapshot(timeline, forecast, feed) {
  const base = normalizeTimeline(timeline);
  const signals = normalizeSignals(forecast, feed);
  const merged = new Map(base.events.map((event) => [event.id, event]));
  const conflicting = new Set(base.conflictIds);
  for (const event of signals.events) {
    const previous = merged.get(event.id);
    if (!previous) { merged.set(event.id, event); continue; }
    if (previous.group !== event.group || previous.url !== event.url || previous.announcedAt !== event.announcedAt) {
      conflicting.add(event.id); continue;
    }
    const a = selectNotification(previous)?.rank ?? 0, b = selectNotification(event)?.rank ?? 0;
    const winner = b > a ? event : previous;
    // Different publication copies may disagree on a deadline. Do not choose an arbitrary clock.
    const windowsConflict = previous.window && event.window && JSON.stringify(previous.window) !== JSON.stringify(event.window);
    const windowInvalid = previous.windowInvalid || event.windowInvalid || !!windowsConflict;
    const window = windowInvalid ? null : previous.window ?? event.window;
    merged.set(event.id, { ...winner, window,
      windowInvalid,
      activeSignal: !(winner.group === "reset" && winner.announcementState === "announced") &&
        (previous.activeSignal || event.activeSignal),
      validUntil: window?.endAt ?? previous.validUntil ?? event.validUntil,
    });
  }
  for (const id of conflicting) merged.delete(id);
  const lastReset = absoluteTime(forecast.last_reset_at);
  for (const [id, event] of merged) {
    const kind = selectNotification(event)?.kind;
    if (["reset-sign", "reset-watch"].includes(kind) && Number.isFinite(lastReset) && event.announcedAt <= lastReset) merged.delete(id);
  }
  return { events: [...merged.values()].sort((a, b) => a.announcedAt - b.announcedAt || a.id.localeCompare(b.id)),
    invalid: base.invalid + signals.invalid, conflicts: conflicting.size };
}
