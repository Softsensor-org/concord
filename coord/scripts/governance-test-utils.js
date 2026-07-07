const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");

const governanceModule = require("./governance.js");
const { GovernanceError, executeCommand, __testing } = governanceModule;
const { STATUS } = require("./governance-constants.js");

// COORD-299: relocate THIS test worker's ephemeral coarse directory locks
// (coord/.coord-state.lock, coord/.agent-state.lock) and memory corpus to a
// per-process os.tmpdir() sandbox. Call ONCE at the top of a test file whose
// governed calls would otherwise acquire the live shared-worktree locks as an
// incidental side effect (no test asserts on the lock-dir location — they are
// transient coordination primitives). Process-scoped, NO restore: node --test runs
// each file in its own worker, so the redirect is naturally file-scoped, and the
// worker exits when the file finishes. RUNTIME_DIR / the journal are intentionally
// NOT touched here, so per-test journal sandboxes (withJournalSandbox etc.) still
// layer on top. Idempotent.
let processRuntimeLocksSandboxDir = null;
function sandboxProcessRuntimeLocks() {
  if (processRuntimeLocksSandboxDir) return processRuntimeLocksSandboxDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord299-runtime-locks-"));
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(dir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(dir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(dir, "memory");
  processRuntimeLocksSandboxDir = dir;
  return dir;
}

// COORD-300 / COORD-390: stronger sibling of sandboxProcessRuntimeLocks().
// Relocates THIS worker's live write surfaces to a per-process os.tmpdir()
// sandbox:
//   - runtime state (RUNTIME_DIR + journal / snapshot / event-lock / locks /
//     plan-records / agent registry + sessions),
//   - the two coarse directory locks,
//   - the memory corpus,
//   - seal-sensitive generated surfaces (PROMPTS_DIR + RENDERED_DIR).
// Call ONCE at the top of a governed-flow test file whose stray mutations (those
// not already wrapped in withGovernedSurfaceSandbox / withJournalSandbox) would
// otherwise write the live coord/.runtime tree or transient prompt/render files.
// Per-test sandboxes layer ON TOP:
// they capture the current (sandboxed) value as their "original" and restore back
// to it, so nothing leaks to the live tree between or around tests. Process-scoped,
// idempotent, NO restore — node --test runs each file in its own worker, so the
// redirect is naturally file-scoped and dies with the worker. Empty agents.json /
// agent_sessions.json are seeded so registry READS resolve instead of ENOENT.
let processRuntimeSandboxDir = null;
function sandboxProcessRuntime() {
  if (processRuntimeSandboxDir) return processRuntimeSandboxDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord300-runtime-"));
  const runtimeDir = path.join(dir, ".runtime");
  const promptsDir = path.join(dir, "prompts");
  const renderedDir = path.join(dir, "rendered");
  fs.mkdirSync(path.join(runtimeDir, "locks"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "plans"), { recursive: true });
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  fs.mkdirSync(renderedDir, { recursive: true });
  const agentsPath = path.join(runtimeDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  // Seed the sandbox registry by COPYING the live tracked registry (coord/agents.json,
  // the 178-handle seed list) so governed flows that look up a real handle (e.g.
  // claudea11) still resolve — while every WRITE lands in the sandbox copy, not the
  // live tree. readAgentsRegistry resolves AGENTS_PATH (.runtime/agents.json) and a
  // compat path (its parent dir's agents.json), so seed BOTH. Sessions start empty
  // (purely runtime; tests that need a session create it). Fall back to [] if absent.
  let seedRegistry = "[]";
  try {
    const liveRegistry = path.resolve(__dirname, "..", "agents.json");
    if (fs.existsSync(liveRegistry)) seedRegistry = fs.readFileSync(liveRegistry, "utf8");
  } catch {
    /* keep [] */
  }
  fs.writeFileSync(agentsPath, seedRegistry, "utf8");
  fs.writeFileSync(path.join(dir, "agents.json"), seedRegistry, "utf8");
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.LOCKS_DIR = path.join(runtimeDir, "locks");
  __testing.paths.PLAN_RECORDS_DIR = path.join(runtimeDir, "plans");
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(dir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(dir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(dir, "memory");
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RENDERED_DIR = renderedDir;
  processRuntimeSandboxDir = dir;
  return dir;
}

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
    // COORD-251: GOVERNANCE_EVENT_LOCK_DIR defaults to an ABSOLUTE path that is
    // independent of RUNTIME_DIR, so rebinding only RUNTIME_DIR left every test
    // layered on this sandbox (via withGovernedSurfaceSandbox) acquiring the
    // LIVE coord/.runtime/governance.lock inside withGovernanceMutation. Under
    // parallel `node --test` that cross-test contention intermittently timed
    // out (30s). Rebind the runtime lock dir into the sandbox too.
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    // COORD-299: the two coarse directory locks + the memory corpus default to
    // the LIVE coord/ tree independent of RUNTIME_DIR, so rebinding only the
    // journal left every governed mutation under test acquiring
    // coord/.coord-state.lock / coord/.agent-state.lock (and any memory write)
    // against the LIVE runtime. Rebind them into the sandbox too.
    COORD_STATE_LOCK_DIR: __testing.paths.COORD_STATE_LOCK_DIR,
    AGENT_STATE_LOCK_DIR: __testing.paths.AGENT_STATE_LOCK_DIR,
    MEMORY_DIR: __testing.paths.MEMORY_DIR,
  };
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(runtimeDir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(runtimeDir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(tempDir, "memory");
  try {
    return fn({ tempDir, runtimeDir, logPath: __testing.paths.GOVERNANCE_EVENT_LOG_PATH });
  } finally {
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
    __testing.paths.COORD_STATE_LOCK_DIR = original.COORD_STATE_LOCK_DIR;
    __testing.paths.AGENT_STATE_LOCK_DIR = original.AGENT_STATE_LOCK_DIR;
    __testing.paths.MEMORY_DIR = original.MEMORY_DIR;
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
    // COORD-299: sandbox the coarse locks + memory alongside the journal.
    COORD_STATE_LOCK_DIR: __testing.paths.COORD_STATE_LOCK_DIR,
    AGENT_STATE_LOCK_DIR: __testing.paths.AGENT_STATE_LOCK_DIR,
    MEMORY_DIR: __testing.paths.MEMORY_DIR,
  };
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(runtimeDir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(runtimeDir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(tmpRoot, "memory");

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
    __testing.paths.COORD_STATE_LOCK_DIR = original.COORD_STATE_LOCK_DIR;
    __testing.paths.AGENT_STATE_LOCK_DIR = original.AGENT_STATE_LOCK_DIR;
    __testing.paths.MEMORY_DIR = original.MEMORY_DIR;
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
    // COORD-290: redirect the prompt + rendered coordination surfaces too.
    // Governed commands under test (start/unstart/block/render) write prompt
    // scaffolds + rendered board artifacts; without these overrides those
    // writes landed under the LIVE coord/prompts + coord/rendered tree, an
    // out-of-band mutation that trips the COORD-220 seal for the next governed
    // command during concurrent runs. Sandbox them with everything else.
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    // COORD-299: sandbox the coarse directory locks + memory corpus too.
    COORD_STATE_LOCK_DIR: __testing.paths.COORD_STATE_LOCK_DIR,
    AGENT_STATE_LOCK_DIR: __testing.paths.AGENT_STATE_LOCK_DIR,
    MEMORY_DIR: __testing.paths.MEMORY_DIR,
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
  // COORD-290: point prompt + rendered surfaces at the sandbox coordRoot.
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });
  __testing.paths.PROMPTS_DIR = path.join(coordRoot, "prompts");
  __testing.paths.RENDERED_DIR = path.join(coordRoot, "rendered");
  __testing.paths.LOCKS_DIR = path.join(coordRoot, ".runtime", "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(coordRoot, "locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(runtimeDir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(runtimeDir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(coordRoot, "memory");
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

  // COORD-273: this workspace seeds live coordination state (board row + plan
  // record + prompt). Anchor a journal baseline now — all governed paths are
  // redirected and the on-disk state is in place — so the governed commands under
  // test run over an INITIALIZED journal (a healthy repo). Without it the new
  // journal-loss-over-existing-state guard refuses to auto-baseline on first use.
  __testing.ensureGovernanceJournalBaseline("coord003-harness-seed");

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
    __testing.paths.PROMPTS_DIR = original.PROMPTS_DIR;
    __testing.paths.RENDERED_DIR = original.RENDERED_DIR;
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
    __testing.paths.COORD_STATE_LOCK_DIR = original.COORD_STATE_LOCK_DIR;
    __testing.paths.AGENT_STATE_LOCK_DIR = original.AGENT_STATE_LOCK_DIR;
    __testing.paths.MEMORY_DIR = original.MEMORY_DIR;
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
    const promptsDir = path.join(tempDir, "prompts");
    const renderedDir = path.join(tempDir, "rendered");
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
    };
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.mkdirSync(locksDir, { recursive: true });
    fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
    fs.mkdirSync(renderedDir, { recursive: true });
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
    __testing.paths.PROMPTS_DIR = promptsDir;
    __testing.paths.RENDERED_DIR = renderedDir;
    __testing.paths.LOCKS_DIR = locksDir;
    __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "locks");
    try {
      return fn({ tempDir, boardPath, logPath, promptsDir, renderedDir });
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
  const activePromptsDir = path.join(__testing.paths.PROMPTS_DIR, "tickets");
  const activePromptPath = path.join(activePromptsDir, `${ticketId}.md`);
  const createdFile = !fs.existsSync(promptPath);
  const createdDir = !fs.existsSync(promptsDir);
  const activeDiffers = path.resolve(activePromptPath) !== path.resolve(promptPath);
  const createdActiveFile = activeDiffers && !fs.existsSync(activePromptPath);
  if (createdDir) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }
  if (createdFile) {
    fs.writeFileSync(promptPath, content, "utf8");
  }
  if (activeDiffers) {
    fs.mkdirSync(activePromptsDir, { recursive: true });
    fs.writeFileSync(activePromptPath, content, "utf8");
  }
  try {
    return fn();
  } finally {
    if (createdFile) {
      try { fs.rmSync(promptPath, { force: true }); } catch { /* best-effort */ }
    }
    if (createdActiveFile) {
      try { fs.rmSync(activePromptPath, { force: true }); } catch { /* best-effort */ }
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
  const agentsPath = path.join(runtimeDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  fs.writeFileSync(
    agentsPath,
    `${JSON.stringify([
      { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
    ], null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");

  // Rebind every path withGovernanceMutation / withCoordStateLock could touch
  // so journal entries, locks, plan records, and identity writes stay inside the
  // temp dir and do not trigger spurious rollback-drift against the live journal.
  const originalPaths = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    // COORD-299: sandbox the coarse directory locks + memory corpus too.
    COORD_STATE_LOCK_DIR: __testing.paths.COORD_STATE_LOCK_DIR,
    AGENT_STATE_LOCK_DIR: __testing.paths.AGENT_STATE_LOCK_DIR,
    MEMORY_DIR: __testing.paths.MEMORY_DIR,
  };
  // COORD-290: sandbox the prompt + rendered surfaces so runBoardSync regenerates
  // artifacts inside tempDir. Previously this harness rendered into the LIVE
  // coord/rendered + coord/PLAN.md and restored a snapshot afterward — a transient
  // out-of-band write that tripped the COORD-220 seal under concurrent governed
  // mutations. Redirecting the output dirs removes the live write entirely.
  fs.mkdirSync(path.join(tempDir, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "rendered"), { recursive: true });

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = path.join(tempDir, "PLAN.md");
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PROMPTS_DIR = path.join(tempDir, "prompts");
  __testing.paths.RENDERED_DIR = path.join(tempDir, "rendered");
  __testing.paths.PLAN_RECORDS_DIR = path.join(runtimeDir, "plans");
  __testing.paths.LOCKS_DIR = path.join(runtimeDir, "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "locks");
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.COORD_STATE_LOCK_DIR = path.join(runtimeDir, ".coord-state.lock");
  __testing.paths.AGENT_STATE_LOCK_DIR = path.join(runtimeDir, ".agent-state.lock");
  __testing.paths.MEMORY_DIR = path.join(tempDir, "memory");
  // COORD-273: this harness seeds a board WITH ticket rows (live coordination
  // state). Anchor a journal baseline up front so the governed command under test
  // runs over an INITIALIZED journal — i.e. a healthy repo. Without it the new
  // journal-loss-over-existing-state guard would (correctly) refuse to silently
  // auto-baseline existing board state on the first mutation.
  __testing.ensureGovernanceJournalBaseline("rp-harness-seed");
  try {
    return body({ tempDir, boardPath, promptOnDisk, ticketId, readBoard: () => JSON.parse(fs.readFileSync(boardPath, "utf8")) });
  } finally {
    for (const [k, v] of Object.entries(originalPaths)) {
      __testing.paths[k] = v;
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
  sandboxProcessRuntimeLocks,
  sandboxProcessRuntime,
  runGit,
  writeRepoFile,
  createTempGitRepo,
  createTempGitRepoWithOrigin,
  createMinimalGovernanceWorkspace,
  setupCoord003Workspace,
  readBoardRow,
};
