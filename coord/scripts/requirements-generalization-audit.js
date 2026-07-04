#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RESIDUE_TYPES = new Set([
  "hardcoded_label",
  "entity_kind",
  "threshold",
  "workflow_shape",
  "vendor_payload",
  "branded_seed_data",
  "terminology",
  "customer_specific_default",
]);

const ABSTRACTIONS = new Set([
  "configuration_pack",
  "terminology_token",
  "adapter",
  "policy",
  "tenant_override",
  "seed_profile",
  "intentional_product_default",
]);

const SCRUB_STATUSES = new Set(["scrubbed", "private_pointer_only", "needs_scrub", "not_applicable"]);

function list(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
}

function findingId(finding, index) {
  return String(finding.id || `GEN-${String(index + 1).padStart(3, "0")}`);
}

function containsSensitiveMarker(value) {
  const text = JSON.stringify(value || {}).toLowerCase();
  return ["customer_name", "client_name", "patient_name", "secret_key", "api_key", "password"].some((marker) => text.includes(marker));
}

function normalizeFindings(input = {}) {
  const findings = Array.isArray(input) ? input : (input.findings || input.generalization_findings || []);
  return findings.map((finding, index) => ({
    id: findingId(finding, index),
    residue_type: normalize(finding.residue_type || finding.type),
    summary: String(finding.summary || finding.title || "").trim(),
    owning_abstraction: normalize(finding.owning_abstraction || finding.abstraction),
    provenance_refs: list(finding.provenance_refs || finding.source_refs || finding.source_ref),
    scrub_status: normalize(finding.scrub_status || "needs_scrub"),
    requirement_ids: list(finding.requirement_ids || finding.requirements).map((id) => id.toUpperCase()),
    followup_ticket: finding.followup_ticket || finding.ticket_id || null,
    branded_sample_allowed: Boolean(finding.branded_sample_allowed),
    intentional_default_rationale: finding.intentional_default_rationale || null,
    proposed_ticket: finding.proposed_ticket || null,
    raw: finding,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function analyzeGeneralizationAudit(input = {}, options = {}) {
  const items = normalizeFindings(input);
  const findings = [];
  const worklist = [];
  for (const item of items) {
    if (!RESIDUE_TYPES.has(item.residue_type)) {
      findings.push({ severity: "fail", code: "unknown-residue-type", finding_id: item.id, residue_type: item.residue_type, message: "Generalization finding uses an unknown residue type." });
    }
    if (!ABSTRACTIONS.has(item.owning_abstraction)) {
      findings.push({ severity: "fail", code: "missing-owning-abstraction", finding_id: item.id, owning_abstraction: item.owning_abstraction, message: "Finding must map to an owning abstraction." });
    }
    if (item.provenance_refs.length === 0) {
      findings.push({ severity: "fail", code: "missing-donor-provenance", finding_id: item.id, message: "Finding must cite donor/legacy provenance by pointer or scrubbed ref." });
    }
    if (!SCRUB_STATUSES.has(item.scrub_status)) {
      findings.push({ severity: "fail", code: "unknown-scrub-status", finding_id: item.id, scrub_status: item.scrub_status, message: "Finding has unknown scrub status." });
    }
    if (item.scrub_status === "needs_scrub") {
      findings.push({ severity: "fail", code: "residue-needs-scrub", finding_id: item.id, message: "Finding still needs scrub before public/product-default use." });
    }
    if (item.owning_abstraction === "intentional_product_default" && !item.intentional_default_rationale) {
      findings.push({ severity: "warning", code: "intentional-default-missing-rationale", finding_id: item.id, message: "Intentional product defaults need rationale." });
    }
    if (item.residue_type === "branded_seed_data" && !item.branded_sample_allowed && item.owning_abstraction !== "seed_profile") {
      findings.push({ severity: "fail", code: "branded-seed-data-leaks-default", finding_id: item.id, message: "Branded seed data must be isolated as a seed profile or explicitly allowed as sample data." });
    }
    if (containsSensitiveMarker(item.raw)) {
      findings.push({ severity: "fail", code: "sensitive-marker-present", finding_id: item.id, message: "Finding contains sensitive marker; use scrubbed/private pointers." });
    }
    if (!item.followup_ticket) {
      worklist.push({
        finding_id: item.id,
        title: item.proposed_ticket && item.proposed_ticket.title ? item.proposed_ticket.title : `Generalize ${item.residue_type}`,
        repo: (item.proposed_ticket && item.proposed_ticket.repo) || "X",
        type: (item.proposed_ticket && item.proposed_ticket.type) || "feature",
        pri: (item.proposed_ticket && (item.proposed_ticket.pri || item.proposed_ticket.priority)) || "P2",
        owning_abstraction: item.owning_abstraction,
        requirement_ids: item.requirement_ids,
        dry_run: true,
      });
    }
  }
  const sortedFindings = findings.sort((a, b) => `${a.severity}:${a.code}:${a.finding_id}`.localeCompare(`${b.severity}:${b.code}:${b.finding_id}`));
  return {
    kind: "concord.requirements.generalization_audit",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      audit: options.auditPath || "coord/.runtime/requirements/generalization-audit.json",
    },
    vocabulary: {
      residue_types: Array.from(RESIDUE_TYPES).sort(),
      owning_abstractions: Array.from(ABSTRACTIONS).sort(),
      scrub_statuses: Array.from(SCRUB_STATUSES).sort(),
    },
    findings_input: items.map(({ raw: _raw, ...item }) => item),
    governed_worklist: worklist.sort((a, b) => a.finding_id.localeCompare(b.finding_id)),
    findings: sortedFindings,
    summary: {
      findings_input: items.length,
      governed_worklist: worklist.length,
      audit_findings: sortedFindings.length,
      failures: sortedFindings.filter((finding) => finding.severity === "fail").length,
    },
    ok: sortedFindings.every((finding) => finding.severity !== "fail"),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Generalization Audit");
  lines.push("");
  lines.push(`Findings: ${report.summary.findings_input}`);
  lines.push(`Governed worklist: ${report.summary.governed_worklist}`);
  lines.push(`Failures: ${report.summary.failures}`);
  lines.push("");
  lines.push("## Governed Worklist");
  if (report.governed_worklist.length === 0) lines.push("None.");
  for (const item of report.governed_worklist) lines.push(`- ${item.pri} ${item.repo}: ${item.title} (${item.owning_abstraction})`);
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) lines.push(`- ${finding.severity.toUpperCase()} ${finding.finding_id}: ${finding.code} - ${finding.message}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { dir: process.cwd(), audit: "coord/.runtime/requirements/generalization-audit.json", output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--audit", "--output"].includes(arg)) {
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
    log(`requirements-generalization-audit: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-generalization-audit [--dir <root>] [--audit <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const auditPath = path.resolve(root, parsed.options.audit);
  if (!fs.existsSync(auditPath)) {
    log(`requirements-generalization-audit: audit not found: ${parsed.options.audit}`);
    return { code: 1 };
  }
  const report = analyzeGeneralizationAudit(JSON.parse(fs.readFileSync(auditPath, "utf8")), {
    auditPath: parsed.options.audit,
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
  ABSTRACTIONS,
  RESIDUE_TYPES,
  analyzeGeneralizationAudit,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
