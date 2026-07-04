"use strict";

// COORD-153: live-MCP lifecycle ENFORCEMENT (Production MCP P2).
//
// This module is the governed closeout gate for `live-mcp` tickets — tickets
// that declare they perform a live/production MCP operation. It is the
// enforcement counterpart to COORD-160's advisory bootstrap surfacing, but
// where bootstrap-advisory.js is WARNING-ONLY, this module is BLOCKING for the
// narrow, explicitly-declared population it governs.
//
// CONTRACT:
//   - DETECTION IS EXPLICIT, NOT FUZZY. A ticket is governed here only when its
//     canonical plan record carries a structured `live_mcp` object (declared by
//     the author via `gov update-plan --live-mcp '<json>'`). Description
//     keyword heuristics are deliberately NOT used: an enforcement gate must not
//     retroactively block normal tickets or existing closed tickets that merely
//     mention "production" or "mcp". When `live_mcp` is absent the result is
//     `{ declared: false, issues: [] }` and nothing downstream changes.
//   - The required-evidence list is sourced from the production-MCP plan
//     (coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md) and the operation-class policy
//     in runtime-evidence.js (the COORD-152 substrate). We REUSE that policy
//     (OPERATION_CLASSES) rather than re-deriving approval/redaction/cleanup
//     rules, and we REUSE validateLiveMcpReceipt for the embedded/declared
//     receipt so receipt parsing is never reinvented.
//   - Governance core governs INTENT + EVIDENCE only. This module never calls a
//     production tool, never reads a real adapter, and never touches the
//     network. It only inspects the declared plan object and (optionally) a
//     receipt the author embedded or pointed at.

const { OPERATION_CLASSES, validateLiveMcpReceipt } = require("./runtime-evidence.js");

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// A live-mcp declaration is the structured plan-record `live_mcp` object. Any
// other shape (null/array/scalar) is treated as "not declared" so a malformed
// field can never silently disable the gate — it surfaces as a declared ticket
// with a malformed_declaration blocker instead (see below).
function readLiveMcpDeclaration(planState) {
  const declaration = planState && planState.live_mcp;
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return null;
  }
  return declaration;
}

// Normalize the boolean-ish "product_impact" flag. Live findings that influenced
// product behavior require fixture/test/spec promotion evidence (plan rule §7,
// success criteria §14). Treated as true only on an explicit truthy declaration.
function declaresProductImpact(declaration) {
  const value = declaration.product_impact;
  return value === true || value === "yes" || value === "true";
}

// The embedded receipt may be supplied inline as `live_mcp.receipt` (an object)
// or referenced by path as `live_mcp.receipt_path` (a string). Either satisfies
// the "recorded receipt" requirement; an inline object is additionally
// validated for structural completeness via the COORD-152 verifier.
function hasReceiptEvidence(declaration) {
  if (isMeaningfulString(declaration.receipt_path)) {
    return true;
  }
  const receipt = declaration.receipt;
  return Boolean(receipt && typeof receipt === "object" && !Array.isArray(receipt));
}

function buildIssue(code, message, nextSteps) {
  return { code, message, next_steps: nextSteps };
}

const REMEDIATION =
  'Declare the missing fields with `coord/scripts/gov update-plan <ticket> --live-mcp ' +
  "'{\"adapter\":\"<adapter>\",\"operation\":\"<op>\",\"operation_class\":\"<class>\"," +
  '"environment":"<local|staging|prod>","scope":"<explicit scope>"}\'. ' +
  "See coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md.";

// buildLiveMcpLifecycle — pure. Given a board row and the parsed plan state,
// return { declared, issues }. `issues` is the ordered list of BLOCKING
// closeout/move-review readiness blockers (same {code,message,next_steps} shape
// the rest of governance-validation emits, so it composes directly). For a
// non-live-mcp ticket `declared` is false and `issues` is always empty.
function buildLiveMcpLifecycle({ planState } = {}) {
  const declaration = readLiveMcpDeclaration(planState);
  if (!declaration) {
    return { declared: false, issues: [] };
  }

  const issues = [];

  // operation class is the keystone: it selects approval/redaction/cleanup
  // policy. An unknown/missing class fails closed (mirrors runtime-evidence
  // fail-closed validation) and short-circuits the policy-derived checks.
  const operationClass = isMeaningfulString(declaration.operation_class)
    ? declaration.operation_class.trim()
    : null;
  const policy = operationClass ? OPERATION_CLASSES[operationClass] : null;

  if (!operationClass) {
    issues.push(buildIssue(
      "live_mcp_operation_class",
      "Live-MCP ticket must declare an operation_class (one of " +
        `${Object.keys(OPERATION_CLASSES).join(", ")}).`,
      [REMEDIATION]
    ));
  } else if (!policy) {
    issues.push(buildIssue(
      "live_mcp_operation_class",
      `Live-MCP ticket declares an unsupported operation_class "${operationClass}". ` +
        `Use one of ${Object.keys(OPERATION_CLASSES).join(", ")}.`,
      [REMEDIATION]
    ));
  }

  // Always-required intent fields, regardless of class (plan §6).
  const requiredFields = [
    ["adapter", "adapter"],
    ["operation", "operation"],
    ["environment", "environment"],
    ["scope", "explicit scope"],
  ];
  for (const [key, label] of requiredFields) {
    if (!isMeaningfulString(declaration[key])) {
      issues.push(buildIssue(
        `live_mcp_${key}`,
        `Live-MCP ticket must declare ${label}.`,
        [REMEDIATION]
      ));
    }
  }

  // A recorded receipt (embedded object or referenced path) is required for
  // every live-MCP operation (plan §7 step 5; success criteria §14). When the
  // receipt is embedded inline, validate it structurally with the COORD-152
  // verifier rather than reimplementing receipt parsing.
  if (!hasReceiptEvidence(declaration)) {
    issues.push(buildIssue(
      "live_mcp_receipt",
      "Live-MCP ticket must record a receipt (embed live_mcp.receipt or set live_mcp.receipt_path).",
      [
        "coord/scripts/gov live-mcp-record <ticket> --adapter <a> --operation <op> --class <class> --scope <scope> --evidence <path> ...",
        REMEDIATION,
      ]
    ));
  } else if (declaration.receipt && typeof declaration.receipt === "object" && !Array.isArray(declaration.receipt)) {
    // Validate the embedded receipt with the COORD-152 verifier (which fails by
    // throwing via its injected fail()), translating any failure into a blocker
    // rather than letting it propagate as an exception.
    try {
      validateLiveMcpReceipt(declaration.receipt, (message) => {
        throw new Error(message);
      });
    } catch (error) {
      issues.push(buildIssue(
        "live_mcp_receipt_invalid",
        `Live-MCP ticket embedded receipt is invalid: ${error.message}`,
        [REMEDIATION]
      ));
    }
  }

  // Policy-derived requirements. Only evaluated once the class resolves to a
  // known policy, so an unknown class does not produce duplicate/false sub-blockers.
  if (policy) {
    if (policy.redaction === "required" && !isMeaningfulString(declaration.redaction)) {
      issues.push(buildIssue(
        "live_mcp_redaction",
        `Live-MCP operation_class "${operationClass}" requires redaction evidence for sensitive reads ` +
          "(declare live_mcp.redaction, e.g. masked|summary|hash).",
        [REMEDIATION]
      ));
    }
    if (policy.approval !== "ticket" && !isMeaningfulString(declaration.approval)) {
      issues.push(buildIssue(
        "live_mcp_approval",
        `Live-MCP operation_class "${operationClass}" requires approval evidence ` +
          `(${policy.approval}); declare live_mcp.approval with the approver.`,
        [REMEDIATION]
      ));
    }
    if (policy.cleanup && !isMeaningfulString(declaration.cleanup)) {
      issues.push(buildIssue(
        "live_mcp_cleanup",
        `Live-MCP operation_class "${operationClass}" requires cleanup completion evidence ` +
          "before closeout (declare live_mcp.cleanup with the stop/revoke proof).",
        [REMEDIATION]
      ));
    }
  }

  // Explicit, author-declared cleanup requirement independent of class policy:
  // a ticket may set cleanup_required=true (e.g. a temporary debug task) even on
  // a class whose default policy does not force cleanup. Closeout cannot proceed
  // while that cleanup is unrecorded (plan §9: no closeout while cleanup pending).
  const cleanupRequiredExplicit =
    declaration.cleanup_required === true ||
    declaration.cleanup_required === "yes" ||
    declaration.cleanup_required === "true";
  const cleanupAlreadyFlagged = issues.some((issue) => issue.code === "live_mcp_cleanup");
  if (cleanupRequiredExplicit && !cleanupAlreadyFlagged && !isMeaningfulString(declaration.cleanup)) {
    issues.push(buildIssue(
      "live_mcp_cleanup",
      "Live-MCP ticket declares cleanup_required=true but records no cleanup completion evidence; " +
        "closeout cannot proceed while cleanup is pending.",
      [REMEDIATION]
    ));
  }

  // Fixture/test/spec promotion: when a live observation influenced product
  // behavior the finding must be promoted before closeout (plan §7 step 6).
  if (declaresProductImpact(declaration) && !isMeaningfulString(declaration.promotion)) {
    issues.push(buildIssue(
      "live_mcp_promotion",
      "Live-MCP ticket marked product-impacting must record fixture/test/spec promotion evidence " +
        "(declare live_mcp.promotion).",
      [REMEDIATION]
    ));
  }

  return { declared: true, issues };
}

module.exports = {
  buildLiveMcpLifecycle,
  readLiveMcpDeclaration,
};
