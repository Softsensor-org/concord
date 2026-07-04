#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DECISION_MODES = new Set(["decides", "recommends", "drafts", "routes", "assembles_evidence", "human_support_only"]);
const PRODUCT_CLASSES = new Set(["decision_support", "regulated", "operational", "clinical", "legal", "review_heavy"]);

function list(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s/-]+/g, "_");
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function analyzeDomainBoundary(manifest = {}, options = {}) {
  const findings = [];
  const profile = {
    product_class: normalize(manifest.product_class || manifest.profile || options.productClass || "decision_support"),
    decision_mode: normalize(manifest.decision_mode || manifest.authority_mode),
    automated_decision_making: Boolean(manifest.automated_decision_making),
    human_reviewer_required: manifest.human_reviewer_required !== false,
  };
  if (!PRODUCT_CLASSES.has(profile.product_class)) {
    findings.push({ severity: "warning", code: "unknown-product-class", message: "Product class is outside the decision-boundary vocabulary.", product_class: profile.product_class });
  }
  if (!DECISION_MODES.has(profile.decision_mode)) {
    findings.push({ severity: "fail", code: "missing-decision-mode", message: "Declare whether the system decides, recommends, drafts, routes, assembles evidence, or only supports a human." });
  }
  if (profile.automated_decision_making && !hasText(manifest.automation_authority_basis)) {
    findings.push({ severity: "fail", code: "missing-automation-authority-basis", message: "Automated decision-making requires an explicit authority basis and review/appeal boundary." });
  }

  const glossaryTerms = list(manifest.glossary_terms || manifest.ontology_terms);
  if (glossaryTerms.length === 0) {
    findings.push({ severity: "fail", code: "missing-glossary", message: "Decision-support requirements need a glossary/domain ontology for terms that drive behavior." });
  }
  for (const term of glossaryTerms) {
    if (!hasText(term.term || term.id || term.name) || !hasText(term.definition)) {
      findings.push({ severity: "warning", code: "weak-glossary-term", term: term.term || term.id || term.name || "", message: "Glossary terms should include term/name and definition." });
    }
    if (list(term.source_refs || term.citations).length === 0) {
      findings.push({ severity: "warning", code: "glossary-term-missing-source", term: term.term || term.id || term.name || "", message: "Glossary term has no source citation." });
    }
  }

  const authorityBoundaries = list(manifest.authority_boundaries);
  if (authorityBoundaries.length === 0) {
    findings.push({ severity: "fail", code: "missing-authority-boundary", message: "Declare human/system/AI authority boundaries for decision-support behavior." });
  }
  for (const boundary of authorityBoundaries) {
    const mode = normalize(boundary.mode || boundary.decision_mode);
    if (!DECISION_MODES.has(mode)) {
      findings.push({ severity: "fail", code: "unknown-authority-mode", boundary: boundary.id || boundary.workflow || "", mode, message: "Authority boundary uses an unknown decision mode." });
    }
    if (!hasText(boundary.human_owner || boundary.reviewer || boundary.accountable_role)) {
      findings.push({ severity: "warning", code: "authority-boundary-missing-human-owner", boundary: boundary.id || boundary.workflow || "", message: "Authority boundary should identify the accountable human role." });
    }
    if (list(boundary.source_refs || boundary.citations).length === 0) {
      findings.push({ severity: "warning", code: "authority-boundary-missing-source", boundary: boundary.id || boundary.workflow || "", message: "Authority boundary should cite source evidence." });
    }
  }

  const sourceEvidence = list(manifest.source_evidence || manifest.citations);
  if (sourceEvidence.length === 0) {
    findings.push({ severity: "fail", code: "missing-source-evidence", message: "Protocol requires source evidence or citations for decision-support requirements." });
  }
  const missingDocuments = list(manifest.missing_documents);
  const contradictions = list(manifest.contradictions);
  if (missingDocuments.length === 0 && contradictions.length === 0 && !manifest.no_missing_documents_or_contradictions) {
    findings.push({ severity: "warning", code: "missing-document-contradiction-review-absent", message: "Declare missing documents/contradictions or explicitly state none were found." });
  }

  const workflows = list(manifest.investigation_workflows || manifest.reviewer_workflows);
  if (workflows.length === 0) {
    findings.push({ severity: "fail", code: "missing-investigation-workflow", message: "Decision-support systems need reviewer/operator investigation workflows." });
  }
  for (const workflow of workflows) {
    if (!hasText(workflow.name || workflow.id) || list(workflow.steps).length === 0) {
      findings.push({ severity: "warning", code: "weak-investigation-workflow", workflow: workflow.name || workflow.id || "", message: "Investigation workflow should include a name/id and ordered steps." });
    }
    if (!hasText(workflow.escalation || workflow.stop_condition || workflow.review_exit)) {
      findings.push({ severity: "warning", code: "investigation-workflow-missing-exit", workflow: workflow.name || workflow.id || "", message: "Investigation workflow should identify escalation, stop condition, or review exit." });
    }
  }

  const text = JSON.stringify(manifest).toLowerCase();
  for (const marker of ["patient_name", "customer_name", "secret_key", "api_key", "password"]) {
    if (text.includes(marker)) {
      findings.push({ severity: "fail", code: "public-cut-sensitive-marker", marker, message: `Manifest contains sensitive marker ${marker}; use private pointers or scrubbed values.` });
    }
  }

  const sortedFindings = findings.sort((a, b) => `${a.severity}:${a.code}:${a.term || a.boundary || a.workflow || ""}`.localeCompare(`${b.severity}:${b.code}:${b.term || b.boundary || b.workflow || ""}`));
  return {
    kind: "concord.requirements.domain_boundary_report",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      manifest: options.manifestPath || "coord/.runtime/requirements/domain-boundary.json",
    },
    vocabulary: {
      product_classes: Array.from(PRODUCT_CLASSES).sort(),
      decision_modes: Array.from(DECISION_MODES).sort(),
    },
    profile,
    coverage: {
      glossary_terms: glossaryTerms.length,
      authority_boundaries: authorityBoundaries.length,
      source_evidence: sourceEvidence.length,
      missing_documents: missingDocuments.length,
      contradictions: contradictions.length,
      investigation_workflows: workflows.length,
    },
    findings: sortedFindings,
    summary: {
      findings: sortedFindings.length,
      failures: sortedFindings.filter((finding) => finding.severity === "fail").length,
    },
    ok: sortedFindings.every((finding) => finding.severity !== "fail"),
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Domain Boundary Report");
  lines.push("");
  lines.push(`Decision mode: ${report.profile.decision_mode || "missing"}`);
  lines.push(`Glossary terms: ${report.coverage.glossary_terms}`);
  lines.push(`Authority boundaries: ${report.coverage.authority_boundaries}`);
  lines.push(`Investigation workflows: ${report.coverage.investigation_workflows}`);
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) lines.push(`- ${finding.severity.toUpperCase()}: ${finding.code} - ${finding.message}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { dir: process.cwd(), manifest: "coord/.runtime/requirements/domain-boundary.json", output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--dir", "--manifest", "--output"].includes(arg)) {
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
    log(`requirements-domain-boundary: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-domain-boundary [--dir <root>] [--manifest <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const manifestPath = path.resolve(root, parsed.options.manifest);
  if (!fs.existsSync(manifestPath)) {
    log(`requirements-domain-boundary: manifest not found: ${parsed.options.manifest}`);
    return { code: 1 };
  }
  const report = analyzeDomainBoundary(JSON.parse(fs.readFileSync(manifestPath, "utf8")), {
    manifestPath: parsed.options.manifest,
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
  DECISION_MODES,
  analyzeDomainBoundary,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
