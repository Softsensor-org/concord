"use strict";

// COORD-905: owned-resource manifests for runner and gate invocations.
//
// A runner or gate writes a run manifest BEFORE it creates anything it owns: its
// identity (pid, process start time, host, boot id, PID namespace), and each
// resource it is about to create (temp dir, clone, worktree, lock staging dir,
// marker process). A graceful exit (SIGTERM, SIGINT, normal return) removes what
// the manifest lists. A SIGKILL, OOM kill or power loss cannot run that cleanup, so
// `recoverRuns` finds manifests whose owner is provably dead and removes only what
// the manifest proves the run owned. Recovery is dry-run unless `apply` is set.
//
// Proof rules (fail closed):
//   - owner on another host                       -> "foreign", kept
//   - owner boot id / PID namespace differs, or
//     either side unreadable                       -> "unverifiable", kept
//   - owner pid not alive (or a zombie)            -> "dead"
//   - owner pid alive, start time unreadable       -> "unverifiable", kept
//   - owner pid alive, start time differs          -> "dead" (pid reused)
//   - owner pid alive, start time equal            -> "live", kept
// A directory is removed only if it still carries this run's marker file. A process
// is killed only if its environment carries this run's id (random per run, inherited
// by every descendant, not forgeable by an unrelated process).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const createDirectoryLocks = require("./directory-locks.js");
// COORD-992 (F-06): the shared pid and start-time primitive.
const { isProcessAlive, readOwnerIdentity, readProcState, readProcStartTime, startTimeVerdict } = require("./process-identity.js");

const SCHEMA_VERSION = 1;
const MANIFEST_KIND = "coord-run-ownership";
const RUN_ENV = "COORD_RUN_ID";
const MARKER = ".coord-run-id";
const OWNED_DIR_TYPES = Object.freeze(["temp_dir", "clone", "worktree", "lock_staging"]);
const STAGING_REMEDY = "coord/scripts/gov break-runtime-lock --kind <kind> --sweep-staging --yes";

function readStartTime(pid) {
  return readProcStartTime(pid);
}

function localIdentity() {
  const identity = readOwnerIdentity(process.pid);
  return {
    host: os.hostname(),
    pid: process.pid,
    boot_id: identity.boot_id ?? null,
    pid_ns: identity.pid_ns ?? null,
    pid_start_time: identity.pid_start_time ?? null,
  };
}

function readPgid(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
}

// A zombie has exited and cannot run; it is not alive.
function processAlive(pid) {
  if (!isProcessAlive(pid)) return false;
  const state = readProcState(pid);
  return state === null || state !== "Z";
}

function writeManifestAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(tmp, file);
}

// Pids whose environment carries exactly this run's marker. Excludes this process.
function markedPids(runId) {
  const needle = `${RUN_ENV}=${runId}`;
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(needle)) found.push(pid);
    } catch {
      // Unreadable or gone: not provably ours, so not included.
    }
  }
  return found;
}

function killMarked(runId) {
  const killed = [];
  for (const pid of markedPids(runId)) {
    try { process.kill(pid, "SIGKILL"); killed.push(pid); } catch { /* already gone */ }
  }
  return killed;
}

function markerMatches(dir, runId) {
  try {
    return fs.readFileSync(path.join(dir, MARKER), "utf8") === runId;
  } catch {
    return false;
  }
}

// Removes one recorded directory only when its marker proves this run created it.
function removeOwnedDir(resource, runId) {
  const target = resource.path;
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { return { removed: true, reason: "already absent" }; }
  if (!stat.isDirectory()) return { removed: false, reason: "not a directory; left in place" };
  if (!markerMatches(target, runId)) return { removed: false, reason: "marker does not match this run; left in place" };
  if (resource.type === "worktree" && resource.repo) {
    spawnSync("git", ["-C", resource.repo, "worktree", "remove", "--force", target], { stdio: "ignore" });
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { removed: true, reason: null };
}

function readManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && value.kind === MANIFEST_KIND ? value : null;
  } catch {
    return null;
  }
}

function ownerVerdict(owner, local, readStart = readStartTime) {
  if (!owner || !Number.isInteger(owner.pid) || typeof owner.host !== "string") return "unverifiable";
  if (owner.host !== local.host) return "foreign";
  if (typeof owner.boot_id !== "string" || typeof owner.pid_ns !== "string") return "unverifiable";
  if (!local.boot_id || !local.pid_ns) return "unverifiable";
  if (owner.boot_id !== local.boot_id || owner.pid_ns !== local.pid_ns) return "unverifiable";
  if (!processAlive(owner.pid)) return "dead";
  if (typeof owner.pid_start_time !== "string") return "unverifiable";
  const verdict = startTimeVerdict(owner.pid, owner.pid_start_time, readStart);
  if (verdict === "unknown") return "unverifiable";
  return verdict === "same" ? "live" : "dead";
}

function beginRun({ dir, kind = "run" }) {
  const runId = crypto.randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  const identity = localIdentity();
  const manifest = {
    schema_version: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    run_id: runId,
    run_kind: kind,
    owner: {
      pid: process.pid,
      pgid: readPgid(process.pid),
      host: identity.host,
      boot_id: identity.boot_id,
      pid_ns: identity.pid_ns,
      pid_start_time: identity.pid_start_time,
    },
    created_at: new Date().toISOString(),
    resources: [],
  };
  const file = path.join(dir, `${runId}.json`);
  writeManifestAtomic(file, manifest);
  const handle = {
    runId,
    file,
    manifest,
    env: { [RUN_ENV]: runId },
    onSignalCleanup: null,
    // Records a directory BEFORE it is created, then creates it and writes the marker.
    recordDir(type, target, { create = true, repo = null } = {}) {
      if (!OWNED_DIR_TYPES.includes(type)) throw new Error(`unknown owned directory type ${type}`);
      if (!path.isAbsolute(target)) throw new Error(`owned path must be absolute: ${target}`);
      manifest.resources.push({ type, path: target, ...(repo ? { repo } : {}), recorded_at: new Date().toISOString() });
      writeManifestAtomic(file, manifest);
      if (create) {
        fs.mkdirSync(target, { mode: type === "temp_dir" ? 0o700 : 0o777 });
        fs.writeFileSync(path.join(target, MARKER), runId);
      }
      return target;
    },
    recordTempDir(target) { return handle.recordDir("temp_dir", target); },
    // Records that this run may own marker processes (found by environment at recovery).
    recordProcessMarker() {
      manifest.resources.push({ type: "process_marker", env: RUN_ENV, recorded_at: new Date().toISOString() });
      writeManifestAtomic(file, manifest);
    },
    release() {
      if (handle.onSignalCleanup) { handle.onSignalCleanup(); handle.onSignalCleanup = null; }
      const kept = [];
      if (manifest.resources.some((resource) => resource.type === "process_marker")) killMarked(runId);
      for (const resource of [...manifest.resources].reverse()) {
        if (resource.type === "process_marker") continue;
        const result = removeOwnedDir(resource, runId);
        if (!result.removed) kept.push({ path: resource.path, reason: result.reason });
      }
      if (kept.length === 0) {
        fs.rmSync(file, { force: true });
      } else {
        manifest.resources = manifest.resources.filter((r) => kept.some((k) => k.path === r.path));
        writeManifestAtomic(file, manifest);
      }
      return { kept };
    },
  };
  return handle;
}

// On SIGTERM or SIGINT: release what the manifest lists, then exit with the
// conventional 128+signal code. Node runs signal listeners on the event loop, so a
// runner blocked in a synchronous child runs this only after that child returns.
function installSignalHandlers(handle, { signals = ["SIGTERM", "SIGINT"], exit = process.exit } = {}) {
  const listeners = signals.map((signal) => {
    const listener = () => {
      handle.release();
      exit(128 + os.constants.signals[signal]);
    };
    process.on(signal, listener);
    return [signal, listener];
  });
  handle.onSignalCleanup = () => {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  };
  return handle;
}

let stagingLocksCache = null;
function stagingLocks() {
  if (stagingLocksCache) return stagingLocksCache;
  stagingLocksCache = createDirectoryLocks({
    fs,
    path,
    os,
    process,
    readDirectoryLockMetadata(dir) {
      try { return JSON.parse(fs.readFileSync(path.join(dir, "lock-owner.json"), "utf8")); } catch { return null; }
    },
    isProcessAlive: processAlive,
  });
  return stagingLocksCache;
}

// Lock staging dirs that no live lock references: age and remedy. With `apply`, removes
// them through the same claim-and-verify path as `break-runtime-lock --sweep-staging`.
function stagingArtifacts(lockPaths, apply) {
  const locks = stagingLocks();
  return lockPaths.flatMap(({ kind, path: lockPath, staleMs }) => locks.collectStagingArtifacts(lockPath, staleMs).map((entry) => {
    const remedy = STAGING_REMEDY.replace("<kind>", kind);
    const base = { lock_kind: kind, path: entry.path, kind: entry.kind, age_ms: entry.age_ms, remedy };
    if (!apply) return { ...base, action: "would-remove" };
    const result = locks.removeStagingArtifactChecked(lockPath, entry);
    return { ...base, action: result.removed ? "removed" : "kept", reason: result.reason };
  }));
}

// Dead-owner recovery. Dry-run unless `apply`. Never touches a live, foreign or
// unverifiable run. Returns { dry_run, runs, staging }.
function recoverRuns({
  dir,
  apply = false,
  readProcessStartTime = readStartTime,
  localIdentity: local = localIdentity(),
  stagingLocks: lockPaths = [],
} = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { names = []; }
  const runs = names.map((name) => {
    const file = path.join(dir, name);
    const manifest = readManifest(file);
    if (!manifest) return { file, run_id: null, verdict: "unreadable", action: "kept", reason: "manifest is missing, corrupt or not a run manifest" };
    const verdict = ownerVerdict(manifest.owner, local, readProcessStartTime);
    const base = { file, run_id: manifest.run_id, run_kind: manifest.run_kind, owner_pid: manifest.owner?.pid ?? null, verdict };
    if (verdict !== "dead") return { ...base, action: "kept", reason: `owner is ${verdict}; not reclaimed` };
    if (!apply) {
      const resources = (manifest.resources || []).map((r) => (r.type === "process_marker"
        ? { type: r.type, pids: markedPids(manifest.run_id) }
        : { type: r.type, path: r.path }));
      return { ...base, action: "would-remove", resources };
    }
    const results = [];
    if (manifest.resources?.some((resource) => resource.type === "process_marker")) {
      results.push({ type: "process_marker", killed: killMarked(manifest.run_id) });
    }
    for (const resource of [...(manifest.resources || [])].reverse()) {
      if (resource.type !== "process_marker") results.push({ type: resource.type, path: resource.path, ...removeOwnedDir(resource, manifest.run_id) });
    }
    const complete = results.every((r) => (r.type === "process_marker" ? true : r.removed === true));
    if (complete) fs.rmSync(file, { force: true });
    return { ...base, action: complete ? "removed" : "partial", resources: results, manifest_kept: !complete };
  });
  const staging = lockPaths.length > 0 ? stagingArtifacts(lockPaths, apply) : [];
  return { dry_run: !apply, runs, staging };
}

// Lock staging dirs that no live lock references, with age and remedy (doctor report).
function stagingReport({ lockPaths }) {
  return stagingArtifacts(lockPaths, false);
}

// Default run-manifest directory for one coord checkout. Under os.tmpdir() so runner
// manifests never land in a live coord/.runtime; doctor uses the same location.
function defaultRunsDir(coordDir) {
  const key = crypto.createHash("sha256").update(path.resolve(coordDir)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "coord-run-ownership", key);
}

// Runs a CLI entry point with an owned run: manifest first, run id in the environment
// (so every child inherits it), graceful-exit cleanup, and release on every return.
function runOwned({ dir, kind, argv, main }) {
  const handle = beginRun({ dir, kind });
  installSignalHandlers(handle);
  process.env[RUN_ENV] = handle.runId;
  handle.recordProcessMarker();
  try {
    return main(argv, handle);
  } finally {
    handle.release();
    delete process.env[RUN_ENV];
  }
}

module.exports = {
  defaultRunsDir,
  runOwned,
  MARKER,
  MANIFEST_KIND,
  RUN_ENV,
  OWNED_DIR_TYPES,
  beginRun,
  installSignalHandlers,
  recoverRuns,
  stagingReport,
  ownerVerdict,
  localIdentity,
  processAlive,
  markedPids,
  readManifest,
};
