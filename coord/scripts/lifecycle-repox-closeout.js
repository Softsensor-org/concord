"use strict";

const path = require("path");

module.exports = function createLifecycleRepoXCloseout({
  COORD_DIR,
  REPO_ROOTS,
  getRepoRoot,
  inferTicketIdFromPath,
  listGitWorktrees,
  repoDisplayNameForCode,
}) {
  function collectTicketWorktreeResidue(ticketId, worktreesByRepo) {
    const residue = [];
    const coordRoot = path.resolve(COORD_DIR, ".worktrees");
    for (const [repoCode, worktrees] of Object.entries(worktreesByRepo || {})) {
      for (const entry of worktrees || []) {
        if (!entry || !entry.path || inferTicketIdFromPath(entry.path) !== ticketId) {
          continue;
        }
        if (path.resolve(entry.path).startsWith(`${coordRoot}${path.sep}`)) {
          continue;
        }
        residue.push({
          repoCode,
          repoLabel: repoDisplayNameForCode(repoCode),
          path: entry.path,
          branch: entry.branch || null,
        });
      }
    }
    return residue;
  }

  function findTicketProductWorktreeResidue(ticketId) {
    const worktreesByRepo = {};
    for (const repoCode of Object.keys(REPO_ROOTS).filter((code) => code !== "X")) {
      const repoRoot = getRepoRoot(repoCode);
      worktreesByRepo[repoCode] = listGitWorktrees(repoRoot).filter((entry) => entry.path !== repoRoot);
    }
    return collectTicketWorktreeResidue(ticketId, worktreesByRepo);
  }

  function ensureRepoXCloseoutReady(ticketId) {
    const residue = findTicketProductWorktreeResidue(ticketId);
    if (residue.length === 0) {
      return null;
    }

    const details = residue
      .map((entry) => `${entry.repoLabel}:${entry.path}${entry.branch ? ` (${entry.branch})` : ""}`)
      .join(", ");
    throw new Error(
      `Ticket ${ticketId} is Repo X but still has governed backend/frontend worktree residue: ${details}. ` +
      "Repo X closeout cannot hide product-repo delivery; split that work into B/F tickets or land and clean the repo worktrees before mark-done."
    );
  }

  return {
    collectTicketWorktreeResidue,
    ensureRepoXCloseoutReady,
    findTicketProductWorktreeResidue,
  };
};
