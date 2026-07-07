#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { gitTry } = require("../scripts/git-ops.js");
const { createCoordPaths } = require("../paths.js");
const {
  STATUS,
  legalStatusSet,
  FINDING_STATUS,
  ORDERED_FINDING_STATUSES,
} = require("../scripts/governance-constants.js");

const BOARD_DIR = __dirname;
const COORD_DIR = path.dirname(BOARD_DIR);
const ROOT_DIR = path.dirname(COORD_DIR);
// COORD-010: board.js owns the canonical coord board's derived artifacts.
// It is loaded as a module by governance.js during the governance test
// suite. The config matrix runs that suite under `COORD_PROJECT_CONFIG`
// (a synthetic non-default registry) to exercise GOVERNANCE-engine
// config-sensitivity — but board.js's own repo registry must stay bound to
// THIS coord checkout's real `project.config.js`, or `board.js validate`
// would re-interpret the real 2-repo coord board under the fake 7-repo
// registry. The board validator is therefore pinned to the real config:
// `forceProjectConfig` bypasses the `COORD_PROJECT_CONFIG` override.
const PATHS = createCoordPaths({
  coordDir: COORD_DIR,
  rootDir: ROOT_DIR,
  forceProjectConfig: true,
});
const TASKS_JSON_PATH = PATHS.boardPath;
const TASKS_SCHEMA_PATH = PATHS.tasksSchemaPath;
const PLAN_RECORD_SCHEMA_PATH = PATHS.planRecordSchemaPath;
let PLAN_RECORDS_DIR = PATHS.planRecordsDir;
let LEGACY_PLAN_RECORDS_DIR = PATHS.legacyPlanRecordsDir;
const RENDERED_TASKS_MD_PATH = PATHS.renderedTasksMdPath;
const RENDERED_PROMPT_INDEX_MD_PATH = PATHS.renderedPromptIndexMdPath;
const TASKS_MD_PATH = PATHS.tasksMdPath;
const PROMPT_INDEX_MD_PATH = PATHS.promptIndexMdPath;
const PLAN_PATH = PATHS.planPath;
const LOCKS_DIR = PATHS.locksDir;
const LEGACY_LOCKS_DIR = PATHS.legacyLocksDir;
const GOVERNANCE_EVENT_LOG_PATH = PATHS.governanceEventLogPath;
const REPO_ROOTS = PATHS.repoRoots;
const STALE_LOCK_MS = 24 * 60 * 60 * 1000;

// COORD-010: a "repo-backed" ticket targets a real product repo in the
// project registry (any code in REPO_ROOTS); code "X" is reserved for
// cross-repo / coord-only work and has no repo root. Lifecycle-gate logic
// used to hardcode `B`/`F` — the coord-template default registry — which
// silently skipped repos C..H under a non-default 7-repo registry. Deriving
// the set from REPO_ROOTS keeps the board validator registry-agnostic.
function isRepoBackedCode(repoCode) {
  return Boolean(repoCode && repoCode !== "X" && REPO_ROOTS[repoCode]);
}

// COORD-074: canonical ordered status enum now sourced from the shared
// governance-constants module (one source of truth across board.js/cli.js/
// lifecycle.js). Values are byte-identical to the prior inline list.
const LEGAL_STATUSES = legalStatusSet();

class BoardValidationError extends Error {}

function main() {
  const command = process.argv[2] || "sync";

  if (!["validate", "render", "sync"].includes(command)) {
    fail(`Unknown command "${command}". Use validate, render, or sync.`);
  }

  if (command === "validate") {
    const state = validateBoardState();
    printSummary(state, false);
    return;
  }

  const state = command === "render"
    ? renderBoardArtifacts()
    : syncBoardArtifacts();
  printSummary(state, true);
}

function validateBoardState(options = {}) {
  const board = readJson(TASKS_JSON_PATH);
  const schema = readJson(TASKS_SCHEMA_PATH);
  const planSchema = readJson(PLAN_RECORD_SCHEMA_PATH);
  return validateBoard(board, schema, planSchema, options);
}

function collectBoardRenderState(board, planSchema, options = {}) {
  const errors = [];
  const tickets = new Map();
  const doingOwners = new Set();
  let tableRowCount = 0;

  if (!board || typeof board !== "object" || Array.isArray(board)) {
    fail("coord/board/tasks.json must contain a JSON object.");
  }
  if (!Array.isArray(board.sections)) {
    fail("coord/board/tasks.json must define sections as an array.");
  }

  for (const [sectionIndex, section] of board.sections.entries()) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      errors.push(`sections[${sectionIndex}] must be an object.`);
      continue;
    }
    if (section.kind !== "table") {
      continue;
    }
    if (!Array.isArray(section.rows)) {
      errors.push(`sections[${sectionIndex}] table rows must be an array.`);
      continue;
    }
    for (const [rowIndex, row] of section.rows.entries()) {
      tableRowCount += 1;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        errors.push(`sections[${sectionIndex}].rows[${rowIndex}] must be an object.`);
        continue;
      }
      const ticketId = typeof row.ID === "string" ? row.ID.trim() : "";
      if (!ticketId) {
        errors.push(`sections[${sectionIndex}].rows[${rowIndex}] is missing ID.`);
        continue;
      }
      if (tickets.has(ticketId)) {
        errors.push(`Duplicate ticket ID "${ticketId}" in sections.`);
        continue;
      }
      tickets.set(ticketId, { row, section });
      if (typeof row.Status === "string" && row.Status.startsWith("doing")) {
        const owner = typeof row.Owner === "string" ? row.Owner.trim() : "";
        doingOwners.add(owner || ticketId);
      }
    }
  }

  const planRecordOptions = { ...options };
  if (
    planRecordOptions.scopePlanRecordsToRenderedTickets === true &&
    planRecordOptions.planRecordScope === undefined
  ) {
    planRecordOptions.planRecordScope = collectPlanMarkdownTicketIds(board);
  }
  const planRecords = readPlanRecords(planSchema, tickets, errors, planRecordOptions);
  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  return {
    board,
    planRecords,
    ticketCount: tickets.size,
    tableRowCount,
    doingCount: doingOwners.size,
  };
}

// COORD-290: resolve the rendered/PLAN/compat OUTPUT paths from the live
// __testing.paths override registry (governance-context state) at call time,
// rather than the module-level constants pinned to THIS checkout. The board
// validator's READ path stays pinned (forceProjectConfig) — only the WRITE
// targets follow the override, so a test that redirects BOARD_PATH / RENDERED_DIR
// to a sandbox no longer re-renders the LIVE coord/rendered + coord/PLAN.md tree
// (an out-of-band mutation that trips the COORD-220 seal). In production the
// registry holds the defaults, so the resolved paths are byte-identical.
function resolveRenderOutputPaths() {
  let reg = null;
  try {
    reg = require("../scripts/governance-context.js").state;
  } catch {
    reg = null;
  }
  const fallback = {
    renderedTasks: RENDERED_TASKS_MD_PATH,
    renderedPromptIndex: RENDERED_PROMPT_INDEX_MD_PATH,
    tasksMd: TASKS_MD_PATH,
    promptIndexMd: PROMPT_INDEX_MD_PATH,
    planPath: PLAN_PATH,
  };
  if (!reg) return fallback;
  let renderedDir;
  let coordRoot;
  if (reg.RENDERED_DIR && reg.RENDERED_DIR !== PATHS.renderedDir) {
    // Explicit RENDERED_DIR override wins.
    renderedDir = reg.RENDERED_DIR;
    coordRoot = path.dirname(renderedDir);
  } else if (reg.BOARD_PATH && reg.BOARD_PATH !== PATHS.boardPath) {
    // Co-locate rendered artifacts with the (redirected) board: a BOARD_PATH
    // sandbox auto-sandboxes the renders. Board lives at <coordRoot>/board/...
    coordRoot = path.dirname(path.dirname(reg.BOARD_PATH));
    renderedDir = path.join(coordRoot, "rendered");
  } else {
    return fallback;
  }
  const planPath =
    reg.PLAN_PATH && reg.PLAN_PATH !== PATHS.planPath
      ? reg.PLAN_PATH
      : path.join(coordRoot, "PLAN.md");
  return {
    renderedTasks: path.join(renderedDir, "TASKS.md"),
    renderedPromptIndex: path.join(renderedDir, "PROMPT_INDEX.md"),
    tasksMd: path.join(coordRoot, "TASKS.md"),
    promptIndexMd: path.join(coordRoot, "PROMPT_INDEX.md"),
    planPath,
  };
}

function writeRenderedArtifacts(state) {
  const tasksMarkdown = renderTasksMarkdown(state.board);
  const promptIndexMarkdown = renderPromptIndexMarkdown(state.board);
  const planMarkdown = renderPlanMarkdown(state.board, state.planRecords);
  const out = resolveRenderOutputPaths();
  writeFile(out.renderedTasks, tasksMarkdown);
  writeFile(out.renderedPromptIndex, promptIndexMarkdown);
  writeCompatibilityCopy(out.renderedTasks, out.tasksMd, tasksMarkdown);
  writeCompatibilityCopy(out.renderedPromptIndex, out.promptIndexMd, promptIndexMarkdown);
  writeFile(out.planPath, planMarkdown);
  return state;
}

function renderBoardArtifacts(options = {}) {
  const board = readJson(TASKS_JSON_PATH);
  const planSchema = readJson(PLAN_RECORD_SCHEMA_PATH);
  const state = collectBoardRenderState(board, planSchema, options);
  return writeRenderedArtifacts(state);
}

function syncBoardArtifacts(options = {}) {
  const state = validateBoardState(options);
  return writeRenderedArtifacts(state);
}

function validateBoard(board, schema, planSchema, options = {}) {
  const errors = [];

  if (!board || typeof board !== "object" || Array.isArray(board)) {
    fail("coord/board/tasks.json must contain a JSON object.");
  }

  validateSchema(schema, board, "tasks.json", errors);

  if (!Array.isArray(board.sections) || board.sections.length === 0) {
    errors.push("sections must be a non-empty array.");
  }

  if (!board.metadata || typeof board.metadata !== "object") {
    errors.push("metadata must be an object.");
  }

  if (!board.prompt_index || typeof board.prompt_index !== "object" || Array.isArray(board.prompt_index)) {
    errors.push("prompt_index must be an object.");
  }

  if (!board.pr_index || typeof board.pr_index !== "object" || Array.isArray(board.pr_index)) {
    errors.push("pr_index must be an object.");
  }

  if (!board.landing_index || typeof board.landing_index !== "object" || Array.isArray(board.landing_index)) {
    errors.push("landing_index must be an object.");
  }

  if (!board.review_findings || typeof board.review_findings !== "object" || Array.isArray(board.review_findings)) {
    errors.push("review_findings must be an object.");
  }
  if (board.waiver_index !== undefined && (!board.waiver_index || typeof board.waiver_index !== "object" || Array.isArray(board.waiver_index))) {
    errors.push("waiver_index must be an object when present.");
  }
  if (!board.followup_exceptions || typeof board.followup_exceptions !== "object" || Array.isArray(board.followup_exceptions)) {
    errors.push("followup_exceptions must be an object.");
  }

  const tickets = new Map();
  const doingOwners = new Map();
  let tableRows = 0;

  for (const [index, section] of (board.sections || []).entries()) {
    if (!section || typeof section !== "object") {
      errors.push(`sections[${index}] must be an object.`);
      continue;
    }

    if (!["markdown", "table"].includes(section.kind)) {
      errors.push(`sections[${index}] has invalid kind "${section.kind}".`);
      continue;
    }

    if (![2, 3].includes(section.level)) {
      errors.push(`sections[${index}] has invalid level "${section.level}".`);
    }

    if (typeof section.heading !== "string" || !section.heading.trim()) {
      errors.push(`sections[${index}] must have a non-empty heading.`);
    }

    if (typeof section.separator_before !== "boolean") {
      errors.push(`sections[${index}] must define separator_before as boolean.`);
    }

    if (section.kind === "markdown") {
      if (!Array.isArray(section.body)) {
        errors.push(`sections[${index}] markdown body must be an array.`);
      }
      continue;
    }

    if (!Array.isArray(section.columns) || section.columns.length === 0) {
      errors.push(`sections[${index}] table must define columns.`);
      continue;
    }

    if (!Array.isArray(section.rows)) {
      errors.push(`sections[${index}] table rows must be an array.`);
      continue;
    }

    for (const [rowIndex, row] of section.rows.entries()) {
      tableRows += 1;

      if (!row || typeof row !== "object" || Array.isArray(row)) {
        errors.push(`sections[${index}].rows[${rowIndex}] must be an object.`);
        continue;
      }

      const ticketId = row.ID;
      if (typeof ticketId !== "string" || !ticketId.trim()) {
        errors.push(`sections[${index}].rows[${rowIndex}] is missing ID.`);
        continue;
      }

      for (const column of section.columns) {
        if (!(column in row)) {
          errors.push(`Ticket ${ticketId} is missing column "${column}".`);
        }
      }

      if (tickets.has(ticketId)) {
        errors.push(`Duplicate ticket ID "${ticketId}" in sections.`);
      } else {
        tickets.set(ticketId, { row, section });
      }

      const status = row.Status;
      if (typeof status !== "string" || !isLegalStatus(status)) {
        errors.push(`Ticket ${ticketId} has invalid status "${status}".`);
      }

      const owner = row.Owner;
      if (status && status.startsWith("doing")) {
        if (typeof owner !== "string" || !owner.trim() || owner === "unassigned") {
          errors.push(`Ticket ${ticketId} is ${status} but has no active owner.`);
        } else {
          const prior = doingOwners.get(owner);
          if (prior) {
            if (!canOwnerHoldConcurrentDoing(board, prior, ticketId)) {
              errors.push(`Owner "${owner}" has multiple doing tickets: ${prior}, ${ticketId}.`);
            }
          } else {
            doingOwners.set(owner, ticketId);
          }
        }
      }
    }
  }

  validateIndex(board.prompt_index, tickets, "prompt_index", errors);
  validateIndex(board.pr_index, tickets, "pr_index", errors);
  validateIndex(board.landing_index, tickets, "landing_index", errors);
  validateLandingIndex(board.landing_index, tickets, errors);
  validateFindings(board.review_findings, tickets, errors);
  validateWaiverIndex(board.waiver_index, tickets, errors);
  validateFollowupExceptions(board.followup_exceptions, tickets, errors);
  validateJournalBackedBoardProgression(tickets, errors, options);
  validateLocks(tickets, errors, options);
  validatePromptFiles(board.prompt_index, errors);
  const planRecords = readPlanRecords(planSchema, tickets, errors, options);
  validateLifecycleGates(tickets, board.metadata, board.pr_index, board.landing_index, board.review_findings, planRecords, errors, options);

  if (errors.length > 0) {
    fail(errors.join("\n"));
  }

  return {
    board,
    planRecords,
    ticketCount: tickets.size,
    tableRowCount: tableRows,
    doingCount: doingOwners.size,
  };
}

function isTicketScopedValidation(options = {}) {
  return options.ticketScopedValidation === true && typeof options.currentTicketId === "string" && options.currentTicketId.trim() !== "";
}

function isTicketInScope(ticketId, options = {}) {
  if (!isTicketScopedValidation(options)) {
    return true;
  }
  return String(ticketId || "").trim() === String(options.currentTicketId || "").trim();
}

function collectPlanMarkdownTicketIds(board) {
  const renderStatuses = new Set(
    Array.isArray(board?.metadata?.plan_markdown_render_statuses) && board.metadata.plan_markdown_render_statuses.length > 0
      ? board.metadata.plan_markdown_render_statuses
      : [STATUS.DOING, STATUS.REVIEW]
  );
  const ticketIds = new Set();
  for (const section of board?.sections || []) {
    for (const row of section?.rows || []) {
      const ticketId = typeof row?.ID === "string" ? row.ID.trim() : "";
      if (!ticketId || !renderStatuses.has(row?.Status)) {
        continue;
      }
      ticketIds.add(ticketId);
    }
  }
  return ticketIds;
}

function validateJournalBackedBoardProgression(tickets, errors, options = {}) {
  const journalState = readLatestLifecycleStatesFromGovernanceJournal(options);
  for (const [ticketId, journalEntry] of journalState.entries()) {
    if (!isTicketInScope(ticketId, options)) {
      continue;
    }
    const boardEntry = tickets.get(ticketId);
    if (!boardEntry) {
      errors.push(
        `Governance journal shows ticket ${ticketId} reached status "${journalEntry.status}" at ${journalEntry.ts}, but coord/board/tasks.json does not contain that ticket. This looks like board rollback drift.`
      );
      continue;
    }

    const boardStatus = String(boardEntry.row?.Status || "").trim();
    if (!isLegalStatus(boardStatus)) {
      continue;
    }

    const boardRank = boardStatusRank(boardStatus);
    const journalRank = boardStatusRank(journalEntry.status);
    if (shouldEnforceJournalRegression(journalEntry) && boardRank < journalRank) {
      errors.push(
        `Ticket ${ticketId} regressed in coord/board/tasks.json: board status "${boardStatus}" is behind journal status "${journalEntry.status}" recorded at ${journalEntry.ts}.`
      );
    }
  }
}

function readLatestLifecycleStatesFromGovernanceJournal(options = {}) {
  const journalPath = options.governanceEventLogPath || GOVERNANCE_EVENT_LOG_PATH;
  if (!journalPath || !fs.existsSync(journalPath)) {
    return new Map();
  }

  const latestByTicket = new Map();
  const contents = fs.readFileSync(journalPath, "utf8");
  for (const rawLine of String(contents || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.result !== "succeeded") {
      continue;
    }
    if (shouldIgnoreJournalLifecycleEvent(event)) {
      continue;
    }

    const ticketId = String(event.ticket || "").trim();
    const afterStatus = String(event.after_status || "").trim();
    const timestamp = String(event.ts || "").trim();
    if (!ticketId || !afterStatus || !isLegalStatus(afterStatus) || !Number.isFinite(Date.parse(timestamp))) {
      continue;
    }

    const prior = latestByTicket.get(ticketId);
    if (!prior || compareEventTimestamps(timestamp, prior.ts) >= 0) {
      latestByTicket.set(ticketId, {
        status: afterStatus,
        ts: timestamp,
        command: String(event.command || "").trim(),
      });
    }
  }
  return latestByTicket;
}

function shouldIgnoreJournalLifecycleEvent(event) {
  if (!event || typeof event !== "object") {
    return false;
  }
  if (event.command !== "manual-reconcile") {
    return false;
  }
  const reason = String(event.details?.reason || "").toLowerCase();
  return reason.includes("overwritten") || reason.includes("rollback") || reason.includes("drift");
}

function compareEventTimestamps(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return String(left).localeCompare(String(right));
  }
  return leftMs - rightMs;
}

function boardStatusRank(status) {
  if (status === STATUS.DONE || status === STATUS.SUPERSEDED) {
    return 3;
  }
  if (status === STATUS.REVIEW) {
    return 2;
  }
  if (status === STATUS.DOING || /^doing \(blocked: .+\)$/.test(status)) {
    return 1;
  }
  return 0;
}

function isTerminalBoardStatus(status) {
  return status === STATUS.DONE || status === STATUS.SUPERSEDED;
}

function shouldEnforceJournalRegression(entry) {
  if (!entry || !isTerminalBoardStatus(entry.status)) {
    return false;
  }
  return entry.command === "land";
}

function validateIndex(index, tickets, label, errors) {
  for (const key of Object.keys(index || {})) {
    if (!tickets.has(key)) {
      errors.push(`${label} references unknown ticket "${key}".`);
    }
  }
}

function validateFindings(reviewFindings, tickets, errors) {
  for (const [ticketId, findings] of Object.entries(reviewFindings || {})) {
    if (!tickets.has(ticketId)) {
      errors.push(`review_findings references unknown ticket "${ticketId}".`);
      continue;
    }

    if (!Array.isArray(findings)) {
      errors.push(`review_findings["${ticketId}"] must be an array.`);
      continue;
    }

    for (const [index, finding] of findings.entries()) {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`review_findings["${ticketId}"][${index}] must be an object.`);
        continue;
      }

      if (!finding.id || typeof finding.id !== "string") {
        errors.push(`review_findings["${ticketId}"][${index}] is missing id.`);
      }
      if (!["HIGH", "MED", "LOW"].includes(finding.severity)) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} has invalid severity.`);
      }
      if (typeof finding.summary !== "string" || !finding.summary.trim()) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} must have a summary.`);
      }
      if (!ORDERED_FINDING_STATUSES.includes(finding.status)) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} has invalid status.`);
      }
      if (!Number.isInteger(finding.round) || finding.round < 1) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} must have round >= 1.`);
      }
      if (finding.status === FINDING_STATUS.DEFERRED && !finding.deferred_to) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} is deferred but missing deferred_to.`);
      }
      if (finding.deferred_to && !tickets.has(finding.deferred_to)) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} references unknown deferred_to ticket "${finding.deferred_to}".`);
      }
      if (finding.status === "consolidated" && !finding.consolidated_into) {
        errors.push(`Finding ${finding.id || `${ticketId}[${index}]`} is consolidated but missing consolidated_into.`);
      }
    }
  }
}

function validateWaiverIndex(waiverIndex, tickets, errors) {
  for (const [ticketId, waiver] of Object.entries(waiverIndex || {})) {
    if (!tickets.has(ticketId)) {
      errors.push(`waiver_index references unknown ticket "${ticketId}".`);
      continue;
    }
    if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) {
      errors.push(`waiver_index["${ticketId}"] must be an object.`);
      continue;
    }
    if (waiver.code !== "prompt_coverage") {
      errors.push(`waiver_index["${ticketId}"] has invalid code "${waiver.code}".`);
    }
    if (typeof waiver.reason !== "string" || !waiver.reason.trim()) {
      errors.push(`waiver_index["${ticketId}"] must include reason.`);
    }
    if (!Number.isFinite(Date.parse(waiver.recorded_at || ""))) {
      errors.push(`waiver_index["${ticketId}"] must use a valid recorded_at timestamp.`);
    }
    if (typeof waiver.recorded_by !== "string" || !waiver.recorded_by.trim()) {
      errors.push(`waiver_index["${ticketId}"] must include recorded_by.`);
    }
  }
}

function validateFollowupExceptions(followupExceptions, tickets, errors) {
  for (const [ticketId, exception] of Object.entries(followupExceptions || {})) {
    if (!tickets.has(ticketId)) {
      errors.push(`followup_exceptions references unknown ticket "${ticketId}".`);
      continue;
    }
    if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
      errors.push(`followup_exceptions["${ticketId}"] must be an object.`);
      continue;
    }
    if (!["closeout-blocker", "related-followup"].includes(exception.type)) {
      errors.push(`followup_exceptions["${ticketId}"] has invalid type "${exception.type}".`);
    }
    if (!exception.parent || typeof exception.parent !== "string") {
      errors.push(`followup_exceptions["${ticketId}"] must include parent.`);
      continue;
    }
    if (!tickets.has(exception.parent)) {
      errors.push(`followup_exceptions["${ticketId}"] references unknown parent "${exception.parent}".`);
    }
  }
}

function canOwnerHoldConcurrentDoing(board, leftTicketId, rightTicketId) {
  if (!board || !leftTicketId || !rightTicketId || leftTicketId === rightTicketId) {
    return false;
  }
  const exceptions = board.followup_exceptions || {};
  const left = exceptions[leftTicketId];
  const right = exceptions[rightTicketId];
  if (left?.type === "closeout-blocker" && left.parent === rightTicketId) {
    return true;
  }
  if (right?.type === "closeout-blocker" && right.parent === leftTicketId) {
    return true;
  }
  return false;
}

function validateLandingIndex(landingIndex, tickets, errors) {
  for (const [ticketId, entry] of Object.entries(landingIndex || {})) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`landing_index["${ticketId}"] must be an object.`);
      continue;
    }
    if (!Number.isFinite(Date.parse(entry.recorded_at))) {
      errors.push(`landing_index["${ticketId}"] must use a valid recorded_at timestamp.`);
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      errors.push(`landing_index["${ticketId}"] must include at least one evidence entry.`);
      continue;
    }
    if (entry.evidence.some((value) => typeof value !== "string" || !value.trim())) {
      errors.push(`landing_index["${ticketId}"] evidence entries must be non-empty strings.`);
    }
    if (entry.commit_sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(entry.commit_sha))) {
      errors.push(`landing_index["${ticketId}"].commit_sha must be a 7-40 character hex git SHA when present.`);
    }
    if (entry.source_commit_sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(entry.source_commit_sha))) {
      errors.push(`landing_index["${ticketId}"].source_commit_sha must be a 7-40 character hex git SHA when present.`);
    }
    if (entry.fulfilled_by_commit_sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(entry.fulfilled_by_commit_sha))) {
      errors.push(`landing_index["${ticketId}"].fulfilled_by_commit_sha must be a 7-40 character hex git SHA when present.`);
    }
    if (entry.fulfilled_by_ticket !== undefined && !/^[A-Z]+-\d+$/.test(String(entry.fulfilled_by_ticket))) {
      errors.push(`landing_index["${ticketId}"].fulfilled_by_ticket must be a valid ticket id when present.`);
    } else if (entry.fulfilled_by_ticket !== undefined && tickets && !tickets.has(String(entry.fulfilled_by_ticket))) {
      errors.push(`landing_index["${ticketId}"].fulfilled_by_ticket references unknown ticket "${entry.fulfilled_by_ticket}".`);
    }
    if (
      entry.provenance_status !== undefined &&
      !["explicit", "legacy", "fulfilled_by", "unknown"].includes(String(entry.provenance_status))
    ) {
      errors.push(`landing_index["${ticketId}"].provenance_status has invalid value "${entry.provenance_status}".`);
    }
  }
}

function shouldIgnoreActiveLockValidationError(ticketId, options = {}) {
  if (options.ignoreActiveTicketLockErrors !== true) {
    return false;
  }
  const currentTicketId = String(options.currentTicketId || options.ticketId || "").trim();
  if (!currentTicketId) {
    return true;
  }
  return ticketId !== currentTicketId;
}

function validateLocks(tickets, errors, options = {}) {
  const skipCanonicalLockLocationForTicket =
    typeof options.skipCanonicalLockLocationForTicket === "string" &&
    options.skipCanonicalLockLocationForTicket.trim().length > 0
      ? options.skipCanonicalLockLocationForTicket.trim()
      : null;
  const activeStatuses = new Set();
  for (const [ticketId, { row }] of tickets.entries()) {
    if (!isTicketInScope(ticketId, options)) {
      continue;
    }
    if (typeof row.Status === "string" && row.Status.startsWith("doing")) {
      activeStatuses.add(ticketId);
    }
  }

  const observedLocks = new Set();
  for (const lockPath of getLockFiles()) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch (error) {
      errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} is not valid JSON.`);
      continue;
    }

    if (typeof lock.ticket === "string" && !isTicketInScope(lock.ticket, options)) {
      continue;
    }

    const requiredFields = [
      "owner",
      "ticket",
      "status",
      "repo",
      "branch",
      "head",
      "worktree",
      "started_at_utc",
      "heartbeat_utc",
    ];
    for (const field of requiredFields) {
      if (typeof lock[field] !== "string" || !lock[field].trim()) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} is missing "${field}".`);
      }
    }

    if (lock.status !== STATUS.DOING) {
      errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} must use status "doing".`);
    }

    if (typeof lock.ticket === "string" && !tickets.has(lock.ticket)) {
      errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} references unknown ticket "${lock.ticket}".`);
    }

    const ignoreActiveLockErrors = shouldIgnoreActiveLockValidationError(lock.ticket, options);

    if (typeof lock.heartbeat_utc === "string") {
      const heartbeatAt = Date.parse(lock.heartbeat_utc);
      if (!Number.isFinite(heartbeatAt)) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} has invalid heartbeat_utc timestamp.`);
      } else if (!ignoreActiveLockErrors && Date.now() - heartbeatAt > STALE_LOCK_MS) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} is stale; heartbeat_utc is older than 24h.`);
      }
    }

    if (typeof lock.started_at_utc === "string" && !Number.isFinite(Date.parse(lock.started_at_utc))) {
      errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} has invalid started_at_utc timestamp.`);
    }

    if (typeof lock.worktree === "string") {
      if (!path.isAbsolute(lock.worktree)) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} must use an absolute worktree path.`);
      } else if (!ignoreActiveLockErrors && !fs.existsSync(lock.worktree)) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} points to missing worktree ${lock.worktree}.`);
      }
    }

    if (typeof lock.ticket === "string" && tickets.has(lock.ticket)) {
      const ticketRow = tickets.get(lock.ticket).row;
      if (ticketRow.Owner !== lock.owner) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} owner "${lock.owner}" does not match board owner "${ticketRow.Owner}" for ${lock.ticket}.`);
      }
      const expectedRepo = expectedLockRepoForCode(ticketRow.Repo);
      if (lock.repo !== expectedRepo) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} repo "${lock.repo}" does not match ticket repo "${expectedRepo}" for ${lock.ticket}.`);
      }
      const expectedWorktree = expectedWorktreePath(ticketRow.Repo, lock.owner, lock.ticket);
      const skipCanonicalLocationChecks =
        skipCanonicalLockLocationForTicket !== null &&
        skipCanonicalLockLocationForTicket === lock.ticket;
      if (
        !ignoreActiveLockErrors &&
        !skipCanonicalLocationChecks &&
        typeof lock.worktree === "string" &&
        lock.worktree !== expectedWorktree
      ) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} must use canonical worktree path ${expectedWorktree}.`);
      }
      const expectedBranchPrefix = `agent/${String(lock.owner).toLowerCase()}-${String(lock.ticket).toLowerCase()}-`;
      if (
        !ignoreActiveLockErrors &&
        !skipCanonicalLocationChecks &&
        typeof lock.branch === "string" &&
        !lock.branch.startsWith(expectedBranchPrefix)
      ) {
        errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} must use canonical branch prefix ${expectedBranchPrefix}...`);
      }
      if (typeof lock.head === "string") {
        if (ticketRow.Repo === "B" || ticketRow.Repo === "F") {
          const currentHead = ignoreActiveLockErrors ? null : resolveGitHead(lock.worktree);
          if (!ignoreActiveLockErrors && !currentHead) {
            errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} points to worktree without a readable git HEAD.`);
          } else if (!ignoreActiveLockErrors && currentHead !== lock.head) {
            errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} head "${lock.head}" does not match worktree HEAD "${currentHead}".`);
          }
        } else if (!ignoreActiveLockErrors && lock.head !== "coord-no-git-head") {
          errors.push(`Lock file ${path.relative(COORD_DIR, lockPath)} for coord tickets must use head "coord-no-git-head".`);
        }
      }
    }

    if (typeof lock.ticket === "string") {
      observedLocks.add(lock.ticket);
    }
  }

  for (const ticketId of activeStatuses) {
    if (!observedLocks.has(ticketId)) {
      errors.push(`Ticket ${ticketId} is doing but has no governed lock file in coord/.runtime/locks/ (or legacy coord/locks/ during migration).`);
    }
  }

  for (const ticketId of observedLocks) {
    if (!activeStatuses.has(ticketId)) {
      errors.push(`Lock exists for ticket ${ticketId}, but the board status is not doing.`);
    }
  }
}

function getLockFiles() {
  const filesByName = new Map();
  for (const dirPath of [LOCKS_DIR, LEGACY_LOCKS_DIR]) {
    if (!dirPath || !fs.existsSync(dirPath)) {
      continue;
    }
    for (const fileName of fs.readdirSync(dirPath).filter((entry) => entry.endsWith(".lock")).sort()) {
      if (!filesByName.has(fileName)) {
        filesByName.set(fileName, path.join(dirPath, fileName));
      }
    }
  }
  return [...filesByName.values()];
}

function expectedWorktreePath(repoCode, owner, ticketId) {
  if (repoCode === "X") {
    return path.join(COORD_DIR, ".worktrees", owner, ticketId);
  }
  return path.join(REPO_ROOTS[repoCode], ".worktrees", owner, ticketId);
}

function expectedLockRepoForCode(repoCode, paths = PATHS) {
  if (repoCode === "X") {
    return "coord";
  }
  const repoRegistry = paths.repoRegistry || {};
  const repoRoots = paths.repoRoots || {};
  if (repoRegistry[repoCode]) {
    return repoRegistry[repoCode];
  }
  return repoRoots[repoCode] ? path.basename(repoRoots[repoCode]) : repoCode;
}

function resolveGitHead(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return null;
  }
  const result = gitTry(worktreePath, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || "").trim();
}

function validatePromptFiles(promptIndex, errors) {
  for (const [ticketId, promptPath] of Object.entries(promptIndex || {})) {
    const absolutePath = path.join(ROOT_DIR, promptPath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`prompt_index for ${ticketId} points to missing file ${promptPath}.`);
    }
  }
}

function validateLifecycleGates(tickets, metadata, prIndex, landingIndex, reviewFindings, planRecords, errors, options = {}) {
  const prRefsByTicket = prIndex || {};
  const landingByTicket = landingIndex || {};
  const findingsByTicket = reviewFindings || {};
  // COORD-010: list worktrees for every repo-backed code that ACTUALLY has a
  // ticket on the board — not the hardcoded B/F pair (which silently skipped
  // repos C..H under a 7-repo registry) and not every configured repo (which
  // would error on a configured-but-not-checked-out repo whose root is
  // genuinely absent). Lifecycle gates only consult worktrees for repos that
  // own a ticket, so deriving the set from the ticket repos keeps the
  // validator both registry-agnostic and free of spurious "Repo root missing"
  // noise for repos no ticket touches.
  const ticketRepoCodes = new Set();
  for (const { row } of tickets.values()) {
    if (isRepoBackedCode(row.Repo)) {
      ticketRepoCodes.add(row.Repo);
    }
  }
  const worktreesByRepo = {};
  for (const repoCode of [...ticketRepoCodes].sort()) {
    worktreesByRepo[repoCode] = listGitWorktrees(repoCode, errors);
  }
  for (const [ticketId, { row }] of tickets.entries()) {
    if (!isTicketInScope(ticketId, options)) {
      continue;
    }
    const status = row.Status;
    const prRefs = prRefsByTicket[ticketId];
    const landing = landingByTicket[ticketId];
    const findings = findingsByTicket[ticketId] || [];
    const openFindings = findings.filter((finding) => finding.status === FINDING_STATUS.OPEN);

    if (status === STATUS.REVIEW) {
      if (requiresPrIndexGovernance(metadata, ticketId, row) && (!Array.isArray(prRefs) || prRefs.length === 0)) {
        errors.push(`Ticket ${ticketId} is review but has no pr_index evidence.`);
      }
      if (openFindings.length > 0) {
        errors.push(`Ticket ${ticketId} is review but still has open review findings.`);
      }
      const planRecord = planRecords.get(ticketId);
      if (!planRecord) {
        errors.push(`Ticket ${ticketId} is review but has no canonical plan record.`);
      } else {
        const requiredRound = inferRequiredReviewRound(findings);
        const planRound = integerOrDefault(planRecord.review_round, 0);
        if (planRound !== requiredRound) {
          errors.push(`Ticket ${ticketId} is review but canonical plan state records Review round ${planRound || "missing"} instead of ${requiredRound}.`);
        }
        const repoGates = Array.isArray(planRecord.repo_gates) ? planRecord.repo_gates : [];
        const featureProof = Array.isArray(planRecord.feature_proof) ? planRecord.feature_proof : [];
        const cycles = parseSelfReviewCyclesFromRecord(planRecord);
        if (isRepoBackedCode(row.Repo) && !repoGates.some((value) => value && !/todo|not-required/i.test(value))) {
          errors.push(`Ticket ${ticketId} is review but canonical plan state lacks executed repo gates.`);
        }
        if (
          requiresFeatureProofGovernance(metadata, ticketId, row) &&
          !featureProof.some((value) => value && !/^todo\b/i.test(String(value).trim()) && !/^not-required$/i.test(String(value).trim()))
        ) {
          errors.push(`Ticket ${ticketId} is review but canonical plan state lacks feature-proof entries.`);
        }
        if (cycles.length < 3) {
          errors.push(`Ticket ${ticketId} is review but canonical plan state has fewer than 3 self-review cycles.`);
        } else if (cycles[cycles.length - 1] !== "pass") {
          errors.push(`Ticket ${ticketId} is review but the most recent self-review cycle is not a pass.`);
        }
      }
    }

    if (status === STATUS.DONE && openFindings.length > 0) {
      errors.push(`Ticket ${ticketId} is done but still has open review findings.`);
    }
    if ((status === STATUS.TODO || status === STATUS.DEFERRED) && ticketHasHistoricalCloseoutEvidence(prRefs, landing, findings)) {
      errors.push(`Ticket ${ticketId} is ${status} but still has historical closeout evidence. Closed tickets must stay closed; create a follow-up instead of reopening via board edits.`);
    }
    if (status === STATUS.DONE && requiresPlanRecordGovernance(metadata, ticketId, row) && !planRecords.get(ticketId)) {
      errors.push(`Ticket ${ticketId} is done but has no canonical plan record.`);
    }
    if (status === STATUS.DONE && requiresLandingGovernance(metadata, ticketId, row)) {
      if (!landing) {
        errors.push(`Ticket ${ticketId} is done but has no landing_index evidence.`);
      }
      if (isRepoBackedCode(row.Repo) && ticketHasTrackedWorktree(worktreesByRepo[row.Repo] || [], ticketId)) {
        errors.push(`Ticket ${ticketId} is done but its canonical ticket worktree still exists.`);
      }
    }
  }
}

function requiresLandingGovernance(metadata, ticketId, row) {
  if (!row || (row.Repo !== "B" && row.Repo !== "F")) {
    return false;
  }
  const threshold = resolveGovernanceThreshold(metadata?.landing_index_required_from_ticket, row);
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

function requiresFeatureProofGovernance(metadata, ticketId, row) {
  if (!row || (row.Repo !== "B" && row.Repo !== "F")) {
    return false;
  }
  const threshold = resolveGovernanceThreshold(metadata?.feature_proof_required_from_ticket, row);
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

function requiresPrIndexGovernance(metadata, ticketId, row) {
  if (!row || (row.Repo !== "B" && row.Repo !== "F")) {
    return false;
  }
  const threshold =
    resolveGovernanceThreshold(metadata?.pr_index_required_from_ticket, row) ||
    resolveGovernanceThreshold(metadata?.landing_index_required_from_ticket, row) ||
    "IMP-120";
  return isTicketAtOrAfter(ticketId, threshold);
}

function requiresPlanRecordGovernance(metadata, ticketId, row) {
  if (!row || (row.Repo !== "B" && row.Repo !== "F" && row.Repo !== "X")) {
    return false;
  }
  const threshold = resolveGovernanceThreshold(metadata?.plan_records_required_from_ticket, row);
  if (!threshold) {
    return false;
  }
  return isTicketAtOrAfter(ticketId, threshold);
}

function resolveGovernanceThreshold(config, row) {
  if (!config) {
    return null;
  }
  if (typeof config === "string") {
    return config;
  }
  if (!row || typeof row.Repo !== "string" || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  return config[row.Repo] || config.default || null;
}

function ticketHasHistoricalCloseoutEvidence(prRefs, landing, findings) {
  if (Array.isArray(prRefs) && prRefs.length > 0) {
    return true;
  }
  if (Array.isArray(landing?.evidence) && landing.evidence.length > 0) {
    return true;
  }
  return Array.isArray(findings) && findings.length > 0;
}

function isTicketAtOrAfter(ticketId, thresholdTicketId) {
  const ticketParts = parseTicketParts(ticketId);
  const thresholdParts = parseTicketParts(thresholdTicketId);
  if (!ticketParts || !thresholdParts || ticketParts.prefix !== thresholdParts.prefix) {
    return false;
  }
  return ticketParts.number >= thresholdParts.number;
}

function parseTicketParts(ticketId) {
  const match = /^([A-Z]+)-(\d+)$/.exec(String(ticketId || ""));
  if (!match) {
    return null;
  }
  return {
    prefix: match[1],
    number: Number.parseInt(match[2], 10),
  };
}

function listGitWorktrees(repoCode, errors) {
  const repoRoot = REPO_ROOTS[repoCode];
  if (!repoRoot || !fs.existsSync(repoRoot)) {
    errors.push(`Repo root missing for ${repoCode}.`);
    return [];
  }
  const result = gitTry(repoRoot, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    errors.push(`Failed to list git worktrees for ${repoRoot}.`);
    return [];
  }
  const blocks = String(result.stdout || "").trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.map((block) => {
    const entry = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        entry.path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/")) {
        entry.branch = line.slice("branch refs/heads/".length).trim();
      }
    }
    return entry;
  });
}

function ticketHasTrackedWorktree(worktrees, ticketId) {
  return worktrees.some((entry) => inferTicketIdFromPath(entry.path) === ticketId);
}

function inferTicketIdFromPath(worktreePath) {
  const parts = String(worktreePath || "").split(path.sep).filter(Boolean);
  for (const part of parts.reverse()) {
    if (/^[A-Z]+-\d+$/.test(part)) {
      return part;
    }
  }
  return null;
}

function readPlanListField(block, fieldName) {
  const lines = String(block || "").split("\n");
  const header = `- ${fieldName}:`;
  const headerIndex = lines.findIndex((line) => line === header);
  if (headerIndex === -1) {
    return [];
  }
  const values = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^- [^:]+:$/.test(line)) {
      break;
    }
    const match = /^  - (.*)$/.exec(line);
    if (match) {
      values.push(match[1]);
    }
  }
  return values;
}

function readPlanScalarField(block, fieldName) {
  const values = readPlanListField(block, fieldName);
  return values.length > 0 ? values[0] : null;
}

function integerOrDefault(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function inferRequiredReviewRound(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return 1;
  }
  return Math.max(...findings.map((finding) => integerOrDefault(finding.round, 1)));
}

function normalizeRecordReviewVerdict(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("pass")) {
    return "pass";
  }
  return "fail";
}

function parseSelfReviewCyclesFromRecord(record) {
  return (record?.self_review_cycles || [])
    .map((cycle) => normalizeRecordReviewVerdict(cycle?.verdict));
}

function parseSelfReviewCycles(block) {
  return String(block || "")
    .split("\n")
    .map((line) => /^- Self-review cycle \d+\/\d+:.*(?:verdict=|verdict:\s*)(pass|fail\b.*)$/i.exec(line.trim()))
    .filter(Boolean)
    .map((match) => (String(match[1]).toLowerCase() === "pass" ? "pass" : "fail"));
}

function validateSchema(schema, value, location, errors) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}.`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${location} must be one of: ${schema.enum.join(", ")}.`);
    return;
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${location} must be ${schema.type}.`);
    return;
  }

  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${location} does not match pattern ${schema.pattern}.`);
  }

  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${location} must have length >= ${schema.minLength}.`);
  }

  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${location} must be >= ${schema.minimum}.`);
  }

  if (Array.isArray(schema.anyOf)) {
    const anyOfValid = schema.anyOf.some((candidate) => {
      const candidateErrors = [];
      validateSchema(candidate, value, location, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!anyOfValid) {
      errors.push(`${location} does not satisfy any allowed schema.`);
      return;
    }
  }

  if (schema.type === "array") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item(s).`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateSchema(schema.items, item, `${location}[${index}]`, errors);
      });
    }
    return;
  }

  if (schema.type === "object") {
    const keys = Object.keys(value);
    const properties = schema.properties || {};

    for (const requiredKey of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
        errors.push(`${location} is missing required key "${requiredKey}".`);
      }
    }

    if (schema.propertyNames) {
      for (const key of keys) {
        validateSchema(schema.propertyNames, key, `${location} key "${key}"`, errors);
      }
    }

    for (const key of keys) {
      const childLocation = `${location}.${key}`;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchema(properties[key], value[key], childLocation, errors);
        continue;
      }

      if (schema.additionalProperties === false) {
        errors.push(`${location} has unexpected key "${key}".`);
        continue;
      }

      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchema(schema.additionalProperties, value[key], childLocation, errors);
      }
    }

    return;
  }
}

function matchesType(type, value) {
  if (type === "object") {
    return isPlainObject(value);
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderTasksMarkdown(board) {
  const lines = [];
  lines.push(`# ${board.metadata.title}`);
  lines.push("");
  lines.push("Generated from `coord/board/tasks.json`. Do not hand-edit.");
  lines.push("Regenerate with `node coord/board/board.js sync`.");
  lines.push("");

  for (const line of board.metadata.preamble || []) {
    lines.push(line);
  }

  for (const section of board.sections) {
    if (section.separator_before) {
      lines.push("");
      lines.push("---");
    }

    lines.push("");
    lines.push(`${"#".repeat(section.level)} ${section.heading}`);
    lines.push("");

    if (section.kind === "markdown") {
      for (const line of section.body || []) {
        lines.push(line);
      }
      continue;
    }

    lines.push(`| ${section.columns.join(" | ")} |`);
    lines.push(`| ${section.columns.map(() => "---").join(" | ")} |`);

    for (const row of section.rows || []) {
      const cells = section.columns.map((column) => escapeTableCell(row[column]));
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

function renderPromptIndexMarkdown(board) {
  const lines = [];
  lines.push("# Prompt Index");
  lines.push("");
  lines.push("Generated from `coord/board/tasks.json` (`prompt_index`). Do not hand-edit.");
  lines.push("Regenerate with `node coord/board/board.js sync`.");
  lines.push("");
  lines.push("| Ticket | Prompt File |");
  lines.push("|--------|-------------|");

  for (const [ticketId, promptPath] of Object.entries(board.prompt_index || {})) {
    lines.push(`| ${escapeTableCell(ticketId)} | \`${promptPath}\` |`);
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

function normalizePlanRecordScope(options = {}) {
  if (options.planRecordScope instanceof Set) {
    return new Set([...options.planRecordScope].map((ticketId) => String(ticketId || "").trim()).filter(Boolean));
  }
  if (Array.isArray(options.planRecordScope)) {
    return new Set(options.planRecordScope.map((ticketId) => String(ticketId || "").trim()).filter(Boolean));
  }
  if (isTicketScopedValidation(options)) {
    return new Set([String(options.currentTicketId || "").trim()].filter(Boolean));
  }
  return null;
}

function listPlanRecordFiles() {
  // Temporary compatibility reader (C6 Phase 2). Plan shards are now
  // runtime-owned (coord/.runtime/plans). Union the runtime dir with the
  // legacy tracked dir (coord/board/plans) so board validation still sees
  // every record during the transition. Runtime wins on id collision.
  const byFileName = new Map();
  for (const dir of [LEGACY_PLAN_RECORDS_DIR, PLAN_RECORDS_DIR]) {
    if (!dir || !fs.existsSync(dir)) {
      continue;
    }
    for (const fileName of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
      byFileName.set(fileName, path.join(dir, fileName));
    }
  }
  return [...byFileName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([fileName, filePath]) => ({ fileName, filePath }));
}

function readPlanRecords(planSchema, tickets, errors, options = {}) {
  const records = new Map();
  const planRecordFiles = listPlanRecordFiles();
  if (planRecordFiles.length === 0) {
    return records;
  }
  const scope = normalizePlanRecordScope(options);

  for (const { fileName, filePath } of planRecordFiles) {
    const fileTicketIdHint = path.basename(fileName, ".json").trim();
    const hintedInScope = !scope || scope.has(fileTicketIdHint);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (scope && !hintedInScope) {
        continue;
      }
      errors.push(`Plan record ${path.relative(COORD_DIR, filePath)} is not valid JSON.`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "requirement_closure")) {
      record = {
        ...record,
        requirement_closure: [],
      };
    }
    if (!Object.prototype.hasOwnProperty.call(record, "feature_proof")) {
      record = {
        ...record,
        feature_proof: [],
      };
    }
    if (!record.governance || typeof record.governance !== "object" || Array.isArray(record.governance)) {
      record = {
        ...record,
        governance: {
          expected_closeout: {
            method: "no_pr",
            base_ref: "main",
            provenance_note: null,
          },
          review_profile: "standard",
          ticket_local_repairs: [],
        },
      };
    } else if (!Object.prototype.hasOwnProperty.call(record.governance, "review_profile")) {
      record = {
        ...record,
        governance: {
          ...record.governance,
          review_profile: "standard",
        },
      };
    }
    const ticketId = record?.ticket_id;
    if (typeof ticketId !== "string" || !ticketId.trim()) {
      if (scope && !hintedInScope) {
        continue;
      }
      errors.push(`Plan record ${path.relative(COORD_DIR, filePath)} must include ticket_id.`);
      continue;
    }
    const normalizedTicketId = ticketId.trim();
    const recordInScope = !scope || scope.has(normalizedTicketId);
    if (scope && !hintedInScope && !recordInScope) {
      continue;
    }
    validateSchema(planSchema, record, path.relative(COORD_DIR, filePath), errors);
    if (!tickets.has(normalizedTicketId)) {
      errors.push(`Plan record ${path.relative(COORD_DIR, filePath)} references unknown ticket "${ticketId}".`);
      continue;
    }
    if (fileTicketIdHint !== normalizedTicketId) {
      errors.push(`Plan record ${path.relative(COORD_DIR, filePath)} must match ticket id "${ticketId}".`);
    }
    if (records.has(normalizedTicketId)) {
      errors.push(`Duplicate canonical plan record for ${ticketId}.`);
      continue;
    }
    records.set(normalizedTicketId, record);
  }

  return records;
}

function renderPlanMarkdown(board, planRecords) {
  const lines = [];
  const rendered = new Set();
  const rowsById = new Map((board.sections || []).flatMap((section) => (section.rows || []).map((row) => [row.ID, row])));
  const renderStatuses = new Set(
    Array.isArray(board?.metadata?.plan_markdown_render_statuses) && board.metadata.plan_markdown_render_statuses.length > 0
      ? board.metadata.plan_markdown_render_statuses
      : [STATUS.DOING, STATUS.REVIEW]
  );

  for (const section of board.sections || []) {
    for (const row of section.rows || []) {
      const record = planRecords.get(row.ID);
      if (!record || !renderStatuses.has(row.Status)) {
        continue;
      }
      rendered.add(row.ID);
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(renderPlanRecord(record));
    }
  }

  for (const [ticketId, record] of [...planRecords.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (rendered.has(ticketId)) {
      continue;
    }
    const row = rowsById.get(ticketId);
    if (row && !renderStatuses.has(row.Status)) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(renderPlanRecord(record));
  }

  lines.push("");
  return lines.join("\n");
}

function renderPlanRecord(record) {
  const lines = [];
  lines.push(record.markdown_heading || `## ${record.ticket_id}`);
  lines.push("");
  appendPlanListSection(lines, "Startup checklist", normalizePlanItems(record.startup_checklist));
  appendPlanListSection(lines, "Traceability gate", normalizePlanItems(record.traceability_gate));
  if (record.review_round !== undefined && record.review_round !== null) {
    appendPlanListSection(lines, "Review round", [String(record.review_round)]);
  }
  appendPlanListSection(lines, "Baseline reproduction", normalizePlanItems(record.baseline_reproduction));
  if ((record.prior_findings || []).length > 0) {
    appendPlanListSection(lines, "Prior findings", normalizePlanItems(record.prior_findings));
  }
  appendPlanListSection(lines, "Intended files", normalizePlanItems(record.intended_files), { code: true });
  appendPlanListSection(lines, "Change summary", normalizePlanItems(record.change_summary));
  appendPlanListSection(lines, "Verification commands", normalizePlanItems(record.verification_commands), { code: true });
  appendPlanListSection(lines, "Critical invariants", normalizePlanItems(record.critical_invariants));
  appendPlanListSection(lines, "Requirement closure", normalizePlanItems(record.requirement_closure));
  appendPlanListSection(lines, "Feature proof", normalizePlanItems(record.feature_proof));
  appendPlanListSection(lines, "Repo gates", normalizePlanItems(record.repo_gates));
  for (const cycle of record.self_review_cycles || []) {
    lines.push(`- Self-review cycle ${cycle.cycle}/${cycle.total}: ${cycle.raw}`);
  }
  appendPlanListSection(lines, "Rollback strategy", normalizePlanItems(record.rollback_strategy));
  if (record.security_surface !== undefined && record.security_surface !== null) {
    appendPlanListSection(lines, "Security surface", [String(record.security_surface)]);
  }
  return lines.join("\n");
}

function normalizePlanItems(items) {
  const values = (items || []).map((item) => String(item));
  const hasMeaningful = values.some((value) => !/^TODO\b/i.test(value.trim()));
  const filtered = hasMeaningful ? values.filter((value) => !/^TODO\b/i.test(value.trim())) : values;
  return [...new Set(filtered)];
}

function appendPlanListSection(lines, label, items, options = {}) {
  lines.push(`- ${label}:`);
  for (const item of items || []) {
    const value = options.code ? `\`${item}\`` : item;
    lines.push(`  - ${value}`);
  }
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function isLegalStatus(status) {
  return LEGAL_STATUSES.has(status) || /^doing \(blocked: .+\)$/.test(status);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Failed to read ${filePath}: ${error.message}`);
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeCompatibilityCopy(primaryPath, compatibilityPath, content) {
  if (!primaryPath || !compatibilityPath || primaryPath === compatibilityPath) {
    return;
  }
  writeFile(compatibilityPath, content);
}

function printSummary(state, rendered) {
  console.log(
    `coord board OK: ${state.ticketCount} tickets across ${state.board.sections.length} sections; ${state.doingCount} doing tickets.`
  );
  if (rendered) {
    console.log(
      `Rendered: ${path.relative(COORD_DIR, RENDERED_TASKS_MD_PATH)}, ${path.relative(COORD_DIR, RENDERED_PROMPT_INDEX_MD_PATH)}, ${path.relative(COORD_DIR, PLAN_PATH)}`
    );
    console.log(
      `Compatibility copies: ${path.relative(COORD_DIR, TASKS_MD_PATH)}, ${path.relative(COORD_DIR, PROMPT_INDEX_MD_PATH)}`
    );
  }
}

function fail(message) {
  throw new BoardValidationError(message);
}

module.exports = {
  BoardValidationError,
  renderBoardArtifacts,
  syncBoardArtifacts,
  validateBoardState,
  __testing: {
    boardStatusRank,
    collectBoardRenderState,
    compareEventTimestamps,
    isTerminalBoardStatus,
    isTicketInScope,
    isTicketScopedValidation,
    readLatestLifecycleStatesFromGovernanceJournal,
    shouldEnforceJournalRegression,
    shouldIgnoreJournalLifecycleEvent,
    requiresLandingGovernance,
    requiresFeatureProofGovernance,
    requiresPrIndexGovernance,
    requiresPlanRecordGovernance,
    resolveGovernanceThreshold,
    ticketHasHistoricalCloseoutEvidence,
    normalizePlanItems,
    parseSelfReviewCyclesFromRecord,
    readPlanRecords,
    listPlanRecordFiles,
    paths: {
      get PLAN_RECORDS_DIR() {
        return PLAN_RECORDS_DIR;
      },
      set PLAN_RECORDS_DIR(value) {
        PLAN_RECORDS_DIR = value;
      },
      get LEGACY_PLAN_RECORDS_DIR() {
        return LEGACY_PLAN_RECORDS_DIR;
      },
      set LEGACY_PLAN_RECORDS_DIR(value) {
        LEGACY_PLAN_RECORDS_DIR = value;
      },
    },
    renderPlanMarkdown,
    renderPlanRecord,
    writeCompatibilityCopy,
    shouldIgnoreActiveLockValidationError,
    validateFollowupExceptions,
    validateWaiverIndex,
    validateBoard,
    expectedLockRepoForCode,
  },
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof BoardValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
