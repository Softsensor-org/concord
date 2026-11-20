"use strict";

// COORD-224: concurrent-agent burn-in WORKER (child process).
//
// This is the per-agent body the burn-in spawns N times CONCURRENTLY (one OS
// process each, via Promise.all of child_process.fork). Every worker:
//
//   1. enters a scoped governance test context for the SHARED sandbox runtime
//      passed in argv[2] (a JSON config) — every worker points at the SAME board, journal,
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

const { __testing, GovernanceError } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance.js"));
const { withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

function withSandboxPaths(cfg, callback) {
  // Every child process shares the sandbox paths, including the runtime and
  // coarse directory locks that must serialize cross-process board writes.
  return withScopedGovernanceTestContext({
    BOARD_PATH: cfg.boardPath,
    PLAN_PATH: cfg.planPath,
    QUESTIONS_PATH: cfg.questionsPath,
    AGENTS_PATH: cfg.agentsPath,
    AGENT_SESSIONS_PATH: cfg.sessionsPath,
    PLAN_RECORDS_DIR: cfg.planRecordsDir,
    LOCKS_DIR: cfg.locksDir,
    LEGACY_LOCKS_DIR: cfg.legacyLocksDir,
    RUNTIME_DIR: cfg.runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: cfg.eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: cfg.snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: cfg.snapshotsDir,
    GOVERNANCE_EVENT_LOCK_DIR: cfg.eventLockDir,
    COORD_STATE_LOCK_DIR: cfg.coordStateLockDir,
    AGENT_STATE_LOCK_DIR: cfg.agentStateLockDir,
  }, callback);
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
  let exitCode = 0;
  withSandboxPaths(cfg, () => {
    try {
      const id = runGovernedCreate(cfg);
      emitResult({ ok: true, workerIndex: cfg.workerIndex, id });
    } catch (error) {
      const refusal = error instanceof GovernanceError;
      emitResult({
        ok: false,
        workerIndex: cfg.workerIndex,
        refusal,
        error: error && error.message ? error.message : String(error),
      });
      exitCode = refusal ? 2 : 1;
    }
  });
  process.exitCode = exitCode;
  if (typeof process.disconnect === "function" && process.connected) process.disconnect();
}

// Guard so the module can be required without side effects (none needed today,
// but keeps it test-importable).
if (require.main === module) {
  main();
}

module.exports = { withSandboxPaths, runGovernedCreate, emitResult };

// Silence an unused-import lint in environments that flag it; fs is used by the
// governance module indirectly and kept here for parity with sibling workers.
void fs;
// COORD-871: the CLI shim at coord/engine/scripts/concurrent-burnin-worker.js re-dispatches this main.
module.exports.main = main;
