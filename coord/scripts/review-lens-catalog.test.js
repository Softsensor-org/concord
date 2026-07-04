"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  REVIEW_LENS_CATALOG,
  CANONICAL_LENS_BUCKETS,
  REQUIRED_LENS_BUCKETS,
  classifyLensBuckets,
  assessLensCoverage,
} = require("./review-lens-catalog.js");

test("catalog codifies the five canonical, diverse, adversarial lenses", () => {
  assert.deepEqual(CANONICAL_LENS_BUCKETS, [
    "contract/state invariants",
    "auth/security/failure modes",
    "tests/operability/performance",
    "requirement closure",
    "adversarial misuse",
  ]);
  // Every lens carries a probe describing what it must adversarially interrogate.
  for (const lens of REVIEW_LENS_CATALOG) {
    assert.ok(lens.title && typeof lens.title === "string");
    assert.ok(lens.probe && lens.probe.length > 20, `${lens.bucket} needs a probe`);
    assert.ok(Array.isArray(lens.match) && lens.match.length > 0);
  }
});

test("REQUIRED_LENS_BUCKETS is the four original buckets — adversarial misuse is advisory only", () => {
  assert.deepEqual(REQUIRED_LENS_BUCKETS, [
    "contract/state invariants",
    "auth/security/failure modes",
    "tests/operability/performance",
    "requirement closure",
  ]);
  // The fifth lens must NOT be hard-required (no retroactive blocker).
  assert.ok(!REQUIRED_LENS_BUCKETS.includes("adversarial misuse"));
});

test("classifyLensBuckets maps free-text descriptions to canonical buckets", () => {
  assert.deepEqual(classifyLensBuckets("Contract and state invariants"), [
    "contract/state invariants",
  ]);
  assert.deepEqual(classifyLensBuckets("Security and failure modes"), [
    "auth/security/failure modes",
  ]);
  assert.deepEqual(classifyLensBuckets("Tests and operability"), [
    "tests/operability/performance",
  ]);
  assert.deepEqual(classifyLensBuckets("Requirement closure"), [
    "requirement closure",
  ]);
  assert.deepEqual(classifyLensBuckets("Adversarial misuse and abuse"), [
    "adversarial misuse",
  ]);
});

test("classifyLensBuckets is empty for unmatched / blank text and case-insensitive", () => {
  assert.deepEqual(classifyLensBuckets(""), []);
  assert.deepEqual(classifyLensBuckets(null), []);
  assert.deepEqual(classifyLensBuckets("a vague unrelated note"), []);
  assert.deepEqual(classifyLensBuckets("INJECTION AND RBAC"), [
    "auth/security/failure modes",
  ]);
});

test("classifyLensBuckets can return multiple buckets for a cross-cutting description", () => {
  const buckets = classifyLensBuckets("api contract plus tenant authz coverage");
  assert.ok(buckets.includes("contract/state invariants"));
  assert.ok(buckets.includes("auth/security/failure modes"));
  assert.ok(buckets.includes("tests/operability/performance"));
});

test("assessLensCoverage detects a fully diverse covered set", () => {
  const cycles = [
    { lens: "Contract and state invariants" },
    { lens: "Auth, security and failure modes" },
    { lens: "Tests and operability" },
    { lens: "Requirement closure" },
    { lens: "Adversarial misuse" },
  ];
  const result = assessLensCoverage(cycles);
  assert.deepEqual(result.covered, CANONICAL_LENS_BUCKETS);
  assert.deepEqual(result.missing, []);
  assert.equal(result.diverse, true);
  assert.equal(result.requiredSatisfied, true);
  assert.equal(result.advisory, true);
});

test("assessLensCoverage detects missing lenses and splits required vs advisory", () => {
  // The four required lenses present, adversarial-misuse absent.
  const cycles = [
    { lens: "Contract and state invariants" },
    { lens: "Security and failure modes" },
    { lens: "Tests and operability" },
    { lens: "Requirement closure" },
  ];
  const result = assessLensCoverage(cycles);
  assert.deepEqual(result.missing, ["adversarial misuse"]);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.missingAdvisory, ["adversarial misuse"]);
  // Diversity not yet complete, but all REQUIRED lenses are satisfied.
  assert.equal(result.diverse, false);
  assert.equal(result.requiredSatisfied, true);
});

test("assessLensCoverage reports missing REQUIRED lenses too", () => {
  const result = assessLensCoverage([{ lens: "Contract and state invariants" }]);
  assert.ok(result.missingRequired.includes("auth/security/failure modes"));
  assert.ok(result.missingRequired.includes("tests/operability/performance"));
  assert.ok(result.missingRequired.includes("requirement closure"));
  assert.equal(result.requiredSatisfied, false);
});

test("assessLensCoverage is ADVISORY — it never throws and never blocks on bad input", () => {
  // The contract is: always returns a shape with advisory:true; never raises.
  for (const input of [undefined, null, [], "not-an-array", 42, {}]) {
    const result = assessLensCoverage(input);
    assert.equal(result.advisory, true, `advisory for ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(result.covered));
    assert.ok(Array.isArray(result.missing));
  }
  // Empty cycles → everything missing, but still advisory (NOT a thrown gate).
  const empty = assessLensCoverage([]);
  assert.deepEqual(empty.missing, CANONICAL_LENS_BUCKETS);
  assert.equal(empty.diverse, false);
  assert.equal(empty.advisory, true);
});

test("assessLensCoverage accepts bare-string cycles as well as {lens} objects", () => {
  const result = assessLensCoverage(["Adversarial misuse probe", "Requirement closure"]);
  assert.ok(result.covered.includes("adversarial misuse"));
  assert.ok(result.covered.includes("requirement closure"));
});
