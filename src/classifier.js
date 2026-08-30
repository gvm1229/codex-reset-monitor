import { parseVerifiedResetTime } from "./time.js";

export function classifyPost(_env, post, pendingContexts = {}) {
  const analysis = analyzeResetAnnouncement(post.text ?? "", post.created_at, pendingContexts, post);
  return { analysis, classifier: "javascript", retry: false };
}

export function determineResetTime(text, postCreatedAt, pendingContexts = null) {
  return analyzeResetAnnouncement(text, postCreatedAt, pendingContexts)?.resetAt ?? null;
}

export function analyzeResetAnnouncement(text, postCreatedAt, pendingContext = null, post = {}) {
  const value = text.toLowerCase();
  const postTime = new Date(postCreatedAt);
  if (Number.isNaN(postTime.getTime())) return null;

  const pendingContexts = normalizePendingContexts(pendingContext);
  const linkedContext = selectLinkedContext(post, pendingContexts, postTime);

  if (isNonAnnouncement(value)) return null;

  if (isBankedReset(value)) {
    const resetAt = parseVerifiedResetTime(value, postTime);
    if (!resetAt) {
      return { kind: "banked-announcement", resetAt: null, resetType: "banked", announcedAs: "scheduled" };
    }
    return {
      kind: "banked-reset",
      resetAt,
      resetType: "banked",
      announcedAs: isAlreadyEffective(value) ? "completed" : "scheduled",
      clarificationOf: pendingContexts.banked?.sourcePostId ?? null,
    };
  }

  const renewedUsage = isRenewedUsage(value);
  const directlyRelevant = isRelevantLimitAnnouncement(value) || renewedUsage;
  const contextualFollowUp = !directlyRelevant && linkedContext && isTimingFollowUp(value);
  if (!directlyRelevant && !contextualFollowUp) {
    return isCodexLimitContext(value) ? { kind: "context", resetType: "usage" } : null;
  }

  if (contextualFollowUp) {
    const resetAt = parseVerifiedResetTime(value, postTime);
    if (!resetAt) return null;
    return {
      kind: linkedContext.resetType === "banked" ? "banked-reset" : "reset",
      resetAt,
      resetType: linkedContext.resetType,
      announcedAs: "scheduled",
      clarificationOf: linkedContext.sourcePostId,
    };
  }

  if (isAlreadyEffective(value)) {
    return { kind: "reset", resetAt: postTime, resetType: "usage", announcedAs: "completed" };
  }

  const resetAt = parseVerifiedResetTime(value, postTime);
  if (resetAt) {
    return { kind: "reset", resetAt, resetType: "usage", announcedAs: "scheduled" };
  }

  if (renewedUsage) {
    return { kind: "reset", resetAt: postTime, resetType: "usage", announcedAs: "completed" };
  }

  return { kind: "context", resetType: "usage" };
}

export function isRelevantLimitAnnouncement(value) {
  const mentionsCodex = /\bcodex\b/i.test(value) || /(^|\s)\/fast\b/i.test(value);
  const mentionsLimit = /\b(?:usage\s+limits?|rate\s+limits?|quotas?|limits?|restrictions?)\b/i.test(value);
  const usageReset = /\busage\s+(?:reset|resets|resetting|reseting)\b/i.test(value);
  const reset = /\b(?:reset|resets|resetting|reseting|restored?|restoring)\b/i.test(value);
  const increase = /\b(?:increase(?:d|s|ing)?|raise(?:d|s|ing)?|higher|double(?:d)?|2x|lift(?:ed|s|ing)?|remov(?:e|ed|es|ing))\b/i.test(value);
  return (mentionsCodex && ((mentionsLimit && (reset || increase)) || usageReset)) ||
    (/\breset\b/i.test(value) && /(^|\s)\/fast\b/i.test(value));
}

function isAlreadyEffective(value) {
  return (
    /\b(?:we|i)\s+(?:have|have\s+just|'ve)\s+(?:fully\s+)?(?:reset|restored|lifted|increased)\b/i.test(value) ||
    /\b(?:we|i)\s+(?:are|'re)\s+(?:fully\s+)?reset(?:t)?ing\b/i.test(value) ||
    /\b(?:usage|rate)\s+limits?\s+(?:have|has|were|was)\s+(?:just\s+)?(?:been\s+)?(?:reset|restored|lifted|increased)\b/i.test(value) ||
    /\b(?:usage|rate)\s+limits?\s+(?:have|has)\s+been\s+(?:doubled|raised)\b/i.test(value) ||
    /\b(?:reset|lifted|increased)\s+(?:the\s+)?(?:usage|rate)?\s*limits?\s+(?:across|for|on)\s+codex\b/i.test(value)
  );
}

function isCodexLimitContext(value) {
  return /\bcodex\b/i.test(value) && /\b(?:usage|rate|quota|limit|limits|reset|reseting|resetting)\b/i.test(value);
}

function isTimingFollowUp(value) {
  return /\b(?:land|lands|landing|arrive|arrives|arriving)\b/i.test(value) &&
    /\b(?:pt|pst|pdt|pacific\s+time|minutes?|mins?|hours?|hrs?)\b/i.test(value);
}

function isBankedReset(value) {
  return /\bbanked\s+reset\b/i.test(value);
}

function isRenewedUsage(value) {
  return /\b(?:brand\s+new|fresh)\s+usage\b[^.!?]*\b(?:codex|all\s+(?:paid\s+)?users?)\b/i.test(value) ||
    /\bfull\s+tank\s+of\s+usage\s+again\b[^.!?]*\bcodex\b/i.test(value);
}

function isNonAnnouncement(value) {
  return (
    /\?\s*$/.test(value) ||
    /\b(?:wish|hope|if only)\b[^.!?]*\b(?:reset|reseting|resetting|usage)\b/i.test(value) ||
    /\b(?:no|not|never|won't|will not|cannot|can't)\b[^.!?]*\b(?:reset|reseting|resetting|increase|usage)\b/i.test(value)
    || /\b(?:feeling|feel|felt)\s+reset\b/i.test(value)
  );
}

function selectLinkedContext(post, contexts, postTime) {
  const eligible = [contexts.usage, contexts.banked].filter((context) =>
    context && Number.isFinite(Date.parse(context.createdAt)) &&
    Date.parse(context.createdAt) <= postTime.getTime() && context.expiresAt > postTime.getTime(),
  );
  const replyIds = new Set(
    (post.referenced_tweets ?? [])
      .filter((reference) => reference.type === "replied_to")
      .map((reference) => reference.id),
  );
  const explicitlyLinked = eligible.find((context) => replyIds.has(context.sourcePostId));
  if (explicitlyLinked) return explicitlyLinked;
  if (replyIds.size) return null;
  return eligible.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

function normalizePendingContexts(value) {
  if (!value) return { usage: null, banked: null };
  if (Object.hasOwn(value, "usage") || Object.hasOwn(value, "banked")) {
    return { usage: value.usage ?? null, banked: value.banked ?? null };
  }
  return {
    usage: value.resetType === "usage" ? value : null,
    banked: value.resetType === "banked" ? value : null,
  };
}
