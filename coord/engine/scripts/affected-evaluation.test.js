"use strict";

// COORD-924: fault-based evaluation, activation criteria and CLI contracts.
// The repository policy is now active under COORD-941; shadow behavior below
// is exercised with an explicit shadow-configured fixture, never by assuming
// the production policy remains in shadow.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ev = require("./affected-evaluation.js");
const sh = require("./affected-shadow.js");
const sel = require("./affected-selector.js");

const DIGEST = `sha256:${"d".repeat(64)}`;

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(fn) {
  const out = { text: "", write(c) { this.text += c; return true; } };
  const err = { text: "", write(c) { this.text += c; return true; } };
  return { status: fn(out, err), out: out.text, err: err.text };
}

const okFaults = [{ id: "S", kind: "seeded", ok: true, outcome: "selected", fallback_reasons: [], selected: ["a.test.js"] }];
const policy = sel.loadPolicy();
const shadowPolicy = { ...policy, initial_state: "shadow" };

function fullRuns(digest = DIGEST, at = "2026-11-07T00:00:00.000Z") {
  const cats = policy.review_criteria.require_categories;
  return Array.from({ length: policy.review_criteria.min_shadow_runs }, (_, i) => ({
    at: `${at.slice(0, 20)}${String(i).padStart(3, "0")}Z`, selector_digest: digest, decision: "selected", tier: "T1",
    categories: [cats[i % cats.length]], edition: i % 2 ? "Enterprise" : "Community", node_major: i % 4 < 2 ? 22 : 24,
    missed: [], wall_time_saved_ms: 1000,
  }));
}

function writeRuns(dir, runs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, sh.FILES.runs), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("COORD-924: every seeded fault and historical regression is selected or forced to fallback", () => {
  const results = ev.runFaultSuite();
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.id), [], JSON.stringify(results.filter((r) => !r.ok), null, 2));
  for (const r of results.filter((x) => x.kind === "seeded" && !["S09", "S13", "S14"].includes(x.id))) {
    assert.ok(r.fault_effective, `${r.id} must break at least one suite`);
  }
  assert.deepEqual(byId.S06.fallback_reasons.slice(0, 1), ["dynamic_dependency"]);
  assert.deepEqual(byId.S03.categories.includes("shim-registered-move"), true);
  assert.deepEqual([byId["H-COORD-893"].outcome, byId["H-COORD-893"].fallback_reasons[0]], ["fallback", "always_enforced_guard"]);
  assert.ok(byId["H-COORD-893"].catchers_selected.includes("coord/engine/scripts/missing-ticket-lock.test.js"), "the COORD-689 suite is also in the would-be selection");
  // COORD-953: widened, the unresolved-site fallback now also applies; coverage_baseline is still a reason (human-admin decision 2026-11-12)
  assert.deepEqual([byId["H-COORD-872-finer-arms"].outcome, byId["H-COORD-872-finer-arms"].fallback_reasons], ["fallback", ["coverage_baseline", "coverage_baseline"]]);
  assert.deepEqual([byId["H-COORD-872-finer-arms-code-only"].outcome, byId["H-COORD-872-finer-arms-code-only"].catchers_selected], ["selected", ["coord/engine/scripts/hooks/session-start.test.js"]]);
  assert.deepEqual(byId["H-COORD-916"].catchers_selected, ["coord/scripts/paths.test.js", "coord/engine/scripts/tmp-path-isolation.test.js"]);
  // Release cuts do not ship the donor-only release/ and create-concord/ suites.
  const shipped = ["release/suite-inventory.test.js", "create-concord/install-plan.test.js"].filter((f) => fs.existsSync(path.join(ev.WORKSPACE_ROOT, f)));
  assert.deepEqual([byId["H-COORD-902-890"].outcome, byId["H-COORD-902-890"].catchers_selected], ["fallback", shipped]);
});

test("COORD-924: fault outcomes: a selection that omits a failing suite is a miss", (t) => {
  const root = ev.initRepo(tmp(t, "coord924-outcome-"), {
    "coord/a.test.js": "require('node:test')('a: fails', () => { throw new Error('x'); });\n",
    "coord/b.test.js": "require('node:test')('b: passes', () => {});\n",
  });
  const failures = ev.runSuites(root, ["coord/a.test.js", "coord/b.test.js"]);
  assert.deepEqual(failures, [{ key: "a", title: "a: fails", suite: "coord/a.test.js" }]);
  assert.deepEqual(ev.seededOutcome({ decision: "selected", selected: [{ suite: "coord/b.test.js" }] }, failures), { outcome: "missed", missed: ["a: fails"] });
  assert.deepEqual(ev.seededOutcome({ decision: "full", selected: [] }, failures), { outcome: "fallback", missed: [] });
  assert.throws(() => ev.applyFault(root, { replace: ["coord/b.test.js", "absent text", "x"] }), /does not contain absent text/);
  fs.writeFileSync(path.join(root, "coord/c.test.js"), "require('node:test')('zz: fails without a file key', () => { throw new Error('x'); });\n");
  assert.deepEqual(ev.runSuites(root, ["coord/c.test.js"])[0].suite, null, "a title whose key names no suite maps to no file");
  assert.throws(() => ev.git(root, ["no-such-git-command"]), /git no-such-git-command/);
  const missedHistory = ev.runHistoricalCase(ev.WORKSPACE_ROOT, { id: "H", source: "s", changes: [{ status: "M", path: "coord/engine/scripts/hooks/session-start.js" }], catchers: ["coord/engine/scripts/sqlite-runtime.test.js", "release/not-shipped.test.js"] });
  // COORD-953: widened, the catcher is now selected through the unresolved-site readers (human-admin decision 2026-11-12), so nothing is missed
  assert.deepEqual([missedHistory.outcome, missedHistory.ok, missedHistory.missed, missedHistory.catchers_not_shipped], ["selected", true, [], ["release/not-shipped.test.js"]]);
  // The miss path stays covered: a catcher that no edge and no unresolved site reaches is missed, with the exact list.
  const missRoot = ev.initRepo(tmp(t, "coord924-miss-"), {
    "coord/engine/governance-guards.json": JSON.stringify({ guards: [] }),
    "coord/a.js": "exports.a = 1;\n",
    "coord/a.test.js": "require('./a.js');\nrequire('node:test')('a: covers a', () => {});\n",
    "coord/unrelated.test.js": "require('node:test')('unrelated: reaches no edge to a', () => {});\n",
  });
  const miss = ev.runHistoricalCase(missRoot, { id: "H-MISS", source: "fixture: catcher reached by no edge and no unresolved site", changes: [{ status: "M", path: "coord/a.js" }], catchers: ["coord/unrelated.test.js"] });
  assert.deepEqual([miss.outcome, miss.ok, miss.missed], ["missed", false, ["coord/unrelated.test.js"]]);
});

test("COORD-924: the review criteria are computed from counted runs and the fault suite", () => {
  const none = ev.computeCriteria({ policy, runs: [], faults: [{ id: "S", ok: false }] });
  assert.deepEqual(none.map((c) => [c.id, c.met]), [["min_shadow_runs", false], ["zero_missed_shadow_failures", true], ["fault_suite", false], ["change_categories", false], ["editions", false], ["node_lanes", false]]);
  assert.match(none[2].detail, /0 of 1 .*failing: S/);
  assert.match(none[4].detail, /no shadow run on: Community, Enterprise/);
  assert.match(none[5].detail, /no shadow run on Node 22, 24/);
  const all = ev.computeCriteria({ policy, runs: fullRuns(), faults: okFaults });
  assert.ok(all.every((c) => c.met), JSON.stringify(all));
  const missed = ev.computeCriteria({ policy, runs: [...fullRuns(), { ...fullRuns()[0], missed: ["x"] }], faults: okFaults });
  assert.equal(missed.find((c) => c.id === "zero_missed_shadow_failures").met, false);
  const resolutions = [{ category: "fixture", at: "2026-11-07T00:00:00.010Z" }, { category: "x", at: "2026-11-06T00:00:00.000Z" }];
  assert.equal(ev.countedRuns(fullRuns(), resolutions, DIGEST).length, policy.review_criteria.min_shadow_runs - 11);
  assert.equal(ev.countedRuns(fullRuns(), undefined, "sha256:other").length, 0);
});

test("COORD-924: an explicitly shadow-configured policy stays in shadow when evaluation criteria are met", (t) => {
  assert.deepEqual([shadowPolicy.initial_state, shadowPolicy.policy_version], ["shadow", policy.policy_version]);
  const dir = path.join(tmp(t, "coord924-eval-"), "ledger");
  const result = ev.evaluateActivation({ ledgerDir: dir, policy: shadowPolicy, faults: okFaults, digest: DIGEST, now: "2026-11-07T00:00:00.000Z" });
  assert.deepEqual([result.state, result.event, result.all_met, result.review_due], ["shadow", "evaluated", false, false]);
  const state = sh.readState(dir, shadowPolicy);
  assert.deepEqual([state.state, state.counted_runs, state.selector_digest, state.policy_version], ["shadow", 0, DIGEST, shadowPolicy.policy_version]);
  const report = fs.readFileSync(path.join(dir, sh.FILES.report), "utf8");
  assert.match(report, /\*\*Activation state: shadow\.\*\* Activation needs these criteria met and a governed policy change with a human-admin ruling \(COORD-936\)\./);
  assert.match(report, /\| min_shadow_runs \| no \| 0 of 30 counted shadow runs \|/);
  assert.match(report, /## Rollback/);
  const rendered = ev.renderReport({ state: "active", criteria: [], runs: [], digest: DIGEST, now: "n", faults: [
    { id: "H", kind: "historical", outcome: "selected", fallback_reasons: [], catchers_selected: ["c.test.js"] },
    { id: "D", kind: "seeded", outcome: "selected", fallback_reasons: [] },
    { id: "F", kind: "seeded", outcome: "fallback", fallback_reasons: ["t2_surface", "config_seam"] },
  ] });
  assert.match(rendered, /\| H \| historical \| selected \| c\.test\.js \|/);
  assert.match(rendered, /\| D \| seeded \| selected \| no suite affected \|/);
  assert.match(rendered, /\| F \| seeded \| fallback \| t2_surface, config_seam \|/);
  const due = tmp(t, "coord924-due-");
  writeRuns(due, fullRuns());
  const review = ev.evaluateActivation({ ledgerDir: due, policy: shadowPolicy, faults: okFaults, digest: DIGEST, now: "2026-11-08T00:00:00.000Z" });
  assert.deepEqual([review.state, review.review_due], ["shadow", true], "every criterion met: still shadow until a governed policy change");
  assert.equal(sh.readJournal(due).at(-1).reason, "every review criterion is met: review the evaluation report");
  const governedState = { state: "active", suspended_categories: { fixture: {} }, resolutions: [{ category: "y", at: "2026-11-08T03:00:00.000Z" }] };
  const after = ev.evaluateActivation({ ledgerDir: due, policy: shadowPolicy, faults: okFaults, state: governedState, digest: DIGEST, now: "2026-11-08T04:00:00.000Z" });
  assert.equal(after.state, "active", "the report shows the governed state; evaluation never changes it");
  assert.equal(after.criteria[0].detail, "0 of 30 counted shadow runs", "runs before the resolution no longer count");
  assert.deepEqual(sh.verifyJournal(sh.readJournal(due)).ok, true);
  const dueCli = capture((out, err) => ev.main(["evaluate", "--ledger", due], { out, err, runFaults: () => okFaults, policy: shadowPolicy }));
  assert.match(dueCli.out, /review criteria met=\d\/6/);
  const dueAll = tmp(t, "coord924-due-all-");
  writeRuns(dueAll, fullRuns(sel.selectorDigest()));
  assert.match(capture((out, err) => ev.main(["evaluate", "--ledger", dueAll], { out, err, runFaults: () => okFaults, policy: shadowPolicy })).out, /review criteria met=6\/6 review due\n$/);
});

test("COORD-924: the CLI selects, records shadow runs, evaluates and reports state and landing policy", (t) => {
  const dir = tmp(t, "coord924-cli-");
  const ledgerDir = path.join(dir, "ledger");
  const run = (argv, deps = {}) => capture((out, err) => ev.main([...argv, "--ledger", ledgerDir], { out, err, runFaults: () => okFaults, ...deps }));
  assert.match(run(["select", "--base", "HEAD", "--head", "HEAD"]).out, /^affected-selection: selected tier=T0 selected=0 omitted=\d+\n$/);
  assert.match(run(["select", "--base", "HEAD", "--head", "HEAD", "--json"]).out, /"authorizes_landing": false/);
  assert.match(run(["select", "--base", "no-such-ref", "--head", "HEAD"]).out, /full .*fallback=incomplete_analysis/);
  const fullReport = path.join(dir, "full.json");
  fs.writeFileSync(fullReport, JSON.stringify({ node_version: "v24.22.1", result: "pass", inventory: [{ name: "core", files: ["coord/engine/scripts/sqlite-runtime.test.js"] }], results: [{ module: "core", duration_ms: 50, failing_tests: [] }] }));
  const selectedReport = path.join(dir, "selected.json");
  fs.writeFileSync(selectedReport, JSON.stringify({ result: "pass", results: [{ duration_ms: 5, failing_tests: [] }] }));
  const shadowRun = run(["shadow", "--base", "HEAD", "--head", "HEAD", "--full-report", fullReport, "--selected-report", selectedReport]);
  assert.match(shadowRun.out, /^affected-selection: shadow selected missed=0 saved_ms=45 manifest=.*\.manifest\.json\n$/, shadowRun.err);
  let ran = null;
  const runSelected = (root, suites) => { ran = suites; return { report: JSON.parse(fs.readFileSync(selectedReport, "utf8")), path: selectedReport }; };
  run(["shadow", "--base", "HEAD", "--head", "HEAD", "--full-report", fullReport, "--run-selected"], { runSelected });
  assert.deepEqual(ran, null, "nothing is selected for an empty range, so nothing runs");
  const fixtures = require("./__fixtures__/affected-selection-faults.js");
  const repo = ev.initRepo(tmp(t, "coord924-cli-repo-"), { ...fixtures.repo, "coord/engine/governance-guards.json": JSON.stringify(fixtures.registry) });
  fs.appendFileSync(path.join(repo, "coord/engine/scripts/math.test.js"), "// edited\n");
  ev.git(repo, ["commit", "-qam", "edit a suite"]);
  const repoReport = path.join(dir, "repo-full.json");
  fs.writeFileSync(repoReport, JSON.stringify({ node_version: "v22.8.0", result: "pass", inventory: [{ name: "core", files: ["coord/engine/scripts/math.test.js", "coord/engine/scripts/report.test.js"] }], results: [{ module: "core", duration_ms: 80, failing_tests: [] }] }));
  const viaRunner = run(["shadow", "--root", repo, "--base", "HEAD~1", "--head", "HEAD", "--full-report", repoReport, "--run-selected"], { runSelected });
  assert.match(viaRunner.out, /shadow selected missed=0 saved_ms=75/, viaRunner.err);
  assert.deepEqual(ran, ["coord/engine/scripts/math.test.js"]);
  assert.match(run(["faults"]).out, /fault suite 1\/1 ok/);
  assert.equal(run(["faults"], { runFaults: () => [{ ok: false }] }).status, 1);
  // Evaluate the shadow evidence recorded above. Its first two runs use
  // this checkout's edition; the third uses the synthetic Community repo.
  const recordedRuns = fs.readFileSync(path.join(ledgerDir, sh.FILES.runs), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(recordedRuns.length, 3);
  const firstManifest = JSON.parse(fs.readFileSync(recordedRuns[0].manifest, "utf8"));
  const checkoutEdition = firstManifest.inputs.edition;
  assert.ok(["donor", "Community", "Enterprise"].includes(checkoutEdition));
  assert.deepEqual(recordedRuns.map(({ edition, node_major }) => [edition, node_major]), [
    [checkoutEdition, 24], [checkoutEdition, 24], ["Community", 22],
  ], "the actual cut and the synthetic repository supply the recorded edition and Node evidence");
  assert.ok(recordedRuns.every((record) => record.selector_digest === sel.selectorDigest()));
  assert.ok(recordedRuns.every((record) => record.missed.length === 0));
  assert.ok(policy.review_criteria.min_shadow_runs > recordedRuns.length);
  const coveredCategories = new Set(recordedRuns.flatMap((record) => record.categories));
  assert.ok(policy.review_criteria.require_categories.some((category) => !coveredCategories.has(category)),
    "these empty ranges and one suite edit do not cover all required change categories");
  const expectedCriteria = [
    ["min_shadow_runs", false], ["zero_missed_shadow_failures", true], ["fault_suite", true],
    ["change_categories", false], ["editions", checkoutEdition === "Enterprise"], ["node_lanes", true],
  ];
  const evaluated = run(["evaluate", "--json"]);
  assert.equal(evaluated.status, 0, evaluated.err);
  const evaluation = JSON.parse(evaluated.out);
  assert.equal(evaluation.state, "active", "the real configured policy is active");
  assert.equal(evaluation.event, "evaluated");
  assert.equal(evaluation.review_due, false);
  assert.equal(evaluation.all_met, false);
  assert.deepEqual(evaluation.criteria.map(({ id, met }) => [id, met]), expectedCriteria);
  const expectedMet = expectedCriteria.filter(([, met]) => met).length;
  assert.equal(run(["evaluate"]).out,
    `affected-selection: state=active (evaluated) review criteria met=${expectedMet}/${expectedCriteria.length}\n`);
  assert.match(run(["state"]).out, /state=active \(/, "COORD-941 activation is visible through the CLI");
  assert.match(run(["landing-policy", "--base", "HEAD", "--head", "HEAD"], { policy: shadowPolicy }).out, /landing gate=full: affected selection is shadow \(.*\); the full gate is required\n$/, "an explicit shadow configuration still requires the full gate");
  assert.match(run(["landing-policy", "--base", "HEAD", "--head", "HEAD"], { policy }).out, /landing gate=affected: T0\/T1 change with a complete selection: the selected suites plus the always-required governance suites\n$/, "the current active policy selects this eligible T0 range");
  assert.equal(run(["record-miss", "--ref", "COORD-999"]).status, 2, "misses are recorded with gov selection suspend, not here");
  assert.match(run(["select", "--base", "HEAD"]).out, /^affected-selection: (selected|full) /, "without --head the working tree is the head");
  assert.match(run(["landing-policy", "--base", "HEAD"]).out, /^affected-selection: landing gate=(full|affected): /, "the working tree decides; a clean checkout has nothing to select");
  const noInventory = path.join(dir, "no-inventory.json");
  fs.writeFileSync(noInventory, JSON.stringify({ result: "pass", results: [] }));
  assert.match(run(["shadow", "--base", "HEAD", "--full-report", noInventory]).out, /shadow selected missed=0/, "a report without an inventory selects from the repository");
  const noBoard = capture((out, err) => ev.main(["state", "--root", dir], { out, err }));
  assert.match(noBoard.out, /state=shadow \(board unreadable: full gates\)/, "a checkout without a readable governed board fails closed");
  const failingFullReport = path.join(dir, "failing-shadow.json");
  fs.writeFileSync(failingFullReport, JSON.stringify({ result: "fail", results: [{ failing_tests: ["broken"] }] }));
  const missedShadow = run(["shadow", "--base", "HEAD", "--head", "HEAD", "--full-report", failingFullReport]);
  assert.equal(missedShadow.status, 1);
  assert.match(missedShadow.out, /missed=1 .*record it in the governed state: coord\/scripts\/gov selection suspend/);
  let landingArgs = null;
  const runLanding = (args) => { landingArgs = args; return { file: "m.json", gate: { suites: ["a"] }, lane: { exit_code: 0 } }; };
  assert.match(run(["run-selected", "--base", "HEAD", "--out", dir], { runLanding }).out, /^affected-selection: selected-suite run exit=0 suites=1 manifest=m\.json\n$/);
  assert.equal(landingArgs.head, "HEAD");
  assert.equal(run(["run-selected", "--base", "HEAD", "--out", dir], { runLanding: () => ({ file: "m", gate: { suites: [] }, lane: { exit_code: 1 } }) }).status, 1);
  assert.match(run(["run-selected", "--base", "HEAD"]).err, /--out <dir> is required/);
  assert.match(run(["verify-landing", "--base", "HEAD"]).err, /--manifest <selection run manifest> is required/);
  const bogusManifest = path.join(dir, "bogus.json");
  fs.writeFileSync(bogusManifest, "{}");
  const refused = run(["verify-landing", "--base", "HEAD", "--manifest", bogusManifest]);
  assert.deepEqual([refused.status, /^add-repo-gate refusing the selected-suite evidence: manifest invalid/.test(refused.out)], [1, true]);
  assert.match(run(["compare-full", "--base", "HEAD"]).err, /--full-report <authoritative full-gate report> is required/);
  const compared = run(["compare-full", "--base", "HEAD", "--full-report", noInventory]);
  assert.match(compared.out, /^affected-selection: compare-full gate=(full|affected) failures=0 missed=0\n$/, compared.err);
  const inventory = path.join(dir, "inv.json");
  fs.writeFileSync(inventory, JSON.stringify({ editions: {} }));
  const failingFull = path.join(dir, "failing-full.json");
  fs.writeFileSync(failingFull, JSON.stringify({ result: "fail", results: [{ failing_tests: ["x"] }] }));
  const missRun = capture((out, err) => ev.main(["compare-full", "--base", "HEAD", "--head", "HEAD", "--full-report", failingFull, "--inventory", inventory, "--ledger", path.join(dir, "fresh-ledger")], { out, err }));
  assert.deepEqual([missRun.status, /missed=1/.test(missRun.out)], [1, true]);
  assert.deepEqual(run(["bogus"]).status, 2);
  assert.match(run(["select"]).err, /--base <ref> is required/);
  assert.match(run(["shadow", "--base", "HEAD"]).err, /--full-report <authoritative full-gate report> is required/);
  assert.match(run(["state", "--nope"]).err, /unknown argument --nope/);
  assert.deepEqual(ev.parseCli(["--json", "--run-selected", "--root", "/r"]), { json: true, runSelected: true, root: "/r" });
});

test("COORD-924: the selected suites run through the authoritative runner; the CLI entrypoint sets the exit code", (t) => {
  const { report, path: reportPath } = ev.runSelectedSuites(ev.WORKSPACE_ROOT, ["coord/engine/scripts/sqlite-runtime.test.js"], tmp(t, "coord924-runsel-"));
  assert.equal(report.result, "pass");
  assert.deepEqual(report.execution_order, ["coord/engine/scripts/sqlite-runtime.test.js"]);
  assert.ok(fs.existsSync(reportPath));
  const r = spawnSync(process.execPath, [path.join(__dirname, "affected-evaluation.js"), "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command bogus/);
});
