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

const { defaultFail, COORD_DIR, DEFAULT_PATHS } = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");

const REPO_ROOTS = DEFAULT_PATHS.repoRoots;

// GCV-3 slice 3: pure formatter for the canonical-derived drift doctor
// error. Returns null when there is no drift (clean repo); otherwise
// returns a single actionable error string naming the drifting paths and
// pointing the operator at the remediation. Pure (no IO) so it is
// unit-testable in isolation.
function buildCanonicalDerivedDriftError(driftPaths) {
  if (!Array.isArray(driftPaths) || driftPaths.length === 0) return null;
  const paths = driftPaths.slice().sort();
  return (
    `Canonical derived artifacts drift from HEAD on ${paths.length} ` +
    `path(s): ${paths.join(", ")}. ` +
    `These paths are deterministically regenerable; the working tree ` +
    `must not lag the journal. Run \`coord/scripts/gov sync --commit ` +
    `"<message>"\` to regenerate and commit them, or rerun the lifecycle ` +
    `action that produced this state without --no-sync.`
  );
}

module.exports = function createDoctorReport(deps = {}) {
  const fail = deps.fail || defaultFail;

  const {
    // MUTATING repair (wired back from doctor-recovery for --fix delegation)
    doctorFix,
    // board-state readers
    readBoard,
    getTicketRef,
    getRows,
    rowsById,
    runBoardValidate,
    runBoardSync,
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
    // identity / sessions
    readAgentSessions,
    ensureCurrentAgentIdentity,
    isNoActiveClaimedSessionError,
    isRegisteredAgentHandle,
    canonicalizeOwnerOrFail,
    detectActiveSameOwnerOtherThread,
    // landing
    assertLandingIntegrity,
    ensureTestingInfrastructureLandingAudit,
    collectLandingAuditReport,
    formatLandingAuditSummary,
    // provenance / drift / freshness
    appendGovernanceProvenanceIssues,
    detectRollbackDrift,
    computeSyncDelta,
    canonicalSyncablePaths,
    // questions / template feedback / event log
    readGovernanceEventLog,
    // ENT-002: tamper-evident journal hash-chain verifier (read-only). Injected
    // so doctor can surface a broken prev_event_hash link (tamper / reorder /
    // drop) as an error without owning the journal module.
    verifyGovernanceChain,
    collectStaleTemplateFeedbackErrors,
    buildQuestionQueueReport,
    readActiveOrchestratorQuestionRows,
    formatBucketCounts,
    buildDoctorResolutionGuidance,
    // COORD-092: gate process-orphan detection (read-only). Injected so the
    // report can surface orphaned gate-proc registry entries as warnings
    // without owning the registry module.
    detectGateProcOrphans,
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
          if (isRepoBackedCode(row.Repo)) {
            const liveHead = safeResolveLockHead(row.Repo, canonicalLock.worktree);
            if (!liveHead) {
              pushPhysicalRepairIssue(`Ticket ${row.ID} lock points to worktree without a readable git HEAD.`, row.Owner);
            } else if (canonicalLock.head !== liveHead) {
              pushPhysicalRepairIssue(`Ticket ${row.ID} lock head ${canonicalLock.head || "(missing)"} does not match worktree HEAD ${liveHead}.`, row.Owner);
            }
          } else if (canonicalLock.head !== "coord-no-git-head") {
            pushPhysicalRepairIssue(`Ticket ${row.ID} coord lock head must be coord-no-git-head.`, row.Owner);
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
        }
      }
    }

    const audits = Object.fromEntries(
      Object.keys(REPO_ROOTS)
        .filter((repoCode) => repoCode !== "X")
        .sort()
        .map((repoCode) => [repoNameForCode(repoCode), auditRepoWorktrees(repoCode, byId)])
    );
    for (const [repoName, audit] of Object.entries(audits)) {
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
        pushPhysicalRepairIssue(`${repoName} missing doing worktree for ${missing}`, byId.get(missing)?.Owner || null);
      }
    }

    if (!targetRef) {
      appendGovernanceProvenanceIssues(errors, warnings);
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
    const governanceEvents = readGovernanceEventLog();
    for (const message of collectStaleTemplateFeedbackErrors(board, governanceEvents, { rows })) {
      errors.push(message);
    }
    // Phase 4 (repair-path hardening): non-fatal freshness/rollback-drift
    // warnings. Board-wide only (skipped for ticket-scoped runs) and routed to
    // the warnings channel so existing green doctor runs and `doctor --fix`
    // behavior stay unaffected.
    if (!targetRef) {
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

    // GCV-3 slice 3: strict canonical-derived drift invariant.
    //
    // Spec acceptance: "gov doctor cannot report journal-vs-board drift on a
    // healthy repo." So canonical-derived drift is an ERROR, not a warning —
    // this is the strict enforcer that pairs with slice 2's best-effort
    // auto-trigger. If slice 2 silently failed (or the operator passed
    // --no-sync), the next `gov doctor` surfaces the drift hard rather than
    // letting it accumulate.
    //
    // Board-wide only (ticket-scoped runs stay targeted/fast). The regen
    // before the delta check is idempotent on consistent state — writing
    // the same content back leaves git status clean — so this is safe to
    // run on every healthy invocation.
    if (!targetRef) {
      try {
        runBoardSync({ ticketScopedValidation: false });
        const driftPaths = computeSyncDelta(COORD_DIR, canonicalSyncablePaths());
        const driftError = buildCanonicalDerivedDriftError(driftPaths);
        if (driftError) {
          errors.push(driftError);
        }
      } catch (error) {
        // If the check itself can't run (e.g., runBoardSync throws because
        // tasks.json is malformed), report it as a non-fatal warning rather
        // than masking the real underlying issue that other checks will
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
      fail(`Governance doctor found issues:\n${errors.join("\n")}${buildDoctorResolutionGuidance(errors)}`);
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
  };
};

module.exports.buildCanonicalDerivedDriftError = buildCanonicalDerivedDriftError;
