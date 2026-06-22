"use strict";

// Wave 3 (COORD-069): repo-gate attribution/board-record tests relocated out of
// plan-command.test.js into a module-owned file alongside gates.js. Exercise the
// gate-attribution classifier and the board-record entry formatter via the
// governance __testing surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const { __testing } = require("./governance-test-utils.js");

test("classifyGateAttribution distinguishes new-on-ticket, pre-existing-on-base, fixed-on-ticket, and clean", () => {
  assert.equal(__testing.classifyGateAttribution({ result: "pass" }), "clean");
  assert.equal(__testing.classifyGateAttribution({ result: "pass", baseResult: "pass" }), "clean");
  assert.equal(__testing.classifyGateAttribution({ result: "pass", baseResult: "fail" }), "fixed-on-ticket");
  assert.equal(__testing.classifyGateAttribution({ result: "fail", baseResult: "pass" }), "new-on-ticket");
  assert.equal(__testing.classifyGateAttribution({ result: "fail", baseResult: "fail" }), "pre-existing-on-base");
  assert.equal(__testing.classifyGateAttribution({ result: "fail" }), "unknown");
  assert.equal(__testing.classifyGateAttribution({}), null);
});

test("formatRepoGateEntry encodes attribution and preserves command + note ordering", () => {
  assert.equal(
    __testing.formatRepoGateEntry({ commandText: "pnpm test" }),
    "pnpm test"
  );
  assert.equal(
    __testing.formatRepoGateEntry({ commandText: "pnpm test", note: "unit suite" }),
    "pnpm test - unit suite"
  );
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "pnpm test",
      result: "fail",
      baseResult: "pass",
      attribution: "new-on-ticket",
      note: "broke the auth suite",
    }),
    "pnpm test [result=fail; base-result=pass; attribution=new-on-ticket] - broke the auth suite"
  );
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "pnpm lint",
      result: "fail",
      baseResult: "fail",
      attribution: "pre-existing-on-base",
    }),
    "pnpm lint [result=fail; base-result=fail; attribution=pre-existing-on-base]"
  );
});

test("COORD-076: formatRepoGateEntry records the dependency-audit signal as an annotation", () => {
  // String summary (the audit-policy.js summary line) is normalized.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      audit: "audit: warn threshold=high total=1 (critical=0 high=0 moderate=1 low=0 info=0) blocking=0",
    }),
    "bash scripts/gate.sh full [result=pass; audit=warn threshold=high total=1 (critical=0 high=0 moderate=1 low=0 info=0) blocking=0]"
  );
  // Object form is accepted too.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "gate:full",
      audit: { result: "fail", threshold: "high" },
    }),
    "gate:full [audit=fail threshold=high]"
  );
  // Absent audit leaves the entry unchanged (backward compatible).
  assert.equal(
    __testing.formatRepoGateEntry({ commandText: "gate:full", result: "pass" }),
    "gate:full [result=pass]"
  );
});

test("COORD-077: formatRepoGateEntry records the test-coverage signal as an annotation", () => {
  // String summary (the coverage-policy.js summary line) is normalized.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      coverage: "coverage: pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91",
    }),
    "bash scripts/gate.sh full [result=pass; coverage=pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91]"
  );
  // Object form is accepted too.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "gate:full",
      coverage: { result: "fail", threshold: 80 },
    }),
    "gate:full [coverage=fail min=80]"
  );
  // Audit and coverage coexist as ordered annotations.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "gate:full",
      result: "pass",
      audit: "audit: pass threshold=high",
      coverage: "coverage: pass min=80 (lines=90.00 branches=90.00 functions=90.00) lowest=90.00",
    }),
    "gate:full [result=pass; audit=pass threshold=high; coverage=pass min=80 (lines=90.00 branches=90.00 functions=90.00) lowest=90.00]"
  );
});

test("COORD-078: formatRepoGateEntry records the architecture/complexity signal as an annotation", () => {
  // String summary (the arch-checks.js summary line) is normalized.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      arch: "arch: warn files=42 findings=3 (size=1 complexity=2 imports=0 dup=0 monolith=0)",
    }),
    "bash scripts/gate.sh full [result=pass; arch=warn files=42 findings=3 (size=1 complexity=2 imports=0 dup=0 monolith=0)]"
  );
  // Object form is accepted too.
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "gate:full",
      arch: { result: "warn", findings: 3 },
    }),
    "gate:full [arch=warn findings=3]"
  );
  // All four gate signals coexist as ordered annotations (audit, coverage, arch).
  assert.equal(
    __testing.formatRepoGateEntry({
      commandText: "gate:full",
      result: "pass",
      audit: "audit: pass threshold=high",
      coverage: "coverage: pass min=80",
      arch: "arch: warn files=42 findings=1 (size=1 complexity=0 imports=0 dup=0 monolith=0)",
    }),
    "gate:full [result=pass; audit=pass threshold=high; coverage=pass min=80; arch=warn files=42 findings=1 (size=1 complexity=0 imports=0 dup=0 monolith=0)]"
  );
  // Absent arch leaves the entry unchanged (backward compatible).
  assert.equal(
    __testing.formatRepoGateEntry({ commandText: "gate:full", result: "pass" }),
    "gate:full [result=pass]"
  );
});
