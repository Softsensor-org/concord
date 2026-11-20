const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");

const {
  GovernanceError,
  executeCommand,
  __testing,
  withJournalSandbox,
  withGovernedSurfaceSandbox,
  withCleanRuntimeFixture,
  sandboxProcessRuntimeLocks,
  withScopedGovernanceTestContext,
} = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { stableIdempotencyKey } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/idempotency.js"));
const governanceCommands = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js")).commands;
const createJournal = require("./journal.js");
const createGovernanceBoardState = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-board-state.js"));
const createChainTransitionSigner = require("./chain-transition-signer.js");
const createConformanceAttestation = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-attestation.js"));
const createConformanceVerbs = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-verbs.js"));
const createEnginePin = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/engine-pin.js"));
const { signTransition } = require("./chain-migration-signing.js");
const createQuestions = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/questions.js"));
const stateIo = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/state-io.js"));
const createGovernanceRepair = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-repair.js"));
const { COORD_DIR, state: journalState, withGovernanceRuntimeLock } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const questionWriter = createQuestions({
  state: journalState,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  classifyQuestionOperationalType: createGovernanceRepair({}).classifyQuestionOperationalType,
  uniqueStrings: (values) => [...new Set(values)],
  todayIso: () => new Date().toISOString().slice(0, 10),
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
});
const sessionDiagnostics = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-session.js"))({}).formatGovernanceJournalUninitializedMessage;
const { signChainTransition } = createChainTransitionSigner({
  coordDir: COORD_DIR,
  resolveRuntimeDir: () => journalState.RUNTIME_DIR,
  createConformanceAttestation,
  signTransition,
});
const warningDriftPrefixes = [".runtime/agent_sessions.json", ".runtime/session-threads/"];
const boardStateProjection = createGovernanceBoardState({});
// This owner build uses the same live context and real filesystem, lock and IO
// seams as the composition root; the pure table classifier is kept local to the
// test so the journal module's own behavior remains directly exercised.
const journalOwner = createJournal({
  fail: (message) => { throw new GovernanceError(message); },
  relativeCoordPath: (filePath) => path.relative(COORD_DIR, filePath).replace(/\\/g, "/"),
  existingLockDirs: () => [journalState.LOCKS_DIR, journalState.LEGACY_LOCKS_DIR],
  writeFileAtomicSync: stateIo.writeFileAtomicSync,
  readJsonFileState: stateIo.readJsonFileState,
  formatJsonFileIssue: stateIo.formatJsonFileIssue,
  readLastNonEmptyLine: stateIo.readLastNonEmptyLine,
  withGovernanceRuntimeLock,
  readCanonicalTextFile: stateIo.readCanonicalTextFile,
  writeCanonicalTextFile: stateIo.writeCanonicalTextFile,
  buildQuestionRow: questionWriter.buildQuestionRow,
  appendQuestionRowText: questionWriter.appendQuestionRowText,
  parseQuestionRow: questionWriter.parseQuestionRow,
  escapeTable: (value) => String(value || "").replace(/\|/g, "\\|"),
  ensureCurrentAgentIdentity: () => null,
  resolveEffectiveThreadId: () => null,
  readAgentSessions: (options = {}) => stateIo.readJsonArrayFileOrFail(journalState.AGENT_SESSIONS_PATH, "agent sessions file"),
  readCanonicalJsonFile: stateIo.readCanonicalJsonFile,
  getRows: boardStateProjection.getRows,
  formatGovernanceJournalUninitializedMessage: sessionDiagnostics,
  splitGovernanceProvenanceDrift: (files) => ({
    warnings: files.filter((file) => warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
    blocking: files.filter((file) => !warningDriftPrefixes.some((prefix) => String(file).startsWith(prefix))),
  }),
  signChainTransition,
  GovernanceError,
});

// COORD-300: redirect this worker's coarse directory locks + memory to a per-process
// os.tmpdir() sandbox (the LIGHT helper — it intentionally leaves RUNTIME_DIR /
// PLAN_RECORDS_DIR alone so the per-test withJournalSandbox layers on top and the
// path-classification tests still see the real configured layout). Combined with the
// lifecycle.js resolveRuntimeDir wiring, `gov conform`'s lazily-generated
// .runtime/conformance-keys now follow the per-test RUNTIME_DIR sandbox instead of
// the live tree, letting journal.test.js leave the test-isolation-guard allowlist.
sandboxProcessRuntimeLocks();

test("COORD-678: doctor provenance diagnostics distinguish an uninitialized journal from warning-only ledger drift", () => {
  withJournalSandbox(() => {
    const errors = [];
    const warnings = [];
    journalOwner.appendGovernanceProvenanceIssues(errors, warnings);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /journal is uninitialized|uninitialized/i);
    assert.deepEqual(warnings, []);
  });

  withGovernedSurfaceSandbox(({ tempDir }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord678-journal-warning-"));
    const runtime = path.join(root, ".runtime");
    const snapshots = path.join(runtime, "governance-snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    const keys = ["BOARD_PATH", "PLAN_PATH", "QUESTIONS_PATH", "AGENTS_PATH", "AGENT_SESSIONS_PATH",
      "PLAN_RECORDS_DIR", "PROMPTS_DIR", "RENDERED_DIR", "RUNTIME_DIR", "GOVERNANCE_EVENT_LOG_PATH",
      "GOVERNANCE_SNAPSHOT_PATH", "GOVERNANCE_SNAPSHOTS_DIR"];
    const original = Object.fromEntries(keys.map((key) => [key, journalState[key]]));
    Object.assign(journalState, {
      BOARD_PATH: path.join(root, "board.json"), PLAN_PATH: path.join(root, "PLAN.md"),
      QUESTIONS_PATH: path.join(root, "QUESTIONS.md"), AGENTS_PATH: path.join(root, "agents.json"),
      AGENT_SESSIONS_PATH: path.join(runtime, "agent_sessions.json"), PLAN_RECORDS_DIR: path.join(root, "plans"),
      PROMPTS_DIR: path.join(root, "prompts"), RENDERED_DIR: path.join(root, "rendered"), RUNTIME_DIR: runtime,
      GOVERNANCE_EVENT_LOG_PATH: path.join(runtime, "governance-events.ndjson"),
      GOVERNANCE_SNAPSHOT_PATH: path.join(runtime, "governance-latest-snapshot.json"),
      GOVERNANCE_SNAPSHOTS_DIR: snapshots,
    });
    for (const file of [journalState.BOARD_PATH, journalState.PLAN_PATH, journalState.QUESTIONS_PATH,
      journalState.AGENTS_PATH, journalState.AGENT_SESSIONS_PATH]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file === journalState.AGENT_SESSIONS_PATH ? "[]\n" : "fixture\n");
    }
    const relative = (file) => path.relative(root, file).split(path.sep).join("/");
    const readState = (file) => {
      if (!fs.existsSync(file)) return { exists: false, value: null, error: null };
      try { return { exists: true, value: JSON.parse(fs.readFileSync(file, "utf8")), error: null }; }
      catch (error) { return { exists: true, value: null, error }; }
    };
    const configuredJournal = createJournal({
      existingLockDirs: () => [], relativeCoordPath: relative, readJsonFileState: readState,
      readLastNonEmptyLine: (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").at(-1) : "",
      formatJsonFileIssue: (_file, _label, result) => String(result.error),
      formatGovernanceJournalUninitializedMessage: () => "Governance journal is uninitialized.",
      formatGovernanceDriftMessage: (_event, files) => `blocking drift: ${files.join(",")}`,
      splitGovernanceProvenanceDrift: (files) => ({
        warnings: files.filter((file) => file === ".runtime/agent_sessions.json"),
        blocking: files.filter((file) => file !== ".runtime/agent_sessions.json"),
      }),
      fail: (message) => { throw new Error(message); },
    });
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const snapshot = configuredJournal.buildGovernanceSnapshot();
      fs.writeFileSync(path.join(snapshots, `${snapshot.digest}.json`), JSON.stringify(snapshot));
      fs.writeFileSync(journalState.GOVERNANCE_SNAPSHOT_PATH, JSON.stringify({ digest: snapshot.digest }));
      fs.writeFileSync(journalState.GOVERNANCE_EVENT_LOG_PATH, JSON.stringify({
        ts: "2026-10-12T00:00:00.000Z", command: "journal-baseline", snapshot_digest: snapshot.digest,
      }) + "\n");
      fs.writeFileSync(journalState.AGENT_SESSIONS_PATH, JSON.stringify([{ session_id: "fixture", status: "active" }]) + "\n");
      const errors = [];
      const warnings = [];
      configuredJournal.appendGovernanceProvenanceIssues(errors, warnings);
      assert.deepEqual(errors, [], "session-ledger drift is warning-class, not blocking");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Non-material governance drift/);
      assert.match(warnings[0], /agent_sessions\.json/);

      // A legacy or incomplete latest event may have no timestamp. The warning
      // remains useful and explicit without inventing an event time.
      fs.writeFileSync(journalState.GOVERNANCE_EVENT_LOG_PATH, JSON.stringify({
        command: "journal-baseline", snapshot_digest: snapshot.digest,
      }) + "\n");
      const timestampFallbackWarnings = [];
      configuredJournal.appendGovernanceProvenanceIssues([], timestampFallbackWarnings);
      assert.equal(timestampFallbackWarnings.length, 1);
      assert.match(timestampFallbackWarnings[0], /since unknown time/);
    } finally {
      for (const key of keys) journalState[key] = original[key];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// COORD-090: local helper for the relocated crash-recovery tests below.
function seedCheckpointEvent() {
  journalOwner.appendGovernanceEvent({
    ts: "2026-06-10T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "test" },
    changed_paths: [],
    snapshot: journalOwner.buildGovernanceSnapshot(),
  });
}

test("COORD-033: writeFileAtomicSync replaces the target and leaves no temp files", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord032-atomic-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
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
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "claim");
  });
});

test("COORD-033: readGovernanceEventLog still fails closed on mid-file corruption", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `not-json-mid-file\n${good}\n`, "utf8");
    assert.throws(() => journalOwner.readGovernanceEventLog(), GovernanceError);
  });
});

test("COORD-033: readLatestGovernanceEvent falls back past a torn tail", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `${good}\n{"torn`, "utf8");
    const latest = journalOwner.readLatestGovernanceEvent();
    assert.equal(latest.command, "claim");
  });
});

test("COORD-033: appendGovernanceEvent repairs a torn tail and journals the repair", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const good = JSON.stringify({ ts: "2026-06-10T00:00:00.000Z", command: "claim", ticket: "T-1" });
    fs.writeFileSync(logPath, `${good}\n{"ts":"2026-06-10T00:01:00.000Z","comm`, "utf8");
    journalOwner.appendGovernanceEvent({
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

  const ignored = journalOwner.gitIgnoredDriftPaths(
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
  const ignored = journalOwner.gitIgnoredDriftPaths(
    [".runtime/agent_sessions.json", "board/tasks.json", "PLAN.md"],
    failingRunner
  );
  assert.deepEqual([...ignored].sort(), [".runtime/agent_sessions.json"]);

  const erroringRunner = () => ({ error: new Error("spawn ENOENT") });
  const ignoredOnError = journalOwner.gitIgnoredDriftPaths(
    [".runtime/session-threads/a44.json", "rendered/TASKS.md"],
    erroringRunner
  );
  assert.deepEqual([...ignoredOnError].sort(), [".runtime/session-threads/a44.json"]);
});

test("detectGovernanceProvenanceDrift reports an uninitialized journal without mutating state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-journal-uninitialized-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(tempDir, "locks");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    const drift = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, true);
    assert.equal(fs.existsSync(eventLogPath), false);
  });
});

test("detectGovernanceProvenanceDrift ignores legacy snapshots that predate QUESTIONS.md tracking", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-journal-compat-"));
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    const fileEntries = journalOwner.collectGovernedSnapshotFilePaths()
      .filter((filePath) => filePath !== questionsPath)
      .map((filePath) => {
        const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
        return {
          path: path.relative(COORD_ROOT_DIR, filePath).replace(/\\/g, "/"),
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

    const drift = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.deepEqual(drift.drift, []);
  });
});

test("detectGovernanceProvenanceDrift resolves compact snapshot artifacts referenced by the latest event", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-journal-compact-"));
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: snapshotsDir,
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    const fileEntries = journalOwner.collectGovernedSnapshotFilePaths().map((filePath) => {
      const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
      return {
        path: path.relative(COORD_ROOT_DIR, filePath).replace(/\\/g, "/"),
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

    const drift = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.deepEqual(drift.drift, []);
    assert.equal(journalOwner.readLatestGovernanceEvent().snapshot, undefined);
  });
});

test("withGovernanceMutation records failed external side-effect mutations after rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-external-failure-"));
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: snapshotsDir,
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
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
  });
});

test("withGovernanceMutation restores governed files when a mutation fails after writing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-rollback-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  // COORD-606: QUESTIONS_PATH must be sandboxed too. collectGovernedSnapshotFilePaths()
  // includes it in the rollback snapshot, so leaving it un-overridden made this test
  // RESTORE the live coord/QUESTIONS.md — invisible only because the bytes were
  // unchanged. The widened isolation guard (governed-state class) blocks that write.
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const recordsDir = path.join(tempDir, "plans");
  const promptsDir = path.join(tempDir, "prompts");
  const renderedDir = path.join(tempDir, "rendered");
  const locksDir = path.join(tempDir, "locks");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(planPath, "baseline plan\n");
  fs.writeFileSync(questionsPath, "# Questions\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(path.join(promptsDir, "tickets", "IMP-100.md"), "# baseline prompt\n", "utf8");
  fs.writeFileSync(path.join(renderedDir, "TASKS.md"), "# baseline rendered\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    // COORD-273: this surface intentionally seeds existing coordination state
    // (prompt + rendered artifacts). Anchor the journal baseline explicitly so the
    // rollback mutation below runs over an INITIALIZED journal — the new
    // journal-loss-over-existing-state guard only fires on an ABSENT journal, and a
    // deliberate baseline here mirrors a healthy repo. The single baseline event is
    // exactly what the post-rollback assertions expect.
    journalOwner.ensureGovernanceJournalBaseline("test-seed");
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

    const journal = fs.readFileSync(eventLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].command, "journal-baseline");
  });
});

test("withGovernanceMutation validates the captured after-snapshot before appending", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    journalOwner.ensureGovernanceJournalBaseline("seed before-snapshot validator fixture");
    const boardBefore = fs.readFileSync(boardPath);
    const journalBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
    let observed = false;
    assert.throws(() => __testing.withGovernanceMutation({
      command: "fixture-after-snapshot-refusal",
      forceLog: true,
      validateAfterSnapshot(before, after) {
        observed = true;
        assert.notEqual(before.digest, after.digest, "validator sees the post-mutation snapshot");
        throw new Error("fixture after-snapshot refusal");
      },
    }, () => fs.writeFileSync(boardPath, "unapproved board bytes\n")), /fixture after-snapshot refusal/);
    assert.equal(observed, true);
    assert.deepEqual(fs.readFileSync(boardPath), boardBefore, "validator refusal rolls governed bytes back");
    assert.equal(fs.existsSync(logPath), journalBefore !== null);
    if (journalBefore) assert.deepEqual(fs.readFileSync(logPath), journalBefore, "validator refusal appends no journal event");
  });
});

test("withGovernanceMutation proactively expires stale agent sessions before running the mutation body", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-expire-sessions-"));
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
  const staleSeenAt = "2026-03-29T00:00:00.000Z";
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    __testing.withGovernanceMutation({ command: "test-mutation", forceLog: true }, () => {});
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(sessions[0].status, "expired");
    assert.ok(sessions[0].released_at);
  });
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

  assert.deepEqual(journalOwner.diffGovernanceSnapshots(left, right), [
    ".runtime/locks/IMP-311.lock",
    ".runtime/locks/IMP-312.lock",
    "board/tasks.json",
  ]);
});

test("withGovernanceMutation records unrelated governance drift to QUESTIONS and continues", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-drift-note-"));
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
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "baseline plan\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});

    // Runtime registry drift remains reportable. PLAN.md and QUESTIONS.md are
    // protected content after COORD-668, not examples of harmless drift.
    fs.writeFileSync(agentsPath, JSON.stringify([{ note: "runtime drift" }]), "utf8");
    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "submit", ticket: "IMP-311" }, () => {})
    );

    const questions = fs.readFileSync(questionsPath, "utf8");
    assert.match(questions, /Governance drift observed while running submit IMP-311:/);
    assert.match(questions, /delegated reconciliation to orchestrator/i);

    const journal = fs.readFileSync(eventLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = journal[journal.length - 1];
    assert.equal(event.command, "submit");
    assert.deepEqual(event.details.preexisting_drift, [path.relative(COORD_ROOT_DIR, agentsPath).replace(/\\/g, "/")]);
    assert.equal(event.details.preexisting_drift_logged_to_questions, true);
    assert(event.changed_paths.some((p) => p.endsWith("QUESTIONS.md")), "the generated note itself is inside the transaction");
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  });
});

test("withGovernanceMutation records QUESTIONS.md edits in changed_paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-questions-log-"));
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
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
    const relativeQuestionsPath = path.relative(COORD_ROOT_DIR, questionsPath).replace(/\\/g, "/");
    assert.equal(event.command, "log-question");
    assert.equal(event.changed_paths.includes(relativeQuestionsPath), true);
  });
});

test("extractDriftSinceTimestamp parses the canonical drift-note answer", () => {
  const ts = journalOwner.extractDriftSinceTimestamp(
    "Detected unjournaled governed-state drift since 2026-04-14T10:00:00.000Z. Continued gov start and delegated reconciliation to orchestrator."
  );
  assert.equal(ts, "2026-04-14T10:00:00.000Z");
  assert.equal(journalOwner.extractDriftSinceTimestamp("unrelated"), null);
  assert.equal(
    journalOwner.extractDriftSinceTimestamp("Detected unjournaled governed-state drift since bogus."),
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

  const plan = journalOwner.planStaleDriftNoteRetirement({
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

  const missingBaseline = journalOwner.planStaleDriftNoteRetirement({ questionsText: text, latestBaselineTs: null });
  assert.equal(missingBaseline.changed, false);
  assert.equal(missingBaseline.retired.length, 0);

  const olderBaseline = journalOwner.planStaleDriftNoteRetirement({
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
    const events = journalOwner.readGovernanceEventLog();
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
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events.some((event) => event.command === "crash-rollback"), false);
  });
});

test("COORD-722: crash recovery on an uninitialized journal restores a metadata-less restore point and journals null provenance", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    // No checkpoint event: the journal is uninitialized, so the restore cannot be
    // proven redundant and must run; there is no drift list to report.
    const originalBoardRaw = fs.readFileSync(boardPath, "utf8");
    const files = __testing.captureGovernanceRestorePoint();
    fs.mkdirSync(path.dirname(__testing.governanceRestorePointPath()), { recursive: true });
    // A restore point written without command, ticket or ts metadata.
    fs.writeFileSync(__testing.governanceRestorePointPath(), JSON.stringify({ files }), "utf8");
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "broken" }] }), "utf8");
    assert.equal(journalOwner.readGovernanceEventLog().length, 0);

    const outcome = __testing.recoverCrashedGovernanceMutation();

    assert.deepEqual(outcome, { action: "restored", interruptedCommand: null });
    assert.equal(fs.readFileSync(boardPath, "utf8"), originalBoardRaw);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.command, "crash-rollback");
    assert.equal(event.result, "restored");
    assert.equal(event.ticket, null);
    assert.deepEqual(event.details, { interrupted_command: null, interrupted_at: null, drifted_paths: null });
  });
});

test("COORD-722: crash recovery of a restore point without a files list treats every governed file as absent at capture", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    fs.mkdirSync(path.dirname(__testing.governanceRestorePointPath()), { recursive: true });
    fs.writeFileSync(__testing.governanceRestorePointPath(), JSON.stringify({ command: "land", ticket: "T-9" }), "utf8");
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "broken" }] }), "utf8");

    const outcome = __testing.recoverCrashedGovernanceMutation();

    assert.deepEqual(outcome, { action: "restored", interruptedCommand: "land" });
    // No captured entries means no governed file existed when the verb began, so
    // the restore removes the file the interrupted verb created.
    assert.equal(fs.existsSync(boardPath), false);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const events = journalOwner.readGovernanceEventLog();
    assert.deepEqual(events.map((event) => [event.command, event.ticket]), [["crash-rollback", "T-9"]]);
    assert.equal(events[0].details.interrupted_command, "land");
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

// COORD-595: replay of the COORD-477 closeout incident (2026-07-31). The journal
// snapshots prove the landed-notice append was never at fault: a `doctor-fix`
// left a persisted restore point at 05:48:15Z, a then-UNJOURNALED `gov
// log-question` appended the COORD-476 repo_gates row at ~05:51Z, and the next
// governed mutation (05:53:33Z `crash-rollback`, drifted_paths PLAN.md +
// QUESTIONS.md) restored QUESTIONS.md to the pre-row bytes. `gov land COORD-477`
// then appended correctly to a file that had already lost the row. COORD-668 made
// log-question a journaled mutation, so crash recovery now runs BEFORE the row is
// written. This test fails if a sanctioned question writer ever again appends
// outside a governed mutation while a crash restore point is pending.
test("COORD-595: a pending crash restore point is recovered before a sanctioned question row is appended, so consecutive closeout rows all survive", () => {
  withGovernedSurfaceSandbox(({ logPath, questionsPath, planPath }) => {
    const landed476 = "| 2026-07-31 | claudea11 | all | COORD-476 landed through governance. | Merged and closed via gov land COORD-476. | yes |";
    const landed477 = "| 2026-07-31 | claudea284 | all | COORD-477 landed through governance. | Merged and closed via gov land COORD-477. | yes |";
    fs.writeFileSync(
      questionsPath,
      `# Questions\n\n| Date | From | To | Question | Answer | Resolved |\n|---|---|---|---|---|---|\n${landed476}\n\n## Instructions\n`,
      "utf8"
    );
    journalOwner.ensureGovernanceJournalBaseline("COORD-595 fixture");
    const planBefore = fs.readFileSync(planPath, "utf8");

    // The interrupted doctor-fix: restore point persisted, one governed file
    // half-written, process gone before journaling or clearing the restore point.
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "doctor-fix" });
    fs.writeFileSync(planPath, `${planBefore}half-written by the interrupted doctor-fix\n`, "utf8");

    // The sanctioned row that was lost in production.
    const logged = executeCommand([
      "log-question", "--from", "claudea11", "--to", "orchestrator",
      "--question", "COORD-476 governance issue resolved: repo_gates",
      "--answer", "Recorded executed gates via update-plan.", "--resolved", "yes",
    ]);
    assert.equal(logged.ok, true, logged.error);

    // The next ticket's closeout appends its landed notice in a governed mutation.
    __testing.withGovernanceMutation({ command: "land", forceLog: true }, () => {
      questionWriter.appendQuestionRowText(landed477);
    });

    const lines = fs.readFileSync(questionsPath, "utf8").split("\n");
    const at = (needle) => lines.findIndex((line) => line.includes(needle));
    const first = at("COORD-476 landed through governance.");
    const second = at("COORD-476 governance issue resolved: repo_gates");
    const third = at("COORD-477 landed through governance.");
    assert.ok(first !== -1, "the prior landed notice survived");
    assert.ok(second !== -1, "the resolved repo_gates row survived the crash rollback and the next landing");
    assert.ok(third !== -1, "the new landed notice was appended");
    assert.ok(first < second && second < third, "rows stay in append order");
    assert.ok(third < at("## Instructions"), "rows stay inside the table");
    for (const needle of ["COORD-476 landed through governance.", "repo_gates", "COORD-477 landed through governance."]) {
      assert.equal(lines.filter((line) => line.includes(needle)).length, 1, `${needle} appears exactly once`);
    }

    assert.equal(fs.readFileSync(planPath, "utf8"), planBefore, "the interrupted mutation's partial write was rolled back");
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const commands = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).command);
    assert.equal(commands.filter((command) => command === "crash-rollback").length, 1);
    assert.ok(
      commands.indexOf("crash-rollback") < commands.indexOf("log-question"),
      "the rollback is journaled before the question row is written, never after it"
    );
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  });
});


// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


test("collectGovernedSnapshotFilePaths includes QUESTIONS.md in the governed surface", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-snapshot-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "locks"),
  }, () => {
    const ignored = path.join(recordsDir, "draft.txt");
    fs.writeFileSync(ignored, "incomplete plan");
    const files = journalOwner.collectGovernedSnapshotFilePaths();
    assert.equal(files.includes(questionsPath), true);
    assert.equal(files.includes(ignored), false);
  });
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    // First append on a fresh log anchors at genesis; subsequent events link
    // to the canonical hash of the prior stored record.
    assert.equal(events[0].prev_event_hash, "genesis");
    assert.equal(events[1].prev_event_hash, journalOwner.hashGovernanceEventRecord(events[0]));
    const chain = journalOwner.verifyGovernanceChain(events);
    assert.equal(chain.ok, true);
    assert.equal(chain.chainedCount, 2);
    assert.equal(chain.preChainCount, 0);
    assert.equal(chain.head, journalOwner.hashGovernanceEventRecord(events[1]));
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("post-migration", "2026-06-10T00:00:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events.length, 4);
    assert.equal(events[0].command, "legacy-1");
    assert.equal(events[1].command, "legacy-2");
    assert.equal(events[2].command, "chain-anchor");
    assert.equal(events[2].prev_event_hash, "genesis");
    assert.equal(events[2].details.reason, "legacy-pre-chain-migration");
    assert.equal(events[3].command, "post-migration");
    assert.equal(events[3].prev_event_hash, journalOwner.hashGovernanceEventRecord(events[2]));
    // Legacy events are accepted-but-unverified; chain verifies clean.
    const chain = journalOwner.verifyGovernanceChain(events);
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
    const chain = journalOwner.verifyGovernanceChain();
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    // Tamper: flip a field of the MIDDLE event on disk (its hash now differs, so
    // the NEXT event's prev_event_hash no longer matches).
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.ticket = "INJECTED-666";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.broken.length >= 1, true);
    assert.equal(chain.broken[0].reason, "prev-hash-mismatch");
  });
});

test("ENT-002: verifyGovernanceChain detects a reordered chained event", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // Swap the last two events.
    [lines[1], lines[2]] = [lines[2], lines[1]];
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.ok, false);
  });
});

test("ENT-002: verifyGovernanceChain detects a dropped chained event", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    // Drop the middle event; gamma's prev_event_hash now points at a missing link.
    lines.splice(1, 1);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.broken[0].reason, "prev-hash-mismatch");
  });
});

test("ENT-002: gov conform reports a pass verdict + chain head on a clean journal (read-only)", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    // Simulate a crash mid-append: a torn (unparseable) trailing line.
    fs.appendFileSync(logPath, '{"ts":"2026-06-10T00:02:00.000Z","comm', "utf8");
    // The next append repairs the torn tail (emitting an auditable repair marker
    // that re-anchors the chain) and chains the new event off it.
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:03:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    const repair = events.find((e) => e.command === "journal-tail-repair");
    assert.ok(repair, "expected a journal-tail-repair marker");
    assert.equal(repair.details.reanchored, true);
    assert.equal(typeof repair.prev_event_hash, "string");
    // The legitimately-repaired tail verifies clean — NOT a tamper signal.
    const chain = journalOwner.verifyGovernanceChain(events);
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
  let prev = journalOwner.CHAIN_GENESIS_PREV || "genesis";
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
    prev = journalOwner.hashGovernanceEventRecord(record);
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
    const chainBefore = journalOwner.verifyGovernanceChain();
    assert.equal(chainBefore.ok, false);

    const result = journalOwner.repairGovernanceChain({ confirm: false });
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
  withGovernedSurfaceSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    events[5].prev_event_hash = "cafebabe".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    const originalRaw = fs.readFileSync(logPath, "utf8");
    const brokenCount = journalOwner.verifyGovernanceChain().broken.length;

    const result = journalOwner.repairGovernanceChain({
      confirm: true,
      reason: "concurrent governed appends crossed prev_event_hash",
      ts: "2026-06-12T00:00:00.000Z",
      identity: { agent: { id: "a99", handle: "claudea99" }, session: { session_id: "a99-x" } },
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.applied, true);
    assert.equal(result.broken_link_count, brokenCount);

    // The re-linked chain now verifies clean.
    const after = journalOwner.readGovernanceEventLog();
    const chain = journalOwner.verifyGovernanceChain(after);
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

    // A timestamped backup sidecar preserves the ORIGINAL broken journalOwner.
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
    const chain = journalOwner.verifyGovernanceChain();
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
      prev_event_hash: journalOwner.hashGovernanceEventRecord(events[5]),
    };
    writeJournalEvents(logPath, [...events, fakeMarker]);
    assert.equal(journalOwner.verifyGovernanceChain().ok, false);
  });
});

test("COORD-124: repair-chain is a clean no-op when the chain is already valid", () => {
  withJournalSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(5);
    writeJournalEvents(logPath, events);
    const before = fs.readFileSync(logPath, "utf8");
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);

    const dry = journalOwner.repairGovernanceChain({ confirm: false });
    assert.equal(dry.status, "already-valid");
    assert.equal(dry.applied, false);

    const applied = journalOwner.repairGovernanceChain({ confirm: true, reason: "nothing to do" });
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
      () => journalOwner.repairGovernanceChain({ confirm: true, reason: "   " }),
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
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);

    // ATTACK: edit the BODY of a non-tip event in place, leaving its prev_event_hash
    // untouched. This breaks exactly the NEXT link (its successor's prev no longer
    // matches the edited record) while the rest of the chain stays self-consistent.
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[2]);
    tampered.ticket = "INJECTED-666";
    tampered.details = { seq: 2, smuggled: "payload" };
    lines[2] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

    const brokenBefore = journalOwner.verifyGovernanceChain();
    assert.equal(brokenBefore.ok, false);
    const rawBefore = fs.readFileSync(logPath, "utf8");

    // Previously this re-linked the altered event into a chain that passed verify.
    // Now it must REFUSE with a clear content-changed error.
    assert.throws(
      () =>
        journalOwner.repairGovernanceChain({
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
    assert.equal(journalOwner.verifyGovernanceChain().ok, false);
    const after = journalOwner.readGovernanceEventLog();
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
    assert.equal(journalOwner.verifyGovernanceChain().ok, false);

    assert.throws(
      () =>
        journalOwner.repairGovernanceChain({
          confirm: true,
          reason: "attempt to launder a deletion",
          ts: "2026-06-12T02:00:00.000Z",
        }),
      (error) => error instanceof GovernanceError && /re-link-ONLY|CONTENT changed/i.test(error.message)
    );
    assert.equal(fs.readFileSync(logPath, "utf8"), rawBefore);
    assert.equal(journalOwner.verifyGovernanceChain().ok, false);
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
      () => journalOwner.repairGovernanceChain({ confirm: false }),
      (error) => error instanceof GovernanceError && /re-link-ONLY|CONTENT changed/i.test(error.message)
    );
  });
});

test("COORD-274: LEGIT linkage-only break (bodies intact) still repairs + verifies", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    const events = buildValidChainedEvents(6);
    // Crossed/stale prev_event_hash links — a cascading linkage break with every
    // event BODY intact. This is the COORD-124 concurrent-append scenario.
    events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
    writeJournalEvents(logPath, events);
    assert.equal(journalOwner.verifyGovernanceChain().ok, false);

    const result = journalOwner.repairGovernanceChain({
      confirm: true,
      reason: "legit linkage re-link; bodies intact",
      ts: "2026-06-12T03:00:00.000Z",
    });
    assert.equal(result.status, "repaired");
    const after = journalOwner.readGovernanceEventLog();
    assert.equal(journalOwner.verifyGovernanceChain(after).ok, true);
    // Every original body survived the re-link (content multiset preserved).
    for (let i = 0; i < 6; i += 1) {
      assert.equal(after[i].details.seq, i);
    }
  });
});

test("COORD-274: a REAL concurrent crossing (predecessor still present) is re-linkable, not refused", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    // Model two agents reading the same tip T (=events[2]) then appending: events[3]
    // and events[4] both point their prev at T. events[5] then chains off events[4].
    // events[4]'s link is broken (isolated — events[5] still vouches for events[4]),
    // but events[4]'s attested predecessor (T) is STILL PRESENT, so this is a genuine
    // linkage crossing the repair must heal — NOT laundering.
    const events = buildValidChainedEvents(6);
    const tipHash = journalOwner.hashGovernanceEventRecord(events[2]);
    events[3].prev_event_hash = tipHash; // points at T (correct, file-order predecessor)
    events[4].prev_event_hash = tipHash; // crossed: also points at T instead of events[3]
    events[5].prev_event_hash = journalOwner.hashGovernanceEventRecord(events[4]); // vouches events[4]
    writeJournalEvents(logPath, events);

    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.ok, false);

    const result = journalOwner.repairGovernanceChain({
      confirm: true,
      reason: "concurrent-append crossing; predecessor present",
      ts: "2026-06-12T04:00:00.000Z",
    });
    assert.equal(result.status, "repaired");
    assert.equal(journalOwner.verifyGovernanceChain(journalOwner.readGovernanceEventLog()).ok, true);
  });
});

// COORD-223: governed-surface sandbox for idempotency + collision-event tests.
// Mirrors the lightweight path-redirect used by the rollback test above (no git
// scaffold needed): a temp governed surface + isolated runtime so withGovernanceMutation
// and the collision emitter operate against a clean, disposable journalOwner.
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

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    PROMPTS_DIR: promptsDir,
    DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
    RENDERED_DIR: renderedDir,
    LOCKS_DIR: locksDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    return fn({
      tempDir,
      runtimeDir,
      boardPath,
      planPath,
      questionsPath,
      recordsDir,
      promptsDir,
      renderedDir,
      snapshotPath: path.join(runtimeDir, "governance-latest-snapshot.json"),
      snapshotsDir: path.join(runtimeDir, "governance-snapshots"),
      logPath: journalState.GOVERNANCE_EVENT_LOG_PATH,
      readJournal: () =>
        fs.existsSync(journalState.GOVERNANCE_EVENT_LOG_PATH)
          ? fs.readFileSync(journalState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
              .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
          : [],
    });
  });
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
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord223-bad-"));
    const badParent = path.join(badRoot, "not-a-dir");
    fs.writeFileSync(badParent, "i am a file");
    try {
      withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOG_PATH: path.join(badParent, "events.ndjson") }, () => {
        const outcome = __testing.recordGovernanceCollision({ ticket: "IMP-1", conflictType: "stale-write-fence" });
        assert.equal(outcome.logged, false);
        assert.ok(outcome.error);
      });
    } finally {
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  });
});

test("COORD-836: default collision metadata remains queryable without ticket or identity details", () => {
  withCoord223Surface(({ readJournal }) => {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
    assert.deepEqual(__testing.recordGovernanceCollision({}), { logged: true });
    const collision = readJournal().find((entry) => entry.command === "collision-detected");
    assert.ok(collision);
    assert.equal(collision.ticket, null);
    assert.equal(collision.identity, null);
    assert.equal(collision.details.conflict_type, "unknown");
    assert.equal(collision.details.verb, null);
    assert.deepEqual(collision.details.contenders, []);
  });
});

test("COORD-836: mismatched pruned snapshot recovery stays unavailable until approved mutation succeeds", () => {
  withCoord223Surface(({ boardPath, runtimeDir, readJournal }) => {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
    const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
    for (const entry of fs.readdirSync(snapshotsDir)) fs.rmSync(path.join(snapshotsDir, entry), { force: true });
    fs.rmSync(path.join(runtimeDir, "governance-latest-snapshot.json"), { force: true });
    const matchingWarnings = [];
    const matchingErrors = [];
    journalOwner.appendGovernanceProvenanceIssues(matchingErrors, matchingWarnings);
    assert.deepEqual(matchingErrors, []);
    assert.equal(matchingWarnings.length, 1);
    assert.match(matchingWarnings[0], /current bytes match the recorded digest/);
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "unapproved current bytes" }] }, null, 2));

    const before = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(before.snapshotPruned, true);
    assert.equal(before.snapshotMatchesCurrent, false);
    const errors = [];
    journalOwner.appendGovernanceProvenanceIssues(errors, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /snapshot.*unavailable|snapshot.*pruned/i);

    const journalBeforeFailure = readJournal();
    const snapshotRecovery = {
      approval: "human-admin approved this exact snapshot digest",
      approvedDigest: before.currentSnapshot.digest,
    };
    let invalidRecoveryWriterCalled = false;
    const refusedRecoveryCases = [
      { command: "claim-ticket", snapshotRecovery },
      { command: "manual-reconcile", snapshotRecovery: { approvedDigest: snapshotRecovery.approvedDigest } },
      { command: "manual-reconcile", snapshotRecovery: { ...snapshotRecovery, approvedDigest: "wrong-digest" } },
    ];
    for (const metadata of refusedRecoveryCases) {
      assert.throws(() => __testing.withGovernanceMutation({
        allowProvenanceDrift: true, ...metadata,
      }, () => { invalidRecoveryWriterCalled = true; }), /snapshot.*unavailable|snapshot.*pruned/i);
    }
    assert.equal(invalidRecoveryWriterCalled, false, "missing or mismatched approval refuses before the callback");
    assert.deepEqual(readJournal(), journalBeforeFailure);

    assert.throws(() => __testing.withGovernanceMutation({
      command: "manual-reconcile", allowProvenanceDrift: true, snapshotRecovery,
    }, () => { throw new Error("injected recovery failure"); }), /injected recovery failure/);
    assert.deepEqual(readJournal(), journalBeforeFailure, "failed recovery does not advance the journal baseline");
    assert.equal(journalOwner.detectGovernanceProvenanceDrift().snapshotPruned, true,
      "failed recovery preserves the pruned/unavailable state for a deliberate retry");

    __testing.withGovernanceMutation({
      command: "manual-reconcile", allowProvenanceDrift: true, snapshotRecovery, forceLog: true,
      details: { operator_note: "approved digest checked" },
    }, () => {});
    const recovered = readJournal().at(-1);
    assert.equal(recovered.command, "manual-reconcile");
    assert.equal(recovered.details.operator_note, "approved digest checked");
    assert.deepEqual(recovered.details.snapshot_recovery, {
      expected_digest: before.expectedSnapshotDigest,
      approved_digest: before.currentSnapshot.digest,
      human_admin_override: snapshotRecovery.approval,
    });
    assert.equal(journalOwner.detectGovernanceProvenanceDrift().snapshotPruned, undefined,
      "successful explicitly approved recovery restores a readable snapshot");
  });
});

test("COORD-836: rollback failure is surfaced as a typed governance failure", () => {
  withCoord223Surface(({ boardPath }) => {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
    assert.throws(() => __testing.withGovernanceMutation({ command: "rollback-failure" }, () => {
      fs.rmSync(boardPath, { force: true });
      fs.mkdirSync(boardPath);
      throw new GovernanceError("original mutation failed");
    }), (error) => error instanceof GovernanceError &&
      /original mutation failed/.test(error.message) && /Governance rollback failed/.test(error.message));
  });
});

test("COORD-836: rollback failures preserve useful fallback messages for empty and nullish errors", () => {
  for (const originalError of [new Error(""), null]) {
    for (const restoreError of [new Error(""), null]) {
      withCoord223Surface(({ boardPath }) => {
        __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
        const originalRenameSync = fs.renameSync;
        let restoreRenameFailed = false;
        let mutationCallbackEntered = false;
        try {
          fs.renameSync = (source, destination) => {
            if (destination === boardPath && !restoreRenameFailed) {
              restoreRenameFailed = true;
              throw restoreError;
            }
            return originalRenameSync(source, destination);
          };
          assert.throws(() => __testing.withGovernanceMutation({ command: "rollback-empty-error" }, () => {
            mutationCallbackEntered = true;
            fs.rmSync(boardPath, { force: true });
            fs.mkdirSync(boardPath);
            throw originalError;
          }), (error) => error instanceof GovernanceError &&
            error.message === `${String(originalError)}\nGovernance rollback failed: ${String(restoreError)}`);
          assert.equal(mutationCallbackEntered, true, "the mutation callback runs before the restore fault");
          assert.equal(restoreRenameFailed, true, "the scoped rename fault reaches restore, not the mutation callback");
        } finally {
          fs.renameSync = originalRenameSync;
        }
      });
    }
  }
});

test("COORD-836: non-merge external effects get retry guidance without a ticket", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    __testing.withGovernanceMutation({ command: "seed", forceLog: true }, () => {});
    assert.throws(() => __testing.withGovernanceMutation({ command: "external-write" }, () => {
      __testing.recordGovernanceExternalSideEffect({ type: "fixture_external_write", receipt: "isolated" });
      fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
      throw new Error("");
    }), (error) => error instanceof GovernanceError &&
      /Error/.test(error.message) && /retry the same governance command/.test(error.message) &&
      !/PR was already merged/.test(error.message));
    const failure = readJournal().at(-1);
    assert.equal(failure.command, "external-write");
    assert.equal(failure.ticket, null);
    assert.equal(failure.before_status, null);
    assert.equal(failure.after_status, null);
    assert.equal(failure.result, "failed");
    assert.equal(failure.details.error, "Error", "an empty error message falls back to its string representation");
    assert.equal(failure.details.external_side_effects.length, 1);
    assert.equal(failure.details.external_side_effects[0].type, "fixture_external_write");
    assert.equal(failure.details.external_side_effects[0].receipt, "isolated");
    assert.equal(typeof failure.details.external_side_effects[0].recorded_at, "string");
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
  const a = journalOwner.canonicalEventSerialization({ b: 2, a: 1, nested: { y: 1, x: 2 } });
  const b = journalOwner.canonicalEventSerialization({ nested: { x: 2, y: 1 }, a: 1, b: 2 });
  // Same content, different insertion order => byte-identical serialization.
  assert.equal(a, b);
  // EXACT canonical form pins the sort + the key/quote/colon literals.
  assert.equal(a, '{"a":1,"b":2,"nested":{"x":2,"y":1}}');
});

test("COORD-245: canonicalEventSerialization preserves array order and serializes nested arrays", () => {
  // Array branch must NOT sort positionally; nested objects inside still sort.
  assert.equal(
    journalOwner.canonicalEventSerialization([3, { q: 1, p: 2 }]),
    '[3,{"p":2,"q":1}]'
  );
  // A non-empty array literal mutated to [] would change the output.
  assert.equal(journalOwner.canonicalEventSerialization([1, 2, 3]), "[1,2,3]");
  assert.equal(journalOwner.canonicalEventSerialization([]), "[]");
});

test("COORD-245: canonicalEventSerialization maps undefined to null (scalar branch)", () => {
  assert.equal(journalOwner.canonicalEventSerialization({ a: undefined }), '{"a":null}');
  assert.equal(journalOwner.canonicalEventSerialization(undefined), "null");
  assert.equal(journalOwner.canonicalEventSerialization("x"), '"x"');
  assert.equal(journalOwner.canonicalEventSerialization(7), "7");
});

test("COORD-245: hashGovernanceEventRecord is the sha1 of the canonical serialization (exact)", () => {
  const record = { b: 2, a: 1, nested: { y: 1, x: 2 } };
  const expected = crypto
    .createHash("sha1")
    .update(journalOwner.canonicalEventSerialization(record))
    .digest("hex");
  assert.equal(journalOwner.hashGovernanceEventRecord(record), expected);
  // Pin the exact digest so a mutated hash input/algorithm is caught.
  assert.equal(journalOwner.hashGovernanceEventRecord(record), "6361d5ab8410562f076d2126d4b09837f40ba4a8");
  // Order-independence flows through the hash too.
  assert.equal(
    journalOwner.hashGovernanceEventRecord({ a: 1, b: 2, nested: { x: 2, y: 1 } }),
    journalOwner.hashGovernanceEventRecord(record)
  );
  // A real content change MUST change the hash (tamper-evidence).
  assert.notEqual(
    journalOwner.hashGovernanceEventRecord(record),
    journalOwner.hashGovernanceEventRecord({ ...record, a: 999 })
  );
});

test("COORD-245: hashGovernanceEventLine hashes the verbatim line string (exact)", () => {
  assert.equal(
    journalOwner.hashGovernanceEventLine("hello-line"),
    "cc9e49a6510017f4d880f4d8ecdb72be5d23962c"
  );
  // String() coercion: a numeric line hashes as its string form.
  assert.equal(journalOwner.hashGovernanceEventLine(123), journalOwner.hashGovernanceEventLine("123"));
  // Distinct lines => distinct hashes.
  assert.notEqual(journalOwner.hashGovernanceEventLine("a"), journalOwner.hashGovernanceEventLine("b"));
});

// --- isChainedEvent (the chained-vs-legacy boundary predicate) --------------

test("COORD-245: isChainedEvent is true only for a non-empty string prev_event_hash", () => {
  assert.equal(journalOwner.isChainedEvent({ prev_event_hash: "genesis" }), true);
  assert.equal(journalOwner.isChainedEvent({ prev_event_hash: "abc123" }), true);
  // Empty string is NOT chained (length > 0 boundary).
  assert.equal(journalOwner.isChainedEvent({ prev_event_hash: "" }), false);
  // Missing field / legacy event is NOT chained.
  assert.equal(journalOwner.isChainedEvent({ command: "legacy" }), false);
  // Non-string prev_event_hash is NOT chained.
  assert.equal(journalOwner.isChainedEvent({ prev_event_hash: 5 }), false);
  // Null/undefined record is NOT chained.
  assert.equal(journalOwner.isChainedEvent(null), false);
  assert.equal(journalOwner.isChainedEvent(undefined), false);
});

// --- verifyGovernanceChain fail-closed reasons + broken-link fields ---------

test("COORD-245: verifyGovernanceChain records exact broken-link fields on a tampered chain", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent(mkLegacyEvent("alpha", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("beta", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("gamma", "2026-06-10T00:02:00.000Z"));
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.ticket = "INJECTED-666";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const events = journalOwner.readGovernanceEventLog();
    const chain = journalOwner.verifyGovernanceChain(events);
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
    assert.equal(link.expected, journalOwner.hashGovernanceEventRecord(events[1]));
    assert.notEqual(link.expected, link.actual);
  });
});

test("COORD-245: verifyGovernanceChain flags an unchained event appearing after the chain started", () => {
  const chained = buildValidChainedEvents(3);
  // Insert a LEGACY (no prev_event_hash) event AFTER the chain began.
  const legacy = mkLegacyEvent("stray-legacy", "2026-06-10T09:00:00.000Z");
  const events = [chained[0], chained[1], legacy, chained[2]];
  const chain = journalOwner.verifyGovernanceChain(events);
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
  const chain = journalOwner.verifyGovernanceChain(chained);
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
  const chain = journalOwner.verifyGovernanceChain(events);
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.broken, []);
  assert.equal(chain.total, 4);
  assert.equal(chain.preChainCount, 0);
  assert.equal(chain.chainedCount, 4);
  // The head is the canonical hash of the LAST chained event (the attestation input).
  assert.equal(chain.head, journalOwner.hashGovernanceEventRecord(events[3]));
  // A mixed legacy+chained log reports both counts.
  const legacyLead = [
    mkLegacyEvent("L1", "2026-06-09T00:00:00.000Z"),
    mkLegacyEvent("L2", "2026-06-09T00:01:00.000Z"),
    ...events,
  ];
  const mixed = journalOwner.verifyGovernanceChain(legacyLead);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.preChainCount, 2);
  assert.equal(mixed.chainedCount, 4);
});

// --- appendGovernanceEvent: prev_event_hash stamping order + anchor boundary -

test("COORD-245: appendGovernanceEvent stamps the FIRST fresh event at genesis and links the rest", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent(mkLegacyEvent("e1", "2026-06-10T00:00:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("e2", "2026-06-10T00:01:00.000Z"));
    journalOwner.appendGovernanceEvent(mkLegacyEvent("e3", "2026-06-10T00:02:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events[0].prev_event_hash, "genesis");
    assert.equal(events[1].prev_event_hash, journalOwner.hashGovernanceEventRecord(events[0]));
    assert.equal(events[2].prev_event_hash, journalOwner.hashGovernanceEventRecord(events[1]));
    // The record-hash is canonical (key-sorted), independent of stored line order.
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    assert.equal(
      journalOwner.hashGovernanceEventRecord(JSON.parse(lines[0])),
      journalOwner.hashGovernanceEventRecord(events[0])
    );
    assert.equal(journalOwner.verifyGovernanceChain(events).ok, true);
  });
});

test("COORD-245: appendGovernanceEvent re-reads the tip UNDER the lock so concurrent-style appends chain in order", () => {
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // First append establishes the tip.
    journalOwner.appendGovernanceEvent(mkLegacyEvent("first", "2026-06-10T00:00:00.000Z"));
    const afterFirst = journalOwner.readGovernanceEventLog();
    const tipHash = journalOwner.hashGovernanceEventRecord(afterFirst[0]);
    // A SECOND append must re-read the tip from disk and link off it (not off a
    // stale in-memory genesis). If the head re-read were dropped, the second
    // event would re-anchor at genesis and the chain would not verify.
    journalOwner.appendGovernanceEvent(mkLegacyEvent("second", "2026-06-10T00:01:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    assert.equal(events[1].prev_event_hash, tipHash);
    assert.notEqual(events[1].prev_event_hash, "genesis");
    assert.equal(journalOwner.verifyGovernanceChain(events).ok, true);
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
    journalOwner.appendGovernanceEvent(mkLegacyEvent("post", "2026-06-10T00:00:00.000Z"));
    const events = journalOwner.readGovernanceEventLog();
    const anchor = events[2];
    // The anchor is an explicit, auditable record with the exact shape.
    assert.equal(anchor.command, "chain-anchor");
    assert.equal(anchor.result, "anchored");
    assert.equal(anchor.prev_event_hash, "genesis");
    assert.equal(anchor.details.reason, "legacy-pre-chain-migration");
    assert.deepEqual(anchor.changed_paths, []);
    // The post-migration event links off the anchor (not the legacy tip).
    assert.equal(events[3].prev_event_hash, journalOwner.hashGovernanceEventRecord(anchor));
  });
});

// --- restampGovernanceChainFrom (COORD-124 link re-stamp) -------------------

test("COORD-245: restampGovernanceChainFrom re-links only from fromIndex forward, leaving prior bytes stable", () => {
  const events = buildValidChainedEvents(5);
  // Cross a link at index 3 (simulate a concurrent-append break).
  events[3].prev_event_hash = "deadbeef".padEnd(40, "0");
  const restamped = journalOwner.restampGovernanceChainFrom(events, 3);
  // Events before fromIndex are byte-identical (not restamped).
  assert.equal(restamped[0].prev_event_hash, events[0].prev_event_hash);
  assert.equal(restamped[2].prev_event_hash, events[2].prev_event_hash);
  // The event at fromIndex links to the canonical hash of its predecessor.
  assert.equal(restamped[3].prev_event_hash, journalOwner.hashGovernanceEventRecord(restamped[2]));
  assert.equal(restamped[4].prev_event_hash, journalOwner.hashGovernanceEventRecord(restamped[3]));
  // The re-linked chain verifies clean.
  assert.equal(journalOwner.verifyGovernanceChain(restamped).ok, true);
  // Re-stamping from index 0 roots at genesis.
  const fromZero = journalOwner.restampGovernanceChainFrom(events, 0);
  assert.equal(fromZero[0].prev_event_hash, "genesis");
});

// --- summarizeIdentityForEvent (every field, present + absent) ---------------

test("COORD-245: summarizeIdentityForEvent maps every identity field, with null fallbacks", () => {
  const full = journalOwner.summarizeIdentityForEvent({
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
  const empty = journalOwner.summarizeIdentityForEvent(null);
  assert.equal(empty.agent_id, null);
  assert.equal(empty.owner, null);
  assert.equal(empty.session_id, null);
  assert.equal(empty.auto_claimed, false);

  // autoClaimed of a non-true truthy value must NOT be coerced to true.
  const notTrue = journalOwner.summarizeIdentityForEvent({ autoClaimed: "yes" });
  assert.equal(notTrue.auto_claimed, false);
});

// --- inferTicketStatus (board lookup, exact status + null paths) -------------

test("COORD-245: inferTicketStatus returns the exact board Status or null", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "T-7", Status: "doing" }] }] }, null, 2)
    );
    assert.equal(journalOwner.inferTicketStatus("T-7"), "doing");
    // Unknown ticket => null.
    assert.equal(journalOwner.inferTicketStatus("T-404"), null);
    // Falsy ticket id => null (no board read).
    assert.equal(journalOwner.inferTicketStatus(null), null);
    assert.equal(journalOwner.inferTicketStatus(""), null);
  });
});

// --- formatGovernanceExternalSideEffect (exact strings, both branches) ------

test("COORD-245: formatGovernanceExternalSideEffect renders a github_pr_merge with all parts", () => {
  const label = journalOwner.formatGovernanceExternalSideEffect({
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
    journalOwner.formatGovernanceExternalSideEffect({ type: "github_pr_merge" }),
    "github_pr_merge(GitHub PR)"
  );
});

test("COORD-245: formatGovernanceExternalSideEffect handles non-merge + invalid effects", () => {
  // A typed non-merge effect echoes its type.
  assert.equal(
    journalOwner.formatGovernanceExternalSideEffect({ type: "webhook" }),
    "webhook"
  );
  // No type => the generic fallback literal.
  assert.equal(
    journalOwner.formatGovernanceExternalSideEffect({}),
    "external side effect"
  );
  // Non-object => the unknown-effect literal.
  assert.equal(
    journalOwner.formatGovernanceExternalSideEffect(null),
    "unknown external side effect"
  );
  assert.equal(
    journalOwner.formatGovernanceExternalSideEffect("nope"),
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
  const msg = journalOwner.formatGovernanceDriftMessage(
    { ts: "2026-06-10T00:00:00.000Z" },
    ["board/tasks.json", "PLAN.md"]
  );
  assert.match(msg, /Governed state changed without a journaled gov mutation since 2026-06-10T00:00:00\.000Z: board\/tasks\.json, PLAN\.md\./);
  assert.match(msg, /gov doctor/);
  assert.match(msg, /gov recover <ticket-id>/);
  // Missing ts => the "unknown time" fallback literal.
  const noTs = journalOwner.formatGovernanceDriftMessage(null, ["x"]);
  assert.match(noTs, /since unknown time: x\./);
});

test("COORD-245: formatOutOfBandBoardMutationMessage embeds paths + ts and the full guidance", () => {
  const msg = journalOwner.formatOutOfBandBoardMutationMessage({
    paths: ["board/tasks.json", "plans/T-1.json"],
    latestEvent: { ts: "2026-06-11T00:00:00.000Z" },
  });
  assert.match(msg, /Refusing to run a governed board mutation on top of an out-of-band coordination-state change/);
  assert.match(msg, /no journaled transaction since 2026-06-11T00:00:00\.000Z\): board\/tasks\.json, plans\/T-1\.json\./);
  assert.match(msg, /Direct edits \/ ad-hoc scripts must NOT mutate the board/);
  assert.match(msg, /gov open-followup \/ gov start \/ gov move-review \/ gov finalize/);
  assert.match(msg, /coord\/scripts\/gov doctor/);
  assert.match(msg, /coord\/scripts\/gov recover <ticket-id>/);
  // COORD-722: semantic drift (ADR documents, a missing baseline) is not recoverable by
  // `gov recover`; the refusal must name the reconcile path that actually accepts it.
  assert.match(msg, /coord\/scripts\/gov reconcile --reason "<why>" --human-admin-override "<approval for these exact changes>"/);
  // Missing latestEvent.ts => the "unknown time" fallback; empty paths => "".
  const fallback = journalOwner.formatOutOfBandBoardMutationMessage({ paths: [], latestEvent: null });
  assert.match(fallback, /since unknown time\): \./);
  // A report with no paths list at all renders the same empty change list.
  assert.match(journalOwner.formatOutOfBandBoardMutationMessage({}), /since unknown time\): \. Direct edits/);
});

// --- describeGovernanceMutation / detectGovernanceQuestionAuthor ------------

test("COORD-245: describeGovernanceMutation joins command + ticket, falling back to a default", () => {
  assert.equal(journalOwner.describeGovernanceMutation({ command: "start", ticket: "T-1" }), "start T-1");
  assert.equal(journalOwner.describeGovernanceMutation({ command: "land" }), "land");
  assert.equal(journalOwner.describeGovernanceMutation({}), "governance mutation");
});

test("COORD-245: detectGovernanceQuestionAuthor prefers the explicit identity handle", () => {
  assert.equal(
    journalOwner.detectGovernanceQuestionAuthor({ identity: { agent: { handle: "claudea11" } } }),
    "claudea11"
  );
});

// --- extractDriftSinceTimestamp (the drift-note parse regex) -----------------

test("COORD-245: extractDriftSinceTimestamp pulls the ISO ts out of a drift-note answer", () => {
  const answer =
    "Detected unjournaled governed-state drift since 2026-06-10T00:00:00.000Z. Continued.";
  assert.equal(journalOwner.extractDriftSinceTimestamp(answer), "2026-06-10T00:00:00.000Z");
  // No marker => null.
  assert.equal(journalOwner.extractDriftSinceTimestamp("nothing here"), null);
  assert.equal(journalOwner.extractDriftSinceTimestamp(""), null);
  assert.equal(journalOwner.extractDriftSinceTimestamp(null), null);
});

// --- findCommittedMutationByIdempotencyKey (reverse scan, key match) --------

test("COORD-245: findCommittedMutationByIdempotencyKey finds the matching succeeded event", () => {
  withCoord223Surface(({ readJournal }) => {
    __testing.withGovernanceMutation(
      { command: "k", ticket: "IMP-1", idempotencyKey: "key-A", forceLog: true },
      () => {}
    );
    const found = journalOwner.findCommittedMutationByIdempotencyKey("key-A");
    assert.ok(found, "expected to find the committed keyed mutation");
    assert.equal(found.result, "succeeded");
    assert.equal(found.details.idempotency_key, "key-A");
    // A non-matching key returns null.
    assert.equal(journalOwner.findCommittedMutationByIdempotencyKey("key-MISSING"), null);
    // A falsy key short-circuits to null.
    assert.equal(journalOwner.findCommittedMutationByIdempotencyKey(""), null);
    assert.equal(journalOwner.findCommittedMutationByIdempotencyKey(null), null);
    void readJournal;
  });
});

// --- snapshot artifacts: write/read round-trip + checkpoint ------------------

test("COORD-245: snapshot artifact write/read round-trips and the path is digest-addressed", () => {
  withGovernedSurfaceSandbox(() => {
    const snapshot = journalOwner.buildGovernanceSnapshot();
    const artifactPath = journalOwner.writeGovernanceSnapshotArtifact(snapshot);
    // The artifact path is addressed by the snapshot digest.
    assert.equal(artifactPath, journalOwner.governanceSnapshotArtifactPath(snapshot.digest));
    assert.equal(fs.existsSync(artifactPath), true);
    const read = journalOwner.readGovernanceSnapshotArtifact(snapshot.digest);
    assert.equal(read.digest, snapshot.digest);
    assert.deepEqual(read.files.map((f) => f.path), snapshot.files.map((f) => f.path));
    // allowMissing returns null instead of failing on an absent digest.
    assert.equal(journalOwner.readGovernanceSnapshotArtifact("0".repeat(40), { allowMissing: true }), null);
    assert.equal(journalOwner.readGovernanceSnapshotArtifact(null, { allowMissing: true }), null);
  });
});

test("COORD-245: writeGovernanceSnapshotCheckpoint persists the digest + metadata", () => {
  withGovernedSurfaceSandbox(({ snapshotPath }) => {
    const snapshot = journalOwner.buildGovernanceSnapshot();
    journalOwner.writeGovernanceSnapshotCheckpoint(snapshot, {
      ts: "2026-06-10T00:00:00.000Z",
      command: "land",
      ticket: "T-3",
    });
    const checkpoint = journalOwner.readGovernanceSnapshotCheckpoint();
    assert.equal(checkpoint.digest, snapshot.digest);
    assert.equal(checkpoint.ts, "2026-06-10T00:00:00.000Z");
    assert.equal(checkpoint.command, "land");
    assert.equal(checkpoint.ticket, "T-3");
    assert.equal(checkpoint.recorded_at, snapshot.recorded_at);
    // allowMissing returns null when no checkpoint exists.
    fs.rmSync(snapshotPath, { force: true });
    assert.equal(journalOwner.readGovernanceSnapshotCheckpoint({ allowMissing: true }), null);
  });
});

test("COORD-1048: approval audit events preserve the latest snapshot after a concurrent state advance", () => {
  withJournalSandbox(({ decisionsDir, snapshotPath }) => {
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), event: "approval.refused", command: "reconcile", ticket: "control-plane" });
    const initial = journalOwner.readLatestGovernanceSnapshotSource();
    assert.equal(initial.latestEvent, null);
    assert.equal(initial.snapshot, null, "an approval-only journal has no baseline");
    const decisionFile = path.join(decisionsDir, "approval-baseline-fixture.md");
    fs.writeFileSync(decisionFile, "baseline A\n", "utf8");
    const oldSnapshot = journalOwner.buildGovernanceSnapshot();
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), command: "fixture-baseline-a", snapshot: oldSnapshot });

    fs.writeFileSync(decisionFile, "baseline B\n", "utf8");
    const latestSnapshot = journalOwner.buildGovernanceSnapshot();
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), command: "fixture-baseline-b", snapshot: latestSnapshot });
    // Simulate a stale checkpoint cache while the append-only latest event and
    // its artifact already hold the newer state.
    journalOwner.writeGovernanceSnapshotCheckpoint(oldSnapshot, { ts: new Date().toISOString(), command: "stale-fixture-cache" });
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), event: "approval.refused", command: "reconcile", ticket: "control-plane" });

    const source = journalOwner.readLatestGovernanceSnapshotSource();
    assert.equal(source.latestEvent.event, "approval.refused", "approval refusal remains the visible audit tail");
    assert.equal(source.snapshot.digest, latestSnapshot.digest,
      "a snapshot-neutral approval event cannot make an older checkpoint authoritative");
    assert.equal(source.source, "event-artifact");

    fs.rmSync(snapshotPath, { force: true });
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), command: "non-approval-snapshotless-event" });
    journalOwner.appendGovernanceEvent({ ts: new Date().toISOString(), event: "approval.refused", command: "reconcile", ticket: "control-plane" });
    const afterBoundary = journalOwner.readLatestGovernanceSnapshotSource();
    assert.equal(afterBoundary.latestEvent.event, "approval.refused");
    assert.equal(afterBoundary.snapshot, null,
      "neutral approvals do not skip across an intervening non-approval snapshotless event");
    assert.equal(afterBoundary.source, null);
  });
});

// --- ensureGovernanceJournalBaseline + advanceGovernanceProvenanceBaseline ---

test("COORD-245: ensureGovernanceJournalBaseline writes a baseline once, then no-ops", () => {
  withGovernedSurfaceSandbox(() => {
    const first = journalOwner.ensureGovernanceJournalBaseline("first-reason");
    assert.equal(first, true);
    const events = journalOwner.readGovernanceEventLog();
    const baseline = events.find((e) => e.command === "journal-baseline");
    assert.ok(baseline, "expected a journal-baseline event");
    assert.equal(baseline.details.reason, "first-reason");
    assert.ok(baseline.snapshot_digest, "baseline carries a snapshot digest");
    // A second call is a no-op (a snapshot already exists).
    assert.equal(journalOwner.ensureGovernanceJournalBaseline("second"), false);
  });
});

test("COORD-245: advanceGovernanceProvenanceBaseline only advances on residual coordination-state drift", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    journalOwner.ensureGovernanceJournalBaseline("seed");
    // No drift => no advance.
    assert.equal(journalOwner.advanceGovernanceProvenanceBaseline("noop-case"), false);
    // Introduce out-of-band board drift (a coordination-state file changed off-journal).
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "x" }] }, null, 2));
    const advanced = journalOwner.advanceGovernanceProvenanceBaseline("post-sync");
    assert.equal(advanced, true);
    const events = journalOwner.readGovernanceEventLog();
    const last = events[events.length - 1];
    assert.equal(last.command, "journal-baseline");
    assert.equal(last.details.reason, "post-sync");
    assert.ok(Array.isArray(last.details.advanced_paths));
    assert.ok(last.details.advanced_paths.length > 0);
    // After advancing, the drift is absorbed: a second advance is a no-op.
    assert.equal(journalOwner.advanceGovernanceProvenanceBaseline("again"), false);
  });
});

test("COORD-275: isPathWithinSyncScope matches exact files + directory pathspecs only", () => {
  const scope = ["board/tasks.json", "rendered/TASKS.md", ".runtime/plans/"];
  // Exact-file pathspec match.
  assert.equal(journalOwner.isPathWithinSyncScope("board/tasks.json", scope), true);
  assert.equal(journalOwner.isPathWithinSyncScope("rendered/TASKS.md", scope), true);
  // Directory pathspec matches its children (prefix), not the bare name.
  assert.equal(journalOwner.isPathWithinSyncScope(".runtime/plans/COORD-1.json", scope), true);
  // A sibling NOT in the synced set is out-of-scope even under the same parent dir.
  assert.equal(journalOwner.isPathWithinSyncScope("rendered/OTHER.md", scope), false);
  assert.equal(journalOwner.isPathWithinSyncScope("prompts/tickets/COORD-9.md", scope), false);
  assert.equal(journalOwner.isPathWithinSyncScope("board/tasks.json", null), false);
  assert.equal(journalOwner.isPathWithinSyncScope("board/tasks.json", []), false);
});

test("COORD-275: scoped baseline advance ABSORBS the mutation's own derived-artifact drift (COORD-246 preserved)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    journalOwner.ensureGovernanceJournalBaseline("seed");
    // Simulate the terminal mutation's OWN post-journal sync rewriting the
    // canonical board json — a derived path the sync is authorized to touch.
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "synced" }] }, null, 2));
    const drift = journalOwner.detectOutOfBandBoardMutation();
    assert.equal(drift.detected, true);
    // Scope = exactly the path(s) the sync rewrote.
    const scopePaths = drift.paths.slice();
    const advanced = journalOwner.advanceGovernanceProvenanceBaseline("post-finalize-sync", { scopePaths });
    assert.equal(advanced, true, "in-scope derived drift must be absorbed");
    // COORD-246 behaviour preserved: the next governed command sees NO spurious drift.
    assert.equal(journalOwner.detectOutOfBandBoardMutation().detected, false);
    // And a re-run is a clean no-op (nothing left to absorb).
    assert.equal(journalOwner.advanceGovernanceProvenanceBaseline("again", { scopePaths }), false);
  });
});

test("COORD-275: scoped baseline advance PRESERVES a concurrent out-of-scope hand-edit (single-writer fail-open closed)", () => {
  withGovernedSurfaceSandbox(({ boardPath, promptsDir }) => {
    journalOwner.ensureGovernanceJournalBaseline("seed");
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
    const advanced = journalOwner.advanceGovernanceProvenanceBaseline("post-finalize-sync", { scopePaths });
    assert.equal(advanced, false, "out-of-scope concurrent drift must NOT be absorbed");
    // The hand-edit remains detectable so the next seal / conform still flags it.
    const after = journalOwner.detectOutOfBandBoardMutation();
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
    journalOwner.ensureGovernanceJournalBaseline("seed");
    // Clean state => not detected.
    const clean = journalOwner.detectOutOfBandBoardMutation();
    assert.equal(clean.detected, false);
    assert.deepEqual(clean.paths, []);
    // Out-of-band board edit => detected, with the board path reported.
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "oob" }] }, null, 2));
    const oob = journalOwner.detectOutOfBandBoardMutation();
    assert.equal(oob.detected, true);
    assert.ok(oob.paths.some((p) => p.endsWith("tasks.json")));
    assert.equal(oob.uninitialized, false);
  });
});

test("COORD-722: ADR decisions join the coordination-state drift matcher", () => {
  // Built from the LIVE configured paths (relativeCoordPath-form): the board file
  // is "board/tasks.json" (exact match) and the plan-records dir is ".runtime/plans/"
  // (prefix match) in the real coord layout.
  assert.equal(journalOwner.isCoordinationStatePath("board/tasks.json"), true);
  assert.equal(journalOwner.isCoordinationStatePath(".runtime/plans/T-1.json"), true);
  assert.equal(journalOwner.isCoordinationStatePath("docs/decisions/README.md"), true);
  // The board match is EXACT — a sibling file in board/ is not the board itself.
  assert.equal(journalOwner.isCoordinationStatePath("board/other.json"), false);
  // The agent_sessions runtime ledger is NOT coordination-state.
  assert.equal(journalOwner.isCoordinationStatePath(".runtime/agent_sessions.json"), false);
  // An unrelated path is NOT coordination-state.
  assert.equal(journalOwner.isCoordinationStatePath("docs/README.md"), false);
  assert.equal(journalOwner.isCoordinationStatePath(null), false);
});

// --- isRuntimeLedgerDriftPath -----------------------------------------------

test("COORD-245: isRuntimeLedgerDriftPath matches the .runtime/ prefix only", () => {
  assert.equal(journalOwner.isRuntimeLedgerDriftPath(".runtime/agent_sessions.json"), true);
  assert.equal(journalOwner.isRuntimeLedgerDriftPath(".runtime/session-threads/x.json"), true);
  assert.equal(journalOwner.isRuntimeLedgerDriftPath("board/tasks.json"), false);
  assert.equal(journalOwner.isRuntimeLedgerDriftPath(""), false);
  assert.equal(journalOwner.isRuntimeLedgerDriftPath(null), false);
});

// --- findLatestGovernanceBaselineTimestamp ----------------------------------

test("COORD-245: findLatestGovernanceBaselineTimestamp returns the ts only for a snapshot-bearing event", () => {
  withGovernedSurfaceSandbox(() => {
    // No events => null.
    assert.equal(journalOwner.findLatestGovernanceBaselineTimestamp(), null);
    journalOwner.ensureGovernanceJournalBaseline("seed");
    const events = journalOwner.readGovernanceEventLog();
    const baselineTs = events[events.length - 1].ts;
    assert.equal(journalOwner.findLatestGovernanceBaselineTimestamp(), baselineTs);
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
  assert.deepEqual(journalOwner.diffGovernanceSnapshots(left, right), ["b", "c"]);
  // Identical snapshots => no diff.
  assert.deepEqual(journalOwner.diffGovernanceSnapshots(left, left), []);
  // Null inputs are tolerated (optional chaining on .files).
  assert.deepEqual(journalOwner.diffGovernanceSnapshots(null, null), []);
});

// --- repairGovernanceChain backup path naming -------------------------------

test("COORD-245: governanceChainRepairBackupPath sanitizes the ts into the sidecar name", () => {
  const p = journalOwner.governanceChainRepairBackupPath("2026-06-12T00:00:00.000Z");
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
        /gov reconcile --reason "<why>" --human-admin-override "[^"]+" --expect-paths-file/.test(error.message) &&
        !/gov recover <ticket-id>/.test(error.message)
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

// COORD-835 (review finding 2) supersedes the COORD-732 symlink expectation: a
// symlink in a governed directory is state, so it now refuses the genesis.
test("COORD-732: nested empty governed directories are fresh; a symlink in one is state (COORD-835)", (t) => {
  withCoord223Surface(({ tempDir, readJournal, recordsDir, promptsDir, renderedDir }) => {
    for (const dir of [recordsDir, promptsDir, renderedDir]) {
      fs.mkdirSync(path.join(dir, "nested", "empty"), { recursive: true });
    }
    const externalFile = path.join(tempDir, "outside-governed-file.md");
    const linkedPrompt = path.join(promptsDir, "nested", "outside.md");
    fs.writeFileSync(externalFile, "outside state is not a governed prompt\n", "utf8");
    if (process.platform === "win32") {
      try {
        fs.symlinkSync(externalFile, linkedPrompt, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`file symlinks unavailable on this host: ${error.code}`);
          return;
        }
        throw error;
      }
    } else {
      fs.symlinkSync(externalFile, linkedPrompt, "file");
    }
    assert.equal(fs.lstatSync(linkedPrompt).isSymbolicLink(), true);
    assert.throws(() =>
      __testing.withGovernanceMutation({ command: "symlinked-prompt", forceLog: true }, () => {}),
    /Refusing to auto-baseline the governance journal/);
    assert.deepEqual(readJournal(), [], "a symlinked prompt is state: no genesis");
    assert.equal(fs.readFileSync(externalFile, "utf8"), "outside state is not a governed prompt\n",
      "the scan must not follow a symlink and mutate its target");
    fs.rmSync(linkedPrompt);

    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation({ command: "fresh-nested-directories", forceLog: true }, () => {})
    );
    const journal = readJournal();
    assert.equal(journal[0].command, "journal-baseline", "empty descendants are still a fresh surface");
    assert.equal(journal[1].command, "fresh-nested-directories");
  });
});

test("COORD-732: a nested governed file refuses lost-journal genesis but explicit recovery remains available", () => {
  withCoord223Surface(({ readJournal, recordsDir }) => {
    const nestedRecord = path.join(recordsDir, "COORD-9001", "evidence.json");
    fs.mkdirSync(path.dirname(nestedRecord), { recursive: true });
    fs.writeFileSync(nestedRecord, JSON.stringify({ ticket: "COORD-9001", evidence: "retained" }) + "\n", "utf8");

    assert.throws(
      () => __testing.withGovernanceMutation({ command: "start", ticket: "COORD-9001" }, () => {}),
      (error) => error instanceof GovernanceError &&
        /Refusing to auto-baseline the governance journal/.test(error.message) &&
        /--expect-paths-file/.test(error.message)
    );
    assert.deepEqual(readJournal(), [], "a retained nested record cannot be blessed as fresh genesis");
    assert.equal(fs.readFileSync(nestedRecord, "utf8"), '{"ticket":"COORD-9001","evidence":"retained"}\n');

    assert.doesNotThrow(() => __testing.withGovernanceMutation(
      { command: "manual-reconcile", allowProvenanceDrift: true, adoptProvenanceDrift: true, forceLog: true },
      () => {}
    ));
    const recovered = readJournal();
    assert.equal(recovered[0].command, "journal-baseline", "only explicit recovery may establish this baseline");
    assert.equal(recovered[1].command, "manual-reconcile");
    assert.equal(fs.readFileSync(nestedRecord, "utf8"), '{"ticket":"COORD-9001","evidence":"retained"}\n');
  });
});

test("COORD-732: file-ticket refuses an absent or empty journal when its latest snapshot remains", () => {
  for (const journalState of ["absent", "empty"]) {
    withGovernedSurfaceSandbox(({ boardPath, logPath, snapshotPath, snapshotsDir }) => {
      const board = {
        version: 1,
        metadata: { title: "COORD-732 journal fixture", last_updated: "2026-10-05", canonical_references: [] },
        sections: [{
          kind: "table", level: 3, heading: "Backlog", separator_before: false,
          columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
          rows: [],
        }],
        prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
      };
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      const first = executeCommand([
        "file-ticket", "COORD-9001", "--repo", "X", "--type", "bug", "--pri", "P1",
        "--description", "Seed live state before the lost journal reproduction",
      ]);
      assert.equal(first.ok, true, first.error);

      const boardBefore = fs.readFileSync(boardPath);
      const latestSnapshotPath = snapshotPath;
      const latestSnapshotBefore = fs.readFileSync(latestSnapshotPath);
      const snapshotArtifacts = fs.readdirSync(snapshotsDir).sort();
      if (journalState === "absent") fs.unlinkSync(logPath);
      else fs.writeFileSync(logPath, "", "utf8");

      const result = executeCommand([
        "file-ticket", "COORD-9002", "--repo", "X", "--type", "bug", "--pri", "P1",
        "--description", `Attempt after ${journalState} journal loss`,
      ]);
      assert.equal(result.ok, false, `${journalState} event log must fail closed`);
      assert.match(result.error, /Refusing to auto-baseline the governance journal/);
      assert.deepEqual(fs.readFileSync(boardPath), boardBefore, "refusal must not alter the board");
      assert.deepEqual(fs.readFileSync(latestSnapshotPath), latestSnapshotBefore,
        "refusal must preserve the retained latest snapshot");
      assert.deepEqual(fs.readdirSync(snapshotsDir).sort(), snapshotArtifacts,
        "refusal must preserve retained snapshot artifacts");
      assert.equal(fs.existsSync(logPath), journalState === "empty");
      if (journalState === "empty") assert.equal(fs.readFileSync(logPath, "utf8"), "");
      const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      assert.deepEqual(after.sections[0].rows.map((row) => row.ID), ["COORD-9001"]);
    }, { isolateBoardValidation: true });
  }
});

// COORD-835: the generic recovery-intent flag no longer re-baselines over existing
// state (claim / doctor --fix / recover carry it and only repair sessions/locks).
// Only the reconcile mutation that adopts drift (reached after its override and
// approved-packet checks) may establish the baseline.
test("COORD-835: only the packet-bound reconcile mutation can re-baseline over EXISTING state", () => {
  withCoord223Surface(({ boardPath, readJournal }) => {
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ sections: [{ heading: "s", rows: [{ ID: "IMP-501", Status: "todo" }] }] }, null, 2)
    );
    for (const metadata of [
      { command: "recover", ticket: "IMP-501", allowProvenanceDrift: true },
      { command: "manual-reconcile", allowProvenanceDrift: true, forceLog: true },
      { command: "claim-ticket", allowProvenanceDrift: true, adoptProvenanceDrift: true },
    ]) {
      assert.throws(() => __testing.withGovernanceMutation(metadata, () => {}), /Refusing to auto-baseline/, metadata.command);
    }
    assert.deepEqual(readJournal(), []);
    assert.doesNotThrow(() =>
      __testing.withGovernanceMutation(
        { command: "manual-reconcile", allowProvenanceDrift: true, adoptProvenanceDrift: true, forceLog: true },
        () => {}
      )
    );
    const journal = readJournal();
    assert.ok(journal.length >= 1, "recovery establishes a baseline over existing state");
    assert.equal(journal[0].command, "journal-baseline");
  });
});

test("COORD-836: packet-bound genesis baseline reuses the validated after-snapshot", () => {
  withCoord223Surface(({ readJournal, promptsDir }) => {
    const relative = "tickets/COORD-836.md";
    const target = path.join(promptsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "approved snapshot bytes\n", "utf8");
    const validatedSnapshot = journalOwner.buildGovernanceSnapshot();
    let validatorCalled = false;

    __testing.withGovernanceMutation({
      command: "manual-reconcile",
      allowProvenanceDrift: true,
      adoptProvenanceDrift: true,
      forceLog: true,
      validateAfterSnapshot: (_before, after) => {
        validatorCalled = true;
        assert.equal(after.digest, validatedSnapshot.digest);
        // Model a concurrent replacement after the packet validator has
        // checked its immutable after-snapshot but before baseline persistence.
        fs.writeFileSync(target, "unapproved concurrent bytes\n", "utf8");
      },
    }, () => {});

    assert.equal(validatorCalled, true);
    const journal = readJournal();
    const baseline = journal.find((event) => event.command === "journal-baseline");
    assert.ok(baseline, "approved missing-baseline reconcile still establishes genesis");
    assert.equal(baseline.snapshot_digest, validatedSnapshot.digest,
      "baseline stores the snapshot that was checked, not a later filesystem resample");
    const provenance = journalOwner.detectGovernanceProvenanceDrift();
    assert(provenance.drift.some((entry) => entry.endsWith(`prompts/${relative}`)),
      "bytes replaced after validation remain detectable as drift");
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
    const drift = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(drift.uninitialized, false);
    assert.equal(drift.snapshotPruned, true, "pruned snapshot reported distinctly");
    assert.deepEqual(drift.drift, []);
    assert.equal(drift.snapshotMatchesCurrent, true);

    // An interrupted operation may leave its recovery point after the
    // snapshot has been pruned. Matching governed bytes need no rollback.
    const journalBeforeRecovery = readJournal();
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "interrupted" });
    const restoredDigest = journalOwner.buildGovernanceSnapshot().digest;
    assert.deepEqual(__testing.recoverCrashedGovernanceMutation(), { action: "discarded_consistent" });
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    assert.equal(journalOwner.buildGovernanceSnapshot().digest, restoredDigest);
    assert.deepEqual(readJournal(), journalBeforeRecovery);

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
const { publicKeyFingerprint } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-attestation.js")).__internals;

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
    const chain = journalOwner.verifyGovernanceChain();
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
    const chain = journalOwner.verifyGovernanceChain();
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
    const chain = journalOwner.verifyGovernanceChain();
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
    const chain = journalOwner.verifyGovernanceChain();
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
    const chain = journalOwner.verifyGovernanceChain();
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
    assert.equal(journalOwner.verifyGovernanceChain().ok, true, "self-consistent forgery passes without an anchor");
    // WITH the genuine signer pinned: the forged signer is untrusted -> rejected.
    const anchored = journalOwner.verifyGovernanceChain(undefined, { trustAnchors: [genuine.fingerprint] });
    assert.equal(anchored.ok, false, "forged signer rejected under the configured trust anchor");
    assert.ok(anchored.broken.some((b) => b.reason === "migration-signature-untrusted"));
  });
});

test("COORD-289: the genuine migration signature verifies under its trust anchor", () => {
  withJournalSandbox(({ logPath }) => {
    const { events, fingerprint } = buildMixedEraFixture();
    writeFixtureJournal(logPath, events);
    const anchored = journalOwner.verifyGovernanceChain(undefined, { trustAnchors: [fingerprint] });
    assert.equal(anchored.ok, true, "genuine signer is trusted under its own anchor");
  });
});

test("COORD-289: BACK-COMPAT — a pre-migration journal appends byte-identically (SHA-1)", () => {
  // An untouched (pre-migration) repo must behave EXACTLY as before: no hash_alg
  // field, sha1 link, byte-identical stored lines.
  withJournalSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent({
      ts: "2026-06-10T00:00:00.000Z", command: "start", ticket: "T-1",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    journalOwner.appendGovernanceEvent({
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
    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.ok, true);
    assert.equal(chain.headAlg, "sha1");
    assert.equal(chain.sha256ChainedCount, 0, "dormant: no sha256 era until the verb runs");
    assert.equal(chain.migrationIndex, null);
  });
});

test("COORD-289: the migration verb appends a signed bridge event then post-migration appends are sha256", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      journalOwner.appendGovernanceEvent({
        ts: `2026-06-10T00:0${i}:00.000Z`, command: "start", ticket: `T-${i}`,
        before_status: null, after_status: null, identity: null, changed_paths: [],
      });
    }
    const pre = journalOwner.verifyGovernanceChain();
    assert.equal(pre.headAlg, "sha1");

    // DRY-RUN writes nothing.
    const dry = journalOwner.migrateGovernanceChainHash({ confirm: false });
    assert.equal(dry.status, "dry-run");
    assert.equal(dry.sha1_chain_head, pre.head);
    assert.equal(journalOwner.verifyGovernanceChain().migrationIndex, null, "dry-run wrote nothing");

    // APPLY appends the signed bridge.
    const res = journalOwner.migrateGovernanceChainHash({ confirm: true, identity: null });
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
    journalOwner.appendGovernanceEvent({
      ts: "2026-06-10T01:00:00.000Z", command: "start", ticket: "T-post",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    const after = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const post = after[4];
    assert.equal(post.hash_alg, "sha256");
    assert.equal(post.prev_event_hash, coord289Sha256(coord289Ss(mig)), "links via sha256 of the migration checkpoint");
    assert.equal(post.prev_event_hash.length, 64, "sha256 link (64 hex)");
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);
  });
});

test("lifecycle chain migration signs under the scoped runtime directory and reports a public no-op", () => {
  withGovernedSurfaceSandbox(({ logPath, runtimeDir, tempDir }) => {
    try {
      journalOwner.appendGovernanceEvent({
        ts: "2026-10-24T00:00:00.000Z", command: "start", ticket: "T-RUNTIME-SIGNER",
        before_status: null, after_status: null, identity: null, changed_paths: [],
      });
      const before = journalOwner.verifyGovernanceChain();
      assert.equal(before.headAlg, "sha1");

      const originalLog = console.log;
      const dryRunOutput = [];
      let publicDryRun;
      try {
        console.log = (...args) => dryRunOutput.push(args.join(" "));
        publicDryRun = governanceCommands.migrateChainHash();
      } finally {
        console.log = originalLog;
      }
      assert.equal(publicDryRun.status, "dry-run");
      assert.match(dryRunOutput.join("\n"), /DRY-RUN \(no --confirm; nothing written\)/);
      assert.match(dryRunOutput.join("\n"), /sha1 chain head:/);
      assert.equal(journalOwner.verifyGovernanceChain().migrationIndex, null,
        "the public default path does not append the migration bridge");

      const migrated = governanceCommands.migrateChainHash({ confirm: true, json: true });
      assert.equal(migrated.status, "migrated");
      assert.equal(migrated.sha1_chain_head, before.head);
      assert.equal(migrated.head_alg, "sha256");
      assert.ok(migrated.signature_fingerprint);

      const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
      const bridge = events.find((event) => event.command === "hash-alg-migration");
      assert.equal(bridge.prev_event_hash, before.head);
      assert.equal(bridge.details.signature.algorithm, "ed25519");
      assert.equal(fs.existsSync(path.join(runtimeDir, "conformance-keys", "attestation-signing-key.pem")), true,
        "the production transition signer resolves the scoped runtime directory at call time");
      assert.equal(journalOwner.verifyGovernanceChain().ok, true);

      const output = [];
      try {
        console.log = (...args) => output.push(args.join(" "));
        const second = governanceCommands.migrateChainHash({ confirm: true });
        assert.equal(second.status, "already-migrated");
        assert.match(output.join("\n"), /Hash-alg migration: NO-OP/);
        assert.match(output.join("\n"), /migration boundary: event #\d+/);
      } finally {
        console.log = originalLog;
      }

      const migrations = fs.readFileSync(logPath, "utf8")
        .trim().split("\n").map(JSON.parse)
        .filter((event) => event.command === "hash-alg-migration");
      assert.equal(migrations.length, 1, "the public retry does not append another bridge");
      assert.equal(journalOwner.verifyGovernanceChain().ok, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("lifecycle chain migration prints applied details through the public human-output path", () => {
  withGovernedSurfaceSandbox(({ logPath, tempDir }) => {
    try {
      journalOwner.appendGovernanceEvent({
        ts: "2026-10-24T00:00:00.000Z", command: "start", ticket: "T-HUMAN-MIGRATION",
        before_status: null, after_status: null, identity: null, changed_paths: [],
      });

      const originalLog = console.log;
      const output = [];
      let migrated;
      try {
        console.log = (...args) => output.push(args.join(" "));
        migrated = governanceCommands.migrateChainHash({ confirm: true });
      } finally {
        console.log = originalLog;
      }

      assert.equal(migrated.status, "migrated");
      const rendered = output.join("\n");
      assert.match(rendered, /Hash-alg migration: APPLIED/);
      assert.match(rendered, /sha1 chain head \(bridged\): [0-9a-f]{40}/);
      assert.match(rendered, /migrated at:\s+\S+/);
      assert.match(rendered, /verifier version:\s+coord-289-sha256-v1/);
      assert.match(rendered, /signer fingerprint:\s+\S+/);
      assert.match(rendered, /migration boundary:\s+event #\d+/);
      assert.match(rendered, /new chain head:\s+[0-9a-f]{64} \[sha256\]/);
      assert.match(rendered, /eras: 1 sha1-chained, 1 sha256-chained/);

      const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(events.filter((event) => event.command === "hash-alg-migration").length, 1);
      assert.equal(journalOwner.verifyGovernanceChain().ok, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("conformance verbs default omitted repair identity to null during a real migration", () => {
  withGovernedSurfaceSandbox(({ logPath, tempDir }) => {
    try {
      journalOwner.appendGovernanceEvent({
        ts: "2026-10-24T00:00:00.000Z", command: "start", ticket: "T-OPTIONAL-IDENTITY",
        before_status: null, after_status: null, identity: null, changed_paths: [],
      });

      const verbs = createConformanceVerbs({
        coordDir: COORD_DIR,
        fail: (message) => { throw new GovernanceError(message); },
        verifyGovernanceChain: journalOwner.verifyGovernanceChain,
        repairGovernanceChain: journalOwner.repairGovernanceChain,
        migrateGovernanceChainHash: journalOwner.migrateGovernanceChainHash,
        createConformanceAttestation,
        createEnginePin,
        resolveRuntimeDir: () => journalState.RUNTIME_DIR,
        // Deliberately omit optional resolveRepairIdentity to exercise the
        // factory's clean-env fallback through its returned command handler.
      });

      const migrated = verbs.migrateChainHash({ confirm: true, json: true });
      assert.equal(migrated.status, "migrated");
      const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
      const bridge = events.find((event) => event.command === "hash-alg-migration");
      assert.equal(bridge.identity.agent_id, null);
      assert.equal(bridge.identity.owner, null);
      assert.equal(bridge.identity.session_id, null);
      assert.equal(bridge.identity.auto_claimed, false);
      assert.equal(journalOwner.verifyGovernanceChain().ok, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("conformance verbs render missing optional fields on an already-migrated result", () => {
  const verbs = createConformanceVerbs({
    coordDir: COORD_DIR,
    fail: (message) => { throw new GovernanceError(message); },
    verifyGovernanceChain: journalOwner.verifyGovernanceChain,
    repairGovernanceChain: journalOwner.repairGovernanceChain,
    migrateGovernanceChainHash: ({ confirm, identity }) => {
      assert.equal(confirm, true);
      assert.equal(identity, null);
      return { status: "already-migrated", migration_index: 3 };
    },
    createConformanceAttestation,
    createEnginePin,
    // Omitted resolveRepairIdentity preserves the factory's null fallback.
  });
  const originalLog = console.log;
  const output = [];
  try {
    console.log = (...args) => output.push(args.join(" "));
    const result = verbs.migrateChainHash({ confirm: true });
    assert.equal(result.status, "already-migrated");
  } finally {
    console.log = originalLog;
  }
  assert.match(output.join("\n"), /Hash-alg migration: NO-OP/);
  assert.match(output.join("\n"), /migration boundary: event #3/);
  assert.match(output.join("\n"), /chain head:\s+\(none\) \[\?\]/);

  const unknownResultVerbs = createConformanceVerbs({
    coordDir: COORD_DIR,
    fail: (message) => { throw new GovernanceError(message); },
    verifyGovernanceChain: journalOwner.verifyGovernanceChain,
    repairGovernanceChain: journalOwner.repairGovernanceChain,
    migrateGovernanceChainHash: ({ confirm, identity }) => {
      assert.equal(confirm, true);
      assert.equal(identity, null);
      return { status: "future-status" };
    },
    createConformanceAttestation,
    createEnginePin,
    // Unknown statuses pass through without being labeled as a successful migration.
  });
  const unknownOutput = [];
  try {
    console.log = (...args) => unknownOutput.push(args.join(" "));
    const result = unknownResultVerbs.migrateChainHash({ confirm: true });
    assert.equal(result.status, "future-status");
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(unknownOutput, [], "an unrecognized result is not falsely rendered as APPLIED");
});

test("COORD-289: a second migration is refused (idempotent)", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    journalOwner.appendGovernanceEvent({
      ts: "2026-06-10T00:00:00.000Z", command: "start", ticket: "T-1",
      before_status: null, after_status: null, identity: null, changed_paths: [],
    });
    const first = journalOwner.migrateGovernanceChainHash({ confirm: true, identity: null });
    assert.equal(first.status, "migrated");
    const second = journalOwner.migrateGovernanceChainHash({ confirm: true, identity: null });
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
      () => journalOwner.migrateGovernanceChainHash({ confirm: true, identity: null }),
      /does not currently verify/
    );
  });
});

test("COORD-289: chain repair within the sha256 era holds the content multiset across eras", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    const { events } = buildMixedEraFixture();
    // Cross a sha256-era link (event #5's prev) so the chain is broken but the
    // bodies are intact — exactly the crossed-link case repair is meant to heal.
    const crossed = events.map((e, i) => (i === 5 ? { ...e, prev_event_hash: "f".repeat(64) } : e));
    writeFixtureJournal(logPath, crossed);
    assert.equal(journalOwner.verifyGovernanceChain().ok, false, "crossed sha256 link is broken");

    const result = journalOwner.repairGovernanceChain({
      confirm: true,
      reason: "COORD-289 era-aware repair test",
      identity: null,
    });
    assert.equal(result.status, "repaired");
    assert.equal(journalOwner.verifyGovernanceChain().ok, true, "repair re-links the sha256 era");
    // The repaired chain still presents both eras correctly.
    const chain = journalOwner.verifyGovernanceChain();
    assert.equal(chain.headAlg, "sha256");
    assert.ok(chain.sha256ChainedCount >= 3);
  });
});

// COORD-698: a failed rollback must leave an UNCHANGED foreign lock byte-identical
// AND filesystem-identical.
//
// captureGovernanceRestorePoint() snapshots every *.lock under existingLockDirs(),
// so a sibling agent's lock is in the restore point of a transaction that never
// touches it. restoreGovernanceRestorePoint() then rewrote every captured entry
// unconditionally through writeFileAtomicSync — temp file plus rename — which
// replaces the inode and moves mtime/ctime even when the bytes are identical.
// Content-only assertions cannot see that, which is why this regression went
// unnoticed: the lock "looked" restored while its filesystem identity had been
// swapped underneath a live sibling owner.
//
// atime is deliberately NOT asserted: reading the fixture to compare bytes
// updates it, so it carries no signal here.
test("COORD-698: a failed mutation leaves an unchanged foreign lock's bytes and filesystem identity intact", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-foreign-lock-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
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
  fs.writeFileSync(questionsPath, "# Questions\n");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  // A sibling agent's lock, owned by another handle and untouched by the
  // transaction below.
  const foreignLockPath = path.join(locksDir, "SIB-001.lock");
  const foreignLockBody = `${JSON.stringify({ ticket: "SIB-001", owner: "codexa700", status: "doing" }, null, 2)}\n`;
  fs.writeFileSync(foreignLockPath, foreignLockBody);
  fs.chmodSync(foreignLockPath, 0o640);
  // Pin mtime into the past so an unchanged file is provable regardless of clock
  // granularity: a rewrite would move it to now.
  const pinnedSeconds = Math.floor(Date.now() / 1000) - 120;
  fs.utimesSync(foreignLockPath, pinnedSeconds, pinnedSeconds);
  const before = fs.statSync(foreignLockPath);

  try {
    withScopedGovernanceTestContext({
      BOARD_PATH: boardPath,
      PLAN_PATH: planPath,
      QUESTIONS_PATH: questionsPath,
      AGENTS_PATH: agentsPath,
      AGENT_SESSIONS_PATH: sessionsPath,
      PLAN_RECORDS_DIR: recordsDir,
      PROMPTS_DIR: promptsDir,
      DECISIONS_DIR: path.join(path.dirname(promptsDir), "docs", "decisions"),
      RENDERED_DIR: renderedDir,
      LOCKS_DIR: locksDir,
      RUNTIME_DIR: runtimeDir,
      GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
      GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
      GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
      GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    }, () => {
      journalOwner.ensureGovernanceJournalBaseline("test-seed");
      assert.throws(
        () =>
          __testing.withGovernanceMutation({ command: "test-foreign-lock" }, () => {
            // Change only LOCAL state; never touch the sibling's lock.
            fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ heading: "mutated" }] }, null, 2));
            throw new GovernanceError("synthetic failure");
          }),
        (error) => error instanceof GovernanceError && /synthetic failure/.test(error.message)
      );

      // Local state is rolled back — the transaction still restores what it changed.
      assert.equal(fs.readFileSync(boardPath, "utf8"), JSON.stringify({ sections: [] }, null, 2));

      // The foreign lock is untouched, in content AND in filesystem identity.
      const after = fs.statSync(foreignLockPath);
      assert.equal(fs.readFileSync(foreignLockPath, "utf8"), foreignLockBody, "foreign lock bytes changed");
      assert.equal(after.ino, before.ino, "foreign lock inode was replaced by an atomic rewrite");
      assert.equal(after.mode, before.mode, "foreign lock mode changed");
      assert.equal(after.mtimeMs, before.mtimeMs, "foreign lock mtime moved");
      assert.equal(after.ctimeMs, before.ctimeMs, "foreign lock ctime moved");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit no-baseline mutations refuse missing genesis and preserve successful external receipts", () => {
  withGovernedSurfaceSandbox(({ tempDir, logPath, boardPath, planPath }) => {
    const boardBefore = fs.readFileSync(boardPath);
    const planBefore = fs.readFileSync(planPath);
    let called = false;
    assert.throws(() => __testing.withGovernanceMutation({
      command: "fixture-explicit-baseline", ensureBaseline: false,
    }, () => { called = true; }), /journal.*uninitialized|baseline/i);
    assert.equal(called, false, "missing genesis must refuse before the writer runs");
    assert.equal(fs.existsSync(logPath), false, "explicit no-baseline request must not silently create genesis");
    assert.deepEqual(fs.readFileSync(boardPath), boardBefore);
    assert.deepEqual(fs.readFileSync(planPath), planBefore);

    journalOwner.ensureGovernanceJournalBaseline("explicit receipt fixture");
    const outsideSnapshot = path.join(tempDir, "external-receipt.txt");
    const receipt = { type: "fixture_file_written", path: outsideSnapshot };
    __testing.withGovernanceMutation({ command: "fixture-external-success", ensureBaseline: false }, () => {
      fs.writeFileSync(outsideSnapshot, "actual isolated fixture side effect\n");
      __testing.recordGovernanceExternalSideEffect(receipt);
      fs.writeFileSync(planPath, "recorded fixture completion\n");
    });
    const events = journalOwner.readGovernanceEventLog();
    const event = events.find(entry => entry.command === "fixture-external-success");
    assert.ok(event);
    assert.equal(event.result, "succeeded");
    assert.equal(event.details.external_side_effects.length, 1);
    assert.equal(event.details.external_side_effects[0].type, receipt.type);
    assert.equal(event.details.external_side_effects[0].path, outsideSnapshot);
    assert.equal(fs.readFileSync(outsideSnapshot, "utf8"), "actual isolated fixture side effect\n");
    assert.equal(events.filter(entry => entry.command === "journal-baseline").length, 1);
  });
});

// COORD-722: crash rollback must restore governed files the interrupted mutation
// DELETED (the pre-restore read of the target fails), byte-exactly, including an
// ADR whose bytes do not round-trip through UTF-8. A restore-point entry that
// records a file as existing but carries no bytes (a damaged or hand-edited
// restore point) restores an empty file instead of aborting the rollback half way.
test("COORD-722: crash recovery recreates deleted governed files byte-exactly and survives an entry without bytes", () => {
  withGovernedSurfaceSandbox(({ boardPath, planPath, questionsPath, decisionsDir }) => {
    const adrPath = path.join(decisionsDir, "ADR-0722-restore.md");
    const adrBytes = Buffer.concat([Buffer.from("# ADR-0722\n\nStatus: accepted\n", "utf8"), Buffer.from([0xff, 0xfe, 0x0a])]);
    fs.writeFileSync(adrPath, adrBytes);
    fs.writeFileSync(questionsPath, "# Questions\n\nrow that the damaged entry cannot restore\n", "utf8");
    seedCheckpointEvent();
    const boardRaw = fs.readFileSync(boardPath, "utf8");
    const planRaw = fs.readFileSync(planPath, "utf8");

    const restorePoint = __testing.captureGovernanceRestorePoint();
    const adrEntry = restorePoint.find((entry) => entry.path === adrPath);
    assert.equal(adrEntry.raw, null, "non-UTF-8 ADR bytes are not kept as decoded text");
    assert.equal(Buffer.from(adrEntry.raw_base64, "base64").equals(adrBytes), true);
    const questionsEntry = restorePoint.find((entry) => entry.path === questionsPath);
    questionsEntry.raw = null;
    __testing.persistGovernanceRestorePoint(restorePoint, { command: "adr", ticket: "T-722" });

    // The interrupted mutation removed two governed files and rewrote the board.
    fs.rmSync(adrPath);
    fs.rmSync(planPath);
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "broken" }] }), "utf8");

    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "restored");
    assert.equal(outcome.interruptedCommand, "adr");
    assert.equal(fs.readFileSync(adrPath).equals(adrBytes), true, "the deleted ADR is recreated with its exact bytes");
    assert.equal(fs.readFileSync(planPath, "utf8"), planRaw, "the deleted plan is recreated");
    assert.equal(fs.readFileSync(boardPath, "utf8"), boardRaw);
    assert.equal(fs.readFileSync(questionsPath, "utf8"), "", "an existing entry without recorded bytes restores as an empty file");
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    const last = journalOwner.readGovernanceEventLog().at(-1);
    assert.equal(last.command, "crash-rollback");
    assert.equal(last.ticket, "T-722");
  });
});

// COORD-929: ticket locks live under coord/.runtime/locks, which git ignores
// (.runtime/.gitignore). Crash recovery used to drop every gitignored drift path,
// so a lock-only change left by an interrupted mutation looked consistent, and the
// restore point was discarded instead of rolling the lock back. These sandboxes
// reproduce the real layout: a git work tree whose .runtime ignores everything.
function withIgnoredRuntimeLockSandbox(fn) {
  return withGovernedSurfaceSandbox(({ tempDir, runtimeDir }) => {
    execFileSync("git", ["init", "-q"], { cwd: tempDir });
    fs.writeFileSync(path.join(runtimeDir, ".gitignore"), "*\n");
    fn({ locksDir: path.join(runtimeDir, "locks") });
  });
}

function ticketLockPayload(owner) {
  return `${JSON.stringify({
    ticket: "T-929",
    owner,
    status: "doing",
    repo: "X",
    branch: "agent/t-929",
    head: "0000000",
    worktree: "/tmp/t-929",
    started_at_utc: "2026-11-12T00:00:00.000Z",
  }, null, 2)}\n`;
}

test("COORD-929: crash between lock creation and journal append removes the new lock", () => {
  withIgnoredRuntimeLockSandbox(({ locksDir }) => {
    seedCheckpointEvent();
    const lockPath = path.join(locksDir, "T-929.lock");
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "start", ticket: "T-929" });
    fs.writeFileSync(lockPath, ticketLockPayload("claudea801"), "utf8");

    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "restored");
    assert.equal(outcome.interruptedCommand, "start");
    assert.equal(fs.existsSync(lockPath), false, "the lock the interrupted mutation created is removed");
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    assert.equal(journalOwner.readGovernanceEventLog().at(-1).command, "crash-rollback");
  });
});

test("COORD-929: crash between lock rebind and journal append restores the previous lock bytes", () => {
  withIgnoredRuntimeLockSandbox(({ locksDir }) => {
    const lockPath = path.join(locksDir, "T-929.lock");
    const foreignPath = path.join(locksDir, "T-930.lock");
    const original = ticketLockPayload("claudea800");
    fs.writeFileSync(lockPath, original, "utf8");
    fs.writeFileSync(foreignPath, ticketLockPayload("claudea799"), "utf8");
    seedCheckpointEvent();
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "claim", ticket: "T-929" });
    // The rebind rewrites the lock to the new owner, then the process dies.
    fs.writeFileSync(lockPath, ticketLockPayload("claudea801"), "utf8");
    // Precondition of the bug: git ignores the runtime lock, so the ignored-drift filter drops it.
    assert.equal(__testing.detectGovernanceProvenanceDrift().drift.some((entry) => entry.endsWith("T-929.lock")), false, "git ignores the runtime lock, as in the real tree");
    const foreignBefore = fs.statSync(foreignPath);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().lockDrift, [`${path.relative(COORD_DIR, lockPath).replace(/\\/g, "/")}`], "the rebound lock is reported as lock drift");

    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "restored");
    assert.equal(fs.readFileSync(lockPath, "utf8"), original, "the rebound lock returns to its pre-mutation bytes");
    const foreignAfter = fs.statSync(foreignPath);
    assert.equal(foreignAfter.ino, foreignBefore.ino, "an unchanged foreign lock keeps its inode (COORD-698)");
    assert.equal(foreignAfter.mtimeMs, foreignBefore.mtimeMs, "an unchanged foreign lock keeps its mtime (COORD-698)");
  });
});

test("COORD-929: crash between lock removal and journal append restores the removed lock", () => {
  withIgnoredRuntimeLockSandbox(({ locksDir }) => {
    const lockPath = path.join(locksDir, "T-929.lock");
    const original = ticketLockPayload("claudea800");
    fs.writeFileSync(lockPath, original, "utf8");
    seedCheckpointEvent();
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "finalize", ticket: "T-929" });
    fs.rmSync(lockPath);

    const outcome = __testing.recoverCrashedGovernanceMutation();
    assert.equal(outcome.action, "restored");
    assert.equal(fs.readFileSync(lockPath, "utf8"), original, "the removed lock is recreated with its exact bytes");
    assert.equal(journalOwner.readGovernanceEventLog().at(-1).command, "crash-rollback");
  });
});

// COORD-935: exercise real journal/renderer transactions in an isolated board.
function withDerivedSyncFixture(fn) {
  return withGovernedSurfaceSandbox((fixture) => {
    const boardApi = require("../../board/board.js");
    // Materialize every projection before the baseline, as an installed board does.
    boardApi.renderBoardArtifacts();
    journalOwner.ensureGovernanceJournalBaseline("coord-935-fixture");
    const sync = () => journalOwner.withGovernanceMutation({ command: "sync", preserveAgentState: true }, () => boardApi.syncBoardArtifacts());
    fn({ ...fixture, boardApi, sync });
  }, { isolateBoardValidation: true });
}

test("COORD-935: exact raw board regeneration recovers once through journaled sync", () => {
  withDerivedSyncFixture(({ planPath, boardApi, sync }) => {
    journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => {
      fs.writeFileSync(planPath, "## Legacy compatible plan projection\n");
    });
    boardApi.syncBoardArtifacts();
    assert.ok(journalOwner.detectGovernanceProvenanceDrift().drift.length > 0);
    assert.throws(() => journalOwner.withGovernanceMutation({ command: "test-mutation" }, () => {}), /out-of-band/);
    sync();
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
    const events = journalOwner.readGovernanceEventLog();
    const recovered = events.filter(e => e.details?.derived_sync_recovery);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].details.derived_sync_recovery.length, 1);
    sync();
    assert.equal(journalOwner.readGovernanceEventLog().filter(e => e.details?.derived_sync_recovery).length, 1);
  });
});

test("COORD-935: manual PLAN and mixed authoritative edits refuse without changes", () => {
  for (const kind of ["manual-plan", "board", "plan-record", "prompt", "policy", "governance-policy", "project-config"]) {
    withDerivedSyncFixture(({ planPath, boardPath, recordsDir, promptsDir, decisionsDir, boardApi, sync, logPath }) => {
      journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
      boardApi.syncBoardArtifacts();
      if (kind === "manual-plan") fs.appendFileSync(planPath, "unreviewed semantic content\n");
      if (kind === "board") { const b = JSON.parse(fs.readFileSync(boardPath)); b.metadata.title = "unapproved"; fs.writeFileSync(boardPath, JSON.stringify(b)); }
      if (kind === "plan-record") fs.writeFileSync(path.join(recordsDir, "COORD-021.json"), "{}\n");
      if (kind === "prompt") fs.writeFileSync(path.join(promptsDir, "tickets/COORD-021.md"), "unapproved\n");
      if (kind === "policy") fs.writeFileSync(path.join(decisionsDir, "policy.md"), "unapproved\n");
      if (kind === "governance-policy") fs.writeFileSync(path.join(path.dirname(planPath), "GOVERNANCE.md"), "unapproved policy\n");
      if (kind === "project-config") fs.writeFileSync(path.join(path.dirname(planPath), "project.config.js"), "unapproved configuration\n");
      const before = journalOwner.buildGovernanceSnapshot().digest;
      const log = fs.readFileSync(logPath, "utf8");
      assert.throws(sync);
      assert.equal(journalOwner.buildGovernanceSnapshot().digest, before, kind);
      assert.equal(fs.readFileSync(logPath, "utf8"), log, kind);
    });
  }
});

test("COORD-935: direct CLI sync refuses initialized board without changing files", () => {
  withDerivedSyncFixture(({ boardApi, logPath }) => {
    const before = journalOwner.buildGovernanceSnapshot().digest;
    const log = fs.readFileSync(logPath, "utf8");
    assert.throws(() => boardApi.main(["sync"]), /Run coord\/scripts\/gov sync/);
    assert.throws(() => boardApi.main(["render"]), /not journaled/);
    assert.equal(journalOwner.buildGovernanceSnapshot().digest, before);
    assert.equal(fs.readFileSync(logPath, "utf8"), log);
  });
});

test("COORD-935: failed regeneration preserves drift and allows a later retry", () => {
  withDerivedSyncFixture(({ planPath, boardApi, sync }) => {
    journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
    boardApi.syncBoardArtifacts();
    assert.throws(() => journalOwner.withGovernanceMutation({ command: "sync", preserveAgentState: true }, () => {
      fs.writeFileSync(planPath, "partial\n"); throw new Error("injected render failure");
    }), /injected render failure/);
    assert.ok(journalOwner.detectGovernanceProvenanceDrift().drift.length > 0);
    sync();
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  });
});
test("COORD-935: real update-plan renderer followed by board sync exposes the drift", () => {
  withDerivedSyncFixture(({ boardPath, planPath, boardApi, sync }) => {
    journalOwner.withGovernanceMutation({ command: "fixture-seed", preserveAgentState: true }, () => {
      const board = JSON.parse(fs.readFileSync(boardPath));
      board.sections.push({ kind: "table", level: 2, heading: "Work", separator_before: false, columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [{ ID: "COORD-021", Repo: "X", Type: "feature", Pri: "P2", Status: "todo", Owner: "unassigned", Description: "fixture", "Depends On": "" }] });
      fs.writeFileSync(boardPath, JSON.stringify(board));
      __testing.ensurePlanStub("COORD-021", "X", "codexa02");
      boardApi.syncBoardArtifacts();
    });
    journalOwner.withGovernanceMutation({ command: "update-plan", ticket: "COORD-021", preserveAgentState: true }, () => {
      __testing.updateCanonicalPlanState("COORD-021", { summary: "Keep canonical evidence", verify: "node --test fixture.js" });
    });
    assert.match(fs.readFileSync(planPath, "utf8"), /Keep canonical evidence/);
    boardApi.syncBoardArtifacts(); // historical CLI's exact renderer; fixed CLI refuses before calling it
    assert.ok(journalOwner.detectGovernanceProvenanceDrift().drift.length);
    sync();
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  });
});
test("COORD-935: unavailable baseline and unsafe generated file types are refused", () => {
  for (const kind of ["deleted-journal", "pruned", "symlink", "executable"]) {
    withDerivedSyncFixture(({ planPath, logPath, snapshotsDir, snapshotPath, boardApi, sync }) => {
      journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
      boardApi.syncBoardArtifacts();
      if (kind === "deleted-journal") fs.unlinkSync(logPath);
      if (kind === "pruned") { fs.rmSync(snapshotsDir, { recursive: true, force: true }); fs.rmSync(snapshotPath, { force: true }); }
      if (kind === "symlink") { fs.renameSync(planPath, planPath + ".saved"); fs.symlinkSync(planPath + ".saved", planPath); }
      if (kind === "executable") fs.chmodSync(planPath, 0o755);
      assert.throws(sync, undefined, kind);
    });
  }
});
test("COORD-935: sync service accepts proven drift but refuses a stale proof", () => {
  for (const tamper of [false, true]) withDerivedSyncFixture(({ planPath, boardApi }) => {
    journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
    boardApi.syncBoardArtifacts();
    const service = require("./sync-provenance.js")({
      withGovernanceMutation: (m, fn) => journalOwner.withGovernanceMutation({ ...m, preserveAgentState: true }, fn),
      detectGovernanceProvenanceDrift: () => {
        if (tamper) fs.writeFileSync(planPath, "changed after proof\n");
        return journalOwner.detectGovernanceProvenanceDrift();
      },
      splitGovernanceProvenanceDrift: drift => ({ blocking: drift }),
      state: journalState, runBoardSync: () => boardApi.syncBoardArtifacts(),
      canonicalSyncablePaths: () => [], computeSyncDelta: () => [],
      isInsideGitWorkTree: () => true, relativeCoordPath: p => path.relative(COORD_DIR, p),
      readBoard: () => ({ sections: [] }), getRows: () => [], isDoingStatus: () => false,
      findLockForTicket: () => null, isStaleTicketLock: () => false,
      resolveCurrentAgentId: () => null, gitTry: () => ({ status: 0, stdout: "" }),
      fail: message => { throw new GovernanceError(message); }, COORD_DIR,
      DEFAULT_PATHS: { boardPath: journalState.BOARD_PATH },
    });
    if (tamper) {
      assert.throws(() => service.runSyncCommand({ quiet: true }), /unapproved governance drift/);
      assert.ok(journalOwner.detectGovernanceProvenanceDrift().drift.length);
    } else {
      service.runSyncCommand({ quiet: true });
      assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
    }
  });
});
test("COORD-935: preview is read-only and journalless bootstrap still renders", () => {
  withDerivedSyncFixture(({ boardApi, logPath }) => {
    const before = journalOwner.buildGovernanceSnapshot().digest;
    const log = fs.readFileSync(logPath, "utf8");
    const outputs = boardApi.previewBoardArtifacts();
    assert.equal(outputs.length, 5);
    assert.equal(journalOwner.buildGovernanceSnapshot().digest, before);
    assert.equal(fs.readFileSync(logPath, "utf8"), log);
    fs.unlinkSync(logPath);
    assert.doesNotThrow(() => boardApi.main(["sync"]));
    assert.equal(fs.existsSync(logPath), false);
  });
});
test("COORD-935: legacy or corrupt snapshots cannot prove derived recovery", () => {
  withDerivedSyncFixture(({ planPath, boardApi }) => {
    journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
    const baseline = journalOwner.buildGovernanceSnapshot();
    boardApi.syncBoardArtifacts();
    const current = journalOwner.buildGovernanceSnapshot();
    const { proveDerivedSync } = require("./derived-sync-recovery.js");
    const digest = text => crypto.createHash("sha1").update(text).digest("hex");
    const input = { baseline, current, outputs: boardApi.previewBoardArtifacts(), resolvePath: p => path.resolve(COORD_DIR, p), digest };
    assert.ok(proveDerivedSync(input));
    assert.equal(proveDerivedSync({ ...input, baseline: { ...baseline, digest: "corrupt" } }), null);
    const files = baseline.files.filter(e => !e.path.endsWith("GOVERNANCE.md"));
    assert.equal(proveDerivedSync({ ...input, baseline: { ...baseline, files, digest: digest(JSON.stringify(files)) } }), null);
    assert.equal(proveDerivedSync({ ...input, baseline: null }), null);
    assert.equal(proveDerivedSync({ ...input, current: baseline }), null, "without changes there is nothing to adopt");
    const planEntry = current.files.find((entry) => path.resolve(COORD_DIR, entry.path) === planPath);
    assert.ok(planEntry?.exists);
    const planStats = fs.statSync(planPath);
    const planBytes = fs.readFileSync(planPath);
    fs.chmodSync(planPath, planStats.mode | 0o100);
    try {
      assert.equal(proveDerivedSync(input), null, "content equality does not approve an executable generated view");
    } finally {
      fs.chmodSync(planPath, planStats.mode);
    }
    fs.unlinkSync(planPath);
    fs.mkdirSync(planPath);
    assert.equal(proveDerivedSync(input), null, "the proof requires regular files");
    fs.rmdirSync(planPath);
    const deleted = { ...current, files: current.files.map((entry) =>
      entry === planEntry ? { ...entry, exists: false, digest: null } : entry) };
    assert.equal(proveDerivedSync({ ...input, current: deleted }), null, "deleting a generated view is not a valid sync proof");
    fs.writeFileSync(planPath, "bytes changed after the snapshot");
    assert.equal(proveDerivedSync(input), null, "each live file must still match its snapshot");
    fs.writeFileSync(planPath, planBytes, { mode: planStats.mode });
    assert.ok(proveDerivedSync(input));

  });
});
test("COORD-935: mixed generated-view drift plus a canonical edit is refused without changes", () => {
  for (const canonical of ["board", "policy"]) {
    withDerivedSyncFixture(({ planPath, boardPath, boardApi, sync, logPath }) => {
      journalOwner.withGovernanceMutation({ command: "update-plan", preserveAgentState: true }, () => fs.writeFileSync(planPath, "legacy\n"));
      boardApi.syncBoardArtifacts();
      // Generated view drifts (PLAN.md would be rewritten by sync) and a canonical input drifts too.
      fs.appendFileSync(planPath, "hand-edited plan text\n");
      if (canonical === "board") {
        const b = JSON.parse(fs.readFileSync(boardPath));
        b.metadata.title = "unapproved";
        fs.writeFileSync(boardPath, JSON.stringify(b));
      } else {
        fs.writeFileSync(path.join(path.dirname(planPath), "GOVERNANCE.md"), "unapproved policy\n");
      }
      const before = journalOwner.buildGovernanceSnapshot().digest;
      const log = fs.readFileSync(logPath, "utf8");
      assert.throws(sync, /Refusing sync over unapproved governance drift/, canonical);
      assert.equal(journalOwner.buildGovernanceSnapshot().digest, before, canonical);
      assert.equal(fs.readFileSync(logPath, "utf8"), log, canonical);
    });
  }
});

test("pending effect recovery preserves complete records around a torn write and reports read errors", () => {
  const effects = require("./governance-side-effects.js");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pending-effect-recovery-"));
  const originalRuntime = journalState.RUNTIME_DIR;
  const originalMutation = journalState.activeGovernanceMutationContext;
  try {
    journalState.RUNTIME_DIR = runtime;
    journalState.activeGovernanceMutationContext = null;
    assert.equal(effects.inGovernanceMutation(), false);
    journalState.activeGovernanceMutationContext = { externalSideEffects: [] };
    assert.equal(effects.inGovernanceMutation(), true);
    const events = [];
    effects.setCrashPointHook((name, context) => events.push({ name, context }));
    effects.recordGovernanceExternalSideEffect({ detail: "external action completed" });
    effects.setCrashPointHook(null);
    effects.crashPoint("after-reset");
    assert.deepEqual(events, [{ name: "external-effect-recorded", context: { type: null } }]);
    const recorded = journalState.activeGovernanceMutationContext.externalSideEffects;
    const pending = path.join(runtime, "governance-external-effects.ndjson");
    fs.appendFileSync(pending, '{"truncated":');
    assert.deepEqual(effects.readPendingGovernanceExternalSideEffects(), recorded);
    effects.clearPendingGovernanceExternalSideEffects();
    assert.deepEqual(effects.readPendingGovernanceExternalSideEffects(), []);
    fs.mkdirSync(pending);
    assert.throws(() => effects.readPendingGovernanceExternalSideEffects(), { code: "EISDIR" });
  } finally {
    effects.setCrashPointHook(null);
    journalState.activeGovernanceMutationContext = originalMutation;
    journalState.RUNTIME_DIR = originalRuntime;
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

function persistFixtureEffect(file) {
  fs.writeFileSync(file, "completed external fixture effect\n");
  const original = journalState.activeGovernanceMutationContext;
  const context = { externalSideEffects: [] };
  journalState.activeGovernanceMutationContext = context;
  try {
    assert.deepEqual(__testing.recordGovernanceExternalSideEffect({ type: "fixture_file_written", path: file }), { recorded: true });
    return context.externalSideEffects[0];
  } finally {
    journalState.activeGovernanceMutationContext = original;
  }
}

test("orphaned effects preserve pre-existing drift and are recovered exactly once", () => {
  withGovernedSurfaceSandbox(({ tempDir, runtimeDir, planPath, logPath }) => {
    seedCheckpointEvent();
    const receipt = path.join(tempDir, "outside-governed-snapshot.txt");
    const effect = persistFixtureEffect(receipt);
    const pendingPath = path.join(runtimeDir, "governance-external-effects.ndjson");
    const pendingBytes = fs.readFileSync(pendingPath);
    fs.appendFileSync(planPath, "\npre-existing unreviewed change\n");
    const pendingDrift = journalOwner.detectGovernanceProvenanceDrift().drift;
    assert.deepEqual(pendingDrift, [path.relative(COORD_DIR, planPath).split(path.sep).join("/")]);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);

    assert.deepEqual(__testing.recoverCrashedGovernanceMutation(), { action: "effects-recorded" });
    const recovered = journalOwner.readGovernanceEventLog().at(-1);
    assert.equal(recovered.command, "crash-rollback");
    assert.equal(recovered.result, "effects-recorded");
    assert.equal(recovered.ticket, null);
    assert.deepEqual(recovered.details, { interrupted_command: null, interrupted_at: null, external_side_effects: [effect] });
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, pendingDrift);
    assert.equal(fs.readFileSync(receipt, "utf8"), "completed external fixture effect\n");
    assert.equal(fs.existsSync(pendingPath), false);
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);

    // If recovery was interrupted after journaling the receipt, effect_id still
    // prevents the same external effect from being appended again.
    const journal = fs.readFileSync(logPath);
    fs.writeFileSync(pendingPath, pendingBytes);
    assert.equal(__testing.recoverCrashedGovernanceMutation(), null);
    assert.equal(fs.existsSync(pendingPath), false);
    assert.deepEqual(fs.readFileSync(logPath), journal);
  }, { coordRelativePaths: true });
});

test("an interrupted mutation with consistent local state retains its external receipt and attribution", () => {
  withGovernedSurfaceSandbox(({ tempDir, runtimeDir, planPath }) => {
    seedCheckpointEvent();
    const planBefore = fs.readFileSync(planPath);
    const restore = __testing.captureGovernanceRestorePoint();
    __testing.persistGovernanceRestorePoint(restore, { command: "fixture-publish", ticket: "T-950" });
    const persisted = JSON.parse(fs.readFileSync(__testing.governanceRestorePointPath(), "utf8"));
    const receipt = path.join(tempDir, "externally-delivered.txt");
    const effect = persistFixtureEffect(receipt);

    assert.deepEqual(__testing.recoverCrashedGovernanceMutation(), { action: "discarded_consistent" });
    const event = journalOwner.readGovernanceEventLog().at(-1);
    assert.equal(event.result, "effects-recorded");
    assert.equal(event.ticket, persisted.ticket);
    assert.deepEqual(event.details, {
      interrupted_command: persisted.command, interrupted_at: persisted.ts, external_side_effects: [effect],
    });
    assert.deepEqual(fs.readFileSync(planPath), planBefore);
    assert.equal(fs.existsSync(path.join(runtimeDir, "governance-external-effects.ndjson")), false);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);
  }, { coordRelativePaths: true });
});

test("an interrupted restore preserves pending external receipts while restoring local bytes", () => {
  withGovernedSurfaceSandbox(({ tempDir, runtimeDir, planPath }) => {
    seedCheckpointEvent();
    const original = fs.readFileSync(planPath);
    const restore = __testing.captureGovernanceRestorePoint();
    __testing.persistGovernanceRestorePoint(restore, { command: "fixture-interrupted", ticket: "T-950" });
    fs.writeFileSync(planPath, "partial local mutation\n");
    const receipt = path.join(tempDir, "external-action.txt");
    const effect = persistFixtureEffect(receipt);

    assert.deepEqual(__testing.recoverCrashedGovernanceMutation(), { action: "restored", interruptedCommand: "fixture-interrupted" });
    assert.deepEqual(fs.readFileSync(planPath), original);
    assert.equal(fs.readFileSync(receipt, "utf8"), "completed external fixture effect\n");
    assert.equal(fs.existsSync(path.join(runtimeDir, "governance-external-effects.ndjson")), false);
    assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
    const recovered = journalOwner.readGovernanceEventLog().at(-1);
    assert.equal(recovered.ticket, "T-950");
    assert.equal(recovered.result, "restored");
    assert.deepEqual(recovered.details.external_side_effects, [effect]);
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);
  }, { coordRelativePaths: true });
});

test("the snapshot checkpoint refuses missing required and invalid persisted state without writing", () => {
  withGovernedSurfaceSandbox(({ snapshotPath, logPath }) => {
    seedCheckpointEvent();
    const persisted = fs.readFileSync(snapshotPath);
    const journal = fs.readFileSync(logPath);
    fs.rmSync(snapshotPath);
    assert.throws(() => journalOwner.readGovernanceSnapshotCheckpoint(), /snapshot checkpoint .* is missing/);
    assert.equal(fs.existsSync(snapshotPath), false);
    const invalid = JSON.stringify({ digest: " " });
    fs.writeFileSync(snapshotPath, invalid);
    assert.throws(() => journalOwner.detectGovernanceProvenanceDrift(), /Invalid governance snapshot checkpoint/);
    assert.equal(fs.readFileSync(snapshotPath, "utf8"), invalid);
    assert.deepEqual(fs.readFileSync(logPath), journal);
    fs.writeFileSync(snapshotPath, persisted);
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, []);
  }, { coordRelativePaths: true });
});

test("a legacy snapshot tolerates absent derived policy but still reports board drift", () => {
  withGovernedSurfaceSandbox(({ boardPath, planPath, logPath }) => {
    const policy = path.join(path.dirname(planPath), "GOVERNANCE.md");
    fs.writeFileSync(policy, "# Fixture policy\n");
    const normalize = (file) => path.relative(COORD_DIR, file).split(path.sep).join("/");
    const current = journalOwner.buildGovernanceSnapshot();
    assert.ok(current.files.some((entry) => entry.path === normalize(policy)));
    const files = current.files.filter((entry) => entry.path !== normalize(policy));
    const digest = crypto.createHash("sha1").update(JSON.stringify(files)).digest("hex");
    const legacy = { command: "journal-baseline", prev_event_hash: "genesis", snapshot: { ...current, digest, files } };
    writeFixtureJournal(logPath, [legacy]);
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [{ ID: "T-935", Status: "todo" }] }] }));
    assert.deepEqual(journalOwner.detectGovernanceProvenanceDrift().drift, [normalize(boardPath)]);

    writeFixtureJournal(logPath, [{ ...legacy, snapshot: { digest } }]);
    const digestOnly = journalOwner.detectGovernanceProvenanceDrift();
    assert.equal(digestOnly.uninitialized, false);
    assert.ok(digestOnly.drift.includes(normalize(boardPath)), "a legacy digest alone cannot attest known board bytes");
    assert.ok(!digestOnly.drift.includes(normalize(policy)));
  }, { coordRelativePaths: true });
});

test("the stale drift note command previews without writing and retires only the dated note", (t) => {
  withGovernedSurfaceSandbox(({ questionsPath, logPath }) => {
    const row = "| 2026-06-09 | codexa11 | orchestrator | Governance drift observed while running gov start T-10: coord/PLAN.md | Detected unjournaled governed-state drift since 2026-06-09T00:00:00.000Z. | no |";
    const other = "| 2026-06-09 | codexa11 | orchestrator | Ordinary outstanding question | TBD | no |";
    const notes = `# Questions\n\n${row}\n${other}\n`;
    fs.writeFileSync(questionsPath, notes);
    seedCheckpointEvent();
    const originalJournal = fs.readFileSync(logPath);
    const output = [];
    t.mock.method(console, "log", (text) => output.push(JSON.parse(text)));
    const now = new Date("2026-06-11T00:00:00.000Z");
    const preview = journalOwner.retireStaleDriftNotes({ dryRun: true, now });
    assert.equal(output[0].status, "dry-run");
    assert.equal(preview.retired.length, 1);
    assert.equal(fs.readFileSync(questionsPath, "utf8"), notes);
    assert.deepEqual(fs.readFileSync(logPath), originalJournal);
    const applied = journalOwner.retireStaleDriftNotes({ now });
    assert.equal(output[1].status, "retired");
    assert.deepEqual(applied.retired, preview.retired);
    const updated = fs.readFileSync(questionsPath, "utf8");
    assert.match(updated, /Retired by gov retire-stale-drift-notes.*\| yes \|/);
    assert.ok(updated.includes(other));
    assert.equal(journalOwner.readGovernanceEventLog().at(-1).command, "retire-stale-drift-notes");
    assert.equal(journalOwner.verifyGovernanceChain().ok, true);
    const finalJournal = fs.readFileSync(logPath);
    const retry = journalOwner.retireStaleDriftNotes({ now });
    assert.equal(output[2].status, "noop");
    assert.deepEqual(retry.retired, []);
    assert.deepEqual(fs.readFileSync(logPath), finalJournal);
  }, { coordRelativePaths: true });
});
