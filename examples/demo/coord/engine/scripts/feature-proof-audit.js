"use strict";

function createFeatureProofAudit(deps) {
  const {
    DEFAULT_INTEGRATION_BRANCH,
    FEATURE_PROOF_EVIDENCE_PREFIX,
    REPO_INTEGRATION_BRANCHES,
    evaluateFeatureProofEntry,
    getRepoRoot,
    isRepoBackedCode,
    isTestingInfrastructureTicket,
    normalizeFeatureProofEntryForTicket,
    parseFeatureProofEntry,
    readPlanRecord,
    readPlanState,
    repoDisplayNameForCode,
    requiresFeatureProofGovernance,
    resolveCommitishInRepo,
    resolveLandingBaseRef,
    resolveLandingCommitSha,
    toArray,
  } = deps;

  function deriveFeatureProofAudit(ticketId, row, landing, metadata) {
    if (!landing || !isRepoBackedCode(row.Repo)) {
      return null;
    }
    if (!requiresFeatureProofGovernance(metadata, ticketId, row)) {
      return null;
    }

    const planState = readPlanRecord(ticketId, { allowMissing: true }) || readPlanState(ticketId);
    if (!planState) {
      // guard:feature-proof-resolution
      throw new Error(`Ticket ${ticketId} feature-proof audit requires a canonical plan record.`);
    }
    if (isTestingInfrastructureTicket(row, planState)) {
      return null;
    }

    const proofs = toArray(planState.feature_proof)
      .map((entry) => normalizeFeatureProofEntryForTicket(entry, ticketId))
      .map((entry) => String(entry || "").trim())
      .filter((entry) => entry && !/^todo\b/i.test(entry) && !/^not-required$/i.test(entry));
    if (proofs.length === 0) {
      throw new Error(
        `Ticket ${ticketId} must record canonical "- Feature proof:" entries before closeout. ` +
        `Use \`coord/scripts/gov update-plan ${ticketId} --feature-proof "path:<repo-relative-path>"\` or ` +
        `\`--feature-proof "symbol:<path>#<symbol>"\`.`
      );
    }

    const repoRoot = getRepoRoot(row.Repo);
    const repoLabel = repoDisplayNameForCode(row.Repo);
    const parsedEntries = proofs.map(parseFeatureProofEntry);
    const invalidEntries = parsedEntries.filter((entry) => !entry.valid);
    if (invalidEntries.length > 0) {
      throw new Error(
        `Ticket ${ticketId} has invalid feature-proof entries: ` +
        `${invalidEntries.map((entry) => `${entry.raw} (${entry.reason})`).join("; ")}.`
      );
    }

    const requestedBaseRef = String(landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim() ||
      REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH;
    const resolvedCommitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha || landing.fulfilled_by_commit_sha) ||
      resolveLandingCommitSha(ticketId, row, landing.method || "manual", landing.evidence || [], [], { baseRef: requestedBaseRef });
    const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, resolvedCommitSha, {
      explicitBase: requestedBaseRef.startsWith("origin/"),
    });
    const baseRef = baseResolution.baseRef;

    const failures = parsedEntries
      .map((entry) => ({
        entry,
        evaluation: evaluateFeatureProofEntry(repoRoot, baseRef, entry),
      }))
      .filter((result) => !result.evaluation.ok);
    if (failures.length > 0) {
      throw new Error(
        `Ticket ${ticketId} feature-proof audit failed against ${repoLabel}/${baseRef}. Missing at branch tip: ` +
        `${failures.map((result) => `${result.entry.raw} (${result.evaluation.reason})`).join("; ")}. ` +
        `Recovery: update proofs with supported ticket-repository syntax, for example "coord/scripts/gov update-plan ${ticketId} --feature-proof \\"path:<correct-path>\\"" ` +
        `or drop invalid proofs with "coord/scripts/gov update-plan ${ticketId} --drop-feature-proof \\"${failures[0].entry.raw}\\"".`
      );
    }

    const commitSha = resolvedCommitSha;
    const evidence =
      `${FEATURE_PROOF_EVIDENCE_PREFIX} commit ${commitSha || "unknown"} verified ${proofs.length} proof(s) ` +
      `on ${repoLabel}/${baseRef}: ${proofs.join("; ")}`;

    return {
      ticketId,
      repoLabel,
      baseRef,
      commitSha: commitSha || null,
      proofs,
      evidence,
    };
  }

  return { deriveFeatureProofAudit };
}

function createFeatureProofNormalization({ parseFeatureProofEntry, resolveRepoCodeForTicket, repoPrefixesForCode }) {
  function normalizeRepoRelativeProofPathForRepo(value, repoCode) {
    const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized) {
      return "";
    }
    for (const repoPrefix of repoPrefixesForCode(repoCode)) {
      if (normalized.startsWith(repoPrefix)) {
        return normalized.slice(repoPrefix.length);
      }
    }
    return normalized;
  }

  function normalizeFeatureProofEntryForTicket(value, ticketId) {
    const parsed = parseFeatureProofEntry(value);
    if (!parsed?.valid) {
      return String(value || "").trim();
    }
    const repoCode = resolveRepoCodeForTicket(ticketId);
    if (parsed.kind === "path") {
      return `path:${normalizeRepoRelativeProofPathForRepo(parsed.path, repoCode)}`;
    }
    if (parsed.kind === "symbol") {
      return `symbol:${normalizeRepoRelativeProofPathForRepo(parsed.path, repoCode)}#${parsed.symbol}`;
    }
    return String(value).trim();
  }

  return { normalizeRepoRelativeProofPathForRepo, normalizeFeatureProofEntryForTicket };
}

module.exports = { createFeatureProofAudit, createFeatureProofNormalization };
