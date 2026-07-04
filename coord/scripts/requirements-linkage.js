#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIREMENT_ID_RE = /\b(?:REQ|URS|PRD|SRS|FR|NFR|SEC|DONOR-REQ)-[A-Za-z0-9_.-]+\b/g;
const EVIDENCE_CLASSES = new Set([
  "test_gate",
  "manual_review",
  "screenshot",
  "runtime_receipt",
  "deploy_receipt",
  "data_contract",
  "security_scan",
  "attestation",
  "controlled_document",
  "waiver",
]);

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractRequirementIds(value) {
  const ids = [];
  const seen = new Set();
  for (const match of String(value || "").matchAll(REQUIREMENT_ID_RE)) {
    const id = match[0].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function collectTicketRows(board) {
  const rows = [];
  for (const section of board.sections || []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (row && typeof row === "object" && row.ID) rows.push(row);
    }
  }
  return rows.sort((a, b) => String(a.ID).localeCompare(String(b.ID)));
}

function normalizeLinkage(row) {
  const explicitRequirementIds = splitList(row["Requirement IDs"]).map((id) => id.toUpperCase());
  const inferredRequirementIds = extractRequirementIds(row.Description || "");
  const requirementIds = Array.from(new Set([...explicitRequirementIds, ...inferredRequirementIds])).sort();
  const evidenceClasses = splitList(row["Expected Evidence Class"] || row["Evidence Class"]).map((item) => item.trim());
  const externalRefs = splitList(row["External Refs"] || row["External References"] || row["External Tickets"]);
  return {
    ticket_id: String(row.ID || "").trim(),
    repo: row.Repo || "",
    type: row.Type || "",
    status: row.Status || "",
    requirement_ids: requirementIds,
    explicit_requirement_ids: explicitRequirementIds.sort(),
    inferred_requirement_ids: inferredRequirementIds.sort(),
    expected_evidence_classes: evidenceClasses.sort(),
    external_refs: externalRefs.sort(),
  };
}

function requirementRegistryIds(registry) {
  return new Set((registry.requirements || []).map((req) => String(req.id || "").toUpperCase()).filter(Boolean));
}

function rowRequiresLinkage(row, options = {}) {
  const status = String(row.Status || "");
  if (["superseded", "deferred"].includes(status)) return false;
  if (options.onlyOpen && ["done"].includes(status)) return false;
  const type = String(row.Type || "").toLowerCase();
  return ["feature", "bug", "test", "docs", "design", "task", "refactor", "infra", "scaffold"].includes(type);
}

function severityForMissing(options = {}) {
  const profile = String(options.profile || "").toLowerCase();
  const lane = String(options.lane || "").toLowerCase();
  if (profile === "regulated" || lane === "regulated") return "fail";
  if (lane === "full" || profile === "product-engineering") return "warning";
  return "info";
}

function analyzeLinkage(board, registry = {}, options = {}) {
  const registryIds = requirementRegistryIds(registry);
  const rows = collectTicketRows(board);
  const tickets = [];
  const findings = [];

  for (const row of rows) {
    const linkage = normalizeLinkage(row);
    tickets.push(linkage);
    if (!rowRequiresLinkage(row, options)) continue;

    if (linkage.requirement_ids.length === 0) {
      findings.push({
        severity: severityForMissing(options),
        code: "missing-requirement-link",
        ticket_id: linkage.ticket_id,
        message: "Ticket has no Requirement IDs field and no requirement id in the description.",
      });
    }

    for (const id of linkage.requirement_ids) {
      if (registryIds.size > 0 && !registryIds.has(id)) {
        findings.push({
          severity: "warning",
          code: "unknown-requirement-id",
          ticket_id: linkage.ticket_id,
          requirement_id: id,
          message: `Requirement id ${id} is not present in the imported registry.`,
        });
      }
    }

    for (const evidence of linkage.expected_evidence_classes) {
      if (!EVIDENCE_CLASSES.has(evidence)) {
        findings.push({
          severity: "warning",
          code: "unknown-evidence-class",
          ticket_id: linkage.ticket_id,
          evidence_class: evidence,
          message: `Expected evidence class ${evidence} is not in the shared vocabulary.`,
        });
      }
    }
  }

  const linked = tickets.filter((ticket) => ticket.requirement_ids.length > 0);
  const explicit = tickets.filter((ticket) => ticket.explicit_requirement_ids.length > 0);
  const failCount = findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.ticket_linkage",
    schema_version: 1,
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    tickets,
    findings: findings.sort((a, b) => `${a.severity}:${a.code}:${a.ticket_id}`.localeCompare(`${b.severity}:${b.code}:${b.ticket_id}`)),
    summary: {
      tickets_checked: tickets.length,
      tickets_with_requirement_links: linked.length,
      tickets_with_explicit_requirement_links: explicit.length,
      findings: findings.length,
      failures: failCount,
    },
    ok: failCount === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Linkage");
  lines.push("");
  lines.push(`Profile: ${report.profile}`);
  lines.push(`Lane: ${report.lane}`);
  lines.push(`Tickets checked: ${report.summary.tickets_checked}`);
  lines.push(`Linked tickets: ${report.summary.tickets_with_requirement_links}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("No linkage findings.");
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.ticket_id}: ${finding.code} - ${finding.message}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    board: "coord/board/tasks.json",
    registry: null,
    json: false,
    profile: "product-engineering",
    lane: "full",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dir") {
      options.dir = argv[++i];
      if (!options.dir) return { error: "--dir requires a path" };
      continue;
    }
    if (arg === "--board") {
      options.board = argv[++i];
      if (!options.board) return { error: "--board requires a path" };
      continue;
    }
    if (arg === "--registry") {
      options.registry = argv[++i];
      if (!options.registry) return { error: "--registry requires a path" };
      continue;
    }
    if (arg === "--profile") {
      options.profile = argv[++i];
      if (!options.profile) return { error: "--profile requires a value" };
      continue;
    }
    if (arg === "--lane") {
      options.lane = argv[++i];
      if (!options.lane) return { error: "--lane requires a value" };
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const parsed = parseArgs(argv);
  if (parsed.error) {
    log(`requirements-linkage: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-linkage [--dir <root>] [--board <path>] [--registry <path>] [--profile <name>] [--lane <name>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fsImpl.existsSync(boardPath)) {
    log(`requirements-linkage: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  let board;
  try {
    board = JSON.parse(fsImpl.readFileSync(boardPath, "utf8"));
  } catch (err) {
    log(`requirements-linkage: malformed JSON in board ${parsed.options.board}: ${err.message}`);
    return { code: 1 };
  }
  let registry = {};
  if (parsed.options.registry) {
    const registryPath = path.resolve(root, parsed.options.registry);
    if (!fsImpl.existsSync(registryPath)) {
      log(`requirements-linkage: registry not found: ${parsed.options.registry}`);
      return { code: 1 };
    }
    try {
      registry = JSON.parse(fsImpl.readFileSync(registryPath, "utf8"));
    } catch (err) {
      log(`requirements-linkage: malformed JSON in registry ${parsed.options.registry}: ${err.message}`);
      return { code: 1 };
    }
  }
  const report = analyzeLinkage(board, registry, {
    profile: parsed.options.profile,
    lane: parsed.options.lane,
  });
  log(parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  analyzeLinkage,
  extractRequirementIds,
  normalizeLinkage,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
