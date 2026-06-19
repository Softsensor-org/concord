const { gitTry } = require("./git-ops.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const { STATUS } = require("./governance-constants.js");

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

function deriveGovernanceReadiness(ticketId, row, board, lock, planState, questionsGuidance = null) {
  const governance = normalizeGovernancePlanShape(planState?.governance, resolveRepoCodeForTicket(ticketId, row));
  const startupChecklist = (planState?.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
  const traceabilityGate = (planState?.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
  const repoGates = planState?.repo_gates || [];
  const featureProof = (planState?.feature_proof || []).filter((value) => isMeaningfulText(value) && !/^todo\b/i.test(String(value || "").trim()));
  const reviewIssues = collectReviewPlanReadinessIssues(ticketId, row);
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
    ticket_local_repairs: ticketLocalRepairs,
  };
}

function collectStartReadinessBlockers(ticketId, row, board) {
  if (row.Status !== STATUS.TODO && row.Status !== STATUS.DEFERRED) {
    return [];
  }

  const blockers = [];
  const closeoutBlocker = buildHistoricalCloseoutStartBlocker(ticketId, row, board);
  if (closeoutBlocker) {
    blockers.push(closeoutBlocker);
    return blockers;
  }
  const readiness = evaluateReadiness(row, rowsById(board), board);
  if (readiness.cycles.length > 0) {
    blockers.push({
      code: "dependency_cycles",
      message: `Ticket ${ticketId} cannot start because dependency cycle(s) exist: ${formatDependencyCycleList(readiness.cycles)}.`,
      next_steps: buildDependencyRepairNextSteps(ticketId, readiness, board),
    });
  }
  if (readiness.blockedBy.length > 0) {
    const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
    blockers.push({
      code: "dependencies",
      message:
        `Ticket ${ticketId} cannot start until these dependencies land: ${readiness.blockedBy.join(", ")}.` +
        (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
        (readiness.deps.length === 1 && readiness.blockedBy.length === 1
          ? " If this dependency should only track a related or closeout-only follow-up, repair the relation with set-followup-relation instead of editing board state directly."
          : ""),
      next_steps: buildDependencyRepairNextSteps(ticketId, readiness, board),
    });
  }
  // COORD-023: a prompt that exists on disk (coord/prompts/tickets/<ID>.md)
  // counts as coverage here too — gov start will auto-register it — so this
  // read-only preflight does not report a false blocker that start would then
  // sail through. Only a truly missing prompt (no index, no waiver, no file)
  // is a blocker, and register-prompt is offered alongside the waiver path.
  if (
    !board.prompt_index?.[ticketId] &&
    !hasPromptWaiver(board, ticketId) &&
    !ticketPromptRelPathExists(defaultTicketPromptRelPath(ticketId))
  ) {
    blockers.push({
      code: "prompt_coverage",
      message: `Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`,
      next_steps: [
        `coord/scripts/gov register-prompt ${ticketId}  # if you create coord/prompts/tickets/${ticketId}.md`,
        buildPromptWaiverCommand(ticketId),
      ],
    });
  }

  const planState = readPlanState(ticketId);
  if (!planState) {
    blockers.push({
      code: "missing_plan_state",
      message: `Plan state missing for ${ticketId}. Seed canonical plan state before start-ticket.`,
      next_steps: [buildStartPlanBootstrapCommand(ticketId, row)],
    });
    return blockers;
  }
  if (planState) {
    const startupChecklist = (planState.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
    if (!startupChecklist.includes("completed")) {
      blockers.push({
        code: "startup_checklist",
        message: `Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`,
        next_steps: [`coord/scripts/gov update-plan ${ticketId} --startup completed`],
      });
    }

    const traceabilityGate = (planState.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
    if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
      blockers.push({
        code: "traceability_gate",
        message: `Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`,
        next_steps: [`coord/scripts/gov update-plan ${ticketId} --traceability verified`],
      });
    }

    if (ticketRequiresBaseline(row)) {
      const baselineItems = planState.baseline_reproduction || [];
      const hasCommand = baselineItems.some((value) => /^Command:/i.test(value));
      const hasOutcome = baselineItems.some((value) => /^Outcome:/i.test(value));
      if (!hasCommand || !hasOutcome) {
        blockers.push({
          code: "baseline_reproduction",
          message: `Plan state for ${ticketId} must record baseline reproduction Command and Outcome before start-ticket.`,
          next_steps: [
            `coord/scripts/gov update-plan ${ticketId} --baseline "Command: <repro command>" --baseline "Outcome: <observed result>"`,
          ],
        });
      }
    }
  }

  return blockers;
}

function collectSubmitReadinessBlockers(ticketId, row, board, lock, options = {}) {
  if (row.Status === STATUS.REVIEW) {
    return [];
  }
  if (row.Status !== STATUS.DOING) {
    return [{
      code: "status",
      message: `Ticket ${ticketId} must be doing or review to submit; current status is "${row.Status}".`,
      next_steps: row.Status === STATUS.TODO || row.Status === STATUS.DEFERRED
        ? [`coord/scripts/gov start ${ticketId}`]
        : [`coord/scripts/gov explain ${ticketId}`],
    }];
  }
  if (!lock) {
    return [{
      code: "missing_lock",
      message: `Ticket ${ticketId} is doing but has no active lock.`,
      next_steps: [`coord/scripts/gov recover ${ticketId}`],
    }];
  }

  const blockers = [];
  const ownershipIssue = describeTicketMutationOwnershipIssue(ticketId, row, lock);
  if (ownershipIssue.code !== "ok") {
    blockers.push(ownershipIssue);
  }
  if (submitRequiresReviewPlanCheck(board, row, ticketId, options)) {
    blockers.push(...collectReviewPlanReadinessIssues(ticketId, row));
  }
  return blockers;
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

function classifyReviewLensBuckets(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const buckets = new Set();
  if (/(contract|state|invariant)/.test(normalized)) {
    buckets.add("contract/state invariants");
  }
  if (/(auth|security|failure|rbac|permission)/.test(normalized)) {
    buckets.add("auth/security/failure modes");
  }
  if (/(test|operability|performance|coverage|runtime)/.test(normalized)) {
    buckets.add("tests/operability/performance");
  }
  if (/(requirement|closure|scope|ask|implemented|deferred)/.test(normalized)) {
    buckets.add("requirement closure");
  }
  return [...buckets];
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

function isNoneLikePlanValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "none" || normalized === "not-required" || normalized === "n/a";
}

function collectBoundedRepairEligibilityIssues(planState, requirementClosure) {
  const issues = [];
  const intendedFiles = (planState.intended_files || []).filter((value) => isMeaningfulText(value));
  if (intendedFiles.length === 0 || intendedFiles.length > 3) {
    issues.push("bounded repair requires 1-3 intended files to keep the diff narrow");
  }
  if (!fieldHasMeaningfulValue(planState.verification_commands || [])) {
    issues.push("bounded repair requires direct regression verification commands");
  }
  if (!fieldHasMeaningfulValue(planState.repo_gates || [])) {
    issues.push("bounded repair requires recorded repo gates");
  }
  if (!isNoneLikePlanValue(requirementClosure.not_implemented)) {
    issues.push('bounded repair requires "Not implemented: none"');
  }
  if (!isNoneLikePlanValue(requirementClosure.deferred_to)) {
    issues.push('bounded repair requires "Deferred to: none"');
  }
  return issues;
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

function assertStartPlanReady(ticketId, row) {
  const planState = readPlanState(ticketId);
  if (!planState) {
    throw new GovernanceError(`Plan state missing for ${ticketId}. Create the canonical record (or a compatible PLAN.md block for stale tickets) before starting.`);
  }
  const startupChecklist = (planState.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
  if (!startupChecklist.includes("completed")) {
    throw new GovernanceError(`Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`);
  }
  const traceabilityGate = (planState.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
  if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
    throw new GovernanceError(`Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`);
  }
  const baselineItems = planState.baseline_reproduction || [];
  if (ticketRequiresBaseline(row)) {
    const hasCommand = baselineItems.some((value) => /^Command:/i.test(value));
    const hasOutcome = baselineItems.some((value) => /^Outcome:/i.test(value));
    if (!hasCommand || !hasOutcome) {
      throw new GovernanceError(`Plan state for ${ticketId} must record baseline reproduction Command and Outcome before start-ticket.`);
    }
  }
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
    })
  );

  const cycles = buildReviewCycleSnapshots(planState, canonicalPlanRecord, block);
  issues.push(
    ...collectSelfReviewCycleIssues(ticketId, row, cycles, {
      productRepo,
      boundedRepairRequested,
      boundedRepairEligibilityIssues,
    })
  );
  return issues;
}

// COORD-104: extracted from collectReviewPlanReadinessIssues. Aggregates the
// product-repo (and non-product fallback) closure/gate/invariant/feature-proof
// blockers. Behavior is byte-identical: same codes, messages, next_steps, and
// short-circuit ordering as the original inline block.
function collectClosureReadinessIssues(ticketId, row, planState, board, ctx) {
  const { productRepo, requirementClosure, repoGates } = ctx;
  const issues = [];
  if (productRepo) {
    // COORD-029: tier-appropriate minimums. For `standard`/absent and `critical`
    // these resolve to the flat (today) values, so enforcement is byte-identical;
    // only a lower tier (e.g. `mechanical`) can relax below them.
    const criticalInvariants = (planState.critical_invariants || []).filter((value) => isMeaningfulText(value));
    const featureProof = (planState.feature_proof || []).filter((value) => isMeaningfulText(value) && !/^todo\b/i.test(String(value || "").trim()));
    const productTier = resolveTicketTier(row).tier;
    const minCriticalInvariants = effectiveTierMinimum(productTier, "min_critical_invariants", 2, row);
    const minFeatureProofs = effectiveTierMinimum(productTier, "min_feature_proofs", 1, row);
    if (criticalInvariants.length < minCriticalInvariants) {
      issues.push({
        code: "critical_invariants",
        message: `Plan state for ${ticketId} must record at least ${minCriticalInvariants} meaningful items under "- Critical invariants:" before move-review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --invariant "<first invariant>" --invariant "<second invariant>"`,
        ],
      });
    }
    if (!fieldHasMeaningfulValue(repoGates) || repoGates.some((value) => String(value).trim().toLowerCase() === "not-required")) {
      issues.push({
        code: "repo_gates",
        message: `Plan state for ${ticketId} must record actual repo gate/test commands under "- Repo gates:" before move-review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --repo-gate "<executed gate command>"`,
        ],
      });
    }
    issues.push(...collectRequirementClosureIssues(ticketId, row, requirementClosure));
    if (
      requiresFeatureProofGovernance(board.metadata, ticketId, row) &&
      !isTestingInfrastructureTicket(row, planState) &&
      featureProof.length < minFeatureProofs
    ) {
      issues.push({
        code: "feature_proof",
        message: `Plan state for ${ticketId} must record canonical "- Feature proof:" entries before move-review.`,
        next_steps: [
          `coord/scripts/gov update-plan ${ticketId} --feature-proof "path:<repo-relative-path>" --feature-proof "symbol:<path>#<symbol-or-literal>"`,
        ],
      });
    }
  } else if (!fieldHasMeaningfulValue(repoGates)) {
    issues.push({
      code: "repo_gates",
      message: `Plan state for ${ticketId} must record "- Repo gates:" with either executed checks or "not-required" before move-review.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --repo-gate "not-required"`,
      ],
    });
  }
  return issues;
}

// COORD-104: extracted requirement-closure field/verdict blocker. The
// missing-fields branch and the verdict branch remain mutually exclusive
// (if/else-if) exactly as in the original.
function collectRequirementClosureIssues(ticketId, row, requirementClosure) {
  const missingRequirementFields = [
    ["ticket_ask", "Ticket ask"],
    ["implemented", "Implemented"],
    ["not_implemented", "Not implemented"],
    ["deferred_to", "Deferred to"],
    ["closeout_verdict", "Closeout verdict"],
  ].filter(([key]) => !isMeaningfulText(requirementClosure[key]));
  if (missingRequirementFields.length > 0) {
    return [{
      code: "requirement_closure",
      message: `Plan state for ${ticketId} must record explicit "- Requirement closure:" entries for ${missingRequirementFields.map(([, label]) => label).join(", ")} before move-review.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --closure "Ticket ask: <ticket ask>" --closure "Implemented: <what landed>" --closure "Not implemented: <gap or none>" --closure "Deferred to: <ticket-id or none>" --closure "Closeout verdict: complete|incomplete"`,
      ],
    }];
  }
  if (requirementClosure.closeout_verdict !== "complete") {
    return [{
      code: "requirement_closure_verdict",
      message: `Plan state for ${ticketId} cannot move to review while "- Requirement closure:" says Closeout verdict: ${requirementClosure.closeout_verdict}. Open or link follow-up tickets first, then update the verdict to complete.`,
      next_steps: [
        `coord/scripts/gov open-followup <new-ticket-id> --depends-on ${ticketId} --repo ${row.Repo} --type followup --pri P0 --description "<remaining gap>" --relation closeout-blocker`,
        `coord/scripts/gov update-plan ${ticketId} --closure "Deferred to: <ticket-id or none>" --closure "Closeout verdict: complete"`,
      ],
    }];
  }
  return [];
}

// COORD-104: extracted the canonical-vs-legacy self-review cycle snapshot
// derivation. Maps the canonical plan-record cycles into the same evaluation
// shape produced by parseSelfReviewCycles, byte-for-byte unchanged.
function buildReviewCycleSnapshots(planState, canonicalPlanRecord, block) {
  if (!(Array.isArray(planState.self_review_cycles) && (canonicalPlanRecord || planState.self_review_cycles.length > 0))) {
    return parseSelfReviewCycles(block);
  }
  return planState.self_review_cycles.map((cycle) => ({
    cycle: cycle.cycle,
    total: cycle.total,
    body: cycle.raw,
    lens: cycle.lens,
    diff: cycle.diff,
    risks: Array.isArray(cycle.risks) ? cycle.risks.join(", ") : "",
    findings: cycle.findings,
    verification: cycle.verification,
    riskCount: Array.isArray(cycle.risks) ? cycle.risks.length : 0,
    lensBuckets: classifyReviewLensBuckets(cycle.lens),
    missingFields: ["lens", "diff", "findings", "verification", "verdict"].filter((field) => !isMeaningfulText(cycle[field])),
    structured:
      isMeaningfulText(cycle.lens) &&
      isMeaningfulText(cycle.diff) &&
      Array.isArray(cycle.risks) &&
      cycle.risks.length > 0 &&
      isMeaningfulText(cycle.findings) &&
      isMeaningfulText(cycle.verification) &&
      isMeaningfulText(cycle.verdict),
    verdictRaw: cycle.verdict,
    verdict: normalizeReviewVerdict(cycle.verdict),
  }));
}

// COORD-104: extracted the self-review-cycle blockers (count/structure/risk
// depth/lens coverage/final verdict). Issue codes, messages, next_steps, and
// evaluation order are byte-identical to the original inline block.
function collectSelfReviewCycleIssues(ticketId, row, cycles, ctx) {
  const { productRepo, boundedRepairRequested, boundedRepairEligibilityIssues } = ctx;
  const issues = [];
  const reviewCycleCommand = `coord/scripts/gov update-plan ${ticketId} --review-cycle "lens=<lens>; diff=<what changed>; risks=<risk 1>, <risk 2>; findings=<none|finding>; verification=<command>; verdict=<pass|fail>"`;
  // COORD-029: flat (pre-tier) minimum, computed exactly as before. The tier
  // policy may only RELAX this below the flat value for a lower tier; `standard`
  // (and absent) and `critical` resolve back to flatMinimumCycles unchanged, so
  // their enforcement is byte-identical to pre-COORD-029 behavior.
  const flatMinimumCycles = productRepo
    ? (boundedRepairRequested && boundedRepairEligibilityIssues.length === 0 ? 3 : 4)
    : 3;
  const ticketTier = resolveTicketTier(row).tier;
  const minimumCycles = effectiveTierMinimum(ticketTier, "min_review_cycles", flatMinimumCycles, row);
  if (cycles.length < minimumCycles) {
    issues.push({
      code: "self_review_cycle_count",
      message: `Plan state for ${ticketId} must record at least ${minimumCycles} self-review cycles before move-review.`,
      next_steps: [reviewCycleCommand],
    });
  }
  const malformedCycle = cycles.find((cycle) => !cycle.structured);
  if (malformedCycle) {
    issues.push({
      code: "self_review_cycle_incomplete",
      message: `Plan state for ${ticketId} has an incomplete self-review cycle (${malformedCycle.cycle}/${malformedCycle.total}). Each cycle must include lens=, diff=, risks=, findings=, verification=, and verdict=.`,
      next_steps: [reviewCycleCommand],
    });
  }
  const shallowRiskCycle = cycles.find((cycle) => cycle.riskCount < 2);
  if (shallowRiskCycle) {
    issues.push({
      code: "self_review_cycle_shallow",
      message: `Plan state for ${ticketId} has a shallow self-review cycle (${shallowRiskCycle.cycle}/${shallowRiskCycle.total}). "risks=" must name at least 2 concrete failure modes, comma-separated.`,
      next_steps: [reviewCycleCommand],
    });
  }
  if (productRepo && cycles.length >= minimumCycles) {
    const lensCoverage = new Set(cycles.flatMap((cycle) => cycle.lensBuckets));
    const requiredCoverage = boundedRepairRequested && boundedRepairEligibilityIssues.length === 0
      ? [
          "contract/state invariants",
          "auth/security/failure modes",
          "tests/operability/performance",
        ]
      : [
          "contract/state invariants",
          "auth/security/failure modes",
          "tests/operability/performance",
          "requirement closure",
        ];
    const missingCoverage = requiredCoverage.filter((bucket) => !lensCoverage.has(bucket));
    if (missingCoverage.length > 0) {
      issues.push({
        code: "self_review_lens_coverage",
        message: `Plan state for ${ticketId} must cover distinct self-review lenses across ${requiredCoverage.join(", ")} before move-review. Missing: ${missingCoverage.join(", ")}.`,
        next_steps: [reviewCycleCommand],
      });
    }
  }
  const lastCycle = cycles[cycles.length - 1];
  if (cycles.length > 0 && lastCycle?.verdict !== "pass") {
    issues.push({
      code: "self_review_final_verdict",
      message: `Plan state for ${ticketId} must end with a passing self-review cycle before move-review.`,
      next_steps: [reviewCycleCommand],
    });
  }
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

function submitRequiresReviewPlanCheck(board, row, ticketId, options = {}) {
  if (!row || row.Status !== STATUS.DOING) {
    return false;
  }
  if (toArray(options.pr).length > 0) {
    return false;
  }
  const existingRefs = board?.pr_index?.[ticketId] || [];
  if (existingRefs.length > 0) {
    return false;
  }
  return true;
}

  return {
    deriveGovernanceReadiness,
    collectStartReadinessBlockers,
    collectSubmitReadinessBlockers,
    assertAlreadyLandedNoPrReconcileReady,
    detectSupersedeLandingBypass,
    assertLandingIntegrity,
    classifyLandingRecord,
    deriveTestingInfrastructureAudit,
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
    collectReviewPlanReadinessIssues,
    formatGovernanceBlockers,
    assertReviewPlanReady,
    submitRequiresReviewPlanCheck,
  };
}

module.exports = createGovernanceValidation;
