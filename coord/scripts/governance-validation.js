const fs = require("node:fs");
const path = require("node:path");

const { gitTry } = require("./git-ops.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const { STATUS } = require("./governance-constants.js");
const { classifyLensBuckets } = require("./review-lens-catalog.js");
// COORD-153: live-MCP lifecycle enforcement. Pure and dependency-free (it only
// inspects the declared plan object + the COORD-152 operation-class policy), so
// it is required directly rather than dependency-injected, mirroring how
// bootstrap-advisory.js is consumed by ticket-guidance.js.
const { buildLiveMcpLifecycle } = require("./live-mcp-lifecycle.js");
// COORD-164: server-bootstrap-via-live-mcp BRIDGE. Pure and dependency-free,
// mirroring buildLiveMcpLifecycle. It governs ONLY tickets that declare BOTH a
// `live_mcp` and a `bootstrap_risk` plan object (a server bootstrap job executed
// as a live-MCP operation); for every other ticket it returns no issues. It adds
// the bootstrap-coverage blocker only — cleanup/redaction enforcement stays with
// the COORD-153 gate above, which runs on the same `live_mcp` object.
const { buildBootstrapViaLiveMcpLifecycle } = require("./bootstrap-via-live-mcp.js");
const { collectGatePlanReadinessIssues } = require("./gate-plan.js"), { collectDecompositionProofIssues } = require("./decomposition-proof-gate.js");
const { validate: validateAdrRegistry } = require("./adr-validator.js");
const { createAdrGate } = require("./gates/adr.js");
const { createBusinessContextGate } = require("./gates/business-context.js");
const { createContextPackAcknowledgementGate } = require("./gates/context-pack-ack.js");
const { createReadinessGate } = require("./gates/readiness.js");
const { createGateRegistry } = require("./gates/registry.js");
const { createReviewCloseoutGate } = require("./gates/review-closeout.js");
const {
  computeContinuityGenerationHash,
  mergeAppendOnlyContinuityRecords,
  validateContinuityFreshRead,
} = require("./governance-context.js");

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
    buildPromptWaiverCommand,
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
    hasPromptWaiver,
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
    ticketPromptRelPathExists,
    defaultTicketPromptRelPath,
    toArray,
  } = deps;

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
      ({ ticketId, row, planState, cycles }) => collectAdrReviewCycleIssues(ticketId, row, planState, cycles),
      ({ ticketId, row, planState }) => [...collectAdrCloseoutCitationIssues(ticketId, row, planState), ...reviewCloseoutGate.collectSubagentSupervisionIssues(ticketId)],
    ],
  });

  const readinessGate = createReadinessGate({
    GovernanceError,
    STATUS,
    buildDependencyRepairNextSteps,
    buildHistoricalCloseoutStartBlocker,
    buildPromptWaiverCommand,
    buildStartPlanBootstrapCommand,
    collectReviewPlanReadinessIssues,
    defaultTicketPromptRelPath,
    describeTicketMutationOwnershipIssue,
    evaluateReadiness,
    formatDependencyCycleList,
    formatGovernanceBlockers,
    formatTransitiveBlockerDetails,
    fs,
    hasPromptWaiver,
    path,
    readPlanState,
    rowsById,
    startGateRegistry,
    state,
    ticketPromptRelPathExists,
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

function deriveGovernanceReadiness(ticketId, row, board, lock, planState, questionsGuidance = null) {
  const governance = normalizeGovernancePlanShape(planState?.governance, resolveRepoCodeForTicket(ticketId, row));
  const startupChecklist = (planState?.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
  const traceabilityGate = (planState?.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
  const repoGates = planState?.repo_gates || [];
  const featureProof = (planState?.feature_proof || []).filter((value) => isMeaningfulText(value) && !/^todo\b/i.test(String(value || "").trim()));
  const reviewIssues = collectReviewPlanReadinessIssues(ticketId, row);
  // COORD-166: surface the active plan-completeness lane (full vs light) in the
  // explain readiness report. Advisory/read-only — the actual relaxation is
  // applied inside the readiness collectors above.
  const laneDecision = resolveTicketLightLane(ticketId, row, planState);
  const selfReviewBlockedCodes = new Set([
    "self_review_cycle_count",
    "self_review_cycle_incomplete",
    "self_review_cycle_shallow",
    "self_review_lens_coverage",
    "self_review_final_verdict",
  ]);
  const selfReviewCyclesComplete = !reviewIssues.some((issue) => selfReviewBlockedCodes.has(issue.code));
  const featureProofRequired = requiresFeatureProofGovernance(board.metadata, ticketId, row) && !isTestingInfrastructureTicket(row, planState);
  const ticketRepairEvents = collectTicketGovernanceIssueEvents(ticketId)
    .filter((event) => ["recover", "manual-reconcile", "reconcile"].includes(String(event.command || "")));
  const resolvedRepairQuestionLogged = hasResolvedGovernanceRepairQuestion(ticketId);
  const ticketLocalRepairs = governance.ticket_local_repairs.length > 0
    ? governance.ticket_local_repairs
    : ticketRepairEvents.length > 0
    ? ticketRepairEvents.map((event) => ({
        kind: String(event.command),
        required_question_logged: resolvedRepairQuestionLogged,
        note: event.command === "manual-reconcile"
          ? "ticket-local governance reconcile affected this ticket's closeout path"
          : "ticket-local governance repair was required before lifecycle could proceed",
      }))
    : governance.ticket_local_repairs;

  return {
    active_lane: {
      lane: laneDecision.eligible ? "light" : "full",
      light_lane_eligible: laneDecision.eligible,
      reason: laneDecision.reason,
    },
    bootstrap: {
      startup_attested: startupChecklist.includes("completed"),
      traceability_status: traceabilityGate.find((value) => ["verified", "closing-gap", "exempt"].includes(value)) || "pending",
    },
    review_prep: {
      repo_gates_recorded:
        fieldHasMeaningfulValue(repoGates) ||
        repoGates.some((value) => String(value).trim().toLowerCase() === "not-required"),
      feature_proof_recorded: featureProofRequired ? featureProof.length > 0 : true,
      self_review_cycles_complete: selfReviewCyclesComplete,
    },
    closeout: {
      expected_method: governance.expected_closeout.method,
      base_ref: governance.expected_closeout.base_ref,
      provenance_note: governance.expected_closeout.provenance_note,
      repair_ticket_local: ticketLocalRepairs.length > 0,
      repair_question_logged: ticketLocalRepairs.every((entry) => entry.required_question_logged !== false),
    },
    decision_required: deriveDecisionRequiredGuidance(ticketId, row, planState),
    ticket_local_repairs: ticketLocalRepairs,
  };
}

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

  const candidates = collectLandingAuditCandidates(repoRoot, landing.evidence || []);
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

function deriveTestingInfrastructureAudit(ticketId, row, landing) {
  if (!landing || !isRepoBackedCode(row.Repo)) {
    return null;
  }
  const planState = readPlanRecord(ticketId, { allowMissing: true }) || readPlanState(ticketId);
  if (!isTestingInfrastructureTicket(row, planState)) {
    return null;
  }

  const repoRoot = getRepoRoot(row.Repo);
  const repoLabel = repoDisplayNameForCode(row.Repo);
  const baseRef = String(landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim();
  const commitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha) ||
    resolveLandingCommitSha(ticketId, row, landing.method || "manual", landing.evidence || [], [], { baseRef });
  if (!commitSha) {
    throw new Error(`Ticket ${ticketId} testing-infrastructure audit could not resolve the landed commit SHA.`);
  }

  const commands = mergeUniqueRefs(planState?.repo_gates || [], planState?.verification_commands || []);
  const plannedFiles = splitPlanPathValues(planState?.intended_files || [])
    .map((entry) => normalizeTestingInfraAuditPath(row.Repo, ticketId, entry))
    .filter((entry) => entry && isTestingInfrastructureFilePath(entry));
  const commandFiles = extractFileReferencesFromCommands(ticketId, row, commands);
  const fallbackFiles = listCommitTouchedPaths(repoRoot, commitSha)
    .map((entry) => normalizeTestingInfraAuditPath(row.Repo, ticketId, entry))
    .filter((entry) => entry && isTestingInfrastructureFilePath(entry));
  const requiredFiles = [...new Set([...plannedFiles, ...commandFiles, ...fallbackFiles])].sort();
  const requiredScripts = [...new Set(extractPackageScriptsFromCommands(commands))].sort();

  if (requiredFiles.length === 0 && requiredScripts.length === 0) {
    throw new Error(
      `Ticket ${ticketId} is a testing-infrastructure ticket, but governance could not derive required files or scripts from its canonical plan record and landing commit.`
    );
  }

  const presentFiles = requiredFiles.filter((filePath) => gitPathExistsAtRef(repoRoot, baseRef, filePath));
  const missingFiles = requiredFiles.filter((filePath) => !presentFiles.includes(filePath));
  const packageJson = readJsonFileFromRef(repoRoot, baseRef, "package.json") || {};
  const scripts = packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
    ? packageJson.scripts
    : {};
  const missingScripts = requiredScripts.filter((scriptName) => !Object.prototype.hasOwnProperty.call(scripts, scriptName));
  const evidence =
    `${TESTING_INFRA_LANDING_EVIDENCE_PREFIX} commit ${commitSha} is an ancestor of ${repoLabel}/${baseRef}; ` +
    `verified files at tip: ${presentFiles.length > 0 ? presentFiles.join(", ") : "none"}; ` +
    `legacy-missing files tolerated: ${missingFiles.length > 0 ? missingFiles.join(", ") : "none"}; ` +
    `required scripts at tip: ${requiredScripts.length > 0 ? requiredScripts.join(", ") : "none"}`;

  return {
    ticketId,
    repoLabel,
    baseRef,
    commitSha,
    requiredFiles,
    presentFiles,
    requiredScripts,
    missingFiles,
    missingScripts,
    evidence,
  };
}

function readTextFileFromRef(repoRoot, refName, filePath) {
  const result = gitTry(repoRoot, ["show", `${refName}:${filePath}`]);
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "");
}

function gitRefContainsLiteral(repoRoot, refName, text) {
  const result = gitTry(repoRoot, ["grep", "-F", "-n", "--", text, refName]);
  return result.status === 0;
}

function parseFeatureProofEntry(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const match = /^([a-z_]+):(.*)$/i.exec(raw);
  if (!match) {
    return {
      raw,
      kind: "invalid",
      valid: false,
      reason: 'use one of "path:", "symbol:", "text:", or "route:"',
    };
  }
  const kind = String(match[1] || "").trim().toLowerCase();
  const remainder = String(match[2] || "").trim();
  if (!remainder) {
    return {
      raw,
      kind,
      valid: false,
      reason: "missing proof value",
    };
  }
  if (kind === "path") {
    return { raw, kind, valid: true, path: remainder };
  }
  if (kind === "text" || kind === "route") {
    return { raw, kind, valid: true, text: remainder };
  }
  if (kind === "symbol") {
    const hashIndex = remainder.indexOf("#");
    if (hashIndex <= 0 || hashIndex === remainder.length - 1) {
      return {
        raw,
        kind,
        valid: false,
        reason: 'use "symbol:<repo-relative-path>#<literal-or-symbol>"',
      };
    }
    return {
      raw,
      kind,
      valid: true,
      path: remainder.slice(0, hashIndex).trim(),
      symbol: remainder.slice(hashIndex + 1).trim(),
    };
  }
  return {
    raw,
    kind,
    valid: false,
    reason: `unsupported proof kind "${kind}"`,
  };
}

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
  return String(value || "").trim();
}

function evaluateFeatureProofEntry(repoRoot, refName, entry) {
  if (!entry?.valid) {
    return {
      ok: false,
      reason: entry?.reason || "invalid feature proof entry",
    };
  }
  if (entry.kind === "path") {
    const ok = gitPathExistsAtRef(repoRoot, refName, entry.path);
    return {
      ok,
      reason: ok ? null : `missing path ${entry.path}`,
    };
  }
  if (entry.kind === "symbol") {
    const content = readTextFileFromRef(repoRoot, refName, entry.path);
    if (content === null) {
      return {
        ok: false,
        reason: `missing path ${entry.path}`,
      };
    }
    const ok = content.includes(entry.symbol);
    return {
      ok,
      reason: ok ? null : `missing literal "${entry.symbol}" in ${entry.path}`,
    };
  }
  if (entry.kind === "text" || entry.kind === "route") {
    const ok = gitRefContainsLiteral(repoRoot, refName, entry.text);
    return {
      ok,
      reason: ok ? null : `missing literal "${entry.text}" in repo`,
    };
  }
  return {
    ok: false,
    reason: entry.reason || "invalid feature proof entry",
  };
}

function deriveFeatureProofAudit(ticketId, row, landing, metadata) {
  if (!landing || !isRepoBackedCode(row.Repo)) {
    return null;
  }
  if (!requiresFeatureProofGovernance(metadata, ticketId, row)) {
    return null;
  }

  const planState = readPlanRecord(ticketId, { allowMissing: true }) || readPlanState(ticketId);
  if (!planState) {
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
  const invalidEntries = parsedEntries.filter((entry) => !entry?.valid);
  if (invalidEntries.length > 0) {
    throw new Error(
      `Ticket ${ticketId} has invalid feature-proof entries: ` +
      `${invalidEntries.map((entry) => `${entry.raw} (${entry.reason})`).join("; ")}.`
    );
  }

  const requestedBaseRef = String(landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH).trim() || REPO_INTEGRATION_BRANCHES[row.Repo] || DEFAULT_INTEGRATION_BRANCH;
  const resolvedCommitSha = resolveCommitishInRepo(repoRoot, landing.commit_sha || landing.fulfilled_by_commit_sha) ||
    resolveLandingCommitSha(ticketId, row, landing.method || "manual", landing.evidence || [], [], { baseRef: requestedBaseRef });
  const baseResolution = resolveLandingBaseRef(repoRoot, requestedBaseRef, resolvedCommitSha, {
    explicitBase: requestedBaseRef.startsWith("origin/"),
  });
  const baseRef = baseResolution.baseRef;

  const failures = parsedEntries
    .map((entry) => {
      const isCoordScoped = entry.raw && /^coord:/.test(entry.raw);
      const evalRoot = isCoordScoped ? COORD_DIR : repoRoot;
      const evalRef = isCoordScoped ? "HEAD" : baseRef;
      const evalEntry = isCoordScoped
        ? { ...entry, path: entry.path ? entry.path.replace(/^coord:/, "") : entry.path, raw: entry.raw.replace(/^coord:/, "") }
        : entry;
      return {
        entry,
        evaluation: evaluateFeatureProofEntry(evalRoot, evalRef, evalEntry),
      };
    })
    .filter((result) => !result.evaluation.ok);
  if (failures.length > 0) {
    throw new Error(
      `Ticket ${ticketId} feature-proof audit failed against ${repoLabel}/${baseRef}. Missing at branch tip: ` +
      `${failures.map((result) => `${result.entry.raw} (${result.evaluation.reason})`).join("; ")}. ` +
      `Recovery: update proofs with "coord/scripts/gov update-plan ${ticketId} --feature-proof \\"path:<correct-path>\\"" ` +
      `or drop invalid proofs with "coord/scripts/gov update-plan ${ticketId} --drop-feature-proof \\"${failures[0]?.entry?.raw || ""}\\"".\n` +
      `Use "coord:" prefix for proofs that resolve against the coord repo instead of ${repoLabel}.`
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
// self-review + the full requirement_closure verdict gate). They DO still pay
// for integrity: attributed ownership (the COORD-128 bound-owner mutation guard
// is enforced separately in governance-session.js and is NOT touched here), a
// repo-gate equivalent (board validate / markdown sanity recorded under "- Repo
// gates:"), and at least ONE structured self-review cycle.
//
// The lane is decided ONLY by ticket type + the changed paths, never by
// relaxing any integrity/attribution check. The default is always the FULL
// lane; the light lane is an explicit, conservative opt-in. If anything is
// ambiguous (no type, no changed paths, or any procedural surface touched) the
// decision fails toward the FULL lane.

// Procedural-doc surfaces. Changes to these alter AGENT BEHAVIOR (procedural
// memory), so a docs-typed ticket touching ANY of them is hard-carved-OUT of
// the light lane and must use the full reviewed lane (see COORD-145).
//   - AGENTS.md and coord/AGENTS.md (and any repo-local AGENTS.md)
//   - CLAUDE.md
//   - coord/GOVERNANCE.md
//   - anything under .claude/ (skills / commands)
const LIGHT_LANE_TICKET_TYPES = new Set(["docs", "chore"]);

function isProceduralDocPath(value) {
  const normalized = String(value || "").trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) {
    return false;
  }
  // .claude/ anywhere in the path (skills / commands change execution).
  if (normalized === ".claude" || normalized.startsWith(".claude/") || normalized.includes("/.claude/")) {
    return true;
  }
  const base = normalized.split("/").pop();
  // Behavior-defining markdown surfaces, matched by basename so a repo-local
  // AGENTS.md anywhere is covered, plus the exact governance/instruction files.
  if (base === "AGENTS.md" || base === "CLAUDE.md") {
    return true;
  }
  if (normalized === "coord/GOVERNANCE.md" || base === "GOVERNANCE.md") {
    return true;
  }
  return false;
}

// Pure, testable lane decision. Returns { eligible, reason }.
//   ticket       — board row (or { Type }); only the Type field is read.
//   changedPaths — the changed/intended repo-relative paths for the ticket.
function isLightLaneEligible(ticket, changedPaths) {
  const type = String(ticket?.Type || ticket?.type || "").trim().toLowerCase();
  if (!LIGHT_LANE_TICKET_TYPES.has(type)) {
    return { eligible: false, reason: `ticket type "${type || "(none)"}" is not light-lane eligible (only docs/chore qualify)` };
  }
  const paths = (Array.isArray(changedPaths) ? changedPaths : [])
    .map((value) => String(value || "").trim())
    .filter((value) => isMeaningfulText(value));
  if (paths.length === 0) {
    // Fail toward the full lane when we cannot see what changed.
    return { eligible: false, reason: "no changed/intended paths recorded — cannot prove a reference-doc-only change, defaulting to full lane" };
  }
  const proceduralHits = paths.filter((value) => isProceduralDocPath(value));
  if (proceduralHits.length > 0) {
    return {
      eligible: false,
      reason: `changed paths touch procedural-doc surface(s) that change agent behavior (${proceduralHits.join(", ")}); full reviewed lane required`,
    };
  }
  return { eligible: true, reason: `docs/chore reference-doc change with no procedural-doc surfaces (${paths.join(", ")})` };
}

// Resolves the active lane for a ticket from its canonical plan state. The
// changed paths are taken from the plan's intended_files (the same source the
// coord-only landing exception uses), normalized to repo-relative form. This is
// the single wiring point the readiness collectors and `explain` consume so the
// pure decision above stays the source of truth.
function resolveTicketLightLane(ticketId, row, planState) {
  const intendedFiles = splitPlanPathValues(planState?.intended_files || [])
    .map((value) => String(value || "").trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((value) => isMeaningfulText(value));
  return isLightLaneEligible(row, intendedFiles);
}

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

function validateFeatureProofEntry(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    fail("Feature proof entries may not be empty.");
  }
  const withoutRepoPrefix = normalized.replace(/^coord:/, "");
  if (/^path:/.test(withoutRepoPrefix)) {
    if (/#/.test(withoutRepoPrefix)) {
      fail(
        `Feature proof entry "${normalized}" is invalid. ` +
        `Use "path:<file>" for file proofs or "symbol:<file>#<symbol>" for symbol proofs.`
      );
    }
    return;
  }
  if (/^symbol:[^#]+#.+$/.test(withoutRepoPrefix)) {
    return;
  }
  if (/^(text|route):.+$/.test(withoutRepoPrefix)) {
    return;
  }
  fail(
    `Feature proof entry "${normalized}" is invalid. ` +
    `Use "path:<file>", "symbol:<file>#<symbol>", "text:<literal>", or "route:<literal-route>". ` +
    `Prefix with "coord:" for cross-repo proofs that resolve against coord instead of the ticket repo.`
  );
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

function traceDependencyReadiness(currentRow, depId, byId, board, path = []) {
  const dep = byId.get(depId);
  if (!dep) {
    return {
      blocked: false,
      blockerChains: [],
      cycles: [],
      transitiveBlockedBy: [],
    };
  }
  if (allowsFollowupDependencyReadinessException({ board, row: currentRow, depId, dep })) {
    return {
      blocked: false,
      blockerChains: [],
      cycles: [],
      transitiveBlockedBy: [],
    };
  }
  if (path.includes(depId)) {
    const cycleStart = path.indexOf(depId);
    return {
      blocked: true,
      blockerChains: [],
      cycles: [path.slice(cycleStart).concat(depId)],
      transitiveBlockedBy: [depId],
    };
  }
  if (dep.Status === STATUS.DONE) {
    return {
      blocked: false,
      blockerChains: [],
      cycles: [],
      transitiveBlockedBy: [],
    };
  }

  const transitiveBlockedBy = new Set([depId]);
  const blockerChains = [];
  const cycles = [];
  const nextPath = [...path, depId];
  for (const nestedDepId of splitDependsOn(dep["Depends On"])) {
    const nested = traceDependencyReadiness(dep, nestedDepId, byId, board, nextPath);
    for (const blockedId of nested.transitiveBlockedBy || []) {
      transitiveBlockedBy.add(blockedId);
    }
    cycles.push(...(nested.cycles || []));
    if (nested.blocked && (nested.blockerChains || []).length > 0) {
      for (const chain of nested.blockerChains) {
        blockerChains.push([depId, ...chain]);
      }
    }
  }
  if (blockerChains.length === 0 && cycles.length === 0) {
    blockerChains.push([depId]);
  }
  return {
    blocked: true,
    blockerChains: dedupeDependencyChains(blockerChains),
    cycles: dedupeDependencyChains(cycles),
    transitiveBlockedBy: [...transitiveBlockedBy],
  };
}

function evaluateReadiness(row, byId, board = null) {
  const deps = splitDependsOn(row["Depends On"]);
  const blockedBy = [];
  const transitiveBlockedBy = new Set();
  const blockerChains = [];
  const cycles = [];

  for (const depId of deps) {
    const traced = traceDependencyReadiness(row, depId, byId, board, [row.ID]);
    if (!traced.blocked) {
      continue;
    }
    blockedBy.push(depId);
    for (const blockedId of traced.transitiveBlockedBy || []) {
      transitiveBlockedBy.add(blockedId);
    }
    blockerChains.push(...(traced.blockerChains || []));
    cycles.push(...(traced.cycles || []));
  }

  return {
    deps,
    blockerChains: dedupeDependencyChains(blockerChains),
    blockedBy,
    cycles: dedupeDependencyChains(cycles),
    transitiveBlockedBy: [...transitiveBlockedBy],
    ready: blockedBy.length === 0 && cycles.length === 0,
  };
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

// COORD-137: the canonical lens catalog (coord/scripts/review-lens-catalog.js)
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

function collectReviewPlanReadinessIssues(ticketId, row) {
  const block = readLatestPlanBlock(ticketId);
  const canonicalPlanRecord = readPlanRecord(ticketId, { allowMissing: true });
  const planState = canonicalPlanRecord || readPlanState(ticketId);
  const board = readBoard();
  if (!planState) {
    return [{
      code: "missing_plan_state",
      message: `Plan state missing for ${ticketId}. Canonical review evidence must exist before moving to review.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --summary "<change summary>"`,
      ],
    }];
  }

  const issues = [];
  const findings = board.review_findings?.[ticketId] || [];
  const requiredRound = inferRequiredReviewRound(findings);
  const planRound = integerOrDefault(planState.review_round, 0);
  if (planRound !== requiredRound) {
    issues.push({
      code: "review_round",
      message: `Plan state for ${ticketId} must record "- Review round:" as ${requiredRound} before move-review. Fresh review evidence is required for the current repair round.`,
      next_steps: [`coord/scripts/gov explain ${ticketId}`],
    });
  }

  const requirementClosure = parseRequirementClosureEntries(planState.requirement_closure || []);
  const repoGates = planState.repo_gates || [];
  const governance = normalizeGovernancePlanShape(planState.governance, row.Repo);
  const productRepo = isRepoBackedCode(row.Repo);
  // COORD-166: light-lane decision (docs/chore reference-doc tickets). Relaxes
  // PLAN COMPLETENESS only (feature-proof, full requirement_closure verdict, the
  // full self-review cycle ceremony); never weakens attribution, the bound-owner
  // guard, repo-gates, or the minimum-one structured self-review cycle.
  const lightLane = resolveTicketLightLane(ticketId, row, planState).eligible;
  issues.push(...collectGatePlanReadinessIssues(ticketId, row, planState, { lightLane }), ...collectDecompositionProofIssues({ ticketId, row, planState, coordDir: COORD_DIR }));
  const boundedRepairRequested = productRepo && governance.review_profile === "bounded_repair";
  const boundedRepairEligibilityIssues = boundedRepairRequested
    ? collectBoundedRepairEligibilityIssues(planState, requirementClosure)
    : [];
  if (boundedRepairEligibilityIssues.length > 0) {
    issues.push({
      code: "bounded_repair_ineligible",
      message: `Plan state for ${ticketId} cannot use governance review_profile=bounded_repair until ticket-local repair constraints are satisfied: ${boundedRepairEligibilityIssues.join("; ")}.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --review-profile standard`,
        `coord/scripts/gov update-plan ${ticketId} --files "<narrow repo-relative path>" --verify "<direct regression command>" --repo-gate "<executed gate command>" --closure "Not implemented: none" --closure "Deferred to: none"`,
      ],
    });
  }
  issues.push(
    ...collectClosureReadinessIssues(ticketId, row, planState, board, {
      productRepo,
      requirementClosure,
      repoGates,
      lightLane,
    })
  );

  const cycles = buildReviewCycleSnapshots(planState, canonicalPlanRecord, block);
  issues.push(
    ...collectSelfReviewCycleIssues(ticketId, row, cycles, {
      productRepo,
      boundedRepairRequested,
      boundedRepairEligibilityIssues,
      lightLane,
    })
  );
  issues.push(...reviewGateRegistry.run("review", { ticketId, row, planState, board, cycles }));
  // COORD-153: live-MCP lifecycle enforcement. Scoped STRICTLY to tickets that
  // DECLARE a live-mcp operation (planState.live_mcp present); for every other
  // ticket buildLiveMcpLifecycle returns no issues, so normal/existing tickets
  // are completely unaffected. When declared, missing required evidence
  // (operation class, adapter, environment, scope, approval/redaction/cleanup
  // per the operation-class policy, a recorded receipt, and promotion for
  // product-impacting findings) BLOCKS move-review/closeout.
  issues.push(...buildLiveMcpLifecycle({ planState }).issues);
  // COORD-164: bootstrap-via-live-mcp coverage blocker. Fires ONLY when the plan
  // declares BOTH live_mcp AND bootstrap_risk (the explicit "this bootstrap job
  // ran as a live-MCP operation" signal). It does NOT re-check cleanup/redaction
  // — those stay with buildLiveMcpLifecycle above on the same live_mcp object;
  // this adds only the bootstrap-coverage requirement. Normal tickets,
  // bootstrap-only tickets, and live-mcp-only tickets all get zero issues here.
  issues.push(...buildBootstrapViaLiveMcpLifecycle({ planState }).issues);
  return issues;
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

function assertReviewPlanReady(ticketId, row) {
  const issues = collectReviewPlanReadinessIssues(ticketId, row);
  if (issues.length > 0) {
    throw new GovernanceError(formatGovernanceBlockers(ticketId, issues, "Review-plan blockers for"));
  }
}

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
          "Re-read the current journal, decision, or promotion-candidate source.",
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
          "Re-read the canonical continuity sources.",
          "Regenerate the derived view from current inputs.",
          "Do not append derived readout output to the governance journal as authority.",
        ],
      });
    }
  }
  return issues;
}

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
