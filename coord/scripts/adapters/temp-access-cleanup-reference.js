"use strict";

// COORD-155: temporary-access / AWS ECS cleanup-receipt adapter REFERENCE
// (Production MCP P4).
//
// This module is a GENERIC, REUSABLE *reference pattern* — a template adopters
// copy and OWN — for SHORT-LIVED operational access: one-off ECS debug tasks,
// temporary security-group ingress, debug ports, elevated roles, or temporary
// tokens. It is deliberately domain-neutral: "temporary elevated access" is the
// shape; AWS ECS is only the motivating example. coord-template ships the
// PATTERN; the adopter owns the real wiring (the actual ECS RunTask / authorize
// ingress / assume-role call, the real ARNs, the real revoke command).
//
// HARD NON-GOALS (enforced by tests):
//   - NO broad deploy automation. This is access lifecycle + cleanup receipts,
//     not a deployer.
//   - NO real AWS credentials, account ids, or resource ARNs committed.
//   - NO real AWS / network call. This module NEVER touches the network. The
//     adopter injects `openAccess` and `runCleanup` executors; tests inject
//     synthetic ones.
//
// WHAT THE PATTERN MODELS (the P4 ticket shape):
//   A temporary-access GRANT opens short-lived access to a named resource and
//   records WHAT was opened (task/resource identifier), HOW LONG it may live
//   (timeout), and a planned STOP/REVOKE command. Access is only legitimate if
//   it is later CLEANED UP: the resource is stopped/revoked, stop/revoke
//   evidence is captured, and a cleanup timestamp is recorded. A cleanup that
//   never ran (pending) or that failed leaves the grant in a non-closeable
//   state — the receipt records that failure state explicitly.
//
// HOW CLEANUP-PENDING BLOCKS CLOSEOUT (REUSE, not a parallel gate):
//   COORD-153 (live-mcp-lifecycle.js) already enforces "no closeout while
//   cleanup pending" for write_prod/destructive operation classes AND for any
//   ticket that declares cleanup_required=true. It treats the `live_mcp.cleanup`
//   field as the cleanup-completion evidence: present => satisfied, absent =>
//   blocked. This adapter feeds exactly that gate. It builds a COORD-152
//   write_prod (or destructive) receipt via the COORD-152 substrate, and emits a
//   ready-to-embed `live_mcp` plan declaration whose `cleanup` field is:
//     - ABSENT while cleanup is pending      => COORD-153 blocks closeout;
//     - ABSENT when cleanup FAILED (+ the failure surfaced in the receipt)
//                                             => COORD-153 blocks closeout;
//     - PRESENT (stop/revoke evidence + timestamp) when cleanup completed
//                                             => COORD-153 lets closeout proceed.
//   We do NOT re-implement a cleanup gate here; we shape evidence for the
//   existing one.
//
// REUSE, do not reinvent: receipts go through runtime-evidence.js
// (`normalizeLiveMcpReceipt` / `validateLiveMcpReceipt`, the COORD-152
// substrate). Temporary elevated access maps to operation_class `write_prod` by
// default (it mutates production state — a running task, an open ingress rule, a
// granted role) and may be escalated to `destructive`; both require cleanup,
// approval, and redaction per OPERATION_CLASSES.

const {
  normalizeLiveMcpReceipt,
  validateLiveMcpReceipt,
  OPERATION_CLASSES,
} = require("../runtime-evidence.js");

// Temporary elevated access mutates production state, so it defaults to
// write_prod (approval=human, redaction=required, cleanup=required). Adopters
// may escalate to "destructive" for harder operations (e.g. break-glass roles).
const DEFAULT_OPERATION_CLASS = "write_prod";

// Operation classes whose policy forces cleanup. We only allow temp-access
// grants on a cleanup-bearing class so the COORD-153 gate is always armed.
const CLEANUP_BEARING_CLASSES = Object.freeze(
  Object.keys(OPERATION_CLASSES).filter((name) => OPERATION_CLASSES[name].cleanup)
);

// The three terminal cleanup states.
const CLEANUP_STATES = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
});

// Field names that, if present in a committed access descriptor, would indicate
// a real secret/credential leaked into source. Used by redaction so a token
// reference never reaches the evidence record as a raw value.
const DEFAULT_SECRET_FIELDS = Object.freeze([
  "token",
  "secret",
  "credential",
  "credentials",
  "password",
  "session_token",
  "access_key",
  "secret_key",
  "private_key",
]);

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function trimmed(value, fallback = null) {
  return isBlank(value) ? fallback : String(value).trim();
}

class TempAccessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TempAccessError";
    this.code = code || "temp_access_error";
  }
}

// maskSecretRef — pure. A token/credential reference is recorded as a stable
// non-reversible marker; the raw value never reaches the evidence record. We
// keep only a short, non-sensitive shape hint (length bucket) so an operator can
// tell "a token was issued" without the token itself.
function maskSecretRef(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  return `[redacted:secret-ref len~${Math.min(text.length, 99)}]`;
}

// normalizeGrant — pure. Validate and normalize the temporary-access descriptor.
// REQUIRED: a resource/task identifier + a timeout + a planned stop/revoke
// command. These are the minimum to later PROVE the access was closed. Any
// secret-bearing fields are masked, never stored raw.
function normalizeGrant(grant) {
  const safe = grant && typeof grant === "object" && !Array.isArray(grant) ? grant : {};

  // Resource/task identifier(s). At least one concrete id is required. We accept
  // any of the common temporary-access shapes; a blank/missing id is refused so
  // a grant can never be untraceable.
  const resourceId =
    trimmed(safe.resource_id) ||
    trimmed(safe.task_arn) ||
    trimmed(safe.task_id) ||
    trimmed(safe.security_group_rule_id) ||
    trimmed(safe.role) ||
    trimmed(safe.port && `port:${safe.port}`);
  if (!resourceId) {
    throw new TempAccessError(
      "Temporary-access grant requires a resource/task identifier " +
        "(resource_id | task_arn | task_id | security_group_rule_id | role | port).",
      "missing_resource_id"
    );
  }

  // Timeout: how long the access may legitimately live. Required — an access
  // with no expiry is exactly the failure mode this pattern guards against.
  const timeout = trimmed(safe.timeout) || (Number.isFinite(safe.timeout_seconds)
    ? `${safe.timeout_seconds}s`
    : null);
  if (!timeout) {
    throw new TempAccessError(
      "Temporary-access grant requires a timeout (timeout or timeout_seconds).",
      "missing_timeout"
    );
  }

  // Planned stop/revoke command — recorded at grant time so cleanup is provable
  // and not improvised. Required.
  const revokeCommand = trimmed(safe.revoke_command) || trimmed(safe.stop_command);
  if (!revokeCommand) {
    throw new TempAccessError(
      "Temporary-access grant requires a planned stop/revoke command (revoke_command).",
      "missing_revoke_command"
    );
  }

  return {
    access_type: trimmed(safe.access_type) || "temporary-elevated-access",
    resource_id: resourceId,
    timeout,
    revoke_command: revokeCommand,
    started_at: trimmed(safe.started_at),
    // Token references are masked; the raw value never enters the receipt.
    token_ref: maskSecretRef(safe.token_ref || safe.token || safe.session_token),
  };
}

// normalizeCleanup — pure. Interpret the cleanup outcome into one of the three
// terminal states and validate the evidence required for "completed".
//
// completed REQUIRES BOTH:
//   - stop/revoke evidence (the executor confirmed the resource stopped/revoked)
//   - a cleanup timestamp (when it happened)
// A "completed" claim missing either is downgraded to FAILED with a reason, so a
// half-finished cleanup can never masquerade as done and slip past closeout.
function normalizeCleanup(cleanup) {
  const safe = cleanup && typeof cleanup === "object" && !Array.isArray(cleanup) ? cleanup : {};
  const claimed = trimmed(safe.state) || CLEANUP_STATES.PENDING;
  const stopEvidence = trimmed(safe.stop_evidence) || trimmed(safe.revoke_evidence);
  const cleanedAt = trimmed(safe.cleaned_at) || trimmed(safe.cleanup_timestamp);
  const failureReason = trimmed(safe.failure_reason);

  if (claimed === CLEANUP_STATES.PENDING) {
    return { state: CLEANUP_STATES.PENDING, stop_evidence: null, cleaned_at: null, failure_reason: null };
  }

  if (claimed === CLEANUP_STATES.FAILED) {
    return {
      state: CLEANUP_STATES.FAILED,
      stop_evidence: stopEvidence,
      cleaned_at: cleanedAt,
      failure_reason: failureReason || "cleanup reported failed without a reason",
    };
  }

  if (claimed === CLEANUP_STATES.COMPLETED) {
    const missing = [];
    if (!stopEvidence) missing.push("stop/revoke evidence");
    if (!cleanedAt) missing.push("cleanup timestamp");
    if (missing.length) {
      // A "completed" claim without proof is treated as a FAILED cleanup so it
      // still blocks closeout rather than silently passing.
      return {
        state: CLEANUP_STATES.FAILED,
        stop_evidence: stopEvidence,
        cleaned_at: cleanedAt,
        failure_reason: `cleanup claimed completed but missing: ${missing.join(", ")}`,
      };
    }
    return { state: CLEANUP_STATES.COMPLETED, stop_evidence: stopEvidence, cleaned_at: cleanedAt, failure_reason: null };
  }

  throw new TempAccessError(
    `Unknown cleanup state "${claimed}" (expected ${Object.values(CLEANUP_STATES).join(" | ")}).`,
    "unknown_cleanup_state"
  );
}

// buildCompactEvidence — pure. Customer-safe, secret-free summary of the grant +
// cleanup. Carries the resource id, timeout, revoke command, cleanup state, and
// (when present) the stop/revoke evidence + timestamp. Never the raw token.
function buildCompactEvidence(grant, cleanup) {
  return {
    access_type: grant.access_type,
    resource_id: grant.resource_id,
    timeout: grant.timeout,
    revoke_command: grant.revoke_command,
    token_ref: grant.token_ref, // already masked
    cleanup_state: cleanup.state,
    stop_evidence: cleanup.stop_evidence,
    cleanup_timestamp: cleanup.cleaned_at,
    failure_state: cleanup.state === CLEANUP_STATES.FAILED ? cleanup.failure_reason : null,
  };
}

// recordTempAccess — the reference entry point.
//
// Inputs:
//   ticket          — governing ticket id (required).
//   adapter         — adapter name (default "temp-access-cleanup").
//   operation       — operation name (default "open_temp_access").
//   operationClass  — write_prod (default) or destructive. Must be a
//                     cleanup-bearing class so COORD-153 enforcement is armed.
//   grant           — { resource_id|task_arn|..., timeout, revoke_command, ... }.
//   cleanup         — { state, stop_evidence, cleaned_at, failure_reason }.
//                     Defaults to { state: "pending" } (nothing cleaned yet).
//   approval        — approval evidence (write_prod/destructive require human).
//   recordReceipt   — optional injection for the COORD-152 normalizer (tests).
//
// Behavior:
//   - Normalizes + validates the grant (resource id + timeout + revoke command).
//   - Normalizes the cleanup into pending|completed|failed.
//   - Builds compact, secret-free evidence.
//   - Builds a COORD-152 write_prod receipt. The receipt's `cleanup` field is
//     populated ONLY when cleanup completed (stop/revoke evidence + timestamp);
//     for pending/failed it is left null so the live_mcp declaration that embeds
//     it leaves `cleanup` empty and COORD-153 blocks closeout.
//   - Validates the receipt via validateLiveMcpReceipt (with a relaxed fail for
//     the cleanup field while pending — see below).
//
// Returns { grant, cleanup, evidence, receipt, liveMcpDeclaration, closeoutReady }.
//   - liveMcpDeclaration is ready to embed in a plan via
//     `gov update-plan <ticket> --live-mcp '<json>'`. Its cleanup_required is
//     always true; its `cleanup` field carries completion proof or is absent.
//   - closeoutReady mirrors what COORD-153 will decide: true iff cleanup
//     completed.
function recordTempAccess(options = {}) {
  const ticket = trimmed(options.ticket);
  if (!ticket) {
    throw new TempAccessError("recordTempAccess requires a governing ticket id.", "missing_ticket");
  }

  const operationClass = trimmed(options.operationClass) || DEFAULT_OPERATION_CLASS;
  if (!CLEANUP_BEARING_CLASSES.includes(operationClass)) {
    throw new TempAccessError(
      `Temporary-access must use a cleanup-bearing operation_class ` +
        `(one of ${CLEANUP_BEARING_CLASSES.join(", ")}); got "${operationClass}".`,
      "non_cleanup_class"
    );
  }

  const adapter = trimmed(options.adapter) || "temp-access-cleanup";
  const operation = trimmed(options.operation) || "open_temp_access";

  const grant = normalizeGrant(options.grant);
  const cleanup = normalizeCleanup(options.cleanup);
  const evidence = buildCompactEvidence(grant, cleanup);

  const completed = cleanup.state === CLEANUP_STATES.COMPLETED;

  const scopeText =
    `resource=${grant.resource_id} timeout=${grant.timeout} ` +
    `access_type=${grant.access_type}`;

  const evidenceLines = [
    `${operation}: opened ${grant.access_type} on ${grant.resource_id} (timeout ${grant.timeout})`,
    `cleanup_state=${cleanup.state}` +
      (completed ? ` cleaned_at=${cleanup.cleaned_at}` : "") +
      (cleanup.state === CLEANUP_STATES.FAILED ? ` failure="${cleanup.failure_reason}"` : ""),
  ];

  // The COORD-152 cleanup field is the stop/revoke proof + timestamp — exactly
  // what COORD-153 reads as "cleanup completion evidence". Populate it ONLY when
  // cleanup is proven complete; pending/failed leave it null so the gate blocks.
  const cleanupField = completed
    ? `stopped/revoked via ${grant.revoke_command}; evidence="${cleanup.stop_evidence}"; cleaned_at=${cleanup.cleaned_at}`
    : null;

  const normalize = typeof options.recordReceipt === "function" ? options.recordReceipt : normalizeLiveMcpReceipt;

  const receiptOptions = {
    adapter,
    operationClass,
    operation,
    scope: scopeText,
    redaction: `secret-free compact evidence; token references masked; resource id retained for traceability`,
    approval: isBlank(options.approval)
      ? "human approval pending — adopter records the approver before opening prod access"
      : String(options.approval).trim(),
    cleanup: cleanupField || undefined,
    evidence: evidenceLines,
    meta: [
      `cleanup_state=${cleanup.state}`,
      `resource_id=${grant.resource_id}`,
      `timeout=${grant.timeout}`,
      completed ? "closeout_ready=true" : "closeout_ready=false",
    ],
    receiptResult: completed ? "pass" : cleanup.state === CLEANUP_STATES.FAILED ? "fail" : "observed",
  };

  // While cleanup is pending/failed, the COORD-152 normalizer WOULD reject a
  // write_prod receipt for a missing cleanup field (policy.cleanup=true). That
  // rejection is correct at on-disk RECORD time (you must not persist a
  // "finished" receipt with no cleanup proof), but the adapter must still be
  // able to PRODUCE the in-flight (pending/failed) receipt OBJECT so the
  // live_mcp declaration can be embedded and COORD-153 can surface the blocker.
  // The COORD-152 normalizer takes a `fail` callback as its THIRD positional
  // arg; we inject one that tolerates ONLY the expected "cleanup is required"
  // message while cleanup is not yet complete and re-raises everything else, so
  // every other validation rule still applies strictly.
  const lenientFail = (message) => {
    if (!completed && /cleanup is required/i.test(String(message))) {
      return;
    }
    throw new TempAccessError(message, "receipt_invalid");
  };

  const receipt = normalize(ticket, receiptOptions, lenientFail);

  // Attach the temp-access lifecycle facts to the receipt so a reader (and the
  // on-disk record) carries the failure state and identifiers explicitly.
  receipt.temp_access = {
    access_type: grant.access_type,
    resource_id: grant.resource_id,
    timeout: grant.timeout,
    revoke_command: grant.revoke_command,
    cleanup_state: cleanup.state,
    cleanup_timestamp: cleanup.cleaned_at,
    stop_evidence: cleanup.stop_evidence,
    failure_state: cleanup.state === CLEANUP_STATES.FAILED ? cleanup.failure_reason : null,
  };

  // When cleanup completed, the receipt is fully valid against COORD-152;
  // assert that so a misconfigured "completed" adopter fails here, not at the
  // COORD-153 gate.
  if (completed) {
    validateLiveMcpReceipt(receipt);
  }

  // The ready-to-embed COORD-153 declaration. cleanup_required is ALWAYS true so
  // the gate is armed even on classes whose default policy somehow weakens;
  // `cleanup` is the completion proof and is ABSENT for pending/failed, which is
  // exactly what makes COORD-153 block closeout (REUSE, not a parallel gate).
  const liveMcpDeclaration = {
    adapter,
    operation,
    operation_class: operationClass,
    environment: trimmed(options.environment) || "prod",
    scope: scopeText,
    approval: receipt.approval,
    redaction: receipt.redaction,
    cleanup_required: true,
    receipt,
  };
  if (cleanupField) {
    liveMcpDeclaration.cleanup = cleanupField;
  }

  return {
    grant,
    cleanup,
    evidence,
    receipt,
    liveMcpDeclaration,
    closeoutReady: completed,
  };
}

module.exports = {
  DEFAULT_OPERATION_CLASS,
  CLEANUP_BEARING_CLASSES,
  CLEANUP_STATES,
  DEFAULT_SECRET_FIELDS,
  TempAccessError,
  maskSecretRef,
  normalizeGrant,
  normalizeCleanup,
  buildCompactEvidence,
  recordTempAccess,
};
