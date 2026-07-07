"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFleetGoldenPath,
  renderFleetGoldenPath,
} = require("./fleet-golden-path.js");

test("COORD-393: fleet golden path front-loads closeout evidence and recovery wrappers", () => {
  const report = buildFleetGoldenPath("COORD-999");
  assert.equal(report.ticket, "COORD-999");
  assert.ok(report.invariants.some((item) => /One governed writer/.test(item)));
  assert.ok(report.prework.some((item) => /gate-plan COORD-999 --write/.test(item)));
  assert.ok(report.prework.some((item) => /business-context-pack --ticket COORD-999/.test(item)));
  assert.ok(report.closeout_wrappers.some((item) => /set-requirement-closure COORD-999/.test(item)));
  assert.ok(report.closeout_wrappers.some((item) => /add-feature-proof COORD-999/.test(item)));
  assert.ok(report.closeout_wrappers.some((item) => /guided-closeout COORD-999/.test(item)));
  assert.ok(report.closeout_wrappers.some((item) => /publishability-check COORD-999/.test(item)));
  assert.ok(report.recovery.some((item) => /doctor --repair-all --confirm/.test(item)));
});

test("COORD-393: fleet golden path renders as operator-readable markdown", () => {
  const markdown = renderFleetGoldenPath(buildFleetGoldenPath("COORD-999"));
  assert.match(markdown, /# Concord Fleet Golden Path/);
  assert.match(markdown, /## Closeout Wrappers/);
  assert.match(markdown, /coord\/scripts\/gov finalize COORD-999/);
});
