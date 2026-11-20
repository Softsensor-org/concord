#!/usr/bin/env node
"use strict";

// Private child used by test-runner --shards. Every worker has a fresh Git
// clone, temp directory and ignored runtime state; tests remain serial inside
// each worker. The parent test-runner validates the emitted reports and merges
// raw coverage before applying the ratchet once.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function fail(message) { throw new Error(`test-sharding: ${message}`); }
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim();
}
function runWorker({ shard, root, sourceCommit, runner, report, manifestPath, node, baseArgs, env,
  censusObserver = null, uiInstallTimeoutSeconds = 300 }) {
  return new Promise((resolve) => {
    const directory = path.join(root, `shard-${String(shard.id).padStart(2, "0")}`);
    const workspace = path.join(directory, "workspace");
    const tmp = path.join(directory, "tmp");
    const runtime = path.join(directory, "runtime");
    const assigned = shard.suites.map((suite) => suite.path);
    const port = 49152 + shard.id;
    const censusDir = censusObserver ? path.join(censusObserver.outputRoot, "workers", String(shard.id)) : null;
    const failure = (error, extra = {}) => resolve({ id: shard.id, result: "fail", exit_code: null,
      signal: null, duration_ms: 0, assigned, workspace, tmp, runtime, port,
      report_path: report, manifest_path: manifestPath || null, census_dir: censusDir, ...extra, error });
    if (port > 65535) return failure("shard count exceeds the isolated port range");
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.chmodSync(runtime, 0o700);
    const clone = spawnSync("git", ["clone", "--quiet", "--shared", "--no-hardlinks", "--no-checkout", env.COORD_SHARD_SOURCE, workspace], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    if (clone.error || clone.status !== 0) return failure(`clone failed: ${clone.stderr || clone.error?.message}`);
    const checkout = spawnSync("git", ["checkout", "--quiet", "--detach", sourceCommit], { cwd: workspace, encoding: "utf8" });
    if (checkout.error || checkout.status !== 0) return failure(`checkout failed: ${checkout.stderr || checkout.error?.message}`);
    const actual = git(workspace, ["rev-parse", "HEAD"]);
    if (actual !== sourceCommit) return failure(`worker HEAD ${actual} differs from snapshot ${sourceCommit}`);
    let uiBootstrap = null;
    if (censusObserver) {
      try {
        const npmCache = path.join(directory, "npm-cache");
        fs.mkdirSync(npmCache, { recursive: true, mode: 0o700 });
        uiBootstrap = require("./test-worker-ui-bootstrap.js").bootstrapWorkerUi({ workspaceRoot: workspace,
          timeoutSeconds: uiInstallTimeoutSeconds, env: { ...env, npm_config_cache: npmCache } });
      } catch (error) {
        return failure(`worker dependency bootstrap failed: ${error.message}`);
      }
      if (!uiBootstrap || !["passed", "skipped"].includes(uiBootstrap.status)) {
        return failure(`worker dependency bootstrap failed: ${uiBootstrap?.message || "no receipt"}`, { ui_bootstrap: uiBootstrap });
      }
    }
    const runnerRel = path.relative(env.COORD_SHARD_SOURCE, runner);
    if (runnerRel === ".." || runnerRel.startsWith(`..${path.sep}`) || path.isAbsolute(runnerRel)) {
      return failure("runner path escapes the source workspace");
    }
    const workerRunner = path.join(workspace, runnerRel);
    const args = [workerRunner, ...baseArgs,
      ...(censusObserver ? ["--census-observer", censusObserver.descriptorPath] : []),
      "--shard-child", "--report", report,
      ...(manifestPath ? ["--manifest", manifestPath] : [])];
    for (const file of assigned) args.push("--file", file);
    const childEnv = { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, RUNNER_TEMP: directory, COORD_RUNTIME_DIR: runtime,
      XDG_RUNTIME_DIR: runtime, COORD_SHARD_ID: String(shard.id), COORD_SHARD_PORT: String(port), PORT: String(port) };
    delete childEnv.COORD_SHARD_SOURCE;
    const started = process.hrtime.bigint();
    const child = spawn(node, args, { cwd: workspace, env: childEnv, stdio: "inherit" });
    child.once("error", (error) => failure(error.message, { duration_ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    child.once("exit", (code, signal) => {
      const duration_ms = Number(process.hrtime.bigint() - started) / 1e6;
      let reportData = null;
      try { reportData = JSON.parse(fs.readFileSync(report, "utf8")); }
      catch (error) { return failure(`worker report unavailable: ${error.message}`,
        { exit_code: code == null ? null : code, signal: signal || null, duration_ms }); }
      const expected = assigned.slice().sort();
      const actualFiles = (reportData.execution_order || []).slice().sort();
      if (JSON.stringify(expected) !== JSON.stringify(actualFiles)) {
        return failure(`worker execution inventory differs: expected ${JSON.stringify(expected)} got ${JSON.stringify(actualFiles)}`,
          { exit_code: code, signal: signal || null, duration_ms, report: reportData });
      }
      if (manifestPath && !fs.existsSync(manifestPath)) {
        return failure("worker run manifest was not persisted at its assigned path",
          { exit_code: code, signal: signal || null, duration_ms, ui_bootstrap: uiBootstrap, report: reportData });
      }
      resolve({ id: shard.id, result: code === 0 && !signal && reportData.result === "partial" ? "pass" : "fail",
        exit_code: code, signal: signal || null, duration_ms, workspace, tmp, runtime, port, report_path: report,
        manifest_path: manifestPath || null, census_dir: censusDir, ui_bootstrap: uiBootstrap, report: reportData,
        assigned: assigned.slice(), error: code === 0 ? null : `worker exited ${signal || code}` });
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) fail("expected one shard manifest path");
  const manifestPath = path.resolve(argv[0]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const key of ["source_root", "source_commit", "runner", "out_dir", "shards", "engine_coverage"]) {
    if (!(key in manifest)) fail(`manifest is missing ${key}`);
  }
  if (!Array.isArray(manifest.shards) || !manifest.shards.length) fail("manifest has no shards");
  const sourceRoot = path.resolve(manifest.source_root);
  if (git(sourceRoot, ["rev-parse", "HEAD"]) !== manifest.source_commit) fail("source HEAD changed after shard plan was created");
  if (git(sourceRoot, ["status", "--porcelain", "--untracked-files=all"])) fail("sharded execution requires a clean source checkout");
  const root = path.resolve(manifest.out_dir, "workers");
  fs.mkdirSync(root, { recursive: true });
  let censusObserver = null;
  if (manifest.census_observer_descriptor_path) {
    censusObserver = require("./test-census-observer.js").loadCensusObserverDescriptor({
      descriptorPath: manifest.census_observer_descriptor_path, expectedMode: "sharded",
    });
    const workersRoot = path.join(censusObserver.outputRoot, "workers");
    fs.mkdirSync(workersRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(workersRoot).isSymbolicLink() || fs.realpathSync(workersRoot) !== workersRoot) fail("census workers root is not canonical");
  }
  const baseArgs = manifest.engine_coverage ? ["--engine-coverage"] : [];
  if (censusObserver) baseArgs.push("--qualification-stage", "release", "--policy-stage", "release", "--qualification-mode", "full");
  const env = { ...process.env, COORD_SHARD_SOURCE: sourceRoot };
  // Validate every census destination before any worker can start writing.
  const workers = manifest.shards.map((shard) => {
    const report = censusObserver ? path.join(censusObserver.outputRoot, `worker-${shard.id}.report.json`) : path.join(root, `shard-${shard.id}.json`);
    const workerManifest = censusObserver ? path.join(censusObserver.outputRoot, `worker-${shard.id}.manifest.json`) : `${report}.manifest.json`;
    const censusDir = censusObserver ? path.join(censusObserver.outputRoot, "workers", String(shard.id)) : null;
    if (censusObserver) {
      fs.mkdirSync(censusDir, { recursive: false, mode: 0o700 });
      if (fs.readdirSync(censusDir).length) fail(`worker ${shard.id} census directory is not empty`);
      if (fs.existsSync(report) || fs.existsSync(workerManifest)) fail(`worker ${shard.id} report destination already exists`);
    }
    return { shard, report, manifestPath: censusObserver ? workerManifest : null };
  });
  const results = await Promise.all(workers.map(({ shard, report, manifestPath }) =>
    runWorker({ shard, root, sourceCommit: manifest.source_commit, runner: manifest.runner,
      report, manifestPath, node: process.execPath, baseArgs, env, censusObserver,
      uiInstallTimeoutSeconds: manifest.ui_install_timeout_seconds || 300 })));
  const summary = { schema_version: 1, source_commit: manifest.source_commit, source_tree: manifest.source_tree,
    results: results.map(({ id, result, exit_code, signal, duration_ms, assigned, error, report, report_path, manifest_path, census_dir, workspace, tmp, runtime, port, ui_bootstrap }) => ({
      id, result, exit_code, signal, duration_ms, assigned, error, report, report_path, manifest_path, census_dir, workspace, tmp, runtime, port, ui_bootstrap,
    })) };
  fs.writeFileSync(path.join(manifest.out_dir, "shard-results.json"), JSON.stringify(summary, null, 2) + "\n");
  if (results.some((result) => result.result !== "pass")) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
module.exports = { main, git };
