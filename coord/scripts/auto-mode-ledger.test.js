"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertAuditComplete, createEntry, reconcile, verifyLedger } = require("./auto-mode-ledger.js");

test("ledger redacts secrets and detects tampering", () => {
  const start = createEntry({ type: "session_start", ticket: "T", api_token: "value" });
  const action = createEntry({ type: "action", action_id: "a1", detail: { password: "value", command: "test" } }, start);
  assert.equal(start.api_token, "[REDACTED]");
  assert.equal(action.detail.password, "[REDACTED]");
  assert.equal(verifyLedger([start, action]).ok, true);
  assert.equal(verifyLedger([start, { ...action, action_id: "changed" }]).ok, false);
});

test("reconciliation cannot claim completeness with missing evidence", () => {
  const start = createEntry({ type: "session_start", ticket: "T" });
  const action = createEntry({ type: "action", action_id: "a1" }, start);
  const complete = reconcile([start, action], { coverage: "complete", actions: [{ id: "a1" }] });
  assert.equal(complete.coverage, "complete");
  assert.equal(assertAuditComplete(complete), true);
  const partial = reconcile([start, action], { coverage: "complete", actions: [{ id: "a1" }, { id: "a2" }] });
  assert.equal(partial.coverage, "partial");
  assert.throws(() => assertAuditComplete(partial), /not complete/);
});
