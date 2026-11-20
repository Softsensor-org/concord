"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createUpgradeLock = require("./upgrade-lock.js");

function makeFixture({ renameSync, mkdirSync } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-upgrade-lock-"));
  const lockDir = path.join(root, "coord", ".runtime", "upgrade-lock");
  const fsOps = new Proxy(fs, {
    get(target, key) {
      if (key === "renameSync" && renameSync) return renameSync;
      if (key === "mkdirSync" && mkdirSync) return mkdirSync;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const locks = createUpgradeLock({
    fs: fsOps,
    UPGRADE_LOCK_REL: "coord/.runtime/upgrade-lock",
    hostname: () => os.hostname(),
    nowMs: () => Date.now(),
    signalProcess: () => { throw Object.assign(new Error("process is gone"), { code: "ESRCH" }); },
    unverifiableLockStaleMs: 60_000,
    writeJsonAtomicSync(file, value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    },
    writeUpgradeReceipt() {},
    fsyncDirectoryBestEffort() {},
    checkpoint() {},
  });
  return { root, lockDir, locks };
}

function seedStaleOwner(lockDir) {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    schema: 1,
    lock_id: "a".repeat(32),
    pid: 999999,
    host: os.hostname(),
    acquired_at: "2026-09-30T00:00:00.000Z",
  }));
}

test("COORD-786 upgrade lock retries when a stale lock vanishes during quarantine", () => {
  let renameCalls = 0;
  const { root, lockDir, locks } = makeFixture({
    renameSync(source, destination) {
      renameCalls += 1;
      if (renameCalls === 1) {
        fs.rmSync(source, { recursive: true, force: true });
        throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
      }
      return fs.renameSync(source, destination);
    },
  });
  try {
    seedStaleOwner(lockDir);
    const lock = locks.acquireUpgradeLock(root);
    assert.equal(renameCalls, 1);
    assert.equal(fs.existsSync(path.join(lockDir, "owner.json")), true);
    assert.equal(locks.releaseUpgradeLock(lock).released, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 upgrade lock surfaces a non-ENOENT quarantine failure", () => {
  const { root, lockDir, locks } = makeFixture({
    renameSync() { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  });
  try {
    seedStaleOwner(lockDir);
    assert.throws(() => locks.acquireUpgradeLock(root), (error) => error.code === "EACCES");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 upgrade lock rejects a busy directory with unknown ownership", () => {
  const { root, lockDir, locks } = makeFixture();
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    assert.throws(() => locks.acquireUpgradeLock(root), /upgrade lock busy for target \(unknown holder;/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 upgrade lock propagates non-EEXIST directory creation failures", () => {
  let blockedPath;
  const { root, lockDir, locks } = makeFixture({
    mkdirSync(target, options) {
      if (target === blockedPath) throw Object.assign(new Error("creation refused"), { code: "EACCES" });
      return fs.mkdirSync(target, options);
    },
  });
  try {
    blockedPath = lockDir;
    assert.throws(() => locks.acquireUpgradeLock(root), (error) => error.code === "EACCES");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
