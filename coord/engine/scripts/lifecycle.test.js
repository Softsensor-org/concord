// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";
const governanceCommands = require("./lifecycle.js").commands;

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();

const { __testing, GovernanceError, withScopedGovernanceTestContext, withGovernedSurfaceSandbox, withoutProcFs } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { state, DEFAULT_PATHS } = require("./governance-context.js");
const createLifecycleLockCommands = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-lock-commands.js"));

test("COORD-915: gate cleanup supplies current ticket ownership status to the process registry", () => {
  const rows = new Map([["ACTIVE", { Status: "doing" }], ["REVIEW", { Status: "review" }]]);
  const statusReads = [];
  const result = { reaped: [], retained: ["active-process"] };
  const commands = createLifecycleLockCommands({
    readBoard: () => ({ fixture: true }),
    rowsById: () => rows,
    isDoingStatus: (status) => { statusReads.push(status); return status === "doing"; },
    gateProcRegistry: { reapOrphans: ({ isTicketDoing, dryRun }) => {
      assert.equal(dryRun, true);
      assert.equal(isTicketDoing("ACTIVE"), true);
      assert.equal(isTicketDoing("REVIEW"), false);
      assert.equal(isTicketDoing("MISSING"), false);
      return result;
    } },
  });
  const savedLog = console.log;
  console.log = () => {};
  try {
    assert.equal(commands.reapGateProcs({ dryRun: true }), result);
    assert.deepEqual(statusReads, ["doing", "review"], "unknown tickets do not invent a status");
    result.reaped.push("finished-process");
    assert.deepEqual(commands.reapGateProcs({ dryRun: true }).reaped, ["finished-process"],
      "the command preserves the registry report when an orphan is eligible for cleanup");
  } finally {
    console.log = savedLog;
  }
});
const createPlanRecords = require("./plan-records.js");
const { escapeRegex } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const planRecordOwner = createPlanRecords({ escapeRegex });

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is a function DEFINED in lifecycle.js — the core
// orchestration module that owns plan/closeout-default builders, lock/worktree
// integrity helpers, the auto-claimed-stub reaper, autoSync orchestration, and
// the orchestrator/SLO report builders. These were facade unit tests in
// governance.test.js; they reach the same fully-wired `__testing` surface, so
// behavior is byte-identical — only the home moved to co-locate the deep
// coverage with the module it exercises. End-to-end lifecycle VERB flows
// (unstart / lock-abandon / land driven through executeCommand) deliberately
// stay in governance.test.js as facade/integration coverage.


// COORD-099: createCoordPaths default-derivation + the withDefaultProjectConfig
// Env helper relocated to paths.test.js (coord/paths.js is the owning module).

test("buildInitiateSummary explains the session primer and claim syntax", () => {
  const summary = __testing.buildInitiateSummary();
  assert.match(summary, /Governance Session Primer/);
  assert.match(summary, /claim --owner <handle\|simple-id>/);
  assert.match(summary, /resume <ticket-id>/);
  assert.match(summary, /Do not directly edit `coord\/board\/tasks\.json`/);
});

// COORD-295: the buildDefaultGovernancePlan repo-default / REPO_INTEGRATION_BRANCHES
// (COORD-006/007) tests and the ensurePlanStub canonical-record-seam tests moved to
// governance-plan-shape.test.js alongside the extracted plan-shape service.

// COORD-099: the GCV-4 / COORD-010 config-seam tests (createCoordPaths fixture
// derivation, normalizeProjectConfig / validateProjectConfig / loadProjectConfig
// / resolveProjectConfigPath, COORD_PROJECT_CONFIG override, absolute path
// handling) relocated to paths.test.js — every subject is defined in
// coord/paths.js. paths.test.js is matched by the same runner glob, so the
// COORD-010 config matrix continues to re-run them under both registries.

test("splitGovernanceProvenanceDrift downgrades runtime session drift to warnings while preserving blocking drift", () => {
  const split = __testing.splitGovernanceProvenanceDrift([
    ".runtime/agent_sessions.json",
    ".runtime/session-threads/a44.json",
    "board/tasks.json",
  ]);

  assert.deepEqual(split.blocking, ["board/tasks.json"]);
  assert.deepEqual(split.warnings, [".runtime/agent_sessions.json", ".runtime/session-threads/a44.json"]);
});

test("buildMergedButNotDoneReport surfaces merged PR tickets that have not reached done", () => {
  const board = {
    sections: [
      {
        rows: [
          { ID: "FE-089", Status: "review" },
          { ID: "FE-073", Status: "done" },
        ],
      },
    ],
  };
  const report = __testing.buildMergedButNotDoneReport(board, [
    {
      ticket: "FE-089",
      details: {
        external_side_effects: [
          {
            type: "github_pr_merge",
            pr_url: "https://github.com/example/repo/pull/10",
            merged_at: "2026-04-04T19:38:02Z",
          },
        ],
      },
    },
    {
      ticket: "FE-073",
      details: {
        external_side_effects: [
          {
            type: "github_pr_merge",
            pr_url: "https://github.com/example/repo/pull/8",
            merged_at: "2026-04-04T12:46:14Z",
          },
        ],
      },
    },
  ]);

  assert.deepEqual(report, [
    {
      ticket: "FE-089",
      merged_at: "2026-04-04T19:38:02Z",
      pr_url: "https://github.com/example/repo/pull/10",
      status: "review",
    },
  ]);
});

test("buildOrchestratorExceptionSloReport summarizes blocker counts, aging, drift stages, and merged-but-not-done tickets", () => {
  const board = {
    sections: [
      {
        rows: [
          { ID: "FE-089", Status: "review" },
          { ID: "MSRV-002", Status: "doing" },
        ],
      },
    ],
  };
  const rows = [
    {
      date: "2026-04-01",
      question: "Starting MSRV-002 exposed repo-state drift in `backend`.",
      resolved: "no",
      operational_type: "blocker",
      severity: "high",
      aging_bucket: "stale",
    },
    {
      date: "2026-04-04",
      question: "Governance drift observed while running move-review FE-017: QUESTIONS.md",
      resolved: "no",
      operational_type: "drift-note",
      severity: "medium",
      aging_bucket: "same-day",
    },
    {
      date: "2026-04-04",
      question: "Governance drift observed while running submit FE-089: board/tasks.json",
      resolved: "no",
      operational_type: "drift-note",
      severity: "medium",
      aging_bucket: "same-day",
    },
  ];
  const report = __testing.buildOrchestratorExceptionSloReport(board, rows, [
    {
      ticket: "FE-089",
      details: {
        external_side_effects: [
          {
            type: "github_pr_merge",
            pr_url: "https://github.com/example/repo/pull/10",
            merged_at: "2026-04-04T19:38:02Z",
          },
        ],
      },
    },
  ]);

  assert.equal(report.unresolved_total, 3);
  assert.equal(report.unresolved_blocker_count, 1);
  assert.deepEqual(report.unresolved_aging, { stale: 1, "same-day": 2 });
  assert.deepEqual(report.unresolved_by_severity, { high: 1, medium: 2 });
  assert.deepEqual(report.drift_counts_by_stage, { "move-review": 1, submit: 1 });
  assert.deepEqual(report.merged_but_not_done, [
    {
      ticket: "FE-089",
      merged_at: "2026-04-04T19:38:02Z",
      pr_url: "https://github.com/example/repo/pull/10",
      status: "review",
    },
  ]);
});

test("buildStartPlanBootstrapCommand recommends gov plan --seed", () => {
  // The bootstrap command is the canonical one-liner agents run when plan
  // state is missing. It seeds startup, traceability, and (for test/contract/
  // infra tickets) baseline scaffold values via gov plan --seed instead of
  // hand-formatted update-plan flags.
  const testTicket = __testing.buildStartPlanBootstrapCommand("DEBT-043", {
    ID: "DEBT-043",
    Repo: "B",
    Type: "test",
  });
  assert.equal(testTicket, "coord/scripts/gov plan DEBT-043 --seed");

  const coordTicket = __testing.buildStartPlanBootstrapCommand("DEBT-041", {
    ID: "DEBT-041",
    Repo: "X",
    Type: "feature",
  });
  assert.equal(coordTicket, "coord/scripts/gov plan DEBT-041 --seed");
});

// COORD-283: the normalizeTestingInfraAuditPath registry-prefix behavior test
// moved to testing-infra-audit.test.js alongside the extracted module.

// COORD-293: the refreshLockHead legacy-promote + corrupt-JSON lock tests moved
// to ticket-lock-service.test.js alongside the extracted ticket-lock service.

test("collectTicketWorktreeResidue only reports matching governed product worktrees", () => {
  const coordWorktreePath = path.join(process.cwd(), "coord", ".worktrees", "codexa04", "IMP-185");
  const residue = __testing.collectTicketWorktreeResidue("IMP-185", {
    B: [
      { path: `/tmp/${repoRegistryOwner.repoNameForCode("B")}/.worktrees/codexa04/IMP-185`, branch: "agent/codexa04-imp-185" },
      { path: `/tmp/${repoRegistryOwner.repoNameForCode("B")}/.worktrees/codexa04/IMP-999`, branch: "agent/codexa04-imp-999" },
      { path: coordWorktreePath, branch: "agent/codexa04-imp-185" },
    ],
    F: [
      { path: `/tmp/${repoRegistryOwner.repoNameForCode("F")}/.worktrees/codexa04/IMP-185`, branch: "agent/codexa04-imp-185" },
      { path: `/tmp/${repoRegistryOwner.repoNameForCode("F")}/dev`, branch: "dev" },
      { path: coordWorktreePath, branch: "agent/codexa04-imp-185" },
    ],
  });

  assert.deepEqual(
    residue,
    [
      {
        repoCode: "B",
        repoLabel: repoRegistryOwner.repoNameForCode("B"),
        path: `/tmp/${repoRegistryOwner.repoNameForCode("B")}/.worktrees/codexa04/IMP-185`,
        branch: "agent/codexa04-imp-185",
      },
      {
        repoCode: "F",
        repoLabel: repoRegistryOwner.repoNameForCode("F"),
        path: `/tmp/${repoRegistryOwner.repoNameForCode("F")}/.worktrees/codexa04/IMP-185`,
        branch: "agent/codexa04-imp-185",
      },
    ]
  );
});

test("assertCurrentTicketLockIntegrity rejects non-canonical current-ticket worktrees", () => {
  // COORD-010: redirect REPO_ROOTS to a real temp dir so the check is
  // registry-agnostic. getRepoRoot fails closed on a non-existent repo dir,
  // so under the config matrix the ambient `B -> services/api` (unprovisioned)
  // would mask the non-canonical-worktree assertion this test targets.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-lockintegrity-"));
  withScopedGovernanceTestContext({ REPO_ROOTS: { B: repoRoot } }, () => {
    assert.throws(
      () => __testing.assertCurrentTicketLockIntegrity(
        "IMP-237",
        { Repo: "B" },
        {
          worktree: "/tmp/not-governed/IMP-237",
          head: "abc123",
        }
      ),
      (error) => error instanceof GovernanceError && /non-canonical worktree path/i.test(error.message)
    );
  });
});

test("product lock integrity accepts only the repository's canonical ticket-worktree prefix", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-product-lock-root-"));
  const commands = createLifecycleLockCommands({
    COORD_DIR: repoRoot,
    ROOT_DIR: repoRoot,
    STATUS: { DOING: "doing" },
    fs,
    fail: (message) => { throw new GovernanceError(message); },
    isRepoBackedCode: (code) => code === "B",
    getRepoRoot: (code) => code === "B" ? repoRoot : null,
    safeResolveLockHead: () => "live-product-head",
  });
  try {
    assert.doesNotThrow(() => commands.assertCurrentTicketLockIntegrity("PRODUCT-644", { Repo: "B" }, {
      worktree: path.join(repoRoot, ".worktrees", "codexa01", "PRODUCT-644"),
      head: "live-product-head",
    }));
    assert.throws(() => commands.assertCurrentTicketLockIntegrity("PRODUCT-644", { Repo: "B" }, {
      worktree: path.join(repoRoot, ".worktrees-foreign", "codexa01", "PRODUCT-644"),
      head: "live-product-head",
    }), /non-canonical worktree path/);
    assert.throws(() => commands.assertCurrentTicketLockIntegrity("PRODUCT-644", { Repo: "B" }, {
      worktree: "",
      head: "live-product-head",
    }), /non-canonical worktree path/,
    "a malformed lock with no worktree path is rejected before resolving a Git head");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Repo X heartbeat refreshes lock.head through the shared resolver", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-heartbeat-head-"));
  const lockPath = path.join(tempDir, "COORD-644.lock");
  const worktree = path.join(tempDir, "registered-ticket-worktree");
  fs.mkdirSync(worktree);
  const row = { ID: "COORD-644", Repo: "X", Status: "doing", Owner: "codexa745" };
  fs.writeFileSync(lockPath, JSON.stringify({
    ticket: row.ID,
    repo: "coord",
    status: "doing",
    owner: row.Owner,
    worktree,
    head: "coord-no-git-head",
  }));
  const calls = [];
  const commands = createLifecycleLockCommands({
    COORD_DIR: tempDir,
    ROOT_DIR: tempDir,
    STATUS: { DOING: "doing" },
    fs,
    fail: (message) => { throw new GovernanceError(message); },
    inferTicketStatus: () => "doing",
    withGovernanceMutation: (_metadata, callback) => callback(),
    resolveTicketLockPath: () => lockPath,
    readJsonFileState: (file) => ({ exists: true, value: JSON.parse(fs.readFileSync(file, "utf8")), error: null }),
    normalizeLockIdentityReferences: (value) => value,
    readBoard: () => ({ sections: [{ rows: [row] }] }),
    getTicketRef: () => ({ row }),
    assertTicketMutationOwnership: () => ({ agent: { handle: row.Owner } }),
    repoCodeForLockRepoName: () => "X",
    isRepoBackedCode: () => false,
    safeResolveLockHead: () => "registered-worktree-head",
    resolveLockHead: (repoCode, worktree) => {
      calls.push({ repoCode, worktree });
      return "registered-worktree-head";
    },
    touchActiveSession: () => {},
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    commands.heartbeat(row.ID);
    assert.deepEqual(calls, [{ repoCode: "X", worktree }]);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).head, "registered-worktree-head");
    assert.throws(
      () => commands.assertCurrentTicketLockIntegrity(row.ID, row, {
        worktree,
        head: "coord-no-git-head",
      }),
      /does not match worktree HEAD registered-worktree-head/
    );
    assert.doesNotThrow(() => commands.assertCurrentTicketLockIntegrity(row.ID, row, {
      worktree,
      head: "registered-worktree-head",
    }));
  } finally {
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-644: lifecycle legacy-lock promotion uses the production repo-name and file-move bindings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-lifecycle-legacy-lock-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeLocks = path.join(runtimeDir, "locks");
  const legacyLocks = path.join(tempDir, "legacy-locks");
  const ticketId = "COORD-644-MOVE-FIXTURE";
  const legacyLock = path.join(legacyLocks, `${ticketId}.lock`);
  const runtimeLock = path.join(runtimeLocks, `${ticketId}.lock`);
  withScopedGovernanceTestContext({
    LOCKS_DIR: runtimeLocks,
    LEGACY_LOCKS_DIR: legacyLocks,
  }, () => {
    const original = {
    LOCKS_DIR: state.LOCKS_DIR,
    LEGACY_LOCKS_DIR: state.LEGACY_LOCKS_DIR,
  };
  fs.mkdirSync(legacyLocks, { recursive: true });
  fs.writeFileSync(legacyLock, JSON.stringify({
    ticket: ticketId,
    repo: "legacy-coord-label",
    worktree: path.join(tempDir, "no-git-worktree"),
    head: "stale-sentinel",
  }));
  state.LOCKS_DIR = runtimeLocks;
  state.LEGACY_LOCKS_DIR = legacyLocks;

  try {
    assert.equal(repoRegistryOwner.repoCodeForLockRepoName("coord"), "X",
      "the lifecycle binding maps the canonical coord repo label to Repo X");
    assert.equal(fs.existsSync(runtimeLock), false);
    __testing.refreshLockHead(ticketId);
    assert.equal(fs.existsSync(legacyLock), false, "the legacy source lock is moved out of the compatibility directory");
    assert.equal(fs.existsSync(runtimeLock), true, "refresh creates the canonical runtime lock path");
    assert.equal(JSON.parse(fs.readFileSync(runtimeLock, "utf8")).head, "coord-no-git-head",
      "the no-repository control-plane keeps its normative sentinel while promoting the lock");
  } finally {
    state.LOCKS_DIR = original.LOCKS_DIR;
    state.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-644: heartbeat refusal and Repo X integrity checks preserve the ticket head contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord644-heartbeat-boundaries-"));
  const lockPath = path.join(tempDir, "COORD-644.lock");
  const worktree = path.join(tempDir, "ticket-worktree");
  fs.mkdirSync(worktree);
  const row = { ID: "COORD-644", Repo: "X", Status: "doing", Owner: "codexa745" };
  let registeredTicket = true;
  let resolvedRepoCode = null;
  const resolvedHeads = [];
  const commands = createLifecycleLockCommands({
    COORD_DIR: tempDir,
    ROOT_DIR: tempDir,
    STATUS: { DOING: "doing" },
    fs,
    fail: (message) => { throw new GovernanceError(message); },
    inferTicketStatus: () => "doing",
    withGovernanceMutation: (_metadata, callback) => callback(),
    resolveTicketLockPath: () => lockPath,
    readJsonFileState: (file) => ({ exists: true, value: JSON.parse(fs.readFileSync(file, "utf8")), error: null }),
    normalizeLockIdentityReferences: (value) => value,
    readBoard: () => ({ sections: [{ rows: [row] }] }),
    getTicketRef: (_board, ticketId) => registeredTicket && ticketId === row.ID ? { row } : null,
    assertTicketMutationOwnership: () => ({ agent: { handle: row.Owner } }),
    repoCodeForLockRepoName: () => resolvedRepoCode,
    isRepoBackedCode: () => false,
    safeResolveLockHead: (_repo, _worktree) => "live-ticket-head",
    resolveLockHead: (repoCode, pathValue) => {
      resolvedHeads.push({ repoCode, path: pathValue });
      return "live-ticket-head";
    },
    touchActiveSession: () => {},
  });
  fs.writeFileSync(lockPath, JSON.stringify({
    ticket: row.ID,
    repo: "legacy-coord-label",
    status: "doing",
    owner: row.Owner,
    worktree,
    head: "coord-no-git-head",
  }));
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.throws(() => commands.heartbeat(""), /heartbeat requires <ticket-id>/);
    registeredTicket = false;
    assert.throws(() => commands.heartbeat(row.ID), /Unknown ticket/);
    registeredTicket = true;
    commands.heartbeat(row.ID);
    assert.deepEqual(resolvedHeads, [{ repoCode: "X", path: worktree }],
      "an unmapped legacy lock label falls back to the board's Repo-X code for HEAD refresh");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).head, "live-ticket-head");

    assert.doesNotThrow(() => commands.assertCurrentTicketLockIntegrity(row.ID, row, null),
      "a ticket without a canonical lock has no lock-head integrity assertion");
    assert.doesNotThrow(() => commands.assertCurrentTicketLockIntegrity(row.ID, { ...row, Repo: "unknown" }, {
      worktree,
      head: "irrelevant-for-non-git-repo",
    }), "non-Git repo codes do not acquire a Git HEAD requirement");
    const noHead = createLifecycleLockCommands({
      isRepoBackedCode: () => false,
      fail: (message) => { throw new GovernanceError(message); },
      safeResolveLockHead: () => null,
    });
    assert.throws(() => noHead.assertCurrentTicketLockIntegrity(row.ID, row, { worktree, head: "old" }), /without a readable git HEAD/);
    assert.throws(() => commands.assertCurrentTicketLockIntegrity(row.ID, row, { worktree, head: "old" }), /does not match worktree HEAD live-ticket-head/);
    assert.doesNotThrow(() => commands.assertCurrentTicketLockIntegrity(row.ID, row, { worktree, head: "live-ticket-head" }));
  } finally {
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-689: reaping preserves recently active auto-claimed sessions between tickets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord003-reap-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "IMP-200", Status: "doing", Owner: "claudea11" },
        ],
      },
    ],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
    { id: "a13", handle: "claudea13", provider: "anthropic", status: "active", aliases: [] },
    { id: "a14", handle: "claudea14", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    // Owner of a doing ticket — must not be reaped.
    {
      session_id: "a11-doing", agent_id: "a11", handle: "claudea11",
      board_path: boardPath, thread_id: "thread-doing",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: true,
    },
    // Idle auto-claimed stub on the current thread — must be protected.
    {
      session_id: "a12-current", agent_id: "a12", handle: "claudea12",
      board_path: boardPath, thread_id: "thread-current",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: true,
    },
    // Idle auto-claimed stub on another thread — should be reaped.
    {
      session_id: "a13-orphan", agent_id: "a13", handle: "claudea13",
      board_path: boardPath, thread_id: "thread-orphan",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: true,
    },
    // Idle session that was explicitly claimed (auto_claimed=false) — must not be reaped.
    {
      session_id: "a14-manual", agent_id: "a14", handle: "claudea14",
      board_path: boardPath, thread_id: "thread-manual",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: false,
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
    BOARD_PATH: state.BOARD_PATH,
    AGENTS_PATH: state.AGENTS_PATH,
    AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
  };
  state.BOARD_PATH = boardPath;
  state.AGENTS_PATH = agentsPath;
  state.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({
      provider: "anthropic",
      protectedThread: "thread-current",
    });
    assert.equal(result.released.length, 0, "recent activity protects every session");

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const byId = Object.fromEntries(after.map((s) => [s.session_id, s]));
    assert.equal(byId["a11-doing"].status, "active", "owner of a doing ticket must stay active");
    assert.equal(byId["a12-current"].status, "active", "current-thread session must be protected");
    assert.equal(byId["a13-orphan"].status, "active", "between-ticket activity must be protected");
    assert.equal(byId["a14-manual"].status, "active", "manually-claimed session must not be reaped");
  } finally {
    state.BOARD_PATH = original.BOARD_PATH;
    state.AGENTS_PATH = original.AGENTS_PATH;
    state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
  });
});

test("reapIdleAutoClaimedProviderStubs releases stale manual claims past the threshold (COORD-010)", () => {
  // The implicit 4h AGENT_SESSION_IDLE_MS auto-expires sessions on read, so
  // stale ages used here must live below 4h to remain "active" when the
  // reaper looks at them. Use a 1h reaper threshold and a 2h stale fixture.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord010-stale-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const recentIso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{ rows: [] }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a21", handle: "claudea21", provider: "anthropic", status: "active", aliases: [] },
    { id: "a22", handle: "claudea22", provider: "anthropic", status: "active", aliases: [] },
    { id: "a23", handle: "claudea23", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a21-stale-manual", agent_id: "a21", handle: "claudea21",
      board_path: boardPath, thread_id: "thread-stale-manual",
      claimed_at: staleIso, last_seen_at: staleIso, status: "active", auto_claimed: false,
    },
    {
      session_id: "a22-recent-manual", agent_id: "a22", handle: "claudea22",
      board_path: boardPath, thread_id: "thread-recent-manual",
      claimed_at: recentIso, last_seen_at: recentIso, status: "active", auto_claimed: false,
    },
    {
      session_id: "a23-stale-auto", agent_id: "a23", handle: "claudea23",
      board_path: boardPath, thread_id: "thread-stale-auto",
      claimed_at: nowIso, last_seen_at: nowIso, status: "active", auto_claimed: true,
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
    BOARD_PATH: state.BOARD_PATH,
    AGENTS_PATH: state.AGENTS_PATH,
    AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
  };
  state.BOARD_PATH = boardPath;
  state.AGENTS_PATH = agentsPath;
  state.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({
      provider: "anthropic",
      includeManualStaleAfterMs: 60 * 60 * 1000,
    });
    const releasedIds = result.released.map((entry) => entry.session_id).sort();
    assert.deepEqual(
      releasedIds,
      ["a21-stale-manual"],
      "only the stale manual claim passes the configured threshold"
    );

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const byId = Object.fromEntries(after.map((s) => [s.session_id, s]));
    assert.equal(byId["a21-stale-manual"].status, "released");
    assert.equal(byId["a22-recent-manual"].status, "active", "recent manual claim must be protected");
    assert.equal(byId["a23-stale-auto"].status, "active");
  } finally {
    state.BOARD_PATH = original.BOARD_PATH;
    state.AGENTS_PATH = original.AGENTS_PATH;
    state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
  });
});

test("reapIdleAutoClaimedProviderStubs without includeManualStaleAfterMs leaves manual claims alone (COORD-010)", () => {
  // Backwards-compat guard: the default behavior (no option set) must continue
  // to skip manual claims so callers that didn't opt into the new behavior
  // don't suddenly start reaping live manual sessions. Stay below the 4h
  // implicit auto-expire so the session arrives at the reaper as "active".
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord010-default-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date();
  const veryStaleIso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{ rows: [] }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a31", handle: "claudea31", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a31-very-stale-manual", agent_id: "a31", handle: "claudea31",
      board_path: boardPath, thread_id: "thread-default",
      claimed_at: veryStaleIso, last_seen_at: veryStaleIso, status: "active", auto_claimed: false,
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
    BOARD_PATH: state.BOARD_PATH,
    AGENTS_PATH: state.AGENTS_PATH,
    AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
  };
  state.BOARD_PATH = boardPath;
  state.AGENTS_PATH = agentsPath;
  state.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({ provider: "anthropic" });
    assert.equal(result.released.length, 0, "default behavior must not reap manual claims regardless of age");

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(after[0].status, "active");
  } finally {
    state.BOARD_PATH = original.BOARD_PATH;
    state.AGENTS_PATH = original.AGENTS_PATH;
    state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
  });
});

test("public doctor --fix normalizes stale sessions and preserves live sessions through lifecycle wiring", () => {
  withGovernedSurfaceSandbox(({ boardPath, agentsPath, sessionsPath }) => {
    const nowMs = Date.now();
    const staleAt = new Date(nowMs - 5 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date(nowMs - 5 * 60 * 1000).toISOString();
    fs.writeFileSync(agentsPath, `${JSON.stringify([
      { id: "a91", handle: "claudea91", provider: "anthropic", status: "active", aliases: [] },
      { id: "a92", handle: "claudea92", provider: "anthropic", status: "active", aliases: [] },
      { id: "a93", handle: "claudea93", provider: "anthropic", status: "active", aliases: [] },
    ], null, 2)}\n`);
    fs.writeFileSync(sessionsPath, `${JSON.stringify([
      {
        session_id: "a91-stale-auto", agent_id: "a91", handle: "claudea91",
        board_path: boardPath, thread_id: null,
        claimed_at: staleAt, last_seen_at: staleAt, status: "active", auto_claimed: true,
      },
      {
        session_id: "a92-recent-auto", agent_id: "a92", handle: "claudea92",
        board_path: boardPath, thread_id: "recent-doctor-session",
        claimed_at: recentAt, last_seen_at: recentAt, status: "active", auto_claimed: true,
      },
      {
        session_id: "a93-live-manual", agent_id: "a93", handle: "claudea93",
        board_path: boardPath, thread_id: "manual-doctor-session",
        claimed_at: recentAt, last_seen_at: recentAt, status: "active", auto_claimed: false,
      },
    ], null, 2)}\n`);

    __testing.ensureGovernanceJournalBaseline("COORD-825: initialize scoped doctor fixture");
    const originalLog = console.log;
    const output = [];
    try {
      console.log = (...values) => output.push(values.join(" "));
      governanceCommands.doctor({ fix: true });
    } finally {
      console.log = originalLog;
    }

    const result = JSON.parse(output.join("\n"));
    assert.equal(result.status, "noop");
    assert.deepEqual(result.repairs, [], "session normalization alone does not claim a doctor repair");

    const byId = Object.fromEntries(
      JSON.parse(fs.readFileSync(sessionsPath, "utf8")).map((session) => [session.session_id, session])
    );
    assert.equal(byId["a91-stale-auto"].status, "expired");
    assert.ok(Date.parse(byId["a91-stale-auto"].released_at), "normalization persists the expiration timestamp");
    assert.equal(Object.hasOwn(byId["a91-stale-auto"], "release_reason"), false,
      "read normalization records expiration without claiming an idle-expiry reaper release");
    assert.equal(byId["a92-recent-auto"].status, "active", "recent auto-claimed session remains active");
    assert.equal(byId["a93-live-manual"].status, "active", "live manually claimed session remains active");
  }, { isolateBoardValidation: true });
});

test("public agent-claim reaches the lifecycle reaper before refusing an unstable competing provider session", () => {
  withGovernedSurfaceSandbox(({ boardPath, agentsPath, sessionsPath }) => {
    const now = new Date().toISOString();
    fs.writeFileSync(agentsPath, `${JSON.stringify([
      { id: "a91", handle: "claudea91", provider: "anthropic", status: "active", aliases: [] },
      { id: "a92", handle: "claudea92", provider: "anthropic", status: "active", aliases: [] },
    ], null, 2)}\n`);
    const existingSession = {
      session_id: "a91-existing-provider-session",
      agent_id: "a91",
      handle: "claudea91",
      session_label: "test:existing-provider-session",
      host: "test-host",
      cwd: process.cwd(),
      board_path: boardPath,
      board_root: path.dirname(boardPath),
      thread_id: "existing-provider-thread",
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: true,
    };
    fs.writeFileSync(sessionsPath, `${JSON.stringify([existingSession], null, 2)}\n`);
    __testing.ensureGovernanceJournalBaseline("COORD-825: initialize scoped claim fixture");

    const identityEnvKeys = [
      "CLAUDECODE", "COORD_PROVIDER", "COORD_PROVIDER_SESSION_ID", "COORD_SESSION_ID", "COORD_INSTANCE_ID",
      "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID",
      "GOVERNANCE_MCP_THREAD_ID", "AGENT_THREAD_ID", "TERM_SESSION_ID", "TMUX_PANE", "WEZTERM_PANE",
      "WT_SESSION", "KITTY_WINDOW_ID", "TAB_ID",
    ];
    const originalEnv = Object.fromEntries(identityEnvKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of identityEnvKeys) delete process.env[key];
      // Provider detection succeeds, while withoutProcFs removes the host-session
      // fallback so getOrCreateSessionToken reaches the lifecycle-wired reaper.
      process.env.CLAUDECODE = "1";
      withoutProcFs(() => {
        assert.throws(
          () => governanceCommands.claimAgent("claudea92", {}),
          /Provider anthropic already has active session a91-existing-provider-session for claudea91 and this runtime has no stable session identity/
        );
      });
    } finally {
      for (const key of identityEnvKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    }

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(after.length, 1, "the failed unstable claim must not replace or append a provider session");
    assert.equal(after[0].session_id, existingSession.session_id);
    assert.equal(after[0].status, "active", "the recent competing session remains active");
    assert.equal(after[0].auto_claimed, true);
    assert.equal(after[0].thread_id, existingSession.thread_id);
  }, { isolateBoardValidation: true });
});

test("buildStartOwnershipRaceMessage explains when another agent already won the ticket", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-start-race-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a49", handle: "geminia49", provider: "google", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a49-live",
      agent_id: "a49",
      handle: "geminia49",
      board_path: state.BOARD_PATH,
      thread_id: "gemini-thread-live",
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: "active",
    },
  ], null, 2));

  const originalAgentsPath = state.AGENTS_PATH;
  const originalSessionsPath = state.AGENT_SESSIONS_PATH;
  state.AGENTS_PATH = agentsPath;
  state.AGENT_SESSIONS_PATH = sessionsPath;
  try {
    const message = __testing.buildStartOwnershipRaceMessage("FE-100", {
      Status: "doing",
      Owner: "geminia49",
    });
    assert.match(message, /already doing under geminia49/);
    assert.match(message, /active_session=a49-live/);
    assert.match(message, /explain FE-100/);
  } finally {
    state.AGENTS_PATH = originalAgentsPath;
    state.AGENT_SESSIONS_PATH = originalSessionsPath;
  }
});

test("recentEvents defaults to a compact journal view and materializes snapshots only with --full", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-recent-compact-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshot = {
    recorded_at: "2026-03-30T13:05:00.000Z",
    digest: "abc123snapshotdigest",
    files: [],
  };
  const event = {
    ts: "2026-03-30T13:05:00.000Z",
    command: "land",
    ticket: "IMP-500",
    before_status: "review",
    after_status: "done",
    identity: null,
    result: "failed",
    details: {
      external_side_effects: [
        {
          type: "github_pr_merge",
          pr_url: "https://github.com/example/repo/pull/7",
          method: "squash",
        },
      ],
    },
    changed_paths: ["board/tasks.json"],
    snapshot_digest: snapshot.digest,
  };
  const originalLog = console.log;
  withScopedGovernanceTestContext({
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: snapshotsDir,
  }, () => {
    const original = {
    GOVERNANCE_EVENT_LOG_PATH: state.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: state.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: state.GOVERNANCE_SNAPSHOTS_DIR,
  };

  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotsDir, `${snapshot.digest}.json`), JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(snapshotPath, JSON.stringify({ digest: snapshot.digest }, null, 2), "utf8");
  fs.writeFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");

  state.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  state.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  state.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;

  try {
    const outputs = [];
    console.log = (value) => outputs.push(value);
    governanceCommands.recentEvents(null, { limit: 1 });
    const compactPayload = JSON.parse(outputs.pop());
    assert.equal(compactPayload.full, false);
    assert.equal(compactPayload.events[0].snapshot, undefined);
    assert.equal(compactPayload.events[0].snapshot_digest, snapshot.digest);
    assert.equal(compactPayload.events[0].changed_path_count, 1);

    governanceCommands.recentEvents(null, { limit: 1, full: true });
    const fullPayload = JSON.parse(outputs.pop());
    assert.equal(fullPayload.full, true);
    assert.equal(fullPayload.events[0].snapshot.digest, snapshot.digest);

    const { snapshot_digest, ...legacyEvent } = event;
    fs.writeFileSync(eventLogPath, `${JSON.stringify({ ...legacyEvent, snapshot })}\n`, "utf8");
    governanceCommands.recentEvents(null, { limit: 1 });
    const legacyCompact = JSON.parse(outputs.pop());
    assert.equal(legacyCompact.events[0].snapshot_digest, snapshot_digest);
    assert.equal(legacyCompact.events[0].snapshot, undefined);
  } finally {
    console.log = originalLog;
    state.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    state.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    state.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
  }
  });
});

// COORD-295: the two ensurePlanStub tests (stale-stub no-overwrite + scaffold-record
// seeding) moved to governance-plan-shape.test.js with the extracted service.

test("appendReviewFollowupPlan seeds a canonical repair scaffold and compatibility block", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-review-scaffold-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");

  withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.appendReviewFollowupPlan("IMP-200", "IMP-200-F2", "Repair stale review evidence", "X", "codexa02", 2);

    const record = JSON.parse(fs.readFileSync(path.join(recordsDir, "IMP-200.json"), "utf8"));
    const planRaw = fs.readFileSync(planPath, "utf8");

    assert.equal(record.review_round, 2);
    assert.deepEqual(record.prior_findings, ["IMP-200-F2 — Repair stale review evidence"]);
    assert.deepEqual(record.change_summary, ["Address review return finding IMP-200-F2."]);
    assert.equal(record.self_review_cycles.length, 3);
    assert.match(planRaw, /IMP-200-F2 — Repair stale review evidence/);
    assert.match(planRaw, /Address review return finding IMP-200-F2\./);
  });
});

test("appendReviewFollowupPlan preserves canonical evidence while resetting only the fresh review-cycle scaffold", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-review-rounds-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, `## IMP-200 — 2026-03-29T10:00:00.000Z

- Startup checklist:
  - completed
- Traceability gate:
  - verified
- Review round:
  - 1
- Change summary:
  - Original implementation.
`, "utf8");
  fs.writeFileSync(path.join(recordsDir, "IMP-200.json"), JSON.stringify({
    schema_version: 1,
    ticket_id: "IMP-200",
    markdown_heading: "## IMP-200 — 2026-03-29T10:00:00.000Z",
    startup_checklist: ["completed"],
    traceability_gate: ["verified"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: not-required"],
    prior_findings: [],
    intended_files: ["coord/scripts/governance.js"],
    change_summary: ["Original implementation."],
    verification_commands: ["node --test coord/scripts/governance.test.js"],
    critical_invariants: ["Original invariant."],
    requirement_closure: ["Ticket ask: original implementation", "Implemented: original implementation", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    feature_proof: ["path:coord/scripts/governance.js"],
    repo_gates: ["node --test coord/scripts/governance.test.js"],
    self_review_cycles: [
      {
        cycle: 1,
        total: 3,
        lens: "contract/state invariants",
        diff: "original",
        risks: ["state drift", "parser mismatch"],
        findings: "none",
        verification: "node --test coord/scripts/governance.test.js",
        verdict: "pass",
        raw: "lens=contract/state invariants; diff=original; risks=state drift, parser mismatch; findings=none; verification=node --test coord/scripts/governance.test.js; verdict=pass",
      },
    ],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-29T10:00:00.000Z",
  }, null, 2), "utf8");

  withScopedGovernanceTestContext({ PLAN_PATH: planPath, PLAN_RECORDS_DIR: recordsDir }, () => {
    __testing.appendReviewFollowupPlan("IMP-200", "IMP-200-F2", "Repair stale review evidence", "X", "codexa02", 2);

    const record = JSON.parse(fs.readFileSync(path.join(recordsDir, "IMP-200.json"), "utf8"));
    const blocks = planRecordOwner.extractPlanBlocks(fs.readFileSync(planPath, "utf8"), "IMP-200");

    assert.equal(record.review_round, 2);
    assert.deepEqual(record.prior_findings, ["IMP-200-F2 — Repair stale review evidence"]);
    assert.deepEqual(record.critical_invariants, ["Original invariant."]);
    assert.deepEqual(record.requirement_closure, ["Ticket ask: original implementation", "Implemented: original implementation", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"]);
    assert.deepEqual(record.feature_proof, ["path:coord/scripts/governance.js"]);
    assert.deepEqual(record.repo_gates, ["node --test coord/scripts/governance.test.js"]);
    assert.equal(record.self_review_cycles.length, 3);
    assert.match(record.self_review_cycles[0].lens, /TODO contract\/state invariants/);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /Original implementation\./);
    assert.match(blocks[0], /Address review return finding IMP-200-F2\./);
  });
});

test("COORD-915: canonical gate recording refuses invalid evidence before any plan mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord915-gate-recording-"));
  const boardPath = path.join(root, "tasks.json");
  const manifestPath = path.join(root, "manifest.json");
  const boardText = JSON.stringify({ metadata: {}, sections: [] });
  fs.writeFileSync(boardPath, boardText);
  fs.writeFileSync(manifestPath, "{}");
  try {
    withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
      assert.throws(() => governanceCommands.addRepoGateCommand("MISSING-915", {
        selectionManifest: manifestPath, base: "dev",
      }), /add-repo-gate refusing the selected-suite evidence:.*manifest invalid/s);
    });
    assert.equal(fs.readFileSync(boardPath, "utf8"), boardText);
    const knownBoardText = JSON.stringify({ metadata: {}, sections: [{ rows: [{ ID: "COORD-915", Repo: "X", Status: "todo", Owner: "unassigned" }] }] });
    fs.writeFileSync(boardPath, knownBoardText);
    withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
      assert.throws(() => governanceCommands.addRepoGateCommand("COORD-915", {
        selectionManifest: manifestPath, base: "dev",
      }), /add-repo-gate refusing the selected-suite evidence:.*manifest invalid/s);
    });
    assert.equal(fs.readFileSync(boardPath, "utf8"), knownBoardText);
    assert.deepEqual(fs.readdirSync(root).sort(), ["manifest.json", "tasks.json"],
      "invalid evidence creates no plan record or other state");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-915: lifecycle sync rejects an empty canonical commit through its wired failure boundary", () => {
  assert.throws(
    () => require("./lifecycle.js").__testing.commitCanonicalDelta([]),
    /commitCanonicalDelta requires a non-empty delta list/,
  );
});

test("production PR view queries the configured product repository and ticket branch", (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord-production-pr-view-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const { gitFixture } = require("./test-git-fixture.js");
  const landingGh = require("./landing-gh.js");
  gitFixture(repoRoot, ["init", "-q", "-b", "dev"]);
  const ticket = "TEST-839";
  const branch = "agent/codexa11-test-839-fixture";
  const prs = [{ number: 71, url: "https://github.com/example/product/pull/71", headRefName: branch }];
  withGovernedSurfaceSandbox(({ boardPath }) => {
    withScopedGovernanceTestContext({ REPO_ROOTS: { B: repoRoot } }, () => {
      const board = JSON.stringify({ sections: [{ rows: [{ ID: ticket, Repo: "B", Status: "review" }] }], pr_index: {} });
      fs.writeFileSync(boardPath, board);
      const calls = [];
      landingGh.setRunGhForTesting((cwd, args) => {
        calls.push({ cwd, args });
        return JSON.stringify(prs);
      });
      const savedLog = console.log;
      const output = [];
      console.log = (line) => output.push(line);
      try {
        governanceCommands.prView(ticket, { branch });
      } finally {
        console.log = savedLog;
        landingGh.resetRunGhForTesting();
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, repoRoot);
      assert.deepEqual(calls[0].args.slice(0, 4), ["pr", "list", "--head", branch]);
      const result = JSON.parse(output.join("\n"));
      assert.equal(result.branch, branch);
      assert.equal(result.repo_root, repoRoot);
      assert.deepEqual(result.prs, prs);
      assert.equal(fs.readFileSync(boardPath, "utf8"), board);
    });
  });
});

test("owner lease evidence remains visible in the read-only lifecycle explanation", () => {
  withGovernedSurfaceSandbox(({ boardPath, locksDir, agentsPath, sessionsPath, logPath }) => {
    const ticket = "TEST-839";
    const owner = "codexa11";
    const board = JSON.stringify({ sections: [{ rows: [{
      ID: ticket, Repo: "X", Status: "doing", Owner: owner, Description: "Explain verified owner evidence",
    }] }] });
    fs.writeFileSync(boardPath, board);
    fs.writeFileSync(path.join(locksDir, ticket + ".lock"), JSON.stringify({
      ticket, owner, status: "doing", session_id: "active-other", branch: "agent/codexa11-test-839",
    }));
    fs.writeFileSync(agentsPath, JSON.stringify([{ id: "a11", handle: owner, provider: "openai", status: "active", aliases: [] }]));
    fs.writeFileSync(sessionsPath, JSON.stringify([{
      handle: owner, board_path: boardPath, session_id: "active-other", thread_id: "other-thread", status: "active",
    }]));
    __testing.ensureGovernanceJournalBaseline("seed scoped lifecycle lease evidence");
    const event = { ts: "2026-11-18T12:00:00.000Z", command: "claim-handoff", ticket,
      before_status: "doing", after_status: "doing", result: "succeeded", changed_paths: [],
      details: { owner, session_id: "active-other" } };
    __testing.appendGovernanceEvent(event);
    const before = fs.readFileSync(logPath, "utf8");
    const savedLog = console.log;
    const output = [];
    console.log = (line) => output.push(line);
    try {
      governanceCommands.explainTicket(ticket);
    } finally {
      console.log = savedLog;
    }
    const report = JSON.parse(output.join("\n"));
    const lease = report.active_same_owner_other_thread;
    assert.equal(lease.present, true, JSON.stringify({ lock: report.lock, lease }));
    assert.deepEqual(lease.active_owner_sessions.map((session) => session.session_id), ["active-other"]);
    assert.equal(lease.recent_owner_lease_evidence.command, event.command);
    assert.deepEqual(lease.recent_owner_lease_evidence.details, event.details);
    assert.equal(fs.readFileSync(boardPath, "utf8"), board);
    assert.equal(fs.readFileSync(logPath, "utf8"), before);
  });
});
