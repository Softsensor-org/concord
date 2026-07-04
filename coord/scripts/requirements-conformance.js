#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const traceability = require("./requirements-traceability.js");
const evidencePolicy = require("./requirements-evidence-policy.js");

const DELIVERY_STATE_PATTERNS = [
  ["delivered-projection", /\b(delivered|implemented|done|completed|shipped)\b/i],
  ["open-projection", /\b(open|pending|in progress|not started|todo|backlog)\b/i],
  ["status-projection", /\b(status|delivery state|implementation state|current state)\s*:/i],
];

function readJsonIfExists(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
}

function sourceLabel(sourcePath) {
  return /(^|[/\\])(prd|urs|srs|requirements)([/\\._-]|$)/i.test(sourcePath);
}

function lineLooksLikeRequirementProjection(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || /^```/.test(trimmed)) return false;
  if (/^\s*<!--/.test(trimmed)) return false;
  return /\b(REQ|URS|PRD|SRS|FR|NFR|SEC|DONOR-REQ)-[A-Za-z0-9_.-]+\b/i.test(trimmed) ||
    /^[-*]\s*(delivered|implemented|done|open|pending|status|delivery state|implementation state)\s*:/i.test(trimmed) ||
    /^(delivered|implemented|done|open|pending|status|delivery state|implementation state)\s*:/i.test(trimmed);
}

function scanRequirementsSource(markdown, options = {}) {
  const sourcePath = options.sourcePath || "<source>";
  const findings = [];
  const lines = String(markdown || "").split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!lineLooksLikeRequirementProjection(line) && sourceLabel(sourcePath)) {
      const lower = line.toLowerCase();
      if (!/delivered|implemented|done|open|pending|status|delivery state|implementation state/.test(lower)) return;
    } else if (!lineLooksLikeRequirementProjection(line)) {
      return;
    }
    for (const [code, pattern] of DELIVERY_STATE_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          severity: "fail",
          code,
          source: sourcePath,
          line: index + 1,
          message: "Requirements source appears to contain delivery-state projection; move status/conformance to generated reports.",
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  });
  return findings;
}

function requirementTitle(req) {
  return String(req.title || req.statement || req.id || "").trim();
}

function requirementMap(registry) {
  const map = new Map();
  for (const req of registry.requirements || []) {
    if (req && req.id) map.set(String(req.id).toUpperCase(), req);
  }
  return map;
}

function normalizeForCheck(value) {
  if (Array.isArray(value)) return value.map(normalizeForCheck);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "generated_at_utc") continue;
    out[key] = normalizeForCheck(value[key]);
  }
  return out;
}

function buildConformanceReport(board, registry = {}, planRecords = [], options = {}) {
  const trace = traceability.buildTraceabilityMatrix(board, registry, planRecords, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    boardPath: options.boardPath,
    registryPath: options.registryPath,
    plansDir: options.plansDir,
  });
  const evidence = evidencePolicy.analyzeEvidencePolicy(board, registry, planRecords, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    boardPath: options.boardPath,
    registryPath: options.registryPath,
    plansDir: options.plansDir,
  });
  const reqs = requirementMap(registry);
  const traceByReq = new Map((trace.requirement_to_tickets || []).map((row) => [row.requirement_id, row]));
  const evidenceByReq = new Map((evidence.requirements || []).map((row) => [row.requirement_id, row]));
  const hygieneFindings = options.sourceFindings || [];
  const requirementIds = Array.from(new Set([
    ...Array.from(reqs.keys()),
    ...(trace.requirement_to_tickets || []).map((row) => row.requirement_id),
  ])).sort();

  const requirements = requirementIds.map((id) => {
    const req = reqs.get(id) || { id };
    const traceRow = traceByReq.get(id) || { tickets: [], status: "missing-ticket-link" };
    const evidenceRow = evidenceByReq.get(id) || { required_evidence: [], observed_evidence: [], missing_evidence: [], closure_strength: "unlinked" };
    return {
      requirement_id: id,
      title: requirementTitle(req),
      risk_class: normalizeValue(req.classification && req.classification.risk_class) || "unknown",
      criticality: normalizeValue(req.classification && req.classification.criticality) || "unknown",
      traceability_state: traceRow.status,
      closure_strength: evidenceRow.closure_strength,
      ticket_ids: traceRow.tickets || [],
      required_evidence: evidenceRow.required_evidence || [],
      observed_evidence: evidenceRow.observed_evidence || [],
      missing_evidence: evidenceRow.missing_evidence || [],
      conformance_state: conformanceState(traceRow, evidenceRow),
    };
  });

  const findings = []
    .concat(hygieneFindings)
    .concat((trace.findings || []).map((finding) => ({ ...finding, source_report: "traceability" })))
    .concat((evidence.findings || []).map((finding) => ({ ...finding, source_report: "evidence_policy" })))
    .sort((a, b) => `${a.severity}:${a.code}:${a.requirement_id || a.ticket_id || a.source || ""}:${a.line || 0}`.localeCompare(`${b.severity}:${b.code}:${b.requirement_id || b.ticket_id || b.source || ""}:${b.line || 0}`));
  const failures = findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.conformance_audit",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    source: {
      board: options.boardPath || "coord/board/tasks.json",
      registry: options.registryPath || null,
      plans: options.plansDir || "coord/.runtime/plans",
      requirements_sources: options.sourcePaths || [],
    },
    source_hygiene: {
      policy: "PRD/URS/SRS sources define requirements only; delivered/open/status projections belong in generated conformance.",
      findings: hygieneFindings,
      ok: hygieneFindings.length === 0,
    },
    requirements,
    findings,
    summary: {
      requirements: requirements.length,
      conforming: requirements.filter((row) => row.conformance_state === "conforming").length,
      partial: requirements.filter((row) => row.conformance_state === "partial").length,
      nonconforming: requirements.filter((row) => row.conformance_state === "nonconforming").length,
      source_hygiene_findings: hygieneFindings.length,
      findings: findings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function conformanceState(traceRow, evidenceRow) {
  if ((traceRow.tickets || []).length === 0 || traceRow.status === "missing-ticket-link") return "nonconforming";
  if ((evidenceRow.missing_evidence || []).length > 0) return "partial";
  if (["validation_grade", "implemented"].includes(evidenceRow.closure_strength)) return "conforming";
  if (["partial", "planned", "unlinked"].includes(evidenceRow.closure_strength)) return "partial";
  return "nonconforming";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Conformance Audit");
  lines.push("");
  lines.push(`Requirements: ${report.summary.requirements}`);
  lines.push(`Conforming: ${report.summary.conforming}`);
  lines.push(`Partial: ${report.summary.partial}`);
  lines.push(`Nonconforming: ${report.summary.nonconforming}`);
  lines.push(`Source hygiene findings: ${report.summary.source_hygiene_findings}`);
  lines.push("");
  lines.push("## Requirements");
  for (const row of report.requirements) {
    lines.push(`- ${row.requirement_id}: ${row.conformance_state}; trace=${row.traceability_state}; closure=${row.closure_strength}; tickets=${row.ticket_ids.join(", ") || "none"}`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.requirement_id || finding.ticket_id || finding.source || ""}: ${finding.code} - ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    board: "coord/board/tasks.json",
    registry: null,
    plans: "coord/.runtime/plans",
    output: null,
    check: null,
    source: [],
    json: false,
    profile: "product-engineering",
    lane: "full",
    generatedAtUtc: "1970-01-01T00:00:00.000Z",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--board", "--registry", "--plans", "--output", "--check", "--profile", "--lane", "--generated-at-utc"].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    if (arg === "--source") {
      const value = argv[++i];
      if (!value) return { error: "--source requires a value" };
      options.source.push(value);
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
    log(`requirements-conformance: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-conformance [--dir <root>] --registry <path> [--board <path>] [--plans <path>] [--source <prd-or-urs.md> ...] [--output <path>] [--check <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fs.existsSync(boardPath)) {
    log(`requirements-conformance: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  if (!parsed.options.registry) {
    log("requirements-conformance: --registry is required");
    return { code: 1 };
  }
  const registryPath = path.resolve(root, parsed.options.registry);
  if (!fs.existsSync(registryPath)) {
    log(`requirements-conformance: registry not found: ${parsed.options.registry}`);
    return { code: 1 };
  }
  const sourceFindings = [];
  for (const source of parsed.options.source) {
    const sourcePath = path.resolve(root, source);
    if (!fs.existsSync(sourcePath)) {
      log(`requirements-conformance: source not found: ${source}`);
      return { code: 1 };
    }
    sourceFindings.push(...scanRequirementsSource(fs.readFileSync(sourcePath, "utf8"), { sourcePath: source }));
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const registry = readJsonIfExists(registryPath, {});
  const plans = traceability.listPlanRecords(path.resolve(root, parsed.options.plans));
  const report = buildConformanceReport(board, registry, plans, {
    boardPath: parsed.options.board,
    registryPath: parsed.options.registry,
    plansDir: parsed.options.plans,
    sourcePaths: parsed.options.source,
    sourceFindings,
    profile: parsed.options.profile,
    lane: parsed.options.lane,
    generatedAtUtc: parsed.options.generatedAtUtc,
  });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  let code = report.ok ? 0 : 2;
  if (parsed.options.check) {
    const checkPath = path.resolve(root, parsed.options.check);
    if (!fs.existsSync(checkPath)) {
      log(`requirements-conformance: check target not found: ${parsed.options.check}`);
      return { code: 1, report };
    }
    const expected = JSON.parse(fs.readFileSync(checkPath, "utf8"));
    const matches = JSON.stringify(normalizeForCheck(expected)) === JSON.stringify(normalizeForCheck(report));
    if (!matches) {
      log(`requirements-conformance: ${parsed.options.check} is stale`);
      code = 2;
    }
  }
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else if (!parsed.options.check || parsed.options.json) {
    log(body);
  }
  return { code, report };
}

module.exports = {
  buildConformanceReport,
  conformanceState,
  normalizeForCheck,
  renderMarkdown,
  run,
  scanRequirementsSource,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
