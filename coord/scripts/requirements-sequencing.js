#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const linkage = require("./requirements-linkage.js");
const traceability = require("./requirements-traceability.js");
const evidencePolicy = require("./requirements-evidence-policy.js");

const WAVE_ORDER = [
  "inspection_blockers",
  "validation_governance_chain",
  "partial_closure_cleanup",
  "operational_readiness_controls",
  "documentation_protocol_closure",
  "implementation_backlog",
];

const WAVE_LABELS = {
  inspection_blockers: "P0 inspection blockers",
  validation_governance_chain: "Validation-governance chain",
  partial_closure_cleanup: "Partial-closure cleanup",
  operational_readiness_controls: "Operational-readiness controls",
  documentation_protocol_closure: "Documentation/protocol closure",
  implementation_backlog: "Feature-value backlog",
};

const PRIORITY_RANK = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3],
]);

function readJsonIfExists(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeValue(value) {
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

function rowByTicket(board) {
  const map = new Map();
  for (const row of collectTicketRows(board)) map.set(String(row.ID), row);
  return map;
}

function requirementMap(registry) {
  const map = new Map();
  for (const req of registry.requirements || []) {
    if (req && req.id) map.set(String(req.id).toUpperCase(), req);
  }
  return map;
}

function linkedTicketsFromRequirement(req) {
  return uniqueSorted(
    []
      .concat(splitList(req.coverage && req.coverage.ticket_ids))
      .concat(splitList(req.ticket_ids))
      .concat(
        (req.links || [])
          .filter((link) => String(link.kind || link.to_kind || "ticket") === "ticket")
          .map((link) => link.id || link.ticket_id || link.to_id)
      )
      .map((id) => String(id || "").trim())
  );
}

function requirementToTicketMap(registry, linkageReport) {
  const map = new Map();
  for (const ticket of linkageReport.tickets || []) {
    for (const requirementId of ticket.requirement_ids || []) {
      if (!map.has(requirementId)) map.set(requirementId, new Set());
      map.get(requirementId).add(ticket.ticket_id);
    }
  }
  for (const req of registry.requirements || []) {
    const id = String(req.id || "").toUpperCase();
    if (!id) continue;
    if (!map.has(id)) map.set(id, new Set());
    for (const ticketId of linkedTicketsFromRequirement(req)) map.get(id).add(ticketId);
  }
  return new Map(Array.from(map.entries()).map(([id, ids]) => [id, Array.from(ids).sort()]));
}

function ticketToRequirementMap(reqToTickets) {
  const map = new Map();
  for (const [requirementId, tickets] of reqToTickets.entries()) {
    for (const ticketId of tickets) {
      if (!map.has(ticketId)) map.set(ticketId, []);
      map.get(ticketId).push(requirementId);
    }
  }
  for (const [ticketId, reqs] of map.entries()) map.set(ticketId, reqs.sort());
  return map;
}

function dependencyIds(row) {
  return splitList(row && row["Depends On"]).map((id) => id.toUpperCase());
}

function dependencyDepth(ticketId, rows, seen = new Set()) {
  if (seen.has(ticketId)) return 0;
  seen.add(ticketId);
  const row = rows.get(ticketId);
  if (!row) return 0;
  const deps = dependencyIds(row).filter((id) => rows.has(id));
  if (deps.length === 0) return 0;
  return 1 + Math.max(...deps.map((id) => dependencyDepth(id, rows, new Set(seen))));
}

function openDependencyIds(row, rows) {
  return dependencyIds(row).filter((id) => {
    const dep = rows.get(id);
    return dep && !["done", "superseded"].includes(String(dep.Status || ""));
  });
}

function priorityRank(priority) {
  return PRIORITY_RANK.has(String(priority || "")) ? PRIORITY_RANK.get(String(priority || "")) : 9;
}

function requirementRisk(req) {
  return normalizeValue(req.classification && req.classification.risk_class);
}

function requirementCriticality(req) {
  return normalizeValue(req.classification && req.classification.criticality);
}

function requirementCoverageStatus(req) {
  return normalizeValue(req.coverage && req.coverage.status);
}

function requiredEvidence(req, options) {
  return evidencePolicy.defaultRequiredEvidence(req, {
    ...options,
    profile: "product-engineering",
    lane: "full",
  }).map(evidencePolicy.normalizeEvidenceClass);
}

function hasControlledDocuments(req) {
  const coverage = req.coverage || {};
  return Boolean(
    (Array.isArray(coverage.controlled_documents) && coverage.controlled_documents.length > 0) ||
      coverage.controlled_document ||
      (Array.isArray(req.controlled_documents) && req.controlled_documents.length > 0) ||
      req.controlled_document
  );
}

function isInspectionBlocker(req, policyRow, ticketRows) {
  const risk = requirementRisk(req);
  const criticality = requirementCriticality(req);
  const classification = req.classification || {};
  const coverage = req.coverage || {};
  const inspectionFlag = Boolean(
    req.inspection_blocker ||
      classification.inspection_blocker ||
      coverage.inspection_blocker ||
      splitList(classification.gxp_scope).some((item) => /gxp|regulat|audit|inspection|data_integrity/.test(item))
  );
  const highRisk = ["regulated", "critical", "high"].includes(risk) || /compliance|gxp|safety|data_integrity|security/.test(criticality);
  const hasP0Ticket = ticketRows.some((row) => String(row.Pri || "") === "P0");
  const missingValidationEvidence = policyRow && (policyRow.missing_evidence || []).length > 0;
  return inspectionFlag || (highRisk && (hasP0Ticket || missingValidationEvidence || ticketRows.length === 0));
}

function requirementReasons(req, policyRow, traceRow, ticketRows, options = {}) {
  const risk = requirementRisk(req) || "low";
  const criticality = requirementCriticality(req) || "ordinary_product";
  const coverageStatus = requirementCoverageStatus(req);
  const required = requiredEvidence(req, options);
  const missing = (policyRow && policyRow.missing_evidence) || [];
  const reasons = [];
  if (isInspectionBlocker(req, policyRow, ticketRows)) {
    reasons.push(`inspection/compliance risk comes first (${risk}/${criticality})`);
  }
  if (required.includes("attestation") || risk === "regulated" || risk === "critical") {
    reasons.push("validation governance evidence is required before ordinary feature sequencing");
  }
  if (["partial", "defect", "stale", "deviation", "waived"].includes(coverageStatus) || (traceRow && ["partial", "waived"].includes(traceRow.status))) {
    reasons.push(`closure is ${coverageStatus || traceRow.status}; cleanup must precede new feature-value work`);
  }
  if (required.some((item) => ["runtime_receipt", "deploy_receipt", "data_contract", "security_scan"].includes(item))) {
    reasons.push("runtime/data/security evidence is required for operational readiness");
  }
  if (required.includes("controlled_document") || hasControlledDocuments(req)) {
    reasons.push("controlled-document or validation-protocol closure is part of the acceptance path");
  }
  if (missing.length > 0) reasons.push(`missing evidence: ${missing.join(", ")}`);
  if (ticketRows.length === 0) reasons.push("no linked ticket exists; create or link governed work before claiming closure");
  return uniqueSorted(reasons);
}

function classifyRequirement(req, policyRow, traceRow, ticketRows, options = {}) {
  const required = requiredEvidence(req, options);
  const coverageStatus = requirementCoverageStatus(req);
  if (isInspectionBlocker(req, policyRow, ticketRows)) return "inspection_blockers";
  if (required.includes("attestation") || ["regulated", "critical"].includes(requirementRisk(req))) return "validation_governance_chain";
  if (["partial", "defect", "stale", "deviation", "waived"].includes(coverageStatus) || (traceRow && ["partial", "waived"].includes(traceRow.status))) {
    return "partial_closure_cleanup";
  }
  if (required.some((item) => ["runtime_receipt", "deploy_receipt", "data_contract", "security_scan"].includes(item))) return "operational_readiness_controls";
  if (required.includes("controlled_document") || hasControlledDocuments(req)) return "documentation_protocol_closure";
  return "implementation_backlog";
}

function buildSequencingPlan(board, registry = {}, planRecords = [], options = {}) {
  const rows = rowByTicket(board);
  const linkageReport = linkage.analyzeLinkage(board, registry, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const traceMatrix = traceability.buildTraceabilityMatrix(board, registry, planRecords, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const policyReport = evidencePolicy.analyzeEvidencePolicy(board, registry, planRecords, {
    profile: "product-engineering",
    lane: "full",
  });
  const reqs = requirementMap(registry);
  const reqToTickets = requirementToTicketMap(registry, linkageReport);
  const ticketToReqs = ticketToRequirementMap(reqToTickets);
  const traceByReq = new Map((traceMatrix.requirement_to_tickets || []).map((row) => [row.requirement_id, row]));
  const policyByReq = new Map((policyReport.requirements || []).map((row) => [row.requirement_id, row]));

  const requirementAnalyses = Array.from(reqs.entries()).map(([requirementId, req]) => {
    const ticketIds = reqToTickets.get(requirementId) || [];
    const ticketRows = ticketIds.map((ticketId) => rows.get(ticketId)).filter(Boolean);
    const traceRow = traceByReq.get(requirementId) || null;
    const policyRow = policyByReq.get(requirementId) || null;
    const wave = classifyRequirement(req, policyRow, traceRow, ticketRows, options);
    return {
      requirement_id: requirementId,
      wave,
      risk_class: requirementRisk(req) || "low",
      criticality: requirementCriticality(req) || "ordinary_product",
      closure_status: requirementCoverageStatus(req) || (traceRow && traceRow.status) || "unknown",
      ticket_ids: ticketIds,
      required_evidence: policyRow ? policyRow.required_evidence : requiredEvidence(req, options),
      missing_evidence: policyRow ? policyRow.missing_evidence : [],
      reasons: requirementReasons(req, policyRow, traceRow, ticketRows, options),
    };
  });

  const reqAnalysisById = new Map(requirementAnalyses.map((item) => [item.requirement_id, item]));
  const entries = [];
  for (const row of collectTicketRows(board)) {
    if (["done", "superseded"].includes(String(row.Status || ""))) continue;
    const requirementIds = ticketToReqs.get(String(row.ID)) || [];
    const analyses = requirementIds.map((id) => reqAnalysisById.get(id)).filter(Boolean);
    const wave = analyses.length
      ? analyses.map((analysis) => analysis.wave).sort((a, b) => WAVE_ORDER.indexOf(a) - WAVE_ORDER.indexOf(b))[0]
      : "implementation_backlog";
    const missingEvidence = uniqueSorted(analyses.flatMap((analysis) => analysis.missing_evidence || []));
    const reasons = uniqueSorted(
      analyses.flatMap((analysis) => analysis.reasons || []).concat(
        requirementIds.length === 0 ? ["ticket has no linked requirement; it is feature-value work until linked to risk-bearing requirements"] : []
      )
    );
    entries.push({
      ticket_id: String(row.ID),
      requirement_ids: requirementIds,
      wave,
      feature_priority: row.Pri || "",
      status: row.Status || "",
      dependency_chain: dependencyIds(row),
      blocked_by_open: openDependencyIds(row, rows),
      dependency_depth: dependencyDepth(String(row.ID), rows),
      missing_evidence: missingEvidence,
      reasons,
      risk_order_explanation: wave === "implementation_backlog" || reasons.length === 0
        ? "No compliance-risk driver found; sequence by normal feature priority and dependencies."
        : reasons[0],
    });
  }

  for (const analysis of requirementAnalyses.filter((item) => item.ticket_ids.length === 0)) {
    entries.push({
      ticket_id: null,
      requirement_ids: [analysis.requirement_id],
      wave: analysis.wave,
      feature_priority: null,
      status: "missing-ticket-link",
      dependency_chain: [],
      blocked_by_open: [],
      dependency_depth: 0,
      missing_evidence: analysis.missing_evidence,
      reasons: analysis.reasons,
      risk_order_explanation: "Create or link a governed ticket before this requirement can be sequenced to implementation.",
      recommended_action: `Create governed ticket for ${analysis.requirement_id}`,
    });
  }

  entries.sort((a, b) => {
    const waveDiff = WAVE_ORDER.indexOf(a.wave) - WAVE_ORDER.indexOf(b.wave);
    if (waveDiff) return waveDiff;
    const blockedDiff = a.blocked_by_open.length - b.blocked_by_open.length;
    if (blockedDiff) return blockedDiff;
    const depthDiff = a.dependency_depth - b.dependency_depth;
    if (depthDiff) return depthDiff;
    const priDiff = priorityRank(a.feature_priority) - priorityRank(b.feature_priority);
    if (priDiff) return priDiff;
    return String(a.ticket_id || a.requirement_ids.join(",")).localeCompare(String(b.ticket_id || b.requirement_ids.join(",")));
  });

  const waves = WAVE_ORDER.map((id) => ({
    id,
    label: WAVE_LABELS[id],
    items: entries.filter((entry) => entry.wave === id),
  })).filter((wave) => wave.items.length > 0);

  return {
    kind: "concord.requirements.sequencing_plan",
    schema_version: 1,
    dry_run: true,
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
    source: {
      board: options.boardPath || "coord/board/tasks.json",
      registry: options.registryPath || null,
      plans: options.plansDir || "coord/.runtime/plans",
    },
    sequencing_policy: {
      mode: "risk_before_feature_value",
      wave_order: WAVE_ORDER,
      mutation_boundary: "This command proposes order only; board priority/dependency changes require a governed ticket.",
    },
    waves,
    requirement_analysis: requirementAnalyses.sort((a, b) => a.requirement_id.localeCompare(b.requirement_id)),
    summary: {
      waves: waves.length,
      items: entries.length,
      tickets: entries.filter((entry) => entry.ticket_id).length,
      requirements_without_tickets: entries.filter((entry) => !entry.ticket_id).length,
      inspection_blockers: entries.filter((entry) => entry.wave === "inspection_blockers").length,
      operational_readiness_controls: entries.filter((entry) => entry.wave === "operational_readiness_controls").length,
      documentation_protocol_closure: entries.filter((entry) => entry.wave === "documentation_protocol_closure").length,
    },
  };
}

function renderMarkdown(plan) {
  const lines = [];
  lines.push("# Requirements Sequencing Plan");
  lines.push("");
  lines.push(`Mode: ${plan.sequencing_policy.mode}`);
  lines.push(`Dry run: ${plan.dry_run}`);
  lines.push(`Items: ${plan.summary.items}`);
  lines.push("");
  for (const wave of plan.waves) {
    lines.push(`## ${wave.label}`);
    for (const item of wave.items) {
      const subject = item.ticket_id || item.requirement_ids.join(", ");
      const deps = item.blocked_by_open.length ? `; blocked by ${item.blocked_by_open.join(", ")}` : "";
      lines.push(`- ${subject}: ${item.risk_order_explanation}${deps}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
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
    log(`requirements-sequencing: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-sequencing [--dir <root>] [--board <path>] --registry <path> [--plans <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fs.existsSync(boardPath)) {
    log(`requirements-sequencing: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  if (!parsed.options.registry) {
    log("requirements-sequencing: --registry is required");
    return { code: 1 };
  }
  const registryPath = path.resolve(root, parsed.options.registry);
  if (!fs.existsSync(registryPath)) {
    log(`requirements-sequencing: registry not found: ${parsed.options.registry}`);
    return { code: 1 };
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const registry = readJsonIfExists(registryPath, {});
  const plansDir = path.resolve(root, parsed.options.plans);
  const planRecords = traceability.listPlanRecords(plansDir);
  const plan = buildSequencingPlan(board, registry, planRecords, {
    boardPath: parsed.options.board,
    registryPath: parsed.options.registry,
    plansDir: parsed.options.plans,
    profile: parsed.options.profile,
    lane: parsed.options.lane,
  });
  const body = parsed.options.json ? JSON.stringify(plan, null, 2) : renderMarkdown(plan);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, plan };
}

module.exports = {
  WAVE_ORDER,
  buildSequencingPlan,
  classifyRequirement,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
