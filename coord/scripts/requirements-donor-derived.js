#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SENSITIVE_MARKERS = [
  /\bcustomer[_ -]?name\b/i,
  /\bclient[_ -]?name\b/i,
  /\bsecret\b/i,
  /\bapi[_ -]?key\b/i,
  /\bpassword\b/i,
  /\bpatient[_ -]?name\b/i,
];

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeInventory(input) {
  if (Array.isArray(input)) return { sources: input };
  return {
    kind: input.kind || "concord.requirements.donor_source_inventory",
    schema_version: input.schema_version || 1,
    sources: Array.isArray(input.sources) ? input.sources : [],
  };
}

function sourceId(source, index) {
  return String(source.id || `DONOR-SRC-${String(index + 1).padStart(3, "0")}`);
}

function entryText(value) {
  return JSON.stringify(value || {}).toLowerCase();
}

function containsSensitiveMarker(value) {
  const text = entryText(value);
  return SENSITIVE_MARKERS.some((pattern) => pattern.test(text));
}

function analyzeSource(source, index) {
  const id = sourceId(source, index);
  const findings = [];
  const sourceRefs = asList(source.source_refs || source.source_ref || source.paths || source.path);
  const confidence = normalize(source.confidence || "candidate");
  const concepts = asList(source.generalized_concepts || source.concepts || source.product_concepts).sort();
  const requirements = asList(source.requirement_candidates || source.requirements).sort();
  const implementationEvidence = asList(source.implementation_evidence || source.evidence_refs || source.evidence).sort();
  const residue = asList(source.customer_specific_residue || source.customer_specific_markers || source.residue).sort();
  const scrubStatus = normalize(source.scrub_status || (residue.length > 0 ? "needs_scrub" : "not_applicable"));
  const proposedTickets = (Array.isArray(source.proposed_tickets) ? source.proposed_tickets : [])
    .map((ticket, ticketIndex) => ({
      id: ticket.id || `${id}-T${String(ticketIndex + 1).padStart(2, "0")}`,
      title: ticket.title || "Generalize donor-derived product capability",
      repo: ticket.repo || "X",
      type: ticket.type || "feature",
      pri: ticket.pri || ticket.priority || "P2",
      description: ticket.description || "",
      provenance_refs: asList(ticket.provenance_refs || ticket.source_refs || sourceRefs).sort(),
      confidence: normalize(ticket.confidence || confidence),
      dry_run: true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (sourceRefs.length === 0) {
    findings.push({
      severity: "fail",
      code: "missing-source-ref",
      source_id: id,
      message: "Donor source has no source_ref/source_refs/path citation.",
    });
  }
  if (concepts.length === 0 && requirements.length === 0) {
    findings.push({
      severity: "warning",
      code: "no-generalized-concept",
      source_id: id,
      message: "Donor source has no generalized concept or requirement candidate.",
    });
  }
  if (implementationEvidence.length === 0) {
    findings.push({
      severity: "warning",
      code: "missing-implementation-evidence",
      source_id: id,
      message: "Donor source has no implementation evidence reference.",
    });
  }
  if (residue.length > 0 && scrubStatus !== "scrubbed" && scrubStatus !== "private_pointer_only") {
    findings.push({
      severity: "fail",
      code: "customer-specific-residue-needs-scrub",
      source_id: id,
      message: "Customer-specific residue is present without scrubbed/private_pointer_only status.",
    });
  }
  if (containsSensitiveMarker(source)) {
    findings.push({
      severity: "fail",
      code: "sensitive-marker-present",
      source_id: id,
      message: "Donor inventory contains a sensitive marker; use scrubbed text or private:// pointers.",
    });
  }
  for (const ticket of proposedTickets) {
    if (ticket.provenance_refs.length === 0) {
      findings.push({
        severity: "fail",
        code: "ticket-missing-provenance",
        source_id: id,
        ticket_id: ticket.id,
        message: "Dry-run derived backlog proposal has no provenance reference.",
      });
    }
  }

  return {
    id,
    source_refs: sourceRefs.sort(),
    confidence,
    scrub_status: scrubStatus,
    generalized_concepts: concepts,
    requirement_candidates: requirements,
    implementation_evidence: implementationEvidence,
    customer_specific_residue: residue,
    proposed_tickets: proposedTickets,
    findings,
  };
}

function analyzeDonorDerived(input, options = {}) {
  const inventory = normalizeInventory(input || {});
  const sources = inventory.sources.map(analyzeSource).sort((a, b) => a.id.localeCompare(b.id));
  const findings = sources
    .flatMap((source) => source.findings)
    .sort((a, b) => `${a.severity}:${a.code}:${a.source_id}:${a.ticket_id || ""}`.localeCompare(`${b.severity}:${b.code}:${b.source_id}:${b.ticket_id || ""}`));
  const failures = findings.filter((finding) => finding.severity === "fail").length;
  const proposedTickets = sources.flatMap((source) => source.proposed_tickets);
  return {
    kind: "concord.requirements.donor_to_product_analysis",
    schema_version: 1,
    source: {
      inventory: options.inventoryPath || "coord/.runtime/requirements/donor-source-inventory.json",
    },
    safety_model: {
      mode: "read_only_dry_run",
      mutation_path: "Derived backlog proposals are dry-run only until accepted by a governed synthesizer ticket.",
      public_boundary: "Use scrubbed summaries or private:// pointers for customer-specific donor material.",
    },
    sources: sources.map(({ findings: _findings, ...source }) => source),
    generalized_concepts: Array.from(new Set(sources.flatMap((source) => source.generalized_concepts))).sort(),
    requirement_candidates: Array.from(new Set(sources.flatMap((source) => source.requirement_candidates))).sort(),
    implementation_evidence: Array.from(new Set(sources.flatMap((source) => source.implementation_evidence))).sort(),
    customer_specific_residue: sources
      .filter((source) => source.customer_specific_residue.length > 0)
      .map((source) => ({ source_id: source.id, residue: source.customer_specific_residue })),
    proposed_tickets: proposedTickets,
    findings,
    summary: {
      sources: sources.length,
      generalized_concepts: Array.from(new Set(sources.flatMap((source) => source.generalized_concepts))).length,
      requirement_candidates: Array.from(new Set(sources.flatMap((source) => source.requirement_candidates))).length,
      implementation_evidence: Array.from(new Set(sources.flatMap((source) => source.implementation_evidence))).length,
      customer_specific_residue: sources.filter((source) => source.customer_specific_residue.length > 0).length,
      proposed_tickets: proposedTickets.length,
      findings: findings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Donor-To-Derived Product Analysis");
  lines.push("");
  lines.push(`Sources: ${report.summary.sources}`);
  lines.push(`Generalized concepts: ${report.summary.generalized_concepts}`);
  lines.push(`Requirement candidates: ${report.summary.requirement_candidates}`);
  lines.push(`Dry-run proposed tickets: ${report.summary.proposed_tickets}`);
  lines.push(`Customer-specific residue sources: ${report.summary.customer_specific_residue}`);
  lines.push("");
  lines.push("## Proposed Tickets");
  if (report.proposed_tickets.length === 0) lines.push("None.");
  for (const ticket of report.proposed_tickets) {
    lines.push(`- ${ticket.pri} ${ticket.type} ${ticket.repo}: ${ticket.title} (${ticket.confidence})`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.source_id}: ${finding.code} - ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    inventory: "coord/.runtime/requirements/donor-source-inventory.json",
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
    if (["--dir", "--inventory", "--output"].includes(arg)) {
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
    log(`requirements-donor-derived: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-donor-derived [--dir <root>] [--inventory <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const inventoryPath = path.resolve(root, parsed.options.inventory);
  if (!fs.existsSync(inventoryPath)) {
    log(`requirements-donor-derived: inventory not found: ${parsed.options.inventory}`);
    return { code: 1 };
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const report = analyzeDonorDerived(inventory, { inventoryPath: parsed.options.inventory });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`, "utf8");
  } else {
    log(body);
  }
  return { code: report.ok ? 0 : 2, report };
}

module.exports = {
  analyzeDonorDerived,
  normalize,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
