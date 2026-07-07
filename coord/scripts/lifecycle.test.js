// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __testing, GovernanceError } = require("./governance-test-utils.js");

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
      { path: `/tmp/${__testing.repoNameForCode("B")}/.worktrees/codexa04/IMP-185`, branch: "agent/codexa04-imp-185" },
      { path: `/tmp/${__testing.repoNameForCode("B")}/.worktrees/codexa04/IMP-999`, branch: "agent/codexa04-imp-999" },
      { path: coordWorktreePath, branch: "agent/codexa04-imp-185" },
    ],
    F: [
      { path: `/tmp/${__testing.repoNameForCode("F")}/.worktrees/codexa04/IMP-185`, branch: "agent/codexa04-imp-185" },
      { path: `/tmp/${__testing.repoNameForCode("F")}/dev`, branch: "dev" },
      { path: coordWorktreePath, branch: "agent/codexa04-imp-185" },
    ],
  });

  assert.deepEqual(
    residue,
    [
      {
        repoCode: "B",
        repoLabel: __testing.repoNameForCode("B"),
        path: `/tmp/${__testing.repoNameForCode("B")}/.worktrees/codexa04/IMP-185`,
        branch: "agent/codexa04-imp-185",
      },
      {
        repoCode: "F",
        repoLabel: __testing.repoNameForCode("F"),
        path: `/tmp/${__testing.repoNameForCode("F")}/.worktrees/codexa04/IMP-185`,
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
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-lockintegrity-"));
  try {
    __testing.paths.REPO_ROOTS = { B: repoRoot };
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
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
  }
});

test("reapIdleAutoClaimedProviderStubs releases auto-claimed stubs without doing tickets (COORD-003)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-coord003-reap-"));
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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({
      provider: "anthropic",
      protectedThread: "thread-current",
    });
    assert.equal(result.released.length, 1, "exactly one orphan stub should be released");
    assert.equal(result.released[0].session_id, "a13-orphan");

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const byId = Object.fromEntries(after.map((s) => [s.session_id, s]));
    assert.equal(byId["a11-doing"].status, "active", "owner of a doing ticket must stay active");
    assert.equal(byId["a12-current"].status, "active", "current-thread session must be protected");
    assert.equal(byId["a13-orphan"].status, "released", "orphan auto-claimed stub must be released");
    assert.equal(byId["a14-manual"].status, "active", "manually-claimed session must not be reaped");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
});

test("reapIdleAutoClaimedProviderStubs releases stale manual claims past the threshold (COORD-010)", () => {
  // The implicit 4h AGENT_SESSION_IDLE_MS auto-expires sessions on read, so
  // stale ages used here must live below 4h to remain "active" when the
  // reaper looks at them. Use a 1h reaper threshold and a 2h stale fixture.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-coord010-stale-"));
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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({
      provider: "anthropic",
      includeManualStaleAfterMs: 60 * 60 * 1000,
    });
    const releasedIds = result.released.map((entry) => entry.session_id).sort();
    assert.deepEqual(
      releasedIds,
      ["a21-stale-manual", "a23-stale-auto"],
      "stale manual claim and auto-claimed stub must both be released; recent manual claim must not"
    );

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const byId = Object.fromEntries(after.map((s) => [s.session_id, s]));
    assert.equal(byId["a21-stale-manual"].status, "released");
    assert.equal(byId["a22-recent-manual"].status, "active", "recent manual claim must be protected");
    assert.equal(byId["a23-stale-auto"].status, "released");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
});

test("reapIdleAutoClaimedProviderStubs without includeManualStaleAfterMs leaves manual claims alone (COORD-010)", () => {
  // Backwards-compat guard: the default behavior (no option set) must continue
  // to skip manual claims so callers that didn't opt into the new behavior
  // don't suddenly start reaping live manual sessions. Stay below the 4h
  // implicit auto-expire so the session arrives at the reaper as "active".
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-coord010-default-"));
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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;

  try {
    const result = __testing.reapIdleAutoClaimedProviderStubs({ provider: "anthropic" });
    assert.equal(result.released.length, 0, "default behavior must not reap manual claims regardless of age");

    const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(after[0].status, "active");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
  }
});

test("buildStartOwnershipRaceMessage explains when another agent already won the ticket", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-start-race-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "gemini-thread-live",
      claimed_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: "active",
    },
  ], null, 2));

  const originalAgentsPath = __testing.paths.AGENTS_PATH;
  const originalSessionsPath = __testing.paths.AGENT_SESSIONS_PATH;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  try {
    const message = __testing.buildStartOwnershipRaceMessage("FE-100", {
      Status: "doing",
      Owner: "geminia49",
    });
    assert.match(message, /already doing under geminia49/);
    assert.match(message, /active_session=a49-live/);
    assert.match(message, /explain FE-100/);
  } finally {
    __testing.paths.AGENTS_PATH = originalAgentsPath;
    __testing.paths.AGENT_SESSIONS_PATH = originalSessionsPath;
  }
});

test("recentEvents defaults to a compact journal view and materializes snapshots only with --full", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-recent-compact-"));
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
  const original = {
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
  };

  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotsDir, `${snapshot.digest}.json`), JSON.stringify(snapshot, null, 2), "utf8");
  fs.writeFileSync(snapshotPath, JSON.stringify({ digest: snapshot.digest }, null, 2), "utf8");
  fs.writeFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");

  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;

  try {
    const outputs = [];
    console.log = (value) => outputs.push(value);
    __testing.recentEvents(null, { limit: 1 });
    const compactPayload = JSON.parse(outputs.pop());
    assert.equal(compactPayload.full, false);
    assert.equal(compactPayload.events[0].snapshot, undefined);
    assert.equal(compactPayload.events[0].snapshot_digest, snapshot.digest);
    assert.equal(compactPayload.events[0].changed_path_count, 1);

    __testing.recentEvents(null, { limit: 1, full: true });
    const fullPayload = JSON.parse(outputs.pop());
    assert.equal(fullPayload.full, true);
    assert.equal(fullPayload.events[0].snapshot.digest, snapshot.digest);
  } finally {
    console.log = originalLog;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
  }
});

// COORD-295: the two ensurePlanStub tests (stale-stub no-overwrite + scaffold-record
// seeding) moved to governance-plan-shape.test.js with the extracted service.

test("appendReviewFollowupPlan seeds a canonical repair scaffold and compatibility block", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-review-scaffold-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.appendReviewFollowupPlan("IMP-200", "IMP-200-F2", "Repair stale review evidence", "X", "codexa02", 2);

    const record = __testing.readPlanRecord("IMP-200", { recordsDir });
    const planRaw = fs.readFileSync(planPath, "utf8");

    assert.equal(record.review_round, 2);
    assert.deepEqual(record.prior_findings, ["IMP-200-F2 — Repair stale review evidence"]);
    assert.deepEqual(record.change_summary, ["Address review return finding IMP-200-F2."]);
    assert.equal(record.self_review_cycles.length, 3);
    assert.match(planRaw, /IMP-200-F2 — Repair stale review evidence/);
    assert.match(planRaw, /Address review return finding IMP-200-F2\./);
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});

test("appendReviewFollowupPlan preserves canonical evidence while resetting only the fresh review-cycle scaffold", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-review-rounds-"));
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

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.appendReviewFollowupPlan("IMP-200", "IMP-200-F2", "Repair stale review evidence", "X", "codexa02", 2);

    const record = __testing.readPlanRecord("IMP-200", { recordsDir });
    const blocks = __testing.extractPlanBlocks(fs.readFileSync(planPath, "utf8"), "IMP-200");

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
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});
