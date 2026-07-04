#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const linkage = require("./requirements-linkage.js");

function readJsonIfExists(filePath, fallback, fsImpl = fs) {
  if (!filePath || !fsImpl.existsSync(filePath)) return fallback;
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
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

function planByTicket(records) {
  const map = new Map();
  for (const record of records) {
    if (record && record.ticket_id) map.set(String(record.ticket_id), record);
  }
  return map;
}

function hasMeaningfulEvidence(plan) {
  if (!plan) return false;
  const proofs = (plan.feature_proof || []).filter((entry) => entry && !/^TODO:/i.test(String(entry)));
  const gates = (plan.repo_gates || []).filter((entry) => entry && !/^TODO:/i.test(String(entry)));
  const reviews = (plan.self_review_cycles || []).filter((entry) => entry && entry.verdict);
  return proofs.length > 0 || gates.length > 0 || reviews.length > 0;
}

function isWaiverOnly(plan, boardWaiver) {
  const closure = (plan && plan.requirement_closure) || [];
  const closureText = closure.join("\n").toLowerCase();
  return Boolean(boardWaiver) || /\bwaiver\s*:/.test(closureText) || /\bwaived\b/.test(closureText) || /\bdeviation\b/.test(closureText);
}

function registryRequirementIds(registry) {
  return (registry.requirements || [])
    .map((req) => String(req.id || "").toUpperCase())
    .filter(Boolean)
    .sort();
}

function registryRequirementMap(registry) {
  const map = new Map();
  for (const req of registry.requirements || []) {
    if (req && req.id) map.set(String(req.id).toUpperCase(), req);
  }
  return map;
}

function normalizePolicyValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
}

function validationGradeRequired(req = {}) {
  const risk = normalizePolicyValue(req.classification && req.classification.risk_class);
  const criticality = normalizePolicyValue(req.classification && req.classification.criticality);
  return ["high", "critical", "regulated"].includes(risk) || /critical|regulated|gxp|data_integrity|security/.test(criticality);
}

function traceabilityState({ req, tickets, plans, boardWaivers }) {
  if (tickets.length === 0) return "missing-ticket-link";
  if (tickets.every((ticketId) => isWaiverOnly(plans.get(ticketId), boardWaivers[ticketId]))) return "waived";
  const coverageStatus = normalizePolicyValue(req && req.coverage && req.coverage.status);
  if (coverageStatus === "partial") return "partial";
  if (coverageStatus === "satisfied") return "validation-grade";
  const hasEvidence = tickets.some((ticketId) => hasMeaningfulEvidence(plans.get(ticketId)));
  if (hasEvidence && validationGradeRequired(req)) return "partial";
  if (hasEvidence) return "implemented";
  return "planned";
}

function buildTraceabilityMatrix(board, registry = {}, planRecords = [], options = {}) {
  const linkageReport = linkage.analyzeLinkage(board, registry, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const plans = planByTicket(planRecords);
  const boardWaivers = board.waiver_index || {};
  const registryIds = registryRequirementIds(registry);
  const reqs = registryRequirementMap(registry);
  const linkedIds = Array.from(
    new Set(linkageReport.tickets.flatMap((ticket) => ticket.requirement_ids || []))
  ).sort();
  const requirementIds = Array.from(new Set([...registryIds, ...linkedIds])).sort();

  const requirementToTickets = requirementIds.map((id) => {
    const tickets = linkageReport.tickets
      .filter((ticket) => ticket.requirement_ids.includes(id))
      .map((ticket) => ticket.ticket_id)
      .sort();
    return {
      requirement_id: id,
      tickets,
      status: traceabilityState({ req: reqs.get(id), tickets, plans, boardWaivers }),
    };
  });

  const ticketToRequirements = linkageReport.tickets
    .filter((ticket) => ticket.requirement_ids.length > 0)
    .map((ticket) => ({
      ticket_id: ticket.ticket_id,
      requirement_ids: ticket.requirement_ids,
      explicit_requirement_ids: ticket.explicit_requirement_ids,
      inferred_requirement_ids: ticket.inferred_requirement_ids,
      expected_evidence_classes: ticket.expected_evidence_classes,
      external_refs: ticket.external_refs,
    }));

  const requirementEvidence = requirementToTickets.map((row) => {
    const evidence = [];
    for (const ticketId of row.tickets) {
      const plan = plans.get(ticketId);
      if (!plan) {
        evidence.push({ ticket_id: ticketId, feature_proof: [], repo_gates: [], review_cycles: 0, waiver: Boolean(boardWaivers[ticketId]) });
        continue;
      }
      evidence.push({
        ticket_id: ticketId,
        feature_proof: plan.feature_proof || [],
        repo_gates: plan.repo_gates || [],
        review_cycles: (plan.self_review_cycles || []).length,
        waiver: Boolean(boardWaivers[ticketId]) || isWaiverOnly(plan, null),
      });
    }
    return { requirement_id: row.requirement_id, evidence };
  });

  const missingLinks = [
    ...requirementToTickets
      .filter((row) => row.tickets.length === 0)
      .map((row) => ({ kind: "requirement-without-ticket", requirement_id: row.requirement_id })),
    ...linkageReport.findings
      .filter((finding) => finding.code === "missing-requirement-link")
      .map((finding) => ({ kind: "ticket-without-requirement", ticket_id: finding.ticket_id, severity: finding.severity })),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const waiverOnly = requirementToTickets
    .filter((row) => row.tickets.length > 0)
    .filter((row) =>
      row.tickets.every((ticketId) => isWaiverOnly(plans.get(ticketId), boardWaivers[ticketId]))
    )
    .map((row) => ({ requirement_id: row.requirement_id, tickets: row.tickets }));

  const closedWithWeakEvidence = linkageReport.tickets
    .filter((ticket) => ticket.status === "done" && ticket.requirement_ids.length > 0)
    .filter((ticket) => !hasMeaningfulEvidence(plans.get(ticket.ticket_id)))
    .map((ticket) => ({
      ticket_id: ticket.ticket_id,
      requirement_ids: ticket.requirement_ids,
      reason: "done ticket has requirement link but no meaningful plan evidence found",
    }));

  const findings = linkageReport.findings;
  return {
    kind: "concord.requirements.traceability_matrix",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      board: options.boardPath || "coord/board/tasks.json",
      registry: options.registryPath || null,
      plans: options.plansDir || "coord/.runtime/plans",
    },
    requirement_to_tickets: requirementToTickets,
    ticket_to_requirements: ticketToRequirements,
    requirement_evidence: requirementEvidence,
    missing_links: missingLinks,
    waiver_only: waiverOnly,
    closed_with_weak_evidence: closedWithWeakEvidence,
    findings,
    summary: {
      requirements: requirementIds.length,
      linked_requirements: requirementToTickets.filter((row) => row.tickets.length > 0).length,
      linked_tickets: ticketToRequirements.length,
      missing_links: missingLinks.length,
      waiver_only: waiverOnly.length,
      closed_with_weak_evidence: closedWithWeakEvidence.length,
      findings: findings.length,
    },
  };
}

function renderMarkdown(matrix) {
  const lines = [];
  lines.push("# Requirements Traceability Matrix");
  lines.push("");
  lines.push(`Requirements: ${matrix.summary.requirements}`);
  lines.push(`Linked requirements: ${matrix.summary.linked_requirements}`);
  lines.push(`Linked tickets: ${matrix.summary.linked_tickets}`);
  lines.push(`Missing links: ${matrix.summary.missing_links}`);
  lines.push(`Closed with weak evidence: ${matrix.summary.closed_with_weak_evidence}`);
  lines.push("");
  lines.push("## Requirement To Tickets");
  for (const row of matrix.requirement_to_tickets) {
    lines.push(`- ${row.requirement_id}: ${row.tickets.length ? row.tickets.join(", ") : "NO TICKET"}`);
  }
  lines.push("");
  lines.push("## Missing Links");
  if (matrix.missing_links.length === 0) lines.push("None.");
  for (const item of matrix.missing_links) {
    lines.push(`- ${item.kind}: ${item.requirement_id || item.ticket_id}`);
  }
  lines.push("");
  lines.push("## Closed With Weak Evidence");
  if (matrix.closed_with_weak_evidence.length === 0) lines.push("None.");
  for (const item of matrix.closed_with_weak_evidence) {
    lines.push(`- ${item.ticket_id}: ${item.requirement_ids.join(", ")} — ${item.reason}`);
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
    log(`requirements-traceability: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-traceability [--dir <root>] [--board <path>] [--registry <path>] [--plans <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fsImpl.existsSync(boardPath)) {
    log(`requirements-traceability: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  const registryPath = parsed.options.registry ? path.resolve(root, parsed.options.registry) : null;
  const plansDir = path.resolve(root, parsed.options.plans);
  let board;
  try {
    board = JSON.parse(fsImpl.readFileSync(boardPath, "utf8"));
  } catch (err) {
    log(`requirements-traceability: malformed JSON in board ${parsed.options.board}: ${err.message}`);
    return { code: 1 };
  }
  let registry;
  try {
    registry = readJsonIfExists(registryPath, {}, fsImpl);
  } catch (err) {
    log(`requirements-traceability: malformed JSON in registry ${parsed.options.registry}: ${err.message}`);
    return { code: 1 };
  }
  const plans = listPlanRecords(plansDir);
  const matrix = buildTraceabilityMatrix(board, registry, plans, {
    boardPath: parsed.options.board,
    registryPath: parsed.options.registry,
    plansDir: parsed.options.plans,
    profile: parsed.options.profile,
    lane: parsed.options.lane,
  });
  const body = parsed.options.json ? JSON.stringify(matrix, null, 2) : renderMarkdown(matrix);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, matrix };
}

module.exports = {
  buildTraceabilityMatrix,
  listPlanRecords,
  renderMarkdown,
  traceabilityState,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
