"use strict";

// COORD-164: BRIDGE — server bootstrap jobs satisfied by production-MCP receipts
// (Server bootstrap P6).
//
// This module connects two already-built subsystems WITHOUT introducing a third
// parallel enforcement gate:
//
//   PRODUCTION-MCP LANE
//     - COORD-152 receipt schema + OPERATION_CLASSES + validateLiveMcpReceipt
//       (runtime-evidence.js)
//     - COORD-153 live-mcp lifecycle ENFORCEMENT (live-mcp-lifecycle.js): the
//       BLOCKING closeout gate for tickets that declare a `live_mcp` plan object.
//       It already enforces "no closeout while cleanup pending" and "redaction
//       required for sensitive/prod operation classes".
//     - COORD-155 temp-access-cleanup-reference.js: an ECS one-off / temporary
//       access cleanup receipt built on the COORD-152 substrate, whose
//       `live_mcp.cleanup` field carries stop/revoke proof and whose
//       `receipt.temp_access` block carries the task/resource id, timeout, and
//       cleanup state.
//
//   SERVER BOOTSTRAP LANE
//     - COORD-159 `bootstrap_risk` plan object (observability_requirements, etc.)
//     - COORD-160 bootstrap-advisory.js (WARNING-ONLY surfacing)
//     - COORD-161 bootstrap receipt schema + validateBootstrapReceipt
//       (runtime-evidence.js): observability, idempotency, disable/rollback, etc.
//
// THE PROBLEM THIS SOLVES:
//   When a server bootstrap job is ACTUALLY EXECUTED as a live/production MCP
//   operation (e.g. an ECS one-off task running the backfill), forcing the author
//   to emit a SECOND, parallel bootstrap receipt is redundant: the live-MCP
//   receipt already carries the task/resource id, timeout, stopped/completed
//   state, log/metric pointer, redaction, and cleanup state. This module defines
//   how that ONE live-MCP receipt SATISFIES the bootstrap job's evidence
//   requirements (observability, ECS one-off task record, cleanup, and
//   fixture/test/spec promotion), and what (if anything) is still missing.
//
// SCOPE (STRICT, EXPLICIT, NON-FUZZY — mirrors COORD-153):
//   This bridge is governed ONLY for a ticket whose plan record declares BOTH
//   the COORD-153 `live_mcp` object AND the COORD-159 `bootstrap_risk` object.
//   That co-presence is the explicit, author-authored signal "this server
//   bootstrap job is executed as a live-MCP operation". Reusing the two existing
//   plan fields means NO new plan field, NO new CLI flag, and NO change to the
//   canonical plan-record serialization — so no existing record's bytes move.
//
//   Every other ticket is COMPLETELY unaffected: a normal ticket (neither field),
//   a bootstrap-only ticket (`bootstrap_risk` but no `live_mcp` — it still needs
//   its own COORD-161 bootstrap receipt; it is NOT silently satisfied), and a
//   live-mcp-only ticket (`live_mcp` but no `bootstrap_risk` — governed by
//   COORD-153 alone) all return `declared:false`, no issues, from THIS module.
//
// ENFORCEMENT — REUSE, NOT A THIRD GATE:
//   `buildBootstrapViaLiveMcpLifecycle` does NOT re-check cleanup/redaction/
//   receipt/approval. Those stay with the existing COORD-153 gate
//   (`buildLiveMcpLifecycle`), which already runs on the same `live_mcp` object.
//   This module adds ONLY the bootstrap-coverage blocker: closeout is blocked if
//   the live-MCP receipt does not actually cover the bootstrap evidence the job
//   needs. Because COORD-153 already runs in governance-validation for any ticket
//   with `live_mcp`, cleanup-pending and missing-redaction continue to block here
//   through that SAME gate — this module never competes with it.
//
// NON-GOALS (COORD-164): no broad deploy automation; NO raw production payloads
// or credentials embedded; receipts stay redacted/customer-safe and tests use
// synthetic data only.

function isMeaningfulString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The bootstrap evidence requirements a live-MCP receipt can satisfy when the
// bootstrap job is executed as a live/production MCP operation. Each maps to a
// concrete check against the receipt's fields. Ordered for stable output.
const BOOTSTRAP_REQUIREMENTS = Object.freeze([
  "ecs_one_off_task_record", // task/resource id + timeout + stopped/completed state
  "observability", // log/metric pointer (no raw logs/payloads committed)
  "cleanup", // cleanup proven complete (pending/failed/absent => unmet)
  "redaction", // redaction recorded (no raw production payloads)
  "promotion", // fixture/test/spec promotion when the finding changes product behavior
]);

// A live-mcp declaration is the structured plan-record `live_mcp` object.
function readLiveMcp(planState) {
  return isPlainObject(planState && planState.live_mcp) ? planState.live_mcp : null;
}

// A bootstrap-risk declaration is the structured plan-record `bootstrap_risk`
// object (COORD-159).
function readBootstrapRisk(planState) {
  return isPlainObject(planState && planState.bootstrap_risk) ? planState.bootstrap_risk : null;
}

// The bridge is "declared" only when BOTH fields are present — the explicit
// signal that a server bootstrap job is run as a live-MCP operation.
function isBridgeDeclared(planState) {
  return Boolean(readLiveMcp(planState) && readBootstrapRisk(planState));
}

// Resolve the live-MCP receipt to field-map. The COORD-153 declaration may carry
// an inline `receipt` object; a path-only reference cannot be field-mapped here.
function resolveLiveMcpReceipt(liveMcp) {
  return isPlainObject(liveMcp.receipt) ? liveMcp.receipt : null;
}

// A receipt's ECS one-off task record lives on the COORD-155 `temp_access` block
// (resource/task id, timeout, cleanup state) when the bootstrap job ran as a
// temp-access ECS task, or on explicit top-level fields. We accept either.
function readTaskRecord(receipt) {
  const temp = isPlainObject(receipt.temp_access) ? receipt.temp_access : {};
  const pick = (...candidates) => {
    for (const c of candidates) {
      if (isMeaningfulString(c)) return c.trim();
    }
    return null;
  };
  return {
    resource_id: pick(temp.resource_id, receipt.task_id, receipt.resource_id),
    timeout: pick(temp.timeout, receipt.timeout),
    // Terminal state: from temp_access cleanup_state (completed/failed are
    // terminal for the task) or an explicit task_state. "pending"/"running" are
    // NOT terminal.
    task_state: pick(temp.cleanup_state, receipt.task_state),
  };
}

// A log/metric pointer: a redacted query/dashboard pointer, never raw logs.
// Accept explicit `logs`/`metrics` pointers, or an evidence line naming one.
function hasObservabilityPointer(receipt) {
  if (isMeaningfulString(receipt.logs) || isMeaningfulString(receipt.metrics)) {
    return true;
  }
  const evidence = Array.isArray(receipt.evidence) ? receipt.evidence : [];
  return evidence.some(
    (line) =>
      isMeaningfulString(line) &&
      /\b(log|logs|metric|metrics|dashboard|trace|query pointer)\b/i.test(line)
  );
}

// mapLiveMcpReceiptToBootstrapEvidence — pure. Given a live-MCP receipt, decide
// which bootstrap evidence requirements it satisfies and which are unmet.
//
// Returns:
//   {
//     satisfied: { [requirement]: boolean },
//     unmet: string[],            // requirements NOT satisfied (excludes n/a promotion)
//     cleanup_state: "completed" | "pending" | "failed" | "absent",
//     expects_promotion: boolean,
//     mapped_fields: { ... }      // which receipt fields fed each decision
//   }
//
// `expectsPromotion` (default false): set true when the bootstrap finding changed
// product behavior, so fixture/test/spec promotion is a required evidence item.
// When false, promotion is not applicable and never appears unmet.
function mapLiveMcpReceiptToBootstrapEvidence(receipt, options = {}) {
  const expectsPromotion = options.expectsPromotion === true;
  const safe = isPlainObject(receipt) ? receipt : {};
  const task = readTaskRecord(safe);

  // cleanup state: prefer the COORD-155 temp_access cleanup_state; else infer
  // from the presence of the COORD-152 `cleanup` field (proof present => done).
  const tempState =
    isPlainObject(safe.temp_access) && isMeaningfulString(safe.temp_access.cleanup_state)
      ? safe.temp_access.cleanup_state.trim()
      : null;
  let cleanupState;
  if (tempState) {
    cleanupState = tempState; // pending | completed | failed
  } else if (isMeaningfulString(safe.cleanup)) {
    cleanupState = "completed";
  } else {
    cleanupState = "absent";
  }

  // The ECS one-off task record needs id + timeout + a TERMINAL (stopped/
  // completed) state. A task still pending/running does not yet prove it.
  const taskTerminal =
    task.task_state === "completed" ||
    task.task_state === "stopped" ||
    task.task_state === "failed";
  const ecsRecordSatisfied = Boolean(task.resource_id && task.timeout && taskTerminal);

  const observabilitySatisfied = hasObservabilityPointer(safe);
  const redactionSatisfied = isMeaningfulString(safe.redaction);
  // Cleanup is satisfied only when proven complete. pending/failed/absent are NOT
  // satisfied — this is the load-bearing "cleanup-pending blocks" mapping.
  const cleanupSatisfied = cleanupState === "completed";
  // Promotion is only a requirement when the finding changed product behavior.
  const promotionSatisfied = !expectsPromotion || isMeaningfulString(safe.promotion);

  const satisfied = {
    ecs_one_off_task_record: ecsRecordSatisfied,
    observability: observabilitySatisfied,
    cleanup: cleanupSatisfied,
    redaction: redactionSatisfied,
    promotion: promotionSatisfied,
  };

  const unmet = BOOTSTRAP_REQUIREMENTS.filter((req) => satisfied[req] === false);

  return {
    satisfied,
    unmet,
    cleanup_state: cleanupState,
    expects_promotion: expectsPromotion,
    mapped_fields: {
      resource_id: task.resource_id,
      timeout: task.timeout,
      task_state: task.task_state,
      task_terminal: taskTerminal,
      has_observability_pointer: observabilitySatisfied,
      redaction: isMeaningfulString(safe.redaction) ? safe.redaction.trim() : null,
      cleanup_field_present: isMeaningfulString(safe.cleanup),
      promotion: isMeaningfulString(safe.promotion) ? safe.promotion.trim() : null,
    },
  };
}

function buildIssue(code, message, nextSteps) {
  return { code, message, next_steps: nextSteps };
}

const REMEDIATION =
  "Back each unmet bootstrap requirement with the live-MCP receipt embedded on the " +
  "`live_mcp` plan object (task/resource id + timeout + stopped/completed state for the ECS " +
  "one-off task; a redacted log/metric pointer for observability; proven cleanup completion; " +
  "recorded redaction; promotion for product-impacting findings), or emit a separate COORD-161 " +
  "bootstrap receipt for the uncovered items. See coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md " +
  "and coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md.";

// Which bootstrap requirements is the live-MCP receipt being asked to satisfy?
// Sourced from `bootstrap_risk.observability_requirements` (COORD-159) and the
// always-applicable ECS-task + cleanup + redaction core. Promotion is added when
// the live_mcp declaration marks the finding product-impacting.
function requiredBootstrapEvidence(liveMcp, bootstrapRisk) {
  const required = new Set(["ecs_one_off_task_record", "cleanup", "redaction"]);
  // bootstrap_risk explicitly lists observability requirements => the receipt
  // must carry an observability pointer.
  const obs = bootstrapRisk && bootstrapRisk.observability_requirements;
  if (Array.isArray(obs) && obs.some((entry) => isMeaningfulString(entry))) {
    required.add("observability");
  }
  // Product-impacting live findings require fixture/test/spec promotion (plan §7
  // step 6) — the same product_impact signal COORD-153 reads.
  const impact = liveMcp.product_impact;
  if (impact === true || impact === "yes" || impact === "true") {
    required.add("promotion");
  }
  return required;
}

// buildBootstrapViaLiveMcpLifecycle — pure. The bootstrap-coverage half of the
// single coherent closeout gate for a "bootstrap job executed as a live-MCP
// operation" ticket. Returns { declared, issues } in the same shape as
// buildLiveMcpLifecycle so it composes directly into governance-validation
// ALONGSIDE the COORD-153 gate (which supplies cleanup/redaction/receipt/approval
// enforcement on the same `live_mcp` object — this module never duplicates it).
//
// For any ticket NOT declaring BOTH live_mcp and bootstrap_risk: declared:false,
// issues:[] — no existing ticket is affected.
function buildBootstrapViaLiveMcpLifecycle({ planState } = {}) {
  if (!isBridgeDeclared(planState)) {
    return { declared: false, issues: [] };
  }

  const liveMcp = readLiveMcp(planState);
  const bootstrapRisk = readBootstrapRisk(planState);
  const issues = [];

  const receipt = resolveLiveMcpReceipt(liveMcp);

  // The bridge can only confirm coverage from an inline receipt. A path-only /
  // missing inline receipt cannot be field-mapped, so coverage is undetermined —
  // block (do NOT silently satisfy). (COORD-153 separately requires SOME receipt
  // evidence; this is the stricter "must be field-mappable to prove coverage".)
  if (!receipt) {
    issues.push(
      buildIssue(
        "bootstrap_via_live_mcp_receipt",
        "This server-bootstrap job declares it runs as a live-MCP operation (live_mcp + bootstrap_risk " +
          "both present) but no inline live-MCP receipt is available to map. Embed the receipt on " +
          "live_mcp.receipt so its task/resource id, timeout, state, observability pointer, redaction, " +
          "and cleanup state can be verified against the bootstrap evidence requirements. A path-only " +
          "reference cannot prove bootstrap coverage.",
        [REMEDIATION]
      )
    );
    return { declared: true, issues };
  }

  const required = requiredBootstrapEvidence(liveMcp, bootstrapRisk);
  const expectsPromotion = required.has("promotion");
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(receipt, { expectsPromotion });

  const uncovered = [...required].filter(
    (req) => BOOTSTRAP_REQUIREMENTS.includes(req) && mapping.satisfied[req] === false
  );

  if (uncovered.length > 0) {
    issues.push(
      buildIssue(
        "bootstrap_via_live_mcp_coverage",
        "The live-MCP receipt does not cover the server-bootstrap evidence requirement(s) this job " +
          `needs: ${uncovered.join(", ")}. ` +
          `(cleanup_state=${mapping.cleanup_state}; ` +
          `task_state=${mapping.mapped_fields.task_state || "absent"}; ` +
          `observability_pointer=${mapping.mapped_fields.has_observability_pointer}; ` +
          `redaction=${mapping.mapped_fields.redaction ? "present" : "absent"}; ` +
          `promotion=${mapping.mapped_fields.promotion ? "present" : "absent"}.)`,
        [REMEDIATION]
      )
    );
  }

  return { declared: true, issues, mapping };
}

module.exports = {
  buildBootstrapViaLiveMcpLifecycle,
  mapLiveMcpReceiptToBootstrapEvidence,
  isBridgeDeclared,
  BOOTSTRAP_REQUIREMENTS,
};
