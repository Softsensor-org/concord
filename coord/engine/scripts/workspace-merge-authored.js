"use strict";

// COORD-928 option (a) (human-admin 2026-11-13): before a workspace merge, an untracked
// file that the merge would overwrite is removed only when ALL of these hold: it is an
// ADR 0020 authored class (prompts, decisions), it is untracked in the canonical checkout,
// and its blob equals the incoming blob. The merge then writes the identical bytes back.
// If any overlap fails these checks, nothing is removed and the merge stays refused.

const fs = require("node:fs");
const path = require("node:path");

// ADR 0020 authored-content classes, relative to the coord directory.
const AUTHORED_CLASS_DIRS = ["prompts/", "docs/decisions/"];

function topLevel(gitTry, repoRoot) {
  const top = gitTry(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!top || top.status !== 0) {
    throw new Error(`workspace merge authored check could not resolve the repository top level: ${String((top && top.stderr) || "").trim()}`);
  }
  return String(top.stdout || "").trim();
}

// `overlap` is repo-top-relative (as findUncommittedMergeOverlap reports it).
// `coordDirName` is the coord directory's name in the repository (default "coord").
function identicalUntrackedAuthoredOverlaps({ gitTry, repoRoot, branch, overlap, coordDirName = "coord" }) {
  const top = topLevel(gitTry, repoRoot);
  const removable = [];
  const refused = [];
  for (const rel of overlap || []) {
    const coordRel = rel.startsWith(`${coordDirName}/`) ? rel.slice(coordDirName.length + 1) : null;
    if (!coordRel || !AUTHORED_CLASS_DIRS.some((dir) => coordRel.startsWith(dir))) {
      refused.push({ path: rel, reason: "not an ADR 0020 authored class (prompts, decisions)" });
      continue;
    }
    const status = gitTry(top, ["status", "--porcelain", "--", rel]);
    if (!status || status.status !== 0) {
      refused.push({ path: rel, reason: "could not read the working-tree state" });
      continue;
    }
    if (!String(status.stdout || "").startsWith("?? ")) {
      refused.push({ path: rel, reason: "tracked or modified in the canonical checkout, not untracked" });
      continue;
    }
    const local = gitTry(top, ["hash-object", "--", rel]);
    const incoming = gitTry(top, ["rev-parse", "--verify", "-q", `${branch}:${rel}`]);
    if (!local || local.status !== 0 || !incoming || incoming.status !== 0) {
      refused.push({ path: rel, reason: "could not compare with the incoming blob" });
      continue;
    }
    const localBlob = String(local.stdout || "").trim();
    const incomingBlob = String(incoming.stdout || "").trim();
    if (!localBlob || localBlob !== incomingBlob) {
      refused.push({ path: rel, reason: "not byte-identical to the incoming blob" });
      continue;
    }
    removable.push({ path: rel, blob: incomingBlob });
  }
  return { removable, refused };
}

// All-or-nothing: removes the identical duplicates only when every overlap is removable.
// Each removal is recorded through recordExternalSideEffect (journaled with the mutation).
function removeIdenticalAuthoredOverlaps({ gitTry, repoRoot, branch, overlap, recordExternalSideEffect, ticketId, coordDirName = "coord" }) {
  const checked = identicalUntrackedAuthoredOverlaps({ gitTry, repoRoot, branch, overlap, coordDirName });
  if (checked.refused.length > 0 || checked.removable.length === 0) {
    return { removed: [], removedEntries: [], refused: checked.refused };
  }
  const top = topLevel(gitTry, repoRoot);
  const removed = [];
  const removedEntries = [];
  for (const { path: rel, blob } of checked.removable) {
    fs.unlinkSync(path.join(top, rel));
    removed.push(rel);
    removedEntries.push({ path: rel, blob });
    if (typeof recordExternalSideEffect === "function") {
      recordExternalSideEffect({
        type: "authored_untracked_identical_removed",
        ticket: ticketId,
        branch,
        path: rel,
        blob,
        reason: "ADR 0020 authored file byte-identical to the incoming blob; the merge restores it",
      });
    }
  }
  return { removed, removedEntries, refused: [] };
}

// Abort path: after a failed merge is aborted, put each removed duplicate back from its
// verified incoming blob (`git cat-file blob`, exact bytes) and journal the restoration.
function restoreRemovedAuthoredOverlaps({ repoRoot, branch, removedEntries, recordExternalSideEffect, ticketId, gitTry }) {
  const { spawnSync } = require("node:child_process");
  const top = topLevel(gitTry, repoRoot);
  const restored = [];
  for (const { path: rel, blob } of removedEntries || []) {
    const abs = path.join(top, rel);
    if (fs.existsSync(abs)) continue;
    const result = spawnSync("git", ["-C", top, "cat-file", "blob", blob], { encoding: "buffer" });
    if (result.status !== 0) {
      throw new Error(`workspace merge abort could not restore ${rel} from ${blob}: ${String(result.stderr || "")}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, result.stdout);
    restored.push(rel);
    if (typeof recordExternalSideEffect === "function") {
      recordExternalSideEffect({
        type: "authored_untracked_identical_restored",
        ticket: ticketId,
        branch,
        path: rel,
        blob,
        reason: "merge aborted after removing a verified duplicate; restored from the incoming blob",
      });
    }
  }
  return { restored };
}

module.exports = {
  AUTHORED_CLASS_DIRS,
  identicalUntrackedAuthoredOverlaps,
  removeIdenticalAuthoredOverlaps,
  restoreRemovedAuthoredOverlaps,
};
