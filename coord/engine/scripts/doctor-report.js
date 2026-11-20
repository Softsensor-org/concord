"use strict";

// Wave 4 slice 1 (COORD-085): the READ-ONLY governance doctor REPORTING
// surface extracted from lifecycle.js — resolveDoctorScope /
// resolveDoctorOwnerScope (scope resolution), the read-only doctor() diagnostic
// report (with its private pushPhysicalRepairIssue owner-scoping helper), and
// the buildCanonicalDerivedDriftError report builder.
//
// This pairs with doctor-recovery.js (COORD-063) to make the report-vs-repair
// boundary clean: REPORT lives here, the MUTATING repair (doctorFix /
// recoverTicket / reconcileGovernance) lives in doctor-recovery.js. The
// read-only doctor() still delegates to the MUTATING doctorFix on `--fix`, so
// doctorFix is INJECTED (as a deferred wrapper) rather than owned here — the
// report can trigger repair without owning it.
//
// Every cross-module primitive (board-state readers, readiness / cycle
// formatters, lock + worktree helpers, agent-session + identity helpers,
// journal / provenance helpers, landing-audit + question-queue builders, the
// canonical-derived drift delta) is dependency-injected rather than
// re-implemented here, mirroring the prior Wave-2/3 extraction discipline.
//
// STATUS, COORD_DIR and REPO_ROOTS are required directly from the shared
// governance-context / governance-constants modules so this module observes the
// SAME live config that lifecycle does.

const path = require("node:path");

const { defaultFail, COORD_DIR, DEFAULT_PATHS, state, directoryLocks } = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");
const { shellQuote } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const { checkGitPrerequisite: defaultGitPrerequisite } = require("./git-prerequisite.js");
const { canonicalCallerPath } = require("./canonical-path.js");
const { integrationBaseRefFindings } = require("./integration-base-ref.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../../paths.js");
// COORD-635 / ADR-0008: control-plane landing evidence (self-contained module).
const { assertControlPlaneLandingIntegrity } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/control-plane-landing.js"));
const treeMutationSafety = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/tree-mutation-safety.js"));

const { inspectMaterializedViews } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/canonical-derived-authority.js"));
const { resolveEngineModule } = require("../../paths.js");
// COORD-862 (COORD-516a): scoped drift verdicts.
const driftScope = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/drift-scope.js"));
// COORD-892: product clones must not show governed worktrees as untracked.
const productWorktreeExclude = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/product-worktree-exclude.js"));
const boardPushPreflight = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/board-push-preflight.js"));

// COORD-894: the effective-rules preflight for the configured board branch.
function defaultBoardPushPreflight(options = {}) {
  const controlPlane = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/control-plane-paths.js"));
  const layout = controlPlane.defaultControlPlaneLayout();
  return boardPushPreflight.runBoardPushPreflight({
    repoRoot: layout.coordRepoRoot,
    branch: controlPlane.resolveControlPlaneIntegrationBranch(layout),
    boardLanding: DEFAULT_PATHS.boardLanding,
    offline: options.offline === true || /^(?:1|true|yes)$/i.test(String(process.env.COORD_DOCTOR_OFFLINE || "")),
  });
}

const REPO_ROOTS = DEFAULT_PATHS.repoRoots;

// COORD-477: onboarding-specific classification of the git state an unborn
// repository leaves behind. A repository whose current branch has no commits
// yet — the state a consent-based `--git-init` bootstrap leaves before the
// separately-consented baseline commit — must get bootstrap-pending guidance
// with exact next steps, NOT generic journal / derived-artifact / provenance
// drift errors. Strict diagnostics resume automatically once the first
// baseline commit exists.
//
// COORD-631/ADR-0008: the classified directory is `coord/` — the independent
// control-plane repository — NOT the workspace container, which is never a Git
// repository. When coord/ is merely tracked by some other repository the state
// is "ancestor": that is not bootstrap-pending, because the answer is a
// reviewed migration, never initializing or committing the container.
// Pure over an injected gitTry so it is unit-testable.
function classifyCoordGitState({ gitTry, coordDir = COORD_DIR } = {}) {
  const coord = path.resolve(coordDir);
  const base = { coord_dir: coord, is_coord_repository: false };
  if (typeof gitTry !== "function") return { ...base, state: "unknown", root: null };
  let top = null;
  try { top = gitTry(coord, ["rev-parse", "--show-toplevel"]); } catch { return { ...base, state: "unknown", root: null }; }
  if (!top || top.status !== 0) return { ...base, state: "outside", root: null };
  const root = String(top.stdout || "").trim();
  if (!root) return { ...base, state: "unknown", root: null };
  // COORD-1015: git reports the canonical toplevel; coord may reach it through a symlink.
  if (canonicalCallerPath(root) !== canonicalCallerPath(coord)) return { ...base, state: "ancestor", root };
  let head = null;
  try { head = gitTry(root, ["rev-parse", "--verify", "HEAD"]); } catch { return { ...base, state: "unknown", root }; }
  return { ...base, is_coord_repository: true, state: head && head.status === 0 ? "established" : "unborn", root };
}

// Pure formatter for the bootstrap-pending doctor notice. Returns null unless
// the root is unborn. The steps are the EXACT bootstrap contract: review the
// staged allowlist, stage via the installer's manifest-derived allowlist
// (never `git add .` / `-A`), create the separately-consented baseline commit,
// re-run doctor.
function buildBootstrapPendingNotice(coordState) {
  if (!coordState || coordState.state !== "unborn") return null;
  return [
    `[bootstrap-pending] The coord/ control-plane repository ${coordState.root} has no commits yet (unborn HEAD).`,
    "Strict journal / derived-artifact / provenance diagnostics are deferred until the first baseline commit exists; they resume automatically after it.",
    "Exact next steps (all of them run INSIDE coord/ — the workspace container above it is not a Git repository and must never become one):",
    "  1. Review what is staged: git -C coord status --short  (secret files must not appear as stage candidates; sibling product repositories are outside this repository and cannot appear at all).",
    "  2. If nothing is staged yet, stage the installer's exact manifest-derived allowlist with the separate --git-stage consent (npx create-concord <dir> --git-stage, or the equivalent SEA flag). Never run `git add .` or `git add -A`.",
    "  3. Create the baseline commit with its own separate installer consent (--git-baseline-commit), or manually: git -C coord commit --no-verify -m \"chore: concord governance baseline\".",
    "  4. Re-run coord/scripts/gov doctor — strict diagnostics resume after the first committed baseline.",
  ].join("\n");
}

// GCV-3 slice 3: pure formatter for the canonical-derived drift doctor
// error. Returns null when there is no drift (clean repo); otherwise
// returns a single actionable error string naming the drifting paths and
// pointing the operator at the remediation. Pure (no IO) so it is
// unit-testable in isolation.
// COORD-862: pure formatter for the whole-tree scoped verdict. Returns null
// when no engine-managed file is dirty; otherwise names every engine path and
// counts the project paths separately, so an engine hand-edit is never lost
// in ordinary uncommitted project work.
function buildEngineDriftWarning(dirtyPaths, options = {}) {
  const scopes = driftScope.partitionDriftPaths(dirtyPaths, { enginePaths: options.enginePaths });
  if (scopes.engine.length === 0) return null;
  return (
    `[engine-drift] ${driftScope.summarizeDriftScopes(scopes, { limit: scopes.engine.length })}. ` +
    `Engine remedy: ${driftScope.SCOPE_REMEDIES.engine}. ` +
    "Confirm with `coord/scripts/gov verify-engine`."
  );
}

// COORD-862: doctor's out-of-band finding, scoped. Authored content that the
// ADR 0020 committed-state policy will adopt on the next governed mutation is
// reported as pending, not as a bypass.
function buildOutOfBandFinding(outOfBand) {
  const plan = outOfBand.committedState || null;
  const pending = new Set(plan && Array.isArray(plan.adopted) ? plan.adopted : []);
  const blocking = (outOfBand.paths || []).filter((entry) => !pending.has(entry));
  const scopes = outOfBand.scopes || driftScope.partitionDriftPaths(outOfBand.paths || []);
  const since = outOfBand.latestEvent?.ts || "unknown time";
  const pendingText = pending.size > 0
    ? `[committed-state] ${[...pending].join(", ")} committed at ${plan.commit} on ${plan.integration_branch}; ` +
      "the next governed mutation adopts it with a journal-baseline event (ADR 0020)."
    : null;
  if (blocking.length === 0) return { error: null, warning: pendingText };
  const declined = plan && Array.isArray(plan.rejected) && plan.rejected.length > 0
    ? ` Committed-state adoption (ADR 0020) declined: ${plan.rejected.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`
    : "";
  return {
    error:
      `Out-of-band board mutation detected (single-writer protocol bypass): ${blocking.join(", ")} ` +
      `changed with no journaled transaction since ${since}. ` +
      `Scope: ${driftScope.summarizeDriftScopes(scopes, { verb: "unjournaled" })}. Remedy by scope: ${driftScope.formatScopeRemedies(scopes)}.${declined} ` +
      "These coordination-state files (board / plan records / prompts / rendered) must only be mutated through a governed transaction. " +
      "Reconcile the manual edit (revert it, or re-apply it via gov open-followup / gov start / gov finalize) before continuing.",
    warning: pendingText,
  };
}

function buildCanonicalDerivedDriftError(driftPaths) {
  if (!Array.isArray(driftPaths) || driftPaths.length === 0) return null;
  const paths = driftPaths.slice().sort();
  const scopes = driftScope.partitionDriftPaths(paths.map((entry) => `coord/${entry}`));
  return (
    `Canonical derived artifacts drift from HEAD on ${paths.length} ` +
    `path(s): ${paths.join(", ")}. ` +
    `Scope: ${driftScope.summarizeDriftScopes(scopes)}. ` +
    `These paths are deterministically regenerable; the working tree ` +
    `must not lag the journal. Run \`coord/scripts/gov sync --commit ` +
    `"<message>"\` to regenerate and commit them, or rerun the lifecycle ` +
    `action that produced this state without --no-sync.`
  );
}

// COORD-963: the owner WIP cap is retired; each unrelated doing pair held by one owner is
// reported (read-only) so the attention concern stays visible.
function buildOwnerDoingDoctorWarnings({ board } = {}) {
  const { findUnrelatedOwnerDoingPairs } = require("./followups.js");
  return findUnrelatedOwnerDoingPairs(board).map((pair) =>
    "[owner-doing] " + pair.owner + " holds unrelated doing tickets " + pair.left + " and " + pair.right +
    " with no closeout-blocker exception (attention, not state: the WIP cap is retired, ADR 0021). " +
    "Finish or reassign one; if the pair is one closeout, record coord/scripts/gov set-followup-relation <ticket> --depends-on <doing-id> --relation closeout-blocker.");
}

// COORD-931: one warning per runtime lock that is a dangling link. Read-only; the
// checked break-runtime-lock verb is the only recovery.
// COORD-928: a prompt_index entry whose prompt file has no committed copy is reported
// (read-only). Inspection failures are reported, never read as "nothing committed".
function buildPromptIndexDoctorWarnings({ board, coordDir = COORD_DIR, gitTry } = {}) {
  const { promptIndexCommitGaps } = require("./prompt-index-commit.js");
  let gaps;
  try {
    gaps = promptIndexCommitGaps({ gitTry, coordDir, promptIndex: board && board.prompt_index });
  } catch (error) {
    return [`[prompt-index] could not inspect git state, so prompt_index entries were not checked: ${error.message}`];
  }
  return gaps.map((gap) =>
    `[prompt-index] ${gap.ticket} -> ${gap.path} has no committed file (${gap.reason}); ` +
    "commit it to the integration branch through a governed ticket branch (COORD-928).");
}

function buildDanglingLockWarnings(locks) {
  const warnings = [];
  for (const { kind, path: lockPath } of locks) {
    const dangling = directoryLocks.describeDanglingLink(lockPath);
    if (dangling) {
      warnings.push(`[runtime-lock] ${kind} lock at ${lockPath} is a dangling link (${dangling}). Inspect with coord/scripts/gov runtime-lock-status --kind ${kind}; recover with coord/scripts/gov break-runtime-lock --kind ${kind} --yes (re-checked before removal, receipt written).`);
    }
  }
  return warnings;
}

module.exports = function createDoctorReport(deps = {}) {
  const fail = deps.fail || defaultFail;
  const inspectViews = deps.inspectMaterializedViews || inspectMaterializedViews;
  const runBoardPushPreflight = deps.runBoardPushPreflight || defaultBoardPushPreflight;

  const {
    // MUTATING repair (wired back from doctor-recovery for --fix delegation)
    doctorFix,
    // board-state readers
    readBoard,
    getTicketRef,
    getRows,
    rowsById,
    runBoardValidate,
    // readiness / cycle formatters
    evaluateReadiness,
    formatDependencyCycleList,
    formatTransitiveBlockerDetails,
    // status / repo predicates
    isDoingStatus,
    isRepoBackedCode,
    getRepoRoot,
    repoNameForCode,
    requiresLandingGovernance,
    hasPromptWaiver,
    // locks + worktree audit
    findLockForTicket,
    isStaleTicketLock,
    safeResolveLockHead,
    inspectCanonicalLockMirrorState,
    auditRepoWorktrees,
    // COORD-635: control-plane worktree audit
    auditCoordWorktrees,
    // identity / sessions
    readAgentSessions,
    ensureCurrentAgentIdentity,
    isNoActiveClaimedSessionError,
    isRegisteredAgentHandle,
    canonicalizeOwnerOrFail,
    detectActiveSameOwnerOtherThread,
    detectColocatedForeignSessions,
    // landing
    assertLandingIntegrity,
    ensureTestingInfrastructureLandingAudit,
    collectLandingAuditReport,
    formatLandingAuditSummary,
    // provenance / drift / freshness
    appendGovernanceProvenanceIssues,
    detectOutOfBandBoardMutation,
    detectRollbackDrift,
    computeSyncDelta,
    canonicalSyncablePaths,
    gitTry,
    // questions / template feedback / event log
    readGovernanceEventLog,
    // ENT-002: tamper-evident journal hash-chain verifier (read-only). Injected
    // so doctor can surface a broken prev_event_hash link (tamper / reorder /
    // drop) as an error without owning the journal module.
    verifyGovernanceChain,
    buildJournalHealthReport,
    formatJournalHealthWarning,
    collectStaleTemplateFeedbackErrors,
    // COORD-243: read-only, sub-second coverage-MATURITY staleness DETECT.
    // Injected so doctor can surface a "TEST_MATURITY.md stale -> run Y" line
    // WITHOUT running a tool or writing the artifact. Mirrors the
    // collectStaleTemplateFeedbackErrors nag; routed to warnings (advisory) so a
    // stale maturity file never wedges finalize. The DO verb (gov coverage-rollup)
    // is what refreshes the file — doctor only detects.
    detectMaturityStaleness,
    buildQuestionQueueReport,
    readActiveOrchestratorQuestionRows,
    formatBucketCounts,
    buildDoctorResolutionGuidance,
    // COORD-092: gate process-orphan detection (read-only). Injected so the
    // report can surface orphaned gate-proc registry entries as warnings
    // without owning the registry module.
    detectGateProcOrphans,
    checkGitPrerequisite = defaultGitPrerequisite,
  } = deps;

  function resolveDoctorScope(board, ticketId) {
    const targetRef = ticketId ? getTicketRef(board, ticketId) : null;
    if (ticketId && !targetRef) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    return {
      targetRef,
      rows: targetRef ? [targetRef.row] : getRows(board),
      byId: rowsById(board),
    };
  }

  function resolveDoctorOwnerScope(options) {
    if (typeof options.owner === "string" && options.owner.length > 0) {
      return canonicalizeOwnerOrFail(options.owner);
    }
    if (options.scopeSelf !== true) {
      return null;
    }
    try {
      const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      return identity?.agent?.handle || null;
    } catch (error) {
      if (isNoActiveClaimedSessionError(error)) {
        return null;
      }
      throw error;
    }
  }

  function doctor(options = {}) {
    if (options.repairAll) {
      return doctorFix({ ...options, repairAll: true });
    }
    if (options.fix) {
      return doctorFix(options);
    }
    const board = readBoard();
    const { targetRef, rows, byId } = resolveDoctorScope(board, options.ticket || null);
    if (!options.ticket) {
      runBoardValidate();
    }
    const errors = [];
    const warnings = [];
    const gitPrerequisite = checkGitPrerequisite();
    if (!gitPrerequisite.ok) warnings.push(`[git-prerequisite] ${gitPrerequisite.diagnostic}`);
    // COORD-931: a dangling lock link looks absent to existsSync but blocks every
    // acquire at its canonical path; report it explicitly (read-only; recovery is
    // the checked break-runtime-lock verb).
    for (const warning of buildDanglingLockWarnings([
      { kind: "governance-runtime", path: state.GOVERNANCE_EVENT_LOCK_DIR },
      { kind: "agent-state", path: state.AGENT_STATE_LOCK_DIR },
      { kind: "coord-state", path: state.COORD_STATE_LOCK_DIR },
    ])) warnings.push(warning);
    for (const warning of buildPromptIndexDoctorWarnings({ board })) warnings.push(warning);
    for (const warning of buildOwnerDoingDoctorWarnings({ board })) warnings.push(warning);
    // COORD-1047 (b): report-only attempt staleness and orphaning for doing tickets (ADR 0023
    // section 7). Read-only; a repository without an origin remote has no namespace and is skipped.
    {
      const doingTickets = [...rowsById(board).values()].filter((row) => isDoingStatus(row.Status)).map((row) => row.ID);
      const health = require("./attempt-coordination.js").attemptHealth(path.dirname(state.RUNTIME_DIR), { tickets: doingTickets });
      for (const finding of health.findings) {
        warnings.push(`[${finding.class}] ${finding.ticket}: attempt ${finding.attempt_id} by ${finding.agent} (domain ${finding.domain_id}) ` +
          `last updated ${finding.updated_at}. Report only; nothing is deleted (ADR 0023 section 7).`);
      }
      for (const problem of health.problems) warnings.push(`[attempt-health] ${problem.ticket}: check did not complete: ${problem.message}`);
    }
    const templateFeedbackErrors = [];
    const cycleErrors = new Set();
    const sessions = readAgentSessions();
    const ownerScope = resolveDoctorOwnerScope(options);

    // A "physical repair" issue is one only the ticket's owner can fix
    // (their lock, their worktree HEAD, their session-mirror state). When
    // ownerScope is set and the ticket is owned by someone else, demote to
    // a warning so foreign drift does not block unrelated agents. Board-level
    // issues (cycles, unassigned, blocked, prompt coverage, landing evidence)
    // remain hard errors regardless of scope.
    function pushPhysicalRepairIssue(message, ownerHandle) {
      if (ownerScope && ownerHandle && ownerHandle !== ownerScope) {
        warnings.push(`[other owner: ${ownerHandle}] ${message}`);
      } else {
        errors.push(message);
      }
    }

    for (const row of rows) {
      const readiness = evaluateReadiness(row, byId, board);
      const canonicalLock = findLockForTicket(row.ID);
      if (readiness.cycles.length > 0) {
        const cycleText = formatDependencyCycleList(readiness.cycles);
        const cycleKey = `${row.ID}:${cycleText}`;
        if (!cycleErrors.has(cycleKey)) {
          errors.push(`Ticket ${row.ID} participates in dependency cycle(s): ${cycleText}.`);
          cycleErrors.add(cycleKey);
        }
      }
      if (isDoingStatus(row.Status)) {
        if (readiness.blockedBy.length > 0) {
          const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
          errors.push(
            `Ticket ${row.ID} is doing but blocked by ${readiness.blockedBy.join(", ")}.` +
            (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "")
          );
        }
        if (row.Owner === "unassigned") {
          errors.push(`Ticket ${row.ID} is doing but unassigned.`);
        } else if (!isRegisteredAgentHandle(row.Owner)) {
          errors.push(`Ticket ${row.ID} is doing under unregistered owner ${row.Owner}.`);
        }
        if (!board.prompt_index?.[row.ID] && !hasPromptWaiver(board, row.ID)) {
          errors.push(`Ticket ${row.ID} is doing without prompt coverage or waiver evidence.`);
        }
        if (!canonicalLock) {
          pushPhysicalRepairIssue(`Ticket ${row.ID} is doing but has no lock.`, row.Owner);
        } else {
          const expectedPrefix = isRepoBackedCode(row.Repo)
            ? `${getRepoRoot(row.Repo)}/.worktrees/`
            : `${COORD_DIR}/.worktrees/`;
          if (!String(canonicalLock.worktree).startsWith(expectedPrefix)) {
            pushPhysicalRepairIssue(`Ticket ${row.ID} lock points to non-canonical worktree path ${canonicalLock.worktree}.`, row.Owner);
          }
          const liveHead = safeResolveLockHead(row.Repo, canonicalLock.worktree);
          if (!liveHead) {
            pushPhysicalRepairIssue(`Ticket ${row.ID} lock points to worktree without a readable git HEAD.`, row.Owner);
          } else if (canonicalLock.head !== liveHead) {
            if (liveHead === "coord-no-git-head") {
              pushPhysicalRepairIssue(`Ticket ${row.ID} coord lock head must be coord-no-git-head when no control-plane Git repository exists.`, row.Owner);
            } else {
              pushPhysicalRepairIssue(`Ticket ${row.ID} lock head ${canonicalLock.head || "(missing)"} does not match worktree HEAD ${liveHead}.`, row.Owner);
            }
          }
        }
      }
      if (canonicalLock && canonicalLock.status === STATUS.DOING && !isStaleTicketLock(canonicalLock)) {
        const mirrorState = inspectCanonicalLockMirrorState({
          board,
          row,
          lock: canonicalLock,
          sessions,
        });
        for (const message of mirrorState.issues) {
          pushPhysicalRepairIssue(`${message} Run \`coord/scripts/gov doctor --fix --ticket ${row.ID}\` to rebuild mirrored state from the canonical lock.`, row.Owner);
        }
        for (const message of mirrorState.conflicts) {
          pushPhysicalRepairIssue(`${message} Resolve the conflicting durable state manually before retrying ticket-scoped repair.`, row.Owner);
        }
        // COORD-011: identity/concurrency diagnostic — surface a live same-owner
        // other-thread holder directly (not hidden behind derived-artifact drift).
        const holderSession = sessions.find((session) => session.session_id === canonicalLock.session_id);
        const holderThreadId = holderSession ? holderSession.thread_id : (canonicalLock.thread_id || null);
        const idConflict = detectActiveSameOwnerOtherThread(row.ID, canonicalLock, {
          sessions,
          currentThreadId: holderThreadId,
        });
        if (idConflict.present) {
          const others = idConflict.active_owner_sessions
            .map((session) => `${session.session_id}@thread:${session.thread_id}`)
            .join(", ");
          pushPhysicalRepairIssue(
            `[identity/concurrency] Ticket ${row.ID} doing lock for ${canonicalLock.owner} has ` +
            `${idConflict.active_owner_sessions.length} other live same-owner thread session(s): ${others}. ` +
            `Confirm the true live owner; a non-holder thread must not rebind without --human-admin-override.`,
            row.Owner,
          );
        }
      }
      if (row.Status === STATUS.DONE && requiresLandingGovernance(board, row.ID, row)) {
        const landing = board.landing_index?.[row.ID];
        if (!landing || !Array.isArray(landing.evidence) || landing.evidence.length === 0) {
          errors.push(`Ticket ${row.ID} is done but missing landing_index evidence.`);
        } else if (isRepoBackedCode(row.Repo)) {
          try {
            assertLandingIntegrity(row.ID, row, landing);
            ensureTestingInfrastructureLandingAudit(row.ID, row, landing);
          } catch (error) {
            errors.push(error.message);
          }
        } else if (row.Repo === "X") {
          // COORD-635: control-plane landings were skipped entirely here.
          // Records that CLAIM remote verification are re-verified; historical
          // local-only records are grandfathered, never invalidated.
          try {
            assertControlPlaneLandingIntegrity(row.ID, landing);
          } catch (error) {
            errors.push(error.message);
          }
        }
      }
    }

    const audits = Object.fromEntries(
      Object.keys(REPO_ROOTS)
        .filter((repoCode) => repoCode !== "X")
        .sort()
        .map((repoCode) => [repoNameForCode(repoCode), auditRepoWorktrees(repoCode, byId)])
    );
    // COORD-635: control-plane worktrees are CONTROL-PLANE state. They used to
    // be invisible here, or — when a configured product-repo directory was not
    // itself a repository — reported under that product repo's name, sending
    // the operator to the wrong repository entirely. Report them explicitly,
    // name coord/, and name the governed remediation (which now exists).
    if (typeof auditCoordWorktrees === "function") {
      try {
        const coordAudit = auditCoordWorktrees(byId);
        const coordLabel = coordAudit.control_plane_repo_root
          ? `control-plane repository ${coordAudit.control_plane_repo_root}`
          : "control plane (coord/)";
        // auditCoordWorktrees always returns each collection as an array.
        for (const stale of coordAudit.stale_worktrees) {
          if (targetRef && stale.ticket !== targetRef.row.ID) continue;
          pushPhysicalRepairIssue(
            `[control-plane] stale coord worktree for ${stale.ticket} in the ${coordLabel}: ${stale.path} ` +
            `(status ${stale.status}). This is coord/ state, NOT backend/frontend state. ` +
            `Remove it with \`coord/scripts/gov cleanup-worktree coord ${stale.ticket} --yes\`.`,
            stale.owner || byId.get(stale.ticket)?.Owner || null,
          );
        }
        for (const unknown of coordAudit.unknown_ticket_worktrees) {
          errors.push(
            `[control-plane] unknown coord worktree in the ${coordLabel}: ${unknown.path}. ` +
            "This is coord/ state, NOT backend/frontend state. " +
            `Remove it with \`coord/scripts/gov cleanup-worktree coord ${shellQuote(unknown.path)} --yes\`.`
          );
        }
        for (const orphan of coordAudit.orphaned_registrations) {
          errors.push(
            `[control-plane] orphaned coord worktree registration in the ${coordLabel}: ${orphan} ` +
            "is registered in git but its directory is gone. " +
            `Remove it with \`coord/scripts/gov cleanup-worktree coord ${shellQuote(orphan)} --yes\`.`
          );
        }
        for (const missing of coordAudit.missing_doing_worktrees) {
          if (targetRef && missing !== targetRef.row.ID) continue;
          pushPhysicalRepairIssue(
            `[control-plane] missing coord worktree for doing ticket ${missing} in the ${coordLabel}.`,
            byId.get(missing)?.Owner || null,
          );
        }
      } catch (error) {
        warnings.push(`[control-plane] could not audit coord worktrees: ${error.message}`);
      }
    }

    // COORD-898 (3): a product clone with no usable integration-branch ref (or a
    // local ref that lags origin) breaks governed start/submit; name the remedy.
    for (const repoCode of Object.keys(REPO_ROOTS).filter((code) => code !== "X").sort()) {
      let repoRoot = null;
      try {
        repoRoot = getRepoRoot(repoCode);
      } catch {
        repoRoot = null;
      }
      if (!repoRoot || !require("node:fs").existsSync(repoRoot)) continue;
      try {
        // Same branch the registry resolves (repo-registry.js resolveRepoIntegrationBranch).
        const branch = DEFAULT_PATHS.repoIntegrationBranches?.[repoCode] || DEFAULT_INTEGRATION_BRANCH;
        for (const finding of integrationBaseRefFindings(repoRoot, branch)) {
          const line = `[${finding.code}] ${repoNameForCode(repoCode)}: ${finding.message}. Remedy: ${finding.remedy}`;
          if (finding.severity === "high") errors.push(line);
          else warnings.push(line);
        }
      } catch (error) {
        warnings.push(`[integration-base-ref] ${repoNameForCode(repoCode)}: check did not complete: ${error.message}`);
      }
    }

    for (const [repoName, audit] of Object.entries(audits)) {
      if (typeof audit.repo_root === "string") {
        try {
          const visibility = productWorktreeExclude.formatProductWorktreeExcludeWarning(
            repoName, productWorktreeExclude.inspectProductWorktreeExclude({ repoRoot: audit.repo_root }));
          if (visibility) warnings.push(visibility);
        } catch (error) {
          warnings.push(`[worktree-visibility] ${repoName}: could not check whether ${audit.repo_root}/.worktrees is ignored: ${error.message}`);
        }
      }
      if (audit.is_own_repository === false) {
        warnings.push(
          `Configured repo directory ${audit.repo_root} (${repoName}) is not a Git repository of its own` +
          (audit.enclosing_repository ? `; it sits inside ${audit.enclosing_repository}` : "") +
          (audit.worktrees_audited === true && audit.audit_scope === "configured-product-worktrees"
            ? ". Only its configured .worktrees subtree is audited; other enclosing-repository worktrees " +
              "are excluded to prevent cross-attribution (COORD-805 / COORD-635)."
            : ". Worktree state for it is not audited, because reporting the enclosing repository's " +
              "worktrees as this repo's would misattribute them (COORD-635).")
        );
      }
      for (const stale of audit.stale_ticket_worktrees) {
        if (targetRef && stale.ticket !== targetRef.row.ID) {
          continue;
        }
        pushPhysicalRepairIssue(`${repoName} stale worktree for ${stale.ticket}: ${stale.path}`, stale.owner);
      }
      for (const unknown of audit.unknown_ticket_worktrees) {
        if (targetRef && unknown.ticket !== targetRef.row.ID) {
          continue;
        }
        // Unknown worktrees have no associated ticket row, so no owner to scope by — keep as board-level error.
        errors.push(`${repoName} unknown ticket worktree: ${unknown.path}`);
      }
      for (const missing of audit.missing_doing_worktrees) {
        if (targetRef && missing !== targetRef.row.ID) {
          continue;
        }
        if ((audit.invalid_ticket_worktrees || []).some((entry) => entry.ticket === missing)) {
          continue;
        }
        pushPhysicalRepairIssue(`${repoName} missing doing worktree for ${missing}`, byId.get(missing)?.Owner || null);
      }
      for (const invalid of audit.invalid_ticket_worktrees || []) {
        if (targetRef && invalid.ticket !== targetRef.row.ID) continue;
        pushPhysicalRepairIssue(
          `${repoName} invalid registered worktree for ${invalid.ticket}: ${invalid.reason}` +
          (invalid.path ? ` (${invalid.path})` : ""),
          invalid.owner || byId.get(invalid.ticket)?.Owner || null,
        );
      }
      for (const wrongRepo of audit.wrong_repo_ticket_worktrees || []) {
        if (targetRef && wrongRepo.ticket !== targetRef.row.ID) continue;
        errors.push(
          `${repoName} contains a registered worktree for ${wrongRepo.ticket} under its product .worktrees ` +
          `directory, but the board assigns that ticket to ${wrongRepo.repo || "another repo"}: ${wrongRepo.path}`
        );
      }
    }

    // COORD-477: classify the control plane's git state ONCE per board-wide run.
    // An unborn coord/ repository swaps the generic journal/derived-drift errors
    // for one actionable bootstrap-pending notice; strict diagnostics resume
    // after the first baseline commit (state flips to "established").
    // COORD-631: the classified directory is coord/, never the container.
    const coordGit = !targetRef
      ? classifyCoordGitState({ gitTry, coordDir: COORD_DIR })
      : { state: "unknown", root: null };
    const bootstrapPending = !targetRef && coordGit.state === "unborn";
    if (bootstrapPending) {
      warnings.push(buildBootstrapPendingNotice(coordGit));
    }
    if (!targetRef && !bootstrapPending) {
      appendGovernanceProvenanceIssues(errors, warnings);
    }
    if (!targetRef) {
      // COORD-222: surface co-located governed sessions — two or more
      // heartbeat-fresh sessions bound to THIS runtime (coord/.runtime) on
      // different threads. This is the condition `gov start` / `gov claim` now
      // FAIL CLOSED on (unless --allow-shared-worktree). Doctor cannot know
      // whether the operator opted into the shared-worktree topology, so it
      // reports the co-located set as an informational warning, not a hard error.
      if (typeof detectColocatedForeignSessions === "function") {
        try {
          // Compute the full fresh-session set on this runtime by treating "no
          // current thread" as the vantage point, so every fresh session shows up.
          const colocated = detectColocatedForeignSessions({ currentThreadId: null, sessions });
          if (colocated.foreign_sessions.length >= 2) {
            const others = colocated.foreign_sessions
              .map((session) => `${session.session_id || "?"}(${session.handle || "?"})@thread:${session.thread_id}`)
              .join(", ");
            warnings.push(
              `[identity/concurrency] ${colocated.foreign_sessions.length} heartbeat-fresh governed sessions are ` +
              `co-located on this runtime (coord/.runtime) across different threads: ${others}. ` +
              "The mkdir runtime lock serializes their governed-file mutations, so this is not journal corruption; " +
              "they do churn each other's owner leases and board claims, and nothing serializes their Git working " +
              `files or external effects (coord/engine/docs/MULTI_AGENT_TOPOLOGIES.md § "Concurrency contract"). ` +
              "Each concurrent agent should use a SEPARATE git worktree " +
              "with its own coord/.runtime, or this was an intentional --allow-shared-worktree session."
            );
          }
        } catch {
          // Session-read failures are already surfaced elsewhere; never wedge doctor on this advisory.
        }
      }
    }
    if (!targetRef && !bootstrapPending) {
      // COORD-220: surface out-of-band coordination-state mutations (a hand-edited
      // tasks.json / stray plan / prompt / rendered file with no journaled
      // transaction) as a dedicated bypass finding so the operator sees it named as
      // a single-writer-protocol violation, not just generic drift. The governed
      // writers FAIL CLOSED on the same condition; doctor reports it for diagnosis.
      if (typeof detectOutOfBandBoardMutation === "function") {
        try {
          const outOfBand = detectOutOfBandBoardMutation();
          if (outOfBand.detected) {
            const finding = buildOutOfBandFinding(outOfBand);
            errors.push(...[finding.error].filter(Boolean));
            warnings.push(...[finding.warning].filter(Boolean));
          }
        } catch {
          // Provenance read failures are already surfaced by appendGovernanceProvenanceIssues.
        }
      }
    }
    // ENT-002: journal hash-chain integrity. Board-wide only (ticket-scoped runs
    // stay targeted). A broken prev_event_hash link means an event was tampered,
    // reordered, or dropped — fail-safe ERROR class. Pre-chain legacy events are
    // accepted-but-unverified and reported as a warning only when present, never
    // a false tamper alarm.
    if (!targetRef && typeof verifyGovernanceChain === "function") {
      try {
        const chain = verifyGovernanceChain();
        if (!chain.ok) {
          const detail = chain.broken
            .slice(0, 5)
            .map((b) => `#${b.index} (${b.reason}${b.command ? `, ${b.command}` : ""}${b.ts ? ` @ ${b.ts}` : ""})`)
            .join(", ");
          errors.push(
            `Governance journal hash-chain is broken at ${chain.broken.length} event(s): ${detail}. ` +
            `The journal (governance-events.ndjson) was reordered, tampered, or had an event dropped. ` +
            `Inspect with \`coord/scripts/gov conform\`; restore the journal from a trusted source if the break is not a legitimate repair.`
          );
        } else if (chain.preChainCount > 0 && chain.chainedCount === 0) {
          warnings.push(
            `[journal-chain] ${chain.preChainCount} pre-chain (legacy) event(s) and no chained events yet; ` +
            `the next journaled mutation will anchor the hash-chain. Accepted-but-unverified, not a tamper signal.`
          );
        }
      } catch (error) {
        const reason = error && error.message ? error.message : String(error);
        warnings.push(`[journal-chain] chain verification did not complete: ${reason}`);
      }
    }
    if (!targetRef && typeof buildJournalHealthReport === "function") {
      try {
        const report = buildJournalHealthReport();
        const message = typeof formatJournalHealthWarning === "function"
          ? formatJournalHealthWarning(report)
          : null;
        if (message) {
          warnings.push(message);
        }
      } catch (error) {
        const reason = error && error.message ? error.message : String(error);
        warnings.push(`[journal-retention] health check did not complete: ${reason}`);
      }
    }
    const governanceEvents = readGovernanceEventLog();
    for (const message of collectStaleTemplateFeedbackErrors(board, governanceEvents, { rows })) {
      templateFeedbackErrors.push(message);
      errors.push(message);
    }
    // COORD-243 DETECT: cheap, READ-ONLY coverage-maturity staleness. Board-wide
    // only (ticket-scoped runs stay targeted/fast). It reads coord/TEST_MATURITY.md
    // + the journal + recorded coverage gate signals and emits ONE actionable
    // "X stale -> run Y" warning line when the maturity file is old (by time OR by
    // tickets-landed-since) or a recorded coverage/mutation dimension is below its
    // gate threshold. HARD RULE: this only DETECTS — it never runs a tool and never
    // writes a file. The fix is the SEPARATE `gov coverage-rollup` verb.
    if (!targetRef && typeof detectMaturityStaleness === "function") {
      try {
        for (const finding of detectMaturityStaleness()) {
          warnings.push(`[coverage-maturity] ${finding}`);
        }
      } catch (error) {
        const reason = error && error.message ? error.message : String(error);
        warnings.push(`[coverage-maturity] staleness check did not complete: ${reason}`);
      }
    }
    // Phase 4 (repair-path hardening): non-fatal freshness/rollback-drift
    // warnings. Board-wide only (skipped for ticket-scoped runs) and routed to
    // the warnings channel so existing green doctor runs and `doctor --fix`
    // behavior stay unaffected. Skipped while bootstrap-pending (COORD-477).
    if (!targetRef && !bootstrapPending) {
      const freshness = detectRollbackDrift();
      for (const reason of freshness.reasons) {
        warnings.push(`[freshness] ${reason}`);
      }
    }

    // COORD-092: orphaned gate-proc detection (warning-class, like orphan
    // worktrees). Surfaces gate-run registry entries whose owning gate-run is
    // gone (no live PID matching the recorded PID+start-time) or whose owning
    // ticket is no longer doing. Read-only: never signals a process here.
    // Board-wide only (ticket-scoped runs stay targeted). The owning-ticket
    // liveness is decided against the board: a ticket is "doing" if its row has
    // a doing status.
    if (!targetRef && typeof detectGateProcOrphans === "function") {
      try {
        const isTicketDoing = (ticketId) => {
          const row = byId.get(ticketId);
          return Boolean(row && isDoingStatus(row.Status));
        };
        const orphans = detectGateProcOrphans({ isTicketDoing });
        for (const orphan of orphans) {
          const owner = orphan.entry?.ticket ? `ticket ${orphan.entry.ticket}` : "no ticket";
          const lane = orphan.entry?.lane ? ` lane=${orphan.entry.lane}` : "";
          const repo = orphan.entry?.repo ? ` repo=${orphan.entry.repo}` : "";
          warnings.push(
            `[gate-proc-orphan] gate-run ${orphan.gateRunId} (${owner}${repo}${lane}) is orphaned: ` +
            `${orphan.reason}. Run \`coord/scripts/gov reap-gate-procs\` to reap recorded PIDs ` +
            `(provenance-scoped by recorded PID+start-time) and clear the registry entry.`
          );
        }
      } catch (error) {
        const reason = error && error.message ? error.message : String(error);
        warnings.push(`[gate-proc-orphan] orphan check did not complete: ${reason}`);
      }
    }

    // COORD-894: can the board commit be pushed? Board-wide only. A blocked
    // push (in push mode) or an unobservable answer is a warning BEFORE the
    // first finalize; "unknown" is never reported as a pass.
    // COORD-947: the affected-target map staleness finding quality-scan files (one line).
    if (!targetRef) warnings.push(...require("./quality-scan.js").affectedMapDoctorWarnings());
    if (!targetRef) {
      try {
        warnings.push(...boardPushPreflight.boardPushDoctorWarnings(runBoardPushPreflight(options)));
      } catch (error) {
        warnings.push(`[board-push] preflight did not complete: ${error && error.message ? error.message : String(error)}`);
      }
    }

    // Diagnose content independently of provenance: accepting a new snapshot
    // cannot restore required blocks that a projector silently discarded.
    try {
      for (const issue of inspectViews({ coordDir: COORD_DIR, paths: state, board })) {
        errors.push(`[${issue.code}] ${issue.message}`);
      }
    } catch (error) {
      errors.push(`[derived_view_inspection_failed] ${error.message}`);
    }

    // GCV-3 slice 3: strict canonical-derived drift invariant.
    //
    // Spec acceptance: "gov doctor cannot report journal-vs-board drift on a
    // healthy repo." So canonical-derived drift is an ERROR, not a warning —
    // this is the strict enforcer that pairs with slice 2's best-effort
    // auto-trigger. If slice 2 silently failed (or the operator passed
    // --no-sync), the next `gov doctor` surfaces the drift hard rather than
    // letting it accumulate.
    //
    // Board-wide only (ticket-scoped runs stay targeted/fast). This is
    // intentionally read-only: doctor only inspects current drift and recommends
    // `gov sync`; it must never regenerate derived artifacts itself.
    //
    // COORD-477: while the root is bootstrap-pending (unborn HEAD), everything
    // is "drift from HEAD" by definition — the actionable finding is the single
    // bootstrap-pending notice above, so this strict check is deferred until
    // the first baseline commit exists.
    if (!targetRef && !bootstrapPending) {
      try {
        const syncScope = canonicalSyncablePaths();
        const driftPaths = computeSyncDelta(COORD_DIR, syncScope);
        let driftError = buildCanonicalDerivedDriftError(driftPaths);
        if (driftError && typeof gitTry === "function") {
          const hazard = treeMutationSafety.buildTreeMutationSafetyHazard({
            gitTry,
            repoRoot: COORD_DIR,
            allowedPaths: syncScope,
            board,
            getRows,
            isDoingStatus,
            findLockForTicket,
            isStaleTicketLock,
          });
          if (hazard) {
            driftError = `${driftError} ${treeMutationSafety.formatTreeMutationSafetyHazard(hazard)}`;
          }
        }
        if (driftError) {
          errors.push(driftError);
        }
        if (typeof gitTry === "function") {
          const status = gitTry(COORD_DIR, ["status", "--porcelain", "--untracked-files=normal"]);
          if (status && status.status === 0) {
            const enginePaths = driftScope.loadEngineManifestPaths(path.dirname(COORD_DIR));
            const engineWarning = buildEngineDriftWarning(treeMutationSafety.parsePorcelainStatusPaths(status.stdout), { enginePaths });
            if (engineWarning) warnings.push(engineWarning);
          }
        }
      } catch (error) {
        // If the check itself can't run, report it as a non-fatal warning
        // rather than masking the real underlying issue that other checks may
        // already surface as errors.
        const reason = error && error.message ? error.message : String(error);
        warnings.push(`[canonical-derived-drift] drift check did not complete: ${reason}`);
      }
    }
    const queueDebt = buildQuestionQueueReport(readActiveOrchestratorQuestionRows());
    const landingAudit = collectLandingAuditReport(board, {
      rows,
      ticket: targetRef?.row.ID || null,
    });

    if (errors.length > 0) {
      const feedbackCounts = new Map();
      for (const message of templateFeedbackErrors) {
        feedbackCounts.set(message, (feedbackCounts.get(message) || 0) + 1);
      }
      const actionableErrors = errors.filter((message) => {
        const remaining = feedbackCounts.get(message) || 0;
        if (remaining === 0) {
          return true;
        }
        feedbackCounts.set(message, remaining - 1);
        return false;
      });
      const detailMode = options.showTemplateFeedback === true;
      const visibleErrors = detailMode
        ? [...actionableErrors, ...templateFeedbackErrors]
        : actionableErrors;
      const feedbackCount = templateFeedbackErrors.length > 0
        ? ` TEMPLATE_FEEDBACK=${templateFeedbackErrors.length}`
        : "";
      const total = `errors=${errors.length} actionable=${actionableErrors.length}${feedbackCount}`;
      const guidance = buildDoctorResolutionGuidance(visibleErrors);
      const feedbackSummary = templateFeedbackErrors.length > 0 && !detailMode
        ? `\nTEMPLATE_FEEDBACK: ${templateFeedbackErrors.length} individual findings hidden; rerun with --show-template-feedback to inspect them.`
        : "";
      fail(
        `Governance doctor found issues: ${total}\n${visibleErrors.join("\n")}${guidance}${feedbackSummary}`
      );
    }
    console.log("Governance doctor OK: no additional issues found.");
    if (warnings.length > 0 || queueDebt.total > 0) {
      console.log("Governance doctor warnings:");
      for (const warning of warnings) {
        console.log(warning);
      }
      if (queueDebt.total > 0) {
        console.log(
          `Queue debt: unresolved orchestrator questions=${queueDebt.total}; ` +
          `type(${formatBucketCounts(queueDebt.by_type, ["blocker", "repair", "drift-note", "informational"])}); ` +
          `severity(${formatBucketCounts(queueDebt.by_severity, ["high", "medium", "low"])}); ` +
          `aging(${formatBucketCounts(queueDebt.by_aging, ["same-day", "aging", "stale"])})`
        );
      }
    }
    const landingAuditLines = formatLandingAuditSummary(landingAudit);
    if (landingAuditLines.length > 0) {
      console.log(landingAuditLines.join("\n"));
    }
  }

  return {
    doctor,
    resolveDoctorScope,
    resolveDoctorOwnerScope,
    buildCanonicalDerivedDriftError,
    classifyCoordGitState,
    buildBootstrapPendingNotice,
  };
};

module.exports.buildCanonicalDerivedDriftError = buildCanonicalDerivedDriftError;
module.exports.buildDanglingLockWarnings = buildDanglingLockWarnings;
module.exports.buildPromptIndexDoctorWarnings = buildPromptIndexDoctorWarnings;
module.exports.classifyCoordGitState = classifyCoordGitState;
module.exports.buildBootstrapPendingNotice = buildBootstrapPendingNotice;
module.exports.buildEngineDriftWarning = buildEngineDriftWarning;
module.exports.buildOutOfBandFinding = buildOutOfBandFinding;
// COORD-963: exported for the owner-doing warning test (followups.test.js).
module.exports.buildOwnerDoingDoctorWarnings = buildOwnerDoingDoctorWarnings;
