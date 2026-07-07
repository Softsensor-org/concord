#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VALID_KINDS = new Set(["donor_repo_review", "urs_discovery", "rendered_ui_qa", "production_mcp_investigation", "adoption_research"]);
const VALID_CONFIDENCE = new Set(["explicit", "inferred", "candidate"]);
const VALID_EVIDENCE = new Set(["manual_review", "screenshot", "runtime_receipt", "deploy_receipt", "data_contract", "security_scan", "attestation", "test_gate"]);

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function validateArtifact(artifact) {
  const findings = [];
  if (!VALID_KINDS.has(normalize(artifact.kind))) {
    findings.push({ severity: "fail", code: "unknown-exploration-kind", message: "Exploration artifact kind is unknown." });
  }
  if (!artifact.source || !artifact.source.uri) {
    findings.push({ severity: "fail", code: "missing-source", message: "Exploration artifact must cite source.uri." });
  }
  const evidence = splitList(artifact.evidence_classes).map(normalize);
  for (const item of evidence) {
    if (!VALID_EVIDENCE.has(item)) {
      findings.push({ severity: "warning", code: "unknown-evidence-class", message: `Evidence class ${item} is not in the promotion vocabulary.` });
    }
  }
  const confidence = normalize(artifact.confidence || "candidate");
  if (!VALID_CONFIDENCE.has(confidence)) {
    findings.push({ severity: "warning", code: "unknown-confidence", message: `Confidence ${confidence} is not explicit, inferred, or candidate.` });
  }
  return { findings, evidence, confidence };
}

function promoteExplorationArtifact(artifact, options = {}) {
  const validation = validateArtifact(artifact || {});
  const proposed = [];
  for (const finding of artifact.findings || []) {
    if (finding.promote === false || finding.rejected === true) continue;
    const ticket = finding.proposed_ticket || {};
    proposed.push({
      title: ticket.title || finding.title || "Promote exploration finding",
      repo: ticket.repo || "X",
      type: ticket.type || "feature",
      pri: ticket.pri || ticket.priority || "P2",
      description: ticket.description || finding.summary || finding.title || "",
      source_evidence: {
        artifact_id: artifact.id || null,
        source_uri: artifact.source && artifact.source.uri,
        evidence_classes: validation.evidence,
        confidence: validation.confidence,
        finding_id: finding.id || null,
      },
      dry_run: true,
    });
  }
  const rejected = (artifact.findings || [])
    .filter((finding) => finding.promote === false || finding.rejected === true)
    .map((finding) => ({
      id: finding.id || null,
      title: finding.title || finding.summary || "",
      reason: finding.rejection_reason || "not promoted",
      authoritative: false,
    }));
  const failures = validation.findings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.exploration.promotion_report",
    schema_version: 1,
    dry_run: options.dryRun !== false,
    exploration: {
      id: artifact.id || null,
      kind: normalize(artifact.kind),
      source: artifact.source || null,
      confidence: validation.confidence,
      evidence_classes: validation.evidence,
    },
    proposed_tickets: proposed,
    unpromoted_findings: rejected,
    findings: validation.findings,
    summary: {
      proposed_tickets: proposed.length,
      unpromoted_findings: rejected.length,
      findings: validation.findings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Exploration Promotion Dry Run");
  lines.push("");
  lines.push(`Exploration: ${report.exploration.id || "unknown"} (${report.exploration.kind || "unknown"})`);
  lines.push(`Source: ${(report.exploration.source && report.exploration.source.uri) || "missing"}`);
  lines.push(`Proposed tickets: ${report.summary.proposed_tickets}`);
  lines.push(`Unpromoted findings: ${report.summary.unpromoted_findings}`);
  lines.push("");
  lines.push("## Proposed Tickets");
  if (report.proposed_tickets.length === 0) lines.push("None.");
  for (const ticket of report.proposed_tickets) {
    lines.push(`- ${ticket.pri} ${ticket.type} ${ticket.repo}: ${ticket.title} (${ticket.source_evidence.confidence})`);
  }
  lines.push("");
  lines.push("## Unpromoted Findings");
  if (report.unpromoted_findings.length === 0) lines.push("None.");
  for (const finding of report.unpromoted_findings) {
    lines.push(`- ${finding.id || "unknown"}: ${finding.title} — ${finding.reason}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { artifact: null, output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--artifact", "--output"].includes(arg)) {
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
    log(`exploration-promote: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: exploration-promote --artifact <exploration.json> [--output <path>] [--json]");
    return { code: 0 };
  }
  if (!parsed.options.artifact) {
    log("exploration-promote: --artifact is required");
    return { code: 1 };
  }
  const cwd = deps.cwd || process.cwd();
  const artifactPath = path.resolve(cwd, parsed.options.artifact);
  if (!fs.existsSync(artifactPath)) {
    log(`exploration-promote: artifact not found: ${parsed.options.artifact}`);
    return { code: 1 };
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const report = promoteExplorationArtifact(artifact);
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  promoteExplorationArtifact,
  renderMarkdown,
  run,
  validateArtifact,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
