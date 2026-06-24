"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBootstrapViaLiveMcpLifecycle,
  mapLiveMcpReceiptToBootstrapEvidence,
  isBridgeDeclared,
  BOOTSTRAP_REQUIREMENTS,
} = require("./bootstrap-via-live-mcp.js");

// COORD-164: BRIDGE — a live-MCP receipt satisfying a server bootstrap job's
// evidence requirements. These tests pin the ticket acceptance criteria:
//   - a complete live-MCP receipt (task/resource id + timeout + stopped/completed
//     + log/metric pointer + redaction + completed cleanup) SATISFIES the
//     bootstrap requirements => ticket ready (no bridge issues);
//   - cleanup-pending => blocked;
//   - redaction missing => blocked;
//   - a bootstrap job WITHOUT a covering live-MCP receipt still needs its own
//     bootstrap evidence (the bridge does not fire => not silently satisfied);
//   - the bridge reports exactly which requirement is unmet;
//   - normal / bootstrap-only / live-mcp-only tickets are unaffected;
//   - no raw payload/creds in committed test data (synthetic only — asserted).

// A complete, customer-safe synthetic live-MCP receipt for an ECS one-off task
// that executed a backfill. NO raw production payloads or credentials.
function completeReceipt(overrides = {}) {
  return {
    ticket: "APP-999",
    adapter: "ecs-one-off",
    operation: "run_backfill_task",
    operation_class: "write_prod",
    scope: "task=analytics-backfill timeout=900s",
    result: "pass",
    redaction: "secret-free compact evidence; resource id retained for traceability",
    approval: "human-admin",
    cleanup: "stopped via aws ecs stop-task; evidence=\"task STOPPED\"; cleaned_at=2026-06-24T14:12:33Z",
    evidence: [
      "run_backfill_task: opened ecs one-off task (timeout 900s)",
      "metrics: dashboard pointer cw://backfill-progress",
    ],
    temp_access: {
      resource_id: "task/analytics-backfill",
      timeout: "900s",
      cleanup_state: "completed",
      cleanup_timestamp: "2026-06-24T14:12:33Z",
      stop_evidence: "task STOPPED",
    },
    ...overrides,
  };
}

// A bridge-declaring plan state: BOTH live_mcp (with embedded receipt) and
// bootstrap_risk present.
function bridgePlan(receipt, planOverrides = {}, liveMcpOverrides = {}) {
  return {
    bootstrap_risk: {
      startup_work_class: "server_bootstrap_job",
      observability_requirements: ["logs", "metrics", "task status"],
      ...(planOverrides.bootstrap_risk || {}),
    },
    live_mcp: {
      adapter: "ecs-one-off",
      operation: "run_backfill_task",
      operation_class: "write_prod",
      environment: "prod",
      scope: "task=analytics-backfill timeout=900s",
      approval: "human-admin",
      redaction: "summary",
      cleanup_required: true,
      cleanup: receipt && receipt.cleanup,
      receipt,
      ...liveMcpOverrides,
    },
  };
}

function codes(result) {
  return result.issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// Bridge declaration scoping
// ---------------------------------------------------------------------------

test("not declared: normal ticket (neither field) => unaffected", () => {
  assert.equal(isBridgeDeclared({}), false);
  assert.deepEqual(buildBootstrapViaLiveMcpLifecycle({ planState: {} }), {
    declared: false,
    issues: [],
  });
  assert.deepEqual(
    buildBootstrapViaLiveMcpLifecycle({
      planState: { critical_invariants: ["x"], feature_proof: ["path:a"] },
    }),
    { declared: false, issues: [] }
  );
});

test("not declared: bootstrap-only ticket still needs its own bootstrap evidence (not silently satisfied)", () => {
  const planState = {
    bootstrap_risk: { startup_work_class: "server_bootstrap_job", observability_requirements: ["logs"] },
  };
  assert.equal(isBridgeDeclared(planState), false);
  // The bridge does NOT fire: it produces no issues AND no satisfaction. The
  // ticket's normal bootstrap evidence path (COORD-161 receipt) is untouched.
  assert.deepEqual(buildBootstrapViaLiveMcpLifecycle({ planState }), {
    declared: false,
    issues: [],
  });
});

test("not declared: live-mcp-only ticket is governed by COORD-153 alone, bridge inert", () => {
  const planState = {
    live_mcp: { adapter: "a", operation: "o", operation_class: "read_sensitive", receipt: { x: 1 } },
  };
  assert.equal(isBridgeDeclared(planState), false);
  assert.deepEqual(buildBootstrapViaLiveMcpLifecycle({ planState }), {
    declared: false,
    issues: [],
  });
});

// ---------------------------------------------------------------------------
// Mapping function
// ---------------------------------------------------------------------------

test("mapping: complete receipt satisfies every applicable bootstrap requirement", () => {
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(completeReceipt(), { expectsPromotion: false });
  assert.equal(mapping.cleanup_state, "completed");
  assert.equal(mapping.satisfied.ecs_one_off_task_record, true);
  assert.equal(mapping.satisfied.observability, true);
  assert.equal(mapping.satisfied.cleanup, true);
  assert.equal(mapping.satisfied.redaction, true);
  assert.equal(mapping.satisfied.promotion, true); // not expected => satisfied
  assert.deepEqual(mapping.unmet, []);
});

test("mapping: cleanup pending => cleanup unmet", () => {
  const receipt = completeReceipt({
    cleanup: undefined,
    temp_access: { resource_id: "task/x", timeout: "900s", cleanup_state: "pending" },
  });
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(receipt);
  assert.equal(mapping.cleanup_state, "pending");
  assert.equal(mapping.satisfied.cleanup, false);
  assert.ok(mapping.unmet.includes("cleanup"));
  // The ECS task record is still NOT terminal while pending => also unmet.
  assert.equal(mapping.satisfied.ecs_one_off_task_record, false);
});

test("mapping: redaction missing => redaction unmet", () => {
  const receipt = completeReceipt({ redaction: undefined });
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(receipt);
  assert.equal(mapping.satisfied.redaction, false);
  assert.ok(mapping.unmet.includes("redaction"));
});

test("mapping: missing observability pointer => observability unmet", () => {
  const receipt = completeReceipt({ evidence: ["ran the task"] });
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(receipt);
  assert.equal(mapping.satisfied.observability, false);
  assert.ok(mapping.unmet.includes("observability"));
});

test("mapping: product-impacting finding requires promotion", () => {
  const withoutPromotion = mapLiveMcpReceiptToBootstrapEvidence(completeReceipt(), {
    expectsPromotion: true,
  });
  assert.equal(withoutPromotion.satisfied.promotion, false);
  assert.ok(withoutPromotion.unmet.includes("promotion"));

  const withPromotion = mapLiveMcpReceiptToBootstrapEvidence(
    completeReceipt({ promotion: "added regression fixture tests/backfill.spec.ts" }),
    { expectsPromotion: true }
  );
  assert.equal(withPromotion.satisfied.promotion, true);
});

test("mapping: top-level task fields (no temp_access) also map", () => {
  const receipt = completeReceipt({
    temp_access: undefined,
    task_id: "task/top-level",
    timeout: "600s",
    task_state: "stopped",
  });
  const mapping = mapLiveMcpReceiptToBootstrapEvidence(receipt);
  assert.equal(mapping.satisfied.ecs_one_off_task_record, true);
  assert.equal(mapping.mapped_fields.resource_id, "task/top-level");
});

// ---------------------------------------------------------------------------
// Gate: buildBootstrapViaLiveMcpLifecycle
// ---------------------------------------------------------------------------

test("gate: complete receipt => declared, no bridge issues (ready)", () => {
  const result = buildBootstrapViaLiveMcpLifecycle({ planState: bridgePlan(completeReceipt()) });
  assert.equal(result.declared, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.mapping.unmet, []);
});

test("gate: cleanup pending => blocked with coverage issue naming cleanup", () => {
  const receipt = completeReceipt({
    cleanup: undefined,
    temp_access: { resource_id: "task/x", timeout: "900s", cleanup_state: "pending" },
  });
  // bridgePlan lifts receipt.cleanup into live_mcp.cleanup; pending => undefined.
  const result = buildBootstrapViaLiveMcpLifecycle({ planState: bridgePlan(receipt) });
  assert.equal(result.declared, true);
  assert.ok(codes(result).includes("bootstrap_via_live_mcp_coverage"));
  const coverageIssue = result.issues.find((i) => i.code === "bootstrap_via_live_mcp_coverage");
  assert.match(coverageIssue.message, /cleanup/);
  assert.match(coverageIssue.message, /cleanup_state=pending/);
});

test("gate: redaction missing => blocked with coverage issue naming redaction", () => {
  const receipt = completeReceipt({ redaction: undefined });
  const result = buildBootstrapViaLiveMcpLifecycle({ planState: bridgePlan(receipt) });
  assert.equal(result.declared, true);
  const coverageIssue = result.issues.find((i) => i.code === "bootstrap_via_live_mcp_coverage");
  assert.ok(coverageIssue, "expected a coverage blocker");
  assert.match(coverageIssue.message, /redaction/);
});

test("gate: no inline receipt to map => blocked (not silently satisfied)", () => {
  // Bridge declared (both fields) but live_mcp carries only a path, no inline obj.
  const planState = {
    bootstrap_risk: { startup_work_class: "server_bootstrap_job", observability_requirements: ["logs"] },
    live_mcp: {
      adapter: "ecs-one-off",
      operation: "run_backfill_task",
      operation_class: "write_prod",
      environment: "prod",
      scope: "task=x",
      receipt_path: "coord/evidence/live-mcp/backfill.json",
    },
  };
  const result = buildBootstrapViaLiveMcpLifecycle({ planState });
  assert.equal(result.declared, true);
  assert.ok(codes(result).includes("bootstrap_via_live_mcp_receipt"));
});

test("gate: coverage reports the SPECIFIC unmet requirement only", () => {
  // Only observability is missing; everything else complete.
  const receipt = completeReceipt({ evidence: ["ran the task with no pointer"] });
  const result = buildBootstrapViaLiveMcpLifecycle({ planState: bridgePlan(receipt) });
  const coverageIssue = result.issues.find((i) => i.code === "bootstrap_via_live_mcp_coverage");
  assert.ok(coverageIssue);
  assert.match(coverageIssue.message, /observability/);
  // It must NOT claim cleanup/redaction (those are satisfied here).
  assert.doesNotMatch(coverageIssue.message, /needs:[^.]*cleanup/);
  assert.doesNotMatch(coverageIssue.message, /needs:[^.]*redaction/);
});

test("gate: product-impacting bridge requires promotion in the receipt", () => {
  const planState = bridgePlan(completeReceipt(), {}, { product_impact: true });
  const blocked = buildBootstrapViaLiveMcpLifecycle({ planState });
  const coverageIssue = blocked.issues.find((i) => i.code === "bootstrap_via_live_mcp_coverage");
  assert.ok(coverageIssue, "missing promotion should block");
  assert.match(coverageIssue.message, /promotion/);

  const promoted = bridgePlan(
    completeReceipt({ promotion: "promoted finding to tests/backfill.spec.ts" }),
    {},
    { product_impact: true }
  );
  assert.deepEqual(buildBootstrapViaLiveMcpLifecycle({ planState: promoted }).issues, []);
});

test("gate: observability not required when bootstrap_risk lists none", () => {
  // bootstrap_risk without observability_requirements => observability not in the
  // required set, so a receipt with no pointer is still ready.
  const receipt = completeReceipt({ evidence: ["ran the task"] });
  const planState = bridgePlan(receipt, { bootstrap_risk: { observability_requirements: [] } });
  const result = buildBootstrapViaLiveMcpLifecycle({ planState });
  assert.deepEqual(result.issues, []);
});

// ---------------------------------------------------------------------------
// Non-goal guard: no raw payloads / credentials in committed fixtures
// ---------------------------------------------------------------------------

test("non-goal: this test file embeds no raw secrets/credentials/payloads", () => {
  const fs = require("fs");
  const src = fs.readFileSync(__filename, "utf8");
  // Synthetic fixtures only: assert none of the obvious secret/credential tokens
  // appear as VALUES in the committed test data.
  const forbidden = [
    /AKIA[0-9A-Z]{16}/, // AWS access key id shape
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /password\s*[:=]\s*["'][^"']+["']/i,
    /secret_key\s*[:=]\s*["'][^"']+["']/i,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(src, re);
  }
});

test("constants: BOOTSTRAP_REQUIREMENTS is the stable ordered contract", () => {
  assert.deepEqual(BOOTSTRAP_REQUIREMENTS, [
    "ecs_one_off_task_record",
    "observability",
    "cleanup",
    "redaction",
    "promotion",
  ]);
});
