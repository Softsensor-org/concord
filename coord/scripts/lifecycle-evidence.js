"use strict";

// COORD-296: the lifecycle PR / EVIDENCE-RESOLUTION service, extracted from
// lifecycle.js (lifecycle decomposition epic COORD-291..297, slice #5 — the fifth
// behavior-preserving extraction after the COORD-291 boundary contract, following
// sync-provenance / ticket-lock-service / ticket-queue-service / governance-plan-shape;
// it is the LAST extraction slice before the COORD-297 facade-shrink). ONE cohesive
// boundary: resolving the GIT CONTEXT (repo root / branch / worktree / lock) for a
// ticket and resolving the PR EVIDENCE refs for a closeout — distinct from
// `landing-resolution.js` (commit-ancestry / base-ref / source-commit resolution)
// and `landing-audit.js` (provenance landing records), which stay SEPARATE modules
// wired alongside this one. lifecycle.js consumes a narrow evidence-resolution API.
//
// CRITICAL INVARIANTS — preserved, NOT reimplemented:
//   - PR / no-PR evidence behavior is byte-identical: the X-lane `--no-pr` finalize
//     path and the PR-backed path resolve evidence through the exact same
//     `resolveLifecyclePrRefs` decision tree (explicit `--pr` refs → existing
//     board `pr_index` refs → repo-backed branch PR discovery → fail-closed when no
//     evidence). `verifyPrEvidence` is INJECTED (with `allowNoPr: true`) so the
//     no-PR allowance is unchanged.
//   - `resolveTicketGitContext` yields identical lock-first / worktree-fallback
//     resolution; the non-repo-backed short-circuit (`{repoRoot:null,...}`) is
//     preserved so the consumers injected as deferred wrappers in lifecycle.js
//     (landing-resolution, worktree-ops, pr-ops, ticket-commands) see no change.
//
// OWNERSHIP NOTE (COORD-088 / COORD-291 re-confirmed): `readCommitSubject` and
// `commitSubjectAffiliatesWithTicket` are review-STATE verification helpers consumed
// by `assertCommittedReviewState` (and injected into governance-validation.js), NOT
// PR/evidence resolution — none of the three functions moved here use them. They were
// deliberately left in lifecycle.js by COORD-088; COORD-296 honors the "if still
// locally owned" caveat and LEAVES them there so `assertCommittedReviewState` is
// unchanged.
//
// Everything external is INJECTED via the createLifecycleEvidence factory (NO
// `require()` of governance internals here). Collaborators that are guaranteed live
// at factory-call time are injected BY REFERENCE: the repo-registry predicates
// `isRepoBackedCode` / `getRepoRoot`, the worktree-ops readers `listGitWorktrees` /
// `inferTicketIdFromPath`, the landing-gh PR helpers `isGitHubPrUrl` /
// `ghPrListByBranch` / `verifyPrEvidence` / `mergeUniqueRefs`, and the `toArray`
// util. The lifecycle-local hoisted helpers (`findLockForTicket`, `fail`) are
// injected as deferred `(...a) => fn(...a)` wrappers so factory wiring order never
// constrains call-time resolution.
//
// lifecycle.js re-destructures the returned functions back into its scope so the
// `commands` dispatch table and the deferred wrappers other factories inject
// (`resolveTicketGitContext` / `resolvePrUrlForTicket` / `resolveLifecyclePrRefs`)
// all resolve exactly as before the move.

module.exports = function createLifecycleEvidence(deps = {}) {
  const {
    // repo registry predicates (BY REFERENCE)
    isRepoBackedCode,
    getRepoRoot,
    // worktree-ops readers (BY REFERENCE)
    listGitWorktrees,
    inferTicketIdFromPath,
    // landing-gh PR helpers (BY REFERENCE)
    isGitHubPrUrl,
    ghPrListByBranch,
    verifyPrEvidence,
    mergeUniqueRefs,
    // util (BY REFERENCE — hoisted function declaration)
    toArray,
    // lifecycle-local hoisted helpers (DEFERRED wrappers)
    findLockForTicket,
    fail,
  } = deps;

  function resolveTicketGitContext(row, ticketId) {
    if (!isRepoBackedCode(row.Repo)) {
      return {
        repoRoot: null,
        branch: null,
        worktree: null,
        lock: null,
      };
    }

    const repoRoot = getRepoRoot(row.Repo);
    const lock = findLockForTicket(ticketId);
    if (lock) {
      return {
        repoRoot,
        branch: lock.branch || null,
        worktree: lock.worktree || null,
        lock,
      };
    }

    const worktrees = listGitWorktrees(repoRoot);
    const match = worktrees.find((entry) => inferTicketIdFromPath(entry.path) === ticketId);
    return {
      repoRoot,
      branch: match?.branch || null,
      worktree: match?.path || null,
      lock: null,
    };
  }

  function resolvePrUrlForTicket(board, row, ticketId) {
    const prRefs = board.pr_index?.[ticketId] || [];
    const prUrls = prRefs.filter((entry) => isGitHubPrUrl(entry));
    if (prUrls.length === 1) {
      return prUrls[0];
    }
    if (prUrls.length > 1) {
      fail(`Ticket ${ticketId} has multiple GitHub PR refs; pass --pr <url> explicitly.`);
    }

    const ticketContext = resolveTicketGitContext(row, ticketId);
    if (!ticketContext.branch || !ticketContext.repoRoot) {
      return null;
    }
    const prs = ghPrListByBranch(ticketContext.repoRoot, ticketContext.branch);
    if (prs.length === 1) {
      return prs[0].url;
    }
    if (prs.length > 1) {
      fail(`Ticket ${ticketId} has multiple PRs for branch ${ticketContext.branch}; pass --pr <url> explicitly.`);
    }
    return null;
  }

  function resolveLifecyclePrRefs(ticketId, row, board, options) {
    const explicitRefs = toArray(options.pr);
    if (explicitRefs.length > 0) {
      verifyPrEvidence(ticketId, explicitRefs, {
        requireMerged: false,
        allowNoPr: true,
      });
      return mergeUniqueRefs([], explicitRefs);
    }

    const existingRefs = board.pr_index?.[ticketId] || [];
    if (existingRefs.length > 0) {
      verifyPrEvidence(ticketId, existingRefs, {
        requireMerged: false,
        allowNoPr: true,
      });
      return mergeUniqueRefs([], existingRefs);
    }

    if (isRepoBackedCode(row.Repo)) {
      const prUrl = resolvePrUrlForTicket(board, row, ticketId);
      if (prUrl) {
        return [prUrl];
      }
    }

    fail(`Ticket ${ticketId} has no PR evidence. Pass --pr <ref>, or create/link a PR first.`);
  }

  return {
    resolveTicketGitContext,
    resolvePrUrlForTicket,
    resolveLifecyclePrRefs,
  };
};
