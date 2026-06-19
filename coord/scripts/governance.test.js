const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const governanceModule = require("./governance.js");
const { GovernanceError, executeCommand, __testing } = governanceModule;
const { withCleanRuntimeFixture, runGit, writeRepoFile, createTempGitRepo, createTempGitRepoWithOrigin, createMinimalGovernanceWorkspace, setupCoord003Workspace, readBoardRow, withCanonicalTicketPrompt, withRegisterPromptHarness } = require("./governance-test-utils.js");

// Hermetic session env: these tests control provider session/thread ids
// explicitly. Strip any ambient id the host injects (e.g. Claude Code exports
// CLAUDE_CODE_SESSION_ID) so it cannot leak into fingerprint/identity tests.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const EXPECTED_TESTING_KEYS = `
addFeatureProofCommand
addRepoGateCommand
addReviewCycleCommand
aggregateCost
allocateAgentSimpleId
allocateLiveSessionId
appendGovernanceEvent
appendQuestionRowText
appendReviewFollowupPlan
applyFollowupRelation
applyLandingAuditBackfill
applyPlanUpdateOptionsToRecord
applyRetireStaleDriftNotes
assertAlreadyLandedNoPrReconcileReady
assertCommittedReviewState
assertCurrentTicketLockIntegrity
assertLandingIntegrity
assertPromptPreconditionsResolve
assertRegisteredBoundOwner
assertReviewPlanReady
assertTicketMutationOwnership
assertTicketRepairOwnership
auditCoordWorktrees
autoSyncAfterLifecycle
blockTicket
breakRuntimeLock
buildAgentStatusPayload
buildAutoSyncMessage
buildCanonicalDerivedDriftError
buildContextPack
buildDefaultGovernancePlan
buildDependencyBootstrapGuidance
buildDoctorResolutionGuidance
buildExplainQuestionsGuidance
buildGovernanceSnapshot
buildInitiateSummary
buildMergedButNotDoneReport
buildNoPrCloseoutPlanUpdate
buildOrchestratorExceptionSloReport
buildPlanStatusPayload
buildPrCloseoutPlanUpdate
buildPromptWaiverCommand
buildQuestionQueueReport
buildReleaseCandidates
buildStartOwnershipRaceMessage
buildStartPlanBootstrapCommand
buildStartPlanSeedUpdate
buildTicketNextCommands
canonicalSyncablePaths
captureGovernanceRestorePoint
claimTicket
classifyGateAttribution
classifyLandingRecord
classifyPrecheckVerdict
classifyPreconditionArtifact
classifyQuestionAgingBucket
classifyQuestionOperationalType
classifyQuestionSeverity
cleanRuntime
cleanupPreparedTicketWorkspace
collectAgentFacadeVerbs
collectAgentWrapperFlags
collectCleanRuntimeTargets
collectCostObservations
collectDispatchCommandVerbs
collectGovernedSnapshotFilePaths
collectLandingAuditReport
collectParseFlagsFlags
collectReferencedAgentIdNumbers
collectReviewPlanReadinessIssues
collectStaleTemplateFeedbackErrors
collectStartReadinessBlockers
collectSubmitReadinessBlockers
collectTemplateFeedbackAlerts
collectTicketWorktreeResidue
collectTicketsWithJournalDrift
collectUnstartEvidenceBlockers
commitCanonicalDelta
commitSubjectAffiliatesWithTicket
computeSyncDelta
contextPack
defaultTicketPromptRelPath
deriveFeatureProofAudit
deriveGovernanceReadiness
deriveTestingInfrastructureAudit
describeDirectoryLockHolder
describeTicketMutationOwnershipIssue
detectActiveSameOwnerOtherThread
detectCwdTicketClaimHazard
detectGatePackageManager
detectGovernanceProvenanceDrift
detectRollbackDrift
detectSupersedeLandingBypass
diffGovernanceSnapshots
dispatchActionForTicket
dispatchCachePrefixMarker
dispatchCommand
dispatchPlan
dispatchPrecheckVerdict
doctorFix
dropFeatureProofCommand
effectiveTierMinimum
ensureCurrentAgentIdentity
ensureDoingTicketLockIntegrity
ensureFeatureProofLandingAudit
ensurePlanBlockForUpdate
ensurePlanRecordForUpdate
ensurePlanStub
ensurePromptCoverageOrDiscover
ensureTestingInfrastructureLandingAudit
ensureTicketMutationOwnership
estimateCostUsd
evaluateReadiness
explainTicket
extractDriftMutationStage
extractDriftSinceTimestamp
extractPlanBlock
extractPlanBlockEntries
extractPlanBlocks
finalizeTicket
findActiveProviderSessions
findDoingTicketForOwner
findLatestGovernanceBaselineTimestamp
finishTicket
formatBucketCounts
formatLandingAuditSummary
formatMissingStartBaseRefMessage
formatRepoGateEntry
formatTemplateFeedbackAlerts
getOrCreateSessionToken
ghPrView
gitCommitishExists
gitIgnoredDriftPaths
governanceRestorePointPath
hasOnlyScaffoldSelfReviewCycles
hasPromptWaiver
hashGovernanceEventRecord
inferRequiredReviewRound
inferTicketIdFromPath
isActiveOrchestratorQuestionRow
isCommitAncestorOfRef
isCompleteLockPayload
isDoingStatus
isInsideGitWorkTree
isPlanSectionBoundary
isProductRepo
isRecoverableGovernanceDriftPath
isRepoBackedCode
isScaffoldWorktreeIntendedFile
isTestingInfrastructureTicket
isTransientGhError
landTicket
latestDoneTimestampByTicket
loadTicketPrecheckProbes
lockAbandonTicket
markDone
materializeGovernanceEvent
materializePlanBlockFromRecord
mergedPrAffiliatesWithTicket
minePriorProofsAndInvariants
moveReview
nextTicketId
normalizeFeatureProofEntryForTicket
normalizeFollowupRelation
normalizeLegacyPlanRecordShape
normalizeSelfReviewCycleLine
normalizeTestingInfraAuditPath
openFollowup
parseDocumentedAgentVerbs
parseDocumentedGovVerbs
parseFlags
parsePlanBlockToRecord
parsePromptLikelyFiles
parsePromptPreconditions
parseQuestionRow
parseTemplateFeedbackRowsFromText
parseTicketDependsOn
parseTicketPromptSections
paths
persistGovernanceRestorePoint
persistMergedPrLandingSnapshot
persistReturnDoingState
planGovernanceChainRepair
planRecordHasImplicitIntendedFilesScaffoldPlaceholder
planRecordHasOnlyScaffoldSelfReviewCycles
planStaleDriftNoteRetirement
planTicket
planWaves
precheck
preflightPrBranch
printNextId
pushAfterLifecycleSync
pushOnFinalizeEnabled
readActiveOrchestratorQuestionRows
readAgentSessions
readAgentsRegistry
readBoard
readCanonicalJsonFile
readCanonicalTextFile
readCommitSubject
readGovernanceEventLog
readGovernanceSnapshotArtifact
readGovernanceSnapshotCheckpoint
readJsonFileState
readLatestGovernanceEvent
readLockFileOrFail
readModelPrices
readOrchestratorQuestionRows
readPlanListField
readPlanRecord
readPlanScalarField
readQuestionRows
readRecordedIntendedFilesScaffoldSeed
readTemplateFeedbackRows
readTierPolicy
reapIdleAutoClaimedProviderStubs
rebindAgent
rebindTicketLock
rebuildBoardFromJournal
recentEvents
recordGovernanceExternalSideEffect
recoverCrashedGovernanceMutation
recoverTicket
refreshLockHead
refsContainMergedPrForTicket
registerPrompt
renderPlanRecordBlock
repairGovernanceChain
repairTornGovernanceEventLogTail
replacePlanBlock
replaceSelfReviewCycles
repoBootstrapLabel
repoCliAliasesForCode
repoCodeForCliRepoArg
repoCodeForLockRepoName
repoDisplayNameForCode
repoNameForCode
repoPrefixForCode
repoPrefixesForCode
requiresFeatureProofGovernance
resetRunGhForTesting
resetSleepSyncForTesting
resolveCommitishInRepo
resolveCurrentAgentId
resolveDoctorOwnerScope
resolveDoctorScope
resolveEffectiveThreadId
resolveFollowupPromptPath
resolveGateArtifactDir
resolveGateInvocation
resolveGateScript
resolveHumanAdminOverride
resolveLandingBaseRef
resolveModelPrice
resolveOwnerIdentity
resolvePrLandingBaseRef
resolveRepoCodeForTicket
resolveRepoIntegrationBranch
resolveSourceCommitSha
resolveTicketBaseRef
resolveTicketTier
resolveWorktreeBaseCompareRef
restoreGovernanceRestorePoint
resumeTicket
retireStaleDriftNotes
runGh
runPrecheckProbe
runSyncCommand
runVerbParityCheck
runtimeLockStatus
runtimeSessionFingerprint
seedStartIntendedFilesFromPrompt
setRequirementClosureCommand
setReviewCyclesCommand
setRunGhForTesting
setSleepSyncForTesting
shouldIgnoreMergeFailureAfterSuccessfulMerge
splitGovernanceProvenanceDrift
splitTicket
submitRequiresReviewPlanCheck
summarizeGovernanceEvent
supersedeTicket
syncPlanRecordFromBlock
synthesizeHistoricalPlanRecord
terminalJournalStatusForTicket
ticketFilesIntersect
ticketNeedsTemplateFeedback
ticketPromptRelPathExists
tierCommand
tierEvidenceMinimums
tryReclaimStaleDirectoryLock
unblockTicket
unstartTicket
updateCanonicalPlanState
upsertListItem
validateFeatureProofEntry
validateRequirementClosureEntry
verifyGovernanceChain
verifyPromptPreconditions
withGovernanceMutation
withPreparedTicketWorkspace
withTemporaryExecutionContext
writeBoard
writeCanonicalJsonFile
writeCanonicalTextFile
writeFileAtomicSync
writeLock
writePlanCompatibilityBlockFromRecord
`.trim().split("\n");

test("__testing export surface matches the frozen governance facade key set", () => {
  assert.deepEqual(Object.keys(__testing).sort(), EXPECTED_TESTING_KEYS);
});

test("buildDependencyBootstrapGuidance is registry-generalized (no hardcoded B/F→repo names)", () => {
  const repo = createTempGitRepo("ebmr-bootstrap-guidance-", {
    "README.md": "backend\n",
  }, "seed");
  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.REPO_ROOTS = { ...original.REPO_ROOTS, B: repo.repoRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "dev" };

  try {
    // Repo label derived from the registry (repoNameForCode), not a hardcoded
    // "msrv"/"frontend" literal. base_ref is the template default "dev".
    assert.deepEqual(__testing.buildDependencyBootstrapGuidance("B", "/tmp/wt"), {
      base_ref: "dev",
      commands: [
        `git -C ${__testing.repoNameForCode("B")} fetch origin dev`,
        "pnpm --dir /tmp/wt install --frozen-lockfile",
      ],
    });
    assert.equal(__testing.repoBootstrapLabel("B"), __testing.repoNameForCode("B"));
    // Non-repo-backed codes return null guidance / coord label.
    assert.equal(__testing.buildDependencyBootstrapGuidance("X", "/tmp/wt"), null);
    assert.equal(__testing.repoBootstrapLabel("X"), "coord");
  } finally {
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
});

test("ensureGitWorktree fails closed with a generalized missing-base-ref message", () => {
  const repo = createTempGitRepo("ebmr-missing-baseref-", {
    "README.md": "backend\n",
  }, "seed");
  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.REPO_ROOTS = { ...original.REPO_ROOTS, B: repo.repoRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "dev" };
  const repoLabel = __testing.repoNameForCode("B");
  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-900");

  try {
    // gitCommitishExists is honest about an existing vs missing ref.
    assert.equal(__testing.gitCommitishExists(repo.repoRoot, "dev"), true);
    assert.equal(__testing.gitCommitishExists(repo.repoRoot, "missing-base"), false);

    const message = __testing.formatMissingStartBaseRefMessage("B", repo.repoRoot, "missing-base");
    assert.match(message, new RegExp(`Cannot create governed ${repoLabel} worktree from missing-base`));
    assert.match(message, new RegExp(`git -C ${repoLabel} fetch origin dev`));
    assert.match(message, /install --frozen-lockfile/);

    assert.throws(
      () =>
        __testing.withPreparedTicketWorkspace(
          {
            repoCode: "B",
            worktree,
            branch: "agent/agenta01-be-900-x",
            base: "missing-base",
          },
          () => {
            throw new GovernanceError("should not reach work fn");
          }
        ),
      (error) =>
        error instanceof GovernanceError &&
        // COORD-125: when the origin fetch fails AND no local base ref (neither
        // origin/<base> nor a local <base> branch) resolves, there is genuinely
        // no base to cut from, so start fails closed with the generalized
        // missing-base message (no worktree, no silent stale-base fallback).
        new RegExp(`Cannot create governed ${repoLabel} worktree from missing-base`).test(error.message)
    );
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
});

test("GCV-2: ensureGitWorktree bases a new ticket branch on origin/<baseRef>, not stale local dev", () => {
  const repo = createTempGitRepoWithOrigin("ebmr-gcv2-stale-base-", {
    "README.md": "backend\n",
  }, "seed");
  const staleHead = repo.head; // local dev will be pinned here (stale)

  // Advance origin/dev to a new commit, then rewind local dev so the
  // local branch is behind origin (the FE-385/FE-386 condition).
  writeRepoFile(repo.repoRoot, "fresh.txt", "origin-only change\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "origin-only advance"]);
  const originHead = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(repo.repoRoot, ["push", "origin", "dev"]);
  runGit(repo.repoRoot, ["reset", "--hard", staleHead]);
  assert.notEqual(originHead, staleHead);
  assert.equal(runGit(repo.repoRoot, ["rev-parse", "dev"]), staleHead); // local dev IS stale

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.REPO_ROOTS = { ...original.REPO_ROOTS, B: repo.repoRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "dev" };
  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-901");

  try {
    let worktreeHead = null;
    __testing.withPreparedTicketWorkspace(
      { repoCode: "B", worktree, branch: "agent/agenta01-be-901-x", base: "dev" },
      () => {
        worktreeHead = runGit(worktree, ["rev-parse", "HEAD"]);
      }
    );
    // The governed worktree must be cut from origin/dev (fresh), never the
    // stale local dev ref.
    assert.equal(worktreeHead, originHead, "worktree should be based on origin/dev");
    assert.notEqual(worktreeHead, staleHead, "worktree must NOT be based on stale local dev");
  } finally {
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
});

test("COORD-125: ensureGitWorktree gracefully falls back to the LOCAL base (with a warning) when origin fetch fails — never hard-fails offline", () => {
  // Reproduction: a local origin/<base> tracking ref already exists (from a
  // prior successful fetch/push) but the remote URL is broken now, so
  // `git fetch` fails (the offline/unreachable case). The fresh-from-origin
  // path (GCV-2) is preferred when reachable, but COORD-125 must NOT hard-fail
  // a local/offline workflow: it falls back to the local base ref and warns.
  const repo = createTempGitRepoWithOrigin("ebmr-coord125-offline-", {
    "README.md": "backend\n",
  }, "seed");
  // Confirm the tracking ref exists locally (set by the push during fixture
  // setup) so a safe local fallback base is available.
  assert.equal(__testing.gitCommitishExists(repo.repoRoot, "origin/dev"), true);
  // Break the remote URL so any subsequent fetch fails (offline).
  runGit(repo.repoRoot, ["remote", "set-url", "origin", "/tmp/does-not-exist-ebmr-coord125"]);
  assert.equal(__testing.gitCommitishExists(repo.repoRoot, "origin/dev"), true);

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.REPO_ROOTS = { ...original.REPO_ROOTS, B: repo.repoRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "dev" };
  const worktree = path.join(repo.repoRoot, ".worktrees", "agenta01", "BE-902");

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  try {
    const result = __testing.withPreparedTicketWorkspace(
      {
        repoCode: "B",
        worktree,
        branch: "agent/agenta01-be-902-x",
        base: "dev",
      },
      (prepared) => prepared
    );
    // Offline start succeeded (no hard-fail): the worktree + branch exist,
    // cut from the local origin/dev tracking ref, with a clear staleness warning.
    assert.equal(result.createdWorktree, true);
    assert.equal(result.createdBranch, true);
    assert.equal(fs.existsSync(worktree), true);
    assert.ok(
      warnings.some((m) => /could not fetch origin dev/i.test(m) && /LOCAL base/i.test(m)),
      "offline fallback must emit a clear staleness warning"
    );
  } finally {
    console.warn = originalWarn;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
});

test("preflightPrBranch fails clearly when the branch is not pushed", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-", { "README.md": "seed\n" });
  writeRepoFile(repo.repoRoot, "feature.txt", "delta\n");
  runGit(repo.repoRoot, ["checkout", "-b", "agent/test-ticket"]);
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "feature"]);

  assert.throws(
    () => __testing.preflightPrBranch(repo.repoRoot, "agent/test-ticket", "dev", {}),
    /is not published on origin/
  );
});

test("preflightPrBranch fails clearly when git cannot compare the requested refs", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-bad-ref-", { "README.md": "seed\n" });

  assert.throws(
    () => __testing.preflightPrBranch(repo.repoRoot, "missing-branch", "dev", {}),
    (error) => error instanceof GovernanceError && /Failed to compare missing-branch against origin\/dev/i.test(error.message)
  );
});

test("preflightPrBranch pushes from options.pushCwd so pre-push hooks run against the worktree, not the repo root", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-worktree-", { "README.md": "seed\n" });
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-worktree-wt-"));
  fs.rmSync(worktreePath, { recursive: true, force: true });
  const branch = "agent/test-ticket-pushcwd";
  runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktreePath, "dev"]);
  writeRepoFile(worktreePath, "feature.txt", "worktree delta\n");
  runGit(worktreePath, ["add", "."]);
  runGit(worktreePath, ["commit", "-m", "feature from worktree"]);

  const hookLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-hooklog-")),
    "hook.log",
  );
  const hookPath = path.join(repo.repoRoot, ".git", "hooks", "pre-push");
  fs.writeFileSync(
    hookPath,
    `#!/usr/bin/env sh\nprintf 'cwd=%s\\n' "$PWD" > "${hookLogPath}"\nprintf 'toplevel=%s\\n' "$(git rev-parse --show-toplevel)" >> "${hookLogPath}"\nexit 0\n`,
    "utf8",
  );
  fs.chmodSync(hookPath, 0o755);

  __testing.preflightPrBranch(repo.repoRoot, branch, "dev", { push: true, pushCwd: worktreePath });

  const hookLog = fs.readFileSync(hookLogPath, "utf8");
  const cwdLine = hookLog.match(/^cwd=(.+)$/m);
  const toplevelLine = hookLog.match(/^toplevel=(.+)$/m);
  assert.ok(cwdLine, `pre-push hook did not record cwd; got:\n${hookLog}`);
  assert.ok(toplevelLine, `pre-push hook did not record toplevel; got:\n${hookLog}`);
  assert.equal(
    fs.realpathSync(cwdLine[1]),
    fs.realpathSync(worktreePath),
    "pre-push hook cwd should be the worktree path passed as pushCwd",
  );
  assert.equal(
    fs.realpathSync(toplevelLine[1]),
    fs.realpathSync(worktreePath),
    "git rev-parse --show-toplevel inside the hook should resolve to the worktree",
  );

  assert.equal(
    runGit(repo.remoteRoot, ["rev-parse", `refs/heads/${branch}`]),
    runGit(worktreePath, ["rev-parse", "HEAD"]),
    "origin should now have the agent branch at the worktree HEAD",
  );
});

test("preflightPrBranch falls back to repoRoot when options.pushCwd is not set", () => {
  const repo = createTempGitRepoWithOrigin("gov-pr-preflight-fallback-", { "README.md": "seed\n" });
  const branch = "agent/test-ticket-fallback";
  runGit(repo.repoRoot, ["checkout", "-b", branch]);
  writeRepoFile(repo.repoRoot, "feature.txt", "repo-root delta\n");
  runGit(repo.repoRoot, ["add", "."]);
  runGit(repo.repoRoot, ["commit", "-m", "feature from repo root"]);

  const hookLogPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gov-pr-preflight-fallback-hooklog-")),
    "hook.log",
  );
  const hookPath = path.join(repo.repoRoot, ".git", "hooks", "pre-push");
  fs.writeFileSync(
    hookPath,
    `#!/usr/bin/env sh\nprintf 'cwd=%s\\n' "$PWD" > "${hookLogPath}"\nexit 0\n`,
    "utf8",
  );
  fs.chmodSync(hookPath, 0o755);

  __testing.preflightPrBranch(repo.repoRoot, branch, "dev", { push: true });

  const hookLog = fs.readFileSync(hookLogPath, "utf8");
  const cwdLine = hookLog.match(/^cwd=(.+)$/m);
  assert.ok(cwdLine, `pre-push hook did not record cwd; got:\n${hookLog}`);
  assert.equal(
    fs.realpathSync(cwdLine[1]),
    fs.realpathSync(repo.repoRoot),
    "pre-push hook cwd should fall back to repoRoot when pushCwd is omitted",
  );
});

test("assertCommittedReviewState rejects source commits already landed on origin/dev when local dev is stale", () => {
  const backendRepo = createTempGitRepoWithOrigin("ebmr-review-state-origin-", {
    "package.json": JSON.stringify({ name: "@template/backend" }, null, 2),
  }, "backend seed");
  runGit(backendRepo.repoRoot, ["checkout", "-b", "agent/codexa34-backend-904-review-state"]);
  writeRepoFile(backendRepo.repoRoot, "feature.txt", "review-state-remote\n");
  runGit(backendRepo.repoRoot, ["add", "."]);
  runGit(backendRepo.repoRoot, ["commit", "-m", "MSRV-904 landed before review"]);
  const sourceHead = runGit(backendRepo.repoRoot, ["rev-parse", "HEAD"]);
  runGit(backendRepo.repoRoot, ["checkout", "dev"]);
  runGit(backendRepo.repoRoot, ["merge", "--ff-only", sourceHead]);
  runGit(backendRepo.repoRoot, ["push", "origin", "dev"]);
  runGit(backendRepo.repoRoot, ["reset", "--hard", "HEAD~1"]);
  const worktreePath = path.join(backendRepo.repoRoot, ".worktrees", "codexa34", "MSRV-904");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(backendRepo.repoRoot, ["worktree", "add", worktreePath, "agent/codexa34-backend-904-review-state"]);

  const originalRepoRoots = { ...__testing.paths.REPO_ROOTS };
  const originalBranches = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  __testing.paths.REPO_ROOTS = {
    ...originalRepoRoots,
    B: backendRepo.repoRoot,
  };
  __testing.paths.REPO_INTEGRATION_BRANCHES = {
    ...originalBranches,
    B: "dev",
  };

  try {
    assert.throws(
      () => __testing.assertCommittedReviewState(
        "MSRV-904",
        { Repo: "B", Type: "feature" },
        {
          worktree: worktreePath,
          branch: "agent/codexa34-backend-904-review-state",
          owner: "codexa34",
          repo: __testing.repoNameForCode("B"),
          head: sourceHead,
        },
        { sourceCommit: sourceHead }
      ),
      new RegExp(`already appears landed on ${__testing.repoNameForCode("B").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/origin\\/dev`)
    );
  } finally {
    __testing.paths.REPO_ROOTS = originalRepoRoots;
    __testing.paths.REPO_INTEGRATION_BRANCHES = originalBranches;
  }
});

test("ensureDoingTicketLockIntegrity recreates a missing doing lock from the canonical worktree", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-recreate-doing-lock-"));
  const repo = createTempGitRepo("ebmr-governance-doing-lock-repo-", {
    "README.md": "lock recreation fixture\n",
  });
  const ticketId = "IMP-997";
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId);
  runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa04-imp-997-fix", worktree, "HEAD"]);

  const boardPath = path.join(tempDir, "tasks.json");
  const locksDir = path.join(tempDir, "locks");
  const legacyLocksDir = path.join(tempDir, "legacy-locks");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(legacyLocksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{
      heading: "Backend",
      rows: [{
        ID: ticketId,
        Repo: "B",
        Status: "doing",
        Owner: "codexa04",
        Description: "Repair lost lock",
        "Depends On": "",
      }],
    }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-current",
      agent_id: "a04",
      handle: "codexa04",
      board_path: boardPath,
      thread_id: "codex-thread-recover-lock",
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: "active",
    },
  ], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = legacyLocksDir;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.REPO_ROOTS = {
    ...__testing.paths.REPO_ROOTS,
    B: repo.repoRoot,
  };
  process.env.CODEX_THREAD_ID = "codex-thread-recover-lock";
  delete process.env.AGENT_THREAD_ID;

  try {
    const row = {
      ID: ticketId,
      Repo: "B",
      Status: "doing",
      Owner: "codexa04",
      Description: "Repair lost lock",
    };
    const lock = __testing.ensureDoingTicketLockIntegrity(ticketId, row, {});
    assert.equal(lock.owner, "codexa04");
    assert.equal(lock.branch, "agent/codexa04-imp-997-fix");
    assert.equal(lock.worktree, worktree);
    assert.equal(lock.session_id, "a04-current");
    assert.equal(fs.existsSync(path.join(locksDir, `${ticketId}.lock`)), true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("withPreparedTicketWorkspace removes a newly created Repo X workspace when later validation fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-workspace-cleanup-"));
  const worktree = path.join(tempDir, ".worktrees", "codexa00", "DEBT-048");

  assert.throws(
    () =>
      __testing.withPreparedTicketWorkspace(
        {
          repoCode: "X",
          worktree,
          branch: "agent/codexa00-debt-048",
          base: "dev",
        },
        () => {
          assert.equal(fs.existsSync(worktree), true);
          throw new GovernanceError("synthetic failure");
        }
      ),
    (error) => error instanceof GovernanceError && /synthetic failure/.test(error.message)
  );

  assert.equal(fs.existsSync(worktree), false);
});

test("executeCommand captures governance stdout while restoring cwd and env overrides", () => {
  const originalCwd = process.cwd();
  const originalThreadId = process.env.AGENT_THREAD_ID;
  const originalMcpCaller = process.env.GOVERNANCE_MCP_CALLER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-exec-"));

  const result = executeCommand(["counts"], {
    cwd: tempDir,
    env: {
      ...process.env,
      AGENT_THREAD_ID: "exec-thread-test",
      GOVERNANCE_MCP_CALLER: "true",
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.stdout, /^Board:/m);
  assert.equal(result.stderr, "");
  assert.equal(process.cwd(), originalCwd);
  assert.equal(process.env.AGENT_THREAD_ID, originalThreadId);
  assert.equal(process.env.GOVERNANCE_MCP_CALLER, originalMcpCaller);
});

test("counts treats superseded tickets as closed instead of open", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-counts-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "Counts Test Board" },
    sections: [
      {
        rows: [
          { ID: "DONE-001", Repo: "X", Status: "done", Owner: "codexa00", Description: "done" },
          { ID: "SUPER-001", Repo: "X", Status: "superseded", Owner: "codexa00", Description: "retired" },
          { ID: "TODO-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "todo" },
          { ID: "DOING-001", Repo: "X", Status: "doing", Owner: "codexa00", Description: "doing" },
        ],
      },
    ],
  }, null, 2), "utf8");

  const originalBoardPath = __testing.paths.BOARD_PATH;
  const originalLocksDir = __testing.paths.LOCKS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.LOCKS_DIR = locksDir;
  try {
    const result = executeCommand(["counts"]);
    assert.equal(result.ok, true);
    assert.match(result.stdout, /^Tickets: 4$/m);
    assert.match(result.stdout, /^Open: 2 \(excludes done and superseded\)$/m);
    assert.match(result.stdout, /^Closed: 2$/m);
    assert.match(result.stdout, /^Superseded: 1$/m);
  } finally {
    __testing.paths.BOARD_PATH = originalBoardPath;
    __testing.paths.LOCKS_DIR = originalLocksDir;
  }
});

test("executeCommand returns governance failures without throwing for GovernanceError paths", () => {
  const result = executeCommand(["definitely-not-a-real-command"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown command/);
});

// COORD-099: allBoardRepoCodes unit tests relocated to paths.test.js (its
// owning module, coord/paths.js).

// GOV-008 — gate-failure attribution on add-repo-gate entries
// GOV-008 — stale drift-note retirement
test("doctor freshness wiring surfaces a journal-newer-than-board warning", () => {
  withCleanRuntimeFixture(({ eventLogPath, boardPath }) => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      eventLogPath,
      JSON.stringify({ ts: future, command: "land", ticket: "B-001" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ name: "todo", rows: [] }] }),
      "utf8"
    );
    const drift = __testing.detectRollbackDrift();
    assert.equal(drift.drift, true);
    assert.ok(drift.reasons.some((reason) => /predates the governance journal/.test(reason)));
    // doctor() routes each reason through the warnings channel with this prefix.
    assert.ok(`[freshness] ${drift.reasons[0]}`.startsWith("[freshness] "));
  });
});

test("GCV-3: computeSyncDelta returns only canonical paths that differ from HEAD (never sweeps unrelated drift)", () => {
  const repo = createTempGitRepo("ebmr-gcv3-sync-delta-", {
    "PLAN.md": "initial\n",
    "rendered/TASKS.md": "initial\n",
    "rendered/PROMPT_INDEX.md": "initial\n",
    "unrelated.md": "untouched-by-sync\n",
  }, "seed");
  const paths = [
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ];
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, paths), []);

  writeRepoFile(repo.repoRoot, "PLAN.md", "modified\n");
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, paths), ["PLAN.md"]);

  writeRepoFile(repo.repoRoot, "unrelated.md", "drift the manual board-sync would have swept\n");
  assert.deepEqual(
    __testing.computeSyncDelta(repo.repoRoot, paths),
    ["PLAN.md"],
    "computeSyncDelta must ignore drift outside the canonical path set"
  );

  writeRepoFile(repo.repoRoot, "rendered/TASKS.md", "modified\n");
  assert.deepEqual(
    __testing.computeSyncDelta(repo.repoRoot, paths),
    ["PLAN.md", "rendered/TASKS.md"]
  );
});

test("GCV-3: computeSyncDelta gracefully handles empty / nonsense path inputs", () => {
  const repo = createTempGitRepo("ebmr-gcv3-sync-empty-", {
    "PLAN.md": "x\n",
  }, "seed");
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, []), []);
  assert.deepEqual(__testing.computeSyncDelta(repo.repoRoot, ["does-not-exist.md"]), []);
});

test("GCV-3: computeSyncDelta is toplevel-aware (no false-clean when coord is a subdir of an outer repo)", () => {
  // Regression for reviewer finding #1: `git status --porcelain` emits
  // paths relative to the GIT TOPLEVEL. When coord lives as a SUBDIRECTORY
  // of an outer git repo (a consumer that embeds coord rather than running
  // coord as its own repo), porcelain reports `coord/PLAN.md` and a naive
  // includes() filter that expected `PLAN.md` silently drops it → false
  // clean → both `gov sync` and the slice-3 doctor invariant miss real
  // drift. The fix must handle BOTH layouts identically.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv3-subdir-"));
  runGit(outer, ["init", "-b", "main"]);
  runGit(outer, ["config", "user.email", "tests@example.com"]);
  runGit(outer, ["config", "user.name", "Tests"]);
  fs.mkdirSync(path.join(outer, "coord", "rendered"), { recursive: true });
  writeRepoFile(outer, "coord/PLAN.md", "seed\n");
  writeRepoFile(outer, "coord/rendered/TASKS.md", "seed\n");
  writeRepoFile(outer, "coord/rendered/PROMPT_INDEX.md", "seed\n");
  runGit(outer, ["add", "."]);
  runGit(outer, ["commit", "-m", "seed"]);

  const coordDir = path.join(outer, "coord");
  const canonical = ["PLAN.md", "rendered/TASKS.md", "rendered/PROMPT_INDEX.md"];

  // Clean tree → no delta in either layout.
  assert.deepEqual(__testing.computeSyncDelta(coordDir, canonical), []);

  // Drift one canonical path: porcelain emits `coord/PLAN.md` (toplevel-
  // relative); the toplevel-aware filter must still surface it as
  // `PLAN.md` (the caller's coord-relative input form).
  writeRepoFile(outer, "coord/PLAN.md", "drift\n");
  assert.deepEqual(
    __testing.computeSyncDelta(coordDir, canonical),
    ["PLAN.md"],
    "coord-as-subdir must report the drifted canonical path, not silently drop it"
  );

  // Drift another canonical path: still scope-limited (no unrelated sweep).
  writeRepoFile(outer, "coord/rendered/TASKS.md", "drift\n");
  writeRepoFile(outer, "unrelated-outside-coord.md", "drift\n");
  assert.deepEqual(
    __testing.computeSyncDelta(coordDir, canonical),
    ["PLAN.md", "rendered/TASKS.md"],
    "subdir delta must not pick up drift outside the coord subdirectory"
  );
});

test("GCV-3 slice 2: commitCanonicalDelta is scoped by pathspec — pre-existing staged unrelated files do NOT ride along", () => {
  // Reviewer finding #2: the prior `git commit -m <msg>` would commit the
  // WHOLE current index. Auto-trigger after a lifecycle action could then
  // silently include any pre-existing staged files unrelated to the
  // canonical derived surface. The fix passes the delta as an explicit
  // pathspec to `git commit -- <delta>` so the commit is scope-limited
  // regardless of what else is staged.
  const repo = createTempGitRepo("ebmr-gcv3-commit-pathspec-", {
    "rendered/TASKS.md": "seed\n",
    "PLAN.md": "seed\n",
    "unrelated.md": "pre-existing tracked unrelated\n",
  }, "seed");

  writeRepoFile(repo.repoRoot, "PLAN.md", "drift\n");
  writeRepoFile(repo.repoRoot, "unrelated.md", "drift unrelated\n");
  runGit(repo.repoRoot, ["add", "unrelated.md"]);
  const preStaged = runGit(repo.repoRoot, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    preStaged.includes("unrelated.md"),
    "test setup: unrelated.md must be pre-staged before commitCanonicalDelta runs"
  );

  __testing.commitCanonicalDelta(
    repo.repoRoot,
    "test: scope-limited sync",
    ["PLAN.md"]
  );

  const committed = runGit(repo.repoRoot, [
    "show",
    "--name-only",
    "--format=",
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    committed.sort(),
    ["PLAN.md"],
    "auto-sync commit must include ONLY the canonical delta paths, never pre-existing staged unrelated files"
  );
  const stillStaged = runGit(repo.repoRoot, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
  assert.ok(
    stillStaged.includes("unrelated.md"),
    "pre-staged unrelated files must remain in the index for the operator to handle"
  );
});

// ---------------------------------------------------------------------------
// COORD-003: --scope-self parseFlags case, gov unstart, gov block / unblock.
// ---------------------------------------------------------------------------

// COORD-099: the COORD-003 `parseFlags accepts --scope-self` flag-acceptance
// test relocated to lifecycle-flags.test.js (beside cli.js's parseFlags
// data-parallel sibling parseLifecycleFlags).

// COORD-061: the COORD-003 workspace harness (createMinimalGovernanceWorkspace,
// setupCoord003Workspace, readBoardRow) now lives in governance-test-utils.js so
// the relocated transition block/unblock tests can share it.
test("COORD-003 Fix 2: unstart reverts a clean doing ticket to todo and clears owner/lock/worktree", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-happy-", ticketId, owner);
  try {
    __testing.unstartTicket(ticketId, {});
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "lock file must be removed");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on review evidence (recorded findings)", () => {
  const ticketId = "MSRV-301";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-review-", ticketId, owner);
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.review_findings[ticketId] = [
      { id: `${ticketId}-F1`, severity: "MED", summary: "x", status: "open", round: 1, qref: "L1" },
    ];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /review findings recorded/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on landing evidence (landing_index record)", () => {
  const ticketId = "MSRV-302";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-landing-", ticketId, owner);
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.landing_index[ticketId] = { commit_sha: "abc1234", evidence: ["dev landing"] };
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /landing_index evidence recorded/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on plan evidence (plan advanced past round 1)", () => {
  const ticketId = "MSRV-303";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-plan-", ticketId, owner, { reviewRound: 2 });
  try {
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /review round 2/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart fails closed on workspace evidence (worktree has commits)", () => {
  const ticketId = "MSRV-304";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-workspace-", ticketId, owner, { withCommit: true });
  try {
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /commit\(s\) ahead of/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with commits must be preserved");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart rejects a foreign owner and directs to admin paths", () => {
  const ticketId = "MSRV-305";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-foreign-", ticketId, owner);
  try {
    // claudea99 is the current session's identity only if it owns the session;
    // here the active session is owner's. Pass an explicit foreign --owner.
    assert.throws(
      () => __testing.unstartTicket(ticketId, { owner: "claudea99" }),
      (error) => error instanceof GovernanceError &&
        /same-owner only/.test(error.message) &&
        /release-lock|human-admin-override/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 2: unstart rejects a non-doing ticket", () => {
  const ticketId = "MSRV-306";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unstart-nondoing-", ticketId, owner, { ticketStatus: "todo" });
  try {
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /must be doing/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

// COORD-009 end-to-end: a freshly-started, completely unworked code ticket
// whose prompt carried a `## Likely Files` section. `gov start` seeded those
// prompt-derived paths into `intended_files` and recorded the same values
// into `scaffold_placeholders.intended_files`. `gov unstart` MUST still
// succeed — the seeded multi-path `intended_files` is start scaffold, not
// authored content.
test("COORD-009: unstart succeeds on an unworked ticket seeded with Likely Files intended_files", () => {
  const ticketId = "MSRV-309";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord009-unstart-seeded-", ticketId, owner);
  try {
    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    // The shape `gov start` produces from a prompt's `## Likely Files`: the
    // implicit worktree placeholder plus prompt-derived paths, with the SAME
    // set recorded as the start seed.
    const seed = [
      `backend/.worktrees/${owner}/${ticketId}/*`,
      "src/auth/session.ts",
      "src/auth/token.ts",
      "src/auth/index.ts",
      "services/api/middleware/auth.ts",
    ];
    record.intended_files = [...seed];
    record.scaffold_placeholders = { intended_files: [...seed] };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    assert.doesNotThrow(() => __testing.unstartTicket(ticketId, {}));
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo", "ticket must revert to todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "lock must be cleared");
  } finally {
    ctx.restore();
  }
});

// COORD-009 end-to-end: an `intended_files` entry an agent added beyond the
// recorded start seed is genuine authored work — `gov unstart` must fail
// closed so the work stays on the board.
test("COORD-009: unstart fails closed when intended_files is edited beyond the start seed", () => {
  const ticketId = "MSRV-310";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord009-unstart-edited-", ticketId, owner);
  try {
    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const seed = [
      `backend/.worktrees/${owner}/${ticketId}/*`,
      "src/auth/session.ts",
    ];
    // `intended_files` carries a path NOT in the recorded start seed — the
    // agent ran `gov update-plan --file src/auth/NEW-authored.ts`.
    record.intended_files = [...seed, "src/auth/NEW-authored.ts"];
    record.scaffold_placeholders = { intended_files: [...seed] };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError &&
        /authored content beyond the start scaffold/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
  } finally {
    ctx.restore();
  }
});

// COORD-009: seedStartIntendedFilesFromPrompt writes the prompt's Likely
// Files into both `intended_files` and `scaffold_placeholders.intended_files`,
// and is a no-op once the record carries authored content.
test("COORD-009: seedStartIntendedFilesFromPrompt records the start seed and is idempotent on authored content", () => {
  const ticketId = "MSRV-311";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord009-seed-", ticketId, owner);
  try {
    // Author a prompt with a `## Likely Files` section.
    const promptPath = path.join(ctx.coordRoot, "prompts", `${ticketId}.md`);
    fs.writeFileSync(promptPath, [
      `# ${ticketId}: seed test.`,
      "",
      "## Likely Files",
      "- `src/auth/session.ts`",
      "- `src/auth/token.ts` — the token path",
      "",
      "## Verification",
      "- `node --test`",
    ].join("\n"), "utf8");

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    // Point prompt_index at the absolute prompt path — readTicketPromptText
    // resolves relative paths against the engine's ROOT_DIR, which the harness
    // does not redirect.
    board.prompt_index = { ...board.prompt_index, [ticketId]: promptPath };
    __testing.seedStartIntendedFilesFromPrompt(ticketId, board);

    const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const seeded = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const expectedSeed = [
      `backend/.worktrees/${owner}/${ticketId}/*`,
      "src/auth/session.ts",
      "src/auth/token.ts",
    ];
    assert.deepEqual(seeded.intended_files, expectedSeed);
    assert.deepEqual(seeded.scaffold_placeholders.intended_files, expectedSeed);
    // The seeded record is still recognized as start scaffold.
    assert.equal(
      __testing.planRecordHasImplicitIntendedFilesScaffoldPlaceholder(seeded),
      true
    );

    // Re-seeding after the agent authored a path is a no-op (the record is no
    // longer a pristine scaffold).
    seeded.intended_files = ["src/agent-authored.ts"];
    seeded.scaffold_placeholders = {};
    fs.writeFileSync(recordPath, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
    __testing.seedStartIntendedFilesFromPrompt(ticketId, board);
    const afterReseed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.deepEqual(afterReseed.intended_files, ["src/agent-authored.ts"],
      "seeding must not overwrite authored intended_files");
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// COORD-004: gov lock-abandon — the foreign-owner admin counterpart of unstart.
// ---------------------------------------------------------------------------

// Re-point a workspace built by setupCoord003Workspace so the ticket and its
// lock are owned by `claudea99` (registered agent a99) while the current
// session stays `claudea0000`. This is the stale-foreign-lock scenario.
function makeForeignOwned(ctx, ticketId) {
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const row = board.sections[0].rows.find((r) => r.ID === ticketId);
  row.Owner = "claudea99";
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  if (fs.existsSync(ctx.lockPath)) {
    const lock = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    lock.owner = "claudea99";
    lock.agent_id = "a99";
    lock.session_id = "claudea99-stale";
    fs.writeFileSync(ctx.lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }
}

test("COORD-004: lock-abandon returns a foreign-owned evidence-free doing ticket to todo", () => {
  const ticketId = "MSRV-400";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-happy-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    __testing.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session, owner offline" });
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "todo");
    assert.equal(row.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.lockPath), false, "stale foreign lock must be removed");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon requires --human-admin-override", () => {
  const ticketId = "MSRV-401";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-nooverride-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => __testing.lockAbandonTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /requires --human-admin-override/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.lockPath), true, "lock must be preserved when rejected");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon rejects a ticket owned by the current session and directs to unstart", () => {
  const ticketId = "MSRV-402";
  const owner = "claudea0000";
  // No makeForeignOwned: the ticket stays owned by the current session.
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-sameowner-", ticketId, owner);
  try {
    assert.throws(
      () => __testing.lockAbandonTicket(ticketId, { humanAdminOverride: "any reason" }),
      (error) => error instanceof GovernanceError &&
        /owned by the current session/.test(error.message) &&
        /gov unstart/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon fails closed on review evidence and directs to supersede/reconcile", () => {
  const ticketId = "MSRV-403";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-evidence-", ticketId, owner);
  try {
    makeForeignOwned(ctx, ticketId);
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.review_findings[ticketId] = [
      { id: `${ticketId}-F1`, severity: "MED", summary: "x", status: "open", round: 1, qref: "L1" },
    ];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () => __testing.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError &&
        /review findings recorded/.test(error.message) &&
        /supersede|reconcile/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "ticket must stay doing");
    assert.equal(fs.existsSync(ctx.lockPath), true, "lock must be preserved on evidence");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon fails closed on workspace evidence (worktree has commits)", () => {
  const ticketId = "MSRV-404";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-workspace-", ticketId, owner, { withCommit: true });
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => __testing.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError &&
        /commit\(s\) ahead of/.test(error.message) &&
        /supersede|reconcile/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with commits must be preserved");
  } finally {
    ctx.restore();
  }
});

test("COORD-004: lock-abandon rejects a non-doing ticket", () => {
  const ticketId = "MSRV-405";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord004-lockabandon-nondoing-", ticketId, owner, { ticketStatus: "todo" });
  try {
    makeForeignOwned(ctx, ticketId);
    assert.throws(
      () => __testing.lockAbandonTicket(ticketId, { humanAdminOverride: "stale foreign session" }),
      (error) => error instanceof GovernanceError && /must be doing/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("open-followup --prefix auto-allocates the next free id under the runtime lock", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-autoid-openfollowup-", ticketId, owner);
  try {
    __testing.openFollowup(null, {
      prefix: "MSRV",
      dependsOn: ticketId,
      repo: "B",
      type: "followup",
      pri: "P2",
      description: "Auto-allocated follow-up from the parent ticket.",
      relation: "related",
    });
    // Parent is MSRV-300, so the first auto-allocated MSRV id is MSRV-301.
    const created = readBoardRow(ctx.boardPath, "MSRV-301");
    assert.ok(created, "open-followup --prefix must create MSRV-301");
    assert.equal(created.Repo, "B");
    assert.equal(created.Status, "todo");
    assert.equal(created["Depends On"], ticketId);
  } finally {
    ctx.restore();
  }
});

test("open-followup with neither <id> nor --prefix fails closed", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-autoid-openfollowup-missing-", ticketId, owner);
  try {
    assert.throws(
      () => __testing.openFollowup(null, {
        dependsOn: ticketId,
        repo: "B",
        type: "followup",
        pri: "P2",
        description: "No id and no prefix.",
        relation: "related",
      }),
      (error) => error instanceof GovernanceError && /--prefix <PREFIX> to auto-allocate/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("split-ticket --into B,F creates two auto-allocated repo halves, each related to the umbrella", () => {
  const ticketId = "MSRV-300";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-autoid-split-", ticketId, owner);
  try {
    __testing.splitTicket(ticketId, {
      into: "B,F",
      // prefix is derived from the parent id (MSRV) when omitted.
      description: "Cross-repo split umbrella.",
    });
    // Two new MSRV-* halves, one per repo, auto-allocated from MSRV-300.
    const backendHalf = readBoardRow(ctx.boardPath, "MSRV-301");
    const frontendHalf = readBoardRow(ctx.boardPath, "MSRV-302");
    assert.ok(backendHalf, "split-ticket must create the first auto-allocated half");
    assert.ok(frontendHalf, "split-ticket must create the second auto-allocated half");
    const repos = new Set([backendHalf.Repo, frontendHalf.Repo]);
    assert.deepEqual([...repos].sort(), ["B", "F"], "one half per --into repo");
    // Both halves depend on (are related to) the umbrella, ready immediately.
    assert.equal(backendHalf["Depends On"], ticketId);
    assert.equal(frontendHalf["Depends On"], ticketId);
  } finally {
    ctx.restore();
  }
});

test("ghPrView rethrows a non-transient gh error without retrying", () => {
  const url = "https://github.com/acme/widget/pull/9";
  let calls = 0;
  __testing.setSleepSyncForTesting(() => {});
  __testing.setRunGhForTesting(() => {
    calls += 1;
    throw new Error("could not resolve to a PullRequest with the URL");
  });
  try {
    assert.throws(
      () => __testing.ghPrView(url),
      (error) => /could not resolve to a PullRequest/.test(error.message)
    );
    assert.equal(calls, 1, "a non-transient error must fail on the first attempt");
  } finally {
    __testing.resetRunGhForTesting();
    __testing.resetSleepSyncForTesting();
  }
});

// ---------------------------------------------------------------------------
// COORD-005: workspace-evidence detection compares a governed worktree's HEAD
// against the remote-tracking ref origin/<integration> — never the local
// integration branch, which can lag origin and false-positive the guard.
// ---------------------------------------------------------------------------

// Advance origin/dev one commit past local dev (which stays behind), then move
// the ticket worktree's HEAD onto origin/dev. The worktree thus sits exactly at
// origin/dev while the LOCAL dev branch is stale. Returns the origin/dev SHA.
function advanceOriginAheadOfStaleLocal(ctx) {
  // Local dev is currently the integration branch tip. Add a commit on a
  // throwaway branch and push it to origin/dev so origin moves ahead while
  // the local dev branch ref is left untouched (stale).
  const localDev = runGit(ctx.backendRoot, ["rev-parse", "dev"]);
  runGit(ctx.backendRoot, ["checkout", "-b", "coord005-origin-advance", "dev"]);
  writeRepoFile(ctx.backendRoot, "src/coord005-origin.txt", "advanced on origin\n");
  runGit(ctx.backendRoot, ["add", "."]);
  runGit(ctx.backendRoot, ["commit", "-m", "COORD-005 advance origin/dev"]);
  const originDev = runGit(ctx.backendRoot, ["rev-parse", "HEAD"]);
  runGit(ctx.backendRoot, ["push", "origin", "HEAD:dev"]);
  runGit(ctx.backendRoot, ["checkout", "dev"]);
  runGit(ctx.backendRoot, ["branch", "-D", "coord005-origin-advance"]);
  runGit(ctx.backendRoot, ["fetch", "origin"]);
  // Local dev must still lag origin/dev for this scenario to be meaningful.
  assert.equal(runGit(ctx.backendRoot, ["rev-parse", "dev"]), localDev);
  assert.notEqual(originDev, localDev);
  return originDev;
}

test("COORD-005: resolveWorktreeBaseCompareRef prefers origin/<base> over the local branch", () => {
  const ticketId = "MSRV-500";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord005-comparer-", ticketId, owner);
  try {
    assert.equal(
      __testing.resolveWorktreeBaseCompareRef(ctx.worktreePath, "dev"),
      "origin/dev",
      "should resolve to the remote-tracking ref when origin/dev exists"
    );
    assert.equal(
      __testing.resolveWorktreeBaseCompareRef(ctx.worktreePath, "no-such-branch"),
      "no-such-branch",
      "should fall back to the literal base name when no remote-tracking ref resolves"
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-005: worktree HEAD at origin/<base> is 0 commits ahead even when local <base> is stale", () => {
  const ticketId = "MSRV-501";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord005-stale-local-", ticketId, owner);
  try {
    const originDev = advanceOriginAheadOfStaleLocal(ctx);
    // Point the governed worktree's HEAD exactly at origin/dev — a genuine
    // unworked wrong-start: no commits beyond the remote integration tip.
    runGit(ctx.worktreePath, ["reset", "--hard", originDev]);
    assert.equal(runGit(ctx.worktreePath, ["rev-parse", "HEAD"]), originDev);

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections[0].rows.find((r) => r.ID === ticketId);
    const blockers = __testing.collectUnstartEvidenceBlockers(ticketId, row, board);
    assert.deepEqual(
      blockers,
      [],
      `worktree at origin/dev must yield no workspace blocker; got: ${blockers.join("; ")}`
    );

    // And unstart must succeed end-to-end on this genuine wrong-start.
    __testing.unstartTicket(ticketId, {});
    const after = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(after.Status, "todo");
    assert.equal(after.Owner, "unassigned");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "clean worktree must be removed");
  } finally {
    ctx.restore();
  }
});

test("COORD-005: a real commit beyond origin/<base> is STILL detected and fails the guard closed", () => {
  const ticketId = "MSRV-502";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord005-real-ahead-", ticketId, owner);
  try {
    const originDev = advanceOriginAheadOfStaleLocal(ctx);
    // Worktree sits at origin/dev plus one genuine ticket commit on top.
    runGit(ctx.worktreePath, ["reset", "--hard", originDev]);
    writeRepoFile(ctx.worktreePath, "src/coord005-work.txt", "ticket work beyond origin\n");
    runGit(ctx.worktreePath, ["add", "."]);
    runGit(ctx.worktreePath, ["commit", "-m", `${ticketId} real ticket work`]);

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections[0].rows.find((r) => r.ID === ticketId);
    const blockers = __testing.collectUnstartEvidenceBlockers(ticketId, row, board);
    assert.equal(blockers.length, 1, `expected one workspace blocker; got: ${blockers.join("; ")}`);
    assert.match(blockers[0], /1 commit\(s\) ahead of origin\/dev/);

    // unstart must fail closed and preserve the worktree.
    assert.throws(
      () => __testing.unstartTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /commit\(s\) ahead of origin\/dev/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.equal(fs.existsSync(ctx.worktreePath), true, "worktree with real commits must be preserved");
  } finally {
    ctx.restore();
  }
});

// ---------------------------------------------------------------------------
// COORD-007: CI parity check for documented lifecycle verbs.
//
// COORD-003/004/005/006 all traced back to GOVERNANCE.md / VERB_CONTRACT.md
// documenting verbs and a flag the engine never implemented. These tests give
// CI a mechanical drift-catcher and also self-test that the catcher WOULD fire
// on a synthetic divergence.
// ---------------------------------------------------------------------------

const COORD007_CLI_SRC = fs.readFileSync(
  path.join(__dirname, "cli.js"),
  "utf8"
);
const COORD007_AGENT_SRC = fs.readFileSync(
  path.join(__dirname, "agent"),
  "utf8"
);
const COORD007_GOVERNANCE_MD = fs.readFileSync(
  path.join(__dirname, "..", "GOVERNANCE.md"),
  "utf8"
);
const COORD007_VERB_CONTRACT_MD = fs.readFileSync(
  path.join(__dirname, "..", "VERB_CONTRACT.md"),
  "utf8"
);
// COORD-007 verb-parity reads the regression suite to prove every lifecycle
// verb keeps coverage. As governance.test.js is progressively split into
// subject-owned siblings (COORD-090/096/097/098/099), the relocated regression
// tests still count toward parity — concatenate the sibling test sources so a
// verb covered in a split-out file is not falsely reported as uncovered.
// COORD-099 added lifecycle-flags.test.js (cli.js parseFlags acceptance tests,
// which carry agent/gov flag tokens for the flag-parity leg) and
// prompt-coverage.test.js / paths.test.js to this concatenation.
// COORD-100 (facade capstone) relocated the lifecycle.js helper unit tests into
// lifecycle.test.js — those bodies carry lifecycle-verb tokens (finalize / land
// / mark-done / move-review / plan), so add lifecycle.test.js here to keep verb
// parity drift-proof if a verb's only regression token ever lives there.
const COORD007_TEST_SRC = [
  fs.readFileSync(__filename, "utf8"),
  ...["governance-validation.test.js", "lifecycle-flags.test.js", "prompt-coverage.test.js", "paths.test.js", "lifecycle.test.js"]
    .map((name) => path.join(__dirname, name))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8")),
].join("\n");

test("COORD-007: every documented gov/agent verb resolves and the parity check passes on main", () => {
  const report = __testing.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD, COORD007_VERB_CONTRACT_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.deepEqual(
    report.missingGovHandlers,
    [],
    `documented \`gov <verb>\` references with no dispatchCommand handler: ${report.missingGovHandlers.join(", ")}`
  );
  assert.deepEqual(
    report.missingAgentVerbs,
    [],
    `documented \`agent <verb>\` references the facade does not expose: ${report.missingAgentVerbs.join(", ")}`
  );
  assert.deepEqual(
    report.missingFlagHandlers,
    [],
    `flags the \`agent\` wrapper passes that parseFlags does not handle: ${report.missingFlagHandlers.join(", ")}`
  );
  assert.equal(report.ok, true, "verb/flag parity check must pass on current main");
  // The docs must reference a non-trivial verb surface — guards against the
  // parser silently matching nothing and the test passing vacuously.
  assert.ok(
    report.documentedGovVerbs.length >= 8,
    `expected the governance docs to reference >=8 gov verbs; got ${report.documentedGovVerbs.length}`
  );
});

test("COORD-007: every lifecycle verb has at least one regression test, or the gap is reported", () => {
  const report = __testing.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD, COORD007_VERB_CONTRACT_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.deepEqual(
    report.lifecycleVerbsWithoutTests,
    [],
    `lifecycle verbs with no regression coverage: ${report.lifecycleVerbsWithoutTests.join(", ")}`
  );
});

test("COORD-007 self-test: the parity check FAILS when a documented gov verb lacks a handler", () => {
  // Synthetic doc references a bogus `gov teleport` verb that no
  // dispatchCommand case handles. The check must catch it.
  const syntheticDoc = "Operators run `coord/scripts/gov teleport <ticket>` to relocate work.";
  const report = __testing.runVerbParityCheck({
    docTexts: [syntheticDoc],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: COORD007_AGENT_SRC,
    testFileText: COORD007_TEST_SRC,
  });
  assert.equal(report.ok, false, "a documented verb with no handler must fail the check");
  assert.deepEqual(report.missingGovHandlers, ["teleport"]);
});

test("COORD-007 self-test: the parity check FAILS when the wrapper passes an unhandled flag", () => {
  // Synthetic `agent` wrapper that injects a `--warp-speed` flag parseFlags
  // never accepts — exactly the COORD-003 `--scope-self` class of drift.
  const syntheticAgent = [
    "#!/usr/bin/env bash",
    "case \"$command\" in",
    "  next)",
    "    exec \"$GOV\" pick --mode general --warp-speed",
    "    ;;",
    "esac",
  ].join("\n");
  const report = __testing.runVerbParityCheck({
    docTexts: [COORD007_GOVERNANCE_MD],
    governanceSource: COORD007_CLI_SRC,
    agentScriptText: syntheticAgent,
    testFileText: COORD007_TEST_SRC,
  });
  assert.equal(report.ok, false, "an unhandled wrapper flag must fail the check");
  assert.ok(
    report.missingFlagHandlers.includes("--warp-speed"),
    `expected --warp-speed in missingFlagHandlers; got ${report.missingFlagHandlers.join(", ")}`
  );
});

test("COORD-007: verb parser only treats backtick-quoted command forms as verbs (no prose drift)", () => {
  // Prose that mentions the words "gov" and "agent" must NOT yield verbs;
  // only complete inline-code spans count.
  const prose = "The agent must run governance carefully. A gov decision matters.";
  assert.deepEqual([...__testing.parseDocumentedGovVerbs(prose)], []);
  assert.deepEqual([...__testing.parseDocumentedAgentVerbs(prose)], []);

  // Real command forms ARE recognized, with or without the path prefix.
  const commands = "Run `gov start TICKET` then `coord/scripts/gov mark-done TICKET`.";
  const govVerbs = [...__testing.parseDocumentedGovVerbs(commands)].sort();
  assert.deepEqual(govVerbs, ["mark-done", "start"]);

  // An unterminated backtick must not let a verb leak out of the span.
  const unterminated = "Broken `gov start and trailing text with no closing tick";
  assert.deepEqual([...__testing.parseDocumentedGovVerbs(unterminated)], []);
});

test("COORD-007: dispatchCommand verb collector reads the real switch, not a duplicate list", () => {
  const verbs = __testing.collectDispatchCommandVerbs(COORD007_CLI_SRC);
  // Spot-check verbs the COORD-003/004 work added — proof the collector sees
  // the live switch surface.
  for (const verb of ["start", "unstart", "lock-abandon", "land", "submit"]) {
    assert.ok(verbs.has(verb), `dispatchCommand should expose "${verb}"`);
  }
  // A verb that does not exist must not be reported.
  assert.equal(verbs.has("teleport"), false);
});

// ---------------------------------------------------------------------------
// COORD-008: start gate verifies ticket prompt preconditions.
//
// A ticket prompt may declare an OPTIONAL `## Preconditions` section listing
// artifacts it claims already exist. The start gate verifies each against the
// target repo's integration branch BEFORE lock/worktree creation and fails
// with a clear stale-prompt error if any does not resolve.
// ---------------------------------------------------------------------------

// COORD-099: parsePromptPreconditions / classifyPreconditionArtifact /
// verifyPromptPreconditions unit tests relocated to prompt-coverage.test.js
// (their owning module). The start-gate integration tests below
// (assertPromptPreconditionsResolve via the runCoord008StartGate harness)
// stay here — they drive the governance start gate end-to-end.

// Shared harness: build a coord workspace + a backend repo, register one
// `todo` ticket with a prompt that declares the given preconditions, then run
// the COORD-008 start-gate hook against it. Returns the thrown error (or null)
// plus the lock path so tests can prove no lock was created on failure.
function runCoord008StartGate(prefix, { repoFiles, promptBody, repoCode = "B" }) {
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace(prefix);
  // Re-seed the backend repo with the requested premise files.
  if (repoFiles && Object.keys(repoFiles).length > 0) {
    for (const [rel, content] of Object.entries(repoFiles)) {
      writeRepoFile(backendRoot, rel, content);
    }
    runGit(backendRoot, ["add", "."]);
    runGit(backendRoot, ["commit", "-m", "coord008 premise"]);
    runGit(backendRoot, ["push", "origin", "dev"]);
  }
  const ticketId = "MSRV-800";
  const promptPath = path.join(coordRoot, "prompts", `${ticketId}.md`);
  fs.writeFileSync(promptPath, promptBody, "utf8");

  const board = {
    sections: [{ rows: [{ ID: ticketId, Repo: repoCode, Status: "todo", Owner: "unassigned" }] }],
    // Absolute prompt path — assertPromptPreconditionsResolve honors absolute paths.
    prompt_index: { [ticketId]: promptPath },
  };
  const row = board.sections[0].rows[0];

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
  };
  __testing.paths.REPO_ROOTS = { ...original.REPO_ROOTS, [repoCode]: backendRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { ...original.REPO_INTEGRATION_BRANCHES, [repoCode]: "dev" };

  let thrown = null;
  try {
    __testing.assertPromptPreconditionsResolve(ticketId, row, board, {});
  } catch (error) {
    thrown = error;
  } finally {
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
  }
  return { thrown, ticketId };
}

test("COORD-008: start gate fails with a stale-prompt error when a declared precondition does not resolve", () => {
  const { thrown } = runCoord008StartGate("ebmr-coord008-startfail-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: gate the call-center route",
      "",
      "## Preconditions",
      "- route:/floor-workscreen",
      "- symbol:src/screens/Call.tsx#CallCenterWorkscreen",
      "",
      "## Likely Files",
      "- src/keep.ts",
    ].join("\n"),
  });
  assert.ok(thrown instanceof GovernanceError, "start gate must fail closed on a stale prompt");
  assert.match(thrown.message, /stale/i);
  assert.match(thrown.message, /\/floor-workscreen/);
  assert.match(thrown.message, /CallCenterWorkscreen/);
});

test("COORD-008: start gate passes when the prompt's declared preconditions are accurate", () => {
  const { thrown } = runCoord008StartGate("ebmr-coord008-startok-", {
    repoFiles: {
      "src/floor.ts": "export const route = '/floor-workscreen';\n",
      "src/screens/Call.tsx": "export function CallCenterWorkscreen() { return null; }\n",
    },
    promptBody: [
      "# MSRV-800: gate the call-center route",
      "",
      "## Preconditions",
      "- route:/floor-workscreen",
      "- symbol:src/screens/Call.tsx#CallCenterWorkscreen",
      "- path:src/floor.ts",
    ].join("\n"),
  });
  assert.equal(thrown, null, thrown ? `unexpected start-gate failure: ${thrown.message}` : "");
});

test("COORD-008: start gate passes for a prompt with no Preconditions section (back-compat)", () => {
  const { thrown } = runCoord008StartGate("ebmr-coord008-nosection-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: a normal feature ticket",
      "",
      "## Context",
      "This prompt declares no preconditions.",
      "",
      "## Likely Files",
      "- src/brand-new-file.ts",
    ].join("\n"),
  });
  assert.equal(thrown, null, thrown ? `back-compat prompt must still start: ${thrown.message}` : "");
});

test("COORD-008: Likely Files pointing at to-be-created files never block start", () => {
  const { thrown } = runCoord008StartGate("ebmr-coord008-likelyfiles-", {
    repoFiles: { "src/keep.ts": "export const keep = 1;\n" },
    promptBody: [
      "# MSRV-800: create new files",
      "",
      "## Preconditions",
      "- path:src/keep.ts",
      "",
      "## Likely Files",
      "- src/does-not-exist-yet.ts",
      "- src/screens/AlsoNew.tsx",
    ].join("\n"),
  });
  // The only DECLARED precondition (src/keep.ts) resolves; the non-existent
  // "Likely Files" entries are outside the section and must not block.
  assert.equal(thrown, null, thrown ? `Likely Files must not block start: ${thrown.message}` : "");
});

test("COORD-022: isInsideGitWorkTree distinguishes a git repo from an off-git directory", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord022-git-"));
  try {
    const offGit = path.join(base, "off-git");
    fs.mkdirSync(offGit, { recursive: true });
    assert.equal(__testing.isInsideGitWorkTree(offGit), false);

    const gitDir = path.join(base, "in-git");
    fs.mkdirSync(gitDir, { recursive: true });
    runGit(gitDir, ["init", "-q"]);
    assert.equal(__testing.isInsideGitWorkTree(gitDir), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("COORD-023: register-prompt happy path writes prompt_index through the board", () => {
  withRegisterPromptHarness("coord023-rp-happy-", {}, ({ promptOnDisk, ticketId, readBoard }) => {
    const result = executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]);
    assert.equal(result.ok, true, `register-prompt should succeed: ${result.error || result.stderr || result.stdout}`);
    const board = readBoard();
    assert.ok(board.prompt_index[ticketId], "prompt_index must now have the ticket");
  });
});

test("COORD-023: register-prompt fails clearly when the prompt file does not exist", () => {
  withRegisterPromptHarness("coord023-rp-missing-", {}, ({ ticketId, tempDir }) => {
    const missing = path.join(tempDir, "nope.md");
    const result = executeCommand(["register-prompt", ticketId, "--path", missing]);
    assert.equal(result.ok, false, "register-prompt must fail on a missing file");
    assert.match(String(result.error || result.stderr || result.stdout), /prompt file not found|not found/i);
  });
});

test("COORD-023: register-prompt with no path defaults to the canonical on-disk prompt and auto-discover registers it", () => {
  // Use COORD-023 itself: its prompt exists at the canonical path on disk, but
  // the temp board has no prompt_index entry — exactly the import-onboarding
  // gap. register-prompt with no --path must resolve and register the default.
  withCanonicalTicketPrompt("COORD-023", "# COORD-023 fixture prompt\n", () => {
    withRegisterPromptHarness("coord023-rp-default-", { ticketId: "COORD-023" }, ({ ticketId, readBoard }) => {
      assert.equal(readBoard().prompt_index[ticketId], undefined, "precondition: not yet registered");
      const result = executeCommand(["register-prompt", ticketId]);
      assert.equal(result.ok, true, `default-path register-prompt should succeed: ${result.error}`);
      assert.equal(readBoard().prompt_index[ticketId], "coord/prompts/tickets/COORD-023.md");
    });
  });
});

test("COORD-023: register-prompt is idempotent and refuses a conflicting remap without --force", () => {
  withRegisterPromptHarness("coord023-rp-force-", {}, ({ promptOnDisk, ticketId, tempDir, readBoard }) => {
    // First registration.
    assert.equal(executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]).ok, true);
    // Same path again is idempotent (success, no overwrite error).
    const idem = executeCommand(["register-prompt", ticketId, "--path", promptOnDisk]);
    assert.equal(idem.ok, true, "re-registering the same path must be idempotent");
    assert.match(String(idem.stdout), /idempotent/i);

    // A different existing path is refused without --force.
    const other = path.join(tempDir, "other.md");
    fs.writeFileSync(other, "# other\n", "utf8");
    const refused = executeCommand(["register-prompt", ticketId, "--path", other]);
    assert.equal(refused.ok, false, "conflicting remap must be refused without --force");
    assert.match(String(refused.error || refused.stderr || refused.stdout), /--force/);

    // With --force it overwrites.
    const forced = executeCommand(["register-prompt", ticketId, "--path", other, "--force"]);
    assert.equal(forced.ok, true, "remap must succeed with --force");
    const board = readBoard();
    assert.match(board.prompt_index[ticketId], /other\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Grooming verbs: set-priority / set-type mutate Pri/Type through gov so the
// canonical board (and the rendered TASKS.md view) stay in sync.
// ---------------------------------------------------------------------------

test("set-priority changes Pri on a non-terminal ticket through gov", () => {
  withRegisterPromptHarness("groom-setpri-", { ticketId: "IMP-700", pri: "P2" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P0"]);
    assert.equal(result.ok, true, `set-priority should succeed: ${result.error || result.stderr || result.stdout}`);
    const row = readBoard().sections[0].rows.find((r) => r.ID === "IMP-700");
    assert.equal(row.Pri, "P0");
  });
});

test("set-priority rejects an invalid --pri value", () => {
  withRegisterPromptHarness("groom-setpri-bad-", { ticketId: "IMP-700" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P9"]);
    assert.equal(result.ok, false, "invalid --pri must be rejected");
    assert.match(String(result.error || result.stderr || result.stdout), /--pri <P0\|P1\|P2\|P3>/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Pri, "P2");
  });
});

test("set-priority refuses a ticket in a terminal status", () => {
  withRegisterPromptHarness("groom-setpri-done-", { ticketId: "IMP-700", status: "done", pri: "P2" }, ({ readBoard }) => {
    const result = executeCommand(["set-priority", "IMP-700", "--pri", "P0"]);
    assert.equal(result.ok, false, "terminal-status reprioritize must be refused");
    assert.match(String(result.error || result.stderr || result.stdout), /Refusing to reprioritize .* terminal status "done"/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Pri, "P2");
  });
});

test("set-type changes Type on a non-terminal ticket through gov", () => {
  withRegisterPromptHarness("groom-settype-", { ticketId: "IMP-700", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "bug"]);
    assert.equal(result.ok, true, `set-type should succeed: ${result.error || result.stderr || result.stdout}`);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "bug");
  });
});

test("set-type rejects an invalid --type value", () => {
  withRegisterPromptHarness("groom-settype-bad-", { ticketId: "IMP-700", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "epic"]);
    assert.equal(result.ok, false, "invalid --type must be rejected");
    assert.match(String(result.error || result.stderr || result.stdout), /set-type requires --type/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "feature");
  });
});

test("set-type refuses a ticket in a terminal status", () => {
  withRegisterPromptHarness("groom-settype-superseded-", { ticketId: "IMP-700", status: "superseded", type: "feature" }, ({ readBoard }) => {
    const result = executeCommand(["set-type", "IMP-700", "--type", "bug"]);
    assert.equal(result.ok, false, "terminal-status retype must be refused");
    assert.match(String(result.error || result.stderr || result.stdout), /Refusing to retype .* terminal status "superseded"/);
    assert.equal(readBoard().sections[0].rows.find((r) => r.ID === "IMP-700").Type, "feature");
  });
});

