"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const phases = require("./governance-phase-model.js");

function report(overrides = {}) {
  return {
    recommended_profile: "product-engineering",
    findings: [],
    coord_setup: { governance: true, board: true },
    commands: { test: [{ command: "npm test" }] },
    requirements: [{ path: "coord/product/REQUIREMENTS.md", likely_stub: false }],
    app_signals: [],
    package_managers: ["npm"],
    ...overrides,
  };
}

test("phase catalog defines the expected phase order", () => {
  assert.deepEqual(phases.PHASES.map((phase) => phase.id), [
    "exploration",
    "prototype",
    "pilot",
    "production",
    "regulated-production",
  ]);
});

test("production and regulated phases do not weaken earlier evidence depth", () => {
  assert.deepEqual(phases.validateStrictness(), {
    production_extends_pilot: true,
    regulated_extends_production: true,
  });
});

test("recommendPhase maps missing governance to exploration and package repo to prototype", () => {
  assert.equal(phases.recommendPhase(report({
    findings: [{ severity: "blocker", code: "missing-governance" }],
  })), "exploration");
  assert.equal(phases.recommendPhase(report({
    coord_setup: { governance: true, board: true },
    commands: { test: [] },
    requirements: [],
    package_managers: ["npm"],
  })), "prototype");
});

test("recommendPhase maps tested requirements repos to pilot or production", () => {
  assert.equal(phases.recommendPhase(report()), "pilot");
  assert.equal(phases.recommendPhase(report({ app_signals: ["docker"] })), "production");
});

test("recommendPhase maps regulated profile to regulated production", () => {
  assert.equal(phases.recommendPhase(report({ recommended_profile: "regulated" })), "regulated-production");
  assert.equal(phases.phaseDetails("regulated-production").minimum_profile, "regulated");
});
