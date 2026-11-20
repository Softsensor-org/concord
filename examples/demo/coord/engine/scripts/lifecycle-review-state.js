"use strict";

const { defaultControlPlaneLayout } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js"));

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
function createReviewSubmissionState({
  BOARD_RAW_SYMBOL,
  fail,
  getRepoRoot,
  isRepoBackedCode,
  planRecordPath,
  readPlanRecord,
  repoNameForCode,
  repoCodeForLockRepoName,
  controlPlaneLayout = defaultControlPlaneLayout,
  resolveSourceCommitSha,
  resolveCommitishInRepo,
  writeCanonicalJsonFile,
  writePlanCompatibilityBlockFromRecord,
}) {
  function resolveReviewSubmission(ticketId, row, lock) {
    const declaredRepo = repoNameForCode(row.Repo);
    const coordRepoRoot = row.Repo === "X" ? controlPlaneLayout()?.coordRepoRoot : null;
    if (!declaredRepo || repoCodeForLockRepoName(lock?.repo) !== row.Repo) {
      fail(`Ticket ${ticketId} lock repository does not match declared repository ${row.Repo}.`);
    }
    if (lock?.head === "coord-no-git-head") {
      if (row.Repo === "X" && !coordRepoRoot) {
        return { submission: null, unresolved_reason: "control-plane repository topology has no Git commit identity" };
      }
      fail(`Ticket ${ticketId} lock uses the no-Git sentinel outside a verified no-Git control-plane topology.`);
    }
    if (!lock?.head) fail(`Ticket ${ticketId} has no committed head to record as its review submission.`);
    const repoRoot = isRepoBackedCode(row.Repo) ? getRepoRoot(row.Repo) : coordRepoRoot;
    if (!repoRoot) fail(`Could not resolve the declared repository root for ${ticketId}.`);
    const sourceCommit = isRepoBackedCode(row.Repo) ? resolveSourceCommitSha(ticketId, row) : lock.head;
    const resolved = resolveCommitishInRepo(repoRoot, sourceCommit);
    if (!resolved || resolved !== lock.head || resolved !== sourceCommit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved)) {
      fail(`Ticket ${ticketId} submitted head is not a full commit in declared repository ${declaredRepo}.`);
    }
    return { submission: { repository: declaredRepo, commit: resolved }, unresolved_reason: null };
  }

  function persistReviewSubmission(ticketId, prepared) {
    const existing = readPlanRecord(ticketId, { allowMissing: false, skipRepairWrite: true });
    if ((existing.review_submission || null) && prepared.submission &&
        existing.review_submission.repository === prepared.submission.repository &&
        existing.review_submission.commit === prepared.submission.commit) return prepared;
    if (!existing.review_submission && !prepared.submission) return prepared;
    const record = JSON.parse(JSON.stringify(existing));
    if (prepared.submission) record.review_submission = prepared.submission;
    else delete record.review_submission;
    const expectedRaw = existing[BOARD_RAW_SYMBOL];
    if (typeof expectedRaw !== "string") fail(`Could not verify the canonical plan bytes for ${ticketId} review submission.`);
    writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw });
    writePlanCompatibilityBlockFromRecord(ticketId, record);
    return prepared;
  }

  return { persistReviewSubmission, resolveReviewSubmission };
}

module.exports = function createLifecycleReviewState({
  BOARD_RAW_SYMBOL,
  appendUniquePlanRecordValue,
  assertCurrentTicketLockIntegrity,
  buildScaffoldPlanRecord,
  resolveCommitishInRepo,
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
  // COORD-749: commit affiliation belongs with its review-state consumer, not
  // as domain logic in the lifecycle composition root. Keep the public facade.
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

  // guard:submit-readiness
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

    // COORD-898 (2): count against the base commit recorded on the lock at start
    // when it is still an ancestor of HEAD, so a moving or stale local ref can never
    // add upstream commits to the ticket's ahead-count.
    const recordedBaseCommit = typeof lock.base_commit === "string" ? lock.base_commit : null;
    const countBase =
      recordedBaseCommit && gitTry(lock.worktree, ["merge-base", "--is-ancestor", recordedBaseCommit, "HEAD"]).status === 0
        ? recordedBaseCommit
        : compareBaseRef;
    const aheadResult = gitTry(lock.worktree, ["rev-list", "--count", `${countBase}..HEAD`]);
    if (aheadResult.status !== 0) {
      fail(`Could not verify commit delta for ${ticketId} against ${countBase} in ${lock.worktree}.`);
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
    readCommitSubject,
    commitSubjectAffiliatesWithTicket,
    appendReviewFollowupPlan,
    assertCommittedReviewState,
    defaultStartTraceabilityValue,
  };
};

module.exports.createReviewSubmissionState = createReviewSubmissionState;
