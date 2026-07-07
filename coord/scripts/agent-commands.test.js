"use strict";

// COORD-087 (Wave 4 slice 3): behavior tests for the AGENT-COMMAND /
// claim-orchestration surface (agent-commands.js) — the deep command-layer
// assertions relocated out of governance.test.js when the command layer was
// extracted from lifecycle.js: the agentid resolver (resolveCurrentAgentId
// guidance / auto-assign / explicit-owner), the cwd-claim hazard detector, the
// agent-status report builder, the claim --transfer-to override path, the
// claim/resume same-owner other-thread owner-lease GATE (the riskiest seam),
// and the agent-rebind --fresh recovery verb. They reach the surface through
// the stable governance.js __testing facade (which re-exports the
// agent-commands factory bindings), preserving the public test contract while
// co-locating the deep behavior coverage with the module it exercises.
//
// The lower-level SESSION-ENGINE behavior tests (identity-v2 env-channel,
// owner-lease registry internals, raw session/registry readers) deliberately
// stay with governance.test.js / governance-session coverage; this file only
// owns the COMMAND-layer behavior.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;
const {
  runGit,
  writeRepoFile,
  createMinimalGovernanceWorkspace,
  sandboxProcessRuntime,
} = require("./governance-test-utils.js");

// COORD-300: redirect the full runtime surface (RUNTIME_DIR + agent registry/
// sessions + coarse locks + plan-records) to a per-process os.tmpdir() sandbox so
// the governed-mutation writes that this file's thin per-test sandboxes don't cover
// land in tmp instead of the live coord/.runtime tree — letting agent-commands.test.js
// leave the test-isolation-guard allowlist.
sandboxProcessRuntime();

// Hermetic session env: these tests control provider session/thread ids
// explicitly. Strip any ambient id the host injects (e.g. Claude Code exports
// CLAUDE_CODE_SESSION_ID) so it cannot leak into fingerprint/identity tests.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

test("detectCwdTicketClaimHazard warns when claiming inside a governed worktree without rebinding the ticket", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-claim-hazard-"));
  const runtimeLocksDir = path.join(tempDir, ".runtime", "locks");
  const worktree = path.join(tempDir, __testing.repoNameForCode("B"), ".worktrees", "codexa12", "IMP-245");
  const lockPath = path.join(runtimeLocksDir, "IMP-245.lock");
  const original = {
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
  };

  fs.mkdirSync(runtimeLocksDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: "claudea12",
    ticket: "IMP-245",
    session_id: "a12-oldsession",
    worktree,
  }, null, 2), "utf8");

  __testing.paths.LOCKS_DIR = runtimeLocksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(tempDir, "legacy-locks");

  try {
    const warning = __testing.detectCwdTicketClaimHazard(
      { session_id: "a12-newsession" },
      path.join(worktree, "services")
    );
    assert.match(warning, /Current cwd is inside governed worktree for IMP-245/);
    assert.match(warning, /coord\/scripts\/gov resume IMP-245/);
  } finally {
    __testing.paths.LOCKS_DIR = original.LOCKS_DIR;
    __testing.paths.LEGACY_LOCKS_DIR = original.LEGACY_LOCKS_DIR;
  }
});

test("COORD-361: optimistic claim reserves todo ownership without creating a lock", () => {
  const owner = "codexa41";
  const threadId = "codex-thread-optimistic";
  const now = new Date().toISOString();
  const { coordRoot } = createMinimalGovernanceWorkspace("coord-optimistic-claim-");

  const boardPath = path.join(coordRoot, "board", "tasks.json");
  const planPath = path.join(coordRoot, "PLAN.md");
  const questionsPath = path.join(coordRoot, "QUESTIONS.md");
  const agentsPath = path.join(coordRoot, ".runtime", "agents.json");
  const sessionsPath = path.join(coordRoot, ".runtime", "agent_sessions.json");
  const runtimeDir = path.join(coordRoot, ".runtime");
  const eventLogPath = path.join(coordRoot, ".runtime", "governance-events.ndjson");
  const locksDir = path.join(coordRoot, ".runtime", "locks");

  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(boardPath, `${JSON.stringify({
    version: 1,
    metadata: {
      title: "Optimistic Claim Board",
      last_updated: now,
      canonical_references: ["coord/GOVERNANCE.md"],
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Optimistic Claims",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: "OPT-001",
            Repo: "X",
            Type: "task",
            Pri: "P3",
            Status: "todo",
            Owner: "unassigned",
            Description: "Optimistic claim success.",
            "Depends On": "",
          },
          {
            ID: "OPT-002",
            Repo: "X",
            Type: "task",
            Pri: "P3",
            Status: "todo",
            Owner: "codexa99",
            Description: "Optimistic claim conflict.",
            "Depends On": "",
          },
          {
            ID: "OPT-003",
            Repo: "X",
            Type: "task",
            Pri: "P3",
            Status: "deferred",
            Owner: "",
            Description: "Optimistic claim keeps deferred status.",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(agentsPath, `${JSON.stringify([
    {
      id: "a41",
      handle: owner,
      provider: "openai",
      status: "active",
      aliases: [],
      lane: "coord",
      default_repo: "X",
      created_at: now,
    },
  ], null, 2)}\n`, "utf8");
  fs.writeFileSync(sessionsPath, `${JSON.stringify([
    {
      session_id: "a41-optimistic",
      agent_id: "a41",
      handle: owner,
      session_label: "codex:optimistic",
      host: "h",
      cwd: coordRoot,
      board_path: boardPath,
      board_root: coordRoot,
      thread_id: threadId,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    },
  ], null, 2)}\n`, "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.PLAN_RECORDS_DIR = path.join(runtimeDir, "plans");
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(coordRoot, "board", "plans");
  __testing.paths.PROMPTS_DIR = path.join(coordRoot, "prompts");
  __testing.paths.RENDERED_DIR = path.join(coordRoot, "rendered");
  __testing.paths.LOCKS_DIR = locksDir;
  __testing.paths.LEGACY_LOCKS_DIR = path.join(coordRoot, "locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  process.env.CODEX_THREAD_ID = threadId;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    assert.throws(
      () => __testing.claimTicket("OPT-001"),
      /claim OPT-001 --optimistic/,
      "plain claim must preserve the existing start/resume guidance",
    );

    __testing.claimTicket("OPT-001", { optimistic: true });
    let board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    let row = board.sections[0].rows.find((item) => item.ID === "OPT-001");
    assert.equal(row.Owner, owner);
    assert.equal(row.Status, "todo");
    assert.equal(fs.existsSync(path.join(locksDir, "OPT-001.lock")), false);
    const payload = JSON.parse(logs.at(-1));
    assert.equal(payload.optimistic, true);
    assert.equal(payload.lock_created, false);

    assert.doesNotThrow(() => __testing.claimTicket("OPT-001", { optimistic: true }));
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    row = board.sections[0].rows.find((item) => item.ID === "OPT-001");
    assert.equal(row.Owner, owner, "same-owner optimistic claim is idempotent");

    assert.throws(
      () => __testing.claimTicket("OPT-002", { optimistic: true }),
      /already owned by codexa99/,
    );

    __testing.claimTicket("OPT-003", { optimistic: true });
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    row = board.sections[0].rows.find((item) => item.ID === "OPT-003");
    assert.equal(row.Owner, owner);
    assert.equal(row.Status, "deferred");
    assert.equal(fs.existsSync(path.join(locksDir, "OPT-003.lock")), false);
  } finally {
    console.log = originalLog;
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
    if (original.CODEX_THREAD_ID === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = original.CODEX_THREAD_ID;
    if (original.CLAUDE_SESSION_ID === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = original.CLAUDE_SESSION_ID;
    if (original.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original.CLAUDE_CODE_SESSION_ID;
    if (original.AGENT_THREAD_ID === undefined) delete process.env.AGENT_THREAD_ID;
    else process.env.AGENT_THREAD_ID = original.AGENT_THREAD_ID;
  }
});

test("claim transfer fails closed without override and records audited transfer details on success", () => {
  const ticketId = "MSRV-003";
  const oldOwner = "claudea0000";
  const newOwner = "claudea12";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("ebmr-governance-transfer-");
  const oldBranch = `agent/${oldOwner}-${ticketId.toLowerCase()}-transfer-test`;

  runGit(backendRoot, ["checkout", "-b", oldBranch]);
  writeRepoFile(backendRoot, "src/transfer.txt", "transfer regression\n");
  runGit(backendRoot, ["add", "."]);
  runGit(backendRoot, ["commit", "-m", `${ticketId} transfer regression`]);
  const head = runGit(backendRoot, ["rev-parse", "HEAD"]);
  runGit(backendRoot, ["checkout", "dev"]);

  const worktreePath = path.join(backendRoot, ".worktrees", oldOwner, ticketId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(backendRoot, ["worktree", "add", worktreePath, oldBranch]);

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

  fs.writeFileSync(promptPath, `# ${ticketId}\n`, "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(boardPath, `${JSON.stringify({
    version: 1,
    metadata: {
      title: "Governance Test Board",
      last_updated: now,
      canonical_references: ["coord/GOVERNANCE.md"],
      landing_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      pr_index_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_records_required_from_ticket: { X: "ARCH-999", B: "MSRV-999", F: "FE-999" },
      feature_proof_required_from_ticket: { B: "MSRV-999", F: "FE-999" },
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Transfer Regression",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: ticketId,
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: "doing",
            Owner: oldOwner,
            Description: "Exercise claim --transfer-to regression handling.",
            "Depends On": "",
          },
        ],
      },
    ],
    prompt_index: {
      [ticketId]: `coord/prompts/${ticketId}.md`,
    },
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(agentsPath, `${JSON.stringify([
    {
      id: "a00",
      handle: oldOwner,
      provider: "anthropic",
      status: "active",
      aliases: [],
      lane: "backend",
      default_repo: "B",
      created_at: now,
    },
    {
      id: "a12",
      handle: newOwner,
      provider: "anthropic",
      status: "active",
      aliases: [],
      lane: "backend",
      default_repo: "B",
      created_at: now,
    },
  ], null, 2)}\n`, "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    agent_id: null,
    owner: oldOwner,
    ticket: ticketId,
    status: "doing",
    repo: __testing.repoNameForCode("B"),
    branch: oldBranch,
    head,
    worktree: worktreePath,
    started_at_utc: now,
    heartbeat_utc: now,
    session_id: `${oldOwner}-stale`,
  }, null, 2)}\n`, "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    // COORD-290: sandbox the prompt + rendered coordination surfaces too.
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  // COORD-010: register only the repo this test provisions so the board
  // validator stays registry-agnostic under the config matrix.
  __testing.paths.REPO_ROOTS = { B: backendRoot };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });
  __testing.paths.PROMPTS_DIR = path.join(coordRoot, "prompts");
  __testing.paths.RENDERED_DIR = path.join(coordRoot, "rendered");
  __testing.paths.PLAN_RECORDS_DIR = path.join(coordRoot, ".runtime", "plans");
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(coordRoot, "board", "plans");
  __testing.paths.LOCKS_DIR = path.join(coordRoot, ".runtime", "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(coordRoot, "locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  delete process.env.CODEX_THREAD_ID;
  process.env.CLAUDE_SESSION_ID = "transfer-claim-session";
  delete process.env.AGENT_THREAD_ID;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    assert.throws(
      () => __testing.claimTicket(ticketId, { transferTo: newOwner }),
      /claim --transfer-to requires --human-admin-override/
    );

    const deniedBoard = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const deniedRow = deniedBoard.sections[0].rows.find((row) => row.ID === ticketId);
    assert.equal(deniedRow.Owner, oldOwner);
    const deniedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(deniedLock.owner, oldOwner);

    __testing.claimTicket(ticketId, {
      transferTo: newOwner,
      humanAdminOverride: "approved transfer regression",
    });

    const payload = JSON.parse(logs.at(-1) || "{}");
    assert.equal(payload.ticket, ticketId);
    assert.equal(payload.transferred, true);
    assert.equal(payload.previousOwner, oldOwner);
    assert.equal(payload.previous_session_id, `${oldOwner}-stale`);
    assert.equal(payload.owner, newOwner);
    assert.equal(payload.override_reason, "approved transfer regression");
    assert.equal(payload.legacy_force_alias, false);

    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const transferredRow = boardAfter.sections[0].rows.find((row) => row.ID === ticketId);
    assert.equal(transferredRow.Owner, newOwner);

    const lockAfter = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockAfter.owner, newOwner);
    assert.equal(lockAfter.worktree, worktreePath);
    assert.equal(lockAfter.branch, oldBranch);
    assert.match(lockAfter.session_id, /^a12-/);

    const journal = fs.readFileSync(eventLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = journal.at(-1);
    assert.equal(event.command, "claim-ticket");
    assert.equal(event.ticket, ticketId);
    assert.equal(event.details.previous_owner, oldOwner);
    assert.equal(event.details.previous_session_id, `${oldOwner}-stale`);
    assert.equal(event.details.transfer_to, newOwner);
    assert.equal(event.details.override_reason, "approved transfer regression");
    assert.equal(event.details.legacy_force_alias, false);
  } finally {
    console.log = originalLog;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
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
    if (original.CODEX_THREAD_ID === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = original.CODEX_THREAD_ID;
    }
    if (original.CLAUDE_SESSION_ID === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = original.CLAUDE_SESSION_ID;
    }
    if (original.AGENT_THREAD_ID === undefined) {
      delete process.env.AGENT_THREAD_ID;
    } else {
      process.env.AGENT_THREAD_ID = original.AGENT_THREAD_ID;
    }
  }
});

test("resolveCurrentAgentId returns structured assignment guidance when the thread is unclaimed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-agentid-guidance-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-guidance";
  delete process.env.AGENT_THREAD_ID;

  try {
    const resolved = __testing.resolveCurrentAgentId({});
    assert.equal(resolved.identity, null);
    assert.equal(resolved.payload.needs_assignment, true);
    assert.equal(resolved.payload.id, null);
    assert.match(resolved.payload.message, /No active claimed agent session/);
    assert.deepEqual(resolved.payload.next_commands, [
      "coord/scripts/gov agentid --assign",
      "coord/scripts/gov agentid --owner <handle|simple-id>",
      "coord/scripts/gov claim --owner <handle|simple-id>",
      "coord/scripts/gov resume <ticket-id>",
    ]);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("resolveCurrentAgentId can auto-assign a live agent id for the current thread", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-agentid-assign-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  const boardPath = path.join(tempDir, "tasks.json");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-assign";
  delete process.env.AGENT_THREAD_ID;

  try {
    const resolved = __testing.resolveCurrentAgentId({ assign: true });
    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));

    assert.equal(resolved.payload.id, "a00");
    assert.equal(resolved.payload.handle, "codexa00");
    assert.equal(resolved.payload.needs_assignment, false);
    assert.equal(resolved.payload.auto_claimed, true);
    assert.equal(resolved.payload.auto_registered, true);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].handle, "codexa00");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].handle, "codexa00");
    assert.equal(sessions[0].thread_id, "codex-thread-assign");
    assert.equal(sessions[0].status, "active");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("resolveCurrentAgentId auto-assign increments from the highest board-referenced user", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-agentid-high-water-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  const boardPath = path.join(tempDir, "tasks.json");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "IMP-001", Owner: "codexa32" },
        ],
      },
    ],
  }, null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-high-water";
  delete process.env.AGENT_THREAD_ID;

  try {
    const resolved = __testing.resolveCurrentAgentId({ assign: true });
    const agents = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));

    assert.equal(resolved.payload.id, "a33");
    assert.equal(resolved.payload.handle, "codexa33");
    assert.equal(agents[0].id, "a33");
    assert.equal(sessions[0].agent_id, "a33");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("buildAgentStatusPayload surfaces idle sessions as release candidates for orchestrator use", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-agent-status-release-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();

  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "IMP-100", Status: "doing", Owner: "codexa00" },
          { ID: "IMP-101", Status: "todo", Owner: "codexa01" },
        ],
      },
    ],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a00", handle: "codexa00", provider: "openai", status: "active", aliases: [] },
    { id: "a01", handle: "codexa01", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a00-busy",
      agent_id: "a00",
      handle: "codexa00",
      board_path: boardPath,
      thread_id: "thread-busy",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    {
      session_id: "a01-idle",
      agent_id: "a01",
      handle: "codexa01",
      board_path: boardPath,
      thread_id: "thread-idle",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "thread-idle";
  delete process.env.AGENT_THREAD_ID;

  try {
    const payload = __testing.buildAgentStatusPayload();
    assert.equal(payload.busy_active_agents.length, 1);
    assert.equal(payload.busy_active_agents[0].agent.handle, "codexa00");
    assert.equal(payload.release_candidates.length, 1);
    assert.equal(payload.release_candidates[0].agent.handle, "codexa01");
    assert.equal(payload.release_candidates[0].session.session_id, "a01-idle");
    assert.equal(payload.release_candidates[0].is_current_thread, true);
    assert.deepEqual(payload.release_candidates[0].release_commands, [
      "coord/scripts/gov agent-release a01-idle",
      "coord/scripts/gov agent-release a01",
    ]);
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("terminal ticket release marks the current active session released without touching other threads", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord263-terminal-session-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const ticketId = "COORD-263";
  const owner = "codexa00";
  const now = new Date().toISOString();
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, `${JSON.stringify({
    sections: [{
      rows: [{
        ID: ticketId,
        Repo: "X",
        Type: "bug",
        Pri: "P2",
        Status: "done",
        Owner: owner,
        Description: "Terminal session release regression",
        "Depends On": "",
      }],
    }],
  }, null, 2)}\n`);
  fs.writeFileSync(agentsPath, `${JSON.stringify([
    { id: "a00", handle: owner, provider: "openai", status: "active", aliases: [] },
  ], null, 2)}\n`);
  fs.writeFileSync(sessionsPath, `${JSON.stringify([
    {
      session_id: "a00-current",
      agent_id: "a00",
      handle: owner,
      board_path: boardPath,
      board_root: tempDir,
      thread_id: "thread-current",
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    },
    {
      session_id: "a00-other",
      agent_id: "a00",
      handle: owner,
      board_path: boardPath,
      board_root: tempDir,
      thread_id: "thread-other",
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    },
  ], null, 2)}\n`);

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  try {
    __testing.paths.BOARD_PATH = boardPath;
    __testing.paths.AGENTS_PATH = agentsPath;
    __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
    __testing.paths.RUNTIME_DIR = runtimeDir;
    process.env.AGENT_THREAD_ID = "thread-current";

    const result = __testing.releaseTerminalTicketSession(ticketId, { effectiveThread: "thread-current" });
    assert.equal(result.released.length, 1, "current active session should be released");
    assert.equal(result.released[0].session_id, "a00-current");

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(sessions.find((s) => s.session_id === "a00-current").status, "released");
    assert.ok(sessions.find((s) => s.session_id === "a00-current").released_at);
    assert.equal(sessions.find((s) => s.session_id === "a00-other").status, "active");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    if (original.AGENT_THREAD_ID === undefined) {
      delete process.env.AGENT_THREAD_ID;
    } else {
      process.env.AGENT_THREAD_ID = original.AGENT_THREAD_ID;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rebindAgent --fresh releases current session and claims a new unclaimed handle (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebind-fresh-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const runtimeDir = path.join(tempDir, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
    { id: "a13", handle: "claudea13", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a11-old",
      agent_id: "a11",
      handle: "claudea11",
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "claude-rebind-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  // Snapshot every path that withGovernanceMutation could write to, so the
  // mutation's journal entries stay inside the temp dir instead of leaking
  // into the live coord/.runtime/governance-events.ndjson and triggering
  // spurious "changed_paths references /tmp/..." drift on later doctor runs.
  const originalPaths = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
  };
  const original = {
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  process.env.CLAUDE_SESSION_ID = "claude-rebind-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;

  const stdoutLines = [];
  const originalLog = console.log;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };

  try {
    __testing.rebindAgent({ fresh: true });

    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));

    // Released the original session.
    const oldSession = sessionsAfter.find((s) => s.session_id === "a11-old");
    assert.equal(oldSession.status, "released", "previous session must be released");
    assert.ok(oldSession.released_at, "previous session must carry released_at timestamp");

    // Created exactly one new active session.
    const activeSessions = sessionsAfter.filter((s) => s.status === "active");
    assert.equal(activeSessions.length, 1, "exactly one active session after rebind");

    // The new session is bound to a different handle (not a11) from the anthropic pool.
    const newSession = activeSessions[0];
    assert.notEqual(newSession.handle, "claudea11", "must not rebind to the previous handle");
    assert.ok(["claudea12", "claudea13"].includes(newSession.handle),
      `must rebind to an unclaimed anthropic handle; got ${newSession.handle}`);
    assert.equal(newSession.thread_id, "claude-rebind-thread",
      "thread_id carries over so gov initiate in this process resolves to the new handle");

    // stdout contains both previous and current identity.
    const output = stdoutLines.join("\n");
    assert.match(output, /"handle": "claudea11"/, "output must name the previous handle");
    assert.match(output, new RegExp(`"handle": "${newSession.handle}"`), "output must name the new handle");
    assert.match(output, /Released claudea11/, "output must announce the release");
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(originalPaths)) {
      __testing.paths[key] = value;
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("rebindAgent --fresh works when there is no prior binding (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebind-empty-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const runtimeDir = path.join(tempDir, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const originalPaths = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
  };
  const original = {
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  process.env.CLAUDE_SESSION_ID = "fresh-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;

  const stdoutLines = [];
  const originalLog = console.log;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };

  try {
    __testing.rebindAgent({ fresh: true });

    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const activeSessions = sessionsAfter.filter((s) => s.status === "active");
    assert.equal(activeSessions.length, 1, "exactly one active session created");
    assert.equal(activeSessions[0].handle, "claudea11", "claims the only available handle in the pool");

    const output = stdoutLines.join("\n");
    assert.match(output, /"previous": null/, "output must report no prior binding");
    assert.match(output, /No prior binding to release/, "output must announce the empty-state case");
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(originalPaths)) {
      __testing.paths[key] = value;
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("rebindAgent --fresh fails closed when the provider pool is exhausted (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rebind-exhausted-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const eventLogPath = path.join(runtimeDir, "governance-events.ndjson");
  const snapshotPath = path.join(runtimeDir, "governance-latest-snapshot.json");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.writeFileSync(eventLogPath, "", "utf8");
  const now = new Date().toISOString();
  // Only one anthropic handle registered, and it is already bound to the caller.
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a11-only",
      agent_id: "a11",
      handle: "claudea11",
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "claude-exhausted-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    // COORD-290: also sandbox the runtime + lock dir (mirror the sibling
    // rebindAgent tests). Without RUNTIME_DIR the mutation's crash-recovery read
    // the LIVE coord/.runtime/governance-restore-point.json and restored the
    // live files it referenced (e.g. coord/prompts/implementer.md) out of band.
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = snapshotPath;
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = snapshotsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  process.env.CLAUDE_SESSION_ID = "claude-exhausted-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;

  try {
    assert.throws(
      () => __testing.rebindAgent({ fresh: true }),
      /No unclaimed anthropic handle available/,
      "must fail closed when pool is exhausted (caller must register another handle first)"
    );

    // The caller's original session must remain active — rebind must roll back on failure.
    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const survivor = sessionsAfter.find((s) => s.session_id === "a11-only");
    assert.equal(survivor.status, "active",
      "failed rebind must not leave the caller unbound (transactional rollback)");
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.QUESTIONS_PATH = original.QUESTIONS_PATH;
    __testing.paths.GOVERNANCE_EVENT_LOG_PATH = original.GOVERNANCE_EVENT_LOG_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOT_PATH = original.GOVERNANCE_SNAPSHOT_PATH;
    __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = original.GOVERNANCE_SNAPSHOTS_DIR;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = original.GOVERNANCE_EVENT_LOCK_DIR;
    for (const key of ["CLAUDE_SESSION_ID", "CLAUDECODE", "CODEX_THREAD_ID", "AGENT_THREAD_ID"]) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
});

test("resolveCurrentAgentId can claim an explicit owner for the current thread", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-agentid-owner-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-owner";
  delete process.env.AGENT_THREAD_ID;

  try {
    const resolved = __testing.resolveCurrentAgentId({ owner: "a04" });
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));

    assert.equal(resolved.payload.id, "a04");
    assert.equal(resolved.payload.handle, "codexa04");
    assert.equal(resolved.payload.requested_owner, "codexa04");
    assert.equal(resolved.payload.auto_claimed, false);
    assert.equal(resolved.payload.auto_registered, false);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].handle, "codexa04");
    assert.equal(sessions[0].thread_id, "codex-thread-owner");
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("COORD-011: a fresh same-owner other-thread Codex session cannot rebind a live ticket lock", () => {
  // Two fresh Codex threads share owner codexa00 against one doing ticket.
  // Thread A holds the lock; thread B (the current session) must NOT be able to
  // resume/claim it without an explicit human-admin override.
  const ticketId = "MSRV-011";
  const owner = "codexa00";
  const threadA = "codex-thread-A";
  const threadB = "codex-thread-B";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("ebmr-coord011-");

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

  fs.writeFileSync(promptPath, `# ${ticketId}\n`, "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(boardPath, `${JSON.stringify({
    version: 1,
    metadata: {
      title: "Governance Test Board",
      last_updated: now,
      canonical_references: ["coord/GOVERNANCE.md"],
      plan_markdown_render_statuses: ["doing", "review"],
      preamble: [],
    },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Owner-Lease Regression",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          {
            ID: ticketId,
            Repo: "B",
            Type: "bug",
            Pri: "P1",
            Status: "doing",
            Owner: owner,
            Description: "Exercise the same-owner other-thread owner-lease gate.",
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
      provider: "openai",
      status: "active",
      aliases: ["codex"],
      lane: "backend",
      default_repo: "B",
      created_at: now,
    },
  ], null, 2)}\n`, "utf8");
  const sessionA = {
    session_id: "a00-aaaa",
    agent_id: "a00",
    handle: owner,
    session_label: "codex:a",
    host: "h",
    cwd: backendRoot,
    board_path: boardPath,
    board_root: coordRoot,
    thread_id: threadA,
    claimed_at: now,
    last_seen_at: now,
    released_at: null,
    status: "active",
    auto_claimed: false,
  };
  const sessionB = { ...sessionA, session_id: "a00-bbbb", thread_id: threadB, session_label: "codex:b" };
  const sessionReleased = {
    ...sessionA, session_id: "a00-cccc", thread_id: "codex-thread-C",
    status: "released", released_at: now,
  };
  fs.writeFileSync(sessionsPath, `${JSON.stringify([sessionA, sessionB, sessionReleased], null, 2)}\n`, "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    agent_id: "a00",
    owner,
    ticket: ticketId,
    status: "doing",
    repo: __testing.repoNameForCode("B"),
    branch: `agent/${owner}-${ticketId.toLowerCase()}`,
    head: "deadbeef",
    worktree: path.join(backendRoot, ".worktrees", owner, ticketId),
    started_at_utc: now,
    heartbeat_utc: now,
    session_id: "a00-aaaa",
  }, null, 2)}\n`, "utf8");

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
    // COORD-290: sandbox the prompt + rendered coordination surfaces too.
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
    LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  __testing.paths.REPO_ROOTS = { B: backendRoot };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.QUESTIONS_PATH = questionsPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });
  __testing.paths.PROMPTS_DIR = path.join(coordRoot, "prompts");
  __testing.paths.RENDERED_DIR = path.join(coordRoot, "rendered");
  __testing.paths.PLAN_RECORDS_DIR = path.join(coordRoot, ".runtime", "plans");
  __testing.paths.LEGACY_PLAN_RECORDS_DIR = path.join(coordRoot, "board", "plans");
  __testing.paths.LOCKS_DIR = path.join(coordRoot, ".runtime", "locks");
  __testing.paths.LEGACY_LOCKS_DIR = path.join(coordRoot, "locks");
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = eventLogPath;
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  process.env.CODEX_THREAD_ID = threadB;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

    // Unit: the detector sees thread A as a live same-owner other-thread holder
    // from thread B's perspective, and ignores the released thread-C session.
    const fromB = __testing.detectActiveSameOwnerOtherThread(ticketId, lock, { currentThreadId: threadB });
    assert.equal(fromB.present, true);
    assert.equal(fromB.active_owner_sessions.length, 1);
    assert.equal(fromB.active_owner_sessions[0].thread_id, threadA);

    // The holder thread itself sees no contending other-thread (B is excluded as
    // self; the released session never contends).
    const lockHeldByAOnly = { ...lock };
    const sessionsHolderOnly = [sessionA, sessionReleased];
    const fromA = __testing.detectActiveSameOwnerOtherThread(ticketId, lockHeldByAOnly, {
      currentThreadId: threadA,
      sessions: sessionsHolderOnly,
    });
    assert.equal(fromA.present, false);

    // Integration: resume (force:true) from thread B must fail closed.
    assert.throws(
      () => __testing.resumeTicket(ticketId),
      /active_same_owner_other_thread/,
      "resume must refuse to displace a fresh same-owner other-thread lock",
    );
    const lockAfterResume = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockAfterResume.session_id, "a00-aaaa", "lock must remain bound to the holder");

    // Plain claim from thread B must also fail closed.
    assert.throws(
      () => __testing.claimTicket(ticketId),
      /active_same_owner_other_thread/,
      "claim must refuse to displace a fresh same-owner other-thread lock",
    );

    // explain surfaces the live owner/session picture.
    logs.length = 0;
    __testing.explainTicket(ticketId);
    const explainPayload = JSON.parse(logs.find((line) => line.trim().startsWith("{")) || "{}");
    assert.equal(explainPayload.active_same_owner_other_thread.present, true);
    assert.equal(explainPayload.active_same_owner_other_thread.active_owner_sessions[0].thread_id, threadA);

    // COORD-222: from thread B's vantage, the live thread-A session is also a
    // co-located FOREIGN session on the same runtime (the gate is owner-agnostic).
    // The detector sees it; the released thread-C session is ignored (not fresh-active).
    const colocatedFromB = __testing.detectColocatedForeignSessions({ currentThreadId: threadB });
    assert.equal(colocatedFromB.present, true, "thread-A is a co-located fresh foreign session from B");
    assert.ok(
      colocatedFromB.foreign_sessions.some((s) => s.thread_id === threadA),
      "co-located detection surfaces the thread-A holder",
    );
    assert.ok(
      !colocatedFromB.foreign_sessions.some((s) => s.thread_id === "codex-thread-C"),
      "released session must not appear as co-located",
    );

    // COORD-222: --allow-shared-worktree opts out of the co-located refusal.
    // (Here the same-owner owner-lease gate still applies, so we assert the
    // refusal message is NOT the co-located one when the override is passed.)
    let sharedErr = null;
    try {
      __testing.claimTicket(ticketId, { allowSharedWorktree: true });
    } catch (err) {
      sharedErr = err;
    }
    assert.ok(
      !sharedErr || !/one governed writer per checkout\/runtime|--allow-shared-worktree/.test(sharedErr.message),
      `--allow-shared-worktree must bypass the co-located gate (got: ${sharedErr && sharedErr.message})`,
    );

    // A human-admin override bypasses the owner-lease gate.
    let overrideErr = null;
    try {
      __testing.claimTicket(ticketId, { humanAdminOverride: "approved owner-lease takeover" });
    } catch (err) {
      overrideErr = err;
    }
    assert.ok(
      !overrideErr || !/active_same_owner_other_thread/.test(overrideErr.message),
      `human-admin override must bypass the owner-lease gate (got: ${overrideErr && overrideErr.message})`,
    );
  } finally {
    console.log = originalLog;
    __testing.paths.REPO_ROOTS = original.REPO_ROOTS;
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
    for (const key of ["CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "AGENT_THREAD_ID"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


// COORD-099: hasPromptWaiver / buildPromptWaiverCommand relocated to
// prompt-coverage.test.js, and the cli.js parseFlags flag-acceptance tests
// relocated to lifecycle-flags.test.js (beside their owning modules).
// resolveHumanAdminOverride stays here — it is owned by lifecycle.js /
// agent-commands.js, not a prompt/path/flag-parser subject.

test("resolveHumanAdminOverride accepts bare --force as the temporary legacy alias", () => {
  assert.deepEqual(
    __testing.resolveHumanAdminOverride("claim --transfer-to", { force: true }),
    {
      reason: "<legacy --force migration>",
      legacyForceAlias: true,
    }
  );
});
