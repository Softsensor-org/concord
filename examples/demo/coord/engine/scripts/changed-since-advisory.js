"use strict";

// COORD-907: ADVISORY pre-gate body, split out of test-runner.js (its production budget). Loaded
// lazily by test-runner.js only under --changed-since. Read-only: it writes no baseline, report or
// run manifest, records no gate evidence and exits 0 once measured (2 on a usage or environment
// error). Test-runner helpers arrive through `helpers` so this module carries no runner state.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function toPosix(rel) { return rel.split(path.sep).join("/"); }

// COORD-907: ADVISORY pre-gate. Runs the suites the engine selector picks for the change since
// <ref> under native coverage, then classifies that partial measurement against the measured
// whole-suite baseline. Read-only: it writes no baseline, report or run manifest, records no
// gate evidence and exits 0 once measured (2 on a usage or environment error). The engine
// modules load here only, so the default runner path keeps its original requires.
function runChangedSinceAdvisory(inventory, opts, out, err, nodeVersion, helpers) {
  const { supportsNativeCoverageVersion, buildChildEnv, ENGINE_COVERAGE_ARGS, parseTapSummary, coverageBaselinePathForNode, assertCoverageBaselineProvenance } = helpers;
  if (!supportsNativeCoverageVersion(nodeVersion)) {
    err.write(`test-runner: advisory --changed-since supports Node 22.x and 24.x; found ${nodeVersion}\n`);
    return 2;
  }
  const root = inventory.workspace_root;
  const contentRel = toPosix(path.relative(root, inventory.content_root));
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${opts.changedSince}^{commit}`], { cwd: root, encoding: "utf8" }).status !== 0) {
    err.write(`test-runner: advisory --changed-since: "${opts.changedSince}" is not a commit\n`);
    return 2;
  }
  const load = (rel) => require(require("../../paths.js").resolveEngineModule(inventory.content_root, rel));
  const selector = load("scripts/affected-selector.js");
  const decision = selector.selectAffected({ root, base: opts.changedSince });
  // Impact set: the changed suites plus the suites that directly import a changed production module
  // (one hop over the selector's own import graph). The selector's transitive reach widens through
  // unresolved dynamic loads (COORD-953) to nearly the whole tree, so that wider set is counted,
  // not run; the whole-suite gate still covers it.
  const graph = load("scripts/affected-graph.js").buildGraph({ root });
  const changedPaths = selector.changedPaths(root, opts.changedSince).map((c) => c.path);
  const impact = new Set(changedPaths.filter((rel) => selector.isSuite(rel) && fs.existsSync(path.join(root, rel))));
  // The reverse map includes mentions. The graph gives every importing file a load-edge set,
  // which may be empty for a suite that only mentions a changed JavaScript module.
  for (const rel of changedPaths.filter((rel) => !selector.isSuite(rel) && /\.(c|m)?js$/.test(rel))) {
    for (const importer of graph.reverse.get(rel) || []) {
      if (selector.isSuite(importer) && graph.loadEdges.get(importer).has(rel)) impact.add(importer);
    }
  }
  const suites = [...impact].sort();
  const plan = {
    advisory: true, gate_evidence: false, baseline_written: false, base: opts.changedSince,
    selector_decision: decision.decision, fallback_reasons: decision.fallback_reasons.map((f) => f.code),
    selected_suites: suites, selector_suites_not_run: decision.selected.filter((entry) => !impact.has(entry.suite)).length, tests: { pass: 0, fail: 0 },
    candidates: [], text_changed: [], unchanged_arms: [], unobserved_files: [], inherited_uncovered: null,
  };
  if (suites.length === 0) return emitChangedSinceAdvisory(plan, out, opts);
  const engineCoverage = load("scripts/engine-coverage.js");
  const coverageSourceProvider = load("scripts/coverage-source-provider.js");
  const coverageAggregator = load("scripts/coverage-aggregate.js");
  const diskError = coverageAggregator.coverageSpaceError([os.tmpdir()]);
  if (diskError) {
    err.write(`test-runner: advisory --changed-since unavailable: ${diskError}\n`);
    return 2;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "concord-advisory-"));
  const rawDirectory = path.join(scratch, "v8");
  const lcovPath = path.join(scratch, "coverage.info");
  const tapPath = path.join(scratch, "tests.tap");
  try {
    const { env } = buildChildEnv(inventory.content_root, scratch);
    delete env.COORD_COVERAGE_BASELINE_CAPTURE;
    fs.mkdirSync(rawDirectory);
    spawnSync(process.execPath, ["--test", ...ENGINE_COVERAGE_ARGS, "--test-concurrency=1",
      "--test-reporter=tap", `--test-reporter-destination=${tapPath}`,
      "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`, ...suites],
    { cwd: root, env: { ...env, NODE_V8_COVERAGE: rawDirectory }, stdio: "ignore" });
    const counts = parseTapSummary(fs.readFileSync(tapPath, "utf8")).counts;
    plan.tests = { pass: counts.pass, fail: counts.fail };
    const rawModules = [{ name: "changed-since", rawDirectory, lcov: fs.readFileSync(lcovPath, "utf8") }];
    const witnessFiles = [...engineCoverage.fingerprintProductionSources(inventory.content_root).keys()]
      .map((rel) => toPosix(path.relative(root, path.join(inventory.content_root, rel))));
    const aggregate = coverageAggregator.aggregateRawCoverage(rawModules, root, witnessFiles);
    const measurement = engineCoverage.measure(inventory.content_root, [aggregate.report], { rangeWitnesses: aggregate.witnesses });
    // Read only: the measured baseline is compared against and never written here.
    const baselinePath = coverageBaselinePathForNode(inventory.content_root);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    assertCoverageBaselineProvenance(baseline, baselinePath);
    const sourceBaseline = engineCoverage.fingerprintProductionSources(inventory.content_root);
    const verdict = engineCoverage.ratchet(measurement, baseline, {
      sourceProvider: (file, sourceCommit) => coverageSourceProvider.readBaselineCoverageSources({
        workspaceRoot: root, contentRoot: inventory.content_root, sourceCommit, file,
        expectedCurrentHash: sourceBaseline.get(file),
      }),
    });
    // JavaScript only, with a raised buffer: a large changed data file would otherwise overflow the
    // default spawnSync stdout limit and silently drop the hunks that follow it.
    const diff = spawnSync("git", ["diff", "--unified=0", "--no-color", opts.changedSince, "--", `:(glob)${contentRel}/**/*.js`],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout || "";
    Object.assign(plan, engineCoverage.advisoryReport(verdict, measurement, engineCoverage.changedLinesFromDiff(diff, `${contentRel}/`)));
  } catch (e) {
    err.write(`test-runner: advisory --changed-since unavailable: ${e.message}\n`);
    return 2;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return emitChangedSinceAdvisory(plan, out, opts);
}

function emitChangedSinceAdvisory(plan, out, opts) {
  if (opts.json) {
    out.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }
  const label = "ADVISORY coverage pre-gate: not gate evidence; no baseline written; never fails the gate";
  out.write(`${label}\n`);
  out.write(`  base: ${plan.base}; selector: ${plan.selector_decision}${plan.fallback_reasons.length ? ` (fallbacks: ${plan.fallback_reasons.join(", ")}; shown set is the direct-impact selection)` : ""}\n`);
  out.write(`  suites (${plan.selected_suites.length}): ${plan.selected_suites.join(", ") || "none touch the change"}\n`);
  if (plan.selector_suites_not_run > 0) out.write(`  selector-widened suites not run here (${plan.selector_suites_not_run}): the whole-suite gate covers them\n`);
  if (plan.selected_suites.length > 0) out.write(`  suite results: pass=${plan.tests.pass} fail=${plan.tests.fail}\n`);
  const show = (title, list) => {
    out.write(`  ${title} (${list.length})\n`);
    for (const f of list.slice(0, 20)) out.write(`    ${f.file}:${f.line} ${f.message}\n`);
  };
  if (plan.candidates) {
    show("text-changed lines: likely new_uncovered, need real tests", plan.text_changed);
    show("unchanged finer arms: likely new_uncovered, baselined per the ruling", plan.unchanged_arms);
    out.write(`  not measured (production files no selected suite loads): ${plan.unobserved_files.length}\n`);
  }
  return 0;
}

module.exports = { runChangedSinceAdvisory, emitChangedSinceAdvisory };
