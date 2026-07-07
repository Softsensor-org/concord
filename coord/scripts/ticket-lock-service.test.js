// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, GovernanceError, runGit, createTempGitRepo } = require("./governance-test-utils.js");
const createTicketLockService = require("./ticket-lock-service.js");
const lifecycleModule = require("./lifecycle.js");

// COORD-293: behavior tests for the ticket-lock service extracted from
// lifecycle.js into ticket-lock-service.js (lifecycle decomposition slice #2,
// per the COORD-291 boundary contract). The behavior tests below were relocated
// VERBATIM from lifecycle.test.js (refreshLockHead legacy-promote + corrupt-JSON)
// and governance.test.js (ensureDoingTicketLockIntegrity doing-lock recreation) —
// they reach the same fully-wired `__testing` facade, so behavior is
// byte-identical; only the home moved to co-locate the coverage with the module
// that now owns it. The legacy-lock-path compatibility, doing-lock-integrity, and
// the live-holder / stale-lock protections are all exercised through this facade.

// --- DI wiring guard: factory shape + lifecycle composition-root wiring --------

test("COORD-293 wiring: createTicketLockService returns exactly the seven public functions", () => {
  const svc = createTicketLockService({});
  const expected = [
    "resolveLockHead",
    "safeResolveLockHead",
    "refreshLockHead",
    "shouldUseLegacyLockCompatibility",
    "existingLockDirs",
    "resolveTicketLockPath",
    "ensureDoingTicketLockIntegrity",
  ];
  assert.deepEqual(Object.keys(svc).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof svc[name], "function", `${name} must be a function`);
  }
});

test("COORD-293 wiring: lifecycle.js re-exports the extracted lock functions through the __testing facade", () => {
  // BRACKET form (COORD-280 facade-scanner safe): the facade only re-exports the
  // two lock helpers it exported before the move (refreshLockHead +
  // ensureDoingTicketLockIntegrity); the other five stay internal exactly as
  // before, so the facade surface is unchanged by this extraction.
  for (const name of ["refreshLockHead", "ensureDoingTicketLockIntegrity"]) {
    assert.equal(typeof lifecycleModule.__testing[name], "function", `lifecycle __testing[${name}] resolves`);
  }
});

// --- legacy-lock-path compatibility (relocated from lifecycle.test.js) ----------

test("refreshLockHead promotes a legacy lock into runtime before rewriting it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-lock-"));
  const runtimeLocksDir = path.join(tempDir, ".runtime", "locks");
  const legacyLocksDir = path.join(tempDir, "locks");
  const runtimeLockPath = path.join(runtimeLocksDir, "IMP-311.lock");
  const legacyLockPath = path.join(legacyLocksDir, "IMP-311.lock");
  const original = {
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
  };

  fs.mkdirSync(legacyLocksDir, { recursive: true });
  fs.writeFileSync(legacyLockPath, JSON.stringify({
    owner: "codexa00",
    ticket: "IMP-311",
    status: "doing",
    repo: "coord",
    branch: "agent/codexa00-imp-311-runtime",
    head: "stale-head",
    worktree: path.join(tempDir, "coord-worktree"),
    started_at_utc: "2026-03-29T12:00:00.000Z",
    heartbeat_utc: "2026-03-29T12:00:00.000Z",
  }, null, 2), "utf8");

  __testing.paths.LOCKS_DIR = runtimeLocksDir;
  __testing.paths.LEGACY_LOCKS_DIR = legacyLocksDir;

  try {
    __testing.refreshLockHead("IMP-311");
    assert.equal(fs.existsSync(runtimeLockPath), true);
    assert.equal(fs.existsSync(legacyLockPath), false);
    assert.equal(JSON.parse(fs.readFileSync(runtimeLockPath, "utf8")).head, "coord-no-git-head");
  } finally {
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
  }
});

test("refreshLockHead fails explicitly when the governed lock JSON is corrupted", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-corrupt-lock-"));
  const locksDir = path.join(tempDir, "locks");
  const original = {
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
  };

  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, "IMP-311.lock"), "{not json}\n", "utf8");

  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "legacy-locks");

  try {
    assert.throws(
      () => __testing.refreshLockHead("IMP-311"),
      (error) => error instanceof GovernanceError && /not valid JSON/i.test(error.message)
    );
  } finally {
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
  }
});

// --- doing-lock integrity: live-holder + recreate (relocated from governance.test.js)

test("ensureDoingTicketLockIntegrity recreates a missing doing lock from the canonical worktree", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-recreate-doing-lock-"));
  const repo = createTempGitRepo("ebmr-governance-doing-lock-repo-", {
    "README.md": "lock recreation fixture\n",
  });
  const ticketId = "IMP-997";
  const worktree = path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId);
  runGit(repo.repoRoot, ["worktree", "add", "-b", "agent/codexa04-imp-997-fix", worktree, "HEAD"]);

  const boardPath = path.join(tempDir, "tasks.json");
  const locksDir = path.join(tempDir, "locks");
  const legacyLocksDir = path.join(tempDir, "legacy-locks");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(legacyLocksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{
      heading: "Backend",
      rows: [{
        ID: ticketId,
        Repo: "B",
        Status: "doing",
        Owner: "codexa04",
        Description: "Repair lost lock",
        "Depends On": "",
      }],
    }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-current",
      agent_id: "a04",
      handle: "codexa04",
      board_path: boardPath,
      thread_id: "codex-thread-recover-lock",
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: "active",
    },
  ], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = legacyLocksDir;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.REPO_ROOTS = {
    ...__testing.paths.REPO_ROOTS,
    B: repo.repoRoot,
  };
  process.env.CODEX_THREAD_ID = "codex-thread-recover-lock";
  delete process.env.AGENT_THREAD_ID;

  try {
    const row = {
      ID: ticketId,
      Repo: "B",
      Status: "doing",
      Owner: "codexa04",
      Description: "Repair lost lock",
    };
    const lock = __testing.ensureDoingTicketLockIntegrity(ticketId, row, {});
    assert.equal(lock.owner, "codexa04");
    assert.equal(lock.branch, "agent/codexa04-imp-997-fix");
    assert.equal(lock.worktree, worktree);
    assert.equal(lock.session_id, "a04-current");
    assert.equal(fs.existsSync(path.join(locksDir, `${ticketId}.lock`)), true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
