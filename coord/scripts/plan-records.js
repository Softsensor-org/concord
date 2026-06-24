"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_PATHS, ROOT_DIR, state } = require("./governance-context.js");
const {
  BOARD_RAW_SYMBOL,
  attachTrackedRaw,
  readCanonicalJsonFile,
  readCanonicalTextFile,
  writeCanonicalJsonFile,
  writeCanonicalTextFile,
} = require("./state-io.js");

module.exports = function createPlanRecords(deps = {}) {
  const {
    fail,
    resolveRepoCodeForTicket,
    buildDefaultGovernancePlan,
    normalizeGovernancePlanShape,
    formatGovernancePlanEntry,
    formatGovernanceReviewProfileEntry,
    formatGovernanceRepairEntry,
    parseGovernancePlanEntries,
    scaffoldSelfReviewCycle,
    resolveRepoIntegrationBranch,
    isTestingInfrastructureTicket,
    todayIso,
    escapeTable,
    toArray,
    normalizeSelfReviewCycleLine,
    parseSelfReviewCycles,
    validateRequirementClosureEntry,
    validateFeatureProofEntry,
    normalizeFeatureProofEntryForTicket,
    isMeaningfulText,
    escapeRegex,
    integerOrDefault,
    readBoard,
    getTicketRef,
    inferRequiredReviewRound,
    normalizeOwnerValue,
    repoNameForCode,
    ensurePlanStub,
    mergeUniqueRefs,
    isRepoBackedCode,
  } = deps;

  const PLAN_RECORD_SCHEMA_PATH = DEFAULT_PATHS.planRecordSchemaPath;
  
  const LEGACY_PLAN_RECORD_ARRAY_FIELDS = [
    "startup_checklist",
    "traceability_gate",
    "baseline_reproduction",
    "prior_findings",
    "intended_files",
    "change_summary",
    "verification_commands",
    "critical_invariants",
    "requirement_closure",
    "feature_proof",
    "repo_gates",
    "rollback_strategy",
  ];
  
  function legacyPlanRecordDefaults(ticketId, existing = {}) {
    const defaults = {
      schema_version: 1,
      ticket_id: ticketId,
      governance: buildDefaultGovernancePlan("X"),
      review_round: null,
      self_review_cycles: [],
    };
    for (const key of LEGACY_PLAN_RECORD_ARRAY_FIELDS) {
      defaults[key] = [];
    }
    return {
      ...defaults,
      ...existing,
    };
  }
  
  function normalizeLegacyPlanRecordShape(ticketId, record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return { record, changed: false };
    }
    const next = { ...legacyPlanRecordDefaults(ticketId, record) };
    let changed = false;
  
    if (!Object.prototype.hasOwnProperty.call(record, "schema_version")) {
      next.schema_version = 1;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "ticket_id") && ticketId) {
      next.ticket_id = ticketId;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "review_round")) {
      next.review_round = null;
      changed = true;
    }
    const normalizedGovernance = normalizeGovernancePlanShape(record.governance, resolveRepoCodeForTicket(ticketId));
    if (
      !Object.prototype.hasOwnProperty.call(record, "governance") ||
      JSON.stringify(normalizedGovernance) !== JSON.stringify(record.governance)
    ) {
      next.governance = normalizedGovernance;
      changed = true;
    }
    for (const key of LEGACY_PLAN_RECORD_ARRAY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        next[key] = [];
        changed = true;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(record, "self_review_cycles")) {
      next.self_review_cycles = [];
      changed = true;
    } else if (Array.isArray(record.self_review_cycles)) {
      const normalizedCycles = record.self_review_cycles.map((cycle) => {
        if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
          return cycle;
        }
        if (Object.prototype.hasOwnProperty.call(cycle, "risks")) {
          return cycle;
        }
        changed = true;
        return { ...cycle, risks: [] };
      });
      if (changed) {
        next.self_review_cycles = normalizedCycles;
      }
    }
    return { record: changed ? next : record, changed };
  }
  
  function planRecordPath(ticketId, recordsDir = state.PLAN_RECORDS_DIR) {
    return path.join(recordsDir, `${ticketId}.json`);
  }
  
  // Temporary compatibility reader (C6 Phase 2). Plan shards are now
  // runtime-owned (coord/.runtime/plans). During the transition, records may
  // still exist only at the legacy tracked location (coord/board/plans). Prefer
  // the runtime copy; fall back to the legacy copy if no runtime copy exists.
  // All WRITES go to the runtime location only (planRecordPath default).
  function resolvePlanRecordReadPath(ticketId, explicitRecordsDir) {
    if (explicitRecordsDir) {
      return path.join(explicitRecordsDir, `${ticketId}.json`);
    }
    const runtimePath = planRecordPath(ticketId, state.PLAN_RECORDS_DIR);
    if (fs.existsSync(runtimePath)) {
      return runtimePath;
    }
    const legacyPath = planRecordPath(ticketId, state.LEGACY_PLAN_RECORDS_DIR);
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
    return runtimePath;
  }
  
  function readPlanRecordSchema() {
    const schema = readCanonicalJsonFile(PLAN_RECORD_SCHEMA_PATH);
    if (!schema || typeof schema !== "object") {
      fail("Plan record schema is missing or invalid.");
    }
    return schema;
  }
  
  function stripMarkdownCodeTicks(value) {
    return String(value || "").trim().replace(/^`|`$/g, "");
  }
  
  // COORD-159: parse the single JSON-encoded "Bootstrap risk" markdown line back
  // into the structured object. Returns undefined when the section is absent so
  // legacy plan records (no bootstrap risk) reparse without the optional field.
  function readPlanBootstrapRiskField(block) {
    const values = readPlanListField(block, "Bootstrap risk");
    const encoded = values.find((value) => String(value || "").trim());
    if (!encoded) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(encoded);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      fail(`Could not parse plan record "Bootstrap risk" JSON line: ${error.message}`);
    }
    return undefined;
  }

  // COORD-153: parse the single JSON-encoded "Live-MCP" markdown line back into
  // the structured object. Returns undefined when absent so legacy/non-live-mcp
  // plan records reparse without the optional field.
  function readPlanLiveMcpField(block) {
    const values = readPlanListField(block, "Live-MCP");
    const encoded = values.find((value) => String(value || "").trim());
    if (!encoded) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(encoded);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      fail(`Could not parse plan record "Live-MCP" JSON line: ${error.message}`);
    }
    return undefined;
  }

  function parsePlanBlockToRecord(ticketId, block) {
    const repoCode = resolveRepoCodeForTicket(ticketId);
    const heading = String(block || "").split("\n")[0] || `## ${ticketId}`;
    const bootstrapRisk = readPlanBootstrapRiskField(block);
    const liveMcp = readPlanLiveMcpField(block);
    return {
      schema_version: 1,
      ticket_id: ticketId,
      markdown_heading: heading,
      startup_checklist: readPlanListField(block, "Startup checklist"),
      traceability_gate: readPlanListField(block, "Traceability gate"),
      governance: parseGovernancePlanEntries(readPlanListField(block, "Governance"), repoCode),
      review_round: integerOrDefault(readPlanScalarField(block, "Review round"), null),
      baseline_reproduction: readPlanListField(block, "Baseline reproduction"),
      prior_findings: readPlanListField(block, "Prior findings"),
      intended_files: readPlanListField(block, "Intended files").map(stripMarkdownCodeTicks),
      change_summary: readPlanListField(block, "Change summary"),
      verification_commands: readPlanListField(block, "Verification commands").map(stripMarkdownCodeTicks),
      critical_invariants: readPlanListField(block, "Critical invariants"),
      requirement_closure: readPlanListField(block, "Requirement closure"),
      feature_proof: readPlanListField(block, "Feature proof"),
      repo_gates: readPlanListField(block, "Repo gates").map(stripMarkdownCodeTicks),
      self_review_cycles: parseSelfReviewCycles(block).map((cycle) => ({
        cycle: cycle.cycle,
        total: cycle.total,
        lens: cycle.lens,
        diff: cycle.diff,
        risks: String(cycle.risks || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        findings: cycle.findings,
        verification: cycle.verification,
        verdict: cycle.verdictRaw,
        raw: cycle.body,
      })),
      rollback_strategy: readPlanListField(block, "Rollback strategy"),
      ...(bootstrapRisk !== undefined ? { bootstrap_risk: bootstrapRisk } : {}),
      ...(liveMcp !== undefined ? { live_mcp: liveMcp } : {}),
      security_surface: readPlanScalarField(block, "Security surface"),
      synced_from_markdown_at: new Date().toISOString(),
    };
  }
  
  function normalizePlanMarkdownHeading(heading, ticketId) {
    const trimmed = String(heading || "").trim();
    if (trimmed.startsWith(`## ${ticketId} — `)) {
      return trimmed;
    }
    return `## ${ticketId} — ${new Date().toISOString()}`;
  }
  
  function pushPlanListSection(lines, fieldName, values, formatter = (value) => value) {
    lines.push(`- ${fieldName}:`);
    for (const value of values || []) {
      lines.push(`  - ${formatter(value)}`);
    }
  }
  
  function formatSelfReviewCycleForPlanRecord(cycle) {
    if (typeof cycle?.raw === "string" && cycle.raw.trim()) {
      return cycle.raw.trim();
    }
    const risks = Array.isArray(cycle?.risks) ? cycle.risks.join(", ") : "";
    return [
      `lens=${cycle?.lens || "TODO"}`,
      `diff=${cycle?.diff || "TODO"}`,
      `risks=${risks || "TODO"}`,
      `findings=${cycle?.findings || "TODO"}`,
      `verification=${cycle?.verification || "TODO"}`,
      `verdict=${cycle?.verdict || "TODO"}`,
    ].join("; ");
  }
  
  function renderPlanRecordBlock(record, ticketId = record?.ticket_id) {
    if (!record) {
      fail("Cannot render a PLAN.md compatibility block without a canonical plan record.");
    }
    const lines = [
      normalizePlanMarkdownHeading(record.markdown_heading, ticketId),
      "",
    ];
    pushPlanListSection(lines, "Startup checklist", record.startup_checklist || []);
    pushPlanListSection(lines, "Traceability gate", record.traceability_gate || []);
    const governance = normalizeGovernancePlanShape(record.governance, resolveRepoCodeForTicket(ticketId));
    pushPlanListSection(lines, "Governance", [
      formatGovernancePlanEntry(governance),
      formatGovernanceReviewProfileEntry(governance),
      ...(governance.ticket_local_repairs.length > 0
        ? governance.ticket_local_repairs.map((entry) => formatGovernanceRepairEntry(entry))
        : ["ticket_local_repairs: none"]),
    ]);
    lines.push("- Review round:");
    if (record.review_round !== null && record.review_round !== undefined) {
      lines.push(`  - ${record.review_round}`);
    }
    pushPlanListSection(lines, "Baseline reproduction", record.baseline_reproduction || []);
    pushPlanListSection(lines, "Prior findings", record.prior_findings || []);
    pushPlanListSection(lines, "Intended files", record.intended_files || [], (value) => `\`${value}\``);
    pushPlanListSection(lines, "Change summary", record.change_summary || []);
    pushPlanListSection(lines, "Verification commands", record.verification_commands || [], (value) => `\`${value}\``);
    pushPlanListSection(lines, "Critical invariants", record.critical_invariants || []);
    pushPlanListSection(lines, "Requirement closure", record.requirement_closure || []);
    pushPlanListSection(lines, "Feature proof", record.feature_proof || []);
    pushPlanListSection(lines, "Repo gates", record.repo_gates || []);
    for (const cycle of record.self_review_cycles || []) {
      lines.push(`- Self-review cycle ${cycle.cycle}/${cycle.total}: ${formatSelfReviewCycleForPlanRecord(cycle)}`);
    }
    pushPlanListSection(lines, "Rollback strategy", record.rollback_strategy || []);
    // COORD-159: optional bootstrap/backfill risk metadata is serialized as a
    // single JSON-encoded line so the structured object (including the nested
    // resource_envelope and boolean flags) round-trips through the markdown
    // compatibility block without data loss. Omitted entirely when absent so
    // legacy plan records render byte-identically.
    if (record.bootstrap_risk !== undefined && record.bootstrap_risk !== null) {
      lines.push("- Bootstrap risk:");
      lines.push(`  - ${JSON.stringify(record.bootstrap_risk)}`);
    }
    // COORD-153: optional live/production-MCP operation declaration serialized as
    // a single JSON-encoded line so the structured object (including a possible
    // embedded receipt) round-trips through the markdown compatibility block.
    // Omitted entirely when absent so non-live-mcp plan records render
    // byte-identically.
    if (record.live_mcp !== undefined && record.live_mcp !== null) {
      lines.push("- Live-MCP:");
      lines.push(`  - ${JSON.stringify(record.live_mcp)}`);
    }
    lines.push("- Security surface:");
    if (record.security_surface !== null && record.security_surface !== undefined && String(record.security_surface).trim()) {
      lines.push(`  - ${record.security_surface}`);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }
  
  function appendPlanBlock(raw, block) {
    const trimmedBlock = String(block || "").trimEnd();
    if (!String(raw || "").trim()) {
      return `${trimmedBlock}\n`;
    }
    return `${String(raw).trimEnd()}\n\n${trimmedBlock}\n`;
  }
  
  function assertValidPlanRecord(record) {
    if (!record || typeof record !== "object") {
      fail("Plan record must be an object.");
    }
    const schema = readPlanRecordSchema();
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in record)) {
        fail(`Plan record is missing required field "${key}".`);
      }
    }
    const allowedKeys = new Set([
      ...Object.keys(schema.properties || {}),
      "schema_version",
      "ticket_id",
      "markdown_heading",
      "startup_checklist",
      "traceability_gate",
      "governance",
      "review_round",
      "baseline_reproduction",
      "prior_findings",
      "scaffold_placeholders",
      "intended_files",
      "change_summary",
      "verification_commands",
      "critical_invariants",
      "requirement_closure",
      "feature_proof",
      "repo_gates",
      "self_review_cycles",
      "rollback_strategy",
      "bootstrap_risk",
      "live_mcp",
      "security_surface",
      "synced_from_markdown_at",
    ]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        fail(`Plan record contains unknown field "${key}".`);
      }
    }
    if (record.schema_version !== schema.properties?.schema_version?.const) {
      fail(`Unsupported plan record schema_version "${record.schema_version}".`);
    }
    if (!/^[A-Z]+-\d+$/.test(String(record.ticket_id || ""))) {
      fail("Plan record must include a valid ticket_id.");
    }
    if (record.review_round !== null && (!Number.isInteger(record.review_round) || record.review_round < 1)) {
      fail("Plan record review_round must be null or an integer >= 1.");
    }
    const stringArrayKeys = [
      "startup_checklist",
      "traceability_gate",
      "baseline_reproduction",
      "prior_findings",
      "intended_files",
      "change_summary",
      "verification_commands",
      "critical_invariants",
      "requirement_closure",
      "feature_proof",
      "repo_gates",
      "rollback_strategy",
    ];
    if (
      !record.governance ||
      typeof record.governance !== "object" ||
      Array.isArray(record.governance)
    ) {
      fail('Plan record field "governance" must be an object.');
    }
    const normalizedGovernance = normalizeGovernancePlanShape(record.governance, resolveRepoCodeForTicket(record.ticket_id));
    const expectedCloseout = normalizedGovernance.expected_closeout;
    if (
      !expectedCloseout ||
      typeof expectedCloseout !== "object" ||
      Array.isArray(expectedCloseout)
    ) {
      fail('Plan record field "governance.expected_closeout" must be an object.');
    }
    if (!["pr", "no_pr", "fulfilled_by"].includes(String(expectedCloseout.method || "").trim())) {
      fail('Plan record field "governance.expected_closeout.method" must be one of pr, no_pr, or fulfilled_by.');
    }
    if (typeof expectedCloseout.base_ref !== "string" || !String(expectedCloseout.base_ref).trim()) {
      fail('Plan record field "governance.expected_closeout.base_ref" must be a non-empty string.');
    }
    if (
      expectedCloseout.provenance_note !== null &&
      expectedCloseout.provenance_note !== undefined &&
      typeof expectedCloseout.provenance_note !== "string"
    ) {
      fail('Plan record field "governance.expected_closeout.provenance_note" must be a string or null.');
    }
    if (!["standard", "bounded_repair"].includes(String(normalizedGovernance.review_profile || "").trim())) {
      fail('Plan record field "governance.review_profile" must be one of standard or bounded_repair.');
    }
    if (!Array.isArray(normalizedGovernance.ticket_local_repairs)) {
      fail('Plan record field "governance.ticket_local_repairs" must be an array.');
    }
    for (const repair of normalizedGovernance.ticket_local_repairs) {
      if (!repair || typeof repair !== "object" || Array.isArray(repair)) {
        fail('Plan record governance.ticket_local_repairs entries must be objects.');
      }
      if (typeof repair.kind !== "string" || !repair.kind.trim()) {
        fail('Plan record governance.ticket_local_repairs entries must include non-empty string field "kind".');
      }
      if (typeof repair.required_question_logged !== "boolean") {
        fail('Plan record governance.ticket_local_repairs entries must include boolean field "required_question_logged".');
      }
      if (repair.note !== null && repair.note !== undefined && typeof repair.note !== "string") {
        fail('Plan record governance.ticket_local_repairs entries must include string-or-null field "note".');
      }
    }
    if (
      record.scaffold_placeholders !== undefined &&
      (
        !record.scaffold_placeholders ||
        typeof record.scaffold_placeholders !== "object" ||
        Array.isArray(record.scaffold_placeholders)
      )
    ) {
      fail('Plan record field "scaffold_placeholders" must be an object when present.');
    }
    if (
      record.scaffold_placeholders?.intended_files !== undefined &&
      (
        !Array.isArray(record.scaffold_placeholders.intended_files) ||
        record.scaffold_placeholders.intended_files.some((value) => typeof value !== "string")
      )
    ) {
      fail('Plan record field "scaffold_placeholders.intended_files" must be an array of strings when present.');
    }
    for (const key of stringArrayKeys) {
      if (!Array.isArray(record[key]) || record[key].some((value) => typeof value !== "string")) {
        fail(`Plan record field "${key}" must be an array of strings.`);
      }
    }
    if (!Array.isArray(record.self_review_cycles)) {
      fail('Plan record field "self_review_cycles" must be an array.');
    }
    for (const cycle of record.self_review_cycles) {
      if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
        fail("Plan record self_review_cycles entries must be objects.");
      }
      const allowedCycleKeys = new Set(["cycle", "total", "lens", "diff", "risks", "findings", "verification", "verdict", "raw"]);
      for (const key of Object.keys(cycle)) {
        if (!allowedCycleKeys.has(key)) {
          fail(`Plan record self_review_cycles contains unknown field "${key}".`);
        }
      }
      if (!Number.isInteger(cycle.cycle) || cycle.cycle < 1 || !Number.isInteger(cycle.total) || cycle.total < 1) {
        fail("Plan record self_review_cycles entries must include positive integer cycle and total values.");
      }
      if (typeof cycle.raw !== "string") {
        fail('Plan record self_review_cycles entries must include string field "raw".');
      }
      if (!Array.isArray(cycle.risks) || cycle.risks.some((value) => typeof value !== "string")) {
        fail('Plan record self_review_cycles entries must include "risks" as an array of strings.');
      }
    }
    if (record.bootstrap_risk !== undefined) {
      assertValidBootstrapRisk(record.bootstrap_risk);
    }
    if (record.live_mcp !== undefined) {
      assertValidLiveMcp(record.live_mcp);
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
  
  function readPlanRecord(ticketId, options = {}) {
    const filePath = options.recordsDir
      ? planRecordPath(ticketId, options.recordsDir)
      : resolvePlanRecordReadPath(ticketId);
    const record = readCanonicalJsonFile(filePath, { allowMissing: options.allowMissing });
    if (!record) {
      return null;
    }
    // The canonical WRITE target. resolvePlanRecordReadPath may have read this
    // record from a legacy (board/plans) path during the C6-P2 transition, but
    // every write — the repair-write below and plan-state writes by callers such
    // as updateCanonicalPlanState — lands at the runtime path. BOARD_RAW_SYMBOL
    // is an optimistic-concurrency token: callers pass it back as `expectedRaw`,
    // so it must describe the file that will actually be written, not the file
    // we happened to read from. When the record was read from a legacy path the
    // runtime file does not exist yet, so its current raw is "".
    const canonicalPath = options.recordsDir ? filePath : planRecordPath(ticketId);
    const readFromCanonical = canonicalPath === filePath;
    const canonicalRawNow = () =>
      readFromCanonical
        ? (typeof record?.[BOARD_RAW_SYMBOL] === "string" ? record[BOARD_RAW_SYMBOL] : fs.readFileSync(filePath, "utf8"))
        : (fs.existsSync(canonicalPath) ? fs.readFileSync(canonicalPath, "utf8") : "");
    const { record: normalized, changed } = normalizeLegacyPlanRecordShape(ticketId, record);
    assertValidPlanRecord(normalized);
    if (changed && !options.skipRepairWrite) {
      // Repair-writes always land in the runtime location so the canonical copy
      // migrates forward off the legacy (tracked) path during transition.
      writeCanonicalJsonFile(canonicalPath, normalized, { expectedRaw: canonicalRawNow() });
      attachTrackedRaw(normalized, BOARD_RAW_SYMBOL, `${JSON.stringify(normalized, null, 2)}\n`);
    } else {
      // No repair-write was performed (record already normalized, or the caller
      // asked to skip it). Track the canonical write target's current raw so a
      // caller passing BOARD_RAW_SYMBOL as `expectedRaw` compares against the
      // file it will write — which, when the record was read from a legacy path,
      // is a not-yet-created runtime file ("").
      attachTrackedRaw(normalized, BOARD_RAW_SYMBOL, canonicalRawNow());
    }
    return normalized;
  }
  
  function synthesizeHistoricalPlanRecord(ticketId, row, board) {
    const prRefs = board?.pr_index?.[ticketId] || [];
    const landing = board?.landing_index?.[ticketId] || null;
    const findings = board?.review_findings?.[ticketId] || [];
    const reviewRound = inferRequiredReviewRound(findings);
    const repoLabel = repoNameForCode(row.Repo);
    const evidence = mergeUniqueRefs(
      prRefs,
      Array.isArray(landing?.evidence) ? landing.evidence : []
    );
    const verificationCommands = evidence.length > 0
      ? evidence.map((entry) => `historical evidence: ${entry}`)
      : ["historical evidence unavailable in board indices"];
    const cycleBody = "lens=historical backfill; diff=not-recoverable from surviving markdown ledger; risks=historical implementation detail unavailable, canonical record could under-describe original review depth; findings=none; verification=board pr_index/landing_index evidence preserved during backfill; verdict=pass";
    const record = {
      schema_version: 1,
      ticket_id: ticketId,
      markdown_heading: `## ${ticketId} — historical backfill ${new Date().toISOString()}`,
      startup_checklist: ["historical backfill: original startup checklist unavailable in canonical ledger"],
      traceability_gate: ["historical backfill"],
      governance: {
        expected_closeout: {
          method: landing ? "fulfilled_by" : (isRepoBackedCode(row.Repo) ? "pr" : "no_pr"),
          base_ref: isRepoBackedCode(row.Repo) ? "dev" : "main",
          provenance_note: landing?.commit_sha
            ? `historical landing preserved at ${landing.commit_sha}`
            : null,
        },
        ticket_local_repairs: [],
      },
      review_round: reviewRound,
      baseline_reproduction: [
        "Command: historical-plan-record-backfill",
        "Outcome: canonical plan record synthesized from board lifecycle evidence because no source PLAN.md block survives in the generated ledger.",
      ],
      prior_findings: findings.map((finding) => {
        const parts = [finding.id, finding.summary].filter(Boolean);
        return parts.join(" — ");
      }),
      intended_files: [`historical:${repoLabel}:${ticketId}`],
      change_summary: [
        row.Description,
        "Historical canonical plan record synthesized during IMP-224 migration from surviving board lifecycle state.",
      ].filter(Boolean),
      verification_commands: verificationCommands,
      critical_invariants: [
        "Historical governance evidence must be preserved without inventing unavailable implementation detail.",
        "Backfill must remain idempotent so reruns do not duplicate or weaken canonical ticket history.",
        "Synthesized records must preserve available PR, landing, and finding references from board state.",
      ],
      requirement_closure: [
        "Ticket ask: historical backfill from surviving board/task text",
        "Implemented: synthesized canonical plan record from surviving governance evidence",
        "Not implemented: original requirement-closure attestation unavailable in historical ledger",
        "Deferred to: none",
        "Closeout verdict: complete",
      ],
      feature_proof: [
        "historical-backfill:not-recoverable-from-canonical-ledger",
      ],
      repo_gates: [
        row.Repo === "X"
          ? "not-required"
          : "historical repo-gate detail unavailable in canonical ledger; PR/landing evidence preserved in verification_commands",
      ],
      self_review_cycles: [
        {
          cycle: 1,
          total: 1,
          lens: "historical backfill",
          diff: "not-recoverable from surviving markdown ledger",
          risks: [
            "historical implementation detail unavailable",
            "canonical record could under-describe original review depth",
          ],
          findings: "none",
          verification: "board pr_index/landing_index evidence preserved during backfill",
          verdict: "pass",
          raw: cycleBody,
        },
      ],
      rollback_strategy: [
        "Delete this synthesized canonical plan record and rerun backfill after recovering stronger historical evidence if the summary conflicts with original ticket history.",
      ],
      security_surface: row.Repo === "X" ? "historical-unknown" : "historical-regulated-surface",
      synced_from_markdown_at: new Date().toISOString(),
    };
    assertValidPlanRecord(record);
    return record;
  }
  
  function syncPlanRecordFromBlock(ticketId, block, recordsDir = state.PLAN_RECORDS_DIR) {
    const filePath = planRecordPath(ticketId, recordsDir);
    const nextRecord = parsePlanBlockToRecord(ticketId, block);
    assertValidPlanRecord(nextRecord);
    const currentRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    writeCanonicalJsonFile(filePath, nextRecord, {
      expectedRaw: currentRaw,
    });
  }
  
  function readPlanState(ticketId) {
    const record = readPlanRecord(ticketId, { allowMissing: true });
    if (record) {
      return record;
    }
    const block = readLatestPlanBlock(ticketId);
    if (!block) {
      return null;
    }
    return parsePlanBlockToRecord(ticketId, block);
  }
  
  function ensurePlanBlockForUpdate(ticketId) {
    let raw = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
    let block = extractPlanBlock(raw, ticketId);
    if (block) {
      return { raw, block, source: "markdown" };
    }
  
    const materialized = materializePlanBlockFromRecord(ticketId, raw);
    if (materialized.block) {
      return { raw: materialized.raw, block: materialized.block, source: "canonical-record" };
    }
  
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const owner = normalizeOwnerValue(ref.row.Owner || "unassigned") || "unassigned";
    ensurePlanStub(ticketId, ref.row.Repo, owner);
    raw = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
    block = extractPlanBlock(raw, ticketId);
    if (!block) {
      fail(`Could not bootstrap plan state for ${ticketId}.`);
    }
    return { raw, block, source: "new-stub" };
  }
  
  function ensurePlanRecordForUpdate(ticketId) {
    const existingRecord = readPlanRecord(ticketId, { allowMissing: true });
    if (existingRecord) {
      return {
        record: existingRecord,
        source: "canonical-record",
      };
    }
  
    const raw = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
    const block = extractPlanBlock(raw, ticketId);
    if (block) {
      const record = parsePlanBlockToRecord(ticketId, block);
      assertValidPlanRecord(record);
      const expectedRaw = "";
      writeCanonicalJsonFile(planRecordPath(ticketId), record, { expectedRaw });
      attachTrackedRaw(record, BOARD_RAW_SYMBOL, `${JSON.stringify(record, null, 2)}\n`);
      return {
        record,
        source: "markdown",
      };
    }
  
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const owner = normalizeOwnerValue(ref.row.Owner || "unassigned") || "unassigned";
    ensurePlanStub(ticketId, ref.row.Repo, owner);
    const record = readPlanRecord(ticketId, { allowMissing: true });
    if (!record) {
      fail(`Could not bootstrap canonical plan state for ${ticketId}.`);
    }
    return {
      record,
      source: "new-stub",
    };
  }
  
  function appendUniquePlanRecordValue(values, value) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return values;
    }
    if (!Array.isArray(values)) {
      return [normalized];
    }
    if (values.some((entry) => String(entry || "").trim() === normalized)) {
      return values;
    }
    return [...values, normalized];
  }
  
  function readPlanRecordScaffoldPlaceholders(record, key) {
    const placeholders = record?.scaffold_placeholders;
    if (!placeholders || typeof placeholders !== "object" || Array.isArray(placeholders)) {
      if (key === "intended_files" && planRecordHasImplicitIntendedFilesScaffoldPlaceholder(record)) {
        return (record?.intended_files || [])
          .map((entry) => String(entry || "").trim())
          .filter(Boolean);
      }
      return [];
    }
    const values = placeholders[key];
    if (!Array.isArray(values)) {
      if (key === "intended_files" && planRecordHasImplicitIntendedFilesScaffoldPlaceholder(record)) {
        return (record?.intended_files || [])
          .map((entry) => String(entry || "").trim())
          .filter(Boolean);
      }
      return [];
    }
    return values
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }
  
  function planRecordFieldHasOnlyScaffoldValues(record, key) {
    const values = Array.isArray(record?.[key])
      ? record[key].map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const placeholders = (PLAN_SCAFFOLD_LIST_VALUES[key] || [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (values.length === 0 || placeholders.length === 0) {
      return false;
    }
    const placeholderSet = new Set(placeholders);
    return values.every((entry) => placeholderSet.has(entry));
  }
  
  // COORD-014: `gov start` RESOLVES startup_checklist and traceability_gate to
  // deterministic values (the startup attestation is completed by starting, and
  // traceability is auto-graded — "exempt" for coord/X tickets). These are not
  // agent-authored content, so a freshly-started, unworked ticket carries them
  // even though they no longer hold the literal "TODO:" placeholder. The unstart /
  // lock-abandon scaffold guard must therefore accept these start-resolved values
  // in addition to the placeholder form, or it false-positives "authored content"
  // on every bare start and blocks the very wrong-start revert it exists for.
  const START_RESOLVED_NON_AUTHORING_VALUES = {
    startup_checklist: ["completed"],
    traceability_gate: ["verified", "closing-gap", "exempt"],
  };
  
  function planRecordFieldIsStartScaffoldOrResolved(record, key) {
    if (planRecordFieldHasOnlyScaffoldValues(record, key)) {
      return true;
    }
    const values = Array.isArray(record?.[key])
      ? record[key].map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    if (values.length === 0) {
      return false;
    }
    const accepted = new Set([
      ...(PLAN_SCAFFOLD_LIST_VALUES[key] || []).map((entry) => String(entry).trim()),
      ...(START_RESOLVED_NON_AUTHORING_VALUES[key] || []),
    ]);
    return accepted.size > 0 && values.every((entry) => accepted.has(entry));
  }
  
  function isScaffoldWorktreeIntendedFile(value, ticketId = null) {
    // COORD-006: this predicate identifies the start-scaffold `intended_files`
    // placeholder — `<repo-prefix>/.worktrees/<owner>/<ticket>/*` — so that
    // `gov unstart` / `gov lock-abandon` can tell a freshly-started, unworked
    // ticket apart from one carrying genuinely authored plan content.
    //
    // It used to be VALUE-EXACT: it rebuilt the set of acceptable repo-name
    // prefixes from the *current* `REPO_ROOTS` / project registry and required
    // the persisted placeholder to begin with one of them. That made the check
    // config-derivation-sensitive: a record seeded under one repo registry
    // (e.g. acme's `B: "acme-api"`) is mis-flagged as authored content the
    // moment the prefix is no longer derivable from the live registry — a
    // freshly-started SEC-010 wrong-start then fails the unstart guard closed.
    //
    // The check is now STRUCTURAL: the `.../.worktrees/<owner>/<ticket>/*` glob
    // is exclusively a start-scaffold artifact. No genuinely authored
    // `intended_files` entry is ever a `.worktrees/<owner>/<ticket>/*` glob —
    // real entries are concrete repo-relative source paths. So recognizing the
    // shape (any non-empty leading repo-prefix segment, `.worktrees`, an owner
    // segment, a ticket segment, then `*`) is registry-agnostic and cannot
    // false-negative on real content. When a ticket id is supplied the trailing
    // ticket segment is pinned to it for a tighter, still config-agnostic match.
    const normalized = String(value || "").trim().replace(/\\/g, "/");
    if (!normalized) {
      return false;
    }
    const trimmedTicketId = ticketId ? String(ticketId).trim() : "";
    // <repo-prefix>/.worktrees/<owner>/<ticket>/* — the repo-prefix may itself be
    // a multi-segment path (e.g. "packages/server" or "coord"), so require a
    // non-empty leading prefix that does not contain a glob or a nested
    // ".worktrees" pivot, then the fixed scaffold tail.
    const tail = "\\.worktrees\\/[^/]+\\/" +
      (trimmedTicketId ? escapeRegex(trimmedTicketId) : "[^/]+") +
      "\\/\\*$";
    const match = new RegExp(`^([^*]+?)\\/${tail}`).exec(normalized);
    if (!match) {
      return false;
    }
    const repoPrefix = match[1];
    // The leading prefix is the repo directory, never the worktree pivot itself.
    return repoPrefix.length > 0 && !/(^|\/)\.worktrees(\/|$)/.test(repoPrefix);
  }
  
  // COORD-009: read the recorded start-seed values for an `intended_files`
  // plan record DIRECTLY off `scaffold_placeholders.intended_files`, without
  // the implicit-worktree-placeholder fallback that
  // `readPlanRecordScaffoldPlaceholders` applies. This is the seam the unstart
  // scaffold guard needs: it must decide whether `intended_files` is start-seed
  // content, so it cannot route through a helper that itself calls the guard.
  function readRecordedIntendedFilesScaffoldSeed(record) {
    const placeholders = record?.scaffold_placeholders;
    if (!placeholders || typeof placeholders !== "object" || Array.isArray(placeholders)) {
      return [];
    }
    const values = placeholders.intended_files;
    if (!Array.isArray(values)) {
      return [];
    }
    return values
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }
  
  function planRecordHasImplicitIntendedFilesScaffoldPlaceholder(record) {
    const intendedFiles = Array.isArray(record?.intended_files)
      ? record.intended_files.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const featureProof = Array.isArray(record?.feature_proof)
      ? record.feature_proof.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    // COORD-009: `intended_files` is start-scaffold when it is non-empty and
    // every entry is EITHER the implicit `.worktrees/<owner>/<ticket>/*`
    // placeholder OR a value recorded into `scaffold_placeholders.intended_files`
    // by `gov start` (the prompt's `## Likely Files` seed). Any entry that is
    // neither — i.e. a path an agent added after start via `update-plan --file`
    // — is genuinely authored content and fails the guard closed. This mirrors
    // how `planRecordFieldHasOnlyScaffoldValues` handles other start-seeded
    // fields, replacing the prior rigid single-placeholder check.
    const recordedSeed = new Set(readRecordedIntendedFilesScaffoldSeed(record));
    // COORD-014: an EMPTY `intended_files` is the start scaffold, not authored
    // content — it is what `gov start` seeds for any ticket whose prompt has no
    // `## Likely Files` section (e.g. the generic planner.md / implementer.md
    // prompts). `[].every(...)` is true, so an unworked wrong start stays
    // unstartable. A NON-empty list is scaffold only when every entry is a
    // recorded seed or the implicit worktree placeholder; any other path is
    // genuinely authored content and fails the guard closed.
    const everyEntryIsScaffold =
      intendedFiles.every((entry) =>
        recordedSeed.has(entry) ||
        isScaffoldWorktreeIntendedFile(entry, record?.ticket_id)
      );
    if (!everyEntryIsScaffold) {
      return false;
    }
    return (
      planRecordFieldIsStartScaffoldOrResolved(record, "startup_checklist") &&
      planRecordFieldIsStartScaffoldOrResolved(record, "traceability_gate") &&
      planRecordFieldHasOnlyScaffoldValues(record, "baseline_reproduction") &&
      planRecordFieldHasOnlyScaffoldValues(record, "verification_commands") &&
      planRecordFieldHasOnlyScaffoldValues(record, "critical_invariants") &&
      (featureProof.length === 0 || planRecordFieldHasOnlyScaffoldValues(record, "feature_proof")) &&
      planRecordFieldHasOnlyScaffoldValues(record, "repo_gates") &&
      planRecordFieldHasOnlyScaffoldValues(record, "rollback_strategy") &&
      planRecordHasOnlyScaffoldSelfReviewCycles(record)
    );
  }
  
  function writePlanRecordScaffoldPlaceholders(record, key, values) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return;
    }
    const normalized = toArray(values)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    const nextPlaceholders = record.scaffold_placeholders &&
      typeof record.scaffold_placeholders === "object" &&
      !Array.isArray(record.scaffold_placeholders)
      ? { ...record.scaffold_placeholders }
      : {};
    if (normalized.length > 0) {
      nextPlaceholders[key] = normalized;
    } else {
      delete nextPlaceholders[key];
    }
    if (Object.keys(nextPlaceholders).length > 0) {
      record.scaffold_placeholders = nextPlaceholders;
    } else {
      delete record.scaffold_placeholders;
    }
  }
  
  const PLAN_SCAFFOLD_LIST_VALUES = {
    startup_checklist: [
      "TODO: completed",
    ],
    traceability_gate: [
      "TODO: verified | closing-gap | exempt",
    ],
    baseline_reproduction: [
      "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
      "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
    ],
    change_summary: [
      "TODO: describe the intended change.",
    ],
    verification_commands: [
      "TODO",
    ],
    critical_invariants: [
      "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
      "TODO: include at least one invariant about state/contract consistency",
      "TODO: list 2-5 truths this repair must preserve under normal, edge, and failure paths",
    ],
    requirement_closure: [
      "TODO: Ticket ask: <what the ticket said to deliver>",
      "TODO: Implemented: <what is actually delivered in this change>",
      "TODO: Not implemented: <residual gap or none>",
      "TODO: Deferred to: <ticket-id or none>",
      "TODO: Closeout verdict: complete | incomplete",
    ],
    feature_proof: [
      "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
      "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
    ],
    repo_gates: [
      "TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets",
    ],
    rollback_strategy: [
      "TODO",
    ],
  };
  
  function stripPlanScaffoldValues(key, values, context = {}) {
    if (!Array.isArray(values)) {
      return values;
    }
    if (key === "intended_files") {
      const incomingValue = String(context.incomingValue || "").trim();
      const incomingIsWorktreePath = isScaffoldWorktreeIntendedFile(incomingValue);
      const scaffoldValues = new Set(toArray(context.scaffoldValues)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean));
      if (incomingValue && !incomingIsWorktreePath && scaffoldValues.size > 0) {
        return values.filter((entry) => !scaffoldValues.has(String(entry || "").trim()));
      }
      return values;
    }
    const placeholders = new Set((PLAN_SCAFFOLD_LIST_VALUES[key] || []).map((entry) => String(entry).trim()));
    if (placeholders.size === 0) {
      return values;
    }
    return values.filter((entry) => !placeholders.has(String(entry || "").trim()));
  }
  
  function planRecordHasOnlyScaffoldSelfReviewCycles(record) {
    const cycles = Array.isArray(record?.self_review_cycles) ? record.self_review_cycles : [];
    return cycles.length > 0 && cycles.every((cycle) => String(cycle?.raw || "").toLowerCase().includes("todo"));
  }
  
  function planRecordHasOnlyMalformedSelfReviewCycles(record) {
    // Narrow definition: every cycle is essentially empty (no user-authored content in diff,
    // risks, findings, verification, or verdict). A cycle with *some* content but failing
    // validation (e.g. one risk instead of two) is real user work and must not be silently
    // replaced — GOV-002. This predicate drives only the scaffold-replacement branch in
    // applyPlanUpdateOptionsToRecord; it is NOT a general validation check.
    const cycles = Array.isArray(record?.self_review_cycles) ? record.self_review_cycles : [];
    return cycles.length > 0 && cycles.every((cycle) => {
      const risks = Array.isArray(cycle?.risks)
        ? cycle.risks.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [];
      const hasDiff = isMeaningfulText(cycle?.diff);
      const hasFindings = isMeaningfulText(cycle?.findings);
      const hasVerification = isMeaningfulText(cycle?.verification);
      const hasVerdict = isMeaningfulText(cycle?.verdict);
      return !hasDiff && !hasFindings && !hasVerification && !hasVerdict && risks.length === 0;
    });
  }
  
  function normalizePlanRecordSelfReviewCycle(record, value, options = {}) {
    const contextBlock = renderPlanRecordBlock(record, record?.ticket_id);
    const normalizedLine = normalizeSelfReviewCycleLine(contextBlock, value, options);
    if (!normalizedLine) {
      return null;
    }
    const parsed = parseSelfReviewCycles(`${normalizedLine}\n`);
    if (parsed.length === 0) {
      fail(`Could not parse self-review cycle entry "${value}".`);
    }
    const cycle = parsed[0];
    return {
      cycle: cycle.cycle,
      total: cycle.total,
      lens: cycle.lens,
      diff: cycle.diff,
      risks: String(cycle.risks || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      findings: cycle.findings,
      verification: cycle.verification,
      verdict: cycle.verdictRaw,
      raw: cycle.body,
    };
  }
  
  function applyPlanUpdateOptionsToRecord(record, options = {}) {
    const normalizedRecord = normalizeLegacyPlanRecordShape(record?.ticket_id || "", record || {}).record || record || {};
    const nextRecord = JSON.parse(JSON.stringify(normalizedRecord));
    const appendListValue = (key, value) => {
      const normalizedIncoming = String(value || "").trim();
      const scaffoldValues = readPlanRecordScaffoldPlaceholders(nextRecord, key);
      nextRecord[key] = appendUniquePlanRecordValue(stripPlanScaffoldValues(key, nextRecord[key], {
        ticketId: nextRecord.ticket_id,
        incomingValue: value,
        scaffoldValues,
      }), value);
      if (scaffoldValues.length > 0) {
        const nextValueSet = new Set((nextRecord[key] || []).map((entry) => String(entry || "").trim()));
        let remainingScaffoldValues = scaffoldValues.filter((entry) => nextValueSet.has(entry));
        if (normalizedIncoming) {
          remainingScaffoldValues = remainingScaffoldValues.filter((entry) => entry !== normalizedIncoming);
        }
        writePlanRecordScaffoldPlaceholders(nextRecord, key, remainingScaffoldValues);
      }
    };
  
    if (options.summary) {
      appendListValue("change_summary", options.summary);
    }
    for (const cmd of toArray(options.verify)) {
      appendListValue("verification_commands", cmd);
    }
    for (const file of toArray(options.dropFile)) {
      const normalizedDrop = String(file || "").trim();
      if (!normalizedDrop) {
        continue;
      }
      nextRecord.intended_files = (nextRecord.intended_files || [])
        .filter((entry) => String(entry || "").trim() !== normalizedDrop);
      const remainingScaffoldValues = readPlanRecordScaffoldPlaceholders(nextRecord, "intended_files")
        .filter((entry) => entry !== normalizedDrop);
      if (remainingScaffoldValues.length > 0 || nextRecord.scaffold_placeholders?.intended_files) {
        writePlanRecordScaffoldPlaceholders(nextRecord, "intended_files", remainingScaffoldValues);
      }
    }
    for (const file of toArray(options.files)) {
      appendListValue("intended_files", file);
    }
    if (options.security) {
      nextRecord.security_surface = String(options.security).trim();
    }
    // COORD-153: `--live-mcp '<json>'` declares (or clears) the live/production-MCP
    // operation object. A JSON object is parsed and stored; the literal "none"
    // clears the declaration (turning the enforcement gate off for the ticket).
    if (options.liveMcp !== undefined) {
      const raw = String(options.liveMcp || "").trim();
      if (!raw || raw.toLowerCase() === "none") {
        delete nextRecord.live_mcp;
      } else {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          fail(`--live-mcp expects a JSON object (or "none"): ${error.message}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          fail('--live-mcp expects a JSON object (or "none").');
        }
        nextRecord.live_mcp = parsed;
      }
    }
    if (options.startup) {
      appendListValue("startup_checklist", options.startup);
    }
    if (options.traceability) {
      appendListValue("traceability_gate", options.traceability);
    }
    for (const item of toArray(options.baseline)) {
      appendListValue("baseline_reproduction", item);
    }
    for (const item of toArray(options.invariant)) {
      appendListValue("critical_invariants", item);
    }
    for (const item of toArray(options.closure)) {
      validateRequirementClosureEntry(item);
      appendListValue("requirement_closure", item);
    }
    for (const item of toArray(options.featureProof)) {
      validateFeatureProofEntry(item);
      appendListValue("feature_proof", normalizeFeatureProofEntryForTicket(item, nextRecord.ticket_id));
    }
    for (const item of toArray(options.dropFeatureProof)) {
      const normalizedDrop = normalizeFeatureProofEntryForTicket(item, nextRecord.ticket_id);
      nextRecord.feature_proof = (nextRecord.feature_proof || [])
        .filter((entry) => String(entry || "").trim() !== normalizedDrop);
      const remainingScaffoldValues = readPlanRecordScaffoldPlaceholders(nextRecord, "feature_proof")
        .filter((entry) => entry !== normalizedDrop);
      if (remainingScaffoldValues.length > 0 || nextRecord.scaffold_placeholders?.feature_proof) {
        writePlanRecordScaffoldPlaceholders(nextRecord, "feature_proof", remainingScaffoldValues);
      }
    }
    for (const item of toArray(options.repoGate)) {
      appendListValue("repo_gates", item);
    }
    for (const item of toArray(options.rollback)) {
      appendListValue("rollback_strategy", item);
    }
    if (
      options.closeoutMethod ||
      options.closeoutBaseRef ||
      Object.prototype.hasOwnProperty.call(options, "provenanceNote") ||
      options.reviewProfile
    ) {
      const governance = normalizeGovernancePlanShape(nextRecord.governance, resolveRepoCodeForTicket(nextRecord.ticket_id));
      if (options.closeoutMethod) {
        governance.expected_closeout.method = String(options.closeoutMethod).trim();
      }
      if (options.closeoutBaseRef) {
        governance.expected_closeout.base_ref = String(options.closeoutBaseRef).trim();
      }
      if (Object.prototype.hasOwnProperty.call(options, "provenanceNote")) {
        const note = String(options.provenanceNote || "").trim();
        governance.expected_closeout.provenance_note = note || null;
      }
      if (options.reviewProfile) {
        const reviewProfile = String(options.reviewProfile || "").trim();
        governance.review_profile = reviewProfile === "bounded_repair" ? "bounded_repair" : "standard";
      }
      nextRecord.governance = governance;
    }
  
    // --drop-review-cycle N: remove cycle N (1-based) from the list
    if (typeof options.dropReviewCycle === "number") {
      const dropIndex = options.dropReviewCycle - 1;
      const existing = nextRecord.self_review_cycles || [];
      if (dropIndex < 0 || dropIndex >= existing.length) {
        throw new Error(`Cannot drop review cycle ${options.dropReviewCycle}: only ${existing.length} cycle(s) exist.`);
      }
      nextRecord.self_review_cycles = existing
        .filter((_, i) => i !== dropIndex)
        .map((cycle, i) => ({ ...cycle, cycle: i + 1, total: existing.length - 1 }));
    }
  
    // --replace-review-cycle N --review-cycle "...": replace cycle N with new value
    if (typeof options.replaceReviewCycle === "number" && toArray(options.reviewCycle).length === 1) {
      const replaceIndex = options.replaceReviewCycle - 1;
      const existing = nextRecord.self_review_cycles || [];
      if (replaceIndex < 0 || replaceIndex >= existing.length) {
        throw new Error(`Cannot replace review cycle ${options.replaceReviewCycle}: only ${existing.length} cycle(s) exist.`);
      }
      const replacement = normalizePlanRecordSelfReviewCycle(nextRecord, toArray(options.reviewCycle)[0], {
        cycleNumber: options.replaceReviewCycle,
        totalCycles: existing.length,
      });
      if (replacement) {
        nextRecord.self_review_cycles = existing.map((cycle, i) =>
          i === replaceIndex ? replacement : cycle
        );
      }
    } else if (typeof options.replaceReviewCycle === "number" && toArray(options.reviewCycle).length !== 1) {
      throw new Error("--replace-review-cycle requires exactly one --review-cycle value.");
    }
  
    const reviewCycles = typeof options.replaceReviewCycle === "number" ? [] : toArray(options.reviewCycle);
    if (options.replaceAllReviewCycles === true) {
      const totalCycles = Math.max(3, reviewCycles.length);
      nextRecord.self_review_cycles = reviewCycles
        .map((value, index) => normalizePlanRecordSelfReviewCycle({
          ...nextRecord,
          self_review_cycles: [],
        }, value, {
          cycleNumber: index + 1,
          totalCycles,
        }))
        .filter(Boolean);
    } else
    if (reviewCycles.length > 0) {
      // Scaffold replacement applies to (a) literal TODO placeholders written during plan
      // initialization and (b) essentially-empty legacy pseudo-cycles with no diff/risks/
      // findings/verification/verdict. Previously the "malformed" predicate also fired for
      // real user-authored cycles that happened to be shallow (e.g. only one risk), silently
      // wiping them when a second update-plan --review-cycle arrived. That predicate has been
      // narrowed to empty-only — shallow real cycles append and are caught by submit-time
      // validation where the user sees the shape error instead of losing their work (GOV-002).
      if (
        planRecordHasOnlyScaffoldSelfReviewCycles(nextRecord) ||
        planRecordHasOnlyMalformedSelfReviewCycles(nextRecord)
      ) {
        const totalCycles = Math.max(3, reviewCycles.length);
        nextRecord.self_review_cycles = reviewCycles
          .map((value, index) => normalizePlanRecordSelfReviewCycle({
            ...nextRecord,
            self_review_cycles: [],
          }, value, {
            cycleNumber: index + 1,
            totalCycles,
          }))
          .filter(Boolean);
      } else {
        for (const value of reviewCycles) {
          const cycle = normalizePlanRecordSelfReviewCycle(nextRecord, value);
          if (!cycle) {
            continue;
          }
          const raw = String(cycle.raw || "").trim();
          if ((nextRecord.self_review_cycles || []).some((entry) => String(entry?.raw || "").trim() === raw)) {
            // Dedup used to skip silently and exit 0, hiding the failed append from the caller.
            // Surface it so the user can either use --replace-review-cycle <N> to overwrite or
            // set-review-cycles to rewrite the full sequence (GOV-002).
            const ticketLabel = nextRecord.ticket_id || "<ticket-id>";
            console.error(
              `Warning: review cycle skipped — raw body duplicates an existing cycle. ` +
              `Use --replace-review-cycle <N> or "coord/scripts/gov set-review-cycles ${ticketLabel} --review-cycle ..." to overwrite.`
            );
            continue;
          }
          nextRecord.self_review_cycles = [...(nextRecord.self_review_cycles || []), cycle];
        }
      }
    }
  
    if (!String(nextRecord.synced_from_markdown_at || "").trim()) {
      nextRecord.synced_from_markdown_at = new Date().toISOString();
    }
    assertValidPlanRecord(nextRecord);
    return nextRecord;
  }
  
  function writePlanCompatibilityBlockFromRecord(ticketId, record) {
    const raw = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true });
    const block = renderPlanRecordBlock(record, ticketId);
    const nextRaw = extractPlanBlock(raw, ticketId)
      ? replacePlanBlock(raw, ticketId, block)
      : appendPlanBlock(raw, block);
    writeCanonicalTextFile(state.PLAN_PATH, nextRaw, { expectedRaw: raw });
    return {
      raw: nextRaw,
      block,
      replaced: Boolean(extractPlanBlock(raw, ticketId)),
    };
  }
  
  function updateCanonicalPlanState(ticketId, options = {}) {
    const prepared = ensurePlanRecordForUpdate(ticketId);
    const incomingCycleCount = toArray(options.reviewCycle).length;
    const nextRecord = applyPlanUpdateOptionsToRecord(prepared.record, options);
    const expectedRaw = prepared.record?.[BOARD_RAW_SYMBOL] ?? "";
    writeCanonicalJsonFile(planRecordPath(ticketId), nextRecord, { expectedRaw });
    attachTrackedRaw(nextRecord, BOARD_RAW_SYMBOL, `${JSON.stringify(nextRecord, null, 2)}\n`);
    writePlanCompatibilityBlockFromRecord(ticketId, nextRecord);
  
    if (incomingCycleCount > 1 && typeof options.replaceReviewCycle !== "number") {
      const recordedCount = (nextRecord.self_review_cycles || []).length;
      if (recordedCount < incomingCycleCount) {
        console.error(
          `Warning: ${incomingCycleCount} --review-cycle values were passed but only ${recordedCount} are recorded. ` +
          `This can happen if some cycles were deduplicated or failed validation. ` +
          `Use "coord/scripts/gov set-review-cycles ${ticketId} --review-cycle ..." to replace all cycles at once.`
        );
      }
    }
  
    return {
      source: prepared.source,
      record: nextRecord,
    };
  }
  
  function materializePlanBlockFromRecord(ticketId, raw = readCanonicalTextFile(state.PLAN_PATH, { allowMissing: true })) {
    const record = readPlanRecord(ticketId, { allowMissing: true });
    if (!record) {
      return {
        raw,
        block: null,
        materialized: false,
      };
    }
    const block = renderPlanRecordBlock(record, ticketId);
    const nextRaw = appendPlanBlock(raw, block);
    writeCanonicalTextFile(state.PLAN_PATH, nextRaw, { expectedRaw: raw });
    return {
      raw: nextRaw,
      block,
      materialized: true,
    };
  }
  
  function extractPlanBlock(raw, ticketId) {
    const entries = extractPlanBlockEntries(raw, ticketId);
    if (entries.length === 0) {
      return null;
    }
    return entries[entries.length - 1].block;
  }
  
  function extractPlanBlockEntries(raw, ticketId) {
    const pattern = new RegExp(`^## ${escapeRegex(ticketId)} — .*?$`, "gm");
    const matches = [...raw.matchAll(pattern)];
    if (matches.length === 0) {
      return [];
    }
    return matches.map((match) => {
      const startIndex = match.index;
      const nextHeadingPattern = /^## [A-Z]+-\d+ — .*?$/gm;
      nextHeadingPattern.lastIndex = startIndex + match[0].length;
      const nextHeading = nextHeadingPattern.exec(raw);
      const endIndex = nextHeading ? nextHeading.index : raw.length;
      return {
        block: raw.slice(startIndex, endIndex),
        startIndex,
        endIndex,
      };
    });
  }
  
  function extractPlanBlocks(raw, ticketId) {
    return extractPlanBlockEntries(raw, ticketId).map((entry) => entry.block);
  }
  
  function upsertListItem(block, fieldName, value) {
    const header = `- ${fieldName}:`;
    if (!block.includes(header)) {
      return `${block.trimEnd()}\n${header}\n  - ${value}\n`;
    }
    const lines = block.split("\n");
    const headerIndex = lines.findIndex((line) => line === header);
    if (headerIndex === -1) {
      return block;
    }
    const nextHeaderIndex = lines.findIndex((line, index) => index > headerIndex && isPlanSectionBoundary(line));
    const sliceEnd = nextHeaderIndex === -1 ? lines.length : nextHeaderIndex;
    const existing = lines.slice(headerIndex + 1, sliceEnd);
    if (!existing.some((line) => line.trim() === `- ${value}`)) {
      lines.splice(sliceEnd, 0, `  - ${value}`);
    }
    return lines.join("\n");
  }
  
  function replaceScalarField(block, fieldName, value) {
    const pattern = new RegExp(`^- ${escapeRegex(fieldName)}:\\n  - .*?$`, "m");
    if (pattern.test(block)) {
      return block.replace(pattern, `- ${fieldName}:\n  - ${value}`);
    }
    return `${block.trimEnd()}\n- ${fieldName}:\n  - ${value}\n`;
  }
  
  function replacePlanBlock(raw, ticketId, nextBlock) {
    const entries = extractPlanBlockEntries(raw, ticketId);
    if (entries.length === 0) {
      fail(`No PLAN block found for ${ticketId}.`);
    }
    const entry = entries[entries.length - 1];
    return `${raw.slice(0, entry.startIndex)}${nextBlock}${raw.slice(entry.endIndex)}`;
  }
  
  function readLatestPlanBlock(ticketId) {
    const raw = fs.existsSync(state.PLAN_PATH) ? fs.readFileSync(state.PLAN_PATH, "utf8") : "";
    return extractPlanBlock(raw, ticketId);
  }
  
  function readPlanListField(block, fieldName) {
    if (!block) {
      return [];
    }
    const lines = block.split("\n");
    const header = `- ${fieldName}:`;
    const headerIndex = lines.findIndex((line) => line === header);
    if (headerIndex === -1) {
      return [];
    }
    const values = [];
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (isPlanSectionBoundary(line)) {
        break;
      }
      const match = /^  - (.*)$/.exec(line);
      if (match) {
        values.push(match[1]);
      }
    }
    return values;
  }
  
  function readPlanScalarField(block, fieldName) {
    const values = readPlanListField(block, fieldName);
    return values.length > 0 ? values[0] : null;
  }
  
  function isPlanSectionBoundary(line) {
    return /^- [^:]+:$/.test(line) || /^- Self-review cycle \d+\/\d+:/i.test(String(line || "").trim());
  }
  
  function normalizePlanPathValue(value) {
    const trimmed = String(value || "").trim().replace(/^`|`$/g, "");
    if (!trimmed) {
      return "";
    }
    const absolute = path.resolve(ROOT_DIR, trimmed);
    const relativeToRoot = path.relative(ROOT_DIR, absolute);
    if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
      return relativeToRoot.replace(/\\/g, "/");
    }
    return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  
  function planTargetsCoordOnlyArtifacts(ticketId) {
    const planState = readPlanState(ticketId);
    const intendedFiles = (planState?.intended_files || [])
      .map((value) => normalizePlanPathValue(value))
      .filter((value) => isMeaningfulText(value));
    if (intendedFiles.length === 0) {
      return false;
    }
    return intendedFiles.every((value) => value === "coord" || value.startsWith("coord/"));
  }

  return {
    legacyPlanRecordDefaults,
    normalizeLegacyPlanRecordShape,
    planRecordPath,
    resolvePlanRecordReadPath,
    readPlanRecordSchema,
    stripMarkdownCodeTicks,
    parsePlanBlockToRecord,
    normalizePlanMarkdownHeading,
    pushPlanListSection,
    formatSelfReviewCycleForPlanRecord,
    renderPlanRecordBlock,
    appendPlanBlock,
    assertValidPlanRecord,
    readPlanRecord,
    synthesizeHistoricalPlanRecord,
    syncPlanRecordFromBlock,
    readPlanState,
    ensurePlanBlockForUpdate,
    ensurePlanRecordForUpdate,
    appendUniquePlanRecordValue,
    readPlanRecordScaffoldPlaceholders,
    planRecordFieldHasOnlyScaffoldValues,
    planRecordFieldIsStartScaffoldOrResolved,
    isScaffoldWorktreeIntendedFile,
    readRecordedIntendedFilesScaffoldSeed,
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
    writePlanRecordScaffoldPlaceholders,
    stripPlanScaffoldValues,
    planRecordHasOnlyScaffoldSelfReviewCycles,
    planRecordHasOnlyMalformedSelfReviewCycles,
    normalizePlanRecordSelfReviewCycle,
    applyPlanUpdateOptionsToRecord,
    writePlanCompatibilityBlockFromRecord,
    updateCanonicalPlanState,
    materializePlanBlockFromRecord,
    extractPlanBlock,
    extractPlanBlockEntries,
    extractPlanBlocks,
    upsertListItem,
    replaceScalarField,
    replacePlanBlock,
    readLatestPlanBlock,
    readPlanListField,
    readPlanScalarField,
    isPlanSectionBoundary,
    normalizePlanPathValue,
    planTargetsCoordOnlyArtifacts,
  };
};
