"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

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

const { sandboxProcessRuntimeLocks } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));

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

test("evaluate honors a positive topK override and falls back for a nonpositive value", () => {
  const selected = evalMod.evaluate({ benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true, topK: 2 });
  assert.equal(selected.top_k, 2);

  const fallback = evalMod.evaluate({ benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true, topK: 0 });
  assert.equal(fallback.top_k, 5);
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

// --- COORD-821: the CLI entrypoint ---------------------------------------------
// The CLI tail is an injectable main(args, io) (the COORD-807 shape): the real CLI
// injects evaluate with {} options; these tests inject the fixture benchmark (no
// rebuild) or a fixed report, so the output and the gate-verdict exit code are
// pinned without the live tree.
const fs = require("node:fs");
const os = require("node:os");

function runEvalCli(argv, io) {
  const chunks = [];
  const code = evalMod.main(argv, { stdout: { write: (chunk) => chunks.push(chunk) }, ...io });
  return { code, out: chunks.join("") };
}

let fixtureReport = null;
function fixtureEvalReport() {
  fixtureReport = fixtureReport || evalMod.evaluate({ benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true });
  return fixtureReport;
}

test("COORD-821: memory-eval main runs the injected evaluator and prints the JSON report", () => {
  const seen = [];
  const options = { benchmarkPath: FIXTURE_BENCHMARK, skipRebuild: true };
  const { code, out } = runEvalCli(["--json"], {
    evaluate: (opts) => {
      seen.push(opts);
      return evalMod.evaluate(opts);
    },
    options,
  });
  assert.deepEqual(seen, [options], "main hands io.options to the evaluator unchanged");
  const report = JSON.parse(out);
  assert.equal(report.benchmark_cases, 2);
  assert.equal(typeof report.gate.semantic_better, "boolean");
  assert.equal(code, report.gate.semantic_better ? 0 : 10);
});

test("COORD-821: memory-eval main maps the gate verdict to exit 0 (semantic better) or 10 (baseline stands)", () => {
  const base = fixtureEvalReport();
  for (const [semanticBetter, expectedCode] of [[true, 0], [false, 10]]) {
    const report = { ...base, gate: { ...base.gate, semantic_better: semanticBetter, enable_by_default: semanticBetter } };
    const text = runEvalCli([], { evaluate: () => report, options: {} });
    assert.equal(text.code, expectedCode);
    assert.equal(text.out, `${evalMod.formatReport(report)}\n`);
    assert.match(text.out, new RegExp(`GATE: semantic_better=${semanticBetter} `));
    const json = runEvalCli(["--json"], { evaluate: () => report, options: {} });
    assert.equal(json.code, expectedCode);
    assert.equal(json.out, `${JSON.stringify(report, null, 2)}\n`);
  }
});

// Spawn the real memory-eval CLI with the COORD-300 MEMORY_DIR redirect applied
// by a -r preload, so the rebuild of the derived decisions index lands in a temp
// dir, never the live coord/memory tree. With emptyHistory the preload also points
// the decision extractor and every journal-provenance read (recall, memory-graph)
// at an empty plans dir and a missing journal: the state of a fresh adopter install
// or a public release cut, which ship no decision history (COORD-846). The
// benchmark, board, ADRs and memory-graph's freshness hash of the journal file stay
// live READS either way. The overrides work because memory-eval, recall and
// memory-graph call through the shared extractor module object.
function spawnSandboxedMemoryEval({ emptyHistory }) {
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord821-memory-eval-spawn-"));
  const memoryDir = path.join(dir, "memory");
  const preload = path.join(dir, "redirect-memory.js");
  const contextPath = resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js");
  const pathsModulePath = path.join(COORD_ROOT_DIR, "paths.js");
  let source =
    "const context = require(" + JSON.stringify(contextPath) + ");\n" +
    "const { resolveEngineModule } = require(" + JSON.stringify(pathsModulePath) + ");\n" +
    "const { createGovernanceTestContextHarness } = require(resolveEngineModule(context.COORD_DIR, \"scripts/governance-test-context.js\"));\n" +
    "createGovernanceTestContextHarness({ state: context.state, defaultPaths: context.DEFAULT_PATHS })" +
      ".installWorkerContext({ MEMORY_DIR: " + JSON.stringify(memoryDir) + " });\n";
  if (emptyHistory) {
    const plansDir = path.join(dir, "empty-plans");
    fs.mkdirSync(plansDir);
    const empty = { plansDir, journalPath: path.join(dir, "no-journal.ndjson") };
    source +=
      "const extractor = require(" + JSON.stringify(path.join(__dirname, "decision-extractor.js")) + ");\n" +
      "const empty = " + JSON.stringify(empty) + ";\n" +
      "for (const name of [\"rebuild\", \"extractDecisions\"]) {\n" +
      "  const original = extractor[name];\n" +
      "  extractor[name] = (options = {}) => original({ ...options, ...empty });\n" +
      "}\n" +
      "const indexJournalProvenance = extractor.indexJournalProvenance;\n" +
      "extractor.indexJournalProvenance = () => indexJournalProvenance(empty.journalPath);\n";
  }
  fs.writeFileSync(preload, source);
  const result = spawnSync(process.execPath, ["-r", preload, path.join(__dirname, "memory-eval.js"), "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  return { dir, decisionsPath: path.join(memoryDir, "decisions.ndjson"), result };
}

test("COORD-821: the memory-eval script run as a process reports the live gate verdict as its exit code", () => {
  const { dir, decisionsPath, result } = spawnSandboxedMemoryEval({ emptyHistory: false });
  try {
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.ok(report.benchmark_cases >= 5);
    assert.equal(result.status, report.gate.semantic_better ? 0 : 10);
    // COORD-846: the sandbox holds exactly what the extractor derives from this
    // tree's live history. That is non-empty in the donor tree and legitimately
    // empty in a release cut, which ships no decision history; an absent file, a
    // stale copy or a write to the live tree all still fail.
    assert.ok(fs.existsSync(decisionsPath), "the rebuild wrote the sandbox");
    const extractor = require("./decision-extractor.js");
    const sandbox = fs.readFileSync(decisionsPath, "utf8");
    assert.equal(
      sandbox,
      extractor.serializeDecisions(extractor.extractDecisions()),
      "the sandbox matches a rebuild of the live decision history",
    );
    // Counted from the plans dir, not through the extractor, so an extractor that
    // wrongly yields no decisions over real plan records still fails here.
    const plansDir = extractor.DEFAULT_PLANS_DIR;
    const planRecords = fs.existsSync(plansDir)
      ? fs.readdirSync(plansDir).filter((name) => name.endsWith(".json")).length
      : 0;
    assert.equal(sandbox.length > 0, planRecords > 0, "the sandbox is non-empty exactly when plan records exist");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-846: the memory-eval script on an empty decision history writes an empty sandbox and still reports a verdict", () => {
  // A fresh install has no plan records, so the derived decisions index is a valid
  // empty corpus: the eval still measures baseline vs semantic over the committed
  // benchmark and reports the gate verdict as its exit code.
  const { dir, decisionsPath, result } = spawnSandboxedMemoryEval({ emptyHistory: true });
  try {
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.ok(report.benchmark_cases >= 5);
    assert.equal(typeof report.gate.semantic_better, "boolean");
    assert.equal(result.status, report.gate.semantic_better ? 0 : 10);
    assert.ok(fs.existsSync(decisionsPath), "the rebuild wrote the sandbox");
    assert.equal(fs.statSync(decisionsPath).size, 0, "an empty history rebuilds to an empty index");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
