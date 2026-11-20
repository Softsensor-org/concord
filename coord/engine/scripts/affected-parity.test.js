"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-947: gate-plan's engine selection is the COORD-924 selector, the same code path
// `gov test-policy resolve --stage pr` uses. These fixtures pin that: gate-plan's
// selected suites equal the selector's own selection, and unknown, deleted and T2
// changes still run the full gate.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const gatePlan = require("./gate-plan.js");
const selector = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/affected-selector.js"));

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const NOW = "2026-11-12T00:00:00Z";

function planFor({ files, changes }) {
  return gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-947",
    row: { ID: "COORD-947", Type: "test", Pri: "P1", Description: "parity fixture" },
    planState: {},
    files: files || [],
    changes,
    now: NOW,
  });
}

function selectorFor(changes) {
  return selector.selectAffected({ root: REPO_ROOT, base: "HEAD", changes });
}

function gatePlanSuites(receipt) {
  return receipt.affected_targets.selected.map((entry) => entry.id).sort();
}

function assertSliceParity(file) {
  const receipt = planFor({ files: [file] });
  const sel = selectorFor([{ status: "M", path: file }]);
  assert.equal(sel.decision, "selected", `selector must not fall back for ${file}`);
  assert.equal(receipt.affected_targets.mode, "slice", `gate-plan must select a slice for ${file}`);
  assert.deepEqual(gatePlanSuites(receipt), sel.selected.map((entry) => entry.suite).sort());
  assert.equal(receipt.affected_targets.map.path, null, "engine selection reads no engine map");
  return receipt;
}

test("parity: a changed suite selects the same suites in gate-plan and the selector", () => {
  const file = "coord/engine/scripts/gate-plan.test.js";
  const receipt = assertSliceParity(file);
  assert.ok(gatePlanSuites(receipt).includes(file));
});

test("parity: a changed module selects the same suites in gate-plan and the selector", () => {
  const file = "coord/engine/scripts/gate-plan.js";
  const receipt = assertSliceParity(file);
  assert.ok(gatePlanSuites(receipt).includes("coord/engine/scripts/gate-plan.test.js"));
});

test("parity: a deleted file falls back to the full gate in gate-plan and the selector", () => {
  // A path absent from the head tree and the base: unattributable.
  const file = "coord/engine/scripts/removed-947.js";
  const receipt = planFor({ changes: [{ status: "D", path: file }] });
  const sel = selectorFor([{ status: "D", path: file }]);
  assert.equal(sel.decision, "full");
  assert.equal(receipt.affected_targets.mode, "full");
});

test("parity: an unknown file falls back to the full gate in gate-plan and the selector", () => {
  const file = "coord/engine/scripts/never-existed-947.js";
  const receipt = planFor({ files: [file] });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.equal(selectorFor([{ status: "A", path: file }]).decision, "full");
});

test("parity: a T2 guard-registry file still runs the full gate", () => {
  const file = "coord/engine/governance-guards.json";
  const receipt = planFor({ files: [file] });
  assert.equal(receipt.affected_targets.mode, "full");
  const sel = selectorFor([{ status: "M", path: file }]);
  assert.equal(sel.tier, "T2");
  assert.equal(sel.decision, "full");
});

test("policy and selector files are fallbacks, so gate-plan runs full for them", () => {
  for (const file of ["coord/engine/test-policy.json", "coord/engine/scripts/affected-selector.js"]) {
    assert.equal(planFor({ files: [file] }).affected_targets.mode, "full", `${file} must be full`);
  }
});
