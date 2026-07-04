#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function collectTicketStatuses(board) {
  const map = new Map();
  for (const section of board.sections || []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (row && row.ID) map.set(String(row.ID), String(row.Status || ""));
    }
  }
  return map;
}

function normalizePersonas(matrix) {
  return (matrix.personas || []).map((row) => ({
    persona: row.persona || row.id || "",
    role_rbac_status: row.role_rbac_status || row.rbac_status || "unknown",
    primary_surface: row.primary_surface || row.surface || "",
    workflows: Array.isArray(row.workflows) ? row.workflows : [],
    backend_coverage: row.backend_coverage || "unknown",
    frontend_coverage: row.frontend_coverage || "unknown",
    blocker_tickets: Array.isArray(row.blocker_tickets) ? row.blocker_tickets : [],
  })).sort((a, b) => a.persona.localeCompare(b.persona));
}

function analyzePersonaWorkflow(matrix, board, options = {}) {
  const statuses = collectTicketStatuses(board);
  const personas = normalizePersonas(matrix);
  const findings = [];

  for (const row of personas) {
    if (!row.persona) {
      findings.push({ severity: "warning", code: "missing-persona-id", persona: "", message: "Persona row has no persona/id." });
    }
    if (!row.primary_surface) {
      findings.push({ severity: "warning", code: "missing-primary-surface", persona: row.persona, message: "Persona has no primary surface." });
    }
    if (row.workflows.length === 0) {
      findings.push({ severity: "warning", code: "missing-workflow", persona: row.persona, message: "Persona has no workflow list." });
    }
    if (row.role_rbac_status === "unknown") {
      findings.push({ severity: "warning", code: "unknown-rbac-status", persona: row.persona, message: "Persona RBAC status is unknown." });
    }
    for (const ticketId of row.blocker_tickets) {
      const status = statuses.get(ticketId);
      if (!status) {
        findings.push({ severity: "fail", code: "unknown-blocker-ref", persona: row.persona, ticket_id: ticketId, message: `Blocker ticket ${ticketId} is not on the board.` });
      } else if (status === "done") {
        findings.push({ severity: "warning", code: "stale-done-blocker", persona: row.persona, ticket_id: ticketId, message: `Blocker ticket ${ticketId} is done but still listed as a blocker.` });
      } else if (status === "todo" || status === "doing" || status === "review" || status.startsWith("doing ")) {
        findings.push({ severity: "info", code: "open-blocker", persona: row.persona, ticket_id: ticketId, status, message: `Blocker ticket ${ticketId} is still ${status}.` });
      }
    }
  }

  const failCount = findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.persona_workflow_audit",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      matrix: options.matrixPath || "coord/.runtime/persona-workflow-matrix.json",
      board: options.boardPath || "coord/board/tasks.json",
    },
    personas,
    findings: findings.sort((a, b) => `${a.severity}:${a.code}:${a.persona}:${a.ticket_id || ""}`.localeCompare(`${b.severity}:${b.code}:${b.persona}:${b.ticket_id || ""}`)),
    summary: {
      personas: personas.length,
      workflows: personas.reduce((total, row) => total + row.workflows.length, 0),
      blockers: personas.reduce((total, row) => total + row.blocker_tickets.length, 0),
      findings: findings.length,
      failures: failCount,
    },
    ok: failCount === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Persona Workflow Audit");
  lines.push("");
  lines.push(`Personas: ${report.summary.personas}`);
  lines.push(`Workflows: ${report.summary.workflows}`);
  lines.push(`Blockers: ${report.summary.blockers}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push("");
  for (const row of report.personas) {
    lines.push(`- ${row.persona}: surface=${row.primary_surface || "missing"} workflows=${row.workflows.length} blockers=${row.blocker_tickets.length}`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) lines.push(`- ${finding.severity.toUpperCase()} ${finding.persona}: ${finding.code} ${finding.ticket_id || ""}`.trim());
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    matrix: "coord/.runtime/persona-workflow-matrix.json",
    board: "coord/board/tasks.json",
    output: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--matrix", "--board", "--output"].includes(arg)) {
      const key = arg.slice(2);
      options[key] = argv[++i];
      if (!options[key]) return { error: `${arg} requires a value` };
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-persona-workflow: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-persona-workflow [--dir <root>] [--matrix <path>] [--board <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const matrixPath = path.resolve(root, parsed.options.matrix);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fsImpl.existsSync(matrixPath)) {
    log(`requirements-persona-workflow: matrix not found: ${parsed.options.matrix}`);
    return { code: 1 };
  }
  if (!fsImpl.existsSync(boardPath)) {
    log(`requirements-persona-workflow: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  let matrix;
  try {
    matrix = JSON.parse(fsImpl.readFileSync(matrixPath, "utf8"));
  } catch (err) {
    log(`requirements-persona-workflow: malformed JSON in matrix ${parsed.options.matrix}: ${err.message}`);
    return { code: 1 };
  }
  let board;
  try {
    board = JSON.parse(fsImpl.readFileSync(boardPath, "utf8"));
  } catch (err) {
    log(`requirements-persona-workflow: malformed JSON in board ${parsed.options.board}: ${err.message}`);
    return { code: 1 };
  }
  const report = analyzePersonaWorkflow(matrix, board, {
    matrixPath: parsed.options.matrix,
    boardPath: parsed.options.board,
  });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  analyzePersonaWorkflow,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
