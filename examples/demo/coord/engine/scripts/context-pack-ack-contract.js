"use strict";

// COORD-723: the ONE context_pack_ack shape contract for every lifecycle
// consumer. COORD-571 aligned the WRITER with coord/board/plan.schema.json, but
// the pure plan-record reader still admits acknowledgements sealed by older
// writers (string-valued considered.* fields, notes, rejected_authority), and
// each later consumer then applied its own idea of the shape:
//   - the review gate accepted a string wherever the schema demands an array, so
//     readiness and guided-closeout reported READY over a schema-invalid ack;
//   - claim / claim --transfer-to never looked at the ack at all;
//   - pr-create and submit were stopped only by the post-mutation board
//     validation, i.e. AFTER the branch push and `gh pr create` had happened.
// Every consumer now asks this module, which delegates to the same
// assertValidContextPackAck the writer uses. There is deliberately no second
// rule set here: a divergent copy is the defect this ticket closes.

const fs = require("node:fs");
const path = require("node:path");
const createPlanRecordFieldValidators = require("./plan-record-field-validators.js");

class ContextPackAckViolation extends Error {}

const { assertValidContextPackAck } = createPlanRecordFieldValidators({
  fail(message) {
    throw new ContextPackAckViolation(message);
  },
});

// Returns the canonical violation message, or null when the acknowledgement
// satisfies the schema. Strict by construction: the legacy read compatibility
// the pure reader opts into is never available to a lifecycle consumer.
function contextPackAckViolation(ack) {
  try {
    assertValidContextPackAck(ack);
    return null;
  } catch (error) {
    if (error instanceof ContextPackAckViolation) {
      return error.message;
    }
    throw error;
  }
}

function repairCommand(ticketId) {
  return `coord/scripts/gov repair-context-pack-ack ${ticketId} --context-pack-ack '<schema-valid JSON>'`;
}

function storedViolationMessage(ticketId, violation) {
  return `Plan state for ${ticketId} stores a context_pack_ack that violates the canonical schema: ${violation}`;
}

// Raw, non-normalizing, non-throwing read of one stored acknowledgement. The
// plan-record reader cannot be used for this: it tolerates the legacy shapes
// this contract must reject and throws on anything worse, and a scan has to
// REPORT a malformed record, never die on it.
function readStoredContextPackAck(ticketId, recordsDirs) {
  for (const recordsDir of recordsDirs.filter(Boolean)) {
    const filePath = path.join(recordsDir, `${ticketId}.json`);
    if (!fs.existsSync(filePath)) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      return { filePath, present: false, ack: undefined, violation: `Plan record ${filePath} is not valid JSON: ${error.message}` };
    }
    const ack = record && typeof record === "object" ? record.context_pack_ack : undefined;
    return {
      filePath,
      present: ack !== undefined,
      ack,
      violation: ack === undefined ? null : contextPackAckViolation(ack),
    };
  }
  return { filePath: null, present: false, ack: undefined, violation: null };
}

function planRecordsDirs(state) {
  return [state.PLAN_RECORDS_DIR, state.LEGACY_PLAN_RECORDS_DIR];
}

// Pre-effect assertion for consumers that are not review-gated (claim and
// claim --transfer-to). Must run before any lock, session, or board write.
// guard:context-pack-ack
function assertStoredContextPackAckValid(ticketId, { state, fail, verb }) {
  const stored = readStoredContextPackAck(ticketId, planRecordsDirs(state));
  if (!stored.violation) return;
  fail(
    `${storedViolationMessage(ticketId, stored.violation)} ` +
    `Refusing ${verb} before any ownership, lock, or session change. Repair it first: ${repairCommand(ticketId)} --confirm`
  );
}

// Deterministic read-only scan: runtime records win over legacy copies (the
// same precedence the reader applies), tickets are reported in sorted order,
// and nothing is written, normalized, or coerced.
function scanContextPackAcks(recordsDirs) {
  const ticketIds = new Set();
  for (const recordsDir of recordsDirs.filter(Boolean)) {
    if (!fs.existsSync(recordsDir)) continue;
    for (const name of fs.readdirSync(recordsDir)) {
      if (name.endsWith(".json")) ticketIds.add(name.slice(0, -".json".length));
    }
  }
  const malformed = [];
  let acknowledged = 0;
  const sorted = Array.from(ticketIds).sort();
  for (const ticketId of sorted) {
    const stored = readStoredContextPackAck(ticketId, recordsDirs);
    if (stored.present) acknowledged += 1;
    if (!stored.violation) continue;
    malformed.push({
      ticket: ticketId,
      path: stored.filePath,
      violation: stored.violation,
      stored: stored.ack === undefined ? null : stored.ack,
      repair: `${repairCommand(ticketId)}   # dry-run; add --confirm to write`,
    });
  }
  return {
    kind: "concord.context_pack_ack_scan",
    schema_version: 1,
    records_scanned: sorted.length,
    acknowledgements: acknowledged,
    malformed_count: malformed.length,
    malformed,
  };
}

// COORD-557: the writer runs the review gate's OWN checks on the acknowledgement
// it was just handed, so an ack the gate will reject is refused at authoring
// time instead of at submit/finalize. It deliberately reuses the injected
// readiness collector (the same gate registry move-review runs) rather than
// re-stating "ref readable / mandatory sections / closeout decision" here; a
// second copy of those rules is how the writer and the gate drifted apart.
// Called inside the update-plan mutation after the candidate is in place, so a
// refusal rolls the plan record and its projection back atomically.
// guard:context-pack-ack
function assertContextPackAckWriteReady(ticketId, options, deps) {
  const raw = typeof options.contextPackAck === "string" ? options.contextPackAck.trim() : options.contextPackAck;
  if (raw === undefined || !raw || (typeof raw === "string" && raw.toLowerCase() === "none")) return;
  const ref = deps.getTicketRef(deps.readBoard(), ticketId);
  if (!ref) return;
  const issues = deps.collectReviewPlanReadinessIssues(ticketId, ref.row)
    .filter((issue) => String(issue.code || "").startsWith("context_pack_"));
  if (issues.length === 0) return;
  const lines = [`Refusing to record context_pack_ack for ${ticketId}: the review gate would reject it, so nothing was written.`];
  issues.forEach((issue, index) => {
    lines.push(`${index + 1}. ${issue.message}`);
    for (const step of issue.next_steps || []) lines.push(`   Next: ${step}`);
  });
  deps.fail(lines.join("\n"));
}

module.exports = {
  assertContextPackAckWriteReady,
  assertStoredContextPackAckValid,
  contextPackAckViolation,
  planRecordsDirs,
  readStoredContextPackAck,
  repairCommand,
  scanContextPackAcks,
  storedViolationMessage,
};
