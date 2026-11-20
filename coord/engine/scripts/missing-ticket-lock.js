"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { canonicalCallerPath } = require("./canonical-path.js");

// Called only inside the governance transaction, after ownership authorization.
// Resolve against registered worktrees before changing the board owner. Never
// create a directory, choose a new branch, or turn a canonical checkout into a lock.
function restoreMissingTicketLock({ ticketId, row, owner, session, resolveTicketGitContext, writeLock, findLockForTicket }) {
  const context = resolveTicketGitContext(row, ticketId);
  verifyTicketWorktree(ticketId, context);
  writeLock({ ticketId, owner, repoCode: row.Repo, branch: context.branch, worktree: context.worktree, session });
  return findLockForTicket(ticketId);
}

function verifyTicketWorktree(ticketId, context) {
  const { worktree, branch, repoRoot } = context;
  const invalid = () => { throw new Error(`Cannot recover ${ticketId}: a verified existing ticket worktree and branch are required.`); };
  if (!worktree || !repoRoot || !branch || !fs.existsSync(worktree)) invalid();
  if (fs.lstatSync(worktree).isSymbolicLink() || fs.realpathSync(worktree) === fs.realpathSync(repoRoot)) invalid();
  if (path.basename(worktree) !== ticketId || !branch.startsWith("agent/")) invalid();
  const registered = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n")
    .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9))
    .filter((entry) => path.basename(entry) === ticketId);
  // COORD-1015: git lists canonical paths; compare against the canonical worktree path.
  if (registered.length !== 1 || path.resolve(registered[0]) !== canonicalCallerPath(worktree)) invalid();
  let liveBranch;
  let topLevel;
  try {
    const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    liveBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    topLevel = git(["rev-parse", "--show-toplevel"]);
    git(["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch { invalid(); }
  if (liveBranch !== branch || fs.realpathSync(topLevel) !== fs.realpathSync(worktree)) invalid();

}

module.exports = { restoreMissingTicketLock, verifyTicketWorktree };
