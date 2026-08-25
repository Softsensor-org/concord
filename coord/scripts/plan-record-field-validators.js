"use strict";

// COORD-594: structured plan-record field validators, extracted from
// plan-records.js under the no-grandfather prodloc policy (the module grew past
// its high-water LOC budget and the policy prefers extraction over a budget
// bump).
//
// Cohesive cluster: the closed vocabularies (allowed-key sets, enum sets) and
// the assertions for the four structured optional plan-record objects —
// context_pack_ack (COORD-141), decision_required, live_mcp (COORD-153) and
// bootstrap_risk (COORD-159) — plus the two shared shape helpers they share.
// They are pure validators: the ONLY collaborator is `fail`, injected so the
// refusal path stays the caller's GovernanceError. Messages, ordering and
// vocabularies are unchanged; assertValidPlanRecord keeps calling them exactly
// as before via the names re-destructured back into the factory closure.
module.exports = function createPlanRecordFieldValidators({ fail }) {

  const CONTEXT_PACK_ACK_ALLOWED_KEYS = new Set([
    "refs",
    "considered",
    "authority",
    "closeout_learning",
    "notes",
  ]);
  const CONTEXT_PACK_ACK_CONSIDERED_KEYS = new Set([
    "active_constraints",
    "adrs",
    "business_rules",
    "conflicts",
    "stale_warnings",
    "open_questions",
  ]);
  const CONTEXT_PACK_ACK_AUTHORITY_KEYS = new Set([
    "constraints",
    "advisory_only",
    "rejected_authority",
  ]);
  const CONTEXT_PACK_ACK_CLOSEOUT_KEYS = new Set([
    "decision",
    "promote",
    "demote",
    "scratch_only",
    "rationale",
  ]);
  const CONTEXT_PACK_ACK_CLOSEOUT_DECISIONS = new Set([
    "promote",
    "demote",
    "scratch-only",
    "mixed",
    "none",
  ]);

  function assertStringArrayOrString(value, fieldName) {
    if (typeof value === "string") {
      return;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return;
    }
    fail(`Plan record context_pack_ack.${fieldName} must be a string or an array of strings.`);
  }

  function assertObjectWithAllowedKeys(value, fieldName, allowedKeys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`Plan record context_pack_ack.${fieldName} must be an object when present.`);
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        fail(`Plan record context_pack_ack.${fieldName} contains unknown field "${key}".`);
      }
    }
  }

  function assertValidContextPackAck(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail('Plan record field "context_pack_ack" must be an object when present.');
    }
    for (const key of Object.keys(value)) {
      if (!CONTEXT_PACK_ACK_ALLOWED_KEYS.has(key)) {
        fail(`Plan record context_pack_ack contains unknown field "${key}".`);
      }
    }
    if (
      value.refs !== undefined &&
      (
        !Array.isArray(value.refs) ||
        value.refs.some((entry) => typeof entry !== "string")
      )
    ) {
      fail("Plan record context_pack_ack.refs must be an array of strings when present.");
    }
    if (value.considered !== undefined) {
      assertObjectWithAllowedKeys(value.considered, "considered", CONTEXT_PACK_ACK_CONSIDERED_KEYS);
      for (const key of Object.keys(value.considered)) {
        assertStringArrayOrString(value.considered[key], `considered.${key}`);
      }
    }
    if (value.authority !== undefined) {
      assertObjectWithAllowedKeys(value.authority, "authority", CONTEXT_PACK_ACK_AUTHORITY_KEYS);
      for (const key of Object.keys(value.authority)) {
        assertStringArrayOrString(value.authority[key], `authority.${key}`);
      }
    }
    if (value.closeout_learning !== undefined) {
      assertObjectWithAllowedKeys(value.closeout_learning, "closeout_learning", CONTEXT_PACK_ACK_CLOSEOUT_KEYS);
      if (
        value.closeout_learning.decision !== undefined &&
        !CONTEXT_PACK_ACK_CLOSEOUT_DECISIONS.has(String(value.closeout_learning.decision))
      ) {
        fail(`Plan record context_pack_ack.closeout_learning.decision must be one of ${[...CONTEXT_PACK_ACK_CLOSEOUT_DECISIONS].join(", ")}.`);
      }
      for (const key of ["promote", "demote", "scratch_only"]) {
        if (
          value.closeout_learning[key] !== undefined &&
          (
            !Array.isArray(value.closeout_learning[key]) ||
            value.closeout_learning[key].some((entry) => typeof entry !== "string")
          )
        ) {
          fail(`Plan record context_pack_ack.closeout_learning.${key} must be an array of strings when present.`);
        }
      }
      if (
        value.closeout_learning.rationale !== undefined &&
        value.closeout_learning.rationale !== null &&
        typeof value.closeout_learning.rationale !== "string"
      ) {
        fail("Plan record context_pack_ack.closeout_learning.rationale must be a string or null when present.");
      }
    }
    if (value.notes !== undefined) {
      assertStringArrayOrString(value.notes, "notes");
    }
  }

  const DECISION_REQUIRED_STATUSES = new Set(["required", "not-required", "waived", "investigating", "deferred"]);
  const DECISION_REQUIRED_ALLOWED_KEYS = new Set([
    "required",
    "status",
    "reason",
    "risk_class",
    "waiver",
    "owner",
    "expires",
    "adr_refs",
  ]);

  function assertValidDecisionRequired(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail('Plan record field "decision_required" must be an object when present.');
    }
    for (const key of Object.keys(value)) {
      if (!DECISION_REQUIRED_ALLOWED_KEYS.has(key)) {
        fail(`Plan record decision_required contains unknown field "${key}".`);
      }
    }
    if (value.required !== undefined && typeof value.required !== "boolean") {
      fail('Plan record decision_required.required must be a boolean when present.');
    }
    if (
      value.status !== undefined &&
      value.status !== null &&
      !DECISION_REQUIRED_STATUSES.has(String(value.status))
    ) {
      fail(`Plan record decision_required.status must be one of ${[...DECISION_REQUIRED_STATUSES].join(", ")}.`);
    }
    for (const key of ["reason", "risk_class", "waiver", "owner", "expires"]) {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
        fail(`Plan record decision_required.${key} must be a string or null when present.`);
      }
    }
    if (
      value.adr_refs !== undefined &&
      (
        !Array.isArray(value.adr_refs) ||
        value.adr_refs.some((entry) => typeof entry !== "string")
      )
    ) {
      fail('Plan record decision_required.adr_refs must be an array of strings when present.');
    }
  }

  // COORD-153: optional live/production-MCP operation declaration. PRESENCE of
  // this object marks the ticket as a live-mcp operation and turns on the
  // live-MCP lifecycle enforcement gate (coord/scripts/live-mcp-lifecycle.js).
  // Absent on every normal ticket, so non-live-mcp tickets are unaffected. The
  // operation-class vocabulary mirrors runtime-evidence.js (COORD-152).
  const LIVE_MCP_OPERATION_CLASSES = new Set([
    "read_safe",
    "read_sensitive",
    "write_low",
    "write_prod",
    "destructive",
  ]);
  const LIVE_MCP_ENVIRONMENTS = new Set(["local", "staging", "prod"]);
  const LIVE_MCP_STRING_FIELDS = [
    "adapter",
    "operation",
    "scope",
    "approval",
    "redaction",
    "cleanup",
    "promotion",
    "receipt_path",
  ];
  const LIVE_MCP_BOOLEANISH_FIELDS = ["cleanup_required", "product_impact"];
  const LIVE_MCP_ALLOWED_KEYS = new Set([
    "operation_class",
    "environment",
    ...LIVE_MCP_STRING_FIELDS,
    ...LIVE_MCP_BOOLEANISH_FIELDS,
    "receipt",
  ]);

  function assertValidLiveMcp(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail('Plan record field "live_mcp" must be an object when present.');
    }
    for (const key of Object.keys(value)) {
      if (!LIVE_MCP_ALLOWED_KEYS.has(key)) {
        fail(`Plan record live_mcp contains unknown field "${key}".`);
      }
    }
    if (
      value.operation_class !== undefined &&
      value.operation_class !== null &&
      !LIVE_MCP_OPERATION_CLASSES.has(String(value.operation_class))
    ) {
      fail(
        `Plan record live_mcp.operation_class must be one of ${[...LIVE_MCP_OPERATION_CLASSES].join(", ")}.`
      );
    }
    if (
      value.environment !== undefined &&
      value.environment !== null &&
      !LIVE_MCP_ENVIRONMENTS.has(String(value.environment))
    ) {
      fail(`Plan record live_mcp.environment must be one of ${[...LIVE_MCP_ENVIRONMENTS].join(", ")}.`);
    }
    for (const key of LIVE_MCP_STRING_FIELDS) {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
        fail(`Plan record live_mcp.${key} must be a string or null when present.`);
      }
    }
    for (const key of LIVE_MCP_BOOLEANISH_FIELDS) {
      if (
        value[key] !== undefined &&
        value[key] !== null &&
        typeof value[key] !== "boolean" &&
        typeof value[key] !== "string"
      ) {
        fail(`Plan record live_mcp.${key} must be a boolean, string, or null when present.`);
      }
    }
    if (
      value.receipt !== undefined &&
      value.receipt !== null &&
      (typeof value.receipt !== "object" || Array.isArray(value.receipt))
    ) {
      fail('Plan record live_mcp.receipt must be an object or null when present.');
    }
  }

  // COORD-159: optional server-bootstrap / startup / backfill / derived-data risk
  // metadata. Advisory only — absent on tickets that do not touch deployed
  // startup or data-generation work. The field vocabulary is canonicalized in
  // coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md.
  const BOOTSTRAP_RISK_WORK_CLASSES = new Set([
    "local_bootstrap",
    "deploy_bootstrap",
    "startup_work",
    "server_bootstrap_job",
    "derived_data_job",
    "production_repair",
  ]);
  const BOOTSTRAP_RISK_STRING_FIELDS = [
    "idempotency_strategy",
    "checkpoint_strategy",
    "verification_signal",
    "rollback_or_disable",
    "data_access_shape",
  ];
  const BOOTSTRAP_RISK_ENVELOPE_NUMBER_FIELDS = ["memory_mb", "timeout_s", "expected_rows", "batch_size"];
  const BOOTSTRAP_RISK_ALLOWED_KEYS = new Set([
    "startup_work_class",
    "runs_at_boot",
    "shares_app_process",
    "resource_envelope",
    ...BOOTSTRAP_RISK_STRING_FIELDS,
    "observability_requirements",
  ]);

  function assertValidBootstrapRisk(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail('Plan record field "bootstrap_risk" must be an object when present.');
    }
    for (const key of Object.keys(value)) {
      if (!BOOTSTRAP_RISK_ALLOWED_KEYS.has(key)) {
        fail(`Plan record bootstrap_risk contains unknown field "${key}".`);
      }
    }
    if (
      value.startup_work_class !== undefined &&
      !BOOTSTRAP_RISK_WORK_CLASSES.has(String(value.startup_work_class))
    ) {
      fail(
        `Plan record bootstrap_risk.startup_work_class must be one of ${[...BOOTSTRAP_RISK_WORK_CLASSES].join(", ")}.`
      );
    }
    for (const key of ["runs_at_boot", "shares_app_process"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") {
        fail(`Plan record bootstrap_risk.${key} must be a boolean when present.`);
      }
    }
    for (const key of BOOTSTRAP_RISK_STRING_FIELDS) {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
        fail(`Plan record bootstrap_risk.${key} must be a string or null when present.`);
      }
    }
    if (value.observability_requirements !== undefined) {
      if (
        !Array.isArray(value.observability_requirements) ||
        value.observability_requirements.some((entry) => typeof entry !== "string")
      ) {
        fail('Plan record bootstrap_risk.observability_requirements must be an array of strings when present.');
      }
    }
    if (value.resource_envelope !== undefined) {
      const envelope = value.resource_envelope;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        fail('Plan record bootstrap_risk.resource_envelope must be an object when present.');
      }
      const allowedEnvelopeKeys = new Set([...BOOTSTRAP_RISK_ENVELOPE_NUMBER_FIELDS, "db_pool_impact"]);
      for (const key of Object.keys(envelope)) {
        if (!allowedEnvelopeKeys.has(key)) {
          fail(`Plan record bootstrap_risk.resource_envelope contains unknown field "${key}".`);
        }
      }
      for (const key of BOOTSTRAP_RISK_ENVELOPE_NUMBER_FIELDS) {
        if (envelope[key] !== undefined && envelope[key] !== null && typeof envelope[key] !== "number") {
          fail(`Plan record bootstrap_risk.resource_envelope.${key} must be a number or null when present.`);
        }
      }
      if (
        envelope.db_pool_impact !== undefined &&
        envelope.db_pool_impact !== null &&
        typeof envelope.db_pool_impact !== "string"
      ) {
        fail('Plan record bootstrap_risk.resource_envelope.db_pool_impact must be a string or null when present.');
      }
    }
  }

  return {
    assertObjectWithAllowedKeys,
    assertStringArrayOrString,
    assertValidBootstrapRisk,
    assertValidContextPackAck,
    assertValidDecisionRequired,
    assertValidLiveMcp,
  };
};
