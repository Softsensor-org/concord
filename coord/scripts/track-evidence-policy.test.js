"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const policy = require("./track-evidence-policy.js");

test("high-risk bootstrap classes block when required evidence is missing", () => {
  const report = policy.evaluateTrackEvidence({
    ticketId: "OPS-101",
    track: "devops",
    riskClass: "R4",
    planState: {
      bootstrap_risk: {
        startup_work_class: "derived_data_job",
        runs_at_boot: false,
        shares_app_process: false,
        verification_signal: "/readyz returned 200",
      },
    },
  });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "bootstrap_resource_envelope"));
  assert.ok(report.issues.some((issue) => issue.code === "bootstrap_runtime_verification_signal"));
  assert.ok(report.issues.every((issue) => issue.next_steps.length > 0));
});

test("complete high-risk bootstrap evidence passes the bootstrap overlay", () => {
  const report = policy.evaluateTrackEvidence({
    ticketId: "DATA-101",
    track: "data-analytics",
    riskClass: "R4",
    planState: {
      repo_gates: ["data-contract gate pass; row-count reconciliation proof"],
      verification_commands: ["row-count before/after proof: 10 -> 10"],
      bootstrap_risk: {
        startup_work_class: "derived_data_job",
        runs_at_boot: false,
        shares_app_process: false,
        resource_envelope: { memory_mb: 512, timeout_s: 300, batch_size: 1000 },
        data_access_shape: "paginated by id with batch_size=1000",
        idempotency_strategy: "claim row before work",
        checkpoint_strategy: "last_processed_id checkpoint",
        verification_signal: "row-count output proof recorded in gate artifact",
        rollback_or_disable: "feature flag disables job",
        observability_requirements: ["job logs", "row-count metric"],
      },
    },
  });
  assert.equal(report.issues.filter((issue) => issue.code.startsWith("bootstrap_")).length, 0);
});

test("local bootstrap stays advisory", () => {
  const issues = policy.evaluateBootstrapRisk({
    ticketId: "OPS-102",
    planState: {
      bootstrap_risk: { startup_work_class: "local_bootstrap" },
    },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "advisory");
});

test("track evidence severity follows risk threshold", () => {
  const low = policy.evaluateTrackEvidence({
    ticketId: "WEB-101",
    track: "marketing",
    riskClass: "R1",
    planState: {},
  });
  assert.ok(low.issues.length > 0);
  assert.ok(low.issues.every((issue) => issue.severity === "advisory"));

  const high = policy.evaluateTrackEvidence({
    ticketId: "WEB-102",
    track: "marketing",
    riskClass: "R2",
    planState: {},
  });
  assert.ok(high.issues.some((issue) => issue.severity === "blocker"));
});

test("requiredEvidenceFor returns track and bootstrap requirements", () => {
  const required = policy.requiredEvidenceFor({
    track: "devops",
    riskClass: "R4",
    planState: {
      bootstrap_risk: { startup_work_class: "production_repair" },
    },
  });
  assert.ok(required.includes("infra gate report"));
  assert.ok(required.includes("rollback or disable switch"));
});
