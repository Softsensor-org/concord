"use strict";

const path = require("path");
const { createCoordPaths } = require("../paths.js");
const fs = require("fs");

const SCRIPTS_DIR = __dirname;
const COORD_DIR = path.dirname(SCRIPTS_DIR);
const ROOT_DIR = path.dirname(COORD_DIR);
const DEFAULT_PATHS = createCoordPaths({ coordDir: COORD_DIR, rootDir: ROOT_DIR });
const AGENT_STATE_LOCK_DIR = DEFAULT_PATHS.agentStateLockDir;
const COORD_STATE_LOCK_DIR = DEFAULT_PATHS.coordStateLockDir;
const AGENT_STATE_LOCK_TIMEOUT_MS = 5000;
const AGENT_STATE_LOCK_STALE_MS = 60 * 1000;
const COORD_STATE_LOCK_TIMEOUT_MS = 5000;
const COORD_STATE_LOCK_STALE_MS = 60 * 1000;
const GOVERNANCE_EVENT_LOCK_TIMEOUT_MS = 30 * 1000;
const GOVERNANCE_EVENT_LOCK_STALE_MS = 2 * 60 * 1000;

class GovernanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "GovernanceError";
  }
}

const state = {
  BOARD_PATH: DEFAULT_PATHS.boardPath,
  PLAN_RECORDS_DIR: DEFAULT_PATHS.planRecordsDir,
  LEGACY_PLAN_RECORDS_DIR: DEFAULT_PATHS.legacyPlanRecordsDir,
  LOCKS_DIR: DEFAULT_PATHS.locksDir,
  LEGACY_LOCKS_DIR: DEFAULT_PATHS.legacyLocksDir,
  PLAN_PATH: DEFAULT_PATHS.planPath,
  QUESTIONS_PATH: DEFAULT_PATHS.questionsPath,
  TEMPLATE_FEEDBACK_PATH: path.join(COORD_DIR, "TEMPLATE_FEEDBACK.md"),
  AGENTS_PATH: DEFAULT_PATHS.agentsPath,
  LEGACY_AGENTS_PATH: DEFAULT_PATHS.legacyAgentsPath,
  AGENT_SESSIONS_PATH: DEFAULT_PATHS.agentSessionsPath,
  LEGACY_AGENT_SESSIONS_PATH: DEFAULT_PATHS.legacyAgentSessionsPath,
  RUNTIME_DIR: DEFAULT_PATHS.runtimeDir,
  GOVERNANCE_EVENT_LOG_PATH: DEFAULT_PATHS.governanceEventLogPath,
  GOVERNANCE_SNAPSHOT_PATH: DEFAULT_PATHS.governanceSnapshotPath,
  GOVERNANCE_SNAPSHOTS_DIR: DEFAULT_PATHS.governanceSnapshotsDir,
  GOVERNANCE_EVENT_LOCK_DIR: DEFAULT_PATHS.governanceEventLockDir,
  MODEL_PRICES_PATH: path.join(COORD_DIR, "product", "model-prices.json"),
  TIER_POLICY_PATH_OVERRIDE: null,
  agentStateLockDepth: 0,
  coordStateLockDepth: 0,
  governanceEventLockDepth: 0,
  activeGovernanceMutationContext: null,
};

function fail(message) {
  throw new GovernanceError(message);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait. This CLI is short-lived and only uses this during brief lock contention.
  }
}

function readLockAgeMs(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

function sameFilesystemEntry(left, right) {
  if (!left || !right) {
    return false;
  }
  if (Number.isInteger(left.dev) && Number.isInteger(left.ino) && Number.isInteger(right.dev) && Number.isInteger(right.ino)) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return Math.abs((left.mtimeMs || 0) - (right.mtimeMs || 0)) < 1;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH");
  }
}

function directoryLockMetadataPath(lockPath) {
  return path.join(lockPath, "lock-owner.json");
}

function writeDirectoryLockMetadata(lockPath, metadata = {}) {
  fs.writeFileSync(
    directoryLockMetadataPath(lockPath),
    JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      created_at: new Date().toISOString(),
      ...metadata,
    }, null, 2) + "\n",
    "utf8"
  );
}

function readDirectoryLockMetadata(lockPath) {
  try {
    const raw = fs.readFileSync(directoryLockMetadataPath(lockPath), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function tryReclaimStaleDirectoryLock(lockPath, staleMs) {
  let observed;
  try {
    observed = fs.statSync(lockPath);
  } catch {
    return false;
  }
  const metadata = readDirectoryLockMetadata(lockPath);
  const staleByAge = Date.now() - observed.mtimeMs > staleMs;
  const staleByDeadOwner = Number.isInteger(metadata?.pid) && !isProcessAlive(metadata.pid);
  if (!staleByAge && !staleByDeadOwner) {
    return false;
  }

  const claimPath = `${lockPath}.reclaim-${process.pid || "pid"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }

  try {
    const claimed = fs.statSync(claimPath);
    if (!sameFilesystemEntry(observed, claimed)) {
      try {
        if (!fs.existsSync(lockPath)) {
          fs.renameSync(claimPath, lockPath);
        }
      } catch {
        // Leave the moved directory in place for explicit repair rather than deleting a potentially fresh lock.
      }
      return false;
    }
    fs.rmSync(claimPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (fs.existsSync(claimPath)) {
      throw error;
    }
    return false;
  }
}

function describeDirectoryLockHolder(lockPath) {
  const metadata = readDirectoryLockMetadata(lockPath);
  const ageMs = readLockAgeMs(lockPath);
  if (!metadata && ageMs === null) {
    return "";
  }
  const parts = [];
  if (metadata?.kind) {
    parts.push(`holder kind=${metadata.kind}`);
  }
  if (Number.isInteger(metadata?.pid)) {
    parts.push(`pid=${metadata.pid}`);
    parts.push(isProcessAlive(metadata.pid) ? "owner_alive=yes" : "owner_alive=no");
  }
  if (metadata?.cwd) {
    parts.push(`cwd=${metadata.cwd}`);
  }
  if (Number.isFinite(ageMs)) {
    parts.push(`age_ms=${Math.max(0, Math.round(ageMs))}`);
  }
  return parts.length > 0 ? `Current lock holder: ${parts.join(" ")}` : "";
}

function withAgentStateLock(fn) {
  if (state.agentStateLockDepth > 0) {
    state.agentStateLockDepth += 1;
    try {
      return fn();
    } finally {
      state.agentStateLockDepth -= 1;
    }
  }

  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(AGENT_STATE_LOCK_DIR);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(AGENT_STATE_LOCK_DIR, AGENT_STATE_LOCK_STALE_MS)) {
        continue;
      }
      if (Date.now() - startedAt > AGENT_STATE_LOCK_TIMEOUT_MS) {
        fail(`Timed out waiting for agent state lock at ${AGENT_STATE_LOCK_DIR}.`);
      }
      sleepSync(50);
    }
  }

  state.agentStateLockDepth = 1;
  try {
    return fn();
  } finally {
    state.agentStateLockDepth = 0;
    fs.rmSync(AGENT_STATE_LOCK_DIR, { recursive: true, force: true });
  }
}

function withCoordStateLock(fn) {
  if (state.coordStateLockDepth > 0) {
    state.coordStateLockDepth += 1;
    try {
      return fn();
    } finally {
      state.coordStateLockDepth -= 1;
    }
  }

  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(COORD_STATE_LOCK_DIR);
      writeDirectoryLockMetadata(COORD_STATE_LOCK_DIR, { kind: "coord-state" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(COORD_STATE_LOCK_DIR, COORD_STATE_LOCK_STALE_MS)) {
        continue;
      }
      if (Date.now() - startedAt > COORD_STATE_LOCK_TIMEOUT_MS) {
        fail(`Timed out waiting for coord state lock at ${COORD_STATE_LOCK_DIR}.`);
      }
      sleepSync(50);
    }
  }

  state.coordStateLockDepth = 1;
  try {
    return fn();
  } finally {
    state.coordStateLockDepth = 0;
    fs.rmSync(COORD_STATE_LOCK_DIR, { recursive: true, force: true });
  }
}

function withGovernanceRuntimeLock(fn) {
  if (state.governanceEventLockDepth > 0) {
    state.governanceEventLockDepth += 1;
    try {
      return fn();
    } finally {
      state.governanceEventLockDepth -= 1;
    }
  }

  fs.mkdirSync(state.RUNTIME_DIR, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(state.GOVERNANCE_EVENT_LOCK_DIR);
      writeDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR, { kind: "governance-runtime" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (tryReclaimStaleDirectoryLock(state.GOVERNANCE_EVENT_LOCK_DIR, GOVERNANCE_EVENT_LOCK_STALE_MS)) {
        continue;
      }
      if (Date.now() - startedAt > GOVERNANCE_EVENT_LOCK_TIMEOUT_MS) {
        const holder = describeDirectoryLockHolder(state.GOVERNANCE_EVENT_LOCK_DIR);
        fail(
          `Timed out waiting for governance runtime lock at ${state.GOVERNANCE_EVENT_LOCK_DIR}.` +
          (holder ? ` ${holder}` : "") +
          ` Recovery: run "coord/scripts/gov break-runtime-lock --yes" to remove a stale lock, or manually "rm -rf ${state.GOVERNANCE_EVENT_LOCK_DIR}".`
        );
      }
      sleepSync(50);
    }
  }

  state.governanceEventLockDepth = 1;
  try {
    return fn();
  } finally {
    state.governanceEventLockDepth = 0;
    fs.rmSync(state.GOVERNANCE_EVENT_LOCK_DIR, { recursive: true, force: true });
  }
}

module.exports = {
  SCRIPTS_DIR,
  COORD_DIR,
  ROOT_DIR,
  DEFAULT_PATHS,
  GovernanceError,
  // COORD-072: canonical DI failure thunk. DI-factory modules do
  // `const fail = deps.fail || defaultFail;` instead of inlining the
  // `(m) => { throw new GovernanceError(m); }` thunk.
  defaultFail: fail,
  state,
  readLockAgeMs,
  isProcessAlive,
  tryReclaimStaleDirectoryLock,
  describeDirectoryLockHolder,
  directoryLockMetadataPath,
  writeDirectoryLockMetadata,
  readDirectoryLockMetadata,
  withAgentStateLock,
  withCoordStateLock,
  withGovernanceRuntimeLock,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
};
