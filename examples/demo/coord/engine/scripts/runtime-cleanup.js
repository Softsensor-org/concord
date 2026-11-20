"use strict";

// Wave 2 (COORD-057): runtime lock + scratch cleanup extracted from lifecycle.js
// — runtime lock status/break, rollback-drift detection, and clean-runtime target
// collection/removal. DI-factory; shared state/paths/lock helpers come from
// governance-context.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { gitTry } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const approvalVerifier = require("./approval-verifier.js");
const {
  defaultFail,
  COORD_DIR,
  DEFAULT_PATHS,
  state,
  readLockAgeMs,
  describeDirectoryLockHolder,
  readDirectoryLockMetadata,
  tryReclaimStaleDirectoryLock,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
  directoryLocks,
} = require("./governance-context.js");
const {
  collectStagingArtifacts,
  inspectLockPath,
  ownerVerdict,
  removeDanglingLinkChecked,
  removeStagingArtifactChecked,
  UNVERIFIABLE_OWNER_STALE_MS,
} = directoryLocks;

const STATE_LOCK_STALE_MS = 60 * 1000;

function remoteBehindReason(runGit, coordDir, boardBranch = DEFAULT_PATHS.boardBranch) {
  const remoteRef = `origin/${boardBranch}`; // COORD-895: the configured board branch
  try {
    const remote = runGit(coordDir, ["rev-parse", "--verify", "--quiet", remoteRef], { stdio: "ignore" });
    if (!remote || remote.status !== 0) return null;
    const behind = runGit(coordDir, ["rev-list", "--count", `HEAD..${remoteRef}`]);
    if (!behind || behind.status !== 0) return null;
    const count = Number.parseInt(String(behind.stdout || "").trim(), 10);
    return Number.isFinite(count) && count > 0
      ? `coord is ${count} commit(s) behind ${remoteRef}; a reset/stash may discard newer state.`
      : null;
  } catch {
    return null; // Absent remote or Git is not evidence of being behind.
  }
}

module.exports = function createRuntimeCleanup(deps = {}) {
  const fail = deps.fail || defaultFail;
  const runGit = deps.gitTry || gitTry;
  const { readGovernanceEventLog, relativeCoordPath, detectGovernanceProvenanceDrift } = deps;

  function selectedLock(options = {}) {
    const kind = options.kind || "governance-runtime";
    if (kind === "governance-runtime") {
      return { kind, path: state.GOVERNANCE_EVENT_LOCK_DIR, staleMs: GOVERNANCE_EVENT_LOCK_STALE_MS };
    }
    if (kind === "agent-state") {
      return { kind, path: state.AGENT_STATE_LOCK_DIR, staleMs: STATE_LOCK_STALE_MS };
    }
    if (kind === "coord-state") {
      return { kind, path: state.COORD_STATE_LOCK_DIR, staleMs: STATE_LOCK_STALE_MS };
    }
    fail(`Unsupported runtime lock kind "${kind}"; use governance-runtime, agent-state, or coord-state.`);
  }

  // COORD-931: a recovery receipt is the evidence record for a checked removal.
  // One JSON file per recovery action under <runtime>/recovery-receipts/.
  function writeRecoveryReceipt(kind, payload) {
    const dir = path.join(state.RUNTIME_DIR, "recovery-receipts");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${kind}-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ kind, created_at: new Date().toISOString(), host: os.hostname(), pid: process.pid, cwd: process.cwd(), ...payload }, null, 2)}\n`, { flag: "wx" });
    return relativeCoordPath(file);
  }

  function danglingFields(lockPath) {
    const inspect = inspectLockPath(lockPath);
    const dangling = inspect.state === "link-dangling";
    return {
      dangling,
      target: dangling ? inspect.target : null,
      target_exists: dangling ? false : null,
      link_age_ms: dangling ? Math.max(0, Math.round(inspect.linkAgeMs)) : null,
    };
  }

  function classifyStateLock(lockPath, staleMs) {
    const inspect = inspectLockPath(lockPath);
    const exists = inspect.state !== "absent";
    const dangling = inspect.state === "link-dangling";
    const holder = exists && !dangling ? readDirectoryLockMetadata(lockPath) : null;
    const ageMs = exists ? readLockAgeMs(lockPath) : null;
    const pid = Number.isInteger(holder?.pid) ? holder.pid : null;
    const host = typeof holder?.host === "string" && holder.host.length > 0 ? holder.host : null;
    let ownerState = "ownerless";
    if (dangling) {
      ownerState = "dangling";
    } else if (host !== null && host !== os.hostname()) {
      // Foreign host wins even when the PID is missing, as before COORD-931.
      ownerState = "foreign-host-unknown";
    } else if (holder) {
      const verdict = ownerVerdict(holder);
      if (verdict === "live") ownerState = "live-local";
      else if (verdict === "dead") ownerState = host === null ? "unknown" : "dead-local";
      else if (verdict === "unverifiable") ownerState = "unverifiable";
      else ownerState = "unknown";
    }
    // COORD-931: an unverifiable owner is reclaimable by age only after the lease.
    const thresholdMs = ownerState === "unverifiable" ? UNVERIFIABLE_OWNER_STALE_MS : staleMs;
    const ageReclaimable = ["ownerless", "unknown", "unverifiable", "dangling"].includes(ownerState)
      ? Number.isFinite(ageMs) && ageMs >= thresholdMs
      : false;
    return {
      exists,
      dangling,
      holder,
      ageMs,
      ownerState,
      reclaimableNow: ownerState === "dead-local" || ageReclaimable,
      requiresHumanAdminOverride: ownerState === "foreign-host-unknown",
      description: exists
        ? `owner_state=${ownerState} host=${host || "unknown"} pid=${pid ?? "unknown"} age_ms=${Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : "unknown"}${dangling ? ` target=${inspect.target} target_exists=no` : ""}`
        : "",
    };
  }

  function runtimeLockStatus(options = {}) {
    const selected = selectedLock(options);
    if (selected.kind !== "governance-runtime") {
      const status = classifyStateLock(selected.path, selected.staleMs);
      console.log(JSON.stringify({
        path: selected.path,
        kind: selected.kind,
        exists: status.exists,
        ...danglingFields(selected.path),
        holder: status.holder,
        description: status.description,
        owner_state: status.ownerState,
        age_ms: status.ageMs,
        reclaimable_now: status.reclaimableNow,
        requires_human_admin_override: status.requiresHumanAdminOverride,
        reclaimable_after_ms: ["ownerless", "unknown", "unverifiable", "dangling"].includes(status.ownerState) && Number.isFinite(status.ageMs)
          ? Math.max(0, (status.ownerState === "unverifiable" ? UNVERIFIABLE_OWNER_STALE_MS : selected.staleMs) - status.ageMs)
          : null,
      }, null, 2));
      return;
    }

    const inspect = inspectLockPath(selected.path);
    const exists = inspect.state !== "absent";
    const dangling = inspect.state === "link-dangling";
    const holder = exists && !dangling ? readDirectoryLockMetadata(selected.path) : null;
    const liveLocalHolder = holderHasLiveLocalProcess(holder);
    const foreignHost = holderHasForeignHost(holder);
    const knownDeadHolder = Number.isInteger(holder?.pid) && !liveLocalHolder;
    const reclaimableNow = exists
      ? (
        dangling ||
        foreignHost ||
        knownDeadHolder
      )
      : false;
    console.log(JSON.stringify({
      path: selected.path,
      exists,
      ...danglingFields(selected.path),
      holder,
      description: exists ? describeDirectoryLockHolder(selected.path) : "",
      live_local_holder: liveLocalHolder,
      reclaimable_now: reclaimableNow,
    }, null, 2));
  }

  function breakRuntimeLock(options = {}) {
    const selected = selectedLock(options);
    if (options.sweepStaging) return sweepStagingArtifacts(selected, options);
    const inspect = inspectLockPath(selected.path);
    if (inspect.state === "link-dangling") return breakDanglingLink(selected, options, inspect);
    if (selected.kind !== "governance-runtime") return breakStateLock(selected, options);
    if (!options.yes) {
      fail("break-runtime-lock is destructive; rerun with --yes.");
    }
    if (inspect.state === "absent") {
      console.log(`No governance runtime lock exists at ${state.GOVERNANCE_EVENT_LOCK_DIR}.`);
      return;
    }
    const metadata = readDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR);
    if (holderHasLiveLocalProcess(metadata) && !options.forceLive) {
      // guard:runtime-lock-cleanup
      fail(
        `break-runtime-lock refuses to remove a live local holder at ${state.GOVERNANCE_EVENT_LOCK_DIR}. ` +
        `Run runtime-lock-status to inspect it, wait for the operation to finish, or rerun with ` +
        `--force-live only after human-admin confirmation that the holder must be displaced.`
      );
    }
    const holder = describeDirectoryLockHolder(state.GOVERNANCE_EVENT_LOCK_DIR);
    fs.rmSync(state.GOVERNANCE_EVENT_LOCK_DIR, { recursive: true, force: true });
    console.log(JSON.stringify({
      path: state.GOVERNANCE_EVENT_LOCK_DIR,
      removed: true,
      holder: holder || null,
    }, null, 2));
  }

  // COORD-931: a dangling lock link is removed only after the observed link is
  // re-checked (inode, device, target string, still dangling) at the moment of the
  // atomic claim; any change refuses and restores the link. A receipt records the
  // observed evidence.
  function breakDanglingLink(selected, options, inspect) {
    const target = inspect.target;
    if (!options.yes) {
      fail(`break-runtime-lock is destructive; the ${selected.kind} lock at ${selected.path} is a dangling link to ${target} (target missing). Rerun for ${selected.kind} with --yes; the link is re-checked before removal.`);
    }
    const observed = {
      link_ino: inspect.linkIno,
      link_dev: inspect.linkDev,
      target,
      link_mtime_ms: inspect.linkMtimeMs,
      link_age_ms: Math.max(0, Math.round(inspect.linkAgeMs)),
    };
    const result = removeDanglingLinkChecked(selected.path, {
      linkIno: inspect.linkIno,
      linkDev: inspect.linkDev,
      target,
    });
    if (!result.removed) {
      const retained = result.retainedClaim ? ` Retained claim preserved at ${result.retainedClaim}.` : "";
      fail(`The ${selected.kind} lock at ${selected.path} ${result.reason}; refusing to remove it. Inspect again with runtime-lock-status --kind ${selected.kind}.${retained}`);
    }
    const receipt = writeRecoveryReceipt(`break-${selected.kind}`, {
      action: "removed-dangling-link",
      lock_path: relativeCoordPath(selected.path),
      observed,
      verified: "inode, device, target string and dangling state matched at removal",
    });
    console.log(JSON.stringify({
      path: selected.path,
      kind: selected.kind,
      removed: true,
      dangling: true,
      target,
      observed,
      recovery_receipt: receipt,
    }, null, 2));
  }

  // COORD-931: governed cleanup of abandoned .acquire-*/.reclaim-* artifacts.
  // Dry-run unless --yes; only unreferenced artifacts older than the stale threshold.
  function sweepStagingArtifacts(selected, options) {
    const candidates = collectStagingArtifacts(selected.path, selected.staleMs);
    const listing = candidates.map((entry) => ({
      path: relativeCoordPath(entry.path),
      kind: entry.kind,
      age_ms: entry.age_ms,
    }));
    if (!options.yes) {
      if (candidates.length === 0) console.log(`${selected.kind} staging sweep: no abandoned staging artifacts.`);
      else {
        console.log(`${selected.kind} staging sweep would remove ${candidates.length} abandoned artifact(s) (dry run; rerun with --sweep-staging --yes to delete):`);
        for (const entry of listing) console.log(`  - ${entry.path} (${entry.kind}, age_ms=${entry.age_ms})`);
      }
      const summary = { kind: selected.kind, dry_run: true, candidates: listing };
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    const removed = [];
    const skipped = [];
    for (const entry of candidates) {
      const result = removeStagingArtifactChecked(selected.path, entry);
      if (result.removed) removed.push({ path: relativeCoordPath(entry.path), kind: entry.kind, age_ms: entry.age_ms });
      else skipped.push({ path: relativeCoordPath(entry.path), reason: result.reason });
    }
    const receipt = removed.length > 0
      ? writeRecoveryReceipt(`sweep-${selected.kind}`, { action: "removed-staging-artifacts", removed, skipped })
      : null;
    const summary = { kind: selected.kind, dry_run: false, removed, skipped, recovery_receipt: receipt };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  function breakStateLock(selected, options = {}) {
    const status = classifyStateLock(selected.path, selected.staleMs);
    if (!status.exists) {
      console.log(`No ${selected.kind} lock exists at ${selected.path}.`);
      return;
    }
    if (status.ownerState === "live-local") {
      // guard:runtime-lock-cleanup
      fail(`break-runtime-lock refuses to remove the confirmed live local ${selected.kind} owner at ${selected.path}. Wait for that process to finish.`);
    }
    const override = typeof options.humanAdminOverride === "string" ? options.humanAdminOverride.trim() : "";
    const foreignOverride = status.ownerState === "foreign-host-unknown" && override.length > 0;
    if (status.ownerState === "foreign-host-unknown" && !foreignOverride) {
      fail(`The ${selected.kind} lock at ${selected.path} names foreign host ${status.holder.host}; its owner is unknown, not presumed dead. Removal requires --human-admin-override "<approval reason>" together with --yes.`);
    }
    if (!options.yes) {
      fail(`break-runtime-lock is destructive; rerun for ${selected.kind} with --yes${status.ownerState === "foreign-host-unknown" ? " and --human-admin-override \"<approval reason>\"" : ""}.`);
    }
    if (status.ownerState !== "dead-local" && status.ownerState !== "foreign-host-unknown" && !status.reclaimableNow) {
      const remaining = Number.isFinite(status.ageMs) ? Math.max(0, selected.staleMs - status.ageMs) : selected.staleMs;
      fail(`The ${selected.kind} lock at ${selected.path} has unknown ownership (${status.description}); wait ${remaining}ms for the 60s stale-owner threshold, then retry with --yes.`);
    }
    let approval = null;
    if (foreignOverride) {
      approval = approvalVerifier.requireSignedOverride({
        commandName: "break-runtime-lock", ticketId: selected.kind,
        row: { path: selected.path, kind: selected.kind, status: {
          exists: status.exists, dangling: status.dangling, holder: status.holder,
          ownerState: status.ownerState, reclaimableNow: status.reclaimableNow,
          requiresHumanAdminOverride: status.requiresHumanAdminOverride,
        } }, options,
        deps: { resolveHumanAdminOverride: deps.resolveHumanAdminOverride, fail,
          appendGovernanceEvent: deps.appendGovernanceEvent, runtimeDir: state.RUNTIME_DIR },
      }).approval;
      const fresh = classifyStateLock(selected.path, selected.staleMs);
      const stableLockFacts = (value) => ({ exists: value.exists, dangling: value.dangling, holder: value.holder || null,
        ownerState: value.ownerState, reclaimableNow: value.reclaimableNow,
        requiresHumanAdminOverride: value.requiresHumanAdminOverride });
      if (approvalVerifier.canonicalJson(stableLockFacts(fresh)) !== approvalVerifier.canonicalJson(stableLockFacts(status))) {
        fail(`break-runtime-lock: the ${selected.kind} lock changed after human approval; inspect it again and retry.`);
      }
    }
    let retainedClaimPath = null;
    const removed = tryReclaimStaleDirectoryLock(selected.path, selected.staleMs, {
      explicitRecovery: true,
      allowForeignHost: foreignOverride,
      onClaimRetained: (claimPath) => { retainedClaimPath = claimPath; },
    });
    if (!removed) {
      const latest = classifyStateLock(selected.path, selected.staleMs);
      const retained = retainedClaimPath ? ` Retained claim preserved at ${retainedClaimPath}.` : "";
      fail(`The ${selected.kind} lock at ${selected.path} changed or is not safely reclaimable (${latest.description}); inspect it again with runtime-lock-status --kind ${selected.kind}.${retained}`);
    }
    console.log(JSON.stringify({
      path: selected.path,
      kind: selected.kind,
      removed: true,
      holder: status.holder || null,
      human_admin_override: foreignOverride ? override : null,
      human_admin_session: approval?.session_id || null,
      approval_record: approval?.record_id || null,
      approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
    }, null, 2));
  }

  function holderHasForeignHost(holder) {
    const host = typeof holder?.host === "string" && holder.host.length > 0 ? holder.host : null;
    return host !== null && host !== os.hostname();
  }

  function holderHasLiveLocalProcess(holder) {
    // COORD-931: the owner verdict includes the host, boot and PID namespace.
    return ownerVerdict(holder) === "live";
  }
  
  function detectRollbackDrift() {
    const reasons = [];
    const usingDefaultCoordRuntime =
      state.BOARD_PATH === DEFAULT_PATHS.boardPath &&
      state.RUNTIME_DIR === DEFAULT_PATHS.runtimeDir &&
      state.GOVERNANCE_EVENT_LOG_PATH === DEFAULT_PATHS.governanceEventLogPath;
  
    // (1) coord local HEAD behind origin/main. Tolerate absent remote/offline.
    if (usingDefaultCoordRuntime) {
      // COORD-967: an injected board branch (tests) wins; undefined keeps the live default.
      const reason = remoteBehindReason(runGit, COORD_DIR, deps.boardBranch);
      if (reason) reasons.push(reason);
    }
  
    // (2) Compare board bytes with the latest journaled snapshot. File times
    // are checkout/clock metadata, and later plan-only events need not rewrite
    // the board. The journal's existing provenance check is the authority.
    try {
      // An empty journal has no causal baseline. Doctor's existing provenance
      // check reports that case; clean-runtime retains its bootstrap behavior.
      if (fs.existsSync(state.BOARD_PATH) && readGovernanceEventLog().length > 0) {
        const provenance = detectGovernanceProvenanceDrift();
        const boardPath = relativeCoordPath(state.BOARD_PATH);
        if (provenance.snapshotPruned && !provenance.snapshotMatchesCurrent) {
          reasons.push("board freshness unverified: the latest governance snapshot is unavailable and its digest differs from current state; inspect journal provenance before cleanup.");
        } else if (provenance.uninitialized) {
          reasons.push("board freshness unverified: no journaled snapshot baseline is available.");
        } else if (provenance.drift.includes(boardPath)) {
          reasons.push("board content differs from the latest journaled governance snapshot; inspect provenance and board progression for rollback or an out-of-band edit.");
        }
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      reasons.push(`board freshness unverified: provenance check failed (${message}); inspect the journal before cleanup.`);
    }
  
    return { drift: reasons.length > 0, reasons };
  }
  
  function collectCleanRuntimeTargets(options = {}) {
    const includeTicketState = Boolean(options.includeTicketState);
    const candidates = [];
    const protectedPaths = [];
  
    // Names directly under .runtime/ that are ALWAYS protected. plans/ and
    // locks/ are runtime-owned (Phase 2) but are ticket-local state, never
    // generated scratch — they require --include-ticket-state to be eligible.
    const alwaysProtected = new Set([
      "locks",
      "session-threads",
      "governance-snapshots",
      "governance-events.ndjson",
      "governance-latest-snapshot.json",
      "governance.lock",
      "agents.json",
      "agent_sessions.json",
    ]);
    const ticketStateProtected = new Set(["plans"]);
  
    function gitTrackingState(absPath) {
      try {
        const rel = path.relative(COORD_DIR, absPath);
        // Only Git's clean exit 1 proves this path is untracked; errors and other statuses remain unknown.
        const result = runGit(
          COORD_DIR,
          ["ls-files", "--error-unmatch", "--", rel],
          { stdio: "ignore" }
        );
        if (result && !result.error && !result.signal && result.status === 0) return "tracked";
        if (result && !result.error && !result.signal && result.status === 1) return "untracked";
      } catch {
        // Unknown tracking status must preserve data, but is not proof of tracking.
      }
      return "unknown";
    }

    function protectWhenTrackingUnknownOrPresent(absPath) {
      const tracking = gitTrackingState(absPath);
      if (tracking === "untracked") return false;
      protectedPaths.push({
        path: absPath,
        reason: tracking === "tracked" ? "git-tracked (canonical)" : "git tracking status unavailable; preserving path",
      });
      return true;
    }
  
    // Conservative allowlist of clearly-generated scratch directly under
    // .runtime/. When unsure, do NOT include it.
    function isSafeScratchName(name) {
      return (
        name === "tmp" ||
        name.startsWith("tmp") ||
        name.endsWith(".tmp") ||
        name.endsWith(".scratch") ||
        name === "scratch"
      );
    }
  
    let entries = [];
    try {
      entries = fs.existsSync(state.RUNTIME_DIR)
        ? fs.readdirSync(state.RUNTIME_DIR, { withFileTypes: true })
        : [];
    } catch {
      entries = [];
    }
  
    for (const entry of entries) {
      const name = entry.name;
      const absPath = path.join(state.RUNTIME_DIR, name);
  
      if (alwaysProtected.has(name)) {
        protectedPaths.push({ path: absPath, reason: "protected runtime state" });
        continue;
      }
      if (ticketStateProtected.has(name)) {
        if (!includeTicketState) {
          protectedPaths.push({
            path: absPath,
            reason: "ticket-local state (requires --include-ticket-state)",
          });
          continue;
        }
        // Opt-in ticket-state removal still refuses git-tracked content.
        if (protectWhenTrackingUnknownOrPresent(absPath)) continue;
        candidates.push({
          path: absPath,
          kind: entry.isDirectory() ? "dir" : "file",
          reason: "ticket-local state (opted in via --include-ticket-state)",
        });
        continue;
      }
      if (!isSafeScratchName(name)) {
        protectedPaths.push({
          path: absPath,
          reason: "not on the conservative scratch allowlist",
        });
        continue;
      }
      if (protectWhenTrackingUnknownOrPresent(absPath)) continue;
      candidates.push({
        path: absPath,
        kind: entry.isDirectory() ? "dir" : "file",
        reason: "regenerable runtime scratch",
      });
    }
  
    return { candidates, protected: protectedPaths };
  }
  
  function cleanRuntime(options = {}) {
    const drift = detectRollbackDrift();
    if (drift.drift && !options.force) {
      fail(
        "clean-runtime refused: governance freshness is unverified or rollback evidence exists:\n" +
          drift.reasons.map((reason) => `  - ${reason}`).join("\n") +
          "\nInspect the journal and board provenance before retrying; --force overrides this guard."
      );
    }
  
    const { candidates, protected: protectedPaths } = collectCleanRuntimeTargets({
      includeTicketState: Boolean(options.includeTicketState),
    });
  
    const summary = {
      command: "clean-runtime",
      runtime_dir: relativeCoordPath(state.RUNTIME_DIR),
      drift_detected: drift.drift,
      drift_reasons: drift.reasons,
      forced: Boolean(options.force),
      include_ticket_state: Boolean(options.includeTicketState),
      applied: Boolean(options.yes),
      candidates: candidates.map((candidate) => ({
        path: relativeCoordPath(candidate.path),
        kind: candidate.kind,
        reason: candidate.reason,
      })),
      removed: [],
      skipped_protected: protectedPaths.map((entry) => ({
        path: relativeCoordPath(entry.path),
        reason: entry.reason,
      })),
    };
  
    if (!options.yes) {
      if (candidates.length === 0) {
        console.log("clean-runtime: no regenerable runtime cruft found; nothing to remove.");
      } else {
        console.log(
          `clean-runtime would remove ${candidates.length} item(s) (dry run; rerun with --yes to delete):`
        );
        for (const candidate of candidates) {
          console.log(`  - ${relativeCoordPath(candidate.path)} (${candidate.reason})`);
        }
      }
      if (protectedPaths.length > 0) {
        console.log(`clean-runtime keeps ${protectedPaths.length} protected path(s) untouched.`);
      }
      console.log(JSON.stringify(summary));
      return summary;
    }
  
    for (const candidate of candidates) {
      fs.rmSync(candidate.path, { recursive: true, force: true });
      summary.removed.push({
        path: relativeCoordPath(candidate.path),
        kind: candidate.kind,
        reason: candidate.reason,
      });
      console.log(`Removed ${relativeCoordPath(candidate.path)}`);
    }
    if (summary.removed.length === 0) {
      console.log("clean-runtime: nothing to remove.");
    }
    console.log(JSON.stringify(summary));
    return summary;
  }
  return {
    runtimeLockStatus, breakRuntimeLock, detectRollbackDrift,
    collectCleanRuntimeTargets, cleanRuntime,
  };
};

module.exports.remoteBehindReason = remoteBehindReason;
