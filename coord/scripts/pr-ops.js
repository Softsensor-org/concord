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
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};

module.exports = function createPrOps(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    assertCommittedReviewState, ensureDoingTicketLockIntegrity, ensureTicketMutationOwnership,
    getRepoRoot, getTicketRef, ghPrListByBranch, ghPrView, inferTicketStatus, isGitHubPrUrl,
    isRepoBackedCode, mergePrUrl, mergeUniqueRefs, preflightPrBranch, readBoard,
    recordGovernanceExternalSideEffect, resolvePrUrlForTicket, resolveTicketGitContext,
    runBoardSync, runGh, withGovernanceMutation, writeBoard,
  } = deps;

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
  
  function prCreate(ticketId, options) {
    const mutation = {
      command: "pr-create",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
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
  
      const repoRoot = getRepoRoot(ref.row.Repo);
      const branch = options.branch || lock.branch;
      if (!branch) {
        fail(`Ticket ${ticketId} has no branch recorded in its lock.`);
      }
      assertCommittedReviewState(ticketId, ref.row, lock);
  
      const existing = ghPrListByBranch(repoRoot, branch);
      if (existing.length > 0) {
        fail(`Ticket ${ticketId} already has PRs for branch ${branch}; use pr-view/pr-merge instead.`);
      }
      const pushCwd = options.pushCwd || lock.worktree || repoRoot;
      preflightPrBranch(repoRoot, branch, options.base || REPO_INTEGRATION_BRANCHES[ref.row.Repo] || DEFAULT_INTEGRATION_BRANCH, { ...options, pushCwd });
  
      const createArgs = ["pr", "create", "--head", branch, "--base", options.base || REPO_INTEGRATION_BRANCHES[ref.row.Repo] || DEFAULT_INTEGRATION_BRANCH];
      if (options.draft) {
        createArgs.push("--draft");
      }
      if (options.fill) {
        createArgs.push("--fill");
      } else {
        if (!options.title || !options.body) {
          fail('pr-create requires either --fill or both --title "<text>" and --body "<text>".');
        }
        createArgs.push("--title", options.title, "--body", options.body);
      }
  
      const output = runGh(repoRoot, createArgs, { capture: true }).trim();
      const nextBoard = readBoard();
      nextBoard.pr_index[ticketId] = mergeUniqueRefs(nextBoard.pr_index?.[ticketId] || [], [output]);
      writeBoard(nextBoard);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
      console.log(JSON.stringify({
        ticket: ticketId,
        branch,
        base: options.base || REPO_INTEGRATION_BRANCHES[ref.row.Repo] || DEFAULT_INTEGRATION_BRANCH,
        draft: Boolean(options.draft),
        pr_url: output,
        pr_index_recorded: true,
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
