"use strict";

// COORD-862 (COORD-516a): dirty paths are reported by drift scope.
const driftScope = require("./drift-scope.js");
const LISTED_DIRTY_PATH_LIMIT = 25;

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
      session_id: typeof lock.session_id === "string" ? lock.session_id.trim() : null,
    });
  }
  return live;
}

function buildTreeMutationSafetyHazard(options = {}) {
  const {
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
  resolveCurrentAgentId,
  } = options;
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
  // Identity is diagnostic only: lookup failure must not suppress the guard.
  // Resolve lazily, without claiming or touching a session, only for a hazard.
  let sessionId = null;
  try {
    const resolved = typeof resolveCurrentAgentId === "function"
      ? resolveCurrentAgentId()?.identity?.session?.session_id : null;
    sessionId = typeof resolved === "string" ? resolved.trim() : null;
  } catch (_) { /* unavailable identity is explicitly unknown */ }
  for (const lock of liveLocks) {
    lock.session_relationship = !sessionId || !lock.session_id
      ? "unknown-session"
      : sessionId === lock.session_id ? "own-session" : "foreign-session";
  }
  const scopes = driftScope.partitionDriftPaths(dirty, { enginePaths: options.enginePaths });
  return {
    dirty_non_derived_paths: dirty,
    dirty_by_scope: scopes,
    scope_summary: driftScope.summarizeDriftScopes(scopes),
    // Historical field name retained for consumers; all live locks are guarded.
    live_foreign_doing_locks: liveLocks,
  };
}

function scopeVerdict(hazard) {
  const scopes = hazard.dirty_by_scope || driftScope.partitionDriftPaths(hazard.dirty_non_derived_paths || []);
  return `Scope: ${driftScope.summarizeDriftScopes(scopes)}. Remedy by scope: ${driftScope.formatScopeRemedies(scopes)}. `;
}

function formatTreeMutationSafetyHazard(hazard) {
  if (!hazard) return "";
  const listed = hazard.dirty_non_derived_paths || [];
  const dirty = listed.length > LISTED_DIRTY_PATH_LIMIT
    ? `${listed.slice(0, LISTED_DIRTY_PATH_LIMIT).join(", ")} and ${listed.length - LISTED_DIRTY_PATH_LIMIT} more`
    : listed.join(", ");
  const locks = (hazard.live_foreign_doing_locks || [])
    .map((lock) => `${lock.ticket}${lock.owner ? `(${lock.owner})` : ""} [${lock.session_relationship || "unknown-session"}]`)
    .join(", ");
  return (
    // guard:tree-mutation-safety
    "Refusing tree-wide governance mutation because live doing locks " +
    `exist (${locks || "unknown-session"}) and the working tree has dirty non-derived ` +
    `path(s): ${dirty || "unknown"}. ` + scopeVerdict(hazard) + "Commit or stash your non-derived work first; " +
    "coordinate with the owning session before changing another session's work. " +
    "This conservative guard applies to any live doing lock, including your own."
  );
}

// guard:tree-mutation-safety
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
