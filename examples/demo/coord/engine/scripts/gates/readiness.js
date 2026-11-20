"use strict";

const DECLARED_FILES_BOARD_FIELDS = [
  "Declared Files",
  "Declared files",
  "declared_files",
  "declaredFiles",
];

function createReadinessGate(deps) {
  const {
    GovernanceError,
    STATUS,
    buildDependencyRepairNextSteps,
    buildHistoricalCloseoutStartBlocker,
    buildStartPlanBootstrapCommand,
    collectPromptRecordBlockers,
    collectReviewPlanReadinessIssues,
    describeTicketMutationOwnershipIssue,
    evaluateReadiness,
    formatDependencyCycleList,
    formatGovernanceBlockers,
    formatTransitiveBlockerDetails,
    fs,
    path,
    readPlanState,
    rowsById,
    startGateRegistry,
    state,
    ticketRequiresBaseline,
    ticketRequiresTraceability,
    toArray,
  } = deps;

  // COORD-814: a bare `Command:` / `Outcome:` label is not evidence. Required
  // baseline entries must carry a nonblank value; the only alternative is an
  // explicit `Not-required: <reason>` entry with a nonblank reason.
  function baselineReproductionSatisfied(baselineItems) {
    const values = (baselineItems || []).map((value) => String(value).trim());
    if (values.some((value) => /^Not-required:\s*\S/i.test(value))) {
      return true;
    }
    const hasCommand = values.some((value) => /^Command:\s*\S/i.test(value));
    const hasOutcome = values.some((value) => /^Outcome:\s*\S/i.test(value));
    return hasCommand && hasOutcome;
  }

  function baselineReproductionMessage(ticketId) {
    return `Plan state for ${ticketId} must record baseline reproduction Command and Outcome with nonblank values ` +
      `(or an explicit "Not-required: <reason>" entry) before start-ticket.`;
  }

  // guard:start-readiness
  function collectStartReadinessBlockers(ticketId, row, board) {
    if (row.Status !== STATUS.TODO && row.Status !== STATUS.DEFERRED) {
      return [{
        code: "status",
        message: `Ticket ${ticketId} cannot start from status "${row.Status}"; start requires todo or deferred.`,
        next_steps: [`coord/scripts/gov explain ${ticketId}`],
      }];
    }

    const blockers = [];
    const closeoutBlocker = buildHistoricalCloseoutStartBlocker(ticketId, row, board);
    if (closeoutBlocker) {
      blockers.push(closeoutBlocker);
      return blockers;
    }
    const readiness = evaluateReadiness(row, rowsById(board), board);
    if (readiness.cycles.length > 0) {
      blockers.push({
        code: "dependency_cycles",
        message: `Ticket ${ticketId} cannot start because dependency cycle(s) exist: ${formatDependencyCycleList(readiness.cycles)}.`,
        next_steps: buildDependencyRepairNextSteps(ticketId, readiness, board),
      });
    }
    if (readiness.blockedBy.length > 0) {
      const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
      blockers.push({
        code: "dependencies",
        message:
          `Ticket ${ticketId} cannot start until these dependencies land: ${readiness.blockedBy.join(", ")}.` +
          (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
          (readiness.deps.length === 1 && readiness.blockedBy.length === 1
            ? " If this dependency should only track a related or closeout-only follow-up, repair the relation with set-followup-relation instead of editing board state directly."
            : ""),
        next_steps: buildDependencyRepairNextSteps(ticketId, readiness, board),
      });
    }
    // COORD-956: prompt coverage (COORD-023) and the prompt content contract
    // (COORD-813) are one prompt-record check. The preflight reports exactly the
    // refusal `gov start` raises; preconditions are start-only and stay out of it.
    blockers.push(...collectPromptRecordBlockers(ticketId, board));

    const planState = readPlanState(ticketId);
    if (!planState) {
      blockers.push({
        code: "missing_plan_state",
        message: `Plan state missing for ${ticketId}. Seed canonical plan state before start-ticket.`,
        next_steps: [buildStartPlanBootstrapCommand(ticketId, row)],
      });
      return blockers;
    }
    if (planState) {
      // readPlanState normalizes these list fields for JSON and legacy plans.
      const startupChecklist = planState.startup_checklist.map((value) => String(value || "").trim().toLowerCase());
      if (!startupChecklist.includes("completed")) {
        blockers.push({
          code: "startup_checklist",
          message: `Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`,
          next_steps: [`coord/scripts/gov update-plan ${ticketId} --startup completed`],
        });
      }

      const traceabilityGate = planState.traceability_gate.map((value) => String(value || "").trim().toLowerCase());
      if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
        blockers.push({
          code: "traceability_gate",
          message: `Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`,
          next_steps: [`coord/scripts/gov update-plan ${ticketId} --traceability verified`],
        });
      }

      if (ticketRequiresBaseline(row)) {
        if (!baselineReproductionSatisfied(planState.baseline_reproduction)) {
          blockers.push({
            code: "baseline_reproduction",
            message: baselineReproductionMessage(ticketId),
            next_steps: [
              `coord/scripts/gov update-plan ${ticketId} --baseline "Command: <repro command>" --baseline "Outcome: <observed result>"`,
              `coord/scripts/gov update-plan ${ticketId} --baseline "Not-required: <reason>"`,
            ],
          });
        }
      }
    }

    return blockers;
  }

  function normalizeDeclaredFilePath(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  }

  function parseDeclaredFilesValue(value) {
    const values = Array.isArray(value) ? value : [value];
    const fileSet = new Set();
    for (const entry of values) {
      const text = String(entry || "").trim();
      if (!text) {
        continue;
      }
      for (const m of text.matchAll(/`([^`]+)`/g)) {
        const candidate = normalizeDeclaredFilePath(m[1]);
        if (candidate && /[\/.]/.test(candidate) && !candidate.includes(" ")) {
          fileSet.add(candidate);
        }
      }
      for (const token of text.split(/[\n,;]+/)) {
        const candidate = normalizeDeclaredFilePath(token.replace(/^\s*-\s*/, "").replace(/^`|`$/g, ""));
        if (candidate && /[\/.]/.test(candidate) && !candidate.includes(" ")) {
          fileSet.add(candidate);
        }
      }
    }
    return [...fileSet].sort();
  }

  function parseBoardDeclaredFiles(row) {
    const fileSet = new Set();
    for (const field of DECLARED_FILES_BOARD_FIELDS) {
      for (const file of parseDeclaredFilesValue(row?.[field])) {
        fileSet.add(file);
      }
    }
    return [...fileSet].sort();
  }

  function parsePromptDeclaredFiles(ticketId) {
    const promptPath = path.join(state.PROMPTS_DIR, "tickets", `${ticketId}.md`);
    if (!fs.existsSync(promptPath)) {
      return [];
    }
    const text = fs.readFileSync(promptPath, "utf8");
    const match = text.match(/(^|\n)##+\s*(?:Likely Files|Files)[^\n]*\n([\s\S]*?)(\n##\s|$)/i);
    if (!match) {
      return [];
    }
    const fileSet = new Set();
    for (const line of match[2].split("\n")) {
      if (!/^\s*-\s+/.test(line)) {
        continue;
      }
      for (const file of parseDeclaredFilesValue(line)) {
        fileSet.add(file);
      }
    }
    return [...fileSet].sort();
  }

  function collectTicketDeclaredFiles(ticketId, row) {
    return [...new Set([
      ...parseBoardDeclaredFiles(row),
      ...parsePromptDeclaredFiles(ticketId),
    ])].sort();
  }

  function collectStartReadinessAdvisories(ticketId, row) {
    if (!row || row.Status !== STATUS.TODO || row.Repo !== "X") {
      return [];
    }
    if (collectTicketDeclaredFiles(ticketId, row).length > 0) {
      return [];
    }
    return [{
      // guard:start-readiness
      code: "repo_x_declared_files_missing",
      message:
        `Ticket ${ticketId} has no declared file surface, so plan-waves must schedule it alone as a global coord-state risk.`,
      next_steps: [
        // COORD-572: this blocker used to describe a file to edit and a board
        // field to "set", and named no command for either — an invitation to
        // hand-edit the board. Declare the surface through the governed writer.
        `coord/scripts/gov update-plan ${ticketId} --files "<repo-relative path>"`,
        `Add a \`## Likely Files\` section to coord/prompts/tickets/${ticketId}.md, or register one with coord/scripts/gov register-prompt ${ticketId} --create`,
        "Keep global coordination state paths (coord/.runtime, coord/board, coord/prompts, coord/rendered, coord/locks) out of safe parallel waves unless the ticket truly must serialize.",
      ],
    }];
  }

  function submitRequiresReviewPlanCheck(_board, row, _ticketId, _options = {}) {
    // COORD-653: PR refs never make a doing ticket review-ready.
    return row?.Status === STATUS.DOING;
  }

  // guard:submit-readiness
  function collectSubmitReadinessBlockers(ticketId, row, board, lock, options = {}) {
    if (row.Status === STATUS.REVIEW) {
      return [];
    }
    if (row.Status !== STATUS.DOING) {
      return [{
        code: "status",
        message: `Ticket ${ticketId} must be doing or review to submit; current status is "${row.Status}".`,
        next_steps: row.Status === STATUS.TODO || row.Status === STATUS.DEFERRED
          ? [`coord/scripts/gov start ${ticketId}`]
          : [`coord/scripts/gov explain ${ticketId}`],
      }];
    }
    if (!lock) {
      return [{
        code: "missing_lock",
        message: `Ticket ${ticketId} is doing but has no active lock.`,
        next_steps: [`coord/scripts/gov recover ${ticketId}`],
      }];
    }

    const blockers = [];
    const ownershipIssue = describeTicketMutationOwnershipIssue(ticketId, row, lock);
    if (ownershipIssue.code !== "ok") {
      blockers.push(ownershipIssue);
    }
    // COORD-796: use the same dependency evaluator as submit/move-review.
    // Existing PR evidence does not make unmet prerequisites ready to land.
    const readiness = evaluateReadiness(row, rowsById(board), board);
    if (readiness.blockedBy.length > 0) {
      const transitiveDetails = formatTransitiveBlockerDetails(readiness.blockerChains);
      blockers.push({
        // guard:dependency-readiness
        code: "dependencies",
        message:
          `Ticket ${ticketId} still has unmet dependencies: ${readiness.blockedBy.join(", ")}.` +
          (transitiveDetails ? ` Transitive blocker chains: ${transitiveDetails}.` : "") +
          (readiness.cycles.length > 0 ? ` Dependency cycle(s): ${formatDependencyCycleList(readiness.cycles)}.` : ""),
        next_steps: buildDependencyRepairNextSteps(ticketId, readiness, board),
      });
    }
    if (submitRequiresReviewPlanCheck(board, row, ticketId, options)) {
      blockers.push(...collectReviewPlanReadinessIssues(ticketId, row));
    }
    return blockers;
  }

  // guard:start-readiness
  function assertStartPlanReady(ticketId, row) {
    const planState = readPlanState(ticketId);
    if (!planState) {
      throw new GovernanceError(`Plan state missing for ${ticketId}. Create the canonical record (or a compatible PLAN.md block for stale tickets) before starting.`);
    }
    // readPlanState normalizes the canonical plan field to an array before this gate runs.
    const startupChecklist = planState.startup_checklist.map((value) => String(value || "").trim().toLowerCase());
    if (!startupChecklist.includes("completed")) {
      throw new GovernanceError(`Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`);
    }
    const traceabilityGate = (planState.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
    if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
      throw new GovernanceError(`Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`);
    }
    if (ticketRequiresBaseline(row) && !baselineReproductionSatisfied(planState.baseline_reproduction)) {
      throw new GovernanceError(baselineReproductionMessage(ticketId));
    }
    const gateIssues = startGateRegistry.run("start", { ticketId, row, planState });
    if (gateIssues.length > 0) {
      throw new GovernanceError(formatGovernanceBlockers(ticketId, gateIssues, "Start-plan blockers for"));
    }
  }

  return {
    assertStartPlanReady,
    collectStartReadinessAdvisories,
    collectStartReadinessBlockers,
    collectSubmitReadinessBlockers,
    collectTicketDeclaredFiles,
    normalizeDeclaredFilePath,
    parseBoardDeclaredFiles,
    parseDeclaredFilesValue,
    parsePromptDeclaredFiles,
    submitRequiresReviewPlanCheck,
  };
}

module.exports = {
  createReadinessGate,
};
