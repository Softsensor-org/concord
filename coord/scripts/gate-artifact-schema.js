"use strict";

// COORD-080 (QGATE-006): gate-artifact completeness schema + validator.
//
// This module is the SINGLE SOURCE OF TRUTH for the *shape* of a complete gate
// artifact. Historically the clean-checkout gate runner (gate-runtime.js) would
// SYNTHESIZE a thin artifact whenever a repo's gate runner did not emit one
// (e.g. the bash `scripts/gate.sh` path) — duration/budget showed up as
// "unknown", and there was no coverage/audit/command-list at all. That was
// useful for keeping the downstream annotate/record/provenance path alive, but
// completeness was silently papered over: a thin synthesized artifact and a
// fully-instrumented one looked the same to the board.
//
// This module makes completeness MEASURED. It defines:
//   - REQUIRED_FIELDS: the field list a complete gate artifact must populate.
//   - validateGateArtifact(artifact): returns { complete, missing, present }.
// gate-runtime.js validates every emitted/synthesized artifact against this and
// records `complete: false` + `incomplete_fields` rather than crashing — the
// minimal zero-dependency template stubs still produce a VALID (mostly-skipped)
// artifact, but the board can now see exactly which fields were synthesized.
//
// Boundary: this module is pure schema + validation. It does NOT run gates,
// touch the board, or write files. gate-runtime.js owns gate EXECUTION + the
// artifact write; gates.js owns the board-record attribution surface; this
// module is the artifact-shape contract both can reference. It mirrors
// audit-policy.js / coverage-policy.js (single-source the policy/shape once,
// in Node, rather than re-typing it in bash on every repo).

// The fields a COMPLETE gate artifact must carry. Each is a top-level key on the
// artifact object. Order is the documented/reported order (see
// coord/product/TESTING_AND_GATES.md, "Gate-artifact completeness schema").
//
//  - lane:           the gate lane that ran (default | full | ci).
//  - commit:         the commit sha the gate ran against (real, from git rev-parse).
//  - result:         the gate verdict ("pass" | "fail").
//  - duration_ms:    real wall-clock duration of the gate run, in ms (a number).
//  - command_list:   the ordered list of step/command labels the lane executed.
//  - coverage:       the coverage summary (077 format) OR null + a `coverage_skip_reason`.
//  - audit:          the audit summary (076 format)    OR null + an `audit_skip_reason`.
//  - artifact_paths: the list of files written under coord/artifacts/gates/<repo>/.
const REQUIRED_FIELDS = Object.freeze([
  "lane",
  "commit",
  "result",
  "duration_ms",
  "command_list",
  "coverage",
  "audit",
  "artifact_paths",
]);

// A field counts as "present" when its key exists and carries a usable value.
// `coverage` / `audit` are the deliberate exception: null is an ALLOWED value
// (the signal was legitimately skipped — no lockfile, no tests, off the lane),
// PROVIDED the artifact also carries the matching `<field>_skip_reason`. This is
// what lets the minimal template stubs emit a complete-but-mostly-skipped
// artifact instead of being marked incomplete for honestly skipping a signal.
const NULLABLE_WITH_REASON = Object.freeze({
  coverage: "coverage_skip_reason",
  audit: "audit_skip_reason",
});

function hasUsableValue(field, value, artifact) {
  if (Object.prototype.hasOwnProperty.call(NULLABLE_WITH_REASON, field)) {
    // null is allowed only when the paired skip-reason is a non-empty string.
    if (value === null || value === undefined) {
      const reasonKey = NULLABLE_WITH_REASON[field];
      const reason = artifact ? artifact[reasonKey] : undefined;
      return typeof reason === "string" && reason.trim().length > 0;
    }
    // A non-null summary must be a non-empty string (the 076/077 one-liner).
    return typeof value === "string" ? value.trim().length > 0 : true;
  }

  if (value === null || value === undefined) return false;

  switch (field) {
    case "duration_ms":
      // Real duration: a finite, non-negative number. "unknown" / null fail.
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "command_list":
      // The ordered list of steps the lane ran — must be a non-empty array.
      return Array.isArray(value) && value.length > 0;
    case "artifact_paths":
      // The files written under coord/artifacts/gates/<repo>/ — non-empty array.
      return Array.isArray(value) && value.length > 0;
    case "result":
      return value === "pass" || value === "fail";
    case "lane":
    case "commit":
      return typeof value === "string" && value.trim().length > 0;
    default:
      return true;
  }
}

// Validate an artifact object against the completeness schema.
// Returns { complete, missing, present } where:
//   - complete: true iff every REQUIRED_FIELDS entry has a usable value
//   - missing:  the subset of REQUIRED_FIELDS that are absent/unusable
//   - present:  the complement (the fields that validated)
function validateGateArtifact(artifact) {
  const obj = artifact && typeof artifact === "object" ? artifact : {};
  const missing = [];
  const present = [];
  for (const field of REQUIRED_FIELDS) {
    if (hasUsableValue(field, obj[field], obj)) {
      present.push(field);
    } else {
      missing.push(field);
    }
  }
  return { complete: missing.length === 0, missing, present };
}

// One-line, grep-friendly summary the runner prints + the gate signal records.
// e.g. "artifact: complete fields=8/8" or
//      "artifact: incomplete fields=5/8 missing=duration_ms,command_list,coverage"
function formatCompletenessSummary(validation) {
  const total = REQUIRED_FIELDS.length;
  const present = validation.present.length;
  if (validation.complete) {
    return `artifact: complete fields=${present}/${total}`;
  }
  return `artifact: incomplete fields=${present}/${total} missing=${validation.missing.join(",")}`;
}

module.exports = {
  REQUIRED_FIELDS,
  NULLABLE_WITH_REASON,
  validateGateArtifact,
  formatCompletenessSummary,
};
