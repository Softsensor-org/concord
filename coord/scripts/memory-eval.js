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

// Run the full comparison: baseline vs semantic + the gate verdict.
function evaluate(options = {}) {
  const benchmarkPath = options.benchmarkPath || DEFAULT_BENCHMARK_PATH;
  const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));

  // Ensure the derived decisions.ndjson exists (it is gitignored + rebuildable),
  // so the harness measures against current repo history without a committed
  // artifact — mirroring recall.test.js.
  if (!options.skipRebuild) {
    extractor.rebuild({ outputPath: options.decisionsPath || DEFAULT_DECISIONS_PATH });
  }

  const baseline = runConfig(benchmark, {}, options);
  const semanticOptions = buildSemanticOptions(options);
  const semantic = runConfig(benchmark, semanticOptions, options);
  const gate = decideGate(baseline, semantic, options);

  return {
    benchmark_cases: benchmark.cases.length,
    top_k: Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K,
    baseline: baseline.metrics,
    semantic: semantic.metrics,
    baseline_per_case: baseline.per_case,
    semantic_per_case: semantic.per_case,
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
