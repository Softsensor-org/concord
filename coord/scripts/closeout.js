"use strict";

// Wave 2 (COORD-062): the ticket closeout / land surface extracted from
// lifecycle.js — finalize / land / finish-ticket and the shared
// prepareDoneCloseout readiness gate they all funnel through. DI-factory;
// every cross-module dependency (board-state mutators/readers, identity /
// ownership, PR-merge + landing-evidence helpers, review-readiness + lock /
// worktree checks, journal withGovernanceMutation / inferTicketStatus, plan-
// state writers, repo registry, and the question-log builders) is injected
// rather than re-implemented here.
//
// This module sits downstream of the ticket-transitions state machine
// (COORD-061): finalize/land/finish call moveReview / markDone / applyMarkDone
// from that surface, which is injected as `ticketTransitions`. In turn
// ticket-transitions.markDone needs prepareDoneCloseout (the review->done
// readiness gate that lives here); lifecycle.js resolves that near-circular
// edge by injecting closeout's prepareDoneCloseout into transitions as a
// deferred wrapper. closeout's factory MUST therefore be wired AFTER
// createTicketTransitions. Keep the exported function set clean and complete.

const path = require("path");
const { defaultFail, ROOT_DIR } = require("./governance-context.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const { STATUS, FINDING_STATUS } = require("./governance-constants.js");

module.exports = function createCloseout(deps = {}) {
  const fail = deps.fail || defaultFail;

  const {
    // board-state mutators / readers
    readBoard,
    getTicketRef,
    setPrRefs,
    // journal-produced (must be wired after createJournal)
    withGovernanceMutation,
    inferTicketStatus,
    // identity / ownership
    ensureTicketMutationOwnership,
    // ticket-transitions surface (must be wired after createTicketTransitions)
    moveReview,
    markDone,
    applyMarkDone,
    // PR merge + landing evidence
    prMerge,
    persistMergedPrLandingSnapshot,
    refreshLandingBaseRef,
    resolvePrUrlForTicket,
    ensureLandingRecord,
    assertLandingIntegrity,
    ensureTestingInfrastructureLandingAudit,
    ensureFeatureProofLandingAudit,
    verifyPrEvidence,
    // review / closeout readiness
    assertReviewPlanReady,
    findOutstandingCloseoutBlockerFollowups,
    findLockForTicket,
    ensureRepoXCloseoutReady,
    cleanupTicketWorktree,
    resolveLifecyclePrRefs,
    // plan-state writers
    updateCanonicalPlanState,
    // question-log builders
    buildQuestionRow,
    buildLandCloseoutAnswer,
    appendQuestionRowText,
    removeQuestionRowText,
    // repo registry
    isRepoBackedCode,
    getRepoRoot,
    resolveRepoIntegrationBranch,
    // misc utilities
    mergeUniqueRefs,
    toArray,
  } = deps;

  function buildPrCloseoutPlanUpdate(row, prUrl) {
    return {
      closeoutMethod: "pr",
      closeoutBaseRef: isRepoBackedCode(row.Repo) ? resolveRepoIntegrationBranch(row.Repo) : "main",
      provenanceNote: prUrl ? `PR-backed landing via ${prUrl}` : "PR-backed landing through governance",
    };
  }

  function buildNoPrCloseoutPlanUpdate(row, options = {}) {
    return {
      closeoutMethod: options.fulfilledByCommit || options.fulfilledByTicket ? "fulfilled_by" : "no_pr",
      closeoutBaseRef: isRepoBackedCode(row.Repo) ? resolveRepoIntegrationBranch(row.Repo) : "main",
      provenanceNote: options.landed || null,
    };
  }

  function landTicket(ticketId, options) {
    const mutation = {
      command: "land",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("land requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.REVIEW) {
        fail(`Ticket ${ticketId} must be in review to land; current status is "${ref.row.Status}".`);
      }
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, null, options);

      const prRefs = board.pr_index?.[ticketId] || [];
      const owner = ref.row.Owner || "unassigned";
      const repoRoot = isRepoBackedCode(ref.row.Repo) ? getRepoRoot(ref.row.Repo) : null;
      const requestedBaseRef = String(options.base || DEFAULT_INTEGRATION_BRANCH).trim() || DEFAULT_INTEGRATION_BRANCH;
      const hasNoPrEvidence = prRefs.some((entry) => /\(no PR\)/.test(String(entry)));
      const prUrl = hasNoPrEvidence ? null : (options.pr || resolvePrUrlForTicket(board, ref.row, ticketId));
      if (prUrl && !isRepoBackedCode(ref.row.Repo)) {
        // COORD-055: `land` performs a GitHub merge (prMerge), which only supports
        // repo-backed tickets. A PR-backed repo-X (coord / cross-repo) ticket has no
        // repo to merge into; close it with the PR-backed finalize, which records the
        // PR evidence and marks it done without a merge or board hand-edits. (No-PR
        // repo-X tickets still land normally below.)
        fail(
          `Ticket ${ticketId} is repo ${ref.row.Repo} with PR evidence; \`land\` performs a GitHub merge and ` +
          `only supports repo-backed tickets. Close PR-backed ${ref.row.Repo} (coord/cross-repo) tickets with ` +
          `\`coord/scripts/gov finalize ${ticketId} --pr "${prUrl}"\`, which records the PR evidence and marks it done.`
        );
      }
      let mergeResult = null;
      if (prUrl) {
        mergeResult = prMerge(ticketId, options);
        if (
          repoRoot &&
          mergeResult &&
          (mergeResult.status === "merged" || mergeResult.status === "already_merged")
        ) {
          refreshLandingBaseRef(repoRoot, requestedBaseRef);
        }
      } else if (!hasNoPrEvidence) {
        fail(`Could not resolve a GitHub PR for ${ticketId}, and no explicit "(no PR)" evidence is recorded.`);
      }
      let postMergeBoard = readBoard();
      let postMergeRef = getTicketRef(postMergeBoard, ticketId);
      if (!postMergeRef) {
        fail(`Unknown ticket "${ticketId}" after PR merge.`);
      }
      if (prUrl && mergeResult && (mergeResult.status === "merged" || mergeResult.status === "already_merged")) {
        const landingRecord = persistMergedPrLandingSnapshot(ticketId, postMergeRef.row, prUrl, options);
        if (!landingRecord && isRepoBackedCode(postMergeRef.row.Repo)) {
          fail(
            `Landing evidence for ${ticketId} could not be recorded after PR merge. ` +
            `The PR was merged but the board state may be incomplete. ` +
            `Recovery: retry "coord/scripts/gov land ${ticketId}" or use "coord/scripts/gov mark-done ${ticketId} --landed \\"<evidence>\\"".`
          );
        }
        postMergeBoard = readBoard();
        postMergeRef = getTicketRef(postMergeBoard, ticketId);
        if (!postMergeRef) {
          fail(`Unknown ticket "${ticketId}" after recording landing evidence.`);
        }
      }
      try {
        prepareDoneCloseout(ticketId, postMergeBoard, postMergeRef, options);
        const rowText = buildQuestionRow({
          from: owner,
          to: "all",
          question: `${ticketId} landed through governance.`,
          answer: buildLandCloseoutAnswer({
            ticketId,
            prUrl,
            prRefs,
            method: options.method || "squash",
            landing: postMergeBoard.landing_index?.[ticketId] || null,
          }),
          resolved: "yes",
        });
        appendQuestionRowText(rowText);
        try {
          applyMarkDone(ticketId, postMergeBoard, postMergeRef);
          updateCanonicalPlanState(ticketId, buildPrCloseoutPlanUpdate(ref.row, prUrl));
        } catch (error) {
          removeQuestionRowText(rowText);
          throw error;
        }
      } catch (error) {
        fail(error.message);
      }
      console.log(`Logged governance closeout note for ${ticketId}.`);
    });
  }

  function finalizeTicket(ticketId, options = {}) {
    if (!ticketId) {
      fail("finalize requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    if (options.alreadyLanded && !options.noPr) {
      fail("finalize --already-landed requires --no-pr. PR-backed landings should use submit/land or the merged-PR review path.");
    }

    if (options.noPr) {
      const noPrRefs = mergeUniqueRefs(board.pr_index?.[ticketId] || [], toArray(options.pr));
      const explicitNoPr = noPrRefs.some((entry) => /\(no PR\)/.test(String(entry)));
      const refs = explicitNoPr ? noPrRefs : mergeUniqueRefs(noPrRefs, ["local-review (no PR)"]);

      if (ref.row.Status === STATUS.DOING) {
        moveReview(ticketId, {
          ...options,
          pr: refs,
        });
        const result = markDone(ticketId, options);
        updateCanonicalPlanState(ticketId, buildNoPrCloseoutPlanUpdate(ref.row, options));
        return result;
      }
      if (ref.row.Status === STATUS.REVIEW) {
        const existingRefs = board.pr_index?.[ticketId] || [];
        if (existingRefs.length === 0) {
          setPrRefs(ticketId, { pr: refs });
        } else if (!existingRefs.some((entry) => /\(no PR\)/.test(String(entry)))) {
          fail(`Ticket ${ticketId} already has PR evidence recorded. Do not use --no-pr on a ticket that already points at a PR.`);
        }
        const result = markDone(ticketId, options);
        updateCanonicalPlanState(ticketId, buildNoPrCloseoutPlanUpdate(ref.row, options));
        return result;
      }
      // COORD-434: idempotent finalize recovery. markDone is a journaled mutation
      // but the closeout plan write (updateCanonicalPlanState) is a separate,
      // non-journaled step done AFTER it — so a crash between them leaves a `done`
      // board row against a stale plan record, and the old code failed the retry
      // with "must be doing or review". For an already-`done` ticket, re-drive the
      // closeout plan write idempotently so a re-run completes the stranded write
      // instead of dead-ending. (It stays the LAST step, so the COORD-220 seal is
      // not tripped — no governed mutation runs after this out-of-band plan write.)
      if (ref.row.Status === STATUS.DONE) {
        updateCanonicalPlanState(ticketId, buildNoPrCloseoutPlanUpdate(ref.row, options));
        return;
      }
      fail(`Ticket ${ticketId} must be doing or review to finalize; current status is "${ref.row.Status}".`);
    }

    return finishTicket(ticketId, options);
  }

  function prepareDoneCloseout(ticketId, board, ref, options = {}) {
    if (ref.row.Status !== STATUS.REVIEW) {
      throw new Error(`Ticket ${ticketId} must be in review; current status is "${ref.row.Status}".`);
    }

    assertReviewPlanReady(ticketId, ref.row);

    const prRefs = board.pr_index?.[ticketId];
    if (!Array.isArray(prRefs) || prRefs.length === 0) {
      throw new Error(`Ticket ${ticketId} is review but has no pr_index evidence.`);
    }
    verifyPrEvidence(ticketId, prRefs, {
      requireMerged: true,
      allowNoPr: true,
    });

    const findings = board.review_findings?.[ticketId] || [];
    const openFindings = findings.filter((finding) => finding.status === FINDING_STATUS.OPEN);
    if (openFindings.length > 0) {
      throw new Error(`Ticket ${ticketId} still has open review findings.`);
    }
    const outstandingFollowups = findOutstandingCloseoutBlockerFollowups(board, ticketId);
    if (outstandingFollowups.length > 0) {
      throw new Error(
        `Ticket ${ticketId} cannot close while closeout-blocker follow-up tickets remain open: ` +
        `${outstandingFollowups.map((row) => `${row.ID} (${row.Status})`).join(", ")}.`
      );
    }

    const lock = findLockForTicket(ticketId);
    if (lock) {
      throw new Error(`Ticket ${ticketId} still has a lock file at ${path.relative(ROOT_DIR, lock.path)}.`);
    }

    if (ref.row.Repo === "X") {
      ensureRepoXCloseoutReady(ticketId);
    }
    if (isRepoBackedCode(ref.row.Repo)) {
      const landing = ensureLandingRecord(ticketId, board, ref.row, options);
      assertLandingIntegrity(ticketId, ref.row, landing);
      ensureTestingInfrastructureLandingAudit(ticketId, ref.row, landing, { recordEvidence: true });
      ensureFeatureProofLandingAudit(ticketId, ref.row, landing, board.metadata, { recordEvidence: true });
      cleanupTicketWorktree(ticketId, ref.row, options);
    }
  }

  function finishTicket(ticketId, options) {
    if (!ticketId) {
      fail("finish-ticket requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const refs = resolveLifecyclePrRefs(ticketId, ref.row, board, options);

    if (ref.row.Status === STATUS.DOING) {
      moveReview(ticketId, { pr: refs });
      return markDone(ticketId, options);
    }
    if (ref.row.Status === STATUS.REVIEW) {
      setPrRefs(ticketId, { pr: refs, skipSync: true });
      return markDone(ticketId, options);
    }
    fail(`Ticket ${ticketId} must be doing or review; current status is "${ref.row.Status}".`);
  }

  return {
    finalizeTicket,
    finishTicket,
    landTicket,
    prepareDoneCloseout,
    buildPrCloseoutPlanUpdate,
    buildNoPrCloseoutPlanUpdate,
  };
};
