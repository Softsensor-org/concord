"use strict";

// COORD-862 (COORD-516a): committed-state policy, ADR 0020 (narrow Option B).
//
// Human-admin decision, 2026-10-24: tracked content committed at HEAD counts as
// reconciled ONLY for authored-content classes (prompts, decisions/ADRs); HEAD
// must be reachable from the integration branch; canonical tree only; every
// acceptance auto-appends a journal-baseline event citing the commit sha and
// paths; the board, plan records, PLAN and QUESTIONS stay journal-only.
//
// This module decides WHICH drifted authored paths qualify. It never writes:
// the journal appends the baseline event (journal.js). A path qualifies only
// when ALL of these hold, otherwise it stays drift and the seal fails closed:
//   1. the caller classified it as authored content;
//   2. it lives inside a Git checkout whose role is the canonical integration
//      tree (not a linked ticket worktree, not a role-marked ephemeral tree);
//   3. HEAD is a commit reachable from the local integration branch and, when
//      a published `origin/<branch>` exists, from that too;
//   4. the file exists, is a regular file (never a symlink), is tracked at
//      HEAD, has no staged, unstaged or untracked difference from HEAD, AND
//      the Git blob id of the bytes read from disk equals the HEAD blob id.
//      `git status` alone is not enough: an assume-unchanged or skip-worktree
//      entry hides an edit from it. A deletion is never adopted.
//
// The canonical-tree rule is enforced here as well as by the role marker:
// the checkout's `.git` must be a directory. A linked worktree has a `.git`
// file, whatever its runtime role marker claims.
//
// Each adopted path also reports `digests[key]`, computed by the caller's
// `contentDigest(bytes)` over the exact bytes verified against HEAD, so the
// caller can bind its own snapshot entry to those bytes.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function refusal(code, message) {
  return { code, message };
}

function parseNulRecords(stdout) {
  return String(stdout || "").split("\0").filter(Boolean);
}

function refExists(gitRun, cwd, ref) {
  const result = gitRun(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0 && result.stdout.trim() !== "";
}

function isAncestor(gitRun, cwd, commit, ref) {
  const result = gitRun(cwd, ["merge-base", "--is-ancestor", commit, ref]);
  return result.status === 0;
}

function blobId(bytes, objectFormat) {
  return crypto.createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function planCommittedStateAdoption(options = {}) {
  const candidates = options.candidates;
  const gitRun = options.gitRun;
  const branch = String(options.integrationBranch || "").trim();
  const empty = { adopted: [], repo_paths: [], digests: {}, rejected: [], commit: null, integration_branch: branch || null, refusal: null };
  if (candidates.length === 0) return empty;
  const reject = (code, message) => ({
    ...empty,
    rejected: candidates.map((candidate) => ({ path: candidate.key, reason: code })),
    refusal: refusal(code, message),
  });
  if (typeof gitRun !== "function") return reject("git_unavailable", "no Git runner is available");
  if (!branch) return reject("integration_branch_unknown", "the integration branch is not configured");

  const present = candidates.filter((candidate) => candidate.absolute && fs.existsSync(candidate.absolute));
  if (present.length === 0) {
    return { ...empty, rejected: candidates.map((candidate) => ({ path: candidate.key, reason: "deleted" })) };
  }
  const top = gitRun(path.dirname(present[0].absolute), ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    return reject("not_a_git_checkout", "the authored paths are not inside a Git checkout");
  }
  const repoRoot = top.stdout.trim();
  let gitDir = null;
  try { gitDir = fs.lstatSync(path.join(repoRoot, ".git")); } catch { gitDir = null; }
  if (!gitDir || !gitDir.isDirectory()) {
    return reject("linked_checkout", "committed-state adoption runs only in the canonical integration tree; this checkout's .git is not a directory");
  }
  const role = typeof options.detectRole === "function" ? options.detectRole(repoRoot) : null;
  if (role !== "canonical_integration_tree") {
    return reject("non_canonical_tree", `committed-state adoption runs only in the canonical integration tree (this checkout is ${role || "unknown"})`);
  }
  const headResult = gitRun(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = headResult.status === 0 ? headResult.stdout.trim() : "";
  if (!commit) return reject("head_unavailable", "HEAD does not name a commit");
  const localRef = `refs/heads/${branch}`;
  const publishedRef = `refs/remotes/origin/${branch}`;
  if (!refExists(gitRun, repoRoot, localRef) || !isAncestor(gitRun, repoRoot, commit, localRef)) {
    return { ...reject("head_not_on_integration_branch", `HEAD ${commit} is not reachable from ${branch}`), commit };
  }
  if (refExists(gitRun, repoRoot, publishedRef) && !isAncestor(gitRun, repoRoot, commit, publishedRef)) {
    return { ...reject("head_not_published", `HEAD ${commit} is not reachable from origin/${branch}`), commit };
  }

  const rejected = [];
  const inRepo = [];
  for (const candidate of candidates) {
    if (!candidate.absolute || !fs.existsSync(candidate.absolute)) {
      rejected.push({ path: candidate.key, reason: "deleted" });
      continue;
    }
    if (!fs.lstatSync(candidate.absolute).isFile()) {
      rejected.push({ path: candidate.key, reason: "not_a_regular_file" });
      continue;
    }
    // Git reports the real top-level path; compare real paths so a symlinked
    // temp or home directory cannot make an in-repo file look outside it.
    const repoPath = toPosix(path.relative(fs.realpathSync(repoRoot), fs.realpathSync(candidate.absolute)));
    if (repoPath.split("/")[0] === ".." || path.isAbsolute(repoPath)) {
      rejected.push({ path: candidate.key, reason: "outside_repository" });
    } else {
      inRepo.push({ ...candidate, repoPath });
    }
  }
  const pathspecs = inRepo.map((entry) => entry.repoPath);
  const headBlobs = new Map();
  const dirty = new Set();
  let objectFormat = "sha1";
  if (pathspecs.length > 0) {
    const tree = gitRun(repoRoot, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", ...pathspecs]);
    if (tree.status !== 0) return { ...reject("git_query_failed", "git ls-tree failed"), commit };
    // "<mode> <type> <oid>\t<path>": only regular blobs (100644/100755) count.
    for (const record of parseNulRecords(tree.stdout)) {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t(.*)$/s.exec(record);
      if (match) headBlobs.set(match[3], match[2]);
    }
    const format = gitRun(repoRoot, ["rev-parse", "--show-object-format"]);
    if (format.status === 0 && format.stdout.trim() === "sha256") objectFormat = "sha256";
    const status = gitRun(repoRoot, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs]);
    if (status.status !== 0) return { ...reject("git_query_failed", "git status failed"), commit };
    const records = parseNulRecords(status.stdout);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      dirty.add(record.slice(3));
      // A rename or copy carries its source path as the next NUL record.
      if (/^[RC]/.test(record)) { dirty.add(records[index + 1]); index += 1; }
    }
  }
  const adopted = [];
  const repoPaths = [];
  const digests = {};
  const contentDigest = typeof options.contentDigest === "function" ? options.contentDigest : () => null;
  for (const entry of inRepo) {
    const headBlob = headBlobs.get(entry.repoPath);
    if (!headBlob) { rejected.push({ path: entry.key, reason: "not_committed" }); continue; }
    if (dirty.has(entry.repoPath)) { rejected.push({ path: entry.key, reason: "differs_from_head" }); continue; }
    const bytes = fs.readFileSync(entry.absolute);
    if (blobId(bytes, objectFormat) !== headBlob) { rejected.push({ path: entry.key, reason: "bytes_differ_from_head" }); continue; }
    adopted.push(entry.key);
    repoPaths.push(entry.repoPath);
    digests[entry.key] = contentDigest(bytes);
  }
  return { adopted, repo_paths: repoPaths, digests, rejected, commit, integration_branch: branch, refusal: null };
}

module.exports = { planCommittedStateAdoption };
