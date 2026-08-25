#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const { gitTry } = require("./git-ops.js");
const { allBoardRepoCodes, DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");

// COORD-649: FINDING_STATUS / SCRIPTS_DIR / readLockAgeMs /
// directoryLockMetadataPath were imported here but referenced nowhere in this
// composition root (their consumers require them directly). Dropping the dead
// wiring pays for the review-round wiring added below under the shrink-only
// prodloc budget, which admits no bump.
const {
  STATUS,
  CREATABLE_STATUSES,
  legalStatusSet,
  legalFindingStatusSet,
} = require("./governance-constants.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const identityV2 = require("./identity-v2.js");
const {
  COORD_DIR,
  ROOT_DIR,
  DEFAULT_PATHS,
  GovernanceError,
  state,
  tryReclaimStaleDirectoryLock,
  describeDirectoryLockHolder,
  writeDirectoryLockMetadata,
  readDirectoryLockMetadata,
  detectCheckoutRuntimeRole,
  canonicalAuthorityWriteIssue,
  assertCanonicalAuthorityWriteAllowed,
  withAgentStateLock,
  withCoordStateLock,
  withGovernanceRuntimeLock,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
  isProcessAlive,
} = require("./governance-context.js");
const {
  BoardValidationError,
  syncBoardArtifacts,
  validateBoardState,
} = require("../board/board.js");
const createTokenEconomics = require("./token-economics.js");
const createOtlpExport = require("./otlp-export.js");
const createPlanRecords = require("./plan-records.js");
const createJournal = require("./journal.js");
const createPromptCoverage = require("./prompt-coverage.js");
const createGovernanceSession = require("./governance-session.js");
const createGovernanceBoardState = require("./governance-board-state.js");
const createGovernanceValidation = require("./governance-validation.js");
const createRepoRegistry = require("./repo-registry.js");
const createLifecycleFlags = require("./lifecycle-flags.js");
const createWorktreeOps = require("./worktree-ops.js");
const createGovernanceRepair = require("./governance-repair.js");
const createPrOps = require("./pr-ops.js");
const createRuntimeCleanup = require("./runtime-cleanup.js");
const createGateRuntime = require("./gate-runtime.js");
const gateProcRegistry = require("./gate-proc-registry.js");
const createQuestions = require("./questions.js");
const createPlanCommand = require("./plan-command.js");
const createGates = require("./gates.js");
const createLandingAudit = require("./landing-audit.js");
const createTicketTransitions = require("./ticket-transitions.js");
const createCloseout = require("./closeout.js");
const createDoctorRecovery = require("./doctor-recovery.js");
const createDoctorReport = require("./doctor-report.js");
const {
  buildJournalHealthReport,
  formatJournalHealthWarning,
} = require("./journal-retention.js");
const createTicketGuidance = require("./ticket-guidance.js");
const { fleetGoldenPath } = require("./fleet-golden-path.js");
const createAgentCommands = require("./agent-commands.js");
const createLandingResolution = require("./landing-resolution.js");
const createBoardRebuild = require("./board-rebuild.js");
const createConformanceAttestation = require("./conformance-attestation.js");
const createEnginePin = require("./engine-pin.js");
const { planFiles } = require("./publishability-check.js");
const createConformanceVerbs = require("./conformance-verbs.js");
const createChainTransitionSigner = require("./chain-transition-signer.js");
const createLifecycleHelp = require("./lifecycle-help.js");
const createTicketCommands = require("./ticket-commands.js");
const createTestingInfraAudit = require("./testing-infra-audit.js");
const createSyncProvenance = require("./sync-provenance.js");
const createTicketLockService = require("./ticket-lock-service.js");
const createTicketQueueService = require("./ticket-queue-service.js");
const createGovernancePlanShape = require("./governance-plan-shape.js");
const createLifecycleEvidence = require("./lifecycle-evidence.js");
const { withTemporaryExecutionContext } = require("./lifecycle-execution-context.js");
const createLifecycleJournalQueries = require("./lifecycle-journal-queries.js");
const createLifecycleBoardCommands = require("./lifecycle-board-commands.js");
const createLifecycleTicketHelpers = require("./lifecycle-ticket-helpers.js");
const createLifecycleLockCommands = require("./lifecycle-lock-commands.js");
const createLifecycleTicketAdmin = require("./lifecycle-ticket-admin.js");
const createLifecycleTestingPaths = require("./lifecycle-testing-paths.js");
const createLifecycleRepoXCloseout = require("./lifecycle-repox-closeout.js");
const createLifecycleGateCodeCommands = require("./lifecycle-gate-code-commands.js");
const createLifecycleLandingGovernance = require("./lifecycle-landing-governance.js");
const createLifecycleMaintenanceCommands = require("./lifecycle-maintenance-commands.js");
const createLifecycleBoardValidate = require("./lifecycle-board-validate.js");
const createLifecycleSessionReaping = require("./lifecycle-session-reaping.js");
const createLifecycleReviewState = require("./lifecycle-review-state.js");
const createTestingInfraPaths = require("./testing-infra-paths.js");
const gatePlan = require("./gate-plan.js");
const { signTransition } = require("./chain-migration-signing.js");
const {
  collectAgentFacadeVerbs,
  collectAgentWrapperFlags,
  collectDispatchCommandVerbs,
  collectParseFlagsFlags,
  parseDocumentedAgentVerbs,
  parseDocumentedGovVerbs,
  runVerbParityCheck,
} = require("./verb-parity.js");
const {
  slugify,
  integerOrDefault,
  inferNextRound,
  currentReviewRound,
  todayIso,
  escapeTable,
  escapeRegex,
  shellEscape,
} = require("./lifecycle-utils.js");
const {
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  canonicalSyncablePaths,
  computeSyncDelta,
  ensureParentDir,
  formatJsonFileIssue,
  readCanonicalJsonFile,
  readCanonicalTextFile,
  readJsonArrayFileOrFail,
  readJsonFileState,
  readLastNonEmptyLine,
  safeReadJson,
  writeCanonicalJsonFile,
  writeCanonicalTextFile,
  writeFileAtomicSync,
  writeJsonFile,
} = require("./state-io.js");

const REPO_ROOTS = DEFAULT_PATHS.repoRoots;
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};
const AGENT_SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
const SESSION_FINGERPRINT_ENV_VARS = [
  "TERM_SESSION_ID",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "WT_SESSION",
  "KITTY_WINDOW_ID",
  "TAB_ID",
];
const TESTING_INFRA_LANDING_EVIDENCE_PREFIX = "testing-infra audit:";
const TESTING_INFRA_DESCRIPTION_PATTERN = /\b(test(?:ing)? infrastructure|test[- ]lanes?|default\/full\/extended(?: gates?)?|architecture guards?|timing artifacts?|coverage thresholds?|vitest|msw|pre-push|hook flow|hook installer|gate automation|gate truthfulness|workspace alias resolver|automation contract)\b/i;
// COORD-669: TESTING_INFRA_FILE_PATTERNS moved to testing-infra-paths.js, next
// to isTestingInfrastructureFilePath, the only consumer of the vocabulary.
const PNPM_BUILTIN_COMMANDS = new Set([
  "add",
  "audit",
  "config",
  "dedupe",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "help",
  "import",
  "info",
  "init",
  "install",
  "list",
  "login",
  "logout",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "publish",
  "rebuild",
  "remove",
  "root",
  "setup",
  "store",
  "unlink",
  "update",
  "up",
  "why",
]);
const FEATURE_PROOF_EVIDENCE_PREFIX = "feature-proof audit:";

// COORD-074: status / finding-status enums sourced from the shared
// governance-constants module (byte-identical to the prior inline Sets).
const LEGAL_STATUSES = legalStatusSet();
const LEGAL_FINDING_STATUSES = legalFindingStatusSet();
const FOLLOWUP_RELATIONS = new Set([
  "blocking",
  "related",
  "closeout-blocker",
  "independent",
]);
const WAIVER_CODES = new Set([
  "prompt_coverage",
]);

const {
  collectTicketGovernanceIssueEvents,
  findLatestTicketGovernanceEvent,
  materializeGovernanceEvent,
  recentEvents,
  summarizeGovernanceEvent,
  uniqueStrings,
} = createLifecycleJournalQueries({
  integerOrDefault,
  readGovernanceEventLog: (...a) => readGovernanceEventLog(...a),
  readGovernanceSnapshotArtifact: (...a) => readGovernanceSnapshotArtifact(...a),
});

const {
  buildHistoricalCloseoutStartBlocker,
  buildPostCloseFollowupCommand,
  buildStartPlanBootstrapCommand,
  ticketHasHistoricalCloseoutEvidence,
} = createLifecycleTicketHelpers({
  STATUS,
});

const {
  buildMergedButNotDoneReport,
  buildOrchestratorExceptionSloReport,
  formatBucketCounts,
  formatTemplateFeedbackAlerts,
  orchestratorCycle,
  printCounts,
  showTicket,
  splitGovernanceProvenanceDrift,
} = createLifecycleBoardCommands({
  STATUS,
  buildQuestionQueueReport: (...a) => buildQuestionQueueReport(...a),
  collectTemplateFeedbackAlerts: (...a) => collectTemplateFeedbackAlerts(...a),
  doctor: (...a) => doctor(...a),
  extractDriftMutationStage: (...a) => extractDriftMutationStage(...a),
  fail: (...a) => fail(...a),
  findLockForTicket: (...a) => findLockForTicket(...a),
  getLockFiles: (...a) => getLockFiles(...a),
  getRows: (...a) => getRows(...a),
  getTicketRef: (...a) => getTicketRef(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  readActiveOrchestratorQuestionRows: (...a) => readActiveOrchestratorQuestionRows(...a),
  readBoard: (...a) => readBoard(...a),
  readGovernanceEventLog: (...a) => readGovernanceEventLog(...a),
  readTicketWaiver: (...a) => readTicketWaiver(...a),
  safeReadJson: (...a) => safeReadJson(...a),
});

// COORD-281: the lifecycle CLI presentation + thin command-wrapper surface lives
// in lifecycle-help.js (extracted to hold lifecycle.js under the arch monolith
// budget). Wired here with deferred (...a)=>fn(...a) wrappers for fail /
// ensureCurrentAgentIdentity (function declarations later in this module); state
// is injected BY REFERENCE so __testing.paths overrides propagate. The returned
// functions are destructured back into scope so the `commands` dispatch table and
// the `__testing` facade (buildInitiateSummary) resolve exactly as before.
const {
  printHelp,
  buildInitiateSummary,
  printInitiate,
  recallCommand,
  insightsCommand,
  coverageRollupCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  signJournalCommand,
} = createLifecycleHelp({
  fail: (...args) => fail(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  GovernanceError,
  state,
  COORD_DIR,
});

const {
  applyTicketStatus,
  assignTicketOwner,
  clearTicketOwner,
  ensureLandingIndex,
  ensurePromptIndex,
  ensureReviewFindings,
  ensureWaiverIndex,
  getRows,
  rowsById,
  getTicketRef,
  isLegalStatus,
  readBoard,
  readTicketWaiver,
  runBoardSync,
  setTicketPrRefs,
  writeBoard,
} = createGovernanceBoardState({
  BOARD_RAW_SYMBOL,
  BoardValidationError,
  LEGAL_STATUSES,
  WAIVER_CODES,
  attachTrackedRaw,
  fail: (...args) => fail(...args),
  normalizeBoardIdentityReferences: (...args) => normalizeBoardIdentityReferences(...args),
  readCanonicalTextFile,
  state,
  syncBoardArtifacts,
  writeCanonicalTextFile,
});

const {
  repoPrefixForCode,
  repoPrefixesForCode,
  resolveRepoIntegrationBranch,
  inferRepoCodeFromTicketId,
  resolveRepoCodeForTicket,
  getRepoRoot,
  isRepoBackedCode,
  isProductRepo,
  repoNameForCode,
  repoDisplayNameForCode,
  repoCodeForLockRepoName,
  repoCliAliasesForCode,
  repoCodeForCliRepoArg,
  configuredRepoArgDescription,
} = createRepoRegistry({
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
});

const { parseLifecycleFlags } = createLifecycleFlags({
  fail: (...args) => fail(...args),
  isLegalStatus: (...args) => isLegalStatus(...args),
  LEGAL_FINDING_STATUSES,
});

const {
  resolveCommitishInRepo,
  fetchRepoRef,
  isCommitAncestorOfRef,
  gitPathExistsAtRef,
  auditWorktrees,
  auditCoordWorktrees,
  cleanupWorktree,
  cleanupHelperWorktrees,
  resolveTicketBaseRef,
  gitCommitishExists,
  ensureGitWorktree,
  ensureTicketWorkspace,
  cleanupPreparedTicketWorkspace,
  withPreparedTicketWorkspace,
  auditRepoWorktrees,
  listGitWorktrees,
  resolveCleanupTarget,
  isHelperWorktree,
  gitRefExists,
  gitRemoteBranchExists,
  countCommitsAhead,
  assertCommitAheadCount,
  pushBranchToOrigin,
  preflightPrBranch,
  isInsideGitWorkTree,
  runGit,
  gitOutput,
  defaultWorktreePath,
  coordWorktreesRoot,
  pruneEmptyParents,
  formatMissingStartBaseRefMessage,
  buildDependencyBootstrapGuidance,
  repoBootstrapLabel,
  inferTicketIdFromPath,
  cleanupTicketWorktree,
  cleanupCoordTicketWorktrees,
  cleanupClosedTicketWorkspace, ensureGovernedWorkspaceForTicket,
} = createWorktreeOps({
  fail: (...args) => fail(...args),
  configuredRepoArgDescription: (...args) => configuredRepoArgDescription(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  readBoard: (...args) => readBoard(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  repoCodeForCliRepoArg: (...args) => repoCodeForCliRepoArg(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  // Deferred wrapper: resolveTicketGitContext is a hoisted lifecycle function
  // (depends on the lifecycle-local lock registry) defined far below this call.
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
});

const {
  classifyQuestionOperationalType,
  buildQuestionQueueReport,
  parseTemplateFeedbackRowsFromText,
  readTemplateFeedbackRows,
  ticketNeedsTemplateFeedback,
  latestDoneTimestampByTicket,
  collectTemplateFeedbackAlerts,
  collectStaleTemplateFeedbackErrors,
  isStaleTicketLock,
  isRecoverableGovernanceDriftPath,
  extractTicketIdsFromGovernanceIssues,
  buildDoctorResolutionGuidance,
} = createGovernanceRepair({
  getRows: (...args) => getRows(...args),
  readCanonicalTextFile,
});

const {
  classifyQuestionSeverity,
  classifyQuestionAgingBucket,
  parseQuestionRow,
  readQuestionRows,
  readOrchestratorQuestionRows,
  isActiveOrchestratorQuestionRow,
  readActiveOrchestratorQuestionRows,
  extractDriftMutationStage,
  buildExplainQuestionsGuidance,
  hasResolvedGovernanceRepairQuestion,
  logQuestion,
  appendQuestionRow,
  buildQuestionRow,
  appendQuestionRowText,
  removeQuestionRowText,
} = createQuestions({
  fail: (...args) => fail(...args),
  readCanonicalTextFile,
  writeCanonicalTextFile,
  classifyQuestionOperationalType: (...args) => classifyQuestionOperationalType(...args),
  uniqueStrings: (...args) => uniqueStrings(...args),
  todayIso,
  escapeTable,
});

const {
  runtimeLockStatus,
  breakRuntimeLock,
  detectRollbackDrift,
  collectCleanRuntimeTargets,
  cleanRuntime,
} = createRuntimeCleanup({
  fail: (...args) => fail(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  relativeCoordPath: (...args) => relativeCoordPath(...args),
});

const {
  readPackageScripts,
  resolveGateScript,
  resolveGateInvocation,
  resolveGateArtifactDir,
  detectGatePackageManager,
  runCleanCheckoutGate,
} = createGateRuntime({
  fail: (...args) => fail(...args),
  configuredRepoArgDescription: (...args) => configuredRepoArgDescription(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  repoCodeForCliRepoArg: (...args) => repoCodeForCliRepoArg(...args),
  repoDisplayNameForCode: (...args) => repoDisplayNameForCode(...args),
  readJsonFileFromRef: (...args) => readJsonFileFromRef(...args),
});

const { prView, prCreate, prMerge } = createPrOps({
  fail: (...args) => fail(...args),
  assertCommittedReviewState: (...args) => assertCommittedReviewState(...args), assertReviewPlanReady: (...args) => assertReviewPlanReady(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args), formatDependencyCycleList: (...args) => formatDependencyCycleList(...args),
  formatTransitiveBlockerDetails: (...args) => formatTransitiveBlockerDetails(...args), ensureDoingTicketLockIntegrity: (...args) => ensureDoingTicketLockIntegrity(...args), ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  ghPrListByBranch: (...args) => ghPrListByBranch(...args),
  ghPrView: (...args) => ghPrView(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  isGitHubPrUrl: (...args) => isGitHubPrUrl(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  mergePrUrl: (...args) => mergePrUrl(...args),
  mergeUniqueRefs: (...args) => mergeUniqueRefs(...args),
  preflightPrBranch: (...args) => preflightPrBranch(...args),
  readBoard: (...args) => readBoard(...args),
  recordGovernanceExternalSideEffect: (...args) => recordGovernanceExternalSideEffect(...args),
  resolvePrUrlForTicket: (...args) => resolvePrUrlForTicket(...args),
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args), rowsById: (...args) => rowsById(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  runGh: (...args) => runGh(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  writeBoard: (...args) => writeBoard(...args),
});

const {
  isTicketAtOrAfter,
  parseTicketParts,
  requiresLandingGovernance,
  resolveRepoThresholdTicket,
} = createLifecycleLandingGovernance({
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
});

const { runBoardValidate } = createLifecycleBoardValidate({
  BoardValidationError,
  fail: (...args) => fail(...args),
  state,
  validateBoardState,
});

// COORD-594: agent-session reaping/release + recency ordering live in
// lifecycle-session-reaping.js (extraction under the no-grandfather prodloc
// policy). Collaborators built by the governance-session factory BELOW are
// injected as deferred wrappers, so ordering here is irrelevant; the names are
// re-destructured into lifecycle scope so every existing call site resolves
// unchanged.
const {
  compareSessionsMostRecentFirst,
  reapIdleAutoClaimedProviderStubs,
  releaseTerminalTicketSession,
} = createLifecycleSessionReaping({
  STATUS,
  findDoingTicketForOwner: (...args) => findDoingTicketForOwner(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  listIdleActiveAgentSessions: (...args) => listIdleActiveAgentSessions(...args),
  normalizeOwnerValue: (...args) => normalizeOwnerValue(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  readAgentsRegistry: (...args) => readAgentsRegistry(...args),
  readBoard: (...args) => readBoard(...args),
  resolveEffectiveThreadId: (...args) => resolveEffectiveThreadId(...args),
  state,
  withAgentStateLock: (...args) => withAgentStateLock(...args),
  writeJsonFile: (...args) => writeJsonFile(...args),
});

const {
  PROVIDER_REGISTRY,
  allocateAgentSimpleId,
  allocateLiveSessionId,
  assertRuntimeProviderMatchesAgent,
  assertRegisteredBoundOwner,
  assertTicketMutationOwnership,
  assertTicketRepairOwnership,
  buildActiveSameOwnerOtherThreadMessage,
  buildDefaultAgentHandle,
  buildSessionId,
  canOwnerHoldConcurrentDoing,
  canonicalizeOwnerOrFail,
  collectReferencedAgentIdNumbers,
  currentRuntimeThreadId,
  defaultAgentRegistry,
  defaultHostLabel,
  describeTicketMutationOwnershipIssue,
  detectActiveSameOwnerOtherThread,
  detectColocatedForeignSessions,
  buildColocatedForeignSessionMessage,
  detectRuntimeProvider,
  ensureAgentFiles,
  ensureCurrentAgentIdentity,
  ensureTicketMutationOwnership,
  findActiveProviderSessions,
  findActiveSessionForHandle,
  findDoingTicketForOwner,
  formatAgentSimpleId,
  formatGovernanceJournalUninitializedMessage,
  getOrCreateSessionToken,
  heartbeatAgeMsForSession,
  isCompleteLockPayload,
  isDoingStatus,
  isRegisteredAgentHandle,
  maybeCanonicalOwner,
  normalizeAgentSessions,
  normalizeBoardIdentityReferences,
  normalizeLockIdentityReferences,
  normalizeOwnerValue,
  ownerMatches,
  parseAgentSimpleIdNumber,
  providerConfig,
  providerThreadEnvNames,
  providerThreadIdValue,
  readAgentSessions,
  readAgentsRegistry,
  rebindTicketLock,
  resolveAgentIdentifier,
  resolveEffectiveThreadId,
  resolveLegacyAgentsCompatibilityPath,
  resolveOrCreateEffectiveThreadId,
  resolveOwnerIdentity,
  runtimeHasStableSessionIdentity,
  runtimeSessionFingerprint,
  sessionTokenPath,
  shouldUseLegacyAgentSessionsCompatibility,
  summarizeRecentOwnerLeaseEvidence,
  touchActiveSession,
  writeAgentRegistryFile,
  writeLock,
} = createGovernanceSession({
  AGENT_SESSION_IDLE_MS,
  COORD_DIR,
  GovernanceError,
  SESSION_FINGERPRINT_ENV_VARS,
  compareSessionsMostRecentFirst,
  ensureParentDir,
  ensureWaiverIndex,
  fail,
  findLatestTicketGovernanceEvent: (...args) => findLatestTicketGovernanceEvent(...args),
  formatJsonFileIssue,
  getRows,
  getTicketRef,
  identityV2,
  isRepoBackedCode,
  moveFileIfNeeded,
  readJsonArrayFileOrFail,
  readJsonFileState,
  reapIdleAutoClaimedProviderStubs: (...args) => reapIdleAutoClaimedProviderStubs(...args),
  repoNameForCode,
  resolveLockHead: (...args) => resolveLockHead(...args),
  safeReadJson,
  state,
  summarizeGovernanceEvent: (...args) => summarizeGovernanceEvent(...args),
  withAgentStateLock,
  writeJsonFile,
});

const createFollowups = require("./followups.js");
const {
  buildDependencyRepairNextSteps,
  normalizeFollowupRelation,
  followupRelationToExceptionType,
  applyFollowupRelation,
  nextTicketId,
  printNextId,
  resolveFollowupPromptPath,
  allowsFollowupDependencyReadinessException,
  findOutstandingCloseoutBlockerFollowups,
} = createFollowups({
  fail,
  getRows,
  readBoard,
  uniqueStrings,
  isDoingStatus,
  // COORD-279 (item 3): deferred accessor — `journalHistoricalTicketIds` is a
  // const destructured from createJournal() further below, so reference it
  // lazily through a wrapper that is only invoked at id-allocation time (after
  // module load completes), not during this factory call.
  historicalTicketIds: () => journalHistoricalTicketIds(),
});



const {
  mergedPrAffiliatesWithTicket,
  refsContainMergedPrForTicket,
  mergeUniqueRefs,
  verifyPrEvidence,
  isGitHubPrUrl,
  ghPrIsMerged,
  isTransientGhError,
  sleepSyncMs,
  setRunGhForTesting,
  resetRunGhForTesting,
  setSleepSyncForTesting,
  resetSleepSyncForTesting,
  ghPrView,
  isCheckedOutLocalBranchDeleteFailure,
  shouldIgnoreMergeFailureAfterSuccessfulMerge,
  ghPrListByBranch,
  mergePrUrl,
  buildLandCloseoutAnswer,
  runGh,
} = require("./landing-gh.js");

// COORD-088 (Wave 4 slice 4): landing COMMIT-RESOLUTION surface (git-ancestry /
// base-ref / source-commit resolution) extracted from lifecycle.js. Wired AFTER
// the git-ops factory (resolveCommitishInRepo / fetchRepoRef /
// isCommitAncestorOfRef) and the repo registry (getRepoRoot / isRepoBackedCode)
// are live, and AFTER landing-gh.js (ghPrView / mergeUniqueRefs / toArray are
// injected, not re-implemented), but BEFORE createLandingAudit below — the
// audit factory consumes resolveLandingBaseRef / resolveLandingCommitSha /
// resolveSourceCommitSha / resolveFulfilledByLandingCommit / extractCommitShas.
// resolveTicketGitContext / resolveLockHead are hoisted lifecycle functions
// injected as deferred wrappers so wiring order never matters at call time.
const {
  extractCommitShas,
  refreshLandingBaseRef,
  resolveLandingBaseRef,
  resolvePrLandingBaseRef,
  pickBestLandingCommit,
  resolveSourceCommitSha,
  resolveFulfilledByLandingCommit,
  resolveLandingCommitSha,
} = createLandingResolution({
  fail: (...args) => fail(...args),
  fs,
  DEFAULT_INTEGRATION_BRANCH,
  resolveCommitishInRepo,
  fetchRepoRef,
  isCommitAncestorOfRef,
  getRepoRoot,
  isRepoBackedCode,
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
  resolveLockHead: (...args) => resolveLockHead(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  ghPrView,
  mergeUniqueRefs,
  toArray,
});

// COORD-295: the governance PLAN-SHAPE service (normalization + scaffold-plan
// construction), extracted from lifecycle.js into governance-plan-shape.js
// (lifecycle decomposition slice #4 per the COORD-291 boundary contract). Wired
// EARLY — before createGovernanceValidation (consumes normalizeGovernancePlanShape)
// and createPlanRecords (consumes all eight shape functions) — so the
// re-destructured returns are in scope when those factories inject them directly.
// Primitives live at this point (state, REPO_INTEGRATION_BRANCHES,
// DEFAULT_INTEGRATION_BRANCH, isRepoBackedCode, repoNameForCode, toArray, the
// state-io canonical readers/writers) are injected BY REFERENCE; the plan-record IO
// collaborators wired LATER by createPlanRecords (readPlanRecord / extractPlanBlock /
// renderPlanRecordBlock / appendPlanBlock / syncPlanRecordFromBlock / planRecordPath /
// writePlanCompatibilityBlockFromRecord) are injected as DEFERRED (...a)=>fn(...a)
// wrappers so factory wiring order never constrains call-time resolution. Plan
// JSON/markdown round-trips stay byte-stable; lifecycle.js only wires the service.
const {
  scaffoldSelfReviewCycle,
  buildDefaultGovernancePlan,
  normalizeGovernancePlanShape,
  formatGovernancePlanEntry,
  formatGovernanceReviewProfileEntry,
  formatGovernanceRepairEntry,
  parseGovernancePlanEntries,
  buildScaffoldPlanRecord,
  ensurePlanStub,
} = createGovernancePlanShape({
  state,
  REPO_INTEGRATION_BRANCHES,
  DEFAULT_INTEGRATION_BRANCH,
  isRepoBackedCode,
  repoNameForCode,
  toArray,
  readCanonicalTextFile,
  writeCanonicalTextFile,
  writeCanonicalJsonFile,
  readPlanRecord: (...a) => readPlanRecord(...a),
  extractPlanBlock: (...a) => extractPlanBlock(...a),
  renderPlanRecordBlock: (...a) => renderPlanRecordBlock(...a),
  appendPlanBlock: (...a) => appendPlanBlock(...a),
  syncPlanRecordFromBlock: (...a) => syncPlanRecordFromBlock(...a),
  planRecordPath: (...a) => planRecordPath(...a),
  writePlanCompatibilityBlockFromRecord: (...a) => writePlanCompatibilityBlockFromRecord(...a),
});

// COORD-296: the lifecycle PR / EVIDENCE-RESOLUTION service (ticket git-context +
// closeout PR-ref resolution), extracted from lifecycle.js into lifecycle-evidence.js
// (lifecycle decomposition slice #5 per the COORD-291 boundary contract — the LAST
// slice before the COORD-297 facade-shrink). Wired here AFTER the repo registry
// (isRepoBackedCode / getRepoRoot), worktree-ops (listGitWorktrees /
// inferTicketIdFromPath) and landing-gh (isGitHubPrUrl / ghPrListByBranch /
// verifyPrEvidence / mergeUniqueRefs) are live, so those collaborators inject BY
// REFERENCE; the lifecycle-local hoisted helpers findLockForTicket / fail are
// injected as DEFERRED (...a)=>fn(...a) wrappers so wiring order never constrains
// call-time resolution. PR/no-PR evidence behavior is byte-identical and the
// landing-resolution / landing-audit module boundaries stay SEPARATE — this slice
// sits alongside them, it does not absorb them. The review-state helpers
// readCommitSubject / commitSubjectAffiliatesWithTicket stay in lifecycle.js
// (COORD-088 ownership re-confirmed: they serve assertCommittedReviewState, not
// PR/evidence resolution). lifecycle.js re-destructures the three returns so the
// `commands` dispatch and the deferred wrappers other factories inject still resolve.
const {
  resolveTicketGitContext,
  resolvePrUrlForTicket,
  resolveLifecyclePrRefs,
} = createLifecycleEvidence({
  isRepoBackedCode,
  getRepoRoot,
  listGitWorktrees,
  inferTicketIdFromPath,
  isGitHubPrUrl,
  ghPrListByBranch,
  verifyPrEvidence,
  mergeUniqueRefs,
  toArray,
  findLockForTicket: (...a) => findLockForTicket(...a),
  fail: (...a) => fail(...a),
});

const {
  assertAlreadyLandedNoPrReconcileReady,
  assertLandingIntegrity,
  assertReviewPlanReady,
  assertStartPlanReady,
  classifyLandingRecord,
  collectReviewPlanReadinessIssues,
  collectStartReadinessAdvisories,
  collectStartReadinessBlockers,
  collectSubmitReadinessBlockers,
  deriveFeatureProofAudit,
  deriveGovernanceReadiness,
  deriveTestingInfrastructureAudit,
  evaluateReadiness,
  fieldHasMeaningfulValue,
  formatDependencyCycleList,
  formatGovernanceBlockers,
  formatTransitiveBlockerDetails,
  gitRefContainsLiteral,
  hasOnlyScaffoldSelfReviewCycles,
  inferRequiredReviewRound,
  isLightLaneEligible,
  isProceduralDocPath,
  resolveTicketLightLane,
  isMeaningfulText,
  normalizeFeatureProofEntryForTicket,
  normalizeSelfReviewCycleLine,
  parseFeatureProofEntry,
  parseSelfReviewCycles,
  readTextFileFromRef,
  replaceSelfReviewCycles,
  requiresFeatureProofGovernance,
  splitDependsOn,
  submitRequiresReviewPlanCheck,
  ticketRequiresBaseline,
  ticketRequiresTraceability,
  validateFeatureProofEntry,
  validateRequirementClosureEntry,
  detectSupersedeLandingBypass,
} = createGovernanceValidation({
  COORD_DIR,
  DEFAULT_PATHS,
  FEATURE_PROOF_EVIDENCE_PREFIX,
  GovernanceError,
  PNPM_BUILTIN_COMMANDS,
  REPO_INTEGRATION_BRANCHES,
  REPO_ROOTS,
  TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
  allowsFollowupDependencyReadinessException: (...args) => allowsFollowupDependencyReadinessException(...args),
  buildDependencyRepairNextSteps: (...args) => buildDependencyRepairNextSteps(...args),
  buildHistoricalCloseoutStartBlocker: (...args) => buildHistoricalCloseoutStartBlocker(...args),
  buildPromptWaiverCommand: (...args) => buildPromptWaiverCommand(...args),
  buildStartPlanBootstrapCommand,
  commitSubjectAffiliatesWithTicket: (...args) => commitSubjectAffiliatesWithTicket(...args),
  // COORD-070: collectLandingAuditCandidates moved to landing-audit.js; injected
  // back (deferred) for classifyLandingRecord, which stays in this module.
  collectLandingAuditCandidates: (...args) => collectLandingAuditCandidates(...args),
  collectTicketGovernanceIssueEvents: (...args) => collectTicketGovernanceIssueEvents(...args),
  describeTicketMutationOwnershipIssue: (...args) => describeTicketMutationOwnershipIssue(...args),
  effectiveTierMinimum: (...args) => effectiveTierMinimum(...args),
  ensureLandingRecord: (...args) => ensureLandingRecord(...args),
  escapeRegex: (...args) => escapeRegex(...args),
  extractFileReferencesFromCommands: (...args) => extractFileReferencesFromCommands(...args),
  extractPackageScriptsFromCommands: (...args) => extractPackageScriptsFromCommands(...args),
  fail: (...args) => fail(...args),
  getRepoRoot,
  getRows,
  rowsById,
  ghPrView,
  gitPathExistsAtRef,
  hasPromptWaiver: (...args) => hasPromptWaiver(...args),
  isCommitAncestorOfRef,
  isGitHubPrUrl,
  isRepoBackedCode,
  isTestingInfrastructureFilePath: (...args) => isTestingInfrastructureFilePath(...args),
  isTestingInfrastructureTicket: (...args) => isTestingInfrastructureTicket(...args),
  isTicketAtOrAfter: (...args) => isTicketAtOrAfter(...args),
  listCommitTouchedPaths: (...args) => listCommitTouchedPaths(...args),
  mergeUniqueRefs,
  mergedPrAffiliatesWithTicket,
  normalizeGovernancePlanShape,
  pickBestLandingCommit,
  readBoard,
  readJsonFileFromRef: (...args) => readJsonFileFromRef(...args),
  readLatestPlanBlock: (...args) => readLatestPlanBlock(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  readPlanState: (...args) => readPlanState(...args),
  refreshLandingBaseRef: (...args) => refreshLandingBaseRef(...args),
  repoDisplayNameForCode,
  repoNameForCode,
  repoPrefixesForCode: (...args) => repoPrefixesForCode(...args),
  resolveCommitishInRepo,
  resolveLandingBaseRef,
  resolveLandingCommitSha: (...args) => resolveLandingCommitSha(...args),
  resolveRepoThresholdTicket,
  resolveRepoCodeForTicket,
  resolveSourceCommitSha,
  resolveTicketTier: (...args) => resolveTicketTier(...args),
  state,
  splitPlanPathValues: (...args) => splitPlanPathValues(...args),
  normalizeTestingInfraAuditPath: (...args) => normalizeTestingInfraAuditPath(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
  hasResolvedGovernanceRepairQuestion: (...args) => hasResolvedGovernanceRepairQuestion(...args),
  integerOrDefault,
  ticketPromptRelPathExists: (...args) => ticketPromptRelPathExists(...args),
  defaultTicketPromptRelPath: (...args) => defaultTicketPromptRelPath(...args),
  toArray,
});

// COORD-070 (Wave 3, slice B): landing provenance / audit surface. Wired AFTER
// createGovernanceValidation so the injected classify/derive/requires-landing
// deps are live. The audit-report cluster, the testing-infra / feature-proof
// landing audits, and the landing-RECORD writers were consolidated here out of
// governance-validation.js + lifecycle.js. Mutual deps are bridged with deferred
// wrappers: this module injects classifyLandingRecord / deriveTestingInfrastructure-
// Audit / deriveFeatureProofAudit / requiresLandingGovernance from validation, and
// validation injects collectLandingAuditCandidates back for classifyLandingRecord.
// verifyPrEvidence stays in landing-gh.js (GH-specific) and is NOT moved.
const {
  collectLandingAuditCandidates,
  summarizeLandingAuditEntries,
  collectLandingAuditReport,
  applyLandingAuditBackfill,
  formatLandingAuditSummary,
  ensureTestingInfrastructureLandingAudit,
  ensureFeatureProofLandingAudit,
  ensureLandingRecord,
  persistMergedPrLandingSnapshot,
} = createLandingAudit({
  STATUS,
  REPO_ROOTS,
  REPO_INTEGRATION_BRANCHES,
  TESTING_INFRA_LANDING_EVIDENCE_PREFIX,
  FEATURE_PROOF_EVIDENCE_PREFIX,
  GovernanceError,
  fail: (...args) => fail(...args),
  toArray,
  mergeUniqueRefs,
  extractCommitShas: (...args) => extractCommitShas(...args),
  isRepoBackedCode,
  isGitHubPrUrl,
  getRepoRoot,
  repoNameForCode,
  resolveCommitishInRepo,
  resolveLandingBaseRef: (...args) => resolveLandingBaseRef(...args),
  resolveLandingCommitSha: (...args) => resolveLandingCommitSha(...args),
  resolveSourceCommitSha: (...args) => resolveSourceCommitSha(...args),
  resolveFulfilledByLandingCommit: (...args) => resolveFulfilledByLandingCommit(...args),
  getRows,
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  ensureLandingIndex: (...args) => ensureLandingIndex(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  ghPrView,
  classifyLandingRecord: (...args) => classifyLandingRecord(...args),
  deriveTestingInfrastructureAudit: (...args) => deriveTestingInfrastructureAudit(...args),
  deriveFeatureProofAudit: (...args) => deriveFeatureProofAudit(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
});

const {
  legacyPlanRecordDefaults,
  normalizeLegacyPlanRecordShape,
  planRecordPath,
  resolvePlanRecordReadPath,
  readPlanRecordSchema,
  stripMarkdownCodeTicks,
  parsePlanBlockToRecord,
  normalizePlanMarkdownHeading,
  pushPlanListSection,
  formatSelfReviewCycleForPlanRecord,
  renderPlanRecordBlock,
  appendPlanBlock,
  assertValidPlanRecord,
  readPlanRecord,
  repairPlanRecord,
  synthesizeHistoricalPlanRecord,
  syncPlanRecordFromBlock,
  readPlanState,
  ensurePlanBlockForUpdate,
  ensurePlanRecordForUpdate,
  appendUniquePlanRecordValue,
  readPlanRecordScaffoldPlaceholders,
  planRecordFieldHasOnlyScaffoldValues,
  planRecordFieldIsStartScaffoldOrResolved,
  isScaffoldWorktreeIntendedFile,
  readRecordedIntendedFilesScaffoldSeed,
  planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
  writePlanRecordScaffoldPlaceholders,
  stripPlanScaffoldValues,
  planRecordHasOnlyScaffoldSelfReviewCycles,
  planRecordHasOnlyMalformedSelfReviewCycles,
  normalizePlanRecordSelfReviewCycle,
  applyPlanUpdateOptionsToRecord,
  writePlanCompatibilityBlockFromRecord,
  updateCanonicalPlanState,
  materializePlanBlockFromRecord,
  extractPlanBlock,
  extractPlanBlockEntries,
  extractPlanBlocks,
  upsertListItem,
  replaceScalarField,
  replacePlanBlock,
  readLatestPlanBlock,
  readPlanListField,
  readPlanScalarField,
  isPlanSectionBoundary,
  normalizePlanPathValue,
  planTargetsCoordOnlyArtifacts,
} = createPlanRecords({
  fail,
  resolveRepoCodeForTicket,
  buildDefaultGovernancePlan,
  normalizeGovernancePlanShape,
  formatGovernancePlanEntry,
  formatGovernanceReviewProfileEntry,
  formatGovernanceRepairEntry,
  parseGovernancePlanEntries,
  scaffoldSelfReviewCycle,
  resolveRepoIntegrationBranch,
  isTestingInfrastructureTicket: (...args) => isTestingInfrastructureTicket(...args),
  todayIso,
  escapeTable,
  toArray,
  normalizeSelfReviewCycleLine,
  parseSelfReviewCycles,
  validateRequirementClosureEntry,
  validateFeatureProofEntry,
  normalizeFeatureProofEntryForTicket,
  isMeaningfulText,
  escapeRegex,
  integerOrDefault,
  readBoard,
  getTicketRef,
  inferRequiredReviewRound,
  normalizeOwnerValue,
  repoNameForCode,
  ensurePlanStub,
  mergeUniqueRefs,
  isRepoBackedCode,
});

const {
  assertPromptPreconditionsResolve,
  buildPromptWaiverCommand,
  classifyPreconditionArtifact,
  defaultTicketPromptRelPath,
  ensurePromptCoverageOrDiscover,
  hasPromptWaiver,
  parsePromptLikelyFiles,
  parsePromptPreconditions,
  registerPrompt,
  seedStartIntendedFilesFromPrompt,
  ticketPromptRelPathExists,
  verifyPromptPreconditions,
} = createPromptCoverage({
  ROOT_DIR,
  // COORD-424: getPromptsDir resolves from the live (overridable) state path so
  // __testing.paths can sandbox prompt discovery — making the COORD-023 discover
  // test self-contained (it then passes in release cuts that strip
  // coord/prompts/tickets/*.md). Production value is identical: state.PROMPTS_DIR
  // defaults to COORD_DIR/prompts. Kept on the COORD_DIR line so lifecycle.js stays
  // within its composition-root LOC high-water budget (net-zero added lines).
  COORD_DIR, getPromptsDir: () => state.PROMPTS_DIR,
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  fail,
  getRepoRoot,
  getTicketRef,
  gitCommitishExists,
  gitPathExistsAtRef,
  gitRefContainsLiteral,
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  isRepoBackedCode,
  planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
  planRecordPath,
  readBoard,
  readPlanRecord,
  repairPlanRecord,
  readTicketWaiver,
  repoDisplayNameForCode,
  resolveTicketBaseRef,
  runBoardSync,
  uniqueStrings,
  withCoordStateLock,
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  writeBoard,
  writeCanonicalJsonFile,
  writePlanCompatibilityBlockFromRecord,
  writePlanRecordScaffoldPlaceholders,
});


// COORD-086 (Wave 4 slice 2): the OPERATOR-GUIDANCE surface —
// buildTicketNextCommands (per-status "what to run next" planner), explainTicket
// (read-only ticket explanation report) and runTicketCycle (recommended
// planner/worker/reviewer/closer cycle) — lives in ticket-guidance.js. These
// read board / lock / plan / readiness state and emit guidance JSON; they never
// mutate governance state. Every cross-module primitive is injected as a
// deferred `(...args) => fn(...args)` wrapper so hoisting / wiring order does
// not matter at call time (several deps — collectStartReadinessBlockers,
// deriveGovernanceReadiness, etc. — are produced by factories wired earlier,
// and buildPostCloseFollowupCommand stays owned here and is injected back).
// buildTicketNextCommands / explainTicket / runTicketCycle are re-destructured
// back into lifecycle scope because the cli.js dispatch, module.exports and the
// __testing facade (consumed by cli.js / governance-mcp) still reference them.
const {
  buildTicketNextCommands,
  explainTicket,
  runTicketCycle,
} = createTicketGuidance({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  rowsById: (...args) => rowsById(...args),
  readPlanState: (...args) => readPlanState(...args),
  readTicketWaiver: (...args) => readTicketWaiver(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  collectStartReadinessBlockers: (...args) => collectStartReadinessBlockers(...args),
  collectSubmitReadinessBlockers: (...args) => collectSubmitReadinessBlockers(...args),
  deriveGovernanceReadiness: (...args) => deriveGovernanceReadiness(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  resolveOwnerIdentity: (...args) => resolveOwnerIdentity(...args),
  detectGovernanceProvenanceDrift: (...args) => detectGovernanceProvenanceDrift(...args),
  splitGovernanceProvenanceDrift: (...args) => splitGovernanceProvenanceDrift(...args),
  buildQuestionQueueReport: (...args) => buildQuestionQueueReport(...args),
  readActiveOrchestratorQuestionRows: (...args) => readActiveOrchestratorQuestionRows(...args),
  buildExplainQuestionsGuidance: (...args) => buildExplainQuestionsGuidance(...args),
  collectTicketGovernanceIssueEvents: (...args) => collectTicketGovernanceIssueEvents(...args),
  findLatestTicketGovernanceEvent: (...args) => findLatestTicketGovernanceEvent(...args),
  summarizeGovernanceEvent: (...args) => summarizeGovernanceEvent(...args),
  buildPostCloseFollowupCommand: (...args) => buildPostCloseFollowupCommand(...args),
  shellEscape: (...args) => shellEscape(...args),
});

// COORD-087 (Wave 4 slice 3): the AGENT-COMMAND / claim-orchestration surface —
// the agents list/register/enable/disable verbs, agentid resolve+format, the
// claim / claim-ticket / claim-agent / claim-agent-session cluster, resume,
// release, rebind, the human-admin override resolver, the cwd-claim hazard
// detector and the agent-status report builder — lives in agent-commands.js.
// governance-session.js stays the lower-level SESSION ENGINE; agent-commands.js
// is the command layer above it and INJECTS the session/registry readers+
// writers, identity resolution, owner-lease metadata, board-state readers, the
// mutation/lock wrappers and the journal appender. findLockForTicket /
// getLockFiles are defined later in this file, so they (and other cross-module
// primitives) are injected as deferred `(...args) => fn(...args)` wrappers; the
// returned commands are re-destructured back into lifecycle scope because the
// cli.js dispatch, module.exports and the __testing facade still reference them.
const {
  agentsCommand,
  listAgents,
  printCurrentAgentId,
  resolveCurrentAgentId,
  formatCurrentAgentIdPayload,
  buildUnclaimedAgentIdPayload,
  isNoActiveClaimedSessionError,
  registerAgent,
  claim,
  resumeTicket,
  resolveHumanAdminOverride,
  claimPayloadFromCurrentIdentity,
  claimTicket,
  setAgentRegistryStatus,
  claimAgent,
  detectCwdTicketClaimHazard,
  claimAgentSession,
  releaseAgent,
  rebindAgent,
  showAgentStatus,
  buildAgentStatusPayload,
} = createAgentCommands({
  fail: (...args) => fail(...args),
  state,
  COORD_DIR,
  identityV2,
  PROVIDER_REGISTRY,
  STATUS,
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  withAgentStateLock: (...args) => withAgentStateLock(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  appendGovernanceEvent: (...args) => appendGovernanceEvent(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  // COORD-680: ensureGovernedWorkspaceForTicket is deferred like every sibling
  // helper. A bare shorthand binds the value at object-construction time, so a
  // wiring/hoisting change turns it into `undefined` and the failure surfaces
  // only at the call site of whichever verb reaches it first. Kept on one line
  // to hold the composition-root LOC budget.
  findLockForTicket: (...args) => findLockForTicket(...args), ensureGovernedWorkspaceForTicket: (...args) => ensureGovernedWorkspaceForTicket(...args),
  getLockFiles: (...args) => getLockFiles(...args),
  rebindTicketLock: (...args) => rebindTicketLock(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  buildActiveSameOwnerOtherThreadMessage: (...args) => buildActiveSameOwnerOtherThreadMessage(...args),
  detectColocatedForeignSessions: (...args) => detectColocatedForeignSessions(...args),
  buildColocatedForeignSessionMessage: (...args) => buildColocatedForeignSessionMessage(...args),
  recordGovernanceCollision: (...args) => recordGovernanceCollision(...args),
  normalizeLockIdentityReferences: (...args) => normalizeLockIdentityReferences(...args),
  readAgentsRegistry: (...args) => readAgentsRegistry(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  writeAgentRegistryFile: (...args) => writeAgentRegistryFile(...args),
  writeJsonFile: (...args) => writeJsonFile(...args),
  resolveAgentIdentifier: (...args) => resolveAgentIdentifier(...args),
  allocateAgentSimpleId: (...args) => allocateAgentSimpleId(...args),
  buildDefaultAgentHandle: (...args) => buildDefaultAgentHandle(...args),
  buildSessionId: (...args) => buildSessionId(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  detectRuntimeProvider: (...args) => detectRuntimeProvider(...args),
  providerConfig: (...args) => providerConfig(...args),
  assertRuntimeProviderMatchesAgent: (...args) => assertRuntimeProviderMatchesAgent(...args),
  runtimeHasStableSessionIdentity: (...args) => runtimeHasStableSessionIdentity(...args),
  findActiveProviderSessions: (...args) => findActiveProviderSessions(...args),
  defaultHostLabel: (...args) => defaultHostLabel(...args),
  currentRuntimeThreadId: (...args) => currentRuntimeThreadId(...args),
  resolveEffectiveThreadId: (...args) => resolveEffectiveThreadId(...args),
  resolveOrCreateEffectiveThreadId: (...args) => resolveOrCreateEffectiveThreadId(...args),
  summarizeBusyActiveAgents: (...args) => summarizeBusyActiveAgents(...args),
  listIdleActiveAgentSessions: (...args) => listIdleActiveAgentSessions(...args),
  buildReleaseCandidates: (...args) => buildReleaseCandidates(...args),
  safeReadJson: (...args) => safeReadJson(...args),
  parseLifecycleFlags: (...args) => parseLifecycleFlags(...args),
});


// COORD-088: extractCommitShas + refreshLandingBaseRef moved to
// landing-resolution.js (injected via the createLandingResolution factory).

function readCommitSubject(repoRoot, commitish) {
  const commitSha = resolveCommitishInRepo(repoRoot, commitish);
  if (!commitSha) {
    return null;
  }
  const result = gitTry(repoRoot, ["log", "-1", "--format=%s", commitSha]);
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "").trim() || null;
}

function commitSubjectAffiliatesWithTicket(repoRoot, commitish, ticketId) {
  const subject = readCommitSubject(repoRoot, commitish);
  const normalizedTicketId = String(ticketId || "").trim().toLowerCase();
  if (!subject || !normalizedTicketId) {
    return false;
  }
  return subject.toLowerCase().includes(normalizedTicketId);
}

// COORD-088: resolveLandingBaseRef / resolvePrLandingBaseRef / pickBestLanding-
// Commit / resolveSourceCommitSha / resolveFulfilledByLandingCommit /
// resolveLandingCommitSha moved to landing-resolution.js (injected via the
// createLandingResolution factory above).

const {
  auditLandings,
  backfillPlanRecords,
} = createLifecycleMaintenanceCommands({
  REPO_ROOTS,
  STATUS,
  allBoardRepoCodes,
  applyLandingAuditBackfill: (...args) => applyLandingAuditBackfill(...args),
  collectLandingAuditReport: (...args) => collectLandingAuditReport(...args),
  fail: (...args) => fail(...args),
  getRows: (...args) => getRows(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  integerOrDefault,
  isTicketAtOrAfter: (...args) => isTicketAtOrAfter(...args),
  planRecordPath: (...args) => planRecordPath(...args),
  readBoard: (...args) => readBoard(...args),
  readLatestPlanBlock: (...args) => readLatestPlanBlock(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  resolveRepoThresholdTicket: (...args) => resolveRepoThresholdTicket(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  syncPlanRecordFromBlock: (...args) => syncPlanRecordFromBlock(...args),
  synthesizeHistoricalPlanRecord: (...args) => synthesizeHistoricalPlanRecord(...args),
  toArray: (...args) => toArray(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  writeBoard: (...args) => writeBoard(...args),
  writeCanonicalJsonFile: (...args) => writeCanonicalJsonFile(...args),
});

// COORD-669: the testing-infrastructure path/token primitives
// (tokenizeShellWords, splitPlanPathValues, isTestingInfrastructureFilePath,
// extractFileReferencesFromCommands) moved to testing-infra-paths.js to bring
// this measured composition root back under its prodloc high-water. Both
// collaborators are injected as deferred wrappers so this block may sit BEFORE
// createTestingInfraAudit, which itself depends on three of these names. The
// four names are re-destructured back into lifecycle scope, so every call site,
// the createTestingInfraAudit injections and the `__testing` facade below
// resolve exactly as before the move.
const {
  extractFileReferencesFromCommands,
  isTestingInfrastructureFilePath,
  splitPlanPathValues,
  tokenizeShellWords,
} = createTestingInfraPaths({
  normalizeTestingInfraAuditPath: (...a) => normalizeTestingInfraAuditPath(...a),
  toArray: (...a) => toArray(...a),
});

// COORD: gov gate bash fallback. Many real repos gate via `bash scripts/gate.sh
// <lane>` and expose NO `gate:<lane>` npm script, which made `gov gate` unusable
// (agents had to run scripts/gate.sh by hand). This resolver FIRST tries the
// existing npm-script resolution (preserving today's behavior exactly) and only
// falls back to a bash invocation when no gate script exists for the lane AND
// scripts/gate.sh is present in the worktree/repo. resolveGateScript itself is
// left intact (its tests depend on the hard fail); we wrap it and catch the
// GovernanceError it throws when no script matches.
// cleanupTicketWorktree / cleanupCoordTicketWorktrees / cleanupClosedTicketWorkspace
// moved to worktree-ops.js (Wave 4 slice 5, COORD-089). They are pure worktree
// mechanics (remove/prune a ticket's worktree); the closeout/superseded decision
// of WHEN to clean stays at the lifecycle/transitions/closeout call-sites. They
// are destructured from createWorktreeOps above and re-exposed via the deferred
// wrappers into the transitions/closeout factories and the module.exports/__testing
// facade below. worktree-ops gets resolveTicketGitContext injected as a deferred
// wrapper because that helper depends on the lifecycle-local lock registry.

// COORD-220: single reserved-ID board transaction primitive.
//
// Every ticket/board update is a coordination-state mutation that must run as ONE
// journaled transaction. `withBoardTransaction` is the named, reusable core of the
// "DO it safely" path and the seam 221..223 build on. It runs `fn` UNDER the
// governance runtime lock via `withGovernanceMutation`, which:
//   - re-reads the board inside the critical section (callers MUST use the `board`
//     passed to `fn`, NOT a board read before the lock),
//   - reserves the next ticket id inside the lock (via `reserveTicketId`) so two
//     concurrent callers can never derive the same max+1 id,
//   - snapshots the governed coordination state, runs the mutation, validates +
//     renders (the caller's `runBoardSync`), appends exactly ONE journal event with
//     the post-mutation snapshot, and
//   - on ANY failure rolls the board / plan / prompt / rendered state back to the
//     pre-mutation snapshot (no partial state).
//
// It also inherits the COORD-220 bypass seal: `withGovernanceMutation` FAILS CLOSED
// if an out-of-band coordination-state edit (a hand-edited tasks.json / stray plan /
// prompt / rendered file with no journaled transaction) is present at entry, so the
// governed path is the only path.
//
// `fn` is invoked as `fn({ board, reserveTicketId })`:
//   - `board`     : the board re-read under the lock; mutate this object in place.
//   - `reserveTicketId(prefix)` : reserve a collision-checked next id for `prefix`
//     against the locked board (use this instead of scanning files for max+1).
// `fn` is responsible for its own `writeBoard(board)` + `runBoardSync(...)` (kept in
// the caller so existing create paths keep their exact render semantics).
function withBoardTransaction(mutation, fn) {
  return withGovernanceMutation(mutation, () => {
    const board = readBoard();
    const reserveTicketId = (prefix) => nextTicketId(board, prefix);
    return fn({ board, reserveTicketId });
  });
}

// Grooming verbs: reprioritize / retype a non-terminal ticket. Pri/Type are
// non-lifecycle backlog metadata, but TASKS.md is a rendered view of canonical
// board state, so they must be mutated through gov (a hand-edit is clobbered by
// the next board write). Guarded + lock-protected, mirroring setFollowupRelation.
const ALLOWED_PRIORITIES = ["P0", "P1", "P2", "P3"];
const ALLOWED_TICKET_TYPES = ["feature", "bug", "chore", "task", "spike", "refactor", "docs", "test"];

// COORD-282: ticket state-mutation command surface (file-ticket / open-followup /
// unstart / lock-abandon / commit + the shared unstart-evidence guard), extracted
// to ticket-commands.js to keep this composition root under its arch LOC budget.
// Wired HERE so the value consts ALLOWED_PRIORITIES / ALLOWED_TICKET_TYPES (above)
// and STATUS are injected by reference; every function collaborator is injected as
// a deferred `(...a)=>fn(...a)` wrapper that resolves at call time, so factory
// ordering is irrelevant (the moved verbs ride the SAME COORD-220
// withBoardTransaction / single-writer path — reserveTicketId arrives from the
// transaction, it is NOT reimplemented here). The six names are re-destructured
// back into lifecycle scope so the `commands` dispatch table, the `__testing`
// facade, and `splitTicket` (which calls openFollowup) still resolve as before.
const {
  collectUnstartEvidenceBlockers,
  unstartTicket,
  lockAbandonTicket,
  commitTicket,
  openFollowup,
  fileTicket,
} = createTicketCommands({
  withBoardTransaction: (...a) => withBoardTransaction(...a),
  withGovernanceMutation: (...a) => withGovernanceMutation(...a),
  withCoordStateLock: (...a) => withCoordStateLock(...a),
  runBoardSync: (...a) => runBoardSync(...a),
  readBoard: (...a) => readBoard(...a),
  writeBoard: (...a) => writeBoard(...a),
  getTicketRef: (...a) => getTicketRef(...a),
  ensurePromptIndex: (...a) => ensurePromptIndex(...a),
  allBoardRepoCodes: (...a) => allBoardRepoCodes(...a),
  applyTicketStatus: (...a) => applyTicketStatus(...a),
  clearTicketOwner: (...a) => clearTicketOwner(...a),
  canonicalizeOwnerOrFail: (...a) => canonicalizeOwnerOrFail(...a),
  recordGovernanceCollision: (...a) => recordGovernanceCollision(...a),
  stableIdempotencyKey: (...a) => stableIdempotencyKey(...a),
  normalizeFollowupRelation: (...a) => normalizeFollowupRelation(...a),
  applyFollowupRelation: (...a) => applyFollowupRelation(...a),
  resolveFollowupPromptPath: (...a) => resolveFollowupPromptPath(...a),
  resolveOwnerIdentity: (...a) => resolveOwnerIdentity(...a),
  ensureCurrentAgentIdentity: (...a) => ensureCurrentAgentIdentity(...a),
  assertTicketMutationOwnership: (...a) => assertTicketMutationOwnership(...a),
  findLockForTicket: (...a) => findLockForTicket(...a),
  resolveTicketLockPath: (...a) => resolveTicketLockPath(...a),
  inferTicketStatus: (...a) => inferTicketStatus(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  cleanupClosedTicketWorkspace: (...a) => cleanupClosedTicketWorkspace(...a),
  isRepoBackedCode: (...a) => isRepoBackedCode(...a),
  toArray: (...a) => toArray(...a),
  runGit: (...a) => runGit(...a),
  gitOutput: (...a) => gitOutput(...a),
  gitTry: (...a) => gitTry(...a),
  refreshLockHead: (...a) => refreshLockHead(...a),
  readPlanRecord: (...a) => readPlanRecord(...a),
  integerOrDefault: (...a) => integerOrDefault(...a),
  planRecordHasImplicitIntendedFilesScaffoldPlaceholder: (...a) => planRecordHasImplicitIntendedFilesScaffoldPlaceholder(...a),
  resolveTicketGitContext: (...a) => resolveTicketGitContext(...a),
  resolveTicketBaseRef: (...a) => resolveTicketBaseRef(...a),
  resolveWorktreeBaseCompareRef: (...a) => resolveWorktreeBaseCompareRef(...a),
  fail: (...a) => fail(...a),
  STATUS,
  CREATABLE_STATUSES,
  ALLOWED_TICKET_TYPES,
  ALLOWED_PRIORITIES,
});

const {
  addFinding,
  correctFindingRound,
  normalizeLock,
  reopenTicket,
  resolveWorktreeBaseCompareRef,
  setFollowupRelation,
  setPrRefs,
  setTicketPriority,
  setTicketType,
  setWaiver,
  splitTicket,
  updateFinding,
} = createLifecycleTicketAdmin({
  ALLOWED_PRIORITIES,
  ALLOWED_TICKET_TYPES,
  STATUS,
  applyFollowupRelation,
  applyTicketStatus,
  canonicalizeOwnerOrFail,
  clearTicketOwner,
  cleanupClosedTicketWorkspace,
  ensureCurrentAgentIdentity: (...a) => ensureCurrentAgentIdentity(...a),
  ensureReviewFindings: (...a) => ensureReviewFindings(...a),
  ensureWaiverIndex: (...a) => ensureWaiverIndex(...a),
  fail: (...a) => fail(...a),
  findLockForTicket: (...a) => findLockForTicket(...a),
  fs,
  getTicketRef: (...a) => getTicketRef(...a),
  gitTry: (...a) => gitTry(...a),
  currentReviewRound: (...a) => currentReviewRound(...a),
  readPlanRecord: (...a) => readPlanRecord(...a),
  inferTicketStatus: (...a) => inferTicketStatus(...a),
  integerOrDefault: (...a) => integerOrDefault(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  maybeCanonicalOwner: (...a) => maybeCanonicalOwner(...a),
  nextTicketId: (...a) => nextTicketId(...a),
  normalizeFollowupRelation,
  openFollowup: (...a) => openFollowup(...a),
  path,
  readBoard: (...a) => readBoard(...a),
  resolveOwnerIdentity: (...a) => resolveOwnerIdentity(...a),
  runBoardSync: (...a) => runBoardSync(...a),
  setTicketPrRefs: (...a) => setTicketPrRefs(...a),
  stableIdempotencyKey: (...a) => stableIdempotencyKey(...a),
  toArray: (...a) => toArray(...a),
  verifyPrEvidence: (...a) => verifyPrEvidence(...a),
  withCoordStateLock: (...a) => withCoordStateLock(...a),
  withGovernanceMutation: (...a) => withGovernanceMutation(...a),
  writeBoard: (...a) => writeBoard(...a),
});

// COORD-283: the testing-infrastructure audit/classification helper cluster,
// extracted into createTestingInfraAudit. Every function collaborator is
// injected as a deferred `(...a)=>fn(...a)` wrapper that resolves at call time
// (so factory ordering is irrelevant), and the value constants REPO_ROOTS /
// PNPM_BUILTIN_COMMANDS / TESTING_INFRA_DESCRIPTION_PATTERN are injected BY
// REFERENCE — REPO_ROOTS is mutated in place by the `__testing` registry setter,
// so the same object reference stays live. The six names are re-destructured
// back into lifecycle scope so the `commands` dispatch table, the `__testing`
// facade, and the audit call sites (deriveTestingInfrastructureAudit,
// extractFileReferencesFromCommands) still resolve exactly as before the move.
const {
  extractPackageScriptsFromCommands,
  buildTestingInfrastructureClassificationText,
  isTestingInfrastructureTicket,
  normalizeTestingInfraAuditPath,
  listCommitTouchedPaths,
  readJsonFileFromRef,
} = createTestingInfraAudit({
  normalizePlanPathValue: (...a) => normalizePlanPathValue(...a),
  repoPrefixesForCode: (...a) => repoPrefixesForCode(...a),
  escapeRegex: (...a) => escapeRegex(...a),
  splitPlanPathValues: (...a) => splitPlanPathValues(...a),
  isTestingInfrastructureFilePath: (...a) => isTestingInfrastructureFilePath(...a),
  tokenizeShellWords: (...a) => tokenizeShellWords(...a),
  gitTry: (...a) => gitTry(...a),
  REPO_ROOTS,
  PNPM_BUILTIN_COMMANDS,
  TESTING_INFRA_DESCRIPTION_PATTERN,
});

// ---------------------------------------------------------------------------
// COORD-026: cost-ledger (TOKEN_ECONOMICS.md lever #1).
// Records per-ticket/agent/model token + estimated-$ accounting as append-only
// `cost.observed` journal events, and reports them via `gov cost`. Pure
// additive: it is evidence, not a gate, and touches neither lifecycle/verdict
// semantics nor the canonical gov-sync surface. Prices come from the
// data-driven coord/product/model-prices.json table — never hardcoded here.
// Compatibility marker for existing precheck probes: function precheck now
// lives in token-economics.js and is wired below.
// ---------------------------------------------------------------------------

const { signChainTransition } = createChainTransitionSigner({
  coordDir: COORD_DIR,
  resolveRuntimeDir: () => state.RUNTIME_DIR,
  createConformanceAttestation,
  signTransition,
});

const {
  collectGovernedSnapshotFilePaths,
  buildGovernanceSnapshot,
  captureGovernanceRestorePoint,
  restoreGovernanceRestorePoint,
  governanceRestorePointPath,
  persistGovernanceRestorePoint,
  clearPersistedGovernanceRestorePoint,
  recoverCrashedGovernanceMutation,
  findCommittedMutationByIdempotencyKey,
  diffGovernanceSnapshots,
  readGovernanceEventLog,
  journalHistoricalTicketIds,
  parseGovernanceEventLogLine,
  governanceSnapshotArtifactPath,
  readGovernanceSnapshotArtifact,
  writeGovernanceSnapshotArtifact,
  readGovernanceSnapshotCheckpoint,
  writeGovernanceSnapshotCheckpoint,
  readLatestGovernanceSnapshotSource,
  readLatestGovernanceEvent,
  ensureGovernanceJournalBaseline,
  advanceGovernanceProvenanceBaseline,
  detectGovernanceProvenanceDrift,
  detectOutOfBandBoardMutation,
  isCoordinationStatePath,
  isPathWithinSyncScope,
  gitIgnoredDriftPaths,
  isRuntimeLedgerDriftPath,
  formatGovernanceDriftMessage,
  describeGovernanceMutation,
  detectGovernanceQuestionAuthor,
  buildGovernanceDriftQuestion,
  appendGovernanceDriftQuestion,
  extractDriftSinceTimestamp,
  planStaleDriftNoteRetirement,
  findLatestGovernanceBaselineTimestamp,
  retireStaleDriftNotes,
  applyRetireStaleDriftNotes,
  appendGovernanceEvent,
  repairTornGovernanceEventLogTail,
  hashGovernanceEventRecord,
  hashGovernanceEventLine,
  canonicalEventSerialization,
  isChainedEvent,
  verifyGovernanceChain,
  planGovernanceChainRepair,
  restampGovernanceChainFrom,
  repairGovernanceChain,
  migrateGovernanceChainHash,
  sha256: journalSha256,
  hashWithAlg,
  eventHashAlg,
  CHAIN_MIGRATION_COMMAND,
  CHAIN_VERIFIER_VERSION,
  governanceChainRepairBackupPath,
  formatOutOfBandBoardMutationMessage,
  summarizeIdentityForEvent,
  recordGovernanceExternalSideEffect,
  recordGovernanceCollision,
  formatGovernanceExternalSideEffect,
  withGovernanceMutation,
  inferTicketStatus,
  appendGovernanceProvenanceIssues,
} = createJournal({
  fail,
  relativeCoordPath,
  existingLockDirs: (...a) => existingLockDirs(...a),
  writeFileAtomicSync,
  readJsonFileState,
  formatJsonFileIssue,
  readLastNonEmptyLine,
  withGovernanceRuntimeLock,
  readCanonicalTextFile,
  writeCanonicalTextFile,
  buildQuestionRow,
  appendQuestionRowText,
  parseQuestionRow,
  escapeTable,
  ensureCurrentAgentIdentity,
  resolveEffectiveThreadId,
  readAgentSessions,
  readCanonicalJsonFile,
  getRows,
  formatGovernanceJournalUninitializedMessage,
  splitGovernanceProvenanceDrift,
  GovernanceError,
  signChainTransition,
});

// COORD-091: board-rebuild-from-journal surface. Wired AFTER createJournal so
// the injected readGovernanceEventLog / withGovernanceMutation bindings are
// live; readBoard / writeBoard / getTicketRef come from createGovernanceBoardState
// (wired earlier). Deferred wrappers keep call-time resolution order-independent.
const {
  rebuildBoardFromJournal,
  terminalJournalStatusForTicket,
  collectTicketsWithJournalDrift,
} = createBoardRebuild({
  fail: (...args) => fail(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  writeBoard: (...args) => writeBoard(...args),
});

// COORD-060: plan-command surface. Wired after createJournal so the injected
// withGovernanceMutation/inferTicketStatus bindings are live.
const {
  buildStartPlanSeedUpdate,
  planCommandUpdateOptions,
  mergePlanCommandOptions,
  hasPlanCommandUpdates,
  buildPlanNextCommands,
  buildPlanStatusPayload,
  planTicket,
  updatePlanBlock,
  addReviewCycleCommand,
  setReviewCyclesCommand,
  setRequirementClosureCommand,
  addFeatureProofCommand,
  buildFeatureProofEntriesFromOptions,
  dropFeatureProofCommand,
  assertTicketPlanMutationAuthority,
} = createPlanCommand({
  fail: (...args) => fail(...args),
  toArray: (...args) => toArray(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  readPlanState: (...args) => readPlanState(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  collectStartReadinessBlockers: (...args) => collectStartReadinessBlockers(...args),
  collectStartReadinessAdvisories: (...args) => collectStartReadinessAdvisories(...args),
  collectReviewPlanReadinessIssues: (...args) => collectReviewPlanReadinessIssues(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  resolveHumanAdminOverride: (...args) => resolveHumanAdminOverride(...args),
  defaultStartTraceabilityValue: (...args) => defaultStartTraceabilityValue(...args),
  ticketRequiresBaseline: (...args) => ticketRequiresBaseline(...args),
});

// COORD-069: repo-gate attribution / board-record surface. Wired after
// createPlanCommand so the injected updatePlanBlock binding is live.
const {
  addRepoGateCommand,
  classifyGateAttribution,
  formatRepoGateEntry,
} = createGates({
  fail: (...args) => fail(...args),
  updatePlanBlock: (...args) => updatePlanBlock(...args),
});

// COORD-061: ticket state-machine transitions. Wired after createJournal (for
// withGovernanceMutation/inferTicketStatus) and createPlanCommand (for
// buildStartPlanSeedUpdate). All other deps are function declarations (hoisted)
// or factory-produced bindings; they are injected as deferred wrappers so the
// lookup resolves at call time. moveReview / markDone / applyMarkDone are
// re-destructured into lifecycle scope because finalize/land/finishTicket
// (which stay here) still call them. COORD-062's closeout module is expected to
// inject this same surface.
const {
  approveTicket,
  rejectTicket,
  startTicket,
  submitTicket,
  moveReview,
  returnDoing,
  markDone,
  applyMarkDone,
  blockTicket,
  unblockTicket,
  supersedeTicket,
  persistReturnDoingState,
} = createTicketTransitions({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  applyTicketStatus: (...args) => applyTicketStatus(...args),
  assignTicketOwner: (...args) => assignTicketOwner(...args),
  clearTicketOwner: (...args) => clearTicketOwner(...args),
  setTicketPrRefs: (...args) => setTicketPrRefs(...args),
  isLegalStatus: (...args) => isLegalStatus(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  runBoardValidate: (...args) => runBoardValidate(...args),
  withBoardTransaction: (...args) => withBoardTransaction(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  resolveOwnerIdentity: (...args) => resolveOwnerIdentity(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  assertTicketMutationOwnership: (...args) => assertTicketMutationOwnership(...args),
  detectColocatedForeignSessions: (...args) => detectColocatedForeignSessions(...args),
  buildColocatedForeignSessionMessage: (...args) => buildColocatedForeignSessionMessage(...args),
  recordGovernanceCollision: (...args) => recordGovernanceCollision(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  resolveTicketLockPath: (...args) => resolveTicketLockPath(...args),
  ensureDoingTicketLockIntegrity: (...args) => ensureDoingTicketLockIntegrity(...args),
  ensureGitWorktree: (...args) => ensureGitWorktree(...args),
  withPreparedTicketWorkspace: (...args) => withPreparedTicketWorkspace(...args),
  cleanupClosedTicketWorkspace: (...args) => cleanupClosedTicketWorkspace(...args),
  writeLock: (...args) => writeLock(...args),
  defaultWorktreePath: (...args) => defaultWorktreePath(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  formatTransitiveBlockerDetails: (...args) => formatTransitiveBlockerDetails(...args),
  formatDependencyCycleList: (...args) => formatDependencyCycleList(...args),
  findDoingTicketForOwner: (...args) => findDoingTicketForOwner(...args),
  canOwnerHoldConcurrentDoing: (...args) => canOwnerHoldConcurrentDoing(...args),
  resolveLifecyclePrRefs: (...args) => resolveLifecyclePrRefs(...args),
  assertReviewPlanReady: (...args) => assertReviewPlanReady(...args),
  assertAlreadyLandedNoPrReconcileReady: (...args) => assertAlreadyLandedNoPrReconcileReady(...args),
  assertCommittedReviewState: (...args) => assertCommittedReviewState(...args),
  refsContainMergedPrForTicket: (...args) => refsContainMergedPrForTicket(...args),
  prCreate: (...args) => prCreate(...args),
  appendReviewFollowupPlan: (...args) => appendReviewFollowupPlan(...args),
  inferNextRound: (...args) => inferNextRound(...args),
  prepareDoneCloseout: (...args) => prepareDoneCloseout(...args),
  buildStartOwnershipRaceMessage: (...args) => buildStartOwnershipRaceMessage(...args),
  buildHistoricalCloseoutStartBlocker: (...args) => buildHistoricalCloseoutStartBlocker(...args),
  ensurePromptCoverageOrDiscover: (...args) => ensurePromptCoverageOrDiscover(...args),
  assertPromptPreconditionsResolve: (...args) => assertPromptPreconditionsResolve(...args),
  ensurePlanStub: (...args) => ensurePlanStub(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  buildStartPlanSeedUpdate: (...args) => buildStartPlanSeedUpdate(...args),
  seedStartIntendedFilesFromPrompt: (...args) => seedStartIntendedFilesFromPrompt(...args),
  assertStartPlanReady: (...args) => assertStartPlanReady(...args),
  buildStartPlanBootstrapCommand: (...args) => buildStartPlanBootstrapCommand(...args),
  detectSupersedeLandingBypass: (...args) => detectSupersedeLandingBypass(...args),
  // COORD-680: deferred forwarder (see the matching note on the
  // createAgentCommands wiring above).
  isRepoBackedCode: (...args) => isRepoBackedCode(...args), ensureGovernedWorkspaceForTicket: (...args) => ensureGovernedWorkspaceForTicket(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  repoDisplayNameForCode: (...args) => repoDisplayNameForCode(...args),
  resolveTicketBaseRef: (...args) => resolveTicketBaseRef(...args),
  toArray: (...args) => toArray(...args),
  slugify: (...args) => slugify(...args),
  integerOrDefault: (...args) => integerOrDefault(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
});

// COORD-062: ticket closeout / land surface. Wired AFTER createTicketTransitions
// because finalize/land/finish call its moveReview / markDone / applyMarkDone,
// which are injected here. The near-circular edge — transitions.markDone needs
// prepareDoneCloseout, which lives in this module — is resolved by injecting
// closeout's prepareDoneCloseout into the transitions factory above as a
// deferred `(...args) => prepareDoneCloseout(...args)` wrapper that resolves at
// call time (the const below is in scope by then). All other deps are hoisted
// function declarations or factory-produced bindings, injected as deferred
// wrappers. finalizeTicket / finishTicket / landTicket / prepareDoneCloseout are
// re-destructured into lifecycle scope because the __testing facade and the
// command dispatch still reference them.
const {
  finalizeTicket,
  finishTicket,
  landTicket,
  prepareDoneCloseout,
  buildPrCloseoutPlanUpdate,
  buildNoPrCloseoutPlanUpdate,
} = createCloseout({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  setPrRefs: (...args) => setPrRefs(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  ensureTicketMutationOwnership: (...args) => ensureTicketMutationOwnership(...args),
  moveReview: (...args) => moveReview(...args),
  markDone: (...args) => markDone(...args),
  applyMarkDone: (...args) => applyMarkDone(...args),
  prMerge: (...args) => prMerge(...args),
  persistMergedPrLandingSnapshot: (...args) => persistMergedPrLandingSnapshot(...args),
  refreshLandingBaseRef: (...args) => refreshLandingBaseRef(...args),
  resolvePrUrlForTicket: (...args) => resolvePrUrlForTicket(...args),
  ensureLandingRecord: (...args) => ensureLandingRecord(...args),
  assertLandingIntegrity: (...args) => assertLandingIntegrity(...args),
  ensureTestingInfrastructureLandingAudit: (...args) => ensureTestingInfrastructureLandingAudit(...args),
  ensureFeatureProofLandingAudit: (...args) => ensureFeatureProofLandingAudit(...args),
  verifyPrEvidence: (...args) => verifyPrEvidence(...args),
  assertReviewPlanReady: (...args) => assertReviewPlanReady(...args),
  findOutstandingCloseoutBlockerFollowups: (...args) => findOutstandingCloseoutBlockerFollowups(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  ensureRepoXCloseoutReady: (...args) => ensureRepoXCloseoutReady(...args),
  cleanupTicketWorktree: (...args) => cleanupTicketWorktree(...args),
  resolveLifecyclePrRefs: (...args) => resolveLifecyclePrRefs(...args),
  updateCanonicalPlanState: (...args) => updateCanonicalPlanState(...args),
  buildQuestionRow: (...args) => buildQuestionRow(...args),
  buildLandCloseoutAnswer: (...args) => buildLandCloseoutAnswer(...args),
  appendQuestionRowText: (...args) => appendQuestionRowText(...args),
  removeQuestionRowText: (...args) => removeQuestionRowText(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  resolveRepoIntegrationBranch: (...args) => resolveRepoIntegrationBranch(...args),
  mergeUniqueRefs: (...args) => mergeUniqueRefs(...args),
  toArray: (...args) => toArray(...args),
});

// COORD-063 (final Wave 2 slice): the MUTATING governance repair / recovery
// surface. doctorFix / reconcileGovernance / recoverTicket all funnel through
// withGovernanceMutation + the board-state mutators, so this factory is wired
// after createJournal / createGovernanceBoardState. Every dep is a hoisted
// function declaration or factory-produced binding injected as a deferred
// `(...args) => fn(...args)` wrapper that resolves at call time. doctorFix is
// re-destructured back into lifecycle scope because the read-only `doctor`
// report delegates to it on `--fix`; reconcileGovernance / recoverTicket are
// re-destructured because the cli.js dispatch + the module.exports surface
// still reference them. The read-only doctor diagnostics stay in lifecycle.js.
const {
  doctorFix,
  reconcileGovernance,
  recoverTicket,
} = createDoctorRecovery({
  fail: (...args) => fail(...args),
  readBoard: (...args) => readBoard(...args),
  writeBoard: (...args) => writeBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  withGovernanceMutation: (...args) => withGovernanceMutation(...args),
  inferTicketStatus: (...args) => inferTicketStatus(...args),
  withAgentStateLock: (...args) => withAgentStateLock(...args),
  withCoordStateLock: (...args) => withCoordStateLock(...args),
  resolveDoctorScope: (...args) => resolveDoctorScope(...args),
  buildTicketNextCommands: (...args) => buildTicketNextCommands(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  writeJsonFile: (...args) => writeJsonFile(...args),
  defaultHostLabel: (...args) => defaultHostLabel(...args),
  resolveEffectiveThreadId: (...args) => resolveEffectiveThreadId(...args),
  reapIdleAutoClaimedProviderStubs: (...args) => reapIdleAutoClaimedProviderStubs(...args),
  reapGateProcOrphans: (...args) => gateProcRegistry.reapOrphans(...args),
  readAgentsRegistry: (...args) => readAgentsRegistry(...args),
  resolveAgentIdentifier: (...args) => resolveAgentIdentifier(...args),
  findActiveSessionForHandle: (...args) => findActiveSessionForHandle(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  assertTicketRepairOwnership: (...args) => assertTicketRepairOwnership(...args),
  inspectCanonicalLockMirrorState: (...args) => inspectCanonicalLockMirrorState(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  isStaleTicketLock: (...args) => isStaleTicketLock(...args),
  getLockFiles: (...args) => getLockFiles(...args),
  resolveTicketLockPath: (...args) => resolveTicketLockPath(...args),
  readLockFileState: (...args) => readLockFileState(...args),
  isCompleteLockPayload: (...args) => isCompleteLockPayload(...args),
  writeLock: (...args) => writeLock(...args),
  resolveLockHead: (...args) => resolveLockHead(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  ensurePlanStub: (...args) => ensurePlanStub(...args),
  applyRetireStaleDriftNotes: (...args) => applyRetireStaleDriftNotes(...args),
  auditCoordWorktrees: (...args) => auditCoordWorktrees(...args),
  pruneEmptyParents: (...args) => pruneEmptyParents(...args),
  coordWorktreesRoot: (...args) => coordWorktreesRoot(...args),
  defaultWorktreePath: (...args) => defaultWorktreePath(...args),
  resolveTicketGitContext: (...args) => resolveTicketGitContext(...args),
  detectGovernanceProvenanceDrift: (...args) => detectGovernanceProvenanceDrift(...args),
  isRecoverableGovernanceDriftPath: (...args) => isRecoverableGovernanceDriftPath(...args),
  formatGovernanceDriftMessage: (...args) => formatGovernanceDriftMessage(...args),
  safeReadJson: (...args) => safeReadJson(...args),
  relativeCoordPath: (...args) => relativeCoordPath(...args),
  readDirectoryLockMetadata: (...args) => readDirectoryLockMetadata(...args),
  isProcessAlive: (...args) => isProcessAlive(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  gitTry: (...args) => gitTry(...args),
  canonicalSyncablePaths: (...args) => canonicalSyncablePaths(...args),
  slugify: (...args) => slugify(...args),
  identityV2,
});

// COORD-085 (Wave 4 slice 1): the READ-ONLY governance doctor REPORTING
// surface. resolveDoctorScope / resolveDoctorOwnerScope / the read-only
// doctor() report + buildCanonicalDerivedDriftError live in doctor-report.js;
// the MUTATING repair (doctorFix) lives in doctor-recovery.js. This factory is
// wired AFTER createDoctorRecovery so doctorFix is in scope to inject for the
// read-only doctor()'s `--fix` delegation. The recovery factory above injects
// resolveDoctorScope via a deferred `(...args) => fn(...args)` wrapper, which
// resolves to the report-produced binding below at call time (the mutual
// report<->repair reference is the documented cyclic seam). Every dep is a
// deferred wrapper so hoisting / wiring order does not matter at call time.
// doctor / orchestratorCycle / resolveDoctorScope / resolveDoctorOwnerScope /
// buildCanonicalDerivedDriftError are re-destructured back into lifecycle scope
// because orchestratorCycle, the cli.js dispatch, module.exports and the
// __testing facade still reference them.
const {
  doctor,
  resolveDoctorScope,
  resolveDoctorOwnerScope,
  buildCanonicalDerivedDriftError,
} = createDoctorReport({
  fail: (...args) => fail(...args),
  doctorFix: (...args) => doctorFix(...args),
  readBoard: (...args) => readBoard(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  getRows: (...args) => getRows(...args),
  rowsById: (...args) => rowsById(...args),
  runBoardValidate: (...args) => runBoardValidate(...args),
  runBoardSync: (...args) => runBoardSync(...args),
  evaluateReadiness: (...args) => evaluateReadiness(...args),
  formatDependencyCycleList: (...args) => formatDependencyCycleList(...args),
  formatTransitiveBlockerDetails: (...args) => formatTransitiveBlockerDetails(...args),
  isDoingStatus: (...args) => isDoingStatus(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  getRepoRoot: (...args) => getRepoRoot(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  requiresLandingGovernance: (...args) => requiresLandingGovernance(...args),
  hasPromptWaiver: (...args) => hasPromptWaiver(...args),
  findLockForTicket: (...args) => findLockForTicket(...args),
  isStaleTicketLock: (...args) => isStaleTicketLock(...args),
  safeResolveLockHead: (...args) => safeResolveLockHead(...args),
  inspectCanonicalLockMirrorState: (...args) => inspectCanonicalLockMirrorState(...args),
  auditRepoWorktrees: (...args) => auditRepoWorktrees(...args),
  // COORD-635: control-plane worktree audit, so doctor names coord/ state.
  auditCoordWorktrees: (...args) => auditCoordWorktrees(...args),
  readAgentSessions: (...args) => readAgentSessions(...args),
  ensureCurrentAgentIdentity: (...args) => ensureCurrentAgentIdentity(...args),
  isNoActiveClaimedSessionError: (...args) => isNoActiveClaimedSessionError(...args),
  isRegisteredAgentHandle: (...args) => isRegisteredAgentHandle(...args),
  canonicalizeOwnerOrFail: (...args) => canonicalizeOwnerOrFail(...args),
  detectActiveSameOwnerOtherThread: (...args) => detectActiveSameOwnerOtherThread(...args),
  detectColocatedForeignSessions: (...args) => detectColocatedForeignSessions(...args),
  assertLandingIntegrity: (...args) => assertLandingIntegrity(...args),
  ensureTestingInfrastructureLandingAudit: (...args) => ensureTestingInfrastructureLandingAudit(...args),
  collectLandingAuditReport: (...args) => collectLandingAuditReport(...args),
  formatLandingAuditSummary: (...args) => formatLandingAuditSummary(...args),
  appendGovernanceProvenanceIssues: (...args) => appendGovernanceProvenanceIssues(...args),
  detectOutOfBandBoardMutation: (...args) => detectOutOfBandBoardMutation(...args),
  detectRollbackDrift: (...args) => detectRollbackDrift(...args),
  computeSyncDelta: (...args) => computeSyncDelta(...args),
  canonicalSyncablePaths: (...args) => canonicalSyncablePaths(...args),
  gitTry: (...args) => gitTry(...args),
  readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
  verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
  buildJournalHealthReport: () => buildJournalHealthReport({
    journalPath: DEFAULT_PATHS.governanceEventLogPath,
    readGovernanceEventLog: (...args) => readGovernanceEventLog(...args),
    verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
  }),
  formatJournalHealthWarning: (...args) => formatJournalHealthWarning(...args),
  collectStaleTemplateFeedbackErrors: (...args) => collectStaleTemplateFeedbackErrors(...args),
  // COORD-243: read-only coverage-maturity staleness DETECT. Lazily required so
  // lifecycle stays independent of the coverage-maturity module's load order; the
  // detector itself does only synchronous reads and returns finding strings.
  detectMaturityStaleness: (...args) =>
    require("./coverage-maturity.js").detectMaturityStalenessFromDisk(...args),
  buildQuestionQueueReport: (...args) => buildQuestionQueueReport(...args),
  readActiveOrchestratorQuestionRows: (...args) => readActiveOrchestratorQuestionRows(...args),
  formatBucketCounts: (...args) => formatBucketCounts(...args),
  buildDoctorResolutionGuidance: (...args) => buildDoctorResolutionGuidance(...args),
  detectGateProcOrphans: (...args) => gateProcRegistry.detectOrphans(...args),
});

// COORD-107: the ENT conformance / engine-integrity CLI verb surface
// (`gov conform` ENT-002/ENT-010 + `gov verify-engine` ENT-011) extracted to
// conformance-verbs.js. lifecycle.js remains the composition root: it requires
// the two factory CREATORS and injects them (plus the journal chain verifier,
// the GovernanceError `fail`, and COORD_DIR) so the extracted module stays a
// thin DI wrapper. `conform`/`verifyEngine` are destructured back out for the
// `commands` dispatch map + cli.js case wiring, preserving behavior parity.
const {
  conform,
  repairChain,
  migrateChainHash,
  verifyEngine,
} = createConformanceVerbs({
  coordDir: COORD_DIR,
  fail,
  // COORD-300: resolve the runtime root from the live (sandboxable) state at call
  // time, so a test that redirects RUNTIME_DIR also sandboxes the conformance
  // keypair + attestation artifacts instead of writing the live coord/.runtime tree.
  resolveRuntimeDir: () => state.RUNTIME_DIR,
  verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
  repairGovernanceChain: (...args) => repairGovernanceChain(...args),
  migrateGovernanceChainHash: (...args) => migrateGovernanceChainHash(...args),
  // COORD-124: best-effort actor identity for the on-chain repair marker. Never
  // auto-claims / touches sessions; falls back to null so the verb still works in
  // a clean-env (no session) invocation.
  resolveRepairIdentity: () => {
    try {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch {
      return null;
    }
  },
  createConformanceAttestation,
  createEnginePin,
});

const {
  readModelPrices,
  resolveModelPrice,
  estimateCostUsd,
  recordCost,
  collectCostObservations,
  aggregateCost,
  costReport,
  loadTicketPrecheckProbes,
  runPrecheckProbe,
  classifyPrecheckVerdict,
  precheck,
  parseTicketPromptSections,
  minePriorProofsAndInvariants,
  ticketFilesIntersect,
  buildContextPack,
  contextPack,
  readTierPolicy,
  resolveTicketTier,
  tierEvidenceMinimums,
  effectiveTierMinimum,
  tierCommand,
  parseTicketDependsOn,
  planWaves,
  buildSequencerPlan,
  sequencerPlan,
  detectMergeQueueAmbiguities,
  buildMergeQueueState,
  mergeQueue,
  dispatchCachePrefixMarker,
  dispatchPrecheckVerdict,
  dispatchActionForTicket,
  dispatchPlan,
} = createTokenEconomics({
  fail,
  relativeCoordPath,
  ensureCurrentAgentIdentity,
  withGovernanceMutation,
  readBoard,
  getRows,
  getTicketRef,
  readGovernanceEventLog,
  readPlanRecord,
  isRepoBackedCode,
});

// ENT-005: OTLP exporter (COMMUNITY tier). Reads the durable journal and emits
// it as OTLP/JSON (tickets-as-traces, lifecycle-verbs-as-spans, cost/tier/
// attribution as span attributes; non-ticket events as log records). Zero-dep +
// deterministic. Wired here so it shares the live journal/board/tier deps; it is
// READ-ONLY (writes only to its own output file/stdout, or POSTs when
// --endpoint is given) and never enters withGovernanceMutation.
const {
  otlpExport,
} = createOtlpExport({
  fail,
  readGovernanceEventLog,
  readBoard,
  getRows,
  resolveTicketTier,
});

// COORD-022: detect the package manager for the clean-checkout gate from the
// lockfile present in the worktree, so npm/yarn adopters are not forced onto
// pnpm. Returns the binary, the frozen/ci install args, and a runScriptArgs
// builder for invoking a package.json script. Falls back to pnpm (the donor
// default) when no recognized lockfile is present, preserving prior behavior.
// Phase 4 (repair-path hardening): detect when a destructive operation could
// silently discard newer governance state. Pure and fully guarded: never
// throws on a missing git binary, missing remote, offline fetch state, or a
// missing/unreadable journal/board. Reused by `clean-runtime` (refuses without
// --force) and surfaced as non-fatal doctor warnings.
// Phase 4 (repair-path hardening): enumerate conservatively-classified
// regenerable runtime cruft under state.RUNTIME_DIR. NEVER includes ticket-local
// state (locks/, plans/), session files, the governance journal/snapshots,
// or anything tracked by git. Returns { candidates, protected }.
// Phase 4 (repair-path hardening): supported, safe replacement for ad hoc
// `git clean/reset` inside coord. By default it deletes NOTHING — it
// enumerates candidates and requires --yes to act (mirrors cleanup-worktree's
// "rerun with --yes" guard). It refuses entirely when rollback drift is
// detected unless --force, and never removes ticket-local state without an
// explicit --include-ticket-state AND --yes.
// Resolve the integration branch (--base) for a ticket. Order:
//   1. explicit options.base / options.baseRef (caller override)
//   2. plan record's governance.expected_closeout.base_ref
//   3. per-repo default from REPO_INTEGRATION_BRANCHES (paths.js)
//   4. historical fallback "dev"
// Prevents start/return-doing/commit from defaulting to "dev" when a repo's
// actual integration branch is configured differently in paths.js.
// Registry-generalized: derive the human-facing repo label from the registry
// (M1 repoNameForCode) instead of hardcoding board codes to repo names.
// COORD-594: the pre-review commit-state assertion, the review-return plan
// append and the shared traceability default live in lifecycle-review-state.js
// (extraction under the no-grandfather prodloc policy). Every collaborator is a
// deferred wrapper resolved at call time (fs / gitTry / STATUS-free), so factory
// ordering stays irrelevant; the names are re-destructured into lifecycle scope
// so pr-ops / ticket-transitions / plan-command and the __testing facade resolve
// exactly as before.
const {
  appendReviewFollowupPlan,
  assertCommittedReviewState,
  defaultStartTraceabilityValue,
} = createLifecycleReviewState({
  BOARD_RAW_SYMBOL,
  appendUniquePlanRecordValue: (...args) => appendUniquePlanRecordValue(...args),
  assertCurrentTicketLockIntegrity: (...args) => assertCurrentTicketLockIntegrity(...args),
  buildScaffoldPlanRecord: (...args) => buildScaffoldPlanRecord(...args),
  commitSubjectAffiliatesWithTicket: (...args) => commitSubjectAffiliatesWithTicket(...args),
  fail: (...args) => fail(...args),
  fs,
  getRepoRoot: (...args) => getRepoRoot(...args),
  gitTry,
  isCommitAncestorOfRef: (...args) => isCommitAncestorOfRef(...args),
  isRepoBackedCode: (...args) => isRepoBackedCode(...args),
  normalizeGovernancePlanShape: (...args) => normalizeGovernancePlanShape(...args),
  planRecordPath: (...args) => planRecordPath(...args),
  planTargetsCoordOnlyArtifacts: (...args) => planTargetsCoordOnlyArtifacts(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  readPlanRecordScaffoldPlaceholders: (...args) => readPlanRecordScaffoldPlaceholders(...args),
  repoNameForCode: (...args) => repoNameForCode(...args),
  resolveLandingBaseRef: (...args) => resolveLandingBaseRef(...args),
  resolveRepoIntegrationBranch: (...args) => resolveRepoIntegrationBranch(...args),
  resolveSourceCommitSha: (...args) => resolveSourceCommitSha(...args),
  stripPlanScaffoldValues: (...args) => stripPlanScaffoldValues(...args),
  ticketRequiresTraceability: (...args) => ticketRequiresTraceability(...args),
  writeCanonicalJsonFile: (...args) => writeCanonicalJsonFile(...args),
  writePlanCompatibilityBlockFromRecord: (...args) => writePlanCompatibilityBlockFromRecord(...args),
});

function getLockFiles() {
  const filesByName = new Map();
  for (const dirPath of existingLockDirs()) {
    for (const fileName of fs.readdirSync(dirPath).filter((entry) => entry.endsWith(".lock")).sort()) {
      if (!filesByName.has(fileName)) {
        filesByName.set(fileName, path.join(dirPath, fileName));
      }
    }
  }
  return [...filesByName.values()];
}

function findLockForTicket(ticketId) {
  for (const lockPath of getLockFiles()) {
    const lock = normalizeLockIdentityReferences(safeReadJson(lockPath));
    if (lock && lock.ticket === ticketId) {
      return { path: lockPath, ...lock };
    }
  }
  return null;
}

// COORD-292: the sync / provenance-baseline service, extracted into
// createSyncProvenance (lifecycle decomposition slice #1 after the COORD-291
// boundary contract). The scoped canonical-delta sync (runSyncCommand /
// commitCanonicalDelta) and the post-mutation provenance-baseline advance
// (lifecycleSyncScopePaths / advanceProvenanceBaselineAfterLifecycle /
// autoSyncAfterLifecycle) plus the opt-in push helpers now live in
// sync-provenance.js. Every external collaborator is injected as a deferred
// `(...a)=>fn(...a)` wrapper that resolves at call time (so factory ordering is
// irrelevant — `advanceGovernanceProvenanceBaseline` comes live earlier from the
// journal factory, `relativeCoordPath`/`fail` are hoisted declarations below),
// and the value constants COORD_DIR / DEFAULT_PATHS are injected BY REFERENCE.
// CRITICAL: the COORD-275 scope-checked baseline advance is INJECTED
// (advanceGovernanceProvenanceBaseline from journal.js), NOT reimplemented here.
// The eight names are re-destructured back into lifecycle scope so the `commands`
// dispatch table, the `__testing` facade, and cli.js (autoSyncAfterLifecycle /
// runSyncCommand) still resolve exactly as before the move.
const {
  runSyncCommand,
  commitCanonicalDelta,
  buildAutoSyncMessage,
  pushOnFinalizeEnabled,
  pushAfterLifecycleSync,
  lifecycleSyncScopePaths,
  advanceProvenanceBaselineAfterLifecycle,
  autoSyncAfterLifecycle,
} = createSyncProvenance({
  runBoardSync: (...a) => runBoardSync(...a),
  canonicalSyncablePaths: (...a) => canonicalSyncablePaths(...a),
  computeSyncDelta: (...a) => computeSyncDelta(...a),
  isInsideGitWorkTree: (...a) => isInsideGitWorkTree(...a),
  relativeCoordPath: (...a) => relativeCoordPath(...a),
  readBoard: (...a) => readBoard(...a),
  getRows: (...a) => getRows(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  findLockForTicket: (...a) => findLockForTicket(...a),
  isStaleTicketLock: (...a) => isStaleTicketLock(...a),
  advanceGovernanceProvenanceBaseline: (...a) => advanceGovernanceProvenanceBaseline(...a),
  gitTry: (...a) => gitTry(...a),
  fail: (...a) => fail(...a),
  COORD_DIR,
  DEFAULT_PATHS,
});

const {
  assertCurrentTicketLockIntegrity,
  buildStartOwnershipRaceMessage,
  describeLockFileIssue,
  heartbeat,
  inspectCanonicalLockMirrorState,
  readLockFileOrFail,
  readLockFileState,
  reapGateProcs,
  releaseLock,
} = createLifecycleLockCommands({
  COORD_DIR,
  ROOT_DIR,
  STATUS,
  assertTicketMutationOwnership: (...a) => assertTicketMutationOwnership(...a),
  canOwnerHoldConcurrentDoing: (...a) => canOwnerHoldConcurrentDoing(...a),
  canonicalizeOwnerOrFail: (...a) => canonicalizeOwnerOrFail(...a),
  fail: (...a) => fail(...a),
  findActiveSessionForHandle: (...a) => findActiveSessionForHandle(...a),
  findDoingTicketForOwner: (...a) => findDoingTicketForOwner(...a),
  fs,
  gateProcRegistry,
  getRepoRoot: (...a) => getRepoRoot(...a),
  getTicketRef: (...a) => getTicketRef(...a),
  inferTicketStatus: (...a) => inferTicketStatus(...a),
  isCompleteLockPayload: (...a) => isCompleteLockPayload(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  isRepoBackedCode: (...a) => isRepoBackedCode(...a),
  normalizeLockIdentityReferences: (...a) => normalizeLockIdentityReferences(...a),
  normalizeOwnerValue: (...a) => normalizeOwnerValue(...a),
  ownerMatches: (...a) => ownerMatches(...a),
  path,
  readAgentsRegistry: (...a) => readAgentsRegistry(...a),
  readBoard: (...a) => readBoard(...a),
  readJsonFileState: (...a) => readJsonFileState(...a),
  relativeCoordPath: (...a) => relativeCoordPath(...a),
  repoCodeForLockRepoName: (...a) => repoCodeForLockRepoName(...a),
  resolveAgentIdentifier: (...a) => resolveAgentIdentifier(...a),
  resolveLockHead: (...a) => resolveLockHead(...a),
  resolveTicketLockPath: (...a) => resolveTicketLockPath(...a),
  rowsById: (...a) => rowsById(...a),
  safeResolveLockHead: (...a) => safeResolveLockHead(...a),
  state,
  touchActiveSession: (...a) => touchActiveSession(...a),
  withGovernanceMutation: (...a) => withGovernanceMutation(...a),
});

// COORD-293: the ticket-lock service, extracted into createTicketLockService
// (lifecycle decomposition slice #2 after the COORD-291 boundary contract). The
// ticket-lock PATH resolution + legacy-lock compatibility/promotion
// (resolveTicketLockPath / shouldUseLegacyLockCompatibility / existingLockDirs),
// lock-HEAD resolution/refresh (resolveLockHead / safeResolveLockHead /
// refreshLockHead), and the doing-lock integrity invariant
// (ensureDoingTicketLockIntegrity) now live in ticket-lock-service.js. The
// governance-context lock-dir primitive (`state`, holding LOCKS_DIR /
// LEGACY_LOCKS_DIR) is injected BY REFERENCE so the path helpers read the live
// values at call time (tests swap them via `__testing.paths`); every other
// collaborator is injected as a deferred `(...a)=>fn(...a)` wrapper that resolves
// at call time (so factory ordering is irrelevant — moveFileIfNeeded /
// readLockFileOrFail / findLockForTicket / resolveTicketGitContext are hoisted
// lifecycle declarations below, the rest come live from governance-context /
// governance-session). CRITICAL: the live-holder + stale-lock primitives
// (mkdir-mutex / tryReclaimStaleDirectoryLock / writeDirectoryLockMetadata in
// governance-context.js, findLockForTicket / writeLock / moveFileIfNeeded in
// governance-session/lifecycle) are INJECTED, NOT moved/reimplemented here, so no
// lock behavior changes. The seven names are re-destructured back into lifecycle
// scope so the `commands` dispatch table, the `__testing` facade, and the deferred
// wrappers other factories inject still resolve exactly as before the move.
const {
  resolveLockHead,
  safeResolveLockHead,
  refreshLockHead,
  shouldUseLegacyLockCompatibility,
  existingLockDirs,
  resolveTicketLockPath,
  ensureDoingTicketLockIntegrity,
} = createTicketLockService({
  state,
  gitTry: (...a) => gitTry(...a),
  isRepoBackedCode: (...a) => isRepoBackedCode(...a),
  repoCodeForLockRepoName: (...a) => repoCodeForLockRepoName(...a),
  readLockFileOrFail: (...a) => readLockFileOrFail(...a),
  findLockForTicket: (...a) => findLockForTicket(...a),
  writeLock: (...a) => writeLock(...a),
  moveFileIfNeeded: (...a) => moveFileIfNeeded(...a),
  isDoingStatus: (...a) => isDoingStatus(...a),
  canonicalizeOwnerOrFail: (...a) => canonicalizeOwnerOrFail(...a),
  ensureTicketMutationOwnership: (...a) => ensureTicketMutationOwnership(...a),
  findActiveSessionForHandle: (...a) => findActiveSessionForHandle(...a),
  resolveTicketGitContext: (...a) => resolveTicketGitContext(...a),
  fail: (...a) => fail(...a),
});

// COORD-294: the ticket QUEUE / ranking / recommendation service, extracted into
// createTicketQueueService (lifecycle decomposition slice #3 after the COORD-291
// boundary contract). Ticket listing (listTickets), the pick/recommend candidate
// ranking (pickTickets + the internal pick*/buildRecommendationSet helpers,
// recommendTickets), the scoring model (scoreTicket + modeBiasScore), the
// downstream/dependency unblocks counts (buildDownstreamCounts), the mode-bias
// resolver (recommendationModeForAgent), the idle/busy active-agent summaries
// (summarizeBusyActiveAgents / listIdleActiveAgentSessions), and the agent-release
// candidate planning (buildReleaseCandidates) now live in ticket-queue-service.js.
// The governance-context primitive (`state`, holding BOARD_PATH) and the `STATUS`
// constant map are injected BY REFERENCE so the agent-summary readers and the
// proposed-exclusion checks read live values at call time; every other collaborator
// is injected as a deferred `(...a)=>fn(...a)` wrapper that resolves at call time
// (so factory ordering is irrelevant — compareSessionsMostRecentFirst is a hoisted
// declaration above that STAYS in lifecycle.js because governance-session also
// consumes it, the rest come live from the board / identity / readiness seams).
// CRITICAL: output PARITY for `gov counts/list/pick/recommend` and the COORD-285
// `proposed`-exclusion (from the downstream unblocks count AND the recommendation
// candidate set) are PRESERVED, not reimplemented — the functions moved verbatim.
// The nine names are re-destructured back into lifecycle scope so the `commands`
// dispatch table, the `__testing` facade, and the deferred wrappers other factories
// inject (summarizeBusyActiveAgents / listIdleActiveAgentSessions /
// buildReleaseCandidates) all resolve exactly as before the move.
const {
  listTickets,
  pickTickets,
  recommendTickets,
  recommendationModeForAgent,
  summarizeBusyActiveAgents,
  listIdleActiveAgentSessions,
  buildReleaseCandidates,
  scoreTicket,
  buildDownstreamCounts,
} = createTicketQueueService({
  state,
  STATUS,
  readBoard: (...a) => readBoard(...a),
  getRows: (...a) => getRows(...a),
  resolveOwnerIdentity: (...a) => resolveOwnerIdentity(...a),
  ensureCurrentAgentIdentity: (...a) => ensureCurrentAgentIdentity(...a),
  maybeCanonicalOwner: (...a) => maybeCanonicalOwner(...a),
  findDoingTicketForOwner: (...a) => findDoingTicketForOwner(...a),
  readAgentsRegistry: (...a) => readAgentsRegistry(...a),
  readAgentSessions: (...a) => readAgentSessions(...a),
  resolveAgentIdentifier: (...a) => resolveAgentIdentifier(...a),
  compareSessionsMostRecentFirst: (...a) => compareSessionsMostRecentFirst(...a),
  resolveEffectiveThreadId: (...a) => resolveEffectiveThreadId(...a),
  evaluateReadiness: (...a) => evaluateReadiness(...a),
  splitDependsOn: (...a) => splitDependsOn(...a),
  isRepoBackedCode: (...a) => isRepoBackedCode(...a),
  formatTransitiveBlockerDetails: (...a) => formatTransitiveBlockerDetails(...a),
  formatDependencyCycleList: (...a) => formatDependencyCycleList(...a),
  integerOrDefault: (...a) => integerOrDefault(...a),
  fail: (...a) => fail(...a),
});

function relativeCoordPath(filePath) {
  return path.relative(COORD_DIR, filePath).replace(/\\/g, "/");
}

function moveFileIfNeeded(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath || sourcePath === destinationPath || !fs.existsSync(sourcePath)) {
    return destinationPath;
  }
  ensureParentDir(destinationPath);
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    fs.rmSync(sourcePath, { force: true });
  }
  return destinationPath;
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

const {
  collectTicketWorktreeResidue,
  ensureRepoXCloseoutReady,
  findTicketProductWorktreeResidue,
} = createLifecycleRepoXCloseout({
  // COORD-512: gitTry (top-level import, no late-binding thunk) lets the
  // factory verify the control-plane ticket branch actually landed.
  // COORD-635: the root it verifies against is coordRepoRoot, not ROOT_DIR —
  // ADR-0008 makes the workspace container a non-repository.
  COORD_DIR, REPO_ROOTS, gitTry,
  // COORD-591: engine integrity surfaces + the governed plan change surface,
  // so engine-facing Repo-X closeouts fail closed while template-sync or
  // verify-engine report drift.
  enginePin: createEnginePin({ coordDir: COORD_DIR }),
  readTicketFileSurface: (ticketId) => planFiles(ticketId, ROOT_DIR),
  // COORD-667: the in-process workspace merge is irreversible by the governed
  // rollback (which restores files, not commits), so it is journaled through
  // the same external-side-effect channel a merged PR uses. Shares a physical
  // line with getRepoRoot deliberately: this root sits AT its fail-closed
  // prodloc high-water (2431), and the no-grandfather policy ratchets that cap
  // down via extraction rather than up for new wiring. This is a DI key, not
  // control flow, so it adds no logical surface to the composition root.
  recordExternalSideEffect: (...args) => recordGovernanceExternalSideEffect(...args), getRepoRoot: (...args) => getRepoRoot(...args),
  inferTicketIdFromPath: (...args) => inferTicketIdFromPath(...args),
  listGitWorktrees: (...args) => listGitWorktrees(...args),
  repoDisplayNameForCode: (...args) => repoDisplayNameForCode(...args),
});

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// COORD-296: resolveTicketGitContext / resolvePrUrlForTicket / resolveLifecyclePrRefs
// moved to lifecycle-evidence.js (injected via createLifecycleEvidence above) — the
// PR/EVIDENCE-resolution slice of the COORD-291 lifecycle-decomposition boundary. The
// review-state helpers readCommitSubject / commitSubjectAffiliatesWithTicket
// deliberately STAY here (COORD-088): they serve assertCommittedReviewState, not
// PR/evidence resolution.


function fail(message) {
  throw new GovernanceError(message);
}

const {
  codeContextCommand,
  codeDiffCommand,
  codeIndexCommand,
  codeSearchCommand,
  gatePlanCommand,
} = createLifecycleGateCodeCommands({
  gatePlan,
  fail: (...args) => fail(...args),
  getTicketRef: (...args) => getTicketRef(...args),
  readBoard: (...args) => readBoard(...args),
  readPlanRecord: (...args) => readPlanRecord(...args),
  readPlanState: (...args) => readPlanState(...args),
  toArray: (...args) => toArray(...args),
  updatePlanBlock: (...args) => updatePlanBlock(...args),
});

const commands = {
  recallCommand,
  signJournalCommand,
  insightsCommand,
  coverageRollupCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  codeIndexCommand,
  codeSearchCommand,
  codeContextCommand,
  codeDiffCommand,
  fleetGoldenPath,
  addFeatureProofCommand,
  addFinding,
  correctFindingRound,
  normalizeLock,
  addRepoGateCommand,
  addReviewCycleCommand,
  agentsCommand,
  approveTicket,
  auditLandings,
  auditWorktrees,
  autoSyncAfterLifecycle,
  pushOnFinalizeEnabled,
  pushAfterLifecycleSync,
  backfillPlanRecords,
  blockTicket,
  breakRuntimeLock,
  claim,
  claimAgent,
  cleanRuntime,
  cleanupHelperWorktrees,
  cleanupWorktree,
  commitTicket,
  contextPack,
  costReport,
  dispatchPlan,
  sequencerPlan,
  mergeQueue,
  doctor,
  dropFeatureProofCommand,
  explainTicket,
  fail,
  finalizeTicket,
  finishTicket,
  gatePlanCommand,
  heartbeat,
  landTicket,
  listTickets,
  lockAbandonTicket,
  logQuestion,
  fileTicket,
  markDone,
  moveReview,
  openFollowup,
  orchestratorCycle,
  otlpExport,
  pickTickets,
  planTicket,
  planWaves,
  prCreate,
  prMerge,
  prView,
  precheck,
  printCounts,
  printCurrentAgentId,
  printHelp,
  printInitiate,
  printNextId,
  conform,
  repairChain,
  migrateChainHash,
  verifyEngine,
  rebindAgent,
  rebuildBoardFromJournal,
  recentEvents,
  recommendTickets,
  reapGateProcs,
  reconcileGovernance,
  recordCost,
  recoverTicket,
  releaseTerminalTicketSession,
  registerPrompt,
  releaseAgent,
  releaseLock,
  rejectTicket,
  reopenTicket,
  resumeTicket,
  retireStaleDriftNotes,
  returnDoing,
  runCleanCheckoutGate,
  runSyncCommand,
  runTicketCycle,
  runtimeLockStatus,
  setFollowupRelation,
  setPrRefs,
  setRequirementClosureCommand,
  setReviewCyclesCommand,
  setTicketPriority,
  setTicketType,
  setWaiver,
  showAgentStatus,
  showTicket,
  splitTicket,
  startTicket,
  submitTicket,
  supersedeTicket,
  tierCommand,
  unblockTicket,
  unstartTicket,
  updateFinding,
  updatePlanBlock,
};

module.exports = {
  GovernanceError,
  commands,
  // COORD-478: public seam for the product bootstrap (`coord init`). When init
  // itself CREATES the starter board — the one moment that coordination state is
  // known-fresh — it anchors the journal genesis for it so the first governed
  // mutation on a fresh artifact is not refused by the COORD-273 lost-journal
  // seal. Idempotent: no-ops once the journal has a snapshot baseline.
  ensureGovernanceJournalBaseline,
  __testing: {
    resumeTicket,
    explainTicket,
    detectActiveSameOwnerOtherThread,
    detectColocatedForeignSessions,
    buildColocatedForeignSessionMessage,
    heartbeatAgeMsForSession,
    withTemporaryExecutionContext,
    collectTicketWorktreeResidue,
    extractPlanBlock,
    extractPlanBlockEntries,
    extractPlanBlocks,
    ensurePlanStub,
    inferRequiredReviewRound,
    inferTicketIdFromPath,
    isPlanSectionBoundary,
    isRecoverableGovernanceDriftPath,
    buildInitiateSummary,
    buildStartOwnershipRaceMessage,
    buildDefaultGovernancePlan,
    resolveRepoCodeForTicket,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
    buildAgentStatusPayload,
    reapIdleAutoClaimedProviderStubs,
    releaseTerminalTicketSession,
    rebindAgent,
    rebuildBoardFromJournal,
    terminalJournalStatusForTicket,
    collectTicketsWithJournalDrift,
    repoPrefixForCode,
    repoPrefixesForCode,
    isRepoBackedCode,
    isProductRepo,
    repoNameForCode,
    repoDisplayNameForCode,
    repoCliAliasesForCode,
    repoCodeForCliRepoArg,
    resolveTicketBaseRef,
    gitCommitishExists,
    repoBootstrapLabel,
    buildDependencyBootstrapGuidance,
    formatMissingStartBaseRefMessage,
    repoCodeForLockRepoName,
    normalizeTestingInfraAuditPath,
    buildDoctorResolutionGuidance,
    buildExplainQuestionsGuidance,
    deriveGovernanceReadiness,
    isLightLaneEligible,
    isProceduralDocPath,
    resolveTicketLightLane,
    classifyQuestionOperationalType,
    classifyQuestionSeverity,
    classifyQuestionAgingBucket,
    parseQuestionRow,
    readQuestionRows,
    readOrchestratorQuestionRows,
    readActiveOrchestratorQuestionRows,
    isActiveOrchestratorQuestionRow,
    buildQuestionQueueReport,
    parseTemplateFeedbackRowsFromText,
    readTemplateFeedbackRows,
    ticketNeedsTemplateFeedback,
    latestDoneTimestampByTicket,
    collectTemplateFeedbackAlerts,
    formatTemplateFeedbackAlerts,
    collectStaleTemplateFeedbackErrors,
    formatBucketCounts,
    splitGovernanceProvenanceDrift,
    extractDriftMutationStage,
    buildMergedButNotDoneReport,
    buildOrchestratorExceptionSloReport,
    buildPromptWaiverCommand,
    buildStartPlanBootstrapCommand,
    buildStartPlanSeedUpdate,
    detectCheckoutRuntimeRole,
    canonicalAuthorityWriteIssue,
    assertCanonicalAuthorityWriteAllowed,
    buildPlanStatusPayload,
    planTicket,
    buildTicketNextCommands,
    buildSequencerPlan,
    detectMergeQueueAmbiguities,
    buildMergeQueueState,
    collectGovernedSnapshotFilePaths,
    collectStartReadinessBlockers,
    collectStartReadinessAdvisories,
    auditCoordWorktrees,
    diffGovernanceSnapshots,
    doctorFix,
    recoverTicket,
    evaluateReadiness,
    parsePlanBlockToRecord,
    renderPlanRecordBlock,
    persistReturnDoingState,
    readPlanListField,
    readAgentsRegistry,
    readPlanRecord,
    repairPlanRecord,
    readPlanScalarField,
    readAgentSessions,
    normalizeLegacyPlanRecordShape,
    normalizeSelfReviewCycleLine,
    detectGovernanceProvenanceDrift,
    detectOutOfBandBoardMutation,
    advanceGovernanceProvenanceBaseline,
    isCoordinationStatePath,
    isPathWithinSyncScope,
    gitIgnoredDriftPaths,
    writeFileAtomicSync,
    repairTornGovernanceEventLogTail,
    readGovernanceEventLog,
    appendGovernanceEvent,
    verifyGovernanceChain,
    planGovernanceChainRepair,
    restampGovernanceChainFrom,
    repairGovernanceChain,
    migrateGovernanceChainHash,
    migrateChainHash,
    sha256: journalSha256,
    hashWithAlg,
    eventHashAlg,
    CHAIN_MIGRATION_COMMAND,
    CHAIN_VERIFIER_VERSION,
    governanceChainRepairBackupPath,
    formatOutOfBandBoardMutationMessage,
    hashGovernanceEventRecord,
    hashGovernanceEventLine,
    canonicalEventSerialization,
    isChainedEvent,
    readLatestGovernanceEvent,
    readLatestGovernanceSnapshotSource,
    parseGovernanceEventLogLine,
    governanceSnapshotArtifactPath,
    writeGovernanceSnapshotArtifact,
    writeGovernanceSnapshotCheckpoint,
    ensureGovernanceJournalBaseline,
    summarizeIdentityForEvent,
    inferTicketStatus,
    formatGovernanceExternalSideEffect,
    formatGovernanceDriftMessage,
    describeGovernanceMutation,
    detectGovernanceQuestionAuthor,
    buildGovernanceDriftQuestion,
    appendGovernanceDriftQuestion,
    appendGovernanceProvenanceIssues,
    isRuntimeLedgerDriftPath,
    governanceRestorePointPath,
    persistGovernanceRestorePoint,
    recoverCrashedGovernanceMutation,
    findCommittedMutationByIdempotencyKey,
    recordGovernanceCollision,
    buildGovernanceSnapshot,
    captureGovernanceRestorePoint,
    ensureCurrentAgentIdentity,
    resolveCurrentAgentId,
    findDoingTicketForOwner,
    findActiveProviderSessions,
    hasPromptWaiver,
    defaultTicketPromptRelPath,
    ticketPromptRelPathExists,
    ensurePromptCoverageOrDiscover,
    registerPrompt,
    appendQuestionRowText,
    hasOnlyScaffoldSelfReviewCycles,
    isDoingStatus,
    getOrCreateSessionToken,
    detectCwdTicketClaimHazard,
    resolveEffectiveThreadId,
    resolveOwnerIdentity,
    describeTicketMutationOwnershipIssue,
    assertRegisteredBoundOwner,
    assertTicketMutationOwnership,
    ensureTicketMutationOwnership,
    assertTicketRepairOwnership,
    ensureDoingTicketLockIntegrity,
    runtimeSessionFingerprint,
    validateRequirementClosureEntry,
    validateFeatureProofEntry,
    normalizeFeatureProofEntryForTicket,
    resolveGateScript,
    resolveGateInvocation,
    resolveGateArtifactDir,
    resolveRepoIntegrationBranch,
    detectGatePackageManager,
    isInsideGitWorkTree,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
    preflightPrBranch,
    refreshLockHead,
    readJsonFileState,
    readLockFileOrFail,
    tryReclaimStaleDirectoryLock,
    describeDirectoryLockHolder,
    readModelPrices,
    resolveModelPrice,
    estimateCostUsd,
    collectCostObservations,
    aggregateCost,
    loadTicketPrecheckProbes,
    runPrecheckProbe,
    classifyPrecheckVerdict,
    precheck,
    parseTicketPromptSections,
    minePriorProofsAndInvariants,
    ticketFilesIntersect,
    buildContextPack,
    contextPack,
    readTierPolicy,
    resolveTicketTier,
    tierEvidenceMinimums,
    effectiveTierMinimum,
    tierCommand,
    parseTicketDependsOn,
    planWaves,
    dispatchCachePrefixMarker,
    dispatchPrecheckVerdict,
    dispatchActionForTicket,
    dispatchPlan,
    runtimeLockStatus,
    breakRuntimeLock,
    detectRollbackDrift,
    collectCleanRuntimeTargets,
    cleanRuntime,
    withPreparedTicketWorkspace,
    cleanupPreparedTicketWorkspace,
    writeLock,
    rebindTicketLock,
    canonicalSyncablePaths,
    computeSyncDelta,
    buildCanonicalDerivedDriftError,
    commitCanonicalDelta,
    collectReviewPlanReadinessIssues,
    collectSubmitReadinessBlockers,
    submitRequiresReviewPlanCheck,
    shouldIgnoreMergeFailureAfterSuccessfulMerge,
    readCanonicalTextFile,
    readCanonicalJsonFile,
    resolveFollowupPromptPath,
    replacePlanBlock,
    restoreGovernanceRestorePoint,
    synthesizeHistoricalPlanRecord,
    syncPlanRecordFromBlock,
    replaceSelfReviewCycles,
    upsertListItem,
    withGovernanceMutation,
    writeCanonicalTextFile,
    writeCanonicalJsonFile,
    readGovernanceSnapshotArtifact,
    readGovernanceSnapshotCheckpoint,
    readLatestGovernanceEvent,
    summarizeGovernanceEvent,
    materializeGovernanceEvent,
    recordGovernanceExternalSideEffect,
    recentEvents,
    assertCurrentTicketLockIntegrity,
    mergedPrAffiliatesWithTicket,
    refsContainMergedPrForTicket,
    readCommitSubject,
    commitSubjectAffiliatesWithTicket,
    resolveCommitishInRepo,
    resolveSourceCommitSha,
    isCommitAncestorOfRef,
    resolveLandingBaseRef,
    resolvePrLandingBaseRef,
    assertAlreadyLandedNoPrReconcileReady,
    detectSupersedeLandingBypass,
    applyFollowupRelation,
    appendReviewFollowupPlan,
    addReviewCycleCommand,
    setReviewCyclesCommand,
    setRequirementClosureCommand,
    addFeatureProofCommand,
    dropFeatureProofCommand,
    addRepoGateCommand,
    classifyGateAttribution,
    formatRepoGateEntry,
    extractDriftSinceTimestamp,
    planStaleDriftNoteRetirement,
    applyRetireStaleDriftNotes,
    findLatestGovernanceBaselineTimestamp,
    retireStaleDriftNotes,
    applyPlanUpdateOptionsToRecord,
    isScaffoldWorktreeIntendedFile,
    applyLandingAuditBackfill,
    ensurePlanBlockForUpdate,
    ensurePlanRecordForUpdate,
    classifyLandingRecord,
    collectLandingAuditReport,
    deriveFeatureProofAudit,
    deriveTestingInfrastructureAudit,
    ensureFeatureProofLandingAudit,
    ensureTestingInfrastructureLandingAudit,
    assertLandingIntegrity,
    persistMergedPrLandingSnapshot,
    assertCommittedReviewState,
    formatLandingAuditSummary,
    isTestingInfrastructureTicket,
    isCompleteLockPayload,
    materializePlanBlockFromRecord,
    normalizeFollowupRelation,
    planRecordHasOnlyScaffoldSelfReviewCycles,
    resolveDoctorScope,
    resolveDoctorOwnerScope,
    requiresFeatureProofGovernance,
    updateCanonicalPlanState,
    writePlanCompatibilityBlockFromRecord,
    allocateAgentSimpleId,
    allocateLiveSessionId,
    collectReferencedAgentIdNumbers,
    claimTicket,
    resolveHumanAdminOverride,
    nextTicketId,
    withBoardTransaction,
    printNextId,
    splitTicket,
    openFollowup,
    fileTicket,
    ghPrView,
    isTransientGhError,
    runGh,
    setRunGhForTesting,
    resetRunGhForTesting,
    setSleepSyncForTesting,
    resetSleepSyncForTesting,
    readBoard,
    writeBoard,
    unstartTicket,
    lockAbandonTicket,
    blockTicket,
    unblockTicket,
    supersedeTicket,
    collectUnstartEvidenceBlockers,
    resolveWorktreeBaseCompareRef,
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
    parsePromptLikelyFiles,
    seedStartIntendedFilesFromPrompt,
    readRecordedIntendedFilesScaffoldSeed,
    parseDocumentedGovVerbs,
    parseDocumentedAgentVerbs,
    collectDispatchCommandVerbs,
    collectParseFlagsFlags,
    collectAgentFacadeVerbs,
    collectAgentWrapperFlags,
    runVerbParityCheck,
    parsePromptPreconditions,
    classifyPreconditionArtifact,
    verifyPromptPreconditions,
    assertPromptPreconditionsResolve,
    paths: createLifecycleTestingPaths({ state, REPO_ROOTS, REPO_INTEGRATION_BRANCHES, DEFAULT_PATHS }),
    assertReviewPlanReady,
  },
};
