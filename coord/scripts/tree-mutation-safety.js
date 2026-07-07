"use strict";

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^"\s*/, "")
    .replace(/\s*"$/, "");
}

function parsePorcelainStatusPaths(stdout) {
  const paths = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const body = normalizePath(rawLine.slice(3));
    if (!body) continue;
    if (body.includes(" -> ")) {
      for (const part of body.split(" -> ")) {
        const normalized = normalizePath(part);
        if (normalized) paths.push(normalized);
      }
    } else {
      paths.push(body);
    }
  }
  return [...new Set(paths)].sort();
}

function allowedPathVariants(pathValue, coordRootName = "coord") {
  const normalized = normalizePath(pathValue);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  const prefix = `${coordRootName}/`;
  if (normalized.startsWith(prefix)) {
    variants.add(normalized.slice(prefix.length));
  } else {
    variants.add(`${prefix}${normalized}`);
  }
  return [...variants];
}

function pathMatchesScope(pathValue, scopePaths, coordRootName = "coord") {
  const pathVariants = allowedPathVariants(pathValue, coordRootName);
  const scopeVariants = new Set(
    (scopePaths || []).flatMap((entry) => allowedPathVariants(entry, coordRootName))
  );
  return pathVariants.some((candidate) => {
    for (const scope of scopeVariants) {
      if (candidate === scope || candidate.startsWith(`${scope}/`)) {
        return true;
      }
    }
    return false;
  });
}

function dirtyPathsOutsideScope({ gitTry, repoRoot, allowedPaths, coordRootName = "coord" } = {}) {
  if (typeof gitTry !== "function") return [];
  const status = gitTry(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!status || status.status !== 0) return [];
  return parsePorcelainStatusPaths(status.stdout)
    .filter((entry) => !pathMatchesScope(entry, allowedPaths || [], coordRootName));
}

function liveForeignDoingLocks({
  board,
  getRows,
  isDoingStatus,
  findLockForTicket,
  isStaleTicketLock,
  currentTicketId = null,
} = {}) {
  if (!board || typeof getRows !== "function" || typeof isDoingStatus !== "function" || typeof findLockForTicket !== "function") {
    return [];
  }
  const rows = getRows(board) || [];
  const current = currentTicketId ? String(currentTicketId) : null;
  const live = [];
  for (const row of rows) {
    if (!row || !row.ID || (current && row.ID === current)) continue;
    if (!isDoingStatus(row.Status)) continue;
    const lock = findLockForTicket(row.ID);
    if (!lock) continue;
    if (typeof isStaleTicketLock === "function" && isStaleTicketLock(lock)) continue;
    live.push({
      ticket: row.ID,
      owner: row.Owner || lock.owner || "unknown",
      lock_path: lock.path || null,
      worktree: lock.worktree || null,
    });
  }
  return live;
}

function buildTreeMutationSafetyHazard({
  gitTry,
  repoRoot,
  allowedPaths,
  board,
  getRows,
  isDoingStatus,
  findLockForTicket,
  isStaleTicketLock,
  currentTicketId = null,
  coordRootName = "coord",
} = {}) {
  const dirty = dirtyPathsOutsideScope({
    gitTry,
    repoRoot,
    allowedPaths,
    coordRootName,
  });
  if (dirty.length === 0) return null;
  const liveLocks = liveForeignDoingLocks({
    board,
    getRows,
    isDoingStatus,
    findLockForTicket,
    isStaleTicketLock,
    currentTicketId,
  });
  if (liveLocks.length === 0) return null;
  return {
    dirty_non_derived_paths: dirty,
    live_foreign_doing_locks: liveLocks,
  };
}

function formatTreeMutationSafetyHazard(hazard) {
  if (!hazard) return "";
  const dirty = (hazard.dirty_non_derived_paths || []).join(", ");
  const locks = (hazard.live_foreign_doing_locks || [])
    .map((lock) => `${lock.ticket}${lock.owner ? `(${lock.owner})` : ""}`)
    .join(", ");
  return (
    "Refusing tree-wide governance mutation because a live foreign doing lock " +
    `exists (${locks || "unknown"}) and the working tree has dirty non-derived ` +
    `path(s): ${dirty || "unknown"}. Finish or isolate the live ticket, commit/stash ` +
    "the non-derived work, or rerun with an explicit human-admin override once " +
    "the concurrent work has been accounted for."
  );
}

function assertNoUnsafeTreeMutation(options = {}) {
  const hazard = buildTreeMutationSafetyHazard(options);
  if (!hazard) return null;
  const message = formatTreeMutationSafetyHazard(hazard);
  if (typeof options.fail === "function") {
    options.fail(message);
  }
  throw new Error(message);
}

module.exports = {
  parsePorcelainStatusPaths,
  pathMatchesScope,
  dirtyPathsOutsideScope,
  liveForeignDoingLocks,
  buildTreeMutationSafetyHazard,
  formatTreeMutationSafetyHazard,
  assertNoUnsafeTreeMutation,
};
