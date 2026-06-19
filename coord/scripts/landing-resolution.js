"use strict";

// Wave 4 slice 4 (COORD-088): the landing COMMIT-RESOLUTION surface extracted
// from lifecycle.js. This module owns git-ancestry / base-ref / source-commit
// resolution ONLY: deciding which commit SHA a landing actually points at, and
// which base ref ancestry should be measured against.
//
// BOUNDARY: GitHub API TRANSPORT stays in landing-gh.js (ghPrView, mergePrUrl,
// verifyPrEvidence, the gh retry/backoff) and landing AUDIT behavior stays in
// landing-audit.js (COORD-070: classify / audit-report / landing-record
// writers). landing-resolution.js never shells out to gh and never writes
// audit records — it only READS git (via injected git-ops: gitTry) and the
// repo registry to resolve commit ancestry. The ONE GH read it needs
// (ghPrView, to read mergeCommit.oid for a merged PR landing) is INJECTED from
// landing-gh.js, not re-implemented. mergeUniqueRefs / toArray are likewise
// injected from landing-gh.js. The commit-subject affiliation helpers
// (readCommitSubject / commitSubjectAffiliatesWithTicket) deliberately STAY in
// lifecycle.js: they are review-state verification helpers (used by
// assertCommittedWorkAheadOfBase), not commit-resolution, and they are not
// called by any function in this module.
//
// resolveFulfilledByLandingCommit and resolveLandingCommitSha reach back into
// each other (fulfilled-by resolution falls back to resolving the canonical
// landing commit of the referenced ticket); both live here so the cycle is
// local. Deferred `(...args) => fn(...args)` wrappers are unnecessary inside
// the factory because all bodies are co-located, but the factory still exposes
// each binding so lifecycle.js can re-destructure them for its dispatch /
// __testing / re-export surface and inject the same bindings into the
// landing-audit.js factory (which calls resolveLandingBaseRef /
// resolveLandingCommitSha / resolveSourceCommitSha / resolveFulfilledByLanding-
// Commit / extractCommitShas).

module.exports = function createLandingResolution(deps = {}) {
  const {
    // process/runtime
    fail,
    fs,
    DEFAULT_INTEGRATION_BRANCH,
    // git-ancestry helpers (injected from the git-ops factory wired in lifecycle:
    // resolveCommitishInRepo/fetchRepoRef/isCommitAncestorOfRef all run git under
    // the hood. No function in this module calls gitTry directly — ancestry is
    // expressed through these higher-level seams — so git-ops.gitTry is NOT
    // injected here.)
    resolveCommitishInRepo,
    fetchRepoRef,
    isCommitAncestorOfRef,
    // repo registry
    getRepoRoot,
    isRepoBackedCode,
    // ticket git context (lifecycle-local; injected deferred)
    resolveTicketGitContext,
    resolveLockHead,
    // board readers
    getTicketRef,
    // landing-gh transport (injected, NOT re-implemented here)
    ghPrView,
    mergeUniqueRefs,
    toArray,
  } = deps;

  function extractCommitShas(value) {
    return String(value || "").match(/\b[0-9a-f]{7,40}\b/gi) || [];
  }

  function refreshLandingBaseRef(repoRoot, baseRef) {
    const normalized = String(baseRef || DEFAULT_INTEGRATION_BRANCH).trim() || DEFAULT_INTEGRATION_BRANCH;
    return fetchRepoRef(repoRoot, normalized);
  }

  function resolveLandingBaseRef(repoRoot, baseRef, commitSha, options = {}) {
    const normalizedBaseRef = String(baseRef || DEFAULT_INTEGRATION_BRANCH).trim() || DEFAULT_INTEGRATION_BRANCH;
    if (!commitSha) {
      return { baseRef: normalizedBaseRef, warning: null };
    }
    if (options.explicitBase === true || normalizedBaseRef.startsWith("origin/")) {
      return { baseRef: normalizedBaseRef, warning: null };
    }
    const remoteBaseRef = `origin/${normalizedBaseRef}`;
    if (!resolveCommitishInRepo(repoRoot, remoteBaseRef)) {
      return { baseRef: normalizedBaseRef, warning: null };
    }
    if (isCommitAncestorOfRef(repoRoot, commitSha, normalizedBaseRef)) {
      return { baseRef: normalizedBaseRef, warning: null };
    }
    if (!isCommitAncestorOfRef(repoRoot, commitSha, remoteBaseRef)) {
      return { baseRef: normalizedBaseRef, warning: null };
    }
    return {
      baseRef: remoteBaseRef,
      warning:
        `Local base ref ${normalizedBaseRef} is stale for merged PR landing commit ${commitSha}; ` +
        `using ${remoteBaseRef} as the authoritative ancestry base.`,
    };
  }

  function resolvePrLandingBaseRef(repoRoot, baseRef, commitSha, options = {}) {
    return resolveLandingBaseRef(repoRoot, baseRef, commitSha, options);
  }

  function pickBestLandingCommit(repoRoot, candidates, baseRef) {
    const ancestorCandidates = candidates.filter((candidate) => isCommitAncestorOfRef(repoRoot, candidate, baseRef));
    if (ancestorCandidates.length === 1) {
      return ancestorCandidates[0];
    }
    if (ancestorCandidates.length === 0) {
      return null;
    }
    const descendant = ancestorCandidates.find((candidate) =>
      ancestorCandidates.every((other) => other === candidate || isCommitAncestorOfRef(repoRoot, other, candidate))
    );
    return descendant || null;
  }

  function resolveSourceCommitSha(ticketId, row, options = {}) {
    if (!isRepoBackedCode(row.Repo)) {
      return null;
    }
    const repoRoot = getRepoRoot(row.Repo);
    const explicit = resolveCommitishInRepo(repoRoot, options.sourceCommit);
    if (explicit) {
      return explicit;
    }
    const context = resolveTicketGitContext(row, ticketId);
    if (context.worktree && fs.existsSync(context.worktree)) {
      const head = resolveLockHead(row.Repo, context.worktree);
      if (head) {
        return head;
      }
    }
    if (context.branch) {
      return resolveCommitishInRepo(repoRoot, context.branch);
    }
    return null;
  }

  function resolveFulfilledByLandingCommit(ticketId, row, board, options = {}) {
    const fulfilledByTicket = String(options.fulfilledByTicket || "").trim() || null;
    const repoRoot = getRepoRoot(row.Repo);
    let fulfilledByCommitSha = resolveCommitishInRepo(repoRoot, options.fulfilledByCommit);

    if (fulfilledByTicket) {
      if (fulfilledByTicket === ticketId) {
        fail(`Ticket ${ticketId} cannot be fulfilled by itself.`);
      }
      const fulfilledRef = getTicketRef(board, fulfilledByTicket);
      if (!fulfilledRef) {
        fail(`Ticket ${ticketId} references unknown fulfilled-by ticket "${fulfilledByTicket}".`);
      }
      if (fulfilledRef.row.Repo !== row.Repo) {
        fail(`Ticket ${ticketId} cannot be fulfilled by ${fulfilledByTicket}; repo codes must match.`);
      }
      const fulfilledLanding = board.landing_index?.[fulfilledByTicket];
      if (!fulfilledLanding) {
        fail(`Ticket ${ticketId} references fulfilled-by ticket ${fulfilledByTicket}, but it has no landing evidence yet.`);
      }
      fulfilledByCommitSha = fulfilledByCommitSha ||
        resolveCommitishInRepo(repoRoot, fulfilledLanding.fulfilled_by_commit_sha || fulfilledLanding.commit_sha) ||
        resolveLandingCommitSha(
          fulfilledByTicket,
          fulfilledRef.row,
          fulfilledLanding.method || "manual",
          fulfilledLanding.evidence || [],
          board.pr_index?.[fulfilledByTicket] || [],
          { baseRef: fulfilledLanding.base_ref || options.base || DEFAULT_INTEGRATION_BRANCH }
        );
    }

    if (!fulfilledByTicket && !fulfilledByCommitSha) {
      return null;
    }
    if (!fulfilledByCommitSha) {
      fail(
        `Ticket ${ticketId} uses fulfilled-by closeout but governance could not resolve the canonical landed commit. ` +
        `Pass --fulfilled-by-ticket <ticket-id> or --fulfilled-by-commit <sha>.`
      );
    }
    return {
      fulfilledByTicket,
      fulfilledByCommitSha,
    };
  }

  function resolveLandingCommitSha(ticketId, row, method, evidence, prUrls = [], options = {}) {
    if (!isRepoBackedCode(row.Repo)) {
      return null;
    }
    const repoRoot = getRepoRoot(row.Repo);
    const baseRef = String(options.baseRef || DEFAULT_INTEGRATION_BRANCH).trim();

    if (method === "pr" && prUrls.length > 0) {
      const payload = ghPrView(prUrls[0]);
      let mergeCommitSha = resolveCommitishInRepo(repoRoot, payload?.mergeCommit?.oid);
      if (!mergeCommitSha && payload?.mergeCommit?.oid && fetchRepoRef(repoRoot, baseRef)) {
        mergeCommitSha = resolveCommitishInRepo(repoRoot, payload?.mergeCommit?.oid);
      }
      if (!mergeCommitSha) {
        return String(payload?.mergeCommit?.oid || "").trim() || null;
      }
      return mergeCommitSha;
    }

    const candidates = mergeUniqueRefs([], toArray(evidence))
      .flatMap((entry) => extractCommitShas(entry))
      .map((entry) => resolveCommitishInRepo(repoRoot, entry))
      .filter(Boolean);
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 0) {
      fail(
        `Ticket ${ticketId} uses ${method === "no_pr" ? "no-PR" : "manual"} landing evidence but no resolvable commit SHA. ` +
        `Pass --landed "<canonical-branch commit-sha and closeout note>".`
      );
    }
    if (uniqueCandidates.length > 1) {
      const bestCandidate = pickBestLandingCommit(repoRoot, uniqueCandidates, baseRef);
      if (bestCandidate) {
        return bestCandidate;
      }
      fail(`Ticket ${ticketId} landing evidence names multiple commit SHAs (${uniqueCandidates.join(", ")}). Record exactly one landed commit.`);
    }
    return uniqueCandidates[0];
  }

  return {
    extractCommitShas,
    refreshLandingBaseRef,
    resolveLandingBaseRef,
    resolvePrLandingBaseRef,
    pickBestLandingCommit,
    resolveSourceCommitSha,
    resolveFulfilledByLandingCommit,
    resolveLandingCommitSha,
  };
};
