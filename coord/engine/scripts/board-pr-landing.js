"use strict";

// COORD-894 — PR landing mode for the board commit (`boardLanding: "pr"`).
//
// When the board branch refuses direct pushes (an org "require a pull
// request" ruleset), finalize/land publishes the landing commit as a
// GOVERNANCE-ONLY pull request instead: the commit is pushed (never forced) to
// a dedicated `coord-board/<ticket>` branch, a PR into the board branch is
// opened (or the existing one reused, so a retry converges), auto-merge is
// enabled with a MERGE COMMIT (so the landing commit stays an ancestor of the
// board branch and the closeout ancestry check still means what it says), and
// the merge is awaited within a bounded window. The caller completes closeout
// only when the receipt says "merged" and the remote ancestry check passes.
//
// Receipt statuses:
//   merged   — the PR merged; merge_commit_sha names the merge
//   pending  — the PR is open (auto-merge waits on reviews/checks); re-run the
//              terminal verb after it merges
//   closed   — the PR was closed without merging; nothing landed
//   failed   — the head push, PR creation or PR lookup failed (detail says why)
//
// `gh(args, { cwd })` and `sleep(ms)` are injected; tests drive fakes.

const { nonForcePush } = require("./control-plane-push.js");
const { gitTry } = require("./git-ops.js");
const { createDefaultGh } = require("./board-push-preflight.js");

const PR_LANDING_STATUS = Object.freeze({ MERGED: "merged", PENDING: "pending", CLOSED: "closed", FAILED: "failed" });
const DEFAULT_WAIT = Object.freeze({ timeoutMs: 5 * 60 * 1000, intervalMs: 10 * 1000 });

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function boardPrHeadBranch(ticketId) {
  const slug = String(ticketId || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!slug) throw new Error("A board PR landing needs a ticket id.");
  return `coord-board/${slug}`;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function stderrOf(result) {
  return String((result && (result.stderr || (result.error && result.error.message))) || "").trim() || "unknown error";
}

function viewPr(gh, url, cwd) {
  const result = gh(["pr", "view", url, "--json", "state,mergeCommit,mergedAt,url"], { cwd });
  if (!result || result.status !== 0) return null;
  return parseJson(result.stdout, null);
}

function findOrCreatePr({ gh, cwd, branch, headBranch, ticketId, commitSha }) {
  const listed = gh(["pr", "list", "--head", headBranch, "--base", branch, "--state", "open", "--json", "url"], { cwd });
  if (!listed || listed.status !== 0) return { error: `gh pr list failed: ${stderrOf(listed)}` };
  const existing = parseJson(listed.stdout, []);
  if (Array.isArray(existing) && existing[0] && existing[0].url) return { url: existing[0].url, created: false };
  const created = gh([
    "pr", "create", "--base", branch, "--head", headBranch,
    "--title", `coord: board landing for ${ticketId}`,
    "--body", `Governance-only PR (boardLanding: "pr", COORD-894): publishes board commit ${commitSha} for ${ticketId}. ` +
      "Merge with a merge commit; governance completes the closeout once this merges.",
  ], { cwd });
  const url = created && created.status === 0 ? String(created.stdout || "").trim().split(/\s+/).pop() : "";
  if (!url) return { error: `gh pr create failed: ${stderrOf(created)}` };
  return { url, created: true };
}

function landBoardCommitViaPr(options = {}) {
  const { repoRoot, branch, commitSha, ticketId } = options;
  const remote = options.remote || "origin";
  const gh = options.gh || createDefaultGh();
  const gitFn = options.gitFn || gitTry;
  const sleep = options.sleep || sleepSync;
  const wait = { ...DEFAULT_WAIT, ...(options.wait || {}) };
  const headBranch = boardPrHeadBranch(ticketId);
  const base = { mode: "pr", base_ref: branch, head_branch: headBranch, commit_sha: commitSha, pr_url: null, merge_commit_sha: null };

  const pushed = nonForcePush(repoRoot, [remote, `${commitSha}:refs/heads/${headBranch}`], { gitFn });
  if (!pushed || pushed.status !== 0) {
    return { ...base, status: PR_LANDING_STATUS.FAILED, detail: `push of ${headBranch} failed: ${stderrOf(pushed)}` };
  }
  const pr = findOrCreatePr({ gh, cwd: repoRoot, branch, headBranch, ticketId, commitSha });
  if (pr.error) return { ...base, status: PR_LANDING_STATUS.FAILED, detail: pr.error };
  const receipt = { ...base, pr_url: pr.url, pr_created: pr.created };

  const auto = gh(["pr", "merge", pr.url, "--auto", "--merge"], { cwd: repoRoot });
  receipt.auto_merge = Boolean(auto && auto.status === 0);
  if (!receipt.auto_merge) receipt.auto_merge_detail = stderrOf(auto);

  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const view = viewPr(gh, pr.url, repoRoot);
    if (view && view.state === "MERGED") {
      gitFn(repoRoot, ["fetch", remote, branch]);
      return { ...receipt, status: PR_LANDING_STATUS.MERGED, merge_commit_sha: (view.mergeCommit && view.mergeCommit.oid) || null };
    }
    if (view && view.state === "CLOSED") return { ...receipt, status: PR_LANDING_STATUS.CLOSED, detail: "the PR was closed without merging" };
    if (Date.now() >= deadline) {
      return { ...receipt, status: PR_LANDING_STATUS.PENDING, detail: `not merged after ${Math.round(wait.timeoutMs / 1000)}s` };
    }
    sleep(wait.intervalMs);
  }
}

// RETRY. An earlier run's PR may already have merged (the run then timed out,
// or failed after the merge). The commit is then on the board branch, so no
// new PR is opened; this finds the merged PR by its governance head branch and
// confirms its merge commit actually contains the landing commit, so the
// landing record can cite it. Returns null when none is found or gh cannot say.
function findMergedBoardPr(options = {}) {
  const { repoRoot, branch, commitSha, ticketId } = options;
  const gh = options.gh || createDefaultGh();
  const gitFn = options.gitFn || gitTry;
  const headBranch = boardPrHeadBranch(ticketId);
  const listed = gh(["pr", "list", "--head", headBranch, "--base", branch, "--state", "merged", "--json", "url,mergeCommit"], { cwd: repoRoot });
  if (!listed || listed.status !== 0) return null;
  const prs = parseJson(listed.stdout, []);
  for (const pr of Array.isArray(prs) ? prs : []) {
    const merge = pr && pr.mergeCommit && pr.mergeCommit.oid;
    if (!merge || !pr.url) continue;
    const contains = gitFn(repoRoot, ["merge-base", "--is-ancestor", commitSha, merge]);
    if (contains && contains.status === 0) {
      return {
        mode: "pr", status: PR_LANDING_STATUS.MERGED, base_ref: branch, head_branch: headBranch, commit_sha: commitSha,
        pr_url: pr.url, merge_commit_sha: merge, resumed: true,
      };
    }
  }
  return null;
}

// POST-SYNC PUSH IN PR MODE. `--push-after-sync` publishes the canonical sync
// commit made after closeout; under a "require a pull request" rule that is the
// push the adopter saw refused. In PR mode it goes through the same
// governance-only PR as the closeout landing commit, to the branch's upstream,
// with its own head (`coord-board/<ticket>-sync`). Already-published HEAD is a
// no-op that still cites a merged PR when one carried it.
function publishSyncCommitViaPr(options = {}) {
  const { repoRoot } = options;
  const gitFn = options.gitFn || gitTry;
  const text = (result) => (result && result.status === 0 ? String(result.stdout || "").trim() : "");
  const branch = text(gitFn(repoRoot, ["symbolic-ref", "--short", "HEAD"]));
  const tracked = branch ? text(gitFn(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`])) : "";
  const slash = tracked.indexOf("/");
  if (slash <= 0 || slash === tracked.length - 1) {
    return { pushed: false, reason: "no-upstream-or-remote", detail: `no upstream configured for ${branch || "a detached HEAD"}` };
  }
  const remote = tracked.slice(0, slash);
  const remoteBranch = tracked.slice(slash + 1);
  const commitSha = text(gitFn(repoRoot, ["rev-parse", "HEAD"]));
  const ticketId = `${options.ticketId || `sync-${commitSha.slice(0, 12)}`}-sync`;
  gitFn(repoRoot, ["fetch", remote, remoteBranch]);
  const onRemote = (ref) => gitFn(repoRoot, ["merge-base", "--is-ancestor", commitSha, ref]).status === 0;
  if (onRemote(`${remote}/${remoteBranch}`)) {
    const cited = findMergedBoardPr({ ...options, branch: remoteBranch, commitSha, ticketId, gitFn });
    return { pushed: true, mode: "pr", status: "already_present", ...(cited ? { pr_url: cited.pr_url, merge_commit_sha: cited.merge_commit_sha } : {}) };
  }
  const receipt = landBoardCommitViaPr({ ...options, remote, branch: remoteBranch, commitSha, ticketId, gitFn });
  const delivered = receipt.status === PR_LANDING_STATUS.MERGED && onRemote(`${remote}/${remoteBranch}`);
  return {
    pushed: delivered, mode: "pr", status: receipt.status, pr_url: receipt.pr_url, merge_commit_sha: receipt.merge_commit_sha,
    head_branch: receipt.head_branch, ...(delivered ? {} : { failed: true, detail: receipt.detail || "the PR merged without delivering HEAD (merge commits only)" }),
  };
}

// project.config.js `boardLandingWaitSeconds` -> the landing wait.
function prWaitFromSeconds(seconds) {
  return Number.isInteger(seconds) && seconds >= 0 ? { timeoutMs: seconds * 1000 } : {};
}

// The journal entry (an external side effect on the governed mutation) for a
// PR-landed closeout: the PR URL and the merge commit, whatever the outcome.
function boardPrLandingSideEffect(ticketId, receipt) {
  return {
    type: "control_plane_pr_landing",
    ticket: ticketId,
    status: receipt.status,
    pr_url: receipt.pr_url,
    merge_commit_sha: receipt.merge_commit_sha,
    head_branch: receipt.head_branch,
    base_ref: receipt.base_ref,
    commit_sha: receipt.commit_sha,
    auto_merge: Boolean(receipt.auto_merge),
    ...(receipt.resumed ? { resumed: true } : {}),
    forced: false,
    summary: `board PR landing ${receipt.status} for ${ticketId}${receipt.pr_url ? ` via ${receipt.pr_url}` : ""}` +
      (receipt.merge_commit_sha ? ` (merge ${String(receipt.merge_commit_sha).slice(0, 12)})` : ""),
  };
}

// The board-record citation: what landed it, and through which PR.
function boardPrLandingRecord(receipt) {
  return {
    status: receipt.status,
    pr_url: receipt.pr_url,
    merge_commit_sha: receipt.merge_commit_sha,
    head_branch: receipt.head_branch,
  };
}

module.exports = {
  PR_LANDING_STATUS,
  DEFAULT_WAIT,
  boardPrHeadBranch,
  landBoardCommitViaPr,
  findMergedBoardPr,
  publishSyncCommitViaPr,
  prWaitFromSeconds,
  boardPrLandingSideEffect,
  boardPrLandingRecord,
};
