"use strict";

const { isOwnWorktreeToplevel } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governed-workspace-recovery.js"));

module.exports = function createLifecycleMaintenanceCommands({
  REPO_ROOTS,
  STATUS,
  allBoardRepoCodes,
  applyLandingAuditBackfill,
  collectLandingAuditReport,
  ensureTicketMutationOwnership,
  fail,
  getRows,
  getTicketRef,
  getRepoRoot,
  ghPrListMergedByBase,
  isCommitAncestorOfRef,
  isRepoBackedCode,
  integerOrDefault,
  isTicketAtOrAfter,
  planRecordPath,
  readBoard,
  readLatestPlanBlock,
  readPlanRecord,
  resolveHumanAdminOverride,
  appendGovernanceEvent,
  runtimeDir,
  resolveRepoThresholdTicket,
  resolveRepoIntegrationBranch,
  runBoardSync,
  syncPlanRecordFromBlock,
  synthesizeHistoricalPlanRecord,
  toArray,
  withCoordStateLock,
  withGovernanceMutation,
  writeBoard,
  writeCanonicalJsonFile,
}) {
  const { reconcileLandingCandidates, summarizeLandingReconciliation } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/landing-reconciliation.js"));

  function reconcileLandings(options = {}) {
    const requestedRepo = options.repo ? String(options.repo).trim() : null;
    const board = readBoard();
    const rows = getRows(board);
    const repos = Object.keys(REPO_ROOTS).filter((repo) => repo !== "X" && isRepoBackedCode(repo))
      .filter((repo) => !requestedRepo || repo === requestedRepo);
    if (requestedRepo && !repos.includes(requestedRepo)) fail(`Unsupported repo code "${requestedRepo}".`);
    const reports = [];
    for (const repo of repos) {
      const repoRoot = getRepoRoot(repo);
      let baseRef = null;
      try {
        // Git and gh walk upward from plain directories; never attribute the
        // enclosing repository's branches or PRs to this configured product.
        if (!isOwnWorktreeToplevel(repoRoot)) {
          reports.push({ repo, base_ref: null, status: "not_independent_repository",
            error: "Configured directory could not be verified as an independent Git worktree; no remote query was made." });
          continue;
        }
        baseRef = resolveRepoIntegrationBranch(repo);
        const pullRequests = ghPrListMergedByBase(repoRoot, baseRef);
        const entries = reconcileLandingCandidates({
          rows: rows.filter((row) => row.Repo === repo), landingIndex: board.landing_index || {},
          pullRequests, repoRoot, baseRef: `origin/${baseRef}`, isCommitAncestorOfRef,
        });
        reports.push({ repo, base_ref: baseRef, status: "observed", summary: summarizeLandingReconciliation(entries), entries });
      } catch (error) {
        reports.push({ repo, base_ref: baseRef, status: "unknown", error: error.message });
      }
    }
    console.log(JSON.stringify({ read_only: true, mutation: "none", reports }, null, 2));
  }

  function auditLandings(options = {}) {
    if (options.correctMerge || options.correctionTicket) {
      const runner = () => {
        const board = readBoard();
        const repair = getTicketRef(board, options.correctionTicket);
        if (!repair) fail("Correction requires a known --correction-ticket.");
        if (options.write) ensureTicketMutationOwnership(options.correctionTicket, repair.row);
        const report = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/landing-corrections.js")).correctLanding(board, options,
          { resolveHumanAdminOverride, appendGovernanceEvent, runtimeDir, fail });
        if (report.changed) {
          writeBoard(board);
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        }
        console.log(JSON.stringify(report, null, 2));
        return report;
      };
      return options.write
        ? withGovernanceMutation({ command: "audit-landings", ticket: options.correctionTicket }, runner)
        : runner();
    }
    const ticketId = options.ticket ? String(options.ticket).trim() : null;
    const repo = options.repo ? String(options.repo).trim() : null;
    const supportedRepos = [...new Set([...Object.keys(REPO_ROOTS), "X"])].sort();
    if (repo && !supportedRepos.includes(repo)) {
      fail(`Unsupported repo code "${repo}". Use ${supportedRepos.join(", ")}.`);
    }

    const mutation = {
      command: "audit-landings",
      ticket: ticketId || null,
      allowProvenanceDrift: true,
    };
    const runner = () => {
      const board = readBoard();
      if (ticketId && !getTicketRef(board, ticketId)) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      const report = options.write
        ? applyLandingAuditBackfill(board, { ticket: ticketId, repo })
        : collectLandingAuditReport(board, { ticket: ticketId, repo });
      if (options.write && report.backfilled.length > 0) {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      }
      console.log(JSON.stringify(report, null, 2));
    };

    if (options.write) {
      return withGovernanceMutation(mutation, runner);
    }
    return runner();
  }

  function backfillPlanRecords(options = {}) {
    const mutation = { command: "backfill-plan-records" };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const rows = getRows(board);
      const statuses = new Set(
        toArray(options.status).length > 0
          ? toArray(options.status)
          : [STATUS.REVIEW, STATUS.DONE]
      );
      const limit = options.limit ? integerOrDefault(options.limit, null) : null;

      const boardRepoCodes = new Set(allBoardRepoCodes());
      const candidates = rows
        .filter((row) => boardRepoCodes.has(row.Repo))
        .filter((row) => statuses.has(row.Status))
        .filter((row) => {
          const threshold =
            resolveRepoThresholdTicket(options.from, row.Repo) ||
            resolveRepoThresholdTicket(board.metadata?.plan_records_required_from_ticket, row.Repo) ||
            resolveRepoThresholdTicket(board.metadata?.landing_index_required_from_ticket, row.Repo);
          return !threshold || isTicketAtOrAfter(row.ID, threshold);
        })
        .filter((row) => !readPlanRecord(row.ID, { allowMissing: true }))
        .slice(0, Number.isInteger(limit) && limit > 0 ? limit : undefined);

      const created = [];
      withCoordStateLock(() => {
        for (const row of candidates) {
          const block = readLatestPlanBlock(row.ID);
          if (block) {
            syncPlanRecordFromBlock(row.ID, block);
            created.push({ ticket: row.ID, mode: "markdown" });
            continue;
          }
          const record = synthesizeHistoricalPlanRecord(row.ID, row, board);
          writeCanonicalJsonFile(planRecordPath(row.ID), record, { expectedRaw: "" });
          created.push({ ticket: row.ID, mode: "synthetic" });
        }
        if (created.length > 0) {
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        }
      });

      console.log(JSON.stringify({
        statuses: [...statuses],
        created,
        created_count: created.length,
      }, null, 2));
    });
  }

  return {
    auditLandings,
    reconcileLandings,
    backfillPlanRecords,
  };
};
