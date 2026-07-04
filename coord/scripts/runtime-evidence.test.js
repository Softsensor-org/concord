"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtimeEvidence = require("./runtime-evidence.js");

function tempCoordDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-evidence-"));
}

function captureConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    const result = fn();
    return { result, text: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("live-mcp-record writes a redacted read_sensitive receipt", () => {
  const coordDir = tempCoordDir();
  const { result } = captureConsole(() => runtimeEvidence.liveMcpRecord("LIVE-001", {
    adapter: "case-readonly",
    operationClass: "read_sensitive",
    operation: "get_case",
    scope: "case_id=abc123 fields=status,shape",
    redaction: "removed names and raw payload fields",
    approval: "human:alice approved bounded read",
    evidence: ["mcp:get_case returned expected shape"],
    gateResult: "observed",
    json: true,
  }, {
    coordDir,
    timestamp: "2026-06-22T12:00:00.000Z",
  }));

  assert.equal(result.ok, true);
  assert.match(result.path, /evidence\/live-mcp\//);
  const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(coordDir), path.basename(coordDir), "evidence", "live-mcp", path.basename(result.path)), "utf8"));
  assert.equal(receipt.ticket, "LIVE-001");
  assert.equal(receipt.operation_class, "read_sensitive");
});

test("live-mcp-record fails closed for write_prod without approval and cleanup", () => {
  assert.throws(() => runtimeEvidence.normalizeLiveMcpReceipt("LIVE-002", {
    adapter: "ops",
    operationClass: "write_prod",
    operation: "restart_task",
    scope: "service=api",
    redaction: "no secrets",
    evidence: ["planned restart"],
  }), /approval is required/);
});

test("deploy receipt requires running artifact and build source to match landed source", () => {
  const good = runtimeEvidence.normalizeDeployReceipt("DEP-001", {
    environment: "staging",
    commit: "abc123",
    buildSource: "abc123",
    artifact: "api@sha256:aaa",
    runningArtifact: "api@sha256:aaa",
    deployId: "ecs-taskdef-42",
    operator: "ci",
    rollback: "api@sha256:prev",
  });
  assert.equal(runtimeEvidence.validateDeployReceipt(good).ok, true);

  assert.throws(() => runtimeEvidence.normalizeDeployReceipt("DEP-002", {
    environment: "staging",
    commit: "abc123",
    buildSource: "def456",
    artifact: "api@sha256:aaa",
    runningArtifact: "api@sha256:bbb",
    deployId: "ecs-taskdef-43",
    operator: "ci",
    rollback: "api@sha256:prev",
  }), /Deploy identity check failed/);
});

test("bootstrap receipt rejects risky api-startup jobs and marker-after-work idempotency", () => {
  assert.throws(() => runtimeEvidence.normalizeBootstrapReceipt("BOOT-001", {
    job: "analytics-backfill",
    executionMode: "api-startup",
    resourceEnvelope: "1GB task",
    idempotency: "lease before work",
    observability: "row-count metric",
    disableRollback: "feature flag off",
    evidence: ["readyz 200"],
  }), /must not run heavy\/risky work in api-startup mode/);

  assert.throws(() => runtimeEvidence.normalizeBootstrapReceipt("BOOT-002", {
    job: "analytics-backfill",
    executionMode: "one-off-task",
    resourceEnvelope: "1GB task",
    idempotency: "marker after work completes",
    observability: "row-count metric",
    disableRollback: "feature flag off",
    evidence: ["row count 10"],
  }), /must not rely on writing the marker only after work completes/);
});

test("runtime verify and falsify receipts require runtime/oracle evidence", () => {
  assert.equal(runtimeEvidence.normalizeRuntimeVerification("DEP-003", {
    environment: "staging",
    evidenceClass: "runtime",
    result: "pass",
    claim: "dashboard populated",
    evidence: ["GET /analytics count=10"],
  }).evidence_class, "runtime");

  assert.throws(() => runtimeEvidence.normalizeRuntimeVerification("DEP-004", {
    environment: "staging",
    evidenceClass: "chat",
    result: "pass",
    claim: "dashboard populated",
    evidence: ["trust me"],
  }), /Unsupported evidence_class/);

  assert.equal(runtimeEvidence.normalizeFalsification("DEP-005", {
    by: "INC-001",
    reason: "runtime row count was zero after closure",
    evidence: ["mcp-oracle: row_count=0"],
  }).falsified_by, "INC-001");
});

test("validate-receipt validates a written deployment receipt", () => {
  const coordDir = tempCoordDir();
  const { result } = captureConsole(() => runtimeEvidence.deployRecord("DEP-006", {
    environment: "prod",
    commit: "abc123",
    artifact: "api@sha256:aaa",
    runningArtifact: "api@sha256:aaa",
    deployId: "release-1",
    operator: "ci",
    rollback: "release-0",
    json: true,
  }, {
    coordDir,
    timestamp: "2026-06-22T13:00:00.000Z",
  }));
  assert.equal(result.ok, true);

  const receiptPath = path.join(coordDir, "evidence", "deployment", path.basename(result.path));
  const validation = captureConsole(() => runtimeEvidence.validateReceiptCommand({
    receipt: receiptPath,
    json: true,
  })).result;
  assert.equal(validation.ok, true);
  assert.equal(validation.kind, "deployment");
});
