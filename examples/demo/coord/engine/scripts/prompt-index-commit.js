"use strict";

// COORD-928: a board publication may only reference prompt files that are in the
// commit being published. prompt_index entries are checked against HEAD plus the
// paths the publication stages (the sync delta). Inspection failures refuse; a
// failed `git ls-tree` is never read as an empty HEAD (vector finding, 2026-11-07).

const fs = require("node:fs");
const path = require("node:path");
const { canonicalCallerPath } = require("./canonical-path.js");
const { resolveEngineModule } = require("../../paths.js");
const defaultGitTry = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js")).gitTry;

const REMEDY =
  "Remedy: commit each listed prompt file to the integration branch through a governed ticket branch " +
  "(ADR 0020 authored-content class), then re-run the publication. COORD-928 tracks the commit path.";

function inspectionError(detail) {
  return new Error(`prompt_index commit check could not inspect git state: ${detail}. Nothing was published.`);
}

function gitTopLevel(gitTry, coordDir) {
  const top = gitTry(coordDir, ["rev-parse", "--show-toplevel"]);
  if (!top || top.status !== 0) {
    throw inspectionError(String((top && top.stderr) || "rev-parse --show-toplevel failed").trim());
  }
  const root = String(top.stdout || "").trim();
  if (!root) throw inspectionError("rev-parse returned an empty repository root");
  return root;
}

// Committed paths (repo-top-relative) among `gitPaths` at HEAD. Returns an empty set
// only for a genuinely unborn branch; any other failure throws.
function committedAtHead(gitTry, coordDir, topLevel, gitPaths) {
  const symref = gitTry(coordDir, ["symbolic-ref", "-q", "HEAD"]);
  if (!symref || symref.status !== 0) {
    throw inspectionError("HEAD is not a symbolic ref to a branch");
  }
  const ref = String(symref.stdout || "").trim();
  if (!ref) throw inspectionError("symbolic-ref returned an empty branch name");
  const head = gitTry(coordDir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (!head || head.status !== 0) {
    const exists = gitTry(coordDir, ["show-ref", "--verify", "-q", ref]);
    // show-ref exits 1 only when the ref does not exist: the unborn first publication.
    if (exists && exists.status === 1) return new Set();
    throw inspectionError(String((head && head.stderr) || `HEAD (${ref}) cannot be resolved`).trim());
  }
  if (gitPaths.length === 0) return new Set();
  const listed = gitTry(topLevel, ["ls-tree", "-z", "--name-only", "HEAD", "--", ...gitPaths]);
  if (!listed || listed.status !== 0) {
    throw inspectionError(String((listed && listed.stderr) || "git ls-tree HEAD failed").trim());
  }
  return new Set(String(listed.stdout || "").split("\0").filter(Boolean));
}

// Returns [{ ticket, path, gitPath, reason }]; reason is "absent" (not on disk) or
// "untracked" (on disk, not in the commit). Empty when every entry is publishable.
function promptIndexCommitGaps({ gitTry = defaultGitTry, coordDir, promptIndex, stagedPaths = [] } = {}) {
  const entries = Object.entries(promptIndex && typeof promptIndex === "object" ? promptIndex : {});
  if (entries.length === 0) return [];
  const workspaceRoot = path.dirname(coordDir);
  const topLevel = gitTopLevel(gitTry, coordDir);
  const resolved = entries.map(([ticket, rel]) => {
    const abs = typeof rel === "string" && rel.trim() ? path.resolve(workspaceRoot, rel) : null;
    // COORD-1015: git's toplevel is canonical; compare the canonical entry path with it.
    const gitPath = abs ? path.relative(topLevel, canonicalCallerPath(abs)).split(path.sep).join("/") : null;
    return { ticket, rel, abs, gitPath };
  });
  const committed = committedAtHead(gitTry, coordDir, topLevel, resolved.filter((r) => r.gitPath).map((r) => r.gitPath));
  const staged = new Set(stagedPaths.map((p) => path.resolve(coordDir, p)));
  const gaps = [];
  for (const entry of resolved) {
    if (!entry.gitPath) {
      gaps.push({ ticket: entry.ticket, path: String(entry.rel), gitPath: null, reason: "invalid-path" });
      continue;
    }
    if (committed.has(entry.gitPath) || staged.has(entry.abs)) continue;
    gaps.push({
      ticket: entry.ticket,
      path: entry.rel,
      gitPath: entry.gitPath,
      reason: fs.existsSync(entry.abs) ? "untracked" : "absent",
    });
  }
  return gaps;
}

// guard:publish-board-refusal
function formatPromptIndexRefusal(gaps) {
  const list = gaps.map((g) => `${g.ticket} -> ${g.path} (${g.reason === "absent"
    ? "absent from the tree"
    : g.reason === "untracked" ? "untracked: not in the commit" : g.reason})`).join("; ");
  return `Refusing to publish: prompt_index entries reference prompt files absent from the commit being published: ${list}. ${REMEDY} Nothing was published.`;
}

// guard:publish-board-refusal
function assertPromptIndexCommittable({ gitTry = defaultGitTry, coordDir, promptIndex, stagedPaths = [], fail } = {}) {
  const gaps = promptIndexCommitGaps({ gitTry, coordDir, promptIndex, stagedPaths });
  if (gaps.length > 0) {
    const message = formatPromptIndexRefusal(gaps);
    if (typeof fail === "function") fail(message);
    throw new Error(message);
  }
  return gaps;
}

module.exports = {
  promptIndexCommitGaps,
  assertPromptIndexCommittable,
  formatPromptIndexRefusal,
};
