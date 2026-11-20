"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const runManifest = require("./run-manifest.js");
const governance = require("./test-sharding-governance.js");

function fixture(t, edition = "Community") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-shard-gov-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-shard-evidence-"));
  t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "test"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  fs.mkdirSync(path.join(root, "coord", "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../test-policy.json"), path.join(root, "coord", "engine", "test-policy.json"));
  if (edition === "donor") {
    fs.mkdirSync(path.join(root, "release"), { recursive: true });
    fs.writeFileSync(path.join(root, "release", "build-public-release.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), JSON.stringify({ metadata: {} }));
  fs.writeFileSync(path.join(root, "source.js"), "module.exports = 1;\n");
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root }).status, 0);
  const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const inputs = runManifest.collectInputs({ root }).inputs;
  const common = {
    schema_version: 1, tool: "coord/scripts/test-runner.js", workspace_root: root, suite_result: "pass", result: "pass",
    inventory: [{ name: "engine", files: ["coord/engine/example.test.js"] }],
    results: [{ module: "engine", files: ["coord/engine/example.test.js"], test_outcomes: [
      { identity: "coord/engine/example.test.js > example passes", outcome: "pass" },
    ] }],
    engine_coverage: { measurement: { totals: { lines: 100, branches: 100, functions: 100 }, files: { "coord/engine/example.js": { lines: 100 } } },
      ratchet: { result: "pass", new_uncovered: [] } },
  };
  const writePair = (name, report, inputPatch = {}) => {
    const reportPath = path.join(artifactRoot, `${name}.report.json`);
    const manifestPath = path.join(artifactRoot, `${name}.manifest.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const boundInputs = structuredClone(runManifest.collectInputs({ root }).inputs);
    Object.assign(boundInputs.source, inputPatch.source || {});
    const manifest = runManifest.finalizeManifest(runManifest.buildManifest({ tool: "coord/scripts/test-runner.js", inputs: boundInputs,
      host: { tmpdir: "/tmp", tmpdir_realpath: "/tmp", kernel: "Linux" },
      lanes: [{ name, exit_code: report.result === "fail" ? 1 : 0, signal: null, duration_ms: 1 }] }), [reportPath]);
    runManifest.writeManifest(manifestPath, manifest);
    return { reportPath, manifestPath };
  };
  const serial = writePair("serial", { ...common, shards: null });
  const sharded = writePair("sharded", { ...common, result: "provisional", qualification: "provisional; donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "release", "--policy-stage", "release", "--qualification-mode", "full"],
    shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] });
  return { root, artifactRoot, tree, commit, common, serial, sharded, writePair };
}

test("COORD-900: compares exact same-tree reports, identities, outcomes, inventory and merged coverage", (t) => {
  const f = fixture(t);
  const pair = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
    shardedReport: f.sharded.reportPath, shardedManifest: f.sharded.manifestPath });
  assert.equal(pair.matched, true);
  assert.equal(pair.identity.tree, f.tree);
  assert.deepEqual(pair.compared, ["test_identity", "outcome", "coverage_findings"]);
  const changed = f.writePair("sharded-changed", { ...f.common,
    result: "provisional", qualification: "provisional; donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "release"],
    results: [{ ...f.common.results[0], test_outcomes: [{ identity: "different", outcome: "fail" }] }],
    shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] });
  const mismatch = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
    shardedReport: changed.reportPath, shardedManifest: changed.manifestPath });
  assert.equal(mismatch.matched, false);
  assert.ok(mismatch.mismatches.some((entry) => entry.field === "test_identity_outcome"));
  const otherTree = f.writePair("sharded-other-tree", { ...f.common, result: "provisional", qualification: "provisional; donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "release"], shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] },
  { source: { tree: "f".repeat(40) } });
  const treeMismatch = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
    shardedReport: otherTree.reportPath, shardedManifest: otherTree.manifestPath });
  assert.ok(treeMismatch.mismatches.some((entry) => entry.field === "manifest.inputs.source.tree"), JSON.stringify(treeMismatch.mismatches));
  const failedSerial = f.writePair("failed-serial", { ...f.common, result: "fail", suite_result: "fail",
    engine_coverage: { ...f.common.engine_coverage, ratchet: { result: "fail", new_uncovered: ["coord/engine/example.js"] } }, shards: null });
  const failedComparison = governance.compareReports({ serialReport: failedSerial.reportPath, serialManifest: failedSerial.manifestPath,
    shardedReport: f.sharded.reportPath, shardedManifest: f.sharded.manifestPath });
  assert.ok(failedComparison.mismatches.some((entry) => entry.field === "serial_run_result"), "failed runs remain comparable and produce a suspension verdict");
});

test("COORD-900: mismatch suspension is sticky and successful comparisons append evidence", () => {
  const board = { metadata: {} };
  const match = { matched: true, identity: { tree: "t" }, evidence: { a: "sha256:a" } };
  governance.updateBoardState(board, match, { at: "2026-11-09T00:00:00.000Z", id: "match" });
  assert.equal(governance.authorityState(board).allowed, true);
  assert.equal(governance.authorityState(board).evidence_pending, false);
  governance.updateBoardState(board, { ...match, matched: false, mismatches: [{ field: "outcome" }] }, { at: "2026-11-09T00:01:00.000Z", id: "miss" });
  assert.equal(governance.authorityState(board).allowed, false);
  governance.updateBoardState(board, match, { at: "2026-11-09T00:02:00.000Z", id: "later-match" });
  assert.equal(governance.authorityState(board).allowed, false, "a later green comparison does not silently clear a suspension");
  assert.equal(board.metadata.test_sharding.comparisons.length, 3);
});

test("COORD-900: the release receipt command verifies evidence before writing separate private output", (t) => {
  const f = fixture(t);
  const Module = require("node:module");
  const chain = require("./journal-chain.js");
  const { createTestPolicyCommands } = require("./test-policy-run.js");
  const verifierPath = path.resolve(__dirname, "../../../release/suite-inventory.js");
  const inventoryPath = path.resolve(__dirname, "../../../release/suite-inventory.json");
  const skipLogDir = path.join(f.artifactRoot, "release-skip-log");
  const originalLoad = Module._load;
  let inventoryAccepted = true;
  let verifications = 0;

  // Supply the donor-only dependency in the fixture so the shared receipt
  // command uses the same import and argument contract in both editions.
  t.mock.method(Module, "_load", function (request, parent, isMain) {
    if (request !== verifierPath || parent?.filename !== require.resolve("./test-sharding-governance.js")) {
      return originalLoad.call(this, request, parent, isMain);
    }
    return {
      verifySuiteInventory(options) {
        verifications++;
        assert.deepEqual(options, {
          artifact: f.root, reportPath: f.sharded.reportPath, skipLogDir,
          manifestFile: inventoryPath, allowProvisional: true,
        });
        return inventoryAccepted ? { ok: true } : { ok: false, problems: ["unexpected test identity"] };
      },
    };
  });
  const event = chain.buildChainAnchorEvent("fixture release");
  const log = [];
  const command = createTestPolicyCommands({
    root: f.root, fail: (message) => { throw new Error(message); },
    log: (line) => log.push(line), readBoard: () => ({ metadata: {} }), readJournalEvents: () => [event],
  });
  const args = ["--stage", "release", "--report", f.sharded.reportPath, "--manifest", f.sharded.manifestPath,
    "--skip-log-dir", skipLogDir];
  const receiptFile = path.join(f.artifactRoot, "receipts", "release.json");
  const reportBytes = fs.readFileSync(f.sharded.reportPath);

  const receipt = command("verify-shard-result", [...args, "--receipt-out", receiptFile]);
  assert.equal(receipt.journal_head_digest, chain.hashGovernanceEventRecord(event));
  assert.equal(receipt.commit, f.commit);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), receipt);
  assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(receiptFile)), [path.basename(receiptFile)]);
  assert.equal(log.length, 1);
  assert.ok(log[0].includes(receipt.receipt_digest));
  assert.throws(() => command("verify-shard-result", [...args, "--receipt-out", f.sharded.reportPath]),
    /separate from report and manifest/);
  assert.deepEqual(fs.readFileSync(f.sharded.reportPath), reportBytes);

  inventoryAccepted = false;
  assert.throws(() => command("verify-shard-result", [...args, "--receipt-out", receiptFile]),
    /exact cut inventory did not verify.*unexpected test identity/);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")), receipt);
  assert.equal(verifications, 3);
});

test("COORD-900: donor receipt binds live state, journal event, tree, policy and final report manifests", (t) => {
  const f = fixture(t);
  const shardManifest = JSON.parse(fs.readFileSync(f.sharded.manifestPath, "utf8"));
  const proof = { id: "pair-1", matched: true, identity: { tree: f.tree, commit: f.commit, policy_digest: shardManifest.inputs.policy.digest, edition: "Community", node_version: process.version }, evidence: {} };
  const board = { metadata: { test_sharding: { comparisons: [proof], suspension: { active: false } } } };
  const events = [{ command: "test-sharding-compare", details: { comparison_id: proof.id } }];
  const eventDigest = () => "sha256:event";
  const policy = require("../test-policy.json");
  const verifyCutInventory = () => ({ ok: true, summary: "fixture inventory exact" });
  // Installed editions can omit the donor-only inventory verifier. The source
  // checkout exercises the default path without replacing it with an adapter.
  if (fs.existsSync(path.resolve(__dirname, "../../../release/suite-inventory.js"))) {
    const before = structuredClone(board);
    assert.throws(() => governance.createReceipt({ ...f.sharded, board, policy,
      journalEvents: events, eventDigest }), /exact cut inventory did not verify .*edition.*never guessed/);
    assert.deepEqual(board, before);
  }
  let checkedSkipLog = null;
  const receipt = governance.createReceipt({ reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    skipLogDir: path.join(f.artifactRoot, "release-skip-log"), board, policy, journalEvents: events, eventDigest, verifyJournal: () => true,
    verifyCutInventory: (report, context) => { checkedSkipLog = context.skipLogDir; return verifyCutInventory(report); } });
  assert.equal(checkedSkipLog, path.join(f.artifactRoot, "release-skip-log"), "release skip-log path is supplied out of band, not by runner report metadata");
  assert.equal(governance.verifyReceipt({ receipt, reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    board, policy, journalEvents: events, eventDigest, verifyJournal: () => true, verifyCutInventory }), true);
  // The receipt helpers are the canonical enforcement boundary: neither
  // creation nor later re-verification may trust a caller that cannot verify
  // the donor journal chain.
  const rejectJournal = () => false;
  assert.throws(() => governance.createReceipt({ reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    skipLogDir: path.join(f.artifactRoot, "release-skip-log"), board, policy, journalEvents: events, eventDigest,
    verifyJournal: rejectJournal, verifyCutInventory }), /donor journal chain is invalid/);
  assert.throws(() => governance.verifyReceipt({ receipt, reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    board, policy, journalEvents: events, eventDigest, verifyJournal: rejectJournal, verifyCutInventory }), /donor journal chain is invalid/);
  assert.throws(() => governance.verifyReceipt({ receipt: { ...receipt, tree: "stale" }, reportPath: f.sharded.reportPath,
    manifestPath: f.sharded.manifestPath, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true, verifyCutInventory }), /digest mismatch/);
  const suspended = { metadata: { test_sharding: { ...board.metadata.test_sharding, suspension: { active: true, reason: "mismatch" } } } };
  assert.throws(() => governance.verifyReceipt({ receipt, reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    board: suspended, policy, journalEvents: events, eventDigest, verifyJournal: () => true, verifyCutInventory }), /suspension is active/);
  assert.throws(() => governance.verifyReceipt({ receipt, reportPath: f.sharded.reportPath, manifestPath: f.sharded.manifestPath,
    board, policy, journalEvents: [], eventDigest, verifyJournal: () => true, verifyCutInventory }), /journal/);
  const promotionFixture = fixture(t, "donor");
  const promotion = promotionFixture.writePair("sharded-promotion", { ...promotionFixture.common, result: "provisional", qualification: "provisional; donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "promotion", "--policy-stage", "production", "--qualification-mode", "full"],
    shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] });
  const qualificationPlan = { stage: "production", base_stage: "promotion", decision: "full", qualifies: true,
    checks: [{ id: "full-suite", args: ["--engine-coverage"] }] };
  const promotionReceipt = governance.createReceipt({ reportPath: promotion.reportPath, manifestPath: promotion.manifestPath,
    stage: "promotion", qualificationPlan, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true });
  assert.equal(promotionReceipt.stage, "promotion");
  assert.equal(governance.verifyReceipt({ receipt: promotionReceipt, reportPath: promotion.reportPath, manifestPath: promotion.manifestPath,
    stage: "promotion", qualificationPlan, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true }), true);
});

test("COORD-900: selected receipt binds the exact selected-plus-mandatory suite set without a whole-suite ratchet", (t) => {
  const f = fixture(t, "donor");
  const selectedSuite = "coord/engine/selected.test.js";
  fs.mkdirSync(path.dirname(path.join(f.root, selectedSuite)), { recursive: true });
  fs.writeFileSync(path.join(f.root, selectedSuite), "// selected fixture suite\n");
  assert.equal(spawnSync("git", ["add", "-A"], { cwd: f.root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "add selected suite"], { cwd: f.root }).status, 0);
  const plan = { stage: "pr", base_stage: "pr", decision: "selected", qualifies: false, selection: { tier: "T1", would_gate: "affected" },
    checks: [{ id: "selected-suites", suites: [selectedSuite] }, { id: "always-required-suites", suites: ["coord/engine/example.test.js"] }] };
  const selected = f.writePair("sharded-selection", { ...f.common, result: "provisional", qualification: "provisional; donor receipt required",
    inventory: [{ name: "engine", files: ["coord/engine/example.test.js", selectedSuite] }],
    engine_coverage: null,
    argv: ["--file", selectedSuite, "--file", "coord/engine/example.test.js", "--shards", "2", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "selection"],
    shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js", selectedSuite] }] });
  const board = { metadata: { test_sharding: { comparisons: [], suspension: { active: false } } } };
  const events = [{ command: "test-sharding-compare", details: { comparison_id: "selection-pair" } }];
  const eventDigest = () => "sha256:event";
  const policy = require("../test-policy.json");
  const receipt = governance.createReceipt({ reportPath: selected.reportPath, manifestPath: selected.manifestPath,
    stage: "pr", qualificationMode: "selection", qualificationPlan: plan, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true });
  assert.equal(receipt.qualification_mode, "selection");
  assert.equal(receipt.qualification_plan_digest, runManifest.digestOf(plan));
  assert.equal(governance.verifyReceipt({ receipt, reportPath: selected.reportPath, manifestPath: selected.manifestPath,
    stage: "pr", qualificationMode: "selection", qualificationPlan: plan, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true }), true);
  const incomplete = { ...plan, checks: plan.checks.slice(0, 1) };
  assert.throws(() => governance.createReceipt({ reportPath: selected.reportPath, manifestPath: selected.manifestPath,
    stage: "pr", qualificationMode: "selection", qualificationPlan: incomplete, board, policy, journalEvents: events, eventDigest, verifyJournal: () => true }),
  /selected-plus-mandatory suite set/);
  const options = { stage: "pr", qualificationMode: "selection", qualificationPlan: plan,
    board, policy, journalEvents: events, eventDigest };
  const report = JSON.parse(fs.readFileSync(selected.reportPath, "utf8"));
  const noRatchet = f.writePair("selection-with-explicit-null-ratchet",
    { ...report, engine_coverage: { measurement: null, ratchet: null } });
  assert.equal(governance.createReceipt({ ...options, ...noRatchet }).qualification_plan_digest, runManifest.digestOf(plan));
  const withRatchet = f.writePair("selection-with-aggregate-ratchet", { ...report, engine_coverage: f.common.engine_coverage });
  assert.throws(() => governance.createReceipt({ ...options, ...withRatchet }), /not passing selection sharding evidence/);
  const noAssignment = f.writePair("selection-without-assignment", { ...report, shards: [{ id: 1, result: "pass" }] });
  assert.throws(() => governance.createReceipt({ ...options, ...noAssignment }), /selected-plus-mandatory suite set/);
});

test("COORD-1052: comparison rejects incomplete, duplicated and divergent execution evidence", (t) => {
  const f = fixture(t);
  const shard = { ...f.common, result: "provisional", shards: [{ id: 1, result: "pass" }] };
  const cases = [
    ["empty inventory", { inventory: [] }, "suite_inventory_integrity"],
    ["duplicate inventory", { inventory: [f.common.inventory[0], f.common.inventory[0]] }, "suite_inventory_integrity"],
    ["different inventory", { inventory: [{ files: ["other.test.js"] }] }, "suite_inventory"],
    ["empty outcomes", { results: [] }, "test_identity_integrity"],
    ["duplicate outcomes", { results: [f.common.results[0], f.common.results[0]] }, "test_identity_integrity"],
    ["no coverage", { engine_coverage: null }, "coverage_findings"],
    ["failed ratchet", { engine_coverage: { ...f.common.engine_coverage, ratchet: { result: "fail" } } }, "sharded_coverage_ratchet"],
    ["failed execution", { result: "fail", suite_result: "fail" }, "sharded_run_result"],
    ["missing shards", { shards: [] }, "shard_outcomes"],
    ["failed shard", { shards: [{ id: 1, result: "fail" }] }, "shard_outcomes"],
  ];
  for (const [name, patch, field] of cases) {
    const candidate = f.writePair(name, { ...shard, ...patch });
    const result = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
      shardedReport: candidate.reportPath, shardedManifest: candidate.manifestPath });
    assert.equal(result.matched, false, name);
    assert.ok(result.mismatches.some((entry) => entry.field === field), name);
  }
  const serialWithoutGit = f.writePair("serial-without-git", { ...f.common, engine_coverage: null },
    { source: { commit: null, tree: null, base: f.commit } });
  const incomplete = governance.compareReports({ serialReport: serialWithoutGit.reportPath, serialManifest: serialWithoutGit.manifestPath,
    shardedReport: f.sharded.reportPath, shardedManifest: f.sharded.manifestPath });
  assert.equal(incomplete.matched, false);
  assert.equal(incomplete.identity.commit, null);
  assert.equal(incomplete.identity.tree, null);
  assert.deepEqual(incomplete.mismatches.find((item) => item.field === "manifest.inputs.source.base"),
    { field: "manifest.inputs.source.base", serial: f.commit, sharded: null });
  assert.equal(incomplete.mismatches.find((item) => item.field === "coverage_findings").serial, null);
  assert.deepEqual(incomplete.mismatches.find((item) => item.field === "serial_coverage_ratchet"),
    { field: "serial_coverage_ratchet", result: "missing" });
  const invalidCoverage = f.writePair("missing measurement", { ...shard, engine_coverage: { ratchet: { result: "pass" } } });
  assert.throws(() => governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
    shardedReport: invalidCoverage.reportPath, shardedManifest: invalidCoverage.manifestPath }), /coverage measurement or ratchet is missing/);
  assert.deepEqual(governance.inventoryOf({ inventory: [{}] }), []);
  assert.deepEqual(governance.inventoryOf({}), []);
  assert.deepEqual(governance.outcomesOf({ results: [{}] }), []);
  assert.deepEqual(governance.outcomesOf({}), []);
});

test("COORD-1052: receipt admission rejects tampered reports and nonpassing evidence", (t) => {
  const f = fixture(t);
  const valid = { ...f.common, result: "provisional", qualification: "donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "release", "--qualification-mode", "full"],
    shards: [{ id: 1, result: "pass" }] };
  const options = { board: { metadata: {} }, policy: require("../test-policy.json"), journalEvents: [{ command: "fixture" }],
    eventDigest: runManifest.digestOf, verifyCutInventory: () => ({ ok: true }) };
  for (const [name, patch, expected] of [
    ["wrong tool", { tool: "not-the-runner" }, /missing or malformed/],
    ["failed suite", { suite_result: "fail", result: "fail" }, /not passing full/],
    ["missing ratchet", { engine_coverage: null }, /not passing full/],
    ["not provisional", { result: "pass" }, /matching provisional shard execution/],
    ["missing invocation", { argv: undefined }, /matching provisional shard execution/],
    ["missing mode", { argv: ["--shards", "2", "--qualification-stage", "release"] }, /matching provisional/],
    ["failed shard", { shards: [{ id: 1, result: "fail" }] }, /matching provisional/],
    ["empty inventory", { inventory: [] }, /edition or full inventory/],
  ]) {
    const pair = f.writePair(name, { ...valid, ...patch });
    assert.throws(() => governance.createReceipt({ ...options, ...pair }), expected, name);
  }
  const changed = f.writePair("tampered", valid);
  fs.appendFileSync(changed.reportPath, "\n");
  assert.throws(() => governance.createReceipt({ ...options, ...changed }), /does not bind the exact report bytes/);
  fs.writeFileSync(changed.manifestPath, "{}");
  assert.throws(() => governance.createReceipt({ ...options, ...changed }), /invalid run manifest/);
  const schemaCases = [
    [/"artifacts"/, (manifest) => { delete manifest.artifacts; }],
    [/"inputs"/, (manifest) => { delete manifest.inputs; }],
    [/policy\.files/, (manifest) => { manifest.inputs.policy.files = null; }],
    [/policy\.digest/, (manifest) => { manifest.inputs.policy.digest = ""; }],
    [/inputs\.edition/, (manifest) => { manifest.inputs.edition = ""; }],
    [/toolchain\.node/, (manifest) => { manifest.inputs.toolchain.node = ""; }],
  ];
  const manifest = JSON.parse(fs.readFileSync(f.sharded.manifestPath, "utf8"));
  for (const [field, change] of schemaCases) {
    const invalid = structuredClone(manifest);
    change(invalid);
    runManifest.writeManifest(changed.manifestPath, invalid);
    const rejectInvalidManifest = (error) => error.message.startsWith("invalid run manifest:") && field.test(error.message);
    const evidence = { reportPath: f.sharded.reportPath, manifestPath: changed.manifestPath };
    assert.throws(() => governance.createReceipt({ ...options, ...evidence }), rejectInvalidManifest);
    assert.throws(() => governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
      shardedReport: evidence.reportPath, shardedManifest: evidence.manifestPath }), rejectInvalidManifest);
  }
  const unbound = f.writePair("unbound-report", valid);
  const unboundManifest = JSON.parse(fs.readFileSync(unbound.manifestPath, "utf8"));
  runManifest.writeManifest(unbound.manifestPath, runManifest.finalizeManifest(unboundManifest, []));
  assert.throws(() => governance.createReceipt({ ...options, ...unbound }), /does not bind the exact report bytes/);
  assert.throws(() => governance.createReceipt({ ...options, ...f.sharded, policy: {} }), /policy does not authorize/);
  assert.throws(() => governance.createReceipt({ ...options, ...f.sharded, qualificationPlan: {} }), /does not accept a donor test-policy plan/);
  assert.throws(() => governance.createReceipt({ ...options, ...f.sharded, verifyCutInventory: () => ({ ok: false, problems: ["missing suite"] }) }), /exact cut inventory.*missing suite/);
  assert.throws(() => governance.createReceipt({ ...options, ...f.sharded, verifyCutInventory: () => ({ ok: false }) }), /exact cut inventory did not verify/);
  assert.throws(() => governance.createReceipt({ ...options, ...f.sharded, journalEvents: [] }), /journal has no current event/);
  const stale = f.writePair("stale commit", valid, { source: { commit: "f".repeat(40) } });
  assert.throws(() => governance.createReceipt({ ...options, ...stale }), /exact clean cut tree/);
});

test("COORD-1052: full donor receipts require the resolved policy stage and exactly-once assignments", (t) => {
  const f = fixture(t, "donor");
  const suite = "coord/engine/example.test.js";
  const report = { ...f.common, result: "provisional", qualification: "donor receipt required",
    argv: ["--shards", "2", "--qualification-stage", "pr", "--policy-stage", "review", "--qualification-mode", "full"],
    shards: [{ id: 1, result: "pass", assigned: [suite] }] };
  const plan = { stage: "review", base_stage: "pr", decision: "full", selection: { tier: "T2" },
    checks: [{ id: "full-suite", args: ["--engine-coverage"] }] };
  const options = { stage: "pr", qualificationPlan: plan, board: { metadata: {} }, policy: require("../test-policy.json"),
    journalEvents: [{ command: "fixture" }], eventDigest: runManifest.digestOf };
  const pair = f.writePair("full-pr", report);
  const receipt = governance.createReceipt({ ...options, ...pair });
  assert.equal(receipt.stage, "pr");
  assert.equal(receipt.comparison_id, null, "policy permits first sharded evidence without fabricating a comparison");
  assert.equal(governance.verifyReceipt({ ...options, ...pair, receipt }), true);
  assert.throws(() => governance.createReceipt({ ...options, ...pair, qualificationPlan: { ...plan, stage: "other" } }), /exact resolved policy stage/);
  assert.throws(() => governance.createReceipt({ ...options, ...pair, qualificationPlan: { ...plan, checks: [] } }), /eligible full plan/);
  assert.throws(() => governance.createReceipt({ ...options, ...pair, qualificationPlan: { ...plan, checks: undefined } }), /eligible full plan/);
  assert.throws(() => governance.createReceipt({ ...options, ...pair, qualificationPlan: { ...plan, selection: { tier: "T1" } } }), /eligible full plan/);
  for (const selection of [{ fallback_reasons: ["unknown dependency"] }, { would_gate: "full" }]) {
    assert.equal(governance.createReceipt({ ...options, ...pair, qualificationPlan: { ...plan, selection } }).qualification_mode, "full");
  }
  for (const assigned of [[], [suite, suite], ["different.test.js"]]) {
    const invalid = f.writePair(`assignment-${assigned.length}-${assigned[0] || "empty"}`.replaceAll("/", "_"),
      { ...report, shards: [{ id: 1, result: "pass", assigned }] });
    assert.throws(() => governance.createReceipt({ ...options, ...invalid }), /complete inventory exactly once/);
  }
  const noAssignment = f.writePair("full-plan-without-assignment", { ...report, shards: [{ id: 1, result: "pass" }] });
  assert.throws(() => governance.createReceipt({ ...options, ...noAssignment }), /complete inventory exactly once/);
  const weirdMode = f.writePair("unsupported-mode", { ...report, argv: report.argv.map((arg) => arg === "full" ? "other" : arg) });
  assert.throws(() => governance.createReceipt({ ...options, ...weirdMode, qualificationMode: "other" }), /unsupported qualification mode/);
});

test("COORD-1052: receipt verification rejects resealed stale authority and malformed receipts", (t) => {
  const f = fixture(t);
  const options = { ...f.sharded, board: { metadata: {} }, policy: require("../test-policy.json"),
    journalEvents: [{ command: "fixture" }], eventDigest: runManifest.digestOf, verifyCutInventory: () => ({ ok: true }) };
  const receipt = governance.createReceipt(options);
  assert.throws(() => governance.verifyReceipt({ ...options, receipt: null }), /invalid or missing/);
  const { receipt_digest, ...unsigned } = receipt;
  const stale = { ...unsigned, journal_head_digest: "sha256:" + "0".repeat(64) };
  stale.receipt_digest = runManifest.digestOf(stale);
  assert.throws(() => governance.verifyReceipt({ ...options, receipt: stale }), /stale or mismatched: journal_head_digest/);
  assert.throws(() => governance.verifyReceipt({ ...options, receipt, journalEvents: [{ command: "new event" }] }), /stale or mismatched: journal_head_digest/);
  assert.throws(() => governance.updateBoardState(null, { matched: true }), /board is unavailable/);
  const board = {};
  const result = governance.updateBoardState(board, { matched: true, evidence: {} });
  assert.match(result.comparison.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(governance.authorityState(board).evidence_pending, false);
  assert.equal(governance.authorityState({ metadata: { test_sharding: {} } }).evidence_pending, true);
  const legacyBoard = { metadata: { test_sharding: { suspension: { active: true, reason: "prior mismatch" } } } };
  governance.updateBoardState(legacyBoard, { matched: true, evidence: {} });
  assert.equal(legacyBoard.metadata.test_sharding.comparisons.length, 1);
  assert.deepEqual(governance.authorityState(legacyBoard),
    { allowed: false, reason: "prior mismatch", suspension: { active: true, reason: "prior mismatch" } });
});

test("COORD-1052: release receipt refuses unavailable cut Git identity and preserves evidence", (t) => {
  const f = fixture(t);
  const beforeReport = fs.readFileSync(f.sharded.reportPath);
  const beforeManifest = fs.readFileSync(f.sharded.manifestPath);
  const gitDir = path.join(f.root, ".git");
  fs.renameSync(gitDir, path.join(f.root, "saved-git"));
  const options = { ...f.sharded, board: { metadata: {} },
    policy: require("../test-policy.json"), journalEvents: [{ command: "fixture" }],
    eventDigest: runManifest.digestOf, verifyCutInventory: () => assert.fail("unverified Git identity must not reach inventory verification"),
  };
  assert.throws(() => governance.createReceipt(options), /cannot verify cut Git identity.*not a git repository/s);
  const bin = path.join(f.artifactRoot, "git-bin");
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.throws(() => governance.createReceipt(options), /cannot verify cut Git identity.*ENOENT/);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    assert.throws(() => governance.createReceipt(options), /cannot verify cut Git identity \(17\)/);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepEqual(fs.readFileSync(f.sharded.reportPath), beforeReport);
  assert.deepEqual(fs.readFileSync(f.sharded.manifestPath), beforeManifest);
});

test("COORD-1052: release receipt refuses a cut whose bound policy differs from the donor", (t) => {
  const f = fixture(t);
  const report = JSON.parse(fs.readFileSync(f.sharded.reportPath, "utf8"));
  fs.appendFileSync(path.join(f.root, "coord", "engine", "test-policy.json"), "\n");
  const pair = f.writePair("changed-policy", report);
  assert.throws(() => governance.createReceipt({ ...pair, board: { metadata: {} },
    policy: require("../test-policy.json"), journalEvents: [{ command: "fixture" }],
    eventDigest: runManifest.digestOf, verifyCutInventory: () => assert.fail("mismatched policy must not reach inventory verification"),
  }), /cut manifest policy does not match the current donor policy/);
});


test("COORD-1052: comparison reports each bound manifest identity mismatch and dirty source", (t) => {
  const f = fixture(t);
  const fields = [
    ["source.commit", (inputs) => { inputs.source.commit = "f".repeat(40); }],
    ["source.base", (inputs) => { inputs.source.base = "different-base"; }],
    ["policy.digest", (inputs) => {
      inputs.policy.files[0].sha256 = `sha256:${"f".repeat(64)}`;
      inputs.policy.digest = runManifest.digestOf(inputs.policy.files);
    }],
    ["edition", (inputs) => { inputs.edition = "Enterprise"; }],
    ["toolchain.node", (inputs) => { inputs.toolchain.node = "v24.0.0"; }],
  ];
  for (const [field, change] of fields) {
    const candidate = f.writePair(`identity-${field.replaceAll(".", "-")}`, { ...f.common, result: "provisional",
      qualification: "provisional; donor receipt required", argv: ["--shards", "2", "--qualification-stage", "release"],
      shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] });
    const manifest = JSON.parse(fs.readFileSync(candidate.manifestPath, "utf8"));
    change(manifest.inputs);
    manifest.input_digest = runManifest.digestOf(manifest.inputs);
    const resealed = runManifest.finalizeManifest(manifest, [candidate.reportPath]);
    runManifest.writeManifest(candidate.manifestPath, resealed);
    const compared = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
      shardedReport: candidate.reportPath, shardedManifest: candidate.manifestPath });
    assert.equal(compared.matched, false, field);
    assert.ok(compared.mismatches.some((item) => item.field === `manifest.inputs.${field}`), field);
  }
  const dirty = f.writePair("dirty-sharded", { ...f.common, result: "provisional",
    qualification: "provisional; donor receipt required", argv: ["--shards", "2", "--qualification-stage", "release"],
    shards: [{ id: 1, result: "pass", assigned: ["coord/engine/example.test.js"] }] });
  const dirtyManifest = JSON.parse(fs.readFileSync(dirty.manifestPath, "utf8"));
  dirtyManifest.inputs.source.dirty = true;
  dirtyManifest.inputs.source.dirty_digest = "sha256:changed-tree";
  dirtyManifest.input_digest = runManifest.digestOf(dirtyManifest.inputs);
  runManifest.writeManifest(dirty.manifestPath, runManifest.finalizeManifest(dirtyManifest, [dirty.reportPath]));
  const dirtyCompared = governance.compareReports({ serialReport: f.serial.reportPath, serialManifest: f.serial.manifestPath,
    shardedReport: dirty.reportPath, shardedManifest: dirty.manifestPath });
  assert.equal(dirtyCompared.matched, false);
  assert.ok(dirtyCompared.mismatches.some((item) => item.field === "manifest.inputs.source.dirty"));
});
