const fs = require("node:fs");
const path = require("node:path");

const { gitTry } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const { DEFAULT_INTEGRATION_BRANCH, resolveEngineModule } = require("../../paths.js");
const { createTestingInfrastructureLandingAudit } = require("./testing-infra-audit.js");
const { STATUS } = require("./governance-constants.js");
const { classifyLensBuckets } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/review-lens-catalog.js"));
// COORD-153: live-MCP lifecycle enforcement. Pure and dependency-free (it only
// inspects the declared plan object + the COORD-152 operation-class policy), so
// it is required directly rather than dependency-injected, mirroring how
// bootstrap-advisory.js is consumed by ticket-guidance.js.
const { buildLiveMcpLifecycle } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/live-mcp-lifecycle.js"));
// COORD-164: server-bootstrap-via-live-mcp BRIDGE. Pure and dependency-free,
// mirroring buildLiveMcpLifecycle. It governs ONLY tickets that declare BOTH a
// `live_mcp` and a `bootstrap_risk` plan object (a server bootstrap job executed
// as a live-MCP operation); for every other ticket it returns no issues. It adds
// the bootstrap-coverage blocker only — cleanup/redaction enforcement stays with
// the COORD-153 gate above, which runs on the same `live_mcp` object.
const { buildBootstrapViaLiveMcpLifecycle } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/bootstrap-via-live-mcp.js"));
// COORD-690: feature-proof parsing, ref evaluation, and reachability resolution
// live in one extracted module. Required directly (like the live-MCP gate
// above) because it derives repo facts from DEFAULT_PATHS rather than the
// injected registry, which is what lets the RECORD path share it.
const {
  FEATURE_PROOF_REF_KINDS,
  evaluateFeatureProofEntry,
  evaluateFeatureProofEntryInWorktree,
  featureProofCandidateRefs,
  gitRefContainsLiteral,
  parseFeatureProofEntry,
  readTextFileFromRef,
  resolveFeatureProofReachability,
} = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-resolution.js"));
const { collectGatePlanReadinessIssues } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gate-plan.js")), { collectDecompositionProofIssues } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/decomposition-proof-gate.js"));
const { validate: validateAdrRegistry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/adr-validator.js"));
const { createAdrGate } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/adr.js"));
const { createBusinessContextGate } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/business-context.js"));
const { createContextPackAcknowledgementGate } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/context-pack-ack.js"));
const { createReadinessGate } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/readiness.js"));
const { createGateRegistry } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/registry.js"));
const { createReviewCloseoutGate } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/review-closeout.js"));
const {
  ROOT_DIR,
  computeContinuityGenerationHash,
  mergeAppendOnlyContinuityRecords,
  validateContinuityFreshRead,
} = require("./governance-context.js");
const { createGovernanceReadiness } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/governance-readiness.js"));
const { createDependencyReadiness } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/dependency-readiness.js"));
const { createFeatureProofAudit, createFeatureProofNormalization } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-audit.js"));
const { createFeatureProofEntryValidator } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-entry-validation.js"));
const { createLandingRecordClassification } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/landing-record-classification.js"));
const { createReviewPlanReadiness } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/review-plan-readiness.js"));
const { createGovernanceLightLane } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/governance-light-lane.js"));
// COORD-860: managed-auto execution evidence gate (self-contained module).
const { collectManagedEvidenceIssues } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gates/managed-evidence.js"));

// COORD-104 (annotated residual): createGovernanceValidation is a
// dependency-injection FACTORY closure that wires ~45 validation helpers over a
// single destructured `deps` bundle and returns them as a facade object. Its
// reported ~50 complexity is an estimator artifact of that closure shape, not
// branching the factory itself performs — the residual decision tokens live in
// inline arrow callbacks lexically inside the closure body that the heuristic
// boundary cannot attribute to a named child. The real cyclomatic hotspots are
// the individual helpers (each reported and reduced separately, e.g.
// collectReviewPlanReadinessIssues 48 -> under-threshold via extraction in this
// ticket). Splitting the factory itself would mean moving helpers to module
// scope and re-threading every `deps` binding by hand — a high-risk rewrite of
// core governance with no behavioral upside. Annotated and accepted per the
// ticket's inherently-complex carve-out.
function createGovernanceValidation(deps) {
  const {
    COORD_DIR,
    DEFAULT_PATHS,
    FEATURE_PROOF_EVIDENCE_PREFIX,
    GovernanceError,
    REPO_INTEGRATION_BRANCHES,
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
    allowsFollowupDependencyReadinessException,
    buildDependencyRepairNextSteps,
    buildHistoricalCloseoutStartBlocker,
    collectPromptRecordBlockers,
    buildStartPlanBootstrapCommand,
    commitSubjectAffiliatesWithTicket,
    collectLandingAuditCandidates,
    collectTicketGovernanceIssueEvents,
    describeTicketMutationOwnershipIssue,
    effectiveTierMinimum,
    ensureLandingRecord,
    escapeRegex,
    extractFileReferencesFromCommands,
    extractPackageScriptsFromCommands,
    fail,
    getRepoRoot,
    getRows,
    rowsById,
    ghPrView,
    gitPathExistsAtRef,
    isCommitAncestorOfRef,
    isGitHubPrUrl,
    isRepoBackedCode,
    isTestingInfrastructureFilePath,
    isTestingInfrastructureTicket,
    isTicketAtOrAfter,
    listCommitTouchedPaths,
    mergeUniqueRefs,
    mergedPrAffiliatesWithTicket,
    normalizeGovernancePlanShape,
    pickBestLandingCommit,
    readBoard,
    readJsonFileFromRef,
    readLatestPlanBlock,
    readPlanRecord,
    readPlanState,
    resolveTicketGitContext,
    refreshLandingBaseRef,
    repoDisplayNameForCode,
    repoNameForCode,
    repoPrefixesForCode,
    resolveCommitishInRepo,
    resolveLandingBaseRef,
    resolveLandingCommitSha,
    resolveRepoThresholdTicket,
    resolveRepoCodeForTicket,
    resolveSourceCommitSha,
    resolveTicketTier,
    state,
    splitPlanPathValues,
    normalizeTestingInfraAuditPath,
    requiresLandingGovernance,
    hasResolvedGovernanceRepairQuestion,
    integerOrDefault,
    toArray,
  } = deps;
  const { deriveTestingInfrastructureAudit } = createTestingInfrastructureLandingAudit({
    DEFAULT_INTEGRATION_BRANCH,
    REPO_INTEGRATION_BRANCHES,
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
    extractFileReferencesFromCommands,
    extractPackageScriptsFromCommands,
    getRepoRoot,
    gitPathExistsAtRef,
    isRepoBackedCode,
    isTestingInfrastructureFilePath,
    isTestingInfrastructureTicket,
    listCommitTouchedPaths,
    mergeUniqueRefs,
    normalizeTestingInfraAuditPath,
    readJsonFileFromRef,
    readPlanRecord,
    readPlanState,
    repoDisplayNameForCode,
    resolveCommitishInRepo,
    resolveLandingCommitSha,
    splitPlanPathValues,
  });

  const { validateFeatureProofEntry } = createFeatureProofEntryValidator({ fail });
  const businessContextGate = createBusinessContextGate({
    COORD_DIR,
    STATUS,
    fs,
    getRows,
    isMeaningfulText,
    path,
  });
  const {
    collectBusinessContextGateIssues,
    collectBusinessContextProposalIssues,
    readBusinessContextEvidence,
    readBusinessContextPack,
    resolveBusinessContextRef,
    ticketTouchesBusinessContextRisk,
  } = businessContextGate;

  const adrGate = createAdrGate({
    COORD_DIR,
    escapeRegex,
    path,
    validateAdrRegistry,
  });
  const {
    collectAdrCloseoutCitationIssues,
    collectAdrRequirementIssues,
    collectAdrReviewCycleIssues,
    deriveDecisionRequiredGuidance,
    normalizeAdrRef,
    readAdrDecisionEvidence,
    ticketRequiresAdrDecision,
  } = adrGate;

  const contextPackAcknowledgementGate = createContextPackAcknowledgementGate({
    isMeaningfulText,
    readBusinessContextEvidence,
    readBusinessContextPack,
    ticketRequiresAdrDecision,
    ticketTouchesBusinessContextRisk,
    toArray,
  });
  const {
    advisoryPackItemIds,
    collectContextPackAcknowledgementIssues,
    contextAckValueIsNone,
    contextAckValueMeaningful,
    packSectionCount,
    ticketRequiresContextPackAcknowledgement,
  } = contextPackAcknowledgementGate;

  const reviewCloseoutGate = createReviewCloseoutGate({
    coordDir: COORD_DIR, effectiveTierMinimum,
    fieldHasMeaningfulValue,
    isMeaningfulText,
    isTestingInfrastructureTicket,
    parseSelfReviewCycles,
    requiresFeatureProofGovernance,
    resolveTicketTier,
    classifyReviewLensBuckets,
    normalizeReviewVerdict,
  });
  const {
    buildReviewCycleSnapshots,
    collectBoundedRepairEligibilityIssues,
    collectClosureReadinessIssues,
    collectRequirementClosureIssues,
    collectSelfReviewCycleIssues,
    isNoneLikePlanValue,
  } = reviewCloseoutGate;

  const startGateRegistry = createGateRegistry({
    start: [],
  });
  const reviewGateRegistry = createGateRegistry({
    review: [
      ({ ticketId, row, planState, board }) => collectBusinessContextGateIssues(ticketId, row, planState, board),
      ({ ticketId, row, planState }) => collectContextPackAcknowledgementIssues(ticketId, row, planState),
      ({ ticketId, row, planState }) => collectAdrRequirementIssues(ticketId, row, planState),
      ({ ticketId, row, planState, cycles, ...ctx }) => [...collectAdrReviewCycleIssues(ticketId, row, planState, cycles), ...reviewCloseoutGate.collectReuseReviewCycleIssues({ ticketId, cycles, ...ctx })],
      ({ ticketId, row, planState }) => [...collectAdrCloseoutCitationIssues(ticketId, row, planState), ...reviewCloseoutGate.collectSubagentSupervisionIssues(ticketId)],
      collectManagedEvidenceIssues,
    ],
  });

  const { traceDependencyReadiness, evaluateReadiness } = createDependencyReadiness({
    STATUS,
    allowsFollowupDependencyReadinessException,
    dedupeDependencyChains,
    splitDependsOn,
  });
  const { isProceduralDocPath, isLightLaneEligible, resolveTicketLightLane } = createGovernanceLightLane({
    splitPlanPathValues,
    isMeaningfulText,
  });
  // COORD-830: assertReviewPlanReady lives with the collector so closeout can
  // hand it the reviewed source commit without logic in this composition root.
  const { collectReviewPlanReadinessIssues, assertReviewPlanReady } = createReviewPlanReadiness({
    buildBootstrapViaLiveMcpLifecycle,
    buildLiveMcpLifecycle,
    buildReviewCycleSnapshots,
    collectBoundedRepairEligibilityIssues,
    collectClosureReadinessIssues,
    collectDecompositionProofIssues,
    collectGatePlanReadinessIssues,
    collectSelfReviewCycleIssues,
    COORD_DIR,
    formatGovernanceBlockers,
    getRepoRoot,
    GovernanceError,
    inferRequiredReviewRound,
    integerOrDefault,
    isRepoBackedCode,
    normalizeGovernancePlanShape,
    parseRequirementClosureEntries,
    readBoard,
    readLatestPlanBlock,
    readPlanRecord,
    readPlanState,
    resolveTicketGitContext,
    resolveTicketLightLane,
    reviewGateRegistry,
    state,
  });
  const readinessGate = createReadinessGate({
    GovernanceError,
    ROOT_DIR,
    STATUS,
    buildDependencyRepairNextSteps,
    buildHistoricalCloseoutStartBlocker,
    collectPromptRecordBlockers,
    buildStartPlanBootstrapCommand,
    collectReviewPlanReadinessIssues,
    describeTicketMutationOwnershipIssue,
    evaluateReadiness,
    formatDependencyCycleList,
    formatGovernanceBlockers,
    formatTransitiveBlockerDetails,
    fs,
    path,
    readPlanState,
    rowsById,
    startGateRegistry,
    state,
    ticketRequiresBaseline,
    ticketRequiresTraceability,
    toArray,
  });
  const {
    assertStartPlanReady,
    collectStartReadinessAdvisories,
    collectStartReadinessBlockers,
    collectSubmitReadinessBlockers,
    collectTicketDeclaredFiles,
    normalizeDeclaredFilePath,
    parseBoardDeclaredFiles,
    parseDeclaredFilesValue,
    parsePromptDeclaredFiles,
    submitRequiresReviewPlanCheck,
  } = readinessGate;
  const { deriveGovernanceReadiness } = createGovernanceReadiness({
    normalizeGovernancePlanShape,
    resolveRepoCodeForTicket,
    isMeaningfulText,
    collectReviewPlanReadinessIssues,
    resolveTicketLightLane,
    requiresFeatureProofGovernance,
    isTestingInfrastructureTicket,
    collectTicketGovernanceIssueEvents,
    hasResolvedGovernanceRepairQuestion,
    fieldHasMeaningfulValue,
    deriveDecisionRequiredGuidance,
    repoNameForCode,
  });

// guard:landing-record-integrity
function assertAlreadyLandedNoPrReconcileReady(ticketId, board, row, prRefs, options = {}) {
  if (options.alreadyLanded !== true) {
    return false;
  }
  if (!isRepoBackedCode(row.Repo)) {
    fail(`Ticket ${ticketId} uses --already-landed, but only repo-backed tickets can land onto canonical dev before review.`);
  }
  const refs = toArray(prRefs);
  if (refs.some((entry) => isGitHubPrUrl(entry))) {
    fail(
      `Ticket ${ticketId} uses --already-landed with PR refs. ` +
      `Use the normal merged-PR submit/move-review path instead of the no-PR reconcile flow.`
    );
  }
  if (!refs.some((entry) => /\(no PR\)/.test(String(entry)))) {
    fail(
      `Ticket ${ticketId} uses --already-landed without "(no PR)" closeout evidence. ` +
      `Pass --pr "local-review (no PR)" or use finalize --no-pr.`
    );
  }
  if (toArray(options.landed).length === 0 && !options.fulfilledByTicket && !options.fulfilledByCommit) {
    fail(
      `Ticket ${ticketId} uses --already-landed without landing evidence. ` +
      `Pass --landed "<canonical-branch closeout proof>" or a fulfilled-by ticket/commit.`
    );
  }
  const tempBoard = JSON.parse(JSON.stringify(board));
  if (!tempBoard.pr_index || typeof tempBoard.pr_index !== "object") {
    tempBoard.pr_index = {};
  }
  tempBoard.pr_index[ticketId] = refs;
  const landing = ensureLandingRecord(ticketId, tempBoard, row, options);
  assertLandingIntegrity(ticketId, row, landing);
  return true;
}

function detectSupersedeLandingBypass(ticketId, row, board, options = {}) {
  if (!isRepoBackedCode(row.Repo)) {
    return null;
  }
  const repoRoot = getRepoRoot(row.Repo);
  const requestedBaseRef = String(options.base || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim();
  const landing = board?.landing_index?.[ticketId] || null;
  if (landing) {
    const commitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha || landing.fulfilled_by_commit_sha);
    const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, commitSha, {
      explicitBase: options.baseExplicit === true,
    });
    if (commitSha && isCommitAncestorOfRef(repoRoot, commitSha, baseResolution.baseRef)) {
      return { kind: "landing_index", commitSha, baseRef: baseResolution.baseRef };
    }
  }
  for (const ref of toArray(board?.pr_index?.[ticketId] || [])) {
    if (!isGitHubPrUrl(ref)) {
      continue;
    }
    const payload = ghPrView(ref);
    if (!(payload.state === "MERGED" && payload.mergedAt && mergedPrAffiliatesWithTicket(ticketId, payload))) {
      continue;
    }
    const commitSha = resolveCommitishInRepo(repoRoot, payload?.mergeCommit?.oid);
    const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, commitSha, {
      explicitBase: options.baseExplicit === true,
    });
    if (commitSha && isCommitAncestorOfRef(repoRoot, commitSha, baseResolution.baseRef)) {
      return { kind: "merged_pr", commitSha, baseRef: baseResolution.baseRef, ref };
    }
  }
  const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);
  const sourceBaseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, sourceCommitSha, {
    explicitBase: options.baseExplicit === true,
  });
  if (
    sourceCommitSha &&
    isCommitAncestorOfRef(repoRoot, sourceCommitSha, sourceBaseResolution.baseRef) &&
    commitSubjectAffiliatesWithTicket(repoRoot, sourceCommitSha, ticketId)
  ) {
    return { kind: "source_commit", commitSha: sourceCommitSha, baseRef: sourceBaseResolution.baseRef };
  }
  return null;
}

// guard:landing-record-integrity
function assertLandingIntegrity(ticketId, row, landing) {
  if (!landing || !isRepoBackedCode(row.Repo)) {
    return;
  }
  const repoRoot = getRepoRoot(row.Repo);
  const method = String(landing.method || "manual").trim();
  const requestedBaseRef = landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH;
  let commitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha || landing.fulfilled_by_commit_sha) ||
    resolveLandingCommitSha(ticketId, row, method, landing.evidence || [], [], { baseRef: requestedBaseRef });
  let resolved = commitSha ? resolveLandingBaseRef(repoRoot, requestedBaseRef, commitSha) : { baseRef: requestedBaseRef };
  if (
    (!resolveCommitishInRepo(repoRoot, commitSha) ||
      !isCommitAncestorOfRef(repoRoot, commitSha, resolved.baseRef)) &&
    refreshLandingBaseRef(repoRoot, requestedBaseRef)
  ) {
    commitSha =
      resolveCommitishInRepo(repoRoot, landing.commit_sha || landing.fulfilled_by_commit_sha) ||
      resolveLandingCommitSha(ticketId, row, method, landing.evidence || [], [], { baseRef: requestedBaseRef }) ||
      commitSha;
    resolved = commitSha ? resolveLandingBaseRef(repoRoot, requestedBaseRef, commitSha) : { baseRef: requestedBaseRef };
  }
  if (!commitSha) {
    const baseRef = String(requestedBaseRef).trim();
    throw new Error(`Ticket ${ticketId} landing_index is missing a resolvable commit_sha for base ${baseRef}.`);
  }
  const baseRef = resolved.baseRef;
  const repoLabel = repoNameForCode(row.Repo);
  if (!isCommitAncestorOfRef(repoRoot, commitSha, baseRef)) {
    throw new Error(`Ticket ${ticketId} landing commit ${commitSha} is not an ancestor of ${repoLabel}/${baseRef}.`);
  }
  if (!baseRef.startsWith("origin/")) {
    const remoteBaseRef = `origin/${baseRef}`;
    if (resolveCommitishInRepo(repoRoot, remoteBaseRef) && !isCommitAncestorOfRef(repoRoot, commitSha, remoteBaseRef)) {
      throw new Error(
        `Ticket ${ticketId} landing commit ${commitSha} is an ancestor of local ${baseRef} but not ${remoteBaseRef}. ` +
        `Push ${repoLabel}/${baseRef} to origin before finalizing, or the landing record will be invalid.`
      );
    }
  }
}

const { classifyLandingRecord } = createLandingRecordClassification({
  DEFAULT_INTEGRATION_BRANCH,
  collectLandingAuditCandidates,
  getRepoRoot,
  isCommitAncestorOfRef,
  isRepoBackedCode,
  pickBestLandingCommit,
  repoNameForCode,
  resolveCommitishInRepo,
  resolveLandingBaseRef,
});


const { normalizeRepoRelativeProofPathForRepo, normalizeFeatureProofEntryForTicket } = createFeatureProofNormalization({
  parseFeatureProofEntry,
  resolveRepoCodeForTicket,
  repoPrefixesForCode,
});

const { deriveFeatureProofAudit } = createFeatureProofAudit({
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
});

function requiresFeatureProofGovernance(metadata, ticketId, row) {
  if (!row || !isRepoBackedCode(row.Repo)) {
    return false;
  }
  const threshold = resolveRepoThresholdTicket(metadata?.feature_proof_required_from_ticket, row.Repo);
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

// COORD-166: the LIGHT LANE for reference/design-doc tickets.
//
// Reference/design-doc changes (README, CHANGELOG, architecture/spec docs under
// coord/docs, and similar) should not have to pay the full code-grade
// plan-completeness ceremony (feature-proof + the full 4-cycle/lens-coverage
function validateRequirementClosureEntry(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    fail("Requirement closure entries may not be empty.");
  }
  if (!/^(Ticket ask|Implemented|Not implemented|Deferred to|Closeout verdict):/i.test(normalized)) {
    fail(
      `Requirement closure entry "${normalized}" must start with one of: ` +
      `"Ticket ask:", "Implemented:", "Not implemented:", "Deferred to:", or "Closeout verdict:".`
    );
  }
}

function dedupeDependencyChains(chains = []) {
  const seen = new Set();
  const unique = [];
  for (const chain of chains) {
    const normalized = Array.isArray(chain)
      ? chain.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (normalized.length === 0) {
      continue;
    }
    const key = normalized.join("->");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function formatDependencyChain(chain = []) {
  return chain.join(" -> ");
}

function formatDependencyCycleList(cycles = []) {
  return dedupeDependencyChains(cycles)
    .map((cycle) => formatDependencyChain(cycle))
    .join("; ");
}

function formatTransitiveBlockerDetails(blockerChains = []) {
  return dedupeDependencyChains(blockerChains)
    .filter((chain) => chain.length > 1)
    .map((chain) => formatDependencyChain(chain))
    .join("; ");
}

function splitDependsOn(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function ticketRequiresTraceability(row) {
  return isRepoBackedCode(row?.Repo);
}

function ticketRequiresBaseline(row) {
  return /^(test|contract|infra)$/i.test(String(row?.Type || ""));
}

function isMeaningfulText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized && !normalized.includes("todo");
}

function fieldHasMeaningfulValue(values) {
  return values.some((value) => isMeaningfulText(value));
}

function inferRequiredReviewRound(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  return Math.max(...findings.map((finding) => integerOrDefault(finding.round, 1)));
}

function normalizeSelfReviewCycleLine(block, value, options = {}) {
  const raw = String(value || "").trim()
    .replace(/[\u2018\u2019\u201C\u201D]/g, (ch) =>
      ch === "\u2018" || ch === "\u2019" ? "'" : '"'
    );
  if (!raw) {
    return null;
  }

  if (/^- Self-review cycle \d+\/\d+:/i.test(raw)) {
    return raw;
  }
  if (/^Self-review cycle \d+\/\d+:/i.test(raw)) {
    return `- ${raw}`;
  }
  if (/^\d+\/\d+:/i.test(raw)) {
    return `- Self-review cycle ${raw}`;
  }
  const nextCycle = Number.isInteger(options.cycleNumber)
    ? options.cycleNumber
    : parseSelfReviewCycles(block).length + 1;
  const totalCycles = Number.isInteger(options.totalCycles)
    ? options.totalCycles
    : Math.max(3, nextCycle);
  return `- Self-review cycle ${nextCycle}/${totalCycles}: ${raw}`;
}

function hasOnlyScaffoldSelfReviewCycles(block) {
  const cycles = parseSelfReviewCycles(block);
  return cycles.length > 0 && cycles.every((cycle) => String(cycle.body || "").toLowerCase().includes("todo"));
}

function replaceSelfReviewCycles(block, values) {
  const normalizedLines = [];
  const requested = toArray(values).map((value) => String(value || "").trim()).filter(Boolean);
  const totalCycles = Math.max(3, requested.length);
  for (const [index, value] of requested.entries()) {
    const line = normalizeSelfReviewCycleLine(block, value, {
      cycleNumber: index + 1,
      totalCycles,
    });
    if (!line || normalizedLines.some((entry) => entry.trim() === line.trim())) {
      continue;
    }
    normalizedLines.push(line);
  }

  const lines = block.split("\n");
  const filtered = lines.filter((entry) => !/^- Self-review cycle \d+\/\d+:/i.test(entry.trim()));
  const rollbackIndex = filtered.findIndex((entry) => entry === "- Rollback strategy:");
  const insertIndex = rollbackIndex === -1 ? filtered.length : rollbackIndex;
  filtered.splice(insertIndex, 0, ...normalizedLines);
  return filtered.join("\n");
}

function extractTaggedReviewField(text, label, followingLabels) {
  const suffix = followingLabels.length > 0
    ? `(?=;\\s*(?:${followingLabels.map((value) => escapeRegex(value)).join("|")})=|$)`
    : "$";
  const pattern = new RegExp(`(?:^|;\\s*)${escapeRegex(label)}=(.*?)${suffix}`, "i");
  const match = pattern.exec(String(text || "").trim());
  return match ? match[1].trim() : null;
}

function normalizeReviewVerdict(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("pass")) {
    return "pass";
  }
  if (normalized.startsWith("fail")) {
    return normalized;
  }
  return null;
}

// COORD-137: the canonical lens catalog (coord/engine/scripts/review-lens-catalog.js)
// is the single source of truth for lens classification. This stays a thin
// delegating wrapper so the move-review lens-coverage signal and the catalog can
// never drift apart. The catalog additionally classifies the advisory fifth
// lens (adversarial misuse), which is NOT in REQUIRED_LENS_BUCKETS, so the hard
// move-review blocker below is unchanged.
function classifyReviewLensBuckets(value) {
  return classifyLensBuckets(value);
}

function parseRequirementClosureEntries(values) {
  const fields = {
    ticket_ask: null,
    implemented: null,
    not_implemented: null,
    deferred_to: null,
    closeout_verdict: null,
  };
  for (const entry of values || []) {
    const text = String(entry || "").trim();
    if (!text) {
      continue;
    }
    if (/^Ticket ask:/i.test(text)) {
      fields.ticket_ask = text.replace(/^Ticket ask:\s*/i, "").trim();
    } else if (/^Implemented:/i.test(text)) {
      fields.implemented = text.replace(/^Implemented:\s*/i, "").trim();
    } else if (/^Not implemented:/i.test(text)) {
      fields.not_implemented = text.replace(/^Not implemented:\s*/i, "").trim();
    } else if (/^Deferred to:/i.test(text)) {
      fields.deferred_to = text.replace(/^Deferred to:\s*/i, "").trim();
    } else if (/^Closeout verdict:/i.test(text)) {
      fields.closeout_verdict = text.replace(/^Closeout verdict:\s*/i, "").trim().toLowerCase();
    }
  }
  return fields;
}

function parseSelfReviewCycles(block) {
  const lines = String(block || "").split("\n");
  return lines
    .map((line) => {
      const match = /^- Self-review cycle (\d+)\/(\d+):(.*)$/i.exec(line.trim());
      if (!match) {
        return null;
      }
      const body = String(match[3] || "").trim();
      const orderedFields = ["lens", "diff", "risks", "findings", "verification", "verdict"];
      const fields = Object.fromEntries(orderedFields.map((field, index) => [
        field,
        extractTaggedReviewField(body, field, orderedFields.slice(index + 1)),
      ]));
      const legacyVerdict = /verdict:\s*(pass|fail\b.*)$/i.exec(body);
      const riskItems = String(fields.risks || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const missingFields = orderedFields.filter((field) => !isMeaningfulText(fields[field]));
      return {
        cycle: Number(match[1]),
        total: Number(match[2]),
        body,
        lens: fields.lens,
        diff: fields.diff,
        risks: fields.risks,
        findings: fields.findings,
        verification: fields.verification,
        riskCount: riskItems.length,
        lensBuckets: classifyReviewLensBuckets(fields.lens),
        missingFields,
        structured: missingFields.length === 0,
        verdictRaw: fields.verdict || (legacyVerdict ? legacyVerdict[1] : null),
        verdict: normalizeReviewVerdict(fields.verdict || (legacyVerdict ? legacyVerdict[1] : null)),
      };
    })
    .filter(Boolean);
}


function formatGovernanceBlockers(ticketId, blockers, summary) {
  const lines = [
    `${summary} ${ticketId}:`,
  ];
  blockers.forEach((blocker, index) => {
    lines.push(`${index + 1}. ${blocker.message}`);
    for (const step of blocker.next_steps || []) {
      lines.push(`   Next: ${step}`);
    }
  });
  return lines.join("\n");
}

// guard:continuity-write-safety
function collectContinuityWriteSafetyIssues(input = {}) {
  const issues = [];
  if (input.append_only) {
    try {
      mergeAppendOnlyContinuityRecords(input.append_only.existing, input.append_only.incoming);
    } catch (error) {
      issues.push({
        code: "continuity_append_only_conflict",
        message: error.message,
        next_steps: [
          // COORD-572: an issue that blocks a write must name a command the
          // caller can run; "re-read the source" names no source and no reader.
          "coord/scripts/gov recent --limit 20 --full",
          "Append a new superseding record instead of rewriting an existing record id.",
          "Retry through the governed single-writer mutation path.",
        ],
      });
    }
  }
  if (input.fresh_read) {
    const result = validateContinuityFreshRead(input.fresh_read.observed, input.fresh_read.current);
    if (!result.ok) {
      issues.push({
        code: "continuity_stale_reread_required",
        message: `Continuity write is stale for ${result.stale.map((item) => item.id || "<unknown>").join(", ")}.`,
        next_steps: result.guidance,
      });
    }
  }
  if (input.derived_view) {
    const expected = input.derived_view.expected_input_generation_hash || input.derived_view.expectedInputGenerationHash;
    const current = input.derived_view.current_input_generation_hash ||
      input.derived_view.currentInputGenerationHash ||
      computeContinuityGenerationHash(input.derived_view.current_inputs || {});
    if (expected && expected !== current) {
      issues.push({
        code: "continuity_derived_view_stale",
        message: `Derived continuity view was generated from ${expected}, but current inputs hash to ${current}.`,
        next_steps: [
          // COORD-572: name the regeneration command instead of describing it.
          "coord/scripts/gov sync",
          "coord/scripts/gov conform --json",
          "Do not append derived readout output to the governance journal as authority.",
        ],
      });
    }
  }
  return issues;
}

// guard:continuity-write-safety
function assertContinuityWriteSafe(input = {}) {
  const issues = collectContinuityWriteSafetyIssues(input);
  if (issues.length > 0) {
    throw new GovernanceError(formatGovernanceBlockers("continuity", issues, "Continuity write-safety blockers for"));
  }
}

  return {
    deriveGovernanceReadiness,
    collectStartReadinessBlockers,
    collectStartReadinessAdvisories,
    collectSubmitReadinessBlockers,
    assertAlreadyLandedNoPrReconcileReady,
    detectSupersedeLandingBypass,
    assertLandingIntegrity,
    classifyLandingRecord,
    deriveTestingInfrastructureAudit,
    isLightLaneEligible,
    isProceduralDocPath,
    resolveTicketLightLane,
    readTextFileFromRef,
    gitRefContainsLiteral,
    parseFeatureProofEntry,
    normalizeRepoRelativeProofPathForRepo,
    normalizeFeatureProofEntryForTicket,
    evaluateFeatureProofEntry,
    deriveFeatureProofAudit,
    requiresFeatureProofGovernance,
    validateRequirementClosureEntry,
    validateFeatureProofEntry,
    resolveFeatureProofReachability,
    evaluateFeatureProofEntryInWorktree,
    featureProofCandidateRefs,
    FEATURE_PROOF_REF_KINDS,
    dedupeDependencyChains,
    formatDependencyChain,
    formatDependencyCycleList,
    formatTransitiveBlockerDetails,
    traceDependencyReadiness,
    evaluateReadiness,
    splitDependsOn,
    ticketRequiresTraceability,
    ticketRequiresBaseline,
    isMeaningfulText,
    fieldHasMeaningfulValue,
    inferRequiredReviewRound,
    normalizeSelfReviewCycleLine,
    hasOnlyScaffoldSelfReviewCycles,
    replaceSelfReviewCycles,
    extractTaggedReviewField,
    normalizeReviewVerdict,
    classifyReviewLensBuckets,
    parseRequirementClosureEntries,
    isNoneLikePlanValue,
    collectBoundedRepairEligibilityIssues,
    parseSelfReviewCycles,
    assertStartPlanReady,
    collectBusinessContextGateIssues,
    ticketTouchesBusinessContextRisk,
    readBusinessContextEvidence,
    collectAdrRequirementIssues,
    collectAdrReviewCycleIssues,
    collectAdrCloseoutCitationIssues,
    deriveDecisionRequiredGuidance,
    ticketRequiresAdrDecision,
    readAdrDecisionEvidence,
    normalizeAdrRef,
    collectReviewPlanReadinessIssues,
    formatGovernanceBlockers,
    assertReviewPlanReady,
    submitRequiresReviewPlanCheck,
    collectContinuityWriteSafetyIssues,
    assertContinuityWriteSafe,
  };
}

module.exports = createGovernanceValidation;
