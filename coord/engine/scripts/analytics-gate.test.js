"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evaluateReceiptSet, runEvidenceGate } = require("./analytics-gate.js");

// A valid read_safe receipt: read_safe only requires ticket/adapter/operation/
// scope/result/evidence (no redaction, no approval, no cleanup).
function readSafeReceipt(overrides = {}) {
  return Object.assign(
    {
      schema_version: 1,
      kind: "live-mcp",
      ticket: "PE-1",
      adapter: "prod-db",
      operation_class: "read_safe",
      operation: "query_order_status",
      scope: "order_id=123",
      result: "observed",
      evidence: ["SELECT status FROM orders WHERE id=123", "1 row"],
    },
    overrides
  );
}

test("fails when no receipt is present", () => {
  const r = evaluateReceiptSet("PE-1", []);
  assert.strictEqual(r.result, "fail");
  assert.strictEqual(r.gateProc, "evidence");
  assert.strictEqual(r.track, "product-engineering");
  assert.ok(r.checks.find((c) => c.name === "receipt_present" && c.result === "fail"));
});

test("passes a valid read_safe receipt", () => {
  const r = evaluateReceiptSet("PE-1", [{ receipt: readSafeReceipt(), source: "a.json" }]);
  assert.strictEqual(r.result, "pass");
  assert.ok(r.checks.some((c) => c.name.startsWith("receipt_valid") && c.result === "pass"));
  assert.deepStrictEqual(r.artifact_paths, ["a.json"]);
});

test("fails a read_sensitive receipt missing required redaction", () => {
  // read_sensitive requires redaction + approval; omit both.
  const receipt = readSafeReceipt({
    operation_class: "read_sensitive",
    operation: "query_customer_pii",
  });
  const r = evaluateReceiptSet("PE-1", [{ receipt, source: "b.json" }]);
  assert.strictEqual(r.result, "fail");
  const v = r.checks.find((c) => c.name.startsWith("receipt_valid"));
  assert.strictEqual(v.result, "fail");
  assert.match(v.detail, /redaction/);
});

test("passes a read_sensitive receipt with redaction + approval", () => {
  const receipt = readSafeReceipt({
    operation_class: "read_sensitive",
    operation: "query_customer_pii",
    redaction: "masked_pii",
    approval: "alice@example.com",
  });
  const r = evaluateReceiptSet("PE-1", [{ receipt, source: "c.json" }]);
  assert.strictEqual(r.result, "pass");
});

test("fails the whole gate if any receipt in the set is invalid", () => {
  const good = { receipt: readSafeReceipt(), source: "ok.json" };
  const bad = { receipt: readSafeReceipt({ scope: "" }), source: "bad.json" }; // empty scope
  const r = evaluateReceiptSet("PE-1", [good, bad]);
  assert.strictEqual(r.result, "fail");
});

test("runEvidenceGate accepts bare receipt objects via options.receipts", () => {
  const r = runEvidenceGate({ ticket: "PE-9", receipts: [readSafeReceipt({ ticket: "PE-9" })] });
  assert.strictEqual(r.result, "pass");
  assert.strictEqual(r.ticket, "PE-9");
});

test("runEvidenceGate requires a ticket", () => {
  assert.throws(() => runEvidenceGate({}), /requires a ticket/);
});
