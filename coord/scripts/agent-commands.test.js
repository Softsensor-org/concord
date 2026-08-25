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

    // ---------------------------------------------------------------------
    // COORD-663. The transfer preserving the worktree and branch (asserted
    // above) is CORRECT and deliberate — renaming a branch that may already be
    // merged is not a governance repair. What was missing is the record of
    // WHOSE namespace those preserved paths belong to. Without it every later
    // mutation validated the preserved paths against the NEW owner and failed,
    // wedging the ticket after a transfer that had itself succeeded.
    // ---------------------------------------------------------------------
    assert.equal(
      lockAfter.workspace_owner,
      oldOwner,
      "the physical namespace stays with the owner whose worktree and branch are preserved"
    );
    assert.ok(Array.isArray(lockAfter.transfer_provenance), "the transfer must be recorded on the lock");
    assert.equal(lockAfter.transfer_provenance.length, 1);
    const provenance = lockAfter.transfer_provenance[0];
    assert.equal(provenance.from, oldOwner);
    assert.equal(provenance.to, newOwner);
    assert.equal(provenance.workspace_owner, oldOwner);
    assert.equal(provenance.reason, "approved transfer regression");
    assert.equal(provenance.previous_session_id, `${oldOwner}-stale`);
    assert.ok(Number.isFinite(Date.parse(provenance.at)), "provenance must carry a parseable timestamp");

    // The namespace the lock declares is the one its physical paths actually
    // use — otherwise the declaration would be decoration.
    assert.ok(
      lockAfter.worktree.includes(`${path.sep}.worktrees${path.sep}${oldOwner}${path.sep}`),
      "the declared namespace must match the preserved worktree path"
    );
    assert.ok(lockAfter.branch.startsWith(`agent/${oldOwner.toLowerCase()}-`));

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

    const held = __testing.releaseTerminalTicketSession(ticketId, {
      effectiveThread: "thread-current",
      terminalSync: {
        session_release_safe: false,
        publication: { status: "ahead", published: false },
      },
    });
    assert.equal(held.released.length, 0, "unpublished canonical history must retain the active session");
    assert.equal(held.reason, "canonical-publication-unverified");
    assert.equal(
      JSON.parse(fs.readFileSync(sessionsPath, "utf8")).find((s) => s.session_id === "a00-current").status,
      "active",
      "the refusal must happen before the session ledger is rewritten",
    );

    const result = __testing.releaseTerminalTicketSession(ticketId, {
      effectiveThread: "thread-current",
      terminalSync: {
        session_release_safe: true,
        publication: { status: "published", published: true },
      },
    });
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

// ---------------------------------------------------------------------------
// COORD-680: factory dependency assertion + deferred-injection convention.
//
// The installed Amneal engine never passed `ensureGovernedWorkspaceForTicket`
// into createAgentCommands at all. The destructure yielded `undefined`, and
// `resume` only discovered it at the call site -- AFTER claimTicket had rebound
// the ticket lock. These tests move that failure to construction time.
// ---------------------------------------------------------------------------

const createAgentCommandsFactory = require("./agent-commands.js");

function completeAgentCommandDeps() {
  const noop = () => {};
  return {
    fail: noop,
    withGovernanceMutation: noop,
    readBoard: noop,
    getTicketRef: noop,
    findLockForTicket: noop,
    ensureGovernedWorkspaceForTicket: noop,
    rebindTicketLock: noop,
    // COORD-680 round 3: the COMPLETE set is built from the factory's OWN
    // declared list, not a hand-maintained subset. A hand-written helper drifts
    // the moment a dependency is added, and then every "missing dependency"
    // assertion below starts passing for the wrong reason — which is exactly
    // how a 7-name helper coexisted with a 44-name real surface.
    //
    // Built from the factory's own EXHAUSTIVE contract: callables get a noop,
    // value/object collaborators get a present object. GovernanceError is in
    // NEITHER list and is deliberately absent from this fixture: both
    // factory-deps.js and agent-commands.js now `require` it directly
    // (agent-commands.js:39) instead of taking it by injection, so there is no
    // wiring under which it can be missing. An earlier revision did destructure
    // it, and classifying it as a callable would have been unsound anyway — see
    // the classification note in factory-deps.js.
    ...Object.fromEntries(
      ((createAgentCommandsFactory.DEP_CONTRACT || {}).callable || []).map((name) => [name, noop]),
    ),
    ...Object.fromEntries(
      ((createAgentCommandsFactory.DEP_CONTRACT || {}).value || []).map((name) => [name, {}]),
    ),
  };
}

test("COORD-680: createAgentCommands rejects a missing required dependency at construction", () => {
  const deps = completeAgentCommandDeps();
  delete deps.ensureGovernedWorkspaceForTicket;

  let error;
  try {
    createAgentCommandsFactory(deps);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "an omitted helper must fail at wiring time, not at the first call site");
  // COORD-680: the error must be TYPED, not merely shaped. cli.js formats only
  // GovernanceError instances (cli.js, `error instanceof GovernanceError`) and
  // rethrows everything else, so a plain Error carrying the right `code` and
  // message still reaches the operator as a raw stack trace. Asserting the
  // message and code alone passed while that was exactly what happened.
  assert.equal(
    error.constructor.name,
    "GovernanceError",
    "a plain Error is rethrown by cli.js as a raw stack — the typed-error criterion is about the TYPE, not the shape",
  );
  assert.match(error.message, /missing required dependencies/);
  assert.equal(error.code, "governance_factory_dependency_missing");
  assert.deepEqual(error.missing, ["ensureGovernedWorkspaceForTicket"]);
  assert.equal(error.factory, "createAgentCommands");
  assert.match(
    error.message,
    /engine wiring defect, not an operator error/,
    "the typed error must not read as operator error",
  );
  // COORD-680: the deferred wrapper is house STYLE, not a correctness
  // requirement (bare shorthand is correct for hoisted function declarations),
  // and the message must not overstate that.
  //
  // Round 5: the remediation is now CLASSIFICATION-AWARE. A single
  // callable-only sentence told an operator that a missing value collaborator
  // "must be injected as a callable" and that "only callability is required" —
  // wrong advice, and a failure of the actionable-hint requirement. A missing
  // CALLABLE must get callable guidance and must NOT be told about the value
  // class, and vice versa.
  assert.match(error.message, /Callable dependencies \(must be typeof "function"\)/);
  assert.doesNotMatch(
    error.message,
    /Value dependencies/,
    "a missing callable must not be given value-collaborator remediation",
  );
  assert.doesNotMatch(
    error.message,
    /Each entry must be injected as a deferred/,
    "the message must not claim a wrapper is required for correctness",
  );
});

test("COORD-680: a dependency present but not callable is rejected like an omission", () => {
  const deps = completeAgentCommandDeps();
  deps.ensureGovernedWorkspaceForTicket = undefined;

  let error;
  try {
    createAgentCommandsFactory(deps);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "a non-callable dependency must be rejected like an omission");
  assert.deepEqual(error.missing, ["ensureGovernedWorkspaceForTicket"]);
});

test("COORD-680: a fully wired deps object constructs cleanly", () => {
  assert.doesNotThrow(() => createAgentCommandsFactory(completeAgentCommandDeps()));
});

test("COORD-680: deferred helpers are injected as lazy forwarders, never bare shorthand", () => {
  const source = fs.readFileSync(path.join(__dirname, "lifecycle.js"), "utf8");

  const forwarders = source.match(
    /ensureGovernedWorkspaceForTicket: \(\.\.\.args\) => ensureGovernedWorkspaceForTicket\(\.\.\.args\)/g,
  ) || [];
  assert.equal(
    forwarders.length,
    2,
    "both the createAgentCommands and createTicketTransitions wirings must use the deferred forwarder",
  );

  // A bare shorthand appended to a sibling's line is exactly how the original
  // defect was introduced; it must not reappear in an injection object.
  const bareShorthandInDepsObject = source
    .split("\n")
    .filter((line) => /\(\.\.\.args\) =>/.test(line))
    .filter((line) => /,\s*ensureGovernedWorkspaceForTicket\s*,/.test(line));
  assert.deepEqual(
    bareShorthandInDepsObject,
    [],
    "ensureGovernedWorkspaceForTicket must not be a bare shorthand in a deferred deps object",
  );
});

test("COORD-680: a resume whose workspace step fails leaves NO governed trace — atomic, not compensated", () => {
  // The regression this ticket exists for. `claimTicket` rebinds the lock and
  // `ensureGovernedWorkspaceForTicket` can still fail afterwards. Previously
  // those were two transactions, so the failure could only be COMPENSATED:
  // hand-restored lock bytes while the journal still asserted a successful
  // rebind. Now both run inside ONE withGovernanceMutation, so the failure
  // rolls back through the governance machinery itself.
  //
  // Asserts MORE than lock bytes, deliberately — a lock-bytes-only assertion
  // passes for compensation too, and cannot tell atomicity from cleanup.
  const ticketId = "MSRV-680";
  const owner = "codexa00";
  const threadA = "codex-thread-A";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("ebmr-coord680-atomic-");

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
    sections: [{
      kind: "table", level: 3, heading: "Resume Atomicity", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{
        ID: ticketId, Repo: "B", Type: "bug", Pri: "P1", Status: "doing", Owner: owner,
        Description: "Exercise resume atomicity across the rebind.", "Depends On": "",
      }],
    }],
    prompt_index: { [ticketId]: `coord/prompts/${ticketId}.md` },
    pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(agentsPath, `${JSON.stringify([{
    id: "a00", handle: owner, provider: "openai", status: "active",
    aliases: ["codex"], lane: "backend", default_repo: "B", created_at: now,
  }], null, 2)}\n`, "utf8");

  // The CURRENT thread's session is active; the lock is bound to a RELEASED
  // same-owner session. So the rebind genuinely rewrites the lock (stale ->
  // current). A no-op rebind would pass this test without proving anything.
  const sessionActive = {
    session_id: "a00-aaaa", agent_id: "a00", handle: owner, session_label: "codex:a",
    host: "h", cwd: backendRoot, board_path: boardPath, board_root: coordRoot,
    thread_id: threadA, claimed_at: now, last_seen_at: now, released_at: null,
    status: "active", auto_claimed: false,
  };
  const sessionStale = {
    ...sessionActive, session_id: "a00-cccc", thread_id: "codex-thread-C",
    status: "released", released_at: now,
  };
  fs.writeFileSync(sessionsPath, `${JSON.stringify([sessionActive, sessionStale], null, 2)}\n`, "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    agent_id: "a00", owner, ticket: ticketId, status: "doing",
    repo: __testing.repoNameForCode("B"),
    branch: `agent/${owner}-${ticketId.toLowerCase()}`,
    head: "deadbeef",
    // Reconstruction from this fixture fails (no base ref in the sandbox repo),
    // which is the post-rebind failure the test needs.
    worktree: path.join(backendRoot, ".worktrees", owner, ticketId),
    started_at_utc: now, heartbeat_utc: now,
    session_id: "a00-cccc",
  }, null, 2)}\n`, "utf8");

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    BOARD_PATH: __testing.paths.BOARD_PATH, PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH, AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR, RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR, LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
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
  process.env.CODEX_THREAD_ID = threadA;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const before = {
      lock: fs.readFileSync(lockPath, "utf8"),
      board: fs.readFileSync(boardPath, "utf8"),
      agents: fs.readFileSync(agentsPath, "utf8"),
      sessions: fs.readFileSync(sessionsPath, "utf8"),
    };
    assert.equal(JSON.parse(before.lock).session_id, "a00-cccc", "fixture: lock starts on the stale session");

    // The workspace post-condition must fail, AFTER the rebind would have run.
    assert.throws(() => __testing.resumeTicket(ticketId), /worktree|workspace/i,
      "fixture must fail at the workspace step, not before it");

    // (1) lock bytes unchanged — byte-for-byte, still naming the STALE session.
    assert.equal(fs.readFileSync(lockPath, "utf8"), before.lock,
      "lock must be byte-identical after a failed resume");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).session_id, "a00-cccc",
      "the rebind must be rolled back, not merely rewritten");

    // (2) board and agent/session state unchanged.
    assert.equal(fs.readFileSync(boardPath, "utf8"), before.board, "board must be unchanged");
    assert.equal(fs.readFileSync(agentsPath, "utf8"), before.agents, "agent registry must be unchanged");
    assert.equal(fs.readFileSync(sessionsPath, "utf8"), before.sessions, "session registry must be unchanged");

    // (3) NO successful claim/rebind event exists for the failed resume.
    const events = fs.existsSync(eventLogPath)
      ? fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const succeededRebinds = events.filter(
      (e) => ["resume", "claim-ticket"].includes(e.command) && e.result === "succeeded",
    );
    assert.deepEqual(succeededRebinds, [],
      "a failed resume must leave NO successful resume/claim-ticket event — this is what separates atomicity from compensation");

    // (4) NO failure event either — and that is the correct contract, not a gap.
    // `withGovernanceMutation` appends a `result: "failed"` event ONLY when the
    // rolled-back mutation had already produced EXTERNAL side effects (a merged
    // PR, say) that rollback cannot undo. With governed state fully restored and
    // nothing external done, the transaction genuinely did not happen, so
    // recording that it failed would be recording an event with no referent.
    //
    // This is the sharper form of the assertion above: compensation leaves a
    // successful rebind plus a correction; atomicity leaves NOTHING.
    const failed = events.filter((e) => e.result === "failed");
    assert.deepEqual(failed, [],
      "a clean rollback with no external side effects must leave no failure event either");

    // The external-side-effect path is the one case that MUST journal, since
    // rollback cannot undo what already left the process. Asserted as a contract
    // note here rather than exercised — this fixture performs no external effect.
    assert.equal(typeof __testing.resumeTicket, "function");
  } finally {
    console.log = originalLog;
    Object.assign(__testing.paths, {
      REPO_ROOTS: original.REPO_ROOTS, BOARD_PATH: original.BOARD_PATH,
      PLAN_PATH: original.PLAN_PATH, QUESTIONS_PATH: original.QUESTIONS_PATH,
      AGENTS_PATH: original.AGENTS_PATH, AGENT_SESSIONS_PATH: original.AGENT_SESSIONS_PATH,
      PLAN_RECORDS_DIR: original.PLAN_RECORDS_DIR,
      LEGACY_PLAN_RECORDS_DIR: original.LEGACY_PLAN_RECORDS_DIR,
      PROMPTS_DIR: original.PROMPTS_DIR, RENDERED_DIR: original.RENDERED_DIR,
      LOCKS_DIR: original.LOCKS_DIR, LEGACY_LOCKS_DIR: original.LEGACY_LOCKS_DIR,
      RUNTIME_DIR: original.RUNTIME_DIR,
      GOVERNANCE_EVENT_LOG_PATH: original.GOVERNANCE_EVENT_LOG_PATH,
      GOVERNANCE_SNAPSHOT_PATH: original.GOVERNANCE_SNAPSHOT_PATH,
      GOVERNANCE_SNAPSHOTS_DIR: original.GOVERNANCE_SNAPSHOTS_DIR,
      GOVERNANCE_EVENT_LOCK_DIR: original.GOVERNANCE_EVENT_LOCK_DIR,
    });
    if (original.CODEX_THREAD_ID === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = original.CODEX_THREAD_ID;
  }
});

test("COORD-680: a same-owner cross-thread resume SUCCEEDS through real wiring — no TypeError, no raw stack", () => {
  // The acceptance criterion the failure-path tests do not cover. AMNL-009's
  // crash was `TypeError: ensureGovernedWorkspaceForTicket is not a function`
  // on a resume that should have succeeded, so a suite that only exercises
  // resume FAILING cannot show the defect is gone.
  //
  // Legitimate handoff: the lock is held by a RELEASED same-owner session on
  // another thread, the current thread is active under the same owner, and the
  // governed worktree genuinely exists — so the ownership guard permits the
  // rebind and the COORD-635 post-condition is satisfiable.
  const ticketId = "MSRV-681";
  const owner = "codexa00";
  const threadA = "codex-thread-A";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("ebmr-coord680-success-");

  // A REAL governed worktree, built the way the engine builds them, so
  // ensureGovernedWorkspaceForTicket verifies rather than reconstructs.
  const branch = `agent/${owner}-${ticketId.toLowerCase()}`;
  runGit(backendRoot, ["checkout", "-b", branch]);
  runGit(backendRoot, ["checkout", "dev"]);
  const worktreePath = path.join(backendRoot, ".worktrees", owner, ticketId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(backendRoot, ["worktree", "add", worktreePath, branch]);
  const head = runGit(worktreePath, ["rev-parse", "HEAD"]).trim();

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
      title: "Governance Test Board", last_updated: now,
      canonical_references: ["coord/GOVERNANCE.md"],
      plan_markdown_render_statuses: ["doing", "review"], preamble: [],
    },
    sections: [{
      kind: "table", level: 3, heading: "Resume Success", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{
        ID: ticketId, Repo: "B", Type: "bug", Pri: "P1", Status: "doing", Owner: owner,
        Description: "Exercise a successful same-owner cross-thread resume.", "Depends On": "",
      }],
    }],
    prompt_index: { [ticketId]: `coord/prompts/${ticketId}.md` },
    pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(agentsPath, `${JSON.stringify([{
    id: "a00", handle: owner, provider: "openai", status: "active",
    aliases: ["codex"], lane: "backend", default_repo: "B", created_at: now,
  }], null, 2)}\n`, "utf8");
  const sessionActive = {
    session_id: "a00-aaaa", agent_id: "a00", handle: owner, session_label: "codex:a",
    host: "h", cwd: backendRoot, board_path: boardPath, board_root: coordRoot,
    thread_id: threadA, claimed_at: now, last_seen_at: now, released_at: null,
    status: "active", auto_claimed: false,
  };
  const sessionReleased = {
    ...sessionActive, session_id: "a00-cccc", thread_id: "codex-thread-C",
    status: "released", released_at: now,
  };
  fs.writeFileSync(sessionsPath, `${JSON.stringify([sessionActive, sessionReleased], null, 2)}\n`, "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    agent_id: "a00", owner, ticket: ticketId, status: "doing",
    repo: __testing.repoNameForCode("B"), branch, head,
    worktree: worktreePath, started_at_utc: now, heartbeat_utc: now,
    session_id: "a00-cccc",
  }, null, 2)}\n`, "utf8");

  const original = {
    REPO_ROOTS: { ...__testing.paths.REPO_ROOTS },
    BOARD_PATH: __testing.paths.BOARD_PATH, PLAN_PATH: __testing.paths.PLAN_PATH,
    QUESTIONS_PATH: __testing.paths.QUESTIONS_PATH, AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
    LEGACY_PLAN_RECORDS_DIR: __testing.paths.LEGACY_PLAN_RECORDS_DIR,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR, RENDERED_DIR: __testing.paths.RENDERED_DIR,
    LOCKS_DIR: __testing.paths.LOCKS_DIR, LEGACY_LOCKS_DIR: __testing.paths.LEGACY_LOCKS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
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
  process.env.CODEX_THREAD_ID = threadA;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    let thrown = null;
    let result;
    try {
      result = __testing.resumeTicket(ticketId);
    } catch (error) {
      thrown = error;
    }

    // No TypeError, and no raw stack reaching the operator.
    assert.equal(thrown, null,
      `resume must SUCCEED through real wiring (got: ${thrown && thrown.stack ? thrown.stack.split("\n")[0] : thrown})`);
    // `claimTicket` REPORTS by printing its payload rather than returning it, so
    // `resumeTicket` legitimately resolves undefined. The success signal is the
    // reported payload plus the rebound lock below — not a return value.
    void result;
    assert.match(logs.join("\n"), new RegExp(ticketId),
      "a successful resume must report its claim payload");

    // The rebind actually happened: the lock now names the CURRENT session.
    const lockAfter = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockAfter.session_id, "a00-aaaa",
      "a successful resume must rebind the lock to the resuming session");
    assert.equal(lockAfter.owner, owner, "owner is unchanged by a same-owner resume");

    // COORD-635: the isolation post-condition still holds afterwards.
    assert.ok(fs.existsSync(worktreePath), "the governed worktree must still exist");
    assert.equal(runGit(worktreePath, ["rev-parse", "--show-toplevel"]).trim(),
      fs.realpathSync(worktreePath),
      "the worktree must still be its own git toplevel, not the canonical tree");
  } finally {
    console.log = originalLog;
    Object.assign(__testing.paths, {
      REPO_ROOTS: original.REPO_ROOTS, BOARD_PATH: original.BOARD_PATH,
      PLAN_PATH: original.PLAN_PATH, QUESTIONS_PATH: original.QUESTIONS_PATH,
      AGENTS_PATH: original.AGENTS_PATH, AGENT_SESSIONS_PATH: original.AGENT_SESSIONS_PATH,
      PLAN_RECORDS_DIR: original.PLAN_RECORDS_DIR,
      LEGACY_PLAN_RECORDS_DIR: original.LEGACY_PLAN_RECORDS_DIR,
      PROMPTS_DIR: original.PROMPTS_DIR, RENDERED_DIR: original.RENDERED_DIR,
      LOCKS_DIR: original.LOCKS_DIR, LEGACY_LOCKS_DIR: original.LEGACY_LOCKS_DIR,
      RUNTIME_DIR: original.RUNTIME_DIR,
      GOVERNANCE_EVENT_LOG_PATH: original.GOVERNANCE_EVENT_LOG_PATH,
      GOVERNANCE_SNAPSHOT_PATH: original.GOVERNANCE_SNAPSHOT_PATH,
      GOVERNANCE_SNAPSHOTS_DIR: original.GOVERNANCE_SNAPSHOTS_DIR,
      GOVERNANCE_EVENT_LOCK_DIR: original.GOVERNANCE_EVENT_LOCK_DIR,
    });
    if (original.CODEX_THREAD_ID === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = original.CODEX_THREAD_ID;
  }
});


test("COORD-680: the typed-error guarantee has no wiring-dependent escape hatch", () => {
  // An earlier revision took GovernanceError from deps/options and fell back to
  // a built-in Error when absent. The test helper always injected it, so the
  // fallback was never exercised — a guarantee with an unexercised escape hatch.
  // factory-deps.js now imports GovernanceError directly, so NO dependency set
  // can produce an untyped error.
  const { assertFactoryDependencies } = require("./factory-deps.js");
  const { GovernanceError } = require("./governance-context.js");

  for (const [label, deps] of [
    ["deps without GovernanceError", { }],
    ["deps with GovernanceError explicitly undefined", { GovernanceError: undefined }],
    ["deps with a hostile non-constructor GovernanceError", { GovernanceError: 42 }],
  ]) {
    let error = null;
    try {
      assertFactoryDependencies("probeFactory", deps, ["someRequiredHelper"]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `${label}: a missing dependency must still throw`);
    assert.ok(
      error instanceof GovernanceError,
      `${label}: must still be a typed GovernanceError — cli.js rethrows anything else as a raw stack`,
    );
    assert.equal(error.code, "governance_factory_dependency_missing");
    assert.equal(error.factory, "probeFactory");
    assert.deepEqual(error.missing, ["someRequiredHelper"]);
  }
});

test("COORD-680: every destructured dependency is CLASSIFIED, and unclassified entries are rejected", () => {
  // SCOPE: the two LIFECYCLE factories in this ticket. The repository has ~52
  // create* factories; widening is out of scope and is recorded as a prompt
  // amendment rather than left implied by a comment here.
  //
  // WHY CLASSIFICATION RATHER THAN USAGE INFERENCE. Deriving requiredness from
  // direct `name(...)` call sites is blind to every other way a dependency is
  // consumed, and two escaped that way:
  //   - `appendReviewFollowupPlan` is passed as a REFERENCE
  //     (`appendPlan: appendReviewFollowupPlan`) and invoked later;
  //   - `GovernanceError` is used as the right-hand side of `instanceof`, which
  //     with an absent dep throws a raw
  //     `TypeError: Right-hand side of 'instanceof' is not an object`.
  // Both survived construction. So each factory declares an EXHAUSTIVE contract,
  // and this test fails if any destructured name is missing from it — meaning a
  // newly added dependency cannot default to unvalidated.
  const factories = [
    {
      name: "createAgentCommands",
      file: path.join(__dirname, "agent-commands.js"),
      marker: "module.exports = function createAgentCommands",
      contract: require("./agent-commands.js").DEP_CONTRACT,
    },
    {
      name: "createTicketTransitions",
      file: path.join(__dirname, "ticket-transitions.js"),
      marker: "module.exports = function createTicketTransitions",
      contract: require("./ticket-transitions.js").DEP_CONTRACT,
    },
  ];

  for (const factory of factories) {
    assert.ok(factory.contract && Array.isArray(factory.contract.callable) && Array.isArray(factory.contract.value),
      `${factory.name} must expose DEP_CONTRACT with callable and value arrays`);

    const src = fs.readFileSync(factory.file, "utf8");
    const body = src.slice(src.indexOf(factory.marker));
    const destructured = body.match(/const\s*\{([\s\S]*?)\}\s*=\s*deps;/);
    assert.ok(destructured, `${factory.name}: could not locate its deps destructuring`);

    const names = destructured[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*/, "").trim().replace(/,$/, ""))
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    assert.ok(names.length > 0, `${factory.name}: parsed no dependencies — the parser is broken, not the factory`);

    const classified = new Set([...factory.contract.callable, ...factory.contract.value]);

    const unclassified = names.filter((name) => !classified.has(name));
    assert.deepEqual(unclassified, [],
      `${factory.name}: destructured but UNCLASSIFIED, so omitting one would survive construction and fail at its use site — classify each as callable or value: ${unclassified.join(", ")}`);

    const phantom = [...classified].filter((name) => !names.includes(name));
    assert.deepEqual(phantom, [],
      `${factory.name}: classified but not destructured — the contract has drifted from the factory: ${phantom.join(", ")}`);

    // The classification is enforced, not decorative: omitting any single entry
    // must refuse construction with a typed error naming it.
    const noop = () => {};
    const build = () => ({
      ...Object.fromEntries(factory.contract.callable.map((n) => [n, noop])),
      ...Object.fromEntries(factory.contract.value.map((n) => [n, {}])),
    });
    const factoryFn = require(factory.file);
    assert.doesNotThrow(() => factoryFn(build()),
      `${factory.name} must construct with a complete classified dependency set`);

    for (const name of names) {
      const deps = build();
      delete deps[name];
      let error = null;
      try {
        factoryFn(deps);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `${factory.name}: omitting ${name} must refuse construction`);
      assert.equal(error.constructor.name, "GovernanceError",
        `${factory.name}: omitting ${name} must raise a TYPED GovernanceError`);
      assert.ok(error.missing.includes(name),
        `${factory.name}: the error must name ${name}`);
    }
  }
});

test("COORD-680: the composition root supplies EVERY contract entry for the scoped factories", () => {
  // SCOPE: the two lifecycle factories named in the prompt's SCOPE NARROWED
  // amendment. Replaces the single-symbol convention check, which asserted only
  // that `ensureGovernedWorkspaceForTicket` was a deferred forwarder in two
  // places — that catches one historical defect and nothing else.
  //
  // The construction-time assertion refuses a factory built with a missing
  // dependency, but it only fires if someone CONSTRUCTS one. This asserts the
  // real composition root actually supplies every classified entry, so a
  // dependency dropped from a wiring object fails here rather than at whichever
  // verb reaches it first.
  const lifecycleSrc = fs.readFileSync(path.join(__dirname, "lifecycle.js"), "utf8");

  function injectionKeys(marker) {
    const start = lifecycleSrc.indexOf(marker);
    assert.ok(start > -1, `could not find the ${marker} composition call`);
    const open = lifecycleSrc.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let i = open; i < lifecycleSrc.length; i += 1) {
      if (lifecycleSrc[i] === "{") depth += 1;
      else if (lifecycleSrc[i] === "}") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    // Line-independent on purpose: the composition root puts MULTIPLE entries on
    // one line (e.g. `findLockForTicket: (...) , ensureGovernedWorkspaceForTicket:
    // (...)`), and a per-line regex silently captured only the first — which
    // reported a supplied dependency as missing. Over-capture is safe here
    // because the assertion is required ⊆ supplied.
    const body = lifecycleSrc
      .slice(open + 1, end)
      .split("\n")
      .map((line) => line.replace(/\/\/.*/, ""))
      .join("\n");

    const supplied = new Set();
    for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      supplied.add(match[1]);
    }
    // Shorthand entries (`name,` / `name` before the closing brace).
    for (const match of body.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?=,|$)/gm)) {
      supplied.add(match[1]);
    }
    return supplied;
  }

  for (const factory of [
    { name: "createAgentCommands", marker: "createAgentCommands({", contract: require("./agent-commands.js").DEP_CONTRACT },
    { name: "createTicketTransitions", marker: "createTicketTransitions({", contract: require("./ticket-transitions.js").DEP_CONTRACT },
  ]) {
    const supplied = injectionKeys(factory.marker);
    const required = [...factory.contract.callable, ...factory.contract.value];
    const notSupplied = required.filter((name) => !supplied.has(name));
    assert.deepEqual(
      notSupplied,
      [],
      `${factory.name}: the composition root does not supply these classified dependencies, so construction would refuse at runtime: ${notSupplied.join(", ")}`,
    );
  }
});

test("COORD-680: a missing VALUE dependency gets value-specific remediation, never callable guidance", () => {
  // Pins behaviour that was previously verified only by a manual probe. Deleting
  // the entire value-remediation block left all 23 focused tests passing — the
  // guidance read as covered while being unprotected, which is the same
  // test-passes-for-the-wrong-reason class as the arrow-function noops that
  // masked the instanceof defect a round earlier.
  const factory = require("./agent-commands.js");
  const contract = factory.DEP_CONTRACT;
  const noop = () => {};
  const build = () => ({
    ...Object.fromEntries(contract.callable.map((n) => [n, noop])),
    ...Object.fromEntries(contract.value.map((n) => [n, {}])),
  });

  assert.ok(contract.value.includes("STATUS"), "fixture: STATUS must be a classified VALUE dependency");

  // --- value side -----------------------------------------------------------
  const valueDeps = build();
  delete valueDeps.STATUS;
  let valueError = null;
  try {
    factory(valueDeps);
  } catch (caught) {
    valueError = caught;
  }
  assert.ok(valueError, "omitting a value dependency must refuse construction");
  assert.deepEqual(valueError.missing_value, ["STATUS"], "missing_value must name the value dependency");
  assert.deepEqual(valueError.missing_callable, [], "a value-only failure must not report missing callables");
  assert.match(
    valueError.message,
    /Value dependencies \(must be PRESENT, and are NOT required to be callable\)/,
    "a missing value collaborator must get VALUE-specific remediation",
  );
  assert.doesNotMatch(
    valueError.message,
    /Callable dependencies/,
    "a value-only failure must not be given callable remediation",
  );
  // The precise wording that was rejected in review: telling an operator a value
  // collaborator must be callable is wrong advice, and wrapping one in a
  // function does not satisfy the check.
  assert.doesNotMatch(
    valueError.message,
    /only callability is required/i,
    "the rejected callable-only guidance must not return for a value dependency",
  );
  assert.match(valueError.message, /wrapping one in a function is wrong/);

  // --- callable side, asserted here too so the split cannot regress one-way ---
  const callableDeps = build();
  delete callableDeps.readBoard;
  let callableError = null;
  try {
    factory(callableDeps);
  } catch (caught) {
    callableError = caught;
  }
  assert.ok(callableError, "omitting a callable dependency must refuse construction");
  assert.deepEqual(callableError.missing_callable, ["readBoard"]);
  assert.deepEqual(callableError.missing_value, []);
  assert.match(callableError.message, /Callable dependencies \(must be typeof "function"\)/);
  assert.doesNotMatch(callableError.message, /Value dependencies/);

  // --- the corrected callability claim --------------------------------------
  // "only callability is required" was an overstatement: an `instanceof` operand
  // additionally needs a prototype, which an arrow function lacks. That
  // overstatement is what made the arrow-function hole look acceptable, so the
  // message must now say what the check does and does NOT guarantee.
  assert.match(
    callableError.message,
    /not sufficient for every use/,
    "the callable guidance must not overstate what callability guarantees",
  );
  assert.match(callableError.message, /instanceof/);
  // The rejected phrase must be absent from the CALLABLE remediation too, not
  // only the value one. Round 6 asserted it against `valueError` alone, so
  // re-adding "only callability is required" to the callable branch — while
  // keeping the corrected paragraph beside it — left every focused test
  // passing. A message that both corrects and repeats the overstatement is
  // still wrong advice, and asserting only the correction does not exclude it.
  // Case-INSENSITIVE deliberately: the first attempt at this assertion was
  // case-sensitive, and re-adding the phrase as "Only callability is required."
  // — sentence-cased, as it would naturally be written at the start of a
  // sentence — slipped straight past it. A negative assertion that the obvious
  // reintroduction evades is itself a green-looking surface.
  assert.doesNotMatch(
    callableError.message,
    /only callability is required/i,
    "the rejected callable-only guidance must not return to the callable remediation",
  );
});
