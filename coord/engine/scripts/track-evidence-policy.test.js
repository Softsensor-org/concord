"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const policy = require("./track-evidence-policy.js");
const { evidenceRef, stableSupersessionId } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));

test("a superseded verification command cannot satisfy a custom current evidence class", () => {
  const old = "live-MCP receipt observed /orders on deployed system";
  const successor = "TODO: corrected verification has not been captured";
  const sourceRef = evidenceRef("verification_command", 1, old);
  const successorRef = evidenceRef("verification_command", 2, successor);
  const issues = policy.evaluateTrackRequirements({
    track: "development", riskClass: "R4",
    policy: { tracks: { development: { required: [{ id: "live_mcp_receipt", label: "a live MCP receipt" }] } } },
    planState: {
      verification_commands: [old, successor],
      evidence_supersessions: [{ id: stableSupersessionId(sourceRef, successorRef), kind: "verification_command",
        source_ref: sourceRef, successor_ref: successorRef, reason: "The endpoint was not valid on the current head.",
        actor: "fixture", timestamp: "2026-10-05T00:00:00.000Z" }],
    },
  });
  assert.ok(issues.some((issue) => issue.code === "track_evidence_live_mcp_receipt"));
});

test("default evidence policy resolves engine-first and supports a legacy-only install", () => {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-policy-layout-"));
  try {
    const enginePath = path.join(coordDir, "engine", "gates", "track-evidence-policy.json");
    fs.mkdirSync(path.dirname(enginePath), { recursive: true });
    fs.writeFileSync(enginePath, JSON.stringify({ source: "engine" }));
    assert.equal(policy.defaultPolicyPath(coordDir), enginePath);
    assert.deepEqual(policy.loadDefaultPolicy(policy.defaultPolicyPath(coordDir)), { source: "engine" });

    fs.rmSync(path.join(coordDir, "engine"), { recursive: true, force: true });
    const legacyPath = path.join(coordDir, "gates", "track-evidence-policy.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ source: "legacy" }));
    assert.equal(policy.defaultPolicyPath(coordDir), legacyPath);
    assert.deepEqual(policy.loadDefaultPolicy(policy.defaultPolicyPath(coordDir)), { source: "legacy" });

    const overridePath = path.join(coordDir, "project-policy.json");
    fs.writeFileSync(overridePath, JSON.stringify({ source: "project override" }));
    assert.deepEqual(policy.loadDefaultPolicy(overridePath), { source: "project override" });
  } finally {
    fs.rmSync(coordDir, { recursive: true, force: true });
  }
});

test("engine and compatibility evidence policies remain byte-identical", () => {
  const enginePath = policy.defaultPolicyPath();
  const legacyPath = path.join(__dirname, "..", "..", "gates", "track-evidence-policy.json");
  assert.equal(fs.readFileSync(enginePath).compare(fs.readFileSync(legacyPath)), 0);
  assert.deepEqual(policy.loadDefaultPolicy(), JSON.parse(fs.readFileSync(enginePath, "utf8")));
});

test("missing plan state blocks evidence requirements that need explicit live or data proof", () => {
  const issues = policy.evaluateTrackRequirements({
    ticketId: "T-713", track: "development", riskClass: "R4",
    policy: { tracks: { development: { required: [
      { id: "redaction_cleanup", label: "live-data redaction and cleanup" },
      { id: "dq_reconciliation", label: "data-quality reconciliation" },
    ] } } },
  });
  assert.deepEqual(issues.map((issue) => issue.code).sort(), ["track_evidence_dq_reconciliation", "track_evidence_redaction_cleanup"]);
});

test("redaction evidence requires both meaningful redaction and cleanup details", () => {
  const policyConfig = { tracks: { development: { required: [
    { id: "redaction_cleanup", label: "live-data redaction and cleanup" },
  ] } } };
  const evaluate = (liveMcp) => policy.evaluateTrackRequirements({
    ticketId: "T-713", track: "development", riskClass: "R4", policy: policyConfig,
    planState: { live_mcp: liveMcp },
  });
  assert.deepEqual(evaluate({ redaction: "Sensitive fields were removed." }).map((issue) => issue.code), ["track_evidence_redaction_cleanup"]);
  assert.deepEqual(evaluate({ redaction: "Sensitive fields were removed.", cleanup: "Temporary records were deleted." }), []);
});

test("explicit live-MCP receipt path and current DQ text satisfy their configured evidence requirements", () => {
  const policyConfig = { tracks: { development: { required: [
    { id: "live_mcp_receipt", label: "a live MCP receipt" },
    { id: "dq_reconciliation", label: "data-quality reconciliation" },
  ] } } };
  const report = policy.evaluateTrackRequirements({
    ticketId: "T-713", track: "development", riskClass: "R4", policy: policyConfig,
    planState: { live_mcp: { receipt_path: "coord/.runtime/evidence/live-mcp.json" }, feature_proof: ["DQ indicator reviewed"] },
  });
  assert.deepEqual(report, []);
});

test("unknown configured evidence requirement fails closed instead of being silently satisfied", () => {
  const issues = policy.evaluateTrackRequirements({
    ticketId: "T-713", track: "development", riskClass: "R4",
    policy: { tracks: { development: { required: [{ id: "future_evidence_class", label: "future evidence" }] } } },
    planState: {},
  });
  assert.deepEqual(issues.map((issue) => issue.code), ["track_evidence_future_evidence_class"]);
});

test("superseded repo gates do not satisfy a current track evidence requirement", () => {
  const old = "npm test [result=pass] on stale head";
  const successor = "TODO: correction command was not executed";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const planState = {
    repo_gates: [old, successor],
    evidence_supersessions: [{
      id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate",
      source_ref: sourceRef, successor_ref: successorRef,
      reason: "The prior result was recorded against a stale head.", actor: "fixture",
      timestamp: "2026-10-05T00:00:00.000Z",
    }],
  };
  const issues = policy.evaluateTrackRequirements({ track: "development", riskClass: "R4", planState });
  assert.ok(issues.some((issue) => issue.code === "track_evidence_repo_gate"));
});

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
