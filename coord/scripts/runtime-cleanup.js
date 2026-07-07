"use strict";

// Wave 2 (COORD-057): runtime lock + scratch cleanup extracted from lifecycle.js
// — runtime lock status/break, rollback-drift detection, and clean-runtime target
// collection/removal. DI-factory; shared state/paths/lock helpers come from
// governance-context.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { gitTry } = require("./git-ops.js");
const {
  defaultFail,
  COORD_DIR,
  DEFAULT_PATHS,
  state,
  readLockAgeMs,
  isProcessAlive,
  describeDirectoryLockHolder,
  readDirectoryLockMetadata,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
} = require("./governance-context.js");

module.exports = function createRuntimeCleanup(deps = {}) {
  const fail = deps.fail || defaultFail;
  const { readGovernanceEventLog, relativeCoordPath } = deps;

  function runtimeLockStatus() {
    const exists = fs.existsSync(state.GOVERNANCE_EVENT_LOCK_DIR);
    const holder = exists ? readDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR) : null;
    const ageMs = exists ? readLockAgeMs(state.GOVERNANCE_EVENT_LOCK_DIR) : null;
    const liveLocalHolder = holderHasLiveLocalProcess(holder);
    const foreignHost = holderHasForeignHost(holder);
    const knownDeadHolder = Number.isInteger(holder?.pid) && !liveLocalHolder;
    const reclaimableNow = exists
      ? (
        foreignHost ||
        knownDeadHolder
      )
      : false;
    console.log(JSON.stringify({
      path: state.GOVERNANCE_EVENT_LOCK_DIR,
      exists,
      holder,
      description: exists ? describeDirectoryLockHolder(state.GOVERNANCE_EVENT_LOCK_DIR) : "",
      live_local_holder: liveLocalHolder,
      reclaimable_now: reclaimableNow,
    }, null, 2));
  }
  
  function breakRuntimeLock(options = {}) {
    if (!options.yes) {
      fail("break-runtime-lock is destructive; rerun with --yes.");
    }
    if (!fs.existsSync(state.GOVERNANCE_EVENT_LOCK_DIR)) {
      console.log(`No governance runtime lock exists at ${state.GOVERNANCE_EVENT_LOCK_DIR}.`);
      return;
    }
    const metadata = readDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR);
    if (holderHasLiveLocalProcess(metadata) && !options.forceLive) {
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

  function holderHasForeignHost(holder) {
    const host = typeof holder?.host === "string" && holder.host.length > 0 ? holder.host : null;
    return host !== null && host !== os.hostname();
  }

  function holderHasLiveLocalProcess(holder) {
    const pid = Number.isInteger(holder?.pid) ? holder.pid : null;
    if (pid === null) return false;
    if (holderHasForeignHost(holder)) return false;
    return isProcessAlive(pid);
  }
  
  function detectRollbackDrift() {
    const reasons = [];
    const usingDefaultCoordRuntime =
      state.BOARD_PATH === DEFAULT_PATHS.boardPath &&
      state.RUNTIME_DIR === DEFAULT_PATHS.runtimeDir &&
      state.GOVERNANCE_EVENT_LOG_PATH === DEFAULT_PATHS.governanceEventLogPath;
  
    // (1) coord local HEAD behind origin/main. Tolerate absent remote/offline.
    if (usingDefaultCoordRuntime) {
      try {
        const hasOriginMain = gitTry(
          COORD_DIR,
          ["rev-parse", "--verify", "--quiet", "origin/main"],
          { stdio: "ignore" }
        );
        if (hasOriginMain && hasOriginMain.status === 0) {
          const behind = gitTry(COORD_DIR, ["rev-list", "--count", "HEAD..origin/main"]);
          if (behind && behind.status === 0) {
            const count = Number.parseInt(String(behind.stdout || "").trim(), 10);
            if (Number.isFinite(count) && count > 0) {
              reasons.push(
                `coord is ${count} commit(s) behind origin/main; a reset/stash may discard newer state.`
              );
            }
          }
        }
      } catch {
        // git unavailable / not a repo / offline — skip silently.
      }
    }
  
    // (2) tracked board snapshot predates the latest governance journal event.
    try {
      let boardMtimeMs = null;
      if (fs.existsSync(state.BOARD_PATH)) {
        const stat = fs.statSync(state.BOARD_PATH);
        if (stat.isFile()) {
          boardMtimeMs = stat.mtimeMs;
        }
      }
      if (boardMtimeMs !== null) {
        const events = readGovernanceEventLog();
        let latestEventMs = null;
        for (const event of events) {
          const ts = event && event.ts ? Date.parse(event.ts) : NaN;
          if (Number.isFinite(ts) && (latestEventMs === null || ts > latestEventMs)) {
            latestEventMs = ts;
          }
        }
        if (latestEventMs !== null && latestEventMs > boardMtimeMs) {
          reasons.push(
            "tracked board state predates the governance journal — board may be stale; run gov recover/reconcile."
          );
        }
      }
    } catch {
      // unreadable journal/board — skip silently rather than throw.
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
  
    function isGitTracked(absPath) {
      try {
        const rel = path.relative(COORD_DIR, absPath);
        const result = gitTry(
          COORD_DIR,
          ["ls-files", "--error-unmatch", "--", rel],
          { stdio: "ignore" }
        );
        return Boolean(result) && result.status === 0;
      } catch {
        // If git can't answer, fail safe: treat as tracked (do not delete).
        return true;
      }
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
        if (isGitTracked(absPath)) {
          protectedPaths.push({ path: absPath, reason: "git-tracked (canonical)" });
          continue;
        }
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
      if (isGitTracked(absPath)) {
        protectedPaths.push({ path: absPath, reason: "git-tracked (canonical)" });
        continue;
      }
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
        "clean-runtime refused: rollback drift detected (a destructive op could discard newer state):\n" +
          drift.reasons.map((reason) => `  - ${reason}`).join("\n") +
          "\nResolve the drift (gov recover/reconcile, or sync coord) or rerun with --force to override."
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
