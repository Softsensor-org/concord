"use strict";

const PHASES = [
  {
    id: "exploration",
    label: "Exploration",
    intent: "Capture discovery without pretending the repo is production-ready.",
    required_evidence: ["notes_or_findings", "promotion_path"],
    closeout_expectations: ["mark_assumptions", "promote_to_ticket_before_implementation"],
    minimum_profile: "solo-dev",
  },
  {
    id: "prototype",
    label: "Prototype",
    intent: "Move quickly while preserving decisions, assumptions, and local verification.",
    required_evidence: ["local_gate_or_not_required", "feature_proof", "requirement_closure"],
    closeout_expectations: ["clear_done_summary", "known_limits_recorded"],
    minimum_profile: "solo-dev",
  },
  {
    id: "pilot",
    label: "Pilot",
    intent: "Add user evidence, runtime verification, and adoption blockers.",
    required_evidence: ["repo_gate", "feature_proof", "review_cycles", "requirement_closure", "runtime_or_user_evidence"],
    closeout_expectations: ["pilot_blockers_split", "runtime_or_user_receipt", "followups_recorded"],
    minimum_profile: "product-engineering",
  },
  {
    id: "production",
    label: "Production",
    intent: "Require tests, release proof, rollback, and owner clarity.",
    required_evidence: ["repo_gate", "feature_proof", "review_cycles", "requirement_closure", "landing_evidence", "rollback_or_recovery", "runtime_or_deploy_receipt"],
    closeout_expectations: ["release_or_no_pr_rationale", "owner_clarity", "post_close_followups"],
    minimum_profile: "product-engineering",
  },
  {
    id: "regulated-production",
    label: "Regulated production",
    intent: "Require traceability, approvals, audit evidence, and validation-grade closure.",
    required_evidence: ["traceability", "repo_gate", "feature_proof", "review_cycles", "requirement_closure", "criticality", "evidence_class", "landing_evidence", "rollback_or_recovery", "runtime_or_deploy_receipt", "qa_or_business_signoff_when_required", "deviation_or_waiver_when_applicable"],
    closeout_expectations: ["validation_grade_closure", "controlled_document_or_code_evidence", "audit_trail", "partial_closure_not_laundered_as_satisfied"],
    minimum_profile: "regulated",
  },
];

function phaseById(id) {
  return PHASES.find((phase) => phase.id === id) || null;
}

function includesAll(haystack, needles) {
  return needles.every((item) => haystack.includes(item));
}

function validateStrictness() {
  const pilot = phaseById("pilot").required_evidence;
  const production = phaseById("production").required_evidence;
  const regulated = phaseById("regulated-production").required_evidence;
  return {
    production_extends_pilot: includesAll(production, pilot.filter((item) => item !== "runtime_or_user_evidence")),
    regulated_extends_production: includesAll(regulated, production),
  };
}

function recommendPhase(report) {
  const profile = report.recommended_profile || "";
  const blockers = new Set((report.findings || []).filter((finding) => finding.severity === "blocker").map((finding) => finding.code));
  if (profile === "regulated") return "regulated-production";
  if (profile === "enterprise" || profile === "production-mcp" || profile === "server-bootstrap") return "production";
  if (blockers.has("missing-governance") || blockers.has("missing-board")) return "exploration";
  if (!report.coord_setup || !report.coord_setup.governance || !report.coord_setup.board) return "exploration";
  const hasTests = Boolean(report.commands && report.commands.test && report.commands.test.length > 0);
  const hasRequirements = Boolean(report.requirements && report.requirements.length > 0 && !report.requirements.some((req) => req.likely_stub));
  const productionSignals = new Set(["docker", "compose", "kubernetes", "helm", "terraform"]);
  if ((report.app_signals || []).some((signal) => productionSignals.has(signal)) && hasTests && hasRequirements) return "production";
  if (hasTests && hasRequirements) return "pilot";
  if ((report.package_managers || []).length > 0) return "prototype";
  return "exploration";
}

function phaseDetails(id) {
  return phaseById(id) || phaseById("exploration");
}

function phaseCatalog() {
  return {
    kind: "concord.governance.phase_model",
    schema_version: 1,
    phases: PHASES,
    strictness_checks: validateStrictness(),
  };
}

module.exports = {
  PHASES,
  phaseById,
  phaseCatalog,
  phaseDetails,
  recommendPhase,
  validateStrictness,
};
