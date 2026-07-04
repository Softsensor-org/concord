"use strict";

// COORD-143: tests for the Phase-3 EVAL HARNESS + MEASUREMENT GATE
// (memory-eval.js) — the CORE deliverable.
//
// Cover: each metric is computed correctly (recall@k, citation precision, answer
// groundedness, stale-answer rate); the gate correctly ENABLES on measured
// improvement and KEEPS-OFF otherwise (no improvement / regression / latency);
// and the full evaluate() runs over the REAL benchmark producing a baseline-vs-
// semantic comparison + an honest gate verdict.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { sandboxProcessRuntimeLocks } = require("./governance-test-utils.js");

// COORD-300: redirect MEMORY_DIR to a per-process os.tmpdir() sandbox so
// evaluate()'s decisions-corpus rebuild writes the sandbox, not the live
// coord/memory tree. The benchmark stays a live read. This lets
// memory-eval.test.js leave the test-isolation-guard RUNTIME_ALLOWLIST_FILES set.
sandboxProcessRuntimeLocks();

const evalMod = require("./memory-eval.js");

const FIXTURE_BENCHMARK = path.join(__dirname, "__fixtures__", "memory-phase3", "benchmark.json");

// --- per-case metric math ----------------------------------------------------

test("scoreCase computes recall@k, citation precision, groundedness, staleness", () => {
  const testCase = {
    id: "T1",
    expected_sources: [
      { type: "decision", id: "A" },
      { type: "file", path: "p/x.js" },
    ],
    must_include: ["foo", "bar"],
  };
  // Result cites A (expected) + an extra irrelevant decision B; finds file too.
  const result = {
    answer: "the answer mentions foo and bar",
    staleness: "fresh",
    sources: [
      { type: "decision", id: "A" },
      { type: "file", path: "p/x.js" },
      { type: "decision", id: "B" },
    ],
  };
  const s = evalMod.scoreCase(testCase, result, 5);
  assert.equal(s.recall_at_k, 1, "both expected sources found");
  // 2 of 3 cited are expected.
  assert.ok(Math.abs(s.citation_precision - 2 / 3) < 1e-9);
  assert.equal(s.answer_groundedness, 1, "both needles present");
  assert.equal(s.stale, 0);
});

test("scoreCase: missing expected source lowers recall@k; missing needle lowers groundedness", () => {
  const testCase = {
    id: "T2",
    expected_sources: [
      { type: "decision", id: "A" },
      { type: "decision", id: "C" },
    ],
    must_include: ["present", "absent"],
  };
  const result = {
    answer: "only present here",
    staleness: "stale",
    sources: [{ type: "decision", id: "A" }],
  };
  const s = evalMod.scoreCase(testCase, result, 5);
  assert.equal(s.recall_at_k, 0.5);
  assert.equal(s.citation_precision, 1, "the one cited source is expected");
  assert.equal(s.answer_groundedness, 0.5);
  assert.equal(s.stale, 1, "stale answer flagged");
});

test("scoreCase respects top-k truncation for recall + precision", () => {
  const testCase = {
    id: "T3",
    expected_sources: [{ type: "decision", id: "Z" }],
    must_include: [],
  };
  // Z is cited but at rank 3 — with k=2 it falls outside the window.
  const result = {
    answer: "",
    staleness: "fresh",
    sources: [
      { type: "decision", id: "A" },
      { type: "decision", id: "B" },
      { type: "decision", id: "Z" },
    ],
  };
  assert.equal(evalMod.scoreCase(testCase, result, 2).recall_at_k, 0);
  assert.equal(evalMod.scoreCase(testCase, result, 5).recall_at_k, 1);
});

// --- the gate ----------------------------------------------------------------

function metrics(over) {
  return {
    metrics: {
      recall_at_k: 0.8,
      citation_precision: 0.5,
      answer_groundedness: 0.9,
      stale_answer_rate: 0,
      latency_ms_avg: 1,
      ...over,
    },
    per_case: [{}, {}, {}, {}, {}],
  };
}

test("gate ENABLES when semantic strictly improves a quality metric with no regression", () => {
  const baseline = metrics({});
  const semantic = metrics({ recall_at_k: 0.95 }); // improved, nothing worse
  const gate = evalMod.decideGate(baseline, semantic);
  assert.equal(gate.semantic_better, true);
  assert.equal(gate.enable_by_default, true);
  assert.ok(gate.improvements.includes("recall_at_k"));
  assert.deepEqual(gate.regressions, []);
});

test("gate KEEPS-OFF when semantic regresses any quality metric", () => {
  const baseline = metrics({});
  const semantic = metrics({ recall_at_k: 0.95, citation_precision: 0.4 }); // one up, one down
  const gate = evalMod.decideGate(baseline, semantic);
  assert.equal(gate.semantic_better, false);
  assert.ok(gate.regressions.includes("citation_precision"));
});

test("gate KEEPS-OFF when semantic shows no measurable improvement", () => {
  const baseline = metrics({});
  const semantic = metrics({}); // identical
  const gate = evalMod.decideGate(baseline, semantic);
  assert.equal(gate.semantic_better, false);
  assert.deepEqual(gate.improvements, []);
  assert.match(gate.rationale, /no measurable quality improvement/);
});

test("gate KEEPS-OFF when latency blows past the budget with no quality gain... but it is the no-improvement path that wins the rationale", () => {
  const baseline = metrics({ latency_ms_avg: 10 });
  const semantic = metrics({ latency_ms_avg: 1000 }); // 100x slower, no gain
  const gate = evalMod.decideGate(baseline, semantic);
  assert.equal(gate.semantic_better, false);
  assert.equal(gate.latency_regressed, true);
});

test("gate treats lower stale_answer_rate as an improvement", () => {
  const baseline = metrics({ stale_answer_rate: 0.4 });
  const semantic = metrics({ stale_answer_rate: 0.1 });
  const gate = evalMod.decideGate(baseline, semantic);
  assert.equal(gate.semantic_better, true);
  assert.ok(gate.improvements.includes("stale_answer_rate"));
});

// --- full integration over the real benchmark --------------------------------

test("evaluate runs baseline AND semantic over the real benchmark and emits a gate verdict", () => {
  const report = evalMod.evaluate({});
  assert.ok(report.benchmark_cases >= 5);
  for (const cfg of ["baseline", "semantic"]) {
    const m = report[cfg];
    for (const key of [
      "recall_at_k",
      "citation_precision",
      "answer_groundedness",
      "stale_answer_rate",
      "latency_ms_avg",
    ]) {
      assert.equal(typeof m[key], "number", `${cfg}.${key} must be a number`);
    }
  }
  // The gate verdict must be a concrete boolean with a rationale.
  assert.equal(typeof report.gate.semantic_better, "boolean");
  assert.equal(report.gate.enable_by_default, report.gate.semantic_better);
  assert.equal(typeof report.gate.rationale, "string");
  // HONEST baseline-quality invariant: the deterministic Phase-1 baseline already
  // achieves strong recall + groundedness on the real benchmark, so semantic has
  // no quality headroom and the layer stays OFF by default. This asserts the
  // documented outcome rather than a fragile exact number.
  assert.ok(report.baseline.recall_at_k >= report.semantic.recall_at_k - 1e-9);
});

test("temporal validity benchmark keeps invalid memory out of active context and reports mandatory warnings", () => {
  const benchmark = require(FIXTURE_BENCHMARK);
  const result = evalMod.evaluateTemporalValidity(benchmark);
  assert.equal(result.metrics.temporal_cases, 1);
  assert.equal(result.metrics.active_constraint_safety_rate, 1);
  assert.equal(result.metrics.warning_coverage, 1);
  assert.equal(result.metrics.current_authority_preference_rate, 1);

  const tv = result.cases[0];
  assert.deepEqual(tv.missing_active, []);
  assert.deepEqual(tv.active_violations, []);
  assert.equal(tv.pack_summary.fields, 1);
  assert.equal(tv.pack_summary.stale_sources, 1);
  assert.equal(tv.pack_summary.history, 1);
  assert.equal(tv.pack_summary.conflicts, 1);
});

test("evaluate includes temporal-validity metrics without merging them into recall@k", () => {
  const report = evalMod.evaluate({ benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true });
  assert.equal(report.benchmark_cases, 2);
  assert.equal(report.temporal_validity.temporal_cases, 1);
  assert.equal(report.claim_promotion.claim_promotion_cases, 1);
  assert.equal(typeof report.baseline.stale_answer_rate, "number");
  assert.equal(typeof report.temporal_validity.active_constraint_safety_rate, "number");
  assert.equal(typeof report.claim_promotion.proposed_claim_precision, "number");
  assert.notEqual(Object.prototype.hasOwnProperty.call(report.baseline, "active_constraint_safety_rate"), true);
  assert.notEqual(Object.prototype.hasOwnProperty.call(report.baseline, "proposed_claim_precision"), true);
});

test("COORD-317 claim-promotion benchmark gates broad extractor rollout on precision", () => {
  const benchmark = require(FIXTURE_BENCHMARK);
  const result = evalMod.evaluateClaimPromotion(benchmark);
  assert.equal(result.metrics.claim_promotion_cases, 1);
  assert.equal(result.metrics.promoted_claim_precision, 1);
  assert.equal(result.metrics.auto_reject_accuracy, 1);
  assert.equal(result.metrics.conflict_detection, 1);
  assert.equal(result.metrics.false_authority_rate, 0);
  assert.equal(result.gate.broad_extractor_rollout_allowed, true);

  const failed = evalMod.decideClaimPromotionGate({
    ...result.metrics,
    false_authority_rate: 1,
  });
  assert.equal(failed.broad_extractor_rollout_allowed, false);
  assert.ok(failed.failures.includes("false_authority_rate"));
});

test("formatReport renders a readable baseline-vs-semantic table + gate line", () => {
  const report = evalMod.evaluate({ benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true });
  const text = evalMod.formatReport(report);
  assert.match(text, /baseline/);
  assert.match(text, /semantic/);
  assert.match(text, /recall_at_k/);
  assert.match(text, /stale_answer_rate/);
  assert.match(text, /GATE: semantic_better=/);
  assert.match(text, /Temporal validity/);
  assert.match(text, /active_constraint_safety_rate/);
  assert.match(text, /Claim promotion precision/);
  assert.match(text, /CLAIM GATE: broad_extractor_rollout_allowed=/);
});
