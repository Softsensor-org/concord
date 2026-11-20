"use strict";

const { defaultControlPlaneLayout } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js"));

function resolveRegisteredControlPlaneWorktreeHead({ repoRoot, worktree, gitTry: git, fs: fsImpl, path: pathImpl } = {}) {
  const fileSystem = fsImpl || require("fs");
  const pathModule = pathImpl || require("path");
  if (!repoRoot || !worktree) {
    throw new Error(`Could not verify Repo X worktree ${worktree || "(missing)"}.`);
  }
  let target = null;
  try {
    if (!fileSystem.lstatSync(worktree).isSymbolicLink()) target = fileSystem.realpathSync(worktree);
  } catch { /* converted to the explicit worktree validation error below */ }
  if (!target) throw new Error(`Could not verify Repo X worktree ${worktree}.`);
  const registered = git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (registered.status !== 0) {
    throw new Error(registered.stderr || `Could not list control-plane worktrees for ${repoRoot}.`);
  }
  const worktreePaths = String(registered.stdout || "")
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  const registeredTarget = worktreePaths.some((entry) => {
    try { return fileSystem.realpathSync(entry) === target; }
    catch { return false; }
  });
  if (!registeredTarget) {
    throw new Error(`Repo X path ${worktree} is not a registered control-plane worktree.`);
  }
  const top = git(worktree, ["rev-parse", "--show-toplevel"]);
  const topLevel = String(top.stdout || "").replace(/\r?\n$/, "");
  if (top.status !== 0 || pathModule.resolve(topLevel) !== target) {
    throw new Error(`Repo X path ${worktree} is not its own Git worktree root.`);
  }
  const branch = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.status !== 0 || !String(branch.stdout || "").trim().startsWith("agent/")) {
    throw new Error(`Repo X worktree ${worktree} is not on a governed agent branch.`);
  }
  const result = git(worktree, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    throw new Error(`Could not resolve HEAD for worktree ${worktree}.`);
  }
  const head = String(result.stdout || "").trim();
  if (!head) throw new Error(`Could not resolve HEAD for worktree ${worktree}.`);
  return head;
}

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
// time (tests scope them through the governance test context). The lifecycle /
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
    controlPlaneLayout = defaultControlPlaneLayout,
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

  function usesGitHead(repoCode) {
    if (isRepoBackedCode(repoCode)) return true;
    return repoCode === "X" && Boolean(controlPlaneLayout()?.coordRepoRoot);
  }

  function resolveLockHead(repoCode, worktree) {
    if (!usesGitHead(repoCode)) {
      return "coord-no-git-head";
    }
    if (repoCode === "X") {
      const layout = controlPlaneLayout();
      try {
        return resolveRegisteredControlPlaneWorktreeHead({
          repoRoot: layout?.coordRepoRoot,
          worktree,
          gitTry,
          fs,
          path,
        });
      } catch (error) {
        fail(error && error.message ? error.message : String(error));
      }
    }
    const result = gitTry(worktree, ["rev-parse", "HEAD"]);
    if (result.status !== 0) {
      fail(`Could not resolve HEAD for worktree ${worktree}.`);
    }
    const head = String(result.stdout || "").trim();
    if (!head) {
      fail(`Could not resolve HEAD for worktree ${worktree}.`);
    }
    return head;
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
    if (!usesGitHead(repoCode)) {
      lock.head = "coord-no-git-head";
    } else if (repoCode !== "X") {
      lock.head = head || resolveLockHead(repoCode, lock.worktree);
    } else {
      const liveHead = resolveLockHead(repoCode, lock.worktree);
      if (head && head !== liveHead) {
        fail(`Supplied lock head ${head} does not match worktree HEAD ${liveHead}.`);
      }
      lock.head = liveHead;
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

module.exports.resolveRegisteredControlPlaneWorktreeHead = resolveRegisteredControlPlaneWorktreeHead;
