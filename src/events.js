export const ONE_HOUR_MS = 3_600_000;
export const BANKED_RANK = { announced: 1, arriving: 2, available: 3 };

// Accept absolute ISO timestamps only, including valid calendar dates.
export function absoluteTime(value) {
  if (typeof value !== "string") return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, zone] = m;
  const day = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== `${y}-${mo}-${d}` ||
      Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return NaN;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return NaN;
  return Date.parse(value);
}

export function normalizeWindow(raw) {
  if (raw == null) return null;
  const startAt = absoluteTime(raw.start_at), endAt = absoluteTime(raw.end_at);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return null;
  const kind = raw.target_kind ?? "range";
  if (!["deadline", "center", "range"].includes(kind)) return null;
  const targetAt = kind === "range" ? null : absoluteTime(raw.target_at);
  if (kind !== "range" && (!Number.isFinite(targetAt) || targetAt < startAt || targetAt > endAt)) return null;
  if (kind === "deadline" && targetAt !== endAt) return null;
  return { startAt, endAt, targetAt, kind };
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      typeof raw.id !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(raw.id) ||
      typeof raw.group !== "string" || raw.group.length > 64 ||
      typeof raw.type !== "string" || raw.type.length > 64 ||
      typeof raw.url !== "string" || raw.url.length > 2048) return null;
  const announcedAt = absoluteTime(raw.announced_at);
  if (!Number.isFinite(announcedAt)) return null;
  let url;
  try {
    url = new URL(raw.url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch { return null; }
  for (const field of ["announcement_state", "banked_state"]) {
    if (raw[field] != null && (typeof raw[field] !== "string" || raw[field].length > 64)) return null;
  }
  // Public window fields are validated explicitly; prose and classifier internals are discarded.
  const window = normalizeWindow(raw.official_window);
  return {
    id: raw.id, group: raw.group, type: raw.type, announcedAt,
    announcementState: raw.announcement_state ?? null,
    bankedState: raw.banked_state ?? null, url: url.href, window,
    windowInvalid: raw.official_window != null && !window,
  };
}

export function normalizeTimeline(payload) {
  if (!payload || !Array.isArray(payload.events) || payload.events.length > 5000) {
    throw new Error("invalid_timeline");
  }
  const events = new Map();
  const conflicts = new Set();
  let invalid = 0;
  for (const raw of payload.events) {
    const event = normalizeEvent(raw);
    if (!event) {
      invalid++;
      if (typeof raw?.id === "string") conflicts.add(raw.id);
      continue;
    }
    const previous = events.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) conflicts.add(event.id);
    events.set(event.id, event);
  }
  for (const id of conflicts) events.delete(id);
  return {
    events: [...events.values()].sort((a, b) => a.announcedAt - b.announcedAt || a.id.localeCompare(b.id)),
    invalid, conflicts: conflicts.size, conflictIds: [...conflicts],
  };
}

export function selectNotification(event) {
  if (event.group === "reset" && event.announcementState === "announced") {
    return { kind: "reset", rank: 1 };
  }
  if (event.group === "reset" && [null, "none"].includes(event.announcementState)) {
    return event.signalLevel === "official" ? { kind: "reset-watch", rank: 0.5 }
      : { kind: "reset-sign", rank: 0.25 };
  }
  if (event.group === "boost") return { kind: "boost", rank: 1 };
  if (event.group === "credits" && Object.hasOwn(BANKED_RANK, event.bankedState)) {
    return { kind: `banked-${event.bankedState}`, rank: BANKED_RANK[event.bankedState] };
  }
  if (event.group === "credits" && [null, "unknown"].includes(event.bankedState)) {
    return { kind: "banked-sign", rank: 0.25 };
  }
  return null;
}

export function notificationKey(event, notification) {
  const window = ["reset", "banked-available", "boost"].includes(notification.kind) ? null : event.window;
  return window ? `${notification.kind}:${window.startAt}:${window.endAt}:${window.kind}:${window.targetAt}` : notification.kind;
}

export function activeSignal(event, now) {
  if (!event.activeSignal || event.announcedAt > now + 60_000) return false;
  const until = event.validUntil ?? event.window?.endAt;
  if (until != null) return now < until;
  // The site keeps an undated official commitment active until it withdraws it.
  // Only the explicitly weak, seven-day hint surface gets an age limit.
  return event.signalLevel !== "hint" || now < event.announcedAt + 7 * 86_400_000;
}

export function eventFreshness(announcedAt, now) {
  if (announcedAt > now + 60_000) return "future_announcement";
  return now - announcedAt > ONE_HOUR_MS ? "outside_notification_window" : null;
}
