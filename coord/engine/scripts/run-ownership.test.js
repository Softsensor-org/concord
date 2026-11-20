"use strict";

// COORD-905: owned-resource manifests for runner and gate invocations. Every kill
// here is a real signal sent to a real child process (run-ownership-child.js) in an
// os.tmpdir() sandbox. Nothing is simulated by a hand-built manifest with an invented
// live or dead pid except where a test states it (the reused-pid and identity tests).

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const runOwnership = require("./run-ownership.js");

const CHILD = path.join(__dirname, "run-ownership-child.js");
const createdSandboxes = [];
const liveChildren = [];

after(() => {
  for (const child of liveChildren) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const dir of createdSandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(prefix = "coord905-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdSandboxes.push(dir);
  return dir;
}

// A zombie has exited (its grandchild parent is gone); it is not alive.
function alive(pid) {
  return runOwnership.processAlive(pid);
}

// Starts the fixture runner and resolves with its READY line.
async function startRunner(dir) {
  const child = spawn(process.execPath, [CHILD, dir], { stdio: ["ignore", "pipe", "pipe"] });
  liveChildren.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 400 && !stdout.includes("\n"); i += 1) await new Promise((r) => setTimeout(r, 25));
  const line = stdout.split("\n")[0];
  assert.ok(line, `runner did not become ready\nstderr:\n${stderr}`);
  return { child, ready: JSON.parse(line), stderrRef: () => stderr };
}

async function stopByExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const [code] = await once(child, "exit");
  return code;
}

function manifestFiles(runsDir) {
  try { return fs.readdirSync(runsDir).filter((n) => n.endsWith(".json")); } catch { return []; }
}

test("the manifest exists and lists a resource before the resource is created", () => {
  const dir = sandbox();
  const handle = runOwnership.beginRun({ dir: path.join(dir, "runs"), kind: "unit" });
  const manifestPath = path.join(dir, "runs", `${handle.runId}.json`);
  assert.ok(fs.existsSync(manifestPath), "beginRun must write the manifest before any resource");

  const target = path.join(dir, "not-yet-created");
  handle.recordTempDir(target);
  const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(onDisk.run_id, handle.runId);
  assert.equal(onDisk.owner.pid, process.pid);
  assert.equal(onDisk.owner.host, os.hostname());
  assert.ok(onDisk.resources.some((r) => r.type === "temp_dir" && r.path === target), "resource recorded to disk");
  assert.ok(fs.existsSync(target), "recordTempDir creates the dir only after recording it");
  handle.release();
  assert.equal(fs.existsSync(manifestPath), false, "release removes the manifest");
});

test("release removes only the directories the manifest lists and proves by marker", () => {
  const dir = sandbox();
  const handle = runOwnership.beginRun({ dir: path.join(dir, "runs"), kind: "unit" });
  const owned = path.join(dir, "owned");
  handle.recordTempDir(owned);
  const unrelated = path.join(dir, "unrelated");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, "keep.txt"), "not ours");
  // A listed directory whose marker was overwritten by someone else is not removed.
  const foreign = path.join(dir, "foreign");
  handle.recordTempDir(foreign);
  fs.writeFileSync(path.join(foreign, runOwnership.MARKER), "some-other-run");

  handle.release();
  assert.equal(fs.existsSync(owned), false, "listed, marker-proven dir is removed");
  assert.equal(fs.existsSync(path.join(unrelated, "keep.txt")), true, "unlisted dir is untouched");
  assert.equal(fs.existsSync(foreign), true, "listed dir with a foreign marker is kept");
});

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`${signal} runs graceful cleanup: owned dir, manifest and marker process are removed`, async () => {
    const dir = sandbox();
    const runsDir = path.join(dir, "runs");
    const { child, ready } = await startRunner(dir);
    assert.ok(alive(ready.grandchildPid), "marker grandchild is running before the signal");
    assert.ok(fs.existsSync(ready.tempDir));
    assert.equal(manifestFiles(runsDir).length, 1);

    child.kill(signal);
    assert.equal(await stopByExit(child), code, `exit code for ${signal}`);
    assert.equal(fs.existsSync(ready.tempDir), false, "owned temp dir removed on graceful exit");
    assert.equal(manifestFiles(runsDir).length, 0, "manifest removed on graceful exit");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(ready.grandchildPid), false, "marker grandchild killed on graceful exit");
  });
}

test("fixture runner releases ownership when its worker exits unexpectedly", { timeout: 5000 }, async (t) => {
  const { child, ready } = await startRunner(sandbox());
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopByExit(child);
  });
  assert.ok(alive(ready.grandchildPid));
  assert.ok(fs.existsSync(ready.tempDir));
  assert.equal(manifestFiles(ready.runsDir).length, 1);

  // This PID belongs to the worker that this fixture started above.
  process.kill(ready.grandchildPid, "SIGTERM");
  assert.equal(await stopByExit(child), 1);
  assert.equal(fs.existsSync(ready.tempDir), false);
  assert.deepEqual(manifestFiles(ready.runsDir), []);
});

test("after kill -9 of the runner, dry-run lists the dead run and removes nothing", async () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  const { child, ready } = await startRunner(dir);
  try {
    child.kill("SIGKILL");
    await stopByExit(child);

    const plan = runOwnership.recoverRuns({ dir: runsDir });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.runs.length, 1);
    assert.equal(plan.runs[0].verdict, "dead");
    assert.equal(plan.runs[0].action, "would-remove");
    assert.ok(fs.existsSync(ready.tempDir), "dry run leaves the temp dir");
    assert.ok(alive(ready.grandchildPid), "dry run leaves the marker process");
    assert.equal(manifestFiles(runsDir).length, 1, "dry run keeps the manifest");
  } finally {
    // The dry-run contract leaves the marker child alive; the fixture must still reclaim it.
    child.kill("SIGKILL");
    await stopByExit(child);
    runOwnership.recoverRuns({ dir: runsDir, apply: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(alive(ready.grandchildPid), false, "fixture cleanup reclaims the dry-run marker process");
  }
});

test("after kill -9 of the runner, apply removes what the manifest proves the run owned", async () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  const { child, ready } = await startRunner(dir);
  child.kill("SIGKILL");
  await stopByExit(child);

  const result = runOwnership.recoverRuns({ dir: runsDir, apply: true });
  assert.equal(result.dry_run, false);
  assert.equal(result.runs[0].action, "removed");
  assert.equal(fs.existsSync(ready.tempDir), false, "owned temp dir removed");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(ready.grandchildPid), false, "marker process of the dead run killed");
  assert.equal(manifestFiles(runsDir).length, 0, "manifest removed once every resource is gone");
});

test("recovery refuses while the owner is alive and touches nothing", async () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  const { child, ready } = await startRunner(dir);
  try {
    const result = runOwnership.recoverRuns({ dir: runsDir, apply: true });
    assert.equal(result.runs[0].verdict, "live");
    assert.equal(result.runs[0].action, "kept");
    assert.ok(fs.existsSync(ready.tempDir), "live run's temp dir is untouched");
    assert.ok(alive(ready.grandchildPid), "live run's marker process is untouched");
    assert.equal(manifestFiles(runsDir).length, 1);
  } finally {
    child.kill("SIGTERM");
    await stopByExit(child);
  }
});

test("an unreadable start time for a live pid is unverifiable, never dead (fail closed)", () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  const handle = runOwnership.beginRun({ dir: runsDir, kind: "unit" });
  const owned = path.join(dir, "owned");
  handle.recordTempDir(owned);
  const identity = JSON.parse(fs.readFileSync(path.join(runsDir, `${handle.runId}.json`), "utf8")).owner;
  // The manifest's owner is this live test process; the reader cannot read its start time.
  const result = runOwnership.recoverRuns({
    dir: runsDir,
    apply: true,
    readProcessStartTime: () => null,
    localIdentity: { host: identity.host, boot_id: identity.boot_id, pid_ns: identity.pid_ns },
  });
  assert.equal(result.runs[0].verdict, "unverifiable");
  assert.equal(result.runs[0].action, "kept");
  assert.ok(fs.existsSync(owned), "unreadable identity keeps the dir");
  handle.release();
});

test("a live pid whose recorded start time differs is a reused pid: dead, reclaimable", () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const owned = path.join(dir, "owned");
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, runOwnership.MARKER), "reused-run");
  const runId = "reused-run";
  const manifest = {
    schema_version: 1, kind: runOwnership.MANIFEST_KIND, run_id: runId, run_kind: "unit",
    owner: { pid: process.pid, host: os.hostname(), boot_id: runOwnership.localIdentity().boot_id,
      pid_ns: runOwnership.localIdentity().pid_ns, pid_start_time: "1" },
    created_at: new Date().toISOString(),
    resources: [{ type: "temp_dir", path: owned, recorded_at: new Date().toISOString() }],
  };
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(manifest));
  const result = runOwnership.recoverRuns({ dir: runsDir, apply: true });
  assert.equal(result.runs[0].verdict, "dead");
  assert.equal(result.runs[0].action, "removed");
  assert.equal(fs.existsSync(owned), false);
});

test("foreign-host and boot-mismatch owners are kept, never treated as dead", () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const owned = path.join(dir, "owned");
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, runOwnership.MARKER), "foreign-run");
  const manifest = {
    schema_version: 1, kind: runOwnership.MANIFEST_KIND, run_id: "foreign-run", run_kind: "unit",
    owner: { pid: 999_999_999, host: "some-other-host", boot_id: "x", pid_ns: "y", pid_start_time: "1" },
    created_at: new Date().toISOString(),
    resources: [{ type: "temp_dir", path: owned, recorded_at: new Date().toISOString() }],
  };
  fs.writeFileSync(path.join(runsDir, "foreign-run.json"), JSON.stringify(manifest));
  const result = runOwnership.recoverRuns({ dir: runsDir, apply: true });
  assert.equal(result.runs[0].verdict, "foreign");
  assert.equal(fs.existsSync(owned), true);

  manifest.owner.host = os.hostname();
  manifest.owner.boot_id = "a-different-boot";
  fs.writeFileSync(path.join(runsDir, "foreign-run.json"), JSON.stringify(manifest));
  const other = runOwnership.recoverRuns({ dir: runsDir, apply: true });
  assert.equal(other.runs[0].verdict, "unverifiable");
  assert.equal(fs.existsSync(owned), true);
});

test("a corrupt manifest is reported and kept, not deleted", () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, "broken.json"), "{not json");
  const result = runOwnership.recoverRuns({ dir: runsDir, apply: true });
  assert.equal(result.runs[0].verdict, "unreadable");
  assert.equal(result.runs[0].action, "kept");
  assert.equal(fs.existsSync(path.join(runsDir, "broken.json")), true);
});

test("staging-dir detection: unreferenced acquire staging dirs are reported with age and remedy; referenced ones are not", () => {
  const dir = sandbox();
  const lockPath = path.join(dir, ".agent-state.lock");
  const orphan = path.join(dir, ".agent-state.lock.acquire-orphan");
  const live = path.join(dir, ".agent-state.lock.acquire-referenced");
  fs.mkdirSync(orphan);
  fs.mkdirSync(live);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  fs.utimesSync(live, old, old);
  fs.symlinkSync(live, lockPath, "dir");

  const report = runOwnership.stagingReport({ lockPaths: [{ kind: "agent-state", path: lockPath, staleMs: 60_000 }] });
  assert.equal(report.length, 1, JSON.stringify(report));
  assert.equal(report[0].path, orphan);
  assert.ok(report[0].age_ms >= 9 * 60 * 1000, "age is reported");
  assert.match(report[0].remedy, /break-runtime-lock --kind agent-state --sweep-staging --yes/);
  const lockPaths = [{ kind: "agent-state", path: lockPath, staleMs: 60_000 }];
  const dry = runOwnership.recoverRuns({ dir: path.join(dir, "missing-runs"), stagingLocks: lockPaths });
  assert.equal(dry.staging[0].action, "would-remove");
  assert.ok(fs.existsSync(orphan), "dry run retains staging data");
  const applied = runOwnership.recoverRuns({ dir: path.join(dir, "missing-runs"), stagingLocks: lockPaths, apply: true });
  assert.equal(applied.staging.length, 1);
  assert.equal(applied.staging[0].action, "removed");
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readlinkSync(lockPath), live, "active lock reference is unchanged");
  assert.ok(fs.existsSync(live), "referenced staging directory survives recovery");
});

test("runOwned sets the run id for children, then releases its manifest on normal return and on throw", () => {
  const dir = sandbox();
  const runsDir = path.join(dir, "runs");
  let seenId = null;
  const temp = path.join(dir, "runner-temp");
  const value = runOwnership.runOwned({
    dir: runsDir,
    kind: "unit-runner",
    argv: [],
    main(_argv, handle) {
      seenId = process.env[runOwnership.RUN_ENV];
      assert.equal(manifestFiles(runsDir).length, 1, "manifest exists while the run is in progress");
      handle.recordTempDir(temp);
      assert.equal(fs.readFileSync(path.join(temp, runOwnership.MARKER), "utf8"), seenId);
      return 0;
    },
  });
  assert.equal(value, 0);
  assert.ok(seenId, "run id is set in the environment during the run");
  assert.equal(process.env[runOwnership.RUN_ENV], undefined, "run id is cleared after the run");
  assert.equal(manifestFiles(runsDir).length, 0, "manifest removed on normal return");
  assert.equal(fs.existsSync(temp), false);

  assert.throws(() => runOwnership.runOwned({
    dir: runsDir,
    kind: "unit-runner",
    argv: [],
    main(_argv, handle) {
      handle.recordTempDir(temp);
      throw new Error("boom");
    },
  }), /boom/);
  assert.equal(manifestFiles(runsDir).length, 0, "manifest removed when the run throws");
  assert.equal(fs.existsSync(temp), false);
  assert.equal(process.env[runOwnership.RUN_ENV], undefined);
});

test("COORD-1052: run cleanup removes a marked Git worktree and its registration", () => {
  const { gitFixture } = require("./test-git-fixture.js");
  const dir = sandbox("coord-run-worktree-");
  const repo = path.join(dir, "repo"), worktree = path.join(dir, "worktree");
  fs.mkdirSync(repo);
  gitFixture(repo, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "fixture\n");
  gitFixture(repo, ["add", "tracked.txt"]);
  gitFixture(repo, ["commit", "-m", "fixture base"]);
  const handle = runOwnership.beginRun({ dir: path.join(dir, "runs") });
  const clone = path.join(dir, "clone");
  handle.recordDir("clone", clone);
  assert.equal(fs.readFileSync(path.join(clone, runOwnership.MARKER), "utf8"), handle.runId);
  handle.recordDir("worktree", worktree, { create: false, repo });
  gitFixture(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
  fs.writeFileSync(path.join(worktree, runOwnership.MARKER), handle.runId);
  assert.ok(String(gitFixture(repo, ["worktree", "list", "--porcelain"])).includes(worktree));
  assert.deepEqual(handle.release(), { kept: [] });
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(String(gitFixture(repo, ["worktree", "list", "--porcelain"])).includes(worktree), false);
  assert.equal(fs.existsSync(handle.file), false);
  assert.equal(fs.existsSync(clone), false);
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "fixture\n");
});

test("COORD-1052: run cleanup retains paths without ownership proof and can retry after proof is restored", () => {
  const dir = sandbox("coord-run-proof-");
  const handle = runOwnership.beginRun({ dir: path.join(dir, "runs") });
  const original = fs.readFileSync(handle.file, "utf8");
  assert.throws(() => handle.recordDir("unknown", path.join(dir, "invalid")), /unknown owned directory type/);
  assert.throws(() => handle.recordDir("temp_dir", "relative"), /must be absolute/);
  assert.equal(fs.readFileSync(handle.file, "utf8"), original);
  const file = path.join(dir, "file"), missingMarker = path.join(dir, "directory"), absent = path.join(dir, "absent");
  handle.recordDir("temp_dir", file, { create: false });
  fs.writeFileSync(file, "must survive\n");
  handle.recordDir("temp_dir", missingMarker, { create: false });
  fs.mkdirSync(missingMarker);
  handle.recordDir("temp_dir", absent, { create: false });
  const first = handle.release();
  assert.equal(first.kept.length, 2);
  assert.ok(first.kept.some((item) => item.path === file && /not a directory/.test(item.reason)));
  assert.ok(first.kept.some((item) => item.path === missingMarker && /marker does not match/.test(item.reason)));
  assert.equal(fs.readFileSync(file, "utf8"), "must survive\n");
  assert.equal(runOwnership.readManifest(handle.file).resources.length, 2);
  fs.writeFileSync(path.join(missingMarker, runOwnership.MARKER), handle.runId);
  const second = handle.release();
  assert.equal(second.kept.length, 1);
  assert.equal(second.kept[0].path, file);
  assert.equal(fs.existsSync(missingMarker), false);
  fs.unlinkSync(file);
  assert.deepEqual(handle.release(), { kept: [] });
  assert.equal(fs.existsSync(handle.file), false);
});

test("COORD-1052: owner proof requires complete local and recorded process identity", () => {
  const local = runOwnership.localIdentity();
  const valid = { ...local };
  for (const owner of [null, {}, { ...valid, pid: "123" }, { ...valid, host: null },
    { ...valid, boot_id: null }, { ...valid, pid_ns: null }, { ...valid, pid_start_time: null }]) {
    assert.equal(runOwnership.ownerVerdict(owner, local), "unverifiable");
  }
  assert.equal(runOwnership.ownerVerdict(valid, { ...local, boot_id: null }), "unverifiable");
  assert.equal(runOwnership.ownerVerdict(valid, { ...local, pid_ns: null }), "unverifiable");
  const dir = sandbox("coord-run-empty-");
  assert.deepEqual(runOwnership.recoverRuns({ dir: path.join(dir, "missing") }).runs, []);
  fs.writeFileSync(path.join(dir, "not-run.json"), JSON.stringify({ kind: "different" }));
  fs.writeFileSync(path.join(dir, "null.json"), "null");
  const recovery = runOwnership.recoverRuns({ dir, apply: true });
  assert.equal(recovery.runs.length, 2);
  assert.ok(recovery.runs.every((item) => item.verdict === "unreadable" && item.action === "kept"));
  assert.equal(fs.existsSync(path.join(dir, "not-run.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "null.json")), true);
});


test("COORD-1052: staging recovery keeps an old unreferenced claim with a live owner", () => {
  const dir = sandbox("coord1052-live-staging-");
  const lockPath = path.join(dir, ".agent-state.lock");
  const retained = `${lockPath}.reclaim-retained`;
  fs.mkdirSync(retained);
  const owner = JSON.stringify(runOwnership.localIdentity());
  fs.writeFileSync(path.join(retained, "lock-owner.json"), owner);
  fs.writeFileSync(path.join(retained, "authored.txt"), "keep live owner data\n");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(retained, old, old);
  const result = runOwnership.recoverRuns({ dir: path.join(dir, "missing-runs"), apply: true,
    stagingLocks: [{ kind: "agent-state", path: lockPath, staleMs: 60_000 }] });
  assert.equal(result.staging.length, 1);
  assert.equal(result.staging[0].action, "kept");
  assert.match(result.staging[0].reason, /owner is live/);
  assert.equal(fs.readFileSync(path.join(retained, "lock-owner.json"), "utf8"), owner);
  assert.equal(fs.readFileSync(path.join(retained, "authored.txt"), "utf8"), "keep live owner data\n");
  assert.deepEqual(fs.readdirSync(dir), [path.basename(retained)], "recovery restores the claim without leaving sweep residue");
});

test("dead-run recovery keeps an unmarked resource and records successful cleanup for the rest", () => {
  const dir = sandbox("coord-recovery-partial-");
  const runsDir = path.join(dir, "runs");
  const handle = runOwnership.beginRun({ dir: runsDir });
  const missing = path.join(dir, "missing");
  const unmarked = path.join(dir, "unmarked");
  handle.recordDir("temp_dir", missing, { create: false });
  handle.recordTempDir(unmarked);
  fs.unlinkSync(path.join(unmarked, runOwnership.MARKER));

  // A differing start time means the pid in an old manifest has been reused.
  const recover = (apply) => runOwnership.recoverRuns({ dir: runsDir, apply, readProcessStartTime: () => "1" }).runs[0];
  const preview = recover(false);
  assert.equal(preview.action, "would-remove");
  assert.deepEqual(preview.resources, [
    { type: "temp_dir", path: missing },
    { type: "temp_dir", path: unmarked },
  ]);

  const partial = recover(true);
  assert.equal(partial.action, "partial");
  assert.equal(partial.manifest_kept, true);
  assert.deepEqual(partial.resources, [
    { type: "temp_dir", path: unmarked, removed: false, reason: "marker does not match this run; left in place" },
    { type: "temp_dir", path: missing, removed: true, reason: "already absent" },
  ]);
  assert.ok(fs.existsSync(unmarked));

  fs.writeFileSync(path.join(unmarked, runOwnership.MARKER), handle.runId);
  assert.equal(recover(true).action, "removed");
  assert.equal(fs.existsSync(unmarked), false);
  assert.deepEqual(manifestFiles(runsDir), []);
});

test("recovery preserves a legacy manifest with no resource list in dry run", () => {
  const dir = sandbox("coord-recovery-legacy-");
  const handle = runOwnership.beginRun({ dir });
  const [name] = manifestFiles(dir);
  const file = path.join(dir, name);
  const manifest = runOwnership.readManifest(file);
  delete manifest.resources;
  fs.writeFileSync(file, JSON.stringify(manifest));
  const args = { dir, readProcessStartTime: () => "1" };
  const preview = runOwnership.recoverRuns(args).runs[0];
  assert.equal(preview.action, "would-remove");
  assert.deepEqual(preview.resources, []);
  assert.ok(fs.existsSync(file));

  const applied = runOwnership.recoverRuns({ ...args, apply: true }).runs[0];
  assert.equal(applied.action, "removed");
  assert.deepEqual(applied.resources, []);
  assert.equal(fs.existsSync(file), false);
});

test("recovery retains a run when host process evidence is unavailable", (t) => {
  const dir = sandbox("coord-run-unreadable-owner-");
  const runsDir = path.join(dir, "runs");
  const readFileSync = fs.readFileSync;
  const readlinkSync = fs.readlinkSync;
  const unavailable = Object.assign(new Error("process information unavailable"), { code: "EACCES" });
  const unreadableFiles = ["/proc/sys/kernel/random/boot_id", `/proc/${process.pid}/stat`];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (unreadableFiles.includes(file)) throw unavailable;
    return readFileSync(file, ...args);
  });
  t.mock.method(fs, "readlinkSync", (file, ...args) => {
    if (file === "/proc/self/ns/pid") throw unavailable;
    return readlinkSync(file, ...args);
  });

  const handle = runOwnership.beginRun({ dir: runsDir });
  const owned = handle.recordTempDir(path.join(dir, "owned"));
  const { owner } = runOwnership.readManifest(handle.file);
  for (const field of ["boot_id", "pid_ns", "pid_start_time", "pgid"]) {
    assert.equal(owner[field], null, `unreadable ${field} is recorded as null`);
  }
  const result = runOwnership.recoverRuns({ dir: runsDir, apply: true }).runs[0];
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.action, "kept");
  assert.ok(fs.existsSync(handle.file));
  assert.equal(fs.readFileSync(path.join(owned, runOwnership.MARKER), "utf8"), handle.runId);
  assert.deepEqual(handle.release(), { kept: [] });
});

test("recovery keeps a legacy run manifest with no owner record", () => {
  const dir = sandbox("coord-run-missing-owner-");
  const handle = runOwnership.beginRun({ dir });
  const owned = handle.recordTempDir(path.join(dir, "owned"));
  const manifest = runOwnership.readManifest(handle.file);
  delete manifest.owner;
  fs.writeFileSync(handle.file, JSON.stringify(manifest));

  const result = runOwnership.recoverRuns({ dir, apply: true }).runs[0];
  assert.equal(result.owner_pid, null);
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.action, "kept");
  assert.deepEqual(runOwnership.readManifest(handle.file), manifest);
  assert.equal(fs.readFileSync(path.join(owned, runOwnership.MARKER), "utf8"), handle.runId);
  assert.deepEqual(handle.release(), { kept: [] });
});

test("recovery preview makes no process ownership claim when the process list is unreadable", (t) => {
  const dir = sandbox("coord-run-unreadable-process-list-");
  const handle = runOwnership.beginRun({ dir });
  handle.recordProcessMarker();
  const readdirSync = fs.readdirSync;
  const mock = t.mock.method(fs, "readdirSync", (file, ...args) => {
    if (file === "/proc") throw Object.assign(new Error("process list unavailable"), { code: "EACCES" });
    return readdirSync(file, ...args);
  });

  const result = runOwnership.recoverRuns({ dir, readProcessStartTime: () => "1" }).runs[0];
  assert.equal(result.action, "would-remove");
  assert.deepEqual(result.resources, [{ type: "process_marker", pids: [] }]);
  assert.ok(fs.existsSync(handle.file));
  mock.mock.restore();
  assert.deepEqual(handle.release(), { kept: [] });
});

test("a marker process exiting during cleanup does not block the remaining resources", (t) => {
  const dir = sandbox("coord-run-marker-race-");
  const handle = runOwnership.beginRun({ dir });
  const owned = handle.recordTempDir(path.join(dir, "owned"));
  handle.recordProcessMarker();
  const gone = 99_001;
  const remaining = 99_002;
  const unrelated = 99_003;
  const readdirSync = fs.readdirSync;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readdirSync", (file, ...args) =>
    file === "/proc" ? [gone, remaining, unrelated].map(String) : readdirSync(file, ...args));
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === `/proc/${gone}/environ` || file === `/proc/${remaining}/environ`) {
      return `${runOwnership.RUN_ENV}=${handle.runId}\0`;
    }
    if (file === `/proc/${unrelated}/environ`) return `${runOwnership.RUN_ENV}=another-run\0`;
    return readFileSync(file, ...args);
  });
  const kill = process.kill;
  const signalAttempts = [];
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal !== "SIGKILL") return kill(pid, signal);
    signalAttempts.push(pid);
    if (pid === gone) throw Object.assign(new Error("process already exited"), { code: "ESRCH" });
    return true;
  });

  const result = runOwnership.recoverRuns({ dir, apply: true, readProcessStartTime: () => "1" }).runs[0];
  assert.deepEqual(signalAttempts, [gone, remaining]);
  assert.equal(result.action, "removed");
  assert.deepEqual(result.resources[0], { type: "process_marker", killed: [remaining] });
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(handle.file), false);
});
