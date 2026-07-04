"use strict";

// COORD-293: the ticket-lock service, extracted from lifecycle.js (lifecycle
// decomposition epic COORD-291..297, slice #2 — the second behavior-preserving
// extraction after the COORD-291 boundary contract). ONE cohesive boundary: the
// ticket-lock PATH resolution (new `.runtime/locks` vs legacy `locks` layout +
// legacy-lock promotion), lock-HEAD resolution/refresh, and the `doing`-ticket
// lock-integrity invariant (a `doing` ticket must always have a sound lock; when
// it has lost its lock the canonical worktree is used to recreate it).
//
// CRITICAL INVARIANTS — preserved, NOT reimplemented:
//   - No lock BEHAVIOR change. The live-holder protection (COORD-270: a live lock
//     holder is never evicted) and stale-lock reclaim are NOT in this slice —
//     they live in governance-context.js (the mkdir-mutex / tryReclaimStaleDirectoryLock
//     / writeDirectoryLockMetadata primitives) and in governance-session.js
//     (`findLockForTicket` / `writeLock`); this service consumes them via injected
//     deps and never duplicates them.
//   - Legacy-lock-path compatibility: `shouldUseLegacyLockCompatibility` /
//     `existingLockDirs` / `resolveTicketLockPath` preserve the exact old-vs-new
//     lock-dir layout resolution and the opt-in `promoteLegacy` move semantics.
//   - `ensureDoingTicketLockIntegrity` still enforces that a `doing` ticket has a
//     sound lock, failing closed (no owner / wrong owner / no canonical worktree /
//     no governed branch) and only auto-recreating the lock for the row's own
//     canonicalized owner from the canonical worktree.
//
// Everything external is INJECTED via the createTicketLockService factory (NO
// `require()` of governance internals here). The governance-context lock-dir
// primitive — the mutable `state` object holding `LOCKS_DIR` / `LEGACY_LOCKS_DIR`
// — is injected BY REFERENCE so the path helpers read the live values at call
// time (tests swap them through the `__testing.paths` setters). The lifecycle /
// governance-session collaborators are injected as deferred `(...a)=>fn(...a)`
// wrappers that resolve at call time, so factory wiring order never constrains
// call-time resolution:
//   - lock-dir primitive (by reference) : state (LOCKS_DIR / LEGACY_LOCKS_DIR)
//   - repo/git helpers   : gitTry, isRepoBackedCode, repoCodeForLockRepoName
//   - lock IO (governance-session) : readLockFileOrFail, findLockForTicket,
//     writeLock, moveFileIfNeeded (the legacy-promote primitive, which STAYS in
//     lifecycle.js because governance-session also consumes it)
//   - ownership / status : isDoingStatus, canonicalizeOwnerOrFail,
//     ensureTicketMutationOwnership, findActiveSessionForHandle
//   - evidence seam      : resolveTicketGitContext (the COORD-296 evidence
//     resolver — injected, not moved here)
//   - GovernanceError thrower `fail`
// `fs` and `path` are node builtins required directly by the module.
//
// lifecycle.js wires this factory and re-destructures the seven returned functions
// back into its scope so the `commands` dispatch table, the `__testing` facade,
// and the deferred wrappers other factories inject (resolveLockHead /
// resolveTicketLockPath / refreshLockHead / ensureDoingTicketLockIntegrity /
// existingLockDirs / safeResolveLockHead) all resolve exactly as before the move.

module.exports = function createTicketLockService(deps = {}) {
  const fs = require("fs");
  const path = require("path");
  const {
    // governance-context lock-dir primitive (injected BY REFERENCE)
    state,
    // repo / git helpers
    gitTry,
    isRepoBackedCode,
    repoCodeForLockRepoName,
    // lock IO (governance-session primitives, injected — not reimplemented)
    readLockFileOrFail,
    findLockForTicket,
    writeLock,
    moveFileIfNeeded,
    // ownership / status
    isDoingStatus,
    canonicalizeOwnerOrFail,
    ensureTicketMutationOwnership,
    findActiveSessionForHandle,
    // evidence seam (COORD-296 resolver — injected, not moved)
    resolveTicketGitContext,
    // GovernanceError thrower
    fail,
  } = deps;

  function resolveLockHead(repoCode, worktree) {
    if (!isRepoBackedCode(repoCode)) {
      return "coord-no-git-head";
    }
    const result = gitTry(worktree, ["rev-parse", "HEAD"]);
    if (result.status !== 0) {
      fail(`Could not resolve HEAD for worktree ${worktree}.`);
    }
    return String(result.stdout || "").trim();
  }

  function safeResolveLockHead(repoCode, worktree) {
    try {
      return resolveLockHead(repoCode, worktree);
    } catch (_) {
      return null;
    }
  }

  function refreshLockHead(ticketId, head = null) {
    const lockPath = resolveTicketLockPath(ticketId, { promoteLegacy: true });
    const lock = readLockFileOrFail(ticketId, lockPath);
    const repoCode = repoCodeForLockRepoName(lock.repo);
    if (isRepoBackedCode(repoCode)) {
      lock.head = head || resolveLockHead(repoCode, lock.worktree);
    } else {
      lock.head = "coord-no-git-head";
    }
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }

  function shouldUseLegacyLockCompatibility() {
    return path.basename(state.LOCKS_DIR) === "locks" && path.basename(path.dirname(state.LOCKS_DIR)) === ".runtime";
  }

  function existingLockDirs() {
    const dirs = [];
    if (fs.existsSync(state.LOCKS_DIR)) {
      dirs.push(state.LOCKS_DIR);
    }
    if (
      shouldUseLegacyLockCompatibility() &&
      state.LEGACY_LOCKS_DIR !== state.LOCKS_DIR &&
      fs.existsSync(state.LEGACY_LOCKS_DIR)
    ) {
      dirs.push(state.LEGACY_LOCKS_DIR);
    }
    return dirs;
  }

  function resolveTicketLockPath(ticketId, options = {}) {
    const fileName = `${ticketId}.lock`;
    const preferred = path.join(state.LOCKS_DIR, fileName);
    if (fs.existsSync(preferred)) {
      return preferred;
    }
    const legacy = path.join(state.LEGACY_LOCKS_DIR, fileName);
    if (shouldUseLegacyLockCompatibility() && legacy !== preferred && fs.existsSync(legacy)) {
      if (options.promoteLegacy === true) {
        return moveFileIfNeeded(legacy, preferred);
      }
      return legacy;
    }
    return preferred;
  }

  function ensureDoingTicketLockIntegrity(ticketId, row, options = {}) {
    if (!isDoingStatus(row?.Status)) {
      return findLockForTicket(ticketId);
    }
    let lock = findLockForTicket(ticketId);
    if (lock) {
      return lock;
    }
    const owner = row?.Owner && row.Owner !== "unassigned"
      ? canonicalizeOwnerOrFail(row.Owner)
      : null;
    if (!owner) {
      fail(`Ticket ${ticketId} is doing but has no active lock and no assigned owner.`);
    }
    const identity = ensureTicketMutationOwnership(ticketId, row, null, options);
    if (identity?.agent?.handle !== owner) {
      fail(`Ticket ${ticketId} is owned by ${owner} and cannot auto-recreate its lock for ${identity?.agent?.handle || "unknown"}.`);
    }
    const context = resolveTicketGitContext(row, ticketId);
    if (!context.worktree || !fs.existsSync(context.worktree)) {
      fail(`Ticket ${ticketId} is doing but has no active lock and no canonical worktree to recreate it from.`);
    }
    if (!context.branch) {
      fail(`Ticket ${ticketId} worktree ${context.worktree} has no governed branch association; run recover before continuing.`);
    }
    writeLock({
      ticketId,
      owner,
      repoCode: row.Repo,
      branch: context.branch,
      worktree: context.worktree,
      session: identity.session || findActiveSessionForHandle(owner),
    });
    return findLockForTicket(ticketId);
  }

  return {
    resolveLockHead,
    safeResolveLockHead,
    refreshLockHead,
    shouldUseLegacyLockCompatibility,
    existingLockDirs,
    resolveTicketLockPath,
    ensureDoingTicketLockIntegrity,
  };
};
