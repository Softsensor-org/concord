"use strict";

// COORD-931 ruling: an owner in another boot or PID namespace may be alive, so it is
// reclaimed only once the lock's own age passes this governance-scale lease, never
// by the short per-kind stale threshold (COORD-270 invariant). Runtime state locks
// are then recovered only by an explicit operator break with --yes.
const UNVERIFIABLE_OWNER_STALE_MS = 24 * 60 * 60 * 1000;

// COORD-992: boot id, PID namespace, owner identity and the start-time reader live in
// process-identity.js (the one liveness primitive).
const {
  ownerLiveness,
  readBootId,
  readOwnerIdentity,
  readPidNamespace,
  readProcStartTime,
} = require("./process-identity.js");

function createDirectoryLocks(deps = {}) {
  const {
    fs,
    path,
    os,
    process,
    readDirectoryLockMetadata,
    readLockAgeMs,
    isProcessAlive,
    sameFilesystemEntry,
    writeDirectoryLockMetadata,
    // COORD-931: namespace-independent owner identity. Both default to "unreadable"
    // so injected callers keep the legacy host+PID behaviour.
    readLocalIdentity = () => ({ bootId: readBootId(), pidNs: readPidNamespace() }),
    readProcessStartTime: readProcessStartTimeOf = readProcStartTime,
    // COORD-1003: optional readers for the zombie check; undefined reads the real /proc.
    readProcessState: readProcessStateOf,
  } = deps;

  // COORD-1003: the one owner-liveness verdict (process-identity.js) for wording and reclaim alike.
  // "dead" = gone, a zombie, or a reused pid; "live" or "unknown" (PID-only, never dead).
  function ownerLivenessOf(owner) {
    return ownerLiveness(owner.pid, owner.pid_start_time, {
      isProcessAlive,
      readProcessStartTime: readProcessStartTimeOf,
      readProcessState: readProcessStateOf,
    });
  }

  // COORD-931: classify what sits at a lock path WITHOUT following symlinks.
  // states: absent | directory | other | link-live | link-dangling
  function inspectLockPath(lockPath) {
    let stat;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "absent" };
      throw error;
    }
    const base = { linkIno: stat.ino, linkDev: stat.dev, linkMtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) {
      let target = null;
      try { target = fs.readlinkSync(lockPath); } catch { target = null; }
      let targetExists = true;
      try { fs.statSync(lockPath); } catch { targetExists = false; }
      return {
        ...base,
        state: targetExists ? "link-live" : "link-dangling",
        target,
        target_exists: targetExists,
        linkAgeMs: Date.now() - stat.mtimeMs,
      };
    }
    return { ...base, state: stat.isDirectory() ? "directory" : "other", target: null, target_exists: null };
  }

  function lockPresent(lockPath) {
    return inspectLockPath(lockPath).state !== "absent";
  }

  function acquireDirectoryLock(lockPath, metadata) {
    const parent = path.resolve(path.dirname(lockPath));
    const stagingDir = fs.mkdtempSync(path.join(parent, directoryLockStagingPrefix(lockPath)));
    try {
      // Prepare a complete owner record off-path, then publish an exclusive
      // symlink. Symlink creation is atomic and fails if any canonical path exists;
      // unlike directory rename, it cannot replace a legacy empty lock directory.
      writeDirectoryLockMetadata(stagingDir, metadata);
      fs.symlinkSync(stagingDir, lockPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY" || error?.code === "EISDIR" ||
          (error?.code === "EPERM" && lockPresent(lockPath))) {
        return false;
      }
      throw error;
    }
    return true;
  }

  function directoryLockStagingPrefix(lockPath) {
    return `.${path.basename(lockPath).replace(/^\.+/, "")}.acquire-`;
  }

  function ownedStagingTarget(lockPath, linkPath = lockPath) {
    let target;
    try {
      target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    } catch {
      return null;
    }
    const parent = path.resolve(path.dirname(lockPath));
    const prefix = directoryLockStagingPrefix(lockPath);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith(prefix)) return null;
    try {
      if (!fs.lstatSync(target).isDirectory()) return null;
    } catch {
      return null;
    }
    return target;
  }

  function removeDirectoryLock(lockPath) {
    try {
      if (fs.lstatSync(lockPath).isSymbolicLink()) {
        const target = ownedStagingTarget(lockPath);
        fs.unlinkSync(lockPath);
        if (target) fs.rmSync(target, { recursive: true, force: true });
        return;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
  }

  // COORD-931: owner liveness without trusting the PID alone. Returns one of:
  //   "foreign"       owner recorded on another host
  //   "live"          provably alive in our boot + PID namespace (or legacy: kill(pid,0))
  //   "dead"          provably dead in our boot + PID namespace (or pid reused)
  //   "unverifiable"  owner recorded in another boot/PID namespace, or identity unreadable:
  //                   possibly live, never dead; reclaimable only by the age threshold
  //   "unknown"       no owner pid recorded
  // Legacy owners with no boot_id/pid_ns keep the pre-COORD-931 host+PID rule.
  function ownerVerdict(owner) {
    const pid = Number.isInteger(owner?.pid) ? owner.pid : null;
    const host = typeof owner?.host === "string" && owner.host.length > 0 ? owner.host : null;
    if (host !== null && host !== os.hostname()) return "foreign";
    if (pid === null) return "unknown";
    const hasBoot = typeof owner.boot_id === "string";
    const hasNs = typeof owner.pid_ns === "string";
    // COORD-992 (sanctioned): a legacy record carrying a start time also rejects a reused pid.
    // Current writers record boot, namespace and start time together, so no current record changes.
    if (!hasBoot && !hasNs) {
      return ownerLivenessOf(owner) === "dead" ? "dead" : "live";
    }
    if (!hasBoot || !hasNs) return "unverifiable";
    const local = readLocalIdentity();
    if (!local.bootId || !local.pidNs) return "unverifiable";
    if (local.bootId !== owner.boot_id || local.pidNs !== owner.pid_ns) return "unverifiable";
    return ownerLivenessOf(owner) === "dead" ? "dead" : "live";
  }

  function ownerHost(owner) {
    return typeof owner?.host === "string" && owner.host.length > 0 ? owner.host : null;
  }

  function tryReclaimStaleDirectoryLock(lockPath, staleMs, options = {}) {
    let observed;
    try {
      observed = fs.lstatSync(lockPath);
    } catch {
      return false;
    }
    const metadata = readDirectoryLockMetadata(lockPath);
    // COORD-270: the lock-dir mtime is written ONCE at acquire and is never
    // refreshed during a held operation, so a governed mutation that legitimately
    // runs longer than `staleMs` (a large `gov sync` + push, or clock skew) would
    // have its still-held lock reclaimed by age alone — admitting two concurrent
    // journal appenders (the COORD-115/123 hash-chain corruption the lock exists
    // to prevent). A known local live owner must NEVER be reclaimed by age. Reclaim
    // known owners only when dead/foreign; age is only for unknown ownership.
    // COORD-931: an owner whose boot/PID namespace differs from ours is
    // "unverifiable" — never dead — and falls back to the age threshold.
    const isStaleByAge = (entry) => Date.now() - entry.mtimeMs >= staleMs;
    const isLeaseExpired = (entry) => Date.now() - entry.mtimeMs >= UNVERIFIABLE_OWNER_STALE_MS;
    // COORD-951: a mtime ahead of this host's clock is clock skew, not an age. It never
    // satisfies the automatic age rule (the negative age would never pass it anyway) and
    // is reclaimed only by explicit recovery, which is the documented operator path.
    const isFutureMtime = (entry) => Number.isFinite(entry?.mtimeMs) && entry.mtimeMs > Date.now();
    const canReclaim = (owner, entry = observed) => {
      const verdict = ownerVerdict(owner);
      if (options.explicitRecovery) {
        if (verdict === "foreign") return options.allowForeignHost === true;
        // A hostless PID may belong to another machine, so it is not authoritative in
        // explicit recovery either: it is reclaimed only by age (pre-COORD-931 rule).
        if (verdict === "dead") return ownerHost(owner) === null ? isStaleByAge(entry) : true;
        if (verdict === "live") return false;
        if (verdict === "unverifiable") return isLeaseExpired(entry);
        if (isFutureMtime(entry)) return true; // COORD-951: skew, explicit recovery only
        return isStaleByAge(entry); // unknown owner
      }
      const ownerKnown = Number.isInteger(owner?.pid);
      if (!ownerKnown) return options.requireKnownOwner ? false : isStaleByAge(entry);
      if (verdict === "foreign" || verdict === "dead") return true;
      if (verdict === "unverifiable") return isLeaseExpired(entry);
      return false; // live: never reclaimed by age
    };
    if (!canReclaim(metadata)) return false;

    const claimPath = `${lockPath}.reclaim-${process.pid || "pid"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.renameSync(lockPath, claimPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
      throw error;
    }

    try {
      const claimed = fs.lstatSync(claimPath);
      if (!sameFilesystemEntry(observed, claimed)) {
        let retainedClaim = false;
        try {
          if (!lockPresent(lockPath)) fs.renameSync(claimPath, lockPath);
          else retainedClaim = true;
        } catch {
          // Keep a moved entry for explicit repair rather than deleting a fresh lock.
          retainedClaim = lockPresent(claimPath);
        }
        if (retainedClaim) options.onClaimRetained?.(claimPath);
        return false;
      }
      if (!canReclaim(readDirectoryLockMetadata(claimPath), fs.lstatSync(claimPath))) {
        let retainedClaim = false;
        try {
          if (!lockPresent(lockPath)) fs.renameSync(claimPath, lockPath);
          else retainedClaim = true;
        } catch {
          // Keep a moved entry for explicit repair rather than deleting a fresh lock.
          retainedClaim = lockPresent(claimPath);
        }
        if (retainedClaim) options.onClaimRetained?.(claimPath);
        return false;
      }
      if (fs.lstatSync(claimPath).isSymbolicLink()) {
        const target = ownedStagingTarget(lockPath, claimPath);
        fs.unlinkSync(claimPath);
        if (target) fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.rmSync(claimPath, { recursive: true, force: true });
      }
      return true;
    } catch (error) {
      if (lockPresent(claimPath)) throw error;
      return false;
    }
  }

  // COORD-931: checked removal of a dangling lock link. The link is first moved
  // to a unique claim name (an atomic rename, so two concurrent recoveries cannot
  // both win), then its inode, device, target string and dangling state are
  // compared with the observation. Any difference restores the link and refuses.
  // Returns { removed, reason, observed, retainedClaim? }.
  function removeDanglingLinkChecked(lockPath, observed) {
    const claimPath = `${lockPath}.reclaim-dangling-${process.pid || "pid"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const changed = "the lock changed or was already removed since it was observed";
    if (typeof observed.target !== "string") return { removed: false, reason: "target could not be read" };
    try {
      fs.renameSync(lockPath, claimPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
        return { removed: false, reason: changed };
      }
      throw error;
    }
    let matches = false;
    let claimedInfo = null;
    try {
      claimedInfo = inspectLockPath(claimPath);
      matches = claimedInfo.state === "link-dangling" &&
        claimedInfo.linkIno === observed.linkIno &&
        claimedInfo.linkDev === observed.linkDev &&
        claimedInfo.target === observed.target;
    } catch {
      matches = false;
    }
    if (!matches) {
      let retainedClaim = null;
      try {
        if (!lockPresent(lockPath)) fs.renameSync(claimPath, lockPath);
        else retainedClaim = claimPath;
      } catch {
        retainedClaim = lockPresent(claimPath) ? claimPath : null;
      }
      return { removed: false, reason: changed, retainedClaim };
    }
    fs.unlinkSync(claimPath);
    return { removed: true, reason: null, observed: claimedInfo };
  }

  // COORD-931: staging artifacts (`.<lock>.acquire-*` from an interrupted acquire,
  // `<lock>.reclaim-*` from an interrupted reclaim) that no lock link references
  // and that are older than the stale threshold. Dry-run input for the sweep.
  function collectStagingArtifacts(lockPath, staleMs, now = Date.now()) {
    const parent = path.resolve(path.dirname(lockPath));
    const base = path.basename(lockPath);
    const acquirePrefix = directoryLockStagingPrefix(lockPath);
    const reclaimPrefix = `${base}.reclaim-`;
    const referenced = new Set();
    const current = inspectLockPath(lockPath);
    if (current.state === "link-live" || current.state === "link-dangling") {
      if (current.target === null) return [];
      referenced.add(path.resolve(parent, current.target));
    }
    let names = [];
    try {
      names = fs.readdirSync(parent);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      if (!name.startsWith(acquirePrefix) && !name.startsWith(reclaimPrefix)) continue;
      const full = path.join(parent, name);
      if (referenced.has(full)) continue;
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      const ageMs = now - stat.mtimeMs;
      if (ageMs < staleMs) continue;
      found.push({
        path: full,
        name,
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other",
        linkIno: stat.ino,
        linkDev: stat.dev,
        mtimeMs: stat.mtimeMs,
        age_ms: Math.max(0, Math.round(ageMs)),
      });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  // COORD-931: checked removal of one staging artifact. Same claim-then-verify
  // pattern as removeDanglingLinkChecked; the artifact must still be unreferenced
  // and be the entry that was observed.
  function removeStagingArtifactChecked(lockPath, artifact) {
    const parent = path.resolve(path.dirname(lockPath));
    const claimPath = path.join(parent, `${path.basename(lockPath)}.reclaim-sweep-${process.pid || "pid"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      fs.renameSync(artifact.path, claimPath);
    } catch {
      return { removed: false, reason: "changed or already removed" };
    }
    let stat = null;
    try { stat = fs.lstatSync(claimPath); } catch { stat = null; }
    const referencedNow = (() => {
      const current = inspectLockPath(lockPath);
      return (current.state === "link-live" || current.state === "link-dangling") &&
        (current.target === null || path.resolve(parent, current.target) === path.resolve(artifact.path));
    })();
    if (!stat || stat.ino !== artifact.linkIno || stat.dev !== artifact.linkDev || referencedNow) {
      try {
        if (!lockPresent(artifact.path)) fs.renameSync(claimPath, artifact.path);
      } catch {
        // Leave the moved entry in place; the next sweep reports it again.
      }
      return { removed: false, reason: "changed since it was observed; left in place" };
    }
    // COORD-931 R2: a retained claim whose owner is still live is never deleted.
    if (ownerVerdict(readDirectoryLockMetadata(claimPath)) === "live") {
      try {
        if (!lockPresent(artifact.path)) fs.renameSync(claimPath, artifact.path);
      } catch {
        // Keep the moved entry for explicit repair rather than deleting it.
      }
      return { removed: false, reason: "owner is live; retained for explicit repair" };
    }
    fs.rmSync(claimPath, { recursive: true, force: true });
    return { removed: true, reason: null };
  }

  function describeDanglingLink(lockPath) {
    const inspect = inspectLockPath(lockPath);
    if (inspect.state !== "link-dangling") return "";
    return `dangling_link target=${inspect.target} target_exists=no link_age_ms=${Math.max(0, Math.round(inspect.linkAgeMs))}`;
  }

  // COORD-841: undo a half-acquired lock directory (mkdir succeeded, the owner
  // record did not land). Remove it only while it is provably this attempt's:
  // no owner record or this attempt's token, AND the same directory entry mkdir
  // created (dev + ino + birth time captured right after mkdir). The identity
  // check closes the post-break race: break-runtime-lock may remove ours and
  // another process may mkdir a fresh lock before its owner record lands, and
  // that directory is not ours to delete. Residual windows, which need an atomic
  // mkdir+stat or rename-based removal to close: mkdir -> identity stat, and
  // identity check -> rmSync. Never throws: the caller rethrows its ORIGINAL
  // error, and a directory left behind is reported through `warn`.
  function releaseHalfAcquiredDirectoryLock(lockPath, { token, identity, warn }) {
    const owner = readDirectoryLockMetadata(lockPath);
    if (owner !== null && owner.token !== token) return "foreign";
    const recovery = `Recover with "coord/scripts/gov break-runtime-lock --yes" once no writer is using it.`;
    if (!identity) {
      warn(`Warning: lock directory ${lockPath} was created by a failed acquisition but could not be identified, so it was left in place. ${recovery}\n`);
      return "unproven";
    }
    let current;
    try {
      current = fs.lstatSync(lockPath);
    } catch {
      return "gone";
    }
    // A mismatch keeps the directory: it may be another writer's fresh lock. Where
    // libuv falls back to ctime for birthtime (no statx), our own directory can also
    // look replaced after a partial write, so the keep is always reported.
    if (!sameFilesystemEntry(identity, current) || identity.birthtimeMs !== current.birthtimeMs) {
      warn(`Warning: lock directory ${lockPath} no longer matches the one this failed acquisition created, so it was left in place. ${recovery}\n`);
      return "replaced";
    }
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
      return "removed";
    } catch (cleanupError) {
      warn(`Warning: cleanup of the half-acquired lock directory ${lockPath} failed (${cleanupError.message}); it is left ownerless and blocks the next acquire. ${recovery}\n`);
      return "cleanup-failed";
    }
  }

  function describeDirectoryLockHolder(lockPath, staleMs = null) {
    const dangling = describeDanglingLink(lockPath);
    if (dangling) return `Current lock holder: ${dangling}`;
    const metadata = readDirectoryLockMetadata(lockPath);
    const ageMs = readLockAgeMs(lockPath);
    if (!metadata && ageMs === null) return "";
    const parts = [];
    if (metadata?.kind) parts.push(`holder kind=${metadata.kind}`);
    // COORD-1003: a reused pid or a zombie reads as not alive; an unknown start time stays PID-only (alive).
    const ownerPid = Number.isInteger(metadata?.pid) ? metadata.pid : null;
    const ownerAlive = ownerPid !== null && ownerLivenessOf(metadata) !== "dead";
    if (ownerPid !== null) {
      parts.push(`pid=${metadata.pid}`);
      parts.push(ownerAlive ? "owner_alive=yes" : "owner_alive=no");
    }
    const ownerHost = typeof metadata?.host === "string" && metadata.host.length > 0 ? metadata.host : null;
    const ownerAliveLocally = ownerAlive && (ownerHost === null || ownerHost === os.hostname());
    if (!metadata || ownerPid === null) parts.push("ownerless=yes (owner metadata missing or unreadable)");
    if (metadata?.cwd) parts.push(`cwd=${metadata.cwd}`);
    if (Number.isFinite(ageMs)) {
      parts.push(`age_ms=${Math.max(0, Math.round(ageMs))}`);
      if (ownerAliveLocally) {
        parts.push("reclaimable=when live owner exits (not by age)");
      } else if (ageMs < 0) {
        // COORD-951: the lock's mtime is ahead of this clock, so no age can be trusted.
        parts.push("clock_skew=future-mtime");
        parts.push(`mtime_ahead_ms=${Math.round(-ageMs)}`);
        parts.push(ownerPid === null ? "reclaimable=explicit-recovery-only" : "reclaimable=now (owner is dead or on a foreign host)");
      } else if (Number.isFinite(staleMs) && ownerPid === null) {
        const remainingMs = Math.max(0, Math.ceil(staleMs - ageMs));
        parts.push(`reclaimable_in_ms=${remainingMs}`);
        parts.push(`reclaimable_at=${new Date(Date.now() + remainingMs).toISOString()}`);
      } else if (ownerPid !== null) {
        parts.push("reclaimable=now (owner is dead or on a foreign host)");
      }
    }
    return `Current lock holder: ${parts.join(" ")}`;
  }

  function describeStateLockRecovery(lockDir, staleMs, kind) {
    const dangling = describeDanglingLink(lockDir);
    if (dangling) {
      // COORD-931: a dangling link has no owner to wait for; name it and point at the checked recovery verb.
      return `${dangling}. Recovery: inspect with \`coord/scripts/gov runtime-lock-status --kind ${kind}\`; the link target is absent, so use \`coord/scripts/gov break-runtime-lock --kind ${kind} --yes\`, which re-checks the link before removing it and writes a recovery receipt.`;
    }
    const owner = readDirectoryLockMetadata(lockDir);
    const ageMs = readLockAgeMs(lockDir);
    const pid = Number.isInteger(owner?.pid) ? owner.pid : null;
    const host = typeof owner?.host === "string" && owner.host.length > 0 ? owner.host : null;
    // COORD-1003: start-time-aware owner liveness; a reused pid or a zombie is dead-local.
    const ownerDead = pid !== null && ownerLivenessOf(owner) === "dead";
    let ownerState = "ownerless";
    if (host !== null && host !== os.hostname()) ownerState = "foreign-host-unknown";
    else if (pid !== null && host === os.hostname()) ownerState = ownerDead ? "dead-local" : "live-local";
    else if (pid !== null && host === null && !ownerDead) ownerState = "live-local";
    else if (pid !== null || owner) ownerState = "unknown";
    const age = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null;
    const alive = ownerState === "live-local" ? "yes" : ownerState === "dead-local" ? "no" : "unknown";
    const ownerText = `pid=${pid ?? "unknown"} owner_alive=${alive} host=${host || "unknown"} owner_state=${ownerState} age_ms=${age ?? "unknown"}`;
    const status = `coord/scripts/gov runtime-lock-status --kind ${kind}`;
    const repair = `coord/scripts/gov break-runtime-lock --kind ${kind} --yes`;
    if (ownerState === "live-local") {
      return `${ownerText} reclaimable=when live owner exits (not by age). Recovery: inspect with \`${status}\`; wait for the live owner to finish.`;
    }
    if (ownerState === "foreign-host-unknown") {
      return `${ownerText}. Recovery: the remote owner is unknown, not presumed dead; after human-admin approval use \`${repair} --human-admin-override \"<approval reason>\"\`.`;
    }
    if (ownerState === "dead-local") return `${ownerText}. Recovery: inspect with \`${status}\`, then use \`${repair}\`.`;
    const remaining = Number.isFinite(age) ? Math.max(0, staleMs - age) : staleMs;
    return `${ownerText}. Recovery: inspect with \`${status}\`; unknown-owner locks become reclaimable in about ${remaining}ms, then use \`${repair}\`.`;
  }

  return {
    describeStateLockRecovery,
    UNVERIFIABLE_OWNER_STALE_MS,
    acquireDirectoryLock,
    collectStagingArtifacts,
    describeDanglingLink,
    describeDirectoryLockHolder,
    inspectLockPath,
    ownerVerdict,
    releaseHalfAcquiredDirectoryLock,
    removeDanglingLinkChecked,
    removeDirectoryLock,
    removeStagingArtifactChecked,
    tryReclaimStaleDirectoryLock,
  };
}

createDirectoryLocks.UNVERIFIABLE_OWNER_STALE_MS = UNVERIFIABLE_OWNER_STALE_MS;
createDirectoryLocks.readOwnerIdentity = readOwnerIdentity;
module.exports = createDirectoryLocks;
