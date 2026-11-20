"use strict";

function createLandingRecordClassification(deps) {
  const {
    DEFAULT_INTEGRATION_BRANCH,
    collectLandingAuditCandidates,
    getRepoRoot,
    isCommitAncestorOfRef,
    isRepoBackedCode,
    pickBestLandingCommit,
    repoNameForCode,
    resolveCommitishInRepo,
    resolveLandingBaseRef,
  } = deps;

  function classifyLandingRecord(ticketId, row, landing) {
    if (!isRepoBackedCode(row.Repo)) {
      return null;
    }
    const repoRoot = getRepoRoot(row.Repo);
    const repoLabel = repoNameForCode(row.Repo);
    const requestedBaseRef = String((landing && landing.base_ref) || DEFAULT_INTEGRATION_BRANCH).trim();
    const entry = {
      ticket_id: ticketId,
      repo: row.Repo,
      repo_label: repoLabel,
      base_ref: requestedBaseRef,
      method: String((landing && landing.method) || "manual").trim() || "manual",
      landing,
      provenance: "unknown",
      status: "unknown",
      resolved_commit_sha: null,
      evidence_commit_candidates: [],
      fulfilled_by_ticket: null,
      fulfilled_by_commit_sha: null,
      reason: null,
    };

    if (!landing) {
      entry.reason = "missing_landing_record";
      return entry;
    }

    if (!Array.isArray(landing.evidence) || landing.evidence.length === 0) {
      entry.reason = "missing_landing_evidence";
      return entry;
    }

    if (landing.fulfilled_by_ticket || landing.fulfilled_by_commit_sha || landing.provenance_status === "fulfilled_by") {
      entry.provenance = "fulfilled_by";
      entry.fulfilled_by_ticket = landing.fulfilled_by_ticket || null;
      const resolvedCommitSha = resolveCommitishInRepo(repoRoot, landing.fulfilled_by_commit_sha || landing.commit_sha);
      if (!resolvedCommitSha) {
        entry.reason = "unresolvable_fulfilled_by_commit_sha";
        return entry;
      }
      const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, resolvedCommitSha);
      entry.fulfilled_by_commit_sha = resolvedCommitSha;
      entry.resolved_commit_sha = resolvedCommitSha;
      entry.base_ref = baseResolution.baseRef;
      entry.status = isCommitAncestorOfRef(repoRoot, resolvedCommitSha, baseResolution.baseRef) ? "merged" : "not_ancestor";
      entry.reason = entry.status === "merged" ? null : "fulfilled_by_commit_not_ancestor";
      return entry;
    }

    if (landing.commit_sha) {
      entry.provenance = landing.provenance_status === "legacy" ? "legacy" : "explicit";
      const resolvedCommitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha);
      if (!resolvedCommitSha) {
        entry.reason = "unresolvable_commit_sha";
        return entry;
      }
      const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, resolvedCommitSha);
      entry.resolved_commit_sha = resolvedCommitSha;
      entry.base_ref = baseResolution.baseRef;
      entry.status = isCommitAncestorOfRef(repoRoot, resolvedCommitSha, baseResolution.baseRef) ? "merged" : "not_ancestor";
      entry.reason = entry.status === "merged" ? null : "explicit_commit_not_ancestor";
      return entry;
    }

    // This branch is reached only after the guard proved evidence is a nonempty array.
    const candidates = collectLandingAuditCandidates(repoRoot, landing.evidence);
    entry.evidence_commit_candidates = candidates;
    if (candidates.length === 0) {
      entry.reason = "no_resolvable_commit_sha_in_evidence";
      return entry;
    }

    entry.provenance = "legacy";
    const resolvedCommitSha = candidates.length === 1
      ? candidates[0]
      : pickBestLandingCommit(repoRoot, candidates, requestedBaseRef);
    if (!resolvedCommitSha) {
      entry.reason = "ambiguous_legacy_commit_candidates";
      return entry;
    }
    const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, resolvedCommitSha);
    entry.resolved_commit_sha = resolvedCommitSha;
    entry.base_ref = baseResolution.baseRef;
    entry.status = isCommitAncestorOfRef(repoRoot, resolvedCommitSha, baseResolution.baseRef) ? "merged" : "not_ancestor";
    entry.reason = entry.status === "merged" ? null : "legacy_commit_not_ancestor";
    return entry;
  }

  return { classifyLandingRecord };
}

module.exports = { createLandingRecordClassification };
