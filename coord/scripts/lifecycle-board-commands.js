"use strict";

module.exports = function createLifecycleBoardCommands(deps = {}) {
  const {
    STATUS,
    buildQuestionQueueReport,
    collectTemplateFeedbackAlerts,
    extractDriftMutationStage,
    fail,
    findLockForTicket,
    getLockFiles,
    getRows,
    getTicketRef,
    isDoingStatus,
    readActiveOrchestratorQuestionRows,
    readBoard,
    readGovernanceEventLog,
    readTicketWaiver,
    safeReadJson,
  } = deps;

  function increment(obj, key) {
    obj[key] = (obj[key] || 0) + 1;
  }

  function printObjectLines(obj) {
    for (const [key, value] of Object.entries(obj)) {
      console.log(`  ${key}: ${value}`);
    }
  }

  function printCounts() {
    const board = readBoard();
    const rows = getRows(board);
    const countsByStatus = {};
    const countsByRepo = {};

    for (const row of rows) {
      increment(countsByStatus, row.Status);
      increment(countsByRepo, row.Repo);
    }

    const supersededRows = rows.filter((row) => row.Status === STATUS.SUPERSEDED);
    const closedRows = rows.filter((row) => row.Status === STATUS.DONE || row.Status === STATUS.SUPERSEDED);
    const proposedRows = rows.filter((row) => row.Status === STATUS.PROPOSED);
    const openRows = rows.filter(
      (row) =>
        row.Status !== STATUS.DONE &&
        row.Status !== STATUS.SUPERSEDED &&
        row.Status !== STATUS.PROPOSED
    );
    const activeRows = rows.filter((row) => isDoingStatus(row.Status) || row.Status === STATUS.REVIEW);

    console.log(`Board: ${board.metadata?.title || "Task Board"}`);
    console.log(`Tickets: ${rows.length}`);
    console.log(`Open: ${openRows.length} (excludes done, superseded, and proposed)`);
    console.log(`Closed: ${closedRows.length}`);
    console.log(`Superseded: ${supersededRows.length}`);
    console.log(`Proposed: ${proposedRows.length} (awaiting approve/reject)`);
    console.log("");
    console.log("By Status:");
    printObjectLines(countsByStatus);
    console.log("");
    console.log("By Repo:");
    printObjectLines(countsByRepo);
    console.log("");
    console.log("Active:");
    if (activeRows.length === 0) {
      console.log("  none");
    } else {
      for (const row of activeRows) {
        console.log(`  ${row.ID}  ${row.Status}  ${row.Owner}  ${row.Description}`);
      }
    }
    console.log("");
    console.log("Doing Locks:");
    const doingLocks = getLockFiles()
      .map((lockPath) => safeReadJson(lockPath))
      .filter(Boolean)
      .filter((lock) => lock.status === STATUS.DOING);
    if (doingLocks.length === 0) {
      console.log("  none");
    } else {
      for (const lock of doingLocks) {
        console.log(`  ${lock.ticket}  ${lock.owner}  ${lock.repo}  ${lock.worktree}`);
      }
    }
  }

  function showTicket(ticketId) {
    if (!ticketId) {
      fail("ticket command requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    const payload = {
      ticket: ref.row,
      prompt: board.prompt_index?.[ticketId] || null,
      waiver: readTicketWaiver(board, ticketId),
      pr_refs: board.pr_index?.[ticketId] || [],
      landing: board.landing_index?.[ticketId] || null,
      review_findings: board.review_findings?.[ticketId] || [],
      lock: findLockForTicket(ticketId),
    };
    console.log(JSON.stringify(payload, null, 2));
  }

  function orchestratorCycle(options = {}) {
    deps.doctor(options);
    const unresolved = readActiveOrchestratorQuestionRows();
    const board = readBoard();
    const governanceEvents = readGovernanceEventLog();
    const exceptionSlo = buildOrchestratorExceptionSloReport(board, unresolved, governanceEvents);
    const templateFeedbackAlerts = collectTemplateFeedbackAlerts(board, governanceEvents);
    if (unresolved.length === 0) {
      console.log("Orchestrator cycle OK: no unresolved orchestrator questions.");
      console.log(
        `Exception SLO: blockers=${exceptionSlo.unresolved_blocker_count}; ` +
        `stale=${exceptionSlo.unresolved_aging.stale || 0}; ` +
        `merged_but_not_done=${exceptionSlo.merged_but_not_done.length}; ` +
        `drift_stages=${formatBucketCounts(exceptionSlo.drift_counts_by_stage, Object.keys(exceptionSlo.drift_counts_by_stage).sort()) || "none"}`
      );
      for (const line of formatTemplateFeedbackAlerts(templateFeedbackAlerts)) {
        console.log(line);
      }
      return;
    }
    console.log(`Orchestrator cycle OK: ${unresolved.length} unresolved orchestrator question(s) remain in QUESTIONS.md.`);
    const report = buildQuestionQueueReport(unresolved);
    console.log(`Queue by type: ${formatBucketCounts(report.by_type, ["blocker", "repair", "drift-note", "informational"])}`);
    console.log(`Queue by severity: ${formatBucketCounts(report.by_severity, ["high", "medium", "low"])}`);
    console.log(`Queue by aging: ${formatBucketCounts(report.by_aging, ["same-day", "aging", "stale"])}`);
    if (report.oldest.length > 0) {
      console.log("Oldest queue items:");
      for (const row of report.oldest) {
        console.log(`  ${row.date} [${row.aging_bucket}/${row.severity}/${row.operational_type}] ${row.question}`);
      }
    }
    console.log(
      `Exception SLO: blockers=${exceptionSlo.unresolved_blocker_count}; ` +
      `stale=${exceptionSlo.unresolved_aging.stale || 0}; ` +
      `merged_but_not_done=${exceptionSlo.merged_but_not_done.length}; ` +
      `drift_stages=${formatBucketCounts(exceptionSlo.drift_counts_by_stage, Object.keys(exceptionSlo.drift_counts_by_stage).sort()) || "none"}`
    );
    for (const line of formatTemplateFeedbackAlerts(templateFeedbackAlerts)) {
      console.log(line);
    }
    if (exceptionSlo.merged_but_not_done.length > 0) {
      console.log("Merged but not done:");
      for (const entry of exceptionSlo.merged_but_not_done) {
        console.log(`  ${entry.ticket} status=${entry.status} merged_at=${entry.merged_at || "unknown"} pr=${entry.pr_url}`);
      }
    }
  }

  function formatTemplateFeedbackAlerts(alerts = []) {
    if (!alerts.length) {
      return [];
    }
    const lines = [`Template feedback alerts: ${alerts.length} COORD ticket(s) need TEMPLATE_FEEDBACK.md rows.`];
    for (const alert of alerts.slice(0, 10)) {
      const age = alert.age_days === null ? "age=unknown" : `age=${alert.age_days}d`;
      lines.push(`  ${alert.ticket} ${age}: add TEMPLATE_FEEDBACK.md row or human-admin project-local waiver.`);
    }
    if (alerts.length > 10) {
      lines.push(`  ... ${alerts.length - 10} more`);
    }
    return lines;
  }

  function formatBucketCounts(counts = {}, order = []) {
    return order
      .filter((key) => counts[key] !== undefined)
      .map((key) => `${key}=${counts[key]}`)
      .join(", ");
  }

  function buildMergedButNotDoneReport(board, events = []) {
    const latestByTicket = new Map();
    for (const event of events) {
      if (!event || !event.ticket) {
        continue;
      }
      const sideEffects = Array.isArray(event.details?.external_side_effects)
        ? event.details.external_side_effects
        : Array.isArray(event.external_side_effects)
        ? event.external_side_effects
        : [];
      const merge = sideEffects.find((entry) => entry?.type === "github_pr_merge");
      if (!merge) {
        continue;
      }
      latestByTicket.set(event.ticket, {
        ticket: event.ticket,
        merged_at: merge.merged_at || null,
        pr_url: merge.pr_url || null,
        status: getRows(board).find((row) => row.ID === event.ticket)?.Status || null,
      });
    }
    return [...latestByTicket.values()]
      .filter((entry) => entry.status !== STATUS.DONE)
      .sort((left, right) => String(left.ticket).localeCompare(String(right.ticket)));
  }

  function buildOrchestratorExceptionSloReport(board, unresolvedRows = [], events = []) {
    const driftCountsByStage = {};
    for (const row of unresolvedRows) {
      const stage = extractDriftMutationStage(row.question);
      if (stage) {
        driftCountsByStage[stage] = (driftCountsByStage[stage] || 0) + 1;
      }
    }
    return {
      unresolved_total: unresolvedRows.length,
      unresolved_blocker_count: unresolvedRows.filter((row) => row.operational_type === "blocker").length,
      unresolved_aging: buildQuestionQueueReport(unresolvedRows).by_aging,
      unresolved_by_severity: buildQuestionQueueReport(unresolvedRows).by_severity,
      drift_counts_by_stage: driftCountsByStage,
      merged_but_not_done: buildMergedButNotDoneReport(board, events),
    };
  }

  function splitGovernanceProvenanceDrift(drift = []) {
    const warningPrefixes = [
      ".runtime/agent_sessions.json",
      ".runtime/session-threads/",
    ];
    const blocking = [];
    const warnings = [];
    for (const filePath of drift) {
      if (warningPrefixes.some((prefix) => String(filePath || "").startsWith(prefix))) {
        warnings.push(filePath);
      } else {
        blocking.push(filePath);
      }
    }
    return { blocking, warnings };
  }

  return {
    buildMergedButNotDoneReport,
    buildOrchestratorExceptionSloReport,
    formatBucketCounts,
    formatTemplateFeedbackAlerts,
    orchestratorCycle,
    printCounts,
    showTicket,
    splitGovernanceProvenanceDrift,
  };
};
