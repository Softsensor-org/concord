"use strict";
const { resolveEngineModule } = require("../../../paths.js");
const COORD_DIR = require("node:path").resolve(__dirname, "..", "..", "..");

// COORD-860: review/landing gate for managed-auto execution evidence. It runs
// in the shared review registry, so submit, move-review and closeout preflight
// (before any external merge) all apply it. Ordinary tickets with no managed
// session, policy or summary get no issue and keep their existing gates.

const path = require("node:path");
const { state } = require(resolveEngineModule(COORD_DIR, "scripts/governance-context.js"));
const { evaluateManagedEvidence } = require(resolveEngineModule(path.resolve(__dirname, "../../.."), "scripts/managed-auto-reconcile.js"));

// guard:managed-auto-evidence
function collectManagedEvidenceIssues({ ticketId, planState }) {
  return evaluateManagedEvidence({ ticketId, plan: planState, runtimeDir: state.RUNTIME_DIR }).issues;
}

module.exports = { collectManagedEvidenceIssues };
