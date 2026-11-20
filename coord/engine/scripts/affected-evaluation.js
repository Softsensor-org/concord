#!/usr/bin/env node
"use strict";

// COORD-924/941: the fault suite, activation evaluation and CLI for
// affected-test selection (ADR 0021). Eligible T0/T1 selection evidence is
// active through the governed landing verifier; fallbacks stay full.
//
//   node coord/engine/scripts/affected-evaluation.js select --base <ref> [--head <ref>]
//   node coord/engine/scripts/affected-evaluation.js shadow --base <ref> --head <ref> --full-report <file> [--selected-report <file> | --run-selected]
//   node coord/engine/scripts/affected-evaluation.js faults
//   node coord/engine/scripts/affected-evaluation.js evaluate
//   node coord/engine/scripts/affected-evaluation.js state
//   node coord/engine/scripts/affected-evaluation.js landing-policy --base <ref> [--head <ref>]
//   node coord/engine/scripts/affected-evaluation.js run-selected --base <ref> [--head <ref>] --out <dir>
//   node coord/engine/scripts/affected-evaluation.js verify-landing --manifest <file> --base <ref> [--head <ref>]
//   node coord/engine/scripts/affected-evaluation.js compare-full --base <ref> [--head <ref>] --full-report <file> [--inventory <file>]
// Common: --root <workspace> (default: this checkout), --ledger <dir> (default
// coord/artifacts/affected-selection), --json.
//
// Evaluation computes post-activation review criteria (policy review_criteria)
// over recorded comparisons and the fault suite, journals the result and writes
// the evaluation report. Evaluation never activates or rolls back selection.
// Misses found here exit non-zero; they are recorded, and their categories
// suspended, in the governed state with `gov selection suspend|nightly`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const selector = require("./affected-selector.js");
const shadow = require("./affected-shadow.js");
const landing = require("./affected-landing.js");
const governedState = require("./affected-state.js");

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");
const FAULTS = path.join(__dirname, "__fixtures__", "affected-selection-faults.js");
const GIT_ID = ["-c", "user.email=selector@example.invalid", "-c", "user.name=selector", "-c", "commit.gpgsign=false"];

function git(cwd, args) {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

function applyFault(root, fault) {
  const abs = (rel) => path.join(root, rel);
  if (fault.write) writeFiles(root, { [fault.write[0]]: fault.write[1] });
  if (fault.replace) {
    const [rel, from, to] = fault.replace;
    const text = fs.readFileSync(abs(rel), "utf8");
    if (!text.includes(from)) throw new Error(`seeded fault: ${rel} does not contain ${from}`);
    fs.writeFileSync(abs(rel), text.replace(from, to));
  }
  if (fault.rename) fs.renameSync(abs(fault.rename[0]), abs(fault.rename[1]));
  if (fault.delete) fs.rmSync(abs(fault.delete));
}

// Failing tests of one node --test run over `suites`, keyed by the suite file
// their title names ("<file key>: ...").
function runSuites(root, suites) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...suites], { cwd: root, encoding: "utf8", env });
  const failing = [...String(r.stdout).matchAll(/^not ok \d+ - ([a-z]+): (.*)$/gm)].map((m) => ({ key: m[1], title: `${m[1]}: ${m[2]}` }));
  return failing.map((f) => ({ ...f, suite: suites.find((s) => path.posix.basename(s) === `${f.key}.test.js`) || null }));
}

function seededOutcome(selection, failures) {
  if (selection.decision === "full") return { outcome: "fallback", missed: [] };
  const chosen = new Set(selection.selected.map((s) => s.suite));
  const missed = failures.filter((f) => !chosen.has(f.suite)).map((f) => f.title);
  return { outcome: missed.length ? "missed" : "selected", missed };
}

// A committed temp workspace holding `files`.
function initRepo(root, files) {
  writeFiles(root, files);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function runSeededFault(fixtures, fault, tmpRoot) {
  const root = fs.mkdtempSync(path.join(tmpRoot, `coord924-${fault.id}-`));
  try {
    initRepo(root, fixtures.repo);
    applyFault(root, fault.fault);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", fault.id]);
    const selection = selector.selectAffected({ root, base: "HEAD~1", head: "HEAD", policy: fixtures.policy, registry: fixtures.registry, shimRegistry: fixtures.shimRegistry });
    const failures = runSuites(root, git(root, ["ls-files"]).split("\n").filter(selector.isSuite));
    const { outcome, missed } = seededOutcome(selection, failures);
    const reasons = selection.fallback_reasons.map((f) => f.code);
    const expected = outcome === fault.expect && (!fault.reason || reasons.includes(fault.reason));
    return {
      id: fault.id, kind: "seeded", category: fault.category, outcome, expected: fault.expect, ok: outcome !== "missed" && expected,
      fault_effective: failures.length > 0, failures: failures.map((f) => f.title), missed, fallback_reasons: reasons,
      selected: selection.selected.map((s) => s.suite), categories: selection.categories,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runHistoricalCase(root, item) {
  const selection = selector.selectAffected({ root, base: "HEAD", head: null, changes: item.changes });
  const chosen = new Set(selection.selected.map((s) => s.suite));
  const present = item.catchers.filter((c) => fs.existsSync(path.join(root, c)));
  const absent = item.catchers.filter((c) => !present.includes(c));
  const uncaught = present.filter((c) => !chosen.has(c));
  const outcome = selection.decision === "full" ? "fallback" : uncaught.length ? "missed" : "selected";
  return {
    id: item.id, kind: "historical", source: item.source, outcome, ok: outcome !== "missed",
    catchers_selected: present.filter((c) => chosen.has(c)), catchers_not_shipped: absent, missed: outcome === "missed" ? uncaught : [],
    fallback_reasons: selection.fallback_reasons.map((f) => f.code), categories: selection.categories,
  };
}

function runFaultSuite({ root = WORKSPACE_ROOT, fixtures = require(FAULTS), tmpRoot = os.tmpdir() } = {}) {
  return [
    ...fixtures.seeded.map((fault) => runSeededFault(fixtures, fault, tmpRoot)),
    ...fixtures.historical.map((item) => runHistoricalCase(root, item)),
  ];
}

// Runs count with the current selector digest after the last governed resolution.
function countedRuns(runs, resolutions, digest) {
  const resolved = (resolutions || []).map((r) => r.at).sort().pop() || "";
  return runs.filter((r) => r.selector_digest === digest && r.at > resolved);
}

function coverageGaps(required, seen) { return required.filter((x) => !seen.has(x)); }

// The pre-approved criteria (acceptance item 6), each with its evidence.
function computeCriteria({ policy, runs, faults }) {
  const c = policy.review_criteria;
  const missed = runs.reduce((n, r) => n + r.missed.length, 0);
  const badFaults = faults.filter((f) => !f.ok);
  const gaps = (required, values) => coverageGaps(required, new Set(values));
  const categories = gaps(c.require_categories, runs.flatMap((r) => r.categories));
  const editions = gaps(c.require_editions, runs.map((r) => r.edition));
  const lanes = gaps(c.require_node_majors, runs.map((r) => r.node_major));
  return [
    { id: "min_shadow_runs", met: runs.length >= c.min_shadow_runs, detail: `${runs.length} of ${c.min_shadow_runs} counted shadow runs` },
    { id: "zero_missed_shadow_failures", met: missed <= c.max_missed_failures, detail: `${missed} missed failure(s) in counted shadow runs` },
    { id: "fault_suite", met: !c.require_fault_suite_pass || badFaults.length === 0, detail: `${faults.length - badFaults.length} of ${faults.length} seeded and historical faults selected or forced to fallback${badFaults.length ? `; failing: ${badFaults.map((f) => f.id).join(", ")}` : ""}` },
    { id: "change_categories", met: categories.length === 0, detail: categories.length ? `not yet covered: ${categories.join(", ")}` : "every change category covered" },
    { id: "editions", met: editions.length === 0, detail: editions.length ? `no shadow run on: ${editions.join(", ")}` : "both editions covered" },
    { id: "node_lanes", met: lanes.length === 0, detail: lanes.length ? `no shadow run on Node ${lanes.join(", ")}` : "both Node lanes covered" },
  ];
}

function renderReport({ state, criteria, faults, runs, digest, now }) {
  const rows = (list, cells) => list.map((item) => `| ${cells(item).join(" | ")} |`).join("\n");
  return [
    "# Affected-test selection: evaluation report",
    "",
    `Generated ${now} by coord/engine/scripts/affected-evaluation.js (COORD-924, ADR 0021). Selector digest: \`${digest}\`.`,
    "",
    `**Activation state: ${state}.** Activation needs these criteria met and a governed policy change with a human-admin ruling (COORD-936). T2 and always-enforced checks never reduce.`,
    "",
    "## Criteria",
    "",
    "| criterion | met | evidence |", "| --- | --- | --- |",
    rows(criteria, (c) => [c.id, c.met ? "yes" : "no", c.detail]),
    "",
    "## Fault suite",
    "",
    "| id | kind | outcome | detail |", "| --- | --- | --- | --- |",
    rows(faults, (f) => [f.id, f.kind, f.outcome, f.fallback_reasons.length ? f.fallback_reasons.join(", ") : (f.selected || f.catchers_selected || []).join(", ") || "no suite affected"]),
    "",
    `## Counted shadow runs (${runs.length})`,
    "",
    "| at | decision | tier | edition | node | missed | saved ms |", "| --- | --- | --- | --- | --- | --- | --- |",
    rows(runs, (r) => [r.at, r.decision, r.tier, r.edition, r.node_major, r.missed.length, Math.round(r.wall_time_saved_ms)]),
    "",
    "## Rollback",
    "",
    "Any missed failure, from `gov selection nightly` or recorded with `gov selection suspend`, suspends selection for its change categories in the governed board state at once (a journaled governance event). `gov selection resolve --category <c> --investigation <ref>` lifts a suspension only under a higher policy version with tightened criteria. A selector or policy change resets the counted runs and forces the full gate for its own landing.",
    "",
  ].join("\n");
}

function evaluateActivation({ ledgerDir, policy = selector.loadPolicy(), faults, state, digest = selector.selectorDigest(), now = new Date().toISOString() }) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const runs = countedRuns(fs.existsSync(path.join(ledgerDir, shadow.FILES.runs))
    ? fs.readFileSync(path.join(ledgerDir, shadow.FILES.runs), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [], state && state.resolutions, digest);
  const criteria = computeCriteria({ policy, runs, faults });
  const allMet = criteria.every((c) => c.met);
  const current = (state || shadow.readState(ledgerDir, policy)).state;
  const reason = allMet ? "every review criterion is met: review the evaluation report" : `unmet: ${criteria.filter((c) => !c.met).map((c) => c.id).join(", ")}`;
  shadow.transition(ledgerDir, { to: current, event: "evaluated", reason, detail: { criteria }, extra: { selector_digest: digest, criteria, counted_runs: runs.length, review_due: allMet }, policy, now });
  fs.writeFileSync(path.join(ledgerDir, shadow.FILES.report), renderReport({ state: current, criteria, faults, runs, digest, now }));
  return { state: current, event: "evaluated", criteria, all_met: allMet, review_due: allMet };
}

// Run the selected suites through the authoritative runner and return its report.
function runSelectedSuites(root, suites, tmpRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "coord924-selected-"));
  const report = path.join(dir, "selected-report.json");
  const runner = path.join(root, "coord", "scripts", "test-runner.js");
  spawnSync(process.execPath, [runner, ...suites.flatMap((s) => ["--file", s]), "--report", report], { cwd: root, stdio: "ignore" });
  return { report: JSON.parse(fs.readFileSync(report, "utf8")), path: report };
}

// --- CLI ---------------------------------------------------------------------

function parseCli(argv) {
  const opts = { json: false, runSelected: false };
  const valued = { "--base": "base", "--head": "head", "--root": "root", "--ledger": "ledger", "--full-report": "fullReport", "--selected-report": "selectedReport", "--out": "out", "--manifest": "manifest", "--inventory": "inventory" };
  for (let i = 0; i < argv.length; i += 1) {
    if (valued[argv[i]]) opts[valued[argv[i]]] = argv[++i];
    else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--run-selected") opts.runSelected = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return opts;
}

function needBase(opts) {
  if (!opts.base) throw new Error("--base <ref> is required");
  return opts.base;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function shadowCommand(opts, ctx) {
  if (!opts.fullReport) throw new Error("--full-report <authoritative full-gate report> is required");
  const full = readJson(opts.fullReport);
  const universe = (full.inventory || []).flatMap((m) => m.files);
  const selection = selector.selectAffected({ root: ctx.root, base: needBase(opts), head: opts.head || "HEAD", universe: universe.length ? universe : null });
  let selected = opts.selectedReport ? { report: readJson(opts.selectedReport), path: opts.selectedReport } : null;
  const suites = selection.selected.map((s) => s.suite);
  // An empty selection runs nothing, and nothing can fail in it.
  if (!selected && selection.decision === "selected" && suites.length === 0) selected = { report: { result: "pass", results: [] }, path: null };
  if (!selected && opts.runSelected && selection.decision === "selected") selected = ctx.runSelected(ctx.root, suites);
  const result = shadow.recordShadowRun({ root: ctx.root, ledgerDir: ctx.ledger, selection, fullReport: full, fullReportPath: opts.fullReport, selectedReport: selected && selected.report, selectedReportPath: selected && selected.path, policy: ctx.policy });
  return { ...result.line, manifest: result.file };
}

const COMMANDS = {
  select: (opts, ctx) => selector.selectAffected({ root: ctx.root, base: needBase(opts), head: opts.head || null }),
  shadow: shadowCommand,
  faults: (opts, ctx) => ctx.runFaults({ root: ctx.root }),
  evaluate: (opts, ctx) => evaluateActivation({ ledgerDir: ctx.ledger, policy: ctx.policy, faults: ctx.runFaults({ root: ctx.root }), state: governedState.readSelectionState({ root: ctx.root, policy: ctx.policy }) }),
  state: (opts, ctx) => governedState.readSelectionState({ root: ctx.root, policy: ctx.policy }),
  "landing-policy": (opts, ctx) => landing.landingGateFor({ root: ctx.root, base: needBase(opts), head: opts.head || null, policy: ctx.policy }).gate,
  "run-selected": (opts, ctx) => {
    if (!opts.out) throw new Error("--out <dir> is required");
    return ctx.runLanding({ root: ctx.root, base: needBase(opts), head: opts.head || "HEAD", outDir: path.resolve(opts.out), policy: ctx.policy });
  },
  "verify-landing": (opts, ctx) => {
    if (!opts.manifest) throw new Error("--manifest <selection run manifest> is required");
    return landing.verifyLandingEvidence({ root: ctx.root, manifest: readJson(opts.manifest), base: needBase(opts), head: opts.head || "HEAD", policy: ctx.policy });
  },
  "compare-full": (opts, ctx) => {
    if (!opts.fullReport) throw new Error("--full-report <authoritative full-gate report> is required");
    return landing.compareFullRun({ root: ctx.root, base: needBase(opts), head: opts.head || "HEAD", fullReport: readJson(opts.fullReport), ledgerDir: ctx.ledger, inventoryFile: opts.inventory || null, policy: ctx.policy });
  },
};

const MISS_HINT = "; record it in the governed state: coord/scripts/gov selection suspend --category <c> --ref <run>";

function summary(command, result) {
  if (command === "select") return `affected-selection: ${result.decision} tier=${result.tier} selected=${result.selected.length} omitted=${result.omitted.length}${result.fallback_reasons.length ? ` fallback=${[...new Set(result.fallback_reasons.map((f) => f.code))].join(",")}` : ""}`;
  if (command === "run-selected") return `affected-selection: selected-suite run exit=${result.lane.exit_code} suites=${result.gate.suites.length} manifest=${result.file}`;
  if (command === "verify-landing") return result.ok ? `affected-selection: selected-suite evidence accepted tier=${result.tier} suites=${result.suites.length}` : landing.formatLandingRefusal(result);
  if (command === "compare-full") return `affected-selection: compare-full gate=${result.gate} failures=${result.full_failures.length} missed=${result.missed.length}${result.missed.length ? MISS_HINT : ""}`;
  if (command === "faults") return `affected-selection: fault suite ${result.filter((f) => f.ok).length}/${result.length} ok`;
  if (command === "evaluate") return `affected-selection: state=${result.state} (${result.event}) review criteria met=${result.criteria.filter((c) => c.met).length}/${result.criteria.length}${result.review_due ? " review due" : ""}`;
  if (command === "landing-policy") return `affected-selection: landing gate=${result.gate}: ${result.reason}`;
  if (command === "state") return `affected-selection: state=${result.state} (${result.source})`;
  return `affected-selection: shadow ${result.decision} missed=${result.missed.length} saved_ms=${Math.round(result.wall_time_saved_ms)} manifest=${result.manifest}${result.missed.length ? MISS_HINT : ""}`;
}

function main(argv, { out = process.stdout, err = process.stderr, runFaults = runFaultSuite, runSelected = runSelectedSuites, runLanding = landing.runSelectedForLanding, policy = selector.loadPolicy() } = {}) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) {
    err.write(`affected-selection: unknown command ${command} (${Object.keys(COMMANDS).join(", ")})\n`);
    return 2;
  }
  try {
    const opts = parseCli(rest);
    const root = path.resolve(opts.root || WORKSPACE_ROOT);
    const ledger = path.resolve(root, opts.ledger || shadow.DEFAULT_LEDGER_REL);
    const result = COMMANDS[command](opts, { root, ledger, runFaults, runSelected, runLanding, policy });
    out.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${summary(command, result)}\n`);
    const failed = (command === "faults" && result.some((f) => !f.ok)) || (command === "verify-landing" && !result.ok) ||
      (command === "run-selected" && result.lane.exit_code !== 0) || ((command === "compare-full" || command === "shadow") && result.missed.length > 0);
    return failed ? 1 : 0;
  } catch (e) {
    err.write(`affected-selection: ${e.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  WORKSPACE_ROOT, FAULTS,
  git, initRepo, applyFault, runSuites, seededOutcome, runSeededFault, runHistoricalCase, runFaultSuite,
  countedRuns, computeCriteria, renderReport, evaluateActivation, runSelectedSuites, parseCli, main,
};
