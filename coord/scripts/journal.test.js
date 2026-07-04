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
  sandboxProcessRuntimeLocks,
} = require("./governance-test-utils.js");
const { stableIdempotencyKey } = require("./idempotency.js");

// COORD-300: redirect this worker's coarse directory locks + memory to a per-process
// os.tmpdir() sandbox (the LIGHT helper — it intentionally leaves RUNTIME_DIR /
// PLAN_RECORDS_DIR alone so the per-test withJournalSandbox layers on top and the
// path-classification tests still see the real configured layout). Combined with the
// lifecycle.js resolveRuntimeDir wiring, `gov conform`'s lazily-generated
// .runtime/conformance-keys now follow the per-test RUNTIME_DIR sandbox instead of
// the live tree, letting journal.test.js leave the test-isolation-guard allowlist.
sandboxProcessRuntimeLocks();

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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
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
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");

  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
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
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "baseline plan\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(promptsDir, "tickets", "IMP-100.md"), "# baseline prompt\n", "utf8");
  fs.writeFileSync(path.join(renderedDir, "TASKS.md"), "# baseline rendered\n", "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    // COORD-273: this surface intentionally seeds existing coordination state
    // (prompt + rendered artifacts). Anchor the journal baseline explicitly so the
    // rollback mutation below runs over an INITIALIZED journal — the new
    // journal-loss-over-existing-state guard only fires on an ABSENT journal, and a
    // deliberate baseline here mirrors a healthy repo. The single baseline event is
    // exactly what the post-rollback assertions expect.
    __testing.ensureGovernanceJournalBaseline("test-seed");
    assert.throws(
      () =>
        __testing.withGovernanceMutation({ command: "test-mutation" }, () => {
          fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
          fs.writeFileSync(path.join(promptsDir, "tickets", "IMP-100.md"), "# mutated prompt\n", "utf8");
          fs.writeFileSync(path.join(promptsDir, "tickets", "IMP-999.md"), "# added prompt\n", "utf8");
          fs.writeFileSync(path.join(renderedDir, "TASKS.md"), "# mutated rendered\n", "utf8");
          fs.writeFileSync(path.join(renderedDir, "NEW.md"), "# added rendered\n", "utf8");
          fs.writeFileSync(path.join(locksDir, "IMP-999.lock"), JSON.stringify({ ticket: "IMP-999" }, null, 2));
          throw new GovernanceError("synthetic failure");
        }),
      (error) => error instanceof GovernanceError && /synthetic failure/.test(error.message)
    );

    assert.equal(fs.readFileSync(boardPath, "utf8"), `${JSON.stringify({ sections: [] }, null, 2)}`);
    assert.equal(fs.readFileSync(planPath, "utf8"), "baseline plan\n");
    assert.equal(fs.readFileSync(path.join(promptsDir, "tickets", "IMP-100.md"), "utf8"), "# baseline prompt\n");
    assert.equal(fs.existsSync(path.join(promptsDir, "tickets", "IMP-999.md")), false);
    assert.equal(fs.readFileSync(path.join(renderedDir, "TASKS.md"), "utf8"), "# baseline rendered\n");
    assert.equal(fs.existsSync(path.join(renderedDir, "NEW.md")), false);
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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  const staleSeenAt = "2026-03-29T00:00:00.000Z";
  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
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
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});

    // COORD-220: drift a NON-coordination-state surface (PLAN.md). The single-writer
    // bypass seal fails closed only on coordination-state drift (board / plan
    // records / prompts / rendered); other unjournaled governed-file drift still
    // logs a QUESTIONS note and continues, which is what this test guards.
    fs.writeFileSync(planPath, "drifted plan\n", "utf8");

    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "submit", ticket: "IMP-311" }, () => {
        fs.writeFileSync(agentsPath, JSON.stringify([{ note: "mutation" }], null, 2), "utf8");
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
    assert.deepEqual(event.details.preexisting_drift, [path.relative(path.join(__dirname, ".."), planPath).replace(/\\/g, "/")]);
    assert.equal(event.details.preexisting_drift_logged_to_questions, true);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
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
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
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
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
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
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
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

// ---------------------------------------------------------------------------
// COORD-274: repair-chain must be RE-LINK ONLY — it must never launder a content
// edit (altered / removed event body) into a chain that then passes verify.
// ---------------------------------------------------------------------------

test("COORD-274: repair-chain REFUSES to launder an in-place content edit (re-link-only)", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    writeJournalEvents(logPath, events);
    // Sanity: the freshly-built chain is valid.
    assert.equal(__testing.verifyGovernanceChain().ok, true);

    // ATTACK: edit the BODY of a non-tip event in place, leaving its prev_event_hash
    // untouched. This breaks exactly the NEXT link (its successor's prev no longer
    // matches the edited record) while the rest of the chain stays self-consistent.
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[2]);
    tampered.ticket = "INJECTED-666";
    tampered.details = { seq: 2, smuggled: "payload" };
    lines[2] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    const brokenBefore = __testing.verifyGovernanceChain();
    assert.equal(brokenBefore.ok, false);
    const rawBefore = fs.readFileSync(logPath, "utf8");

    // Previously this re-linked the altered event into a chain that passed verify.
    // Now it must REFUSE with a clear content-changed error.
    assert.throws(
      () =>
        __testing.repairGovernanceChain({
          confirm: true,
          reason: "attempt to launder a tampered body",
          ts: "2026-06-12T01:00:00.000Z",
        }),
      (error) =>
        error instanceof GovernanceError && /re-link-ONLY|CONTENT changed/i.test(error.message)
    );

    // The journal was NOT rewritten into a falsely-valid state: byte-identical to the
    // tampered input, still failing verification, and no repair marker / backup added.
    assert.equal(fs.readFileSync(logPath, "utf8"), rawBefore);
    assert.equal(__testing.verifyGovernanceChain().ok, false);
    const after = __testing.readGovernanceEventLog();
    assert.equal(after.some((e) => e.command === "chain-repair"), false);
    const sidecars = fs.readdirSync(path.dirname(logPath)).filter((n) => n.includes("pre-repair"));
    assert.deepEqual(sidecars, []);
  });
});

test("COORD-274: repair-chain REFUSES to launder a removed event (deleted body)", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    writeJournalEvents(logPath, events);
    // ATTACK: delete a non-tip event. The successor's prev now attests a record that
    // is no longer present; the link after it stays consistent (isolated break).
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    lines.splice(2, 1);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const rawBefore = fs.readFileSync(logPath, "utf8");
    assert.equal(__testing.verifyGovernanceChain().ok, false);

    assert.throws(
      () =>
        __testing.repairGovernanceChain({
          confirm: true,
          reason: "attempt to launder a deletion",
          ts: "2026-06-12T02:00:00.000Z",
        }),
      (error) => error instanceof GovernanceError && /re-link-ONLY|CONTENT changed/i.test(error.message)
    );
    assert.equal(fs.readFileSync(logPath, "utf8"), rawBefore);
    assert.equal(__testing.verifyGovernanceChain().ok, false);
  });
});

test("COORD-274: repair-chain dry-run also REFUSES a laundering content edit", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    writeJournalEvents(logPath, events);
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[2]);
    tampered.result = "TAMPERED";
    lines[2] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    // Even without --confirm the operator must be told this is not re-linkable, so
    // they never proceed to --confirm.
    assert.throws(
      () => __testing.repairGovernanceChain({ confirm: false }),
      (error) => error instanceof GovernanceError && /re-link-ONLY|CONTENT changed/i.test(error.message)
    );
  });
});

test("COORD-274: LEGIT linkage-only break (bodies intact) still repairs + verifies", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    // Crossed/stale prev_event_hash links — a cascading linkage break with every
    // event BODY intact. This is the COORD-124 concurrent-append scenario.
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    assert.equal(__testing.verifyGovernanceChain().ok, false);

    const result = __testing.repairGovernanceChain({
      confirm: true,
      reason: "legit linkage re-link; bodies intact",
      ts: "2026-06-12T03:00:00.000Z",
    });
    assert.equal(result.status, "repaired");
    const after = __testing.readGovernanceEventLog();
    assert.equal(__testing.verifyGovernanceChain(after).ok, true);
    // Every original body survived the re-link (content multiset preserved).
    for (let i = 0; i < 6; i += 1) {
      assert.equal(after[i].details.seq, i);
    }
  });
});

test("COORD-274: a REAL concurrent crossing (predecessor still present) is re-linkable, not refused", () => {
  withJournalSandbox(({ logPath }) => {
    // Model two agents reading the same tip T (=events[2]) then appending: events[3]
    // and events[4] both point their prev at T. events[5] then chains off events[4].
    // events[4]'s link is broken (isolated — events[5] still vouches for events[4]),
    // but events[4]'s attested predecessor (T) is STILL PRESENT, so this is a genuine
    // linkage crossing the repair must heal — NOT laundering.
    const events = buildValidChainedEvents(6);
    const tipHash = __testing.hashGovernanceEventRecord(events[2]);
    events[3].prev_event_hash = tipHash; // points at T (correct, file-order predecessor)
    events[4].prev_event_hash = tipHash; // crossed: also points at T instead of events[3]
    events[5].prev_event_hash = __testing.hashGovernanceEventRecord(events[4]); // vouches events[4]
    writeJournalEvents(logPath, events);

    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);

    const result = __testing.repairGovernanceChain({
      confirm: true,
      reason: "concurrent-append crossing; predecessor present",
      ts: "2026-06-12T04:00:00.000Z",
    });
    assert.equal(result.status, "repaired");
    assert.equal(__testing.verifyGovernanceChain(__testing.readGovernanceEventLog()).ok, true);
  });
});

// COORD-223: governed-surface sandbox for idempotency + collision-event tests.
// Mirrors the lightweight path-redirect used by the rollback test above (no git
// scaffold needed): a temp governed surface + isolated runtime so withGovernanceMutation
// and the collision emitter operate against a clean, disposable journal.
function withCoord223Surface(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord223-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  // COORD-273: isolate the prompts/rendered coordination dirs too. Without this
  // they leak to the REAL repo, whose populated artifacts make the new
  // journal-loss-over-existing-state guard fire on this empty-board fresh surface.
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "baseline plan\n");
  fs.writeFileSync(questionsPath, "# QUESTIONS\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const keys = [
    "BOARD_PATH", "PLAN_PATH", "QUESTIONS_PATH", "AGENTS_PATH", "AGENT_SESSIONS_PATH",
    "PLAN_RECORDS_DIR", "PROMPTS_DIR", "RENDERED_DIR", "LOCKS_DIR", "RUNTIME_DIR",
    "GOVERNANCE_EVENT_LOG_PATH",
    "GOVERNANCE_SNAPSHOT_PATH", "GOVERNANCE_SNAPSHOTS_DIR", "GOVERNANCE_EVENT_LOCK_DIR",
  ];
  const original = {};
  for (const k of keys) original[k] = __testing.paths[k];

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    return fn({
      tempDir,
      runtimeDir,
      boardPath,
      logPath: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
      readJournal: () =>
        fs.existsSync(__testing.paths.GOVERNANCE_EVENT_LOG_PATH)
          ? fs.readFileSync(__testing.paths.GOVERNANCE_EVENT_LOG_PATH, "utf8")
              .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
          : [],
    });
  } finally {
    for (const k of keys) __testing.paths[k] = original[k];
  }
}

test("COORD-223: a retried keyed mutation does NOT double-apply (idempotent no-op resume)", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    let applyCount = 0;
    const meta = () => ({ command: "test-keyed", ticket: "IMP-700", idempotencyKey: "intent-abc", idempotentResult: "resumed" });
    const apply = () => {
      // Simulate the logical effect: append a row. A double-apply would add two rows.
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections = [{ heading: "s", rows: [{ ID: "IMP-700" }] }];
      fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
      applyCount += 1;
      return "applied";
    };

    // First attempt commits the keyed mutation.
    const first = __testing.withGovernanceMutation(meta(), apply);
    assert.equal(first, "applied");
    assert.equal(applyCount, 1);

    // Retry the SAME logical mutation (same idempotency key). It must be a clean
    // no-op-or-resume: fn is NOT re-run and no duplicate succeeded event is appended.
    const retry = __testing.withGovernanceMutation(meta(), apply);
    assert.equal(retry, "resumed");
    assert.equal(applyCount, 1, "fn must not re-run on idempotent retry");

    const journal = readJournal();
    const keyed = journal.filter((e) => e.result === "succeeded" && e.details && e.details.idempotency_key === "intent-abc");
    assert.equal(keyed.length, 1, "exactly one succeeded event for the logical intent");
  });
});

test("COORD-264: stableIdempotencyKey normalizes option order and array order", () => {
  const a = stableIdempotencyKey("set-pr", "COORD-1", {
    pr: ["b", "a"],
    nested: { z: "last", a: "first" },
  });
  const b = stableIdempotencyKey("set-pr", "COORD-1", {
    nested: { a: "first", z: "last" },
    pr: ["a", "b"],
  });
  assert.equal(a, b);
  assert.match(a, /^gov:set-pr:COORD-1:/);
});

test("COORD-264: committed idempotency key does not suppress a later lifecycle cycle after status changes", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    let applyCount = 0;
    const meta = () => ({ command: "start", ticket: "IMP-701", idempotencyKey: "start-IMP-701", idempotentResult: "resumed" });
    const writeStatus = (status) => {
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      board.sections = [{
        heading: "s",
        rows: [{ ID: "IMP-701", Status: status, Repo: "X", Type: "bug", Pri: "P2", Owner: "codexa00", Description: "x" }],
      }];
      fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
    };
    const applyDoing = () => {
      writeStatus("doing");
      applyCount += 1;
      return "applied";
    };

    assert.equal(__testing.withGovernanceMutation(meta(), applyDoing), "applied");
    assert.equal(__testing.withGovernanceMutation(meta(), applyDoing), "resumed");
    assert.equal(applyCount, 1);

    // A real later cycle moved the ticket away from the committed after_status.
    // The same key must no longer suppress the mutation.
    __testing.withGovernanceMutation(
      { command: "reset-status", ticket: "IMP-701", allowProvenanceDrift: true },
      () => writeStatus("todo")
    );
    assert.equal(__testing.withGovernanceMutation(meta(), applyDoing), "applied");
    assert.equal(applyCount, 2);
    const keyed = readJournal().filter((e) => e.result === "succeeded" && e.details?.idempotency_key === "start-IMP-701");
    assert.equal(keyed.length, 2);
  });
});

test("COORD-223: distinct idempotency keys still apply independently", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    let applyCount = 0;
    const apply = (rows) => () => {
      fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "s", rows }] }, null, 2));
      applyCount += 1;
      return "applied";
    };
    __testing.withGovernanceMutation({ command: "k", ticket: "IMP-1", idempotencyKey: "k1" }, apply([{ ID: "IMP-1" }]));
    __testing.withGovernanceMutation({ command: "k", ticket: "IMP-2", idempotencyKey: "k2" }, apply([{ ID: "IMP-2" }]));
    assert.equal(applyCount, 2);
    const keyed = readJournal().filter((e) => e.details && e.details.idempotency_key);
    assert.deepEqual(keyed.map((e) => e.details.idempotency_key).sort(), ["k1", "k2"]);
  });
});

test("COORD-223: recordGovernanceCollision journals a queryable collision-detected event that survives rollback", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    // Seed a baseline so the journal is initialized.
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});

    // A detection site emits a collision event, then the surrounding mutation rolls
    // back. The collision event must remain in the journal (event log is not part of
    // the rollback snapshot set).
    assert.throws(
      () =>
        __testing.withGovernanceMutation({ command: "start", ticket: "IMP-900" }, () => {
          fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
          __testing.recordGovernanceCollision({
            ticket: "IMP-900",
            conflictType: "reserved-id-duplicate",
            verb: "file-ticket",
            contenders: [{ ticket_id: "IMP-900" }],
          });
          throw new GovernanceError("synthetic collision refusal");
        }),
      (error) => error instanceof GovernanceError && /synthetic collision refusal/.test(error.message)
    );

    // Governed file rolled back.
    assert.equal(fs.readFileSync(boardPath, "utf8"), JSON.stringify({ sections: [] }, null, 2));

    // The collision event is journaled and queryable (recent/explain read this log).
    const collisions = readJournal().filter((e) => e.command === "collision-detected");
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].result, "detected");
    assert.equal(collisions[0].ticket, "IMP-900");
    assert.equal(collisions[0].details.conflict_type, "reserved-id-duplicate");
    assert.deepEqual(collisions[0].details.contenders, [{ ticket_id: "IMP-900" }]);
  });
});

test("COORD-223: recordGovernanceCollision is best-effort and never throws over the underlying refusal", () => {
  withCoord223Surface(() => {
    // Point the runtime dir at a path that cannot be created (a file, not a dir) so
    // the append fails; the helper must swallow it and report logged:false.
    const original = __testing.paths.GOVERNANCE_EVENT_LOG_PATH;
    const badParent = path.join(os.tmpdir(), `coord223-bad-${Date.now()}`);
    fs.writeFileSync(badParent, "i am a file");
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(badParent, "events.ndjson");
    try {
      const outcome = __testing.recordGovernanceCollision({ ticket: "IMP-1", conflictType: "stale-write-fence" });
      assert.equal(outcome.logged, false);
      assert.ok(outcome.error);
    } finally {
      __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original;
    }
  });
});

// ===========================================================================
// COORD-245: mutation-hardening of the hash-chain integrity core.
//
// The COORD-244 baseline scored 46.56% — the existing tests confirmed the
// happy path but did NOT tightly pin the tamper-evident invariants, so a
// mutated hash / serialization / link-stamp / fail-closed branch went
// uncaught. The tests below target the SURVIVED Stryker mutants directly:
// they assert EXACT canonical serialization + hash values (a mutated hash must
// be caught), order-independent stable serialization, precise prev_event_hash
// linkage + chain-verification fail-closed reasons/fields, the append-time
// re-read + anchor/legacy boundary, and the exact text of every fail-closed
// message + journaled detail field. Each assertion is chosen so that flipping
// the corresponding operator / literal / branch changes the observed value.
// TESTS-ONLY: no behavior change to journal.js.
// ===========================================================================

// --- canonical serialization + hash (stableStringify / canonicalEventSerialization
//     / hashGovernanceEventRecord / hashGovernanceEventLine) ------------------

test("COORD-245: canonicalEventSerialization sorts keys recursively (order-independent)", () => {
  const a = __testing.canonicalEventSerialization({ b: 2, a: 1, nested: { y: 1, x: 2 } });
  const b = __testing.canonicalEventSerialization({ nested: { x: 2, y: 1 }, a: 1, b: 2 });
  // Same content, different insertion order => byte-identical serialization.
  assert.equal(a, b);
  // EXACT canonical form pins the sort + the key/quote/colon literals.
  assert.equal(a, '{"a":1,"b":2,"nested":{"x":2,"y":1}}');
});

test("COORD-245: canonicalEventSerialization preserves array order and serializes nested arrays", () => {
  // Array branch must NOT sort positionally; nested objects inside still sort.
  assert.equal(
    __testing.canonicalEventSerialization([3, { q: 1, p: 2 }]),
    '[3,{"p":2,"q":1}]'
  );
  // A non-empty array literal mutated to [] would change the output.
  assert.equal(__testing.canonicalEventSerialization([1, 2, 3]), "[1,2,3]");
  assert.equal(__testing.canonicalEventSerialization([]), "[]");
});

test("COORD-245: canonicalEventSerialization maps undefined to null (scalar branch)", () => {
  assert.equal(__testing.canonicalEventSerialization({ a: undefined }), '{"a":null}');
  assert.equal(__testing.canonicalEventSerialization(undefined), "null");
  assert.equal(__testing.canonicalEventSerialization("x"), '"x"');
  assert.equal(__testing.canonicalEventSerialization(7), "7");
});

test("COORD-245: hashGovernanceEventRecord is the sha1 of the canonical serialization (exact)", () => {
  const record = { b: 2, a: 1, nested: { y: 1, x: 2 } };
  const expected = crypto
    .createHash("sha1")
    .update(__testing.canonicalEventSerialization(record))
    .digest("hex");
  assert.equal(__testing.hashGovernanceEventRecord(record), expected);
  // Pin the exact digest so a mutated hash input/algorithm is caught.
  assert.equal(__testing.hashGovernanceEventRecord(record), "6361d5ab8410562f076d2126d4b09837f40ba4a8");
  // Order-independence flows through the hash too.
  assert.equal(
    __testing.hashGovernanceEventRecord({ a: 1, b: 2, nested: { x: 2, y: 1 } }),
    __testing.hashGovernanceEventRecord(record)
  );
  // A real content change MUST change the hash (tamper-evidence).
  assert.notEqual(
    __testing.hashGovernanceEventRecord(record),
    __testing.hashGovernanceEventRecord({ ...record, a: 999 })
  );
});

test("COORD-245: hashGovernanceEventLine hashes the verbatim line string (exact)", () => {
  assert.equal(
    __testing.hashGovernanceEventLine("hello-line"),
    "cc9e49a6510017f4d880f4d8ecdb72be5d23962c"
  );
  // String() coercion: a numeric line hashes as its string form.
  assert.equal(__testing.hashGovernanceEventLine(123), __testing.hashGovernanceEventLine("123"));
  // Distinct lines => distinct hashes.
  assert.notEqual(__testing.hashGovernanceEventLine("a"), __testing.hashGovernanceEventLine("b"));
});

// --- isChainedEvent (the chained-vs-legacy boundary predicate) --------------

test("COORD-245: isChainedEvent is true only for a non-empty string prev_event_hash", () => {
  assert.equal(__testing.isChainedEvent({ prev_event_hash: "genesis" }), true);
  assert.equal(__testing.isChainedEvent({ prev_event_hash: "abc123" }), true);
  // Empty string is NOT chained (length > 0 boundary).
  assert.equal(__testing.isChainedEvent({ prev_event_hash: "" }), false);
  // Missing field / legacy event is NOT chained.
  assert.equal(__testing.isChainedEvent({ command: "legacy" }), false);
  // Non-string prev_event_hash is NOT chained.
  assert.equal(__testing.isChainedEvent({ prev_event_hash: 5 }), false);
  // Null/undefined record is NOT chained.
  assert.equal(__testing.isChainedEvent(null), false);
  assert.equal(__testing.isChainedEvent(undefined), false);
});

// --- verifyGovernanceChain fail-closed reasons + broken-link fields ---------

test("COORD-245: verifyGovernanceChain records exact broken-link fields on a tampered chain", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.ticket = "INJECTED-666";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const events = __testing.readGovernanceEventLog();
    const chain = __testing.verifyGovernanceChain(events);
    assert.equal(chain.ok, false);
    // The break is at index 2 (gamma's prev no longer matches the tampered beta).
    const link = chain.broken.find((b) => b.index === 2);
    assert.ok(link, "expected a broken link at index 2");
    assert.equal(link.reason, "prev-hash-mismatch");
    // The broken-link carries the OFFENDING event's command + ts (not null) and
    // the expected-vs-actual prev hashes.
    assert.equal(link.command, "gamma");
    assert.equal(link.ts, "2026-06-10T00:02:00.000Z");
    assert.equal(link.actual, events[2].prev_event_hash);
    assert.equal(link.expected, __testing.hashGovernanceEventRecord(events[1]));
    assert.notEqual(link.expected, link.actual);
  });
});

test("COORD-245: verifyGovernanceChain flags an unchained event appearing after the chain started", () => {
  const chained = buildValidChainedEvents(3);
  // Insert a LEGACY (no prev_event_hash) event AFTER the chain began.
  const legacy = mkLegacyEvent("stray-legacy", "2026-06-10T09:00:00.000Z");
  const events = [chained[0], chained[1], legacy, chained[2]];
  const chain = __testing.verifyGovernanceChain(events);
  assert.equal(chain.ok, false);
  const link = chain.broken.find((b) => b.reason === "unchained-event-after-chain-start");
  assert.ok(link, "expected unchained-event-after-chain-start");
  assert.equal(link.index, 2);
  assert.equal(link.command, "stray-legacy");
  assert.equal(link.ts, "2026-06-10T09:00:00.000Z");
});

test("COORD-245: verifyGovernanceChain flags a chained run whose first event is not genesis-anchored", () => {
  const chained = buildValidChainedEvents(3);
  // Break the anchor: the first chained event must carry the genesis marker.
  chained[0].prev_event_hash = "deadbeef".padEnd(40, "0");
  const chain = __testing.verifyGovernanceChain(chained);
  assert.equal(chain.ok, false);
  const link = chain.broken.find((b) => b.reason === "chain-start-not-anchored");
  assert.ok(link, "expected chain-start-not-anchored");
  assert.equal(link.index, 0);
  assert.equal(link.expected, "genesis");
  assert.equal(link.actual, "deadbeef".padEnd(40, "0"));
  assert.equal(link.command, "chain-anchor");
});

test("COORD-245: verifyGovernanceChain reports exact counts + head on a healthy chain", () => {
  const events = buildValidChainedEvents(4);
  const chain = __testing.verifyGovernanceChain(events);
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.broken, []);
  assert.equal(chain.total, 4);
  assert.equal(chain.preChainCount, 0);
  assert.equal(chain.chainedCount, 4);
  // The head is the canonical hash of the LAST chained event (the attestation input).
  assert.equal(chain.head, __testing.hashGovernanceEventRecord(events[3]));
  // A mixed legacy+chained log reports both counts.
  const legacyLead = [
    mkLegacyEvent("L1", "2026-06-09T00:00:00.000Z"),
    mkLegacyEvent("L2", "2026-06-09T00:01:00.000Z"),
    ...events,
  ];
  const mixed = __testing.verifyGovernanceChain(legacyLead);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.preChainCount, 2);
  assert.equal(mixed.chainedCount, 4);
});

// --- appendGovernanceEvent: prev_event_hash stamping order + anchor boundary -

test("COORD-245: appendGovernanceEvent stamps the FIRST fresh event at genesis and links the rest", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent(mkLegacyEvent("e1", "2026-06-10T00:00:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("e2", "2026-06-10T00:01:00.000Z"));
    __testing.appendGovernanceEvent(mkLegacyEvent("e3", "2026-06-10T00:02:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    assert.equal(events[0].prev_event_hash, "genesis");
    assert.equal(events[1].prev_event_hash, __testing.hashGovernanceEventRecord(events[0]));
    assert.equal(events[2].prev_event_hash, __testing.hashGovernanceEventRecord(events[1]));
    // The record-hash is canonical (key-sorted), independent of stored line order.
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    assert.equal(
      __testing.hashGovernanceEventRecord(JSON.parse(lines[0])),
      __testing.hashGovernanceEventRecord(events[0])
    );
    assert.equal(__testing.verifyGovernanceChain(events).ok, true);
  });
});

test("COORD-245: appendGovernanceEvent re-reads the tip UNDER the lock so concurrent-style appends chain in order", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // First append establishes the tip.
    __testing.appendGovernanceEvent(mkLegacyEvent("first", "2026-06-10T00:00:00.000Z"));
    const afterFirst = __testing.readGovernanceEventLog();
    const tipHash = __testing.hashGovernanceEventRecord(afterFirst[0]);
    // A SECOND append must re-read the tip from disk and link off it (not off a
    // stale in-memory genesis). If the head re-read were dropped, the second
    // event would re-anchor at genesis and the chain would not verify.
    __testing.appendGovernanceEvent(mkLegacyEvent("second", "2026-06-10T00:01:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    assert.equal(events[1].prev_event_hash, tipHash);
    assert.notEqual(events[1].prev_event_hash, "genesis");
    assert.equal(__testing.verifyGovernanceChain(events).ok, true);
  });
});

test("COORD-245: appendGovernanceEvent migrates a legacy log with an explicit anchor record", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const legacy = [
      mkLegacyEvent("legacy-1", "2026-06-09T00:00:00.000Z"),
      mkLegacyEvent("legacy-2", "2026-06-09T00:01:00.000Z"),
    ];
    fs.writeFileSync(logPath, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    __testing.appendGovernanceEvent(mkLegacyEvent("post", "2026-06-10T00:00:00.000Z"));
    const events = __testing.readGovernanceEventLog();
    const anchor = events[2];
    // The anchor is an explicit, auditable record with the exact shape.
    assert.equal(anchor.command, "chain-anchor");
    assert.equal(anchor.result, "anchored");
    assert.equal(anchor.prev_event_hash, "genesis");
    assert.equal(anchor.details.reason, "legacy-pre-chain-migration");
    assert.deepEqual(anchor.changed_paths, []);
    // The post-migration event links off the anchor (not the legacy tip).
    assert.equal(events[3].prev_event_hash, __testing.hashGovernanceEventRecord(anchor));
  });
});

// --- restampGovernanceChainFrom (COORD-124 link re-stamp) -------------------

test("COORD-245: restampGovernanceChainFrom re-links only from fromIndex forward, leaving prior bytes stable", () => {
  const events = buildValidChainedEvents(5);
  // Cross a link at index 3 (simulate a concurrent-append break).
  events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
  const restamped = __testing.restampGovernanceChainFrom(events, 3);
  // Events before fromIndex are byte-identical (not restamped).
  assert.equal(restamped[0].prev_event_hash, events[0].prev_event_hash);
  assert.equal(restamped[2].prev_event_hash, events[2].prev_event_hash);
  // The event at fromIndex links to the canonical hash of its predecessor.
  assert.equal(restamped[3].prev_event_hash, __testing.hashGovernanceEventRecord(restamped[2]));
  assert.equal(restamped[4].prev_event_hash, __testing.hashGovernanceEventRecord(restamped[3]));
  // The re-linked chain verifies clean.
  assert.equal(__testing.verifyGovernanceChain(restamped).ok, true);
  // Re-stamping from index 0 roots at genesis.
  const fromZero = __testing.restampGovernanceChainFrom(events, 0);
  assert.equal(fromZero[0].prev_event_hash, "genesis");
});

// --- summarizeIdentityForEvent (every field, present + absent) ---------------

test("COORD-245: summarizeIdentityForEvent maps every identity field, with null fallbacks", () => {
  const full = __testing.summarizeIdentityForEvent({
    agent: { id: "a11", handle: "claudea11" },
    session: { session_id: "a11-xyz", thread_id: "thread-9" },
    autoClaimed: true,
  });
  assert.equal(full.agent_id, "a11");
  assert.equal(full.owner, "claudea11");
  assert.equal(full.session_id, "a11-xyz");
  assert.equal(full.thread_id, "thread-9");
  assert.equal(full.auto_claimed, true);

  // Absent identity => null fields and auto_claimed strictly false (=== true).
  const empty = __testing.summarizeIdentityForEvent(null);
  assert.equal(empty.agent_id, null);
  assert.equal(empty.owner, null);
  assert.equal(empty.session_id, null);
  assert.equal(empty.auto_claimed, false);

  // autoClaimed of a non-true truthy value must NOT be coerced to true.
  const notTrue = __testing.summarizeIdentityForEvent({ autoClaimed: "yes" });
  assert.equal(notTrue.auto_claimed, false);
});

// --- inferTicketStatus (board lookup, exact status + null paths) -------------

test("COORD-245: inferTicketStatus returns the exact board Status or null", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "T-7", Status: "doing" }] }] }, null, 2)
    );
    assert.equal(__testing.inferTicketStatus("T-7"), "doing");
    // Unknown ticket => null.
    assert.equal(__testing.inferTicketStatus("T-404"), null);
    // Falsy ticket id => null (no board read).
    assert.equal(__testing.inferTicketStatus(null), null);
    assert.equal(__testing.inferTicketStatus(""), null);
  });
});

// --- formatGovernanceExternalSideEffect (exact strings, both branches) ------

test("COORD-245: formatGovernanceExternalSideEffect renders a github_pr_merge with all parts", () => {
  const label = __testing.formatGovernanceExternalSideEffect({
    type: "github_pr_merge",
    pr_url: "https://example/pr/1",
    method: "squash",
    merged_at: "2026-06-10T00:00:00.000Z",
    delete_branch: true,
  });
  assert.equal(
    label,
    "github_pr_merge(https://example/pr/1, method=squash, merged_at=2026-06-10T00:00:00.000Z, delete_branch=true)"
  );
  // Missing pr_url falls back to the literal "GitHub PR"; omitted optional parts
  // are dropped (filter(Boolean)).
  assert.equal(
    __testing.formatGovernanceExternalSideEffect({ type: "github_pr_merge" }),
    "github_pr_merge(GitHub PR)"
  );
});

test("COORD-245: formatGovernanceExternalSideEffect handles non-merge + invalid effects", () => {
  // A typed non-merge effect echoes its type.
  assert.equal(
    __testing.formatGovernanceExternalSideEffect({ type: "webhook" }),
    "webhook"
  );
  // No type => the generic fallback literal.
  assert.equal(
    __testing.formatGovernanceExternalSideEffect({}),
    "external side effect"
  );
  // Non-object => the unknown-effect literal.
  assert.equal(
    __testing.formatGovernanceExternalSideEffect(null),
    "unknown external side effect"
  );
  assert.equal(
    __testing.formatGovernanceExternalSideEffect("nope"),
    "unknown external side effect"
  );
});

// --- recordGovernanceCollision (exact journaled detail fields) --------------

test("COORD-245: recordGovernanceCollision journals the exact conflict detail shape", () => {
  withCoord223Surface(({ readJournal }) => {
    const outcome = __testing.recordGovernanceCollision({
      ticket: "IMP-9",
      conflictType: "co-located-session",
      verb: "start",
      contenders: [{ handle: "claudea11" }, { handle: "claudea12" }],
      identity: { agent: { id: "a11", handle: "claudea11" }, session: { session_id: "a11-x" } },
      extra: { note: "raced" },
    });
    assert.deepEqual(outcome, { logged: true });
    const ev = readJournal().find((e) => e.command === "collision-detected");
    assert.equal(ev.result, "detected");
    assert.equal(ev.ticket, "IMP-9");
    assert.equal(ev.details.conflict_type, "co-located-session");
    assert.equal(ev.details.verb, "start");
    assert.deepEqual(ev.details.contenders, [{ handle: "claudea11" }, { handle: "claudea12" }]);
    // The extra object is spread into details.
    assert.equal(ev.details.note, "raced");
    assert.equal(ev.identity.owner, "claudea11");
    assert.deepEqual(ev.changed_paths, []);
  });
});

test("COORD-245: recordGovernanceCollision defaults conflict_type and contenders safely", () => {
  withCoord223Surface(({ readJournal }) => {
    __testing.recordGovernanceCollision({ ticket: "IMP-1" });
    const ev = readJournal().find((e) => e.command === "collision-detected");
    // Missing conflictType => the "unknown" literal (not "").
    assert.equal(ev.details.conflict_type, "unknown");
    // Missing verb => null.
    assert.equal(ev.details.verb, null);
    // Non-array contenders default to [].
    assert.deepEqual(ev.details.contenders, []);
    // No identity => null.
    assert.equal(ev.identity, null);
  });
});

// --- formatGovernanceDriftMessage / formatOutOfBandBoardMutationMessage ------

test("COORD-245: formatGovernanceDriftMessage embeds the ts + drift list verbatim", () => {
  const msg = __testing.formatGovernanceDriftMessage(
    { ts: "2026-06-10T00:00:00.000Z" },
    ["board/tasks.json", "PLAN.md"]
  );
  assert.match(msg, /Governed state changed without a journaled gov mutation since 2026-06-10T00:00:00\.000Z: board\/tasks\.json, PLAN\.md\./);
  assert.match(msg, /gov doctor/);
  assert.match(msg, /gov recover <ticket-id>/);
  // Missing ts => the "unknown time" fallback literal.
  const noTs = __testing.formatGovernanceDriftMessage(null, ["x"]);
  assert.match(noTs, /since unknown time: x\./);
});

test("COORD-245: formatOutOfBandBoardMutationMessage embeds paths + ts and the full guidance", () => {
  const msg = __testing.formatOutOfBandBoardMutationMessage({
    paths: ["board/tasks.json", "plans/T-1.json"],
    latestEvent: { ts: "2026-06-11T00:00:00.000Z" },
  });
  assert.match(msg, /Refusing to run a governed board mutation on top of an out-of-band coordination-state change/);
  assert.match(msg, /no journaled transaction since 2026-06-11T00:00:00\.000Z\): board\/tasks\.json, plans\/T-1\.json\./);
  assert.match(msg, /Direct edits \/ ad-hoc scripts must NOT mutate the board/);
  assert.match(msg, /gov open-followup \/ gov start \/ gov move-review \/ gov finalize/);
  assert.match(msg, /coord\/scripts\/gov doctor/);
  assert.match(msg, /coord\/scripts\/gov recover <ticket-id>/);
  // Missing latestEvent.ts => the "unknown time" fallback; empty paths => "".
  const fallback = __testing.formatOutOfBandBoardMutationMessage({ paths: [], latestEvent: null });
  assert.match(fallback, /since unknown time\): \./);
});

// --- describeGovernanceMutation / detectGovernanceQuestionAuthor ------------

test("COORD-245: describeGovernanceMutation joins command + ticket, falling back to a default", () => {
  assert.equal(__testing.describeGovernanceMutation({ command: "start", ticket: "T-1" }), "start T-1");
  assert.equal(__testing.describeGovernanceMutation({ command: "land" }), "land");
  assert.equal(__testing.describeGovernanceMutation({}), "governance mutation");
});

test("COORD-245: detectGovernanceQuestionAuthor prefers the explicit identity handle", () => {
  assert.equal(
    __testing.detectGovernanceQuestionAuthor({ identity: { agent: { handle: "claudea11" } } }),
    "claudea11"
  );
});

// --- extractDriftSinceTimestamp (the drift-note parse regex) -----------------

test("COORD-245: extractDriftSinceTimestamp pulls the ISO ts out of a drift-note answer", () => {
  const answer =
    "Detected unjournaled governed-state drift since 2026-06-10T00:00:00.000Z. Continued.";
  assert.equal(__testing.extractDriftSinceTimestamp(answer), "2026-06-10T00:00:00.000Z");
  // No marker => null.
  assert.equal(__testing.extractDriftSinceTimestamp("nothing here"), null);
  assert.equal(__testing.extractDriftSinceTimestamp(""), null);
  assert.equal(__testing.extractDriftSinceTimestamp(null), null);
});

// --- findCommittedMutationByIdempotencyKey (reverse scan, key match) --------

test("COORD-245: findCommittedMutationByIdempotencyKey finds the matching succeeded event", () => {
  withCoord223Surface(({ readJournal }) => {
    __testing.withGovernanceMutation(
      { command: "k", ticket: "IMP-1", idempotencyKey: "key-A", forceLog: true },
      () => {}
    );
    const found = __testing.findCommittedMutationByIdempotencyKey("key-A");
    assert.ok(found, "expected to find the committed keyed mutation");
    assert.equal(found.result, "succeeded");
    assert.equal(found.details.idempotency_key, "key-A");
    // A non-matching key returns null.
    assert.equal(__testing.findCommittedMutationByIdempotencyKey("key-MISSING"), null);
    // A falsy key short-circuits to null.
    assert.equal(__testing.findCommittedMutationByIdempotencyKey(""), null);
    assert.equal(__testing.findCommittedMutationByIdempotencyKey(null), null);
    void readJournal;
  });
});

// --- snapshot artifacts: write/read round-trip + checkpoint ------------------

test("COORD-245: snapshot artifact write/read round-trips and the path is digest-addressed", () => {
  withGovernedSurfaceSandbox(() => {
    const snapshot = __testing.buildGovernanceSnapshot();
    const artifactPath = __testing.writeGovernanceSnapshotArtifact(snapshot);
    // The artifact path is addressed by the snapshot digest.
    assert.equal(artifactPath, __testing.governanceSnapshotArtifactPath(snapshot.digest));
    assert.equal(fs.existsSync(artifactPath), true);
    const read = __testing.readGovernanceSnapshotArtifact(snapshot.digest);
    assert.equal(read.digest, snapshot.digest);
    assert.deepEqual(read.files.map((f) => f.path), snapshot.files.map((f) => f.path));
    // allowMissing returns null instead of failing on an absent digest.
    assert.equal(__testing.readGovernanceSnapshotArtifact("0".repeat(40), { allowMissing: true }), null);
    assert.equal(__testing.readGovernanceSnapshotArtifact(null, { allowMissing: true }), null);
  });
});

test("COORD-245: writeGovernanceSnapshotCheckpoint persists the digest + metadata", () => {
  withGovernedSurfaceSandbox(() => {
    const snapshot = __testing.buildGovernanceSnapshot();
    __testing.writeGovernanceSnapshotCheckpoint(snapshot, {
      ts: "2026-06-10T00:00:00.000Z",
      command: "land",
      ticket: "T-3",
    });
    const checkpoint = __testing.readGovernanceSnapshotCheckpoint();
    assert.equal(checkpoint.digest, snapshot.digest);
    assert.equal(checkpoint.ts, "2026-06-10T00:00:00.000Z");
    assert.equal(checkpoint.command, "land");
    assert.equal(checkpoint.ticket, "T-3");
    assert.equal(checkpoint.recorded_at, snapshot.recorded_at);
    // allowMissing returns null when no checkpoint exists.
    fs.rmSync(__testing.paths.GOVERNANCE_SNAPSHOT_PATH, { force: true });
    assert.equal(__testing.readGovernanceSnapshotCheckpoint({ allowMissing: true }), null);
  });
});

// --- ensureGovernanceJournalBaseline + advanceGovernanceProvenanceBaseline ---

test("COORD-245: ensureGovernanceJournalBaseline writes a baseline once, then no-ops", () => {
  withGovernedSurfaceSandbox(() => {
    const first = __testing.ensureGovernanceJournalBaseline("first-reason");
    assert.equal(first, true);
    const events = __testing.readGovernanceEventLog();
    const baseline = events.find((e) => e.command === "journal-baseline");
    assert.ok(baseline, "expected a journal-baseline event");
    assert.equal(baseline.details.reason, "first-reason");
    assert.ok(baseline.snapshot_digest, "baseline carries a snapshot digest");
    // A second call is a no-op (a snapshot already exists).
    assert.equal(__testing.ensureGovernanceJournalBaseline("second"), false);
  });
});

test("COORD-245: advanceGovernanceProvenanceBaseline only advances on residual coordination-state drift", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    __testing.ensureGovernanceJournalBaseline("seed");
    // No drift => no advance.
    assert.equal(__testing.advanceGovernanceProvenanceBaseline("noop-case"), false);
    // Introduce out-of-band board drift (a coordination-state file changed off-journal).
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "x" }] }, null, 2));
    const advanced = __testing.advanceGovernanceProvenanceBaseline("post-sync");
    assert.equal(advanced, true);
    const events = __testing.readGovernanceEventLog();
    const last = events[events.length - 1];
    assert.equal(last.command, "journal-baseline");
    assert.equal(last.details.reason, "post-sync");
    assert.ok(Array.isArray(last.details.advanced_paths));
    assert.ok(last.details.advanced_paths.length > 0);
    // After advancing, the drift is absorbed: a second advance is a no-op.
    assert.equal(__testing.advanceGovernanceProvenanceBaseline("again"), false);
  });
});

test("COORD-275: isPathWithinSyncScope matches exact files + directory pathspecs only", () => {
  const scope = ["board/tasks.json", "rendered/TASKS.md", ".runtime/plans/"];
  // Exact-file pathspec match.
  assert.equal(__testing.isPathWithinSyncScope("board/tasks.json", scope), true);
  assert.equal(__testing.isPathWithinSyncScope("rendered/TASKS.md", scope), true);
  // Directory pathspec matches its children (prefix), not the bare name.
  assert.equal(__testing.isPathWithinSyncScope(".runtime/plans/COORD-1.json", scope), true);
  // A sibling NOT in the synced set is out-of-scope even under the same parent dir.
  assert.equal(__testing.isPathWithinSyncScope("rendered/OTHER.md", scope), false);
  assert.equal(__testing.isPathWithinSyncScope("prompts/tickets/COORD-9.md", scope), false);
  assert.equal(__testing.isPathWithinSyncScope("board/tasks.json", null), false);
  assert.equal(__testing.isPathWithinSyncScope("board/tasks.json", []), false);
});

test("COORD-275: scoped baseline advance ABSORBS the mutation's own derived-artifact drift (COORD-246 preserved)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    __testing.ensureGovernanceJournalBaseline("seed");
    // Simulate the terminal mutation's OWN post-journal sync rewriting the
    // canonical board json — a derived path the sync is authorized to touch.
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "synced" }] }, null, 2));
    const drift = __testing.detectOutOfBandBoardMutation();
    assert.equal(drift.detected, true);
    // Scope = exactly the path(s) the sync rewrote.
    const scopePaths = drift.paths.slice();
    const advanced = __testing.advanceGovernanceProvenanceBaseline("post-finalize-sync", { scopePaths });
    assert.equal(advanced, true, "in-scope derived drift must be absorbed");
    // COORD-246 behaviour preserved: the next governed command sees NO spurious drift.
    assert.equal(__testing.detectOutOfBandBoardMutation().detected, false);
    // And a re-run is a clean no-op (nothing left to absorb).
    assert.equal(__testing.advanceGovernanceProvenanceBaseline("again", { scopePaths }), false);
  });
});

test("COORD-275: scoped baseline advance PRESERVES a concurrent out-of-scope hand-edit (single-writer fail-open closed)", () => {
  withGovernedSurfaceSandbox(({ boardPath, promptsDir }) => {
    __testing.ensureGovernanceJournalBaseline("seed");
    // The mutation's OWN sync rewrote the board json (in scope)...
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "synced" }] }, null, 2));
    // ...and a GENUINE concurrent hand-edit landed in the advance window on a
    // coordination-state path the sync does NOT rewrite (a prompt source file).
    const promptFile = path.join(promptsDir, "tickets", "COORD-999.md");
    fs.writeFileSync(promptFile, "hand-edited out of band\n", "utf8");
    // Scope = ONLY what the sync was authorized to rewrite (the board json).
    const scopePaths = __testing
      .detectOutOfBandBoardMutation()
      .paths.filter((p) => p.endsWith("tasks.json"));
    assert.equal(scopePaths.length, 1, "the board json is the only in-scope drift path");
    // The advance must REFUSE: an out-of-band path lies outside the synced scope.
    const advanced = __testing.advanceGovernanceProvenanceBaseline("post-finalize-sync", { scopePaths });
    assert.equal(advanced, false, "out-of-scope concurrent drift must NOT be absorbed");
    // The hand-edit remains detectable so the next seal / conform still flags it.
    const after = __testing.detectOutOfBandBoardMutation();
    assert.equal(after.detected, true);
    assert.ok(
      after.paths.some((p) => p.endsWith("COORD-999.md")),
      "the out-of-scope prompt hand-edit is preserved as detectable drift"
    );
  });
});

// --- detectOutOfBandBoardMutation + isCoordinationStatePath -----------------

test("COORD-245: detectOutOfBandBoardMutation flags a coordination-state edit, ignores runtime ledgers", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    __testing.ensureGovernanceJournalBaseline("seed");
    // Clean state => not detected.
    const clean = __testing.detectOutOfBandBoardMutation();
    assert.equal(clean.detected, false);
    assert.deepEqual(clean.paths, []);
    // Out-of-band board edit => detected, with the board path reported.
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "oob" }] }, null, 2));
    const oob = __testing.detectOutOfBandBoardMutation();
    assert.equal(oob.detected, true);
    assert.ok(oob.paths.some((p) => p.endsWith("tasks.json")));
    assert.equal(oob.uninitialized, false);
  });
});

test("COORD-245: isCoordinationStatePath matches the board file + records dir, not runtime/unrelated", () => {
  // Built from the LIVE configured paths (relativeCoordPath-form): the board file
  // is "board/tasks.json" (exact match) and the plan-records dir is ".runtime/plans/"
  // (prefix match) in the real coord layout.
  assert.equal(__testing.isCoordinationStatePath("board/tasks.json"), true);
  assert.equal(__testing.isCoordinationStatePath(".runtime/plans/T-1.json"), true);
  // The board match is EXACT — a sibling file in board/ is not the board itself.
  assert.equal(__testing.isCoordinationStatePath("board/other.json"), false);
  // The agent_sessions runtime ledger is NOT coordination-state.
  assert.equal(__testing.isCoordinationStatePath(".runtime/agent_sessions.json"), false);
  // An unrelated path is NOT coordination-state.
  assert.equal(__testing.isCoordinationStatePath("docs/README.md"), false);
});

// --- isRuntimeLedgerDriftPath -----------------------------------------------

test("COORD-245: isRuntimeLedgerDriftPath matches the .runtime/ prefix only", () => {
  assert.equal(__testing.isRuntimeLedgerDriftPath(".runtime/agent_sessions.json"), true);
  assert.equal(__testing.isRuntimeLedgerDriftPath(".runtime/session-threads/x.json"), true);
  assert.equal(__testing.isRuntimeLedgerDriftPath("board/tasks.json"), false);
  assert.equal(__testing.isRuntimeLedgerDriftPath(""), false);
  assert.equal(__testing.isRuntimeLedgerDriftPath(null), false);
});

// --- findLatestGovernanceBaselineTimestamp ----------------------------------

test("COORD-245: findLatestGovernanceBaselineTimestamp returns the ts only for a snapshot-bearing event", () => {
  withGovernedSurfaceSandbox(() => {
    // No events => null.
    assert.equal(__testing.findLatestGovernanceBaselineTimestamp(), null);
    __testing.ensureGovernanceJournalBaseline("seed");
    const events = __testing.readGovernanceEventLog();
    const baselineTs = events[events.length - 1].ts;
    assert.equal(__testing.findLatestGovernanceBaselineTimestamp(), baselineTs);
  });
});

// --- diffGovernanceSnapshots -------------------------------------------------

test("COORD-245: diffGovernanceSnapshots reports added/removed/changed/missing files", () => {
  const left = {
    files: [
      { path: "a", exists: true, digest: "h1" },
      { path: "b", exists: true, digest: "h2" },
    ],
  };
  const right = {
    files: [
      { path: "a", exists: true, digest: "h1" }, // unchanged
      { path: "b", exists: true, digest: "h2-CHANGED" }, // changed digest
      { path: "c", exists: true, digest: "h3" }, // added
    ],
  };
  assert.deepEqual(__testing.diffGovernanceSnapshots(left, right), ["b", "c"]);
  // Identical snapshots => no diff.
  assert.deepEqual(__testing.diffGovernanceSnapshots(left, left), []);
  // Null inputs are tolerated (optional chaining on .files).
  assert.deepEqual(__testing.diffGovernanceSnapshots(null, null), []);
});

// --- repairGovernanceChain backup path naming -------------------------------

test("COORD-245: governanceChainRepairBackupPath sanitizes the ts into the sidecar name", () => {
  const p = __testing.governanceChainRepairBackupPath("2026-06-12T00:00:00.000Z");
  // Colons + dots in the ts are replaced with dashes for a safe filename.
  assert.match(p, /\.pre-repair-2026-06-12T00-00-00-000Z$/);
  assert.ok(!/:/.test(path.basename(p)), "no colons in the sidecar filename");
});

// COORD-273: seal the journal-deletion bypass. When the governance journal is
// ABSENT but governed coordination state already exists on disk, a `gov` command
// must NOT silently anchor that state as a fresh genesis baseline (the attack:
// hand-edit tasks.json, `rm` the events log, let the next command launder the
// tamper). It must FAIL CLOSED and direct the operator to an explicit recovery
// path. A genuinely fresh project still auto-baselines, and the explicit recovery
// path (recovery-intent flag) can still re-baseline over existing state.
test("COORD-273: refuses to auto-baseline an ABSENT journal over EXISTING board state (attack blocked)", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    // Existing governed coordination state on disk: a real ticket row.
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "IMP-500", Status: "todo" }] }] }, null, 2)
    );
    // The journal is absent (withCoord223Surface seeds none). A normal governed
    // mutation must refuse rather than silently re-baseline the tampered state.
    assert.throws(
      () => __testing.withGovernanceMutation({ command: "start", ticket: "IMP-500" }, () => {}),
      (error) =>
        error instanceof GovernanceError &&
        /Refusing to auto-baseline the governance journal/.test(error.message) &&
        /gov recover/.test(error.message) &&
        /gov reconcile/.test(error.message)
    );
    // No genesis baseline was laundered into existence.
    assert.equal(readJournal().length, 0, "no journal-baseline event may be written for a journal-loss-over-state case");
  });
});

test("COORD-273: a genuinely FRESH project (no coordination state) still auto-baselines cleanly", () => {
  withCoord223Surface(({ readJournal }) => {
    // Empty board (no ticket rows), empty prompts/rendered/plan-records, absent
    // journal: this is a real first-run init and must auto-baseline, not error.
    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {})
    );
    const journal = readJournal();
    assert.ok(journal.length >= 1, "a fresh init auto-baselines");
    assert.equal(journal[0].command, "journal-baseline");
  });
});

test("COORD-273: explicit recovery intent (allowProvenanceDrift) CAN re-baseline over EXISTING state", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    // Same starting condition as the attack (existing rows + absent journal) but
    // the operator deliberately invokes a recovery path carrying recovery intent.
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "IMP-501", Status: "todo" }] }] }, null, 2)
    );
    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation(
        { command: "manual-reconcile", allowProvenanceDrift: true, forceLog: true },
        () => {}
      )
    );
    const journal = readJournal();
    assert.ok(journal.length >= 1, "recovery establishes a baseline over existing state");
    assert.equal(journal[0].command, "journal-baseline");
  });
});

// COORD-279 (item 4): when the journal's latest SNAPSHOT ARTIFACT was pruned
// (snapshots are prunable by design — COORD-105/108) but the journal ITSELF is
// intact, `gov` must NOT brick. detectGovernanceProvenanceDrift now reports a
// distinct `snapshotPruned` with no false drift, and the mutation path
// gracefully re-baselines (an explicit, auditable journal-baseline recovery
// event) instead of hard-failing. This is DISTINCT from the COORD-273 hole
// (journal ABSENT over live state), which must still fail closed.
test("COORD-279: a PRUNED snapshot artifact gracefully re-baselines instead of bricking gov", () => {
  withCoord223Surface(({ runtimeDir, readJournal }) => {
    // Establish a real baseline via a governed mutation on the (empty) fresh
    // surface — this auto-baselines and writes events + a snapshot artifact.
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
    const before = readJournal().length;
    assert.ok(before >= 1, "baseline established");

    // PRUNE: delete every snapshot artifact AND the checkpoint, leaving the
    // journal's latest event pointing at a now-missing snapshot_digest.
    const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
    for (const f of fs.readdirSync(snapshotsDir)) {
      fs.rmSync(path.join(snapshotsDir, f), { force: true });
    }
    const checkpoint = path.join(runtimeDir, "governance-latest-snapshot.json");
    if (fs.existsSync(checkpoint)) fs.rmSync(checkpoint, { force: true });

    // Read-only drift detection no longer throws; it reports pruned + no drift.
    const drift = __testing.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.equal(drift.snapshotPruned, true, "pruned snapshot reported distinctly");
    assert.deepEqual(drift.drift, []);

    // A subsequent governed mutation succeeds (does NOT brick) and records an
    // auditable re-baseline recovery event.
    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "seed", ticket: "IMP-900", forceLog: true }, () => {})
    );
    const journal = readJournal();
    assert.ok(
      journal.some(
        (e) => e.command === "journal-baseline" && e.details && e.details.reason === "snapshot-pruned-recovery"
      ),
      "an auditable snapshot-pruned-recovery baseline event was appended"
    );
  });
});

// COORD-279 (item 4) NO-CONFLICT proof: the pruned-snapshot graceful recovery
// must NOT weaken the COORD-273 guard. Journal ABSENT over live state still
// fails closed (latestEvent === null => uninitialized, not snapshotPruned).
test("COORD-279: the COORD-273 journal-absent-over-live-state guard still fails closed", () => {
  withCoord223Surface(({ boardPath, runtimeDir, readJournal }) => {
    // Live coordination state on disk...
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "IMP-901", Status: "todo" }] }] }, null, 2)
    );
    // ...but the ENTIRE journal is gone (events log + snapshots + checkpoint) —
    // the COORD-273 deletion signature, NOT a mere pruned cache artifact.
    const logPath = path.join(runtimeDir, "governance-events.ndjson");
    if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });
    const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
    if (fs.existsSync(snapshotsDir)) {
      for (const f of fs.readdirSync(snapshotsDir)) fs.rmSync(path.join(snapshotsDir, f), { force: true });
    }
    const checkpoint = path.join(runtimeDir, "governance-latest-snapshot.json");
    if (fs.existsSync(checkpoint)) fs.rmSync(checkpoint, { force: true });

    assert.throws(
      () => __testing.withGovernanceMutation({ command: "start", ticket: "IMP-901" }, () => {}),
      (error) =>
        error instanceof GovernanceError &&
        /Refusing to auto-baseline the governance journal/.test(error.message)
    );
    assert.equal(readJournal().length, 0, "no baseline laundered for journal-loss-over-state");
  });
});

// ---------------------------------------------------------------------------
// COORD-289: versioned SHA-1 -> SHA-256 journal hash-chain migration. Tests use
// ISOLATED sandbox journals (withJournalSandbox) + hand-built fixtures; the LIVE
// journal is never mutated here. The migration bridge is a single signed
// `hash-alg-migration` event: SHA-1-linked to the old head (continuity), carrying
// hash_alg:"sha256" + details{ sha1_chain_head, migrated_at, verifier_version,
// signature }, whose own sha256 record-hash is the new-era checkpoint.
// ---------------------------------------------------------------------------

const chainSign = require("./chain-migration-signing.js");
const { publicKeyFingerprint } = require("./conformance-attestation.js").__internals;

function coord289Ss(value) {
  if (Array.isArray(value)) return `[${value.map(coord289Ss).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${coord289Ss(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const coord289Sha1 = (v) => crypto.createHash("sha1").update(v).digest("hex");
const coord289Sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

// Build a mixed-era fixture: [pre-chain legacy] -> [sha1 chained x2] ->
// [signed migration bridge] -> [sha256 chained x2]. Returns the events + the
// signing key fingerprint so trust-anchor cases can pin authenticity.
function buildMixedEraFixture(signer) {
  const key = signer || crypto.generateKeyPairSync("ed25519");
  const pubPem = key.publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = publicKeyFingerprint(pubPem);

  const legacy = { ts: "t0", command: "legacy", ticket: "L" }; // no prev — pre-chain
  const s1 = { ts: "t1", command: "start", ticket: "A", prev_event_hash: "genesis" };
  const s2 = { ts: "t2", command: "start", ticket: "B", prev_event_hash: coord289Sha1(coord289Ss(s1)) };
  const sha1Head = coord289Sha1(coord289Ss(s2));

  const payload = chainSign.transitionPayload({
    migrated_at: "tm",
    sha1_chain_head: sha1Head,
    verifier_version: "coord-289-sha256-v1",
  });
  const signature = chainSign.signTransition(payload, key.privateKey, pubPem);
  const mig = {
    ts: "tm",
    command: "hash-alg-migration",
    ticket: null,
    result: "migrated",
    hash_alg: "sha256",
    details: { sha1_chain_head: sha1Head, migrated_at: "tm", verifier_version: "coord-289-sha256-v1", signature },
    changed_paths: [],
    prev_event_hash: sha1Head,
  };
  const migHash = coord289Sha256(coord289Ss(mig));
  const n1 = { ts: "t3", command: "start", ticket: "C", hash_alg: "sha256", prev_event_hash: migHash };
  const n2 = { ts: "t4", command: "start", ticket: "D", hash_alg: "sha256", prev_event_hash: coord289Sha256(coord289Ss(n1)) };

  return { events: [legacy, s1, s2, mig, n1, n2], fingerprint, key, pubPem, sha1Head, payload, signature, mig };
}

function writeFixtureJournal(logPath, events) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("COORD-289: a mixed-era journal (pre-chain + sha1 + migration + sha256) verifies ok", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    writeFixtureJournal(logPath, events);
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, true, "mixed-era chain verifies");
    assert.equal(chain.preChainCount, 1);
    assert.equal(chain.sha1ChainedCount, 2, "two sha1-era chained events");
    assert.equal(chain.sha256ChainedCount, 3, "migration + 2 post-migration are sha256-era");
    assert.equal(chain.migrationIndex, 3, "migration boundary at event #3");
    assert.equal(chain.headAlg, "sha256", "head is in the sha256 era");
  });
});

test("COORD-289: tamper in the SHA-1 era is detected", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    const tampered = events.map((e, i) => (i === 2 ? { ...e, ticket: "B-TAMPERED" } : e));
    writeFixtureJournal(logPath, tampered);
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false, "sha1-era body tamper breaks the chain");
    assert.ok(chain.broken.some((b) => b.reason === "prev-hash-mismatch"));
  });
});

test("COORD-289: tamper in the SHA-256 era is detected", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    // Tamper a NON-tail sha256 event (event #4) so the next event's sha256 link breaks.
    const tampered = events.map((e, i) => (i === 4 ? { ...e, ticket: "C-TAMPERED" } : e));
    writeFixtureJournal(logPath, tampered);
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false, "sha256-era body tamper breaks the chain");
    assert.ok(chain.broken.some((b) => b.reason === "prev-hash-mismatch"));
  });
});

test("COORD-289: tampering the migration event's sha1_chain_head is detected", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    const tampered = events.map((e, i) =>
      i === 3 ? { ...e, details: { ...e.details, sha1_chain_head: "deadbeef" } } : e
    );
    writeFixtureJournal(logPath, tampered);
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.ok(chain.broken.some((b) => b.reason === "migration-sha1-head-mismatch"));
  });
});

test("COORD-289: tampering the migration signature value is detected", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    const tampered = events.map((e, i) =>
      i === 3
        ? {
            ...e,
            details: {
              ...e.details,
              signature: { ...e.details.signature, value: Buffer.from("x".repeat(64)).toString("base64") },
            },
          }
        : e
    );
    writeFixtureJournal(logPath, tampered);
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.ok(chain.broken.some((b) => b.reason === "migration-signature-invalid"));
  });
});

test("COORD-289: a forged migration signature is rejected under a configured trust anchor", () => {
  withJournalSandbox(({ logPath }) => {
    const genuine = buildMixedEraFixture();
    // Attacker re-signs the SAME payload with their OWN key, embeds their own
    // public key, AND re-links the downstream sha256 events so the chain is
    // internally self-consistent (the strongest forgery).
    const attacker = crypto.generateKeyPairSync("ed25519");
    const attackerPub = attacker.publicKey.export({ type: "spki", format: "pem" });
    const forgedSig = chainSign.signTransition(genuine.payload, attacker.privateKey, attackerPub);
    const migF = { ...genuine.mig, details: { ...genuine.mig.details, signature: forgedSig } };
    const migFHash = coord289Sha256(coord289Ss(migF));
    const n1F = { ...genuine.events[4], prev_event_hash: migFHash };
    const n2F = { ...genuine.events[5], prev_event_hash: coord289Sha256(coord289Ss(n1F)) };
    const forgedEvents = [genuine.events[0], genuine.events[1], genuine.events[2], migF, n1F, n2F];
    writeFixtureJournal(logPath, forgedEvents);

    // WITHOUT a trust anchor: integrity holds (self-signed) — the community path
    // is preserved and verify is HONEST that it cannot vouch for authenticity.
    assert.equal(__testing.verifyGovernanceChain().ok, true, "self-consistent forgery passes without an anchor");
    // WITH the genuine signer pinned: the forged signer is untrusted -> rejected.
    const anchored = __testing.verifyGovernanceChain(undefined, { trustAnchors: [genuine.fingerprint] });
    assert.equal(anchored.ok, false, "forged signer rejected under the configured trust anchor");
    assert.ok(anchored.broken.some((b) => b.reason === "migration-signature-untrusted"));
  });
});

test("COORD-289: the genuine migration signature verifies under its trust anchor", () => {
  withJournalSandbox(({ logPath }) => {
    const { events, fingerprint } = buildMixedEraFixture();
    writeFixtureJournal(logPath, events);
    const anchored = __testing.verifyGovernanceChain(undefined, { trustAnchors: [fingerprint] });
    assert.equal(anchored.ok, true, "genuine signer is trusted under its own anchor");
  });
});

test("COORD-289: BACK-COMPAT — a pre-migration journal appends byte-identically (SHA-1)", () => {
  // An untouched (pre-migration) repo must behave EXACTLY as before: no hash_alg
  // field, sha1 link, byte-identical stored lines.
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent({
      ts: "2026-06-10T00:00:00.000Z", command: "start", ticket: "T-1",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    __testing.appendGovernanceEvent({
      ts: "2026-06-10T00:01:00.000Z", command: "start", ticket: "T-2",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    for (const rec of lines) {
      assert.equal(Object.prototype.hasOwnProperty.call(rec, "hash_alg"), false, "no hash_alg field pre-migration");
    }
    assert.equal(lines[0].prev_event_hash, "genesis");
    // Second event links via sha1 of the first stored record.
    assert.equal(lines[1].prev_event_hash, coord289Sha1(coord289Ss(lines[0])));
    assert.equal(lines[1].prev_event_hash.length, 40, "sha1 link (40 hex)");
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.ok, true);
    assert.equal(chain.headAlg, "sha1");
    assert.equal(chain.sha256ChainedCount, 0, "dormant: no sha256 era until the verb runs");
    assert.equal(chain.migrationIndex, null);
  });
});

test("COORD-289: the migration verb appends a signed bridge event then post-migration appends are sha256", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      __testing.appendGovernanceEvent({
        ts: `2026-06-10T00:0${i}:00.000Z`, command: "start", ticket: `T-${i}`,
        before_status: null, after_status: null, identity: null, changed_paths: [],
      });
    }
    const pre = __testing.verifyGovernanceChain();
    assert.equal(pre.headAlg, "sha1");

    // DRY-RUN writes nothing.
    const dry = __testing.migrateGovernanceChainHash({ confirm: false });
    assert.equal(dry.status, "dry-run");
    assert.equal(dry.sha1_chain_head, pre.head);
    assert.equal(__testing.verifyGovernanceChain().migrationIndex, null, "dry-run wrote nothing");

    // APPLY appends the signed bridge.
    const res = __testing.migrateGovernanceChainHash({ confirm: true, identity: null });
    assert.equal(res.status, "migrated");
    assert.equal(res.head_alg, "sha256");
    assert.equal(res.sha1_chain_head, pre.head, "bridge roots at the old sha1 head");

    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const mig = lines[3];
    assert.equal(mig.command, "hash-alg-migration");
    assert.equal(mig.hash_alg, "sha256");
    assert.equal(mig.prev_event_hash, pre.head, "SHA-1 bridge link to the prior tip");
    assert.equal(mig.prev_event_hash.length, 40, "bridge link is sha1");
    assert.equal(mig.details.sha1_chain_head, pre.head);
    assert.equal(mig.details.verifier_version, "coord-289-sha256-v1");
    assert.ok(mig.details.signature && mig.details.signature.value, "carries an ed25519 signature");
    assert.equal(mig.details.signature.algorithm, "ed25519");

    // A post-migration append is stamped sha256 + linked via sha256(migration).
    __testing.appendGovernanceEvent({
      ts: "2026-06-10T01:00:00.000Z", command: "start", ticket: "T-post",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    const after = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const post = after[4];
    assert.equal(post.hash_alg, "sha256");
    assert.equal(post.prev_event_hash, coord289Sha256(coord289Ss(mig)), "links via sha256 of the migration checkpoint");
    assert.equal(post.prev_event_hash.length, 64, "sha256 link (64 hex)");
    assert.equal(__testing.verifyGovernanceChain().ok, true);
  });
});

test("COORD-289: a second migration is refused (idempotent)", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    __testing.appendGovernanceEvent({
      ts: "2026-06-10T00:00:00.000Z", command: "start", ticket: "T-1",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    const first = __testing.migrateGovernanceChainHash({ confirm: true, identity: null });
    assert.equal(first.status, "migrated");
    const second = __testing.migrateGovernanceChainHash({ confirm: true, identity: null });
    assert.equal(second.status, "already-migrated", "double migration refused");
    // Exactly ONE migration event in the log.
    const migs = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((e) => e.command === "hash-alg-migration");
    assert.equal(migs.length, 1);
  });
});

test("COORD-289: the migration verb refuses a chain that does not verify", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    // Corrupt a NON-tail sha1-era event so the next event's prev-link breaks (a
    // genuine break), and strip the migration so the precondition (not the
    // idempotency guard) is what fails.
    const broken = [events[0], { ...events[1], ticket: "TAMPER" }, events[2]];
    writeFixtureJournal(logPath, broken);
    assert.throws(
      () => __testing.migrateGovernanceChainHash({ confirm: true, identity: null }),
      /does not currently verify/
    );
  });
});

test("COORD-289: chain repair within the sha256 era holds the content multiset across eras", () => {
  withJournalSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    // Cross a sha256-era link (event #5's prev) so the chain is broken but the
    // bodies are intact — exactly the crossed-link case repair is meant to heal.
    const crossed = events.map((e, i) => (i === 5 ? { ...e, prev_event_hash: "f".repeat(64) } : e));
    writeFixtureJournal(logPath, crossed);
    assert.equal(__testing.verifyGovernanceChain().ok, false, "crossed sha256 link is broken");

    const result = __testing.repairGovernanceChain({
      confirm: true,
      reason: "COORD-289 era-aware repair test",
      identity: null,
    });
    assert.equal(result.status, "repaired");
    assert.equal(__testing.verifyGovernanceChain().ok, true, "repair re-links the sha256 era");
    // The repaired chain still presents both eras correctly.
    const chain = __testing.verifyGovernanceChain();
    assert.equal(chain.headAlg, "sha256");
    assert.ok(chain.sha256ChainedCount >= 3);
  });
});
