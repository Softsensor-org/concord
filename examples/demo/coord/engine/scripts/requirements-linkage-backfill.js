#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_DIR = path.resolve(__dirname, "..", "..");
// Resolved at load so a lazy require never depends on later filesystem probes.
const GOVERNANCE_CONTEXT_MODULE = resolveEngineModule(COORD_DIR, "scripts/governance-context.js");
const LIFECYCLE_MODULE = resolveEngineModule(COORD_DIR, "scripts/lifecycle.js");

const linkage = require("./requirements-linkage.js");

const DEFAULT_BOARD = "coord/board/tasks.json";
const DEFAULT_STAMP = "COORD-248";
const STAMP_FIELD = "Requirements Backfill Stamp";
const REQUIREMENT_FIELD = "Requirement IDs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableList(ids) {
  return Array.from(new Set(ids.map((id) => String(id).toUpperCase()).filter(Boolean))).sort();
}

function collectRows(board) {
  const rows = [];
  for (const [sectionIndex, section] of (board.sections || []).entries()) {
    if (!section || section.kind !== "table" || !Array.isArray(section.rows)) continue;
    for (const [rowIndex, row] of section.rows.entries()) {
      if (row && typeof row === "object" && row.ID) rows.push({ sectionIndex, rowIndex, row });
    }
  }
  return rows;
}

function analyzeBoard(board, options = {}) {
  const stamp = options.stamp || DEFAULT_STAMP;
  const changes = [];
  const skipped = [];
  const rows = collectRows(board);

  for (const item of rows) {
    const row = item.row;
    // collectRows() includes only records with an ID, so this fallback is
    // unreachable here and obscures the input invariant.
    const ticketId = String(row.ID);
    const inferred = stableList(linkage.extractRequirementIds(row.Description || ""));
    const existing = stableList(splitList(row[REQUIREMENT_FIELD]));
    const hasExplicitMetadata = Object.prototype.hasOwnProperty.call(row, REQUIREMENT_FIELD);
    const stamped = row[STAMP_FIELD] === stamp;

    if (hasExplicitMetadata) {
      skipped.push({
        ticket_id: ticketId,
        reason: stamped ? "already-backfilled" : "existing-requirement-metadata",
        requirement_ids: existing,
      });
      continue;
    }
    if (inferred.length === 0) {
      skipped.push({ ticket_id: ticketId, reason: "no-explicit-requirement-id" });
      continue;
    }
    changes.push({
      ticket_id: ticketId,
      section_index: item.sectionIndex,
      row_index: item.rowIndex,
      requirement_ids: inferred,
      before: { [REQUIREMENT_FIELD]: row[REQUIREMENT_FIELD] || null, [STAMP_FIELD]: row[STAMP_FIELD] || null },
      after: { [REQUIREMENT_FIELD]: inferred.join(", "), [STAMP_FIELD]: stamp },
    });
  }

  return {
    kind: "concord.requirements.linkage_backfill_report",
    schema_version: 1,
    mode: options.mode || "dry-run",
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      board: options.boardPath || DEFAULT_BOARD,
      explicit_requirement_ids_only: true,
      stamp_field: STAMP_FIELD,
      stamp,
    },
    changes,
    skipped,
    summary: {
      rows_checked: rows.length,
      proposed_updates: changes.length,
      skipped: skipped.length,
      already_backfilled: skipped.filter((item) => item.reason === "already-backfilled").length,
      existing_metadata: skipped.filter((item) => item.reason === "existing-requirement-metadata").length,
      no_explicit_requirement_id: skipped.filter((item) => item.reason === "no-explicit-requirement-id").length,
    },
  };
}

function applyBackfill(board, options = {}) {
  const next = clone(board);
  const report = analyzeBoard(next, { ...options, mode: "apply" });
  for (const change of report.changes) {
    const row = next.sections[change.section_index].rows[change.row_index];
    row[REQUIREMENT_FIELD] = change.after[REQUIREMENT_FIELD];
    row[STAMP_FIELD] = change.after[STAMP_FIELD];
  }
  return { board: next, report };
}

function revertBackfill(board, options = {}) {
  const stamp = options.stamp || DEFAULT_STAMP;
  const next = clone(board);
  const changes = [];
  const skipped = [];
  for (const item of collectRows(next)) {
    const row = item.row;
    const ticketId = String(row.ID || "");
    if (row[STAMP_FIELD] !== stamp) {
      skipped.push({ ticket_id: ticketId, reason: "not-stamped-by-this-migration" });
      continue;
    }
    const ids = stableList(splitList(row[REQUIREMENT_FIELD]));
    if (ids.length === 0) {
      delete row[STAMP_FIELD];
      skipped.push({ ticket_id: ticketId, reason: "stamp-without-requirement-ids-cleared" });
      continue;
    }
    changes.push({
      ticket_id: ticketId,
      section_index: item.sectionIndex,
      row_index: item.rowIndex,
      requirement_ids: ids,
      before: { [REQUIREMENT_FIELD]: row[REQUIREMENT_FIELD], [STAMP_FIELD]: row[STAMP_FIELD] },
      after: { [REQUIREMENT_FIELD]: null, [STAMP_FIELD]: null },
    });
    delete row[REQUIREMENT_FIELD];
    delete row[STAMP_FIELD];
  }
  return {
    board: next,
    report: {
      kind: "concord.requirements.linkage_backfill_report",
      schema_version: 1,
      mode: "revert",
      generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
      source: {
        board: options.boardPath || DEFAULT_BOARD,
        explicit_requirement_ids_only: true,
        stamp_field: STAMP_FIELD,
        stamp,
      },
      changes,
      skipped,
      summary: {
        rows_checked: collectRows(board).length,
        proposed_updates: changes.length,
        skipped: skipped.length,
        already_backfilled: 0,
        existing_metadata: 0,
        no_explicit_requirement_id: 0,
      },
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Linkage Backfill");
  lines.push("");
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Rows checked: ${report.summary.rows_checked}`);
  lines.push(`Updates: ${report.summary.proposed_updates}`);
  lines.push(`Skipped: ${report.summary.skipped}`);
  lines.push("");
  if (report.changes.length === 0) lines.push("No row updates.");
  for (const change of report.changes) {
    lines.push(`- ${change.ticket_id}: ${change.requirement_ids.join(", ")}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: ".",
    board: DEFAULT_BOARD,
    output: null,
    json: false,
    apply: false,
    revert: false,
    allowLiveBoard: false,
    stamp: DEFAULT_STAMP,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--revert") {
      options.revert = true;
      continue;
    }
    if (arg === "--allow-live-board") {
      options.allowLiveBoard = true;
      continue;
    }
    if (["--dir", "--board", "--output", "--stamp"].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  if (options.apply && options.revert) return { error: "Use only one of --apply or --revert" };
  return { options };
}

function resolvedTarget(filePath) {
  let ancestor = path.resolve(filePath);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

function sameFile(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function canonicalBoardTarget(root, boardPath) {
  const target = path.resolve(root, boardPath);
  const { state } = require(GOVERNANCE_CONTEXT_MODULE);
  const governed = path.resolve(state.BOARD_PATH);
  const governedFile = sameFile(target, governed);
  return {
    live: target === path.resolve(root, DEFAULT_BOARD) || governedFile,
    governed: governedFile,
  };
}

function protectedReportTarget(outputPath, boardPath) {
  const { state } = require(GOVERNANCE_CONTEXT_MODULE);
  const resolved = resolvedTarget(outputPath);
  const files = [boardPath, state.BOARD_PATH, state.GOVERNANCE_EVENT_LOG_PATH,
    state.GOVERNANCE_SNAPSHOT_PATH, state.PLAN_PATH, state.QUESTIONS_PATH,
    state.AGENTS_PATH, state.AGENT_SESSIONS_PATH];
  const dirs = [state.GOVERNANCE_SNAPSHOTS_DIR, state.PLAN_RECORDS_DIR,
    state.LOCKS_DIR, state.PROMPTS_DIR, state.RENDERED_DIR];
  return files.some((file) => file && (resolved === resolvedTarget(file) || sameFile(outputPath, file))) ||
    dirs.some((dir) => dir && !path.relative(resolvedTarget(dir), resolved).startsWith("..") &&
      !path.isAbsolute(path.relative(resolvedTarget(dir), resolved)));
}

function writeReport(report, options, root, log) {
  const body = options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (options.output) {
    const outputPath = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-linkage-backfill: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-linkage-backfill [--board <path>] [--output <path>] [--json] [--apply|--revert] [--allow-live-board] [--stamp <id>]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fs.existsSync(boardPath)) {
    log(`requirements-linkage-backfill: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    if (protectedReportTarget(outputPath, boardPath)) {
      log("requirements-linkage-backfill: report output cannot overwrite governed state.");
      return { code: 2 };
    }
  }
  const mutating = parsed.options.apply || parsed.options.revert;
  const target = mutating ? canonicalBoardTarget(root, parsed.options.board) : null;
  if (target && target.live) {
    if (!parsed.options.allowLiveBoard) {
      // guard:requirements-live-board-safety
      log("requirements-linkage-backfill: refusing to mutate live coord/board/tasks.json without --allow-live-board.");
      return { code: 2 };
    }
    if (!target.governed) {
      log("requirements-linkage-backfill: this canonical board is outside the installed governance context. Run the command from that project's coord installation; no board was changed.");
      return { code: 2 };
    }
    try {
      const { commands } = require(LIFECYCLE_MODULE);
      const result = commands.backfillRequirementLinks({
        revert: parsed.options.revert,
        stamp: parsed.options.stamp,
        boardPath: parsed.options.board,
      });
      writeReport(result.report, parsed.options, root, log);
      return { code: 0, report: result.report, board: result.board };
    } catch (error) {
      log(`requirements-linkage-backfill: governed mutation failed: ${error.message}`);
      return { code: 1 };
    }
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  let result;
  if (parsed.options.apply) {
    result = applyBackfill(board, { boardPath: parsed.options.board, stamp: parsed.options.stamp });
  } else if (parsed.options.revert) {
    result = revertBackfill(board, { boardPath: parsed.options.board, stamp: parsed.options.stamp });
  } else {
    result = { board, report: analyzeBoard(board, { boardPath: parsed.options.board, stamp: parsed.options.stamp }) };
  }
  if (mutating) {
    fs.writeFileSync(boardPath, `${JSON.stringify(result.board, null, 2)}\n`);
  }
  writeReport(result.report, parsed.options, root, log);
  return { code: 0, report: result.report, board: result.board };
}

module.exports = {
  STAMP_FIELD,
  REQUIREMENT_FIELD,
  analyzeBoard,
  applyBackfill,
  revertBackfill,
  renderMarkdown,
  main,
  run,
};

function main() {
  const result = run(process.argv.slice(2));
  process.exitCode = result.code;
}
if (require.main === module) main();
