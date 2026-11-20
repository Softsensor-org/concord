"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { execFileSync, spawnSync } = require("node:child_process");
const { gitFixture } = require("./test-git-fixture.js");
const sharding = require("./test-sharding.js");
const shardExecutor = require("./test-sharding-executor.js");
const shardPolicy = require("../test-policy.json").sharding;

const inventory = [
  { module: "core", path: "coord/engine/scripts/a.test.js", duration_ms: 50 },
  { module: "core", path: "coord/engine/scripts/b.test.js", duration_ms: 10 },
  { module: "release", path: "release/c.test.js", duration_ms: 30 },
  { module: "core", path: "coord/engine/scripts/d.test.js", duration_ms: 20 },
  { module: "core", path: "coord/scripts/concurrent-burnin.test.js", duration_ms: 60, timing_sensitive: true },
];

test("COORD-1052: executor main validates a committed source and runs the exact assigned suite", async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-source-"));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-output-"));
  t.after(() => { fs.rmSync(sourceRoot, { recursive: true, force: true }); fs.rmSync(outputRoot, { recursive: true, force: true }); });

  const runner = path.join(sourceRoot, "coord", "engine", "scripts", "test-runner.js");
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.writeFileSync(runner, [
    "const fs=require('node:fs');",
    "const args=process.argv.slice(2);",
    "const files=[]; for(let i=0;i<args.length;i++) if(args[i]==='--file') files.push(args[++i]);",
    "const report=args[args.indexOf('--report')+1];",
    "fs.writeFileSync(report,JSON.stringify({result:'partial',execution_order:files.slice().sort(),results:[]}));",
    "",
  ].join("\n"));
  gitFixture(sourceRoot, ["init", "-q"]);
  gitFixture(sourceRoot, ["config", "user.name", "Coverage fixture"]);
  gitFixture(sourceRoot, ["config", "user.email", "coverage@example.invalid"]);
  gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "COORD-1052 executor fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const manifestPath = path.join(outputRoot, "executor.json");
  const manifest = { source_root: sourceRoot, source_commit: sourceCommit, source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}"]),
    runner, out_dir: outputRoot, engine_coverage: false,
    shards: [{ id: 1, suites: [{ module: "core", path: "coord/engine/scripts/example.test.js" }] }] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  await shardExecutor.main([manifestPath]);
  const result = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8"));
  assert.equal(result.source_commit, sourceCommit);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].result, "pass");
  assert.deepEqual(result.results[0].assigned, ["coord/engine/scripts/example.test.js"]);
  assert.deepEqual(result.results[0].report.execution_order, ["coord/engine/scripts/example.test.js"]);

  fs.writeFileSync(path.join(sourceRoot, "uncommitted.txt"), "dirty source\n");
  await assert.rejects(shardExecutor.main([manifestPath]), /clean source checkout/);
});

test("COORD-1052: a child without a report retains its exit and assignment metadata", async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-no-report-source-"));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-no-report-output-"));
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; fs.rmSync(sourceRoot, { recursive: true, force: true }); fs.rmSync(outputRoot, { recursive: true, force: true }); });
  gitFixture(sourceRoot, ["init", "-q"]);
  gitFixture(sourceRoot, ["config", "user.name", "Coverage fixture"]);
  gitFixture(sourceRoot, ["config", "user.email", "coverage@example.invalid"]);
  fs.writeFileSync(path.join(sourceRoot, "tracked.txt"), "clean source\n");
  const terminatedRunner = path.join(sourceRoot, "terminated-runner.js");
  fs.writeFileSync(terminatedRunner, "process.kill(process.pid, 'SIGTERM');\n");
  gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "COORD-1052 missing-report fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const assignment = ["coord/engine/scripts/does-not-exist.test.js"];
  const reportPath = path.join(outputRoot, "workers", "shard-1.json");
  const manifestPath = path.join(outputRoot, "executor.json");
  const manifest = { source_root: sourceRoot, source_commit: sourceCommit,
    source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}"]),
    runner: path.join(sourceRoot, "coord/engine/scripts/missing-runner.js"), out_dir: outputRoot, engine_coverage: true,
    shards: [{ id: 1, suites: assignment.map((file) => ({ module: "core", path: file })) }] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await shardExecutor.main([manifestPath]);
  const results = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8"));
  assert.equal(results.results.length, 1);
  const worker = results.results[0];
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, 1);
  assert.equal(worker.signal, null);
  assert.deepEqual(worker.assigned, assignment);
  assert.equal(worker.workspace, path.join(outputRoot, "workers/shard-01/workspace"));
  assert.equal(worker.report_path, reportPath);
  assert.match(worker.error, /worker report unavailable/);
  assert.equal(fs.existsSync(reportPath), false);

  const terminatedOutput = path.join(outputRoot, "terminated");
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, runner: terminatedRunner, out_dir: terminatedOutput }));
  await shardExecutor.main([manifestPath]);
  const { results: [terminated] } = JSON.parse(fs.readFileSync(path.join(terminatedOutput, "shard-results.json"), "utf8"));
  assert.equal(terminated.result, "fail");
  assert.equal(terminated.exit_code, null);
  assert.equal(terminated.signal, "SIGTERM");
  assert.deepEqual(terminated.assigned, assignment);
  assert.match(terminated.error, /worker report unavailable/);
  assert.equal(fs.existsSync(terminated.report_path), false);
  const summary = sharding.summarizeShardWorker(terminated, manifest);
  assert.equal(summary.exit_code, -1);
  assert.equal(summary.signal, "SIGTERM");
  assert.deepEqual(summary.files, assignment);
  assert.deepEqual(summary.suite_modules, { [assignment[0]]: "core" });
  assert.deepEqual(summary.skipped_tests, []);
  assert.deepEqual(summary.failing_tests, []);
  const unplanned = sharding.summarizeShardWorker({ id: 2, result: "fail" }, manifest);
  assert.deepEqual(unplanned.files, []);
  assert.deepEqual(unplanned.suite_modules, {});
  assert.equal(unplanned.duration_ms, 0);
});

test("COORD-1052: executor refuses malformed and unpinned manifests before spawning workers", async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-invalid-source-"));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-invalid-output-"));
  t.after(() => { fs.rmSync(sourceRoot, { recursive: true, force: true }); fs.rmSync(outputRoot, { recursive: true, force: true }); });
  assert.rejects(shardExecutor.main([]), /expected one shard manifest path/);

  const manifestPath = path.join(outputRoot, "executor.json");
  fs.writeFileSync(manifestPath, "{");
  await assert.rejects(shardExecutor.main([manifestPath]));
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot }));
  await assert.rejects(shardExecutor.main([manifestPath]), /manifest is missing/);

  const required = { source_root: sourceRoot, source_commit: "a".repeat(40), runner: "runner.js",
    out_dir: outputRoot, engine_coverage: false, shards: [] };
  fs.writeFileSync(manifestPath, JSON.stringify(required));
  await assert.rejects(shardExecutor.main([manifestPath]), /manifest has no shards/);
  required.shards = [{ id: 1, suites: [] }];
  fs.writeFileSync(manifestPath, JSON.stringify(required));
  await assert.rejects(shardExecutor.main([manifestPath]), /git rev-parse.*failed/);

  gitFixture(sourceRoot, ["init", "-q"]);
  gitFixture(sourceRoot, ["config", "user.name", "Coverage fixture"]);
  gitFixture(sourceRoot, ["config", "user.email", "coverage@example.invalid"]);
  gitFixture(sourceRoot, ["commit", "-q", "--allow-empty", "-m", "Pinned executor fixture"]);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...required, source_commit: "b".repeat(40) }));
  await assert.rejects(shardExecutor.main([manifestPath]), /source HEAD changed/);
  assert.throws(() => shardExecutor.git(path.join(sourceRoot, "missing"), ["status"]), /git status failed:.*ENOENT/);
  fs.writeFileSync(path.join(sourceRoot, "before.txt"), "before\n");
  fs.writeFileSync(path.join(sourceRoot, "after.txt"), "after\n");
  assert.throws(() => shardExecutor.git(sourceRoot, ["diff", "--no-index", "--quiet", "before.txt", "after.txt"]),
    /git diff .*failed: 1$/);
});

test("COORD-1052: executor refuses stale census destinations before dispatching any worker", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-executor-stale-census-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), out = path.join(root, "executor"), census = path.join(root, "records");
  for (const dir of [source, out, census]) fs.mkdirSync(dir);
  const sentinel = path.join(root, "worker-started");
  const runner = path.join(source, "runner.js");
  fs.writeFileSync(runner, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, "launched");\n`);
  gitFixture(source, ["init", "-q"]);
  gitFixture(source, ["add", "."]);
  gitFixture(source, ["commit", "-qm", "Committed census fixture"]);
  const logger = path.join(root, "logger.cjs");
  fs.writeFileSync(logger, "// fixture observer\n");
  const descriptorPath = path.join(root, "observer.json");
  const hash = require("node:crypto").createHash("sha256").update(fs.readFileSync(logger)).digest("hex");
  fs.writeFileSync(descriptorPath, JSON.stringify({ schema_version: 1, kind: "release-suite-census", mode: "sharded",
    logger_path: logger, logger_sha256: `sha256:${hash}`, output_root: census }));
  const manifestPath = path.join(out, "executor.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: source, source_commit: gitFixture(source, ["rev-parse", "HEAD"]),
    runner, out_dir: out, engine_coverage: true, census_observer_descriptor_path: descriptorPath,
    shards: [1, 2].map((id) => ({ id, suites: [{ module: "core", path: `suite-${id}.test.js` }] })) }));
  const execute = () => spawnSync(process.execPath, [require.resolve("./test-sharding-executor.js"), manifestPath],
    { encoding: "utf8", timeout: 10_000 });
  const records = path.join(census, "workers");
  const elsewhere = path.join(root, "unowned-records");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, records, "dir");
  const linked = execute();
  assert.equal(linked.status, 2, linked.stderr);
  assert.match(linked.stderr, /census workers root is not canonical/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.unlinkSync(records);

  const stale = path.join(census, "worker-2.report.json");
  fs.writeFileSync(stale, "preserve prior report");
  const refused = execute();
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /worker 2 report destination already exists/);
  assert.equal(fs.readFileSync(stale, "utf8"), "preserve prior report");
  assert.equal(fs.existsSync(sentinel), false, "no earlier worker can start before all destinations are checked");
  assert.deepEqual(fs.readdirSync(path.join(out, "workers")), []);
  assert.equal(fs.existsSync(path.join(out, "shard-results.json")), false);

  fs.rmSync(records, { recursive: true });
  fs.unlinkSync(stale);
  const racedRecord = path.join(records, "2", "prior.json");
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (directory, options) => {
    const made = mkdir(directory, options);
    if (directory === path.dirname(racedRecord)) fs.writeFileSync(racedRecord, "racing writer evidence");
    return made;
  });
  await assert.rejects(shardExecutor.main([manifestPath]), /worker 2 census directory is not empty/);
  assert.equal(fs.readFileSync(racedRecord, "utf8"), "racing writer evidence");
  assert.equal(fs.existsSync(sentinel), false);
  assert.deepEqual(fs.readdirSync(path.join(out, "workers")), []);
  assert.equal(fs.existsSync(path.join(out, "shard-results.json")), false);
});

test("COORD-900: measured-duration planning is deterministic and assigns every suite once", () => {
  const ties = ["d", "b", "c", "a"].map((id) => ({ module: "core", path: `${id}.test.js`, duration_ms: 5 }));
  assert.deepEqual(sharding.planShards(ties, 2).shards.map(({ suites }) => suites.map(({ path }) => path)),
    [["a.test.js", "c.test.js"], ["b.test.js", "d.test.js"]]);
  const a = sharding.planShards(inventory, 3);
  const b = sharding.planShards(inventory.slice().reverse(), 3);
  assert.deepEqual(a, b);
  assert.equal(a.shards.reduce((sum, shard) => sum + shard.suites.length, 0), inventory.length);
  assert.equal(sharding.validateShardPlan(sharding.normalizeInventory(inventory), a.shards.map((s) => ({ id: s.id, suites: s.suites }))), true);
});

test("COORD-900: without complete measured history, stable assignment is explicit and durations stay unknown", () => {
  const withoutHistory = inventory.map(({ module, path, timing_sensitive }) => ({ module, path, timing_sensitive }));
  const a = sharding.planShards(withoutHistory, 3);
  const b = sharding.planShards(withoutHistory.slice().reverse(), 3);
  assert.deepEqual(a, b);
  assert.equal(a.algorithm, "stable-path-round-robin-v1");
  assert.equal(a.duration_source, "none");
  assert.equal(a.total_duration_ms, null);
  assert.ok(a.shards.every((shard) => shard.estimated_duration_ms === null));
  assert.throws(() => sharding.planShards([
    { module: "core", path: "a.test.js", duration_ms: 4 },
    { module: "core", path: "b.test.js" },
  ], 2), /include a measured positive duration for every suite or none/);
});

test("COORD-900: timing-sensitive suites receive dedicated shards", () => {
  const plan = sharding.planShards(inventory, 3);
  const dedicated = plan.shards.filter((shard) => shard.timing_sensitive_dedicated);
  assert.equal(dedicated.length, 1);
  assert.deepEqual(dedicated[0].suites.map((suite) => suite.path), ["coord/scripts/concurrent-burnin.test.js"]);
});

test("COORD-900: measured durations drive greedy balance and are reported", () => {
  const plan = sharding.planShards(inventory, 3);
  assert.deepEqual(plan.shards.map((shard) => shard.estimated_duration_ms), [60, 60, 50]);
  assert.equal(plan.algorithm, "measured-duration-greedy-v1");

  const equalDurations = inventory.map((suite) => ({ ...suite, duration_ms: 10 }));
  const tied = sharding.planShards(equalDurations.slice().reverse(), 3);
  assert.deepEqual(tied.shards.filter((shard) => !shard.timing_sensitive_dedicated)
    .map((shard) => shard.suites.map((suite) => path.basename(suite.path))), [
    ["a.test.js", "d.test.js"],
    ["b.test.js", "c.test.js"],
  ]);
});

test("COORD-900: missing, duplicated, unknown, or invalid duration input fails closed", () => {
  assert.throws(() => sharding.planShards(inventory, 1), /timing-sensitive suites dedicated/);
  assert.throws(() => sharding.normalizeInventory([...inventory, inventory[0]]), /duplicate suite/);
  assert.throws(() => sharding.planShards([
    { ...inventory[4], path: "a.test.js" }, { ...inventory[4], path: "b.test.js" },
  ], 1), /timing-sensitive suites dedicated/);
  assert.throws(() => sharding.validateShardPlan(inventory, [{ id: 1, suites: inventory.slice(1) }]), /missing=/);
  assert.throws(() => sharding.normalizeInventory([{ module: "core", path: "x.test.js", duration_ms: 0 }]), /invalid measured duration/);
  assert.throws(() => sharding.normalizeInventory({}), /inventory must be an array/);
  assert.throws(() => sharding.normalizeInventory([null]), /needs a module and path/);
  assert.throws(() => sharding.normalizeInventory([{ module: "core", path: "x.test.js", duration_ms: Infinity }]), /invalid measured duration/);
  assert.throws(() => sharding.planShards([], 1), /exceeds suite count/);
  assert.throws(() => sharding.resolveShardCount(0), /positive integer/);
  assert.throws(() => sharding.resolveShardCount("auto", { cpuCount: 0, freeMemoryBytes: 1, maxMemoryBytes: 1 }), /available CPU count/);
  assert.throws(() => sharding.resolveShardCount("auto", { cpuCount: 1, freeMemoryBytes: 0, maxMemoryBytes: 1 }), /available memory/);
  assert.throws(() => sharding.verifyCutInventory("not-an-array", []), /must be arrays/);
  assert.throws(() => sharding.verifyCutInventory(["a.test.js"], [{ suites: [{ path: "extra.test.js" }] }]), /unexpected=/);
});

test("COORD-1052: timing-sensitive suite policy rejects malformed entries and duplicates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, "engine");
  fs.mkdirSync(engine, { recursive: true });
  const policyPath = path.join(engine, "test-policy.json");
  const write = (sharding) => fs.writeFileSync(policyPath, JSON.stringify({ sharding }));
  write({});
  assert.throws(() => sharding.loadTimingSensitiveSuites(root), /invalid timing-sensitive suite policy/);
  write({ timing_sensitive_suites: [{ path: "src/not-a-suite.js", reason: "bad path" }] });
  assert.throws(() => sharding.loadTimingSensitiveSuites(root), /invalid timing-sensitive suite entry/);
  write({ timing_sensitive_suites: [{ path: "coord/engine/scripts/a.test.js", reason: "  " }] });
  assert.throws(() => sharding.loadTimingSensitiveSuites(root), /invalid timing-sensitive suite entry/);
  write({ timing_sensitive_suites: [
    { path: "coord/engine/scripts/a.test.js", reason: "first" },
    { path: "coord/engine/scripts/a.test.js", reason: "duplicate" },
  ] });
  assert.throws(() => sharding.loadTimingSensitiveSuites(root), /duplicate timing-sensitive suite/);
});

test("COORD-900: --shards auto is bounded by available CPUs and memory", (t) => {
  t.mock.method(os, "availableParallelism", () => 0);
  t.mock.method(os, "cpus", () => [{}, {}, {}]);
  assert.equal(sharding.resolveShardCount("auto", { freeMemoryBytes: 16, maxMemoryBytes: 4 }), 3);
  assert.equal(sharding.resolveShardCount("auto", { cpuCount: 16, freeMemoryBytes: 12 * 1024 ** 3, maxMemoryBytes: 4 * 1024 ** 3 }), 3);
  assert.equal(sharding.resolveShardCount("auto", { cpuCount: 2, freeMemoryBytes: 12 * 1024 ** 3, maxMemoryBytes: 4 * 1024 ** 3 }), 2);
});

test("COORD-900: public-cut inventory must match assignments exactly", () => {
  assert.equal(sharding.verifyCutInventory(["a.test.js", "b.test.js"], [
    { suites: [{ path: "a.test.js" }] }, { suites: [{ path: "b.test.js" }] },
  ]), true);
  assert.throws(() => sharding.verifyCutInventory(["a.test.js", "b.test.js"], [
    { suites: [{ path: "a.test.js" }, { path: "a.test.js" }] },
  ]), /missing=.*duplicate=/);
});

test("COORD-1050: relocated shard coverage preserves native source ordering", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-coverage-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "worker");
  const targetRoot = path.join(root, "a space source");
  const outDir = path.join(root, "aggregate");
  const rawDirectory = path.join(root, "worker", "tmp", "v8");
  fs.mkdirSync(rawDirectory, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "coord", "engine"), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, "coord", "engine"), { recursive: true });
  const sourceFile = path.join(sourceRoot, "coord", "engine", "source.js");
  const targetFile = path.join(targetRoot, "coord", "engine", "source.js");
  const externalFile = path.join(root, "a!unrelated-preload.js");
  fs.writeFileSync(sourceFile, "module.exports = 1;\n");
  fs.writeFileSync(targetFile, "module.exports = 1;\n");
  fs.mkdirSync(path.dirname(externalFile), { recursive: true });
  fs.writeFileSync(externalFile, "module.exports = 2;\n");
  fs.writeFileSync(path.join(rawDirectory, "coverage-1-1234567890123-1.json"), JSON.stringify({ result: [
    { url: pathToFileURL(externalFile).href }, { url: pathToFileURL(sourceFile).href },
  ] }));
  const externalRelativeToWorker = path.relative(sourceRoot, externalFile).split(path.sep).join("/");
  const normalized = sharding.normalizeRawCoverageModules([{ name: "core", rawDirectory,
    workspace_root: sourceRoot, lcov: `TN:\nSF:${externalRelativeToWorker}\nDA:1,1\nend_of_record\nSF:${sourceFile}\nDA:1,1\nend_of_record\n` }], {
    sourceWorkspaceRoots: [sourceRoot], targetWorkspaceRoot: targetRoot, outDir,
  });
  const raw = fs.readFileSync(path.join(normalized.modules[0].rawDirectory, "coverage-1-1234567890123-1.json"), "utf8");
  const normalizedUrls = JSON.parse(raw).result.map((script) => script.url);
  assert.deepEqual(normalizedUrls, [pathToFileURL(externalFile).href, pathToFileURL(targetFile).href]);
  assert.deepEqual(normalized.modules[0].lcov.split(/\r?\n/).filter((line) => line.startsWith("SF:")), [
    "SF:coord/engine/source.js", "SF:../a!unrelated-preload.js",
  ], "LCOV paths are normalized and records follow the relocated native source order");
  assert.deepEqual(normalizedUrls.map(fileURLToPath), [externalFile, targetFile]);
  const sourceModule = { name: "malformed", rawDirectory, workspace_root: sourceRoot };
  assert.throws(() => sharding.normalizeRawCoverageModules([{ ...sourceModule, lcov: `SF:${sourceFile}\nDA:1,1\n` }], {
    sourceWorkspaceRoots: [sourceRoot], targetWorkspaceRoot: targetRoot, outDir,
  }), /incomplete LCOV record/);
  assert.throws(() => sharding.normalizeRawCoverageModules([{ ...sourceModule, lcov: "TN:\n" }], {
    sourceWorkspaceRoots: [sourceRoot], targetWorkspaceRoot: targetRoot, outDir,
  }), /incomplete LCOV record|no source records/);
  assert.throws(() => sharding.normalizeRawCoverageModules([{ ...sourceModule,
    lcov: `SF:${sourceFile}\nDA:1,1\nend_of_record\nTN:\nDA:1,1\nend_of_record\n` }], {
    sourceWorkspaceRoots: [sourceRoot], targetWorkspaceRoot: targetRoot, outDir,
  }), /no source file/);
});

test("COORD-900: rewritten shard reports point at preserved normalized coverage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-report-rewrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workerRoot = path.join(root, "workers");
  const reportPath = path.join(workerRoot, "shard-01", "report.json");
  const resultsPath = path.join(root, "shard-results.json");
  const oldRaw = path.join(workerRoot, "shard-01", "tmp", "coverage");
  const normalizedRaw = path.join(root, "coverage-merged-input", "module-000");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(normalizedRaw, { recursive: true });
  const worker = { id: 1, report_path: reportPath, report: { engine_coverage: { raw_modules: [
    { name: "core", rawDirectory: oldRaw, workspace_root: path.join(workerRoot, "shard-01", "workspace"), lcov: "SF:/old/file.js\nend_of_record\n" },
  ] } } };
  const runManifest = require("./run-manifest.js");
  const { inputs, host } = runManifest.collectInputs({ root: process.cwd(), gateConfig: { fixture: "report-rewrite" } });
  const manifestPath = path.join(workerRoot, "shard-01", "report.manifest.json");
  worker.report.run_manifest = { path: manifestPath };
  fs.writeFileSync(reportPath, JSON.stringify(worker.report));
  runManifest.writeManifest(manifestPath, runManifest.buildManifest({ tool: "test-shard-report",
    inputs, host, lanes: [{ name: "shard-1", exit_code: 0, signal: null, duration_ms: 1 }],
    artifacts: runManifest.artifactDigests([reportPath]) }));
  fs.writeFileSync(resultsPath, JSON.stringify({ results: [{ id: 1, report: worker.report }] }));
  const shardRun = { workerRoot, resultsPath, workers: [worker] };
  sharding.rewriteShardCoverageReports(shardRun, [{ name: "core-shard-1", rawDirectory: normalizedRaw,
    source_raw_directory: oldRaw, lcov: "SF:/source/file.js\nend_of_record\n" }], "/source");
  const workerReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const resultReport = JSON.parse(fs.readFileSync(resultsPath, "utf8")).results[0].report;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(runManifest.validateManifest(manifest), [], "rewriting normalized coverage refreshes the child artifact digest");
  assert.deepEqual(manifest.artifacts, runManifest.artifactDigests([reportPath]));
  for (const module of [workerReport.engine_coverage.raw_modules[0], resultReport.engine_coverage.raw_modules[0]]) {
    assert.equal(module.rawDirectory, normalizedRaw);
    assert.equal(module.workspace_root, "/source");
    assert.doesNotMatch(module.rawDirectory, /shard-01\/tmp/);
  }
  delete manifest.artifacts;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const priorModule = worker.report.engine_coverage.raw_modules[0];
  sharding.rewriteShardCoverageReports(shardRun, [{ ...priorModule, source_raw_directory: normalizedRaw }], "/source");
  const emptyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(emptyManifest.artifacts, []);
  assert.deepEqual(runManifest.validateManifest(emptyManifest), []);
  const unmeasured = { id: 2, report: { result: "partial", engine_coverage: null } };
  const reportBytes = fs.readFileSync(reportPath);
  assert.throws(() => sharding.rewriteShardCoverageReports({ workers: [unmeasured] }, [], "/source"),
    /shard results path is missing/);
  fs.writeFileSync(resultsPath, JSON.stringify({ source_commit: "fixture" }));
  assert.equal(sharding.rewriteShardCoverageReports({ resultsPath, workers: [unmeasured] }, [], "/source"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultsPath, "utf8")), { source_commit: "fixture" });
  assert.deepEqual(fs.readFileSync(reportPath), reportBytes);
});

test("COORD-900: clean persisted pre-gate runs remove worker trees but keep reports and normalized coverage; failures retain trees", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-worker-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const makeRun = (name) => {
    const workerRoot = path.join(root, name, "workers");
    const shardDir = path.join(workerRoot, "shard-01");
    const worker = {
      id: 1,
      workspace: path.join(shardDir, "workspace"),
      tmp: path.join(shardDir, "tmp"),
      runtime: path.join(shardDir, "runtime"),
      report_path: path.join(shardDir, "report.json"),
    };
    for (const dir of [worker.workspace, worker.tmp, worker.runtime]) fs.mkdirSync(dir, { recursive: true });
    const normalizedCoverage = path.join(root, name, "coverage-merged-input", "module-000");
    fs.mkdirSync(normalizedCoverage, { recursive: true });
    fs.writeFileSync(path.join(normalizedCoverage, "snapshot.json"), "normalized coverage\n");
    const report = { engine_coverage: { raw_modules: [
      { rawDirectory: normalizedCoverage },
    ] }, run_manifest: { path: path.join(shardDir, "report.manifest.json") } };
    fs.writeFileSync(worker.report_path, JSON.stringify(report));
    const runManifest = require("./run-manifest.js");
    const { inputs, host } = runManifest.collectInputs({ root: process.cwd(), gateConfig: { fixture: name } });
    runManifest.writeManifest(report.run_manifest.path, runManifest.buildManifest({ tool: "test-shard-cleanup", inputs, host,
      lanes: [{ name: "shard-1", exit_code: 0, signal: null, duration_ms: 1 }],
      artifacts: runManifest.artifactDigests([worker.report_path]) }));
    return { shardRun: { workerRoot, workers: [worker] }, worker, normalizedCoverage };
  };
  const incomplete = makeRun("incomplete");
  assert.equal(sharding.cleanupShardWorkers(incomplete.shardRun, { reportPersisted: false, allGreen: true }), false);
  assert.ok(fs.existsSync(incomplete.worker.workspace));
  const failed = makeRun("failed");
  assert.equal(sharding.cleanupShardWorkers(failed.shardRun, { reportPersisted: true, allGreen: false }), false);
  assert.ok(fs.existsSync(failed.worker.workspace));

  const preGate = makeRun("pre-gate");
  assert.equal(sharding.cleanupShardWorkers(preGate.shardRun, { reportPersisted: true, allGreen: true }), true,
    "authorization status is deliberately not a cleanup condition");
  for (const dir of [preGate.worker.workspace, preGate.worker.tmp, preGate.worker.runtime]) assert.equal(fs.existsSync(dir), false);
  assert.equal(JSON.parse(fs.readFileSync(preGate.worker.report_path, "utf8")).engine_coverage.raw_modules[0].rawDirectory,
    preGate.normalizedCoverage);
  assert.equal(fs.readFileSync(path.join(preGate.normalizedCoverage, "snapshot.json"), "utf8"), "normalized coverage\n");
  assert.equal(sharding.cleanupShardWorkers(preGate.shardRun, { reportPersisted: true, allGreen: true }), true,
    "a retry still validates retained evidence after worker directories are already gone");
  const selected = makeRun("selection");
  const selectedReport = JSON.parse(fs.readFileSync(selected.worker.report_path, "utf8"));
  selectedReport.engine_coverage = null;
  fs.writeFileSync(selected.worker.report_path, JSON.stringify(selectedReport));
  fs.rmdirSync(selected.worker.tmp);
  assert.equal(sharding.cleanupShardWorkers(selected.shardRun, { reportPersisted: true, allGreen: true }), true,
    "a partial cleanup retry removes remaining worker directories");
  for (const directory of [selected.worker.workspace, selected.worker.tmp, selected.worker.runtime]) {
    assert.equal(fs.existsSync(directory), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(selected.worker.report_path, "utf8")), selectedReport);
});

// COORD-946: the cut-manifest half ("ships in both cuts") reads release/, which the
// cut strips, so it lives in release/timing-sensitive-cut-manifest.test.js.
test("COORD-900: timing-sensitive suite metadata is governed", () => {
  const configured = sharding.loadTimingSensitiveSuites(path.resolve(__dirname, "../.."));
  assert.deepEqual(configured, shardPolicy.timing_sensitive_suites.map((suite) => suite.path));
  assert.ok(configured.some((file) => file.includes("concurrent-burnin")), "COORD-224 burn-in stays dedicated");
  assert.ok(configured.some((file) => file.includes("session-lifecycle-conformance")), "COORD-712 lifecycle burn-in stays dedicated");
  assert.ok(configured.some((file) => file.includes("session-lifecycle-mutations")), "COORD-857 reaping burn-in stays dedicated");
});

test("COORD-900: direct runner stays provisional; donor policy and live suspension govern authority", (t) => {
  const directAuthority = sharding.resolveShardAuthority({ contentRoot: path.resolve(__dirname, "../.."), workspaceRoot: path.resolve(__dirname, "../../..") });
  assert.equal(directAuthority.authoritative, false, "direct runner has no donor wrapper receipt authority");
  assert.match(directAuthority.reason, /provisional; donor governance receipt is required/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-authority-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, "coord");
  const policyFile = path.join(content, "engine", "test-policy.json");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  const enabled = { authoritative: true, scope: "resolved-policy-plan", suspension: { active: false, reason: null, evidence: null },
    comparison: { first_sharded_run_requires_same_tree_serial_comparison: false, scheduled_serial_full_comparison: false,
      compared: ["test_identity", "outcome", "coverage_findings"],
      mismatch_action: "fail-qualification-and-automatically-suspend",
      comparison_execution: "donor-journaled-transaction" } };
  const donorAuthority = () => sharding.resolveShardAuthority({ contentRoot: content, workspaceRoot: root,
    donorWrapper: true, board: { metadata: {} } });
  assert.match(donorAuthority().reason, /cannot read sharding authority policy/);
  fs.writeFileSync(policyFile, "malformed JSON");
  assert.match(donorAuthority().reason, /cannot read sharding authority policy/);
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, authoritative: false } }));
  assert.equal(sharding.resolveShardAuthority({ contentRoot: content, workspaceRoot: root }).authoritative, false);
  assert.match(donorAuthority().reason, /not authorized for resolved policy plans/);
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, scope: "unrecognized-scope" } }));
  assert.match(donorAuthority().reason, /not authorized for resolved policy plans/);
  for (const suspension of [true, "suspended", {}, { active: null }]) {
    fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, suspension } }));
    assert.match(donorAuthority().reason, /suspension state is malformed/);
  }
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, suspension: { active: true } } }));
  assert.match(donorAuthority().reason, /suspended: comparison mismatch/);
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: enabled }));
  assert.deepEqual(sharding.resolveShardAuthority({ contentRoot: content, workspaceRoot: root, donorWrapper: true, board: { metadata: {} } }), {
    authoritative: true, scope: "resolved-policy-plan", comparison: ["test_identity", "outcome", "coverage_findings"], evidence_pending: true,
  });
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, suspension: { active: true, reason: "identity mismatch", evidence: "comparison.json" } } }));
  assert.match(sharding.resolveShardAuthority({ contentRoot: content, workspaceRoot: root, donorWrapper: true,
    board: { metadata: { test_sharding: { suspension: { active: true, reason: "identity mismatch" } } } } }).reason, /suspended: identity mismatch/);
  fs.writeFileSync(policyFile, JSON.stringify({ sharding: { ...enabled, comparison: { ...enabled.comparison,
    scheduled_serial_full_comparison: true } } }));
  assert.match(sharding.resolveShardAuthority({ contentRoot: content, workspaceRoot: root, donorWrapper: true, board: { metadata: {} } }).reason, /safeguards are incomplete/);
});

test("COORD-900: isolated workers execute an exact suite partition on clean clones", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord900-shard-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engineScripts = path.join(root, "coord", "engine", "scripts");
  fs.mkdirSync(engineScripts, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../test-policy.json"), path.join(root, "coord", "engine", "test-policy.json"));
  fs.copyFileSync(path.join(__dirname, "test-sharding-executor.js"), path.join(engineScripts, "test-sharding-executor.js"));
  fs.writeFileSync(path.join(engineScripts, "a.test.js"), "// fixture suite a\n");
  fs.writeFileSync(path.join(engineScripts, "b.test.js"), "// fixture suite b\n");
  fs.writeFileSync(path.join(engineScripts, "test-runner.js"), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const files = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--file') files.push(args[++i]);
    const partial = args.includes('--shard-child');
    const report = args[args.indexOf('--report') + 1];
    const identities = files.flatMap((file) => [
      { file, title: 'fixture passes: ' + file, outcome: 'pass' },
      { file, title: 'fixture skipped: ' + file, outcome: 'skip' },
    ]).sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
    const coverage_findings = files.filter((file) => file.endsWith('/a.test.js')).map((file) => ({ file, branch: 'b0', uncovered: false }));
    const failed = files.includes(process.env.COORD_FIXTURE_FAIL_FILE);
    fs.writeFileSync(report, JSON.stringify({ result: failed ? 'fail' : partial ? 'partial' : 'pass', execution_order: files.slice().sort(), identities, coverage_findings,
      results: files.map(() => ({ tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0, failing_tests: [] })),
      governed_tree_violations: [], coverage_source_violations: [], engine_coverage: null }));
    if (failed) process.exitCode = 1;
  `);
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["config", "user.name", "Coord fixture"]);
  gitFixture(root, ["config", "user.email", "coord@example.invalid"]);
  gitFixture(root, ["add", "."]);
  gitFixture(root, ["commit", "-q", "-m", "fixture"]);
  const outDir = path.join(root, "..", `coord900-shard-output-${process.pid}`);
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const serialReport = path.join(root, "..", `coord900-serial-report-${process.pid}.json`);
  t.after(() => fs.rmSync(serialReport, { force: true }));
  execFileSync(process.execPath, [path.join(engineScripts, "test-runner.js"), "--report", serialReport,
    "--file", "coord/engine/scripts/a.test.js", "--file", "coord/engine/scripts/b.test.js"], { cwd: root });
  const serial = JSON.parse(fs.readFileSync(serialReport, "utf8"));
  const run = sharding.executeShards({ workspaceRoot: root, contentRoot: path.join(root, "coord"),
    selected: [{ name: "core", files: ["coord/engine/scripts/a.test.js", "coord/engine/scripts/b.test.js"] }],
    count: 2, engineCoverage: false, outDir, timingSensitive: [] });
  assert.deepEqual(run.workers.map((worker) => worker.result), ["pass", "pass"]);
  assert.deepEqual(run.workers.flatMap((worker) => worker.assigned).sort(), ["coord/engine/scripts/a.test.js", "coord/engine/scripts/b.test.js"]);
  const shardReports = run.workers.map((worker) => worker.report);
  const identities = shardReports.flatMap((report) => report.identities).sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
  const coverageFindings = shardReports.flatMap((report) => report.coverage_findings).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(identities, serial.identities, "serial and sharded fixture runs preserve test identities and outcomes");
  assert.deepEqual(coverageFindings, serial.coverage_findings, "serial and sharded fixture runs preserve coverage findings");
  for (const worker of run.workers) {
    assert.equal(worker.report.result, "partial", "a shard report is not a full gate result");
    assert.notEqual(worker.workspace, root, "each worker executes in its own clone");
    assert.notEqual(worker.tmp, os.tmpdir(), "each worker has its own TMPDIR");
    assert.ok(worker.runtime, "each worker has an isolated runtime directory");
    assert.ok(worker.port >= 49152 && worker.port <= 65535, "each worker receives an isolated dynamic port");
  }
  assert.equal(new Set(run.workers.map((worker) => worker.port)).size, run.workers.length);

  const failedOutDir = path.join(root, "..", `coord900-shard-failed-output-${process.pid}`);
  t.after(() => fs.rmSync(failedOutDir, { recursive: true, force: true }));
  const failed = sharding.executeShards({ workspaceRoot: root, contentRoot: path.join(root, "coord"),
    selected: [{ name: "core", files: ["coord/engine/scripts/a.test.js", "coord/engine/scripts/b.test.js"] }],
    count: 2, engineCoverage: false, outDir: failedOutDir, timingSensitive: [],
    env: { ...process.env, COORD_FIXTURE_FAIL_FILE: "coord/engine/scripts/b.test.js" } });
  assert.match(failed.validationError, /executor exited 1/);
  assert.equal(failed.workers.find((worker) => worker.assigned.includes("coord/engine/scripts/b.test.js")).result, "fail");
});

// COORD-1015: git reports the canonical toplevel. A runner workspace reached through a
// symlinked parent is still the Git workspace root; it must not be refused as a non-root.
test("COORD-1015 executeShards: a workspace root reached through a symlinked parent is still a Git workspace root", (t) => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shard-1015-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "shard-1015-link-"));
  t.after(() => { fs.rmSync(linkParent, { recursive: true, force: true }); fs.rmSync(real, { recursive: true, force: true }); });
  gitFixture(real, ["init", "-q"]);
  gitFixture(real, ["config", "user.name", "Coord fixture"]);
  gitFixture(real, ["config", "user.email", "coord@example.invalid"]);
  gitFixture(real, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
  fs.symlinkSync(real, path.join(linkParent, "ws"), "dir");
  const viaLink = path.join(linkParent, "ws");
  let message = "";
  try {
    sharding.executeShards({ workspaceRoot: viaLink, contentRoot: path.join(viaLink, "coord"), selected: [],
      count: 1, engineCoverage: false, outDir: path.join(real, "out"), timingSensitive: [] });
  } catch (error) {
    message = error.message;
  }
  assert.doesNotMatch(message, /requires a Git workspace root/);
});

test("COORD-1052: shard assignment validation rejects malformed, duplicated and unknown suites", () => {
  const suites = [{ path: "a.test.js" }, { path: "b.test.js" }];
  assert.throws(() => sharding.validateShardPlan(suites, [{ id: 1 }]), /has no suite list/);
  assert.throws(() => sharding.validateShardPlan(suites, [{ id: 1, suites: [{ path: "foreign.test.js" }] }]), /unknown suite/);
  assert.throws(() => sharding.validateShardPlan(suites, [{ id: 1, suites: [suites[0], suites[0], suites[1]] }]), /duplicate=\["a.test.js"\]/);
  assert.throws(() => sharding.verifyCutInventory(["a.test.js"], [{}, { suites: [suites[0], suites[0]] }]), /duplicate=\["a.test.js"\]/);
  assert.equal(sharding.validateShardPlan(suites, [{ id: 1, suites: [suites[1]] }, { id: 2, suites: [suites[0]] }]), true);
});

test("COORD-1052: raw shard normalization rejects missing and malformed evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-raw-refusal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = path.join(root, "raw"), source = path.join(root, "worker"), target = path.join(root, "canonical");
  fs.mkdirSync(raw);
  const options = { sourceWorkspaceRoots: [source], targetWorkspaceRoot: target, outDir: path.join(root, "normalized") };
  const entry = { name: "core", rawDirectory: raw, workspace_root: source, lcov: "SF:coord/source.js\nDA:1,1\nend_of_record\n" };
  assert.throws(() => sharding.normalizeRawCoverageModules([], options), /no raw modules/);
  assert.throws(() => sharding.normalizeRawCoverageModules([null], options), /record is incomplete/);
  assert.throws(() => sharding.normalizeRawCoverageModules([{ ...entry, workspace_root: target }], options), /unrecognized shard workspace/);
  assert.throws(() => sharding.normalizeRawCoverageModules([entry], options), /directory is incomplete/);
  const wrong = path.join(raw, "not-coverage.json");
  fs.writeFileSync(wrong, "{}");
  assert.throws(() => sharding.normalizeRawCoverageModules([entry], options), /directory is incomplete/);
  fs.unlinkSync(wrong);
  const file = path.join(raw, "coverage-1-1234567890123-1.json");
  fs.writeFileSync(file, JSON.stringify({ result: {} }));
  assert.throws(() => sharding.normalizeRawCoverageModules([entry], options), /invalid raw coverage snapshot/);
  fs.writeFileSync(file, JSON.stringify({ result: [{ url: "node:internal/test_runner" }] }));
  const normalized = sharding.normalizeRawCoverageModules([entry], options);
  assert.equal(JSON.parse(fs.readFileSync(path.join(normalized.modules[0].rawDirectory, path.basename(file)), "utf8")).result[0].url,
    "node:internal/test_runner", "non-file source URLs must remain unchanged");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { result: [{ url: "node:internal/test_runner" }] }, "source evidence is never rewritten");
});

test("COORD-1052: cleanup validates every worker before deleting any diagnostics", async (t) => {
  const cases = [
    ["missing runtime", (f) => { f.last.runtime = null; }, /runtime path is missing/],
    ["outside root", (f) => { f.last.tmp = path.join(f.root, "outside"); }, /outside worker root/],
    ["root itself", (f) => { f.last.workspace = f.run.workerRoot; }, /outside worker root/],
    ["symlink escapes worker directories", (f) => {
      const link = path.join(f.run.workerRoot, "linked");
      fs.symlinkSync(f.root, link);
      f.last.tmp = path.join(link, "normalized");
    }, /noncanonical temp directory/],
    ["missing report", (f) => fs.unlinkSync(f.last.report_path), /without persisted report/],
    ["report inside workspace", (f) => {
      f.last.report_path = path.join(f.last.workspace, "report.json");
      fs.writeFileSync(f.last.report_path, JSON.stringify(f.report));
    }, /remove shard 2 report/],
    ["missing normalized coverage", (f) => { f.report.engine_coverage.raw_modules[0].rawDirectory = path.join(f.root, "missing"); }, /without preserved normalized coverage/],
    ["coverage inside temp", (f) => { f.report.engine_coverage.raw_modules[0].rawDirectory = f.last.tmp; }, /without preserved normalized coverage/],
    ["missing manifest", (f) => { f.report.run_manifest = { path: path.join(f.run.workerRoot, "missing.manifest.json") }; }, /without persisted manifest/],
    ["manifest inside runtime", (f) => {
      const file = path.join(f.last.runtime, "manifest.json"); fs.writeFileSync(file, "{}"); f.report.run_manifest = { path: file };
    }, /remove shard 2 manifest/],
    ["invalid manifest", (f) => {
      const file = path.join(f.run.workerRoot, "invalid.manifest.json"); fs.writeFileSync(file, "{}"); f.report.run_manifest = { path: file };
    }, /invalid worker manifest/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-cleanup-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workerRoot = path.join(root, "workers"), normalized = path.join(root, "normalized");
    fs.mkdirSync(normalized);
    const report = { engine_coverage: { raw_modules: [{ rawDirectory: normalized }] } };
    const workers = [1, 2].map((id) => {
      const dir = path.join(workerRoot, String(id));
      const worker = { id, workspace: path.join(dir, "workspace"), tmp: path.join(dir, "tmp"), runtime: path.join(dir, "runtime"), report_path: path.join(dir, "report.json") };
      for (const item of [worker.workspace, worker.tmp, worker.runtime]) { fs.mkdirSync(item, { recursive: true }); fs.writeFileSync(path.join(item, "keep.txt"), "diagnostic\n"); }
      fs.writeFileSync(worker.report_path, JSON.stringify(report));
      return worker;
    });
    const originalLastReport = workers[1].report_path;
    const context = { root, report, last: workers[1], run: { workerRoot, workers } };
    mutate(context);
    // Keep report deletion/path scenarios intact; other cases alter its content.
    if (fs.existsSync(originalLastReport)) fs.writeFileSync(originalLastReport, JSON.stringify(report));
    assert.throws(() => sharding.cleanupShardWorkers(context.run, { reportPersisted: true, allGreen: true }), expected);
    for (const item of [workers[0].workspace, workers[0].tmp, workers[0].runtime]) {
      assert.equal(fs.readFileSync(path.join(item, "keep.txt"), "utf8"), "diagnostic\n", "valid earlier worker must survive a later refusal");
    }
    assert.ok(fs.existsSync(normalized));
  });
});

test("COORD-1052: shard cleanup refuses unspecified or filesystem-root deletion scopes", (t) => {
  assert.throws(() => sharding.cleanupShardWorkers({ workers: [] }, { reportPersisted: true, allGreen: true }), /without a worker root/);
  assert.throws(() => sharding.cleanupShardWorkers({ workerRoot: path.parse(process.cwd()).root, workers: [] }, { reportPersisted: true, allGreen: true }), /safe worker root/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-worker-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, "linked");
  fs.symlinkSync(root, link);
  assert.throws(() => sharding.cleanupShardWorkers({ workerRoot: link, workers: [] }, { reportPersisted: true, allGreen: true }), /real worker directory/);
});

test("COORD-1052: shard execution refuses uncommitted sources and incomplete duration evidence before dispatch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-dispatch-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-dispatch-output-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true }); });
  const options = { workspaceRoot: root, contentRoot: path.join(root, "coord"),
    selected: [{ name: "core", files: ["coord/engine/scripts/a.test.js"] }], count: 1, engineCoverage: false, outDir };
  assert.throws(() => sharding.executeShards(options), /requires a Git workspace root/);
  gitFixture(root, ["init", "-q"]);
  assert.throws(() => sharding.executeShards(options), /could not bind shard run to a Git commit and tree/);
  gitFixture(root, ["commit", "--allow-empty", "-m", "shard fixture"]);
  const dirty = path.join(root, "uncommitted.txt");
  fs.writeFileSync(dirty, "uncommitted\n");
  assert.throws(() => sharding.executeShards(options), /clean committed workspace/);
  fs.unlinkSync(dirty);
  assert.throws(() => sharding.executeShards({ ...options, durations: { "unexpected.test.js": 1 } }), /exactly one measurement/);
  assert.throws(() => sharding.executeShards(options), /cannot locate canonical test runner/);
  assert.deepEqual(fs.readdirSync(outDir), [], "prerequisite refusal must not dispatch workers or create executor evidence");
});

test("COORD-1052: shard execution refuses missing or foreign executor results and preserves validation details", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-results-source-")));
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-shard-results-output-"));
  const fakeNode = path.join(outputRoot, "fixture-node");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outputRoot, { recursive: true, force: true }); });

  const runner = path.join(root, "coord", "engine", "scripts", "test-runner.js");
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../test-policy.json"), path.join(root, "coord", "engine", "test-policy.json"));
  fs.writeFileSync(runner, "process.exit(0);\n");
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["config", "user.name", "Coverage fixture"]);
  gitFixture(root, ["config", "user.email", "coverage@example.invalid"]);
  gitFixture(root, ["add", "."]);
  gitFixture(root, ["commit", "-q", "-m", "COORD-1052 shard result fixture"]);
  const sourceCommit = gitFixture(root, ["rev-parse", "HEAD"]);
  const sourceTree = gitFixture(root, ["rev-parse", "HEAD^{tree}"]);

  fs.writeFileSync(fakeNode, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const mode = process.env.COORD_SHARD_RESULT_FIXTURE;
if (mode === "missing") process.exit(0);
if (mode === "failed-before-report") process.exit(17);
if (mode === "terminated-before-report") process.kill(process.pid, "SIGTERM");
const assignment = mode === "missing-assignment" ? [] : manifest.shards[0].suites.map((suite) => suite.path);
if (mode === "merged-assignment") assignment.push(...manifest.shards[1].suites.map((suite) => suite.path));
const result = { source_commit: mode === "foreign-source" ? "f".repeat(40) : manifest.source_commit,
  source_tree: manifest.source_tree, results: mode === "missing-count" || mode === "failed-incomplete" ? [] : [{
    id: 1, assigned: mode === "omitted-assignment" ? undefined : assignment,
    report: mode === "unmeasured" ? { result: "partial" } : mode === "with-coverage" ? {
      result: "partial", engine_coverage: { raw_modules: [{ name: "core", rawDirectory: path.join(manifest.out_dir, "raw") }] },
    } : undefined,
  }] };
if (["swapped-workers", "reordered-workers", "reordered-suites", "duplicate-worker"].includes(mode)) {
  result.results = manifest.shards.map(({ id, suites }) => ({ id, assigned: suites.map(({ path }) => path) }));
  if (mode === "swapped-workers") {
    [result.results[0].assigned, result.results[1].assigned] = [result.results[1].assigned, result.results[0].assigned];
  } else if (mode === "reordered-workers") {
    result.results.reverse();
  } else if (mode === "reordered-suites") {
    result.results[0].assigned.reverse();
  } else {
    result.results[1].id = result.results[0].id;
  }
}
fs.writeFileSync(path.join(manifest.out_dir, "shard-results.json"), JSON.stringify(result));
if (mode === "nonzero" || mode === "failed-incomplete") process.exitCode = 7;
`);
  fs.chmodSync(fakeNode, 0o755);

  const options = (mode) => ({ workspaceRoot: root, contentRoot: path.join(root, "coord"),
    selected: [{ name: "core", files: ["coord/engine/scripts/example.test.js"] }], count: 1, engineCoverage: false,
    outDir: fs.mkdtempSync(path.join(outputRoot, `run-${mode}-`)), timingSensitive: [], node: fakeNode,
    env: { ...process.env, COORD_SHARD_RESULT_FIXTURE: mode } });

  assert.throws(() => sharding.executeShards(options("missing")), /shard executor did not persist worker results.*ENOENT/);
  assert.throws(() => sharding.executeShards(options("failed-before-report")), /shard executor did not persist worker results \(exit 17\).*ENOENT/);
  assert.throws(() => sharding.executeShards(options("foreign-source")), /bound to a different source snapshot/);
  assert.throws(() => sharding.executeShards({ ...options("launch-error"), node: path.join(outputRoot, "absent-node") }),
    /shard executor did not persist worker results.*ENOENT/, "an actual failed process launch cannot look like an empty successful run");
  assert.throws(() => sharding.executeShards(options("terminated-before-report")),
    /shard executor did not persist worker results \(exit SIGTERM\)/, "a signaled executor retains the termination reason");

  const omitted = sharding.executeShards(options("missing-assignment"));
  assert.match(omitted.validationError, /missing=/, "an incomplete assignment is retained as a validation failure");
  assert.equal(omitted.workers.length, 1);
  assert.deepEqual(omitted.workers[0].assigned, []);
  assert.equal(omitted.sourceCommit, sourceCommit);
  assert.equal(omitted.sourceTree, sourceTree);
  const noAssignment = sharding.executeShards(options("omitted-assignment"));
  assert.match(noAssignment.validationError, /missing=/);
  assert.deepEqual(noAssignment.rawModules, []);

  const missingCount = sharding.executeShards(options("missing-count"));
  assert.match(missingCount.validationError, /expected 1 shard results, received 0/);
  assert.deepEqual(missingCount.workers, []);

  const incompleteFailure = sharding.executeShards(options("failed-incomplete"));
  assert.match(incompleteFailure.validationError, /missing=.*; expected 1 shard results, received 0; shard executor exited 7/);
  assert.deepEqual(incompleteFailure.workers, []);

  const nonzero = sharding.executeShards({
    ...options("nonzero"), durations: { "coord/engine/scripts/example.test.js": 5 },
  });
  assert.equal(nonzero.plan.total_duration_ms, 5);
  assert.match(nonzero.validationError, /executor exited 7/);
  assert.deepEqual(nonzero.workers[0].assigned, ["coord/engine/scripts/example.test.js"]);
  const recorded = options("nonzero");
  sharding.executeShards(recorded);
  const retained = sharding.executeShards({ ...recorded, node: path.join(outputRoot, "absent-node") });
  assert.match(retained.validationError, /shard executor exited .*ENOENT/);
  assert.deepEqual(retained.workers[0].assigned, ["coord/engine/scripts/example.test.js"]);
  const unmeasured = sharding.executeShards({ ...options("unmeasured"), durations: null });
  assert.equal(unmeasured.validationError, null);
  assert.equal(unmeasured.plan.total_duration_ms, null);
  assert.deepEqual(unmeasured.rawModules, []);
  const withCoverage = sharding.executeShards({ ...options("with-coverage"), engineCoverage: true });
  assert.equal(withCoverage.validationError, null);
  assert.deepEqual(withCoverage.rawModules, [{ name: "core", rawDirectory: path.join(path.dirname(withCoverage.resultsPath), "raw") }]);
  const mergedAssignment = sharding.executeShards({
    ...options("merged-assignment"), count: 2,
    selected: [{ name: "core", files: ["coord/engine/scripts/example.test.js", "coord/engine/scripts/other.test.js"] }],
  });
  assert.equal(mergedAssignment.validationError, "expected 2 shard results, received 1");

  const paired = (mode) => sharding.executeShards({
    ...options(mode), count: 2,
    selected: [{ name: "core", files: ["a.test.js", "b.test.js", "c.test.js", "d.test.js"] }],
  });
  for (const mode of ["swapped-workers", "reordered-suites", "duplicate-worker"]) {
    const invalid = paired(mode);
    assert.match(invalid.validationError, /shard \d+ reported a different ordered assignment than the plan/, mode);
    assert.equal(invalid.workers.length, 2);
    assert.deepEqual(invalid.workers.flatMap(({ assigned }) => assigned).sort(),
      ["a.test.js", "b.test.js", "c.test.js", "d.test.js"], "a complete global union cannot validate wrong worker attribution");
    assert.equal(fs.existsSync(invalid.resultsPath), true, "validation failure retains the original executor diagnostics");
  }
  const reordered = paired("reordered-workers");
  assert.equal(reordered.validationError, null, "worker record order is independent of the order within each assigned shard");
  assert.deepEqual(reordered.workers.map(({ id }) => id), [2, 1]);
});

test("COORD-1052: auto shard count bottoms out at one when memory is below one worker budget", () => {
  assert.equal(sharding.resolveShardCount("auto", { cpuCount: 8, freeMemoryBytes: 1, maxMemoryBytes: 4 * 1024 ** 3 }), 1);
  const allDedicated = sharding.planShards([
    { module: "core", path: "a.test.js", duration_ms: 3, timing_sensitive: true },
    { module: "core", path: "b.test.js", duration_ms: 2, timing_sensitive: true },
  ], 2);
  assert.deepEqual(allDedicated.shards.map((shard) => [shard.timing_sensitive_dedicated, shard.suites.map((suite) => suite.path)]), [
    [true, ["a.test.js"]], [true, ["b.test.js"]],
  ], "an all-dedicated plan has no ordinary shard to schedule");
});

// Canonical executor/installer integration; the small child driver below is a
// fixture protocol peer, not a coverage ratchet or a release qualification.
test("COORD-1052: observer workers install local locked dependencies and preserve ordered assignments and bound evidence", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-observer-")));
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"), out = path.join(root, "executor"), census = path.join(root, "records");
  for (const dir of [source, out, census]) fs.mkdirSync(dir);
  const digest = (file) => `sha256:${require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
  const write = (relative, body) => { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  write(".gitignore", "node_modules/\n");
  const ui = "frontend/apps/coord-ui";
  const dependencies = { "executor-local-dependency": "file:./local-package" };
  write(`${ui}/package.json`, JSON.stringify({ name: "executor-ui-fixture", version: "1.0.0", private: true, dependencies }));
  write(`${ui}/local-package/package.json`, JSON.stringify({ name: "executor-local-dependency", version: "1.0.0", main: "index.js" }));
  write(`${ui}/local-package/index.js`, "module.exports = __dirname;\n");
  write(`${ui}/package-lock.json`, JSON.stringify({ name: "executor-ui-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "executor-ui-fixture", version: "1.0.0", dependencies },
      "local-package": { name: "executor-local-dependency", version: "1.0.0" },
      "node_modules/executor-local-dependency": { resolved: "local-package", link: true } } }));
  const assignments = [["coord/engine/scripts/z.test.js", "coord/engine/scripts/a.test.js"],
    ["coord/engine/scripts/y.test.js", "coord/engine/scripts/b.test.js"]];
  for (const file of assignments.flat()) write(file, `
    const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
    test('worker-local dependency exists before suite execution', () => {
      const installed = require(path.join(process.cwd(), 'frontend/apps/coord-ui/node_modules/executor-local-dependency'));
      assert.equal(installed, path.join(process.cwd(), 'frontend/apps/coord-ui/local-package'));
    });
  `);
  const logger = path.join(root, "fixture-observer.cjs");
  fs.writeFileSync(logger, `
    if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
      const fs = require('node:fs'), path = require('node:path');
      const directory = process.env.COORD_TEST_CENSUS_DIR;
      if (!directory) throw new Error('generic observer directory was not delivered');
      delete process.env.COORD_TEST_CENSUS_DIR;
      fs.writeFileSync(path.join(directory, process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json'), JSON.stringify({ file: path.resolve(process.argv[1]), cwd: process.cwd() }));
    }
  `);
  const descriptorPath = path.join(root, "observer.json");
  const descriptor = { schema_version: 1, kind: "release-suite-census", mode: "sharded", logger_path: logger,
    logger_sha256: digest(logger), output_root: census };
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const loaderPath = path.join(__dirname, "test-census-observer.js"), manifestModule = path.join(__dirname, "run-manifest.js");
  write("coord/engine/scripts/test-runner.js", `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const { spawnSync } = require('node:child_process');
    const rm = require(${JSON.stringify(manifestModule)});
    const argv = process.argv.slice(2), value = (flag) => argv[argv.indexOf(flag) + 1];
    assert.ok(argv.includes('--engine-coverage')); assert.ok(argv.includes('--shard-child'));
    assert.equal(value('--qualification-stage'), 'release'); assert.equal(value('--policy-stage'), 'release'); assert.equal(value('--qualification-mode'), 'full');
    const observer = require(${JSON.stringify(loaderPath)}).loadCensusObserverDescriptor({ descriptorPath: value('--census-observer'), expectedMode: 'sharded' });
    const files = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--file') files.push(argv[++i]);
    const directory = path.join(observer.outputRoot, 'workers', process.env.COORD_SHARD_ID);
    const testEnv = { ...process.env, COORD_TEST_CENSUS_DIR: directory };
    delete testEnv.NODE_TEST_CONTEXT; // Node assigns this to the actual suite children.
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--require', observer.loggerPath, ...files],
      { cwd: process.cwd(), env: testEnv, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const reportPath = value('--report'), manifestPath = value('--manifest');
    const collected = rm.collectInputs({ root: process.cwd() });
    const manifest = rm.buildManifest({ tool: 'executor-fixture-child', inputs: collected.inputs, host: collected.host,
      lanes: [{ name: 'fixture', exit_code: 0, signal: null, duration_ms: 1 }] });
    const report = { result: 'partial', suite_result: 'pass', workspace_root: process.cwd(), node_version: process.version,
      execution_order: files.slice().sort(), shard_assignment: files, release_observer: JSON.parse(fs.readFileSync(observer.descriptorPath, 'utf8')),
      release_observer_binding: { path: observer.descriptorPath, sha256: observer.descriptorSha256 },
      run_manifest: { path: manifestPath, input_digest: manifest.input_digest }, results: [] };
    fs.writeFileSync(reportPath, JSON.stringify(report));
    rm.writeManifest(manifestPath, rm.finalizeManifest(manifest, [reportPath, observer.descriptorPath,
      ...fs.readdirSync(directory).map((name) => path.join(directory, name))]));
  `);
  gitFixture(source, ["init", "-q"]); gitFixture(source, ["add", "."]); gitFixture(source, ["commit", "-qm", "Executor observer fixture"]);
  const commit = gitFixture(source, ["rev-parse", "HEAD"]), tree = gitFixture(source, ["rev-parse", "HEAD^{tree}"]);
  const executorManifestPath = path.join(out, "executor.json");
  fs.writeFileSync(executorManifestPath, JSON.stringify({ source_root: source, source_commit: commit, source_tree: tree,
    runner: path.join(source, "coord/engine/scripts/test-runner.js"), out_dir: out, engine_coverage: true,
    census_observer_descriptor_path: descriptorPath, ui_install_timeout_seconds: 60,
    shards: assignments.map((files, i) => ({ id: i + 1, suites: files.map((file) => ({ module: "core", path: file })) })) }));
  assert.equal(fs.existsSync(path.join(source, ui, "node_modules")), false);
  await shardExecutor.main([executorManifestPath]);
  const results = JSON.parse(fs.readFileSync(path.join(out, "shard-results.json"), "utf8"));
  assert.equal(results.source_commit, commit); assert.equal(results.source_tree, tree); assert.equal(results.results.length, 2);
  const runManifest = require("./run-manifest.js");
  for (const worker of results.results) {
    assert.equal(worker.result, "pass", worker.error);
    assert.equal(worker.ui_bootstrap.status, "passed", worker.ui_bootstrap.message);
    assert.deepEqual(worker.ui_bootstrap.command, ["npm", "--prefix", path.join(worker.workspace, ui), "ci", "--include=dev", "--no-audit", "--no-fund"]);
    assert.equal(worker.ui_bootstrap.lock_sha256, digest(path.join(source, ui, "package-lock.json")).slice(7));
    assert.deepEqual(worker.assigned, assignments[worker.id - 1]);
    assert.deepEqual(worker.report.shard_assignment, assignments[worker.id - 1]);
    assert.deepEqual(worker.report.execution_order, assignments[worker.id - 1].slice().sort());
    assert.equal(worker.report_path, path.join(census, `worker-${worker.id}.report.json`));
    assert.equal(worker.manifest_path, path.join(census, `worker-${worker.id}.manifest.json`));
    assert.equal(worker.census_dir, path.join(census, "workers", String(worker.id)));
    assert.deepEqual(worker.report.release_observer, descriptor);
    assert.deepEqual(worker.report.release_observer_binding, { path: descriptorPath, sha256: digest(descriptorPath) });
    const manifest = JSON.parse(fs.readFileSync(worker.manifest_path, "utf8"));
    assert.deepEqual(runManifest.validateManifest(manifest), []);
    assert.equal(manifest.inputs.source.commit, commit); assert.equal(manifest.inputs.source.tree, tree);
    assert.equal(manifest.inputs.source.dirty, false);
    for (const file of [worker.report_path, descriptorPath, ...fs.readdirSync(worker.census_dir).map((name) => path.join(worker.census_dir, name))]) {
      const entries = manifest.artifacts.filter((entry) => entry.path === file);
      assert.equal(entries.length, 1); assert.equal(entries[0].sha256, digest(file));
    }
    const logged = fs.readdirSync(worker.census_dir).map((name) => JSON.parse(fs.readFileSync(path.join(worker.census_dir, name), "utf8")));
    assert.deepEqual(logged.map((record) => path.relative(worker.workspace, record.file)).sort(), assignments[worker.id - 1].slice().sort());
    assert.ok(logged.every((record) => record.cwd === worker.workspace));
    const installed = fs.realpathSync(path.join(worker.workspace, ui, "node_modules/executor-local-dependency"));
    assert.equal(installed, path.join(worker.workspace, ui, "local-package"));
  }
  assert.notEqual(results.results[0].workspace, results.results[1].workspace);
  assert.notEqual(results.results[0].census_dir, results.results[1].census_dir);
  assert.equal(fs.existsSync(path.join(source, ui, "node_modules")), false, "installer never populates donor/source dependencies");
  assert.equal(gitFixture(source, ["status", "--porcelain", "--untracked-files=all"]), "");

  const observer = require("./test-census-observer.js").loadCensusObserverDescriptor({
    descriptorPath, expectedMode: "sharded",
  });
  const shardRun = { workerRoot: path.join(out, "workers"), workers: results.results };
  const opts = { reportPersisted: true, allGreen: true, censusObserver: observer };
  const [firstWorker, secondWorker] = shardRun.workers;
  const forged = { ...shardRun, workers: [firstWorker, { ...secondWorker, report_path: firstWorker.report_path }] };
  assert.throws(() => sharding.cleanupShardWorkers(forged, opts), /unexpected census report path for shard 2/);

  const manifestPath = secondWorker.manifest_path;
  const forgedManifest = { ...shardRun, workers: [
    firstWorker, { ...secondWorker, manifest_path: firstWorker.manifest_path },
  ] };
  assert.throws(() => sharding.cleanupShardWorkers(forgedManifest, opts), /mismatched census manifest path for shard 2/);
  const originalReport = fs.readFileSync(secondWorker.report_path);
  fs.writeFileSync(secondWorker.report_path, JSON.stringify({
    ...secondWorker.report, run_manifest: { path: firstWorker.manifest_path },
  }));
  assert.throws(() => sharding.cleanupShardWorkers(forgedManifest, opts), /unexpected census manifest path for shard 2/);
  fs.writeFileSync(secondWorker.report_path, originalReport);

  const backup = `${manifestPath}.backup`;
  fs.renameSync(manifestPath, backup);
  fs.symlinkSync(backup, manifestPath);
  assert.throws(() => sharding.cleanupShardWorkers(shardRun, opts), /noncanonical census manifest path/);
  fs.unlinkSync(manifestPath);
  fs.renameSync(backup, manifestPath);
  assert.ok(fs.existsSync(firstWorker.workspace), "invalid later evidence must leave earlier workers intact");
  assert.ok(fs.existsSync(secondWorker.workspace), "invalid evidence must leave the affected worker intact");

  assert.equal(sharding.cleanupShardWorkers(shardRun, opts), true);
  for (const worker of shardRun.workers) {
    for (const directory of [worker.workspace, worker.tmp, worker.runtime]) assert.equal(fs.existsSync(directory), false);
    for (const file of [worker.report_path, worker.manifest_path, worker.census_dir]) assert.ok(fs.existsSync(file));
    const manifest = JSON.parse(fs.readFileSync(worker.manifest_path, "utf8"));
    assert.deepEqual(runManifest.validateManifest(manifest), []);
  }
});


test("COORD-1052: executor fails closed when a worker runner escapes its checkout or shard port range", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-boundaries-")));
  t.after(() => { process.exitCode = originalExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = path.join(root, "source"), outputRoot = path.join(root, "output");
  fs.mkdirSync(sourceRoot); fs.mkdirSync(outputRoot);
  const runner = path.join(sourceRoot, "runner.js");
  fs.writeFileSync(runner, "process.exitCode = 0;\n");
  gitFixture(sourceRoot, ["init", "-q"]); gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor boundary fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceTree = gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const outsideRunner = path.join(root, "outside-runner.js");
  fs.writeFileSync(outsideRunner, "process.exitCode = 0;\n");
  const manifestPath = path.join(outputRoot, "executor.json");
  const assigned = ["coord/engine/scripts/a.test.js"];
  const writeManifest = (runnerPath, id) => fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot,
    source_commit: sourceCommit, source_tree: sourceTree, runner: runnerPath, out_dir: outputRoot,
    engine_coverage: false, shards: [{ id, suites: assigned.map((file) => ({ module: "core", path: file })) }] }));

  writeManifest(outsideRunner, 1);
  await shardExecutor.main([manifestPath]);
  const escaped = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8")).results[0];
  assert.equal(escaped.result, "fail");
  assert.equal(escaped.exit_code, null);
  assert.equal(escaped.signal, null);
  assert.deepEqual(escaped.assigned, assigned);
  assert.match(escaped.error, /runner path escapes the source workspace/);
  assert.equal(fs.existsSync(escaped.workspace), true, "the worker clone is retained after a runner-path refusal");
  assert.equal(fs.existsSync(escaped.report_path), false, "the escaped runner is never dispatched");

  writeManifest(runner, 16384);
  await shardExecutor.main([manifestPath]);
  const outOfRange = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8")).results[0];
  assert.equal(outOfRange.port, 65536);
  assert.equal(outOfRange.result, "fail");
  assert.equal(outOfRange.exit_code, null);
  assert.equal(outOfRange.signal, null);
  assert.deepEqual(outOfRange.assigned, assigned);
  assert.match(outOfRange.error, /exceeds the isolated port range/);
  assert.equal(fs.existsSync(outOfRange.workspace), false);
});

test("COORD-1052: a zero-exit worker with a mismatched report inventory is retained as a failure", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-inventory-source-")));
  t.after(() => { process.exitCode = originalExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const outputRoot = path.join(root, "output"); fs.mkdirSync(outputRoot);
  const sourceRoot = path.join(root, "source"); fs.mkdirSync(sourceRoot);
  const runner = path.join(sourceRoot, "runner.js");
  fs.writeFileSync(runner, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const report = args[args.indexOf('--report') + 1];
    const execution_order = process.env.COORD_SHARD_ID === '1' ? [] : undefined;
    fs.writeFileSync(report, JSON.stringify({ result: 'partial', execution_order, results: [] }));
  `);
  gitFixture(sourceRoot, ["init", "-q"]); gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor inventory fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const assigned = ["coord/engine/scripts/expected.test.js", "coord/engine/scripts/other-expected.test.js"];
  const manifestPath = path.join(outputRoot, "executor.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot, source_commit: sourceCommit,
    source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}" ]), runner, out_dir: outputRoot, engine_coverage: false,
    shards: assigned.map((file, index) => ({ id: index + 1, suites: [{ module: "core", path: file }] })) }));

  await shardExecutor.main([manifestPath]);
  const { results } = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8"));
  assert.deepEqual(results.map((worker) => worker.report.execution_order), [[], undefined]);
  for (const worker of results) {
    assert.equal(worker.result, "fail");
    assert.equal(worker.exit_code, 0);
    assert.equal(worker.signal, null);
    assert.deepEqual(worker.assigned, [assigned[worker.id - 1]]);
    assert.match(worker.error, /worker execution inventory differs/);
    assert.equal(JSON.parse(fs.readFileSync(worker.report_path, "utf8")).result, "partial",
      "the child report remains available for diagnosis despite inventory refusal");
  }
});

test("COORD-1052: a census worker without its assigned manifest fails with report and assignment retained", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-manifest-source-")));
  t.after(() => { process.exitCode = originalExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = path.join(root, "source"), outputRoot = path.join(root, "output"), censusRoot = path.join(root, "records");
  for (const directory of [sourceRoot, outputRoot, censusRoot]) fs.mkdirSync(directory);
  const loggerPath = path.join(root, "logger.cjs"), descriptorPath = path.join(root, "observer.json");
  const loggerBytes = Buffer.from("// fixture observer logger\n"); fs.writeFileSync(loggerPath, loggerBytes);
  const digest = require("node:crypto").createHash("sha256").update(loggerBytes).digest("hex");
  fs.writeFileSync(descriptorPath, JSON.stringify({ schema_version: 1, kind: "release-suite-census", mode: "sharded",
    logger_path: loggerPath, logger_sha256: `sha256:${digest}`, output_root: censusRoot }));
  const runner = path.join(sourceRoot, "runner.js");
  fs.writeFileSync(runner, `const fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst files = []; for (let i = 0; i < args.length; i++) if (args[i] === '--file') files.push(args[++i]);\nconst report = args[args.indexOf('--report') + 1];\nfs.writeFileSync(report, JSON.stringify({ result: 'partial', execution_order: files.slice().sort(), results: [] }));\n`);
  gitFixture(sourceRoot, ["init", "-q"]); gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor missing-manifest fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const assigned = ["coord/engine/scripts/worker.test.js"];
  const manifestPath = path.join(outputRoot, "executor.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot, source_commit: sourceCommit,
    source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}" ]), runner, out_dir: outputRoot, engine_coverage: true,
    census_observer_descriptor_path: descriptorPath,
    shards: [{ id: 1, suites: assigned.map((file) => ({ module: "core", path: file })) }] }));

  await shardExecutor.main([manifestPath]);
  const worker = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8")).results[0];
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, 0);
  assert.equal(worker.signal, null);
  assert.deepEqual(worker.assigned, assigned);
  assert.equal(worker.ui_bootstrap.status, "skipped", "the fixture has no UI package to install");
  assert.equal(worker.report_path, path.join(censusRoot, "worker-1.report.json"));
  assert.equal(worker.manifest_path, path.join(censusRoot, "worker-1.manifest.json"));
  assert.match(worker.error, /worker run manifest was not persisted/);
  assert.equal(fs.existsSync(worker.report_path), true);
  assert.equal(fs.existsSync(worker.manifest_path), false);
});

test("COORD-1052: failed worker UI bootstrap is a refusal and preserves assignment metadata", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-bootstrap-source-")));
  t.after(() => { process.exitCode = originalExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = path.join(root, "source"), outputRoot = path.join(root, "output"), censusRoot = path.join(root, "records");
  for (const directory of [sourceRoot, outputRoot, censusRoot]) fs.mkdirSync(directory);
  const ui = path.join(sourceRoot, "frontend/apps/coord-ui"); fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, "package.json"), JSON.stringify({ name: "fixture-ui", version: "1.0.0" }));
  fs.writeFileSync(path.join(ui, "package-lock.json"), JSON.stringify({ name: "fixture-ui", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture-ui", version: "1.0.0" } } }));
  const loggerPath = path.join(root, "logger.cjs"), descriptorPath = path.join(root, "observer.json");
  const loggerBytes = Buffer.from("// fixture observer logger\n"); fs.writeFileSync(loggerPath, loggerBytes);
  const digest = require("node:crypto").createHash("sha256").update(loggerBytes).digest("hex");
  fs.writeFileSync(descriptorPath, JSON.stringify({ schema_version: 1, kind: "release-suite-census", mode: "sharded",
    logger_path: loggerPath, logger_sha256: `sha256:${digest}`, output_root: censusRoot }));
  const runner = path.join(sourceRoot, "runner.js"); fs.writeFileSync(runner, "throw new Error('worker must not run after failed bootstrap');\n");
  gitFixture(sourceRoot, ["init", "-q"]); gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor bootstrap fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const assigned = ["coord/engine/scripts/worker.test.js"];
  const manifestPath = path.join(outputRoot, "executor.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot, source_commit: sourceCommit,
    source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}" ]), runner, out_dir: outputRoot, engine_coverage: true,
    census_observer_descriptor_path: descriptorPath, ui_install_timeout_seconds: 901,
    shards: [{ id: 1, suites: assigned.map((file) => ({ module: "core", path: file })) }] }));

  await shardExecutor.main([manifestPath]);
  const worker = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8")).results[0];
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, null);
  assert.equal(worker.signal, null);
  assert.deepEqual(worker.assigned, assigned);
  assert.equal(worker.ui_bootstrap.status, "failed");
  assert.match(worker.error, /worker dependency bootstrap failed: UI install timeout/);
  assert.equal(fs.existsSync(worker.workspace), true);
  assert.equal(fs.existsSync(worker.report_path), false);

  const blockedOut = path.join(outputRoot, "blocked-cache");
  const blockedCensusRoot = path.join(root, "blocked-records");
  fs.mkdirSync(blockedCensusRoot);
  const cache = path.join(blockedOut, "workers", "shard-01", "npm-cache");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, "prior cache diagnostic");
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  fs.writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, output_root: blockedCensusRoot }));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, out_dir: blockedOut }));
  await shardExecutor.main([manifestPath]);
  const { results: [blocked] } = JSON.parse(fs.readFileSync(path.join(blockedOut, "shard-results.json"), "utf8"));
  assert.equal(blocked.result, "fail");
  assert.equal(blocked.exit_code, null);
  assert.deepEqual(blocked.assigned, assigned);
  assert.match(blocked.error, /worker dependency bootstrap failed:.*EEXIST/);
  assert.equal(fs.readFileSync(cache, "utf8"), "prior cache diagnostic");
  assert.equal(fs.existsSync(blocked.report_path), false);

  const noReceiptOut = path.join(outputRoot, "missing-receipt");
  const noReceiptCensus = path.join(root, "missing-receipt-records");
  fs.mkdirSync(noReceiptCensus);
  fs.writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, output_root: noReceiptCensus }));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, out_dir: noReceiptOut }));
  t.mock.method(require("./test-worker-ui-bootstrap.js"), "bootstrapWorkerUi", () => null);
  await shardExecutor.main([manifestPath]);
  const { results: [missing] } = JSON.parse(fs.readFileSync(path.join(noReceiptOut, "shard-results.json"), "utf8"));
  assert.equal(missing.result, "fail");
  assert.equal(missing.ui_bootstrap, null);
  assert.deepEqual(missing.assigned, assigned);
  assert.match(missing.error, /worker dependency bootstrap failed: no receipt/);
  assert.equal(fs.existsSync(missing.report_path), false);
});

test("COORD-1052: executor CLI reports malformed manifests with its fail-closed exit status", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "executor.json");
  fs.writeFileSync(manifestPath, "{ malformed\n");
  let failure;
  try { execFileSync(process.execPath, [path.join(__dirname, "test-sharding-executor.js"), manifestPath], { encoding: "utf8" }); }
  catch (error) { failure = error; }
  assert.ok(failure, "the malformed manifest must make the child exit unsuccessfully");
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /test-sharding|JSON|Unexpected/);
});


test("COORD-1052: a worker process launch error retains the assigned suite and fails closed", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-executor-spawn-error-")));
  t.after(() => { process.exitCode = originalExitCode; fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = path.join(root, "source"), outputRoot = path.join(root, "output");
  fs.mkdirSync(sourceRoot); fs.mkdirSync(outputRoot);
  const runner = path.join(sourceRoot, "runner.js"); fs.writeFileSync(runner, "process.exitCode = 0;\n");
  gitFixture(sourceRoot, ["init", "-q"]); gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor spawn error fixture"]);
  const sourceCommit = gitFixture(sourceRoot, ["rev-parse", "HEAD"]);
  const assigned = ["coord/engine/scripts/launch.test.js"], manifestPath = path.join(outputRoot, "executor.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ source_root: sourceRoot, source_commit: sourceCommit,
    source_tree: gitFixture(sourceRoot, ["rev-parse", "HEAD^{tree}" ]), runner, out_dir: outputRoot, engine_coverage: false,
    shards: [{ id: 1, suites: assigned.map((file) => ({ module: "core", path: file })) }] }));
  const childProcess = require("node:child_process"), { EventEmitter } = require("node:events");
  const executorPath = require.resolve("./test-sharding-executor.js");
  const originalSpawn = childProcess.spawn, originalModule = require.cache[executorPath];
  let executorWithLaunchFailure;
  try {
    childProcess.spawn = () => { const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("fixture spawn refused"))); return child; };
    delete require.cache[executorPath];
    executorWithLaunchFailure = require(executorPath);
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalModule) require.cache[executorPath] = originalModule;
    else delete require.cache[executorPath];
  }

  await executorWithLaunchFailure.main([manifestPath]);
  const worker = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8")).results[0];
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, null);
  assert.equal(worker.signal, null);
  assert.deepEqual(worker.assigned, assigned);
  assert.match(worker.error, /fixture spawn refused/);
});

test("COORD-1052: failed coverage report rewrites retain raw evidence and do not publish aggregate results", async (t) => {
  for (const failure of ["normalization", "report-path", "manifest"]) await t.test(failure, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-shard-rewrite-refusal-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const raw = path.join(root, "raw"), normalized = path.join(root, "normalized");
    fs.mkdirSync(raw);
    fs.mkdirSync(normalized);
    const rawFile = path.join(raw, "coverage.json");
    fs.writeFileSync(rawFile, '{"result":[]}\n');
    const reportPath = path.join(root, "report.json");
    const resultsPath = path.join(root, "shard-results.json");
    const report = { engine_coverage: { raw_modules: [{ name: "core", rawDirectory: raw, lcov: "SF:old.js\nend_of_record\n" }] } };
    if (failure === "manifest") report.run_manifest = { path: path.join(root, "missing.manifest.json") };
    const worker = { id: 1, report_path: failure === "report-path" ? undefined : reportPath, report };
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const beforeReport = fs.readFileSync(reportPath, "utf8");
    const beforeResults = JSON.stringify({ results: [{ id: 1, report }] }) + "\n";
    fs.writeFileSync(resultsPath, beforeResults);
    const modules = failure === "normalization" ? [] : [{ name: "core-shard-1", source_raw_directory: raw,
      rawDirectory: normalized, lcov: "SF:source.js\nend_of_record\n" }];
    const expected = { normalization: /no normalized coverage artifact/, "report-path": /report path is missing/, manifest: /manifest is missing/ };
    assert.throws(() => sharding.rewriteShardCoverageReports({ workers: [worker], resultsPath }, modules, root), expected[failure]);
    assert.equal(fs.readFileSync(resultsPath, "utf8"), beforeResults, "failed rewrite cannot publish a new aggregate report");
    assert.equal(fs.readFileSync(rawFile, "utf8"), '{"result":[]}\n', "original raw evidence remains available for recovery");
    if (failure !== "manifest") assert.equal(fs.readFileSync(reportPath, "utf8"), beforeReport);
  });
});

test("COORD-1052: an executor preserves a populated worker directory when cloning is refused", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-executor-clone-refused-"));
  t.after(() => {
    process.exitCode = originalExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  const existingWorkspace = path.join(outputRoot, "workers", "shard-01", "workspace");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(existingWorkspace, { recursive: true });
  const diagnostic = path.join(existingWorkspace, "diagnostic.txt");
  fs.writeFileSync(diagnostic, "prior diagnostic");
  const runner = path.join(sourceRoot, "runner.js");
  fs.writeFileSync(runner, "throw new Error('must not dispatch a worker in a populated destination');\n");
  gitFixture(sourceRoot, ["init", "-q"]);
  gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor clone refusal fixture"]);
  const manifestPath = path.join(outputRoot, "executor.json");
  const assignedFile = "coord/engine/scripts/worker.test.js";
  fs.writeFileSync(manifestPath, JSON.stringify({
    source_root: sourceRoot, source_commit: gitFixture(sourceRoot, ["rev-parse", "HEAD"]),
    runner, out_dir: outputRoot, engine_coverage: false,
    shards: [{ id: 1, suites: [{ module: "core", path: assignedFile }] }],
  }));

  await shardExecutor.main([manifestPath]);
  const { results: [worker] } = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8"));
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, null);
  assert.equal(worker.signal, null);
  assert.deepEqual(worker.assigned, [assignedFile]);
  assert.match(worker.error, /^clone failed:.*already exists/s);
  assert.equal(fs.existsSync(worker.report_path), false);
  assert.equal(fs.readFileSync(diagnostic, "utf8"), "prior diagnostic");
});

test("COORD-1052: a worker report cannot mask a nonzero child exit", async (t) => {
  const originalExitCode = process.exitCode;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-executor-reported-exit-"));
  t.after(() => {
    process.exitCode = originalExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(outputRoot);
  const runner = path.join(sourceRoot, "runner.js");
  fs.writeFileSync(runner, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const report = args[args.indexOf('--report') + 1];",
    "const suite = args[args.indexOf('--file') + 1];",
    "fs.writeFileSync(report, JSON.stringify({ result: 'partial', execution_order: [suite] }));",
    "process.exitCode = 7;",
  ].join("\n"));
  gitFixture(sourceRoot, ["init", "-q"]);
  gitFixture(sourceRoot, ["add", "."]);
  gitFixture(sourceRoot, ["commit", "-q", "-m", "Executor nonzero exit fixture"]);
  const manifestPath = path.join(outputRoot, "executor.json");
  const assignedFile = "coord/engine/scripts/worker.test.js";
  fs.writeFileSync(manifestPath, JSON.stringify({
    source_root: sourceRoot, source_commit: gitFixture(sourceRoot, ["rev-parse", "HEAD"]),
    runner, out_dir: outputRoot, engine_coverage: false,
    shards: [{ id: 1, suites: [{ module: "core", path: assignedFile }] }],
  }));

  await shardExecutor.main([manifestPath]);
  const { results: [worker] } = JSON.parse(fs.readFileSync(path.join(outputRoot, "shard-results.json"), "utf8"));
  assert.equal(worker.result, "fail");
  assert.equal(worker.exit_code, 7);
  assert.equal(worker.signal, null);
  assert.equal(worker.error, "worker exited 7");
  assert.deepEqual(worker.assigned, [assignedFile]);
  assert.deepEqual(worker.report.execution_order, [assignedFile]);
  assert.equal(worker.report.result, "partial");
});

test("worker setup preserves shard evidence when cloning or checking out the snapshot fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-shard-setup-refusal-"));
  const originalExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = originalExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const runner = path.join(source, "runner.js");
  fs.writeFileSync(runner, "throw new Error('worker must not run after refused setup');\n");
  gitFixture(source, ["init", "-q"]);
  gitFixture(source, ["add", "."]);
  gitFixture(source, ["commit", "-q", "-m", "prior snapshot"]);
  const prior = gitFixture(source, ["rev-parse", "HEAD"]);
  gitFixture(source, ["commit", "-q", "--allow-empty", "-m", "planned snapshot"]);
  const snapshot = gitFixture(source, ["rev-parse", "HEAD"]);
  const assigned = "coord/engine/scripts/example.test.js";
  const childProcess = require("node:child_process");
  const spawnGit = childProcess.spawnSync;
  let failure = null;
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "git" && failure === `${args[0]} launch`) {
      return { status: null, error: Object.assign(new Error("fixture Git executable unavailable"), { code: "ENOENT" }) };
    }
    if (command === "git" && args[0] === "checkout") {
      const commit = failure === "checkout miss" ? "f".repeat(40) : prior;
      return spawnGit(command, [...args.slice(0, -1), commit], options);
    }
    return spawnGit(command, args, options);
  });

  const executorPath = require.resolve("./test-sharding-executor.js");
  const original = require.cache[executorPath];
  delete require.cache[executorPath];
  let executor;
  try { executor = require(executorPath); }
  finally { require.cache[executorPath] = original; }

  for (const [label, expected] of [
    ["clone launch", /^clone failed: fixture Git executable unavailable$/],
    ["checkout miss", /^checkout failed: .*fatal:/s],
    ["checkout launch", /^checkout failed: fixture Git executable unavailable$/],
    ["unexpected HEAD", new RegExp(`worker HEAD ${prior} differs from snapshot ${snapshot}`)],
  ]) {
    failure = label;
    const output = fs.mkdtempSync(path.join(root, "result-"));
    const manifestPath = path.join(output, "executor.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      source_root: source, source_commit: snapshot, source_tree: gitFixture(source, ["rev-parse", "HEAD^{tree}"]),
      runner, out_dir: output, engine_coverage: false, shards: [{ id: 1, suites: [{ module: "core", path: assigned }] }],
    }));
    await executor.main([manifestPath]);
    const { results: [worker] } = JSON.parse(fs.readFileSync(path.join(output, "shard-results.json"), "utf8"));
    assert.equal(worker.result, "fail");
    assert.equal(worker.exit_code, null);
    assert.deepEqual(worker.assigned, [assigned]);
    assert.match(worker.error, expected);
    assert.equal(fs.existsSync(worker.report_path), false);
    assert.equal(fs.existsSync(worker.tmp), true, "refused worker retains its diagnostic directory");
  }
});
