#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const linkage = require("./requirements-linkage.js");
const traceability = require("./requirements-traceability.js");

function readJsonIfExists(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function reqMap(registry = {}) {
  const map = new Map();
  for (const req of registry.requirements || []) {
    if (req && req.id) map.set(String(req.id).toUpperCase(), req);
  }
  return map;
}

function blockHash(req) {
  return (req && req.source && req.source.block_hash) || req.block_hash || null;
}

function collectScreens(screenIndex = {}, changedReqs = []) {
  const changedIds = new Set(changedReqs.map((req) => req.requirement_id));
  const changedAnchors = new Set(changedReqs.map((req) => req.current_anchor || req.baseline_anchor).filter(Boolean));
  const impacted = [];
  for (const app of screenIndex.apps || []) {
    for (const screen of app.screens || []) {
      const refs = screen.requirement_refs || [];
      const hit = refs.some((ref) => changedIds.has(String(ref.requirement_id || "").toUpperCase()) || changedAnchors.has(ref.anchor));
      if (hit) {
        impacted.push({
          app: app.app || null,
          screen_id: screen.id,
          route: screen.route || null,
          title: screen.title || "",
          refs,
        });
      }
    }
  }
  return impacted.sort((a, b) => `${a.app || ""}:${a.screen_id}`.localeCompare(`${b.app || ""}:${b.screen_id}`));
}

function planEvidenceForTicket(plans, ticketId) {
  const plan = plans.get(ticketId);
  if (!plan) return { feature_proof: [], repo_gates: [], review_cycles: 0, requirement_closure: [] };
  return {
    feature_proof: plan.feature_proof || [],
    repo_gates: plan.repo_gates || [],
    review_cycles: (plan.self_review_cycles || []).length,
    requirement_closure: plan.requirement_closure || [],
  };
}

function planMap(planRecords) {
  const map = new Map();
  for (const plan of planRecords || []) {
    if (plan && plan.ticket_id) map.set(String(plan.ticket_id), plan);
  }
  return map;
}

function changedRequirements(baseline = {}, current = {}) {
  const before = reqMap(baseline);
  const after = reqMap(current);
  const ids = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
  return ids
    .map((id) => {
      const b = before.get(id);
      const c = after.get(id);
      const baselineHash = blockHash(b);
      const currentHash = blockHash(c);
      let change = null;
      if (!b && c) change = "added";
      else if (b && !c) change = "removed";
      else if (baselineHash !== currentHash) change = "changed";
      if (!change) return null;
      return {
        requirement_id: id,
        change,
        baseline_hash: baselineHash,
        current_hash: currentHash,
        baseline_anchor: b && b.source ? b.source.anchor : null,
        current_anchor: c && c.source ? c.source.anchor : null,
        title: (c && c.title) || (b && b.title) || "",
      };
    })
    .filter(Boolean);
}

function buildStaleImpactReport({ baselineRegistry, currentRegistry, board, planRecords, screenIndex }, options = {}) {
  const changed = changedRequirements(baselineRegistry, currentRegistry);
  const linkageReport = linkage.analyzeLinkage(board || { sections: [] }, currentRegistry || {}, {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const matrix = traceability.buildTraceabilityMatrix(board || { sections: [] }, currentRegistry || {}, planRecords || [], {
    profile: options.profile || "product-engineering",
    lane: options.lane || "full",
  });
  const plans = planMap(planRecords || []);
  const reqToTickets = new Map((matrix.requirement_to_tickets || []).map((row) => [row.requirement_id, row.tickets || []]));
  for (const ticket of linkageReport.tickets || []) {
    for (const reqId of ticket.requirement_ids || []) {
      if (!reqToTickets.has(reqId)) reqToTickets.set(reqId, []);
      reqToTickets.set(reqId, Array.from(new Set(reqToTickets.get(reqId).concat(ticket.ticket_id))).sort());
    }
  }
  const impactedScreens = collectScreens(screenIndex || {}, changed);
  const impacts = changed.map((req) => {
    const tickets = reqToTickets.get(req.requirement_id) || [];
    return {
      ...req,
      impacted_tickets: tickets,
      impacted_screens: impactedScreens
        .filter((screen) => (screen.refs || []).some((ref) => String(ref.requirement_id || "").toUpperCase() === req.requirement_id || ref.anchor === req.current_anchor || ref.anchor === req.baseline_anchor))
        .map((screen) => ({ app: screen.app, screen_id: screen.screen_id, route: screen.route })),
      impacted_evidence: tickets.map((ticketId) => ({ ticket_id: ticketId, ...planEvidenceForTicket(plans, ticketId) })),
      required_action: req.change === "removed" ? "retire-or-waive-linked-work" : "revalidate-linked-work-or-record-waiver",
    };
  });
  return {
    kind: "concord.requirements.stale_impact_report",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      baseline_registry: options.baselinePath || null,
      current_registry: options.currentPath || null,
      board: options.boardPath || "coord/board/tasks.json",
      plans: options.plansDir || "coord/.runtime/plans",
      screen_index: options.screenIndexPath || null,
    },
    changed_requirements: impacts,
    impacted_tickets: Array.from(new Set(impacts.flatMap((impact) => impact.impacted_tickets))).sort(),
    impacted_screens: impactedScreens,
    findings: impacts
      .filter((impact) => impact.impacted_tickets.length === 0 && impact.change !== "added")
      .map((impact) => ({
        severity: "warning",
        code: "changed-requirement-without-linked-ticket",
        requirement_id: impact.requirement_id,
        message: "Changed/removed requirement has no linked ticket in current traceability.",
      })),
    summary: {
      changed_requirements: impacts.length,
      impacted_tickets: Array.from(new Set(impacts.flatMap((impact) => impact.impacted_tickets))).length,
      impacted_screens: impactedScreens.length,
      findings: impacts.filter((impact) => impact.impacted_tickets.length === 0 && impact.change !== "added").length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Stale Impact Report");
  lines.push("");
  lines.push(`Changed requirements: ${report.summary.changed_requirements}`);
  lines.push(`Impacted tickets: ${report.summary.impacted_tickets}`);
  lines.push(`Impacted screens: ${report.summary.impacted_screens}`);
  lines.push("");
  for (const impact of report.changed_requirements) {
    lines.push(`- ${impact.requirement_id} (${impact.change}): tickets=${impact.impacted_tickets.join(", ") || "none"} screens=${impact.impacted_screens.map((screen) => screen.screen_id).join(", ") || "none"} action=${impact.required_action}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    baseline: null,
    current: "coord/.runtime/requirements/registry.json",
    board: "coord/board/tasks.json",
    plans: "coord/.runtime/plans",
    screenIndex: null,
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
    if (["--dir", "--baseline", "--current", "--board", "--plans", "--screen-index", "--output", "--profile", "--lane"].includes(arg)) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
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
    log(`requirements-stale-impact: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-stale-impact --baseline <registry.json> [--current <registry.json>] [--board <tasks.json>] [--plans <dir>] [--screen-index <json>] [--output <path>] [--json]");
    return { code: 0 };
  }
  if (!parsed.options.baseline) {
    log("requirements-stale-impact: --baseline is required");
    return { code: 1 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const baselinePath = path.resolve(root, parsed.options.baseline);
  const currentPath = path.resolve(root, parsed.options.current);
  const boardPath = path.resolve(root, parsed.options.board);
  if (!fs.existsSync(baselinePath)) {
    log(`requirements-stale-impact: baseline not found: ${parsed.options.baseline}`);
    return { code: 1 };
  }
  if (!fs.existsSync(currentPath)) {
    log(`requirements-stale-impact: current registry not found: ${parsed.options.current}`);
    return { code: 1 };
  }
  if (!fs.existsSync(boardPath)) {
    log(`requirements-stale-impact: board not found: ${parsed.options.board}`);
    return { code: 1 };
  }
  const screenIndexPath = parsed.options.screenIndex ? path.resolve(root, parsed.options.screenIndex) : null;
  const report = buildStaleImpactReport({
    baselineRegistry: JSON.parse(fs.readFileSync(baselinePath, "utf8")),
    currentRegistry: JSON.parse(fs.readFileSync(currentPath, "utf8")),
    board: JSON.parse(fs.readFileSync(boardPath, "utf8")),
    planRecords: traceability.listPlanRecords(path.resolve(root, parsed.options.plans)),
    screenIndex: readJsonIfExists(screenIndexPath, {}),
  }, {
    baselinePath: parsed.options.baseline,
    currentPath: parsed.options.current,
    boardPath: parsed.options.board,
    plansDir: parsed.options.plans,
    screenIndexPath: parsed.options.screenIndex,
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
  return { code: 0, report };
}

module.exports = {
  buildStaleImpactReport,
  changedRequirements,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
