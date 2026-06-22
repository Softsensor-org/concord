const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");

const governanceModule = require("./governance.js");
const { GovernanceError, executeCommand, __testing } = governanceModule;
const { STATUS } = require("./governance-constants.js");

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
  return String(result.stdout || "").trim();
}

function writeRepoFile(repoRoot, relativePath, content) {
  const filePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createTempGitRepo(prefix, filesByPath, commitMessage = "seed") {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(repoRoot, ["init", "-b", "dev"]);
  runGit(repoRoot, ["config", "user.email", "governance-tests@example.com"]);
  runGit(repoRoot, ["config", "user.name", "Governance Tests"]);
  for (const [relativePath, content] of Object.entries(filesByPath)) {
    writeRepoFile(repoRoot, relativePath, content);
  }
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", commitMessage]);
  return { repoRoot, head: runGit(repoRoot, ["rev-parse", "HEAD"]) };
}

function createTempGitRepoWithOrigin(prefix, filesByPath, commitMessage = "seed") {
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}remote-`));
  runGit(remoteRoot, ["init", "--bare"]);
  const repo = createTempGitRepo(prefix, filesByPath, commitMessage);
  runGit(repo.repoRoot, ["remote", "add", "origin", remoteRoot]);
  runGit(repo.repoRoot, ["push", "-u", "origin", "dev"]);
  return { ...repo, remoteRoot };
}

function withJournalSandbox(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord032-journal-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const original = {
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
  };
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  try {
    return fn({ tempDir, runtimeDir, logPath: __testing.paths.GOVERNANCE_EVENT_LOG_PATH });
  } finally {
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
  }
}

function withCleanRuntimeFixture(run) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-c6p4-clean-"));
  const runtimeDir = path.join(tmpRoot, ".runtime");
  const boardPath = path.join(tmpRoot, "board", "tasks.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.dirname(boardPath), { recursive: true });

  // Protected ticket-local / runtime state.
  fs.mkdirSync(path.join(runtimeDir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "plans", "B-001.json"), "{}", "utf8");
  fs.mkdirSync(path.join(runtimeDir, "locks"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "locks", "B-001.json"), "{}", "utf8");
  fs.mkdirSync(path.join(runtimeDir, "session-threads"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "governance-events.ndjson"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "governance-latest-snapshot.json"), "{}", "utf8");

  // Safe regenerable scratch (eligible for removal with --yes).
  fs.mkdirSync(path.join(runtimeDir, "tmp-render"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "tmp-render", "x.txt"), "scratch", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "stale.tmp"), "scratch", "utf8");

  // Tracked board snapshot (older than the journal, by default).
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }), "utf8");

  const original = {
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    BOARD_PATH: __testing.paths.BOARD_PATH,
  };
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.BOARD_PATH = boardPath;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    return run({ tmpRoot, runtimeDir, boardPath, eventLogPath, logs });
  } finally {
    console.log = originalLog;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// COORD-061: shared COORD-003/004/transition workspace fixtures. Lifted out of
// governance.test.js so the ticket-transitions block/unblock tests (which moved
// into ticket-transitions.test.js) and the COORD-003/004 unstart/lock-abandon
// tests (which stay in governance.test.js) can share one provisioning helper.
function createMinimalGovernanceWorkspace(prefix) {
  const coordRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}coord-`));
  fs.mkdirSync(path.join(coordRoot, "board"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "board", "plans"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, ".runtime", "locks"), { recursive: true });
  const backend = createTempGitRepoWithOrigin(`${prefix}backend-`, {
    "README.md": "backend regression harness\n",
  });
  return { coordRoot, backendRoot: backend.repoRoot };
}

function setupCoord003Workspace(prefix, ticketId, owner, {
  ticketStatus = STATUS.DOING,
  withCommit = false,
  dirtyWorktree = false,
  reviewRound = null,
} = {}) {
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace(prefix);
  const branch = `agent/${owner}-${ticketId.toLowerCase()}-coord003`;

  runGit(backendRoot, ["checkout", "-b", branch]);
  runGit(backendRoot, ["checkout", "dev"]);
  const worktreePath = path.join(backendRoot, ".worktrees", owner, ticketId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(backendRoot, ["worktree", "add", worktreePath, branch]);
  if (withCommit) {
    writeRepoFile(worktreePath, "src/coord003.txt", "ticket work\n");
    runGit(worktreePath, ["add", "."]);
    runGit(worktreePath, ["commit", "-m", `${ticketId} ticket work`]);
  }
  if (dirtyWorktree) {
    writeRepoFile(worktreePath, "src/uncommitted.txt", "uncommitted\n");
  }
  const head = runGit(worktreePath, ["rev-parse", "HEAD"]);

  const now = new Date().toISOString();
  const boardPath = path.join(coordRoot, "board", "tasks.json");
  const planPath = path.join(coordRoot, "PLAN.md");
  const questionsPath = path.join(coordRoot, "QUESTIONS.md");
  const promptPath = path.join(coordRoot, "prompts", `${ticketId}.md`);
  const agentsPath = path.join(coordRoot, ".runtime", "agents.json");
  const sessionsPath = path.join(coordRoot, ".runtime", "agent_sessions.json");
  const lockPath = path.join(coordRoot, ".runtime", "locks", `${ticketId}.lock`);
  const runtimeDir = path.join(coordRoot, ".runtime");
  const eventLogPath = path.join(coordRoot, ".runtime", "governance-events.ndjson");
  const planRecordsDir = path.join(coordRoot, ".runtime", "plans");
  fs.mkdirSync(planRecordsDir, { recursive: true });

  fs.writeFileSync(promptPath, `# ${ticketId}\n`, "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(boardPath, `${JSON.stringify({
    version: 1,
    metadata: {
      title: "COORD-003 Test Board",
      last_updated: now,
      canonical_references: ["coord/GOVERNANCE.md"],
      landing_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      pr_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_records_required_from_ticket: { X: "ARCH-999", B: "MSRV-999", F: "FE-999" },
      feature_proof_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_markdown_render_statuses: [STATUS.DOING, STATUS.REVIEW],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-003 Regression",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: ticketId,
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: ticketStatus,
            Owner: owner,
            Description: "Exercise COORD-003 unstart/block regression handling.",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: { [ticketId]: `coord/prompts/${ticketId}.md` },
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(agentsPath, `${JSON.stringify([
    {
      id: "a00",
      handle: owner,
      provider: "anthropic",
      status: "active",
      aliases: [],
      lane: "backend",
      default_repo: "B",
      created_at: now,
    },
    {
      id: "a99",
      handle: "claudea99",
      provider: "anthropic",
      status: "active",
      aliases: [],
      lane: "backend",
      default_repo: "B",
      created_at: now,
    },
  ], null, 2)}\n`, "utf8");
  fs.writeFileSync(sessionsPath, `${JSON.stringify([
    {
      session_id: `${owner}-coord003`,
      agent_id: "a00",
      handle: owner,
      board_path: boardPath,
      thread_id: "coord003-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2)}\n`, "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    agent_id: "a00",
    owner,
    ticket: ticketId,
    status: STATUS.DOING,
    repo: __testing.repoNameForCode("B"),
    branch,
    head,
    worktree: worktreePath,
    started_at_utc: now,
    heartbeat_utc: now,
    session_id: `${owner}-coord003`,
  }, null, 2)}\n`, "utf8");

  // Seed a plan record. Scaffold by default; advanced when reviewRound is set.
  const scaffold = {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — ${now}`,
    startup_checklist: ["TODO: completed"],
    traceability_gate: ["TODO: verified | closing-gap | exempt"],
    governance: __testing.buildDefaultGovernancePlan("B"),
    review_round: reviewRound === null ? 1 : reviewRound,
    baseline_reproduction: [
      "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
      "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
    ],
    prior_findings: [],
    scaffold_placeholders: {
      intended_files: [`backend/.worktrees/${owner}/${ticketId}/*`],
    },
    intended_files: [`backend/.worktrees/${owner}/${ticketId}/*`],
    change_summary: ["TODO: describe the intended change."],
    verification_commands: ["TODO"],
    critical_invariants: [
      "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
      "TODO: include at least one invariant about state/contract consistency",
    ],
    requirement_closure: [
      "TODO: Ticket ask: <what the ticket said to deliver>",
      "TODO: Implemented: <what is actually delivered in this change>",
      "TODO: Not implemented: <residual gap or none>",
      "TODO: Deferred to: <ticket-id or none>",
      "TODO: Closeout verdict: complete | incomplete",
    ],
    feature_proof: [
      "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
      "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
    ],
    repo_gates: ["TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets"],
    self_review_cycles: [1, 2, 3, 4].map((cycle) => ({
      cycle,
      total: 4,
      lens: "TODO contract/state invariants",
      diff: "TODO git diff origin/dev...HEAD -- <paths>",
      risks: ["TODO failure mode 1", "TODO failure mode 2"],
      findings: "TODO none or describe issues fixed",
      verification: "TODO command rerun",
      verdict: "TODO pass or fail — fixed N issues, re-cycling",
      raw: "lens=TODO; diff=TODO; risks=TODO; findings=TODO; verification=TODO; verdict=TODO",
    })),
    rollback_strategy: ["TODO"],
    security_surface: "no",
    synced_from_markdown_at: now,
  };

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    REPO_INTEGRATION_BRANCHES: { ...__testing.paths.REPO_INTEGRATION_BRANCHES },
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    COORD_PROVIDER: process.env.COORD_PROVIDER,
    COORD_INSTANCE_ID: process.env.COORD_INSTANCE_ID,
  };
  // COORD-010: register ONLY the repo this harness provisions. Spreading the
  // ambient registry leaked the config-matrix's unprovisioned repos (C..H)
  // into the board validator, which then reported "Repo root missing". A
  // self-contained registry keeps the harness registry-agnostic. The harness
  // creates the temp repo on `dev`, so pin B's integration branch to `dev`
  // — otherwise the config-matrix's `devx` leaks in and the commits-ahead
  // base-ref resolution misses the test commits.
  __testing.paths.REPO_ROOTS = { B: backendRoot };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "dev" };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = planRecordsDir;
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(coordRoot, "board", "plans");
  __testing.paths.LOCKS_DIR = path.join(coordRoot, ".runtime", "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(coordRoot, "locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  // Stay on the legacy session-token identity channel (no v2 env).
  delete process.env.COORD_PROVIDER;
  delete process.env.COORD_INSTANCE_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;
  process.env.CLAUDE_SESSION_ID = "coord003-thread";

  // COORD-010: rebuild the governance block now that REPO_INTEGRATION_BRANCHES
  // is redirected to `{ B: "dev" }`. `buildDefaultGovernancePlan` reads the
  // registry at call time and seeds `expected_closeout.base_ref` from it; the
  // scaffold object literal above was built before the redirect, so under the
  // config matrix it captured the ambient `devx`. `resolveTicketBaseRef`
  // prefers the plan record's base_ref, so a stale `devx` there made the
  // commits-ahead guard compare against a non-existent ref.
  scaffold.governance = __testing.buildDefaultGovernancePlan("B");

  // Plan record write needs the redirected PLAN_RECORDS_DIR, so write it now.
  fs.writeFileSync(
    path.join(planRecordsDir, `${ticketId}.json`),
    `${JSON.stringify(scaffold, null, 2)}\n`,
    "utf8"
  );

  function restore() {
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
    __testing.paths.REPO_INTEGRATION_BRANCHES = original.REPO_INTEGRATION_BRANCHES;
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
    __testing.paths.LEGACY_PLAN_RECORDS_DIR = original.LEGACY_PLAN_RECORDS_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
    for (const key of ["CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "AGENT_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID"]) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }

  return { coordRoot, backendRoot, boardPath, lockPath, worktreePath, planRecordsDir, branch, restore };
}

function readBoardRow(boardPath, ticketId) {
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  return board.sections[0].rows.find((row) => row.ID === ticketId);
}

// COORD-090: lifted from governance.test.js so journal.test.js (which now owns
// the crash-recovery / governed-surface behavior tests) can share it without
// duplication. Redirects the full governed surface (board/plan/questions/
// agents/sessions/locks) at a temp sandbox layered on withJournalSandbox.
function withGovernedSurfaceSandbox(fn) {
  return withJournalSandbox(({ tempDir, runtimeDir, logPath }) => {
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
    fs.writeFileSync(planPath, "plan\n", "utf8");
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
      return fn({ tempDir, boardPath, logPath });
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
}

// COORD-090: lifted from governance.test.js — the exact shape
// buildScaffoldPlanRecord emits for a freshly-started ticket (every list field
// carries only its TODO scaffold value). Shared by governance.test.js
// (start/unstart scaffold guards) and plan-records.test.js
// (isScaffoldWorktreeIntendedFile), so it lives here to avoid duplication.
function coord006ScaffoldRecord(ticketId, intendedFile) {
  return {
    schema_version: 1,
    ticket_id: ticketId,
    markdown_heading: `## ${ticketId} — 2026-05-21T00:00:00.000Z`,
    startup_checklist: ["TODO: completed"],
    traceability_gate: ["TODO: verified | closing-gap | exempt"],
    governance: __testing.buildDefaultGovernancePlan("B"),
    review_round: 1,
    baseline_reproduction: [
      "TODO: Command: <required for test/contract/infra tickets; otherwise mark not-required>",
      "TODO: Outcome: <required for test/contract/infra tickets; otherwise mark not-required>",
    ],
    prior_findings: [],
    scaffold_placeholders: { intended_files: [intendedFile] },
    intended_files: [intendedFile],
    change_summary: ["TODO: describe the intended change."],
    verification_commands: ["TODO"],
    critical_invariants: [
      "TODO: list 2-5 truths this change must preserve under normal, edge, and failure paths",
      "TODO: include at least one invariant about state/contract consistency",
    ],
    requirement_closure: [
      "TODO: Ticket ask: <what the ticket said to deliver>",
      "TODO: Implemented: <what is actually delivered in this change>",
      "TODO: Not implemented: <residual gap or none>",
      "TODO: Deferred to: <ticket-id or none>",
      "TODO: Closeout verdict: complete | incomplete",
    ],
    feature_proof: [
      "TODO: path:<repo-relative-file-that-must-exist-on-canonical-branch>",
      "TODO: symbol:<repo-relative-file>#<symbol-or-literal-that-must-exist-at-closeout>",
    ],
    repo_gates: ["TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets"],
    self_review_cycles: [1, 2, 3, 4].map((cycle) => ({
      cycle,
      total: 4,
      lens: "TODO contract/state invariants",
      diff: "TODO git diff origin/dev...HEAD -- <paths>",
      risks: ["TODO failure mode 1", "TODO failure mode 2"],
      findings: "TODO none or describe issues fixed",
      verification: "TODO command rerun",
      verdict: "TODO pass or fail — fixed N issues, re-cycling",
      raw: "lens=TODO; diff=TODO; risks=TODO; findings=TODO; verification=TODO; verdict=TODO",
    })),
    rollback_strategy: ["TODO"],
    security_surface: "no",
  };
}

// COORD-090: lifted from governance.test.js — simulates a host without
// /proc/self/stat so runtimeSessionFingerprint / getOrCreateSessionToken
// exercise their non-POSIX fallbacks. Shared by the staying facade tests.
function withoutProcFs(fn) {
  const original = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (p === "/proc/self/stat") {
      const err = new Error("ENOENT: simulated missing procfs");
      err.code = "ENOENT";
      throw err;
    }
    return original.call(fs, p, ...rest);
  };
  try {
    return fn();
  } finally {
    fs.readFileSync = original;
  }
}

// COORD-096: lifted from governance.test.js — materializes a canonical on-disk
// ticket prompt (coord/prompts/tickets/<id>.md) for the duration of fn, then
// cleans up anything it created. Shared by the staying facade prompt tests and
// the relocated token-economics context-pack tests (no duplication).
function withCanonicalTicketPrompt(ticketId, content, fn) {
  // __dirname is coord/scripts → repo root is two levels up; canonical prompt
  // path mirrors defaultTicketPromptRelPath (coord/prompts/tickets/<id>.md).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const promptsDir = path.join(repoRoot, "coord", "prompts", "tickets");
  const promptPath = path.join(promptsDir, `${ticketId}.md`);
  const createdFile = !fs.existsSync(promptPath);
  const createdDir = !fs.existsSync(promptsDir);
  if (createdDir) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }
  if (createdFile) {
    fs.writeFileSync(promptPath, content, "utf8");
  }
  try {
    return fn();
  } finally {
    if (createdFile) {
      try { fs.rmSync(promptPath, { force: true }); } catch { /* best-effort */ }
    }
  }
}

// COORD-100: shared harness for the register-prompt / set-priority / set-type /
// auto-discover verb tests. Builds a temp board with a single ticket and rebinds
// the governance path seam at it. runBoardSync regenerates the real rendered
// artifacts from the temp board; we snapshot and restore them so the working
// tree is left untouched. Lifted here (out of governance.test.js) because the
// register-prompt VERB tests stay in the facade suite while the prompt-coverage
// behavior tests moved to prompt-coverage.test.js — both consume this harness.
function withRegisterPromptHarness(prefix, { ticketId = "IMP-700", promptRegistered = null, status = "todo", type = "feature", pri = "P2" }, body) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const boardPath = path.join(tempDir, "tasks.json");
  const promptOnDisk = path.join(tempDir, "external-prompt.md");
  fs.writeFileSync(promptOnDisk, `# ${ticketId} external prompt\n`, "utf8");

  const board = {
    version: 1,
    metadata: { title: "RP test board", canonical_references: [], preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Work",
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: ticketId, Repo: "B", Type: type, Pri: pri, Status: status, Owner: "unassigned", Description: "RP", "Depends On": "" },
        ],
      },
    ],
    prompt_index: promptRegistered ? { [ticketId]: promptRegistered } : {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
  fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  const runtimeDir = path.join(tempDir, ".runtime");
  fs.mkdirSync(path.join(runtimeDir, "locks"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "plans"), { recursive: true });

  // Rebind every path withGovernanceMutation / withCoordStateLock could touch
  // so journal entries, locks, and plan records stay inside the temp dir and
  // do not trigger spurious rollback-drift against the live journal.
  const originalPaths = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
  };
  // Snapshot real rendered artifacts so the temp-board sync does not leak.
  const realTasks = "coord/rendered/TASKS.md";
  const realPromptIdx = "coord/rendered/PROMPT_INDEX.md";
  const realPlan = "coord/PLAN.md";
  const snap = {};
  for (const p of [realTasks, realPromptIdx, realPlan]) {
    try { snap[p] = fs.readFileSync(p, "utf8"); } catch { snap[p] = null; }
  }

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = path.join(tempDir, "PLAN.md");
  __testing.paths.PLAN_RECORDS_DIR = path.join(runtimeDir, "plans");
  __testing.paths.LOCKS_DIR = path.join(runtimeDir, "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "locks");
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  try {
    return body({ tempDir, boardPath, promptOnDisk, ticketId, readBoard: () => JSON.parse(fs.readFileSync(boardPath, "utf8")) });
  } finally {
    for (const [k, v] of Object.entries(originalPaths)) {
      __testing.paths[k] = v;
    }
    for (const [p, content] of Object.entries(snap)) {
      if (content !== null) fs.writeFileSync(p, content, "utf8");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  GovernanceError,
  executeCommand,
  governanceModule,
  __testing,
  coord006ScaffoldRecord,
  withCanonicalTicketPrompt,
  withRegisterPromptHarness,
  withoutProcFs,
  withJournalSandbox,
  withGovernedSurfaceSandbox,
  withCleanRuntimeFixture,
  runGit,
  writeRepoFile,
  createTempGitRepo,
  createTempGitRepoWithOrigin,
  createMinimalGovernanceWorkspace,
  setupCoord003Workspace,
  readBoardRow,
};

