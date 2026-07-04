#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const importer = require("./requirements-import.js");
const traceability = require("./requirements-traceability.js");

const DEFAULT_FIXTURE_DIR = "coord/scripts/__fixtures__/requirements-walking-skeleton";

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sourceRecord({ id, sourcePath, text }) {
  return {
    id,
    type: "markdown",
    label: path.basename(sourcePath),
    uri: sourcePath,
    authority: "authoritative",
    visibility: "public",
    owner: "product",
    version: null,
    retrieved_at_utc: null,
    content_hash: sha256(text),
    notes: "Imported by the requirements walking-skeleton proof.",
  };
}

function readJson(filePath, fsImpl, label) {
  const raw = fsImpl.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(err.message);
    wrapped.code = "MALFORMED_JSON";
    wrapped.jsonLabel = label;
    throw wrapped;
  }
}

function buildWalkingSkeleton({ root, source, board, plans, fsImpl = fs }) {
  const sourcePath = path.resolve(root, source);
  const boardPath = path.resolve(root, board);
  const plansDir = path.resolve(root, plans);
  const sourceText = fsImpl.readFileSync(sourcePath, "utf8");
  const sourceRel = path.relative(root, sourcePath).split(path.sep).join("/");
  const requirements = importer.parseMarkdownRequirements(sourceText, {
    sourceId: "SRC-001",
    sourcePath: sourceRel,
  });
  const registry = importer.buildRegistry(
    [sourceRecord({ id: "SRC-001", sourcePath: sourceRel, text: sourceText })],
    requirements,
    { projectName: "requirements-walking-skeleton" }
  );
  const boardData = readJson(boardPath, fsImpl, "board");
  const planRecords = traceability.listPlanRecords(plansDir);
  const matrix = traceability.buildTraceabilityMatrix(boardData, registry, planRecords, {
    boardPath: path.relative(root, boardPath).split(path.sep).join("/"),
    registryPath: "<in-memory-import>",
    plansDir: path.relative(root, plansDir).split(path.sep).join("/"),
  });
  const linkedRows = matrix.requirement_to_tickets.filter((row) => row.tickets.length > 0);
  const linkedTicketIds = Array.from(new Set(matrix.ticket_to_requirements.map((row) => row.ticket_id))).sort();
  const readout = {
    kind: "concord.requirements.walking_skeleton",
    schema_version: 1,
    source: {
      markdown: sourceRel,
      board: path.relative(root, boardPath).split(path.sep).join("/"),
      plans: path.relative(root, plansDir).split(path.sep).join("/"),
    },
    registry_summary: {
      requirements_imported: registry.requirements.length,
      source_hash: registry.sources[0].content_hash,
    },
    traceability_summary: {
      requirements: matrix.summary.requirements,
      linked_requirements: matrix.summary.linked_requirements,
      linked_tickets: linkedTicketIds.length,
      missing_links: matrix.summary.missing_links,
    },
    rows: linkedRows.map((row) => ({
      requirement_id: row.requirement_id,
      tickets: row.tickets,
    })),
    ok: registry.requirements.length >= 1 && linkedRows.length >= 1 && linkedTicketIds.length >= 2,
  };
  return { registry, matrix, readout };
}

function renderMarkdown(readout) {
  const lines = [];
  lines.push("# Requirements Walking Skeleton");
  lines.push("");
  lines.push(`Markdown source: ${readout.source.markdown}`);
  lines.push(`Imported requirements: ${readout.registry_summary.requirements_imported}`);
  lines.push(`Linked requirements: ${readout.traceability_summary.linked_requirements}`);
  lines.push(`Linked tickets: ${readout.traceability_summary.linked_tickets}`);
  lines.push(`Missing links: ${readout.traceability_summary.missing_links}`);
  lines.push("");
  lines.push("## Requirement Links");
  for (const row of readout.rows) {
    lines.push(`- ${row.requirement_id}: ${row.tickets.join(", ")}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    source: `${DEFAULT_FIXTURE_DIR}/URS.md`,
    board: `${DEFAULT_FIXTURE_DIR}/tasks.json`,
    plans: `${DEFAULT_FIXTURE_DIR}/plans`,
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
    if (["--dir", "--source", "--board", "--plans", "--output"].includes(arg)) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
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
    log(`requirements-walking-skeleton: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-walking-skeleton [--dir <root>] [--source <md>] [--board <json>] [--plans <dir>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const fsImpl = deps.fs || fs;
  const root = path.resolve(deps.cwd || process.cwd(), parsed.options.dir);
  for (const [label, rel] of [["source", parsed.options.source], ["board", parsed.options.board]]) {
    if (!fsImpl.existsSync(path.resolve(root, rel))) {
      log(`requirements-walking-skeleton: ${label} not found: ${rel}`);
      return { code: 1 };
    }
  }
  let result;
  try {
    result = buildWalkingSkeleton({
      root,
      source: parsed.options.source,
      board: parsed.options.board,
      plans: parsed.options.plans,
      fsImpl,
    });
  } catch (err) {
    if (err && err.code === "MALFORMED_JSON") {
      log(`requirements-walking-skeleton: malformed JSON in ${err.jsonLabel} ${parsed.options.board}: ${err.message}`);
      return { code: 1 };
    }
    throw err;
  }
  const body = parsed.options.json ? JSON.stringify(result.readout, null, 2) : renderMarkdown(result.readout);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: result.readout.ok ? 0 : 2, ...result };
}

module.exports = {
  buildWalkingSkeleton,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
