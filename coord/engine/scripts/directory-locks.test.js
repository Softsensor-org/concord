"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const createDirectoryLocks = require("./directory-locks.js");
const { readProcStartTime } = require("./process-identity.js");

function readProcStartTimeOfSelf() {
  return readProcStartTime(process.pid);
}

// COORD-951 (4): a dead pid is a real reaped child, never a constant that may be live.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("directory lock recovery uses a stable claim name when an injected process has no PID", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-pidless-claim-"));
  const lockPath = path.join(tempDir, ".agent-state.lock");
  const staleAt = new Date(Date.now() - 120_000);
  fs.mkdirSync(lockPath);
  fs.utimesSync(lockPath, staleAt, staleAt);

  let retainedClaim = null;
  const locks = createDirectoryLocks({
    fs,
    path,
    os,
    process: { platform: process.platform },
    readDirectoryLockMetadata(directory) {
      try { return JSON.parse(fs.readFileSync(path.join(directory, "lock-owner.json"), "utf8")); }
      catch { return null; }
    },
    readLockAgeMs(directory) { return Date.now() - fs.statSync(directory).mtimeMs; },
    isProcessAlive(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    },
    sameFilesystemEntry() {
      fs.mkdirSync(lockPath); // A fresh canonical entry wins after the old entry is claimed.
      return false;
    },
    writeDirectoryLockMetadata(directory, metadata) {
      fs.writeFileSync(path.join(directory, "lock-owner.json"), JSON.stringify(metadata));
    },
  });

  try {
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, {
      onClaimRetained(claimPath) { retainedClaim = claimPath; },
    }), false);
    assert.match(retainedClaim, /\.agent-state\.lock\.reclaim-pid-/,
      "a missing process.pid uses the documented stable fallback in the claim name");
    assert.equal(fs.existsSync(lockPath), true, "the new canonical lock is preserved");
    assert.equal(fs.existsSync(retainedClaim), true, "the moved old entry is retained for repair");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-841: half-acquired cleanup removes only the directory entry this attempt created", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord841-half-acquired-"));
  const lockPath = path.join(tempDir, "governance.lock");
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const locks = createDirectoryLocks({
    fs,
    path,
    os,
    process: { platform: process.platform },
    readDirectoryLockMetadata(directory) {
      try { return JSON.parse(fs.readFileSync(path.join(directory, "lock-owner.json"), "utf8")); }
      catch { return null; }
    },
    sameFilesystemEntry: (left, right) => left.dev === right.dev && left.ino === right.ino,
  });
  try {
    fs.mkdirSync(lockPath);
    const identity = fs.statSync(lockPath);
    // Same inode number but a different birth time: inode reuse after a break.
    const reused = { dev: identity.dev, ino: identity.ino, birthtimeMs: identity.birthtimeMs - 1 };
    assert.equal(locks.releaseHalfAcquiredDirectoryLock(lockPath, { token: "t", identity: reused, warn }), "replaced");
    assert.equal(fs.existsSync(lockPath), true);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ token: "other" }));
    assert.equal(locks.releaseHalfAcquiredDirectoryLock(lockPath, { token: "t", identity, warn }), "foreign");
    assert.equal(fs.existsSync(lockPath), true);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ token: "t" }));
    assert.equal(locks.releaseHalfAcquiredDirectoryLock(lockPath, { token: "t", identity, warn }), "removed");
    assert.equal(fs.existsSync(lockPath), false);
    // The replaced keep above is reported, naming the directory and the recovery.
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(lockPath));
    assert.match(warnings[0], /no longer matches/);
    assert.match(warnings[0], /coord\/scripts\/gov break-runtime-lock --yes/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-841: a partial owner-record write left inside our directory is still cleaned, and a ctime-fallback birthtime keeps it with a warning", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord841-partial-write-"));
  const lockPath = path.join(tempDir, "governance.lock");
  const warnings = [];
  const deps = {
    fs, path, os,
    process: { platform: process.platform },
    readDirectoryLockMetadata(directory) {
      try { return JSON.parse(fs.readFileSync(path.join(directory, "lock-owner.json"), "utf8")); }
      catch { return null; }
    },
    sameFilesystemEntry: (left, right) => left.dev === right.dev && left.ino === right.ino,
  };
  const locks = createDirectoryLocks(deps);
  const warn = (message) => warnings.push(message);
  try {
    fs.mkdirSync(lockPath);
    const identity = fs.statSync(lockPath);
    // The realistic failure: the owner-record tmp file landed before the write failed.
    fs.writeFileSync(path.join(lockPath, `lock-owner.json.tmp-${process.pid}`), "{\"tok");
    const current = fs.statSync(lockPath);
    if (current.birthtimeMs === identity.birthtimeMs) {
      assert.equal(locks.releaseHalfAcquiredDirectoryLock(lockPath, { token: "t", identity, warn }), "removed");
      assert.equal(fs.existsSync(lockPath), false, "our directory and its partial tmp file are cleaned");
      assert.deepEqual(warnings, []);
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, `lock-owner.json.tmp-${process.pid}`), "{\"tok");
    }
    // libuv without statx reports ctime as birthtime, so the partial write moves it:
    // the directory is kept (it cannot be proven ours) but never silently.
    const fallbackIdentity = { ...fs.statSync(lockPath), dev: fs.statSync(lockPath).dev, ino: fs.statSync(lockPath).ino, birthtimeMs: identity.ctimeMs - 1 };
    assert.equal(locks.releaseHalfAcquiredDirectoryLock(lockPath, { token: "t", identity: fallbackIdentity, warn }), "replaced");
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(lockPath));
    assert.match(warnings[0], /coord\/scripts\/gov break-runtime-lock --yes/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stale reclaim rethrows a removal failure while the claim remains and reports false once it is gone", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord841-reclaim-failure-"));
  const lockPath = path.join(tempDir, "governance.lock");
  const staleAt = new Date(Date.now() - 120_000);
  let mode = "keep";
  const failingFs = {
    ...fs,
    rmSync(target, options) {
      if (String(target).includes(".reclaim-")) {
        if (mode === "gone") fs.rmSync(target, options);
        const error = new Error(`EBUSY: injected removal failure, ${target}`);
        error.code = "EBUSY";
        throw error;
      }
      return fs.rmSync(target, options);
    },
  };
  const locks = createDirectoryLocks({
    fs: failingFs,
    path,
    os,
    process: { platform: process.platform, pid: process.pid },
    readDirectoryLockMetadata() { return null; },
    readLockAgeMs(directory) { return Date.now() - fs.statSync(directory).mtimeMs; },
    isProcessAlive() { return false; },
    sameFilesystemEntry: (left, right) => left.dev === right.dev && left.ino === right.ino,
    writeDirectoryLockMetadata() {},
  });
  try {
    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, staleAt, staleAt);
    assert.throws(() => locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), /EBUSY: injected removal failure/,
      "a removal failure that leaves the claimed entry behind is surfaced");
    const leftover = fs.readdirSync(tempDir).filter((name) => name.includes(".reclaim-"));
    assert.equal(leftover.length, 1, "the claimed entry is kept for repair, not lost");

    fs.mkdirSync(lockPath);
    fs.utimesSync(lockPath, staleAt, staleAt);
    mode = "gone";
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), false,
      "a removal error after the claim is already gone is not a failure to report");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// COORD-931: dangling lock links, namespace-safe owner liveness, checked removal,
// and staging cleanup. These run the real filesystem with real identity helpers
// injected the same way governance-context wires them.
const { spawn } = require("node:child_process");
const DIRECTORY_LOCKS_MODULE = path.join(__dirname, "directory-locks.js");

function realLockDeps(overrides = {}) {
  return {
    fs,
    path,
    os,
    process: { platform: process.platform, pid: process.pid },
    readDirectoryLockMetadata(directory) {
      try { return JSON.parse(fs.readFileSync(path.join(directory, "lock-owner.json"), "utf8")); }
      catch { return null; }
    },
    readLockAgeMs(lockPath) {
      try { return Date.now() - fs.lstatSync(lockPath).mtimeMs; } catch { return null; }
    },
    isProcessAlive(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) { return error?.code === "EPERM"; }
    },
    sameFilesystemEntry: (left, right) => left.dev === right.dev && left.ino === right.ino,
    writeDirectoryLockMetadata(directory, metadata) {
      fs.writeFileSync(path.join(directory, "lock-owner.json"), JSON.stringify({
        pid: process.pid, host: os.hostname(), ...metadata,
      }));
    },
    ...overrides,
  };
}

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function makeDangling(lockPath, target = "missing-staging-dir") {
  fs.symlinkSync(target, lockPath, "dir");
  const old = new Date(Date.now() - 120_000);
  fs.lutimesSync(lockPath, old, old);
}

test("COORD-931: inspectLockPath classifies absent, directory, live and dangling links without following them", () => {
  withTempDir("coord931-inspect-", (tempDir) => {
    const locks = createDirectoryLocks(realLockDeps());
    const absent = path.join(tempDir, "absent.lock");
    assert.equal(locks.inspectLockPath(absent).state, "absent");

    const dir = path.join(tempDir, "dir.lock");
    fs.mkdirSync(dir);
    assert.equal(locks.inspectLockPath(dir).state, "directory");

    const liveTarget = path.join(tempDir, ".live.lock.acquire-1");
    fs.mkdirSync(liveTarget);
    const live = path.join(tempDir, "live.lock");
    fs.symlinkSync(liveTarget, live, "dir");
    const liveInfo = locks.inspectLockPath(live);
    assert.equal(liveInfo.state, "link-live");
    assert.equal(liveInfo.target, liveTarget);

    const dangling = path.join(tempDir, "governance.lock");
    makeDangling(dangling, ".governance.lock.acquire-gone");
    const info = locks.inspectLockPath(dangling);
    assert.equal(info.state, "link-dangling");
    assert.equal(info.target, ".governance.lock.acquire-gone");
    assert.equal(info.target_exists, false);
    assert.ok(info.linkAgeMs >= 120_000 - 1000, "the link age is read from the link itself");
    assert.ok(Number.isInteger(info.linkIno) && Number.isInteger(info.linkDev));
    assert.match(locks.describeDanglingLink(dangling), /dangling_link target=\.governance\.lock\.acquire-gone target_exists=no/);
    assert.equal(locks.describeDanglingLink(live), "");
  });
});

test("COORD-931: a dangling link blocks acquire, is never silently treated as absent, and is reclaimed once stale", () => {
  withTempDir("coord931-dangling-acquire-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    makeDangling(lockPath);
    // Fresh dangling link: acquire reports contention (false), it does not throw or pass.
    fs.lutimesSync(lockPath, new Date(), new Date());
    assert.equal(locks.acquireDirectoryLock(lockPath, { kind: "agent-state" }), false);
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), false, "a fresh dangling link is not reclaimed by age");
    assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true, "the link is left in place until it is stale");

    // Once it has aged past the threshold, the existing reclaim path removes it and acquire proceeds.
    const old = new Date(Date.now() - 120_000);
    fs.lutimesSync(lockPath, old, old);
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), true);
    assert.equal(locks.inspectLockPath(lockPath).state, "absent");
    assert.equal(locks.acquireDirectoryLock(lockPath, { kind: "agent-state" }), true);
    assert.equal(locks.inspectLockPath(lockPath).state, "link-live");
    locks.removeDirectoryLock(lockPath);
  });
});

test("COORD-931: checked removal removes the observed dangling link only when nothing changed", () => {
  withTempDir("coord931-checked-remove-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    makeDangling(lockPath, ".agent-state.lock.acquire-gone");
    const observed = locks.inspectLockPath(lockPath);

    const removed = locks.removeDanglingLinkChecked(lockPath, observed);
    assert.equal(removed.removed, true);
    assert.equal(locks.inspectLockPath(lockPath).state, "absent");
    assert.equal(fs.readdirSync(tempDir).filter((name) => name.includes(".reclaim-")).length, 0,
      "the claimed link is unlinked, not left behind");
  });
});

test("COORD-931: checked removal refuses and restores a link that changed between observe and remove", () => {
  withTempDir("coord931-changed-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    makeDangling(lockPath, ".agent-state.lock.acquire-first");
    const observed = locks.inspectLockPath(lockPath);

    // Another actor replaces the link with a different dangling target after observation.
    fs.unlinkSync(lockPath);
    fs.symlinkSync(".agent-state.lock.acquire-second", lockPath, "dir");
    const result = locks.removeDanglingLinkChecked(lockPath, observed);
    assert.equal(result.removed, false);
    assert.match(result.reason, /changed or was already removed/);
    assert.equal(fs.readlinkSync(lockPath), ".agent-state.lock.acquire-second", "the replacement link is kept");
    assert.equal(fs.readdirSync(tempDir).filter((name) => name.includes(".reclaim-")).length, 0);
  });
});

test("COORD-931: two concurrent recoveries of one dangling link: exactly one child succeeds", async () => {
  await withTempDirAsync("coord931-concurrent-", async (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    makeDangling(lockPath, ".agent-state.lock.acquire-raced");
    const observed = JSON.stringify(locks.inspectLockPath(lockPath));
    const script = `
      const path = require("path"), os = require("os"), fs = require("fs");
      const [moduleFile, lockPath, observedJson] = process.argv.slice(1);
      const locks = require(moduleFile)({
        fs, path, os, process: { platform: process.platform, pid: process.pid },
        readDirectoryLockMetadata: () => null, readLockAgeMs: () => 0,
        isProcessAlive: () => false, sameFilesystemEntry: () => false, writeDirectoryLockMetadata: () => {},
      });
      const result = locks.removeDanglingLinkChecked(lockPath, JSON.parse(observedJson));
      process.stdout.write(JSON.stringify({ removed: result.removed }));
    `;
    const runChild = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, DIRECTORY_LOCKS_MODULE, lockPath, observed]);
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    });
    const [first, second] = await Promise.all([runChild(), runChild()]);
    const outcomes = [first, second].map((entry) => {
      assert.equal(entry.code, 0, entry.out);
      return JSON.parse(entry.out).removed;
    });
    assert.equal(outcomes.filter(Boolean).length, 1, `exactly one recovery succeeds, got ${JSON.stringify(outcomes)}`);
    assert.equal(locks.inspectLockPath(lockPath).state, "absent");
  });
});

async function withTempDirAsync(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("COORD-931: an owner in another boot or PID namespace is unverifiable, never dead, and is not reclaimed early", () => {
  withTempDir("coord931-namespace-", (tempDir) => {
    const lockPath = path.join(tempDir, "governance.lock");
    const deadLooking = { pid: deadPid(), boot_id: "boot-elsewhere", pid_ns: "pid:[4026531836]", pid_start_time: "1" };
    const locks = createDirectoryLocks(realLockDeps({
      isProcessAlive: () => false, // in our namespace this PID is absent: it must NOT count as dead
      readLocalIdentity: () => ({ bootId: "boot-here", pidNs: "pid:[4026532999]" }),
      readProcessStartTime: () => null,
    }));
    assert.equal(locks.ownerVerdict(deadLooking), "unverifiable");

    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ host: os.hostname(), ...deadLooking }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), false,
      "a fresh unverifiable owner is not reclaimed as dead");
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), false,
      "explicit recovery does not reclaim an unverifiable owner while its lease is fresh");
    assert.equal(fs.existsSync(lockPath), true);

    // COORD-931 ruling: the short per-kind threshold does not release an unverifiable owner.
    const short = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, short, short);
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), false,
      "a 60s stale threshold never reclaims an unverifiable owner (COORD-270)");
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), false,
      "explicit recovery does not reclaim it before the lease either");
    assert.equal(fs.existsSync(lockPath), true);

    // Only the lock's own age past the lease releases an unverifiable owner.
    const expired = new Date(Date.now() - (locks.UNVERIFIABLE_OWNER_STALE_MS + 60_000));
    fs.utimesSync(lockPath, expired, expired);
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), true);
  });
});

test("COORD-931: same boot and PID namespace still decides dead/live, and a reused PID is dead", () => {
  withTempDir("coord931-same-ns-", (tempDir) => {
    const identity = { boot_id: "boot-here", pid_ns: "pid:[1]", pid_start_time: "100" };
    const locks = createDirectoryLocks(realLockDeps({
      isProcessAlive: () => false,
      readLocalIdentity: () => ({ bootId: "boot-here", pidNs: "pid:[1]" }),
      readProcessStartTime: () => null,
    }));
    assert.equal(locks.ownerVerdict({ pid: deadPid(), host: os.hostname(), ...identity }), "dead");

    const reused = createDirectoryLocks(realLockDeps({
      isProcessAlive: () => true,
      readLocalIdentity: () => ({ bootId: "boot-here", pidNs: "pid:[1]" }),
      readProcessStartTime: () => "555", // the PID now belongs to a different process
    }));
    assert.equal(reused.ownerVerdict({ pid: process.pid, host: os.hostname(), ...identity }), "dead");

    const live = createDirectoryLocks(realLockDeps({
      isProcessAlive: () => true,
      readLocalIdentity: () => ({ bootId: "boot-here", pidNs: "pid:[1]" }),
      readProcessStartTime: () => "100",
    }));
    assert.equal(live.ownerVerdict({ pid: process.pid, host: os.hostname(), ...identity }), "live");

    // Unreadable local identity is unverifiable, never dead.
    const blind = createDirectoryLocks(realLockDeps({ isProcessAlive: () => false }));
    assert.equal(blind.ownerVerdict({ pid: deadPid(), host: os.hostname(), ...identity }), "unverifiable");
  });
});

test("COORD-931: legacy owners without identity fields keep the host+PID rule", () => {
  const locks = createDirectoryLocks(realLockDeps({ isProcessAlive: (pid) => pid === process.pid }));
  assert.equal(locks.ownerVerdict({ pid: deadPid(), host: os.hostname() }), "dead");
  assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname() }), "live");
  assert.equal(locks.ownerVerdict({ pid: deadPid(), host: "other-host" }), "foreign");
  assert.equal(locks.ownerVerdict({}), "unknown");
});

test("COORD-931: interrupted acquire and reclaim leave artifacts the sweep finds, and the lock stays usable", () => {
  withTempDir("coord931-interrupted-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    const old = new Date(Date.now() - 120_000);

    // Step 1 of acquire interrupted: staging directory made, nothing published.
    const orphanAcquire = path.join(tempDir, ".agent-state.lock.acquire-orphan");
    fs.mkdirSync(orphanAcquire);
    fs.utimesSync(orphanAcquire, old, old);
    // Reclaim interrupted after claiming the old entry, before it was removed.
    const orphanReclaim = path.join(tempDir, ".agent-state.lock.reclaim-1-abc-def");
    fs.mkdirSync(orphanReclaim);
    fs.utimesSync(orphanReclaim, old, old);
    // Interrupted before the owner record landed: staging exists, a fresh one is a live acquire.
    const freshAcquire = path.join(tempDir, ".agent-state.lock.acquire-fresh");
    fs.mkdirSync(freshAcquire);

    const found = locks.collectStagingArtifacts(lockPath, 60_000).map((entry) => path.basename(entry.path));
    assert.deepEqual(found, [".agent-state.lock.acquire-orphan", ".agent-state.lock.reclaim-1-abc-def"].sort(),
      "only aged, unreferenced artifacts are candidates");

    // The lock is not blocked by the leftover staging directories.
    assert.equal(locks.acquireDirectoryLock(lockPath, { kind: "agent-state" }), true);
    assert.equal(locks.inspectLockPath(lockPath).state, "link-live");
  });
});

test("COORD-931: the staging sweep never removes a referenced or fresh artifact, and removes an aged unreferenced one", () => {
  withTempDir("coord931-sweep-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    const old = new Date(Date.now() - 120_000);
    const referenced = path.join(tempDir, ".agent-state.lock.acquire-live");
    fs.mkdirSync(referenced);
    fs.utimesSync(referenced, old, old);
    fs.symlinkSync(referenced, lockPath, "dir");
    const aged = path.join(tempDir, ".agent-state.lock.acquire-aged");
    fs.mkdirSync(aged);
    fs.utimesSync(aged, old, old);

    const candidates = locks.collectStagingArtifacts(lockPath, 60_000);
    assert.deepEqual(candidates.map((entry) => path.basename(entry.path)), [".agent-state.lock.acquire-aged"]);
    const result = locks.removeStagingArtifactChecked(lockPath, candidates[0]);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(aged), false);
    assert.equal(fs.existsSync(referenced), true, "the artifact a lock link points at is kept");
    assert.equal(locks.inspectLockPath(lockPath).state, "link-live");
  });
});

// COORD-931 review R1: explicit recovery matches the pre-931 host rules. A hostless PID
// may belong to another machine, so only a host-local dead PID is reclaimed at once.
test("COORD-931 R1: explicit recovery refuses a hostless dead-PID owner inside the stale age and reclaims it past it", () => {
  withTempDir("coord931-r1-hostless-", (tempDir) => {
    const lockPath = path.join(tempDir, "agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps({ isProcessAlive: () => false }));
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ pid: deadPid() }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), false,
      "a fresh hostless owner is not reclaimed on a dead PID alone");
    assert.equal(fs.existsSync(lockPath), true);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), true,
      "past the stale age the hostless owner is reclaimed");
  });
});

test("COORD-931 R1: explicit recovery reclaims a host-local dead-PID owner immediately", () => {
  withTempDir("coord931-r1-local-", (tempDir) => {
    const lockPath = path.join(tempDir, "agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps({ isProcessAlive: () => false }));
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), true,
      "a fresh host-local dead owner is reclaimed without waiting for the age threshold");
  });
});

// COORD-931 review R2: a retained claim whose owner is still live is reported and kept.
test("COORD-931 R2: the staging sweep never deletes a retained claim whose owner is live", () => {
  withTempDir("coord931-r2-live-claim-", (tempDir) => {
    const lockPath = path.join(tempDir, ".agent-state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    const old = new Date(Date.now() - 120_000);
    const liveClaim = path.join(tempDir, ".agent-state.lock.reclaim-7-live-x");
    fs.mkdirSync(liveClaim);
    fs.writeFileSync(path.join(liveClaim, "lock-owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname() }));
    fs.utimesSync(liveClaim, old, old);
    const deadClaim = path.join(tempDir, ".agent-state.lock.reclaim-8-dead-y");
    fs.mkdirSync(deadClaim);
    fs.writeFileSync(path.join(deadClaim, "lock-owner.json"), JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    fs.utimesSync(deadClaim, old, old);

    const candidates = locks.collectStagingArtifacts(lockPath, 60_000);
    assert.deepEqual(candidates.map((entry) => path.basename(entry.path)).sort(),
      [".agent-state.lock.reclaim-7-live-x", ".agent-state.lock.reclaim-8-dead-y"]);
    const live = candidates.find((entry) => entry.path === liveClaim);
    const kept = locks.removeStagingArtifactChecked(lockPath, live);
    assert.equal(kept.removed, false);
    assert.match(kept.reason, /owner is live; retained for explicit repair/);
    assert.equal(fs.existsSync(liveClaim), true, "the live-owner claim is kept, not deleted");
    assert.equal(fs.readdirSync(tempDir).filter((name) => name.includes(".reclaim-sweep-")).length, 0,
      "the moved claim is restored to its name, not left behind");

    const dead = candidates.find((entry) => entry.path === deadClaim);
    assert.equal(locks.removeStagingArtifactChecked(lockPath, dead).removed, true,
      "a claim whose owner is dead is still removed");
  });
});

// COORD-951 (1): a future mtime is clock skew, never an age. An ownerless lock whose
// mtime runs an hour ahead is diagnosed as skew and reclaimed only by explicit recovery.
test("COORD-951 A1: an ownerless lock with a future mtime reports clock skew and is reclaimable only by explicit recovery", () => {
  withTempDir("coord951-future-mtime-", (tempDir) => {
    const lockPath = path.join(tempDir, "governance.lock");
    fs.mkdirSync(lockPath);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(lockPath, future, future);
    const locks = createDirectoryLocks(realLockDeps({ isProcessAlive: () => false }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000), false,
      "automatic age reclaim never trusts a future mtime");
    assert.equal(fs.existsSync(lockPath), true);
    const diagnostic = locks.describeDirectoryLockHolder(lockPath, 60_000);
    assert.match(diagnostic, /clock_skew=future-mtime/, diagnostic);
    assert.match(diagnostic, /reclaimable=explicit-recovery-only/, diagnostic);
    const ownerFile = path.join(lockPath, "lock-owner.json");
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: "fixture-foreign-host" }));
    fs.utimesSync(lockPath, future, future);
    assert.match(locks.describeDirectoryLockHolder(lockPath, 60_000),
      /clock_skew=future-mtime.*reclaimable=now \(owner is dead or on a foreign host\)/);
    fs.unlinkSync(ownerFile);
    fs.utimesSync(lockPath, future, future);

    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), true,
      "explicit recovery reclaims an ownerless lock whose mtime is in the future");
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("COORD-951 A2: a future-mtime lock with a LIVE owner is never reclaimed, even by explicit recovery", () => {
  withTempDir("coord951-future-live-", (tempDir) => {
    const lockPath = path.join(tempDir, "governance.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const future = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(lockPath, future, future);
    const locks = createDirectoryLocks(realLockDeps({ isProcessAlive: () => true }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, { explicitRecovery: true }), false);
    assert.equal(fs.existsSync(lockPath), true);
  });
});

// COORD-951 (4): no suite in the liveness scope uses a literal dead-looking pid. Dead
// pids come from deadPid(); a numeric pid literal of four or more digits is refused.
test("COORD-951 P1: the liveness suites use no literal pid constant", () => {
  const suites = [
    "directory-locks.test.js",
    "identity-v2.test.js",
    "governance-session.test.js",
    "governance-context.test.js",
    "integration-authority.test.js",
    "runtime-cleanup.test.js",
  ];
  const literalPid = /\bpid\b["']?\s*[:=]\s*\d{4,}/g;
  for (const name of suites) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.deepEqual(source.match(literalPid) || [], [], `${name} must obtain dead pids from deadPid()`);
  }
});

// COORD-992 (F-06): one process-identity check. A PID reused by another process (same boot and
// namespace, different start time) is dead, so its lock is reclaimed; with /proc unavailable the
// answer stays PID-only and a live owner is never reclaimed.
test("COORD-992: a PID reused with a different start time reclaims the lock (real filesystem and /proc)", () => {
  withTempDir("coord992-reuse-", (dir) => {
    const lockPath = path.join(dir, "lock");
    fs.mkdirSync(lockPath);
    const identity = createDirectoryLocks.readOwnerIdentity(process.pid);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({
      pid: process.pid, host: os.hostname(), boot_id: identity.boot_id, pid_ns: identity.pid_ns, pid_start_time: "1",
    }));
    const locks = createDirectoryLocks(realLockDeps());
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, {}), true, "a reused pid is dead: reclaimed");
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("COORD-992: with /proc unavailable the owner stays PID-only live and the lock is not reclaimed", () => {
  withTempDir("coord992-noproc-", (dir) => {
    const lockPath = path.join(dir, "lock");
    fs.mkdirSync(lockPath);
    const identity = createDirectoryLocks.readOwnerIdentity(process.pid);
    fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({
      pid: process.pid, host: os.hostname(), boot_id: identity.boot_id, pid_ns: identity.pid_ns, pid_start_time: "1",
    }));
    const locks = createDirectoryLocks(realLockDeps({ readProcessStartTime: () => null }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, {}), false, "unknown start time keeps the live pid live");
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test("COORD-992: a legacy owner record carrying a start time is dead when the PID was reused (sanctioned change)", () => {
  const locks = createDirectoryLocks(realLockDeps());
  assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname(), pid_start_time: "1" }), "dead");
  assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname() }), "live", "legacy record without start time stays pid-only");
});

// COORD-1003: start-time-aware liveness on the lock wording and the reclaim verdict. A reused pid
// (same pid, different start time) is not alive; the same process stays alive; an unknown start
// time keeps PID-only behaviour and is never reclaimed; a zombie is dead.
function ownerLockDir(dir, owner) {
  const lockPath = path.join(dir, "lock");
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "lock-owner.json"), JSON.stringify({ host: os.hostname(), ...owner }));
  return lockPath;
}

test("COORD-1003: a reused pid reads as owner_alive=no in the lock wording and is reclaimable now", () => {
  withTempDir("coord1003-wording-reuse-", (dir) => {
    const lockPath = ownerLockDir(dir, { pid: process.pid, pid_start_time: "1" });
    const locks = createDirectoryLocks(realLockDeps());
    const wording = locks.describeDirectoryLockHolder(lockPath, 60_000);
    assert.match(wording, /owner_alive=no/, wording);
    assert.doesNotMatch(wording, /owner_alive=yes/, wording);
    assert.match(wording, /reclaimable=now \(owner is dead or on a foreign host\)/, wording);
    assert.doesNotMatch(wording, /reclaimable=when live owner exits/, wording);
  });
});

test("COORD-1003: the same process stays owner_alive=yes and is never reclaimed", () => {
  withTempDir("coord1003-same-", (dir) => {
    const start = readProcStartTimeOfSelf();
    const lockPath = ownerLockDir(dir, { pid: process.pid, pid_start_time: start });
    const locks = createDirectoryLocks(realLockDeps());
    assert.match(locks.describeDirectoryLockHolder(lockPath, 60_000), /owner_alive=yes .*reclaimable=when live owner exits \(not by age\)/);
    assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname(), pid_start_time: start }), "live");
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 1, {}), false, "a live owner with a matching start time is never reclaimed");
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test("COORD-1003: an unknown start time keeps PID-only behaviour: owner_alive=yes, never reclaimed, never reported dead", () => {
  withTempDir("coord1003-unknown-", (dir) => {
    const lockPath = ownerLockDir(dir, { pid: process.pid });
    const locks = createDirectoryLocks(realLockDeps({ readProcessStartTime: () => null }));
    const wording = locks.describeDirectoryLockHolder(lockPath, 60_000);
    assert.match(wording, /owner_alive=yes/, wording);
    assert.doesNotMatch(wording, /owner_alive=no/, wording);
    assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname() }), "live");
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 1, {}), false, "unknown start time is never reclaimed");
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test("COORD-1003: a zombie owner reads as owner_alive=no and is dead outside run-ownership", () => {
  withTempDir("coord1003-zombie-", (dir) => {
    const start = readProcStartTimeOfSelf();
    const lockPath = ownerLockDir(dir, { pid: process.pid, pid_start_time: start });
    const locks = createDirectoryLocks(realLockDeps({ readProcessState: () => "Z" }));
    assert.match(locks.describeDirectoryLockHolder(lockPath, 60_000), /owner_alive=no/);
    assert.equal(locks.ownerVerdict({ pid: process.pid, host: os.hostname(), pid_start_time: start }), "dead");
    assert.equal(locks.tryReclaimStaleDirectoryLock(lockPath, 60_000, {}), true, "a zombie owner is dead: reclaimed");
  });
});

test("COORD-1003: state-lock recovery wording reports a reused pid as dead-local, and the same process as live-local", () => {
  withTempDir("coord1003-state-", (dir) => {
    const start = readProcStartTimeOfSelf();
    const reused = ownerLockDir(dir, { pid: process.pid, pid_start_time: "1" });
    const locks = createDirectoryLocks(realLockDeps());
    const reusedWording = locks.describeStateLockRecovery(reused, 60_000, "coord-state");
    assert.match(reusedWording, /owner_alive=no host=\S+ owner_state=dead-local/, reusedWording);
    assert.doesNotMatch(reusedWording, /live-local|owner_alive=yes|reclaimable=when live owner exits/, reusedWording);
    fs.rmSync(reused, { recursive: true, force: true });
    const same = ownerLockDir(dir, { pid: process.pid, pid_start_time: start });
    assert.match(locks.describeStateLockRecovery(same, 60_000, "coord-state"), /owner_alive=yes host=\S+ owner_state=live-local/);
  });
});

test("COORD-1003: state-lock recovery wording with an unknown start time stays live-local (PID-only), never dead-local", () => {
  withTempDir("coord1003-state-unknown-", (dir) => {
    const lockPath = ownerLockDir(dir, { pid: process.pid });
    const locks = createDirectoryLocks(realLockDeps({ readProcessStartTime: () => null }));
    const wording = locks.describeStateLockRecovery(lockPath, 60_000, "coord-state");
    assert.match(wording, /owner_alive=yes host=\S+ owner_state=live-local/, wording);
    assert.doesNotMatch(wording, /dead-local/, wording);
  });
});

test("COORD-1003: state-lock recovery wording reports a zombie owner as dead-local", () => {
  withTempDir("coord1003-state-zombie-", (dir) => {
    const start = readProcStartTimeOfSelf();
    const lockPath = ownerLockDir(dir, { pid: process.pid, pid_start_time: start });
    const locks = createDirectoryLocks(realLockDeps({ readProcessState: () => "Z" }));
    assert.match(locks.describeStateLockRecovery(lockPath, 60_000, "coord-state"), /owner_alive=no host=\S+ owner_state=dead-local/);
  });
});

test("directory lock publication failures clean staging and preserve the competing lock", () => {
  withTempDir("coord-lock-publication-", (dir) => {
    const lock = path.join(dir, "state.lock");
    for (const code of ["EEXIST", "ENOTEMPTY", "EISDIR", "EPERM", "EIO"]) {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "winner"), "unchanged");
      const failure = Object.assign(new Error("publication refused"), { code });
      const locks = createDirectoryLocks(realLockDeps({
        fs: { ...fs, symlinkSync() { throw failure; } },
      }));
      if (code === "EIO") assert.throws(() => locks.acquireDirectoryLock(lock, {}), (e) => e === failure);
      else assert.equal(locks.acquireDirectoryLock(lock, {}), false);
      assert.deepEqual(fs.readdirSync(dir), ["state.lock"], "unpublished staging is removed");
      assert.equal(fs.readFileSync(path.join(lock, "winner"), "utf8"), "unchanged");
      fs.rmSync(lock, { recursive: true });
    }
    const failure = Object.assign(new Error("permission denied without competitor"), { code: "EPERM" });
    const locks = createDirectoryLocks(realLockDeps({ fs: { ...fs, symlinkSync() { throw failure; } } }));
    assert.throws(() => locks.acquireDirectoryLock(lock, {}), (e) => e === failure);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("dangling link recovery retains its claim when a concurrent replacement blocks restoration", () => {
  withTempDir("coord-lock-dangling-race-", (dir) => {
    const lock = path.join(dir, "state.lock");
    makeDangling(lock);
    const original = createDirectoryLocks(realLockDeps()).inspectLockPath(lock);
    const locks = createDirectoryLocks(realLockDeps({ fs: {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === lock) {
          fs.unlinkSync(to);
          fs.symlinkSync("different-missing-target", to);
          fs.mkdirSync(lock);
          fs.writeFileSync(path.join(lock, "winner"), "preserved");
        }
      },
    } }));
    const result = locks.removeDanglingLinkChecked(lock, original);
    assert.equal(result.removed, false);
    assert.ok(result.retainedClaim);
    assert.equal(fs.readlinkSync(result.retainedClaim), "different-missing-target");
    assert.equal(fs.readFileSync(path.join(lock, "winner"), "utf8"), "preserved");
  });
});

test("dangling link recovery distinguishes a lost race from an unexpected rename failure", () => {
  withTempDir("coord-lock-dangling-errors-", (dir) => {
    const lock = path.join(dir, "state.lock");
    makeDangling(lock);
    const observed = createDirectoryLocks(realLockDeps()).inspectLockPath(lock);
    for (const code of ["ENOENT", "EEXIST", "ENOTEMPTY", "EACCES"]) {
      const failure = Object.assign(new Error("rename refused"), { code });
      const locks = createDirectoryLocks(realLockDeps({ fs: { ...fs, renameSync() { throw failure; } } }));
      if (code === "EACCES") assert.throws(() => locks.removeDanglingLinkChecked(lock, observed), (e) => e === failure);
      else assert.equal(locks.removeDanglingLinkChecked(lock, observed).removed, false);
      assert.equal(fs.readlinkSync(lock), observed.target);
    }
    let claimed;
    const ops = createDirectoryLocks(realLockDeps({ fs: { ...fs,
      renameSync(from, to) {
        if (from === lock) {
          // The claimed entry differs from the observation.
          fs.unlinkSync(lock);
          makeDangling(lock, "replacement-target");
          fs.renameSync(from, to);
          claimed = to;
          return;
        }
        // Another cleanup has already consumed the claim by restoration time.
        fs.unlinkSync(from);
        throw Object.assign(new Error("claim consumed"), { code: "ENOENT" });
      },
    } }));
    const refused = ops.removeDanglingLinkChecked(lock, observed);
    assert.equal(refused.removed, false);
    assert.equal(refused.retainedClaim, null);
    assert.ok(claimed);
    assert.equal(ops.inspectLockPath(claimed).state, "absent");
  });
});

test("staging sweep preserves an artifact referenced after discovery and refuses a vanished artifact", () => {
  withTempDir("coord-lock-staging-race-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const artifactPath = path.join(dir, ".state.lock.acquire-interrupted");
    fs.mkdirSync(artifactPath);
    fs.writeFileSync(path.join(artifactPath, "payload"), "preserved");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(artifactPath, old, old);
    const locks = createDirectoryLocks(realLockDeps());
    const [artifact] = locks.collectStagingArtifacts(lock, 60_000);
    assert.equal(artifact.path, artifactPath);
    fs.symlinkSync(artifactPath, lock);
    assert.equal(locks.removeStagingArtifactChecked(lock, artifact).removed, false);
    assert.equal(fs.readFileSync(path.join(lock, "payload"), "utf8"), "preserved");
    assert.equal(fs.readlinkSync(lock), artifactPath);
    fs.unlinkSync(lock);
    fs.rmSync(artifactPath, { recursive: true });
    assert.equal(locks.removeStagingArtifactChecked(lock, artifact).removed, false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("stale lock recovery preserves a newly live owner even when restoration fails", () => {
  for (const restorationFails of [false, true]) {
    withTempDir("coord-lock-owner-race-", (dir) => {
      const lock = path.join(dir, "state.lock");
      fs.mkdirSync(lock);
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      let claimedPath;
      let retainedPath;
      const locks = createDirectoryLocks(realLockDeps({
        fs: { ...fs, renameSync(from, to) {
          if (to === lock && restorationFails) throw Object.assign(new Error("restore busy"), { code: "EBUSY" });
          fs.renameSync(from, to);
          if (from === lock) {
            claimedPath = to;
            fs.writeFileSync(path.join(to, "lock-owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname() }));
          }
        } },
      }));
      assert.equal(locks.tryReclaimStaleDirectoryLock(lock, 60_000, {
        onClaimRetained(value) { retainedPath = value; },
      }), false);
      const preserved = restorationFails ? claimedPath : lock;
      assert.equal(JSON.parse(fs.readFileSync(path.join(preserved, "lock-owner.json"), "utf8")).pid, process.pid);
      assert.equal(retainedPath, restorationFails ? claimedPath : undefined);
      assert.equal(fs.existsSync(lock), !restorationFails);
      assert.deepEqual(fs.readdirSync(dir), [path.basename(preserved)]);
    });
  }
});

test("lock acquisition propagates owner-record failure without leaving unpublished staging", () => {
  withTempDir("coord-lock-owner-write-failure-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const failure = Object.assign(new Error("owner record storage full"), { code: "ENOSPC" });
    const locks = createDirectoryLocks(realLockDeps({
      writeDirectoryLockMetadata(staging) {
        fs.writeFileSync(path.join(staging, "partial"), "partial owner record");
        throw failure;
      },
    }));
    assert.throws(() => locks.acquireDirectoryLock(lock, {}), (e) => e === failure);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("COORD-1052: staging sweep retains moved evidence when inspection or live-owner restoration fails", () => {
  for (const mode of ["inspection-denied", "live-owner"]) {
    withTempDir("coord1052-staging-retain-", (dir) => {
      const lock = path.join(dir, "state.lock");
      const artifactPath = path.join(dir, ".state.lock.acquire-interrupted");
      fs.mkdirSync(artifactPath);
      fs.writeFileSync(path.join(artifactPath, "payload"), "must survive recovery");
      if (mode === "live-owner") fs.writeFileSync(path.join(artifactPath, "lock-owner.json"),
        JSON.stringify({ pid: process.pid, host: os.hostname() }));
      const [artifact] = createDirectoryLocks(realLockDeps()).collectStagingArtifacts(lock, 0, Date.now() + 1000);
      let claimPath, deniedInspection = false;
      const locks = createDirectoryLocks(realLockDeps({ fs: { ...fs,
        renameSync(from, to) {
          if (to === artifactPath) throw Object.assign(new Error("restore denied"), { code: "EACCES" });
          fs.renameSync(from, to); claimPath = to;
        },
        lstatSync(at) {
          if (mode === "inspection-denied" && at === claimPath && !deniedInspection) {
            deniedInspection = true;
            throw Object.assign(new Error("claim inspection denied"), { code: "EACCES" });
          }
          return fs.lstatSync(at);
        },
      } }));
      const result = locks.removeStagingArtifactChecked(lock, artifact);
      assert.equal(result.removed, false);
      assert.match(result.reason, mode === "live-owner" ? /owner is live/ : /changed since it was observed/);
      assert.equal(fs.existsSync(artifactPath), false);
      assert.equal(fs.readFileSync(path.join(claimPath, "payload"), "utf8"), "must survive recovery");
      if (mode === "live-owner") assert.equal(JSON.parse(fs.readFileSync(path.join(claimPath, "lock-owner.json"), "utf8")).pid, process.pid);
      assert.deepEqual(fs.readdirSync(dir), [path.basename(claimPath)], "only retained evidence remains");
      assert.ok(createDirectoryLocks(realLockDeps()).collectStagingArtifacts(lock, 0, Date.now() + 1000)
        .some((entry) => entry.path === claimPath), "a later sweep can discover the retained claim");
    });
  }
});

test("COORD-1052: staging discovery tolerates unreadable parent and vanished candidates without deleting anything", () => {
  withTempDir("coord1052-staging-read-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const inaccessible = path.join(dir, ".state.lock.acquire-unreadable");
    const visible = path.join(dir, ".state.lock.acquire-visible");
    for (const at of [inaccessible, visible]) { fs.mkdirSync(at); fs.writeFileSync(path.join(at, "payload"), "retained"); }
    const denied = createDirectoryLocks(realLockDeps({ fs: { ...fs, readdirSync() {
      throw Object.assign(new Error("directory read denied"), { code: "EACCES" });
    } } }));
    assert.deepEqual(denied.collectStagingArtifacts(lock, 0), []);
    const raced = createDirectoryLocks(realLockDeps({ fs: { ...fs, lstatSync(at) {
      if (at === inaccessible) throw Object.assign(new Error("candidate vanished"), { code: "ENOENT" });
      return fs.lstatSync(at);
    } } }));
    assert.deepEqual(raced.collectStagingArtifacts(lock, 0, Date.now() + 1000).map((entry) => entry.path), [visible]);
    for (const at of [inaccessible, visible]) assert.equal(fs.readFileSync(path.join(at, "payload"), "utf8"), "retained");
  });
});

test("COORD-1052: dangling recovery retains the original link when inspection and restoration fail", () => {
  withTempDir("coord1052-dangling-inspect-", (dir) => {
    const lock = path.join(dir, "state.lock"); makeDangling(lock);
    const observed = createDirectoryLocks(realLockDeps()).inspectLockPath(lock);
    let claimPath, inspected = false;
    const locks = createDirectoryLocks(realLockDeps({ fs: { ...fs,
      renameSync(from, to) {
        if (to === lock) throw Object.assign(new Error("cannot restore link"), { code: "EBUSY" });
        fs.renameSync(from, to); claimPath = to;
      },
      lstatSync(at) {
        if (at === claimPath && !inspected) { inspected = true; throw Object.assign(new Error("cannot inspect moved link"), { code: "EACCES" }); }
        return fs.lstatSync(at);
      },
    } }));
    const result = locks.removeDanglingLinkChecked(lock, observed);
    assert.equal(result.removed, false);
    assert.equal(result.retainedClaim, claimPath);
    assert.equal(fs.readlinkSync(claimPath), observed.target);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(claimPath)]);
    const description = createDirectoryLocks(realLockDeps()).describeStateLockRecovery(claimPath, 60_000, "coord-state");
    assert.match(description, /dangling_link.*target_exists=no/);
    assert.match(description, /break-runtime-lock --kind coord-state --yes/);
  });
});

test("COORD-1052: removing a foreign lock link preserves its target and propagates unlink failure", () => {
  withTempDir("coord1052-foreign-lock-link-", (dir) => {
    const lock = path.join(dir, "state.lock"), foreign = path.join(dir, "unowned-directory");
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "payload"), "foreign data"); fs.symlinkSync(foreign, lock);
    const failure = Object.assign(new Error("unlink denied"), { code: "EACCES" });
    const failed = createDirectoryLocks(realLockDeps({ fs: { ...fs, unlinkSync() { throw failure; } } }));
    assert.throws(() => failed.removeDirectoryLock(lock), (error) => error === failure);
    assert.equal(fs.readlinkSync(lock), foreign);
    assert.equal(fs.readFileSync(path.join(foreign, "payload"), "utf8"), "foreign data");
    createDirectoryLocks(realLockDeps()).removeDirectoryLock(lock);
    assert.deepEqual(fs.readdirSync(dir), ["unowned-directory"]);
    assert.equal(fs.readFileSync(path.join(foreign, "payload"), "utf8"), "foreign data");
  });
});

test("COORD-1052: incomplete namespace identity retains owner data despite the short stale threshold", () => {
  withTempDir("coord1052-incomplete-owner-", (dir) => {
    const lock = path.join(dir, "state.lock");
    for (const [identity, local] of [
      [{ boot_id: "recorded-boot" }, {}],
      [{ pid_ns: "pid:[recorded]" }, {}],
      [{ boot_id: "recorded-boot", pid_ns: "pid:[recorded]" }, { bootId: "recorded-boot", pidNs: null }],
      [{ boot_id: "recorded-boot", pid_ns: "pid:[recorded]" }, { bootId: null, pidNs: "pid:[recorded]" }],
    ]) {
      fs.mkdirSync(lock);
      const bytes = JSON.stringify({ pid: process.pid, host: os.hostname(), ...identity });
      fs.writeFileSync(path.join(lock, "lock-owner.json"), bytes);
      fs.writeFileSync(path.join(lock, "payload"), "retain uncertain ownership\n");
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      const locks = createDirectoryLocks(realLockDeps({ readLocalIdentity: () => local }));
      assert.equal(locks.ownerVerdict(JSON.parse(bytes)), "unverifiable");
      assert.equal(locks.tryReclaimStaleDirectoryLock(lock, 60_000), false);
      assert.equal(locks.tryReclaimStaleDirectoryLock(lock, 60_000, { explicitRecovery: true }), false);
      assert.equal(fs.readFileSync(path.join(lock, "lock-owner.json"), "utf8"), bytes);
      assert.equal(fs.readFileSync(path.join(lock, "payload"), "utf8"), "retain uncertain ownership\n");
      assert.deepEqual(fs.readdirSync(dir), ["state.lock"]);
      fs.rmSync(lock, { recursive: true });
    }
  });
});


test("COORD-1052: lock inspection distinguishes ordinary files and propagates inaccessible lstat state", () => {
  withTempDir("coord1052-lock-inspection-errors-", (dir) => {
    const lock = path.join(dir, "state.lock");
    fs.writeFileSync(lock, "not a lock directory");
    const ordinary = createDirectoryLocks(realLockDeps());
    assert.equal(ordinary.inspectLockPath(lock).state, "other");
    assert.equal(fs.readFileSync(lock, "utf8"), "not a lock directory");

    const failure = Object.assign(new Error("lock metadata inaccessible"), { code: "EACCES" });
    const inaccessible = createDirectoryLocks(realLockDeps({ fs: { ...fs, lstatSync(target) {
      if (target === lock) throw failure;
      return fs.lstatSync(target);
    } } }));
    assert.throws(() => inaccessible.inspectLockPath(lock), (error) => error === failure);
    assert.equal(fs.readFileSync(lock, "utf8"), "not a lock directory", "inspection failure cannot erase or reclassify the entry");
  });
});

test("COORD-1052: failed restoration retains a replacement moved during stale lock recovery", () => {
  withTempDir("coord-lock-replacement-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const displaced = path.join(dir, "original");
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    let retained;
    const locks = createDirectoryLocks(realLockDeps({ fs: { ...fs,
      renameSync(from, to) {
        if (from === lock) {
          fs.renameSync(lock, displaced);
          fs.mkdirSync(lock);
          fs.writeFileSync(path.join(lock, "payload"), "concurrent replacement");
          return fs.renameSync(from, to);
        }
        throw Object.assign(new Error("restoration denied"), { code: "EACCES" });
      },
    } }));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lock, 60_000, {
      onClaimRetained(claim) { retained = claim; },
    }), false);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readFileSync(path.join(retained, "payload"), "utf8"), "concurrent replacement");
    assert.deepEqual(fs.readdirSync(displaced), []);
  });
});

test("COORD-1052: stale recovery removes a published lock and its owned staging directory", () => {
  withTempDir("coord-lock-stale-published-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const locks = createDirectoryLocks(realLockDeps());
    assert.equal(locks.acquireDirectoryLock(lock, { pid: deadPid(), host: os.hostname() }), true);
    const staging = fs.realpathSync(lock);
    assert.ok(fs.existsSync(staging));
    assert.equal(locks.tryReclaimStaleDirectoryLock(lock, 60_000), true);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test("COORD-1052: removing an absent or legacy directory lock is idempotent", () => {
  withTempDir("coord-lock-legacy-removal-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const neighbor = path.join(dir, "keep");
    fs.mkdirSync(lock);
    fs.writeFileSync(neighbor, "unrelated state");
    const locks = createDirectoryLocks(realLockDeps());
    locks.removeDirectoryLock(lock);
    locks.removeDirectoryLock(lock);
    assert.deepEqual(fs.readdirSync(dir), ["keep"]);
    assert.equal(fs.readFileSync(neighbor, "utf8"), "unrelated state");
  });
});

test("COORD-1052: recovery distinguishes dangling links, staging symlinks, and ordinary artifacts", () => {
  withTempDir("coord-lock-artifact-types-", (dir) => {
    const lock = path.join(dir, "state.lock");
    makeDangling(lock);
    const symlink = path.join(dir, ".state.lock.acquire-orphan");
    const file = path.join(dir, "state.lock.reclaim-interrupted");
    fs.symlinkSync("missing-target", symlink);
    fs.writeFileSync(file, "retained diagnostic");
    const locks = createDirectoryLocks(realLockDeps());
    assert.match(locks.describeDirectoryLockHolder(lock), /Current lock holder: .*dangling_link.*target_exists=no/);
    assert.deepEqual(locks.collectStagingArtifacts(lock, 0, Date.now() + 1000)
      .map(({ path: artifactPath, kind }) => [artifactPath, kind]),
    [[symlink, "symlink"], [file, "other"]]);
    assert.equal(fs.readlinkSync(symlink), "missing-target");
    assert.equal(fs.readFileSync(file, "utf8"), "retained diagnostic");
  });
});

test("unreadable lock link targets prevent deletion and keep staging in place", () => {
  withTempDir("coord-lock-unreadable-target-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const stage = path.join(dir, ".state.lock.acquire-old");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "owner-evidence"), "preserve this staging data");
    const [artifact] = createDirectoryLocks(realLockDeps()).collectStagingArtifacts(lock, 0, Date.now() + 1000);
    const ops = createDirectoryLocks(realLockDeps({ fs: { ...fs,
      readlinkSync(file) {
        if (file === lock) throw Object.assign(new Error("cannot read the lock link"), { code: "EACCES" });
        return fs.readlinkSync(file);
      },
    } }));
    fs.symlinkSync(stage, lock, "dir");
    assert.deepEqual(ops.collectStagingArtifacts(lock, 0, Date.now() + 1000), []);
    assert.equal(ops.removeStagingArtifactChecked(lock, artifact).removed, false);
    assert.equal(fs.readFileSync(path.join(lock, "owner-evidence"), "utf8"), "preserve this staging data");
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(stage), path.basename(lock)].sort());

    fs.unlinkSync(lock);
    const missing = path.join(dir, "missing");
    makeDangling(lock, missing);
    const observed = ops.inspectLockPath(lock);
    assert.equal(observed.state, "link-dangling");
    assert.equal(observed.target, null);
    assert.deepEqual(ops.removeDanglingLinkChecked(lock, observed), { removed: false, reason: "target could not be read" });
    assert.equal(fs.readlinkSync(lock), missing);
  });
});

test("directory lock publication and recovery select platform and PID fallbacks", () => {
  withTempDir("coord-lock-platform-pid-", (dir) => {
    const lock = path.join(dir, "state.lock");
    const claims = [];
    let publishedType;
    const ops = createDirectoryLocks(realLockDeps({
      process: { platform: "win32" },
      fs: { ...fs,
        symlinkSync(target, destination, type) {
          publishedType = type;
          fs.symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
        },
        renameSync(from, to) {
          fs.renameSync(from, to);
          claims.push(to);
        },
      },
    }));
    assert.equal(ops.acquireDirectoryLock(lock, { kind: "test-lock" }), true);
    assert.equal(publishedType, "junction", "the Windows adapter requests a directory junction");
    assert.equal(ops.inspectLockPath(lock).state, "link-live");
    ops.removeDirectoryLock(lock);

    makeDangling(lock, path.join(dir, "missing"));
    assert.equal(ops.removeDanglingLinkChecked(lock, ops.inspectLockPath(lock)).removed, true);
    assert.match(claims.at(-1), /reclaim-dangling-pid-/);
    const stage = path.join(dir, ".state.lock.acquire-old");
    fs.mkdirSync(stage);
    const [artifact] = ops.collectStagingArtifacts(lock, 0, Date.now() + 1000);
    assert.equal(ops.removeStagingArtifactChecked(lock, artifact).removed, true);
    assert.match(claims.at(-1), /reclaim-sweep-pid-/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
