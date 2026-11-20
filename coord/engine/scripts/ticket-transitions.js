"use strict";

// Wave 2 (COORD-061): the ticket state-machine transitions extracted from
// lifecycle.js — start / submit / move-review / return-doing / mark-done /
// block / unblock / supersede, plus the two transition-specific primitives
// they own (applyMarkDone and persistReturnDoingState). DI-factory; every
// cross-module dependency (board-state mutators, validation/readiness helpers,
// journal withGovernanceMutation/inferTicketStatus, plan/prompt/workspace
// helpers, repo registry) is injected rather than re-implemented here.
//
// This is the central transition surface. Downstream closeout/land logic
// (finalize/land/finishTicket, which stay in lifecycle.js) consumes the
// re-exported moveReview / markDone / applyMarkDone bindings, and the
// COORD-062 closeout module is expected to inject this surface. Keep the
// exported function set clean and complete.

const fs = require("fs");
const path = require("path");
const { GovernanceError, defaultFail, ROOT_DIR } = require("./governance-context.js");
const { STATUS, FINDING_STATUS } = require("./governance-constants.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const { assertFactoryDependencies } = require("./factory-deps.js");
const { refusal, submitTitlePrecheck } = require("./test-title-precheck.js");
const { resolvePreservedReviewWorkspace } = require("./review-workspace-evidence.js");
// COORD-921: landing-gh.js has no engine-module dependency on this factory, so
// the PR-head reads are imported directly rather than widening lifecycle.js (the
// composition root, held to a LOC ratchet) with two more wiring lines.
const { ghPrView, isGitHubPrUrl } = require("./landing-gh.js");
// COORD-1019: the governed branch-name format lives in control-plane-pr-evidence.js.
const { buildTicketBranchName } = require("./control-plane-pr-evidence.js");
const { createReviewSubmissionState } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-review-state.js"));
const approvalVerifier = require("./approval-verifier.js");


// COORD-680: the sibling factory had NO construction-time validation, so the
// same wiring defect that produced `TypeError: ensureGovernedWorkspaceForTicket
// is not a function` inside `gov resume` could reappear here — this factory owns
// `startTicket` and `returnDoing`, both of which reconstruct governed
// workspaces. Validated against the same shared assertion agent-commands uses.
const REQUIRED_TICKET_TRANSITION_DEPS = {
  callable: [
    "readBoard",
    "writeBoard",
    "getTicketRef",
    "rowsById",
    "applyTicketStatus",
    "assignTicketOwner",
    "clearTicketOwner",
    "setTicketPrRefs",
    "isLegalStatus",
    "runBoardSync",
    "runBoardValidate",
    "withBoardTransaction",
    "withCoordStateLock",
    "withGovernanceMutation",
    "inferTicketStatus",
    "resolveOwnerIdentity",
    "canonicalizeOwnerOrFail",
    "ensureCurrentAgentIdentity",
    "ensureTicketMutationOwnership",
    "assertTicketMutationOwnership",
    "detectColocatedForeignSessions",
    "buildColocatedForeignSessionMessage",
    "recordGovernanceCollision",
    "findLockForTicket",
    "resolveTicketLockPath",
    "ensureDoingTicketLockIntegrity",
    "ensureGitWorktree",
    "ensureGovernedWorkspaceForTicket",
    "withPreparedTicketWorkspace",
    "cleanupClosedTicketWorkspace",
    "writeLock",
    "defaultWorktreePath",
    "evaluateReadiness",
    "formatTransitiveBlockerDetails",
    "formatDependencyCycleList",
    "resolveLifecyclePrRefs",
    "assertReviewPlanReady",
    "assertAlreadyLandedNoPrReconcileReady",
    "assertCommittedReviewState",
    "refsContainMergedPrForTicket",
    "prCreate",
    "appendReviewFollowupPlan",
    "inferNextRound",
    "prepareDoneCloseout",
    "buildStartOwnershipRaceMessage",
    "buildHistoricalCloseoutStartBlocker",
    "assertPromptRecord",
    "ensurePlanStub",
    "updateCanonicalPlanState",
    "buildStartPlanSeedUpdate",
    "seedStartIntendedFilesFromPrompt",
    "assertStartPlanReady",
    "buildStartPlanBootstrapCommand",
    "detectSupersedeLandingBypass",
    "isRepoBackedCode",
    "repoNameForCode",
    "repoCodeForLockRepoName",
    "readPlanRecord",
    "planRecordPath",
    "writeCanonicalJsonFile",
    "writePlanCompatibilityBlockFromRecord",
    "resolveSourceCommitSha",
    "repoDisplayNameForCode",
    "resolveTicketBaseRef",
    "fetchRepoRef",
    "resolveCommitishInRepo",
    "getRepoRoot",
    "toArray",
    "integerOrDefault",
    "isDoingStatus",
    "assertTicketFence",
  ],
  value: ["BOARD_RAW_SYMBOL"],
};

// COORD-820: a finding's added_by is the identity that actually performed the
// transition — the bound session — and NEVER a flag. return-doing used to stamp
// the --owner value, so an owner could manufacture a "recorded reviewer" (the
// authority correct-finding-severity grants to a non-owner added_by author) by
// naming another handle. With no bound session (or one that fails validation)
// nothing is stamped, exactly as add-finding does. Read-only: it must not bind,
// touch or auto-claim a session.
function boundFindingAuthorStamp(ensureCurrentAgentIdentity) {
  let identity = null;
  try {
    identity = ensureCurrentAgentIdentity({ readOnly: true });
  } catch {
    return {};
  }
  const handle = identity && identity.agent && identity.agent.handle;
  return handle ? { added_by: handle } : {};
}

module.exports = function createTicketTransitions(deps = {}) {
  const fail = deps.fail || defaultFail;
  assertFactoryDependencies("createTicketTransitions", deps, REQUIRED_TICKET_TRANSITION_DEPS);

  const {
    // board-state mutators / readers
    readBoard,
    writeBoard,
    getTicketRef,
    rowsById,
    applyTicketStatus,
    assignTicketOwner,
    clearTicketOwner,
    setTicketPrRefs,
    isLegalStatus,
    runBoardSync,
    runBoardValidate,
    withBoardTransaction,
    withCoordStateLock,
    // journal-produced (must be wired after createJournal)
    withGovernanceMutation,
    inferTicketStatus,
    // identity / ownership
    resolveOwnerIdentity,
    canonicalizeOwnerOrFail,
    ensureCurrentAgentIdentity,
    ensureTicketMutationOwnership,
    assertTicketMutationOwnership,
    detectColocatedForeignSessions,
    buildColocatedForeignSessionMessage,
    recordGovernanceCollision,
    // locks / worktrees
    findLockForTicket,
    resolveTicketLockPath,
    ensureDoingTicketLockIntegrity,
    ensureGitWorktree,
    ensureGovernedWorkspaceForTicket,
    withPreparedTicketWorkspace,
    cleanupClosedTicketWorkspace,
    writeLock,
    defaultWorktreePath,
    // readiness / dependency analysis
    evaluateReadiness,
    formatTransitiveBlockerDetails,
    formatDependencyCycleList,
    // review / PR evidence
    resolveLifecyclePrRefs,
    assertReviewPlanReady,
    assertAlreadyLandedNoPrReconcileReady,
    assertCommittedReviewState,
    persistReviewSubmission: persistReviewSubmissionOverride,
    resolveReviewSubmission: resolveReviewSubmissionOverride,
    refsContainMergedPrForTicket,
    prCreate,
    appendReviewFollowupPlan,
    inferNextRound,
    // closeout (stays in lifecycle.js; injected for mark-done)
    prepareDoneCloseout,
    assertTicketFence,
    // start-path: plan/prompt/seed helpers
    buildStartOwnershipRaceMessage,
    buildHistoricalCloseoutStartBlocker,
    assertPromptRecord,
    ensurePlanStub,
    updateCanonicalPlanState,
    buildStartPlanSeedUpdate,
    seedStartIntendedFilesFromPrompt,
    assertStartPlanReady,
    buildStartPlanBootstrapCommand,
    // supersede
    detectSupersedeLandingBypass,
    // repo registry
    isRepoBackedCode,
    repoNameForCode,
    repoDisplayNameForCode,
    resolveTicketBaseRef,
    fetchRepoRef,
    resolveCommitishInRepo,
    getRepoRoot,
    repoCodeForLockRepoName,
    BOARD_RAW_SYMBOL,
    readPlanRecord,
    planRecordPath,
    writeCanonicalJsonFile,
    writePlanCompatibilityBlockFromRecord,
    resolveSourceCommitSha,
    // misc utilities
    toArray,
    integerOrDefault,
    isDoingStatus,
  } = deps;
  const submissionState = createReviewSubmissionState({
    BOARD_RAW_SYMBOL, fail, getRepoRoot, isRepoBackedCode, planRecordPath, readPlanRecord,
    repoNameForCode, repoCodeForLockRepoName, resolveSourceCommitSha,
    resolveCommitishInRepo, writeCanonicalJsonFile, writePlanCompatibilityBlockFromRecord,
  });
  const persistReviewSubmission = persistReviewSubmissionOverride || submissionState.persistReviewSubmission;
  const resolveReviewSubmission = resolveReviewSubmissionOverride || submissionState.resolveReviewSubmission;

  // COORD-285: approval-gated intake. `proposed` tickets are machine-proposed
  // debt that a human must triage before they become schedulable work. These
  // verbs ride the board transaction path so create -> approve/reject remains a
  // single-writer, journaled transition.
  function approveTicket(ticketId, options = {}) {
    const mutation = {
      command: "approve",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("approve", ticketId, { owner: options.owner || null }),
    };
    return withBoardTransaction(mutation, ({ board }) => {
      if (!ticketId) {
        fail("approve requires <ticket-id>.");
      }
      const identity = options.owner
        ? resolveOwnerIdentity(options.owner, { allowAutoClaim: false, touchSession: false })
        : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      mutation.identity = identity;

      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.PROPOSED) {
        fail(
          `approve only promotes a "proposed" ticket to todo; ${ticketId} is currently "${ref.row.Status}". ` +
          `Nothing to approve.`
        );
      }

      const approval = approvalVerifier.requireSignedOverride({
        commandName: "approve",
        ticketId,
        row: ref.row,
        options,
        deps: { fail, resolveHumanAdminOverride: deps.resolveHumanAdminOverride,
          appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir },
      }).approval;

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.TODO);
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.TODO;
      mutation.details = { previous_status: STATUS.PROPOSED, human_admin_session: approval.session_id, approval_record: approval.record_id, approval_verified: `key_id=${approval.key_id}` };
      console.log(`Approved ${ticketId}: proposed -> todo. It is now schedulable work.`);
    });
  }

  function rejectTicket(ticketId, options = {}) {
    const reason = String(options.reason || "").trim();
    const mutation = {
      command: "reject",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("reject", ticketId, { reason: reason || null, owner: options.owner || null }),
      details: { reason: reason || null },
    };
    return withBoardTransaction(mutation, ({ board }) => {
      if (!ticketId) {
        fail("reject requires <ticket-id>.");
      }
      if (!reason) {
        fail('reject requires --reason "<why the proposal is declined>".');
      }
      const identity = options.owner
        ? resolveOwnerIdentity(options.owner, { allowAutoClaim: false, touchSession: false })
        : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      mutation.identity = identity;

      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.PROPOSED) {
        fail(
          `reject only declines a "proposed" ticket (-> superseded); ${ticketId} is currently "${ref.row.Status}". ` +
          `Use \`coord/scripts/gov supersede ${ticketId} --reason "<why>"\` to retire non-proposed work.`
        );
      }

      const approval = approvalVerifier.requireSignedOverride({
        commandName: "reject",
        ticketId,
        row: { ticket: ref.row, rejection_reason: reason },
        options,
        deps: { fail, resolveHumanAdminOverride: deps.resolveHumanAdminOverride,
          appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: deps.runtimeDir },
      }).approval;

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.SUPERSEDED);
        ref.row["Supersede Reason"] = reason;
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.SUPERSEDED;
      mutation.details = { previous_status: STATUS.PROPOSED, reason, human_admin_session: approval.session_id, approval_record: approval.record_id, approval_verified: `key_id=${approval.key_id}` };
      console.log(`Rejected ${ticketId}: proposed -> superseded. Reason: ${reason}`);
    });
  }

  function submitTicket(ticketId, options) {
    if (!ticketId) {
      fail("submit requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    if (ref.row.Status === STATUS.REVIEW) {
      ensureTicketMutationOwnership(ticketId, ref.row, null, options);
      const refs = resolveLifecyclePrRefs(ticketId, ref.row, board, options);
      console.log(JSON.stringify({
        ticket: ticketId,
        status: "already_review",
        pr_refs: refs,
      }, null, 2));
      return;
    }

    if (ref.row.Status !== STATUS.DOING) {
      fail(`Ticket ${ticketId} must be doing or review to submit; current status is "${ref.row.Status}".`);
    }
    const lock = findLockForTicket(ticketId);
    if (!lock) {
      fail(`Ticket ${ticketId} is doing but has no active lock.`);
    }
    ensureTicketMutationOwnership(ticketId, ref.row, lock, options);
    // COORD-906: refuse before any review or PR side effect when the ticket's
    // changed test files define titles the release suite inventory lacks.
    const titles = submitTitlePrecheck({ root: lock.worktree, base: resolveTicketBaseRef(ticketId, ref.row, {}) });
    if (titles.warning) console.error(`Ticket ${ticketId}: warning: ${titles.warning}`);
    if (!titles.ok) fail(`Ticket ${ticketId}: ${refusal("submit", titles)}`);

    const refs = toArray(options.pr);
    if (refs.length > 0) {
      // COORD-921: an explicit GitHub PR gets the same verified push and head check as a recorded one.
      const explicitPrUrl = refs.find((entry) => isGitHubPrUrl(entry));
      const verifiedPrHead = explicitPrUrl
        ? verifyExistingPrResubmission(ticketId, ref.row, lock, explicitPrUrl, options)
        : null;
      moveReview(ticketId, verifiedPrHead ? { pr: refs, verifiedPrHead } : { pr: refs });
      return;
    }

    const existingRefs = board.pr_index?.[ticketId] || [];
    if (existingRefs.length > 0) {
      // COORD-921: a recorded GitHub PR is re-pushed and verified before the
      // submission is journaled; any other recorded reference is unchanged.
      const recordedPrUrl = existingRefs.find((entry) => isGitHubPrUrl(entry));
      const verifiedPrHead = recordedPrUrl
        ? verifyExistingPrResubmission(ticketId, ref.row, lock, recordedPrUrl, options)
        : null;
      moveReview(ticketId, verifiedPrHead ? { verifiedPrHead } : {});
      return;
    }

    if (ref.row.Repo === "X") {
      fail(
        `Ticket ${ticketId} is repo X and has no recorded PR evidence. ` +
        `Use "coord/scripts/gov submit ${ticketId} --pr \\"local-review (no PR)\\"" ` +
        `or "coord/scripts/gov move-review ${ticketId} --pr \\"local-review (no PR)\\"" instead.`
      );
    }

    assertTicketDependenciesReady(ticketId, ref.row, board);
    assertReviewPlanReady(ticketId, ref.row);
    // COORD-697: submit used to leave dependency and committed-state checks to
    // moveReview, which runs only AFTER prCreate has published the branch and
    // created the PR. Re-run the complete locally fallible transition preflight
    // before delegating to either external action. prCreate keeps its own copy
    // because it is also a public verb and must be safe when called directly.
    resolveReviewSubmission(ticketId, ref.row, lock);
    assertCommittedReviewState(ticketId, ref.row, lock);
    prCreate(ticketId, { ...options, push: true });
    moveReview(ticketId, {});
  }

  // COORD-921: re-submit with a recorded PR. Pushes the lock head to the PR's
  // head branch through prCreate's existing-PR path (it never creates a PR here:
  // the PR was confirmed open on the ticket branch first), then requires the PR
  // head to equal the submitted commit. Any failure throws before move-review, so
  // the ticket stays doing and nothing is journaled as submitted. Repo X cannot
  // be pushed by governance (pr-create refuses it), so there the owner must push
  // the ticket branch to the PR head; the verification still applies.
  function verifyExistingPrResubmission(ticketId, row, lock, prUrl, options) {
    const submitted = resolveReviewSubmission(ticketId, row, lock).submission;
    const before = ghPrView(prUrl);
    if (!before || before.state !== "OPEN") {
      fail(`Ticket ${ticketId} recorded PR ${prUrl} is ${before?.state || "unknown"}, not OPEN; ticket stays doing.`);
    }
    if (before.headRefName !== lock.branch) {
      fail(`Ticket ${ticketId} recorded PR ${prUrl} has head branch ${before.headRefName}, not the ticket branch ${lock.branch}; ticket stays doing.`);
    }
    if (row.Repo !== "X") {
      // fill: true only satisfies prCreate's argv check; requireExistingPr makes
      // prCreate refuse (before any push) rather than create a PR on this path.
      prCreate(ticketId, { ...options, fill: true, push: true, requireExistingPr: true });
    }
    const after = ghPrView(prUrl);
    if (!after || after.headRefOid !== submitted.commit) {
      const head = after?.headRefOid || "unknown";
      const remedy = row.Repo === "X"
        ? `push ${lock.branch} to ${before.headRefName} and re-submit`
        : "the push did not publish the submitted commit";
      fail(
        `Ticket ${ticketId} PR ${prUrl} head ${head} does not equal submitted commit ${submitted.commit}; ` +
        `${remedy}. Ticket stays doing and nothing is recorded as submitted.`,
      );
    }
    return { url: prUrl, head_ref_name: after.headRefName, head_sha: after.headRefOid };
  }

  // guard:dependency-readiness
  function assertTicketDependenciesReady(ticketId, row, board) {
    const readiness = evaluateReadiness(row, rowsById(board), board);
    if (readiness.blockedBy.length === 0) return;
    const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
    fail(
      `Ticket ${ticketId} still has unmet dependencies: ${readiness.blockedBy.join(", ")}.` +
      (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
      (readiness.cycles.length > 0 ? ` Dependency cycle(s): ${formatDependencyCycleList(readiness.cycles)}.` : "")
    );
  }

  function markDone(ticketId, options = {}) {
    const mutation = {
      command: "mark-done",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("mark-done", ticketId, {
        landed: options.landed || null,
        sourceCommit: options.sourceCommit || null,
        fulfilledByTicket: options.fulfilledByTicket || null,
        fulfilledByCommit: options.fulfilledByCommit || null,
        prRefs: options.closeoutPrRefs || null,
      }),
      ...(Array.isArray(options.closeoutPrRefs)
        ? { details: { closeout_pr_refs: options.closeoutPrRefs } }
        : {}),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("mark-done requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      try {
        // COORD-855: finalize may supply a newly verified PR ref set. Keep it
        // prospective in memory while every mark-done preflight reads the
        // board, then let applyMarkDone write it together with the landing and
        // terminal status under this single governance transaction.
        if (Array.isArray(options.closeoutPrRefs)) {
          setTicketPrRefs(board, ticketId, options.closeoutPrRefs);
        }
        let doingLock = null;
        if (ref.row.Status === STATUS.DOING && options.closeoutFromDoing === true) {
          doingLock = ensureDoingTicketLockIntegrity(ticketId, ref.row, options);
          mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, doingLock, options);
          assertTicketDependenciesReady(ticketId, ref.row, board);
          assertReviewPlanReady(ticketId, ref.row);
          const prospectiveRefs = board.pr_index?.[ticketId] || [];
          const allowAlreadyLandedNoPrReconcile = assertAlreadyLandedNoPrReconcileReady(
            ticketId,
            board,
            ref.row,
            prospectiveRefs,
            options
          );
          assertCommittedReviewState(ticketId, ref.row, doingLock, {
            allowMergedPrReconcile: refsContainMergedPrForTicket(ticketId, prospectiveRefs),
            allowAlreadyLandedNoPrReconcile,
          });
          // The review state is prospective only. The lock remains present
          // until all closeout checks pass and applyMarkDone commits DONE.
          applyTicketStatus(ref, STATUS.REVIEW);
        } else {
          mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, null, options);
        }
        prepareDoneCloseout(ticketId, board, ref, {
          ...options,
          // The outer closeout's status read is advisory only. Authorization
          // to ignore the review-state lock gate comes solely from this
          // transaction's own validated doing lock.
          closeoutFromDoing: Boolean(doingLock),
        });
        // Readiness and evidence checks can take time. Recheck the captured
        // decision immediately before the actual DONE board write.
        assertTicketFence(ticketId);
        applyMarkDone(ticketId, board, ref, doingLock);
      } catch (error) {
        fail(error.message);
      }
    });
  }

  function supersedeTicket(ticketId, options = {}) {
    const mutation = {
      command: "supersede",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("supersede", ticketId, {
        reason: options.reason || null,
        consolidatedInto: options.consolidatedInto || null,
        deleteBranch: Boolean(options.deleteBranch),
      }),
      details: {
        reason: options.reason || null,
        consolidated_into: options.consolidatedInto || null,
      },
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("supersede requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status === STATUS.SUPERSEDED) {
        console.log(`Ticket ${ticketId} is already superseded.`);
        return;
      }

      const landedBypass = detectSupersedeLandingBypass(ticketId, ref.row, board, options);
      if (landedBypass) {
        const repoLabel = repoDisplayNameForCode(ref.row.Repo);
        fail(
          `Ticket ${ticketId} appears to already be landed on ${repoLabel}/${landedBypass.baseRef} ` +
          `via ${landedBypass.kind.replace(/_/g, " ")} commit ${landedBypass.commitSha}. ` +
          `Do not use supersede to bypass review/done gates. ` +
          `Use \`coord/scripts/gov finalize ${ticketId} --no-pr --already-landed --landed "<canonical-branch closeout proof>"\` ` +
          `for local no-PR landing, or complete the normal PR-backed closeout instead.`
        );
      }

      const lock = findLockForTicket(ticketId);
      if (isDoingStatus(ref.row.Status)) {
        if (!lock) {
          fail(`Ticket ${ticketId} is doing but has no active lock. Run \`coord/scripts/gov recover ${ticketId}\` before superseding it.`);
        }
        mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
      } else if (ref.row.Status === STATUS.REVIEW) {
        mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, null);
      }

      const cleaned = cleanupClosedTicketWorkspace(ticketId, ref.row, {
        deleteBranch: options.deleteBranch,
      });
      const lockPath = lock?.path || resolveTicketLockPath(ticketId, { promoteLegacy: true });
      const previousStatus = ref.row.Status;

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.SUPERSEDED);
        clearTicketOwner(ref);
        // Record inline supersession provenance on the board row so a retired
        // ticket is never left without a reason/replacement pointer (the event
        // log alone is easy to miss). Both fields are optional in the schema.
        if (options.consolidatedInto) {
          ref.row["Superseded By"] = String(options.consolidatedInto);
        }
        if (options.reason) {
          ref.row["Supersede Reason"] = String(options.reason);
        }
        writeBoard(board);
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.SUPERSEDED;
      mutation.details = {
        ...mutation.details,
        previous_status: previousStatus,
        cleaned_workspace: cleaned || null,
      };
      console.log(`Marked ${ticketId} ${previousStatus} -> superseded and cleaned active governance residue.`);
    });
  }

  function applyMarkDone(ticketId, board, ref, doingLock = null) {
    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.DONE);
      writeBoard(board);
      if (doingLock) {
        // Never trust a `path` field from lock JSON: findLockForTicket spreads
        // payload properties over its computed path. Resolve the ticket's
        // actual canonical/legacy lock location from governance paths instead.
        const lockPath = resolveTicketLockPath(ticketId);
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Marked ${ticketId} ${doingLock ? "doing -> done" : "review -> done"} and synced board artifacts.`);
  }

  function moveReview(ticketId, options = {}) {
    const mutation = {
      command: "move-review",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("move-review", ticketId, {
        pr: toArray(options.pr),
        alreadyLanded: Boolean(options.alreadyLanded),
        noPr: Boolean(options.noPr),
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("move-review requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.DOING) {
        fail(`Ticket ${ticketId} must be doing; current status is "${ref.row.Status}".`);
      }
      const lock = ensureDoingTicketLockIntegrity(ticketId, ref.row, options);
      const preparedSubmission = resolveReviewSubmission(ticketId, ref.row, lock);
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, lock, options);
      assertTicketDependenciesReady(ticketId, ref.row, board);
      assertReviewPlanReady(ticketId, ref.row);
      const prRefs = resolveLifecyclePrRefs(ticketId, ref.row, board, options);
      const allowAlreadyLandedNoPrReconcile = assertAlreadyLandedNoPrReconcileReady(
        ticketId,
        board,
        ref.row,
        prRefs,
        options
      );
      assertCommittedReviewState(ticketId, ref.row, lock, {
        allowMergedPrReconcile: refsContainMergedPrForTicket(ticketId, prRefs),
        allowAlreadyLandedNoPrReconcile,
      });

      const lockPath = lock?.path || resolveTicketLockPath(ticketId);
      let submissionResult;
      withCoordStateLock(() => {
        submissionResult = persistReviewSubmission(ticketId, preparedSubmission);
        // COORD-921: the journaled submission record cites the PR head verified by the re-submit path.
        mutation.details = { ...(mutation.details || {}), review_submission: submissionResult, ...(options.verifiedPrHead ? { verified_pr_head: options.verifiedPrHead } : {}) };
        // COORD-979: a hand-opened PR has no journaled pr-create push. The released lock's branch,
        // worktree and reviewed head are the workspace evidence review-workspace-evidence.js reads.
        // pr_head_ref is set only when the submit path verified the PR head ref against the ticket branch.
        // Only a review backed by a GitHub PR has a PR workspace to preserve; a local-review
        // (no PR) keeps the legacy path, as before COORD-979.
        if (lock?.branch && lock?.worktree && prRefs.some((entry) => isGitHubPrUrl(entry))) {
          mutation.details.workspace_evidence = {
            branch: lock.branch,
            worktree: lock.worktree,
            head: submissionResult.submission?.commit || null,
            pr_url: options.verifiedPrHead?.url || null,
            pr_head_ref: options.verifiedPrHead?.head_ref_name || null,
          };
        }
        setTicketPrRefs(board, ticketId, prRefs);
        applyTicketStatus(ref, STATUS.REVIEW);
        writeBoard(board);
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Moved ${ticketId} doing -> review, ${submissionResult.submission ? "recorded immutable submission scope" : "left no-Git submission scope unresolved"}, recorded PR evidence, and released the lock.`);
    });
  }

  function returnDoing(ticketId, options) {
    // guard:bound-owner
    const assertOwnerAssertion = (row) => {
      if (!options.owner) return;
      const currentOwner = canonicalizeOwnerOrFail(row.Owner, { readOnly: true });
      const requestedOwner = canonicalizeOwnerOrFail(options.owner, { readOnly: true });
      if (requestedOwner !== currentOwner) {
        fail(
          `return-doing --owner is only an assertion of the current owner (${currentOwner}); ` +
          `received ${requestedOwner}. Use \`coord/scripts/gov claim ${ticketId} --transfer-to ${requestedOwner} --human-admin-override "<reason>"\` to transfer ownership.`
        );
      }
    };
    // `--owner` remains accepted for compatibility as an assertion that the
    // caller knows the current owner. Reject a reassignment before entering the
    // governed mutation envelope: that envelope may touch identity/session
    // state before it knows the command will fail. Ownership transfers use the
    // governed claim path instead.
    if (options.owner) {
      const currentRef = getTicketRef(readBoard(), ticketId);
      if (currentRef) assertOwnerAssertion(currentRef.row);
    }
    const mutation = {
      command: "return-doing",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("return-doing", ticketId, {
        summary: options.summary || null,
        severity: options.severity || null,
        qref: options.qref || null,
        round: options.round || null,
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("return-doing requires <ticket-id>.");
      }
      if (!options.summary || !options.severity || !options.qref) {
        fail("return-doing requires --summary, --severity, and --qref.");
      }
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.REVIEW) {
        fail(`Ticket ${ticketId} must be review; current status is "${ref.row.Status}".`);
      }
      // Recheck after acquiring the governed mutation lock to close the race
      // where ownership changes after the early no-write preflight.
      assertOwnerAssertion(ref.row);
      const identity = assertTicketMutationOwnership(ticketId, ref.row, null);
      mutation.identity = identity;
      const owner = identity.agent.handle;
      // Actor and finding author are the bound session. --owner was checked
      // above only as a compatibility assertion and never selects identity.
      const authorStamp = boundFindingAuthorStamp(() => identity);
      // COORD-963: the owner WIP cap (wip-cap) is retired (ADR 0021; retirement
      // review integration authority claudea11, 2026-11-14). An owner holding
      // unrelated doing tickets is no longer refused here; followups.js
      // findUnrelatedOwnerDoingPairs reports it as a doctor warning.

      const findings = board.review_findings[ticketId] || [];
      const nextId = `${ticketId}-F${findings.length + 1}`;
      // COORD-649: return-doing is the ONE round-advancing transition — it
      // writes this round onto the finding AND onto the plan record, so the
      // pair is consistent by construction. An explicit --round that is not the
      // round this transition actually advances into FAILS CLOSED rather than
      // being silently accepted: accepting it writes a plan round that claims
      // repair rounds which never happened.
      const advancedRound = inferNextRound(findings);
      if (options.round !== undefined && options.round !== null && options.round !== "") {
        const requested = integerOrDefault(options.round, null);
        if (requested !== advancedRound) {
          fail(
            `return-doing --round ${options.round} disagrees with lifecycle state: this transition advances ${ticketId} ` +
            `into review round ${advancedRound}. Omit --round (or pass ${advancedRound}); a round is earned by a real ` +
            `review -> doing repair, not chosen. To repair a finding already filed under the wrong round, use ` +
            `\`coord/scripts/gov correct-finding-round ${ticketId} --id <finding-id> --round <n> --human-admin-override "<reason>"\`.`
          );
        }
      }
      // COORD-820: anchor the severity history and record the bound author
      // (the session that performed return-doing, never --owner).
      const finding = {
        id: nextId,
        severity: options.severity,
        original_severity: options.severity,
        summary: options.summary,
        status: FINDING_STATUS.OPEN,
        round: advancedRound,
        qref: options.qref,
        ...authorStamp,
      };

      // COORD-920: a ticket whose PR was built in a workspace (journaled pr-create push)
      // reopens IN that workspace, on its branch, in its original namespace. Only a ticket
      // with no such evidence gets the fresh-workspace default below.
      const preserved = resolvePreservedReviewWorkspace({
        ticketId,
        row: ref.row,
        currentOwner: owner,
        prRefs: board.pr_index?.[ticketId] || [],
        defaultWorktreePath,
      });
      if (preserved && preserved.problems.length > 0) {
        // guard:workspace-recovery-safety
        fail(`return-doing ${ticketId} refused: ${preserved.problems.join("; ")}. ${preserved.repair}`);
      }
      if (preserved && options.branch && options.branch !== preserved.branch) {
        fail(`return-doing --branch ${options.branch} disagrees with the PR branch ${preserved.branch}; omit --branch to reopen the PR workspace.`);
      }
      if (preserved && options.worktree && path.resolve(options.worktree) !== path.resolve(preserved.worktree)) {
        fail(`return-doing --worktree ${options.worktree} disagrees with the PR worktree ${preserved.worktree}; omit --worktree to reopen the PR workspace.`);
      }
      const branch = preserved
        ? preserved.branch
        : options.branch ||
          buildTicketBranchName({ owner, ticketId, slug: options.topic || ref.row.Description });
      const worktree = preserved ? preserved.worktree : options.worktree || defaultWorktreePath(ref.row.Repo, owner, ticketId);
      if (preserved) {
        mutation.details = {
          ...(mutation.details || {}),
          preserved_workspace: { worktree, branch, pr_head: preserved.pr_head, pr_url: preserved.pr_url, workspace_owner: preserved.workspace_owner },
        };
      }
      // COORD-635: this used ensureGitWorktree for product repos and a bare
      // `fs.mkdirSync(worktree)` for Repo X — a PLAIN DIRECTORY presented as a
      // governed worktree. Because the path is nested inside the canonical
      // tree, git resolves such a directory to CANONICAL, so an agent sent
      // there edits and stages main while believing it is isolated. Both repo
      // kinds now go through the one recovery entry point, which reconstructs
      // via the same ensureTicketWorkspace `gov start` uses and then PROVES
      // isolation (own toplevel + registered) before returning.
      ensureGovernedWorkspaceForTicket({
        ticketId,
        row: ref.row,
        worktree,
        branch,
        base: resolveTicketBaseRef(ticketId, ref.row, options),
        stage: "return-doing",
      });

      const namespaceOwner = preserved && preserved.workspace_owner !== owner ? preserved.workspace_owner : null;
      persistReturnDoingState({
        board,
        ref,
        finding,
        owner,
        branch,
        worktree,
        workspaceOwner: namespaceOwner,
        transferProvenance: namespaceOwner
          ? [{ from: namespaceOwner, to: owner, at: new Date().toISOString(), workspace_owner: namespaceOwner, reason: "return-doing reopened the PR workspace", previous_session_id: null }]
          : null,
        session: identity.session,
        appendPlan: appendReviewFollowupPlan,
        boardWriter: writeBoard,
        lockWriter: writeLock,
        syncWriter: () => runBoardSync({ ignoreActiveTicketLockErrors: true, currentTicketId: ticketId }),
      });
      // COORD-820: return-doing resolves its owner without allowAutoClaim, so an
      // "auto-claimed" suffix here could never print; it was removed as dead.
      console.log(`Moved ${ticketId} review -> doing, recorded ${nextId}, reacquired lock, and updated plan under owner=${owner}.`);
    });
  }

  function startTicket(ticketId, options) {
    const mutation = {
      command: "start",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("start", ticketId, {
        owner: options.owner || null,
        branch: options.branch || null,
        worktree: options.worktree || null,
        topic: options.topic || null,
        base: options.base || null,
        allowSharedWorktree: Boolean(options.allowSharedWorktree),
        ...(options.dispatchExecutionId ? { dispatchExecutionId: options.dispatchExecutionId } : {}),
      }),
      details: options.dispatchExecutionId ? { dispatch_execution_id: options.dispatchExecutionId } : null,
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("start-ticket requires <ticket-id>.");
      }
      // Preflight v2 owner authority before identity resolution can bind a
      // legacy agent session or any later lifecycle step can mutate ticket state.
      const identity = resolveOwnerIdentity(options.owner, { requireHeldOwnerLease: true });
      mutation.identity = identity;
      const owner = identity.agent.handle;

      // COORD-222: enforce the documented "one governed writer per
      // checkout/runtime" rule in CODE. Before binding a NEW ticket, refuse if
      // another heartbeat-fresh governed session is already bound to this runtime
      // on a different thread (a co-located second writer would interleave writes
      // into the hash-chained journal). The caller's own session never trips this,
      // so the common lone-session start is frictionless. An operator deliberately
      // running the orchestrator-spawns-N-subagents topology passes
      // --allow-shared-worktree to proceed.
      if (options.allowSharedWorktree !== true) {
        const currentThreadId = identity.session?.thread_id || undefined;
        const colocated = detectColocatedForeignSessions(
          currentThreadId !== undefined ? { currentThreadId } : {},
        );
        if (colocated.present) {
          // COORD-223: journal the co-located-session refusal as an auditable
          // collision so the contending sessions are queryable after the process exits.
          recordGovernanceCollision({
            ticket: ticketId,
            conflictType: "co-located-session",
            verb: "start",
            identity,
            contenders: colocated.foreign_sessions,
            extra: { current_thread_id: colocated.current_thread_id },
          });
          // guard:co-located-writer
          fail(buildColocatedForeignSessionMessage("start", colocated));
        }
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }

      // COORD-285: a `proposed` ticket is quarantined intake — it must be
      // human-accepted (`gov approve` -> todo) before any work begins. Fail
      // closed with a message that directs the operator to the approve verb
      // instead of the generic ownership-race message.
      if (ref.row.Status === STATUS.PROPOSED) {
        fail(
          `Ticket ${ticketId} is "proposed" (machine-proposed debt awaiting human triage); ` +
          `it cannot be started directly. Run \`coord/scripts/gov approve ${ticketId}\` to promote it ` +
          `to todo first, or \`coord/scripts/gov reject ${ticketId} --reason "<why>"\` to decline it.`
        );
      }
      if (![STATUS.TODO, STATUS.DEFERRED].includes(ref.row.Status)) {
        fail(buildStartOwnershipRaceMessage(ticketId, ref.row));
      }
      const closeoutBlocker = buildHistoricalCloseoutStartBlocker(ticketId, ref.row, board);
      if (closeoutBlocker) {
        fail(`${closeoutBlocker.message}\nNext: ${closeoutBlocker.next_steps.join("\n")}`);
      }
      const readiness = evaluateReadiness(ref.row, rowsById(board), board);
      if (readiness.blockedBy.length > 0) {
        const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
        fail(
          `Ticket ${ticketId} cannot start; blocked by ${readiness.blockedBy.join(", ")}.` +
          (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
          (readiness.cycles.length > 0 ? ` Dependency cycle(s): ${formatDependencyCycleList(readiness.cycles)}.` : "")
        );
      }
      // COORD-956 (prompt-record): content contract (COORD-813), then coverage or
      // on-disk auto-discovery (COORD-023), then declared preconditions (COORD-008),
      // before any lock or worktree is created. The integration ref is resolved
      // only after coverage holds, so a refused prompt triggers no fetch.
      let resolvedBaseRef = null;
      let immutableBaseCommit = null;
      assertPromptRecord(ticketId, ref.row, board, {
        ...options,
        resolvePreconditionRef: () => {
          resolvedBaseRef = resolveTicketBaseRef(ticketId, ref.row, options);
          let preconditionRef = resolvedBaseRef;
          if (isRepoBackedCode(ref.row.Repo)) {
            const repoRoot = getRepoRoot(ref.row.Repo);
            const refreshed = fetchRepoRef(repoRoot, resolvedBaseRef);
            const candidate = refreshed ? `origin/${String(resolvedBaseRef).replace(/^origin\//, "")}` : resolvedBaseRef;
            immutableBaseCommit = resolveCommitishInRepo(repoRoot, candidate);
            preconditionRef = candidate;
          }
          return preconditionRef;
        },
      });
      // COORD-963: wip-cap retired (see return-doing). Unrelated same-owner doing
      // tickets are reported by the doctor (owner-doing), not refused at start.

      runBoardValidate({ ignoreActiveTicketLockErrors: true });
      const planPreparation = ensurePlanStub(ticketId, ref.row.Repo, owner);
      updateCanonicalPlanState(ticketId, buildStartPlanSeedUpdate(ref.row));
      // COORD-009: seed `intended_files` from the prompt's `## Likely Files`
      // section and record the same values into
      // `scaffold_placeholders.intended_files`. This keeps the start-scaffold
      // visible to the unstart/lock-abandon guard even when the prompt carries
      // multiple prompt-derived paths.
      seedStartIntendedFilesFromPrompt(ticketId, board);
      try {
        assertStartPlanReady(ticketId, ref.row);
      } catch (error) {
        if (error instanceof GovernanceError) {
          const preparationHint = planPreparation.createdMarkdownBlock
            ? `Compatibility PLAN.md block prepared for ${ticketId}.`
            : `Plan state already existed for ${ticketId}.`;
          fail(
            `${error.message}\n` +
            `${preparationHint} Seed the startup attestation, then retry:\n` +
            buildStartPlanBootstrapCommand(ticketId, ref.row)
          );
        }
        throw error;
      }

      const repoCode = ref.row.Repo;
      const now = new Date().toISOString();
      const branch =
        options.branch ||
        buildTicketBranchName({ owner, ticketId, slug: options.topic || ref.row.Description });
      const worktree =
        options.worktree ||
        defaultWorktreePath(repoCode, owner, ticketId);
      const lockPath = resolveTicketLockPath(ticketId, { promoteLegacy: true });
      if (fs.existsSync(lockPath)) {
        // COORD-223: a per-ticket lock already exists — a second writer is fencing
        // against an in-flight owner. Journal the contended lock as an auditable
        // collision before refusing.
        recordGovernanceCollision({
          ticket: ticketId,
          conflictType: "stale-write-fence",
          verb: "start",
          identity,
          contenders: [{ ticket_id: ticketId, lock_path: path.relative(ROOT_DIR, lockPath), contender_owner: owner }],
        });
        fail(`Lock file already exists for ${ticketId}: ${path.relative(ROOT_DIR, lockPath)}`);
      }
      const repoName = repoNameForCode(repoCode);

      withPreparedTicketWorkspace(
        {
          repoCode,
          worktree,
          branch,
          base: resolvedBaseRef,
          baseCommit: immutableBaseCommit,
        },
        () => {
          withCoordStateLock(() => {
            applyTicketStatus(ref, STATUS.DOING);
            assignTicketOwner(ref, owner);
            writeBoard(board);
            writeLock({ ticketId, owner, repoCode, branch, worktree, now, repoName, session: identity.session, baseRef: resolvedBaseRef });
            runBoardSync({ ignoreActiveTicketLockErrors: true });
          });
        }
      );
      console.log(`Started ${ticketId}: owner=${owner}${identity.autoClaimed ? ` (${identity.agent.id}, auto-claimed)` : ""} branch=${branch} worktree=${worktree}`);
      // COORD-1047 (d): the start facts the CLI needs to publish the attempt after the lock is released.
      return { ticket: ticketId, handle: owner, branch, base_ref: resolvedBaseRef, base_sha: immutableBaseCommit };
    });
  }

  function blockTicket(ticketId, options = {}) {
    const mutation = {
      command: "block",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("block", ticketId, {
        reason: options.reason || null,
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("block requires <ticket-id>.");
      }
      const reason = String(options.reason || "").trim();
      if (!reason) {
        fail('block requires --reason "<why work is paused>".');
      }
      const identity = resolveOwnerIdentity(options.owner);
      mutation.identity = identity;

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      // Read the prior status under the mutation lock: another writer may have amended it.
      mutation.beforeStatus = ref.row.Status;
      if (ref.row.Status !== STATUS.DOING && !/^doing \(blocked: .+\)$/.test(ref.row.Status)) {
        fail(
          `Ticket ${ticketId} must be plain "doing" or "doing (blocked: ...)" to block; current status is "${ref.row.Status}".`
        );
      }
      const lock = findLockForTicket(ticketId);
      mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);

      const nextStatus = `doing (blocked: ${reason})`;
      if (!isLegalStatus(nextStatus)) {
        fail(`Computed status "${nextStatus}" is not a legal status.`);
      }

      withCoordStateLock(() => {
        applyTicketStatus(ref, nextStatus);
        writeBoard(board);
        // The ticket lock keeps status:"doing"; gov doctor treats any doing*
        // board status as consistent with a "doing" lock (isDoingStatus), so no
        // lock rewrite is needed and none would reduce drift.
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = nextStatus;
      mutation.details = { reason };
      console.log(`Blocked ${ticketId}: ${mutation.beforeStatus} -> ${nextStatus}.`);
    });
  }

  function unblockTicket(ticketId, options = {}) {
    const mutation = {
      command: "unblock",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("unblock", ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("unblock requires <ticket-id>.");
      }
      const identity = resolveOwnerIdentity(options.owner);
      mutation.identity = identity;

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (!/^doing \(blocked: .+\)$/.test(String(ref.row.Status || ""))) {
        fail(
          `Ticket ${ticketId} must be "doing (blocked: ...)" to unblock; current status is "${ref.row.Status}".`
        );
      }
      const lock = findLockForTicket(ticketId);
      mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);

      const previousStatus = ref.row.Status;

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.DOING);
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.DOING;
      mutation.details = { previous_status: previousStatus };
      console.log(`Unblocked ${ticketId}: ${previousStatus} -> doing.`);
    });
  }

  function persistReturnDoingState({ board, ref, finding, owner, branch, worktree, session, appendPlan, boardWriter, lockWriter, syncWriter = null, workspaceOwner = null, transferProvenance = null }) {
    const findings = board.review_findings[ref.row.ID] || [];
    findings.push(finding);
    board.review_findings[ref.row.ID] = findings;

    applyTicketStatus(ref, STATUS.DOING);
    assignTicketOwner(ref, owner);

    withCoordStateLock(() => {
      appendPlan(ref.row.ID, finding.id, finding.summary, ref.row.Repo, owner, finding.round);
      boardWriter(board);
      lockWriter({
        ticketId: ref.row.ID,
        owner,
        repoCode: ref.row.Repo,
        branch,
        worktree,
        session,
        workspaceOwner,
        transferProvenance,
      });
      if (typeof syncWriter === "function") {
        syncWriter();
      }
    });
  }

  return {
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
  };
};

module.exports.DEP_CONTRACT = REQUIRED_TICKET_TRANSITION_DEPS;
module.exports.boundFindingAuthorStamp = boundFindingAuthorStamp;
