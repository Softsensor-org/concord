#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const linkage = require("./requirements-linkage.js");

const EVIDENCE_CLASSES = new Set([
  "test_gate",
  "manual_review",
  "runtime_receipt",
  "deploy_receipt",
  "data_contract",
  "screenshot",
  "security_scan",
  "waiver",
  "attestation",
  "controlled_document",
]);

const RISK_CLASSES = new Set(["low", "medium", "high", "critical", "regulated"]);
const CRITICALITY_CLASSES = new Set([
  "ordinary_product",
  "standard",
  "business_critical",
  "safety_critical",
  "compliance_critical",
  "gxp_regulatory",
  "security",
  "data_integrity",
  "operational",
  "ux",
]);

const WAIVER_CLASSIFICATIONS = new Set(["product_deferral", "regulated_deviation", "accepted_risk"]);
const CONTROLLED_DOCUMENT_TYPES = new Set([
  "sop_template",
  "validation_protocol",
  "iq_oq_pq",
  "training_artifact",
  "role_authorization",
  "operating_procedure",
]);
const CONTROLLED_DOCUMENT_STATUSES = new Set([
  "vendor_template",
  "draft",
  "site_approved",
  "customer_approved",
  "effective",
  "retired",
]);

const DIMENSION_EVIDENCE = [
  ["security_controls", "security_scan"],
  ["apis", "runtime_receipt"],
  ["routes", "runtime_receipt"],
  ["events", "runtime_receipt"],
  ["data_entities", "data_contract"],
  ["screens", "screenshot"],
  ["controlled_documents", "controlled_document"],
];

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEvidenceClass(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "deployment_receipt") return "deploy_receipt";
  if (normalized === "visual_proof" || normalized === "visual") return "screenshot";
  if (normalized === "data_contract_proof") return "data_contract";
  if (normalized === "signed_attestation") return "attestation";
  return normalized;
}

function normalizePolicyValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function collectTicketRows(board) {
  const rows = [];
  for (const section of board.sections || []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (row && row.ID) rows.push(row);
    }
  }
  return rows.sort((a, b) => String(a.ID).localeCompare(String(b.ID)));
}

function planByTicket(records) {
  const map = new Map();
  for (const record of records || []) {
    if (record && record.ticket_id) map.set(String(record.ticket_id), record);
  }
  return map;
}

function listPlanRecords(plansDir) {
  if (!fs.existsSync(plansDir)) return [];
  return fs
    .readdirSync(plansDir)
    .filter((name) => /^[A-Z]+-\d+\.json$/.test(name))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(plansDir, name), "utf8"));
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
}

function requirementRisk(req) {
  return normalizePolicyValue((req.classification && req.classification.risk_class) || "low");
}

function requirementCriticality(req) {
  return normalizePolicyValue((req.classification && req.classification.criticality) || "ordinary_product");
}

function explicitEvidenceClasses(req) {
  return uniqueSorted(splitList(req.evidence_class_required || req.evidence_classes).concat(
    splitList(req.dimensions && req.dimensions.evidence_classes)
  ).map(normalizeEvidenceClass));
}

function dimensionEvidenceClasses(req) {
  const dimensions = req.dimensions || {};
  const classes = [];
  for (const [dimension, evidenceClass] of DIMENSION_EVIDENCE) {
    if (splitList(dimensions[dimension]).length > 0) classes.push(evidenceClass);
  }
  return uniqueSorted(classes);
}

function defaultRequiredEvidence(req, options = {}) {
  const risk = requirementRisk(req);
  const criticality = requirementCriticality(req);
  const profile = String(options.profile || "").toLowerCase();
  const lane = String(options.lane || "").toLowerCase();
  const explicit = explicitEvidenceClasses(req);
  if (explicit.length > 0) return explicit;

  if (risk === "regulated" || profile === "regulated" || lane === "regulated") {
    return uniqueSorted(["test_gate", "manual_review", "attestation"].concat(dimensionEvidenceClasses(req)));
  }
  if (risk === "critical" || criticality.includes("critical")) {
    return uniqueSorted(["test_gate", "manual_review", "attestation"].concat(dimensionEvidenceClasses(req)));
  }
  if (risk === "high") {
    return uniqueSorted(["test_gate", "manual_review"].concat(dimensionEvidenceClasses(req)));
  }
  if (risk === "medium") return ["test_gate", "manual_review"];
  return ["test_gate"];
}

function evidenceClassesFromPlan(plan) {
  const classes = [];
  if (!plan) return classes;
  if ((plan.repo_gates || []).length > 0) classes.push("test_gate");
  if ((plan.self_review_cycles || []).length > 0) classes.push("manual_review");
  const text = [
    ...(plan.feature_proof || []),
    ...(plan.repo_gates || []),
    ...(plan.requirement_closure || []),
  ].join("\n").toLowerCase();
  const patterns = [
    ["runtime_receipt", /\bruntime|receipt|observed|endpoint|deployed system\b/],
    ["deploy_receipt", /\bdeploy|deployment|image|task-def|release artifact\b/],
    ["data_contract", /\bdata[-_ ]?contract|migration|backfill|schema|row count\b/],
    ["screenshot", /\bscreenshot|visual|playwright|rendered\b/],
    ["security_scan", /\bsecurity scan|secret scan|sbom|dependency scan|trivy|snyk|npm audit\b/],
    ["attestation", /\battestation|signed|signature|conformance\b/],
    ["controlled_document", /\bcontrolled document|sop|validation protocol|iq\/oq\/pq\b/],
    ["waiver", /\bwaiver|waived|deviation\b/],
  ];
  for (const [evidenceClass, pattern] of patterns) {
    if (pattern.test(text)) classes.push(evidenceClass);
  }
  return uniqueSorted(classes);
}

function evidenceClassesFromTicket(ticket) {
  return uniqueSorted((ticket.expected_evidence_classes || []).map(normalizeEvidenceClass));
}

function controlledDocumentRecords(req) {
  const coverage = (req && req.coverage) || {};
  return []
    .concat(Array.isArray(coverage.controlled_documents) ? coverage.controlled_documents : [])
    .concat(Array.isArray(req.controlled_documents) ? req.controlled_documents : [])
    .concat(coverage.controlled_document ? [coverage.controlled_document] : [])
    .concat(req.controlled_document ? [req.controlled_document] : []);
}

function controlledDocumentIsApproved(record) {
  const status = normalizePolicyValue(record.status || record.approval_status);
  return ["site_approved", "customer_approved", "effective"].includes(status);
}

function evidenceClassesFromRequirement(req) {
  return controlledDocumentRecords(req).some(controlledDocumentIsApproved) ? ["controlled_document"] : [];
}

function requirementCoverageStatus(req) {
  return normalizePolicyValue(req.coverage && req.coverage.status);
}

function closureStrength({ req, tickets, observedEvidence, missingEvidence }) {
  const coverageStatus = requirementCoverageStatus(req);
  if (coverageStatus === "waived" || coverageStatus === "deviation") return coverageStatus;
  if (tickets.length === 0) return "unlinked";
  if (coverageStatus === "partial") return "partial";
  if (coverageStatus === "satisfied" && missingEvidence.length === 0) return "validation_grade";
  if (observedEvidence.length > 0 && missingEvidence.length > 0) return "partial";
  if (observedEvidence.length > 0) return "implemented";
  return "planned";
}

function waiverRecord(req) {
  const coverage = (req && req.coverage) || {};
  return coverage.waiver || coverage.deviation || req.waiver || req.deviation || null;
}

function hasWaiverReference(req) {
  const coverage = (req && req.coverage) || {};
  return Boolean(coverage.waiver_ref || coverage.deviation_ref || req.waiver_ref || req.deviation_ref);
}

function validateWaiverMetadata(req, requirementId, options = {}) {
  const findings = [];
  const coverageStatus = requirementCoverageStatus(req);
  if (coverageStatus !== "waived" && coverageStatus !== "deviation") return findings;
  const record = waiverRecord(req);
  if (!record) {
    if (!hasWaiverReference(req)) {
      findings.push({
        severity: "fail",
        code: "missing-waiver-record",
        requirement_id: requirementId,
        message: "Waived/deviation requirement must include waiver/deviation metadata or a waiver/deviation reference.",
      });
    }
    return findings;
  }
  const requiredFields = [
    ["reason", record.reason],
    ["risk", record.risk],
    ["approver", record.approver],
    ["approval_date", record.approval_date || record.approved_at],
    ["compensating_control", record.compensating_control],
  ];
  for (const [field, value] of requiredFields) {
    if (!String(value || "").trim()) {
      findings.push({
        severity: "fail",
        code: "waiver-missing-required-field",
        requirement_id: requirementId,
        field,
        message: `Waiver/deviation metadata is missing ${field}.`,
      });
    }
  }
  const classification = normalizePolicyValue(record.classification || record.type);
  if (!WAIVER_CLASSIFICATIONS.has(classification)) {
    findings.push({
      severity: "fail",
      code: "unknown-waiver-classification",
      requirement_id: requirementId,
      classification,
      message: `Waiver/deviation classification ${classification || "<missing>"} is not in the shared vocabulary.`,
    });
  }
  if (!String(record.expiry || record.expires_at || record.revisit_condition || "").trim()) {
    findings.push({
      severity: "fail",
      code: "waiver-missing-revisit-condition",
      requirement_id: requirementId,
      message: "Waiver/deviation metadata needs an expiry/expires_at or revisit_condition.",
    });
  }
  if (splitList(record.evidence_refs || record.evidence || record.evidence_ref).length === 0) {
    findings.push({
      severity: "fail",
      code: "waiver-missing-evidence",
      requirement_id: requirementId,
      message: "Waiver/deviation metadata must cite approval or risk-acceptance evidence.",
    });
  }
  const expiresAt = record.expires_at || record.expiry;
  if (expiresAt) {
    const asOf = Date.parse(options.asOfUtc || new Date().toISOString());
    const expiry = Date.parse(expiresAt);
    if (Number.isFinite(asOf) && Number.isFinite(expiry) && expiry < asOf) {
      findings.push({
        severity: "fail",
        code: "waiver-expired",
        requirement_id: requirementId,
        expires_at: expiresAt,
        message: `Waiver/deviation expired at ${expiresAt}.`,
      });
    }
  }
  return findings;
}

function validateControlledDocuments(req, requirementId) {
  const findings = [];
  for (const [index, record] of controlledDocumentRecords(req).entries()) {
    const documentId = record.id || `controlled-document-${index + 1}`;
    const type = normalizePolicyValue(record.type || record.kind);
    const status = normalizePolicyValue(record.status || record.approval_status);
    for (const [field, value] of [
      ["doc_ref", record.doc_ref || record.ref],
      ["owner", record.owner || record.approver || record.approval_owner],
      ["version", record.version],
    ]) {
      if (!String(value || "").trim()) {
        findings.push({
          severity: "fail",
          code: "controlled-document-missing-field",
          requirement_id: requirementId,
          document_id: documentId,
          field,
          message: `Controlled-document evidence is missing ${field}.`,
        });
      }
    }
    if (!CONTROLLED_DOCUMENT_TYPES.has(type)) {
      findings.push({
        severity: "fail",
        code: "unknown-controlled-document-type",
        requirement_id: requirementId,
        document_id: documentId,
        type,
        message: `Controlled-document type ${type || "<missing>"} is not in the shared vocabulary.`,
      });
    }
    if (!CONTROLLED_DOCUMENT_STATUSES.has(status)) {
      findings.push({
        severity: "fail",
        code: "unknown-controlled-document-status",
        requirement_id: requirementId,
        document_id: documentId,
        status,
        message: `Controlled-document status ${status || "<missing>"} is not in the shared vocabulary.`,
      });
    }
    if (status === "vendor_template") {
      findings.push({
        severity: "warning",
        code: "vendor-template-not-site-approved",
        requirement_id: requirementId,
        document_id: documentId,
        message: "Vendor template evidence is not equivalent to a site/customer-approved controlled document.",
      });
    }
    if (splitList(record.evidence_refs || record.evidence || record.evidence_ref).length === 0) {
      findings.push({
        severity: "fail",
        code: "controlled-document-missing-evidence",
        requirement_id: requirementId,
        document_id: documentId,
        message: "Controlled-document evidence must cite the document/protocol/training approval artifact.",
      });
    }
  }
  return findings;
}

function buildRequirementIndex(registry) {
  const map = new Map();
  for (const req of registry.requirements || []) {
    if (req && req.id) map.set(String(req.id).toUpperCase(), req);
  }
  return map;
}

function rowByTicket(board) {
  const map = new Map();
  for (const row of collectTicketRows(board)) map.set(String(row.ID), row);
  return map;
}

function analyzeEvidencePolicy(board, registry = {}, planRecords = [], options = {}) {
  const plans = planByTicket(planRecords);
  const rows = rowByTicket(board);
  const reqs = buildRequirementIndex(registry);
  const linkageReport = linkage.analyzeLinkage(board, registry, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const ticketsByRequirement = new Map();
  for (const ticket of linkageReport.tickets) {
    for (const requirementId of ticket.requirement_ids || []) {
      if (!ticketsByRequirement.has(requirementId)) ticketsByRequirement.set(requirementId, []);
      ticketsByRequirement.get(requirementId).push(ticket);
    }
  }

  const findings = [];
  const requirements = Array.from(reqs.values())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((req) => {
      const id = String(req.id).toUpperCase();
      const tickets = (ticketsByRequirement.get(id) || []).sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
      const actual = [];
      const declared = explicitEvidenceClasses(req);
      for (const ticket of tickets) {
        actual.push(...evidenceClassesFromTicket(ticket));
        actual.push(...evidenceClassesFromPlan(plans.get(ticket.ticket_id)));
      }
      actual.push(...evidenceClassesFromRequirement(req));
      const observedEvidence = uniqueSorted(actual);
      const requiredEvidence = defaultRequiredEvidence(req, options);
      const missingEvidence = requiredEvidence.filter((evidenceClass) => !observedEvidence.includes(evidenceClass));
      const unknownEvidence = uniqueSorted([...declared, ...observedEvidence].filter((evidenceClass) => !EVIDENCE_CLASSES.has(evidenceClass)));
      const severity = riskSeverity(req, options);
      const risk = requirementRisk(req);
      const criticality = requirementCriticality(req);
      const closure = closureStrength({ req, tickets, observedEvidence, missingEvidence });

      for (const evidenceClass of unknownEvidence) {
        findings.push({
          severity: "fail",
          code: "unknown-evidence-class",
          requirement_id: id,
          evidence_class: evidenceClass,
          message: `Evidence class ${evidenceClass} is not in the shared vocabulary.`,
        });
      }
      if (tickets.length === 0) {
        findings.push({
          severity: severity === "fail" ? "fail" : "warning",
          code: "requirement-without-ticket",
          requirement_id: id,
          message: "Requirement has no linked ticket, so evidence coverage cannot be proven.",
        });
      } else if (missingEvidence.length > 0) {
        findings.push({
          severity,
          code: "missing-required-evidence",
          requirement_id: id,
          missing_evidence: missingEvidence,
          message: `Requirement is missing required evidence classes: ${missingEvidence.join(", ")}.`,
        });
      }
      if (!RISK_CLASSES.has(risk)) {
        findings.push({
          severity: "fail",
          code: "unknown-risk-class",
          requirement_id: id,
          risk_class: risk,
          message: `Risk class ${risk} is not in the shared vocabulary.`,
        });
      }
      if (!CRITICALITY_CLASSES.has(criticality)) {
        findings.push({
          severity: "fail",
          code: "unknown-criticality",
          requirement_id: id,
          criticality,
          message: `Criticality ${criticality} is not in the shared vocabulary.`,
        });
      }
      findings.push(...validateWaiverMetadata(req, id, options));
      findings.push(...validateControlledDocuments(req, id));
      return {
        requirement_id: id,
        risk_class: risk,
        criticality,
        closure_strength: closure,
        waiver_or_deviation: coverageStatusIsWaiver(req),
        controlled_documents: controlledDocumentRecords(req).map((record) => ({
          id: record.id || null,
          type: normalizePolicyValue(record.type || record.kind),
          status: normalizePolicyValue(record.status || record.approval_status),
          owner: record.owner || record.approver || record.approval_owner || null,
          doc_ref: record.doc_ref || record.ref || null,
          version: record.version || null,
        })),
        required_evidence: requiredEvidence,
        observed_evidence: observedEvidence,
        missing_evidence: missingEvidence,
        ticket_ids: tickets.map((ticket) => ticket.ticket_id),
      };
    });

  for (const ticket of linkageReport.tickets) {
    for (const evidenceClass of evidenceClassesFromTicket(ticket)) {
      if (!EVIDENCE_CLASSES.has(evidenceClass)) {
        findings.push({
          severity: "fail",
          code: "unknown-ticket-evidence-class",
          ticket_id: ticket.ticket_id,
          evidence_class: evidenceClass,
          message: `Ticket declares unknown evidence class ${evidenceClass}.`,
        });
      }
    }
    if (ticket.requirement_ids.length === 0) continue;
    const row = rows.get(ticket.ticket_id);
    if (row && String(row.Status || "") === "done" && evidenceClassesFromPlan(plans.get(ticket.ticket_id)).length === 0) {
      findings.push({
        severity: "warning",
        code: "done-ticket-without-plan-evidence",
        ticket_id: ticket.ticket_id,
        message: "Done ticket is linked to requirements but has no plan evidence classes.",
      });
    }
  }

  const sortedFindings = findings.sort((a, b) => `${a.severity}:${a.code}:${a.requirement_id || a.ticket_id}`.localeCompare(`${b.severity}:${b.code}:${b.requirement_id || b.ticket_id}`));
  const failures = sortedFindings.filter((finding) => finding.severity === "fail").length;
  return {
    kind: "concord.requirements.evidence_policy",
    schema_version: 1,
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    source: {
      board: options.boardPath || "coord/board/tasks.json",
      registry: options.registryPath || null,
      plans: options.plansDir || "coord/.runtime/plans",
    },
    evidence_classes: Array.from(EVIDENCE_CLASSES).sort(),
    requirements,
    findings: sortedFindings,
    summary: {
      requirements_checked: requirements.length,
      requirements_missing_evidence: requirements.filter((row) => row.missing_evidence.length > 0).length,
      findings: sortedFindings.length,
      failures,
    },
    ok: failures === 0,
  };
}

function coverageStatusIsWaiver(req) {
  const status = requirementCoverageStatus(req);
  if (status !== "waived" && status !== "deviation") return null;
  const record = waiverRecord(req);
  return {
    status,
    classification: record ? normalizePolicyValue(record.classification || record.type) : null,
    approver: record ? record.approver || null : null,
    expires_at: record ? record.expires_at || record.expiry || null : null,
    revisit_condition: record ? record.revisit_condition || null : null,
    reference: (req.coverage && (req.coverage.waiver_ref || req.coverage.deviation_ref)) || req.waiver_ref || req.deviation_ref || null,
  };
}

function riskSeverity(req, options = {}) {
  const risk = requirementRisk(req);
  const profile = String(options.profile || "").toLowerCase();
  const lane = String(options.lane || "").toLowerCase();
  if (risk === "regulated" || risk === "critical" || profile === "regulated" || lane === "regulated") return "fail";
  if (risk === "high") return "fail";
  if (risk === "medium") return "warning";
  return "info";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Evidence Policy");
  lines.push("");
  lines.push(`Profile: ${report.profile}`);
  lines.push(`Lane: ${report.lane}`);
  lines.push(`Requirements checked: ${report.summary.requirements_checked}`);
  lines.push(`Requirements missing evidence: ${report.summary.requirements_missing_evidence}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push("");
  lines.push("## Requirement Evidence");
  for (const row of report.requirements) {
    lines.push(`- ${row.requirement_id} (${row.risk_class}/${row.criticality}; ${row.closure_strength}): required=${row.required_evidence.join(", ")} observed=${row.observed_evidence.join(", ") || "none"} tickets=${row.ticket_ids.join(", ") || "none"}`);
  }
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.requirement_id || finding.ticket_id}: ${finding.code} - ${finding.message}`);
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
    if (["--dir", "--board", "--registry", "--plans", "--output", "--profile", "--lane"].includes(arg)) {
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
    log(`requirements-evidence-policy: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-evidence-policy [--dir <root>] --registry <path> [--board <path>] [--plans <path>] [--profile <name>] [--lane <name>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fsImpl.existsSync(boardPath)) {
    log(`requirements-evidence-policy: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  if (!parsed.options.registry) {
    log("requirements-evidence-policy: --registry is required");
    return { code: 1 };
  }
  const registryPath = path.resolve(root, parsed.options.registry);
  if (!fsImpl.existsSync(registryPath)) {
    log(`requirements-evidence-policy: registry not found: ${parsed.options.registry}`);
    return { code: 1 };
  }
  let board;
  try {
    board = JSON.parse(fsImpl.readFileSync(boardPath, "utf8"));
  } catch (err) {
    log(`requirements-evidence-policy: malformed JSON in board ${parsed.options.board}: ${err.message}`);
    return { code: 1 };
  }
  let registry;
  try {
    registry = JSON.parse(fsImpl.readFileSync(registryPath, "utf8"));
  } catch (err) {
    log(`requirements-evidence-policy: malformed JSON in registry ${parsed.options.registry}: ${err.message}`);
    return { code: 1 };
  }
  const plansDir = path.resolve(root, parsed.options.plans);
  const plans = listPlanRecords(plansDir);
  const report = analyzeEvidencePolicy(board, registry, plans, {
    boardPath: parsed.options.board,
    registryPath: parsed.options.registry,
    plansDir: parsed.options.plans,
    profile: parsed.options.profile,
    lane: parsed.options.lane,
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
  EVIDENCE_CLASSES,
  CRITICALITY_CLASSES,
  CONTROLLED_DOCUMENT_STATUSES,
  CONTROLLED_DOCUMENT_TYPES,
  RISK_CLASSES,
  WAIVER_CLASSIFICATIONS,
  analyzeEvidencePolicy,
  closureStrength,
  defaultRequiredEvidence,
  evidenceClassesFromPlan,
  evidenceClassesFromRequirement,
  normalizeEvidenceClass,
  renderMarkdown,
  run,
  validateWaiverMetadata,
  validateControlledDocuments,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
