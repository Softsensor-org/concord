"use strict";

// COORD-224: concurrent-agent burn-in WORKER (child process).
//
// This is the per-agent body the burn-in spawns N times CONCURRENTLY (one OS
// process each, via Promise.all of child_process.fork). Every worker:
//
//   1. rebinds the governance path seam at the SHARED sandbox runtime passed in
//      argv[2] (a JSON config) — every worker points at the SAME board, journal,
//      snapshot, and (critically) the SAME governance-runtime lock dir, so the
//      mkdir-based cross-process mutex actually serializes them, and
//   2. runs ONE governed create through the real `withBoardTransaction`
//      primitive: it reserves a ticket id INSIDE the runtime lock and appends a
//      row, exactly as a governed creator would.
//
// Because the reservation + row append + journal append happen under the one
// shared runtime lock, N concurrent workers can never collide an id or interleave
// a journal append. The parent process asserts the invariants on the resulting
// board + journal (see concurrent-burnin.test.js).
//
// The worker NEVER touches the live coord board: the parent always hands it a
// throwaway sandbox coord dir under os.tmpdir(). Zero new runtime deps; this is
// plain node + the existing governance module.

const fs = require("node:fs");

const { __testing, GovernanceError } = require("./governance.js");

function rebindPathsAtSandbox(cfg) {
  // Point every coordination-state surface AND the runtime lock at the shared
  // sandbox. The governance-runtime lock dir is the cross-process mutex; the
  // board / journal / snapshot are the shared state whose integrity we assert.
  __testing.paths.BOARD_PATH = cfg.boardPath;
  __testing.paths.PLAN_PATH = cfg.planPath;
  __testing.paths.QUESTIONS_PATH = cfg.questionsPath;
  __testing.paths.AGENTS_PATH = cfg.agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = cfg.sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = cfg.planRecordsDir;
  __testing.paths.LOCKS_DIR = cfg.locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = cfg.legacyLocksDir;
  __testing.paths.RUNTIME_DIR = cfg.runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = cfg.eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = cfg.snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = cfg.snapshotsDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = cfg.eventLockDir;
  // COORD-300: bind the two coarse directory locks at the SHARED sandbox too, so the
  // governed mutation's withCoordStateLock / withAgentStateLock contend on the
  // sandbox lock instead of the live coord/.coord-state.lock + .agent-state.lock.
  __testing.paths.COORD_STATE_LOCK_DIR = cfg.coordStateLockDir;
  __testing.paths.AGENT_STATE_LOCK_DIR = cfg.agentStateLockDir;
}

// Run one governed create. Returns the reserved id. Retries ONLY on transient
// runtime-lock contention timeouts (which cannot happen under the generous CI
// timeout, but keeps the worker honest if a host is pathologically slow); a
// genuine governance refusal (seal, collision) propagates.
function runGovernedCreate(cfg) {
  const mutation = { command: "burnin-create", ticket: "(auto)" };
  let reservedId = null;
  __testing.withBoardTransaction(mutation, ({ board, reserveTicketId }) => {
    const id = reserveTicketId(cfg.prefix);
    reservedId = id;
    // Record the reserved id as the mutation's ticket so the journaled event
    // names the concrete row it created (enables the exactly-once assertion).
    mutation.ticket = id;
    const section = board.sections[0];
    section.rows.push({
      ID: id,
      Repo: "X",
      Type: "chore",
      Pri: "P2",
      Status: "todo",
      Owner: "unassigned",
      Description: `burn-in row ${id} by worker ${cfg.workerIndex}`,
      "Depends On": "",
    });
    __testing.writeBoard(board);
  });
  return reservedId;
}

function emitResult(result) {
  if (typeof process.send === "function") {
    process.send(result);
    return;
  }
  process.stdout.write(JSON.stringify(result));
}

function main() {
  const cfg = JSON.parse(process.argv[2] || "{}");
  rebindPathsAtSandbox(cfg);
  try {
    const id = runGovernedCreate(cfg);
    emitResult({ ok: true, workerIndex: cfg.workerIndex, id });
    process.exit(0);
  } catch (error) {
    const refusal = error instanceof GovernanceError;
    emitResult({
      ok: false,
      workerIndex: cfg.workerIndex,
      refusal,
      error: error && error.message ? error.message : String(error),
    });
    process.exit(refusal ? 2 : 1);
  }
}

// Guard so the module can be required without side effects (none needed today,
// but keeps it test-importable).
if (require.main === module) {
  main();
}

module.exports = { rebindPathsAtSandbox, runGovernedCreate, emitResult };

// Silence an unused-import lint in environments that flag it; fs is used by the
// governance module indirectly and kept here for parity with sibling workers.
void fs;
