"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const authority = require("./evidence-authority.js");

test("implementation-only observed records cannot guide implementation", () => {
  const source = {
    authority: "implementation",
    visibility: "internal",
    freshness: "unknown",
  };
  const decision = authority.classifyRecordAuthority(
    { confidence: "observed", status: "candidate" },
    [source]
  );
  assert.equal(decision.confidence, "observed");
  assert.equal(decision.computed_confidence, "observed");
  assert.equal(decision.confidence_inputs.verification_level, "observed_behavior");
  assert.equal(decision.confidence_inputs.corroborating_source_count, 1);
  assert.equal(decision.can_guide_implementation, false);
  assert.equal(decision.approval_required, true);
  assert.match(decision.reason, /candidate|Observed/);
});

test("accepted confirmed records can guide implementation", () => {
  const decision = authority.classifyRecordAuthority(
    { confidence: "observed", status: "accepted", reviewer_approved: true },
    [
      { authority: "approved_policy", visibility: "internal", freshness: "current" },
      { authority: "test_proof", visibility: "internal", freshness: "current" },
    ]
  );
  assert.equal(decision.confidence, "confirmed");
  assert.equal(decision.confidence_inputs.extractor_confidence, "observed");
  assert.equal(decision.confidence_inputs.review_status, "approved");
  assert.equal(decision.can_guide_implementation, true);
  assert.equal(decision.approval_required, false);
});

test("extractor-authored confirmed is downgraded without authoritative evidence", () => {
  const decision = authority.classifyRecordAuthority(
    { confidence: "confirmed", status: "accepted" },
    [{ authority: "implementation", visibility: "internal", freshness: "current" }]
  );
  assert.equal(decision.confidence, "observed");
  assert.equal(decision.confidence_inputs.extractor_confidence, "confirmed");
  assert.equal(decision.can_guide_implementation, false);
});

test("machine verified multi-source intent can become confirmed", () => {
  const decision = authority.classifyRecordAuthority(
    { confidence: "unknown", status: "candidate", deterministic_verified: true },
    [
      { authority: "requirement", visibility: "internal", freshness: "current" },
      { authority: "test_proof", visibility: "internal", freshness: "current" },
    ]
  );
  assert.equal(decision.confidence, "confirmed");
  assert.equal(decision.confidence_inputs.verification_level, "machine_verified");
  assert.equal(decision.confidence_inputs.corroborating_source_count, 2);
});

test("stale or conflicted records cannot compute active confirmed confidence", () => {
  const stale = authority.classifyRecordAuthority(
    { confidence: "confirmed", status: "accepted", reviewer_approved: true },
    [{ authority: "approved_policy", visibility: "internal", freshness: "stale" }]
  );
  assert.equal(stale.confidence, "deprecated");
  assert.equal(stale.confidence_inputs.freshness, "stale");
  assert.equal(stale.can_guide_implementation, false);

  const conflicted = authority.classifyRecordAuthority(
    { confidence: "confirmed", status: "accepted", reviewer_approved: true, conflicts_with: ["BD-REC-2"] },
    [{ authority: "approved_policy", visibility: "internal", freshness: "current" }]
  );
  assert.equal(conflicted.confidence, "contradicted");
  assert.equal(conflicted.confidence_inputs.conflict_state, "conflicted");
  assert.equal(conflicted.can_guide_implementation, false);
});

test("inferred unknown contradicted and deprecated records are blocked unless waived", () => {
  for (const confidence of ["inferred", "unknown", "contradicted", "deprecated"]) {
    const decision = authority.classifyRecordAuthority(
      { confidence, status: "accepted" },
      [{ authority: "implementation", visibility: "internal", freshness: "current" }]
    );
    assert.equal(decision.can_guide_implementation, false);
    assert.equal(decision.approval_required, true);
  }

  const waived = authority.classifyRecordAuthority(
    { confidence: "inferred", status: "waived" },
    [{ authority: "implementation", visibility: "sensitive", freshness: "current" }]
  );
  assert.equal(waived.confidence, "waived");
  assert.equal(waived.can_guide_implementation, true);
  assert.equal(waived.approval_required, false);
  assert.equal(waived.sensitivity, "sensitive");
});
