"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RISK_ORDER = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);
const HIGH_RISK_BOOTSTRAP_CLASSES = new Set([
  "server_bootstrap_job",
  "derived_data_job",
  "production_repair",
]);

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function normalizeRiskClass(value) {
  const risk = String(value || "").trim().toUpperCase();
  return RISK_ORDER.includes(risk) ? risk : "R1";
}

function riskGte(actual, threshold) {
  return RISK_ORDER.indexOf(normalizeRiskClass(actual)) >= RISK_ORDER.indexOf(normalizeRiskClass(threshold));
}

function isMeaningful(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text) && !/not[- ]?required/i.test(text);
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function loadDefaultPolicy(policyPath = path.join(__dirname, "..", "gates", "track-evidence-policy.json")) {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function classifyRequirementSeverity(requirement, riskClass) {
  const threshold = requirement.blocking_from || "R4";
  return riskGte(riskClass, threshold) ? "blocker" : "advisory";
}

function evidenceText(input = {}) {
  const planState = input.planState || {};
  const receipt = input.receipt || planState.gate_plan || {};
  return [
    ...(planState.repo_gates || []),
    ...(planState.verification_commands || []),
    ...(planState.feature_proof || []),
    ...(planState.requirement_closure || []),
    ...(receipt.required_evidence || []),
    ...(receipt.selected_gates || []).map((entry) => entry.command || entry.id || entry.name || entry),
  ].join("\n");
}

function evaluateTrackRequirements(input = {}) {
  const policy = input.policy || loadDefaultPolicy();
  const trackName = String(input.track?.name || input.track || "development");
  const riskClass = normalizeRiskClass(input.riskClass || input.receipt?.risk_class);
  const trackPolicy = policy.tracks?.[trackName] || policy.tracks?.development || { required: [] };
  const text = evidenceText(input);
  const issues = [];

  for (const requirement of trackPolicy.required || []) {
    const present = trackRequirementSatisfied(requirement.id, input, text);
    if (present) continue;
    const severity = classifyRequirementSeverity(requirement, riskClass);
    issues.push({
      code: `track_evidence_${requirement.id}`,
      severity,
      message: `${trackName} ${riskClass} ticket requires ${requirement.label}.`,
      next_steps: [
        `Record evidence in the plan with coord/scripts/gov update-plan ${input.ticketId || "<ticket>"} --repo-gate "<${requirement.label}>"`,
        `Regenerate the gate-plan receipt with coord/scripts/gov gate-plan ${input.ticketId || "<ticket>"} --write`,
      ],
    });
  }

  return issues;
}

function trackRequirementSatisfied(id, input, text) {
  const planState = input.planState || {};
  if (id === "repo_gate") {
    return toArray(planState.repo_gates).some(isMeaningful);
  }
  if (id === "content_gate_report") {
    return textIncludesAny(text, [/\bcontent[- ]gate\b/i, /\bhtml_validity\b/i, /\bseo_meta\b/i]);
  }
  if (id === "preview_or_skip") {
    return textIncludesAny(text, [/\bpreview\b/i, /\bskip reason\b/i, /\bnot-runtime\b/i]);
  }
  if (id === "infra_report") {
    return textIncludesAny(text, [/\binfra[- ]gate\b/i, /\bswa_config_valid\b/i, /\bdeploy/i]);
  }
  if (id === "deploy_smoke_or_non_runtime") {
    return textIncludesAny(text, [/\bdeploy[-_ ]?smoke\b/i, /\bruntime smoke\b/i, /\bnon[- ]runtime\b/i]);
  }
  if (id === "live_mcp_receipt") {
    return Boolean(planState.live_mcp?.receipt || planState.live_mcp?.receipt_path) ||
      textIncludesAny(text, [/\blive[- ]?mcp receipt\b/i]);
  }
  if (id === "redaction_cleanup") {
    const live = planState.live_mcp || {};
    return isMeaningful(live.redaction) && isMeaningful(live.cleanup);
  }
  if (id === "data_contract") {
    return textIncludesAny(text, [/\bdata[- ]contract\b/i, /\bcertification\b/i, /\bregistry\b/i]);
  }
  if (id === "dq_reconciliation") {
    return textIncludesAny(text, [/\breconcil/i, /\brow[- ]?count\b/i, /\bdata quality\b/i, /\bDQ\b/]);
  }
  return false;
}

function evaluateBootstrapRisk(input = {}) {
  const planState = input.planState || {};
  const risk = planState.bootstrap_risk;
  if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
    return [];
  }
  const workClass = String(risk.startup_work_class || "").trim();
  if (!HIGH_RISK_BOOTSTRAP_CLASSES.has(workClass)) {
    return [{
      code: "bootstrap_risk_advisory",
      severity: "advisory",
      message: `${workClass || "bootstrap"} is advisory unless a track opts into blocking bootstrap evidence.`,
      next_steps: [`Use coord/scripts/gov gate-plan ${input.ticketId || "<ticket>"} --write to record the advisory disposition.`],
    }];
  }

  const issues = [];
  const missing = [];
  const envelope = risk.resource_envelope || {};
  if (!envelope || typeof envelope !== "object" || (!envelope.memory_mb && !envelope.timeout_s && !envelope.batch_size)) {
    missing.push(["resource_envelope", "declare memory_mb, timeout_s, or batch_size"]);
  }
  if (!isMeaningful(risk.data_access_shape) || /\b(unbounded|unknown|all rows|select \*)\b/i.test(String(risk.data_access_shape))) {
    missing.push(["bounded_data_access", "record bounded/streamed/paginated data_access_shape"]);
  }
  if (!isMeaningful(risk.idempotency_strategy) && !isMeaningful(risk.checkpoint_strategy)) {
    missing.push(["idempotency_or_checkpoint", "record idempotency_strategy or checkpoint_strategy"]);
  }
  if (!isMeaningful(risk.verification_signal) || /\/readyz|readiness/i.test(String(risk.verification_signal))) {
    missing.push(["runtime_verification_signal", "record a job-specific verification_signal distinct from /readyz"]);
  }
  if (!isMeaningful(risk.rollback_or_disable)) {
    missing.push(["rollback_or_disable", "record rollback_or_disable"]);
  }
  if (!toArray(risk.observability_requirements).some(isMeaningful)) {
    missing.push(["observability", "record observability_requirements"]);
  }
  if (workClass === "derived_data_job" && !/\b(row[- ]?count|output|before\/after|reconcil)/i.test(String(risk.verification_signal || ""))) {
    missing.push(["output_or_row_count_proof", "record row-count/output proof for the derived-data job"]);
  }

  for (const [code, step] of missing) {
    issues.push({
      code: `bootstrap_${code}`,
      severity: "blocker",
      message: `${workClass} requires ${code.replace(/_/g, " ")} before review/closeout.`,
      next_steps: [
        `Update bootstrap_risk in the canonical plan record: ${step}.`,
        `Regenerate the gate-plan receipt with coord/scripts/gov gate-plan ${input.ticketId || "<ticket>"} --write.`,
      ],
    });
  }
  return issues;
}

function evaluateTrackEvidence(input = {}) {
  const trackIssues = evaluateTrackRequirements(input);
  const bootstrapIssues = evaluateBootstrapRisk(input);
  return {
    ok: [...trackIssues, ...bootstrapIssues].every((issue) => issue.severity !== "blocker"),
    issues: [...trackIssues, ...bootstrapIssues],
  };
}

function requiredEvidenceFor(input = {}) {
  const policy = input.policy || loadDefaultPolicy();
  const trackName = String(input.track?.name || input.track || "development");
  const riskClass = normalizeRiskClass(input.riskClass || input.receipt?.risk_class);
  const requirements = (policy.tracks?.[trackName]?.required || [])
    .filter((requirement) => riskGte(riskClass, requirement.blocking_from || "R4"))
    .map((requirement) => requirement.label);
  const bootstrapRisk = input.planState?.bootstrap_risk;
  const workClass = String(bootstrapRisk?.startup_work_class || "");
  if (HIGH_RISK_BOOTSTRAP_CLASSES.has(workClass)) {
    for (const requirement of policy.bootstrap_overlay?.required || []) {
      requirements.push(requirement.label);
    }
  }
  return Array.from(new Set(requirements));
}

module.exports = {
  HIGH_RISK_BOOTSTRAP_CLASSES,
  RISK_ORDER,
  evaluateBootstrapRisk,
  evaluateTrackEvidence,
  evaluateTrackRequirements,
  loadDefaultPolicy,
  normalizeRiskClass,
  requiredEvidenceFor,
  riskGte,
};
