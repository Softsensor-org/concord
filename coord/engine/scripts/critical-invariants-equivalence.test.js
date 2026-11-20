"use strict";
// COORD-962: the critical-invariant refusal and admission (COORD-029) replay field for field against the
// golden fixture captured on the unmodified origin/dev before the fold into requirement-closure.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { capture } = require("./__fixtures__/critical-invariants-equivalence-harness.js");
const golden = require("./__fixtures__/critical-invariants-golden.json");

test("COORD-962: critical-invariant refusals and admissions replay field for field against the origin/dev golden capture", () => {
  const worktree = path.resolve(__dirname, "..", "..", "..");
  const actual = capture(worktree);
  assert.equal(actual.gate.length, golden.gate.length, "gate-level case count");
  assert.equal(actual.caller.length, golden.caller.length, "caller-level case count");
  assert.deepStrictEqual(actual, golden);
});

test("COORD-962: exactly one critical-invariant implementation, owned by requirement-closure", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "gates", "review-closeout.js"), "utf8");
  assert.equal(source.split('code: "critical_invariants"').length - 1, 1, "one critical_invariants refusal site");
  assert.equal(source.split('"min_critical_invariants"').length - 1, 1, "one tier-minimum lookup");
  const requirementStart = source.indexOf("function collectRequirementClosureIssues(");
  const fieldStart = source.indexOf("function collectRequirementClosureFieldIssues(");
  const refusal = source.indexOf('code: "critical_invariants"');
  assert.ok(requirementStart > 0 && refusal > requirementStart && refusal < fieldStart, "the refusal lives in collectRequirementClosureIssues");
  assert.ok(source.slice(requirementStart - 200, requirementStart).includes("// guard:requirement-closure"), "requirement-closure marker is on the owning function");
});
