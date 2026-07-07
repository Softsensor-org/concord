"use strict";

module.exports = function createLifecycleMaintenanceCommands({
  REPO_ROOTS,
  STATUS,
  allBoardRepoCodes,
  applyLandingAuditBackfill,
  collectLandingAuditReport,
  fail,
  getRows,
  getTicketRef,
  integerOrDefault,
  isTicketAtOrAfter,
  planRecordPath,
  readBoard,
  readLatestPlanBlock,
  readPlanRecord,
  resolveRepoThresholdTicket,
  runBoardSync,
  syncPlanRecordFromBlock,
  synthesizeHistoricalPlanRecord,
  toArray,
  withCoordStateLock,
  withGovernanceMutation,
  writeBoard,
  writeCanonicalJsonFile,
}) {
  function auditLandings(options = {}) {
    const ticketId = options.ticket ? String(options.ticket).trim() : null;
    const repo = options.repo ? String(options.repo).trim() : null;
    const supportedRepos = Object.keys(REPO_ROOTS).filter((repoCode) => repoCode !== "X").sort();
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
    backfillPlanRecords,
  };
};
