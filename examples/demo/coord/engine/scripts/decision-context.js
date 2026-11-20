"use strict";
// COORD-932: one versioned --decision-context packet. The packet is an
// operator-authored JSON object that EXPANDS into the existing canonical plan
// fields (adr_refs, decision_required, the business-context invariant and
// context_pack_ack). It adds no persisted record and no writer: the expansion
// produces the same option keys the per-field flags already produce, so the
// canonical writer, its validators and its gates stay the only authority.
//
// Fail closed: an unknown schema_version or an unknown key refuses the packet.
// All structural problems are collected and reported together, and the caller
// refuses before any write.

const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
// COORD-1000: the ADR ref check is the gate's own normalizeAdrRef; the
// business-context invariant grammar is parseBusinessContextInvariant.
const { normalizeAdrRef } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/adr-reference.js"));
const {
  BUSINESS_CONTEXT_INVESTIGATION_STATUSES,
  parseBusinessContextInvariant,
} = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
const createPlanRecordFieldValidators = require("./plan-record-field-validators.js");
const { isPlainObject } = require("./lifecycle-utils.js");
const { resolvePlanEvidence } = require("./plan-evidence-supersession.js");
const DECISION_CONTEXT_SCHEMA_VERSION = 1;
const PACKET_KEYS = Object.freeze(new Set([
  "schema_version", "adr_refs", "decision_required", "business_context", "context_pack_ack",
]));
const BUSINESS_CONTEXT_KEYS = Object.freeze(new Set(["status", "ref"]));

// Returns { ok: true, options } or { ok: false, problems: [...] }. Pure: it
// touches no file and no record. `options` uses the update-plan option keys.
function expandDecisionContext(packet) {
  const problems = [];
  if (!isPlainObject(packet)) {
    return { ok: false, problems: ["decision-context packet must be a JSON object."] };
  }
  if (packet.schema_version !== DECISION_CONTEXT_SCHEMA_VERSION) {
    problems.push(`decision-context schema_version must be ${DECISION_CONTEXT_SCHEMA_VERSION} (got ${JSON.stringify(packet.schema_version ?? null)}).`);
  }
  for (const key of Object.keys(packet)) {
    if (!PACKET_KEYS.has(key)) {
      problems.push(`decision-context contains unknown key "${key}".`);
    }
  }

  const adrRef = [];
  if (packet.adr_refs !== undefined) {
    if (!Array.isArray(packet.adr_refs) || packet.adr_refs.length === 0) {
      problems.push("adr_refs must be a non-empty array of ADR references.");
    } else {
      for (const ref of packet.adr_refs) {
        if (typeof ref !== "string" || !normalizeAdrRef(ref)) {
          problems.push(`adr_refs entry ${JSON.stringify(ref)} is not a recognized ADR reference (such as ADR-0021).`);
        } else {
          adrRef.push(ref);
        }
      }
    }
  }

  let decisionRequired;
  if (packet.decision_required !== undefined) {
    if (!isPlainObject(packet.decision_required)) {
      problems.push("decision_required must be an object.");
    } else {
      decisionRequired = packet.decision_required;
      // COORD-1000: the canonical shape check, collected with the other problems
      // instead of surfacing for the first time at the writer.
      try {
        createPlanRecordFieldValidators({ fail: (message) => { throw new Error(message); } })
          .assertValidDecisionRequired(decisionRequired);
      } catch (error) {
        problems.push(error.message);
      }
      const bound = [...adrRef, ...(Array.isArray(decisionRequired.adr_refs) ? decisionRequired.adr_refs : [])];
      if (decisionRequired.required === true && bound.length === 0) {
        problems.push("decision_required.required is true but no ADR ref is bound (set adr_refs or decision_required.adr_refs).");
      }
    }
  }

  const invariant = [];
  if (packet.business_context !== undefined) {
    if (!isPlainObject(packet.business_context)) {
      problems.push("business_context must be an object.");
    } else {
      const bc = packet.business_context;
      for (const key of Object.keys(bc)) {
        if (!BUSINESS_CONTEXT_KEYS.has(key)) {
          problems.push(`business_context contains unknown key "${key}".`);
        }
      }
      if (!BUSINESS_CONTEXT_INVESTIGATION_STATUSES.includes(bc.status)) {
        problems.push(`business_context.status must be one of ${BUSINESS_CONTEXT_INVESTIGATION_STATUSES.join(", ")}.`);
      } else {
        invariant.push(`business-context status: ${bc.status}`);
      }
      if (bc.ref !== undefined) {
        if (typeof bc.ref !== "string" || !bc.ref.trim() || /[\s,;]/.test(bc.ref.trim())) {
          problems.push("business_context.ref must be a non-empty string without spaces, commas or semicolons.");
        } else {
          invariant.push(`business-context: ${bc.ref.trim()}`);
        }
      }
    }
  }

  let contextPackAck;
  if (packet.context_pack_ack !== undefined) {
    if (!isPlainObject(packet.context_pack_ack)) {
      problems.push("context_pack_ack must be an object.");
    } else {
      contextPackAck = packet.context_pack_ack;
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  // Each emitted line must be one the business-context grammar recognizes.
  for (const line of invariant) {
    if (!parseBusinessContextInvariant(line)) {
      return { ok: false, problems: [`business-context line ${JSON.stringify(line)} would not be recognized by the business-context gate.`] };
    }
  }
  const options = {};
  if (adrRef.length) options.adrRef = adrRef;
  if (decisionRequired !== undefined) options.decisionRequired = decisionRequired;
  if (invariant.length) options.invariant = invariant;
  if (contextPackAck !== undefined) options.contextPackAck = contextPackAck;
  return { ok: true, options };
}

// Derived, read-only view in packet shape. It works on legacy records too: the
// canonical fields are the source of truth, so the view can never disagree with
// them.
function projectDecisionContextView(record = {}) {
  // Read invariants through the active projection, never the append-only history.
  const invariants = resolvePlanEvidence(record).critical_invariants;
  const parsed = invariants.map(parseBusinessContextInvariant).filter(Boolean);
  let businessContext = null;
  const statusEntry = parsed.find((entry) => "status" in entry);
  const refEntry = parsed.find((entry) => "ref" in entry);
  if (statusEntry || refEntry) {
    businessContext = {};
    if (statusEntry) businessContext.status = statusEntry.status;
    if (refEntry) businessContext.ref = refEntry.ref;
  }
  return {
    schema_version: DECISION_CONTEXT_SCHEMA_VERSION,
    adr_refs: Array.isArray(record.adr_refs) ? [...record.adr_refs] : [],
    decision_required: record.decision_required ?? null,
    business_context: businessContext,
    context_pack_ack: record.context_pack_ack ?? null,
  };
}

module.exports = {
  DECISION_CONTEXT_SCHEMA_VERSION,
  expandDecisionContext,
  projectDecisionContextView,
};
