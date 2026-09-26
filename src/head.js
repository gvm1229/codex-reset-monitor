export const HEAD_KEY = "source_head:v1";

// Derive a shared cursor from existing per-kind positions without resetting receipts.
export function latestPosition(head) {
  return Object.values(head).reduce((latest, position) =>
    comparePosition(position, latest) > 0 ? position : latest, undefined);
}

export function comparePosition(left, right) {
  if (!right) return 1;
  if (left.announcedAt !== right.announcedAt) return left.announcedAt < right.announcedAt ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

export function advanceHead(head, position, kind) {
  if (!kind || !position || typeof position.id !== "string" || !Number.isFinite(position.announcedAt)) return head;
  if (comparePosition(position, head[kind]) > 0) head[kind] = { id: position.id, announcedAt: position.announcedAt };
  return head;
}

export function legacyKind(record) {
  if (record.group === "reset") return record.rank >= 1 ? "reset" : "reset-sign";
  if (record.group === "credits") {
    if (record.rank >= 3) return "banked-available";
    if (record.rank >= 2) return "banked-arriving";
    if (record.rank >= 1) return "banked-announced";
    return "banked-sign";
  }
  return record.group === "boost" ? "boost" : null;
}

export function headFromRecords(records) {
  const head = {};
  for (const record of records) advanceHead(head, record, legacyKind(record));
  return head;
}
