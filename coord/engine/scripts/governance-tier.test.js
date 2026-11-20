"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildGovernanceTierReport,
  normalizeTier,
} = require("./governance-tier.js");

test("governance tier defaults to full to preserve existing behavior", () => {
  const report = buildGovernanceTierReport({ projectConfig: {} });
  assert.equal(report.active_tier, "full");
  assert.equal(report.default_is_full, true);
  const missingConfig = buildGovernanceTierReport({ root: path.join(__dirname, "missing-project") });
  assert.deepEqual(missingConfig, report);
  assert.ok(report.required_gates.some((gate) => /track evidence/.test(gate)));
});

test("governance tier supports progressive disclosure", () => {
  const report = buildGovernanceTierReport({ projectConfig: { governance: { tier: "lite" } } });
  assert.equal(report.active_tier, "lite");
  assert.ok(report.invariants.includes("journal"));
  assert.ok(report.optional_gates.includes("ADR"));
  assert.throws(() => normalizeTier("unknown"), /Unknown governance tier/);
});
