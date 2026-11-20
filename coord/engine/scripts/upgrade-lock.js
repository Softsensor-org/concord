"use strict";
const nodePath = require("node:path");
const crypto = require("node:crypto");

// Target-local upgrade serialization extracted without changing lock or
// recovery behavior. The existing upgrade facade owns all injected effects.
module.exports = function createUpgradeLock({ fs, UPGRADE_LOCK_REL, hostname, nowMs,
  signalProcess, unverifiableLockStaleMs, writeJsonAtomicSync, writeUpgradeReceipt,
  fsyncDirectoryBestEffort, checkpoint }) {
  function upgradeLockPath(targetRoot) {
    return nodePath.join(targetRoot, UPGRADE_LOCK_REL);
  }

  function lockOwnerPath(lockDir) {
    return nodePath.join(lockDir, "owner.json");
  }

  function publicLockOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (
      value.schema !== 1 || typeof value.lock_id !== "string" || !/^[0-9a-f]{32}$/.test(value.lock_id) ||
      !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.host !== "string" || !value.host ||
      typeof value.acquired_at !== "string"
    ) return null;
    return {
      schema: 1,
      lock_id: value.lock_id,
      pid: value.pid,
      host: value.host,
      acquired_at: value.acquired_at,
    };
  }

  function readLockOwner(lockDir) {
    try {
      return publicLockOwner(JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), "utf8")));
    } catch {
      return null;
    }
  }

  function processIsAlive(pid) {
    try {
      signalProcess(pid);
      return true;
    } catch (error) {
      if (error && error.code === "ESRCH") return false;
      return true;
    }
  }

  function classifyExistingLock(lockDir) {
    const owner = readLockOwner(lockDir);
    const stat = fs.lstatSync(lockDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { stale: false, owner: null, reason: "upgrade lock path is not a real directory" };
    }
    if (owner && owner.host === hostname()) {
      if (processIsAlive(owner.pid)) return { stale: false, owner, reason: "same-host process is alive" };
      return { stale: true, owner, reason: "same-host process is no longer running" };
    }
    if (owner) return { stale: false, owner, reason: "foreign-host ownership cannot be verified safely" };
    const ageMs = Math.max(0, nowMs() - stat.mtimeMs);
    if (ageMs >= unverifiableLockStaleMs) {
      return { stale: true, owner: null, reason: `unverifiable lock metadata exceeded ${unverifiableLockStaleMs}ms` };
    }
    return { stale: false, owner: null, reason: "lock metadata is missing or invalid and has not expired" };
  }

  function releaseUpgradeLock(lock) {
    if (!lock) return { released: false };
    const owner = readLockOwner(lock.dir);
    if (!owner || owner.lock_id !== lock.owner.lock_id) {
      return { released: false, error: "upgrade lock ownership changed before release" };
    }
    fs.rmSync(lock.dir, { recursive: true, force: true });
    fsyncDirectoryBestEffort(nodePath.dirname(lock.dir));
    return { released: true };
  }

  function acquireUpgradeLock(targetRoot) {
    const dir = upgradeLockPath(targetRoot);
    fs.mkdirSync(nodePath.dirname(dir), { recursive: true, mode: 0o700 });
    let recovered = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        const owner = {
          schema: 1,
          lock_id: crypto.randomBytes(16).toString("hex"),
          pid: process.pid,
          host: hostname(),
          acquired_at: new Date(nowMs()).toISOString(),
        };
        try {
          writeJsonAtomicSync(lockOwnerPath(dir), owner, { mode: 0o600 });
          const lock = { dir, owner };
          if (recovered) {
            writeUpgradeReceipt(targetRoot, {
              schema: 1,
              outcome: "stale-lock-recovered",
              prior_holder: recovered.owner,
              recovery_reason: recovered.reason,
              recovered_by: owner,
              completed_at: new Date(nowMs()).toISOString(),
            }, `lock-recovery-${nowMs()}-${owner.lock_id}`);
            fs.rmSync(recovered.quarantine, { recursive: true, force: true });
          }
          checkpoint("after-upgrade-lock-acquired");
          return lock;
        } catch (error) {
          fs.rmSync(dir, { recursive: true, force: true });
          if (recovered && fs.existsSync(recovered.quarantine) && !fs.existsSync(dir)) {
            fs.renameSync(recovered.quarantine, dir);
          }
          throw error;
        }
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        const classification = classifyExistingLock(dir);
        if (!classification.stale) {
          const holder = classification.owner
            ? `${classification.owner.host}:${classification.owner.pid} acquired ${classification.owner.acquired_at}`
            : "unknown holder";
          throw new Error(`upgrade lock busy for target (${holder}; ${classification.reason})`);
        }
        const quarantine = `${dir}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
        try {
          fs.renameSync(dir, quarantine);
          recovered = { ...classification, quarantine };
        } catch (renameError) {
          if (renameError && renameError.code === "ENOENT") continue;
          throw renameError;
        }
      }
    }
    throw new Error("unable to acquire target upgrade lock after concurrent recovery attempts");
  }

  return { upgradeLockPath, classifyExistingLock, releaseUpgradeLock, acquireUpgradeLock };
};
