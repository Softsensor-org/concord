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
    buildPromptWaiverCommand,
    buildStartPlanBootstrapCommand,
    collectReviewPlanReadinessIssues,
    defaultTicketPromptRelPath,
    describeTicketMutationOwnershipIssue,
    evaluateReadiness,
    formatDependencyCycleList,
    formatGovernanceBlockers,
    formatTransitiveBlockerDetails,
    fs,
    hasPromptWaiver,
    path,
    readPlanState,
    rowsById,
    startGateRegistry,
    state,
    ticketPromptRelPathExists,
    ticketRequiresBaseline,
    ticketRequiresTraceability,
    toArray,
  } = deps;

  function collectStartReadinessBlockers(ticketId, row, board) {
    if (row.Status !== STATUS.TODO && row.Status !== STATUS.DEFERRED) {
      return [];
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
    // COORD-023: a prompt that exists on disk (coord/prompts/tickets/<ID>.md)
    // counts as coverage here too — gov start will auto-register it — so this
    // read-only preflight does not report a false blocker that start would then
    // sail through. Only a truly missing prompt (no index, no waiver, no file)
    // is a blocker, and register-prompt is offered alongside the waiver path.
    if (
      !board.prompt_index?.[ticketId] &&
      !hasPromptWaiver(board, ticketId) &&
      !ticketPromptRelPathExists(defaultTicketPromptRelPath(ticketId))
    ) {
      blockers.push({
        code: "prompt_coverage",
        message: `Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`,
        next_steps: [
          `coord/scripts/gov register-prompt ${ticketId}  # if you create coord/prompts/tickets/${ticketId}.md`,
          buildPromptWaiverCommand(ticketId),
        ],
      });
    }

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
      const startupChecklist = (planState.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
      if (!startupChecklist.includes("completed")) {
        blockers.push({
          code: "startup_checklist",
          message: `Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`,
          next_steps: [`coord/scripts/gov update-plan ${ticketId} --startup completed`],
        });
      }

      const traceabilityGate = (planState.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
      if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
        blockers.push({
          code: "traceability_gate",
          message: `Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`,
          next_steps: [`coord/scripts/gov update-plan ${ticketId} --traceability verified`],
        });
      }

      if (ticketRequiresBaseline(row)) {
        const baselineItems = planState.baseline_reproduction || [];
        const hasCommand = baselineItems.some((value) => /^Command:/i.test(value));
        const hasOutcome = baselineItems.some((value) => /^Outcome:/i.test(value));
        if (!hasCommand || !hasOutcome) {
          blockers.push({
            code: "baseline_reproduction",
            message: `Plan state for ${ticketId} must record baseline reproduction Command and Outcome before start-ticket.`,
            next_steps: [
              `coord/scripts/gov update-plan ${ticketId} --baseline "Command: <repro command>" --baseline "Outcome: <observed result>"`,
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
      code: "repo_x_declared_files_missing",
      message:
        `Ticket ${ticketId} has no declared file surface, so plan-waves must schedule it alone as a global coord-state risk.`,
      next_steps: [
        `Add a \`## Likely Files\` section to coord/prompts/tickets/${ticketId}.md, or set the board \`Declared Files\` field with repo-relative paths.`,
        "Keep global coordination state paths (coord/.runtime, coord/board, coord/prompts, coord/rendered, coord/locks) out of safe parallel waves unless the ticket truly must serialize.",
      ],
    }];
  }

  function submitRequiresReviewPlanCheck(board, row, ticketId, options = {}) {
    if (!row || row.Status !== STATUS.DOING) {
      return false;
    }
    if (toArray(options.pr).length > 0) {
      return false;
    }
    const existingRefs = board?.pr_index?.[ticketId] || [];
    if (existingRefs.length > 0) {
      return false;
    }
    return true;
  }

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
    if (submitRequiresReviewPlanCheck(board, row, ticketId, options)) {
      blockers.push(...collectReviewPlanReadinessIssues(ticketId, row));
    }
    return blockers;
  }

  function assertStartPlanReady(ticketId, row) {
    const planState = readPlanState(ticketId);
    if (!planState) {
      throw new GovernanceError(`Plan state missing for ${ticketId}. Create the canonical record (or a compatible PLAN.md block for stale tickets) before starting.`);
    }
    const startupChecklist = (planState.startup_checklist || []).map((value) => String(value || "").trim().toLowerCase());
    if (!startupChecklist.includes("completed")) {
      throw new GovernanceError(`Plan state for ${ticketId} must record "- Startup checklist:" with "completed" before start-ticket.`);
    }
    const traceabilityGate = (planState.traceability_gate || []).map((value) => String(value || "").trim().toLowerCase());
    if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {
      throw new GovernanceError(`Plan state for ${ticketId} must record "- Traceability gate:" with verified, closing-gap, or exempt before start-ticket.`);
    }
    const baselineItems = planState.baseline_reproduction || [];
    if (ticketRequiresBaseline(row)) {
      const hasCommand = baselineItems.some((value) => /^Command:/i.test(value));
      const hasOutcome = baselineItems.some((value) => /^Outcome:/i.test(value));
      if (!hasCommand || !hasOutcome) {
        throw new GovernanceError(`Plan state for ${ticketId} must record baseline reproduction Command and Outcome before start-ticket.`);
      }
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
