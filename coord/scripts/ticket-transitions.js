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

module.exports = function createTicketTransitions(deps = {}) {
  const fail = deps.fail || defaultFail;

  const {
    // board-state mutators / readers
    readBoard,
    writeBoard,
    getTicketRef,
    getRows,
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
    withPreparedTicketWorkspace,
    cleanupClosedTicketWorkspace,
    writeLock,
    defaultWorktreePath,
    // readiness / dependency analysis
    evaluateReadiness,
    formatTransitiveBlockerDetails,
    formatDependencyCycleList,
    findDoingTicketForOwner,
    canOwnerHoldConcurrentDoing,
    // review / PR evidence
    resolveLifecyclePrRefs,
    assertReviewPlanReady,
    assertAlreadyLandedNoPrReconcileReady,
    assertCommittedReviewState,
    refsContainMergedPrForTicket,
    prCreate,
    appendReviewFollowupPlan,
    inferNextRound,
    // closeout (stays in lifecycle.js; injected for mark-done)
    prepareDoneCloseout,
    // start-path: plan/prompt/seed helpers
    buildStartOwnershipRaceMessage,
    buildHistoricalCloseoutStartBlocker,
    ensurePromptCoverageOrDiscover,
    assertPromptPreconditionsResolve,
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
    // misc utilities
    toArray,
    slugify,
    integerOrDefault,
    isDoingStatus,
  } = deps;

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

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.TODO);
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.TODO;
      mutation.details = { previous_status: STATUS.PROPOSED };
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

      withCoordStateLock(() => {
        applyTicketStatus(ref, STATUS.SUPERSEDED);
        ref.row["Supersede Reason"] = reason;
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });

      mutation.afterStatus = STATUS.SUPERSEDED;
      mutation.details = { previous_status: STATUS.PROPOSED, reason };
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

    const refs = toArray(options.pr);
    if (refs.length > 0) {
      moveReview(ticketId, { pr: refs });
      return;
    }

    const existingRefs = board.pr_index?.[ticketId] || [];
    if (existingRefs.length > 0) {
      moveReview(ticketId, {});
      return;
    }

    if (options.fill && toArray(options.pr).some((entry) => /\(no PR\)/.test(String(entry)))) {
      moveReview(ticketId, { pr: options.pr });
      return;
    }

    if (ref.row.Repo === "X") {
      fail(
        `Ticket ${ticketId} is repo X and has no recorded PR evidence. ` +
        `Use "coord/scripts/gov submit ${ticketId} --pr \\"local-review (no PR)\\"" ` +
        `or "coord/scripts/gov move-review ${ticketId} --pr \\"local-review (no PR)\\"" instead.`
      );
    }

    assertReviewPlanReady(ticketId, ref.row);
    prCreate(ticketId, { ...options, push: true });
    moveReview(ticketId, {});
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
      }),
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
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, null, options);
      try {
        prepareDoneCloseout(ticketId, board, ref, options);
        applyMarkDone(ticketId, board, ref);
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
        ...(mutation.details || {}),
        previous_status: previousStatus,
        cleaned_workspace: cleaned || null,
      };
      console.log(`Marked ${ticketId} ${previousStatus} -> superseded and cleaned active governance residue.`);
    });
  }

  function applyMarkDone(ticketId, board, ref) {
    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.DONE);
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Marked ${ticketId} review -> done and synced board artifacts.`);
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
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, lock, options);
      const readiness = evaluateReadiness(ref.row, rowsById(board), board);
      if (readiness.blockedBy.length > 0) {
        const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
        fail(
          `Ticket ${ticketId} still has unmet dependencies: ${readiness.blockedBy.join(", ")}.` +
          (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
          (readiness.cycles.length > 0 ? ` Dependency cycle(s): ${formatDependencyCycleList(readiness.cycles)}.` : "")
        );
      }
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
      withCoordStateLock(() => {
        setTicketPrRefs(board, ticketId, prRefs);
        applyTicketStatus(ref, STATUS.REVIEW);
        writeBoard(board);
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Moved ${ticketId} doing -> review, recorded PR evidence, and released the lock.`);
    });
  }

  function returnDoing(ticketId, options) {
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
      const identity = resolveOwnerIdentity(options.owner);
      mutation.identity = identity;
      const owner = identity.agent.handle;

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (ref.row.Status !== STATUS.REVIEW) {
        fail(`Ticket ${ticketId} must be review; current status is "${ref.row.Status}".`);
      }
      assertTicketMutationOwnership(ticketId, ref.row, null);
      const ownerDoing = findDoingTicketForOwner(board, owner, ticketId);
      if (ownerDoing) {
        fail(`Owner ${owner} already has an active doing ticket: ${ownerDoing.ID}.`);
      }

      const findings = board.review_findings[ticketId] || [];
      const nextId = `${ticketId}-F${findings.length + 1}`;
      const finding = {
        id: nextId,
        severity: options.severity,
        summary: options.summary,
        status: FINDING_STATUS.OPEN,
        round: integerOrDefault(options.round, inferNextRound(findings)),
        qref: options.qref,
      };

      const branch =
        options.branch ||
        `agent/${owner.toLowerCase()}-${ticketId.toLowerCase()}-${slugify(options.topic || ref.row.Description).slice(0, 40)}`;
      const worktree = options.worktree || defaultWorktreePath(ref.row.Repo, owner, ticketId);
      if (isRepoBackedCode(ref.row.Repo)) {
        ensureGitWorktree({
          repoCode: ref.row.Repo,
          worktree,
          branch,
          base: resolveTicketBaseRef(ticketId, ref.row, options),
        });
      } else if (ref.row.Repo === "X") {
        fs.mkdirSync(worktree, { recursive: true });
      }

      persistReturnDoingState({
        board,
        ref,
        finding,
        owner,
        branch,
        worktree,
        session: identity.session,
        appendPlan: appendReviewFollowupPlan,
        boardWriter: writeBoard,
        lockWriter: writeLock,
        syncWriter: () => runBoardSync({ ignoreActiveTicketLockErrors: true, currentTicketId: ticketId }),
      });
      console.log(`Moved ${ticketId} review -> doing, recorded ${nextId}, reacquired lock, and updated plan under owner=${owner}${identity.autoClaimed ? ` (${identity.agent.id}, auto-claimed)` : ""}.`);
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
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("start-ticket requires <ticket-id>.");
      }
      const identity = resolveOwnerIdentity(options.owner);
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
      // COORD-023: auto-discover an on-disk prompt before failing. If neither a
      // prompt_index entry, a waiver, nor a coord/prompts/tickets/<ID>.md file
      // exists, the original "no prompt coverage" error stands.
      if (!ensurePromptCoverageOrDiscover(board, ticketId)) {
        fail(`Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`);
      }
      // COORD-008: verify the ticket prompt's declared `## Preconditions`
      // against the target repo's integration branch BEFORE any lock or
      // worktree is created. A stale prompt (premise artifacts that exist in no
      // branch) fails here instead of burning a full claim/lock/worktree cycle.
      assertPromptPreconditionsResolve(ticketId, ref.row, board, options);
      const ownerDoing = findDoingTicketForOwner(board, owner);
      if (ownerDoing && !canOwnerHoldConcurrentDoing(board, ticketId, ownerDoing.ID)) {
        fail(
          `Owner ${owner} already has an active doing ticket: ${ownerDoing.ID}. ` +
          `Run \`coord/scripts/gov explain ${ownerDoing.ID}\` or finish/repair that ticket before starting ${ticketId}.`
        );
      }

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
        `agent/${owner.toLowerCase()}-${ticketId.toLowerCase()}-${slugify(options.topic || ref.row.Description).slice(0, 40)}`;
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
          base: resolveTicketBaseRef(ticketId, ref.row, options),
        },
        () => {
          withCoordStateLock(() => {
            applyTicketStatus(ref, STATUS.DOING);
            assignTicketOwner(ref, owner);
            writeBoard(board);
            writeLock({ ticketId, owner, repoCode, branch, worktree, now, repoName, session: identity.session });
            runBoardSync({ ignoreActiveTicketLockErrors: true });
          });
        }
      );
      console.log(`Started ${ticketId}: owner=${owner}${identity.autoClaimed ? ` (${identity.agent.id}, auto-claimed)` : ""} branch=${branch} worktree=${worktree}`);
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
      if (ref.row.Status !== STATUS.DOING) {
        fail(
          `Ticket ${ticketId} must be plain "doing" to block; current status is "${ref.row.Status}".`
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
      console.log(`Blocked ${ticketId}: doing -> ${nextStatus}.`);
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

  function persistReturnDoingState({ board, ref, finding, owner, branch, worktree, session, appendPlan, boardWriter, lockWriter, syncWriter = null }) {
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
