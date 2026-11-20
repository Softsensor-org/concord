"use strict";

// COORD-924/941: risk-based selection at landing and its evidence loop. POLICY
// below is an active policy; the explicit SHADOW rollback case stays tested.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const landing = require("./affected-landing.js");
const governed = require("./affected-state.js");
const { initRepo, git } = require("./affected-evaluation.js");
const fixtures = require("./__fixtures__/affected-selection-faults.js");
const createGates = require("./gates.js");

const E = "coord/engine/scripts/";
const POLICY = { ...fixtures.policy, policy_version: 1, initial_state: "active", always_required_suites: [`${E}owner.test.js`, `${E}not-shipped.test.js`] };

function workspace(t) {
  const root = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), "coord924-landing-")), {
    ...fixtures.repo, "coord/engine/governance-guards.json": JSON.stringify(fixtures.registry), "coord/board/tasks.json": "{ \"metadata\": {} }\n",
  });
  const base = git(root, ["rev-parse", "HEAD"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-landing-out-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  const boardPath = path.join(out, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({ metadata: {} }));
  return { root, base, out, ledgerDir: path.join(out, "ledger"), boardPath };
}

function change(root, rel, text, message = `edit ${rel}`) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
}

const passingRun = (exit = 0) => (root, suites, reportPath) => {
  fs.writeFileSync(reportPath, JSON.stringify({ result: exit ? "fail" : "pass", suites }));
  return { exit_code: exit, signal: null, duration_ms: 5 };
};

// What `gov selection suspend` writes: the governed board state.
function suspendOnBoard(w, categories) {
  const meta = governed.withSuspension({ suspended_categories: {}, resolutions: [], policy_version: 1 }, { categories, reason: "missed", ref: "COORD-999", policyVersion: 1, now: "n" });
  fs.writeFileSync(w.boardPath, JSON.stringify({ metadata: { affected_selection: meta } }));
}

function selectedRun(w, extra = {}) {
  return landing.runSelectedForLanding({ root: w.root, base: w.base, outDir: w.out, boardPath: w.boardPath, policy: POLICY, run: passingRun(), env: {}, ...extra });
}

const readManifest = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const verify = (w, file, extra = {}) => landing.verifyLandingEvidence({ root: w.root, manifest: readManifest(file), base: w.base, policy: POLICY, boardPath: w.boardPath, ...extra });

test("COORD-924: a T0/T1 selected-suite run with a valid manifest is accepted as repo-gate evidence", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.js`, "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => b * a;\n");
  const run = selectedRun(w);
// COORD-953: widened, suites reaching unresolved dynamic loads are added (human-admin decision 2026-11-12); COORD-966: loader and shim no longer have an unresolved site (fmt.js:2 is a literal spec)
  assert.deepEqual(run.gate.suites, [`${E}math.test.js`, `${E}owner.test.js`, `${E}plugins.test.js`, `${E}report.test.js`], "selected plus always-required suites that ship");
  const manifest = readManifest(run.file);
  assert.equal(manifest.plan.selection.mode, "landing");
  assert.equal(manifest.plan.selection.policy_version, 1);
  const verdict = verify(w, run.file);
  assert.deepEqual([verdict.ok, verdict.refusals, verdict.tier], [true, [], "T1"]);
  assert.match(landing.repoGateEntry(run.file, verdict), /^affected-selection run .* - result=pass tier=T1 suites=4 tree=[0-9a-f]{40} base=[0-9a-f]{40} input_digest=sha256:/);
  const { entry, refusal } = createGates.verifySelectionEvidence({ manifestPath: run.file, base: w.base, root: w.root, policy: POLICY, boardPath: w.boardPath });
  assert.deepEqual([Boolean(entry), refusal], [true, null]);
});

test("COORD-924: in shadow a T0/T1 landing still requires the full gate while the selection is recorded", (t) => {
  const w = workspace(t);
  const SHADOW = { ...POLICY, initial_state: "shadow" };
  change(w.root, `${E}math.js`, "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => b * a;\n");
  const { selection, state, gate, wouldGate } = landing.landingGateFor({ root: w.root, base: w.base, policy: SHADOW, boardPath: w.boardPath });
  assert.deepEqual([state.state, selection.decision, selection.tier], ["shadow", "selected", "T1"]);
  assert.deepEqual([gate.gate, gate.tier], ["full", "T1"]);
  assert.match(gate.reason, /^affected selection is shadow \(.+\); the full gate is required$/);
// COORD-953: widened, suites reaching unresolved dynamic loads are added (human-admin decision 2026-11-12)
  assert.deepEqual([wouldGate.gate, wouldGate.suites], ["affected", [`${E}math.test.js`, `${E}owner.test.js`, `${E}plugins.test.js`, `${E}report.test.js`]], "what an active selection would run");
  assert.throws(() => selectedRun(w, { policy: SHADOW }), /refusing a selected-suite run: the full gate is required \(affected selection is shadow/);
  const activeRun = selectedRun(w);
  const refused = verify(w, activeRun.file, { policy: SHADOW });
  assert.equal(refused.ok, false, "selected-suite evidence never replaces the full gate in shadow");
  assert.match(refused.refusals.join("\n"), /affected selection is shadow/);
  const inventory = path.join(w.out, "inventory.json");
  fs.writeFileSync(inventory, JSON.stringify({ editions: { Community: { tests: { [`${E}math.test.js`]: [["math: add"]], [`${E}limits.test.js`]: [["limits: the configured limit"]] } } } }));
  const full = { node_version: "v22.8.0", result: "fail", results: [{ module: "core", failing_tests: ["math: add", "limits: the configured limit"] }] };
  const line = landing.compareFullRun({ root: w.root, base: w.base, fullReport: full, ledgerDir: w.ledgerDir, boardPath: w.boardPath, inventoryFile: inventory, policy: SHADOW, now: "2026-11-07T00:00:00.000Z" });
  assert.deepEqual([line.gate, line.state, line.would_run, line.missed], ["full", "shadow", wouldGate.suites, ["limits: the configured limit"]], "the nightly loop records what selection would have run and missed");
  const plan = require("./gate-plan.js").landingGateSummary({ base: w.base, root: w.root, boardPath: w.boardPath, landing: { landingGateFor: (args) => landing.landingGateFor({ ...args, policy: SHADOW }) } });
  assert.deepEqual([plan.gate, plan.would_gate, plan.would_suites], ["full", "affected", wouldGate.suites], "the gate-plan receipt records the selection");
});

test("COORD-941: a shadow rollback overrides active board state with any recorded version", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.test.js`, `${fixtures.repo[`${E}math.test.js`]}// test edit\n`);
  const rollback = { ...POLICY, policy_version: 3, initial_state: "shadow" };
  for (const policyVersion of [2, 3, undefined]) {
    fs.writeFileSync(w.boardPath, JSON.stringify({ metadata: { affected_selection: {
      state: "active", ...(policyVersion === undefined ? {} : { policy_version: policyVersion }),
      suspended_categories: { "engine-module": { reason: "prior miss" } }, resolutions: [],
    } } }));
    const state = governed.readSelectionState({ root: w.root, boardPath: w.boardPath, policy: rollback });
    assert.equal(state.state, "shadow", `board policy version ${policyVersion} cannot override the rollback policy`);
    assert.deepEqual(state.suspended_categories, { "engine-module": { reason: "prior miss" } }, "rollback preserves suspensions");
    const gate = landing.landingGateFor({ root: w.root, base: w.base, policy: rollback, boardPath: w.boardPath }).gate;
    assert.deepEqual([gate.gate, gate.tier], ["full", "T0"]);
  }
});

test("COORD-941: the fresh PR policy manifest is accepted only with its docs and mandatory checks", (t) => {
  const evalTools = require("./affected-evaluation.js");
  const testPolicy = require("./test-policy.js");
  const policyRunner = require("./test-policy-run.js");
  const selector = require("./affected-selector.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord941-policy-evidence-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "coord941-policy-output-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  const docsSuite = "coord/scripts/documented-gov-verbs.test.js";
  evalTools.initRepo(root, {
    ...fixtures.repo,
    "coord/engine/governance-guards.json": JSON.stringify(fixtures.registry),
    "coord/engine/shim-registry.json": JSON.stringify(fixtures.shimRegistry),
    "coord/board/tasks.json": JSON.stringify({ metadata: {} }),
    "coord/project.config.js": "module.exports = { limit: 3, testPolicy: { stageMap: { feature: 'pr' }, stages: { feature: { checks: [{ id: 'lint-check', command: ['node', '-e', 'process.exit(0)'], scope: 'engine' }] } } } };\n",
    "release/build-public-release.sh": "#!/bin/sh\nexit 0\n",
    [docsSuite]: "const test = require('node:test'); test('doc guard', () => {});\n",
  });
  const { policy, config } = testPolicy.loadTestPolicy({ root, env: {} });
  const base = git(root, ["rev-parse", "HEAD"]);
  change(root, "coord/engine/docs/guide.md", "# changed guide\n");
  const plan = testPolicy.resolveStage({ root, stage: "feature", base, policy, config, landingGateFor: landing.landingGateFor });
  assert.equal(plan.decision, "selected");
  assert.equal(plan.base_stage, "pr", "a configured adopter stage alias keeps PR landing eligibility");
  assert.ok(plan.checks.some((check) => check.id === "docs-checks" && check.suites.includes(docsSuite)));
  const spawn = (argv) => {
    if (argv.includes("--report")) fs.writeFileSync(argv[argv.indexOf("--report") + 1], JSON.stringify({
      result: "pass", totals: { tests: 1 }, results: [{ module: "fixture", exit_code: 0, failing_tests: [] }], engine_coverage: null,
    }));
    return { exit_code: 0, signal: null, duration_ms: 3, timed_out: false, error: null };
  };
  const ran = policyRunner.runPlan({ root, plan, policy, outDir: out, spawn, env: {} });
  const accepted = createGates.verifySelectionEvidence({ manifestPath: ran.manifestFile, base, root,
    policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
  assert.ok(accepted.entry, accepted.refusal || "policy receipt should pass through the existing repo-gate verifier");
  const recorded = [];
  const addGate = createGates({ ticketRow: (ticketId) => ({ ID: ticketId }),
    resolveTicketGitContext: (row, ticketId) => { assert.equal(row.ID, ticketId); assert.equal(ticketId, "COORD-941"); return { worktree: root }; },
    updatePlanBlock: (ticketId, block) => recorded.push([ticketId, block]), fail: (message) => { throw new Error(message); } });
  addGate.addRepoGateCommand("COORD-941", { selectionManifest: ran.manifestFile, base });
  assert.match(recorded[0][1].repoGate[0], /^affected-selection run .* - result=pass tier=T0/,
    "add-repo-gate resolves the ticket worktree and records the policy runner manifest through the existing verifier");
  assert.equal(ran.manifest.plan.selection.mode, "landing");
  const incomplete = JSON.parse(JSON.stringify(ran.manifest));
  incomplete.plan.shards.forEach((shard) => { shard.files = shard.files.filter((file) => file !== docsSuite); });
  const incompletePath = path.join(out, "missing-doc-check.manifest.json");
  fs.writeFileSync(incompletePath, JSON.stringify(incomplete));
  const refused = createGates.verifySelectionEvidence({ manifestPath: incompletePath, base, root,
    policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
  assert.match(refused.refusal, /did not cover|required suites/);
  const missingCommand = JSON.parse(JSON.stringify(ran.manifest));
  missingCommand.lanes = missingCommand.lanes.filter((lane) => lane.name !== "lint-check");
  const missingCommandPath = path.join(out, "missing-policy-command.manifest.json");
  fs.writeFileSync(missingCommandPath, JSON.stringify(missingCommand));
  const commandRefused = createGates.verifySelectionEvidence({ manifestPath: missingCommandPath, base, root,
    policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
  assert.match(commandRefused.refusal, /omitted required checks: lint-check/);
  const legacyReceipt = JSON.parse(JSON.stringify(ran.manifest));
  legacyReceipt.tool = "affected-selection run-selected";
  const legacyPath = path.join(out, "legacy-selected.manifest.json");
  fs.writeFileSync(legacyPath, JSON.stringify(legacyReceipt));
  const legacyRefused = createGates.verifySelectionEvidence({ manifestPath: legacyPath, base, root,
    policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
  assert.match(legacyRefused.refusal, /active stage policy requires a fresh gov test-policy run receipt/,
    "the old selected-only runner cannot bypass active mandatory policy checks");
  const refusesChangedReceipt = (mutate, expected) => {
    const changed = structuredClone(ran.manifest);
    mutate(changed);
    // Keep the synthetic receipt structurally valid so the semantic policy
    // checks, rather than the checksum check, must reject the changed claims.
    changed.input_digest = require("./run-manifest.js").digestOf(changed.inputs);
    const verdict = landing.verifyLandingEvidence({ root, manifest: changed, base,
      policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
    assert.equal(verdict.ok, false);
    assert.match(verdict.refusals.join("; "), expected);
  };
  refusesChangedReceipt((m) => { m.inputs.gate_config.test_policy.base_stage = "promotion"; }, /only a fresh developer or PR/);
  refusesChangedReceipt((m) => { delete m.inputs.gate_config.test_policy; }, /only a fresh developer or PR/);
  refusesChangedReceipt((m) => { m.inputs.gate_config.test_policy.stage = "nightly"; }, /full qualification/);
  refusesChangedReceipt((m) => { m.inputs.gate_config.test_policy.exceptions = [{ id: "unvalidated-exception" }]; }, /exception-bearing policy runs require/);
  refusesChangedReceipt((m) => { m.inputs.gate_config.test_policy.policy_digest = "different-policy"; }, /does not match the current developer\/PR/);
  refusesChangedReceipt((m) => { delete m.plan.selection.test_policy; }, /does not carry the current selected landing policy receipt/);
  refusesChangedReceipt((m) => { m.lanes[0].exit_code = 1; m.result = "fail"; }, /did not pass every fresh check/);
  refusesChangedReceipt((m) => { m.lanes = m.lanes.filter((lane) => lane.name !== "engine-suites"); }, /omitted its fresh engine-suite lane/);
  refusesChangedReceipt((m) => { delete m.plan.shards[0].files; }, /manifest invalid:.*files/);
  // A real governance suspension overrides an earlier green policy receipt.
  const boardPath = path.join(root, "coord/board/tasks.json");
  const suspended = governed.withSuspension({ suspended_categories: {}, resolutions: [], policy_version: policy.policy_version },
    { categories: [], reason: "confirmed missed regression", ref: "COORD-941", policyVersion: policy.policy_version, now: "fixture-time" });
  fs.writeFileSync(boardPath, JSON.stringify({ metadata: { affected_selection: suspended } }));
  const suspendedVerdict = landing.verifyLandingEvidence({ root, manifest: ran.manifest, base,
    policy: selector.loadPolicy(), boardPath });
  assert.equal(suspendedVerdict.ok, false);
  assert.match(suspendedVerdict.refusals.join("; "), /full gate is required: selection is suspended/);
});

test("COORD-941: an installed-workspace policy receipt without an engine selection gets a clear full-gate refusal", (t) => {
  const evalTools = require("./affected-evaluation.js");
  const testPolicy = require("./test-policy.js");
  const policyRunner = require("./test-policy-run.js");
  const selector = require("./affected-selector.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord941-workspace-policy-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "coord941-workspace-output-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  evalTools.initRepo(root, { ...fixtures.repo, README: "# workspace\n", "coord/board/tasks.json": JSON.stringify({ metadata: {} }) });
  const base = git(root, ["rev-parse", "HEAD"]);
  change(root, "README", "# workspace change\n");
  const { policy, config } = testPolicy.loadTestPolicy({ root, env: {} });
  const plan = testPolicy.resolveStage({ root, stage: "developer", base, policy, config, edition: "Community", landingGateFor: landing.landingGateFor });
  assert.equal(plan.decision, "workspace");
  assert.deepEqual(plan.reasons, []);
  assert.equal(plan.selection, null);
  const ran = policyRunner.runPlan({ root, plan, policy, outDir: out, env: {}, spawn: () => ({ exit_code: 0, signal: null, duration_ms: 0 }) });
  const verdict = landing.verifyLandingEvidence({ root, manifest: ran.manifest, base, policy: selector.loadPolicy(), boardPath: path.join(root, "coord/board/tasks.json") });
  assert.ok(verdict.refusals.includes("the current policy requires the full gate"),
    "a non-engine stage has no selection reasons, but must still explain why its receipt cannot establish affected landing evidence");
});

test("COORD-924: T2 changes need the full gate; a selected-suite run is refused", (t) => {
  const w = workspace(t);
  change(w.root, `${E}upgrade.js`, "exports.migrate = (v) => v + 2;\n");
  assert.throws(() => selectedRun(w), /refusing a selected-suite run: the full gate is required \(T2 changes always run the full relevant gate\)/);
  const gate = landing.landingGateFor({ root: w.root, base: w.base, policy: POLICY, boardPath: w.boardPath }).gate;
  assert.deepEqual([gate.gate, gate.tier], ["full", "T2"]);
});

test("COORD-924: tree or base drift, a failed run, missing suites and a policy change refuse the evidence", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.test.js`, `${fixtures.repo[`${E}math.test.js`]}// more\n`);
  const run = selectedRun(w);
  const other = git(w.root, ["rev-parse", "HEAD"]);
  assert.match(verify(w, run.file, { base: other }).refusals.join("\n"), /landing changes the tested base/);
  const newer = verify(w, run.file, { policy: { ...POLICY, policy_version: 2 } });
  assert.match(newer.refusals.join("\n"), /the selector or its policy changed since the run \(policy v1 -> v2\)/);
  const manifest = readManifest(run.file);
  manifest.plan.shards = [{ lane: "selected", files: [`${E}math.test.js`] }];
  manifest.input_digest = require("./run-manifest.js").digestOf(manifest.inputs);
  const partial = landing.verifyLandingEvidence({ root: w.root, manifest, base: w.base, policy: POLICY, boardPath: w.boardPath });
  // COORD-953: widened, the required list also names the unresolved-site readers (human-admin decision 2026-11-12); exact list
  assert.deepEqual(partial.refusals, ["the run did not cover required suites: coord/engine/scripts/owner.test.js, coord/engine/scripts/plugins.test.js"]);
  assert.match(landing.verifyLandingEvidence({ root: w.root, manifest: { ...manifest, plan: { shards: [], selection: null } }, base: w.base, policy: POLICY, boardPath: w.boardPath }).refusals[0], /records no landing selection/);
  const failed = selectedRun(w, { run: passingRun(1), outDir: path.join(w.out, "failed") });
  assert.match(verify(w, failed.file).refusals.join("\n"), /evidence run result is fail/);
  assert.deepEqual(landing.verifyLandingEvidence({ root: w.root, manifest: { schema_version: 1 }, base: w.base, policy: POLICY, boardPath: w.boardPath }).ok, false);
  change(w.root, `${E}math.test.js`, `${fixtures.repo[`${E}math.test.js`]}// drift\n`);
  const drift = verify(w, run.file);
  assert.equal(drift.ok, false);
  assert.match(drift.refusals.join("\n"), /landing changes the tested tree/);
  assert.match(landing.formatLandingRefusal(drift), /^add-repo-gate refusing the selected-suite evidence: /);
});

test("COORD-924: a change to the selector policy forces the full gate", (t) => {
  const w = workspace(t);
  change(w.root, "coord/engine/test-policy.json", "{}\n");
  const real = require("./affected-selector.js").loadPolicy();
  const gate = landing.landingGateFor({ root: w.root, base: w.base, policy: { ...real, initial_state: "active", generated_files: [] }, boardPath: w.boardPath }).gate;
  assert.deepEqual([gate.gate, gate.reason], ["full", "selection fell back: selector_change"]);
  const shipped = landing.landingGateFor({ root: w.root, base: w.base, policy: { ...real, generated_files: [] }, boardPath: w.boardPath });
  assert.deepEqual([shipped.gate.gate, shipped.wouldGate.reason], ["full", "selection fell back: selector_change"], "a policy change still falls back to full under the active policy");
});

test("COORD-924: a full-run comparison journals a miss, suspends its category and lists it for refinement", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.test.js`, `${fixtures.repo[`${E}math.test.js`]}// edited\n`);
  const inventory = path.join(w.out, "inventory.json");
  fs.writeFileSync(inventory, JSON.stringify({ editions: { Community: { tests: {
    [`${E}math.test.js`]: [["math: add"]], [`${E}limits.test.js`]: [["limits: the configured limit"]],
  } } } }));
  const full = (failing) => ({ node_version: "v22.8.0", result: failing.length ? "fail" : "pass", results: [{ module: "core", failing_tests: failing }] });
  const caught = landing.compareFullRun({ root: w.root, base: w.base, fullReport: full(["math: add"]), ledgerDir: w.ledgerDir, boardPath: w.boardPath, inventoryFile: inventory, policy: POLICY, now: "2026-11-07T00:00:00.000Z" });
  assert.deepEqual([caught.gate, caught.missed, caught.categories], ["affected", [], ["test-only"]]);
  const missed = landing.compareFullRun({ root: w.root, base: w.base, fullReport: full(["limits: the configured limit", "unattributed name"]), ledgerDir: w.ledgerDir, boardPath: w.boardPath, inventoryFile: inventory, policy: POLICY, now: "2026-11-07T01:00:00.000Z" });
  assert.deepEqual(missed.missed, ["limits: the configured limit", "unattributed name"]);
  assert.deepEqual(governed.readSelectionState({ root: w.root, boardPath: w.boardPath, policy: POLICY }).suspended_categories, {}, "the comparison only reports; gov selection nightly journals the suspension");
  suspendOnBoard(w, missed.categories);
  landing.compareFullRun({ root: w.root, base: w.base, fullReport: full([]), ledgerDir: w.ledgerDir, boardPath: w.boardPath, inventoryFile: inventory, policy: POLICY });
  const after = landing.landingGateFor({ root: w.root, base: w.base, policy: POLICY, boardPath: w.boardPath }).gate;
  assert.deepEqual([after.gate, after.reason], ["full", "selection is suspended for test-only after a recorded miss"]);
  const report = fs.readFileSync(path.join(w.ledgerDir, landing.REFINEMENT_REPORT), "utf8");
  assert.match(report, /- test-only: missed \(since n, policy v1\)/);
  assert.match(report, /tier T0 \[test-only\]: limits: the configured limit; unattributed name/);
  const fullGate = landing.compareFullRun({ root: w.root, base: w.base, fullReport: full(["x"]), ledgerDir: w.ledgerDir, boardPath: w.boardPath, inventoryFile: inventory, policy: POLICY });
  assert.deepEqual([fullGate.would_run, fullGate.missed], ["full", []], "a full gate misses nothing");
  assert.equal(landing.readInventory(w.root, path.join(w.out, "absent.json")), null);
  assert.deepEqual(landing.attributeFailures(["a"], null), [{ name: "a", suites: [] }]);
  fs.writeFileSync(path.join(w.ledgerDir, landing.COMPARISONS), "");
  assert.match(landing.renderRefinementReport(path.join(w.out, "empty-ledger"), POLICY, "n", { suspended_categories: {} }), /Comparisons: 0; with misses: 0[\s\S]*- none[\s\S]*- none/);
});

test("COORD-924: add-repo-gate records accepted selection evidence and refuses the rest", () => {
  const recorded = [];
  const failures = [];
  const fail = (message) => { failures.push(message); throw new Error(message); };
  const ok = createGates({ fail, updatePlanBlock: (id, block) => recorded.push([id, block]), verifySelectionEvidence: () => ({ entry: "affected-selection run m - result=pass", refusal: null }) });
  ok.addRepoGateCommand("COORD-1", { selectionManifest: "m.json", base: "dev" });
  assert.deepEqual(recorded, [["COORD-1", { repoGate: ["affected-selection run m - result=pass"] }]]);
  const refused = createGates({ fail, updatePlanBlock: () => assert.fail("nothing is recorded"), verifySelectionEvidence: () => ({ entry: null, refusal: "add-repo-gate refusing the selected-suite evidence: T2" }) });
  assert.throws(() => refused.addRepoGateCommand("COORD-1", { selectionManifest: "m.json", base: "dev" }), /refusing the selected-suite evidence: T2/);
  assert.throws(() => refused.addRepoGateCommand("COORD-1", { selectionManifest: "m.json" }), /requires --base <ref>/);
  ok.addRepoGateCommand("COORD-1", { notRequired: true });
  assert.deepEqual(recorded.at(-1), ["COORD-1", { repoGate: ["not-required"] }], "--not-required records before any selection check");
  assert.throws(() => ok.addRepoGateCommand("COORD-1", {}), /requires --command <cmd> or --not-required/);
  assert.equal(failures.length, 3);
});

test("COORD-924: a suspended category turns accepted evidence into a full-gate refusal; the CLI and defaults agree", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.js`, "exports.add = (a, b) => b + a;\nexports.mul = (a, b) => a * b;\n");
  const run = selectedRun(w);
  const ev = require("./affected-evaluation.js");
  const cli = (argv, deps = {}) => {
    let out = "";
    let err = "";
    const status = ev.main([...argv, "--root", w.root, "--ledger", w.ledgerDir], { out: { write: (c) => { out += c; } }, err: { write: (c) => { err += c; } }, policy: POLICY, ...deps });
    return { status, out, err };
  };
  const accepted = cli(["verify-landing", "--manifest", run.file, "--base", w.base]);
  // COORD-953: widened to six suites (human-admin decision 2026-11-12)
  assert.deepEqual([accepted.status, accepted.out], [0, "affected-selection: selected-suite evidence accepted tier=T1 suites=4\n"]);
  const compared = cli(["compare-full", "--base", w.base, "--full-report", run.file]);
  assert.match(compared.out, /compare-full gate=affected failures=0 missed=0/);
  suspendOnBoard(w, ["shared-helper"]);
  const held = verify(w, run.file);
  assert.equal(held.ok, false);
  assert.match(held.refusals.join("\n"), /the full gate is required: selection is suspended for shared-helper after a recorded miss/);
  assert.deepEqual(held.suites, []);
  const refused = createGates.verifySelectionEvidence({ manifestPath: run.file, base: w.base, root: w.root, policy: POLICY, boardPath: w.boardPath });
  assert.match(refused.refusal, /^add-repo-gate refusing the selected-suite evidence: .*suspended for shared-helper/);
  assert.equal(refused.entry, null);
  const defaults = createGates.verifySelectionEvidence({ manifestPath: run.file, base: w.base, root: w.root, boardPath: path.join(w.out, "absent-board.json") });
  assert.match(defaults.refusal, /board unreadable: full gates/, "an unreadable governed board fails closed");
  const unversioned = { ...fixtures.policy, initial_state: "active" };
  fs.writeFileSync(w.boardPath.replace("tasks.json", "x.json"), "{\"metadata\":{}}");
  assert.deepEqual(landing.landingGateFor({ root: w.root, base: w.base, policy: unversioned, boardPath: w.boardPath.replace("tasks.json", "x.json") }).gate.suites, [`${E}math.test.js`, `${E}plugins.test.js`, `${E}report.test.js`], "a policy without always-required suites adds none");
  const legacy = governed.withSuspension({ suspended_categories: {}, resolutions: [] }, { categories: ["fixture"], reason: "r", ref: "x", now: "n" });
  assert.deepEqual(governed.withResolution(legacy, { category: "fixture", investigation: "x", policyVersion: 1, now: "m" }).suspended_categories, {}, "a suspension recorded before versioning lifts under version 1");
  assert.deepEqual(landing.attributeFailures(["t"], { editions: { Community: {}, Enterprise: { tests: { "a.test.js": [["d", "t"]] } } } }), [{ name: "t", suites: ["a.test.js"] }]);
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-runner-"));
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fakeRoot, "coord", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "coord", "scripts", "test-runner.js"), "if (process.argv.includes('kill.test.js')) process.kill(process.pid, 'SIGTERM');\nconst i = process.argv.indexOf('--report'); require('fs').writeFileSync(process.argv[i + 1], JSON.stringify({ argv: process.argv.slice(2) })); process.exitCode = 3;\n");
  const report = path.join(fakeRoot, "r.json");
  const lane = landing.runRunner(fakeRoot, ["a.test.js", "b.test.js"], report);
  assert.deepEqual([lane.exit_code, lane.signal], [3, null]);
  assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")).argv, ["--file", "a.test.js", "--file", "b.test.js", "--report", report]);
  assert.deepEqual(landing.runRunner(fakeRoot, ["kill.test.js"], report).exit_code === -1 ? "signalled" : "exited", "signalled", "a signalled runner is a failed lane");
});

test("COORD-924: finalize, land and closeout re-check recorded selection evidence at the reviewed head", (t) => {
  const w = workspace(t);
  change(w.root, `${E}math.js`, "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => b * a;\n");
  const run = selectedRun(w);
  const entry = landing.repoGateEntry(run.file, verify(w, run.file));
  const head = git(w.root, ["rev-parse", "HEAD"]);
  const recheck = (extra = {}) => landing.recheckSelectionEntries({ ticketId: "COORD-1", repoGates: ["node --test x", entry], root: w.root, head, policy: POLICY, boardPath: w.boardPath, ...extra });
  assert.deepEqual(recheck(), [], "unchanged evidence still holds");
  assert.deepEqual(landing.recheckSelectionEntries({ ticketId: "COORD-1", repoGates: null, root: w.root, policy: POLICY, boardPath: w.boardPath }), []);
  assert.deepEqual(recheck({ head: undefined }), [], "without a reviewed head the workspace HEAD is checked");
  const newer = recheck({ policy: { ...POLICY, policy_version: 2 } });
  assert.equal(newer[0].code, "affected_selection_evidence");
  assert.match(newer[0].message, /no longer holds at [0-9a-f]{40}: .*policy changed since the run/);
  suspendOnBoard(w, ["shared-helper"]);
  assert.match(recheck()[0].message, /suspended for shared-helper/);
  fs.writeFileSync(w.boardPath, JSON.stringify({ metadata: {} }));
  change(w.root, `${E}math.js`, "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b * 1;\n", "code changed after the selected run");
  const moved = recheck({ head: git(w.root, ["rev-parse", "HEAD"]) });
  assert.match(moved[0].message, /landing changes the tested tree/);
  assert.match(moved[0].next_steps[1], /add-repo-gate COORD-1 --command/);
  const forged = entry.replace(/input_digest=sha256:[0-9a-f]+/, `input_digest=sha256:${"0".repeat(64)}`);
  assert.match(recheck({ repoGates: [forged] })[0].message, /is not the one recorded/);
  assert.match(recheck({ head: "no-such-ref" })[0].message, /landing changes the tested tree \([0-9a-f]+ -> null\)/, "an unknown reviewed head cannot match the tested tree");
  const gone = entry.replace(run.file, path.join(w.out, "gone.manifest.json"));
  assert.match(recheck({ repoGates: [gone] })[0].message, /cannot be read/);
});
