"use strict";

// B7 decomposition slice: GitHub PR operations (view/create/merge) extracted
// from lifecycle.js into a DI-factory module. The core state-machine transitions
// (start/submit/land/markDone/...) remain in lifecycle.js by design: their
// ~139-identifier coupling makes them the irreducible orchestration hub, so
// factory-extracting them would inject ~60 deps and add coupling rather than
// reduce it (the thin-hub endpoint).

const { defaultFail, DEFAULT_PATHS } = require("./governance-context.js");
const { DEFAULT_INTEGRATION_BRANCH } = require("../paths.js");
const { STATUS } = require("./governance-constants.js");
const { assertFactoryDependencies } = require("./factory-deps.js");
const { stableIdempotencyKey } = require("./idempotency.js");
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};

const REQUIRED_PR_OPS_DEPS = {
  callable: [
    "assertCommittedReviewState",
    "assertReviewPlanReady",
    "ensureDoingTicketLockIntegrity",
    "ensureTicketMutationOwnership",
    "evaluateReadiness",
    "formatDependencyCycleList",
    "formatTransitiveBlockerDetails",
    "getRepoRoot",
    "getTicketRef",
    "ghPrListByBranch",
    "ghPrView",
    "inferTicketStatus",
    "isGitHubPrUrl",
    "isRepoBackedCode",
    "mergePrUrl",
    "mergeUniqueRefs",
    "preflightPrBranch",
    "readBoard",
    "recordGovernanceExternalSideEffect",
    "resolvePrUrlForTicket",
    "resolveTicketGitContext",
    "rowsById",
    "runBoardSync",
    "runGh",
    "withGovernanceMutation",
    "writeBoard",
  ],
  value: [],
};

module.exports = function createPrOps(deps = {}) {
  const fail = deps.fail || defaultFail;
  assertFactoryDependencies("createPrOps", deps, REQUIRED_PR_OPS_DEPS);
  const {
    assertCommittedReviewState, assertReviewPlanReady, ensureDoingTicketLockIntegrity,
    ensureTicketMutationOwnership, evaluateReadiness, formatDependencyCycleList,
    formatTransitiveBlockerDetails, getRepoRoot, getTicketRef, ghPrListByBranch, ghPrView,
    inferTicketStatus, isGitHubPrUrl,
    isRepoBackedCode, mergePrUrl, mergeUniqueRefs, preflightPrBranch, readBoard,
    recordGovernanceExternalSideEffect, resolvePrUrlForTicket, resolveTicketGitContext, rowsById,
    runBoardSync, runGh, withGovernanceMutation, writeBoard,
  } = deps;

  function assertPrTransitionReady(ticketId, row, board) {
    const readiness = evaluateReadiness(row, rowsById(board), board);
    if (readiness.blockedBy.length > 0) {
      const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
      fail(
        `Ticket ${ticketId} still has unmet dependencies: ${readiness.blockedBy.join(", ")}.` +
        (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
        (readiness.cycles.length > 0 ? ` Dependency cycle(s): ${formatDependencyCycleList(readiness.cycles)}.` : "")
      );
    }
    assertReviewPlanReady(ticketId, row);
  }

  function buildPrCreateArgs(branch, base, options = {}) {
    const createArgs = ["pr", "create", "--head", branch, "--base", base];
    if (options.draft) {
      createArgs.push("--draft");
    }
    if (options.fill) {
      createArgs.push("--fill");
      return createArgs;
    }
    if (!options.title || !options.body) {
      fail('pr-create requires either --fill or both --title "<text>" and --body "<text>".');
    }
    createArgs.push("--title", options.title, "--body", options.body);
    return createArgs;
  }

  function reusablePrForBranch(prs, branch, base) {
    const matches = (Array.isArray(prs) ? prs : []).filter((pr) => {
      if (!isGitHubPrUrl(pr?.url)) return false;
      if (pr.headRefName && pr.headRefName !== branch) return false;
      if (pr.baseRefName && pr.baseRefName !== base) return false;
      return !pr.state || pr.state === "OPEN" || pr.state === "MERGED";
    });
    if (matches.length > 1) {
      fail(`Branch ${branch} has multiple reusable PRs targeting ${base}; pass the intended PR explicitly.`);
    }
    return matches[0] || null;
  }

  function recordBranchPush(ticketId, branch, receipt) {
    if (!receipt || receipt.attempted !== true) return;
    recordGovernanceExternalSideEffect({
      type: "git_branch_push",
      ticket: ticketId,
      branch,
      remote: receipt.remote || "origin",
      remote_ref: receipt.remote_ref || null,
      commit_sha: receipt.commit_sha || null,
      remote_sha_before: receipt.remote_sha_before || null,
      remote_sha_after: receipt.remote_sha_after || null,
      status: receipt.status || "unknown",
      attempted: true,
      acknowledged: receipt.acknowledged !== false,
      delivered: receipt.pushed === true,
      remote_moved: receipt.remote_moved === true,
      forced: false,
      ...(receipt.ack_lost ? { ack_lost: true } : {}),
      ...(receipt.detail ? { detail: receipt.detail } : {}),
    });
  }

  function recordPrCreate(ticketId, branch, base, details = {}) {
    recordGovernanceExternalSideEffect({
      type: "github_pr_create",
      ticket: ticketId,
      branch,
      base,
      pr_url: details.prUrl || null,
      status: details.status,
      attempted: details.attempted === true,
      acknowledged: details.acknowledged !== false,
      ...(details.delivered === undefined ? {} : { delivered: details.delivered === true }),
      ...(details.detail ? { detail: details.detail } : {}),
    });
  }

  function prView(subject, options) {
    if (!subject) {
      fail("pr-view requires <ticket-id|pr-url>.");
    }
  
    if (isGitHubPrUrl(subject)) {
      console.log(JSON.stringify(ghPrView(subject), null, 2));
      return;
    }
  
    const board = readBoard();
    const ref = getTicketRef(board, subject);
    if (!ref) {
      fail(`Unknown ticket "${subject}".`);
    }
  
    const prRefs = board.pr_index?.[subject] || [];
    const ticketContext = resolveTicketGitContext(ref.row, subject);
    const branch = options.branch || ticketContext.branch;
    let prs = [];
  
    if (prRefs.some((entry) => isGitHubPrUrl(entry))) {
      prs = prRefs.filter((entry) => isGitHubPrUrl(entry)).map((entry) => ghPrView(entry));
    } else if (branch && isRepoBackedCode(ref.row.Repo)) {
      prs = ghPrListByBranch(getRepoRoot(ref.row.Repo), branch);
    }
  
    console.log(JSON.stringify({
      ticket: ref.row,
      branch,
      repo_root: isRepoBackedCode(ref.row.Repo) ? getRepoRoot(ref.row.Repo) : null,
      pr_refs: prRefs,
      prs,
    }, null, 2));
  }
  
  function prCreate(ticketId, options = {}) {
    const mutation = {
      command: "pr-create",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("pr-create", ticketId, {
        base: options?.base || null,
        branch: options?.branch || null,
        draft: Boolean(options?.draft),
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("pr-create requires <ticket-id>.");
      }
  
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (!isRepoBackedCode(ref.row.Repo)) {
        fail(`Ticket ${ticketId} is repo ${ref.row.Repo}; PR creation is only supported for repo-backed tickets.`);
      }
      if (ref.row.Status !== STATUS.DOING) {
        fail(`Ticket ${ticketId} must be doing before PR creation; current status is "${ref.row.Status}".`);
      }
  
      const lock = ensureDoingTicketLockIntegrity(ticketId, ref.row, options);
      mutation.identity = ensureTicketMutationOwnership(ticketId, ref.row, lock, options);
      assertPrTransitionReady(ticketId, ref.row, board);
  
      const repoRoot = getRepoRoot(ref.row.Repo);
      const branch = options.branch || lock.branch;
      if (!branch) {
        fail(`Ticket ${ticketId} has no branch recorded in its lock.`);
      }
      const base = options.base || REPO_INTEGRATION_BRANCHES[ref.row.Repo] || DEFAULT_INTEGRATION_BRANCH;
      // COORD-697: construct and validate the COMPLETE provider argv before a
      // push can happen. Previously --push ran first and a missing title/body
      // failed afterwards, leaving a published branch behind with no receipt.
      const createArgs = buildPrCreateArgs(branch, base, options);
      assertCommittedReviewState(ticketId, ref.row, lock);

      const existing = ghPrListByBranch(repoRoot, branch);
      const reusable = reusablePrForBranch(existing, branch, base);
      if (existing.length > 0 && !reusable) {
        fail(`Ticket ${ticketId} already has a non-reusable PR for branch ${branch}; use pr-view to reconcile it.`);
      }
      const pushCwd = options.pushCwd || lock.worktree || repoRoot;
      const branchResult = preflightPrBranch(repoRoot, branch, base, {
        ...options,
        pushCwd,
        onPushReceipt: (receipt) => recordBranchPush(ticketId, branch, receipt),
      });

      let output = reusable?.url || null;
      let acknowledged = Boolean(reusable);
      if (reusable) {
        recordPrCreate(ticketId, branch, base, {
          prUrl: output,
          status: "already_present",
          attempted: false,
          acknowledged: true,
          delivered: true,
          detail: "provider state already contained one reusable PR for the governed branch/base; no PR create was attempted",
        });
      } else {
        try {
          output = String(runGh(repoRoot, createArgs, { capture: true }) || "").trim();
          if (!isGitHubPrUrl(output)) {
            throw new Error(`gh pr create returned an invalid PR URL: ${output || "<empty>"}`);
          }
          acknowledged = true;
        } catch (error) {
          // The provider may have created the PR and lost the acknowledgement.
          // Reconcile from provider state before deciding whether the action
          // failed, exactly as the shared push primitive does for lost ACKs.
          let observed = [];
          let observationError = null;
          try {
            observed = ghPrListByBranch(repoRoot, branch);
          } catch (queryError) {
            observationError = queryError;
          }
          const afterFailure = reusablePrForBranch(observed, branch, base);
          if (afterFailure) {
            output = afterFailure.url;
            acknowledged = false;
            recordPrCreate(ticketId, branch, base, {
              prUrl: output,
              status: "created_ack_lost",
              attempted: true,
              acknowledged: false,
              delivered: true,
              detail: `PR creation was not acknowledged locally (${error.message}), but provider state confirms ${output}`,
            });
          } else {
            recordPrCreate(ticketId, branch, base, {
              status: "ambiguous",
              attempted: true,
              acknowledged: false,
              detail: observationError
                ? `${error.message}; provider reconciliation also failed: ${observationError.message}`
                : `${error.message}; provider state did not yet confirm whether creation completed`,
            });
            throw error;
          }
        }
        if (acknowledged) {
          recordPrCreate(ticketId, branch, base, {
            prUrl: output,
            status: "created",
            attempted: true,
            acknowledged: true,
            delivered: true,
          });
        }
      }

      const nextBoard = readBoard();
      nextBoard.pr_index[ticketId] = mergeUniqueRefs(nextBoard.pr_index?.[ticketId] || [], [output]);
      writeBoard(nextBoard);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
      console.log(JSON.stringify({
        ticket: ticketId,
        branch,
        base,
        draft: Boolean(options.draft),
        pr_url: output,
        pr_index_recorded: true,
        pr_create_acknowledged: acknowledged,
        branch_push: branchResult?.pushReceipt || null,
      }, null, 2));
    });
  }
  
  function prMerge(subject, options) {
    if (!subject) {
      fail("pr-merge requires <ticket-id|pr-url>.");
    }
  
    const mutation = {
      command: "pr-merge",
      ticket: isGitHubPrUrl(subject) ? null : subject,
      beforeStatus: isGitHubPrUrl(subject) ? null : inferTicketStatus(subject),
      forceLog: true,
    };
    return withGovernanceMutation(mutation, () => {
      const method = options.method || "squash";
      if (!["merge", "squash", "rebase"].includes(method)) {
        fail(`Unsupported merge method "${method}". Use merge, squash, or rebase.`);
      }
  
      if (isGitHubPrUrl(subject)) {
        const mergeResult = mergePrUrl(subject, method, options);
        if (mergeResult?.status === "merged") {
          recordGovernanceExternalSideEffect({
            type: "github_pr_merge",
            pr_url: mergeResult.pr_url,
            method: mergeResult.method,
            merged_at: mergeResult.merged_at || null,
            delete_branch: Boolean(mergeResult.delete_branch),
          });
        }
        return mergeResult;
      }
  
      const board = readBoard();
      const ref = getTicketRef(board, subject);
      if (!ref) {
        fail(`Unknown ticket "${subject}".`);
      }
      if (ref.row.Status !== STATUS.REVIEW) {
        fail(`Ticket ${subject} must be review before PR merge; current status is "${ref.row.Status}".`);
      }
      if (!isRepoBackedCode(ref.row.Repo)) {
        fail(`Ticket ${subject} is repo ${ref.row.Repo}; PR merge is only supported for repo-backed tickets.`);
      }
      mutation.identity = ensureTicketMutationOwnership(subject, ref.row, null, options);
  
      const repoRoot = getRepoRoot(ref.row.Repo);
      const prUrl = options.pr || resolvePrUrlForTicket(board, ref.row, subject);
      if (!prUrl) {
        fail(`Could not resolve a GitHub PR for ${subject}.`);
      }
  
      const mergeResult = mergePrUrl(prUrl, method, options, repoRoot);
      if (mergeResult?.status === "merged") {
        recordGovernanceExternalSideEffect({
          type: "github_pr_merge",
          ticket: subject,
          pr_url: mergeResult.pr_url,
          method: mergeResult.method,
          merged_at: mergeResult.merged_at || null,
          delete_branch: Boolean(mergeResult.delete_branch),
        });
      }
      return mergeResult;
    });
  }
  return { prView, prCreate, prMerge };
};

module.exports.DEP_CONTRACT = REQUIRED_PR_OPS_DEPS;
