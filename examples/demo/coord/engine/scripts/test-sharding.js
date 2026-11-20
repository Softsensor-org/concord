"use strict";

// COORD-900: deterministic assignment for opt-in, serial-per-shard runs.
// Timing history is advisory input to bin packing; suite identity and the
// selected shard count are recorded in the run manifest so a shard can be
// reproduced without consulting mutable history.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalCallerPath } = require("./canonical-path.js");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function loadTimingSensitiveSuites(contentRoot) {
  const file = path.join(contentRoot, "engine", "test-policy.json");
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  const suites = policy?.sharding?.timing_sensitive_suites;
  if (!Array.isArray(suites)) {
    throw new Error(`invalid timing-sensitive suite policy in test-policy.json: ${file}`);
  }
  const seen = new Set();
  return suites.map((entry) => {
    if (!entry || typeof entry.path !== "string" || !/^coord\/(?:engine|scripts)\/.+\.test\.js$/.test(entry.path) ||
        typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`invalid timing-sensitive suite entry in ${file}`);
    }
    if (seen.has(entry.path)) throw new Error(`duplicate timing-sensitive suite in ${file}: ${entry.path}`);
    seen.add(entry.path);
    return entry.path;
  });
}

function resolveShardAuthority({ contentRoot, workspaceRoot, donorWrapper = false, board = null }) {
  if (!donorWrapper) return { authoritative: false, reason: "sharded runner reports are provisional; donor governance receipt is required" };
  const policyFile = path.join(contentRoot, "engine", "test-policy.json");
  let policy;
  try { policy = JSON.parse(fs.readFileSync(policyFile, "utf8")); }
  catch (error) { return { authoritative: false, reason: `cannot read sharding authority policy: ${error.message}` }; }
  const sharding = policy?.sharding;
  if (sharding?.authoritative !== true || sharding.scope !== "resolved-policy-plan") {
    return { authoritative: false, reason: "sharding is not authorized for resolved policy plans" };
  }
  const comparison = sharding.comparison;
  if (comparison?.first_sharded_run_requires_same_tree_serial_comparison !== false ||
      comparison?.scheduled_serial_full_comparison !== false ||
      !["test_identity", "outcome", "coverage_findings"].every((field) => comparison.compared?.includes(field)) ||
      comparison?.mismatch_action !== "fail-qualification-and-automatically-suspend" ||
      comparison?.comparison_execution !== "donor-journaled-transaction") {
    return { authoritative: false, reason: "COORD-900 comparison and serial fallback safeguards are incomplete" };
  }
  const governance = require("./test-sharding-governance.js").authorityState(board);
  if (!governance.allowed) return { authoritative: false, reason: `COORD-900 sharding is suspended: ${governance.reason}` };
  if (sharding.suspension?.active === true) {
    return { authoritative: false, reason: `COORD-900 sharding is suspended: ${sharding.suspension.reason || "comparison mismatch"}` };
  }
  if (sharding.suspension != null && (typeof sharding.suspension !== "object" || sharding.suspension.active !== false)) {
    return { authoritative: false, reason: "COORD-900 sharding suspension state is malformed" };
  }
  return { authoritative: true, scope: sharding.scope, comparison: comparison.compared.slice(), evidence_pending: governance.evidence_pending };
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`);
  return n;
}

function resolveShardCount(value, { cpuCount = os.availableParallelism?.() || os.cpus().length,
  freeMemoryBytes = os.freemem(), maxMemoryBytes = 4 * 1024 ** 3 } = {}) {
  if (value !== "auto") return positiveInt(value, "shard count");
  const cpus = positiveInt(cpuCount, "available CPU count");
  const memory = Math.max(1, Math.floor(positiveInt(freeMemoryBytes, "available memory") /
    positiveInt(maxMemoryBytes, "per-shard memory budget")));
  return Math.max(1, Math.min(cpus, memory));
}

function compareSuitePaths(a, b) {
  return Number(a.path > b.path) - Number(a.path < b.path);
}

function normalizeInventory(inventory) {
  if (!Array.isArray(inventory)) throw new Error("shard inventory must be an array");
  const seen = new Set();
  return inventory.map((entry) => {
    if (!entry || typeof entry.path !== "string" || !entry.path || typeof entry.module !== "string" || !entry.module) {
      throw new Error("each shard inventory entry needs a module and path");
    }
    if (seen.has(entry.path)) throw new Error(`duplicate suite in inventory: ${entry.path}`);
    seen.add(entry.path);
    const duration = entry.duration_ms == null ? null : Number(entry.duration_ms);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new Error(`invalid measured duration for ${entry.path}`);
    return { module: entry.module, path: entry.path, duration_ms: duration,
      timing_sensitive: entry.timing_sensitive === true };
  }).sort(compareSuitePaths);
}

function planShards(inventory, count) {
  const suites = normalizeInventory(inventory);
  const shardCount = positiveInt(count, "shard count");
  if (shardCount > suites.length) throw new Error(`shard count ${shardCount} exceeds suite count ${suites.length}`);
  const dedicated = suites.filter((suite) => suite.timing_sensitive);
  if (dedicated.length > shardCount || (dedicated.length === shardCount && suites.length > dedicated.length)) {
    throw new Error(`shard count ${shardCount} cannot give ${dedicated.length} timing-sensitive suites dedicated shards`);
  }
  const measured = suites.every((suite) => suite.duration_ms !== null);
  if (!measured && suites.some((suite) => suite.duration_ms !== null)) {
    throw new Error("duration history must include a measured positive duration for every suite or none");
  }
  const shards = Array.from({ length: shardCount }, (_, index) => ({ id: index + 1, suites: [], duration_ms: 0 }));
  const available = shards.slice(dedicated.length);
  dedicated.forEach((suite, index) => {
    shards[index].suites.push(suite);
    shards[index].duration_ms += suite.duration_ms;
    shards[index].dedicated = true;
  });
  const ordinary = suites.filter((suite) => !suite.timing_sensitive);
  if (measured) {
    // Stable duration sort keeps the normalized path order for equal weights.
    ordinary.sort((a, b) => b.duration_ms - a.duration_ms);
    for (const suite of ordinary) {
      const target = available.slice().sort((a, b) => a.duration_ms - b.duration_ms || a.id - b.id)[0];
      target.suites.push(suite);
      target.duration_ms += suite.duration_ms;
    }
  } else {
    ordinary.forEach((suite, index) => available[index % available.length].suites.push(suite));
  }
  for (const shard of shards) shard.suites.sort(compareSuitePaths);
  validateShardPlan(suites, shards);
  return { schema_version: 1, algorithm: measured ? "measured-duration-greedy-v1" : "stable-path-round-robin-v1", shard_count: shardCount,
    duration_source: measured ? "complete-suite-history" : "none",
    total_duration_ms: measured ? suites.reduce((sum, suite) => sum + suite.duration_ms, 0) : null,
    shards: shards.map(({ id, suites: assigned, duration_ms, dedicated: timing_sensitive_dedicated }) => ({
      id, suites: assigned, estimated_duration_ms: measured ? duration_ms : null,
      timing_sensitive_dedicated: timing_sensitive_dedicated === true,
    })) };
}

function validateShardPlan(inventory, shards) {
  const expected = new Set(inventory.map((suite) => suite.path));
  const seen = new Map();
  for (const shard of shards) {
    if (!Array.isArray(shard.suites)) throw new Error(`shard ${shard.id} has no suite list`);
    for (const suite of shard.suites) {
      if (!expected.has(suite.path)) throw new Error(`shard ${shard.id} contains an unknown suite: ${suite.path}`);
      seen.set(suite.path, (seen.get(suite.path) || 0) + 1);
    }
  }
  const missing = [...expected].filter((file) => !seen.has(file)).sort();
  const duplicate = [...seen].filter(([, count]) => count !== 1).map(([file]) => file).sort();
  if (missing.length || duplicate.length) throw new Error(`shard coverage is not exact: missing=${JSON.stringify(missing)} duplicate=${JSON.stringify(duplicate)}`);
  return true;
}

function verifyCutInventory(expected, assignments) {
  if (!Array.isArray(expected) || !Array.isArray(assignments)) throw new Error("cut inventory and assignments must be arrays");
  const expectedSorted = [...expected].sort();
  const assigned = assignments.flatMap((shard) => shard.suites || []).map((suite) => suite.path).sort();
  const duplicates = assigned.filter((path, index) => index > 0 && assigned[index - 1] === path);
  const missing = expectedSorted.filter((path) => !assigned.includes(path));
  const unexpected = assigned.filter((path) => !expectedSorted.includes(path));
  if (duplicates.length || missing.length || unexpected.length) {
    throw new Error(`cut shard inventory mismatch: missing=${JSON.stringify(missing)} duplicate=${JSON.stringify([...new Set(duplicates)])} unexpected=${JSON.stringify([...new Set(unexpected)])}`);
  }
  return true;
}

function remapCoverageUrl(url, fromRoot, toRoot) {
  if (typeof url !== "string" || !url.startsWith("file:")) return url;
  const absolute = fileURLToPath(url);
  const rel = path.relative(fromRoot, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return url;
  return pathToFileURL(path.resolve(toRoot, rel)).href;
}

function normalizeRawCoverageModules(modules, { sourceWorkspaceRoots, targetWorkspaceRoot, outDir }) {
  if (!Array.isArray(modules) || modules.length === 0) throw new Error("sharded coverage has no raw modules");
  fs.mkdirSync(outDir, { recursive: true });
  const byRoot = new Map(sourceWorkspaceRoots.map((root) => [path.resolve(root), targetWorkspaceRoot]));
  const normalized = [];
  const scratch = fs.mkdtempSync(path.join(outDir, "coverage-merged-input-"));
  let index = 0;
  for (const module of modules) {
    if (!module || typeof module.name !== "string" || typeof module.rawDirectory !== "string" ||
        typeof module.lcov !== "string" || typeof module.workspace_root !== "string") {
      throw new Error("shard raw coverage record is incomplete");
    }
    const fromRoot = path.resolve(module.workspace_root);
    const targetRoot = byRoot.get(fromRoot);
    if (!targetRoot) throw new Error(`unrecognized shard workspace root in coverage: ${fromRoot}`);
    const rawDirectory = path.join(scratch, `module-${String(index++).padStart(3, "0")}`);
    fs.mkdirSync(rawDirectory, { recursive: true });
    const entries = fs.readdirSync(module.rawDirectory);
    if (!entries.length || entries.some((name) => !/^coverage-\d+-\d{13}-\d+\.json$/.test(name))) {
      throw new Error(`raw shard coverage directory is incomplete: ${module.rawDirectory}`);
    }
    for (const name of entries) {
      const input = JSON.parse(fs.readFileSync(path.join(module.rawDirectory, name), "utf8"));
      if (!input || !Array.isArray(input.result)) throw new Error(`invalid raw coverage snapshot: ${name}`);
      for (const script of input.result) script.url = remapCoverageUrl(script.url, fromRoot, targetRoot);
      fs.writeFileSync(path.join(rawDirectory, name), JSON.stringify(input));
    }
    const headers = [];
    const records = [];
    let record = [];
    let sawSource = false;
    for (const line of module.lcov.split(/\r?\n/)) {
      if (!sawSource && !line.startsWith("SF:")) { headers.push(line); continue; }
      if (line.startsWith("SF:")) {
        sawSource = true;
        // Resolve worker-relative LCOV paths from the worker, and emit the
        // target-relative form used by the native reporter during aggregation.
        const sourceFile = path.resolve(fromRoot, line.slice(3));
        const rel = path.relative(fromRoot, sourceFile);
        const normalizedFile = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? sourceFile : path.resolve(targetRoot, rel);
        record.push(`SF:${path.relative(targetRoot, normalizedFile).split(path.sep).join("/")}`);
        record.source = normalizedFile;
      } else record.push(line);
      if (line === "end_of_record") { records.push(record); record = []; }
    }
    if (record.some((line) => line !== "")) throw new Error(`incomplete LCOV record in shard ${module.name}`);
    if (!records.length) throw new Error(`LCOV has no source records in shard ${module.name}`);
    if (records.some((entry) => typeof entry.source !== "string")) throw new Error(`LCOV record has no source file in shard ${module.name}`);
    // Native TestCoverage sorts absolute source paths. Relocation can change
    // that order relative to external preloads, so sort by the normalized
    // absolute path while retaining every record body exactly.
    records.sort((a, b) => a.source.localeCompare(b.source));
    const lcov = [...headers, ...records.flatMap((lines) => lines)].join("\n") + "\n";
    normalized.push({ name: `${module.name}-shard-${index}`, rawDirectory, lcov,
      source_raw_directory: path.resolve(module.rawDirectory) });
  }
  return { modules: normalized, scratch };
}

function rewriteShardCoverageReports(shardRun, normalizedModules, workspaceRoot) {
  const bySourceDirectory = new Map(normalizedModules.map((module) => [module.source_raw_directory, module]));
  for (const worker of shardRun.workers) {
    const coverage = worker.report?.engine_coverage;
    if (!coverage || !Array.isArray(coverage.raw_modules)) continue;
    coverage.raw_modules = coverage.raw_modules.map((module) => {
      const normalized = bySourceDirectory.get(path.resolve(module.rawDirectory));
      if (!normalized) throw new Error(`no normalized coverage artifact for shard raw directory ${module.rawDirectory}`);
      return { ...module, name: normalized.name, rawDirectory: normalized.rawDirectory,
        lcov: normalized.lcov, workspace_root: workspaceRoot };
    });
    if (typeof worker.report_path !== "string") throw new Error(`shard ${worker.id} report path is missing`);
    fs.writeFileSync(worker.report_path, JSON.stringify(worker.report, null, 2) + "\n");
    const manifestPath = worker.report.run_manifest?.path;
    if (manifestPath) {
      if (!fs.existsSync(manifestPath)) throw new Error(`shard ${worker.id} manifest is missing: ${manifestPath}`);
      const runManifest = require("./run-manifest.js");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const artifacts = (manifest.artifacts || []).map((artifact) => artifact.path);
      runManifest.writeManifest(manifestPath, runManifest.finalizeManifest(manifest, artifacts));
    }
  }
  if (!shardRun.resultsPath) throw new Error("shard results path is missing");
  const results = JSON.parse(fs.readFileSync(shardRun.resultsPath, "utf8"));
  const reports = new Map(shardRun.workers.map((worker) => [worker.id, worker.report]));
  for (const result of results.results || []) {
    if (reports.has(result.id)) result.report = reports.get(result.id);
  }
  fs.writeFileSync(shardRun.resultsPath, JSON.stringify(results, null, 2) + "\n");
  return true;
}

function cleanupShardWorkers(shardRun, { reportPersisted, allGreen, censusObserver = null } = {}) {
  if (!shardRun || reportPersisted !== true || allGreen !== true) return false;
  if (typeof shardRun.workerRoot !== "string" || !shardRun.workerRoot) throw new Error("refusing shard cleanup without a worker root");
  const root = path.resolve(shardRun.workerRoot);
  if (!root || root === path.parse(root).root) throw new Error("refusing shard cleanup without a safe worker root");
  const checkedPath = (candidate, label) => {
    if (typeof candidate !== "string" || !candidate) throw new Error(`shard ${label} path is missing`);
    const absolute = path.resolve(candidate);
    const rel = path.relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`refusing shard cleanup path outside worker root: ${absolute}`);
    }
    return absolute;
  };
  // Release evidence lives in the validated observer output rather than worker scratch.
  const censusRoot = censusObserver?.outputRoot;
  const checkedEvidencePath = (candidate, label, workerId) => {
    if (!censusObserver) return checkedPath(candidate, label);
    if (!Number.isSafeInteger(workerId) || workerId < 1 ||
        typeof censusRoot !== "string" || !path.isAbsolute(censusRoot) ||
        candidate !== path.join(censusRoot, `worker-${workerId}.${label}.json`)) {
      throw new Error(`refusing shard cleanup with unexpected census ${label} path for shard ${workerId}`);
    }
    if (fs.existsSync(candidate) && (!fs.lstatSync(candidate).isFile() || fs.realpathSync(candidate) !== candidate)) {
      throw new Error(`refusing shard cleanup with noncanonical census ${label} path: ${candidate}`);
    }
    return candidate;
  };
  const encloses = (directory, file) => file === directory || file.startsWith(`${directory}${path.sep}`);
  if (!fs.lstatSync(root).isDirectory()) throw new Error("refusing shard cleanup without a real worker directory");
  const rootRealPath = fs.realpathSync(root);
  const checkedRemovalPath = (candidate, label) => {
    const absolute = checkedPath(candidate, label);
    const expected = path.join(rootRealPath, path.relative(root, absolute));
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return null; // A prior cleanup may already have removed this directory.
    if (!stat.isDirectory() || fs.realpathSync(absolute) !== expected) {
      throw new Error(`refusing shard cleanup with noncanonical ${label} directory: ${absolute}`);
    }
    return absolute;
  };
  const cleanup = [];
  for (const worker of shardRun.workers) {
    const reportPath = checkedEvidencePath(worker.report_path, "report", worker.id);
    const remove = [
      checkedRemovalPath(worker.workspace, "workspace"),
      checkedRemovalPath(worker.tmp, "temp"),
      checkedRemovalPath(worker.runtime, "runtime"),
    ].filter(Boolean);
    if (remove.some((directory) => encloses(directory, reportPath))) {
      throw new Error(`refusing to remove shard ${worker.id} report with its worker directories`);
    }
    if (!fs.existsSync(reportPath)) throw new Error(`refusing shard cleanup without persisted report: ${reportPath}`);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    for (const module of report.engine_coverage?.raw_modules || []) {
      if (typeof module.rawDirectory !== "string" || !fs.existsSync(module.rawDirectory) ||
          remove.some((directory) => path.resolve(module.rawDirectory) === directory ||
            path.resolve(module.rawDirectory).startsWith(`${directory}${path.sep}`))) {
        throw new Error(`refusing shard cleanup without preserved normalized coverage for shard ${worker.id}`);
      }
    }
    const manifestPath = report.run_manifest?.path;
    if (censusObserver && manifestPath !== worker.manifest_path) {
      throw new Error(`refusing shard cleanup with mismatched census manifest path for shard ${worker.id}`);
    }
    if (manifestPath || censusObserver) {
      const absoluteManifest = checkedEvidencePath(manifestPath, "manifest", worker.id);
      if (!fs.existsSync(absoluteManifest)) throw new Error(`refusing shard cleanup without persisted manifest: ${absoluteManifest}`);
      if (remove.some((directory) => encloses(directory, absoluteManifest))) {
        throw new Error(`refusing to remove shard ${worker.id} manifest with its worker directories`);
      }
      const runManifest = require("./run-manifest.js");
      const manifest = JSON.parse(fs.readFileSync(absoluteManifest, "utf8"));
      const errors = runManifest.validateManifest(manifest);
      if (errors.length) throw new Error(`refusing shard cleanup with invalid worker manifest: ${errors.join("; ")}`);
    }
    cleanup.push(remove);
  }
  // Validate every worker before deleting any of them, so a malformed later
  // record cannot leave a partially cleaned diagnostic run.
  for (const directories of cleanup) {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  }
  return true;
}

function summarizeShardWorker(worker, plan) {
  const plannedShard = plan.shards.find((shard) => shard.id === worker.id);
  const suiteModules = Object.fromEntries((plannedShard?.suites || []).map((suite) => [suite.path, suite.module]));
  const modules = worker.report?.results || [];
  const counts = modules.reduce((acc, module) => {
    for (const name of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) acc[name] += module[name] || 0;
    return acc;
  }, { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const skippedTests = modules.every((module) => Array.isArray(module.skipped_tests))
    ? modules.flatMap((module) => module.skipped_tests)
    : null;
  return { module: `shard-${String(worker.id).padStart(2, "0")}`, files: worker.assigned || [],
    suite_modules: suiteModules,
    exit_code: worker.result === "pass" ? 0 : worker.exit_code == null ? -1 : worker.exit_code,
    signal: worker.signal || null, ...counts, duration_ms: worker.duration_ms || 0,
    skipped_tests: skippedTests,
    failing_tests: modules.flatMap((module) => module.failing_tests || []) };
}

function executeShards({ workspaceRoot, contentRoot, selected, count, engineCoverage, outDir, node = process.execPath,
  env = process.env, durations = {}, timingSensitive = [], durationHistorySha256 = null,
  censusObserverDescriptorPath = null }) {
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot, encoding: "utf8" });
  if (gitRoot.error || gitRoot.status !== 0 || path.resolve(gitRoot.stdout.trim()) !== canonicalCallerPath(workspaceRoot)) {
    throw new Error("sharded execution requires a Git workspace root as the runner workspace");
  }
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspaceRoot, encoding: "utf8" });
  if (status.error || status.status !== 0 || status.stdout.trim()) {
    throw new Error("sharded execution requires a clean committed workspace; run serially for uncommitted changes");
  }
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).stdout.trim();
  const sourceTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspaceRoot, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit) || !/^[0-9a-f]{40,64}$/.test(sourceTree)) throw new Error("could not bind shard run to a Git commit and tree");
  const timing = new Set(timingSensitive);
  const durationFiles = Object.keys(durations || {});
  const inventoryFiles = selected.flatMap((module) => module.files);
  if (durationFiles.length && (durationFiles.length !== inventoryFiles.length || durationFiles.some((file) => !inventoryFiles.includes(file)))) {
    throw new Error("duration history must contain exactly one measurement for every inventoried suite");
  }
  const inventory = selected.flatMap((module) => module.files.map((file) => ({ module: module.name, path: file,
    duration_ms: durationFiles.length ? durations[file] : null, timing_sensitive: timing.has(file) })));
  const plan = planShards(inventory, count);
  const runner = path.join(contentRoot, "engine", "scripts", "test-runner.js");
  if (!fs.existsSync(runner)) throw new Error(`cannot locate canonical test runner at ${runner}`);
  fs.mkdirSync(outDir, { recursive: true });
  const planFile = path.join(outDir, "shard-plan.json");
  const executorManifest = path.join(outDir, "shard-executor.json");
  const planRecord = { ...plan, source_commit: sourceCommit, source_tree: sourceTree,
    duration_history_sha256: durationHistorySha256,
    timing_sensitive_policy_sha256: require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(path.join(contentRoot, "engine", "test-policy.json"))).digest("hex"),
    assignments: plan.shards.map((shard) => ({ ...shard, suites: shard.suites.map((suite) => suite.path) })) };
  fs.writeFileSync(planFile, JSON.stringify(planRecord, null, 2) + "\n");
  fs.writeFileSync(executorManifest, JSON.stringify({ source_root: workspaceRoot, source_commit: sourceCommit,
    source_tree: sourceTree, runner, out_dir: outDir, engine_coverage: engineCoverage,
    census_observer_descriptor_path: censusObserverDescriptorPath,
    shards: plan.shards.map((shard) => ({ id: shard.id, suites: shard.suites })) }, null, 2) + "\n");
  const executor = path.join(contentRoot, "engine", "scripts", "test-sharding-executor.js");
  const result = spawnSync(node, [executor, executorManifest], { cwd: workspaceRoot, env: { ...env }, stdio: "inherit" });
  let workerResults;
  try { workerResults = JSON.parse(fs.readFileSync(path.join(outDir, "shard-results.json"), "utf8")); }
  catch (error) {
    throw new Error(`shard executor did not persist worker results${result.error || result.status !== 0
      ? ` (exit ${result.error?.message || result.signal || result.status})` : ""}: ${error.message}`);
  }
  if (workerResults.source_commit !== sourceCommit || workerResults.source_tree !== sourceTree) throw new Error("shard results are bound to a different source snapshot");
  const assigned = workerResults.results.flatMap((shard) => shard.assigned || []);
  let validationError = null;
  try { verifyCutInventory(inventory.map((suite) => suite.path), [{ suites: assigned.map((file) => ({ path: file })) }]); }
  catch (error) { validationError = error.message; }
  if (workerResults.results.length !== plan.shard_count) validationError =
    `${validationError ? `${validationError}; ` : ""}expected ${plan.shard_count} shard results, received ${workerResults.results.length}`;
  // Worker records may arrive in any order, but each assignment echoes its plan order.
  const misplaced = !validationError && planRecord.assignments.find(({ id, suites }) =>
    JSON.stringify(workerResults.results.find((worker) => worker.id === id)?.assigned) !== JSON.stringify(suites));
  if (misplaced) validationError = `shard ${misplaced.id} reported a different ordered assignment than the plan`;
  if (result.error || result.status !== 0) validationError =
    `${validationError ? `${validationError}; ` : ""}shard executor exited ${result.error?.message || result.signal || result.status}`;
  return { plan: planRecord, workers: workerResults.results, sourceCommit, sourceTree,
    workerRoot: path.resolve(outDir, "workers"), resultsPath: path.join(outDir, "shard-results.json"),
    rawModules: workerResults.results.flatMap((shard) => shard.report?.engine_coverage?.raw_modules || []),
    validationError, coverageScratch: null };
}

module.exports = { resolveShardCount, normalizeInventory, planShards, validateShardPlan, verifyCutInventory,
  remapCoverageUrl, normalizeRawCoverageModules, rewriteShardCoverageReports, cleanupShardWorkers,
  loadTimingSensitiveSuites, resolveShardAuthority, summarizeShardWorker, executeShards };
