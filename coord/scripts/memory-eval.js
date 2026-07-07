"use strict";

// COORD-143: [Memory] Phase 3 — the EVAL HARNESS + MEASUREMENT GATE.
//
// This is the CORE deliverable of Phase 3. Per coord/docs/MEMORY_ARCHITECTURE.md
// §8 the Phase-0 benchmark (coord/memory/eval/benchmark.json) is the ground truth
// EVERY later phase is measured against, on these metrics: recall@k, citation
// precision, answer groundedness, stale-answer rate, latency. §10 is explicit:
// "Don't overclaim 'semantic memory' until ... evaluated against the Phase 0
// harness" and "vectors are Phase 3, GATED ON MEASURED LIFT."
//
// So this harness:
//   1. Scores retrieval over the benchmark on the five metrics.
//   2. Runs it for BOTH configurations:
//        - baseline   = the deterministic Phase-1 recall (recall.js, no semantic)
//        - semantic   = recall + graph links + (local) vector similarity
//   3. GATES: the semantic layer is "better" (enable-by-default candidate) ONLY
//      if it MEASURABLY beats the baseline — improving at least one primary
//      quality metric WITHOUT regressing any other, and without an unacceptable
//      latency blow-up. Otherwise the honest verdict is "semantic NOT better;
//      keep it OFF by default" — an ACCEPTABLE outcome on a tiny 5-case corpus.
//
// The harness DECIDES whether to trust the semantic layer; it does not assume.
// Its output (the comparison table + gate verdict) IS the feature-proof for the
// ticket. ZERO new runtime deps; deterministic (latency aside — see below).
//
// METRIC DEFINITIONS (computed per case, then averaged):
//   - recall@k        : fraction of a case's expected_sources that appear in the
//                       top-k cited sources. The headline retrieval-quality
//                       metric.
//   - citation_precision : fraction of the cited sources that are EXPECTED for the
//                       case (penalizes citing irrelevant sources). 1.0 when no
//                       sources cited and none expected.
//   - answer_groundedness : fraction of the case's must_include substrings that
//                       actually appear in the composed answer (every claim must
//                       be grounded in cited text — §5/§7).
//   - stale_answer_rate : fraction of cases whose answer is flagged `stale`
//                       (lower is better). On a coherent single-head corpus this
//                       is ~0; it guards against citing sources whose chain_head
//                       drifted.
//   - latency_ms_avg  : average wall-clock per query (NOT deterministic; reported
//                       for the gate's latency-regression guard, never asserted
//                       byte-equal).

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BENCHMARK_PATH = path.join(COORD_DIR, "memory", "eval", "benchmark.json");
const DEFAULT_DECISIONS_PATH = path.join(COORD_DIR, "memory", "decisions.ndjson");

const recall = require("./recall.js");
const extractor = require("./decision-extractor.js");
const memoryGraph = require("./memory-graph.js");
const memoryVector = require("./memory-vector.js");
const contextPack = require("./business-context-pack.js");
const claimCompiler = require("./knowledge-claim-compiler.js");

const DEFAULT_TOP_K = 5;

function sourceKey(s) {
  return s.type === "decision" ? `decision:${s.id}` : `file:${s.path}`;
}

function expectedKey(e) {
  return e.type === "decision" ? `decision:${e.id}` : `file:${e.path}`;
}

// Score a single benchmark case against one recall result.
function scoreCase(testCase, result, topK) {
  const cited = (result.sources || []).slice(0, topK);
  const citedKeys = new Set(cited.map(sourceKey));
  const expected = testCase.expected_sources || [];
  const expectedKeys = expected.map(expectedKey);

  // recall@k: expected sources found in the top-k.
  const found = expectedKeys.filter((k) => citedKeys.has(k)).length;
  const recallAtK = expectedKeys.length ? found / expectedKeys.length : 1;

  // citation precision: cited sources that are expected.
  const expectedSet = new Set(expectedKeys);
  const citedArr = [...citedKeys];
  const relevantCited = citedArr.filter((k) => expectedSet.has(k)).length;
  const citationPrecision = citedArr.length ? relevantCited / citedArr.length : (expectedKeys.length ? 0 : 1);

  // answer groundedness: must_include substrings present in the answer.
  const needles = testCase.must_include || [];
  const grounded = needles.filter((n) => (result.answer || "").includes(n)).length;
  const groundedness = needles.length ? grounded / needles.length : 1;

  const stale = result.staleness === "stale" ? 1 : 0;

  return {
    id: testCase.id,
    recall_at_k: recallAtK,
    citation_precision: citationPrecision,
    answer_groundedness: groundedness,
    stale: stale,
  };
}

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Run the whole benchmark under one recall configuration. `recallOptions` is
// merged into every recall() call (e.g. { semantic: {...} } for the augmented
// run; {} for the baseline).
function runConfig(benchmark, recallOptions, options = {}) {
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K;
  const perCase = [];
  let totalLatency = 0;
  // Build the corpus ONCE and reuse it across cases. This mirrors a real recall
  // deployment (the corpus is loaded once, queried many times) and lets the
  // vector path's per-doc embedding cache amortize across queries — a fair
  // latency comparison. The first query under the semantic config still pays the
  // one-time doc-embedding cost; subsequent queries reuse it.
  const corpus = options.corpus || recall.buildCorpus(options);
  for (const testCase of benchmark.cases) {
    const t0 = process.hrtime.bigint();
    const result = recall.recall(testCase.question, { ...recallOptions, topK, corpus });
    const t1 = process.hrtime.bigint();
    totalLatency += Number(t1 - t0) / 1e6; // ns -> ms
    perCase.push(scoreCase(testCase, result, topK));
  }
  return {
    per_case: perCase,
    metrics: {
      recall_at_k: mean(perCase.map((c) => c.recall_at_k)),
      citation_precision: mean(perCase.map((c) => c.citation_precision)),
      answer_groundedness: mean(perCase.map((c) => c.answer_groundedness)),
      stale_answer_rate: mean(perCase.map((c) => c.stale)),
      latency_ms_avg: totalLatency / (benchmark.cases.length || 1),
    },
  };
}

// Build the semantic recall options (graph + local vector embedder) shared by a
// measured run. The graph is built once over current sources; the embedder is
// the dependency-free local one so the harness CAN measure without a dep.
function buildSemanticOptions(options = {}) {
  const decisions = extractor.extractDecisions({
    plansDir: options.plansDir,
    journalPath: options.journalPath,
    rootDir: options.rootDir,
  });
  const graph = memoryGraph.buildGraph({
    boardPath: options.boardPath,
    decisions,
    rootDir: options.rootDir,
  });
  return {
    semantic: {
      graph,
      embedder: options.embedder || memoryVector.localEmbedder(),
      maxHops: 1,
    },
  };
}

// THE GATE. Decide whether the semantic layer measurably beats the baseline.
// Primary quality metrics where HIGHER is better: recall_at_k,
// citation_precision, answer_groundedness. stale_answer_rate: LOWER is better.
// Rule (deliberately conservative): semantic WINS iff it strictly improves at
// least one primary quality metric AND regresses NONE of them AND does not raise
// the stale-answer rate AND does not blow up latency past `latencyBudgetFactor`x
// the baseline (a soft guard; latency is noisy so a small absolute floor is
// allowed). Otherwise the honest verdict is that semantic is NOT better and the
// layer stays OFF by default.
const HIGHER_IS_BETTER = ["recall_at_k", "citation_precision", "answer_groundedness"];
const EPS = 1e-9;

function decideGate(baseline, semantic, options = {}) {
  const latencyBudgetFactor = options.latencyBudgetFactor || 3;
  const latencyAbsFloorMs = options.latencyAbsFloorMs || 5;
  const b = baseline.metrics;
  const s = semantic.metrics;

  const improvements = [];
  const regressions = [];
  for (const m of HIGHER_IS_BETTER) {
    if (s[m] > b[m] + EPS) {
      improvements.push(m);
    } else if (s[m] < b[m] - EPS) {
      regressions.push(m);
    }
  }
  if (s.stale_answer_rate > b.stale_answer_rate + EPS) {
    regressions.push("stale_answer_rate");
  } else if (s.stale_answer_rate < b.stale_answer_rate - EPS) {
    improvements.push("stale_answer_rate");
  }

  // Latency guard: only fails the gate if latency is BOTH above the absolute
  // floor AND beyond the budget multiple (so tiny absolute jitter is ignored).
  const latencyRegressed =
    s.latency_ms_avg > latencyAbsFloorMs &&
    s.latency_ms_avg > b.latency_ms_avg * latencyBudgetFactor;

  const better = improvements.length > 0 && regressions.length === 0 && !latencyRegressed;

  let rationale;
  if (better) {
    rationale =
      `semantic improved [${improvements.join(", ")}] with no regression — ` +
      `ENABLE-by-default candidate.`;
  } else if (regressions.length) {
    rationale =
      `semantic regressed [${regressions.join(", ")}] — keep OFF by default.`;
  } else if (improvements.length === 0) {
    // The deeper, primary finding: no quality headroom. On the tiny benchmark the
    // deterministic baseline already saturates recall_at_k / groundedness, so the
    // semantic layer cannot improve them — it can only match or add cost. This is
    // the honest, ACCEPTABLE Phase-3 outcome (MEMORY_ARCHITECTURE.md §10).
    const latencyNote = latencyRegressed
      ? ` (and it adds latency: ${s.latency_ms_avg.toFixed(3)}ms vs ${b.latency_ms_avg.toFixed(3)}ms)`
      : "";
    rationale =
      `semantic showed no measurable quality improvement over the baseline on a ` +
      `${semantic.per_case.length}-case corpus${latencyNote} — keep OFF by default (honest, acceptable).`;
  } else {
    rationale =
      `semantic latency ${s.latency_ms_avg.toFixed(3)}ms exceeds ` +
      `${latencyBudgetFactor}x baseline ${b.latency_ms_avg.toFixed(3)}ms — keep OFF by default.`;
  }

  return {
    semantic_better: better,
    enable_by_default: better,
    improvements,
    regressions,
    latency_regressed: latencyRegressed,
    rationale,
  };
}

function flattenSectionIds(pack, names) {
  const ids = [];
  for (const name of names) {
    for (const item of pack.sections?.[name]?.items || []) {
      if (item.id) {
        ids.push(item.id);
      }
    }
  }
  return ids;
}

function activeSectionNames(pack) {
  const special = new Set(["conflicts", "history", "stale_sources", "open_questions", "approvals"]);
  return Object.keys(pack.sections || {}).filter((name) => !special.has(name));
}

function fraction(found, expected) {
  if (!expected.length) {
    return 1;
  }
  const foundSet = new Set(found);
  return expected.filter((id) => foundSet.has(id)).length / expected.length;
}

function precision(found, expected) {
  if (!found.length) {
    return expected.length ? 0 : 1;
  }
  const expectedSet = new Set(expected);
  return found.filter((id) => expectedSet.has(id)).length / found.length;
}

function idsForOutcomes(outcomes, statuses) {
  const statusSet = new Set(statuses);
  return outcomes
    .filter((outcome) => statusSet.has(outcome.outcome))
    .map((outcome) => outcome.claim_id)
    .filter(Boolean);
}

function claimEvidenceGrounded(claim) {
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
  if (evidence.length === 0) return false;
  return evidence.some((source) => {
    const authority = source.authority || source.authority_class || source.evidence_role;
    return authority && authority !== "summary";
  });
}

function falseAuthorityPromoted(outcome) {
  return outcome.outcome === "accepted" && outcome.computed_confidence === "confirmed";
}

function scoreClaimPromotionCase(testCase) {
  const compileResult = claimCompiler.compileClaims({
    claims: testCase.claims || [],
    policy: testCase.policy || {},
    context: testCase.context || {},
  });
  const expectations = testCase.expectations || {};
  const outcomes = compileResult.outcomes || [];
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.claim_id, outcome]));
  const claimById = new Map((testCase.claims || []).map((claim) => [claim.id || claim.candidate_id, claim]));

  const reviewable = idsForOutcomes(outcomes, ["accepted", "candidate", "review-required"]);
  const accepted = idsForOutcomes(outcomes, ["accepted"]);
  const rejected = idsForOutcomes(outcomes, ["rejected"]);
  const conflicted = idsForOutcomes(outcomes, ["conflicted"]);
  const expectedReviewable = expectations.expected_reviewable || [
    ...(expectations.expected_accepted || []),
    ...(expectations.expected_candidate || []),
    ...(expectations.expected_review_required || []),
  ];
  const expectedAccepted = expectations.expected_accepted || [];
  const expectedAutoRejected = expectations.expected_auto_rejected || expectations.expected_rejected || [];
  const expectedConflicted = expectations.expected_conflicted || [];
  const expectedGrounded = expectations.expected_grounded || expectedReviewable;
  const falseAuthority = expectations.false_authority_claims || [];
  const falseAuthorityPromotions = falseAuthority
    .map((id) => outcomeById.get(id))
    .filter(Boolean)
    .filter(falseAuthorityPromoted)
    .map((outcome) => outcome.claim_id);
  const groundedFound = expectedGrounded.filter((id) => claimEvidenceGrounded(claimById.get(id) || {}));
  const reviewRequired = idsForOutcomes(outcomes, ["review-required"]);
  const maxReviewRequired =
    Number.isInteger(expectations.max_review_required)
      ? expectations.max_review_required
      : compileResult.policy?.max_claims_per_reviewer || claimCompiler.DEFAULT_POLICY.max_claims_per_reviewer;

  return {
    id: testCase.id,
    proposed_claim_precision: precision(reviewable, expectedReviewable),
    promoted_claim_precision: precision(accepted, expectedAccepted),
    auto_reject_accuracy: fraction(rejected, expectedAutoRejected),
    reviewer_load_budget: reviewRequired.length <= maxReviewRequired ? 1 : 0,
    review_required_count: reviewRequired.length,
    max_review_required: maxReviewRequired,
    conflict_detection: fraction(conflicted, expectedConflicted),
    groundedness: fraction(groundedFound, expectedGrounded),
    false_authority_rate: falseAuthority.length ? falseAuthorityPromotions.length / falseAuthority.length : 0,
    false_authority_promotions: falseAuthorityPromotions,
    accepted,
    reviewable,
    rejected,
    conflicted,
  };
}

function decideClaimPromotionGate(metrics, options = {}) {
  const thresholds = {
    ...claimCompiler.DEFAULT_POLICY.extraction_precision_thresholds,
    ...(options.thresholds || {}),
  };
  const failures = [];
  if (metrics.proposed_claim_precision < thresholds.min_proposed_claim_precision) failures.push("proposed_claim_precision");
  if (metrics.promoted_claim_precision < thresholds.min_promoted_claim_precision) failures.push("promoted_claim_precision");
  if (metrics.auto_reject_accuracy < thresholds.min_auto_reject_accuracy) failures.push("auto_reject_accuracy");
  if (metrics.conflict_detection < thresholds.min_conflict_detection) failures.push("conflict_detection");
  if (metrics.groundedness < thresholds.min_groundedness) failures.push("groundedness");
  if (metrics.false_authority_rate > thresholds.max_false_authority_rate) failures.push("false_authority_rate");
  if (metrics.max_review_required_per_case > thresholds.max_review_required_per_case) failures.push("reviewer_load_budget");
  const pass = failures.length === 0;
  return {
    broad_extractor_rollout_allowed: pass,
    pass,
    failures,
    thresholds,
    rationale: pass
      ? "claim promotion precision thresholds met; broad extractor rollout may proceed."
      : `claim promotion precision thresholds failed [${failures.join(", ")}]; broad extractor rollout remains blocked.`,
  };
}

function evaluateClaimPromotion(benchmark, options = {}) {
  const cases = benchmark.claim_promotion_cases || [];
  const perCase = cases.map(scoreClaimPromotionCase);
  const metrics = {
    claim_promotion_cases: perCase.length,
    proposed_claim_precision: mean(perCase.map((c) => c.proposed_claim_precision)),
    promoted_claim_precision: mean(perCase.map((c) => c.promoted_claim_precision)),
    auto_reject_accuracy: mean(perCase.map((c) => c.auto_reject_accuracy)),
    reviewer_load_budget_rate: mean(perCase.map((c) => c.reviewer_load_budget)),
    max_review_required_per_case: perCase.reduce((max, c) => Math.max(max, c.review_required_count), 0),
    conflict_detection: mean(perCase.map((c) => c.conflict_detection)),
    groundedness: mean(perCase.map((c) => c.groundedness)),
    false_authority_rate: mean(perCase.map((c) => c.false_authority_rate)),
  };
  return {
    cases: perCase,
    metrics,
    gate: decideClaimPromotionGate(metrics, options),
  };
}

// COORD-343: Temporal-validity benchmark cases test the safety contract around
// stale/superseded/conflicted memory. They are separate from recall@k because a
// high-recall system can still be unsafe if it emits old knowledge as an active
// constraint. Each case builds the normal context pack and scores:
//   - active_constraint_safety: no stale/superseded/conflicted ids appear in
//     active sections, and expected current ids do appear there.
//   - warning_coverage: every expected stale/history/conflict warning appears
//     in its mandatory section.
//   - current_authority_preference: current authoritative records appear active
//     while old/invalid records do not, even if they share stronger words with
//     the query.
function scoreTemporalValidityCase(testCase) {
  const pack = contextPack.buildPack(testCase.synthesis, {
    ticket: testCase.ticket,
    scope: testCase.scope || "",
    touchedFiles: testCase.touched_files || [],
    requirements: testCase.requirements || [],
    limit: testCase.limit || 10,
  });
  const expectations = testCase.expectations || {};
  const activeIds = flattenSectionIds(pack, activeSectionNames(pack));
  const activeSet = new Set(activeIds);
  const activeInclude = expectations.active_include || [];
  const activeExclude = expectations.active_exclude || [];
  const missingActive = activeInclude.filter((id) => !activeSet.has(id));
  const activeViolations = activeExclude.filter((id) => activeSet.has(id));

  const warningSections = expectations.warning_sections || {};
  let warningExpected = 0;
  let warningFound = 0;
  for (const [section, ids] of Object.entries(warningSections)) {
    const sectionIds = flattenSectionIds(pack, [section]);
    warningExpected += ids.length;
    warningFound += ids.filter((id) => sectionIds.includes(id)).length;
  }

  const current = expectations.current_authoritative || activeInclude;
  const invalid = expectations.old_or_invalid || activeExclude;
  const currentAuthorityPreference =
    fraction(activeIds, current) === 1 && invalid.every((id) => !activeSet.has(id)) ? 1 : 0;

  return {
    id: testCase.id,
    active_constraint_safety: missingActive.length === 0 && activeViolations.length === 0 ? 1 : 0,
    warning_coverage: warningExpected ? warningFound / warningExpected : 1,
    current_authority_preference: currentAuthorityPreference,
    missing_active: missingActive,
    active_violations: activeViolations,
    pack_summary: pack.summary,
  };
}

function evaluateTemporalValidity(benchmark) {
  const cases = benchmark.temporal_validity_cases || [];
  const perCase = cases.map(scoreTemporalValidityCase);
  return {
    cases: perCase,
    metrics: {
      temporal_cases: perCase.length,
      active_constraint_safety_rate: mean(perCase.map((c) => c.active_constraint_safety)),
      warning_coverage: mean(perCase.map((c) => c.warning_coverage)),
      current_authority_preference_rate: mean(perCase.map((c) => c.current_authority_preference)),
    },
  };
}

// Run the full comparison: baseline vs semantic + the gate verdict.
function evaluate(options = {}) {
  const benchmarkPath = options.benchmarkPath || DEFAULT_BENCHMARK_PATH;
  const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));

  // Ensure the derived decisions.ndjson exists (it is gitignored + rebuildable),
  // so the harness measures against current repo history without a committed
  // artifact — mirroring recall.test.js.
  if (!options.skipRebuild) {
    // COORD-300: rebuild into the governed, sandboxable MEMORY_DIR (via recall's
    // shared resolver) so a redirected __testing.paths.MEMORY_DIR writes the
    // derived corpus to an os.tmpdir() sandbox instead of the live coord/memory
    // tree. The benchmark above stays a LIVE read (the committed ground truth).
    extractor.rebuild({ outputPath: options.decisionsPath || recall.defaultDecisionsPath() });
  }

  const baseline = runConfig(benchmark, {}, options);
  const semanticOptions = buildSemanticOptions(options);
  const semantic = runConfig(benchmark, semanticOptions, options);
  const gate = decideGate(baseline, semantic, options);
  const temporalValidity = evaluateTemporalValidity(benchmark);
  const claimPromotion = evaluateClaimPromotion(benchmark, options);

  return {
    benchmark_cases: benchmark.cases.length,
    top_k: Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K,
    baseline: baseline.metrics,
    semantic: semantic.metrics,
    baseline_per_case: baseline.per_case,
    semantic_per_case: semantic.per_case,
    temporal_validity: temporalValidity.metrics,
    temporal_validity_per_case: temporalValidity.cases,
    claim_promotion: claimPromotion.metrics,
    claim_promotion_per_case: claimPromotion.cases,
    claim_promotion_gate: claimPromotion.gate,
    gate,
  };
}

function formatReport(report) {
  const fmt = (n) => (typeof n === "number" ? n.toFixed(4) : String(n));
  const rows = [
    ["metric", "baseline", "semantic"],
    ["recall_at_k", fmt(report.baseline.recall_at_k), fmt(report.semantic.recall_at_k)],
    [
      "citation_precision",
      fmt(report.baseline.citation_precision),
      fmt(report.semantic.citation_precision),
    ],
    [
      "answer_groundedness",
      fmt(report.baseline.answer_groundedness),
      fmt(report.semantic.answer_groundedness),
    ],
    [
      "stale_answer_rate",
      fmt(report.baseline.stale_answer_rate),
      fmt(report.semantic.stale_answer_rate),
    ],
    [
      "latency_ms_avg",
      fmt(report.baseline.latency_ms_avg),
      fmt(report.semantic.latency_ms_avg),
    ],
  ];
  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
  const line = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const out = [
    `Memory Phase-3 eval — ${report.benchmark_cases} cases, top_k=${report.top_k}`,
    line(rows[0]),
    rows
      .slice(1)
      .map((r) => line(r))
      .join("\n"),
    "",
    `GATE: semantic_better=${report.gate.semantic_better} enable_by_default=${report.gate.enable_by_default}`,
    `  ${report.gate.rationale}`,
  ];
  if (report.temporal_validity && report.temporal_validity.temporal_cases > 0) {
    out.push(
      "",
      `Temporal validity — ${report.temporal_validity.temporal_cases} case(s)`,
      `  active_constraint_safety_rate=${fmt(report.temporal_validity.active_constraint_safety_rate)}`,
      `  warning_coverage=${fmt(report.temporal_validity.warning_coverage)}`,
      `  current_authority_preference_rate=${fmt(report.temporal_validity.current_authority_preference_rate)}`
    );
  }
  if (report.claim_promotion && report.claim_promotion.claim_promotion_cases > 0) {
    out.push(
      "",
      `Claim promotion precision — ${report.claim_promotion.claim_promotion_cases} case(s)`,
      `  proposed_claim_precision=${fmt(report.claim_promotion.proposed_claim_precision)}`,
      `  promoted_claim_precision=${fmt(report.claim_promotion.promoted_claim_precision)}`,
      `  auto_reject_accuracy=${fmt(report.claim_promotion.auto_reject_accuracy)}`,
      `  reviewer_load_budget_rate=${fmt(report.claim_promotion.reviewer_load_budget_rate)}`,
      `  conflict_detection=${fmt(report.claim_promotion.conflict_detection)}`,
      `  groundedness=${fmt(report.claim_promotion.groundedness)}`,
      `  false_authority_rate=${fmt(report.claim_promotion.false_authority_rate)}`,
      `CLAIM GATE: broad_extractor_rollout_allowed=${report.claim_promotion_gate.broad_extractor_rollout_allowed}`,
      `  ${report.claim_promotion_gate.rationale}`
    );
  }
  return out.join("\n");
}

module.exports = {
  DEFAULT_TOP_K,
  sourceKey,
  expectedKey,
  scoreCase,
  mean,
  runConfig,
  buildSemanticOptions,
  decideGate,
  scoreTemporalValidityCase,
  evaluateTemporalValidity,
  scoreClaimPromotionCase,
  evaluateClaimPromotion,
  decideClaimPromotionGate,
  evaluate,
  formatReport,
  DEFAULT_BENCHMARK_PATH,
  DEFAULT_DECISIONS_PATH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const report = evaluate({});
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  // Non-zero exit is NOT used to fail CI — "semantic not better" is an acceptable
  // honest outcome, not a build failure. The exit code simply reports the gate
  // verdict for scripting (0 = semantic better, 10 = baseline stands).
  process.exitCode = report.gate.semantic_better ? 0 : 10;
}
