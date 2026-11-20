"use strict";

// COORD-936: the test-policy runner (fresh runs, history orders only, flaky
// classification, COORD-910 manifest), the shadow comparison classification
// and `gov test-policy`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tp = require("./test-policy.js");
const tpr = require("./test-policy-run.js");
const runManifest = require("./run-manifest.js");

const POLICY = tp.effectivePolicy();
const GUARD = POLICY.selection.always_required_suites[0];

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(t) {
  const root = tmp(t, "coord936-run-");
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"]]) spawnSync("git", args, { cwd: root });
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

function plan(checks, extra = {}) {
  return { stage: "pr", base_stage: "pr", trigger: null, decision: "selected", qualifies: false, base: null, scopes: [{ scope: "engine" }, { scope: "product", repo: "B" }], reasons: [], notes: [],
    selection: { tier: "T1", would_gate: "affected", selected_count: 1, omitted_count: 3, fallback_reasons: [], would_suites: [] },
    policy: { policy_version: 1, digest: POLICY.digest }, operating_mode: { pilot: "runnable-now", landing_gates: "unchanged" }, checks, ...extra };
}

// A spawn stub: the runner writes its report; commands answer from a script.
function fakeSpawn(script) {
  const calls = [];
  const spawn = (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, shell: opts.shell, timeoutMs: opts.timeoutMs, env: opts.env });
    const key = argv.includes("--report") ? `runner${argv.includes("--file") ? `:${argv.filter((_, i) => argv[i - 1] === "--file").join(",")}` : ":full"}` : argv.join(" ");
    const step = (script[key] || [{ exit: 0 }]).shift() || { exit: 0 };
    if (argv.includes("--report") && step.report !== null) {
      const failing = step.failing || [];
      const requestedFiles = argv.filter((_, index) => argv[index - 1] === "--file");
      fs.writeFileSync(argv[argv.indexOf("--report") + 1], JSON.stringify({ result: step.result ?? (step.exit === 0 ? "pass" : "fail"), totals: { tests: 3 }, results: [{ module: "core", exit_code: step.exit, failing_tests: failing }], engine_coverage: step.ratchet ? { ratchet: { result: step.ratchet } } : null,
        shards: argv.includes("--shards") ? [{ id: 1, result: "pass", assigned: requestedFiles.length ? requestedFiles : ["coord/a.test.js"] }] : null }));
    }
    return { exit_code: step.exit, signal: null, duration_ms: step.ms || 5, timed_out: Boolean(step.timeout), error: step.error || null };
  };
  return { spawn, calls };
}

const INVENTORY = { editions: { Community: { tests: { "coord/a.test.js": [["broken title"]], "coord/b.test.js": [["other title"]] } } } };

test("COORD-936: units are fresh runs; history only orders them and never removes a check", () => {
  const p = plan([{ id: "selected-suites", suites: ["coord/a.test.js"] }, { id: "always-required-suites", suites: [GUARD] }, { id: "product-tests", target: "B:test", command: "npm test", cwd: "backend" },
    { id: "lint", command: ["npm", "run", "lint"] }, { id: "product-tests", unconfigured: true, reason: "none" }]);
  const units = tpr.unitsOf(p);
  assert.deepEqual(units.map((u) => [u.id, u.kind]), [["engine-suites", "runner"], ["B:test", "command"], ["lint", "command"], ["product-tests", "unconfigured"]]);
  assert.deepEqual(units[0].files, ["coord/a.test.js", GUARD]);
  const history = [{ id: "lint", result: "pass", duration_ms: 1 }, { id: "B:test", result: "fail", duration_ms: 900 }];
  assert.deepEqual(tpr.orderUnits(units, history).map((u) => u.id), ["B:test", "lint", "engine-suites", "product-tests"], "failed first, then faster; nothing dropped");
  assert.deepEqual(tpr.orderUnits(units).map((u) => u.id), units.map((u) => u.id));
  assert.deepEqual(tpr.unitsOf(plan([{ id: "full-suite", args: ["--engine-coverage"] }])), [{ id: "full-suite", kind: "runner", files: [], args: ["--engine-coverage"] }]);
  assert.deepEqual(tpr.unitsOf(plan([{ id: "full-suite" }]))[0].args, []);
});

test("COORD-936: a run records fresh results, flaky and consistent failures and timeouts in a valid COORD-910 manifest", (t) => {
  const root = repo(t);
  const out = path.join(tmp(t, "coord936-out-"), "run");
  const { spawn, calls } = fakeSpawn({
    "runner:coord/a.test.js": [{ exit: 1, failing: ["broken title"] }, { exit: 1, failing: ["broken title"] }],
    "flaky": [{ exit: 1 }, { exit: 0 }],
    "always-red": [{ exit: 1 }, { exit: 1 }],
    "slow": [{ exit: -1, timeout: true }],
  });
  const p = plan([{ id: "selected-suites", suites: ["coord/a.test.js"] }, { id: "f", command: "flaky" }, { id: "r", command: "always-red" }, { id: "s", command: "slow" }, { id: "u", unconfigured: true, reason: "no command" }],
    { execution: "policy + exception: add TPX-1", exceptions: [{ id: "TPX-1" }] });
  const ran = tpr.runPlan({ root, plan: p, policy: { execution: { timeout_seconds: 7 } }, outDir: out, spawn, inventory: INVENTORY, env: { COORD_PROJECT_CONFIG: "/adopter.config.js", KEEP: "1" }, now: (() => { let n = 0; return () => (n += 100); })() });
  const byId = Object.fromEntries(ran.report.results.map((r) => [r.id, [r.result, r.classification]]));
  assert.deepEqual(byId, { "engine-suites": ["fail", "consistent"], f: ["fail", "flaky"], r: ["fail", "consistent"], s: ["fail", "timeout"], u: ["fail", "unconfigured"] }, "a pass on the rerun classifies, it never passes the check");
  assert.equal(calls.filter((c) => c.argv.includes("--report")).length, 2, "the failing suite was re-run once, alone");
  assert.ok(calls.every((c) => c.timeoutMs === 7000));
  assert.deepEqual(calls.filter((c) => c.argv.includes("--report")).map((c) => c.env), [{ KEEP: "1" }, { KEEP: "1" }], "the adopter override never reaches the engine suites under test");
  assert.equal(calls.find((c) => c.argv[0] === "flaky").env.COORD_PROJECT_CONFIG, "/adopter.config.js", "adopter commands keep the install configuration");
  const flakyCall = calls.find((c) => c.argv[0] === "flaky");
  assert.deepEqual([flakyCall.shell, flakyCall.cwd], [true, root]);
  assert.equal(ran.report.result, "fail");
  assert.deepEqual(ran.report.metrics.flaky_failures, ["f"]);
  assert.deepEqual([ran.report.metrics.timeouts, ran.report.metrics.feedback_ms, ran.report.metrics.execution], [["s"], 100, "policy + exception: add TPX-1"]);
  assert.deepEqual(ran.report.metrics.selection_scope, { would_gate: "affected", selected: 1, omitted: 3, tier: "T1" });
  assert.deepEqual(runManifest.validateManifest(ran.manifest), []);
  const rec = ran.manifest.inputs.gate_config.test_policy;
  assert.deepEqual([rec.stage, rec.execution, rec.exceptions, rec.landing_gates, rec.order], ["pr", "policy + exception: add TPX-1", [{ id: "TPX-1" }], "unchanged", ["engine-suites", "f", "r", "s", "u"]]);
  assert.equal(JSON.parse(fs.readFileSync(ran.manifestFile, "utf8")).input_digest, ran.manifest.input_digest);
});

test("COORD-936: a deterministic coverage-ratchet failure is retained without rerunning the full suite", (t) => {
  const root = repo(t);
  const { spawn, calls } = fakeSpawn({ "runner:full": [{ exit: 1, ratchet: "fail" }] });
  const p = plan([{ id: "full-suite", args: ["--engine-coverage"] }], {
    stage: "promotion", base_stage: "promotion", decision: "full", qualifies: true,
    scopes: [{ scope: "engine" }], selection: null, base: "HEAD",
  });
  const ran = tpr.runPlan({ root, plan: p, policy: POLICY, outDir: tmp(t, "coord936-ratchet-fail-"), spawn, inventory: INVENTORY, env: {} });
  assert.equal(calls.filter((c) => c.argv.includes("--report")).length, 1, "the full suite runs once when its ratchet fails");
  assert.deepEqual([ran.report.results[0].result, ran.report.results[0].classification], ["fail", "consistent"]);
  assert.equal(ran.report.metrics.promotion_outcome.result, "fail", "a deterministic ratchet failure never qualifies");
  assert.match(ran.report.results.find((r) => r.id === "qualification-requirements").reason, /coverage ratchet did not pass \(fail\)/);
});

test("COORD-936: named test failures still rerun their suite when the coverage ratchet also fails", (t) => {
  const root = repo(t);
  const { spawn, calls } = fakeSpawn({
    "runner:full": [{ exit: 1, ratchet: "fail", failing: ["broken title"] }],
    "runner:coord/a.test.js": [{ exit: 0, ratchet: "pass" }],
  });
  const p = plan([{ id: "full-suite", args: ["--engine-coverage"] }], {
    stage: "promotion", base_stage: "promotion", decision: "full", qualifies: true,
    scopes: [{ scope: "engine" }], selection: null, base: "HEAD",
  });
  const ran = tpr.runPlan({ root, plan: p, policy: POLICY, outDir: tmp(t, "coord936-ratchet-and-test-fail-"), spawn, inventory: INVENTORY, env: {} });
  assert.equal(calls.filter((c) => c.argv.includes("--report")).length, 2);
  assert.deepEqual([ran.report.results[0].result, ran.report.results[0].classification], ["fail", "flaky"]);
  assert.equal(ran.report.metrics.promotion_outcome.result, "fail", "a passing classification rerun never clears the original failure");
});

test("COORD-936: a passing promotion run records its outcome; a missing runner report fails closed", (t) => {
  const root = repo(t);
  const { spawn } = fakeSpawn({ "runner:full": [{ exit: 0 }], ping: [{ exit: 0 }] });
  const p = plan([{ id: "full-suite", args: [] }, { id: "ping", kind: "smoke", command: ["ping"] }], { stage: "production", base_stage: "promotion", selection: null, decision: "full", base: "HEAD" });
  const ran = tpr.runPlan({ root, plan: p, policy: POLICY, outDir: tmp(t, "coord936-promo-"), spawn, inventory: INVENTORY, env: {} });
  assert.deepEqual([ran.report.result, ran.report.metrics.promotion_outcome, ran.report.metrics.selection_scope, ran.report.metrics.execution], ["pass", { stage: "production", result: "pass" }, { decision: "full" }, "policy"]);
  assert.equal(Object.hasOwn(ran.report.results.find((result) => result.kind === "command"), "report"), false);
  const red = fakeSpawn({ "runner:full": [{ exit: 0 }], ping: [{ exit: 1 }, { exit: 1 }] });
  const failed = tpr.runPlan({ root, plan: p, policy: POLICY, outDir: tmp(t, "coord936-promo-red-"), spawn: red.spawn, env: {} });
  assert.deepEqual(failed.report.metrics.promotion_outcome, { stage: "production", result: "fail" }, "the inventory defaults to the checkout's suite inventory");
  const missing = fakeSpawn({ "runner:coord/a.test.js": [{ exit: 0, report: null }] });
  const lost = tpr.runPlan({ root, plan: plan([{ id: "selected-suites", suites: ["coord/a.test.js"] }]), policy: POLICY, outDir: tmp(t, "coord936-lost-"), spawn: missing.spawn, inventory: INVENTORY, env: {} });
  assert.deepEqual([lost.report.results[0].result, lost.report.results[0].classification], ["fail", "flaky"], "no report is a failure; the rerun only classifies it");
  assert.equal(lost.report.results[0].report, null, "a diagnostic rerun cannot supply evidence for the missing primary run");
  const real = tpr.spawnUnit(["sh", "-c", "exit 3"], { cwd: root, timeoutMs: 5000, env: process.env });
  assert.deepEqual([real.exit_code, real.timed_out], [3, false]);
  assert.equal(tpr.spawnUnit(["sleep", "5"], { cwd: root, timeoutMs: 50, env: process.env }).timed_out, true);
  assert.match(tpr.spawnUnit(["/no/such/binary"], { cwd: root, timeoutMs: 5000, env: process.env }).error, /ENOENT/);
});

test("COORD-900: shard full gates and exact selected plans, but reject incomplete selections", (t) => {
  const root = repo(t);
  const shardingPolicyPath = path.join(root, "coord", "engine", "test-policy.json");
  fs.mkdirSync(path.dirname(shardingPolicyPath), { recursive: true });
  const shardPolicy = { authoritative: true, scope: "resolved-policy-plan",
    suspension: { active: false, reason: null, evidence: null },
    comparison: { first_sharded_run_requires_same_tree_serial_comparison: false, scheduled_serial_full_comparison: false,
      compared: ["test_identity", "outcome", "coverage_findings"],
      mismatch_action: "fail-qualification-and-automatically-suspend",
      comparison_execution: "donor-journaled-transaction" } };
  fs.writeFileSync(shardingPolicyPath, JSON.stringify({ sharding: shardPolicy }));
  assert.equal(spawnSync("git", ["add", "coord/engine/test-policy.json"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "fixture promotion policy"], { cwd: root }).status, 0);
  const { spawn, calls } = fakeSpawn({ "runner:full": [
    { exit: 2, result: "provisional", ratchet: "pass" },
    { exit: 0, ratchet: "pass" },
    { exit: 0, ratchet: "pass" },
    { exit: 0, ratchet: "pass" },
    { exit: 0, ratchet: "pass" },
  ] });
  const full = [{ id: "full-suite", args: ["--engine-coverage"] }];
  const promotion = plan(full, { stage: "production", base_stage: "promotion", decision: "full", qualifies: true,
    selection: null, scopes: [{ scope: "engine" }], base: "HEAD" });
  const ran = tpr.runPlan({ root, plan: promotion, policy: POLICY, outDir: tmp(t, "coord900-promotion-shards-"),
    spawn, inventory: INVENTORY, env: {}, shards: "auto" });
  assert.equal(ran.report.result, "provisional", "the low-level runner result cannot qualify promotion without donor receipt verification");
  assert.equal(ran.manifest.result, "provisional");
  assert.ok(calls[0].argv.includes("--shards") && calls[0].argv.includes("auto"), "the full promotion run invokes the sharded runner");
  assert.ok(calls[0].argv.includes("--qualification-stage") && calls[0].argv.includes("promotion"), "the policy runner labels the resolved qualification context");
  assert.ok(calls[0].argv.includes("--policy-stage") && calls[0].argv.includes("production"), "the exact adopter stage is also bound");
  assert.ok(calls[0].argv.includes("--qualification-mode") && calls[0].argv.includes("full"));
  assert.deepEqual(ran.report.results[0].shards, [{ id: 1, result: "pass", assigned: ["coord/a.test.js"] }],
    "the policy report carries the runner's actual shard results");
  assert.ok(ran.manifest.artifacts.some((artifact) => artifact.path === ran.reportFile && artifact.sha256),
    "the run manifest binds the policy report containing the shard receipt");

  const nightly = plan(full, { stage: "nightly", base_stage: "nightly", decision: "full", qualifies: true, selection: null });
  const nightlyRun = tpr.runPlan({ root, plan: nightly, policy: POLICY, outDir: tmp(t, "coord900-nightly-shards-"), spawn, inventory: INVENTORY, env: {}, shards: "auto" });
  assert.equal(nightlyRun.report.result, "provisional");
  assert.ok(calls.at(-1).argv.includes("nightly"), "the full nightly stage is passed to the runner");

  const t2 = plan(full, { stage: "pr", base_stage: "pr", decision: "full", qualifies: false,
    scopes: [{ scope: "engine" }], selection: { tier: "T2", fallback_reasons: [], would_gate: "full" } });
  const t2Run = tpr.runPlan({ root, plan: t2, policy: POLICY, outDir: tmp(t, "coord900-pr-t2-shards-"), spawn, inventory: INVENTORY, env: {}, shards: "auto" });
  assert.equal(t2Run.report.result, "provisional");
  assert.ok(calls.at(-1).argv.includes("pr"), "T2 PR full fallback can shard");

  const unknown = plan(full, { stage: "pr", base_stage: "pr", decision: "full", qualifies: false,
    scopes: [{ scope: "engine" }], selection: { tier: "T1", fallback_reasons: ["unknown_dependents"], would_gate: "full" } });
  assert.equal(tpr.runPlan({ root, plan: unknown, policy: POLICY, outDir: tmp(t, "coord900-pr-unknown-shards-"), spawn, inventory: INVENTORY, env: {}, shards: "auto" }).report.result, "provisional");
  const onlyFullDecision = { ...unknown, selection: { tier: "T1", fallback_reasons: [], would_gate: "full" } };
  assert.equal(tpr.runPlan({ root, plan: onlyFullDecision, policy: POLICY, outDir: tmp(t, "coord900-pr-full-decision-"),
    spawn, inventory: INVENTORY, env: {}, shards: "auto" }).report.result, "provisional");
  const beforeRefusal = calls.length;
  for (const inadmissible of [{ ...unknown, selection: null }, plan([{ id: "always-required-suites", suites: [] }])]) {
    assert.throws(() => tpr.runPlan({ root, plan: inadmissible, policy: POLICY, outDir: tmp(t, "coord900-empty-shard-"),
      spawn, inventory: INVENTORY, env: {}, shards: "auto" }), /complete resolved full gate or an exact resolved selected-suite set/);
  }
  assert.equal(calls.length, beforeRefusal, "ineligible plans do not dispatch a runner");

  const partial = plan([{ id: "selected-suites", suites: ["coord/a.test.js"] }], { stage: "pr", base_stage: "pr", decision: "selected", qualifies: false });
  const selected = plan([
    { id: "selected-suites", suites: ["coord/a.test.js"] },
    { id: "always-required-suites", suites: ["coord/b.test.js"] },
  ], { stage: "pr", base_stage: "pr", decision: "selected", qualifies: false,
    selection: { tier: "T1", would_gate: "affected", selected_count: 1, omitted_count: 1, fallback_reasons: [], would_suites: ["coord/a.test.js"] } });
  const selectedRun = tpr.runPlan({ root, plan: selected, policy: POLICY, outDir: tmp(t, "coord900-pr-selected-shards-"), spawn, inventory: INVENTORY, env: {}, shards: "auto" });
  const selectedArgs = calls.at(-1).argv;
  assert.equal(selectedRun.report.result, "provisional");
  assert.deepEqual(selectedArgs.filter((_, index) => selectedArgs[index - 1] === "--file").sort(), ["coord/a.test.js", "coord/b.test.js"]);
  assert.ok(selectedArgs.includes("selection"), "receipt mode marks partial selection distinctly");
  assert.equal(selectedArgs.includes("--engine-coverage"), false, "partial selection never applies the whole-suite ratchet");
  assert.deepEqual(selectedRun.report.results[0].shards[0].assigned.sort(), ["coord/a.test.js", "coord/b.test.js"]);

  const singleton = plan([
    { id: "selected-suites", suites: ["coord/a.test.js"] },
    { id: "always-required-suites", suites: [] },
  ], { stage: "developer", base_stage: "developer", decision: "selected", qualifies: false,
    selection: { tier: "T1", would_gate: "affected", selected_count: 1, omitted_count: 1, fallback_reasons: [], would_suites: ["coord/a.test.js"] } });
  const beforeSingleton = calls.length;
  const singletonRun = tpr.runPlan({ root, plan: singleton, policy: POLICY, outDir: tmp(t, "coord900-singleton-auto-"), spawn, inventory: INVENTORY, env: {}, shards: "auto" });
  assert.equal(singletonRun.report.results[0].result, "pass");
  assert.equal(calls.length, beforeSingleton + 1);
  assert.equal(calls.at(-1).argv.includes("--shards"), false, "auto does not create a one-worker clone");
  assert.equal(singletonRun.report.sharding.mode, "serial-fallback");
  assert.match(singletonRun.report.sharding.reason, /only one suite/);
  assert.throws(() => tpr.runPlan({ root, plan: singleton, policy: POLICY, outDir: tmp(t, "coord900-singleton-too-many-"), spawn, inventory: INVENTORY, env: {}, shards: "2" }),
    /exceeds the resolved selected-plus-mandatory suite count 1/);

  assert.throws(() => tpr.runPlan({ root, plan: partial, policy: POLICY, outDir: tmp(t, "coord900-pr-partial-no-mandatory-shards-"), spawn, env: {}, shards: "auto" }),
    /complete resolved full gate or an exact resolved selected-suite set/);
  let donorState = { metadata: {} };
  const revoked = tpr.runPlan({ root, plan: promotion, policy: POLICY, outDir: tmp(t, "coord900-revoked-shards-"),
    inventory: INVENTORY, env: {}, shards: "auto", readBoard: () => donorState,
    spawn: (...args) => {
      donorState = { metadata: { test_sharding: { suspension: { active: true, reason: "comparison failed during execution" } } } };
      return fakeSpawn({ "runner:full": [{ exit: 2, result: "provisional", ratchet: "pass" }] }).spawn(...args);
    } });
  assert.equal(revoked.report.result, "fail");
  assert.equal(revoked.report.results.find((result) => result.id === "full-suite").result, "pass");
  assert.match(revoked.report.results.find((result) => result.id === "qualification-requirements").reason,
    /donor authority changed during sharded execution.*comparison failed during execution/);

  const suspended = { ...POLICY, sharding: { ...shardPolicy,
    suspension: { active: true, reason: "serial comparison mismatch", evidence: "comparison.json" } } };
  fs.writeFileSync(shardingPolicyPath, JSON.stringify({ sharding: suspended.sharding }));
  assert.throws(() => tpr.runPlan({ root, plan: promotion, policy: suspended,
    outDir: tmp(t, "coord900-suspended-shards-"), spawn, env: {}, shards: "auto" }), /sharding is suspended/);
});

test("COORD-936: promotion cannot pass without the full suite, a passing coverage ratchet and the exact committed candidate", (t) => {
  const root = repo(t);
  const promotion = (checks, extra = {}) => plan(checks, { stage: "staging", base_stage: "promotion", selection: null, decision: "full", qualifies: true, scopes: [{ scope: "engine" }], ...extra });
  const run = (p, script) => tpr.runPlan({ root, plan: p, policy: POLICY, outDir: tmp(t, "coord936-qual-"), spawn: fakeSpawn(script).spawn, inventory: INVENTORY, env: {} }).report;
  const reason = (r) => (r.results.find((x) => x.id === "qualification-requirements") || {}).reason || null;
  const full = { id: "full-suite", args: ["--engine-coverage"] };
  const good = run(promotion([full, { id: "smoke", kind: "smoke", command: ["ping"] }]), { "runner:full": [{ exit: 0, ratchet: "pass" }] });
  assert.deepEqual([good.result, reason(good), good.metrics.promotion_outcome.result], ["pass", null, "pass"], "the full suite with a passing ratchet on a clean candidate qualifies");
  const noRatchet = run(promotion([{ id: "full-suite", args: [] }]), { "runner:full": [{ exit: 0 }] });
  assert.deepEqual([noRatchet.result, reason(noRatchet)], ["fail", "the coverage ratchet did not pass (not measured)"], "a green full suite without the ratchet does not qualify");
  const redRatchet = run(promotion([full]), { "runner:full": [{ exit: 0, ratchet: "fail" }, { exit: 0, ratchet: "fail" }] });
  assert.equal(reason(redRatchet), "the coverage ratchet did not pass (fail)");
  const noSuite = run(promotion([{ id: "ping", kind: "smoke", command: ["ping"] }]), {});
  assert.deepEqual([noSuite.result, reason(noSuite)], ["fail", "the full suite did not run"], "smoke checks alone never promote engine code");
  fs.writeFileSync(path.join(root, "uncommitted.txt"), "x\n");
  const dirty = run(promotion([full]), { "runner:full": [{ exit: 0, ratchet: "pass" }] });
  assert.match(reason(dirty), /uncommitted changes: promotion qualifies only the exact committed candidate/);
  const nightly = run(promotion([full], { stage: "nightly", base_stage: "nightly" }), { "runner:full": [{ exit: 0, ratchet: "pass" }] });
  assert.equal(nightly.result, "pass", "the scheduled run carries the ratchet; a dirty tree is a promotion refusal only");
  const product = run(promotion([{ id: "product-tests", target: "B:test", command: ["true"] }], { scopes: [{ scope: "product", repo: "B" }] }), {});
  assert.equal(reason(product), null, "a product promotion runs its full product checks; the engine ratchet is not a product check");
  const ex = require("./test-policy-exceptions.js");
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], policy: POLICY, plan: { checks: [full], selection: { would_suites: ["coord/a.test.js"] } }, override: { reason: "r" }, stage: "promotion" }).join(), /promotion always runs the full suite and the coverage ratchet/);
});

test("COORD-941: landing selection receipts retain mandatory suites without inferring landing authority", () => {
  const checks = [{ id: "selected-suites", suites: ["coord/a.test.js"] },
    { id: "always-required-suites", suites: [GUARD] }, { id: "lint", command: "lint" }];
  const selected = plan(checks, { selection: { mode: "selection" } });
  const receipt = tpr.landingSelectionFor(selected);
  assert.deepEqual(receipt.required_suites, [...new Set(["coord/a.test.js", GUARD])].sort());
  assert.deepEqual(receipt.fallback_reasons, []);
  assert.equal(receipt.authorizes_landing, false);
  assert.deepEqual(receipt.test_policy.required_checks, checks.map((check) => check.id));
  const fallback = { ...selected, selection: { mode: "selection", would_suites: ["coord/extra.test.js"],
    fallback_details: [{ code: "incomplete_analysis" }] } };
  assert.ok(tpr.landingSelectionFor(fallback).required_suites.includes("coord/extra.test.js"));
  assert.deepEqual(tpr.landingSelectionFor(fallback).fallback_reasons, fallback.selection.fallback_details);
  assert.equal(tpr.landingSelectionFor({ ...selected, base_stage: "promotion" }), null);
  assert.equal(tpr.landingSelectionFor({ ...selected, decision: "full" }), null);
});

test("COORD-941: requested candidate identity refuses missing or stale heads despite passing checks", (t) => {
  const root = repo(t);
  const oldHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(spawnSync("git", ["commit", "--allow-empty", "-qm", "new candidate"], { cwd: root }).status, 0);
  for (const head of ["missing-candidate-ref", oldHead, "HEAD"]) {
    const promotion = plan([{ id: "full-suite", args: ["--engine-coverage"] }, { id: "candidate-command", command: ["fixture-command"] }], {
      stage: "production", base_stage: "promotion", decision: "full", qualifies: true,
      scopes: [{ scope: "engine" }], base: "HEAD", head,
    });
    const fake = fakeSpawn({ "runner:full": [{ exit: 0, ratchet: "pass" }] });
    const ran = tpr.runPlan({ root, plan: promotion, policy: POLICY,
      outDir: tmp(t, "coord941-requested-head-"), spawn: fake.spawn, inventory: [] });
    assert.equal(ran.report.result, head === "HEAD" ? "pass" : "fail");
    assert.equal(fake.calls.length, head === "HEAD" ? 2 : 0, "mismatched or missing heads must dispatch no runners or commands");
    if (head !== "HEAD") {
      const refusal = ran.report.results.find((entry) => entry.id === "qualification-requirements");
      assert.match(refusal.reason, /not the exact checked-out candidate/);
      assert.equal(JSON.parse(fs.readFileSync(ran.reportFile, "utf8")).result, "fail");
      const persisted = JSON.parse(fs.readFileSync(ran.manifestFile, "utf8"));
      assert.deepEqual(persisted.inputs.gate_config.test_policy.order, []);
      assert.equal(persisted.inputs.source.commit, spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim());
      assert.equal(fs.existsSync(path.join(path.dirname(ran.reportFile), "runner-report.json")), false);
    }
  }
  const selected = plan([{ id: "selected-suites", suites: ["coord/a.test.js"] }], { head: oldHead });
  const selectedSpawn = fakeSpawn({});
  const selectedRun = tpr.runPlan({ root, plan: selected, policy: POLICY,
    outDir: tmp(t, "coord1052-stale-selected-head-"), spawn: selectedSpawn.spawn, inventory: [] });
  assert.equal(selectedRun.report.result, "fail");
  assert.equal(selectedSpawn.calls.length, 0);
  assert.equal(selectedRun.report.metrics.suites_run, 0);
  assert.deepEqual(selectedRun.manifest.inputs.gate_config.test_policy.order, []);
  assert.deepEqual(selectedRun.report.plan.checks, selected.checks, "retain requested checks as intent");

});

test("COORD-941: a runner that advances HEAD cannot qualify a clean promotion candidate", (t) => {
  const root = repo(t);
  const promotion = plan([{ id: "full-suite", args: ["--engine-coverage"] }], {
    stage: "production", base_stage: "promotion", decision: "full", qualifies: true, scopes: [{ scope: "engine" }], base: "HEAD",
  });
  const fake = fakeSpawn({ "runner:full": [{ exit: 0, ratchet: "pass" }] });
  let advanced = false;
  const spawn = (argv, options) => {
    const result = fake.spawn(argv, options);
    if (!advanced && argv.includes("--report")) {
      advanced = true;
      fs.writeFileSync(path.join(root, "runner-advanced-head.txt"), "changed during check\n");
      assert.equal(spawnSync("git", ["add", "runner-advanced-head.txt"], { cwd: root }).status, 0);
      assert.equal(spawnSync("git", ["-c", "user.email=coord941@example.invalid", "-c", "user.name=coord941", "commit", "-qm", "advance head"], { cwd: root }).status, 0);
    }
    return result;
  };
  const ran = tpr.runPlan({ root, plan: promotion, policy: POLICY, outDir: tmp(t, "coord941-head-drift-"), spawn, inventory: INVENTORY, env: {} });
  const refusal = ran.report.results.find((result) => result.id === "qualification-requirements");
  assert.match(refusal.reason, /source commit, tree or working-tree state changed/);
  assert.equal(ran.report.result, "fail", "a clean but different post-run HEAD cannot qualify the candidate");
  assert.notEqual(ran.manifest.inputs.source.commit, spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim());
});

test("COORD-936: only a passing qualifying run advances the checkpoint; a failed, interrupted or skipped run never does, and a skip is never promotion evidence", (t) => {
  const root = repo(t);
  const state = tmp(t, "coord936-checkpoint-");
  const runtime = path.join(state, "test-policy");
  const lastFile = path.join(runtime, "last-qualified.json");
  const outcomes = [];
  const cmd = tpr.createTestPolicyCommands({ root, fail: (m) => { throw new Error(m); }, log: () => {}, env: {}, ledgerDir: path.join(state, "ledger"), readBoard: () => ({ metadata: {} }),
    scheduleDecide: () => ({ decision: outcomes[0] === "skip" ? "skip" : "run", reason: "test" }),
    run: (o) => {
      const outcome = outcomes.shift();
      if (outcome === "interrupt") throw new Error("interrupted: SIGTERM");
      const result = outcome === "pass" ? "pass" : "fail";
      return { manifest: { inputs: { source: { commit: `c-${result}`, tree: "t" } } }, manifestFile: "m.json",
        report: { result, plan: o.plan, metrics: { feedback_ms: 1 }, results: [{ id: "full-suite", result, classification: null }] } };
    } });
  outcomes.push("pass");
  cmd("run", ["--stage", "nightly"]);
  assert.equal(JSON.parse(fs.readFileSync(lastFile, "utf8")).commit, "c-pass");
  outcomes.push("fail");
  assert.throws(() => cmd("run", ["--stage", "nightly"]), /test-policy run failed at stage nightly/);
  assert.equal(JSON.parse(fs.readFileSync(lastFile, "utf8")).commit, "c-pass", "a failed run leaves the checkpoint");
  outcomes.push("interrupt");
  assert.throws(() => cmd("run", ["--stage", "nightly"]), /interrupted: SIGTERM/);
  assert.equal(JSON.parse(fs.readFileSync(lastFile, "utf8")).commit, "c-pass", "an interrupted run leaves the checkpoint");
  outcomes.push("skip");
  const skippedOut = path.join(state, "must-not-be-created-for-nightly-skip");
  const skipped = cmd("run", ["--stage", "nightly", "--shards", "auto", "--out", skippedOut]);
  assert.deepEqual([skipped.result, skipped.results], ["skipped", []], "a skip is recorded as skipped, with no check result");
  assert.deepEqual(outcomes, ["skip"], "conditional nightly skip never launches the sharded runner");
  assert.equal(fs.existsSync(skippedOut), false, "a skipped nightly creates no provisional report, manifest or receipt directory");
  assert.equal(JSON.parse(fs.readFileSync(lastFile, "utf8")).commit, "c-pass", "a skip never advances the checkpoint");
  const decisions = fs.readFileSync(path.join(runtime, "schedule-decisions.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l).decision);
  assert.deepEqual(decisions, ["run", "run", "run", "skip"]);
  // Promotion never consults scheduled records: with only a skip on record and no full-suite result, it refuses.
  const promotion = plan([{ id: "staging-smoke", kind: "smoke", command: ["ping"] }], { stage: "staging", base_stage: "promotion", qualifies: true, scopes: [{ scope: "engine" }], selection: null });
  const report = tpr.runPlan({ root, plan: promotion, policy: POLICY, outDir: tmp(t, "coord936-skip-evidence-"), spawn: fakeSpawn({}).spawn, inventory: INVENTORY, env: {} }).report;
  assert.deepEqual([report.result, report.results.at(-1).reason], ["fail", "the full suite did not run"]);
});

test("COORD-936: the shadow comparison classifies each full-run failure by test identity and reason", () => {
  const fullReport = { inventory: [{ files: ["coord/a.test.js", "coord/b.test.js", "coord/c.test.js"] }], results: [
    { module: "core", exit_code: 1, failing_tests: ["broken title", "other title"] },
    { module: "hooks", exit_code: -1, signal: "SIGKILL", failing_tests: ["killed title"] },
    { module: "gates", exit_code: 1, failing_tests: ["socket ETIMEDOUT title"] },
  ] };
  const line = { gate: "full", state: "shadow", would_run: ["coord/a.test.js"] };
  const r = tpr.classifyComparison({ fullReport, line, inventory: INVENTORY, changedFiles: ["coord/x.js"], selectedReport: { results: [] } });
  const kinds = Object.fromEntries(r.failures.map((f) => [f.test, f.kind]));
  assert.deepEqual(kinds, { "broken title": "not-reproduced", "killed title": "environmental", "other title": "detection-miss", "socket ETIMEDOUT title": "environmental" });
  const miss = r.failures.find((f) => f.kind === "detection-miss");
  assert.deepEqual([miss.suites, miss.reason, miss.map_correction.changed_files], [["coord/b.test.js"], "exit 1", ["coord/x.js"]]);
  assert.deepEqual([r.gate, r.state, r.would_suites, r.detection_misses, r.environmental, r.skipped_work], ["full", "shadow", 1, 1, 2, { suites: 1 }]);
  assert.equal(r.failures.find((f) => f.test === "killed title").reason, "signal SIGKILL");
  const caught = tpr.classifyComparison({ fullReport: { inventory: [], results: [{ module: "core", exit_code: 1, failing_tests: ["broken title"] }] }, line, inventory: INVENTORY });
  assert.equal(caught.failures[0].kind, "caught");
  const full = tpr.classifyComparison({ fullReport: { results: [{ module: "core", exit_code: 1, failing_tests: ["other title"] }] }, line: { gate: "full", state: "shadow", would_run: "full" }, inventory: INVENTORY });
  assert.deepEqual([full.failures[0].kind, full.would_suites, full.skipped_work, full.state], ["caught", "full", { suites: 0 }, "shadow"]);
});

test("COORD-936: gov test-policy show, resolve, run and compare, with argument errors", (t) => {
  const root = repo(t);
  const logs = [];
  const fail = (m) => { throw new Error(m); };
  const runs = [];
  const cmd = tpr.createTestPolicyCommands({ root, fail, log: (x) => logs.push(x), env: {}, ledgerDir: path.join(root, "ledger"), readBoard: () => ({ metadata: {} }),
    run: (o) => { runs.push(o); return { manifest: { inputs: { source: { commit: "c0ffee", tree: "7ree" } } }, report: { result: o.plan.stage === "staging" ? "fail" : "pass", plan: o.plan, metrics: { feedback_ms: 1 }, results: [{ id: "full-suite", result: o.plan.stage === "staging" ? "fail" : "pass", classification: o.plan.stage === "staging" ? "consistent" : null }] }, manifestFile: "m.json" }; },
    compareFullRun: (o) => ({ gate: "full", state: "shadow", would_run: "full", base: o.base }),
    scheduleDecide: ({ last }) => (last && last.results ? { decision: "skip", reason: "unchanged tree since the last successful full run" } : { decision: "run", reason: "no previous successful full run" }) });
  assert.equal(cmd("show", []).policy_version, 2);
  assert.match(logs.at(-1), /workflow stages: staging->promotion, beta->promotion/);
  assert.equal(JSON.parse(cmd("show", ["--json"]) && logs.at(-1)).schema_version, 2);
  const badConfig = path.join(root, "bad.config.js");
  fs.writeFileSync(badConfig, "module.exports = { testPolicy: { operating_mode: {} } };\n");
  tpr.createTestPolicyCommands({ root, fail, log: (x) => logs.push(x), env: { COORD_PROJECT_CONFIG: badConfig }, readBoard: () => ({ metadata: {} }) })("show", []);
  assert.match(logs.at(-1), /override refused: testPolicy.operating_mode: refused \(engine-owned/);
  const plan = cmd("resolve", ["--stage", "production"]);
  assert.deepEqual([plan.base_stage, plan.execution, plan.exceptions], ["promotion", "policy", []]);
  assert.match(logs.at(-1), /execution: policy\n/);
  cmd("resolve", ["--stage", "nightly", "--json"]);
  assert.equal(JSON.parse(logs.at(-1)).stage, "nightly");
  const history = path.join(root, "h.json");
  fs.writeFileSync(history, JSON.stringify({ results: [{ id: "full-suite", result: "fail" }] }));
  assert.equal(cmd("run", ["--stage", "nightly", "--history", history, "--out", path.join(root, "o")]).result, "pass");
  assert.match(logs.find((l) => /scheduled run run:/.test(l)), /scheduled run run: no previous successful full run/);
  const last = JSON.parse(fs.readFileSync(path.join(root, "test-policy", "last-qualified.json"), "utf8"));
  assert.deepEqual([last.commit, last.tree, last.stage], ["c0ffee", "7ree", "nightly"], "a passing qualifying run becomes the last-qualified record");
  assert.ok(fs.readFileSync(path.join(root, "test-policy", "schedule-decisions.ndjson"), "utf8").includes("no previous successful full run"), "every scheduled decision is recorded");
  const skipped = cmd("run", ["--stage", "nightly", "--last-qualified", history]);
  assert.deepEqual([skipped.result, skipped.decision.decision], ["skipped", "skip"], "a skipped scheduled run records its reason and fails nothing");
  assert.equal(runs.length, 1, "a skip runs no check");
  assert.deepEqual([runs[0].history, runs[0].outDir], [[{ id: "full-suite", result: "fail" }], path.join(root, "o")]);
  assert.throws(() => cmd("run", ["--stage", "staging"]), /test-policy run failed at stage staging: full-suite/);
  assert.match(runs[1].outDir, /test-policy[/\\]staging-\d+$/);
  assert.deepEqual(runs[1].history, []);
  const full = path.join(root, "full.json");
  fs.writeFileSync(full, JSON.stringify({ results: [] }));
  assert.deepEqual(cmd("compare", ["--full-report", full, "--base", "HEAD"]).failures, []);
  assert.match(logs.find((l) => /full-suite=fail/.test(l)), /full-suite=fail\(consistent\)/);
  const real = tpr.createTestPolicyCommands({ root, fail, log: () => {}, env: {}, ledgerDir: path.join(root, "ledger"), readBoard: () => ({ metadata: {} }) });
  fs.mkdirSync(path.join(root, "coord", "engine"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "engine", "unmapped.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(root, "release"));
  fs.writeFileSync(path.join(root, "release", "build-public-release.sh"), "#!/bin/sh\nexit 0\n");
  const direct = tpr.createTestPolicyCommands({ root, fail, log: () => {}, env: {}, readBoard: () => ({ metadata: {} }) });
  const conservative = direct("resolve", ["--stage", "pr", "--base", "HEAD"]);
  assert.equal(conservative.decision, "full");
  assert.match(conservative.reasons.join("; "), /selection-fallback/);
  fs.writeFileSync(full, JSON.stringify({ results: [{ module: "core", exit_code: 1, failing_tests: ["t"] }], inventory: [] }));
  const inventory = path.join(root, "inv.json");
  fs.writeFileSync(inventory, JSON.stringify({ editions: {} }));
  const compared = real("compare", ["--full-report", full, "--base", "HEAD", "--selected-report", full, "--inventory", inventory]);
  assert.deepEqual([compared.gate, compared.failures.map((f) => [f.test, f.kind])], ["full", [["t", "caught"]]], "the real comparison records through COORD-924 and classifies");
  for (const [argv, pattern] of [[["nope"], /requires a subcommand: show \| resolve \| run \| except \| compare/], [["resolve"], /requires --stage/], [["resolve", "--bogus", "1"], /unknown or valueless argument --bogus/],
    [["compare", "--base", "HEAD"], /requires --full-report/], [["compare", "--full-report", path.join(root, "none.json"), "--base", "HEAD"], /unreadable full report/]]) {
    assert.throws(() => cmd(argv[0], argv.slice(1)), pattern);
  }
  assert.deepEqual(tpr.parseArgs(["--add", "a", "--add", "b", "--reduce", "c"]), { json: false, add: ["a", "b"], reduce: ["c"] });
});

test("COORD-936: gov test-policy runs through the real CLI dispatch", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("coord936-cli-", {}, () => {
    const shown = executeCommand(["test-policy", "show"]);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.match(String(shown.stdout), /operating mode: runnable-now; landing gates active/);
    const product = executeCommand(["test-policy", "resolve", "--stage", "pr", "--repo", "B"]);
    assert.match(String(product.stdout), /scopes: product:B/);
    const ticketed = executeCommand(["test-policy", "resolve", "--stage", "pr", "--ticket", "MSRV-1"]);
    assert.match(String(ticketed.stdout), /execution: policy/, "a ticket with no exception on the board runs under policy");
    assert.match(String(executeCommand(["test-policy", "except", "--add", "x"]).error), /requires --ticket/);
    const noSubmission = executeCommand(["test-policy", "except", "--ticket", "COORD-990", "--base", "HEAD", "--add", "perf=true", "--human-admin-override", "release candidate"]);
    assert.match(String(noSubmission.error), /No active claimed agent session/, "an exception is recorded by a bound session, never anonymously");
  });
});

// COORD-974: gov test-policy resolve feeds the board landings and the last passing full run to the triggers.
test("COORD-974: resolve counts the board landings since the last passing full run and reports the counter", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord974-resolve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "test-policy");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "last-qualified.json"), JSON.stringify({ commit: "c0", at: "2026-11-15T00:00:00.000Z" }));
  const landing_index = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`COORD-${i}`, { recorded_at: i < 10 ? "2026-11-14T00:00:00.000Z" : "2026-11-16T00:00:00.000Z" }]));
  const logs = [];
  const cmd = tpr.createTestPolicyCommands({ root, fail: (m) => { throw new Error(m); }, log: (x) => logs.push(x), env: {}, ledgerDir: path.join(root, "ledger"),
    readBoard: () => ({ metadata: {}, landing_index }) });
  const plan = cmd("resolve", ["--stage", "pr", "--json"]);
  assert.deepEqual([plan.full_suite_triggers.counter.landed_since, plan.full_suite_triggers.counter.fired, plan.full_suite_triggers.fired], [2, false, []],
    "only the two landings after the last passing full run count");
  cmd("resolve", ["--stage", "pr"]);
  assert.match(logs.at(-1), /full-suite triggers: none fired/);
  fs.writeFileSync(path.join(runtime, "last-qualified.json"), JSON.stringify({ commit: "c1", at: "2026-11-13T00:00:00.000Z" }));
  const reached = cmd("resolve", ["--stage", "pr", "--json"]);
  assert.deepEqual([reached.full_suite_triggers.counter.landed_since, reached.full_suite_triggers.fired], [12, ["counter"]]);
});

// COORD-1036: `gov test-policy promotion-manifest --dry-run` resolves the edge's gates at HEAD through
// the subcommand and writes nothing (a dry run never runs a gate or touches a remote).
test("promotion-manifest subcommand: a dry run resolves the edge gates at the commit and writes nothing", (t) => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const out = tmp(t, "promotion-manifest-dry-");
  const outFile = path.join(out, "manifest.json");
  const logs = [];
  const cmd = tpr.createTestPolicyCommands({ root, fail: (message) => { throw new Error(message); }, log: (text) => logs.push(text) });
  const result = cmd("promotion-manifest", ["--edge", "staging->main", "--commit", "HEAD", "--out", outFile, "--dry-run"]);
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.plan.gates.map((g) => [g.gate, g.lane]), [["full-suite-node22", "node22"], ["full-suite-node24", "node24"], ["coverage-ratchet", "node22"]]);
  assert.equal(fs.existsSync(outFile), false);
});

test("promotion-manifest subcommand refuses a measured red gate and retains bound evidence", (t) => {
  const root = repo(t);
  const out = path.join(tmp(t, "coord-policy-red-promotion-"), "manifest.json");
  const policyDir = path.join(root, "coord", "engine");
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, "test-policy.json"), JSON.stringify({
    promotion_edges: { "dev->staging": { gates: ["fixture-gate"] } },
  }));
  fs.writeFileSync(path.join(root, "red-gate.js"), "process.exitCode = 17;\n");
  const { gitFixture } = require("./test-git-fixture.js");
  gitFixture(root, ["add", "."]);
  gitFixture(root, ["commit", "-qm", "Fixture red gate"]);
  const promote = require("./promote.js");
  const produce = promote.produceGateManifest;
  t.mock.method(promote, "produceGateManifest", (options, deps) => produce(options, {
    ...deps, nodeBinDir: { node22: path.dirname(process.execPath) },
    gateRuns: { "fixture-gate": { lane: "node22", argv: ["red-gate.js"] } },
  }));
  const events = [], logs = [];
  const command = tpr.createTestPolicyCommands({ root, log: (text) => logs.push(text),
    fail: (message) => { throw new Error(message); }, appendGovernanceEvent: (event) => events.push(event) });
  assert.throws(() => command("promotion-manifest", ["--edge", "dev->staging", "--commit", "HEAD", "--out", out]),
    /promotion-manifest recorded red gate\(s\) fixture-gate/);
  const result = JSON.parse(logs.at(-1));
  assert.equal(result.runs["fixture-gate"].exit_code, 17);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).gates, { "fixture-gate": "fail" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].details.gates, { "fixture-gate": "fail" });
});

test("COORD-1052: compare-sharding records matching evidence and keeps a later suspension sticky", (t) => {
  const root = repo(t), out = tmp(t, "coord-policy-compare-");
  const board = { metadata: {} }, transactions = [], logs = [];
  const governance = require("./test-sharding-governance.js");
  const common = {
    schema_version: 1, tool: "coord/scripts/test-runner.js", workspace_root: root,
    suite_result: "pass", result: "pass",
    inventory: [{ name: "engine", files: ["coord/engine/example.test.js"] }],
    results: [{ module: "engine", files: ["coord/engine/example.test.js"], test_outcomes: [{ identity: "example passes", outcome: "pass" }] }],
    engine_coverage: { measurement: { totals: { lines: 100, branches: 100, functions: 100 }, files: {} }, ratchet: { result: "pass", new_uncovered: [] } },
  };
  function writePair(name, sharded, outcome = "pass") {
    const report = { ...common, result: sharded ? "provisional" : "pass",
      results: [{ ...common.results[0], test_outcomes: [{ identity: "example passes", outcome }] }],
      ...(sharded ? { qualification: "provisional; donor receipt required",
        argv: ["--shards", "2", "--qualification-stage", "release", "--policy-stage", "release", "--qualification-mode", "full"],
        shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] } : { shards: null }) };
    const reportPath = path.join(out, `${name}.report.json`), manifestPath = path.join(out, `${name}.manifest.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const manifest = runManifest.finalizeManifest(runManifest.buildManifest({ tool: "coord/scripts/test-runner.js",
      inputs: runManifest.collectInputs({ root }).inputs, host: { tmpdir: "/tmp", tmpdir_realpath: "/tmp", kernel: "Linux" },
      lanes: [{ name, exit_code: 0, signal: null, duration_ms: 1 }] }), [reportPath]);
    runManifest.writeManifest(manifestPath, manifest);
    return [reportPath, manifestPath];
  }
  const serial = writePair("serial", false), sharded = writePair("sharded", true), changed = writePair("changed", true, "fail");
  const command = tpr.createTestPolicyCommands({ root, fail: (message) => { throw new Error(message); }, log: (text) => logs.push(text),
    readBoard: () => board,
    withBoardTransaction: (metadata, operation) => { transactions.push(metadata); return operation({ board }); },
    writeBoard: (updated) => assert.equal(updated, board) });
  const args = (pair) => ["--serial-report", serial[0], "--serial-manifest", serial[1], "--sharded-report", pair[0], "--sharded-manifest", pair[1]];
  const match = command("compare-sharding", args(sharded));
  assert.equal(match.matched, true);
  assert.equal(match.suspension_active, false);
  assert.equal(transactions[0].command, "test-sharding-compare");
  assert.equal(governance.authorityState(board).allowed, true);
  assert.throws(() => command("compare-sharding", args(changed)), /mismatch recorded and sharding suspended/);
  assert.equal(governance.authorityState(board).allowed, false);
  const later = command("compare-sharding", args(sharded));
  assert.equal(later.matched, true);
  assert.equal(later.suspension_active, true, "matching evidence must not silently reinstate suspended sharding");
  assert.equal(transactions.length, 3);
  assert.ok(logs.some((text) => text.includes("test_identity_outcome")));
});

test("COORD-1052: compare-sharding refuses active operations and records unreadable evidence as a suspension", (t) => {
  const root = repo(t), out = tmp(t, "coord-policy-refuse-");
  const board = { metadata: {} }, writes = [];
  let integration = { operation: { id: "running" } };
  const command = tpr.createTestPolicyCommands({ root, fail: (message) => { throw new Error(message); }, log: () => {},
    readBoard: () => board, readIntegrationRecord: () => integration,
    withBoardTransaction: (metadata, operation) => { writes.push(metadata); return operation({ board }); }, writeBoard: () => {} });
  assert.throws(() => command("compare-sharding", []), /requires --serial-report/);
  const args = ["--serial-report", path.join(out, "serial.json"), "--serial-manifest", path.join(out, "serial.manifest.json"),
    "--sharded-report", path.join(out, "sharded.json"), "--sharded-manifest", path.join(out, "sharded.manifest.json")];
  assert.throws(() => command("compare-sharding", args), /active integration operation/);
  assert.equal(writes.length, 0);
  integration = null;
  assert.throws(() => command("compare-sharding", args), /mismatch recorded and sharding suspended/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].details.matched, false);
  assert.equal(writes[0].details.mismatches[0].field, "comparison_evidence");
  assert.equal(require("./test-sharding-governance.js").authorityState(board).allowed, false);
});

test("COORD-1052: shard receipt CLI refuses wrong stages and missing evidence without creating output", (t) => {
  const root = repo(t), out = tmp(t, "coord-policy-receipt-");
  fs.mkdirSync(path.join(root, "coord", "engine"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../test-policy.json"), path.join(root, "coord", "engine", "test-policy.json"));
  const receipt = path.join(out, "receipt.json");
  const command = tpr.createTestPolicyCommands({ root, fail: (message) => { throw new Error(message); }, log: () => {},
    readBoard: () => ({ metadata: {} }), readJournalEvents: () => [] });
  assert.throws(() => command("verify-shard-result", ["--stage", "pr"]), /requires --stage release/);
  assert.throws(() => command("verify-shard-result", ["--stage", "release"]), /requires --report, --manifest/);
  assert.throws(() => command("verify-shard-result", ["--stage", "release", "--report", path.join(out, "missing.json"),
    "--manifest", path.join(out, "missing-manifest.json"), "--skip-log-dir", path.join(out, "skips"), "--receipt-out", receipt]));
  assert.equal(fs.existsSync(receipt), false);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("COORD-1052: full sharded promotion becomes qualified only after receipt and manifest publication", (t) => {
  const root = repo(t);
  const out = tmp(t, "coord-policy-sharded-promotion-");
  fs.mkdirSync(path.join(root, "coord", "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../test-policy.json"), path.join(root, "coord", "engine", "test-policy.json"));
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), JSON.stringify({ metadata: {} }));
  fs.writeFileSync(path.join(root, "release", "build-public-release.sh"), "#!/usr/bin/env bash\nexit 0\n");
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "donor policy fixture"], { cwd: root }).status, 0);

  const suite = "coord/engine/example.test.js";
  const runnerReportPath = path.join(out, "runner-report.json");
  const runnerManifestPath = path.join(out, "runner.manifest.json");
  const outputManifestPath = path.join(out, tpr.MANIFEST);
  const { inputs, host } = runManifest.collectInputs({ root, env: {}, gateConfig: { shards: "2" } });
  const runnerReport = {
    schema_version: 1,
    tool: "coord/scripts/test-runner.js",
    workspace_root: root,
    argv: ["--engine-coverage", "--shards", "2", "--qualification-stage", "promotion", "--policy-stage", "promotion", "--qualification-mode", "full"],
    suite_result: "pass",
    result: "provisional",
    qualification: "provisional; donor receipt required",
    inventory: [{ name: "core", files: [suite] }],
    results: [{ module: "core", files: [suite], failing_tests: [], test_outcomes: [{ identity: `${suite} > example passes`, outcome: "pass" }] }],
    shards: [{ id: 1, result: "pass", assigned: [suite] }],
    engine_coverage: { measurement: { totals: { lines: { found: 1, hit: 1 }, branches: { found: 1, hit: 1 }, functions: { found: 1, hit: 1 } } },
      ratchet: { result: "pass", new_uncovered: [] } },
  };
  runnerReport.run_manifest = { path: runnerManifestPath };

  const initialReport = { result: "provisional", results: [{ id: "engine-suites", kind: "runner", result: "pass", report: runnerReportPath }],
    metrics: { feedback_ms: 1 } };
  const initialManifest = runManifest.buildManifest({ tool: "gov test-policy run", inputs, host,
    lanes: [{ name: "engine-suites", exit_code: 0, signal: null, duration_ms: 1 }], qualification: "provisional" });
  const chain = require("./journal-chain.js");
  const event = chain.buildChainAnchorEvent("fixture current donor event");
  const laterEvent = { ...event, command: "test-sharding-compare", prev_event_hash: chain.hashGovernanceEventRecord(event) };
  let events = [event];
  let appendBetweenReads = false;
  const calls = [];
  let suspendOnVerification = false;
  let invalidPolicyManifest = false;
  let boardReads = 0;
  const options = {
    root,
    fail: (message) => { throw new Error(message); },
    log: (text) => calls.push({ log: text }),
    env: {},
    ledgerDir: path.join(root, "coord", ".runtime", "ledger"),
    readBoard: () => suspendOnVerification && ++boardReads > 1
      ? { metadata: { test_sharding: { suspension: { active: true, reason: "late comparison mismatch" } } } }
      : { metadata: {} },
    run: (options) => {
      boardReads = 0;
      calls.push({ stage: options.plan.stage, base_stage: options.plan.base_stage, shards: options.shards });
      if (options.outDir === out) {
        const ran = tpr.runPlan({ ...options, inventory: INVENTORY, spawn: (argv) => {
          assert.equal(argv[argv.indexOf("--report") + 1], runnerReportPath);
          assert.equal(argv[argv.indexOf("--manifest") + 1], runnerManifestPath);
          fs.writeFileSync(runnerReportPath, `${JSON.stringify(runnerReport, null, 2)}\n`);
          const runnerManifest = runManifest.finalizeManifest(runManifest.buildManifest({
            tool: "coord/scripts/test-runner.js", inputs, host,
            plan: { shards: [{ lane: "core", files: [suite] }], selection: null },
            lanes: [{ name: "core", exit_code: 0, signal: null, duration_ms: 1 }],
            qualification: "provisional",
          }), [runnerReportPath]);
          runManifest.writeManifest(runnerManifestPath, runnerManifest);
          return { exit_code: 2, signal: null, duration_ms: 1, timed_out: false };
        } });
        const provisional = JSON.parse(fs.readFileSync(ran.reportFile, "utf8"));
        assert.equal(provisional.result, "provisional");
        const runner = provisional.results.find((result) => result.kind === "runner" && result.report);
        assert.equal(runner?.report, runnerReportPath);
        return ran;
      }
      const report = structuredClone(initialReport);
      const reportFile = path.join(options.outDir, tpr.REPORT);
      const manifestFile = path.join(options.outDir, tpr.MANIFEST);
      fs.writeFileSync(reportFile, JSON.stringify(report));
      const manifest = runManifest.finalizeManifest(initialManifest, [reportFile]);
      if (invalidPolicyManifest) manifest.input_digest = `sha256:${"0".repeat(64)}`;
      runManifest.writeManifest(manifestFile, manifest);
      return { report, manifest, manifestFile };
    },
  };
  const command = tpr.createTestPolicyCommands({ ...options, readJournalEvents: () => {
    const snapshot = events;
    if (appendBetweenReads) {
      events = [...snapshot, laterEvent];
      appendBetweenReads = false;
    }
    return snapshot;
  } });

  const completed = command("run", ["--stage", "promotion", "--shards", "2", "--out", out]);
  const receiptPath = path.join(out, "shard-authority-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const publishedReport = JSON.parse(fs.readFileSync(path.join(out, tpr.REPORT), "utf8"));
  const publishedManifest = JSON.parse(fs.readFileSync(outputManifestPath, "utf8"));
  assert.deepEqual(calls.find((entry) => entry.shards), { stage: "promotion", base_stage: "promotion", shards: "2" });
  assert.equal(completed.result, "pass");
  assert.equal(completed.qualification, "donor receipt verified");
  assert.equal(completed.metrics.sharding.authority, "donor receipt verified");
  assert.equal(publishedReport.results[0].report, runnerReportPath);
  assert.equal(publishedReport.authority_receipt.sha256, receipt.receipt_digest);
  assert.equal(receipt.stage, "promotion");
  assert.equal(receipt.qualification_mode, "full");
  assert.equal(publishedManifest.result, "pass");
  assert.deepEqual(publishedManifest.artifacts.map((artifact) => artifact.path).sort(), [path.join(out, tpr.REPORT), receiptPath].sort());
  assert.equal(publishedManifest.artifacts.find((artifact) => artifact.path === receiptPath).sha256,
    `sha256:${require("node:crypto").createHash("sha256").update(fs.readFileSync(receiptPath)).digest("hex")}`);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);

  const lastQualified = path.join(root, "coord", ".runtime", "test-policy", "last-qualified.json");
  const checkpoint = fs.readFileSync(lastQualified);
  const failedOut = tmp(t, "coord-policy-revoked-receipt-");
  const assertStillProvisional = () => {
    assert.deepEqual(fs.readdirSync(failedOut).sort(), [tpr.REPORT, tpr.MANIFEST].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(failedOut, tpr.REPORT), "utf8")), initialReport);
    assert.equal(JSON.parse(fs.readFileSync(path.join(failedOut, tpr.MANIFEST), "utf8")).result, "provisional");
    assert.deepEqual(fs.readFileSync(lastQualified), checkpoint);
  };
  suspendOnVerification = true;
  assert.throws(() => command("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]), /late comparison mismatch/);
  assertStillProvisional();

  const noJournal = tpr.createTestPolicyCommands(options);
  suspendOnVerification = false;
  assert.throws(() => noJournal("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]), /no current event to bind/);
  assertStillProvisional();

  invalidPolicyManifest = true;
  assert.throws(() => command("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]), /invalid policy run manifest/);
  assertStillProvisional();

  invalidPolicyManifest = false;
  appendBetweenReads = true;
  assert.throws(() => command("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]),
    /stale or mismatched: journal_head_digest/);
  assertStillProvisional();

  const read = fs.readFileSync;
  const loseReceipt = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (typeof file === "string" && file.startsWith(failedOut + path.sep) && path.basename(file) === "shard-authority-receipt.json") {
      fs.unlinkSync(file);
    }
    return read(file, ...args);
  });
  try {
    assert.throws(() => command("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]),
      /donor sharded-plan manifest invalid.*shard-authority-receipt\.json was not produced/);
    assertStillProvisional();
  } finally {
    loseReceipt.mock.restore();
  }

  assert.equal(command("run", ["--stage", "promotion", "--shards", "2", "--out", failedOut]).result, "pass");
  const retriedReceipt = JSON.parse(fs.readFileSync(path.join(failedOut, "shard-authority-receipt.json"), "utf8"));
  assert.equal(retriedReceipt.journal_head_digest, chain.hashGovernanceEventRecord(laterEvent));
  const retriedManifest = JSON.parse(fs.readFileSync(path.join(failedOut, tpr.MANIFEST), "utf8"));
  assert.deepEqual(runManifest.validateManifest(retriedManifest), []);
});

test("COORD-1052: provisional sharded execution without bound runner artifacts cannot become qualified", (t) => {
  const root = repo(t);
  for (const missing of ["runner", "manifest"]) {
    const out = tmp(t, "coord1052-incomplete-shard-");
    const runnerPath = path.join(out, "runner.json");
    if (missing === "manifest") fs.writeFileSync(runnerPath, JSON.stringify({ result: "provisional" }));
    const provisional = { result: "provisional", results: missing === "runner" ? [] : [{ kind: "runner", report: runnerPath }] };
    const command = tpr.createTestPolicyCommands({ root, env: {}, ledgerDir: path.join(out, "ledger"),
      fail: (message) => { throw new Error(message); }, log: () => {}, readBoard: () => ({ metadata: {} }),
      run: () => ({ report: provisional, manifest: {}, manifestFile: path.join(out, "policy.manifest.json") }),
    });
    assert.throws(() => command("run", ["--stage", "promotion", "--shards", "2", "--out", out]), /runner report or manifest is missing/);
    assert.equal(provisional.result, "provisional");
    assert.equal(fs.existsSync(path.join(out, "shard-authority-receipt.json")), false);
    assert.equal(fs.existsSync(path.join(out, "policy.manifest.json")), false);
    assert.equal(fs.existsSync(path.join(out, tpr.REPORT)), false, "no promoted passing report is manufactured from incomplete evidence");
  }
});
