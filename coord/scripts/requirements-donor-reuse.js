#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REUSE_DECISIONS = new Set(["reuse_pattern", "replace", "isolate", "migrate", "defer", "reject"]);
const SCRUB_STATUSES = new Set(["scrubbed", "needs_scrub", "private_pointer_only", "not_applicable"]);
const GENERALIZATION_STATUSES = new Set(["generalized", "needs_generalization", "intentional_product_default", "not_applicable"]);
const CONFIDENCE = new Set(["explicit", "inferred", "candidate"]);

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDecision(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeMatrix(input) {
  if (Array.isArray(input)) return { entries: input };
  return {
    kind: input.kind || "concord.requirements.donor_reuse_matrix",
    schema_version: input.schema_version || 1,
    entries: Array.isArray(input.entries) ? input.entries : [],
  };
}

function entryId(entry, index) {
  return String(entry.id || `DONOR-REUSE-${String(index + 1).padStart(3, "0")}`);
}

function hasAny(entry, keys) {
  return keys.some((key) => splitList(entry[key]).length > 0 || Boolean(entry[key]));
}

function validateEntry(entry, index) {
  const id = entryId(entry, index);
  const findings = [];
  const decision = normalizeDecision(entry.reuse_decision);
  const scrubStatus = normalizeDecision(entry.scrub_status);
  const generalizationStatus = normalizeDecision(entry.generalization_status);
  const confidence = normalizeDecision(entry.confidence || "candidate");
  const provenanceRefs = splitList(entry.provenance_refs || entry.provenance || entry.source_refs);
  const targetRequirementIds = splitList(entry.target_requirement_ids || entry.target_requirement_id);
  const complianceControls = splitList(entry.compliance_controls || entry.compliance_control);

  for (const [field, value] of [
    ["source_system", entry.source_system],
    ["control_pattern", entry.control_pattern],
    ["reuse_decision", entry.reuse_decision],
    ["scrub_status", entry.scrub_status],
    ["generalization_status", entry.generalization_status],
  ]) {
    if (!String(value || "").trim()) {
      findings.push({
        severity: "fail",
        code: "missing-required-field",
        entry_id: id,
        field,
        message: `Donor reuse entry is missing ${field}.`,
      });
    }
  }

  if (decision && !REUSE_DECISIONS.has(decision)) {
    findings.push({
      severity: "fail",
      code: "unknown-reuse-decision",
      entry_id: id,
      reuse_decision: decision,
      message: `Reuse decision ${decision} is not one of ${Array.from(REUSE_DECISIONS).join(", ")}.`,
    });
  }
  if (scrubStatus && !SCRUB_STATUSES.has(scrubStatus)) {
    findings.push({
      severity: "fail",
      code: "unknown-scrub-status",
      entry_id: id,
      scrub_status: scrubStatus,
      message: `Scrub status ${scrubStatus} is not in the shared vocabulary.`,
    });
  }
  if (generalizationStatus && !GENERALIZATION_STATUSES.has(generalizationStatus)) {
    findings.push({
      severity: "fail",
      code: "unknown-generalization-status",
      entry_id: id,
      generalization_status: generalizationStatus,
      message: `Generalization status ${generalizationStatus} is not in the shared vocabulary.`,
    });
  }
  if (confidence && !CONFIDENCE.has(confidence)) {
    findings.push({
      severity: "warning",
      code: "unknown-confidence",
      entry_id: id,
      confidence,
      message: `Confidence ${confidence} is not explicit, inferred, or candidate.`,
    });
  }
  if (provenanceRefs.length === 0) {
    findings.push({
      severity: "fail",
      code: "missing-provenance",
      entry_id: id,
      message: "Donor reuse entry has no provenance reference.",
    });
  }
  if (targetRequirementIds.length === 0 && ["reuse_pattern", "migrate", "isolate"].includes(decision)) {
    findings.push({
      severity: "warning",
      code: "missing-target-requirement",
      entry_id: id,
      message: "Reusable donor pattern has no target requirement id.",
    });
  }
  if (["reuse_pattern", "migrate"].includes(decision) && ["needs_scrub", ""].includes(scrubStatus)) {
    findings.push({
      severity: "fail",
      code: "unsafe-reuse-needs-scrub",
      entry_id: id,
      message: "Reusable or migrated donor material cannot close while scrub_status is needs_scrub.",
    });
  }
  if (["reuse_pattern", "migrate"].includes(decision) && ["needs_generalization", ""].includes(generalizationStatus)) {
    findings.push({
      severity: "fail",
      code: "unsafe-reuse-needs-generalization",
      entry_id: id,
      message: "Reusable or migrated donor material cannot close while generalization_status is needs_generalization.",
    });
  }
  if (decision === "reuse_pattern" && confidence !== "explicit") {
    findings.push({
      severity: "warning",
      code: "reuse-pattern-not-explicit",
      entry_id: id,
      message: "Reuse-pattern decisions should be explicitly reviewed before product claims are made.",
    });
  }
  if (hasAny(entry, ["customer_names", "secrets", "private_identifiers"])) {
    findings.push({
      severity: "fail",
      code: "private-content-present",
      entry_id: id,
      message: "Donor matrix entry declares private/customer/secret content; public artifacts must use private pointers only.",
    });
  }
  if (complianceControls.length > 0 && decision === "reject") {
    findings.push({
      severity: "warning",
      code: "rejected-compliance-control",
      entry_id: id,
      message: "Entry rejects a donor pattern that carried compliance controls; record replacement evidence before closure.",
    });
  }

  return {
    id,
    source_system: entry.source_system || "",
    source_ref: entry.source_ref || "",
    control_pattern: entry.control_pattern || "",
    target_requirement_ids: targetRequirementIds.sort(),
    reuse_decision: decision,
    provenance_refs: provenanceRefs.sort(),
    confidence,
    scrub_status: scrubStatus,
    generalization_status: generalizationStatus,
    compliance_controls: complianceControls.sort(),
    notes: entry.notes || "",
    findings,
  };
}

function analyzeDonorReuse(input, options = {}) {
  const matrix = normalizeMatrix(input || {});
  const entries = matrix.entries.map(validateEntry).sort((a, b) => a.id.localeCompare(b.id));
  const findings = entries.flatMap((entry) => entry.findings).sort((a, b) => `${a.severity}:${a.code}:${a.entry_id}`.localeCompare(`${b.severity}:${b.code}:${b.entry_id}`));
  const failures = findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.donor_reuse_matrix_report",
    schema_version: 1,
    source: {
      matrix: options.matrixPath || "coord/.runtime/requirements/donor-reuse-matrix.json",
    },
    allowed: {
      reuse_decisions: Array.from(REUSE_DECISIONS).sort(),
      scrub_statuses: Array.from(SCRUB_STATUSES).sort(),
      generalization_statuses: Array.from(GENERALIZATION_STATUSES).sort(),
      confidence: Array.from(CONFIDENCE).sort(),
    },
    entries: entries.map(({ findings: _findings, ...entry }) => entry),
    findings,
    summary: {
      entries: entries.length,
      findings: findings.length,
      failures,
      reusable_patterns: entries.filter((entry) => entry.reuse_decision === "reuse_pattern").length,
      unsafe_reuse: findings.filter((finding) => finding.code.startsWith("unsafe-reuse")).length,
    },
    ok: failures === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Donor/Legacy Reuse Matrix");
  lines.push("");
  lines.push(`Entries: ${report.summary.entries}`);
  lines.push(`Reusable patterns: ${report.summary.reusable_patterns}`);
  lines.push(`Unsafe reuse findings: ${report.summary.unsafe_reuse}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push("");
  lines.push("## Entries");
  for (const entry of report.entries) {
    const label = entry.control_pattern ? ` - ${entry.control_pattern}` : "";
    lines.push(`- ${entry.id}: ${entry.reuse_decision || "missing-decision"}${label}`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.entry_id}: ${finding.code} - ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    matrix: "coord/.runtime/requirements/donor-reuse-matrix.json",
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
    if (["--dir", "--matrix", "--output"].includes(arg)) {
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
    log(`requirements-donor-reuse: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-donor-reuse [--dir <root>] [--matrix <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const matrixPath = path.resolve(root, parsed.options.matrix);
  if (!fsImpl.existsSync(matrixPath)) {
    log(`requirements-donor-reuse: matrix not found: ${parsed.options.matrix}`);
    return { code: 1 };
  }
  let matrix;
  try {
    matrix = JSON.parse(fsImpl.readFileSync(matrixPath, "utf8"));
  } catch (err) {
    log(`requirements-donor-reuse: malformed JSON in matrix ${parsed.options.matrix}: ${err.message}`);
    return { code: 1 };
  }
  const report = analyzeDonorReuse(matrix, { matrixPath: parsed.options.matrix });
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
  REUSE_DECISIONS,
  analyzeDonorReuse,
  normalizeDecision,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
