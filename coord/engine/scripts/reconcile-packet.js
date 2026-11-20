"use strict";

// COORD-722: the approved packet `gov reconcile --expect-paths-file` binds to.
// Two accepted shapes, both naming every adopted path with its exact bytes:
//
//   1. Line packet (what `gov reconcile --dry-run` prints as expect_paths_packet):
//      one `<sha256|absent> <coord-relative path>` per line, sha256sum order;
//      `#` comments and blank lines are ignored.
//   2. Markdown approval packet (coord/docs/evidence/*-packet.md): a table whose
//      header has `path` and `sha256` columns, with REPO-relative paths
//      (`coord/docs/decisions/...`). Every row of such a table is an entry; prose
//      and other tables around it are ignored, so the human-approved file is
//      used verbatim.
//
// Either shape resolves to a Map of coord-relative path -> sha256|"absent".

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const HASH_PATTERN = /^([0-9a-f]{64}|absent)$/i;

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function normalizePacketPath(value, format, fail) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") ||
      value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`--expect-paths-file ${format} path must be a normalized relative POSIX path: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    fail(`--expect-paths-file ${format} path must be a normalized relative POSIX path: ${value}`);
  }
  return value;
}

function toCoordRelative(repoRelative, coordDir, fail) {
  const normalized = normalizePacketPath(repoRelative, "table", fail);
  const prefix = `${path.basename(coordDir)}/`;
  if (!normalized.startsWith(prefix)) {
    fail(`--expect-paths-file table path must be repo-relative under ${prefix}: ${repoRelative}`);
  }
  return normalized.slice(prefix.length);
}

function collectTableEntries(lines, coordDir, fail) {
  const entries = [];
  let columns = null;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      columns = null;
      return;
    }
    const cells = splitTableRow(line);
    if (!columns) {
      const header = cells.map((cell) => cell.toLowerCase());
      columns = header.includes("path") && header.includes("sha256")
        ? { path: header.indexOf("path"), hash: header.indexOf("sha256") }
        : { skip: true };
      return;
    }
    if (columns.skip || cells.every((cell) => /^:?-+:?$/.test(cell))) return;
    const hash = cells[columns.hash] || "";
    const repoPath = (cells[columns.path] || "").replace(/^`(.*)`$/, "$1");
    if (!HASH_PATTERN.test(hash) || !repoPath) {
      fail(`--expect-paths-file table row on line ${index + 1} needs a repo-relative path and a sha256 (or "absent"): ${line}`);
    }
    entries.push([toCoordRelative(repoPath, coordDir, fail), hash.toLowerCase()]);
  });
  return entries;
}

function collectLineEntries(lines, fail) {
  const entries = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^([0-9a-f]{64}|absent)\s+(.+)$/i.exec(line);
    if (!match) fail(`--expect-paths-file line ${index + 1} is not "<sha256|absent> <path>": ${line}`);
    entries.push([normalizePacketPath(match[2], "line", fail), match[1].toLowerCase()]);
  });
  return entries;
}

function isMarkdownPacket(lines) {
  return lines.some((raw) => {
    const line = raw.trim();
    if (!line.startsWith("|")) return false;
    const header = splitTableRow(line).map((cell) => cell.toLowerCase());
    return header.includes("path") && header.includes("sha256");
  });
}

function parseReconcilePacket(text, { coordDir, fail }) {
  const lines = String(text).split(/\r?\n/);
  const markdown = isMarkdownPacket(lines);
  if (markdown && lines.some((raw) => {
    const line = raw.trim();
    return line && !line.startsWith("#") && /^(?:[a-f0-9]{64}|absent)\s+.+$/i.test(line);
  })) {
    // guard:reconcile-approved-packet
    fail("--expect-paths-file must use exactly one packet format; mixed table and line entries are refused.");
  }
  const entries = markdown ? collectTableEntries(lines, coordDir, fail) : collectLineEntries(lines, fail);
  const packet = new Map();
  for (const [entryPath, hash] of entries) {
    const normalized = normalizePacketPath(entryPath, markdown ? "table" : "line", fail);
    if (packet.has(normalized)) fail(`--expect-paths-file lists ${normalized} more than once.`);
    packet.set(normalized, hash);
  }
  if (packet.size === 0) fail("--expect-paths-file names no paths; an approved packet lists every path to adopt.");
  return packet;
}

// Only transient sessions and ticket locks are omitted from a reconcile packet.
// Durable runtime evidence such as .runtime/plans remains governed and must be
// bound to the approval even when the surrounding runtime directory is ignored
// by Git.
function isRecoverableRuntimePath(relativePath) {
  const value = String(relativePath || "");
  return value === "agent_sessions.json" || value === ".runtime/agent_sessions.json" ||
    value === ".runtime/agents.json" || value.startsWith("locks/") || value.startsWith(".runtime/locks/");
}

function dropRuntimeLedgerPaths(relativePaths, isRuntimePath = isRecoverableRuntimePath) {
  return relativePaths.filter((entry) => !isRuntimePath(entry));
}

// guard:reconcile-approved-packet
function assertReconcileSnapshotMatchesPacket(packet, beforeSnapshot, afterSnapshot,
  { coordDir, fail, isRuntimePath = isRecoverableRuntimePath }) {
  const before = new Map((beforeSnapshot?.files || []).map((entry) => [entry.path, entry]));
  const after = new Map((afterSnapshot?.files || []).map((entry) => [entry.path, entry]));
  const changedDuringMutation = [...new Set([...before.keys(), ...after.keys()])]
    .filter((entry) => {
      const left = before.get(entry);
      const right = after.get(entry);
      return (!left || !right || left.exists !== right.exists || left.digest !== right.digest) &&
        !isRuntimePath(entry);
    })
    .sort();
  if (changedDuringMutation.length) {
    fail(`Reconcile refused: the actual after-snapshot changed after packet validation: ${changedDuringMutation.join(", ")}. Nothing was adopted.`);
  }

  const mismatches = [];
  for (const [relativePath, approvedHash] of packet) {
    const snapshotEntry = after.get(relativePath);
    if (approvedHash === "absent") {
      if (snapshotEntry?.exists) mismatches.push(`${relativePath} is present in the actual after-snapshot, approved absent`);
      continue;
    }
    if (!snapshotEntry?.exists) {
      mismatches.push(`${relativePath} is absent from the actual after-snapshot, approved ${approvedHash}`);
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(path.resolve(coordDir, relativePath));
    } catch {
      mismatches.push(`${relativePath} could not be read for after-snapshot verification`);
      continue;
    }
    const snapshotDigest = crypto.createHash("sha1").update(bytes.toString("utf8"), "utf8").digest("hex");
    const approvedDigest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (snapshotDigest !== snapshotEntry.digest || approvedDigest !== approvedHash) {
      mismatches.push(`${relativePath} does not match the approved bytes in the actual after-snapshot`);
    }
  }
  if (mismatches.length) {
    // guard:reconcile-approved-packet
    fail(`Reconcile refused: the actual after-snapshot does not match the approved packet: ${mismatches.join("; ")}. Nothing was adopted.`);
  }
}

module.exports = { parseReconcilePacket, dropRuntimeLedgerPaths, assertReconcileSnapshotMatchesPacket };
