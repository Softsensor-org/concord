// COORD-890: drop inherited agent-shell identity so a bare `node --test` run matches a runner child.
require("./test-runner.js").scrubIdentityEnv();
// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const governanceCommands = require("./lifecycle.js").commands;
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  __testing,
  createTempGitRepo,
  executeCommand,
  runGit,
  withScopedGovernanceTestContext,
  withGovernedSurfaceSandbox,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const createDoctorRecovery = require("./doctor-recovery.js");
const createGovernanceRepair = require("./governance-repair.js");
const governanceRepair = createGovernanceRepair({ getRows: () => [], readCanonicalTextFile: () => "" });
const createTicketLockService = require("./ticket-lock-service.js");
const createGovernanceSession = require("./governance-session.js");
const stateIo = require("./state-io.js");
const { gitTry } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const { state: governanceState, DEFAULT_PATHS } = require("./governance-context.js");
const { createCoordPaths, resolveEngineModule } = require("../../paths.js");
const { createIsolatedGovernanceWorkspace } = require(resolveEngineModule(path.resolve(__dirname, "..", ".."), "engine/scripts/fixtures/isolated-governance-workspace.js"));
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function executeWithSignedApproval(args, verb, ticket) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const first = executeCommand(args);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
    assert.equal(first.ok, false, "bare override text must not authorize the mutation");
    assert.ok(digest, first.error);
    fixture.login({ verb, ticket, subject_sha256: digest[1] });
    return withApprovalTestClient(path.resolve(__dirname, "..", ".."), fixture.client(), () => executeCommand(args));
  } finally { fixture.cleanup(); }
}

function doctorApprovalDependencies(fixture) {
  const runtimeDir = path.join(fixture.dir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    resolveHumanAdminOverride: (_commandName, options) => ({
      reason: String(options.humanAdminOverride || "").trim(), legacyForceAlias: false,
    }),
    appendGovernanceEvent: (event) => fs.appendFileSync(path.join(runtimeDir, "governance-events.ndjson"), `${JSON.stringify(event)}\n`),
    runtimeDir,
    approvalClient: fixture.client(),
  };
}

function runWithSignedDoctorApproval(fixture, ticket, run, verb = "reconcile", coordDir = path.resolve(__dirname, "..", "..")) {
  let refusal = null;
  try { withApprovalTestClient(coordDir, fixture.client(), run); } catch (error) { refusal = error; }
  assert.ok(refusal, "the override reason alone must not authorize the operation");
  assert.match(String(refusal.message), /requires a signed human-admin approval/);
  const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(refusal.message));
  assert.ok(digest, String(refusal.message));
  fixture.login({ verb, ticket, subject_sha256: digest[1] });
  return withApprovalTestClient(coordDir, fixture.client(), run);
}

function withCoord678ProjectionFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord678-reconcile-"));
  const paths = {
    PLAN_PATH: path.join(root, "PLAN.md"),
    PLAN_RECORDS_DIR: path.join(root, ".runtime", "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(root, "board", "plans"),
    RENDERED_DIR: path.join(root, "rendered"),
    RUNTIME_DIR: path.join(root, ".runtime"),
  };
  return withScopedGovernanceTestContext(paths, () => {
    fs.mkdirSync(paths.RENDERED_DIR, { recursive: true });
    fs.mkdirSync(paths.PLAN_RECORDS_DIR, { recursive: true });
    fs.writeFileSync(paths.PLAN_PATH, "", "utf8");
    const board = { sections: [{ rows: [{ ID: "TEST-678", Status: "todo" }] }], prompt_index: {} };
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "| TEST-678 | fixture |\n", "utf8");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "PROMPT_INDEX.md"), "", "utf8");
    try { return fn({ root, paths, board }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

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

function createRegisteredRepoWorktree(repoRoot, ticketId, handle = "codexa00") {
  const worktree = path.join(repoRoot, ".worktrees", handle, ticketId);
  const branch = `agent/${handle}-${ticketId.toLowerCase()}-${process.pid}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { worktree, branch, head: runGit(worktree, ["rev-parse", "HEAD"]) };
}

function removeRegisteredRepoWorktree(repoRoot, worktree, branch) {
  runGit(repoRoot, ["worktree", "remove", "--force", worktree]);
  runGit(repoRoot, ["branch", "-D", branch]);
}

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-doctor-fix-"));
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

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
    RENDERED_DIR: path.join(tempDir, "rendered"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true, ticket: "DEBT-900" }));
    assert.equal(fs.existsSync(path.join(recordsDir, "DEBT-900.json")), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(worktreePath), false);
  });
});

test("wired doctor --fix rebuilds every missing lock field from the assigned doing row", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    const ticketId = "IMP-6621";
    const ownerlessTicketId = "IMP-6622";
    const repo = createTempGitRepo("coord662-doctor-repo-name-", { "README.md": "fixture\n" });
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const ownerlessLockPath = path.join(governanceState.LOCKS_DIR, `${ownerlessTicketId}.lock`);
    return withScopedGovernanceTestContext({ REPO_ROOTS: { B: repo.repoRoot } }, () => {
    const now = new Date().toISOString();

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(boardPath, JSON.stringify({
      version: 1,
      metadata: { title: "doctor repo-name fixture", last_updated: "2026-10-02", canonical_references: [] },
      sections: [{
        kind: "table", level: 2, heading: "Fixture", separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: ticketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "malformed lock repair", "Depends On": "" },
          // A corrupted on-disk legacy row is doctor-reported, and doctorFix
          // deliberately supplies the historical unknown-owner fallback while
          // rebuilding its malformed lock. Keep this separate from the normal
          // assigned-owner case above.
          { ID: ownerlessTicketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Description: "ownerless legacy lock repair", "Depends On": "" },
        ],
      }],
      prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {},
    }, null, 2));
    // Keep the ticket key so doctor recognizes the record, while leaving the
    // required payload fields absent. The real board row and configured repo
    // root provide the deterministic repair values.
    fs.writeFileSync(lockPath, JSON.stringify({ ticket: ticketId }, null, 2));
    fs.writeFileSync(ownerlessLockPath, JSON.stringify({ ticket: ownerlessTicketId }, null, 2));

    try {
      const originalLog = console.log;
      const output = [];
      let payload;
      try {
        console.log = (...values) => output.push(values.join(" "));
        __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
        __testing.doctorFix({ fix: true, ticket: ticketId });
        payload = JSON.parse(output.join("\n"));
      } finally {
        console.log = originalLog;
      }
      assert.equal(payload.status, "repaired");
      assert.ok(payload.repairs.some((repair) => repair.type === "repaired_malformed_lock" && repair.ticket === ticketId));
      const repaired = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(repaired.owner, "codexa04");
      assert.equal(repaired.status, "doing");
      assert.equal(repaired.repo, "backend");
      assert.equal(repaired.branch, `agent/codexa04-${ticketId.toLowerCase()}`);
      assert.equal(repaired.worktree, path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId));
      assert.ok(Date.parse(repaired.started_at_utc));
      assert.ok(Date.parse(repaired.heartbeat_utc));

      const ownerlessOutput = [];
      try {
        console.log = (...values) => ownerlessOutput.push(values.join(" "));
        __testing.doctorFix({ fix: true, ticket: ownerlessTicketId });
      } finally {
        console.log = originalLog;
      }
      const ownerlessPayload = JSON.parse(ownerlessOutput.join("\n"));
      assert.equal(ownerlessPayload.status, "repaired");
      assert.ok(ownerlessPayload.repairs.some((repair) => repair.type === "repaired_malformed_lock" && repair.ticket === ownerlessTicketId));
      const ownerlessLock = JSON.parse(fs.readFileSync(ownerlessLockPath, "utf8"));
      assert.equal(ownerlessLock.owner, "unknown");
      assert.equal(ownerlessLock.branch, `agent/unknown-${ownerlessTicketId.toLowerCase()}`);
      assert.equal(ownerlessLock.worktree, path.join(repo.repoRoot, ".worktrees", "unknown", ownerlessTicketId));
    } finally {
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
    });
  });
});

test("COORD-371: board-wide doctorFix does NOT rewrite an existing plan record (non-destructive)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord371-doctor-nondestructive-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const recordsDir = path.join(tempDir, "plans");
  const locksDir = path.join(runtimeDir, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  const paths = {
    BOARD_PATH: path.join(tempDir, "tasks.json"),
    PLAN_PATH: path.join(tempDir, "PLAN.md"),
    QUESTIONS_PATH: path.join(tempDir, "QUESTIONS.md"),
    AGENTS_PATH: path.join(tempDir, "agents.json"),
    AGENT_SESSIONS_PATH: path.join(runtimeDir, "agent_sessions.json"),
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
    RENDERED_DIR: path.join(tempDir, "rendered"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  };

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

  try {
    withScopedGovernanceTestContext(paths, () => {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true }));
    assert.equal(
      fs.readFileSync(recordPath, "utf8"),
      seed,
      "board-wide doctor --fix must NOT rewrite an existing plan record (COORD-371 §11.1 non-destructive)"
    );
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctorFix rebuilds ticket-scoped board and session mirrors from a canonical lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-doctor-fix-rebuild-"));
  const backendRepo = createTempGitRepo("legacy-doctor-fix-rebuild-backend-", { "package.json": JSON.stringify({ name: "@template/backend" }, null, 2) });
  const frontendRepo = createTempGitRepo("legacy-doctor-fix-rebuild-frontend-", { "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2) });
  // COORD-010: board.js pins to THIS coord checkout's real registry
  // (forceProjectConfig), so the symlink shim that gives the board validator
  // real repo dirs must target the same real-config roots, not the config
  // matrix fixture roots.
  const liveRepoRoots = createCoordPaths({ coordDir: path.join(__dirname, "..", ".."), forceProjectConfig: true }).repoRoots;
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
  const { worktree: worktreePath, branch: worktreeBranch, head: worktreeHead } =
    createRegisteredRepoWorktree(backendRepo.repoRoot, "DEBT-901");
  const lockPath = path.join(locksDir, "DEBT-901.lock");
  const now = new Date().toISOString();
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
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
            Repo: "B",
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
    repo: "backend",
    branch: worktreeBranch,
    head: worktreeHead,
    worktree: worktreePath,
    session_id: "a00-rebuild-session",
    started_at_utc: now,
    heartbeat_utc: now,
  }, null, 2), "utf8");

  for (const [repoCode, targetPath] of Object.entries({ B: backendRepo.repoRoot, F: frontendRepo.repoRoot })) {
    const liveRepoRoot = liveRepoRoots[repoCode];
    if (!liveRepoRoot || fs.existsSync(liveRepoRoot)) {
      continue;
    }
    fs.symlinkSync(targetPath, liveRepoRoot, "dir");
    createdRepoRootLinks.push(liveRepoRoot);
  }

  try {
    withScopedGovernanceTestContext({
      BOARD_PATH: boardPath,
      PLAN_PATH: planPath,
      QUESTIONS_PATH: questionsPath,
      AGENTS_PATH: agentsPath,
      AGENT_SESSIONS_PATH: sessionsPath,
      PLAN_RECORDS_DIR: recordsDir,
      LOCKS_DIR: locksDir,
      LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
      RENDERED_DIR: path.join(tempDir, "rendered"),
      RUNTIME_DIR: runtimeDir,
      GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
      GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
      GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
      GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
      REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot, F: frontendRepo.repoRoot },
    }, () => {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
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
    assert.equal(session.binding_sequence, 1, "rebuilt binding receives recorded order");
    assert.deepEqual(planRecord.intended_files, []);
    assert.deepEqual(
      planRecord.scaffold_placeholders.intended_files,
      ["backend/.worktrees/codexa00/DEBT-901/*"]
    );
    });
  } finally {
    removeRegisteredRepoWorktree(backendRepo.repoRoot, worktreePath, worktreeBranch);
    for (const liveRepoRoot of createdRepoRootLinks) {
      fs.rmSync(liveRepoRoot, { force: true });
    }
    fs.rmSync(backendRepo.repoRoot, { recursive: true, force: true });
    fs.rmSync(frontendRepo.repoRoot, { recursive: true, force: true });
  }
});

test("doctorFix overwrites stale session thread_id from the canonical lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-doctor-fix-thread-id-"));
  const backendRepo = createTempGitRepo("legacy-doctor-fix-thread-id-backend-", { "package.json": JSON.stringify({ name: "@template/backend" }, null, 2) });
  const frontendRepo = createTempGitRepo("legacy-doctor-fix-thread-id-frontend-", { "package.json": JSON.stringify({ name: "@template/frontend" }, null, 2) });
  // COORD-010: board.js pins to THIS coord checkout's real registry
  // (forceProjectConfig), so the symlink shim that gives the board validator
  // real repo dirs must target the same real-config roots, not the config
  // matrix fixture roots.
  const liveRepoRoots = createCoordPaths({ coordDir: path.join(__dirname, "..", ".."), forceProjectConfig: true }).repoRoots;
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
  const { worktree: worktreePath, branch: worktreeBranch, head: worktreeHead } =
    createRegisteredRepoWorktree(backendRepo.repoRoot, "DEBT-904");
  const lockPath = path.join(locksDir, "DEBT-904.lock");
  const now = new Date().toISOString();
  const canonicalThreadId = "thread-canonical-from-lock";
  const staleThreadId = "thread-stale-from-session-row";
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
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
            Repo: "B",
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
      binding_sequence: 4,
      agent_id: "a00",
      handle: "codexa00",
      session_label: "rebuild:debt-904",
      host: "test-host",
      cwd: worktreePath,
      board_path: boardPath,
      board_root: path.join(__dirname, "..", ".."),
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
    repo: "backend",
    branch: worktreeBranch,
    head: worktreeHead,
    worktree: worktreePath,
    session_id: "a00-thread-drift-session",
    thread_id: canonicalThreadId,
    started_at_utc: now,
    heartbeat_utc: now,
  }, null, 2), "utf8");

  for (const [repoCode, targetPath] of Object.entries({ B: backendRepo.repoRoot, F: frontendRepo.repoRoot })) {
    const liveRepoRoot = liveRepoRoots[repoCode];
    if (!liveRepoRoot || fs.existsSync(liveRepoRoot)) {
      continue;
    }
    fs.symlinkSync(targetPath, liveRepoRoot, "dir");
    createdRepoRootLinks.push(liveRepoRoot);
  }

  try {
    withScopedGovernanceTestContext({
      BOARD_PATH: boardPath,
      PLAN_PATH: planPath,
      QUESTIONS_PATH: questionsPath,
      AGENTS_PATH: agentsPath,
      AGENT_SESSIONS_PATH: sessionsPath,
      PLAN_RECORDS_DIR: recordsDir,
      LOCKS_DIR: locksDir,
      LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
      RENDERED_DIR: path.join(tempDir, "rendered"),
      RUNTIME_DIR: runtimeDir,
      GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
      GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
      GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
      GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
      REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: backendRepo.repoRoot, F: frontendRepo.repoRoot },
    }, () => {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.doesNotThrow(() => __testing.doctorFix({ fix: true, ticket: "DEBT-904" }));
    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const session = sessionsAfter.find((entry) => entry.session_id === "a00-thread-drift-session");
    assert.equal(session.thread_id, canonicalThreadId,
      "doctor --fix must overwrite a stale session thread_id with the canonical lock's thread_id");
    assert.equal(session.binding_sequence, 5, "in-place repair advances binding order");
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
    });
  } finally {
    removeRegisteredRepoWorktree(backendRepo.repoRoot, worktreePath, worktreeBranch);
    for (const liveRepoRoot of createdRepoRootLinks) {
      fs.rmSync(liveRepoRoot, { force: true });
    }
    fs.rmSync(backendRepo.repoRoot, { recursive: true, force: true });
    fs.rmSync(frontendRepo.repoRoot, { recursive: true, force: true });
  }
});

test("ticket-scoped recover repairs a legacy Repo X sentinel from a registered worktree HEAD", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-recover-head-"));
  const controlPlane = createTempGitRepo("coord644-recover-control-plane-", { "README.md": "disposable Repo X recovery fixture\n" });
  const ticketId = "DEBT-644-HEAD";
  const branch = `agent/codexa00-${ticketId.toLowerCase()}-${process.pid}`;
  const worktree = path.join(controlPlane.repoRoot, ".worktrees", "codexa00", ticketId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const lockPath = path.join(tempDir, `${ticketId}.lock`);
  const lock = {
    owner: "codexa00",
    agent_id: "a00",
    ticket: ticketId,
    status: "doing",
    repo: "coord",
    branch,
    head: "coord-no-git-head",
    worktree,
    session_id: null,
    identity_model: "v2",
    started_at_utc: new Date().toISOString(),
    heartbeat_utc: new Date().toISOString(),
  };
  const row = { ID: ticketId, Repo: "X", Status: "doing", Owner: "codexa00", Description: "repair legacy head" };
  const board = { sections: [{ rows: [row] }] };
  runGit(controlPlane.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  const expectedHead = runGit(worktree, ["rev-parse", "HEAD"]);
  const lockHeadService = createTicketLockService({
    isRepoBackedCode: () => false,
    controlPlaneLayout: () => ({ coordRepoRoot: controlPlane.repoRoot }),
    gitTry,
    fail: (message) => { throw new Error(message); },
  });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  const identity = { present: true };
  let verifyWorkspace = true;
  const recovery = createDoctorRecovery({
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (_metadata, callback) => callback(),
    inferTicketStatus: () => "doing",
    detectGovernanceProvenanceDrift: () => ({ drift: [], latestEvent: null }),
    isRecoverableGovernanceDriftPath: () => true,
    readBoard: () => board,
    getTicketRef: (_board, id) => id === ticketId ? { row } : null,
    canonicalizeOwnerOrFail: (owner) => owner,
    resolveAgentIdentifier: () => ({ agent: { id: "a00" } }),
    readAgentsRegistry: () => [{ id: "a00", handle: "codexa00" }],
    findActiveSessionForHandle: () => null,
    resolveTicketLockPath: () => lockPath,
    readLockFileState: () => ({ exists: true, value: JSON.parse(fs.readFileSync(lockPath, "utf8")), error: null }),
    isCompleteLockPayload: () => true,
    isDoingStatus: (status) => status === "doing",
    assertTicketRepairOwnership: (_id, _row, _options, context) => {
      if (verifyWorkspace) context.verifyWorkspace();
      return { agent: { handle: "codexa00" } };
    },
    resolveTicketGitContext: () => ({ worktree, branch, repoRoot: controlPlane.repoRoot }),
    identityV2: { readEnvIdentity: () => identity },
    resolveLockHead: lockHeadService.resolveLockHead,
    findLockForTicket: () => ({ ...JSON.parse(fs.readFileSync(lockPath, "utf8")), path: lockPath }),
    buildTicketNextCommands: () => [],
    relativeCoordPath: (value) => value,
  });

  const output = [];
  const originalLog = console.log;
  const worktreeGitfile = path.join(worktree, ".git");
  const worktreeGitfileContents = fs.readFileSync(worktreeGitfile, "utf8");
  console.log = (...args) => output.push(args.join(" "));
  try {
    recovery.recoverTicket(ticketId);
    const persisted = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(persisted.head, expectedHead);
    assert.match(output.join("\n"), /"type": "refreshed_lock_head"/);
    assert.match(output.join("\n"), new RegExp(expectedHead));

    verifyWorkspace = false; // Same-owner auth does not invoke the adoption-only workspace callback.
    const beforeInvalidGitMetadata = fs.readFileSync(lockPath, "utf8");
    fs.unlinkSync(worktreeGitfile);
    assert.throws(() => recovery.recoverTicket(ticketId), /not its own Git worktree root/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), beforeInvalidGitMetadata,
      "an existing directory with broken worktree metadata fails before lock mutation");
    fs.writeFileSync(worktreeGitfile, worktreeGitfileContents, "utf8");

    const missingWorktree = `${worktree}-missing`;
    const missingLock = { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), worktree: missingWorktree };
    fs.writeFileSync(lockPath, JSON.stringify(missingLock, null, 2));
    output.length = 0;
    recovery.recoverTicket(ticketId);
    const afterMissingRepair = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(afterMissingRepair.head, expectedHead,
      "a missing worktree warning must preserve the existing anchor rather than invent one");
    assert.match(output.join("\n"), /Lock worktree is missing/);
  } finally {
    console.log = originalLog;
    removeRegisteredRepoWorktree(controlPlane.repoRoot, worktree, branch);
    fs.rmSync(controlPlane.repoRoot, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-recover-noop-"));
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

  // No lock file is written: the ticket is done and lock-less, the common case.
  assert.equal(fs.existsSync(lockPath), false);

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: recordsDir,
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
    RENDERED_DIR: path.join(tempDir, "rendered"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(" ")); };
    try {
      __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
      assert.doesNotThrow(() => governanceCommands.recoverTicket("DEBT-901", {}));
      const payload = JSON.parse(captured.join("\n"));
      assert.equal(payload.status, "noop", "lock-less done ticket recover must be a no-op");
      assert.deepEqual(payload.repairs, [], "no repairs should be emitted for a lock-less done ticket");
      assert.equal(payload.lock, null, "recover must not synthesize a phantom lock");
      assert.equal(fs.existsSync(lockPath), false, "recover must not create a lock file");
    } finally {
      console.log = originalLog;
    }
  });
});

test("COORD-662: recover removes malformed and non-doing locks without inventing ownership", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    const malformedId = "IMP-6631";
    const nonDoingId = "IMP-6632";
    const now = new Date().toISOString();
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{
      kind: "table", level: 2, heading: "Fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [
        { ID: malformedId, Repo: "X", Type: "task", Pri: "P2", Status: "done", Owner: "unassigned", Description: "malformed lock cleanup", "Depends On": "" },
        { ID: nonDoingId, Repo: "X", Type: "task", Pri: "P2", Status: "done", Owner: "unassigned", Description: "non-doing lock cleanup", "Depends On": "" },
      ],
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
    const malformedLock = path.join(governanceState.LOCKS_DIR, `${malformedId}.lock`);
    const nonDoingLock = path.join(governanceState.LOCKS_DIR, `${nonDoingId}.lock`);
    fs.writeFileSync(malformedLock, "{\n");
    fs.writeFileSync(nonDoingLock, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: "stale-legacy-session",
      ticket: nonDoingId, status: "doing", repo: "coord", branch: "agent/codexa04-imp-6632",
      head: "coord-no-git-head", worktree: "/tmp/unused-recovery-fixture",
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(" "));
    try {
      __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
      governanceCommands.recoverTicket(malformedId, {});
      const malformedPayload = JSON.parse(captured.join("\n"));
      assert.equal(malformedPayload.status, "repaired");
      assert.ok(malformedPayload.repairs.some((repair) => repair.type === "removed_corrupt_lock"));
      assert.equal(fs.existsSync(malformedLock), false);

      captured.length = 0;
      governanceCommands.recoverTicket(nonDoingId, {});
      const nonDoingPayload = JSON.parse(captured.join("\n"));
      assert.equal(nonDoingPayload.status, "repaired");
      assert.ok(nonDoingPayload.repairs.some((repair) => repair.type === "released_stale_lock"));
      assert.equal(fs.existsSync(nonDoingLock), false);
    } finally {
      console.log = originalLog;
    }
  });
});

test("COORD-662: public recover refuses an unassigned doing ticket before changing governed bytes", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const ticketId = "IMP-6626";
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{
      kind: "table", level: 2, heading: "Fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: ticketId, Repo: "X", Type: "task", Pri: "P2", Status: "doing",
        Owner: "unassigned", Description: "recover must not invent an owner", "Depends On": "" }],
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
    __testing.ensureGovernanceJournalBaseline("COORD-662 ownerless recover refusal fixture");

    const governedPaths = [
      boardPath,
      governanceState.QUESTIONS_PATH,
      governanceState.AGENT_SESSIONS_PATH,
      governanceState.AGENTS_PATH,
      logPath,
    ];
    const before = new Map(governedPaths.map((file) => [file, fs.readFileSync(file)]));
    const result = executeCommand(["recover", ticketId]);

    assert.equal(result.ok, false);
    assert.match(result.error, /has no assigned owner; recover cannot invent ownership/);
    assert.equal(fs.existsSync(lockPath), false, "refusal must not synthesize a lock");
    for (const [file, bytes] of before) {
      assert.deepEqual(fs.readFileSync(file), bytes, `${path.basename(file)} remains byte-identical after refusal`);
    }
  });
});

test("COORD-662: recover rejects missing IDs, unknown tickets, and nonrecoverable provenance drift", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    __testing.ensureGovernanceJournalBaseline("COORD-662 recover input refusal fixture");
    const missingId = executeCommand(["recover"]);
    assert.equal(missingId.ok, false);
    assert.match(missingId.error, /recover requires <ticket-id>/);

    const unknownTicket = executeCommand(["recover", "IMP-6600"]);
    assert.equal(unknownTicket.ok, false);
    assert.match(unknownTicket.error, /Unknown ticket/);

    const agentsPath = governanceState.AGENTS_PATH;
    fs.writeFileSync(agentsPath, JSON.stringify([{ note: "unexpected registry change" }], null, 2));
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeAgents = fs.readFileSync(agentsPath);
    const beforeJournal = fs.readFileSync(logPath);
    const unsafeDrift = executeCommand(["recover", "IMP-6600"]);
    assert.equal(unsafeDrift.ok, false);
    assert.match(unsafeDrift.error, /drift|agents\.json/i);
    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
    assert.deepEqual(fs.readFileSync(agentsPath), beforeAgents);
    assert.deepEqual(fs.readFileSync(logPath), beforeJournal);
  });
});

test("COORD-662: recover refuses an unsupported repo code without creating a lock", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const ticketId = "IMP-6630";
    const threadId = "coord662-unsupported-repo-thread";
    const now = new Date().toISOString();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = threadId;
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{
      kind: "table", level: 2, heading: "Corrupt legacy fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: ticketId, Repo: "Q", Type: "infra", Pri: "P2", Status: "doing",
        Owner: "codexa04", Description: "unknown repo code must fail closed", "Depends On": "" }],
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-unsupported-repo-session", agent_id: "a04", handle: "codexa04",
      board_path: boardPath, thread_id: threadId, claimed_at: now, last_seen_at: now, status: "active",
    }], null, 2));
    __testing.ensureGovernanceJournalBaseline("COORD-662 unsupported repo recovery fixture");
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeJournal = fs.readFileSync(logPath);
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);

    try {
      const result = executeCommand(["recover", ticketId, "--owner", "codexa04"]);
      assert.equal(result.ok, false);
      assert.match(result.error, /Unsupported repo code "Q"/);
      assert.equal(fs.existsSync(lockPath), false);
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal);
    } finally {
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });
});

test("wired recover normalizes a configured repo lock using the bound owner session", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    const ticketId = "IMP-6622";
    const missingWorktreeTicketId = "IMP-6624";
    const controlPlaneTicketId = "COORD-6625";
    const repo = createTempGitRepo("coord662-recover-repo-", { "README.md": "fixture\n" });
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const missingWorktreeLockPath = path.join(governanceState.LOCKS_DIR, `${missingWorktreeTicketId}.lock`);
    const controlPlaneLockPath = path.join(governanceState.LOCKS_DIR, `${controlPlaneTicketId}.lock`);
    const missingWorktree = path.join(repo.repoRoot, ".worktrees", "codexa04", missingWorktreeTicketId);
    const previousThread = process.env.CODEX_THREAD_ID;
    const previousCoordSession = process.env.COORD_SESSION_ID;
    const previousProvider = process.env.COORD_PROVIDER;
    const previousInstance = process.env.COORD_INSTANCE_ID;
    const threadId = "coord662-recovery-thread";
    const now = new Date().toISOString();
    withScopedGovernanceTestContext({ REPO_ROOTS: { B: repo.repoRoot } }, () => {
    process.env.CODEX_THREAD_ID = threadId;
    delete process.env.COORD_SESSION_ID;
    process.env.COORD_PROVIDER = "openai";
    process.env.COORD_INSTANCE_ID = "coord662-recovery-instance";

    fs.writeFileSync(boardPath, JSON.stringify({
      version: 1,
      metadata: { title: "recover repo fixture", last_updated: "2026-10-02", canonical_references: [] },
      sections: [{
        kind: "table", level: 2, heading: "Fixture", separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: ticketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "bound owner recovery", "Depends On": "" },
          { ID: missingWorktreeTicketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "missing registered worktree is reported", "Depends On": "" },
          { ID: controlPlaneTicketId, Repo: "X", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "control-plane lock head is normalized", "Depends On": "" },
        ],
      }],
      prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {},
    }, null, 2));
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-owner-session", agent_id: "a04", handle: "codexa04",
      board_path: boardPath, thread_id: threadId, claimed_at: now, last_seen_at: now, status: "active",
    }], null, 2));
    fs.writeFileSync(lockPath, JSON.stringify({
      owner: "codexa03", agent_id: "a03", session_id: "legacy-session-to-clear",
      ticket: ticketId, status: "doing", repo: "backend",
      branch: "agent/codexa04-imp-6622", head: "0123456789012345678901234567890123456789", worktree: repo.repoRoot,
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));
    fs.writeFileSync(missingWorktreeLockPath, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: null, identity_model: "v2",
      ticket: missingWorktreeTicketId, status: "doing", repo: "backend",
      branch: `agent/codexa04-${missingWorktreeTicketId.toLowerCase()}`, head: repo.head, worktree: missingWorktree,
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));
    fs.writeFileSync(controlPlaneLockPath, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: "stale-v1-session", identity_model: "v2",
      ticket: controlPlaneTicketId, status: "doing", repo: "coord",
      branch: `agent/codexa04-${controlPlaneTicketId.toLowerCase()}`, head: "0123456789012345678901234567890123456789", worktree: repo.repoRoot,
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(" "));
    try {
      __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
      governanceCommands.recoverTicket(ticketId, { owner: "codexa04" });
      const payload = JSON.parse(captured.join("\n"));
      assert.equal(payload.status, "repaired");
      assert.ok(payload.repairs.some((repair) => repair.type === "refreshed_lock_head" && repair.head === repo.head));
      assert.ok(payload.repairs.some((repair) => repair.type === "normalized_lock_identity_model" && repair.identity_model === "v2"));
      const repaired = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(repaired.head, repo.head);
      assert.equal(repaired.owner, "codexa04");
      assert.equal(repaired.identity_model, "v2");
      assert.equal(repaired.session_id, null);
      assert.deepEqual(payload.warnings, []);
      assert.ok(payload.repairs.some((repair) => repair.type === "normalized_lock_owner" && repair.owner === "codexa04"));

      captured.length = 0;
      governanceCommands.recoverTicket(missingWorktreeTicketId, { owner: "codexa04" });
      const missingWorktreePayload = JSON.parse(captured.join("\n"));
      assert.equal(missingWorktreePayload.status, "noop", "a missing registered worktree warns without inventing a repair");
      assert.deepEqual(missingWorktreePayload.warnings, [
        `Lock worktree is missing at ${missingWorktree}; recover did not invent a replacement.`,
      ]);
      assert.equal(JSON.parse(fs.readFileSync(missingWorktreeLockPath, "utf8")).worktree, missingWorktree);

      captured.length = 0;
      const beforeControlPlaneLock = fs.readFileSync(controlPlaneLockPath);
      const beforeBoard = fs.readFileSync(boardPath);
      assert.throws(() => governanceCommands.recoverTicket(controlPlaneTicketId, { owner: "codexa04" }),
        /not a registered control-plane worktree/,
        "a product repository cannot stand in for the registered Repo X checkout");
      assert.deepEqual(fs.readFileSync(controlPlaneLockPath), beforeControlPlaneLock,
        "refusal must preserve the existing lock instead of normalizing an unverified checkout");
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
    } finally {
      console.log = originalLog;
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      if (previousCoordSession === undefined) delete process.env.COORD_SESSION_ID;
      else process.env.COORD_SESSION_ID = previousCoordSession;
      if (previousProvider === undefined) delete process.env.COORD_PROVIDER;
      else process.env.COORD_PROVIDER = previousProvider;
      if (previousInstance === undefined) delete process.env.COORD_INSTANCE_ID;
      else process.env.COORD_INSTANCE_ID = previousInstance;
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
    });
  });
});

test("COORD-662: recover adopts only the expired owner session for its registered worktree", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const ticketId = "IMP-6627";
    const noOwnerTicketId = "IMP-6628";
    const repo = createTempGitRepo("coord662-recover-adoption-repo-", { "README.md": "fixture\n" });
    const branch = `agent/codexa04-${ticketId.toLowerCase()}`;
    const worktree = path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId);
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const now = new Date().toISOString();
    const currentThread = "coord662-recovery-adoption-thread";
    const previousThread = process.env.CODEX_THREAD_ID;
    const previousCoordSession = process.env.COORD_SESSION_ID;
    withScopedGovernanceTestContext({ REPO_ROOTS: { B: repo.repoRoot } }, () => {
    process.env.CODEX_THREAD_ID = currentThread;
    delete process.env.COORD_SESSION_ID;
    runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);

    fs.writeFileSync(boardPath, JSON.stringify({
      version: 1,
      metadata: { title: "recover session adoption fixture", last_updated: "2026-10-02", canonical_references: [] },
      sections: [{ kind: "table", level: 2, heading: "Fixture", separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: ticketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "recover an expired same-owner session", "Depends On": "" },
          { ID: noOwnerTicketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "refuse expired-session recovery without an explicit owner", "Depends On": "" },
        ] }],
      prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {},
    }, null, 2));
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([
      {
        session_id: "coord662-expired-owner-session", agent_id: "a04", handle: "codexa04",
        board_path: boardPath, thread_id: "old-thread", claimed_at: now, last_seen_at: now,
        released_at: now, release_reason: "idle-expiry", status: "expired",
      },
      {
        session_id: "coord662-no-owner-expired-session", agent_id: "a04", handle: "codexa04",
        board_path: boardPath, thread_id: "older-thread", claimed_at: now, last_seen_at: now,
        released_at: now, release_reason: "idle-expiry", status: "expired",
      },
    ], null, 2));
    fs.writeFileSync(lockPath, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: "coord662-expired-owner-session",
      ticket: ticketId, status: "doing", repo: "backend", branch, head: repo.head, worktree,
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));
    const noOwnerLockPath = path.join(governanceState.LOCKS_DIR, `${noOwnerTicketId}.lock`);
    fs.writeFileSync(noOwnerLockPath, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: "coord662-no-owner-expired-session",
      ticket: noOwnerTicketId, status: "doing", repo: "backend", branch, head: repo.head, worktree,
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(" "));
    try {
      __testing.ensureGovernanceJournalBaseline("COORD-662 adoption refusal fixture");
      const refusalSnapshot = [boardPath, noOwnerLockPath, governanceState.AGENT_SESSIONS_PATH, logPath]
        .map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
      assert.throws(() => governanceCommands.recoverTicket(noOwnerTicketId, {}), (error) => error.code === "NO_ACTIVE_SESSION",
        "without an explicit owner, expired-session adoption must refuse rather than guess ticket ownership");
      [boardPath, noOwnerLockPath, governanceState.AGENT_SESSIONS_PATH, logPath].forEach((file, index) => {
        assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, refusalSnapshot[index],
          `${path.basename(file)} remains unchanged on refusal`);
      });

      governanceCommands.recoverTicket(ticketId, { owner: "codexa04" });
      const payload = JSON.parse(captured.join("\n"));
      assert.equal(payload.status, "repaired");
      assert.ok(payload.repairs.some((repair) => repair.type === "normalized_lock_session"));
      const repairedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.notEqual(repairedLock.session_id, "coord662-expired-owner-session");
      const sessions = JSON.parse(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"));
      const adopted = sessions.find((session) => session.session_id === repairedLock.session_id);
      assert.equal(adopted.handle, "codexa04");
      assert.equal(adopted.status, "active");
      assert.equal(adopted.thread_id, currentThread);
      assert.equal(adopted.previous_session_id, "coord662-expired-owner-session");

    } finally {
      console.log = originalLog;
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      if (previousCoordSession === undefined) delete process.env.COORD_SESSION_ID;
      else process.env.COORD_SESSION_ID = previousCoordSession;
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
    });
  });
});

test("recovery-session adoption helper refuses invalid snapshots (unit contract)", () => {
  const { adoptRecoverySession } = require("./recovery-session.js");
  const sessionAuthority = require("./governance-session.js")({
    state: governanceState,
    fail: (message) => { throw new Error(message); },
  });
  const makeInput = () => {
    const boardPath = "/tmp/recovery-helper-board/tasks.json";
    const prior = {
      session_id: "expired-a04", agent_id: "a04", handle: "codexa04", status: "expired",
      board_path: boardPath, thread_id: "old-thread", claimed_at: "2000-01-01T00:00:00.000Z",
    };
    const error = Object.assign(new Error("no active session"), { code: "NO_ACTIVE_SESSION" });
    const input = {
      error, ticketId: "RECOVERY-662", expectedOwner: "codexa04", requestedOwner: "codexa04",
      lock: {
        ticket: "RECOVERY-662", owner: "codexa04", agent_id: "a04", session_id: prior.session_id,
        status: "doing", repo: "B", branch: "agent/codexa04-recovery-662",
        head: "0123456789abcdef0123456789abcdef01234567", worktree: "/tmp/recovery-helper-worktree",
        started_at_utc: "2000-01-01T00:00:00.000Z",
      },
      agents: [{ id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] }],
      sessions: [prior], threadId: "current-thread", boardPath,
      assertProvider: (agent) => sessionAuthority.assertRuntimeProviderMatchesAgent(agent),
      completeLock: (lock) => sessionAuthority.isCompleteLockPayload(lock),
      buildSessionId: () => "replacement-session",
      verifyWorkspace() { this.workspaceChecks = (this.workspaceChecks || 0) + 1; },
      writeSessions(next) { this.writes = (this.writes || 0) + 1; this.persisted = next; },
    };
    return { input, prior };
  };

  for (const [name, mutate] of [
    ["missing thread", (d) => { d.threadId = null; }],
    ["unrequested owner", (d) => { d.requestedOwner = null; }],
    ["incomplete lock", (d) => { d.lock.worktree = " "; }],
    ["wrong ticket", (d) => { d.lock.ticket = "RECOVERY-OTHER"; }],
    ["v2 lock", (d) => { d.lock.identity_model = "v2"; }],
    ["missing active owner", (d) => { d.agents = []; }],
    ["wrong prior board", (d) => { d.sessions[0].board_path = "/other/tasks.json"; }],
    ["active same-owner conflict", (d) => { d.sessions.push({
      session_id: "active-a04", handle: "codexa04", status: "active", board_path: d.boardPath, thread_id: "other-thread",
    }); }],
    ["active same-thread conflict", (d) => { d.sessions.push({
      session_id: "active-other", handle: "codexa99", status: "active", board_path: d.boardPath, thread_id: d.threadId,
    }); }],
    ["workspace verifier missing", (d) => { delete d.verifyWorkspace; }],
  ]) {
    const { input } = makeInput();
    mutate(input);
    const before = JSON.stringify(input.sessions);
    assert.throws(() => adoptRecoverySession(input), (error) => error === input.error, name);
    assert.equal(input.writes || 0, 0, name);
    assert.equal(input.workspaceChecks || 0, 0, name);
    assert.equal(JSON.stringify(input.sessions), before, name);
  }

  const { input, prior } = makeInput();
  const priorSnapshot = structuredClone(prior);
  const adopted = adoptRecoverySession(input);
  assert.equal(adopted.recoveredFromSession, prior.session_id);
  assert.equal(input.workspaceChecks, 1);
  assert.equal(input.writes, 1);
  assert.deepEqual(input.persisted[0], priorSnapshot, "adoption appends history without rewriting the expired interval");
});

test("recovery-session continuation helper preserves eligible and refusal contracts (unit contract)", () => {
  const { continueReleasedSession } = require("./recovery-session.js");
  const sessionAuthority = require("./governance-session.js")({
    state: governanceState,
    fail: (message) => { throw new Error(message); },
  });
  const makeInput = () => {
    const boardPath = "/tmp/continuation-helper-board/tasks.json";
    const prior = {
      session_id: "idle-a04", agent_id: "a04", handle: "codexa04", status: "expired",
      board_path: boardPath, thread_id: "current-thread", claimed_at: "2000-01-01T00:00:00.000Z",
      binding_sequence: 2,
    };
    const input = {
      inMutation: true, nativeThreadId: "current-thread", threadId: "current-thread", requestedHandle: null,
      agents: [{ id: "a04", handle: "codexa04", provider: "openai", status: "active" }], sessions: [prior],
      boardPath, idleMs: 60_000, host: "fixture-host",
      assertProvider(agent) {
        this.providerChecks = (this.providerChecks || 0) + 1;
        sessionAuthority.assertRuntimeProviderMatchesAgent(agent);
      },
      buildSessionId: () => "continued-session",
      writeSessions(next) { this.writes = (this.writes || 0) + 1; this.persisted = next; },
    };
    return { input, prior };
  };

  const { input, prior } = makeInput();
  const priorSnapshot = structuredClone(prior);
  const result = continueReleasedSession(input);
  assert.equal(result.continuedFromSession, prior.session_id);
  assert.equal(input.writes, 1);
  assert.deepEqual(input.persisted[0], priorSnapshot, "continuation appends a new interval without rewriting history");

  for (const [name, mutate] of [
    ["outside mutation", (d) => { d.inMutation = false; }],
    ["foreign native thread", (d) => { d.nativeThreadId = "other-thread"; }],
    ["no prior binding", (d) => { d.sessions = []; }],
    ["explicit release", (d) => { d.sessions[0].status = "released"; d.sessions[0].release_reason = "explicit"; }],
    ["missing timestamps", (d) => { delete d.sessions[0].last_seen_at; delete d.sessions[0].claimed_at; }],
    ["recent expiry", (d) => { d.sessions[0].last_seen_at = new Date().toISOString(); }],
    ["different requested handle", (d) => { d.requestedHandle = "codexa99"; }],
    ["duplicate binding id", (d) => { d.sessions.push({ ...d.sessions[0], binding_sequence: 3 }); }],
    ["disabled owner", (d) => { d.agents[0].status = "disabled"; }],
    ["owner id mismatch", (d) => { d.agents[0].id = "a99"; }],
    ["active owner collision", (d) => { d.sessions.push({
      session_id: "active-a04", handle: "codexa04", status: "active", board_path: d.boardPath,
      thread_id: "other-thread", claimed_at: "1999-01-01T00:00:00.000Z", binding_sequence: 1,
    }); }],
    ["active current-thread collision", (d) => { d.sessions.push({
      session_id: "active-other", handle: "codexa99", status: "active", board_path: d.boardPath,
      thread_id: d.threadId, claimed_at: "1999-01-01T00:00:00.000Z", binding_sequence: 1,
    }); }],
  ]) {
    const { input: candidate } = makeInput();
    mutate(candidate);
    const before = JSON.stringify(candidate.sessions);
    assert.equal(continueReleasedSession(candidate), null, name);
    if (name === "active current-thread collision") assert.equal(candidate.providerChecks, 1, "the thread collision is reached after owner validation");
    assert.equal(candidate.writes || 0, 0, name);
    assert.equal(JSON.stringify(candidate.sessions), before, name);
  }
});

test("COORD-662: recovery refuses a lock replaced between verified workspace reads", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const createDoctorRecovery = require("./doctor-recovery.js");
    const createLifecycleEvidence = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-evidence.js"));
    const createGovernanceSession = require("./governance-session.js");
    const governanceState = require("./governance-context.js").state;
    const ticketId = "IMP-6636";
    const repoA = createTempGitRepo("coord662-recover-race-a-", { "README.md": "fixture A\n" });
    const repoB = createTempGitRepo("coord662-recover-race-b-", { "README.md": "fixture B\n" });
    const branchA = `agent/codexa04-${ticketId.toLowerCase()}-prior`;
    const branchB = `agent/codexa04-${ticketId.toLowerCase()}`;
    const worktreeA = path.join(repoA.repoRoot, ".worktrees", "codexa04", ticketId);
    const worktreeB = path.join(repoB.repoRoot, ".worktrees", "codexa04", ticketId);
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const now = new Date().toISOString();
    const threadId = "coord662-recovery-lock-race-thread";
    const previousThread = process.env.CODEX_THREAD_ID;
    const previousCoordSession = process.env.COORD_SESSION_ID;
    withScopedGovernanceTestContext({ REPO_ROOTS: { B: repoB.repoRoot } }, () => {
    process.env.CODEX_THREAD_ID = threadId;
    delete process.env.COORD_SESSION_ID;
    runGit(repoA.repoRoot, ["worktree", "add", "-b", branchA, worktreeA, "HEAD"]);
    runGit(repoB.repoRoot, ["worktree", "add", "-b", branchB, worktreeB, "HEAD"]);
    runGit(worktreeB, ["checkout", "-b", branchA]);
    runGit(worktreeB, ["checkout", branchB]);
    fs.writeFileSync(boardPath, JSON.stringify({
      version: 1,
      metadata: { title: "recovery lock replacement race", last_updated: "2026-10-02", canonical_references: [] },
      sections: [{ kind: "table", level: 2, heading: "Fixture", separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [{ ID: ticketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
          Owner: "codexa04", Description: "refuse workspace lock replacement during recovery", "Depends On": "" }] }],
      prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {},
    }, null, 2));
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-expired-lock-race-session", agent_id: "a04", handle: "codexa04",
      board_path: boardPath, thread_id: "previous-thread", claimed_at: now, last_seen_at: now,
      released_at: now, release_reason: "idle-expiry", status: "expired",
    }], null, 2));
    const priorSnapshot = {
      owner: "codexa04", agent_id: "a04", session_id: "coord662-expired-lock-race-session",
      ticket: ticketId, status: "doing", repo: "backend", branch: branchA, head: repoA.head,
      worktree: worktreeA, started_at_utc: now, heartbeat_utc: now,
    };
    const currentSnapshot = {
      ...priorSnapshot, branch: branchB, head: repoB.head, worktree: worktreeB,
    };
    const branchOnlyPriorSnapshot = {
      ...priorSnapshot, branch: branchA, head: repoB.head, worktree: worktreeB,
    };
    let observedSnapshot = priorSnapshot;
    fs.writeFileSync(lockPath, `${JSON.stringify(currentSnapshot, null, 2)}\n`);
    __testing.ensureGovernanceJournalBaseline("COORD-662 recovery lock replacement race fixture");
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeLock = fs.readFileSync(lockPath);
    const beforeAgents = fs.readFileSync(governanceState.AGENTS_PATH);
    const beforeSessions = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH);
    const beforeJournal = fs.readFileSync(logPath);
    const sessionHelpers = createGovernanceSession({
      ...stateIo,
      ...require("./governance-board-state.js")({ state: governanceState }),
      state: governanceState,
      GovernanceError: require("./governance-context.js").GovernanceError,
      AGENT_SESSION_IDLE_MS: 15 * 60 * 1000,
      COORD_DIR: path.resolve(__dirname, "..", ".."),
      SESSION_FINGERPRINT_ENV_VARS: [],
      compareSessionsMostRecentFirst: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-session-reaping.js"))({}).compareSessionsMostRecentFirst,
      identityV2: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js")),
      withAgentStateLock: (callback) => callback(),
      readJsonArrayFileOrFail: (filePath, label) => {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
        return value;
      },
      fail: (message) => { throw new Error(message); },
    });

    const resolveTicketGitContext = createLifecycleEvidence({
      isRepoBackedCode: (code) => code === "B",
      getRepoRoot: () => repoB.repoRoot,
      listGitWorktrees: () => [],
      inferTicketIdFromPath: () => null,
      isGitHubPrUrl: () => false,
      ghPrListByBranch: () => [],
      verifyPrEvidence: () => {},
      mergeUniqueRefs: (_left, right) => right,
      toArray: (value) => Array.isArray(value) ? value : [],
      findLockForTicket: () => JSON.parse(fs.readFileSync(lockPath, "utf8")),
      fail: (message) => { throw new Error(message); },
    }).resolveTicketGitContext;
    const recovery = createDoctorRecovery({
      fail: (message) => { throw new Error(message); },
      withGovernanceMutation: __testing.withGovernanceMutation,
      inferTicketStatus: __testing.inferTicketStatus,
      detectGovernanceProvenanceDrift: __testing.detectGovernanceProvenanceDrift,
      isRecoverableGovernanceDriftPath: governanceRepair.isRecoverableGovernanceDriftPath,
      formatGovernanceDriftMessage: __testing.formatGovernanceDriftMessage,
      readBoard: __testing.readBoard,
      getTicketRef: (board, id) => {
        for (const section of board.sections || []) {
          const row = (section.rows || []).find((candidate) => candidate.ID === id);
          if (row) return { row };
        }
        return null;
      },
      canonicalizeOwnerOrFail: sessionHelpers.canonicalizeOwnerOrFail,
      readAgentsRegistry: sessionHelpers.readAgentsRegistry,
      resolveAgentIdentifier: (handle, agents) => {
        const agent = agents.find((candidate) => candidate.handle === handle || candidate.id === handle);
        return agent ? { agent } : null;
      },
      findActiveSessionForHandle: () => null,
      resolveTicketLockPath: () => lockPath,
      readLockFileState: () => ({ exists: true, error: null, value: observedSnapshot }),
      isCompleteLockPayload: sessionHelpers.isCompleteLockPayload,
      isDoingStatus: sessionHelpers.isDoingStatus,
      assertTicketRepairOwnership: sessionHelpers.assertTicketRepairOwnership,
      resolveTicketGitContext,
    });

    try {
      let failure;
      try {
        recovery.recoverTicket(ticketId, { owner: "codexa04" });
      } catch (error) {
        failure = error;
      }
      assert.match(String(failure?.message), /Recovery lock conflicts with registered workspace/);
      assert.match(failure.stack, /Object\.verifyWorkspace \(.*doctor-recovery\.js:\d+:\d+\)/,
        "the independent lock and workspace snapshots must reach the fail-closed consistency check");
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
      assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
      assert.deepEqual(fs.readFileSync(governanceState.AGENTS_PATH), beforeAgents);
      assert.deepEqual(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH), beforeSessions,
        "a failed workspace recheck must not adopt the expired session");
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal);

      // A second real historical snapshot has the same registered worktree but
      // its previous branch. The current on-disk lock and worktree agree on B,
      // so this read boundary exercises the branch comparison after path equality.
      observedSnapshot = branchOnlyPriorSnapshot;
      let branchFailure;
      try {
        recovery.recoverTicket(ticketId, { owner: "codexa04" });
      } catch (error) {
        branchFailure = error;
      }
      assert.match(String(branchFailure?.message), /Recovery lock conflicts with registered workspace/);
      assert.match(branchFailure.stack, /Object\.verifyWorkspace \(.*doctor-recovery\.js:\d+:\d+\)/);
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
      assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
      assert.deepEqual(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH), beforeSessions);
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal);
    } finally {
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      if (previousCoordSession === undefined) delete process.env.COORD_SESSION_ID;
      else process.env.COORD_SESSION_ID = previousCoordSession;
      fs.rmSync(repoA.repoRoot, { recursive: true, force: true });
      fs.rmSync(repoB.repoRoot, { recursive: true, force: true });
    }
    });
  });
});

test("COORD-662: recover rebuilds an absent lock only from a registered ticket worktree", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    const ticketId = "IMP-6629";
    const corruptTicketId = "IMP-6633";
    const noOwnerSessionTicketId = "IMP-6637";
    const repo = createTempGitRepo("coord662-recover-rebuild-repo-", { "README.md": "fixture\n" });
    const branch = `agent/codexa04-${ticketId.toLowerCase()}`;
    const corruptBranch = `agent/codexa04-${corruptTicketId.toLowerCase()}`;
    const noOwnerSessionBranch = `agent/codexa04-${noOwnerSessionTicketId.toLowerCase()}`;
    const worktree = path.join(repo.repoRoot, ".worktrees", "codexa04", ticketId);
    const corruptWorktree = path.join(repo.repoRoot, ".worktrees", "codexa04", corruptTicketId);
    const noOwnerSessionWorktree = path.join(repo.repoRoot, ".worktrees", "codexa04", noOwnerSessionTicketId);
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    const corruptLockPath = path.join(governanceState.LOCKS_DIR, `${corruptTicketId}.lock`);
    const noOwnerSessionLockPath = path.join(governanceState.LOCKS_DIR, `${noOwnerSessionTicketId}.lock`);
    const now = new Date().toISOString();
    const threadId = "coord662-recover-rebuild-thread";
    const previousThread = process.env.CODEX_THREAD_ID;
    const previousCoordSession = process.env.COORD_SESSION_ID;
    withScopedGovernanceTestContext({ REPO_ROOTS: { B: repo.repoRoot } }, () => {
    process.env.CODEX_THREAD_ID = threadId;
    delete process.env.COORD_SESSION_ID;
    runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    runGit(repo.repoRoot, ["worktree", "add", "-b", corruptBranch, corruptWorktree, "HEAD"]);
    runGit(repo.repoRoot, ["worktree", "add", "-b", noOwnerSessionBranch, noOwnerSessionWorktree, "HEAD"]);
    fs.writeFileSync(boardPath, JSON.stringify({
      version: 1,
      metadata: { title: "recover missing lock fixture", last_updated: "2026-10-02", canonical_references: [] },
      sections: [{ kind: "table", level: 2, heading: "Fixture", separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [{ ID: ticketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
          Owner: "codexa04", Description: "rebuild lock for registered worktree", "Depends On": "" },
          { ID: corruptTicketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "rebuild corrupt lock for registered worktree", "Depends On": "" },
          { ID: noOwnerSessionTicketId, Repo: "B", Type: "infra", Pri: "P2", Status: "doing",
            Owner: "codexa04", Description: "foreign recovery without owner session", "Depends On": "" }] }],
      prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, waiver_index: {},
    }, null, 2));
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
      { id: "a05", handle: "codexa05", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-rebuild-foreign-session", agent_id: "a05", handle: "codexa05",
      board_path: boardPath, thread_id: threadId, claimed_at: now, last_seen_at: now, status: "active",
    }], null, 2));
    fs.writeFileSync(corruptLockPath, "{\n");
    assert.equal(fs.existsSync(lockPath), false);

    try {
      __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
      const payloadResult = executeWithSignedApproval([
        "recover", ticketId, "--owner", "codexa05", "--human-admin-override", "approved lock reconstruction",
      ], "recover --human-admin-override", ticketId);
      assert.equal(payloadResult.ok, true, payloadResult.error || payloadResult.stderr);
      const payload = JSON.parse(payloadResult.stdout);
      assert.equal(payload.status, "repaired");
      assert.ok(payload.repairs.some((repair) => repair.type === "recreated_lock"));
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(lock.owner, "codexa04");
      assert.equal(lock.branch, branch);
      assert.equal(lock.worktree, worktree);
      assert.equal(lock.head, repo.head);
      assert.equal(lock.session_id, null, "the ticket owner has no active session to bind into the rebuilt lock");

      const corruptResult = executeWithSignedApproval([
        "recover", corruptTicketId, "--owner", "codexa05", "--human-admin-override", "approved lock reconstruction",
      ], "recover --human-admin-override", corruptTicketId);
      assert.equal(corruptResult.ok, true, corruptResult.error || corruptResult.stderr);
      const corruptPayload = JSON.parse(corruptResult.stdout);
      assert.equal(corruptPayload.status, "repaired");
      assert.ok(corruptPayload.repairs.some((repair) => repair.type === "recreated_corrupt_lock"));
      const restoredCorruptLock = JSON.parse(fs.readFileSync(corruptLockPath, "utf8"));
      assert.equal(restoredCorruptLock.owner, "codexa04");
      assert.equal(restoredCorruptLock.branch, corruptBranch);
      assert.equal(restoredCorruptLock.worktree, corruptWorktree);

      // The actor is authorized through their own active session, while the
      // ticket owner has no active session to adopt into the rebuilt lock.
      const noOwnerSessionResult = executeWithSignedApproval([
        "recover", noOwnerSessionTicketId, "--owner", "codexa05", "--human-admin-override", "approved lock reconstruction",
      ], "recover --human-admin-override", noOwnerSessionTicketId);
      assert.equal(noOwnerSessionResult.ok, true, noOwnerSessionResult.error || noOwnerSessionResult.stderr);
      const noOwnerSessionPayload = JSON.parse(noOwnerSessionResult.stdout);
      assert.equal(noOwnerSessionPayload.status, "repaired");
      assert.ok(noOwnerSessionPayload.repairs.some((repair) => repair.type === "recreated_lock"));
      const noOwnerSessionLock = JSON.parse(fs.readFileSync(noOwnerSessionLockPath, "utf8"));
      assert.equal(noOwnerSessionLock.owner, "codexa04");
      assert.equal(noOwnerSessionLock.branch, noOwnerSessionBranch);
      assert.equal(noOwnerSessionLock.worktree, noOwnerSessionWorktree);
      assert.equal(noOwnerSessionLock.session_id, null);
    } finally {
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      if (previousCoordSession === undefined) delete process.env.COORD_SESSION_ID;
      else process.env.COORD_SESSION_ID = previousCoordSession;
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
    });
  });
});

test("COORD-662: reasoned foreign repair preserves the ticket owner in board and journal", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const ticketId = "COORD-6628";
    const threadId = "coord662-admin-repair-thread";
    const now = new Date().toISOString();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = threadId;
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{
      kind: "table", level: 2, heading: "Fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: ticketId, Repo: "X", Type: "infra", Pri: "P2", Status: "doing",
        Owner: "codexa04", Description: "authorized foreign-owner repair", "Depends On": "" }],
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
      { id: "a05", handle: "codexa05", provider: "openai", status: "active", aliases: [] },
    ], null, 2));
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-admin-session", agent_id: "a05", handle: "codexa05",
      board_path: boardPath, thread_id: threadId, claimed_at: now, last_seen_at: now, status: "active",
    }], null, 2));
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({
      owner: "codexa04", agent_id: "a04", session_id: "stale-legacy-session",
      ticket: ticketId, status: "doing", repo: "coord", branch: "agent/codexa04-coord-6628",
      head: "coord-no-git-head", worktree: path.join(os.tmpdir(), "not-needed-for-control-plane"),
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));
    __testing.ensureGovernanceJournalBaseline("COORD-662 foreign repair refusal fixture");

    try {
      const beforeBoard = fs.readFileSync(boardPath);
      const beforeLock = fs.readFileSync(lockPath);
      const beforeSessions = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH);
      const beforeJournal = fs.readFileSync(logPath);
      const refused = executeCommand(["recover", ticketId, "--owner", "codexa05"]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /human-admin-override/);
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
      assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
      assert.deepEqual(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH), beforeSessions);
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal);
      const blankOverride = executeCommand([
        "recover", ticketId, "--owner", "codexa05", "--human-admin-override", "   ",
      ]);
      assert.equal(blankOverride.ok, false);
      assert.match(blankOverride.error, /human-admin-override/);
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
      assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
      assert.deepEqual(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH), beforeSessions);
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal);

      const result = executeWithSignedApproval([
        "recover", ticketId, "--owner", "codexa05", "--human-admin-override", "approved maintenance repair",
      ], "recover --human-admin-override", ticketId);
      assert.equal(result.ok, true, result.error || result.stderr);
      assert.equal(JSON.parse(fs.readFileSync(boardPath, "utf8")).sections[0].rows[0].Owner, "codexa04");
      const repairedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(repairedLock.owner, "codexa04");
      assert.equal(repairedLock.session_id, null,
        "a legacy lock is normalized without inventing a session for an owner who has none");
      const events = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      const event = events.filter((entry) => entry.ticket === ticketId && entry.command === "recover").at(-1);
      assert.equal(event.details.owner_preserved, "codexa04");
      assert.equal(event.details.override_reason, "approved maintenance repair");
    } finally {
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });
});

test("COORD-662: recover tolerates a transiently missing owner entry during lock metadata lookup", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const createDoctorRecovery = require("./doctor-recovery.js");
    const createGovernanceSession = require("./governance-session.js");
    const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
    const ticketId = "COORD-6629";
    const threadId = "coord662-registry-read-race-thread";
    const now = new Date().toISOString();
    const previousThread = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = threadId;
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{
      kind: "table", level: 2, heading: "Fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: ticketId, Repo: "X", Type: "infra", Pri: "P2", Status: "doing",
        Owner: "codexa04", Description: "normalize from an owner registry read race", "Depends On": "" }],
    }];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
    const agentsPath = governanceState.AGENTS_PATH;
    const agentsBytes = Buffer.from(JSON.stringify([
      { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
      { id: "a05", handle: "codexa05", provider: "openai", status: "active", aliases: [] },
    ], null, 2) + "\n");
    fs.writeFileSync(agentsPath, agentsBytes);
    fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "coord662-registry-race-actor-session", agent_id: "a05", handle: "codexa05",
      board_path: boardPath, thread_id: threadId, claimed_at: now, last_seen_at: now, status: "active",
    }], null, 2));
    const lockPath = path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`);
    fs.writeFileSync(lockPath, JSON.stringify({
      owner: "codexa03", agent_id: "a03", session_id: "legacy-session-to-clear",
      ticket: ticketId, status: "doing", repo: "coord", branch: "agent/codexa04-coord-6629",
      head: "legacy-head", worktree: path.join(os.tmpdir(), "coord662-registry-race"),
      started_at_utc: now, heartbeat_utc: now,
    }, null, 2));
    __testing.ensureGovernanceJournalBaseline("COORD-662 owner registry lookup race fixture");

    const governanceContext = require("./governance-context.js");
    const sessionHelpers = createGovernanceSession({
      ...stateIo,
      ...require("./governance-board-state.js")({ state: governanceState }),
      state: governanceContext.state,
      GovernanceError: governanceContext.GovernanceError,
      AGENT_SESSION_IDLE_MS: 15 * 60 * 1000,
      COORD_DIR: path.resolve(__dirname, "..", ".."),
      SESSION_FINGERPRINT_ENV_VARS: [],
      compareSessionsMostRecentFirst: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-session-reaping.js"))({}).compareSessionsMostRecentFirst,
      identityV2,
      resolveHumanAdminOverride: (_commandName, options) => ({ reason: options.humanAdminOverride, legacyForceAlias: false }),
      appendGovernanceEvent: (event) => fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`),
      runtimeDir: governanceContext.state.RUNTIME_DIR,
      withAgentStateLock: governanceContext.withAgentStateLock,
      readJsonArrayFileOrFail: require("./state-io.js").readJsonArrayFileOrFail,
      fail: governanceContext.defaultFail,
    });
    const actualReadAgentsRegistry = sessionHelpers.readAgentsRegistry;
    let transientReadCount = 0;
    const readAgentsRegistryWithOnDiskGap = () => {
      // The preceding real canonicalization already accepted the board owner.
      // Model a concurrent registry replacement only for this subsequent
      // metadata lookup, and restore the exact bytes before real authorization
      // canonicalizes the owner again.
      fs.writeFileSync(agentsPath, "[]\n");
      try {
        const snapshot = actualReadAgentsRegistry();
        transientReadCount += 1;
        return snapshot;
      } finally {
        fs.writeFileSync(agentsPath, agentsBytes);
      }
    };
    const recovery = createDoctorRecovery({
      fail: (message) => { throw new Error(message); },
      withGovernanceMutation: __testing.withGovernanceMutation,
      inferTicketStatus: __testing.inferTicketStatus,
      detectGovernanceProvenanceDrift: __testing.detectGovernanceProvenanceDrift,
      isRecoverableGovernanceDriftPath: governanceRepair.isRecoverableGovernanceDriftPath,
      formatGovernanceDriftMessage: __testing.formatGovernanceDriftMessage,
      readBoard: __testing.readBoard,
      getTicketRef: (currentBoard, id) => {
        for (const section of currentBoard.sections || []) {
          const row = (section.rows || []).find((candidate) => candidate.ID === id);
          if (row) return { row };
        }
        return null;
      },
      readAgentsRegistry: readAgentsRegistryWithOnDiskGap,
      resolveAgentIdentifier: sessionHelpers.resolveAgentIdentifier,
      findActiveSessionForHandle: (handle) => sessionHelpers.readAgentSessions()
        .find((session) => session.handle === handle && session.status === "active") || null,
      canonicalizeOwnerOrFail: sessionHelpers.canonicalizeOwnerOrFail,
      assertTicketRepairOwnership: sessionHelpers.assertTicketRepairOwnership,
      resolveTicketLockPath: () => lockPath,
      readLockFileState: () => ({
        exists: fs.existsSync(lockPath), error: null,
        value: JSON.parse(fs.readFileSync(lockPath, "utf8")),
      }),
      isCompleteLockPayload: sessionHelpers.isCompleteLockPayload,
      isDoingStatus: sessionHelpers.isDoingStatus,
      identityV2,
      isRepoBackedCode: (code) => code !== "X",
      findLockForTicket: () => JSON.parse(fs.readFileSync(lockPath, "utf8")),
      buildTicketNextCommands: () => [],
    });

    const approval = createApprovalFixture({ allowedVerbs: ["recover --human-admin-override"] });
    try {
      const run = () => withApprovalTestClient(path.resolve(__dirname, "..", ".."), approval.client(), () =>
        recovery.recoverTicket(ticketId, { owner: "codexa05", humanAdminOverride: "approved registry-race repair" }));
      let result;
      try { run(); } catch (error) {
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
        assert.ok(digest, error.message);
        assert.match(error.message, /requires a signed human-admin approval/);
        approval.login({ verb: "recover --human-admin-override", ticket: ticketId, subject_sha256: digest[1] });
        result = run();
      }
      assert.equal(transientReadCount, 2, "both the unsigned refusal and signed retry saw the temporary on-disk registry snapshot once");
      assert.deepEqual(fs.readFileSync(agentsPath), agentsBytes,
        "the registry fixture is restored before the real authorization check");
      const repairedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(repairedLock.owner, "codexa04");
      assert.equal(repairedLock.agent_id, null,
        "the normalization keeps canonical owner text and safely omits an id absent from that metadata snapshot");
      assert.equal(result, undefined, "the mutation callback reports through the normal recovery output path");
      const event = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line))
        .filter((entry) => entry.ticket === ticketId && entry.command === "recover").at(-1);
      assert.equal(event.details.owner_preserved, "codexa04");
      assert.equal(event.details.override_reason, "approved registry-race repair");
    } finally {
      approval.cleanup();
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
    }
  });
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
        ? { status: 0, stdout: " M coord/engine/scripts/doctor-recovery.js\n M coord/rendered/TASKS.md\n" }
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

test("COORD-654: doctor fix distinguishes session ownership and refuses before mutation", () => {
  const createDoctorRecovery = require("./doctor-recovery.js");
  for (const [session, label] of [["caller", "own-session"], ["other", "foreign-session"], [null, "unknown-session"]]) {
    let writes = 0;
    const recovery = createDoctorRecovery({
      readBoard: () => ({}),
      resolveDoctorScope: () => ({ rows: [{ ID: "T-1", Status: "doing", Owner: "same-handle" }] }),
      gitTry: () => ({ status: 0, stdout: " M coord/scripts/worker.js\n" }),
      canonicalSyncablePaths: () => [], isDoingStatus: () => true,
      findLockForTicket: () => ({ owner: "same-handle", session_id: session }),
      isStaleTicketLock: () => false,
      resolveCurrentAgentId: () => ({ identity: { session: { session_id: "caller" } } }),
      withGovernanceMutation: () => { writes += 1; },
      fail: (message) => { throw new Error(message); },
    });
    assert.throws(() => recovery.doctorFix({ fix: true }), new RegExp(label));
    assert.equal(writes, 0);
  }
});

test("COORD-662: missing-ticket-lock recovery accepts only a registered live ticket worktree", () => {
  const { restoreMissingTicketLock } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/missing-ticket-lock.js"));
  const { repoRoot } = createTempGitRepo("legacy-missing-ticket-lock-", { "README.md": "seed\n" });
  const ticketId = "LOCK-123";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-agent-worktree-root-"));
  const worktree = path.join(tempRoot, ticketId);
  const otherWorktree = path.join(tempRoot, "OTHER-WORKTREE");
  const otherRepo = createTempGitRepo("legacy-missing-ticket-lock-other-repo-", { "README.md": "other\n" }).repoRoot;
  const foreignWorktreeParent = path.join(tempRoot, "foreign-repo-worktree");
  fs.mkdirSync(foreignWorktreeParent);
  const foreignTicketPath = path.join(foreignWorktreeParent, ticketId);
  const branch = "agent/codexa42-lock-123";
  const row = { ID: ticketId, Repo: "X", Status: "doing", Owner: "codexa42" };
  let writes = 0;
  const context = { repoRoot, worktree, branch };
  const restore = (candidate = context) => restoreMissingTicketLock({
    ticketId,
    row,
    owner: "codexa42",
    session: { session_id: "session-123" },
    resolveTicketGitContext: () => candidate,
    writeLock: () => { writes += 1; },
    findLockForTicket: () => ({ ticket: ticketId, owner: "codexa42" }),
  });

  try {
    runGit(repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    runGit(repoRoot, ["worktree", "add", "-b", "agent/codexa42-other", otherWorktree, "HEAD"]);
    runGit(otherRepo, ["worktree", "add", "-b", branch, foreignTicketPath, "HEAD"]);
    assert.deepEqual(restore(), { ticket: ticketId, owner: "codexa42" });
    assert.equal(writes, 1, "a registered existing worktree with its live branch may restore the lock");

    const invalidCases = [
      [{ ...context, worktree: "" }, /verified existing ticket worktree/],
      [{ ...context, worktree: path.join(tempRoot, "missing-ticket-worktree") }, /verified existing ticket worktree/],
      [{ ...context, worktree: repoRoot }, /verified existing ticket worktree/],
      [{ ...context, worktree: otherWorktree }, /verified existing ticket worktree/],
      [{ ...context, worktree: foreignTicketPath }, /verified existing ticket worktree/],
      [{ ...context, branch: "main" }, /verified existing ticket worktree/],
      [{ ...context, worktree: `${worktree}-unregistered` }, /verified existing ticket worktree/],
    ];
    const symlink = `${worktree}-link`;
    fs.symlinkSync(worktree, symlink, "dir");
    invalidCases.push([{ ...context, worktree: symlink }, /verified existing ticket worktree/]);

    for (const [candidate, expected] of invalidCases) {
      assert.throws(() => restore(candidate), expected);
      assert.equal(writes, 1, "invalid topology must refuse before writing a lock");
    }

    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_WORK_TREE = otherWorktree;
    try {
      assert.throws(() => restore(), /verified existing ticket worktree/,
        "Git's resolved top-level must still match the registered ticket path");
      assert.equal(writes, 1, "a redirected Git top-level must not reach the lock writer");
    } finally {
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
    }

    runGit(worktree, ["checkout", "--detach", "HEAD"]);
    assert.throws(() => restore(), /verified existing ticket worktree/,
      "a registered directory on detached HEAD is not a live agent branch");
    assert.equal(writes, 1, "detached worktree refusal leaves the lock writer untouched");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(otherRepo, { recursive: true, force: true });
  }
});

test("COORD-644: canonical recover normalizes Repo X authority, rebuilds only a verified missing lock, and refuses unsafe rows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-recovery-contract-"));
  const repo = createTempGitRepo("coord644-recovery-contract-repo-", { "README.md": "recovery contract fixture\n" });
  const ticketId = "DEBT-644-RECOVERY-CONTRACT";
  const owner = "codexa00";
  const branch = "agent/codexa00-debt-644-recovery-contract";
  const worktree = path.join(repo.repoRoot, ".worktrees", owner, ticketId);
  const lockPath = path.join(tempDir, `${ticketId}.lock`);
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentsPath = path.join(runtimeDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions.json");
  const initialAgents = [{ id: "a00", handle: owner, status: "active" }];
  fs.mkdirSync(runtimeDir, { recursive: true });
  stateIo.writeJsonFile(agentsPath, initialAgents);
  stateIo.writeJsonFile(legacyAgentsPath, initialAgents);
  stateIo.writeJsonFile(sessionsPath, []);
  stateIo.writeJsonFile(legacySessionsPath, []);
  const sessionIdentity = createGovernanceSession({
    state: { AGENTS_PATH: agentsPath, LEGACY_AGENTS_PATH: legacyAgentsPath, AGENT_SESSIONS_PATH: sessionsPath, LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath },
    withAgentStateLock: (callback) => callback(),
    readJsonArrayFileOrFail: stateIo.readJsonArrayFileOrFail,
    readJsonFileState: stateIo.readJsonFileState,
    safeReadJson: stateIo.safeReadJson,
    writeJsonFile: stateIo.writeJsonFile,
    ensureParentDir: stateIo.ensureParentDir,
    fail: (message) => { throw new Error(message); },
  });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  const expectedHead = runGit(worktree, ["rev-parse", "HEAD"]);
  let row = { ID: ticketId, Repo: "X", Status: "doing", Owner: owner, Description: "recover the registered ticket worktree" };
  let provenance = { drift: [], latestEvent: null };
  let identityV2Present = false;
  let recoveredFromSession = null;
  const mutationRecords = [];
  let activeSession = { session_id: "session-644-active" };
  let ticketContext = { worktree, branch, repoRoot: repo.repoRoot };
  let noGitTopology = false;
  let lockError = null;
  let lockValue = null;
  const board = { sections: [{ rows: [row] }] };
  const service = createTicketLockService({
    isRepoBackedCode: () => false,
    controlPlaneLayout: () => ({ coordRepoRoot: noGitTopology ? null : repo.repoRoot }),
    gitTry,
    fail: (message) => { throw new Error(message); },
  });
  const recovery = createDoctorRecovery({
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (mutation, callback) => {
      mutationRecords.push(mutation);
      return callback();
    },
    inferTicketStatus: () => row.Status,
    detectGovernanceProvenanceDrift: () => provenance,
    isRecoverableGovernanceDriftPath: (entry) => entry === "coord/PLAN.md",
    formatGovernanceDriftMessage: () => "unrecoverable governance provenance drift",
    readBoard: () => board,
    getTicketRef: (_board, id) => id === ticketId ? { row } : null,
    canonicalizeOwnerOrFail: sessionIdentity.canonicalizeOwnerOrFail,
    resolveAgentIdentifier: sessionIdentity.resolveAgentIdentifier,
    readAgentsRegistry: sessionIdentity.readAgentsRegistry,
    findActiveSessionForHandle: () => activeSession,
    resolveTicketLockPath: () => lockPath,
    readLockFileState: () => ({ exists: fs.existsSync(lockPath), value: lockValue, error: lockError }),
    isCompleteLockPayload: (value) => sessionIdentity.isCompleteLockPayload(value),
    isDoingStatus: (status) => String(status).startsWith("doing"),
    assertTicketRepairOwnership: (_id, _row, _options, context) => {
      // The production helper verifies the workspace when adopting an expired
      // session. An already-active owner is authorized from session identity;
      // doctor-recovery still compares the registered context to the lock below.
      if (recoveredFromSession) context.verifyWorkspace();
      return {
        agent: { handle: owner },
        ...(recoveredFromSession ? { recoveredFromSession } : {}),
      };
    },
    resolveTicketGitContext: () => ticketContext,
    identityV2: { readEnvIdentity: () => ({ present: identityV2Present }) },
    resolveLockHead: service.resolveLockHead,
    writeLock: ({ ticketId: id, owner: lockOwner, repoCode, branch: lockBranch, worktree: lockWorktree, session }) => {
      const payload = {
        ticket: id,
        owner: lockOwner,
        agent_id: "a00",
        repo: repoCode === "X" ? "coord" : repoCode,
        status: "doing",
        branch: lockBranch,
        head: service.resolveLockHead(repoCode, lockWorktree),
        worktree: lockWorktree,
        session_id: session?.session_id || null,
        started_at_utc: new Date().toISOString(),
        heartbeat_utc: new Date().toISOString(),
      };
      if (identityV2Present) payload.identity_model = "v2";
      lockValue = payload;
      fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`);
    },
    findLockForTicket: () => fs.existsSync(lockPath)
      ? { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), path: lockPath }
      : null,
    buildTicketNextCommands: () => [],
    relativeCoordPath: (value) => path.relative(tempDir, value),
    isRepoBackedCode: () => false,
  });
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    assert.throws(() => recovery.recoverTicket(""), /recover requires <ticket-id>/);
    assert.throws(() => recovery.recoverTicket("UNKNOWN-644"), /Unknown ticket/);
    provenance = { drift: ["coord/board/tasks.json"], latestEvent: null };
    assert.throws(() => recovery.recoverTicket(ticketId), /unrecoverable governance provenance drift/);
    provenance = { drift: [], latestEvent: null };

    row = { ...row, Owner: "unassigned" };
    assert.throws(() => recovery.recoverTicket(ticketId), /has no assigned owner; recover cannot invent ownership/);
    assert.equal(fs.existsSync(lockPath), false, "ownerless doing work is refused before a lock can be synthesized");
    row = { ...row, Owner: owner };

    // This factory-boundary case models a malformed/stale on-disk Repo code.
    // readBoard parses and normalizes but does not schema-validate; recovery must
    // still refuse instead of creating a lock for an unsupported repository.
    row = { ...row, Repo: "Q" };
    assert.throws(() => recovery.recoverTicket(ticketId), /Unsupported repo code "Q"/);
    assert.equal(fs.existsSync(lockPath), false,
      "an unsupported repository code must not create a ticket lock");
    row = { ...row, Repo: "X" };

    lockValue = {
      ticket: ticketId,
      owner: "codexa99",
      agent_id: "a99",
      repo: "coord",
      status: "doing",
      branch,
      head: "coord-no-git-head",
      worktree,
      session_id: "old-session",
      started_at_utc: new Date().toISOString(),
      heartbeat_utc: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    recovery.recoverTicket(ticketId);
    const normalized = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(normalized.owner, owner);
    assert.equal(normalized.agent_id, "a00");
    assert.equal(normalized.session_id, activeSession.session_id);
    assert.equal(normalized.head, expectedHead);
    assert.match(logs.join("\n"), /normalized_lock_owner/);
    assert.match(logs.join("\n"), /normalized_lock_session/);
    assert.match(logs.join("\n"), /refreshed_lock_head/);

    recoveredFromSession = "session-644-prior";
    mutationRecords.length = 0;
    recovery.recoverTicket(ticketId);
    assert.equal(mutationRecords.at(-1).details.previous_session_id, "session-644-prior",
      "recovery records the prior session when ownership was recovered from it");
    recoveredFromSession = null;

    const malformedIdAgent = [{ id: "", handle: owner, status: "active" }];
    stateIo.writeJsonFile(agentsPath, malformedIdAgent);
    stateIo.writeJsonFile(legacyAgentsPath, malformedIdAgent);
    lockValue = { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), owner: "codexa99", agent_id: "a99" };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    recovery.recoverTicket(ticketId);
    const malformedIdRepair = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(malformedIdRepair.owner, owner, "the production canonicalizer resolves the registered handle");
    assert.equal(malformedIdRepair.agent_id, null, "an accepted empty registry id remains null rather than being invented");
    const restoredAgents = [{ id: "a00", handle: owner, status: "active" }];
    stateIo.writeJsonFile(agentsPath, restoredAgents);
    stateIo.writeJsonFile(legacyAgentsPath, restoredAgents);

    lockValue = { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), branch: "agent/codexa99-wrong-branch" };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    const mismatchedLock = fs.readFileSync(lockPath, "utf8");
    recoveredFromSession = "session-644-prior";
    assert.throws(() => recovery.recoverTicket(ticketId), /Recovery lock conflicts with registered workspace/);
    recoveredFromSession = null;
    assert.equal(fs.readFileSync(lockPath, "utf8"), mismatchedLock,
      "a lock that disagrees with the verified ticket branch remains unchanged on refusal");

    const missingWorktree = path.join(repo.repoRoot, ".worktrees", owner, "DEBT-644-REMOVED");
    ticketContext = { worktree: missingWorktree, branch, repoRoot: repo.repoRoot };
    lockValue = { ...lockValue, branch, worktree: missingWorktree };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    assert.match(logs.join("\n"), /Lock worktree is missing at .* recover did not invent a replacement/);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).worktree, missingWorktree,
      "repair preserves the missing path and warns instead of fabricating a replacement worktree");

    noGitTopology = true;
    lockValue = { ...JSON.parse(fs.readFileSync(lockPath, "utf8")), head: "stale-no-git-head" };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).head, "coord-no-git-head",
      "a supported no-Git topology normalizes the existing lock sentinel without inventing a worktree");
    assert.match(logs.join("\n"), /normalized_coord_lock_head/);
    noGitTopology = false;
    ticketContext = { worktree, branch, repoRoot: repo.repoRoot };

    identityV2Present = true;
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    const v2 = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(v2.session_id, null, "v2 recovery does not reintroduce legacy session authority");
    assert.equal(v2.identity_model, "v2");

    identityV2Present = false;
    activeSession = null;
    lockValue = { ...v2, session_id: "stale-legacy-session" };
    delete lockValue.identity_model;
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    recovery.recoverTicket(ticketId);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).session_id, null,
      "a legacy lock clears stale session authority when the owner has no active session");

    fs.rmSync(lockPath);
    lockValue = null;
    identityV2Present = false;
    activeSession = null;
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    const rebuilt = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(rebuilt.ticket, ticketId);
    assert.equal(rebuilt.owner, owner);
    assert.equal(rebuilt.worktree, worktree);
    assert.equal(rebuilt.branch, branch);
    assert.equal(rebuilt.head, expectedHead);
    assert.equal(rebuilt.session_id, null, "a rebuilt lock does not invent a session id when its owner has no active session");
    assert.match(logs.join("\n"), /recreated_lock/);

    lockError = new Error("truncated lock payload");
    lockValue = null;
    fs.writeFileSync(lockPath, "{truncated\n");
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).worktree, worktree,
      "a doing ticket with a corrupt lock is rebuilt from its registered worktree");
    assert.match(logs.join("\n"), /recreated_corrupt_lock/);
    lockError = null;

    row = { ...row, Status: "review" };
    fs.writeFileSync(lockPath, "{malformed lock json\n");
    lockValue = null;
    lockError = new Error("not valid JSON");
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    assert.equal(fs.existsSync(lockPath), false, "a corrupt non-doing lock is removed rather than retained as authority");
    assert.match(logs.join("\n"), /removed_corrupt_lock/);

    row = { ...row, Status: "done" };
    lockError = null;
    lockValue = {
      ticket: ticketId,
      owner,
      agent_id: "a00",
      repo: "coord",
      status: "doing",
      branch,
      head: expectedHead,
      worktree,
      session_id: null,
      started_at_utc: new Date().toISOString(),
      heartbeat_utc: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
    logs.length = 0;
    recovery.recoverTicket(ticketId);
    assert.equal(fs.existsSync(lockPath), false, "a complete stale lock is released when the board row is terminal");
    assert.match(logs.join("\n"), /released_stale_lock/);
  } finally {
    console.log = originalLog;
    removeRegisteredRepoWorktree(repo.repoRoot, worktree, branch);
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("COORD-678 reconcile fails closed on missing projection records and supports a diagnostic dry run", () => {
  withCoord678ProjectionFixture(({ paths, board }) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      const recovery = createDoctorRecovery({
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => ({ uninitialized: false, snapshotPruned: false, drift: [] }),
        withGovernanceMutation: () => { throw new Error("projection refusal must precede mutation"); },
      });
      assert.throws(() => recovery.reconcileGovernance(null, {}), /reconcile requires --reason/);
      fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "", "utf8");
      assert.throws(() => recovery.reconcileGovernance(null, { reason: "review fixture" }), /required canonical records missing/);
      recovery.reconcileGovernance(null, { reason: "review fixture", dryRun: true });
      const result = JSON.parse(logs.at(-1));
      assert.equal(result.status, "dry_run");
      assert.equal(result.derived_view_issues[0].path, "coord/rendered/TASKS.md");
      assert.equal(result.requires_human_admin_override, false);
    } finally { console.log = originalLog; }
  });
});

test("COORD-678 reconcile rechecks materialized views inside the governed mutation", () => {
  withCoord678ProjectionFixture(({ paths, board }) => {
    let mutationEntered = false;
    const recovery = createDoctorRecovery({
      readBoard: () => board,
      detectGovernanceProvenanceDrift: () => ({ uninitialized: false, snapshotPruned: false, drift: [".runtime/locks/example.lock"] }),
      isRecoverableGovernanceDriftPath: () => true,
      withGovernanceMutation: (_metadata, callback) => {
        mutationEntered = true;
        fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "", "utf8");
        return callback();
      },
    });
    assert.throws(() => recovery.reconcileGovernance(null, { reason: "recheck fixture" }), /required canonical records missing/);
    assert.equal(mutationEntered, true);
  });
});

test("COORD-678 reconcile requires review for a pruned mismatching snapshot and records approval", () => {
  withCoord678ProjectionFixture(({ board, paths }) => {
    const provenance = { uninitialized: false, snapshotPruned: true, snapshotMatchesCurrent: false,
      expectedSnapshotDigest: "a".repeat(40), drift: [],
      currentSnapshot: { digest: "b".repeat(40), files: [{ path: "coord678-pruned-fixture.json", exists: true, digest: "c".repeat(40) }] } };
    let metadata = null;
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    const recovery = createDoctorRecovery({
      readBoard: () => board,
      detectGovernanceProvenanceDrift: () => provenance,
      isRecoverableGovernanceDriftPath: (entry) => entry.startsWith("locks/"),
      withGovernanceMutation: (value, callback) => { metadata = value; return callback(); },
      resolveHumanAdminOverride: (_verb, options) => ({ reason: options.humanAdminOverride }),
      appendGovernanceEvent: (event) => {
        fs.mkdirSync(paths.RUNTIME_DIR, { recursive: true });
        fs.appendFileSync(path.join(paths.RUNTIME_DIR, "governance-events.ndjson"), `${JSON.stringify(event)}\n`);
      },
    });
    assert.throws(() => recovery.reconcileGovernance(null, { reason: "snapshot fixture" }), /--human-admin-override/);
    const originalLog = console.log;
    console.log = () => {};
    // COORD-722: the override binds to an approved packet of the adopted set.
    assert.throws(() => recovery.reconcileGovernance(null, { reason: "snapshot fixture", humanAdminOverride: "approved exact snapshot recovery" }),
      /requires --expect-paths-file/);
    assert.equal(metadata, null, "an unbound override never enters the mutation");
    try {
      withApprovalTestClient(path.resolve(__dirname, "..", ".."), approval.client(), () => {
        const options = { reason: "snapshot fixture", humanAdminOverride: "approved exact snapshot recovery", expectPaths: "absent coord678-pruned-fixture.json\n" };
        try { recovery.reconcileGovernance(null, options); } catch (error) {
          const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
          assert.ok(digest, error.message);
          assert.match(error.message, /requires a signed human-admin approval/);
          assert.equal(metadata, null, "bare text does not enter the mutation");
          approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: digest[1] });
          recovery.reconcileGovernance(null, options);
        }
      });
    }
    finally { console.log = originalLog; }
    approval.cleanup();
    assert.deepEqual(metadata.snapshotRecovery, {
      approval: "approved exact snapshot recovery",
      approvedDigest: "b".repeat(40),
    });
  });
});

test("COORD-678 matching pruned snapshot can be restored without an admin override", () => {
  withCoord678ProjectionFixture(({ board }) => {
    const provenance = { uninitialized: false, snapshotPruned: true, snapshotMatchesCurrent: true,
      expectedSnapshotDigest: "matching-digest", currentSnapshot: { digest: "matching-digest" }, drift: [] };
    let metadata = null;
    const recovery = createDoctorRecovery({
      readBoard: () => board,
      detectGovernanceProvenanceDrift: () => provenance,
      isRecoverableGovernanceDriftPath: () => true,
      withGovernanceMutation: (value, callback) => { metadata = value; return callback(); },
    });
    const originalLog = console.log;
    console.log = () => {};
    try { recovery.reconcileGovernance(null, { reason: "matching snapshot fixture" }); }
    finally { console.log = originalLog; }
    assert.deepEqual(metadata.snapshotRecovery, {
      approval: "",
      approvedDigest: "matching-digest",
    });
  });
});

test("COORD-722 reconcile needs the approved packet for semantic drift, never for lock/session drift", () => {
  withCoord678ProjectionFixture(({ board }) => {
    const run = (drift, options) => {
      const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
      let entered = false;
      const recovery = createDoctorRecovery({
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => ({ uninitialized: false, drift, currentSnapshot: { digest: "d", files: [] } }),
        isRecoverableGovernanceDriftPath: (entry) => entry.startsWith("locks/"),
        withGovernanceMutation: (value, callback) => { entered = true; return callback(); },
        ...doctorApprovalDependencies(approval),
      });
      try {
        const attempt = () => recovery.reconcileGovernance(null, { reason: "fixture", ...options });
        if (options.humanAdminOverride && options.expectPaths) runWithSignedDoctorApproval(approval, "control-plane", attempt);
        else attempt();
        return entered;
      } finally { approval.cleanup(); }
    };
    assert.equal(run(["locks/COORD-1.lock"], {}), true, "lock/session drift reconciles with a reason alone");
    assert.throws(() => run(["docs/decisions/0001-x.md"], { humanAdminOverride: "approve" }), /requires --expect-paths-file/);
    assert.throws(() => run(["docs/decisions/0001-x.md"], {}), /--human-admin-override/);
    assert.equal(run(["docs/decisions/0001-x.md"], { humanAdminOverride: "approve", expectPaths: "absent docs/decisions/0001-x.md\n" }), true);
  });
});

test("COORD-836 canonical recovery factory rejects each packet mismatch and reports no-op/unknown-ticket outcomes", () => {
  withCoord678ProjectionFixture(({ board }) => {
    const packetPath = "engine/scripts/reconcile-packet.js";
    const packetBytes = fs.readFileSync(path.resolve(__dirname, "..", "..", packetPath));
    const packetSha256 = crypto.createHash("sha256").update(packetBytes).digest("hex");
    const snapshotEntry = {
      path: packetPath,
      exists: true,
      digest: crypto.createHash("sha1").update(packetBytes).digest("hex"),
    };
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      const makeRecovery = (drift, options = {}) => createDoctorRecovery({
        fail: (message) => { throw new Error(message); },
        readBoard: () => board,
        getTicketRef: (_currentBoard, id) => id === "TEST-678" ? { row: { ID: id } } : null,
        detectGovernanceProvenanceDrift: () => ({
          uninitialized: false,
          snapshotPruned: false,
          drift,
          currentSnapshot: { files: [snapshotEntry] },
        }),
        isRecoverableGovernanceDriftPath: (entry) => entry.startsWith("locks/"),
        withGovernanceMutation: (_metadata, callback) => callback(),
        ...options,
      });

      const approved = `${packetSha256} ${packetPath}\n`;
      assert.throws(() => makeRecovery([packetPath, "engine/scripts/agent-commands.js"])
        .reconcileGovernance(null, {
          reason: "reject unapproved drift",
          humanAdminOverride: "reviewed exact bytes",
          expectPaths: approved,
        }), /would adopt paths not in the packet/);

      const extraBytes = fs.readFileSync(path.resolve(__dirname, "../../engine/scripts/agent-commands.js"));
      const extraSha256 = crypto.createHash("sha256").update(extraBytes).digest("hex");
      assert.throws(() => makeRecovery([packetPath]).reconcileGovernance(null, {
        reason: "reject non-drift packet path",
        humanAdminOverride: "reviewed exact bytes",
        expectPaths: `${approved}${extraSha256} engine/scripts/agent-commands.js\n`,
      }), /packet paths not drifted/);

      assert.throws(() => makeRecovery([packetPath]).reconcileGovernance(null, {
        reason: "reject changed approved bytes",
        humanAdminOverride: "reviewed exact bytes",
        expectPaths: `${"0".repeat(64)} ${packetPath}\n`,
      }), /bytes differ from the packet/);

      logs.length = 0;
      makeRecovery([]).reconcileGovernance(null, { reason: "clean state check" });
      assert.equal(JSON.parse(logs.at(-1)).status, "noop");

      assert.throws(() => makeRecovery(["locks/COORD-TEST.lock"])
        .reconcileGovernance("TEST-UNKNOWN", { reason: "validate ticket reference" }), /Unknown ticket/);
    } finally {
      console.log = originalLog;
    }
  });
});

test("COORD-836 reconcile wires actual after-snapshot validation only for an approved packet", () => {
  withCoord678ProjectionFixture(({ paths }) => {
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    const board = { sections: [], prompt_index: {} };
    fs.writeFileSync(paths.PLAN_PATH, "", "utf8");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "# Tasks\n", "utf8");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "PROMPT_INDEX.md"), "# Prompt index\n", "utf8");

    // The packet binds a real, unchanged file under canonical COORD_DIR. The
    // injected provenance view models that file as preexisting semantic drift;
    // the mutation wrapper then follows journal order: run the callback, build
    // the after-snapshot, and invoke the supplied validator before success.
    const packetPath = "engine/scripts/reconcile-packet.js";
    const bytes = fs.readFileSync(path.resolve(__dirname, "..", "..", packetPath));
    const sha1 = crypto.createHash("sha1").update(bytes.toString("utf8"), "utf8").digest("hex");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const entry = { path: packetPath, exists: true, digest: sha1 };
    const provenance = { uninitialized: false, snapshotPruned: false, drift: [packetPath], currentSnapshot: { files: [entry] } };

    const run = (afterSnapshot) => {
      const recovery = createDoctorRecovery({
        fail: (message) => { throw new Error(message); },
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => provenance,
        isRecoverableGovernanceDriftPath: () => false,
        withGovernanceMutation: (mutation, callback) => {
          assert.equal(typeof mutation.validateAfterSnapshot, "function");
          const beforeSnapshot = { files: [entry] };
          const result = callback();
          mutation.validateAfterSnapshot(beforeSnapshot, afterSnapshot);
          return result;
        },
        ...doctorApprovalDependencies(approval),
      });
      const originalLog = console.log;
      console.log = () => {};
      try {
        return runWithSignedDoctorApproval(approval, "control-plane", () => recovery.reconcileGovernance(null, {
          reason: "verify approved snapshot binding",
          humanAdminOverride: "Fixture administrator approved the exact bytes",
          expectPaths: `${sha256} ${packetPath}\n`,
        }));
      } finally { console.log = originalLog; }
    };
    try {
      assert.doesNotThrow(() => run({ files: [entry] }), "an unchanged approved after-snapshot is accepted");
      assert.throws(() => run({ files: [{ ...entry, digest: "changed-after-callback" }] }),
        /actual after-snapshot changed after packet validation/,
        "a changed after-snapshot refuses through the mutation callback");
    } finally { approval.cleanup(); }
  });
});

test("COORD-836 packet-bound genesis reconcile leaves no baseline when bytes change after outer validation", () => {
  const fixture = createIsolatedGovernanceWorkspace({ prefix: "coord836-genesis-race-" });
  try {
    const state = fixture.governance.__testing;
    const target = path.join(fixture.coord, "prompts", "tickets", "COORD-999.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "approved prompt bytes\n");

    const dryRun = fixture.invoke(["reconcile", "--reason", "inspect genesis", "--dry-run"]);
    assert.equal(dryRun.ok, true, dryRun.error);
    const packet = JSON.parse(dryRun.stdout).expect_paths_packet.join("\n") + "\n";
    const eventLog = path.join(fixture.coord, ".runtime", "governance-events.ndjson");
    const snapshotFile = path.join(fixture.coord, ".runtime", "governance-latest-snapshot.json");
    const snapshotDir = path.join(fixture.coord, ".runtime", "governance-snapshots");
    const restorePoint = path.join(fixture.coord, ".runtime", "governance-restore-point.json");
    const readJournalState = () => ({
      eventLog: fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8") : null,
      snapshot: fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile, "utf8") : null,
      restorePoint: fs.existsSync(restorePoint) ? fs.readFileSync(restorePoint, "utf8") : null,
      snapshots: fs.existsSync(snapshotDir)
        ? fs.readdirSync(snapshotDir).sort().map((name) => [name, fs.readFileSync(path.join(snapshotDir, name))])
        : null,
    });
    const journalBefore = readJournalState();
    const savedRecoveryModule = require(resolveEngineModule(fixture.coord, "scripts/doctor-recovery.js"));
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    let mutationEntered = false;
    const recovery = savedRecoveryModule({
      fail: (message) => { throw new fixture.governance.GovernanceError(message); },
      readBoard: state.readBoard,
      detectGovernanceProvenanceDrift: state.detectGovernanceProvenanceDrift,
      isRecoverableGovernanceDriftPath: governanceRepair.isRecoverableGovernanceDriftPath,
      inferTicketStatus: state.inferTicketStatus,
      ...doctorApprovalDependencies(approval),
      withGovernanceMutation: (mutation, callback) => {
        // This is the precise race window: doctor already checked the approved
        // packet, but the real journal transaction has not yet created genesis.
        mutationEntered = true;
        fs.writeFileSync(target, "unapproved raced bytes\n");
        return state.withGovernanceMutation(mutation, callback);
      },
    });

    try {
      assert.throws(() => runWithSignedDoctorApproval(approval, "control-plane", () => recovery.reconcileGovernance(null, {
        reason: "apply reviewed genesis",
        humanAdminOverride: "Fixture administrator approved the exact packet bytes",
        expectPaths: packet,
      }), "reconcile", fixture.coord), /packet|approved|snapshot/i);
      assert.equal(mutationEntered, true, "the original approved packet passed outer validation before the injected race");
      assert.equal(fs.readFileSync(target, "utf8"), "unapproved raced bytes\n", "rollback preserves the pre-transaction file state");
      assert.deepEqual(readJournalState(), journalBefore, "no genesis event or snapshot may survive a refused reconcile");
    } finally { approval.cleanup(); }
  } finally {
    fixture.cleanup();
  }
});

// COORD-722: the board-wide `doctor --fix` / `doctor --repair-all --confirm`
// pass, driven against recording collaborators so each repair the pass owns is
// pinned by what it reports and journals: the confirmed repair-all is journaled
// under its own command, a stale governance runtime lock whose recorded owner is
// dead is released, stale drift notes are retired, orphaned gate process groups
// are reaped, and a failing reaper never aborts the rest of the repair pass.
function boardWideDoctorFixHarness({ retired = [], reap = () => ({ reaped: [] }), alivePids = [], overrides = {} } = {}) {
  const mutations = [];
  const reaperCalls = [];
  const recovery = createDoctorRecovery({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [{ rows: [{ ID: "T-DOING", Repo: "X", Status: "doing", Owner: "ownera" }] }] }),
    resolveDoctorScope: () => ({ targetRef: null, rows: [], byId: new Map() }),
    gitTry: () => ({ status: 0, stdout: "" }),
    canonicalSyncablePaths: () => [],
    isDoingStatus: (status) => status === "doing",
    getTicketRef: (board, ticketId) => {
      const row = board.sections.flatMap((section) => section.rows).find((candidate) => candidate.ID === ticketId);
      return row ? { row } : null;
    },
    findLockForTicket: () => null,
    isStaleTicketLock: () => false,
    withGovernanceMutation: (mutation, action) => { mutations.push(mutation); return action(); },
    withAgentStateLock: (action) => action(),
    getLockFiles: () => [],
    readDirectoryLockMetadata: (lockDir) => JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")),
    isProcessAlive: (pid) => alivePids.includes(pid),
    relativeCoordPath: (target) => path.relative(path.dirname(path.dirname(target)), target),
    auditCoordWorktrees: () => ({ stale_worktrees: [] }),
    applyRetireStaleDriftNotes: ({ dryRun }) => {
      assert.equal(dryRun, false, "the repair pass applies retirement, it does not preview it");
      return { retired };
    },
    resolveEffectiveThreadId: () => "doctor-thread",
    reapIdleAutoClaimedProviderStubs: () => ({ released: [] }),
    reapGateProcOrphans: ({ isTicketDoing }) => {
      reaperCalls.push({ doing: isTicketDoing("T-DOING"), gone: isTicketDoing("T-GONE") });
      return reap();
    },
    ...overrides,
  });
  const run = (options) => {
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      recovery.doctorFix(options);
    } finally {
      console.log = originalLog;
    }
    return JSON.parse(lines.join("\n"));
  };
  return { mutations, reaperCalls, run };
}

function withStaleGovernanceLockDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord722-doctor-lock-"));
  const lockDir = path.join(root, ".runtime", "governance.lock");
  return withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
    try { return fn(lockDir); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

function writeAgedLockDir(lockDir, pid, ageMs) {
  fs.mkdirSync(lockDir, { recursive: true });
  const owner = pid === null ? { kind: "governance-runtime" } : { pid, kind: "governance-runtime" };
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
  const agedSeconds = (Date.now() - ageMs) / 1000;
  fs.utimesSync(lockDir, agedSeconds, agedSeconds);
}

test("COORD-722: confirmed doctor --repair-all journals as doctor-repair-all and applies every board-wide repair", () => {
  withStaleGovernanceLockDir((lockDir) => {
    // Older than the 2-minute stale window, younger than twice it: only a dead
    // recorded owner makes it releasable.
    writeAgedLockDir(lockDir, 999_999_001, 3 * 60 * 1000);
    const reapedEntry = { gate_run_id: "gr-1", ticket: "T-GONE", repo: "backend", lane: "unit", signaled_pids: [4242], reason: "ticket_not_doing" };
    const harness = boardWideDoctorFixHarness({
      retired: [{ date: "2026-10-01", since: "2026-09-30T00:00:00Z", baseline_ts: "2026-10-02T00:00:00Z" }],
      reap: () => ({ reaped: [reapedEntry] }),
    });
    const payload = harness.run({ repairAll: true, confirm: true });

    assert.equal(harness.mutations.length, 1);
    assert.equal(harness.mutations[0].command, "doctor-repair-all");
    assert.equal(harness.mutations[0].allowProvenanceDrift, true);
    assert.equal(fs.existsSync(lockDir), false, "a stale runtime lock with a dead owner is released");
    assert.equal(payload.status, "repaired");
    const byType = Object.fromEntries(payload.repairs.map((repair) => [repair.type, repair]));
    assert.equal(byType.released_stale_governance_lock.dead_owner, true);
    assert.ok(byType.released_stale_governance_lock.age_ms > 2 * 60 * 1000);
    assert.deepEqual(byType.retired_stale_drift_note, {
      type: "retired_stale_drift_note", drift_row_date: "2026-10-01", drift_since: "2026-09-30T00:00:00Z", baseline_ts: "2026-10-02T00:00:00Z",
    });
    assert.deepEqual(byType.reaped_orphan_gate_procs, { type: "reaped_orphan_gate_procs", ...reapedEntry });
    assert.deepEqual(harness.reaperCalls, [{ doing: true, gone: false }], "the reaper sees which owning tickets are still doing");
    assert.deepEqual(harness.mutations[0].details.repairs, payload.repairs, "every reported repair is journaled on the mutation");
  });
});

test("COORD-722: doctor --fix keeps a stale runtime lock whose owner is alive and survives an empty or failing gate reaper", () => {
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedLockDir(lockDir, 999_999_002, 3 * 60 * 1000);
    const emptyReap = boardWideDoctorFixHarness({ alivePids: [999_999_002], reap: () => ({}) });
    const quiet = emptyReap.run({ fix: true });
    assert.equal(emptyReap.mutations[0].command, "doctor-fix");
    assert.equal(fs.existsSync(lockDir), true, "a live owner's lock is not released before twice the stale window");
    assert.deepEqual(quiet, { ticket: null, status: "noop", repairs: [] }, "a reaper result without a reaped list reports nothing");
    assert.equal(emptyReap.reaperCalls.length, 1);

    const failingReap = boardWideDoctorFixHarness({
      alivePids: [999_999_002],
      retired: [{ date: "2026-10-03", since: "2026-10-02T00:00:00Z", baseline_ts: "2026-10-04T00:00:00Z" }],
      reap: () => { throw new Error("gate-proc registry unreadable"); },
    });
    const payload = failingReap.run({ fix: true });
    assert.equal(failingReap.reaperCalls.length, 1);
    assert.equal(payload.status, "repaired", "a reaper failure is best effort and does not abort the pass");
    assert.deepEqual(payload.repairs.map((repair) => repair.type), ["retired_stale_drift_note"]);
  });
});

// COORD-831: doctorFix runs inside withGovernanceMutation, i.e. while holding the
// governance runtime lock it later inspects for staleness. A held lock's mtime is
// never refreshed, so a long pass used to look "stale" and delete its own live
// lock. These tests take the REAL runtime lock around the pass.
const governanceContext = require("./governance-context.js");

// Hermetic held-lock fixture: relocate the runtime dir and every runtime
// authority path into the temp root, so the real withGovernanceRuntimeLock can
// run from a linked worktree too (its canonical-authority guard only refuses
// when those paths are live inside the checkout).
function withHeldLockSandbox(lockDir, fn) {
  const root = path.dirname(path.dirname(lockDir));
  const relocated = {
    RUNTIME_DIR: path.dirname(lockDir),
    GOVERNANCE_EVENT_LOG_PATH: path.join(root, ".runtime", "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(root, ".runtime", "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(root, ".runtime", "governance-snapshots"),
    PLAN_RECORDS_DIR: path.join(root, ".runtime", "plans"),
  };
  const original = Object.fromEntries(Object.keys(relocated).map((key) => [key, governanceState[key]]));
  Object.assign(governanceState, relocated);
  try {
    return fn();
  } finally {
    Object.assign(governanceState, original);
  }
}

test("COORD-831: doctor --fix never releases the runtime lock it currently holds, even past twice the stale window", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    const observed = [];
    const ageHeldLock = () => {
      // Simulate a pass that has run far longer than the stale window: the
      // held lock directory's mtime is from 5 minutes ago (> 2 x 2 minutes).
      const agedSeconds = (Date.now() - 5 * 60 * 1000) / 1000;
      fs.utimesSync(lockDir, agedSeconds, agedSeconds);
      return [];
    };
    const harness = boardWideDoctorFixHarness({
      overrides: {
        withGovernanceMutation: (mutation, action) => governanceContext.withGovernanceRuntimeLock(action),
        readDirectoryLockMetadata: governanceContext.readDirectoryLockMetadata,
        isProcessAlive: governanceContext.isProcessAlive,
        getLockFiles: ageHeldLock,
        auditCoordWorktrees: () => {
          observed.push({ exists: fs.existsSync(lockDir), depth: governanceState.governanceEventLockDepth });
          return { stale_worktrees: [] };
        },
      },
    });
    const payload = harness.run({ fix: true });
    assert.deepEqual(observed, [{ exists: true, depth: 1 }], "the live lock survives the staleness check inside the pass");
    assert.equal(
      payload.repairs.some((repair) => repair.type === "released_stale_governance_lock"),
      false,
      "the pass must not report releasing its own lock",
    );
    assert.equal(fs.existsSync(lockDir), false, "the lock is released normally when the pass exits");
    assert.equal(governanceState.governanceEventLockToken, null, "the acquisition token is cleared on release");
  }));
});

test("COORD-831: holdsGovernanceRuntimeLock matches only this process's current acquisition by pid and token", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    assert.equal(governanceContext.holdsGovernanceRuntimeLock({ pid: process.pid, token: "x" }), false, "not held outside the lock");
    governanceContext.withGovernanceRuntimeLock(() => {
      const metadata = governanceContext.readDirectoryLockMetadata(lockDir);
      assert.equal(typeof metadata.token, "string");
      assert.equal(metadata.token, governanceState.governanceEventLockToken);
      assert.equal(governanceContext.holdsGovernanceRuntimeLock(metadata), true);
      assert.equal(governanceContext.holdsGovernanceRuntimeLock({ ...metadata, token: "other" }), false, "a different acquisition token is foreign");
      assert.equal(governanceContext.holdsGovernanceRuntimeLock({ ...metadata, pid: process.pid + 1 }), false, "a different pid is foreign");
      assert.equal(governanceContext.holdsGovernanceRuntimeLock(null), false, "unreadable metadata is not proof of ownership");
      // Re-entrant acquisition keeps the same token.
      governanceContext.withGovernanceRuntimeLock(() => {
        assert.equal(governanceContext.holdsGovernanceRuntimeLock(metadata), true);
      });
    });
    assert.equal(governanceContext.holdsGovernanceRuntimeLock({ pid: process.pid, token: governanceState.governanceEventLockToken }), false);
  }));
});

test("COORD-831: a foreign runtime lock is judged by its owner, not by age alone", () => {
  // Dead foreign owner past the stale window: still released (COORD-722 case).
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedLockDir(lockDir, 999_999_011, 5 * 60 * 1000);
    const payload = boardWideDoctorFixHarness().run({ fix: true });
    assert.equal(fs.existsSync(lockDir), false, "a genuinely dead foreign lock is released");
    const release = payload.repairs.find((repair) => repair.type === "released_stale_governance_lock");
    assert.equal(release.dead_owner, true);
  });
  // Live foreign owner past TWICE the stale window: kept (live owners are never reclaimed by age).
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedLockDir(lockDir, 999_999_012, 5 * 60 * 1000);
    const payload = boardWideDoctorFixHarness({ alivePids: [999_999_012] }).run({ fix: true });
    assert.equal(fs.existsSync(lockDir), true, "a live owner's lock is never released by age");
    assert.deepEqual(payload.repairs, []);
  });
  // Ownerless lock: kept between one and two stale windows, released past two.
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedLockDir(lockDir, null, 3 * 60 * 1000);
    boardWideDoctorFixHarness().run({ fix: true });
    assert.equal(fs.existsSync(lockDir), true, "an ownerless lock younger than twice the window is kept");
    writeAgedLockDir(lockDir, null, 5 * 60 * 1000);
    const payload = boardWideDoctorFixHarness().run({ fix: true });
    assert.equal(fs.existsSync(lockDir), false, "an ownerless lock older than twice the window is released");
    const release = payload.repairs.find((repair) => repair.type === "released_stale_governance_lock");
    assert.equal(release.dead_owner, false);
  });
});

function captureStderr(fn) {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    return { result: fn(), warnings: chunks.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// COORD-831 review follow-up: while this process holds the runtime lock, the
// doctor pass must skip the staleness check of that lock ENTIRELY, independent
// of what its owner metadata says. Unreadable or missing metadata made the held
// lock look ownerless, and past twice the window the ownerless branch deleted it.
function runHeldDoctorPassWithMetadata(lockDir, tamper) {
  const observed = [];
  const harness = boardWideDoctorFixHarness({
    overrides: {
      withGovernanceMutation: (mutation, action) => governanceContext.withGovernanceRuntimeLock(action),
      readDirectoryLockMetadata: governanceContext.readDirectoryLockMetadata,
      isProcessAlive: governanceContext.isProcessAlive,
      getLockFiles: () => {
        tamper(path.join(lockDir, "lock-owner.json"));
        const agedSeconds = (Date.now() - 5 * 60 * 1000) / 1000;
        fs.utimesSync(lockDir, agedSeconds, agedSeconds);
        return [];
      },
      auditCoordWorktrees: () => {
        observed.push(fs.existsSync(lockDir));
        return { stale_worktrees: [] };
      },
    },
  });
  const { result: payload, warnings } = captureStderr(() => harness.run({ fix: true }));
  return { observed, payload, warnings };
}

for (const [label, tamper] of [
  ["torn", (metadataPath) => fs.writeFileSync(metadataPath, "{torn", "utf8")],
  ["missing", (metadataPath) => fs.rmSync(metadataPath, { force: true })],
]) {
  test(`COORD-831: doctor --fix keeps its own held runtime lock when the owner metadata is ${label}`, () => {
    withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
      const { observed, payload, warnings } = runHeldDoctorPassWithMetadata(lockDir, tamper);
      assert.deepEqual(observed, [true], "the held lock survives the pass regardless of its metadata");
      assert.equal(
        payload.repairs.some((repair) => repair.type === "released_stale_governance_lock"),
        false,
        "the pass never reports releasing the lock it holds",
      );
      // The release cannot prove the directory is still ours, so it is left in
      // place for break-runtime-lock and reported, never deleted blind.
      assert.equal(fs.existsSync(lockDir), true);
      assert.match(warnings, /governance runtime lock .*not released/i);
      assert.equal(governanceState.governanceEventLockDepth, 0);
      assert.equal(governanceState.governanceEventLockToken, null);
    }));
  });
}

// COORD-831 review follow-up: releasing the runtime lock must not delete a lock
// someone else re-acquired after ours was broken (break-runtime-lock --force-live).
// The token alone decides here: same pid, different token is a foreign lock.
test("COORD-831: releasing the runtime lock keeps a lock re-acquired under another token by the same pid", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    const { warnings } = captureStderr(() => governanceContext.withGovernanceRuntimeLock(() => {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "lock-owner.json"),
        JSON.stringify({ pid: process.pid, kind: "governance-runtime", token: "someone-else" }),
        "utf8",
      );
    }));
    assert.equal(fs.existsSync(lockDir), true, "the re-acquired lock is not ours to delete");
    assert.equal(governanceContext.readDirectoryLockMetadata(lockDir).token, "someone-else");
    assert.match(warnings, /governance runtime lock .*not released/i);
    assert.match(warnings, /runtime-lock-status/);
    assert.match(warnings, /coord\/scripts\/gov break-runtime-lock --yes/, "the warning names the stale-lock recovery verb");
    assert.equal(governanceState.governanceEventLockDepth, 0);
    assert.equal(governanceState.governanceEventLockToken, null);
  }));
});

test("COORD-831: releasing the runtime lock is silent when the lock was already broken and not re-acquired", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    const { warnings } = captureStderr(() => governanceContext.withGovernanceRuntimeLock(() => {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }));
    assert.equal(fs.existsSync(lockDir), false);
    assert.equal(warnings, "");
    assert.equal(governanceState.governanceEventLockDepth, 0);
  }));
});

test("COORD-831: releasing the runtime lock removes it when the token is ours", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    const { warnings } = captureStderr(() => governanceContext.withGovernanceRuntimeLock(() => {
      assert.equal(fs.existsSync(lockDir), true);
    }));
    assert.equal(fs.existsSync(lockDir), false, "our own lock is released on exit");
    assert.equal(warnings, "");
  }));
});

// COORD-831 review follow-up: if the owner record fails to land after mkdir
// succeeded, the acquisition must not leave an ownerless directory behind. Such a
// directory is never reclaimed (requireKnownOwner), so every later acquire would
// time out until break-runtime-lock. `beforeThrow` runs inside the failing write.
function withFailingLockMetadataWrite(lockDir, beforeThrow, fn) {
  const originalWrite = fs.writeFileSync;
  let failures = 0;
  fs.writeFileSync = function patchedWrite(target, ...rest) {
    if (failures === 0 && String(target).startsWith(path.join(lockDir, "lock-owner.json"))) {
      failures += 1;
      beforeThrow(rest);
      const error = new Error("injected metadata write failure");
      error.code = "ENOSPC";
      throw error;
    }
    return originalWrite.call(this, target, ...rest);
  };
  try {
    return fn(() => failures);
  } finally {
    fs.writeFileSync = originalWrite;
  }
}

function acquireOnce() {
  let ran = false;
  governanceContext.withGovernanceRuntimeLock(() => { ran = true; });
  return ran;
}

const originalWriteFileSync = fs.writeFileSync;
for (const label of ["no owner record landed", "this attempt's own owner record landed before the failure"]) {
  test(`COORD-831: a failed owner-record write after mkdir removes the lock directory (${label})`, () => {
    withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
      const hook = label.startsWith("no") ? () => {} : (rest) => {
        // Land the real record (our pid + token) through the unpatched write.
        fs.mkdirSync(lockDir, { recursive: true });
        originalWriteFileSync(path.join(lockDir, "lock-owner.json"), rest[0], "utf8");
      };
      withFailingLockMetadataWrite(lockDir, hook, (failures) => {
        assert.throws(() => acquireOnce(), /injected metadata write failure/);
        assert.equal(failures(), 1);
        assert.equal(fs.existsSync(lockDir), false, "the half-acquired lock directory is removed");
        assert.equal(governanceState.governanceEventLockDepth, 0);
        assert.equal(governanceState.governanceEventLockToken, null);
        const startedAt = Date.now();
        assert.equal(acquireOnce(), true, "the next acquire succeeds");
        assert.ok(Date.now() - startedAt < 5000, "the next acquire does not wait for a timeout");
        assert.equal(fs.existsSync(lockDir), false);
      });
    }));
  });
}

for (const [label, foreignOwner] of [
  ["another token", () => ({ pid: process.pid, kind: "governance-runtime", token: "someone-else" })],
  ["another pid", () => ({ pid: process.pid + 1, kind: "governance-runtime", token: "someone-else" })],
]) {
  test(`COORD-831: a failed owner-record write keeps a lock directory now owned by ${label}`, () => {
    withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
      withFailingLockMetadataWrite(lockDir, () => {
        originalWriteFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify(foreignOwner()), "utf8");
      }, () => {
        assert.throws(() => acquireOnce(), /injected metadata write failure/);
      });
      assert.equal(fs.existsSync(lockDir), true, "a directory carrying someone else's owner record is not ours to delete");
      assert.equal(governanceContext.readDirectoryLockMetadata(lockDir).token, "someone-else");
      assert.equal(governanceState.governanceEventLockDepth, 0);
      assert.equal(governanceState.governanceEventLockToken, null);
    }));
  });
}

test("COORD-831: a non-EEXIST mkdir failure is rethrown without touching any lock directory", () => {
  withStaleGovernanceLockDir((lockDir) => withHeldLockSandbox(lockDir, () => {
    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = function patchedMkdir(target, ...rest) {
      if (String(target) === lockDir) {
        const error = new Error("injected mkdir failure");
        error.code = "EACCES";
        throw error;
      }
      return originalMkdir.call(this, target, ...rest);
    };
    try {
      assert.throws(() => acquireOnce(), /injected mkdir failure/);
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    assert.equal(fs.existsSync(lockDir), false);
    assert.equal(governanceState.governanceEventLockDepth, 0);
    assert.equal(governanceState.governanceEventLockToken, null);
    assert.equal(acquireOnce(), true, "a later acquire still succeeds");
  }));
});

// COORD-831 coverage follow-up: the board-wide lock pass classifies every ticket
// lock file. Unreadable or ticketless files are skipped untouched; a lock whose
// ticket left the board is released as non-doing; a doing ticket's lock is kept
// while fresh and released as stale once its heartbeat is over a day old.
function writeTicketLock(locksDir, name, ticket, heartbeatUtc) {
  const lockPath = path.join(locksDir, name);
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: "ownera", ticket, status: "doing", repo: "coord", branch: `agent/ownera-${ticket.toLowerCase()}`,
    worktree: `/tmp/${ticket}`, started_at_utc: heartbeatUtc, heartbeat_utc: heartbeatUtc,
  }), "utf8");
  return lockPath;
}

// The scope's row list only drives plan-stub seeding, which is not under test.
function doctorLockScope(rows, targetRef = null) {
  return () => ({ targetRef, rows: [], byId: new Map(rows.map((row) => [row.ID, row])) });
}

function readJsonOrNull(target) {
  try { return JSON.parse(fs.readFileSync(target, "utf8")); } catch { return null; }
}

test("COORD-831: board-wide doctor --fix skips unreadable locks and releases gone-ticket and stale locks by reason", () => {
  withStaleGovernanceLockDir((lockDir) => {
    const locksDir = path.join(path.dirname(lockDir), "locks");
    fs.mkdirSync(locksDir, { recursive: true });
    const fresh = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const torn = path.join(locksDir, "torn.lock");
    fs.writeFileSync(torn, "{torn", "utf8");
    const ticketless = path.join(locksDir, "ticketless.lock");
    fs.writeFileSync(ticketless, JSON.stringify({ owner: "ownera", status: "doing" }), "utf8");
    const gone = writeTicketLock(locksDir, "T-GONE.lock", "T-GONE", fresh);
    const stale = writeTicketLock(locksDir, "T-DOING.lock", "T-DOING", twoDaysAgo);
    const live = writeTicketLock(locksDir, "T-LIVE.lock", "T-LIVE", fresh);
    const rows = [
      { ID: "T-DOING", Repo: "X", Status: "doing", Owner: "ownera" },
      { ID: "T-LIVE", Repo: "X", Status: "doing", Owner: "ownera" },
    ];
    const payload = boardWideDoctorFixHarness({
      overrides: {
        resolveDoctorScope: doctorLockScope(rows),
        getLockFiles: () => [torn, ticketless, gone, stale, live],
        safeReadJson: readJsonOrNull,
      },
    }).run({ fix: true });

    assert.equal(fs.readFileSync(torn, "utf8"), "{torn", "an unreadable lock file is left untouched");
    assert.equal(fs.existsSync(ticketless), true, "a lock naming no ticket is left untouched");
    assert.equal(fs.existsSync(live), true, "a fresh lock of a doing ticket is kept");
    assert.equal(fs.existsSync(gone), false);
    assert.equal(fs.existsSync(stale), false);
    assert.deepEqual(
      payload.repairs.map((repair) => [repair.type, repair.ticket]),
      [["released_non_doing_lock", "T-GONE"], ["released_stale_lock", "T-DOING"]],
    );
  });
});

test("COORD-831: ticket-scoped doctor --fix removes only the target ticket's orphan coord worktree", () => {
  withStaleGovernanceLockDir((lockDir) => {
    const root = path.dirname(path.dirname(lockDir));
    const locksDir = path.join(root, ".runtime", "locks");
    fs.mkdirSync(locksDir, { recursive: true });
    const foreignLock = writeTicketLock(locksDir, "T-DONE.lock", "T-DONE", new Date().toISOString());
    const target = path.join(root, ".worktrees", "ownera", "T-DOING");
    const foreign = path.join(root, ".worktrees", "ownera", "T-OTHER");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    const pruned = [];
    const doingRow = { ID: "T-DOING", Repo: "X", Status: "doing", Owner: "ownera" };
    const rows = [doingRow, { ID: "T-DONE", Repo: "X", Status: "done", Owner: "ownera" }];
    const payload = boardWideDoctorFixHarness({
      overrides: {
        resolveDoctorScope: doctorLockScope(rows, { row: doingRow }),
        readAgentSessions: () => [],
        getLockFiles: () => [foreignLock],
        safeReadJson: readJsonOrNull,
        auditCoordWorktrees: () => ({ stale_worktrees: [{ ticket: "T-OTHER", path: foreign }, { ticket: "T-DOING", path: target }] }),
        pruneEmptyParents: (entry, stopAt) => pruned.push([entry, stopAt]),
        coordWorktreesRoot: () => path.join(root, ".worktrees"),
      },
    }).run({ fix: true, ticket: "T-DOING" });

    assert.equal(fs.existsSync(target), false, "the target ticket's orphan worktree is removed");
    assert.equal(fs.existsSync(foreign), true, "another ticket's orphan worktree is out of scope");
    assert.equal(fs.existsSync(foreignLock), true, "another ticket's non-doing lock is out of scope");
    assert.deepEqual(pruned, [[target, path.join(root, ".worktrees")]]);
    assert.deepEqual(payload, {
      ticket: "T-DOING",
      status: "repaired",
      repairs: [{ type: "removed_orphan_coord_worktree", ticket: "T-DOING", path: target }],
    });
  });
});

test("COORD-831: a failed release of a dead-owner runtime lock is not reported and does not abort the pass", () => {
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedLockDir(lockDir, 999_999_021, 3 * 60 * 1000);
    const observed = [];
    const originalRm = fs.rmSync;
    fs.rmSync = function patchedRm(target, ...rest) {
      if (String(target) === lockDir) {
        const error = new Error("injected lock removal failure");
        error.code = "EBUSY";
        throw error;
      }
      return originalRm.call(this, target, ...rest);
    };
    let payload;
    try {
      payload = boardWideDoctorFixHarness({
        overrides: {
          auditCoordWorktrees: () => {
            observed.push("audited");
            return { stale_worktrees: [] };
          },
        },
      }).run({ fix: true });
    } finally {
      fs.rmSync = originalRm;
    }
    assert.equal(fs.existsSync(lockDir), true, "the lock that could not be removed is still there");
    assert.deepEqual(observed, ["audited"], "the pass continues past the failed release");
    assert.deepEqual(payload, { ticket: null, status: "noop", repairs: [] }, "an unreleased lock is never reported as released");
  });
});

test("COORD-862 reconcile --scope narrows the adoption set and reports drift by scope", () => {
  withCoord678ProjectionFixture(({ board }) => {
    const drift = ["locks/COORD-1.lock", "prompts/tickets/COORD862-FIXTURE.md", "rendered/COORD862-FIXTURE.md"];
    const run = (options, provenance = { uninitialized: false, drift, currentSnapshot: { digest: "d", files: [] } }) => {
      const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
      let metadata = null;
      const recovery = createDoctorRecovery({
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => provenance,
        isRecoverableGovernanceDriftPath: (entry) => entry.startsWith("locks/"),
        withGovernanceMutation: (value, callback) => { metadata = value; return callback(); },
        relativeCoordPath: (file) => path.relative(path.resolve(__dirname, "..", ".."), file).split(path.sep).join("/"),
        ...doctorApprovalDependencies(approval),
      });
      const lines = [];
      const originalLog = console.log;
      console.log = (line) => lines.push(line);
      try {
        const attempt = () => recovery.reconcileGovernance(null, { reason: "fixture", ...options });
        if (options.humanAdminOverride && options.expectPaths) runWithSignedDoctorApproval(approval, "control-plane", attempt);
        else attempt();
        return { metadata, output: JSON.parse(lines.join("\n")) };
      } finally { console.log = originalLog; approval.cleanup(); }
    };
    const dry = run({ scope: "derived", dryRun: true }).output;
    assert.equal(dry.scope, "derived");
    assert.deepEqual(dry.drift, ["rendered/COORD862-FIXTURE.md"]);
    assert.deepEqual(dry.drift_by_scope.governed, ["prompts/tickets/COORD862-FIXTURE.md"]);
    assert.equal(dry.scope_summary, "engine intact, 3 project paths unjournaled (governed 1, derived 1, runtime 1)");
    assert.equal(dry.requires_human_admin_override, true);
    // Runtime lock drift alone needs no approval; the other scopes are retained.
    const runtime = run({ scope: " runtime " });
    assert.deepEqual(runtime.metadata.adoptDriftPaths, ["locks/COORD-1.lock"]);
    assert.equal(runtime.metadata.details.reconcile_scope, "runtime");
    assert.deepEqual(runtime.metadata.details.reconciled_drift, ["locks/COORD-1.lock"]);
    const unscoped = run({ humanAdminOverride: "approve", expectPaths: "absent prompts/tickets/COORD862-FIXTURE.md\nabsent rendered/COORD862-FIXTURE.md\n" });
    assert.equal(unscoped.metadata.adoptDriftPaths, undefined, "an unscoped reconcile adopts everything as before");
    assert.throws(() => run({ scope: "engine" }), /--scope must be one of governed, derived, runtime/);
    assert.throws(() => run({ scope: "governed" }, { uninitialized: true, drift: [], currentSnapshot: { digest: "d", files: [] } }),
      /--scope cannot establish a missing or pruned baseline/);
    // A missing baseline still dry-runs; it has no file-level drift to classify.
    const lost = run({ dryRun: true }, { uninitialized: true, drift: [], currentSnapshot: { digest: "d", files: [] } }).output;
    assert.deepEqual(lost.drift_by_scope, { engine: [], governed: [], derived: [], runtime: [] });
  });
});

// COORD-1003: the governance-lock release in doctor --repair-all judges the recorded owner with the
// start-time-aware liveness. A reused pid (different start time) and a zombie owner are dead and
// the lock is released; the same process, and an owner whose start time cannot be read, are kept.
function writeAgedOwnerLockDir(lockDir, owner, ageMs) {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ kind: "governance-runtime", ...owner }), "utf8");
  const agedSeconds = (Date.now() - ageMs) / 1000;
  fs.utimesSync(lockDir, agedSeconds, agedSeconds);
}

function runRepairAllOverGovernanceLock(owner, overrides = {}) {
  let outcome;
  withStaleGovernanceLockDir((lockDir) => {
    writeAgedOwnerLockDir(lockDir, owner, 3 * 60 * 1000);
    const harness = boardWideDoctorFixHarness({ alivePids: [process.pid], overrides });
    const payload = harness.run({ repairAll: true, confirm: true });
    const release = payload.repairs.find((repair) => repair.type === "released_stale_governance_lock");
    outcome = { released: fs.existsSync(lockDir) === false, release };
  });
  return outcome;
}

test("COORD-1003: doctor releases a governance lock whose pid was reused by a different process", () => {
  const outcome = runRepairAllOverGovernanceLock({ pid: process.pid, pid_start_time: "1" });
  assert.equal(outcome.released, true, "a reused pid is dead: the stale governance lock is released");
  assert.equal(outcome.release.dead_owner, true);
});

test("COORD-1003: doctor keeps a governance lock whose owner is the same process (matching start time)", () => {
  const start = require("./process-identity.js").readProcStartTime(process.pid);
  const outcome = runRepairAllOverGovernanceLock({ pid: process.pid, pid_start_time: start });
  assert.equal(outcome.released, false, "a live owner with a matching start time is never released");
  assert.equal(outcome.release, undefined);
});

test("COORD-1003: doctor keeps a governance lock whose start time cannot be read (PID-only, never reclaimed on start time)", () => {
  const outcome = runRepairAllOverGovernanceLock({ pid: process.pid }, { readProcessStartTime: () => null });
  assert.equal(outcome.released, false, "an unknown start time keeps the alive owner");
  assert.equal(outcome.release, undefined);
});

test("COORD-1003: doctor releases a governance lock whose owner is a zombie", () => {
  const start = require("./process-identity.js").readProcStartTime(process.pid);
  const outcome = runRepairAllOverGovernanceLock({ pid: process.pid, pid_start_time: start }, { readProcessState: () => "Z" });
  assert.equal(outcome.released, true, "a zombie has exited and is dead outside run-ownership");
  assert.equal(outcome.release.dead_owner, true);
});

function assertUsableBaselineReapproval(changePoint) {
    withCoord678ProjectionFixture(({ board, paths }) => {
      const filePath = "coord1048-usable-baseline-fixture.json";
      assert.equal(fs.existsSync(path.join(path.resolve(__dirname, "../.."), filePath)), false,
        "the absent-file packet must never name an existing workspace file");
      const provenance = {
        uninitialized: false, snapshotPruned: false, snapshotMatchesCurrent: false,
        expectedSnapshotDigest: "a".repeat(40), drift: [filePath],
        currentSnapshot: { digest: "c".repeat(40), files: [
          { path: filePath, exists: false, digest: crypto.createHash("sha1").update("").digest("hex") },
        ] },
      };
      const materialBefore = JSON.stringify(provenance.currentSnapshot);
      const options = { reason: "bind the usable baseline identity", humanAdminOverride: "approved exact reconcile state",
        expectPaths: `absent ${filePath}\n` };
      const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
      const events = [];
      let changeInside = false, entered = 0, adopted = 0;
      const recovery = createDoctorRecovery({
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => ({ ...provenance }),
        isRecoverableGovernanceDriftPath: () => false,
        resolveHumanAdminOverride: (_verb, opts) => ({ reason: opts.humanAdminOverride }),
        appendGovernanceEvent: (event) => {
          events.push(event);
          fs.mkdirSync(paths.RUNTIME_DIR, { recursive: true });
          fs.appendFileSync(path.join(paths.RUNTIME_DIR, "governance-events.ndjson"), `${JSON.stringify(event)}\n`);
        },
        withGovernanceMutation: (_metadata, callback) => {
          entered += 1;
          if (changeInside) provenance.expectedSnapshotDigest = "b".repeat(40);
          const result = callback();
          adopted += 1;
          return result;
        },
      });
      const originalLog = console.log;
      console.log = () => {};
      try {
        withApprovalTestClient(path.resolve(__dirname, "../.."), approval.client(), () => {
          const refusedSubject = () => {
            let subject;
            assert.throws(() => recovery.reconcileGovernance(null, options), (error) => {
              subject = /Subject digest: ([0-9a-f]{64})/.exec(error.message)?.[1];
              assert.ok(subject, error.message);
              return true;
            });
            return subject;
          };
          const firstSubject = refusedSubject();
          assert.equal(entered, 0, "an unsigned request never enters the mutation");
          approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: firstSubject });
          if (changePoint === "before verification") provenance.expectedSnapshotDigest = "b".repeat(40);
          else changeInside = true;
          assert.throws(() => recovery.reconcileGovernance(null, options),
            changeInside ? /state changed after human approval/ : /requires a signed human-admin approval/);
          assert.equal(entered, changeInside ? 1 : 0);
          assert.equal(adopted, 0, "a changed baseline must not be adopted using the earlier approval");
          assert.equal(JSON.stringify(provenance.currentSnapshot), materialBefore, "material contents did not change");
          assert.equal(options.expectPaths, `absent ${filePath}\n`, "approved packet did not change");
          if (changeInside) assert.ok(events.some((event) => event.event === "approval.verified"),
            "the inside-mutation case must exercise revalidation after genuine signature verification");
          changeInside = false;
          const newSubject = refusedSubject();
          assert.notEqual(newSubject, firstSubject, "usable baseline identity must affect the signed subject");
          approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: newSubject });
          recovery.reconcileGovernance(null, options);
          assert.equal(adopted, 1, "a new approval bound to the new baseline can reconcile the same material and packet");
        });
      } finally {
        console.log = originalLog;
        approval.cleanup();
      }
    });
 }

test("COORD-1048: changed usable baseline invalidates prior reconcile approval before verification", () => {
  assertUsableBaselineReapproval("before verification");
});

test("COORD-1048: changed usable baseline invalidates prior reconcile approval inside the mutation", () => {
  assertUsableBaselineReapproval("inside mutation");
});

// Exercise the real session normalizer, lock-mirror classifier and repair pass
// together; persistence collaborators are confined to this in-memory fixture.
function retainedIdleMirrorFixture({
  now, status = "doing", age = 4 * 60 * 60 * 1000 + 1, lockPath = null,
  writeBoard = () => { throw new Error("valid retained board must not be rewritten"); },
} = {}) {
  const { COORD_DIR } = require("./governance-context.js");
  const state = { BOARD_PATH: governanceState.BOARD_PATH };
  const agent = { id: "a60", handle: "codexa60", status: "active" };
  const row = { ID: "TEST-1060", Repo: "X", Status: status, Owner: agent.handle };
  const board = { sections: [{ rows: [row] }] };
  const seen = new Date(now - age).toISOString();
  const lock = { ticket: row.ID, owner: agent.handle, agent_id: agent.id, status: "doing", repo: "coord",
    branch: "agent/coord1060", worktree: "/tmp/coord1060-fixture/worktree", head: "a".repeat(40),
    session_id: "a60-idle", thread_id: "original-thread", started_at_utc: seen, heartbeat_utc: seen };
  let sessions = [{ session_id: lock.session_id, agent_id: agent.id, handle: agent.handle,
    board_path: state.BOARD_PATH, board_root: COORD_DIR, thread_id: lock.thread_id,
    claimed_at: seen, last_seen_at: seen, status: "active", auto_claimed: false }];
  const sessionApi = createGovernanceSession({ AGENT_SESSION_IDLE_MS: 4 * 60 * 60 * 1000, COORD_DIR, state });
  const normalize = () => { sessions = sessionApi.normalizeAgentSessions(sessions).sessions; return sessions; };
  const mirror = require("./lifecycle-lock-commands.js")({ COORD_DIR, state, STATUS: { DOING: "doing" },
    isCompleteLockPayload: sessionApi.isCompleteLockPayload, isDoingStatus: (value) => /^doing(?: \(blocked: .+\))?$/.test(value),
    normalizeOwnerValue: (value) => value, ownerMatches: (left, right) => left === right,
    AGENT_SESSION_IDLE_MS: 4 * 60 * 60 * 1000,
    readAgentsRegistry: () => [agent], resolveAgentIdentifier: (handle) => handle === agent.handle ? { agent } : null });
  let writes = 0;
  const harness = boardWideDoctorFixHarness({ overrides: { readBoard: () => board,
    resolveDoctorScope: () => ({ targetRef: { row }, rows: [row], byId: new Map([[row.ID, row]]) }),
    findLockForTicket: () => lockPath ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : lock, readAgentSessions: normalize,
    getLockFiles: () => lockPath ? [lockPath] : [],
    safeReadJson: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
    normalizeAgentSessions: sessionApi.normalizeAgentSessions,
    inspectCanonicalLockMirrorState: mirror.inspectCanonicalLockMirrorState,
    readPlanRecord: () => ({ ticket_id: row.ID }),
    writeJsonFile: (_path, value) => { writes += 1; sessions = value; },
    defaultHostLabel: () => "fixture", runBoardSync: () => {}, withCoordStateLock: (action) => action(),
    writeBoard,
  } });
  return { row, lock, agent, normalize, get sessions() { return sessions; }, get writes() { return writes; },
    inspect: (overrides = {}) => mirror.inspectCanonicalLockMirrorState({ board, row, lock, sessions, ...overrides }),
    run: (options = { ticket: row.ID }) => harness.run({ fix: true, ...options }) };
}

test("COORD-1060: expiry boundaries preserve retained ownership without renewing session liveness", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const age of [4 * 60 * 60 * 1000 - 1, 4 * 60 * 60 * 1000, 4 * 60 * 60 * 1000 + 1]) {
    for (const status of ["doing", "doing (blocked: host access unavailable)"]) {
      const f = retainedIdleMirrorFixture({ now, age, status });
      f.normalize();
      const expectedStatus = age > 4 * 60 * 60 * 1000 ? "expired" : "active";
      assert.equal(f.sessions[0].status, expectedStatus);
      const before = JSON.stringify({ sessions: f.sessions, row: f.row, lock: f.lock });
      assert.deepEqual(f.inspect().issues, [], "idle liveness is not corrupted ownership metadata");
      for (let pass = 0; pass < 2; pass += 1) {
        assert.equal(f.run().status, "noop");
        f.normalize();
        assert.equal(JSON.stringify({ sessions: f.sessions, row: f.row, lock: f.lock }), before);
      }
      assert.equal(f.writes, 0, "doctor must not revive and re-expire a valid historical binding");
    }
  }
});

test("COORD-1060: retained ownership does not excuse explicit release or conflicting bindings", (t) => {
  const ownerless = retainedIdleMirrorFixture({ now: Date.now() });
  const lock = { ...ownerless.lock };
  delete lock.owner;
  const classified = ownerless.inspect({ lock, sessions: null });
  assert.deepEqual(classified.conflicts, [`Ticket ${ownerless.row.ID} canonical lock is missing owner metadata.`]);
  assert.equal(classified.agent, null);
  assert.equal(classified.boardRepairNeeded, false);
  delete ownerless.lock.owner;
  assert.throws(() => ownerless.run(), /cannot rebuild mirrored state deterministically/);
  assert.equal(ownerless.writes, 0);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const mutate of [
    (f) => { f.sessions[0].status = "released"; f.sessions[0].release_reason = "manual-release"; },
    (f) => { f.sessions[0].release_reason = "revoked"; },
    (f) => { f.sessions[0].handle = "codexa61"; },
    (f) => { f.sessions[0].agent_id = "a61"; },
    (f) => { f.agent.handle = "unregistered-owner"; },
    (f) => { f.sessions[0].released_at = new Date(now + 1).toISOString(); },
    (f) => { f.sessions[0].released_at = new Date(now - 2).toISOString(); },
    (f) => { delete f.sessions[0].released_at; },
    (f) => { delete f.sessions[0].last_seen_at; delete f.sessions[0].claimed_at; },
    (f) => { f.sessions.push({ ...f.sessions[0] }); },
    (f) => { f.sessions.push({ ...f.sessions[0], session_id: "a60-competing", status: "active", last_seen_at: new Date(now).toISOString() }); },
  ]) {
    const f = retainedIdleMirrorFixture({ now });
    f.normalize(); mutate(f);
    const before = JSON.stringify(f.sessions);
    assert.ok(f.inspect().issues.length + f.inspect().conflicts.length > 0);
    assert.throws(() => f.run(), /cannot rebuild mirrored state deterministically/);
    assert.equal(JSON.stringify(f.sessions), before);
    assert.equal(f.writes, 0);
  }
});


test("COORD-1060: stale missing mirrors rebuild as expired while metadata repairs retain historical activity", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = retainedIdleMirrorFixture({ now });
  f.sessions.splice(0);
  const rebuilt = f.run();
  assert.equal(rebuilt.status, "repaired");
  assert.equal(f.sessions[0].status, "expired");
  assert.equal(f.sessions[0].last_seen_at, f.lock.heartbeat_utc);
  assert.equal(f.run().status, "noop");
  const historical = JSON.stringify({ last_seen_at: f.sessions[0].last_seen_at, released_at: f.sessions[0].released_at,
    claimed_at: f.sessions[0].claimed_at, status: f.sessions[0].status });
  f.sessions[0].thread_id = "stale-thread-metadata";
  assert.equal(f.run().status, "repaired");
  assert.equal(f.sessions[0].thread_id, f.lock.thread_id);
  assert.equal(JSON.stringify({ last_seen_at: f.sessions[0].last_seen_at, released_at: f.sessions[0].released_at,
    claimed_at: f.sessions[0].claimed_at, status: f.sessions[0].status }), historical);
  assert.equal(f.run().status, "noop");
});


test("COORD-1060: metadata repair preserves newer genuine activity than the retained lock heartbeat", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const activityField of ["last_seen_at", "claimed_at"]) {
    const f = retainedIdleMirrorFixture({ now });
    const recentActivity = new Date(now - 1000).toISOString();
    f.sessions[0][activityField] = recentActivity;
    if (activityField === "claimed_at") delete f.sessions[0].last_seen_at;
    f.sessions[0].thread_id = "stale-thread-metadata";
    const originalClaim = f.sessions[0].claimed_at;
    assert.notEqual(f.lock.heartbeat_utc, recentActivity);
    assert.equal(f.run().status, "repaired");
    assert.equal(f.sessions[0].thread_id, f.lock.thread_id);
    assert.equal(f.sessions[0].status, "active");
    assert.equal(f.sessions[0].last_seen_at, recentActivity, "genuine session activity takes precedence over an older lock");
    assert.equal(f.sessions[0].claimed_at, originalClaim, "a distinct authored claim timestamp is retained");
    const retained = JSON.stringify(f.sessions);
    assert.equal(f.run().status, "noop");
    assert.equal(JSON.stringify(f.sessions), retained);
  }
});


test("COORD-1060: bound lock repair refuses missing, invalid or future historical activity", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1060-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "ticket.lock");
  for (const [scoped, malformed] of [[true, false], [true, true], [false, true]]) {
    for (const mutate of [
      (lock) => { lock.heartbeat_utc = "not-a-timestamp"; },
      (lock) => { delete lock.heartbeat_utc; delete lock.started_at_utc; },
      (lock) => { lock.heartbeat_utc = new Date(now + 1).toISOString(); },
      (lock) => { lock.started_at_utc = "not-a-timestamp"; },
      (lock) => { lock.started_at_utc = new Date(now + 1).toISOString(); },
    ]) {
      const f = retainedIdleMirrorFixture({ now, lockPath });
      f.sessions.splice(0);
      if (malformed) delete f.lock.branch; // Cover complete reconstruction and the malformed-lock pass.
      mutate(f.lock);
      const before = JSON.stringify(f.lock);
      fs.writeFileSync(lockPath, before);
      for (let pass = 0; pass < 2; pass += 1) {
        assert.throws(() => f.run(scoped ? { ticket: f.row.ID } : {}), /historical activity.*owner recovery/);
        assert.equal(fs.readFileSync(lockPath, "utf8"), before, "repair must not invent a timestamp for a later pass");
        assert.deepEqual(f.sessions, []);
        assert.equal(f.writes, 0);
      }
    }
  }
});


test("COORD-1060: bound lock timestamp completion retains historical expiry and recent activity", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1060-completion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "ticket.lock");
  for (const age of [5 * 60 * 60 * 1000, 1000]) {
    for (const missing of ["heartbeat_utc", "started_at_utc"]) {
      const f = retainedIdleMirrorFixture({ now, age, lockPath });
      const historical = f.lock.heartbeat_utc;
      delete f.lock[missing];
      f.sessions.splice(0);
      fs.writeFileSync(lockPath, JSON.stringify(f.lock));
      assert.equal(f.run().status, "repaired", "first pass completes lock metadata from its real historical timestamp");
      const repaired = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.equal(repaired.started_at_utc, historical);
      assert.equal(repaired.heartbeat_utc, historical);
      // A heartbeat is optional in the canonical completeness predicate; a missing
      // start blocks mirror reconstruction until the lock has been completed.
      assert.equal(f.sessions.length, missing === "heartbeat_utc" ? 1 : 0);
      assert.equal(f.run().status, missing === "heartbeat_utc" ? "noop" : "repaired");
      assert.equal(f.sessions[0].last_seen_at, historical);
      assert.equal(f.sessions[0].claimed_at, historical);
      assert.equal(f.sessions[0].status, age > 4 * 60 * 60 * 1000 ? "expired" : "active");
      const before = JSON.stringify(f.sessions);
      assert.equal(f.run().status, "noop");
      assert.equal(JSON.stringify(f.sessions), before);
      assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), repaired);
    }
  }
});

test("reconcile rejects invalid snapshot evidence before requesting or consuming approval", () => {
  withCoord678ProjectionFixture(({ board }) => {
    const file = "missing-reconcile-fixture.json";
    const entry = { path: file, exists: false, digest: crypto.createHash("sha1").update("").digest("hex") };
    const invalidSnapshots = [
      [null, /without the materialized current snapshot files/],
      [[entry, entry], /duplicate current snapshot entry/],
      [[{ ...entry, path: "../outside.json" }], /malformed or duplicate current snapshot entry/],
      [[{ ...entry, digest: "incomplete" }], /malformed or duplicate current snapshot entry/],
    ];
    for (const [files, message] of invalidSnapshots) {
      const recovery = createDoctorRecovery({
        readBoard: () => board,
        detectGovernanceProvenanceDrift: () => ({
          drift: [file], uninitialized: false, snapshotPruned: false, currentSnapshot: { files },
        }),
        isRecoverableGovernanceDriftPath: () => false,
        appendGovernanceEvent: () => assert.fail("attempted an approval audit write"),
        withGovernanceMutation: () => assert.fail("entered the mutation"),
      });
      assert.throws(() => recovery.reconcileGovernance(null, {
        reason: "validate recorded snapshot", humanAdminOverride: "approve exact fixture",
        expectPaths: "absent " + file + "\n",
      }), message);
    }
  });
});

test("doctor fixes owner-authoritative board mirrors without creating a legacy session", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const persisted = [];
  const f = retainedIdleMirrorFixture({ now, age: 1_000, writeBoard: (board) => persisted.push(JSON.stringify(board)) });
  Object.assign(f.row, { Status: "todo", Owner: "unassigned" });
  Object.assign(f.lock, { identity_model: "v2", session_id: null, thread_id: null });
  f.sessions.splice(0);
  const originalLock = JSON.stringify(f.lock);
  assert.equal(f.inspect().boardRepairNeeded, true);
  assert.equal(f.inspect().sessionRepair, null);
  const repaired = f.run();
  assert.equal(repaired.status, "repaired");
  assert.deepEqual(repaired.repairs.map(({ type }) => type), ["rebuilt_board_from_canonical_lock"]);
  assert.equal(f.row.Status, "doing");
  assert.equal(f.row.Owner, f.lock.owner);
  assert.equal(persisted.length, 1);
  assert.deepEqual(JSON.parse(persisted[0]).sections[0].rows, [f.row]);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.sessions, []);
  assert.equal(JSON.stringify(f.lock), originalLock);
  assert.equal(f.run().status, "noop");
});

test("doctor normalizes an incomplete legacy session without inventing a thread or recent activity", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = retainedIdleMirrorFixture({ now, age: 1_000 });
  delete f.lock.thread_id;
  delete f.sessions[0].thread_id;
  delete f.sessions[0].claimed_at;
  delete f.sessions[0].last_seen_at;
  f.sessions[0].board_root = "/stale-workspace";
  const originalLock = JSON.stringify(f.lock);
  const repaired = f.run();
  assert.equal(repaired.status, "repaired");
  assert.deepEqual(repaired.repairs.map(({ type }) => type), ["normalized_session_binding_from_canonical_lock"]);
  assert.equal(repaired.repairs[0].previous_thread_id, null);
  assert.equal(repaired.repairs[0].thread_id, null);
  assert.equal(f.sessions[0].thread_id, null);
  assert.equal(f.sessions[0].claimed_at, f.lock.started_at_utc);
  assert.equal(f.sessions[0].last_seen_at, f.lock.started_at_utc);
  assert.equal(f.sessions[0].status, "active");
  assert.equal(f.writes, 1);
  assert.equal(JSON.stringify(f.lock), originalLock);
  assert.equal(f.run().status, "noop");
  assert.equal(f.writes, 1);
});

test("signed runtime-only reconcile tolerates reordered entries and session churn, but refuses changed durable contents", (t) => {
  withCoord678ProjectionFixture(({ board, paths }) => {
    const runtimePath = ".runtime/agent_sessions.json";
    const durablePlanPath = ".runtime/plans/TEST-123.json";
    const snapshot = [
      { path: durablePlanPath, exists: true, digest: "a".repeat(40) },
      { path: "board/tasks.json", exists: true, digest: "b".repeat(40) },
      { path: runtimePath, exists: true, digest: "c".repeat(40) },
    ];
    const provenance = { drift: [runtimePath], currentSnapshot: { files: snapshot }, expectedSnapshotDigest: "e".repeat(40) };
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    t.after(approval.cleanup);
    t.mock.method(console, "log", () => {});
    const options = { reason: "review runtime reconciliation", humanAdminOverride: "record verified recovery" };
    const verified = [];
    let adopted = 0;
    let changeDurablePlan = false;
    const recovery = createDoctorRecovery({
      readBoard: () => board,
      detectGovernanceProvenanceDrift: () => provenance,
      isRecoverableGovernanceDriftPath: (file) => file === runtimePath,
      resolveHumanAdminOverride: (_verb, opts) => ({ reason: opts.humanAdminOverride }),
      appendGovernanceEvent: (event) => {
        if (event.event === "approval.verified") verified.push(event);
        fs.mkdirSync(paths.RUNTIME_DIR, { recursive: true });
        fs.appendFileSync(path.join(paths.RUNTIME_DIR, "governance-events.ndjson"), `${JSON.stringify(event)}\n`);
      },
      withGovernanceMutation: (mutation, callback) => {
        assert.equal(mutation.validateAfterSnapshot, null, "recoverable runtime drift does not require an adoption packet");
        provenance.currentSnapshot = {
          files: [...snapshot].reverse().map((entry) => {
            if (entry.path === runtimePath) return { ...entry, digest: "d".repeat(40) };
            if (changeDurablePlan && entry.path === durablePlanPath) return { ...entry, digest: "f".repeat(40) };
            return entry;
          }),
        };
        callback();
        adopted += 1;
        assert.equal(mutation.details.approval_record, verified.at(-1).approval_record);
      },
    });

    withApprovalTestClient(path.resolve(__dirname, "../.."), approval.client(), () => {
      let subject;
      assert.throws(() => recovery.reconcileGovernance(null, options), (error) => {
        subject = /Subject digest: ([0-9a-f]{64})/.exec(error.message)?.[1];
        assert.ok(subject, error.message);
        return true;
      });
      const login = () => approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: subject });
      login();
      recovery.reconcileGovernance(null, options);
      assert.equal(adopted, 1);
      assert.equal(verified.length, 1);

      changeDurablePlan = true;
      login();
      assert.throws(() => recovery.reconcileGovernance(null, options), /approved provenance or packet state changed after human approval/);
      assert.equal(verified.length, 2, "the changed durable plan is refused after signature verification");
      assert.equal(adopted, 1);
    });
  });
});

test("doctor restores legacy session metadata without inventing an absent agent ID", (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = retainedIdleMirrorFixture({ now, age: 1_000 });
  delete f.agent.id;
  f.sessions[0].board_root = "/stale-workspace";
  const normalized = f.run();
  assert.equal(normalized.repairs[0].type, "normalized_session_binding_from_canonical_lock");
  assert.equal(f.sessions[0].agent_id, null);
  f.sessions.splice(0);
  const rebuilt = f.run();
  assert.equal(rebuilt.repairs[0].type, "created_session_binding_from_canonical_lock");
  assert.equal(f.sessions[0].agent_id, null);
  assert.equal(f.sessions[0].handle, f.lock.owner);
});
