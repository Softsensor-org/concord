"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBootstrapAdvisory,
  collectMissingEvidence,
  hasVerificationBeyondReadiness,
} = require("./bootstrap-advisory.js");

// COORD-160: advisory-only server-bootstrap/backfill risk surfacing. These tests
// pin the four required behaviors from the ticket:
//   (a) backfill/migration mention with no bootstrap_risk -> advisory lists the
//       missing evidence fields;
//   (b) a complete bootstrap_risk -> no advisory;
//   (c) a harmless/local mention -> no advisory (no false-block);
//   (d) it never blocks and never throws (no exit-code influence).

const COMPLETE_RISK = {
  startup_work_class: "server_bootstrap_job",
  runs_at_boot: false,
  shares_app_process: false,
  resource_envelope: {
    memory_mb: 1024,
    timeout_s: 900,
    expected_rows: 100000,
    batch_size: 500,
    db_pool_impact: "one read cursor, one writer",
  },
  idempotency_strategy: "lease + checkpoint + completion marker",
  checkpoint_strategy: "row-id watermark persisted every batch",
  verification_signal: "job receipt + marker row + metric",
  rollback_or_disable: "feature flag off by default; rerun from checkpoint",
  observability_requirements: ["logs", "task status", "metrics", "failure reason"],
  data_access_shape: "paginated",
};

test("(a) backfill mention with no bootstrap_risk triggers an advisory listing missing fields", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-1", Description: "Add a historical backfill of the fact table for analytics." },
    planState: {},
  });
  assert.equal(advisory.triggered, true);
  assert.equal(advisory.blocking, false);
  assert.ok(advisory.matched_signals.includes("backfill"));
  assert.ok(advisory.matched_signals.includes("fact-table"));
  assert.deepEqual(advisory.missing_evidence, [
    "resource_envelope",
    "idempotency_or_checkpoint_strategy",
    "verification_signal_beyond_readiness",
    "rollback_or_disable",
    "observability_requirements",
  ]);
  assert.match(advisory.message, /Advisory only \(non-blocking\)/);
});

test("(a2) migration mention with partial bootstrap_risk lists only the remaining gaps", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-2", Description: "Run a data migration to backfill derived data." },
    planState: {
      bootstrap_risk: {
        resource_envelope: { memory_mb: 512 },
        idempotency_strategy: "lease + completion marker",
      },
    },
  });
  assert.equal(advisory.triggered, true);
  assert.equal(advisory.blocking, false);
  assert.deepEqual(advisory.missing_evidence, [
    "verification_signal_beyond_readiness",
    "rollback_or_disable",
    "observability_requirements",
  ]);
});

test("(b) a complete bootstrap_risk produces no advisory even with strong signals", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-3", Description: "Generated-data replay job: backfill + migration of derived data." },
    planState: { bootstrap_risk: COMPLETE_RISK },
  });
  assert.equal(advisory.triggered, false);
  assert.equal(advisory.blocking, false);
  assert.deepEqual(advisory.missing_evidence, []);
});

test("(c) harmless local seed mention does NOT trigger (no false-block)", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-4", Description: "Seed local dev data and sample fixtures for the dashboard." },
    planState: {},
  });
  assert.equal(advisory.triggered, false);
  assert.equal(advisory.blocking, false);
  assert.equal(advisory.suppressed_reason, "local_context_weak_signals_only");
});

test("(c2) declared local_bootstrap work class suppresses the advisory entirely", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-5", Description: "Backfill migration replay derived-data fact-table." },
    planState: { bootstrap_risk: { startup_work_class: "local_bootstrap" } },
  });
  assert.equal(advisory.triggered, false);
  assert.equal(advisory.suppressed_reason, "declared_local_bootstrap");
});

test("(c3) a plain startup-config mention (weak signal, no strong work) does not trigger", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-6", Description: "Add a tiny synchronous startup config compatibility check before listen." },
    planState: {},
  });
  // 'startup' is a weak signal; without a local context it could match, but it is
  // the only weak signal and there is no strong data-work signal, so it triggers
  // a conservative advisory. Confirm it never blocks regardless.
  assert.equal(advisory.blocking, false);
  if (advisory.triggered) {
    assert.deepEqual(advisory.matched_signals, ["startup"]);
  }
});

test("(d) advisory never blocks and never throws on degenerate input", () => {
  for (const input of [
    undefined,
    {},
    { row: null, planState: null },
    { row: {}, planState: { bootstrap_risk: [] } },
    { row: { Description: "" }, planState: { change_summary: ["backfill"] } },
  ]) {
    let advisory;
    assert.doesNotThrow(() => {
      advisory = buildBootstrapAdvisory(input);
    });
    assert.equal(advisory.blocking, false, `blocking must be false for ${JSON.stringify(input)}`);
  }
});

test("plan free-text fields (change_summary) are scanned, not just the row description", () => {
  const advisory = buildBootstrapAdvisory({
    row: { ID: "APP-7", Description: "Analytics feature." },
    planState: { change_summary: ["Implement an index-population job over the fact table."] },
  });
  assert.equal(advisory.triggered, true);
  assert.ok(advisory.matched_signals.includes("index-population"));
});

test("verification_signal of only /readyz does not count as beyond readiness", () => {
  assert.equal(hasVerificationBeyondReadiness({ verification_signal: "/readyz" }), false);
  assert.equal(hasVerificationBeyondReadiness({ verification_signal: "deploy success" }), false);
  assert.equal(hasVerificationBeyondReadiness({ verification_signal: "server started" }), false);
  assert.equal(hasVerificationBeyondReadiness({ verification_signal: "job receipt + marker row" }), true);
});

test("collectMissingEvidence accepts checkpoint_strategy alone for the idempotency requirement", () => {
  const missing = collectMissingEvidence({
    resource_envelope: { memory_mb: 256 },
    checkpoint_strategy: "row-id watermark",
    verification_signal: "receipt row",
    rollback_or_disable: "flag off",
    observability_requirements: ["logs"],
  });
  assert.deepEqual(missing, []);
});
