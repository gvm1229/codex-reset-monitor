const ONE_HOUR_MS = 60 * 60 * 1000;
const KST_TIME_ZONE = "Asia/Seoul";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export function parseVerifiedResetTime(text, postTime) {
  const value = text.toLowerCase();
  const relativeDelay = parseRelativeDelayMs(value);
  const result = relativeDelay !== null
    ? new Date(postTime.getTime() + relativeDelay)
    : parsePacificClockTime(value, postTime);
  return result && Number.isFinite(result.getTime()) ? result : null;
}

function parseRelativeDelayMs(value) {
  const numeric = value.match(
    /(?:\b(?:in|within)\s+(?:the\s+)?|^)(\d+(?:\.\d+)?)\s*(minutes?|mins?|min|hours?|hrs?|hr)\b/i,
  );
  if (numeric) {
    const amount = Number(numeric[1]);
    return /^(?:minutes?|mins?|min)$/i.test(numeric[2])
      ? amount * 60 * 1000
      : amount * ONE_HOUR_MS;
  }

  if (/\b(?:in|within)\s+(?:the\s+)?next\s+hour\b/i.test(value)) return ONE_HOUR_MS;
  return null;
}

function parsePacificClockTime(text, postTime) {
  const match = text.match(/(?:\b(?:at|around|by|landing(?:\s+at)?)\s*|^)(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(pt|pst|pdt|pacific\s+time)\b/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.replaceAll(".", "").toLowerCase();
  if (minute > 59 || hour > 23) return null;

  if (meridiem) {
    if (hour < 1 || hour > 23) return null;
    // Tibo occasionally writes a redundant form such as "14pm". Treat 13-23
    // as an unambiguous 24-hour clock rather than discarding the announcement.
    if (hour <= 12) {
      if (meridiem === "pm" && hour !== 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    } else if (meridiem === "am") {
      return null;
    }
  }

  const postPacific = zonedParts(postTime, PACIFIC_TIME_ZONE);
  let dayOffset = /\btomorrow\b/i.test(text) ? 1 : 0;
  let candidate = zonedDateToUtc(
    addDays(postPacific.year, postPacific.month, postPacific.day, dayOffset),
    hour,
    minute,
    PACIFIC_TIME_ZONE,
  );

  // Without an explicit next-day expression, do not guess that a past clock
  // time means tomorrow. The alert must have an exact, defensible KST time.
  if (!candidate || candidate.getTime() <= postTime.getTime()) return null;
  return candidate;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedDateToUtc(dateParts, hour, minute, timeZone) {
  const guess = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute);
  const candidates = new Map();
  for (const delta of [-36, 0, 36]) {
    const sample = guess + delta * ONE_HOUR_MS;
    const parts = zonedParts(new Date(sample), timeZone);
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - sample;
    const candidate = new Date(guess - offset);
    const local = zonedParts(candidate, timeZone);
    if (local.year === dateParts.year && local.month === dateParts.month && local.day === dateParts.day &&
        local.hour === hour && local.minute === minute) candidates.set(candidate.getTime(), candidate);
  }
  // Nonexistent or repeated DST clock times are not an exact instant.
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function addDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function formatKst(date) {
  const parts = zonedParts(date, KST_TIME_ZONE);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} KST`;
}
