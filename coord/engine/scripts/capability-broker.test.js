"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CapabilityBroker } = require("./capability-broker.js");

test("broker requires explicit approval and returns a redacted ticket receipt", () => {
  const calls = [];
  const broker = new CapabilityBroker({ ticket: "COORD-491", now: () => 1, execute: (request) => { calls.push(request); return { result: "completed", external_id: "change-7", secret_token: "must-not-escape" }; } });
  assert.equal(broker.request({ capability: "scm.submit", target: "origin/dev" }).decision, "approval_required");
  const result = broker.request({ capability: "scm.submit", target: "origin/dev", approved: true, parameters: { api_token: "raw", message: "update" } });
  assert.equal(result.decision, "allow");
  assert.match(result.receipt.receipt_id, /^[a-f0-9]{20}$/);
  assert.deepEqual({ ...result.receipt, receipt_id: "stable" }, { schema: "coord.auto-mode.broker-receipt/v1", receipt_id: "stable", ticket: "COORD-491", capability: "scm.submit", target: "origin/dev", target_class: "scm-ref", result: "completed", external_id: "change-7" });
  assert.equal(calls[0].credential_ref, "broker-owned");
  assert.equal(calls[0].parameters.api_token, "[REDACTED]");
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("broker denies sensitive targets and production capabilities", () => {
  const broker = new CapabilityBroker({ ticket: "COORD-491", execute: () => ({}) });
  assert.equal(broker.request({ capability: "scm.submit", target: "production-release", approved: true }).decision, "deny");
  assert.equal(broker.request({ capability: "cloud.deploy", target: "dev", approved: true }).decision, "deny");
});
