"use strict";

// COORD-1025: classifies one docs/decisions change as "metadata" (admitted at a
// workspace merge with no packet) or "body" (needs the approved packet, as
// before). Human-admin ruling 2026-11-16 ("Keep packet for acceptance"):
//   * Admitted without a packet: Status lines set to any value other than
//     Accepted or Superseded, Date, Supersedes and link bullets in the leading
//     block, and README index rows that differ only in a non-Accepted,
//     non-Superseded Status cell.
//   * Packet required: a Status line or README index row whose new value is
//     Accepted or Superseded; ANY change to the Approval State section; and every
//     other line (titles, headings, Decision and Context sections, new or deleted
//     files, mode-only changes, a removed Status line with no replacement, and
//     diffs above the size cap). Pure: no file, ref or record is read.

const METADATA_FIELD = /^\s*(?:[-*]\s+)?(?:\*\*)?(Status|Date|Supersedes|Superseded by|Ticket|Linked scope|Links|Related)(?:\*\*)?\s*:/;
const STATUS_FIELD = /^\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/;
const PACKET_STATUS = /^\s*(Accepted|Superseded)\b/i;
const APPROVAL_SECTION = "Approval State";
const MAX_CELLS = 4000000;

// Per-line verdict for one ADR document. `side` is "old" or "new": only the new
// side decides whether a Status line sets Accepted or Superseded.
function adrLineInfo(text, side = "new") {
  const info = [];
  let inLeading = true;
  let section = null;
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      inLeading = false;
      section = line.slice(3).trim();
      info.push({ kind: "body", field: null, reason: null });
    } else if (inLeading) {
      const status = STATUS_FIELD.exec(line);
      if (status) {
        const packet = side === "new" && PACKET_STATUS.test(status[1]);
        info.push({ kind: packet ? "body" : "metadata", field: "status", reason: packet ? "Status set to Accepted or Superseded" : null });
      } else if (line.trim() === "" || METADATA_FIELD.test(line)) {
        info.push({ kind: "metadata", field: null, reason: null });
      } else {
        info.push({ kind: "body", field: null, reason: null });
      }
    } else if (section === APPROVAL_SECTION) {
      info.push({ kind: "body", field: null, reason: "Approval State changed" });
    } else {
      info.push({ kind: "body", field: null, reason: null });
    }
  }
  return info;
}

// Per-line kind only ("metadata" or "body"); see adrLineInfo for the reasons.
function adrLineKinds(text, side = "new") {
  return adrLineInfo(text, side).map((entry) => entry.kind);
}

// Line-level diff: indexes of old lines removed and new lines added. Trims the
// common prefix and suffix first; returns null when the middle is too large.
function lineDiff(oldLines, newLines) {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const n = oldEnd - start, m = newEnd - start;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[start + i] === newLines[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const removed = [], added = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[start + i] === newLines[start + j]) { i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { removed.push(start + i); i += 1; }
    else { added.push(start + j); j += 1; }
  }
  while (i < n) { removed.push(start + i); i += 1; }
  while (j < m) { added.push(start + j); j += 1; }
  return { removed, added };
}

// README index rows are metadata only when a removed row and an added row match
// in every cell except the last (the Status cell). The added row is body when its
// Status cell is Accepted or Superseded.
function indexRowKinds(oldLines, newLines, diff) {
  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const isRow = (line) => /^\|\s*\[\d{4}\]/.test(line);
  const kinds = new Map();
  const unmatched = [...diff.added];
  for (const index of diff.removed) {
    const line = oldLines[index];
    if (!isRow(line)) continue;
    const old = cells(line);
    const match = unmatched.findIndex((addedIndex) => {
      const next = cells(newLines[addedIndex]);
      return isRow(newLines[addedIndex]) && next.length === old.length &&
        next.slice(0, -1).join("\u0000") === old.slice(0, -1).join("\u0000");
    });
    if (match >= 0) {
      const addedIndex = unmatched[match];
      const packet = PACKET_STATUS.test(cells(newLines[addedIndex]).at(-1));
      kinds.set(`old:${index}`, "metadata");
      kinds.set(`new:${addedIndex}`, packet ? "body" : "metadata");
      if (packet) kinds.set(`reason:new:${addedIndex}`, "README index row set to Accepted or Superseded");
      unmatched.splice(match, 1);
    }
  }
  return kinds;
}

// Classifies one changed docs/decisions path. oldText and newText are the
// bytes before and after the landing (null when the file is absent on that
// side). Returns { path, kind, bodyLines, metadataLines, reason }.
function classifyDecisionChange({ path, oldText, newText }) {
  const result = (kind, extra = {}) => ({ path, kind, bodyLines: [], metadataLines: 0, reason: null, ...extra });
  if (oldText == null) return result("body", { reason: "added or replaced file" });
  if (newText == null) return result("body", { reason: "deleted file" });
  if (oldText === newText) return result("body", { reason: "mode or type change without a text change" });
  const oldLines = oldText.split("\n"), newLines = newText.split("\n");
  const diff = lineDiff(oldLines, newLines);
  if (diff === null) return result("body", { reason: "diff too large to classify line by line" });
  const isIndex = /(^|\/)README\.md$/.test(path);
  const reasons = new Set();
  const bodyLines = [];
  let metadataLines = 0;
  if (isIndex) {
    const indexKinds = indexRowKinds(oldLines, newLines, diff);
    const classify = (side, index) => indexKinds.get(`${side}:${index}`) || "body";
    for (const index of diff.removed) {
      if (classify("old", index) === "body") bodyLines.push(`-${oldLines[index]}`); else metadataLines += 1;
    }
    for (const index of diff.added) {
      if (classify("new", index) === "body") {
        bodyLines.push(`+${newLines[index]}`);
        reasons.add(indexKinds.get(`reason:new:${index}`) || "index row changed");
      } else metadataLines += 1;
    }
  } else {
    const oldInfo = adrLineInfo(oldText, "old"), newInfo = adrLineInfo(newText, "new");
    const removedStatus = diff.removed.filter((index) => oldInfo[index].field === "status").length;
    const addedStatus = diff.added.filter((index) => newInfo[index].field === "status").length;
    if (removedStatus > addedStatus) reasons.add("Status line removed without a replacement");
    for (const index of diff.removed) {
      if (oldInfo[index].kind === "body") { bodyLines.push(`-${oldLines[index]}`); if (oldInfo[index].reason) reasons.add(oldInfo[index].reason); }
      else metadataLines += 1;
    }
    for (const index of diff.added) {
      if (newInfo[index].kind === "body") { bodyLines.push(`+${newLines[index]}`); if (newInfo[index].reason) reasons.add(newInfo[index].reason); }
      else metadataLines += 1;
    }
  }
  const body = bodyLines.length > 0 || reasons.size > 0;
  const reason = body ? ([...reasons].join("; ") || "body lines changed") : "metadata lines only";
  return result(body ? "body" : "metadata", { bodyLines, metadataLines, reason });
}

module.exports = { classifyDecisionChange, adrLineKinds, lineDiff };
