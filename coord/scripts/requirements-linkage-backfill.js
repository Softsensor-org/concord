#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
    const ticketId = String(row.ID || "");
    const inferred = stableList(linkage.extractRequirementIds(row.Description || ""));
    const existing = stableList(splitList(row[REQUIREMENT_FIELD]));
    const stamped = row[STAMP_FIELD] === stamp;

    if (existing.length > 0) {
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

function isLiveBoard(root, boardPath) {
  return path.resolve(root, boardPath) === path.resolve(root, DEFAULT_BOARD);
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
  if ((parsed.options.apply || parsed.options.revert) && isLiveBoard(root, parsed.options.board) && !parsed.options.allowLiveBoard) {
    log("requirements-linkage-backfill: refusing to mutate live coord/board/tasks.json without --allow-live-board. Prefer dry-run report plus governed acceptance.");
    return { code: 2 };
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
  if (parsed.options.apply || parsed.options.revert) {
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
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
