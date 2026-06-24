const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  executeCommand,
  __testing,
  withJournalSandbox,
  withGovernedSurfaceSandbox,
  withCleanRuntimeFixture,
} = require("./governance-test-utils.js");

// COORD-090: local helper for the relocated crash-recovery tests below.
function seedCheckpointEvent() {
  __testing.appendGovernanceEvent({
    ts: "2026-06-10T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "test" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

test("COORD-033: writeFileAtomicSync replaces the target and leaves no temp files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord032-atomic-"));
  const target = path.join(tempDir, "nested", "state.json");
  __testing.writeFileAtomicSync(target, "first\n");
  assert.equal(fs.readFileSync(target, "utf8"), "first\n");
  __testing.writeFileAtomicSync(target, "second\n");
  assert.equal(fs.readFileSync(target, "utf8"), "second\n");
  const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("COORD-033: readGovernanceEventLog tolerates exactly one torn trailing line", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `${good}\n{"ts":"2026-06-10T00:01:00.000Z","command":"sta`, "utf8");
    const events = __testing.readGovernanceEventLog();
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "claim");
  });
});

test("COORD-033: readGovernanceEventLog still fails closed on mid-file corruption", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `not-json-mid-file\n${good}\n`, "utf8");
    assert.throws(() => __testing.readGovernanceEventLog(), GovernanceError);
  });
});

test("COORD-033: readLatestGovernanceEvent falls back past a torn tail", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `${good}\n{"torn`, "utf8");
    const latest = __testing.readLatestGovernanceEvent();
    assert.equal(latest.command, "claim");
  });
});

test("COORD-033: appendGovernanceEvent repairs a torn tail and journals the repair", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `${good}\n{"ts":"2026-06-10T00:01:00.000Z","comm`, "utf8");
    __testing.appendGovernanceEvent({
      ts: "2026-06-10T00:02:00.000Z",
      command: "start",
      ticket: "T-1",
      before_status: null,
      after_status: null,
      identity: null,
      changed_paths: [],
    });
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed[0].command, "claim");
    assert.equal(parsed[1].command, "journal-tail-repair");
    assert.match(parsed[1].details.discarded_fragment, /comm/);
    assert.equal(parsed[2].command, "start");
  });
});


// ---------------------------------------------------------------------------
// COORD-090: relocated from governance.test.js (journal module behavior:
// provenance drift, governed mutation/rollback, snapshots, drift-note
// retirement, crash recovery)
// ---------------------------------------------------------------------------

test("COORD-068: gitIgnoredDriftPaths drops gitignored runtime ledgers but keeps tracked governance artifacts", () => {
  const runCheckIgnore = (candidates) => ({
    status: 0,
    stdout: `${candidates.filter((entry) => entry.startsWith(".runtime/")).join("\n")}\n`,
    stderr: "",
  });

  const ignored = __testing.gitIgnoredDriftPaths(
    [".runtime/agent_sessions.json", ".runtime/session-threads/a44.json", "board/tasks.json"],
    runCheckIgnore
  );

  // (a) gitignored runtime ledgers are excluded from the drift report.
  assert.equal(ignored.has(".runtime/agent_sessions.json"), true);
  assert.equal(ignored.has(".runtime/session-threads/a44.json"), true);
  // (b) tracked governance artifacts are NOT excluded — drift on them still surfaces.
  assert.equal(ignored.has("board/tasks.json"), false);
});

test("COORD-068: gitIgnoredDriftPaths falls back to the runtime-ledger heuristic when git is unavailable", () => {
  // A non-zero, non-1 exit (e.g. 128 = not a work tree, or a spawn error)
  // means we cannot trust check-ignore; fall back to the runtime prefix so a
  // gitignored ledger is still excluded and tracked artifacts still surface.
  const failingRunner = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
  const ignored = __testing.gitIgnoredDriftPaths(
    [".runtime/agent_sessions.json", "board/tasks.json", "PLAN.md"],
    failingRunner
  );
  assert.deepEqual([...ignored].sort(), [".runtime/agent_sessions.json"]);

  const erroringRunner = () => ({ error: new Error("spawn ENOENT") });
  const ignoredOnError = __testing.gitIgnoredDriftPaths(
    [".runtime/session-threads/a44.json", "rendered/TASKS.md"],
    erroringRunner
  );
  assert.deepEqual([...ignoredOnError].sort(), [".runtime/session-threads/a44.json"]);
});

test("detectGovernanceProvenanceDrift reports an uninitialized journal without mutating state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-journal-uninitialized-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    const drift = __testing.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, true);
    assert.equal(fs.existsSync(__testing.paths.GOVERNANCE_EVENT_LOG_PATH), false);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("detectGovernanceProvenanceDrift ignores legacy snapshots that predate QUESTIONS.md tracking", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-journal-compat-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "");
  fs.writeFileSync(questionsPath, "# Questions\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    const fileEntries = __testing.collectGovernedSnapshotFilePaths()
      .filter((filePath) => filePath !== questionsPath)
      .map((filePath) => {
        const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
        return {
          path: path.relative(path.join(__dirname, ".."), filePath).replace(/\\/g, "/"),
          exists: fs.existsSync(filePath),
          digest: crypto.createHash("sha1").update(raw).digest("hex"),
        };
      });
    const snapshot = {
      recorded_at: "2026-03-29T22:48:48.789Z",
      digest: crypto.createHash("sha1").update(JSON.stringify(fileEntries)).digest("hex"),
      files: fileEntries,
    };
    fs.writeFileSync(eventLogPath, `${JSON.stringify({
      ts: "2026-03-29T22:48:48.789Z",
      command: "seed",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      details: null,
      changed_paths: [],
      snapshot,
    })}\n`, "utf8");

    const drift = __testing.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.deepEqual(drift.drift, []);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("detectGovernanceProvenanceDrift resolves compact snapshot artifacts referenced by the latest event", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-journal-compact-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "");
  fs.writeFileSync(questionsPath, "# Questions\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    const fileEntries = __testing.collectGovernedSnapshotFilePaths().map((filePath) => {
      const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
      return {
        path: path.relative(path.join(__dirname, ".."), filePath).replace(/\\/g, "/"),
        exists: fs.existsSync(filePath),
        digest: crypto.createHash("sha1").update(raw).digest("hex"),
      };
    });
    const snapshot = {
      recorded_at: "2026-03-30T13:00:00.000Z",
      digest: crypto.createHash("sha1").update(JSON.stringify(fileEntries)).digest("hex"),
      files: fileEntries,
    };
    fs.writeFileSync(path.join(snapshotsDir, `${snapshot.digest}.json`), JSON.stringify(snapshot, null, 2), "utf8");
    fs.writeFileSync(snapshotPath, JSON.stringify({
      digest: snapshot.digest,
      recorded_at: snapshot.recorded_at,
      ts: "2026-03-30T13:00:00.000Z",
      command: "seed",
      ticket: null,
    }, null, 2), "utf8");
    fs.writeFileSync(eventLogPath, `${JSON.stringify({
      ts: "2026-03-30T13:00:00.000Z",
      command: "seed",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      result: "succeeded",
      details: null,
      changed_paths: [],
      snapshot_digest: snapshot.digest,
    })}\n`, "utf8");

    const drift = __testing.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.deepEqual(drift.drift, []);
    assert.equal(__testing.readLatestGovernanceEvent().snapshot, undefined);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("withGovernanceMutation records failed external side-effect mutations after rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-external-failure-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");

  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "baseline plan\n");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    assert.throws(
      () =>
        __testing.withGovernanceMutation({ command: "land", ticket: "IMP-999" }, () => {
          __testing.recordGovernanceExternalSideEffect({
            type: "github_pr_merge",
            pr_url: "https://github.com/example/repo/pull/9",
            method: "squash",
          });
          fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
          throw new GovernanceError("closeout failed");
        }),
      (error) => error instanceof GovernanceError && /external side effects already occurred/i.test(error.message)
    );

    const journal = fs.readFileSync(eventLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 2);
    assert.equal(journal[1].command, "land");
    assert.equal(journal[1].result, "failed");
    assert.equal(Array.isArray(journal[1].details.external_side_effects), true);
    assert.equal(journal[1].details.external_side_effects[0].type, "github_pr_merge");
    assert.equal(typeof journal[1].snapshot_digest, "string");
    assert.equal(journal[1].snapshot, undefined);
    assert.equal(fs.readFileSync(planPath, "utf8"), "baseline plan\n");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("withGovernanceMutation restores governed files when a mutation fails after writing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rollback-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "baseline plan\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    assert.throws(
      () =>
        __testing.withGovernanceMutation({ command: "test-mutation" }, () => {
          fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
          fs.writeFileSync(path.join(locksDir, "IMP-999.lock"), JSON.stringify({ ticket: "IMP-999" }, null, 2));
          throw new GovernanceError("synthetic failure");
        }),
      (error) => error instanceof GovernanceError && /synthetic failure/.test(error.message)
    );

    assert.equal(fs.readFileSync(boardPath, "utf8"), `${JSON.stringify({ sections: [] }, null, 2)}`);
    assert.equal(fs.readFileSync(planPath, "utf8"), "baseline plan\n");
    assert.equal(fs.existsSync(path.join(locksDir, "IMP-999.lock")), false);

    const journal = fs.readFileSync(__testing.paths.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].command, "journal-baseline");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("withGovernanceMutation proactively expires stale agent sessions before running the mutation body", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-expire-sessions-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  const staleSeenAt = "2026-03-29T00:00:00.000Z";
  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify([
      {
        session_id: "a00-stale",
        handle: "codexa00",
        status: "active",
        claimed_at: staleSeenAt,
        last_seen_at: staleSeenAt,
        board_path: boardPath,
        board_root: tempDir,
      },
    ], null, 2),
    "utf8"
  );

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    __testing.withGovernanceMutation({ command: "test-mutation", forceLog: true }, () => {});
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(sessions[0].status, "expired");
    assert.ok(sessions[0].released_at);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("diffGovernanceSnapshots reports created, modified, and deleted governed files", () => {
  const left = {
    files: [
      { path: ".runtime/agent_sessions.json", exists: true, digest: "alpha" },
      { path: "board/tasks.json", exists: true, digest: "beta" },
      { path: ".runtime/locks/IMP-311.lock", exists: true, digest: "gamma" },
    ],
  };
  const right = {
    files: [
      { path: ".runtime/agent_sessions.json", exists: true, digest: "alpha" },
      { path: "board/tasks.json", exists: true, digest: "delta" },
      { path: ".runtime/locks/IMP-312.lock", exists: true, digest: "epsilon" },
    ],
  };

  assert.deepEqual(__testing.diffGovernanceSnapshots(left, right), [
    ".runtime/locks/IMP-311.lock",
    ".runtime/locks/IMP-312.lock",
    "board/tasks.json",
  ]);
});

test("withGovernanceMutation records unrelated governance drift to QUESTIONS and continues", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-drift-note-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "baseline plan\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});

    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "drifted" }] }, null, 2), "utf8");

    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "submit", ticket: "IMP-311" }, () => {
        fs.writeFileSync(planPath, "mutation plan\n", "utf8");
      })
    );

    const questions = fs.readFileSync(questionsPath, "utf8");
    assert.match(questions, /Governance drift observed while running submit IMP-311:/);
    assert.match(questions, /delegated reconciliation to orchestrator/i);

    const journal = fs.readFileSync(__testing.paths.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = journal[journal.length - 1];
    assert.equal(event.command, "submit");
    assert.deepEqual(event.details.preexisting_drift, [path.relative(path.join(__dirname, ".."), boardPath).replace(/\\/g, "/")]);
    assert.equal(event.details.preexisting_drift_logged_to_questions, true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("withGovernanceMutation records QUESTIONS.md edits in changed_paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-questions-log-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "legacy-locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});

    __testing.withGovernanceMutation({ command: "log-question", forceLog: true }, () => {
      fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n\n| From | To | Question |\n", "utf8");
    });

    const journal = fs.readFileSync(eventLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = journal[journal.length - 1];
    const relativeQuestionsPath = path.relative(path.join(__dirname, ".."), questionsPath).replace(/\\/g, "/");
    assert.equal(event.command, "log-question");
    assert.equal(event.changed_paths.includes(relativeQuestionsPath), true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
  }
});

test("extractDriftSinceTimestamp parses the canonical drift-note answer", () => {
  const ts = __testing.extractDriftSinceTimestamp(
    "Detected unjournaled governed-state drift since 2026-04-14T10:00:00.000Z. Continued gov start and delegated reconciliation to orchestrator."
  );
  assert.equal(ts, "2026-04-14T10:00:00.000Z");
  assert.equal(__testing.extractDriftSinceTimestamp("unrelated"), null);
  assert.equal(
    __testing.extractDriftSinceTimestamp("Detected unjournaled governed-state drift since bogus."),
    null
  );
});

test("planStaleDriftNoteRetirement retires drift-notes whose since-ts predates the baseline and skips newer ones", () => {
  const baselineTs = "2026-04-14T12:00:00.000Z";
  const now = new Date("2026-04-14T12:30:00.000Z");
  const driftRowOld =
    "| 2026-04-14 | codexa11 | orchestrator | " +
    "Governance drift observed while running gov start GOV-100: coord/PLAN.md | " +
    "Detected unjournaled governed-state drift since 2026-04-14T09:00:00.000Z. Continued gov start and delegated reconciliation to orchestrator. | no |";
  const driftRowFresh =
    "| 2026-04-14 | codexa11 | orchestrator | " +
    "Governance drift observed while running gov heartbeat GOV-100: coord/PLAN.md | " +
    "Detected unjournaled governed-state drift since 2026-04-14T12:15:00.000Z. Continued gov heartbeat and delegated reconciliation to orchestrator. | no |";
  const driftRowResolved =
    "| 2026-04-13 | codexa11 | orchestrator | " +
    "Governance drift observed while running gov start GOV-099: coord/PLAN.md | " +
    "Detected unjournaled governed-state drift since 2026-04-13T00:00:00.000Z. Continued gov start and delegated reconciliation to orchestrator. | yes |";
  const nonDriftRow =
    "| 2026-04-14 | codexa11 | orchestrator | GOV-100 review prep question | TBD | no |";
  const questionsText = [
    "# Questions",
    "",
    "| Date | From | To | Question | Answer | Resolved |",
    "|------|------|----|----------|--------|----------|",
    driftRowOld,
    driftRowFresh,
    driftRowResolved,
    nonDriftRow,
    "",
    "## Instructions",
    "",
  ].join("\n");

  const plan = __testing.planStaleDriftNoteRetirement({
    questionsText,
    latestBaselineTs: baselineTs,
    now,
  });

  assert.equal(plan.changed, true);
  assert.equal(plan.retired.length, 1);
  assert.equal(plan.retired[0].since, "2026-04-14T09:00:00.000Z");
  assert.equal(plan.retired[0].baseline_ts, baselineTs);
  assert.ok(
    plan.skipped.some((entry) => entry.since === "2026-04-14T12:15:00.000Z" && entry.reason === "baseline-not-advanced"),
    "fresh drift row should be skipped because baseline has not advanced past it"
  );
  assert.ok(plan.text.includes(driftRowFresh), "fresh drift-note row must remain untouched");
  assert.ok(plan.text.includes(driftRowResolved), "already-resolved drift-note row must remain untouched");
  assert.ok(plan.text.includes(nonDriftRow), "non-drift rows must remain untouched");
  assert.ok(
    plan.text.includes("Retired by gov retire-stale-drift-notes"),
    "retired row must carry the audit annotation"
  );
  assert.ok(
    /\|\s*yes\s*\|\s*$/m.test(plan.text.split("\n").find((line) => line.includes("GOV-100: coord/PLAN.md") && line.includes("09:00:00"))),
    "retired row must end with resolved=yes"
  );
});

test("planStaleDriftNoteRetirement is a noop when the baseline is missing or older than every drift-note", () => {
  const driftRow =
    "| 2026-04-14 | codexa11 | orchestrator | " +
    "Governance drift observed while running gov start GOV-100: coord/PLAN.md | " +
    "Detected unjournaled governed-state drift since 2026-04-14T11:00:00.000Z. Continued gov start and delegated reconciliation to orchestrator. | no |";
  const text = ["## Instructions", "", driftRow].join("\n");

  const missingBaseline = __testing.planStaleDriftNoteRetirement({ questionsText: text, latestBaselineTs: null });
  assert.equal(missingBaseline.changed, false);
  assert.equal(missingBaseline.retired.length, 0);

  const olderBaseline = __testing.planStaleDriftNoteRetirement({
    questionsText: text,
    latestBaselineTs: "2026-04-14T10:00:00.000Z",
  });
  assert.equal(olderBaseline.changed, false);
  assert.equal(olderBaseline.retired.length, 0);
  assert.ok(olderBaseline.skipped.some((entry) => entry.reason === "baseline-not-advanced"));
});

// ---------------------------------------------------------------------------
// Phase 4 (repair-path hardening): clean-runtime / freshness / rollback-drift
// ---------------------------------------------------------------------------

test("COORD-033: crash recovery rolls back an interrupted mutation and journals it", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    seedCheckpointEvent();
    const originalBoardRaw = fs.readFileSync(boardPath, "utf8");
    const restorePoint = __testing.captureGovernanceRestorePoint();
    __testing.persistGovernanceRestorePoint(restorePoint, { command: "land", ticket: "T-9" });
    // Simulate a crash mid-mutation: the board was partially rewritten and the
    // process died before journaling.
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "broken" }] }), "utf8");
    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "restored");
    assert.equal(outcome.interruptedCommand, "land");
    assert.equal(fs.readFileSync(boardPath, "utf8"), originalBoardRaw);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const events = __testing.readGovernanceEventLog();
    const last = events[events.length - 1];
    assert.equal(last.command, "crash-rollback");
    assert.equal(last.ticket, "T-9");
    assert.equal(last.details.interrupted_command, "land");
  });
});

test("COORD-033: crash recovery discards a stale restore point when state matches the checkpoint", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    seedCheckpointEvent();
    const boardRaw = fs.readFileSync(boardPath, "utf8");
    const restorePoint = __testing.captureGovernanceRestorePoint();
    __testing.persistGovernanceRestorePoint(restorePoint, { command: "land", ticket: "T-9" });
    // No drift: the interrupted mutation never wrote (or fully committed).
    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "discarded_consistent");
    assert.equal(fs.readFileSync(boardPath, "utf8"), boardRaw);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const events = __testing.readGovernanceEventLog();
    assert.equal(events.some((event) => event.command === "crash-rollback"), false);
  });
});

test("COORD-033: crash recovery discards a torn restore point", () => {
  withGovernedSurfaceSandbox(() => {
    seedCheckpointEvent();
    fs.mkdirSync(path.dirname(__testing.governanceRestorePointPath()), { recursive: true });
    fs.writeFileSync(__testing.governanceRestorePointPath(), '{"ts":"2026-06-10T00:00:00.000Z","fil', "utf8");
    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "discarded_torn");
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
  });
});


// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


test("collectGovernedSnapshotFilePaths includes QUESTIONS.md in the governed surface", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-snapshot-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
  };

  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "locks");

  try {
    const files = __testing.collectGovernedSnapshotFilePaths();
    assert.equal(files.includes(questionsPath), true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
  }
});

// ---------------------------------------------------------------------------
// ENT-002: tamper-evident journal hash-chain (prev_event_hash linking,
// verifyGovernanceChain, doctor + gov conform detection, legacy pre-chain
// acceptance, torn-tail re-anchor). Temp-journal fixtures only.
// ---------------------------------------------------------------------------

function mkLegacyEvent(command, ts) {
  // A pre-chain (legacy) event shape: NO prev_event_hash field.
  return {
    ts,
    command,
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    result: "succeeded",
    details: null,
    changed_paths: [],
  };
}

test("ENT-002: appendGovernanceEvent links each new event via prev_event_hash", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    // First append on a fresh log anchors at genesis; subsequent events link
    // to the canonical hash of the prior stored record.
    assert.equal(events[0].prev_event_hash, "genesis");
    assert.equal(events[1].prev_event_hash, __testing.hashGovernanceEventRecord(events[0]));
    const chain = __testing.verifyGovernanceChain(events);
    assert.equal(chain.ok, true);
    assert.equal(chain.chainedCount, 2);
    assert.equal(chain.preChainCount, 0);
    assert.equal(chain.head, __testing.hashGovernanceEventRecord(events[1]));
  });
});

test("ENT-002: first chained append on a legacy log inserts an explicit anchor (non-destructive migration)", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Seed two LEGACY (pre-chain) events directly, bypassing the chained append.
    const legacy = [
      mkLegacyEvent("legacy-1", "2026-06-09T00:00:00.000Z"),
      mkLegacyEvent("legacy-2", "2026-06-09T00:01:00.000Z"),
    ];
    fs.writeFileSync(logPath, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    // The next chained append migrates: anchor first, then the new event.
    __testing.appendGovernanceEvent(mkLegacyEvent("post-migration", "2026-06-10T00:00:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    assert.equal(events.length, 4);
    assert.equal(events[0].command, "legacy-1");
    assert.equal(events[1].command, "legacy-2");
    assert.equal(events[2].command, "chain-anchor");
    assert.equal(events[2].prev_event_hash, "genesis");
    assert.equal(events[2].details.reason, "legacy-pre-chain-migration");
    assert.equal(events[3].command, "post-migration");
    assert.equal(events[3].prev_event_hash, __testing.hashGovernanceEventRecord(events[2]));
    // Legacy events are accepted-but-unverified; chain verifies clean.
    const chain = __testing.verifyGovernanceChain(events);
    assert.equal(chain.ok, true);
    assert.equal(chain.preChainCount, 2);
    assert.equal(chain.chainedCount, 2);
  });
});

test("ENT-002: pure legacy (pre-chain) journal verifies without a false tamper alarm", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const legacy = [
      mkLegacyEvent("legacy-1", "2026-06-09T00:00:00.000Z"),
      mkLegacyEvent("legacy-2", "2026-06-09T00:01:00.000Z"),
      mkLegacyEvent("legacy-3", "2026-06-09T00:02:00.000Z"),
    ];
    fs.writeFileSync(logPath, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, true);
    assert.equal(chain.preChainCount, 3);
    assert.equal(chain.chainedCount, 0);
    assert.equal(chain.head, null);
    assert.deepEqual(chain.broken, []);
  });
});

test("ENT-002: verifyGovernanceChain detects an in-place tampered chained event", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    // Tamper: flip a field of the MIDDLE event on disk (its hash now differs, so
    // the NEXT event's prev_event_hash no longer matches).
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.ticket = "INJECTED-666";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.broken.length >= 1, true);
    assert.equal(chain.broken[0].reason, "prev-hash-mismatch");
  });
});

test("ENT-002: verifyGovernanceChain detects a reordered chained event", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // Swap the last two events.
    [lines[1], lines[2]] = [lines[2], lines[1]];
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
  });
});

test("ENT-002: verifyGovernanceChain detects a dropped chained event", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // Drop the middle event; gamma's prev_event_hash now points at a missing link.
    lines.splice(1, 1);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.broken[0].reason, "prev-hash-mismatch");
  });
});

test("ENT-002: gov conform reports a pass verdict + chain head on a clean journal (read-only)", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    const before = fs.readFileSync(logPath, "utf8");
    const result = executeCommand(["conform", "--json"]);
    assert.equal(result.ok, true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "pass");
    assert.equal(typeof report.chain_head, "string");
    assert.equal(report.chained_events, 2);
    // Read-only: the journal is unchanged.
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
  });
});

test("ENT-002: gov conform fails (non-zero) on a tampered fixture journal", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.command = "TAMPERED";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const result = executeCommand(["conform"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /hash-chain verification FAILED/i);
  });
});

test("ENT-002: torn-tail repair re-anchors the chain explicitly + auditably (no false tamper)", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    // Simulate a crash mid-append: a torn (unparseable) trailing line.
    fs.appendFileSync(logPath, '{"ts":"2026-06-10T00:02:00.000Z","comm', "utf8");
    // The next append repairs the torn tail (emitting an auditable repair marker
    // that re-anchors the chain) and chains the new event off it.
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:03:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    const repair = events.find((e) => e.command === "journal-tail-repair");
    assert.ok(repair, "expected a journal-tail-repair marker");
    assert.equal(repair.details.reanchored, true);
    assert.equal(typeof repair.prev_event_hash, "string");
    // The legitimately-repaired tail verifies clean — NOT a tamper signal.
    const chain = __testing.verifyGovernanceChain(events);
    assert.equal(chain.ok, true);
  });
});

// ---------------------------------------------------------------------------
// COORD-124: guarded, auditable journal hash-chain repair
// ---------------------------------------------------------------------------

// Build a valid genesis-anchored chained journal of `count` events, then return
// the in-memory event objects so a test can deliberately cross prev-hash links
// to simulate the concurrent-append break.
function buildValidChainedEvents(count) {
  const events = [];
  let prev = __testing.CHAIN_GENESIS_PREV || "genesis";
  for (let i = 0; i < count; i += 1) {
    const record = {
      ts: `2026-06-10T00:0${i}:00.000Z`,
      command: i === 0 ? "chain-anchor" : `cmd-${i}`,
      ticket: i === 0 ? null : `T-${i}`,
      before_status: null,
      after_status: null,
      identity: null,
      result: i === 0 ? "anchored" : "succeeded",
      details: { seq: i },
      changed_paths: [],
      prev_event_hash: prev,
    };
    events.push(record);
    prev = __testing.hashGovernanceEventRecord(record);
  }
  return events;
}

function writeJournalEvents(logPath, events) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("COORD-124: repair-chain dry-run reports the break, writes nothing", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    // Simulate two concurrent appends crossing prev_event_hash at #3 and #5.
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    events[5].prev_event_hash = "cafebabe".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    const before = fs.readFileSync(logPath, "utf8");

    // Precondition: the chain is broken. (Crossing #3 + #5 also cascades #4,
    // since corrupting an event changes its hash and unlinks its successor — a
    // faithful model of the concurrent-append break.)
    const chainBefore = __testing.verifyGovernanceChain();
    assert.equal(chainBefore.ok, false);

    const result = __testing.repairGovernanceChain({ confirm: false });
    assert.equal(result.status, "dry-run");
    assert.equal(result.applied, false);
    assert.equal(result.broken_link_count, chainBefore.broken.length);
    assert.ok(result.broken_link_count >= 2);
    assert.equal(result.first_broken_index, 3);
    assert.equal(result.backup_path, null);
    // Dry-run captures claimed-vs-expected evidence per broken link.
    assert.equal(result.broken_links[0].index, 3);
    assert.equal(result.broken_links[0].claimed_prev_event_hash, events[3].prev_event_hash);
    assert.ok(result.broken_links[0].expected_prev_event_hash);

    // Nothing written.
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
    // No backup sidecar created.
    const sidecars = fs.readdirSync(path.dirname(logPath)).filter((n) => n.includes("pre-repair"));
    assert.deepEqual(sidecars, []);
  });
});

test("COORD-124: repair-chain --confirm re-links the chain so conform PASSES + records an on-chain marker", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    events[5].prev_event_hash = "cafebabe".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    const originalRaw = fs.readFileSync(logPath, "utf8");
    const brokenCount = __testing.verifyGovernanceChain().broken.length;

    const result = __testing.repairGovernanceChain({
      confirm: true,
      reason: "concurrent governed appends crossed prev_event_hash",
      ts: "2026-06-12T00:00:00.000Z",
      identity: { agent: { id: "a99", handle: "claudea99" }, session: { session_id: "a99-x" } },
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.applied, true);
    assert.equal(result.broken_link_count, brokenCount);

    // The re-linked chain now verifies clean.
    const after = __testing.readGovernanceEventLog();
    const chain = __testing.verifyGovernanceChain(after);
    assert.equal(chain.ok, true);

    // An explicit on-chain repair marker is present and captures the evidence.
    const marker = after[after.length - 1];
    assert.equal(marker.command, "chain-repair");
    assert.equal(marker.result, "repaired");
    assert.equal(marker.details.reason, "concurrent governed appends crossed prev_event_hash");
    assert.equal(marker.details.broken_link_count, brokenCount);
    assert.equal(marker.details.broken_links.length, brokenCount);
    assert.equal(marker.details.broken_links[0].index, 3);
    assert.ok(marker.details.broken_links[0].claimed_prev_event_hash);
    assert.ok(marker.details.broken_links[0].expected_prev_event_hash);
    // Actor identity recorded.
    assert.equal(marker.identity.owner, "claudea99");

    // A timestamped backup sidecar preserves the ORIGINAL broken journal.
    assert.ok(result.backup_abs_path);
    assert.equal(fs.existsSync(result.backup_abs_path), true);
    assert.equal(fs.readFileSync(result.backup_abs_path, "utf8"), originalRaw);

    // Semantic content of pre-break events is untouched (only linkage changed).
    assert.equal(after[2].details.seq, 2);
    assert.equal(after[2].command, "cmd-2");
  });
});

test("COORD-124: a chain broken WITHOUT a repair marker still FAILS conform (guard intact)", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    writeJournalEvents(logPath, events);

    // No repair was recorded — the verifier must still flag the break. A bare
    // marker cannot launder it; only a genuine re-link (which repair-chain does)
    // makes the chain valid.
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.broken.some((b) => b.index === 3), true);

    // Appending a chain-repair-SHAPED event by hand (no re-link) does NOT heal it.
    const fakeMarker = {
      ts: "2026-06-12T00:00:00.000Z",
      command: "chain-repair",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      result: "repaired",
      details: { reason: "pretend", broken_link_count: 0, broken_links: [] },
      changed_paths: [],
      prev_event_hash: __testing.hashGovernanceEventRecord(events[5]),
    };
    writeJournalEvents(logPath, [...events, fakeMarker]);
    assert.equal(__testing.verifyGovernanceChain().ok, false);
  });
});

test("COORD-124: repair-chain is a clean no-op when the chain is already valid", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(5);
    writeJournalEvents(logPath, events);
    const before = fs.readFileSync(logPath, "utf8");
    assert.equal(__testing.verifyGovernanceChain().ok, true);

    const dry = __testing.repairGovernanceChain({ confirm: false });
    assert.equal(dry.status, "already-valid");
    assert.equal(dry.applied, false);

    const applied = __testing.repairGovernanceChain({ confirm: true, reason: "nothing to do" });
    assert.equal(applied.status, "already-valid");
    assert.equal(applied.applied, false);

    // Journal untouched; no backup written.
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
    const sidecars = fs.readdirSync(path.dirname(logPath)).filter((n) => n.includes("pre-repair"));
    assert.deepEqual(sidecars, []);
  });
});

test("COORD-124: repair-chain --confirm without a reason refuses to write", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    const before = fs.readFileSync(logPath, "utf8");

    assert.throws(
      () => __testing.repairGovernanceChain({ confirm: true, reason: "   " }),
      (error) => error instanceof GovernanceError && /requires a non-empty --reason/i.test(error.message)
    );
    // Refusal leaves the journal untouched.
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
  });
});
