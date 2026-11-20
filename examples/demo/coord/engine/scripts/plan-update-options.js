"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

const { normalizeAdrRef } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/adr-reference.js"));
const { defaultFail } = require("./governance-context.js");
const { expandDecisionContext } = require("./decision-context.js");

// Shared input contract for the canonical writer and its CLI/plan adapters.
// Keep record spellings and input spellings together for help and discovery.
const JSON_OBJECT_PLAN_FIELDS = Object.freeze([
  ["bootstrapRisk", "bootstrap_risk"],
  ["contextPackAck", "context_pack_ack"],
  ["decisionRequired", "decision_required"],
  ["gatePlan", "gate_plan"],
  ["liveMcp", "live_mcp"],
]);
const PLAN_UPDATE_OPTION_KEYS = Object.freeze([
  "summary", "verify", "files", "dropFile", "security", "adrRef",
  "startup", "traceability", "baseline", "invariant", "closure", "replaceClosure",
  "featureProof", "dropFeatureProof", "repoGate", "rollback", "closeoutMethod",
  "closeoutBaseRef", "provenanceNote", "reviewProfile", "reviewCycle",
  "replaceReviewCycle", "dropReviewCycle", "replaceAllReviewCycles", "evidenceSupersession", "evidenceDisposition", "independentReview", "managedExecution",
  ...JSON_OBJECT_PLAN_FIELDS.map(([key]) => key),
]);
// COORD-932: the packet expands before the writer sees anything. Every problem
// is refused together and nothing is written; a packet never overrides a
// per-field flag for the same canonical field.
// guard:plan-record-schema
function expandDecisionContextOption(options) {
  const { decisionContext, ...rest } = options;
  let packet;
  try {
    packet = typeof decisionContext === "string" ? JSON.parse(decisionContext) : decisionContext;
  } catch (error) {
    // guard:plan-record-schema
    defaultFail(`--decision-context expects a JSON object (or --decision-context-file): ${error.message}`);
  }
  const result = expandDecisionContext(packet);
  // guard:plan-record-schema
  if (!result.ok) {
    defaultFail(`decision-context refused (${result.problems.length} problem(s), nothing written):\n- ${result.problems.join("\n- ")}`);
  }
  const expanded = result.options;
  // guard:plan-record-schema
  if (expanded.decisionRequired !== undefined && rest.decisionRequired !== undefined) {
    defaultFail("decision_required is also given by --decision-required; give it once, through the packet or the flag.");
  }
  // guard:plan-record-schema
  if (expanded.contextPackAck !== undefined && rest.contextPackAck !== undefined) {
    defaultFail("context_pack_ack is also given by --context-pack-ack; give it once, through the packet or the flag.");
  }
  const merged = { ...rest };
  for (const key of ["adrRef", "invariant"]) {
    if (expanded[key] !== undefined) {
      merged[key] = [...[].concat(rest[key] ?? []), ...expanded[key]];
    }
  }
  for (const key of ["decisionRequired", "contextPackAck"]) {
    if (expanded[key] !== undefined) merged[key] = expanded[key];
  }
  return merged;
}

// COORD-932: the packet is accepted by update-plan but is not a writer option:
// it expands into the writer options above before the writer runs.
const PLAN_UPDATE_PACKET_KEYS = Object.freeze(["decisionContext"]);
function selectPlanUpdateOptions(options = {}) {
  if (options.decisionContext !== undefined) {
    options = expandDecisionContextOption(options);
  }
  if (options.adrRef !== undefined) {
    const refs = Array.isArray(options.adrRef) ? options.adrRef : [options.adrRef];
    for (const ref of refs) {
      if (typeof ref !== "string" || !normalizeAdrRef(ref)) {
        defaultFail("--adr-ref requires an ADR reference recognized by the ADR gate, such as ADR-0001.");
      }
    }
  }
  return Object.fromEntries(PLAN_UPDATE_OPTION_KEYS
    .filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
}
module.exports = { JSON_OBJECT_PLAN_FIELDS, PLAN_UPDATE_OPTION_KEYS, PLAN_UPDATE_PACKET_KEYS, selectPlanUpdateOptions };
