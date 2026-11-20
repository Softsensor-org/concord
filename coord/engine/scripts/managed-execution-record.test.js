"use strict";

// COORD-860: the closed plan-record shape for managed execution evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const record = require("./managed-execution-record.js");
const supersession = require("./plan-evidence-supersession.js");

const H = "a".repeat(64);
function summary(overrides = {}) {
  return {
    schema: "coord.managed-execution-summary/v1", ticket: "COORD-860", session: "s1", provider: "codex", policy_digest: H, chain_root: H,
    session_head: H, base_commit: "b".repeat(40), head_commit: "c".repeat(40), integrity: "valid", coverage: "partial",
    counts: { entries: 3, legacy_v1: 0, session_events: 3, effects: 1, changed_paths: 1, commits: 0, by_class: { file: 1 } },
    gaps: ["coverage_partial"], unexplained: [], diff_digest: `sha256:${H}`, verdict: "incomplete", summary_digest: "d".repeat(64), ...overrides,
  };
}
function exception(overrides = {}) {
  return {
    schema: "coord.managed-execution-exception/v1", summary_digest: "d".repeat(64), chain_root: H, gaps: ["coverage_partial"],
    reason: "adapter outage", residual_risk: "unobserved egress for 3 minutes", approval: "human admin approved", actor: "claudea12",
    recorded_at: "2026-10-25T00:00:00.000Z", legal_waiver: false, ...overrides,
  };
}
const value = (overrides = {}) => ({ summary: summary(), exception: null, recorded_at: "2026-10-25T00:00:00.000Z", actor: "claudea12", ...overrides });

test("COORD-860 a valid record and a bound exception pass; every malformed shape names its violation", () => {
  assert.equal(record.managedExecutionViolation(value()), null);
  assert.equal(record.managedExecutionViolation(value({ exception: exception() })), null);
  assert.equal(record.managedExecutionViolation(value({ summary: summary({ session: null, provider: null, chain_root: null, base_commit: null, diff_digest: null }) })), null);
  const cases = [
    [value({ extra: 1 }), /exactly summary/],
    [value({ actor: "bad actor" }), /actor or time/],
    [value({ recorded_at: "never" }), /actor or time/],
    [value({ summary: { ...summary(), raw: "x" } }), /exactly the redacted/],
    [value({ summary: summary({ schema: "v0" }) }), /schema/],
    [value({ summary: summary({ ticket: "x" }) }), /ticket/],
    [value({ summary: summary({ provider: "other" }) }), /session or provider/],
    [value({ summary: summary({ chain_root: "x" }) }), /SHA-256/],
    [value({ summary: summary({ summary_digest: null }) }), /SHA-256/],
    [value({ summary: summary({ head_commit: "abc" }) }), /full SHAs/],
    [value({ summary: summary({ integrity: "ok" }) }), /integrity/],
    [value({ summary: summary({ coverage: "full" }) }), /coverage/],
    [value({ summary: summary({ verdict: "pass" }) }), /verdict/],
    [value({ summary: summary({ diff_digest: H }) }), /diff_digest/],
    [value({ summary: summary({ gaps: ["b", "a"] }) }), /sorted unique/],
    [value({ summary: summary({ unexplained: ["Path/with/secret"] }) }), /sorted unique/],
    [value({ summary: summary({ counts: { ...summary().counts, entries: -1 } }) }), /counts are invalid/],
    [value({ summary: summary({ counts: { ...summary().counts, by_class: { "a.txt": 1 } } }) }), /by_class/],
    [value({ summary: summary({ counts: { ...summary().counts, by_class: [] } }) }), /by_class/],
    [value({ exception: { ...exception(), note: "x" } }), /technical-exception fields/],
    [value({ exception: exception({ legal_waiver: true }) }), /schema is unsupported/],
    [value({ exception: exception({ summary_digest: H }) }), /bind the recorded summary/],
    [value({ exception: exception({ gaps: [] }) }), /name its gaps/],
    [value({ exception: exception({ gaps: ["coverage_bypassed"] }) }), /exactly the summary gaps/],
    [value({ exception: exception({ residual_risk: " " }) }), /residual-risk/],
    [value({ exception: exception({ reason: "x".repeat(501) }) }), /residual-risk/],
    [value({ exception: exception({ actor: "a b" }) }), /actor or time/],
    [value({ exception: exception({ recorded_at: "x" }) }), /actor or time/],
  ];
  for (const [input, pattern] of cases) assert.match(record.managedExecutionViolation(input), pattern);
  assert.match(record.managedExecutionViolation(null), /exactly summary/);
});

test("COORD-860 only the branded governed write reaches the record, and it renders as one PLAN.md line", () => {
  const reject = (message) => { throw new Error(message); };
  const target = {};
  assert.throws(() => record.applyManagedExecutionToRecord(target, { managedExecution: { value: value() } }, reject), /only by gov record-managed-evidence/);
  assert.throws(() => record.applyManagedExecutionToRecord(target, { managedExecution: { [record.MANAGED_EXECUTION_WRITE]: true, value: value({ actor: "" }) } }, reject), /invalid/);
  record.applyManagedExecutionToRecord(target, { managedExecution: { [record.MANAGED_EXECUTION_WRITE]: true, value: value() } }, reject);
  assert.deepEqual(target.managed_execution, value());
  // The canonical writer delegates through the supersession module.
  const viaWriter = {};
  supersession.applyCorrectionsToRecord(viaWriter, { managedExecution: { [record.MANAGED_EXECUTION_WRITE]: true, value: value() } });
  assert.deepEqual(viaWriter.managed_execution, value());
  assert.throws(() => supersession.applyCorrectionsToRecord({}, { managedExecution: {} }), /only by gov record-managed-evidence/);
  const lines = [];
  record.renderManagedExecutionSection(lines, {});
  assert.deepEqual(lines, []);
  supersession.renderManagedExecutionSection(lines, target);
  assert.deepEqual(lines, ["- Managed execution:", `  - ${JSON.stringify(value())}`]);
  const messages = [];
  record.validateManagedExecutionRecord({}, (message) => messages.push(message));
  record.validateManagedExecutionRecord({ managed_execution: value() }, (message) => messages.push(message));
  record.validateManagedExecutionRecord({ managed_execution: value({ actor: "" }) }, (message) => messages.push(message));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Plan record managed_execution is invalid/);
});
