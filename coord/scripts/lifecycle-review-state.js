"use strict";

// COORD-594: pre-review commit-state assertion + review-return plan append,
// extracted from the lifecycle composition root under the no-grandfather
// prodloc policy (extraction preferred over a budget bump).
//
// Cohesive cluster: everything here answers "is this ticket's work actually
// committed and ahead of its integration branch, and if a reviewer returns it,
// what does the plan record look like on the next round?". `assertCommitted-
// ReviewState` is the fail-closed gate used by move-review / PR creation /
// transitions; `appendReviewFollowupPlan` is the matching return-to-doing
// bookkeeping; `defaultStartTraceabilityValue` is the shared traceability
// default those paths seed.
//
// No state of its own: git access, repo/branch resolution, plan-record IO and
// the plan-shape normalizer are all injected. Collaborators constructed LATER
// in the root are injected as deferred `(...a) => fn(...a)` wrappers resolved
// at call time, so factory ordering in the root stays irrelevant. `fs` and
// `gitTry` are injected BY REFERENCE. Behavior is unchanged; the three names
// are re-destructured back into lifecycle scope so pr-ops / ticket-transitions
// / plan-command, the `commands` table and the `__testing` facade resolve
// exactly as before.
module.exports = function createLifecycleReviewState({
  BOARD_RAW_SYMBOL,
  appendUniquePlanRecordValue,
  assertCurrentTicketLockIntegrity,
  buildScaffoldPlanRecord,
  commitSubjectAffiliatesWithTicket,
  fail,
  fs,
  getRepoRoot,
  gitTry,
  isCommitAncestorOfRef,
  isRepoBackedCode,
  normalizeGovernancePlanShape,
  planRecordPath,
  planTargetsCoordOnlyArtifacts,
  readPlanRecord,
  readPlanRecordScaffoldPlaceholders,
  repoNameForCode,
  resolveLandingBaseRef,
  resolveRepoIntegrationBranch,
  resolveSourceCommitSha,
  stripPlanScaffoldValues,
  ticketRequiresTraceability,
  writeCanonicalJsonFile,
  writePlanCompatibilityBlockFromRecord,
}) {
  function assertCommittedReviewState(ticketId, row, lock, options = {}) {
    if (!lock || !isRepoBackedCode(row.Repo)) {
      return;
    }
    assertCurrentTicketLockIntegrity(ticketId, row, lock);
    if (!lock.worktree || !fs.existsSync(lock.worktree)) {
      fail(`Ticket ${ticketId} has no readable governed worktree to verify commit state.`);
    }

    const statusResult = gitTry(lock.worktree, ["status", "--porcelain"]);
    if (statusResult.status !== 0) {
      fail(`Could not verify git status for ${ticketId} in ${lock.worktree}.`);
    }
    if (String(statusResult.stdout || "").trim()) {
      fail(`Ticket ${ticketId} has uncommitted changes in ${lock.worktree}. Commit the work before review/PR creation.`);
    }

    const repoRoot = getRepoRoot(row.Repo);
    const sourceCommitSha = resolveSourceCommitSha(ticketId, row, options);
    // COORD-022: compare against this repo's configured integration branch
    // (default "dev"), not a hardcoded "dev", so main-integration adopters get
    // a correct ahead-count delta.
    const compareBaseRef = resolveLandingBaseRef(repoRoot, resolveRepoIntegrationBranch(row.Repo), sourceCommitSha, {
      explicitBase: options.baseExplicit === true,
    }).baseRef;

    const aheadResult = gitTry(lock.worktree, ["rev-list", "--count", `${compareBaseRef}..HEAD`]);
    if (aheadResult.status !== 0) {
      fail(`Could not verify commit delta for ${ticketId} against ${compareBaseRef} in ${lock.worktree}.`);
    }
    const aheadCount = Number.parseInt(String(aheadResult.stdout || "").trim(), 10);
    if (!Number.isFinite(aheadCount) || aheadCount < 1) {
      if (options.allowMergedPrReconcile === true) {
        return;
      }
      if (options.allowAlreadyLandedNoPrReconcile === true) {
        return;
      }
      if (planTargetsCoordOnlyArtifacts(ticketId)) {
        return;
      }
      if (
        sourceCommitSha &&
        isCommitAncestorOfRef(repoRoot, sourceCommitSha, compareBaseRef) &&
        commitSubjectAffiliatesWithTicket(repoRoot, sourceCommitSha, ticketId)
      ) {
        fail(
          `Ticket ${ticketId} has no committed changes ahead of ${compareBaseRef} because its governed source commit ${sourceCommitSha} ` +
          `already appears landed on ${repoNameForCode(row.Repo)}/${compareBaseRef}. ` +
          `Use \`coord/scripts/gov finalize ${ticketId} --no-pr --already-landed --landed "<canonical-branch closeout proof>"\` instead of supersede.`
        );
      }
      fail(
        `Ticket ${ticketId} has no committed changes ahead of ${compareBaseRef}. Commit the work before review/PR creation. ` +
        `If the ticket was already landed on ${compareBaseRef} before review, use ` +
        `\`coord/scripts/gov finalize ${ticketId} --no-pr --already-landed --landed "<canonical-branch closeout proof>"\`.`
      );
    }
  }

  function defaultStartTraceabilityValue(row) {
    return ticketRequiresTraceability(row) ? "closing-gap" : "exempt";
  }

  function appendReviewFollowupPlan(ticketId, findingId, summary, repoCode, owner, round = 1) {
    const existingRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
    const record = existingRecord
      ? JSON.parse(JSON.stringify(existingRecord))
      : buildScaffoldPlanRecord(ticketId, repoCode, owner, {
          reviewRound: round,
          priorFindings: [],
          changeSummary: [],
        });
    const normalizedGovernance = normalizeGovernancePlanShape(record.governance, repoCode);
    const priorFindingEntry = `${findingId} — ${summary}`;
    record.review_round = round;
    record.prior_findings = appendUniquePlanRecordValue(record.prior_findings || [], priorFindingEntry);
    record.change_summary = appendUniquePlanRecordValue(
      stripPlanScaffoldValues("change_summary", record.change_summary || [], {
        ticketId,
        incomingValue: `Address review return finding ${findingId}.`,
        scaffoldValues: readPlanRecordScaffoldPlaceholders(record, "change_summary"),
      }),
      `Address review return finding ${findingId}.`
    );
    normalizedGovernance.ticket_local_repairs = [
      ...(Array.isArray(normalizedGovernance.ticket_local_repairs) ? normalizedGovernance.ticket_local_repairs : []),
      {
        kind: "return_doing",
        required_question_logged: false,
        note: `Repair round ${round} started for ${findingId}.`,
      },
    ];
    record.governance = normalizedGovernance;
    record.self_review_cycles = buildScaffoldPlanRecord(ticketId, repoCode, owner, {
      reviewRound: round,
      priorFindings: record.prior_findings,
      changeSummary: record.change_summary,
    }).self_review_cycles;
    const expectedRaw = existingRecord?.[BOARD_RAW_SYMBOL] ?? "";
    writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw });
    writePlanCompatibilityBlockFromRecord(ticketId, record);
  }

  return {
    appendReviewFollowupPlan,
    assertCommittedReviewState,
    defaultStartTraceabilityValue,
  };
};
