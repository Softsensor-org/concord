"use strict";

// COORD-137 (Quality dimension #7): review-lens hardening.
//
// Semantic / domain correctness is the ONE quality dimension that is NOT
// statically gate-able (see the boundary section of
// `coord/docs/QUALITY_DIMENSIONS.md`). A static checker can hold the line on
// debt and drift, but whether a change does the *right* thing for the business
// is not mechanically decidable. The lever for that gap is HARDENING the human/
// agent review step with a set of diverse, named, adversarial LENSES that are
// recorded as auditable review-cycle EVIDENCE — not a new checker.
//
// This module is the SINGLE SOURCE OF TRUTH for the canonical lens catalog. It
// is pure data + pure helpers: it does NOT read the board, mutate plan state, or
// run any subprocess. `governance-validation.js` delegates its lens
// classification to `classifyLensBuckets` here so the catalog and the
// move-review lens-coverage signal can never drift apart.
//
// Framing (deliberate): this is "carried as evidence, not a checker" and
// "roadmap-only". The coverage helper below is ADVISORY — it reports which
// canonical lenses a ticket's recorded review cycles cover vs. miss, but it does
// NOT introduce a new hard gate. The pre-existing move-review lens-coverage
// blocker in `governance-validation.js` is unchanged: it still requires only the
// four original buckets, so adding the fifth (adversarial-misuse) lens here does
// NOT retroactively break any existing ticket's review cycles.

// The canonical, diverse, adversarial review lenses. Each entry pairs a stable
// `bucket` id (the coverage key) with `match` patterns used to classify a
// free-text `lens=` description and a short `probe` describing what the lens
// must adversarially interrogate. Order is the recommended review order.
const REVIEW_LENS_CATALOG = Object.freeze([
  Object.freeze({
    bucket: "contract/state invariants",
    title: "Contract & state invariants",
    match: Object.freeze(["contract", "state", "invariant", "schema", "api"]),
    probe:
      "Do public APIs match their declared contracts? Are state transitions "
      + "complete and ordered? Are domain-model constraints and shared types "
      + "preserved across boundaries?",
    required: true,
  }),
  Object.freeze({
    bucket: "auth/security/failure modes",
    title: "Auth, security & failure modes",
    match: Object.freeze([
      "auth",
      "security",
      "failure",
      "rbac",
      "permission",
      "injection",
      "tenant",
    ]),
    probe:
      "Any injection / taint / unsafe-API risk? Are authz and tenant-isolation "
      + "checks in place? Is sensitive data exposed in logs or responses? Do "
      + "failures propagate gracefully? Any race / TOCTOU conditions?",
    required: true,
  }),
  Object.freeze({
    bucket: "tests/operability/performance",
    title: "Tests, operability & performance",
    match: Object.freeze([
      "test",
      "operability",
      "performance",
      "coverage",
      "runtime",
      "observability",
      "logging",
    ]),
    probe:
      "Are new/changed behaviors covered by unit + error-path tests? Do existing "
      + "tests still pass? Any O(n^2) / N+1 / needless allocation? Is logging "
      + "adequate for production debugging?",
    required: true,
  }),
  Object.freeze({
    bucket: "requirement closure",
    title: "Requirement closure",
    match: Object.freeze([
      "requirement",
      "closure",
      "scope",
      "ask",
      "implemented",
      "deferred",
    ]),
    probe:
      "Does the change satisfy the ticket ask? Is the implemented / not-"
      + "implemented / deferred split accurate, and does the closeout verdict "
      + "match the actual diff?",
    required: true,
  }),
  // The fifth, diversity-extending lens. It is ADVISORY ONLY: it is intentionally
  // NOT marked `required`, so it is reported by the coverage helper and surfaced
  // to reviewers, but it is NOT added to the move-review hard blocker — adding it
  // here cannot retroactively fail any existing ticket.
  Object.freeze({
    bucket: "adversarial misuse",
    title: "Adversarial misuse",
    match: Object.freeze([
      "adversarial",
      "misuse",
      "abuse",
      "malicious",
      "exploit",
      "fuzz",
      "edge-case",
      "hostile",
    ]),
    probe:
      "Think like a hostile / careless user: malformed input, out-of-order "
      + "calls, replay, boundary and overflow values, concurrent abuse, and "
      + "intended-but-unstated misuse. What breaks the invariants the happy "
      + "path assumes?",
    required: false,
  }),
]);

// Stable, ordered list of every canonical bucket id.
const CANONICAL_LENS_BUCKETS = Object.freeze(
  REVIEW_LENS_CATALOG.map((lens) => lens.bucket),
);

// The buckets the existing move-review gate hard-requires. This is the SAME
// four-bucket set governance-validation.js already enforced; it is exported so
// the gate and the catalog reference one list. `adversarial misuse` is
// deliberately excluded → advisory, not a retroactive blocker.
const REQUIRED_LENS_BUCKETS = Object.freeze(
  REVIEW_LENS_CATALOG.filter((lens) => lens.required).map((lens) => lens.bucket),
);

// Classify a free-text `lens=` description into zero or more canonical buckets.
// Pure, case-insensitive substring matching against each lens's `match` terms.
// A single description may legitimately touch multiple buckets.
function classifyLensBuckets(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const buckets = [];
  for (const lens of REVIEW_LENS_CATALOG) {
    if (lens.match.some((term) => normalized.includes(term))) {
      buckets.push(lens.bucket);
    }
  }
  return buckets;
}

// ADVISORY coverage assessment. Given a ticket's recorded review cycles (each a
// plain object with a `lens` string, as produced by the plan record), report
// which canonical lenses are covered vs. missing. This is a signal a reviewer or
// `gov explain` can surface — it never throws and never blocks.
//
// Returns:
//   {
//     covered:           ["contract/state invariants", ...],   // canonical order
//     missing:           ["adversarial misuse", ...],          // canonical order
//     missingRequired:   [...],   // subset of `missing` that is hard-required
//     missingAdvisory:   [...],   // subset of `missing` that is advisory-only
//     diverse:           <bool>,  // every canonical lens covered
//     requiredSatisfied: <bool>,  // every REQUIRED lens covered
//     advisory:          true,    // this assessment is never a hard gate
//   }
function assessLensCoverage(cycles) {
  const list = Array.isArray(cycles) ? cycles : [];
  const seen = new Set();
  for (const cycle of list) {
    const lensText = cycle && typeof cycle === "object" ? cycle.lens : cycle;
    for (const bucket of classifyLensBuckets(lensText)) {
      seen.add(bucket);
    }
  }
  const covered = CANONICAL_LENS_BUCKETS.filter((bucket) => seen.has(bucket));
  const missing = CANONICAL_LENS_BUCKETS.filter((bucket) => !seen.has(bucket));
  const missingRequired = missing.filter((bucket) =>
    REQUIRED_LENS_BUCKETS.includes(bucket));
  const missingAdvisory = missing.filter((bucket) =>
    !REQUIRED_LENS_BUCKETS.includes(bucket));
  return {
    covered,
    missing,
    missingRequired,
    missingAdvisory,
    diverse: missing.length === 0,
    requiredSatisfied: missingRequired.length === 0,
    advisory: true,
  };
}

module.exports = {
  REVIEW_LENS_CATALOG,
  CANONICAL_LENS_BUCKETS,
  REQUIRED_LENS_BUCKETS,
  classifyLensBuckets,
  assessLensCoverage,
};
