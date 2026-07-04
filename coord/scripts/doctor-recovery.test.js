// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCoordPaths } = require("../paths.js");
const { __testing, createTempGitRepo } = require("./governance-test-utils.js");

// COORD-063 (final Wave 2 slice): tests for the extracted doctor-recovery.js
// surface — the MUTATING governance repair pass driven through `doctor --fix`
// (doctorFix). The recovery functions are reached through the lifecycle
// __testing facade, which now wires the createDoctorRecovery factory after the
// journal / board-state factories. Hermetic identity env: strip ambient ids so
// host-injected session/thread ids cannot leak into the rebuild fixtures.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

test("COORD-392: doctor --repair-all is a dry-run by default and requires confirmation", () => {
  const createDoctorRecovery = require("./doctor-recovery.js");
  let mutated = false;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const recovery = createDoctorRecovery({
      withGovernanceMutation: () => {
        mutated = true;
        throw new Error("dry-run must not mutate");
      },
    });
    const payload = recovery.doctorFix({ repairAll: true });
    assert.equal(payload.mode, "dry-run");
    assert.equal(payload.confirmation_required, true);
    assert.match(payload.apply_command, /doctor --repair-all --confirm/);
  } finally {
    console.log = originalLog;
  }
  assert.equal(mutated, false);
  assert.match(logs.join("\n"), /\"mode\": \"dry-run\"/);
  assert.match(logs.join("\n"), /repair-chain/);
});

test("doctorFix repairs ticket-scoped plan stub, non-doing lock, and orphan coord worktree", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-doctor-fix-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const worktreePath = path.join(tempDir, ".worktrees", "codexa00", "DEBT-900");
  const lockPath = path.join(locksDir, "DEBT-900.lock");
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
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {
      title: "Test Board",
      last_updated: "2026-03-30",
      canonical_references: [],
      plan_records_required_from_ticket: "DEBT-001",
      landing_index_required_from_ticket: "IMP-120",
      plan_markdown_render_statuses: ["doing", "review", "done", "deferred", "superseded", "todo"],
    },
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Debt",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "DEBT-900",
            Repo: "X",
            Type: "infra",
            Pri: "P2",
            Status: "todo",
            Owner: "unassigned",
            Description: "Test repair target",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: "codexa00",
    ticket: "DEBT-900",
    status: "doing",
    repo: "coord",
    branch: "agent/codexa00-debt-900-test",
    head: "coord-no-git-head",
    worktree: worktreePath,
    started_at_utc: "2026-03-29T12:00:00.000Z",
    heartbeat_utc: "2026-03-29T12:00:00.000Z",
  }, null, 2), "utf8");

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
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true, ticket: "DEBT-900" }));
    assert.equal(fs.existsSync(path.join(recordsDir, "DEBT-900.json")), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(worktreePath), false);
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

test("COORD-371: board-wide doctorFix does NOT rewrite an existing plan record (non-destructive)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord371-doctor-nondestructive-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  const keys = [
    "BOARD_PATH", "PLAN_PATH", "QUESTIONS_PATH", "AGENTS_PATH", "AGENT_SESSIONS_PATH",
    "PLAN_RECORDS_DIR", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "RUNTIME_DIR",
    "GOVERNANCE_EVENT_LOG_PATH", "GOVERNANCE_SNAPSHOT_PATH", "GOVERNANCE_SNAPSHOTS_DIR", "GOVERNANCE_EVENT_LOCK_DIR",
  ];
  const original = Object.fromEntries(keys.map((k) => [k, __testing.paths[k]]));

  fs.writeFileSync(path.join(tempDir, "tasks.json"), JSON.stringify({
    version: 1,
    metadata: { title: "Test", plan_markdown_render_statuses: ["done"] },
    sections: [{
      kind: "table", level: 2, heading: "Debt", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: "DEBT-950", Repo: "X", Type: "infra", Pri: "P2", Status: "done", Owner: "unassigned", Description: "done ticket", "Depends On": "" }],
    }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {}, followup_exceptions: {},
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(tempDir, "PLAN.md"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "QUESTIONS.md"), "# Questions\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "agents.json"), "[]\n", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "agent_sessions.json"), "[]\n", "utf8");
  // A MINIMAL existing plan record: normalization WOULD expand it (changed=true),
  // so the old unguarded readPlanRecord would repair-WRITE it during board-wide
  // doctorFix. The fix (skipRepairWrite on the existence check) must leave it intact.
  const recordPath = path.join(recordsDir, "DEBT-950.json");
  const seed = `${JSON.stringify({ schema_version: 1, ticket_id: "DEBT-950" }, null, 2)}\n`;
  fs.writeFileSync(recordPath, seed, "utf8");

  __testing.paths.BOARD_PATH = path.join(tempDir, "tasks.json");
  __testing.paths.PLAN_PATH = path.join(tempDir, "PLAN.md");
  __testing.paths.QUESTIONS_PATH = path.join(tempDir, "QUESTIONS.md");
  __testing.paths.AGENTS_PATH = path.join(tempDir, "agents.json");
  __testing.paths.AGENT_SESSIONS_PATH = path.join(runtimeDir, "agent_sessions.json");
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "legacy-locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");

  try {
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true }));
    assert.equal(
      fs.readFileSync(recordPath, "utf8"),
      seed,
      "board-wide doctor --fix must NOT rewrite an existing plan record (COORD-371 §11.1 non-destructive)"
    );
  } finally {
    for (const k of keys) __testing.paths[k] = original[k];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctorFix rebuilds ticket-scoped board and session mirrors from a canonical lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-doctor-fix-rebuild-"));
  const backendRepo = createTempGitRepo("ebmr-doctor-fix-rebuild-backend-", { "package.json": JSON.stringify({ name: "@template/backend" }, null, 2) });
  const frontendRepo = createTempGitRepo("ebmr-doctor-fix-rebuild-frontend-", { "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2) });
  // COORD-010: board.js pins to THIS coord checkout's real registry
  // (forceProjectConfig), so the symlink shim that gives the board validator
  // real repo dirs must target the same real-config roots, not the config
  // matrix fixture roots.
  const liveRepoRoots = createCoordPaths({ coordDir: path.join(__dirname, ".."), forceProjectConfig: true }).repoRoots;
  const createdRepoRootLinks = [];
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const worktreePath = path.join(tempDir, ".worktrees", "codexa00", "DEBT-901");
  const lockPath = path.join(locksDir, "DEBT-901.lock");
  const now = new Date().toISOString();
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
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {
      title: "Test Board",
      last_updated: now,
      canonical_references: [],
      plan_records_required_from_ticket: "DEBT-001",
      landing_index_required_from_ticket: "IMP-120",
      plan_markdown_render_statuses: ["doing", "review", "done", "deferred", "superseded", "todo"],
    },
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Debt",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "DEBT-901",
            Repo: "X",
            Type: "infra",
            Pri: "P2",
            Status: "todo",
            Owner: "unassigned",
            Description: "Crash-after-lock rebuild target",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([
    {
      id: "a00",
      handle: "codexa00",
      aliases: [],
      provider: "openai",
      status: "active",
      notes: "Test agent",
      created_at: now,
    },
  ], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");
  fs.writeFileSync(lockPath, JSON.stringify({
    agent_id: "a00",
    owner: "codexa00",
    ticket: "DEBT-901",
    status: "doing",
    repo: "coord",
    branch: "agent/codexa00-debt-901-test",
    head: "coord-no-git-head",
    worktree: worktreePath,
    session_id: "a00-rebuild-session",
    started_at_utc: now,
    heartbeat_utc: now,
  }, null, 2), "utf8");

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
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    B: backendRepo.repoRoot,
    F: frontendRepo.repoRoot,
  };
  for (const [repoCode, targetPath] of Object.entries({ B: backendRepo.repoRoot, F: frontendRepo.repoRoot })) {
    const liveRepoRoot = liveRepoRoots[repoCode];
    if (!liveRepoRoot || fs.existsSync(liveRepoRoot)) {
      continue;
    }
    fs.symlinkSync(targetPath, liveRepoRoot, "dir");
    createdRepoRootLinks.push(liveRepoRoot);
  }

  try {
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true, ticket: "DEBT-901" }));
    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const row = boardAfter.sections[0].rows.find((entry) => entry.ID === "DEBT-901");
    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const session = sessionsAfter.find((entry) => entry.session_id === "a00-rebuild-session");
    const planRecord = JSON.parse(fs.readFileSync(path.join(recordsDir, "DEBT-901.json"), "utf8"));

    assert.equal(row.Status, "doing");
    assert.equal(row.Owner, "codexa00");
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(session.handle, "codexa00");
    assert.equal(session.agent_id, "a00");
    assert.equal(session.status, "active");
    assert.equal(session.board_path, boardPath);
    assert.equal(planRecord.intended_files[0], "coord/.worktrees/codexa00/DEBT-901/*");
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
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    for (const liveRepoRoot of createdRepoRootLinks) {
      fs.rmSync(liveRepoRoot, { force: true });
    }
  }
});

test("doctorFix overwrites stale session thread_id from the canonical lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-doctor-fix-thread-id-"));
  const backendRepo = createTempGitRepo("ebmr-doctor-fix-thread-id-backend-", { "package.json": JSON.stringify({ name: "@template/backend" }, null, 2) });
  const frontendRepo = createTempGitRepo("ebmr-doctor-fix-thread-id-frontend-", { "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2) });
  // COORD-010: board.js pins to THIS coord checkout's real registry
  // (forceProjectConfig), so the symlink shim that gives the board validator
  // real repo dirs must target the same real-config roots, not the config
  // matrix fixture roots.
  const liveRepoRoots = createCoordPaths({ coordDir: path.join(__dirname, ".."), forceProjectConfig: true }).repoRoots;
  const createdRepoRootLinks = [];
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const worktreePath = path.join(tempDir, ".worktrees", "codexa00", "DEBT-904");
  const lockPath = path.join(locksDir, "DEBT-904.lock");
  const now = new Date().toISOString();
  const canonicalThreadId = "thread-canonical-from-lock";
  const staleThreadId = "thread-stale-from-session-row";
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
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {
      title: "Test Board",
      last_updated: now,
      canonical_references: [],
      plan_records_required_from_ticket: "DEBT-001",
      landing_index_required_from_ticket: "IMP-120",
      plan_markdown_render_statuses: ["doing", "review", "done", "deferred", "superseded", "todo"],
    },
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Debt",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "DEBT-904",
            Repo: "X",
            Type: "infra",
            Pri: "P2",
            Status: "doing",
            Owner: "codexa00",
            Description: "Stale session thread_id repair target",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([
    {
      id: "a00",
      handle: "codexa00",
      aliases: [],
      provider: "openai",
      status: "active",
      notes: "Test agent",
      created_at: now,
    },
  ], null, 2), "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a00-thread-drift-session",
      agent_id: "a00",
      handle: "codexa00",
      session_label: "rebuild:debt-904",
      host: "test-host",
      cwd: worktreePath,
      board_path: boardPath,
      board_root: path.join(__dirname, ".."),
      thread_id: staleThreadId,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    },
  ], null, 2), "utf8");
  fs.writeFileSync(lockPath, JSON.stringify({
    agent_id: "a00",
    owner: "codexa00",
    ticket: "DEBT-904",
    status: "doing",
    repo: "coord",
    branch: "agent/codexa00-debt-904-thread-drift",
    head: "coord-no-git-head",
    worktree: worktreePath,
    session_id: "a00-thread-drift-session",
    thread_id: canonicalThreadId,
    started_at_utc: now,
    heartbeat_utc: now,
  }, null, 2), "utf8");

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
  __testing.paths.REPO_ROOTS = {
    ...original.REPO_ROOTS,
    B: backendRepo.repoRoot,
    F: frontendRepo.repoRoot,
  };
  for (const [repoCode, targetPath] of Object.entries({ B: backendRepo.repoRoot, F: frontendRepo.repoRoot })) {
    const liveRepoRoot = liveRepoRoots[repoCode];
    if (!liveRepoRoot || fs.existsSync(liveRepoRoot)) {
      continue;
    }
    fs.symlinkSync(targetPath, liveRepoRoot, "dir");
    createdRepoRootLinks.push(liveRepoRoot);
  }

  try {
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true, ticket: "DEBT-904" }));
    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const session = sessionsAfter.find((entry) => entry.session_id === "a00-thread-drift-session");
    assert.equal(session.thread_id, canonicalThreadId,
      "doctor --fix must overwrite a stale session thread_id with the canonical lock's thread_id");
    assert.equal(session.handle, "codexa00");
    assert.equal(session.status, "active");

    const eventLines = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean);
    const repairEvents = eventLines
      .map((line) => JSON.parse(line))
      .flatMap((entry) => Array.isArray(entry.details?.repairs) ? entry.details.repairs : []);
    const threadRepair = repairEvents.find((entry) =>
      entry?.type === "normalized_session_binding_from_canonical_lock" &&
      entry?.session_id === "a00-thread-drift-session"
    );
    assert.ok(threadRepair, "normalized_session_binding_from_canonical_lock repair should be journalled");
    assert.equal(threadRepair.previous_thread_id, staleThreadId,
      "repair event must record the stale thread_id for audit");
    assert.equal(threadRepair.thread_id, canonicalThreadId,
      "repair event must record the canonical thread_id that replaced it");
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
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    for (const liveRepoRoot of createdRepoRootLinks) {
      fs.rmSync(liveRepoRoot, { force: true });
    }
  }
});

// COORD-064 (P1 bug): `gov recover <ticket>` crashed with ENOENT on lock-less
// tickets. recoverTicket built a phantom lock={path,...} for a MISSING lock
// file (lockInvalid was gated on lockState.exists), so a non-doing ticket hit
// the `else if (lock)` branch and ran fs.unlinkSync on a nonexistent path.
// Since ~75/79 tickets are done (no lock), recover on any done ticket crashed.
// Fix gates lock construction on existence so a missing lock falls through to
// the noop path. This regression test recovers a done, lock-less ticket and
// asserts it does NOT throw (ENOENT) and reports a non-mutating `noop`.
test("recoverTicket on a done lock-less ticket is a no-op and does not throw ENOENT", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-recover-noop-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const lockPath = path.join(locksDir, "DEBT-901.lock");
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
  fs.writeFileSync(boardPath, JSON.stringify({
    version: 1,
    metadata: {
      title: "Test Board",
      last_updated: "2026-03-30",
      canonical_references: [],
      plan_records_required_from_ticket: "DEBT-001",
      landing_index_required_from_ticket: "IMP-120",
      plan_markdown_render_statuses: ["doing", "review", "done", "deferred", "superseded", "todo"],
    },
    sections: [
      {
        kind: "table",
        level: 2,
        heading: "Debt",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "DEBT-901",
            Repo: "X",
            Type: "infra",
            Pri: "P2",
            Status: "done",
            Owner: "unassigned",
            Description: "Done lock-less recover target",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  }, null, 2), "utf8");
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

  // No lock file is written: the ticket is done and lock-less, the common case.
  assert.equal(fs.existsSync(lockPath), false);

  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => { captured.push(args.join(" ")); };
  try {
    assert.doesNotThrow(() => __testing.recoverTicket("DEBT-901", {}));
    const payload = JSON.parse(captured.join("\n"));
    assert.equal(payload.status, "noop", "lock-less done ticket recover must be a no-op");
    assert.deepEqual(payload.repairs, [], "no repairs should be emitted for a lock-less done ticket");
    assert.equal(payload.lock, null, "recover must not synthesize a phantom lock");
    assert.equal(fs.existsSync(lockPath), false, "recover must not create a lock file");
  } finally {
    console.log = originalLog;
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

test("COORD-362: board-wide doctor --fix refuses dirty non-derived work while a foreign doing lock is live", () => {
  const createDoctorRecovery = require("./doctor-recovery.js");
  const board = {
    sections: [
      {
        rows: [
          { ID: "OTHER-1", Repo: "X", Status: "doing", Owner: "codexb00", "Depends On": "" },
        ],
      },
    ],
  };
  const recovery = createDoctorRecovery({
    fail: (message) => {
      throw new Error(message);
    },
    readBoard: () => board,
    resolveDoctorScope: (candidateBoard) => ({
      targetRef: null,
      rows: candidateBoard.sections.flatMap((section) => section.rows || []),
      byId: new Map(candidateBoard.sections.flatMap((section) => section.rows || []).map((row) => [row.ID, row])),
    }),
    gitTry: (repoRoot, args) => (
      args[0] === "status"
        ? { status: 0, stdout: " M coord/scripts/doctor-recovery.js\n M coord/rendered/TASKS.md\n" }
        : { status: 0, stdout: "" }
    ),
    canonicalSyncablePaths: () => ["rendered/TASKS.md"],
    isDoingStatus: (status) => status === "doing",
    findLockForTicket: (ticket) => ({
      ticket,
      owner: "codexb00",
      path: `/repo/coord/.runtime/locks/${ticket}.lock`,
      worktree: `/repo/coord/.worktrees/codexb00/${ticket}`,
    }),
    isStaleTicketLock: () => false,
    withGovernanceMutation: () => {
      throw new Error("doctorFix must fail before mutating governance state");
    },
  });

  assert.throws(
    () => recovery.doctorFix({ fix: true }),
    /Refusing tree-wide governance mutation/
  );
});
