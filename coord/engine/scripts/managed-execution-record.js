"use strict";

// COORD-860: the plan record field `managed_execution`, written only by
// `gov record-managed-evidence`. It holds the redacted reconciliation summary
// (policy digest, chain root, counts, coverage, named gaps, diff digest,
// verdict) and, separately, an optional human-admin technical exception bound
// to that exact summary. An exception never rewrites the summary verdict and is
// not a legal waiver.

const MANAGED_EXECUTION_WRITE = Symbol.for("coord.managed-execution.write/v1");
const SECTION = "Managed execution";
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE = /^[a-z][a-z0-9_]{0,63}(?::[a-z][a-z0-9_-]{0,31})?$/;
const SUMMARY_KEYS = [
  "schema", "ticket", "session", "provider", "policy_digest", "chain_root", "session_head", "base_commit", "head_commit",
  "integrity", "coverage", "counts", "gaps", "unexplained", "diff_digest", "verdict", "summary_digest",
];
const COUNT_KEYS = ["entries", "legacy_v1", "session_events", "effects", "changed_paths", "commits", "by_class"];
const EXCEPTION_KEYS = ["schema", "summary_digest", "chain_root", "gaps", "reason", "residual_risk", "approval", "actor", "recorded_at", "legal_waiver"];
const RECORD_KEYS = ["summary", "exception", "recorded_at", "actor"];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function nullable(value, pattern) {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function count(value) {
  return Number.isInteger(value) && value >= 0;
}

function codes(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && CODE.test(entry))
    && [...value].sort().join("\n") === value.join("\n") && new Set(value).size === value.length;
}

function boundedText(value, limit) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

const DIGEST_FIELDS = ["policy_digest", "chain_root", "session_head"];
// Ordered [holds, violation] rules over an exact-key summary.
const SUMMARY_RULES = [
  [(s) => s.schema === "coord.managed-execution-summary/v1", "summary schema is unsupported"],
  [(s) => /^[A-Z][A-Z0-9]*-\d+$/.test(s.ticket), "summary ticket is invalid"],
  [(s) => nullable(s.session, /^[A-Za-z0-9._:-]{1,128}$/) && nullable(s.provider, /^(?:claude|codex)$/), "summary session or provider is invalid"],
  [(s) => DIGEST_FIELDS.every((field) => nullable(s[field], HEX64)) && HEX64.test(s.summary_digest), "summary digests must be SHA-256"],
  [(s) => nullable(s.base_commit, COMMIT) && nullable(s.head_commit, COMMIT), "summary commits must be full SHAs"],
  [(s) => ["valid", "invalid"].includes(s.integrity), "summary integrity is invalid"],
  [(s) => ["complete", "partial", "interrupted", "bypassed", "unmanaged"].includes(s.coverage), "summary coverage is invalid"],
  [(s) => ["complete", "incomplete", "unexplained", "invalid"].includes(s.verdict), "summary verdict is invalid"],
  [(s) => nullable(s.diff_digest, /^sha256:[0-9a-f]{64}$/), "summary diff_digest is invalid"],
  [(s) => codes(s.gaps) && codes(s.unexplained), "summary gaps and unexplained must be sorted unique codes"],
  [(s) => exactKeys(s.counts, COUNT_KEYS) && COUNT_KEYS.slice(0, -1).every((key) => count(s.counts[key])), "summary counts are invalid"],
  [(s) => plainObject(s.counts.by_class) && Object.entries(s.counts.by_class).every(([name, value]) => CODE.test(name) && count(value)), "summary by_class counts are invalid"],
];

function summaryViolation(summary) {
  if (!exactKeys(summary, SUMMARY_KEYS)) return "summary must carry exactly the redacted summary fields";
  const failed = SUMMARY_RULES.find(([holds]) => !holds(summary));
  return failed ? failed[1] : null;
}

function exceptionViolation(exception, summary) {
  if (exception === null) return null;
  if (!exactKeys(exception, EXCEPTION_KEYS)) return "exception must carry exactly the technical-exception fields";
  if (exception.schema !== "coord.managed-execution-exception/v1" || exception.legal_waiver !== false) return "exception schema is unsupported";
  if (exception.summary_digest !== summary.summary_digest || exception.chain_root !== summary.chain_root) return "exception must bind the recorded summary";
  if (!codes(exception.gaps) || exception.gaps.length === 0) return "exception must name its gaps";
  if (exception.gaps.join("\n") !== [...summary.gaps, ...summary.unexplained].sort().join("\n")) return "exception must name exactly the summary gaps";
  if (!boundedText(exception.reason, 500) || !boundedText(exception.residual_risk, 500) || !boundedText(exception.approval, 500)) {
    return "exception requires a reason, a residual-risk statement and the human-admin approval";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(exception.actor) || Number.isNaN(Date.parse(exception.recorded_at))) return "exception actor or time is invalid";
  return null;
}

function managedExecutionViolation(value) {
  if (!exactKeys(value, RECORD_KEYS)) return "managed_execution must carry exactly summary, exception, recorded_at and actor";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.actor) || Number.isNaN(Date.parse(value.recorded_at))) return "managed_execution actor or time is invalid";
  return summaryViolation(value.summary) || exceptionViolation(value.exception, value.summary);
}

function validateManagedExecutionRecord(record, reject) {
  if (record.managed_execution === undefined) return;
  const violation = managedExecutionViolation(record.managed_execution);
  if (violation) reject(`Plan record managed_execution is invalid: ${violation}.`);
}

function applyManagedExecutionToRecord(record, options, reject) {
  const request = options.managedExecution;
  if (!plainObject(request) || request[MANAGED_EXECUTION_WRITE] !== true) {
    reject("managed_execution is written only by gov record-managed-evidence.");
  }
  const violation = managedExecutionViolation(request.value);
  if (violation) reject(`managed_execution is invalid: ${violation}.`);
  record.managed_execution = request.value;
}

function renderManagedExecutionSection(lines, record) {
  if (record.managed_execution === undefined) return;
  lines.push(`- ${SECTION}:`);
  lines.push(`  - ${JSON.stringify(record.managed_execution)}`);
}

module.exports = {
  MANAGED_EXECUTION_WRITE, applyManagedExecutionToRecord, managedExecutionViolation, renderManagedExecutionSection,
  validateManagedExecutionRecord,
};
