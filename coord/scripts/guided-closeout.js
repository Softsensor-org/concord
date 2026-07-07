"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT, "coord");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function meaningful(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text) && !/^not[- ]?required$/i.test(text);
}

function recordedDisposition(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function findTicket(board, ticketId) {
  for (const section of board.sections || []) {
    for (const row of section.rows || []) {
      if (row.ID === ticketId) return row;
    }
  }
  return null;
}

function planPath(ticketId, root = ROOT) {
  return path.join(root, "coord", ".runtime", "plans", `${ticketId}.json`);
}

function readPlan(ticketId, root = ROOT) {
  return readJson(planPath(ticketId, root), {});
}

function splitRequirementClosure(plan) {
  const fields = {};
  for (const line of toArray(plan.requirement_closure)) {
    const text = String(line || "").trim();
    const match = text.match(/^(?:TODO:\s*)?([^:]+):\s*(.*)$/i);
    if (!match) continue;
    fields[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return fields;
}

function cycleIsComplete(cycle) {
  const risks = toArray(cycle?.risks).filter(meaningful);
  return meaningful(cycle?.lens) &&
    meaningful(cycle?.diff) &&
    risks.length >= 2 &&
    meaningful(cycle?.findings) &&
    meaningful(cycle?.verification) &&
    meaningful(cycle?.verdict);
}

function gatePlanPresent(plan) {
  return Boolean(plan.gate_plan || plan.gatePlan || plan.gate_plan_receipt);
}

function businessContextDispositionPresent(plan) {
  const text = [
    ...toArray(plan.change_summary),
    ...toArray(plan.critical_invariants),
    ...toArray(plan.requirement_closure),
    JSON.stringify(plan.context_pack_ack || {}),
  ].join("\n");
  return Boolean(
    plan.business_context_disposition ||
    plan.context_pack_ack?.business_context ||
    plan.context_pack_ack?.decision ||
    /\bbusiness-context\s+(?:investigation|status|approval|approved|waiver|waived)\s*:/i.test(text) ||
    /\bdecision\s+(?:status|investigation)\s*:/i.test(text)
  );
}

function buildGuidedCloseoutReport(input = {}) {
  const root = input.root || ROOT;
  const ticketId = input.ticketId;
  if (!ticketId) throw new Error("guided-closeout requires a ticket id");
  const board = input.board || readJson(path.join(root, "coord", "board", "tasks.json"), {});
  const row = input.row || findTicket(board, ticketId) || {};
  const plan = input.plan || readPlan(ticketId, root);
  const closure = splitRequirementClosure(plan);
  const checks = [];

  function add(id, ok, message, command, severity = "blocker") {
    checks.push({
      id,
      ok: Boolean(ok),
      severity: ok ? "ok" : severity,
      message,
      command: ok ? null : command,
    });
  }

  add(
    "plan_record",
    Boolean(plan && Object.keys(plan).length),
    "canonical plan record exists",
    `coord/scripts/gov plan ${ticketId} --seed`
  );
  add(
    "review_cycles",
    toArray(plan.self_review_cycles).length >= 3 && toArray(plan.self_review_cycles).every(cycleIsComplete),
    "three structured review cycles with concrete risks are recorded",
    `coord/scripts/gov set-review-cycles ${ticketId} --review-cycle "lens=contract; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass" --review-cycle "lens=security; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass" --review-cycle "lens=tests; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass"`
  );
  add(
    "repo_gates",
    toArray(plan.repo_gates).some(recordedDisposition),
    "repo gate evidence is recorded",
    `coord/scripts/gov update-plan ${ticketId} --repo-gate "<command and outcome>"`
  );
  add(
    "requirement_closure",
    meaningful(closure["ticket ask"]) && meaningful(closure.implemented) && /complete|incomplete/i.test(closure["closeout verdict"] || ""),
    "ticket ask, implemented work, and closeout verdict are recorded",
    `coord/scripts/gov set-requirement-closure ${ticketId} --ticket-ask "<ask>" --implemented "<implemented>" --not-implemented "none" --deferred-to "none" --closeout-verdict complete`
  );
  add(
    "feature_proof",
    toArray(plan.feature_proof).some((entry) => /^path:|^symbol:/i.test(String(entry || "").trim()) && meaningful(entry)),
    "feature proof cites a path or symbol that must exist at closeout",
    `coord/scripts/gov add-feature-proof ${ticketId} --proof-path <path>`
  );
  add(
    "gate_plan",
    gatePlanPresent(plan),
    "gate-plan receipt has been generated after evidence changes",
    `coord/scripts/gov gate-plan ${ticketId} --write`
  );
  add(
    "business_context_disposition",
    businessContextDispositionPresent(plan),
    "business-context or decision disposition is recorded when relevant",
    `coord/scripts/gov update-plan ${ticketId} --summary "<business context/decision disposition>"`,
    "advisory"
  );

  const blockers = checks.filter((check) => !check.ok && check.severity === "blocker");
  const advisories = checks.filter((check) => !check.ok && check.severity !== "blocker");
  return {
    kind: "concord.guided_closeout",
    schema_version: 1,
    ticket_id: ticketId,
    status: row.Status || "unknown",
    ready: blockers.length === 0,
    blockers,
    advisories,
    checks,
    next_commands: [...blockers, ...advisories].map((check) => check.command).filter(Boolean),
  };
}

function renderGuidedCloseout(report) {
  const lines = [
    "# Guided Closeout",
    "",
    `Ticket: ${report.ticket_id}`,
    `Ready: ${report.ready ? "yes" : "no"}`,
    "",
    "## Checks",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? "PASS" : check.severity.toUpperCase()}: ${check.id} - ${check.message}`);
    if (!check.ok && check.command) lines.push(`  Fix: \`${check.command}\``);
  }
  return `${lines.join("\n")}\n`;
}

function writeRuntimeReceipt(report, root = ROOT) {
  const dir = path.join(root, "coord", ".runtime", "closeout-guides");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${report.ticket_id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
}

function guidedCloseoutCommand(ticketId, options = {}) {
  const report = buildGuidedCloseoutReport({ ticketId, root: options.root });
  if (options.write) {
    report.receipt_path = path.relative(options.root || ROOT, writeRuntimeReceipt(report, options.root)).replace(/\\/g, "/");
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderGuidedCloseout(report));
  }
  return report;
}

module.exports = {
  buildGuidedCloseoutReport,
  businessContextDispositionPresent,
  guidedCloseoutCommand,
  renderGuidedCloseout,
  writeRuntimeReceipt,
};
