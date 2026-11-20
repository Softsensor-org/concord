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
const approvalVerifier = require("./approval-verifier.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient, installApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const governanceCommands = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle.js")).commands;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const governanceModule = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance.js"));
const createGovernanceSession = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-session.js"));
const createTicketTransitions = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/ticket-transitions.js"));
const createRepoRegistry = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/repo-registry.js"));
const repoRegistryOwner = createRepoRegistry();

function withApprovalClient(fixture, run) {
  return withApprovalTestClient(path.resolve(__dirname, "..", ".."), fixture.client(), run);
}
const { __testing } = governanceModule;
const {
  runGit,
  writeRepoFile,
  createMinimalGovernanceWorkspace,
  sandboxProcessRuntime,
  withoutProcFs,
  withRegisterPromptHarness,
  withScopedGovernanceTestContext,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { state: governanceState, DEFAULT_PATHS } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));

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

const sessionContext = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));
const sessionOwner = createGovernanceSession({
  ...require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/state-io.js")),
  ...require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-board-state.js"))({ state: governanceState }),
  AGENT_SESSION_IDLE_MS: 15 * 60 * 1000,
  COORD_DIR: path.resolve(__dirname, "..", ".."),
  GovernanceError: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js")).GovernanceError,
  SESSION_FINGERPRINT_ENV_VARS: [],
  compareSessionsMostRecentFirst: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-session-reaping.js"))({}).compareSessionsMostRecentFirst,
  identityV2: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js")),
  fail: sessionContext.defaultFail,
  withAgentStateLock: sessionContext.withAgentStateLock,
  state: governanceState,
});

test("detectCwdTicketClaimHazard warns when claiming inside a governed worktree without rebinding the ticket", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-claim-hazard-"));
  const runtimeLocksDir = path.join(tempDir, ".runtime", "locks");
  const worktree = path.join(tempDir, repoRegistryOwner.repoNameForCode("B"), ".worktrees", "codexa12", "IMP-245");
  const lockPath = path.join(runtimeLocksDir, "IMP-245.lock");
  fs.mkdirSync(runtimeLocksDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: "claudea12",
    ticket: "IMP-245",
    session_id: "a12-oldsession",
    worktree,
  }, null, 2), "utf8");

  return withScopedGovernanceTestContext({
    LOCKS_DIR: runtimeLocksDir,
    LEGACY_LOCKS_DIR: path.join(tempDir, "legacy-locks"),
  }, () => {
    const warning = __testing.detectCwdTicketClaimHazard(
      { session_id: "a12-newsession" },
      path.join(worktree, "services")
    );
    assert.match(warning, /Current cwd is inside governed worktree for IMP-245/);
    assert.match(warning, /coord\/scripts\/gov resume IMP-245/);
  });
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
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  const logs = [];
  const originalLog = console.log;

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: path.join(runtimeDir, "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(coordRoot, "board", "plans"),
    PROMPTS_DIR: path.join(coordRoot, "prompts"),
    RENDERED_DIR: path.join(coordRoot, "rendered"),
    LOCKS_DIR: locksDir,
    LEGACY_LOCKS_DIR: path.join(coordRoot, "locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  process.env.CODEX_THREAD_ID = threadId;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
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
});

test("claim transfer fails closed without override and records audited transfer details on success", () => {
  const ticketId = "MSRV-003";
  const oldOwner = "claudea0000";
  const newOwner = "claudea12";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("legacy-governance-transfer-");
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
    {
      id: "a13",
      handle: "owner-candidate",
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
    repo: repoRegistryOwner.repoNameForCode("B"),
    branch: oldBranch,
    head,
    worktree: worktreePath,
    started_at_utc: now,
    heartbeat_utc: now,
    session_id: `${oldOwner}-stale`,
  }, null, 2)}\n`, "utf8");

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  // COORD-010: register only the repo this test provisions so the board
  // validator stays registry-agnostic under the config matrix.
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });

  const logs = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { B: backendRoot },
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PROMPTS_DIR: path.join(coordRoot, "prompts"),
    RENDERED_DIR: path.join(coordRoot, "rendered"),
    PLAN_RECORDS_DIR: path.join(coordRoot, ".runtime", "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(coordRoot, "board", "plans"),
    LOCKS_DIR: path.join(coordRoot, ".runtime", "locks"),
    LEGACY_LOCKS_DIR: path.join(coordRoot, "locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  delete process.env.CODEX_THREAD_ID;
  process.env.CLAUDE_SESSION_ID = "transfer-claim-session";
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.throws(
      () => __testing.claimTicket(ticketId, { transferTo: newOwner }),
      /claim --transfer-to requires --human-admin-override/
    );

    const deniedBoard = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const deniedRow = deniedBoard.sections[0].rows.find((row) => row.ID === ticketId);
    assert.equal(deniedRow.Owner, oldOwner);
    const deniedLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(deniedLock.owner, oldOwner);

    // ADR 0031: preview and apply share one target-bound approval subject. A
    // signature for another active target cannot authorize this transfer.
    const approvalFixture = createApprovalFixture();
    try {
      const transferOptions = { transferTo: newOwner, humanAdminOverride: "approved transfer regression" };
      const preview = __testing.claimTicket(ticketId, { ...transferOptions, dryRun: true });
      let refusal = null;
      try { withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), () => __testing.claimTicket(ticketId, transferOptions)); }
      catch (error) { refusal = error; }
      assert.ok(refusal, "bare transfer reason must refuse before mutation");
      assert.match(String(refusal.message), /requires a signed human-admin approval/);
      const subject = /Subject digest: ([0-9a-f]{64})/.exec(String(refusal.message));
      assert.ok(subject, String(refusal.message));
      assert.equal(preview.approval.subject_sha256, subject[1], "preview and apply bind the same canonical transfer state");
      approvalFixture.login({ verb: "claim --transfer-to", ticket: ticketId, subject_sha256: subject[1] });
      const beforeUnauthorizedTarget = {
        board: fs.readFileSync(boardPath),
        lock: fs.readFileSync(lockPath),
        sessions: fs.readFileSync(sessionsPath),
      };
      let changedTargetRefusal = null;
      try { withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), () => __testing.claimTicket(ticketId, {
        ...transferOptions, transferTo: "owner-candidate",
      })); } catch (error) { changedTargetRefusal = error; }
      assert.ok(changedTargetRefusal, "a signature for the named owner cannot authorize a different target");
      assert.match(String(changedTargetRefusal.message), /refused: scope-mismatch/);
      assert.deepEqual(fs.readFileSync(boardPath), beforeUnauthorizedTarget.board);
      assert.deepEqual(fs.readFileSync(lockPath), beforeUnauthorizedTarget.lock);
      assert.deepEqual(fs.readFileSync(sessionsPath), beforeUnauthorizedTarget.sessions);
      withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), () => __testing.claimTicket(ticketId, {
        transferTo: newOwner,
        humanAdminOverride: "approved transfer regression",
      }));
    } finally {
      approvalFixture.cleanup();
    }

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
});

test("resolveCurrentAgentId returns structured assignment guidance when the thread is unclaimed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-agentid-guidance-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
  }, () => {
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
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("resolveCurrentAgentId can auto-assign a live agent id for the current thread", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-agentid-assign-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  const boardPath = path.join(tempDir, "tasks.json");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2));

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
  }, () => {
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
    assert.equal(sessions[0].binding_sequence, 1, "automatic claim records binding order");
    assert.equal(sessions[0].status, "active");
  } finally {
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("COORD-638 agentid --assign refuses to leave a held v2 owner lease unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-638-agentid-lease-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  const boardPath = path.join(tempDir, "tasks.json");
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(agentsPath, "[]\n");
  fs.writeFileSync(sessionsPath, "[]\n");
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }));

  const original = {
    COORD_PROVIDER: process.env.COORD_PROVIDER,
    COORD_PROVIDER_SESSION_ID: process.env.COORD_PROVIDER_SESSION_ID,
    COORD_INSTANCE_ID: process.env.COORD_INSTANCE_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
    RUNTIME_DIR: runtimeDir,
  }, () => {
  process.env.COORD_PROVIDER = "openai";
  delete process.env.COORD_PROVIDER_SESSION_ID;
  process.env.COORD_INSTANCE_ID = "coord638-held-instance";
  process.env.CODEX_THREAD_ID = "coord638-held-thread";
  try {
    const envIdent = identityV2.readEnvIdentity();
    const registry = identityV2.registerAndAcquire(identityV2.emptyRegistry(), envIdent, "codexa42").registry;
    identityV2.writeRegistry(runtimeDir, registry);
    fs.writeFileSync(sessionsPath, JSON.stringify([
      {
        session_id: "other-thread",
        agent_id: "a42",
        handle: "codexa42",
        board_path: boardPath,
        thread_id: "not-the-current-thread",
        status: "active",
      },
      {
        session_id: "released-current-thread",
        agent_id: "a42",
        handle: "codexa42",
        board_path: boardPath,
        thread_id: "coord638-held-thread",
        status: "released",
      },
    ], null, 2) + "\n");
    const before = {
      agents: fs.readFileSync(agentsPath, "utf8"),
      sessions: fs.readFileSync(sessionsPath, "utf8"),
      registry: fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8"),
    };

    assert.throws(
      () => __testing.resolveCurrentAgentId({ assign: true }),
      /already holds the codexa42 owner lease.*gov claim --owner codexa42/s
    );
    assert.equal(fs.readFileSync(agentsPath, "utf8"), before.agents);
    assert.equal(fs.readFileSync(sessionsPath, "utf8"), before.sessions);
    assert.equal(fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8"), before.registry);
    assert.deepEqual(JSON.parse(fs.readFileSync(agentsPath, "utf8")), []);
    assert.equal(JSON.parse(fs.readFileSync(sessionsPath, "utf8")).length, 2);

    identityV2.writeRegistry(runtimeDir, identityV2.emptyRegistry());
    fs.writeFileSync(agentsPath, "[]\n");
    fs.writeFileSync(sessionsPath, "[]\n");
    const noLeaseAssignment = __testing.resolveCurrentAgentId({ assign: true });
    assert.ok(noLeaseAssignment.payload.handle, "without a held lease, ordinary assignment remains available");
    assert.equal(noLeaseAssignment.payload.auto_claimed, true);

    const multipleLeaseRegistry = identityV2.registerAndAcquire(identityV2.emptyRegistry(), envIdent, "codexa42").registry;
    const withSecondOwner = identityV2.registerAndAcquire(multipleLeaseRegistry, envIdent, "codexa43").registry;
    identityV2.writeRegistry(runtimeDir, withSecondOwner);
    fs.writeFileSync(agentsPath, "[]\n");
    fs.writeFileSync(sessionsPath, "[]\n");
    assert.throws(
      () => __testing.resolveCurrentAgentId({ assign: true }),
      /already holds the codexa42, codexa43 owner lease/
    );

    identityV2.writeRegistry(runtimeDir, registry);
    const now = new Date().toISOString();
    fs.writeFileSync(agentsPath, JSON.stringify([{
      id: "a42",
      handle: "codexa42",
      provider: "openai",
      status: "active",
      aliases: [],
      lane: "coord",
      default_repo: "X",
      created_at: now,
    }], null, 2) + "\n");
    fs.writeFileSync(sessionsPath, JSON.stringify([{
      session_id: "held-owner-current-thread",
      agent_id: "a42",
      handle: "codexa42",
      session_label: "codex:coord638-held",
      host: "test-host",
      cwd: tempDir,
      board_path: boardPath,
      board_root: tempDir,
      thread_id: "coord638-held-thread",
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    }], null, 2) + "\n");
    const preserved = __testing.resolveCurrentAgentId({ assign: true });
    assert.equal(preserved.payload.handle, "codexa42", "assignment must retain the already-held owner when this thread is bound to it");
    assert.equal(JSON.parse(fs.readFileSync(sessionsPath, "utf8"))[0].session_id, "held-owner-current-thread");
    assert.equal(JSON.parse(fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8")).leases.codexa42.instance_id, "coord638-held-instance");
  } finally {
    for (const name of ["COORD_PROVIDER", "COORD_PROVIDER_SESSION_ID", "COORD_INSTANCE_ID", "CODEX_THREAD_ID"]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-638 explicit owner rebind gives supported claim recovery without changing the current session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-638-explicit-rebind-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  const boardPath = path.join(tempDir, "tasks.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [], created_at: now },
    { id: "a43", handle: "codexa43", provider: "openai", status: "active", aliases: [], created_at: now },
  ], null, 2) + "\n");
  fs.writeFileSync(sessionsPath, JSON.stringify([{
    session_id: "codexa42-current-thread",
    agent_id: "a42",
    handle: "codexa42",
    session_label: "codex:rebind-test",
    host: "test-host",
    cwd: tempDir,
    board_path: boardPath,
    board_root: tempDir,
    thread_id: "coord638-rebind-thread",
    claimed_at: now,
    last_seen_at: now,
    released_at: null,
    status: "active",
    auto_claimed: false,
  }], null, 2) + "\n");
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }) + "\n");

  const original = {
    COORD_PROVIDER: process.env.COORD_PROVIDER,
    COORD_PROVIDER_SESSION_ID: process.env.COORD_PROVIDER_SESSION_ID,
    COORD_INSTANCE_ID: process.env.COORD_INSTANCE_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  const before = fs.readFileSync(sessionsPath, "utf8");
  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
    RUNTIME_DIR: path.join(tempDir, ".runtime"),
  }, () => {
  process.env.COORD_PROVIDER = "openai";
  process.env.COORD_PROVIDER_SESSION_ID = "coord638-rebind-provider";
  process.env.COORD_INSTANCE_ID = "coord638-rebind-instance";
  process.env.CODEX_THREAD_ID = "coord638-rebind-thread";
  try {
    assert.throws(
      () => __testing.resolveCurrentAgentId({ owner: "codexa43" }),
      (error) => {
        assert.match(error.message, /Current thread already owns codexa42/);
        assert.match(error.message, /gov claim --owner codexa43 --force/);
        assert.match(error.message, /explicit same-owner --handoff/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(sessionsPath, "utf8"), before, "a refused rebind must not release or rewrite the existing session");
  } finally {
    for (const name of ["COORD_PROVIDER", "COORD_PROVIDER_SESSION_ID", "COORD_INSTANCE_ID", "CODEX_THREAD_ID"]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-638 in-process start checks the v2 lease before later lifecycle gates", () => {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  const env = {
    ...process.env,
    COORD_PROVIDER: "anthropic",
    COORD_PROVIDER_SESSION_ID: "coord638-start-provider",
    COORD_INSTANCE_ID: "coord638-start-instance-test",
    CLAUDE_CODE_SESSION_ID: "coord638-start-thread-test",
  };
  delete env.CODEX_THREAD_ID;
  delete env.AGENT_THREAD_ID;

  withRegisterPromptHarness("coord-638-start-no-lease-", { ticketId: "C638-001", status: "proposed" }, ({ tempDir, ticketId }) => {
    identityV2.writeRegistry(path.join(tempDir, ".runtime"), identityV2.emptyRegistry());
    const missingTicket = governanceModule.executeCommand(["start"], { env });
    assert.equal(missingTicket.ok, false);
    assert.match(missingTicket.error, /start-ticket requires <ticket-id>/);
    const unknownTicket = governanceModule.executeCommand(
      ["start", "C638-MISSING", "--owner", "claudea11", "--allow-shared-worktree"],
      { env: { ...env, COORD_INSTANCE_ID: undefined } }
    );
    assert.equal(unknownTicket.ok, false);
    assert.match(unknownTicket.error, /Unknown ticket "C638-MISSING"/);
    const before = {
      board: fs.readFileSync(governanceState.BOARD_PATH, "utf8"),
      sessions: fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"),
      registry: fs.readFileSync(identityV2.registryPath(path.join(tempDir, ".runtime")), "utf8"),
    };
    const refusal = governanceModule.executeCommand(
      ["start", ticketId, "--owner", "claudea11"],
      { env }
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.error, /does not already hold a fresh claudea11 owner lease/);
    assert.equal(fs.readFileSync(governanceState.BOARD_PATH, "utf8"), before.board);
    assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), before.sessions);
    assert.equal(fs.readFileSync(identityV2.registryPath(path.join(tempDir, ".runtime")), "utf8"), before.registry);
  });

  withRegisterPromptHarness("coord-638-start-held-lease-", { ticketId: "C638-002", status: "proposed" }, ({ tempDir, ticketId }) => {
    const identity = identityV2.readEnvIdentity(env);
    const registry = identityV2.registerAndAcquire(identityV2.emptyRegistry(), identity, "claudea11").registry;
    identityV2.writeRegistry(path.join(tempDir, ".runtime"), registry);
    const refusal = governanceModule.executeCommand(
      ["start", ticketId, "--owner", "claudea11", "--allow-shared-worktree"],
      { env }
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.error, /is "proposed".*gov approve C638-002/s, "a held lease passes the new preflight and reaches the existing ticket-status gate");
  });

  withRegisterPromptHarness("coord-638-start-owner-doing-", {
    ticketId: "C638-005",
    // COORD-813: start reads the mapped prompt, so the mapping must resolve.
    promptRegistered: path.join(__dirname, "..", "..", "prompts", "implementer.md"),
    status: "todo",
    extraRows: [{ ID: "C638-006", Status: "doing", Owner: "claudea11", Repo: "X" }],
  }, ({ tempDir, ticketId }) => {
    const identity = identityV2.readEnvIdentity(env);
    const registry = identityV2.registerAndAcquire(identityV2.emptyRegistry(), identity, "claudea11").registry;
    identityV2.writeRegistry(path.join(tempDir, ".runtime"), registry);
    const refusal = governanceModule.executeCommand(
      ["start", ticketId, "--owner", "claudea11", "--allow-shared-worktree"],
      { env }
    );
    // COORD-963: the owner WIP cap is retired. The unrelated doing ticket C638-006 is reported
    // by the owner-doing doctor warning instead of refusing start.
    assert.doesNotMatch(String(refusal.error || ""), /already has an active doing ticket/);
  });

  withRegisterPromptHarness("coord-638-start-todo-", { ticketId: "C638-004", status: "todo" }, ({ tempDir, ticketId }) => {
    const identity = identityV2.readEnvIdentity(env);
    const registry = identityV2.registerAndAcquire(identityV2.emptyRegistry(), identity, "claudea11").registry;
    identityV2.writeRegistry(path.join(tempDir, ".runtime"), registry);
    const refusal = governanceModule.executeCommand(
      ["start", ticketId, "--owner", "claudea11", "--allow-shared-worktree"],
      { env }
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.error, /without prompt coverage or a recorded waiver/);
  });
});

test("COORD-638 direct claim cases preserve owner/session semantics across reachable branches", () => {
  withRegisterPromptHarness("coord-638-claim-branches-", { ticketId: "C638-003" }, ({ tempDir }) => {
    const agentsPath = governanceState.AGENTS_PATH;
    const sessionsPath = governanceState.AGENT_SESSIONS_PATH;
    const boardPath = governanceState.BOARD_PATH;
    const now = new Date().toISOString();
    const makeAgent = (id, handle, provider = "anthropic", status = "active") => ({
      id, handle, provider, status, aliases: [], lane: "coord", default_repo: "X", created_at: now,
    });
    const makeSession = (id, handle, threadId) => ({
      session_id: `${id}-${threadId}`,
      agent_id: id,
      handle,
      session_label: `test:${threadId}`,
      host: "test-host",
      cwd: tempDir,
      board_path: boardPath,
      board_root: tempDir,
      thread_id: threadId,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    });
    const writeAgents = (agents) => fs.writeFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n");
    const writeSessions = (sessions) => fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2) + "\n");
    const runClaim = (args, env) => governanceModule.executeCommand(["agent-claim", ...args], { env });
    const runSignedClaim = (args, env, ticket) => {
      const refused = runClaim(args, env);
      assert.equal(refused.ok, false, "a reason alone must not authorize a live-session rebind");
      assert.match(refused.error, /requires a signed human-admin approval/);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(refused.error);
      assert.ok(digest, refused.error);
      const approval = createApprovalFixture({ allowedVerbs: ["agent claim --human-admin-override"] });
      try {
        approval.login({ verb: "agent claim --human-admin-override", ticket, subject_sha256: digest[1] });
        return withApprovalClient(approval, () => runClaim(args, env));
      } finally { approval.cleanup(); }
    };
    const baseEnv = {
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord638-claim-provider",
      CLAUDE_CODE_SESSION_ID: "coord638-claim-current",
      COORD_INSTANCE_ID: undefined,
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
      // COORD-880: detection is fixture-owned; only fallbackEnv below sets CLAUDECODE.
      CLAUDECODE: undefined,
      // COORD-883: the other provider detection flags are never inherited either.
      GEMINI_AGENT: undefined,
      GROK_AGENT: undefined,
    };

    writeAgents([makeAgent("a42", "codexa42"), makeAgent("a43", "codexa43")]);
    writeSessions([]);
    assert.match(runClaim([], baseEnv).error, /agent-claim requires <handle\|simple-id>/);
    assert.match(runClaim(["unknown"], baseEnv).error, /Unknown registered agent/);
    writeAgents([makeAgent("a42", "codexa42", "anthropic", "disabled")]);
    assert.match(runClaim(["codexa42"], baseEnv).error, /is not active/);

    const unknownProviderEnv = {
      ...baseEnv,
      COORD_PROVIDER: "unknown",
      COORD_PROVIDER_SESSION_ID: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      AGENT_THREAD_ID: undefined,
    };
    writeAgents([makeAgent("a42", "codexa42", "unknown"), makeAgent("a43", "codexa43", "unknown")]);
    writeSessions([]);
    assert.match(runClaim(["codexa42"], unknownProviderEnv).error, /No stable runtime thread id is available/);

    const fallbackEnv = {
      ...baseEnv,
      COORD_PROVIDER: undefined,
      CLAUDECODE: "1",
      COORD_PROVIDER_SESSION_ID: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      AGENT_THREAD_ID: undefined,
    };
    const fallbackThread = withoutProcFs(() => governanceModule.__testing.withTemporaryExecutionContext(
      { env: fallbackEnv },
      () => sessionOwner.getOrCreateSessionToken("anthropic")
    ));
    assert.ok(fallbackThread, "the known provider receives its existing fallback thread token");
    writeAgents([makeAgent("a42", "codexa42"), makeAgent("a43", "codexa43")]);

    writeSessions([makeSession("a42", "codexa42", fallbackThread)]);
    const unstableMismatch = withoutProcFs(() => runClaim(["codexa43"], fallbackEnv));
    assert.equal(unstableMismatch.ok, false);
    assert.match(unstableMismatch.error, /unstable anthropic fallback and is already bound to codexa42/);
    assert.match(unstableMismatch.error, /provide CLAUDE_CODE_SESSION_ID before claiming a different owner/);

    writeAgents([makeAgent("a42", "codexa42"), makeAgent("a43", "codexa43")]);
    writeSessions([makeSession("a42", "codexa42", "coord638-claim-current")]);
    const sameOwner = runClaim(["codexa42", "--cwd", tempDir], baseEnv);
    assert.equal(sameOwner.ok, true, sameOwner.error);
    assert.match(sameOwner.stdout, /\"reused\": true/);

    const refusedRebind = runClaim(["codexa43"], baseEnv);
    assert.equal(refusedRebind.ok, false);
    assert.match(refusedRebind.error, /gov claim --owner codexa43 --force/);
    const forcedRebind = runClaim(["codexa43", "--force"], baseEnv);
    assert.equal(forcedRebind.ok, true, forcedRebind.error);
    assert.equal(JSON.parse(fs.readFileSync(sessionsPath, "utf8")).find((session) => session.handle === "codexa42").status, "released");

    writeSessions([makeSession("a42", "codexa42", "coord638-claim-other-thread")]);
    const activeConflict = runClaim(["codexa42"], baseEnv);
    assert.equal(activeConflict.ok, false);
    assert.match(activeConflict.error, /already has an active session/);
    // COORD-893 human-admin ruling (2026-11-05): --handoff over a LIVE session
    // on another thread is gated like --force; it needs the override.
    const liveHandoff = runClaim(["codexa42", "--handoff"], baseEnv);
    assert.equal(liveHandoff.ok, false);
    assert.match(liveHandoff.error, /--handoff does not authorize taking a handle from another session/);
    assert.match(activeConflict.error, /gov agent-release a42-coord638-claim-other-thread/);
    const handedOff = runSignedClaim(["codexa42", "--handoff", "--human-admin-override", "authorized takeover"], baseEnv, "codexa42");
    assert.equal(handedOff.ok, true, handedOff.error);
    assert.equal(JSON.parse(fs.readFileSync(sessionsPath, "utf8")).filter((session) => session.handle === "codexa42" && session.status === "active").length, 1);

    writeAgents([makeAgent("a42", "codexa42"), makeAgent("a43", "codexa43")]);
    writeSessions([makeSession("a42", "codexa42", "coord638-other-provider-thread")]);
    const competingProvider = withoutProcFs(() => runClaim(["codexa43"], fallbackEnv));
    assert.equal(competingProvider.ok, false);
    assert.match(competingProvider.error, /already has active session/);
    assert.match(competingProvider.error, /provide CLAUDE_CODE_SESSION_ID before claiming another one/);
  });
});

test("COORD-638 agent-claim acquires, refuses conflicts, and reports a same-owner v2 handoff", () => {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  withRegisterPromptHarness("coord-638-v2-claim-outcomes-", { ticketId: "C638-007" }, ({ tempDir }) => {
    const runtimeDir = path.join(tempDir, ".runtime");
    const envFor = (instanceId, threadId) => ({
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord638-v2-claim-provider",
      COORD_INSTANCE_ID: instanceId,
      CLAUDE_CODE_SESSION_ID: threadId,
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
    });
    const runClaim = (env, args = ["claudea11"]) => governanceModule.executeCommand(["agent-claim", ...args], { env });
    const runSignedClaim = (env, args, ticket) => {
      const refused = runClaim(env, args);
      assert.equal(refused.ok, false, "a reason alone must not authorize a live-session rebind");
      assert.match(refused.error, /requires a signed human-admin approval/);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(refused.error);
      assert.ok(digest, refused.error);
      const approval = createApprovalFixture({ allowedVerbs: ["agent claim --human-admin-override"] });
      try {
        approval.login({ verb: "agent claim --human-admin-override", ticket, subject_sha256: digest[1] });
        return withApprovalClient(approval, () => runClaim(env, args));
      } finally { approval.cleanup(); }
    };
    const locksDir = governanceState.LOCKS_DIR;
    const worktree = path.join(tempDir, "owned-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(locksDir, "C638-LEGACY.lock"), JSON.stringify({
      owner: "claudea11", ticket: "C638-LEGACY", worktree, session_id: "prior-session",
    }) + "\n");

    const firstEnv = envFor("coord638-claim-instance-a", "coord638-claim-thread-a");
    const first = runClaim(firstEnv, ["claudea11", "--cwd", path.join(worktree, "nested")]);
    assert.equal(first.ok, true, first.error);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.agent.handle, "claudea11");
    assert.match(firstPayload.warning, /inside governed worktree for C638-LEGACY/);
    assert.equal(firstPayload.owner_lease_handoff, undefined);
    assert.equal(JSON.parse(fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8")).leases.claudea11.instance_id,
      "coord638-claim-instance-a");

    // COORD-893 ruling: the thread-a session is still live, so the override is required.
    const handoffResult = runSignedClaim(envFor("coord638-claim-instance-b", "coord638-claim-thread-b"), [
      "claudea11", "--handoff", "--reason", "replace interrupted same-owner session",
      "--human-admin-override", "authorized same-owner takeover",
    ], "claudea11");
    assert.equal(handoffResult.ok, true, handoffResult.error);
    const handoff = JSON.parse(handoffResult.stdout).owner_lease_handoff;
    assert.equal(handoff.from_instance, "coord638-claim-instance-a");
    assert.equal(handoff.to_instance, "coord638-claim-instance-b");
    assert.equal(handoff.reason, "replace interrupted same-owner session");

    const registryBeforeConflict = fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8");
    // COORD-893: --force alone no longer reaches the v2 decision over another
    // live session; the human-admin override does, and the lease still refuses.
    const conflict = runSignedClaim(envFor("coord638-claim-instance-c", "coord638-claim-thread-c"), [
      "claudea11", "--force", "--human-admin-override", "authorized takeover attempt",
    ], "claudea11");
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /lease is held by a live instance coord638-claim-instance-b/);
    assert.equal(fs.readFileSync(identityV2.registryPath(runtimeDir), "utf8"), registryBeforeConflict,
      "a denied second instance must not replace the lease holder");

  });
});

// COORD-812: a v2 owner-lease registry that exists but cannot be trusted is a
// refusal for every consumer — never an implicit empty authority store.
function coord812FilesBelow(root) {
  const out = {};
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  };
  visit(root);
  return out;
}

// Owner claudea11 holds a doing ticket (board row, lock, plan, session), and
// instance A holds the v2 lease, all created through public commands.
function coord812Harness(prefix, body) {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  const ticketId = "IMP-812";
  withRegisterPromptHarness(prefix, { ticketId }, ({ tempDir, boardPath, readBoard }) => {
    const legacyEnv = { ...process.env };
    for (const key of Object.keys(legacyEnv)) {
      if (/_(?:SESSION|THREAD|INSTANCE)_ID$/.test(key) || key === "COORD_PROVIDER") delete legacyEnv[key];
    }
    Object.assign(legacyEnv, { COORD_SESSION_ID: "coord812-thread", CLAUDE_CODE_SESSION_ID: "coord812-thread" });
    // Same conversation thread, distinct live instances: the legacy session
    // resolves to claudea11 for both, so only the v2 lease tells them apart.
    const envFor = (instance) => ({
      ...legacyEnv,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord812-provider",
      COORD_INSTANCE_ID: `coord812-instance-${instance}`,
    });
    const run = (env, args) => governanceModule.executeCommand(args, { env });
    const runtimeDir = governanceState.RUNTIME_DIR;
    const registryFile = identityV2.registryPath(runtimeDir);

    assert.equal(run(legacyEnv, ["agentid", "--owner", "claudea11"]).ok, true);
    const seed = run(legacyEnv, ["plan", ticketId, "--seed"]);
    assert.equal(seed.ok, true, seed.error);
    const board = readBoard();
    Object.assign(board.sections[0].rows[0], { Owner: "claudea11", Status: "doing", Repo: "X" });
    board.waiver_index = { [ticketId]: { code: "prompt_coverage", reason: "isolated lease fixture", recorded_by: "fixture", recorded_at: new Date().toISOString() } };
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
    const session = sessionOwner.readAgentSessions().find((row) => row.status === "active");
    // Not materialized: heartbeat only refreshes HEAD for a checkout that exists.
    const worktree = path.join(tempDir, ".worktrees", "claudea11", ticketId);
    fs.writeFileSync(path.join(governanceState.LOCKS_DIR, `${ticketId}.lock`), JSON.stringify({
      owner: "claudea11", agent_id: "a11", ticket: ticketId, status: "doing", repo: "coord",
      branch: "agent/claudea11-imp-812", worktree, head: "coord-no-git-head",
      started_at_utc: session.claimed_at, heartbeat_utc: new Date().toISOString(),
      session_id: session.session_id, thread_id: session.thread_id,
    }, null, 2) + "\n");
    __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command: "journal-baseline", ticket: null,
      before_status: null, after_status: null, identity: null,
      details: { reason: "isolated owner-lease fixture" }, changed_paths: [],
      snapshot: __testing.buildGovernanceSnapshot(),
    });
    assert.equal(fs.existsSync(path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`)), true);
    const runWithApprovalClient = (fixture, env, args) => withApprovalClient(fixture, () => run(env, args));
    body({ identityV2, ticketId, tempDir, run, runWithApprovalClient, envFor, registryFile });
  });
}

test("COORD-812 first claim on an absent registry creates the lease; an empty file is not first use", () => {
  coord812Harness("coord-812-first-claim-", ({ ticketId, tempDir, run, envFor, registryFile }) => {
    assert.equal(fs.existsSync(registryFile), false, "fresh runtime: no registry yet");
    const firstClaim = run(envFor("a"), ["agent-claim", "claudea11"]);
    assert.equal(firstClaim.ok, true, firstClaim.error);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(registry.leases.claudea11.instance_id, "coord812-instance-a");
    const mutation = run(envFor("a"), ["heartbeat", ticketId]);
    assert.equal(mutation.ok, true, mutation.error);

    fs.writeFileSync(registryFile, "");
    const before = coord812FilesBelow(tempDir);
    for (const args of [["agent-claim", "claudea11"], ["heartbeat", ticketId]]) {
      const refused = run(envFor("a"), args);
      assert.equal(refused.ok, false, `${args[0]} must not treat a zero-byte registry as first use`);
      assert.match(refused.error, /owner-lease registry .* is corrupt/i);
      assert.deepEqual(coord812FilesBelow(tempDir), before);
    }
  });
});

const MALFORMED_REGISTRY = "{ malformed registry\n";

for (const [label, corrupt] of [
  ["malformed JSON", (file) => fs.writeFileSync(file, MALFORMED_REGISTRY)],
  ["a zero-byte file", (file) => fs.writeFileSync(file, "")],
  ["an unsupported structure", (file) => fs.writeFileSync(file, "[]\n")],
  ["an unreadable file", (file) => {
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (target, ...args) {
      if (String(target) === file && args.length > 0) {
        throw Object.assign(new Error("EIO: injected registry read failure"), { code: "EIO" });
      }
      return originalRead.call(this, target, ...args);
    };
    return () => { fs.readFileSync = originalRead; };
  }],
]) {
  test(`COORD-812 mutation and explicit handoff both refuse ${label} before changing anything`, () => {
    coord812Harness("coord-812-corrupt-", ({ ticketId, tempDir, run, envFor, registryFile }) => {
      assert.equal(run(envFor("a"), ["agent-claim", "claudea11"]).ok, true);
      assert.equal(run(envFor("a"), ["heartbeat", ticketId]).ok, true);
      const validBytes = fs.readFileSync(registryFile);

      const clearFault = corrupt(registryFile);
      let refusals;
      let before;
      let after;
      try {
        before = coord812FilesBelow(tempDir);
        refusals = [
          ["heartbeat", ticketId],
          ["agent-claim", "claudea11", "--handoff", "--reason", "take over the corrupt registry"],
          ["agent-claim", "claudea11"],
          ["start", ticketId, "--owner", "claudea11"],
          ["agentid", "--assign"],
        ].map((args) => [args, run(envFor("b"), args), coord812FilesBelow(tempDir)]);
        after = coord812FilesBelow(tempDir);
      } finally {
        if (clearFault) clearFault();
      }
      for (const [args, result, filesAfter] of refusals) {
        assert.equal(result.ok, false, `${args.join(" ")} must refuse`);
        assert.match(result.error, /owner-lease registry/i, args.join(" "));
        assert.ok(result.error.includes(registryFile), "names the preserved artifact");
        assert.match(result.error, /do not delete, truncate or re-create/i);
        assert.equal(/owner_lease_handoff/.test(result.stdout), false);
        assert.deepEqual(filesAfter, before,
          `${args.join(" ")}: board, lock, plan, sessions, event log and registry bytes are unchanged`);
      }
      assert.deepEqual(after, before);

      // Restoring the saved valid registry restores exactly the prior authority.
      fs.writeFileSync(registryFile, validBytes);
      const holder = run(envFor("a"), ["heartbeat", ticketId]);
      assert.equal(holder.ok, true, holder.error);
      const candidate = run(envFor("b"), ["heartbeat", ticketId]);
      assert.equal(candidate.ok, false);
      assert.match(candidate.error, /lease is held by a live instance coord812-instance-a/);
      const candidateClaim = run(envFor("b"), ["agent-claim", "claudea11"]);
      assert.equal(candidateClaim.ok, false);
      assert.match(candidateClaim.error, /lease is held by a live instance coord812-instance-a/);
      const handoff = run(envFor("b"), ["agent-claim", "claudea11", "--handoff", "--reason", "explicit"]);
      assert.equal(handoff.ok, true, handoff.error);
      assert.equal(JSON.parse(handoff.stdout).owner_lease_handoff.from_instance, "coord812-instance-a");
    });
  });
}

test("COORD-812 a registry reader that throws anything refuses the claim instead of starting empty", () => {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  withRegisterPromptHarness("coord-812-reader-throws-", { ticketId: "C812-008" }, ({ tempDir }) => {
    const env = {
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord812-reader-provider",
      COORD_INSTANCE_ID: "coord812-reader-instance",
      CLAUDE_CODE_SESSION_ID: "coord812-reader-thread",
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
    };
    const sessionsBefore = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8");
    const originalRead = identityV2.readRegistry;
    identityV2.readRegistry = () => { throw new Error("unexpected registry read failure"); };
    try {
      const result = governanceModule.executeCommand(["agent-claim", "claudea11"], { env });
      assert.equal(result.ok, false);
      assert.match(result.error, /unexpected registry read failure/);
      assert.equal(result.stdout, "");
      assert.equal(fs.existsSync(identityV2.registryPath(path.join(tempDir, ".runtime"))), false);
      assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), sessionsBefore);
    } finally {
      identityV2.readRegistry = originalRead;
    }
  });
});

// COORD-824: the governed recovery verb for the registry COORD-812 refuses.
function coord824Events() {
  return fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function coord824Sha(file) {
  return require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runWithSignedRegistryRecovery(run, runWithApprovalClient, env, args, ticket = "owner-lease-registry") {
  const fixture = createApprovalFixture({ allowedVerbs: ["agents recover-lease-registry"] });
  try {
    const registryFile = args[args.indexOf("--registry") + 1];
    const recoveryEvidenceDir = path.join(path.dirname(path.dirname(registryFile)), "identity", "recovery");
    const registryBefore = fs.readFileSync(registryFile);
    const first = run(env, args);
    assert.equal(first.ok, false, "reason-only registry recovery must refuse");
    const unsignedRegistryBytes = fs.readFileSync(registryFile);
    const unsignedEvidenceExists = fs.existsSync(recoveryEvidenceDir);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
    assert.ok(digest, first.error);
    assert.deepEqual(unsignedRegistryBytes, registryBefore, "reason-only recovery leaves the registry bytes unchanged");
    assert.equal(unsignedEvidenceExists, false, "reason-only recovery writes no evidence");
    fixture.login({ verb: "agents recover-lease-registry", ticket, subject_sha256: digest[1] });
    return { ...runWithApprovalClient(fixture, env, args), unsignedAttempt: first, unsignedRegistryBytes, unsignedEvidenceExists };
  } finally { fixture.cleanup(); }
}

test("COORD-824 agents recover-lease-registry restores a known-good copy under explicit human-admin authority", () => {
  coord812Harness("coord-824-restore-", ({ identityV2, ticketId, tempDir, run, runWithApprovalClient, envFor, registryFile }) => {
    assert.equal(run(envFor("a"), ["agent-claim", "claudea11"]).ok, true);
    const knownGood = path.join(tempDir, "known-good-instances.json");
    fs.copyFileSync(registryFile, knownGood);
    fs.writeFileSync(registryFile, MALFORMED_REGISTRY);
    const corruptBytes = fs.readFileSync(registryFile);

    const refused = run(envFor("a"), ["heartbeat", ticketId]);
    assert.equal(refused.ok, false);
    assert.ok(refused.error.includes(`agents recover-lease-registry --registry ${registryFile}`), refused.error);

    const recover = (...extra) => run(envFor("a"), ["agents", "recover-lease-registry", "--registry", registryFile, ...extra]);
    const authorized = ["--human-admin-override", "operator approved restoring the last known-good registry"];
    const hash = coord824Sha(registryFile);
    for (const [args, pattern] of [
      [["--expect-sha256", hash, "--restore-from", knownGood], /requires --human-admin-override/],
      [["--expect-sha256", "0".repeat(64), "--restore-from", knownGood, ...authorized], new RegExp(`is now ${hash}`)],
      [["--expect-sha256", hash, ...authorized], /exactly one replacement/],
      [["--expect-sha256", hash, "--restore-from", knownGood, "--force"], /unknown argument "--force"/],
      [["--expect-sha256"], /--expect-sha256 requires a value/],
      // A flag is never another flag's value, and a repeated flag is refused, not last-wins.
      [["--expect-sha256", hash, "--restore-from", knownGood, "--human-admin-override", "--approve-empty"],
        /--human-admin-override requires a value, not the flag "--approve-empty"/],
      [["--expect-sha256", hash, "--human-admin-override", "--restore-from", knownGood],
        /--human-admin-override requires a value, not the flag "--restore-from"/],
      // No --flag=value form: it is an unknown argument, not a smuggled value.
      [["--expect-sha256", hash, "--restore-from", knownGood, "--human-admin-override=--x"],
        /unknown argument "--human-admin-override=--x"/],
      [["--expect-sha256", hash, "--restore-from", knownGood, ...authorized, "--restore-from", knownGood],
        /--restore-from was given more than once/],
      [["--expect-sha256", hash, "--approve-empty", "--approve-empty", ...authorized], /--approve-empty was given more than once/],
    ]) {
      const result = recover(...args);
      assert.equal(result.ok, false, args.join(" "));
      assert.match(result.error, pattern);
      assert.deepEqual(fs.readFileSync(registryFile), corruptBytes);
    }
    assert.equal(coord824Events().some((event) => event.command === "owner-lease-registry-recovery"), false);

    const recovered = runWithSignedRegistryRecovery(run, runWithApprovalClient, envFor("a"),
      ["agents", "recover-lease-registry", "--registry", registryFile, "--expect-sha256", hash, "--restore-from", knownGood, ...authorized]);
    assert.equal(recovered.ok, true, recovered.error);
    assert.match(recovered.unsignedAttempt.error, /requires a signed human-admin approval/);
    assert.deepEqual(recovered.unsignedRegistryBytes, corruptBytes, "reason-only approval leaves the corrupt registry unchanged");
    assert.equal(recovered.unsignedEvidenceExists, false,
      "reason-only approval creates no recovery evidence");
    const output = JSON.parse(recovered.stdout);
    assert.deepEqual(fs.readFileSync(registryFile), fs.readFileSync(knownGood));
    assert.deepEqual(fs.readFileSync(output.evidence.bytes_path), corruptBytes);
    assert.equal(output.actor.handle, "claudea11");
    assert.equal(output.leases.before_known, false, "malformed bytes cannot show the prior leases");
    assert.deepEqual(output.leases.after.map((lease) => [lease.owner, lease.instance_id]), [["claudea11", "coord812-instance-a"]]);
    assert.deepEqual(output.unknown_holders, { leases: [], warning: null }, "a registered handle on a known instance");
    const events = coord824Events().filter((event) => event.command === "owner-lease-registry-recovery");
    assert.equal(events.length, 1);
    assert.equal(events[0].registry_path, registryFile);
    assert.equal(events[0].evidence.bytes_path, output.evidence.bytes_path);
    assert.equal(events[0].actor.handle, "claudea11");
    assert.match(events[0].human_admin_override_reason, /operator approved/);
    assert.ok(events[0].authorization?.human_admin_session, "recovery evidence retains the verified human-admin session");
    assert.match(events[0].authorization?.subject_sha256 || "", /^[0-9a-f]{64}$/);

    // The restored authority is exactly the prior authority.
    const holder = run(envFor("a"), ["heartbeat", ticketId]);
    assert.equal(holder.ok, true, holder.error);
    const candidate = run(envFor("b"), ["heartbeat", ticketId]);
    assert.match(candidate.error, /lease is held by a live instance coord812-instance-a/);
    assert.equal(identityV2.readRegistry(governanceState.RUNTIME_DIR).leases.claudea11.instance_id, "coord812-instance-a");

    const again = recover("--expect-sha256", coord824Sha(registryFile), "--approve-empty", ...authorized);
    assert.equal(again.ok, false);
    assert.match(again.error, /is valid, so there is nothing to recover/);
  });
});

test("COORD-824 a value that starts with -- but is not a recovery flag is accepted verbatim", () => {
  coord812Harness("coord-824-dashvalue-", ({ tempDir, run, runWithApprovalClient, envFor, registryFile }) => {
    assert.equal(run(envFor("a"), ["agent-claim", "claudea11"]).ok, true);
    const knownGood = path.join(tempDir, "known-good-instances.json");
    fs.copyFileSync(registryFile, knownGood);
    fs.writeFileSync(registryFile, MALFORMED_REGISTRY);
    const args = [
      "agents", "recover-lease-registry", "--registry", registryFile, "--expect-sha256", coord824Sha(registryFile),
      "--restore-from", knownGood, "--human-admin-override", "-- see ticket",
    ];
    const recovered = runWithSignedRegistryRecovery(run, runWithApprovalClient, envFor("a"), args);
    assert.equal(recovered.ok, true, recovered.error);
    const [event] = coord824Events().filter((row) => row.command === "owner-lease-registry-recovery");
    assert.equal(event.human_admin_override_reason, "-- see ticket");
    assert.deepEqual(fs.readFileSync(registryFile), fs.readFileSync(knownGood));
  });
});

test("COORD-824 an approved empty registry is an explicit, listed reset that frees the lease", () => {
  coord812Harness("coord-824-empty-", ({ identityV2, ticketId, run, runWithApprovalClient, tempDir, envFor, registryFile }) => {
    assert.equal(run(envFor("a"), ["agent-claim", "claudea11"]).ok, true);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    fs.writeFileSync(registryFile, JSON.stringify({ ...registry, version: 99 }));
    const args = [
      "agents", "recover-lease-registry", "--registry", registryFile, "--expect-sha256", coord824Sha(registryFile),
      "--approve-empty", "--human-admin-override", "operator approved a reset after an unknown-version write",
    ];
    const recovered = runWithSignedRegistryRecovery(run, runWithApprovalClient, envFor("b"), args);
    assert.equal(recovered.ok, true, recovered.error);
    const { leases, replacement } = JSON.parse(recovered.stdout);
    assert.equal(replacement.source, "approved-empty");
    assert.deepEqual(leases.dropped.map((lease) => [lease.owner, lease.instance_id]), [["claudea11", "coord812-instance-a"]]);
    assert.match(leases.warning, /1 lease\(s\) dropped and 0 changed/);
    assert.deepEqual(identityV2.readRegistry(governanceState.RUNTIME_DIR), identityV2.emptyRegistry());
    const takeover = run(envFor("b"), ["heartbeat", ticketId]);
    assert.equal(takeover.ok, true, takeover.error);
  });
});

test("COORD-824 a restored lease for a handle the engine does not know is accepted and listed", () => {
  coord812Harness("coord-824-unknown-", ({ identityV2, tempDir, run, runWithApprovalClient, envFor, registryFile }) => {
    assert.equal(run(envFor("a"), ["agent-claim", "claudea11"]).ok, true);
    const backup = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    backup.leases.claudez99 = { instance_id: "coord812-instance-a", acquired_at: "2026-10-01T00:00:00.000Z" };
    const knownGood = path.join(tempDir, "backup-instances.json");
    fs.writeFileSync(knownGood, JSON.stringify(backup, null, 2) + "\n");
    fs.writeFileSync(registryFile, MALFORMED_REGISTRY);
    const args = [
      "agents", "recover-lease-registry", "--registry", registryFile, "--expect-sha256", coord824Sha(registryFile),
      "--restore-from", knownGood, "--human-admin-override", "operator restoring a real backup",
    ];
    const recovered = runWithSignedRegistryRecovery(run, runWithApprovalClient, envFor("a"), args);
    assert.equal(recovered.ok, true, recovered.error);
    const { unknown_holders: unknown } = JSON.parse(recovered.stdout);
    assert.deepEqual(unknown.leases.map((lease) => [lease.owner, lease.reasons]), [["claudez99", ["handle_not_registered"]]]);
    assert.match(unknown.warning, /1 lease\(s\) in the replacement name a holder the engine does not know/);
    const [event] = coord824Events().filter((row) => row.command === "owner-lease-registry-recovery");
    assert.deepEqual(event.unknown_holders, unknown);
    assert.equal(identityV2.readRegistry(governanceState.RUNTIME_DIR).leases.claudez99.instance_id, "coord812-instance-a");
  });
});

// COORD-811: claim/handoff success is reported only after the lease (and, for a
// handoff, its journal event) is durable. Each write boundary is failed in turn.
function coord811Harness(prefix, ticketId, body) {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  withRegisterPromptHarness(prefix, { ticketId }, ({ tempDir }) => {
    const runtimeDir = path.join(tempDir, ".runtime");
    const envFor = (suffix) => ({
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord811-provider",
      COORD_INSTANCE_ID: `coord811-instance-${suffix}`,
      CLAUDE_CODE_SESSION_ID: `coord811-thread-${suffix}`,
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
    });
    const runClaim = (suffix, args = ["claudea11"]) =>
      governanceModule.executeCommand(["agent-claim", ...args], { env: envFor(suffix) });
    const runSignedClaim = (suffix, args) => {
      const refused = runClaim(suffix, args);
      assert.equal(refused.ok, false, "override reason alone must not authorize an owner-lease handoff");
      assert.match(refused.error, /requires a signed human-admin approval/);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(refused.error);
      assert.ok(digest, refused.error);
      const approval = createApprovalFixture({ allowedVerbs: ["agent claim --human-admin-override"] });
      try {
        approval.login({ verb: "agent claim --human-admin-override", ticket: "claudea11", subject_sha256: digest[1] });
        return withApprovalClient(approval, () => runClaim(suffix, args));
      } finally { approval.cleanup(); }
    };
    const registryFile = identityV2.registryPath(runtimeDir);
    const durableState = () => ({
      registry: fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : null,
      events: fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"),
      sessions: fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"),
    });
    const nonApprovalEvents = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => !String(event.event || "").startsWith("approval."));
    const gate = (suffix) => identityV2.assertCanMutate(
      identityV2.readRegistry(runtimeDir),
      identityV2.readEnvIdentity(envFor(suffix)),
      { owner: "claudea11", requireTicketOwner: false }
    ).decision;
    body({ identityV2, runClaim, runSignedClaim, durableState, nonApprovalEvents, gate, registryFile });
  });
}

// COORD-893 ruling: instance A's session is live on another thread, so each
// handoff below carries the human-admin override the gate now requires.
const COORD893_OVERRIDE = ["--human-admin-override", "authorized fixture handoff"];

test("COORD-811 a first claim whose lease write fails reports failure and binds nothing", () => {
  coord811Harness("coord-811-first-claim-", "C811-001", ({ identityV2, runClaim, durableState, gate, registryFile }) => {
    const before = durableState();
    assert.equal(before.registry, null, "fixture starts with no v2 registry");
    const originalWrite = identityV2.writeRegistry;
    identityV2.writeRegistry = () => { throw new Error("simulated registry persistence failure"); };
    let failed;
    try {
      failed = runClaim("a");
    } finally {
      identityV2.writeRegistry = originalWrite;
    }
    assert.equal(failed.ok, false, "a claim whose lease is not durable must not report success");
    assert.match(failed.error, /owner lease for claudea11 was not persisted/i);
    assert.match(failed.error, /simulated registry persistence failure/);
    assert.equal(failed.stdout, "", "no claim receipt is printed");
    assert.equal(fs.existsSync(registryFile), false, "no lease registry was created");
    const after = durableState();
    assert.equal(after.sessions, before.sessions, "no legacy session binding survives the failed claim");
    assert.equal(after.events.includes("owner-lease-handoff"), false);

    // The same instance can still claim normally once the write succeeds.
    const retried = runClaim("a");
    assert.equal(retried.ok, true, retried.error);
    assert.equal(gate("a").action, "held");
  });
});

test("COORD-811 a handoff whose lease write fails leaves the prior holder authoritative", () => {
  coord811Harness("coord-811-registry-write-", "C811-002", ({ identityV2, runClaim, runSignedClaim, durableState, nonApprovalEvents, gate }) => {
    assert.equal(runClaim("a").ok, true);
    const handedToB = runSignedClaim("b", ["claudea11", "--handoff", "--reason", "a to b", ...COORD893_OVERRIDE]);
    assert.equal(handedToB.ok, true, handedToB.error);
    assert.equal(JSON.parse(handedToB.stdout).owner_lease_handoff.to_instance, "coord811-instance-b");

    const before = durableState();
    const originalWrite = identityV2.writeRegistry;
    identityV2.writeRegistry = () => { throw new Error("simulated registry persistence failure"); };
    let failed;
    try {
      failed = runSignedClaim("d", ["claudea11", "--handoff", "--reason", "b to d", ...COORD893_OVERRIDE]);
    } finally {
      identityV2.writeRegistry = originalWrite;
    }
    assert.equal(failed.ok, false, "a handoff that was not persisted must not report success");
    assert.match(failed.error, /owner lease for claudea11 was not persisted/i);
    assert.equal(failed.stdout, "", "no claim or handoff receipt is printed");
    const after = durableState();
    assert.equal(after.registry, before.registry, "the failed handoff leaves the lease registry byte-identical");
    assert.equal(after.sessions, before.sessions, "the failed handoff leaves legacy sessions byte-identical");
    assert.deepEqual(nonApprovalEvents(after.events), nonApprovalEvents(before.events),
      "approval audit events may persist, but no lease-handoff or claim mutation event is written");

    // Prior holder still passes the v2 gate; the candidate does not.
    assert.deepEqual(gate("b"), { allowed: true, action: "held", handoff: undefined, owner: "claudea11" });
    assert.equal(gate("d").allowed, false);
    assert.equal(gate("d").action, "split-brain");
    const candidate = runClaim("d");
    assert.equal(candidate.ok, false);
    // B's legacy session binding was never released, so the candidate is
    // stopped at the session layer before it even reaches the v2 lease.
    assert.match(candidate.error, /already has an active session/);
    assert.equal(runClaim("b").ok, true, "the prior durable holder can still claim");
  });
});

test("COORD-811 a handoff whose journal append fails is rolled back, not reported", () => {
  coord811Harness("coord-811-journal-append-", "C811-003", ({ runClaim, runSignedClaim, durableState, nonApprovalEvents, gate, registryFile }) => {
    assert.equal(runClaim("a").ok, true);
    const before = durableState();

    const originalWrite = fs.writeFileSync;
    let rejectedHandoffAudit = false;
    fs.writeFileSync = function (file, data, ...args) {
      if (!rejectedHandoffAudit && typeof data === "string") {
        try {
          if (JSON.parse(data).command === "owner-lease-handoff") {
            rejectedHandoffAudit = true;
            throw new Error("simulated handoff audit append failure");
          }
        } catch (error) {
          if (error.message === "simulated handoff audit append failure") throw error;
        }
      }
      return originalWrite.call(this, file, data, ...args);
    };
    let failed;
    try {
      failed = runSignedClaim("b", ["claudea11", "--handoff", "--reason", "recover after restart", ...COORD893_OVERRIDE]);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(rejectedHandoffAudit, true, "the targeted owner-handoff event write must fail");
    assert.equal(failed.ok, false, "an unjournaled handoff must not report success");
    assert.match(failed.error, /handoff .* could not be journaled/i);
    assert.match(failed.error, /simulated handoff audit append failure/);
    assert.equal(failed.stdout, "", "no claim or handoff receipt is printed");

    const after = durableState();
    assert.equal(after.registry, before.registry, "the lease transfer and revocation were rolled back byte-for-byte");
    assert.equal(after.sessions, before.sessions, "no legacy session binding survives the failed handoff");
    assert.deepEqual(nonApprovalEvents(after.events), nonApprovalEvents(before.events),
      "approval audit events may persist, but failed handoff writes no mutation event");
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(registry.leases.claudea11.instance_id, "coord811-instance-a");
    assert.equal(registry.instances.find((i) => i.instance_id === "coord811-instance-a").status, "active");

    assert.equal(gate("a").action, "held");
    assert.equal(gate("b").action, "split-brain");
    assert.equal(runClaim("b").ok, false, "the candidate still needs an explicit handoff");
    assert.equal(runClaim("a").ok, true, "the prior durable holder can still claim");

    // With the journal healthy the same handoff completes and is journaled once.
    const completed = runSignedClaim("b", ["claudea11", "--handoff", "--reason", "recover after restart", ...COORD893_OVERRIDE]);
    assert.equal(completed.ok, true, completed.error);
    assert.equal(JSON.parse(completed.stdout).owner_lease_handoff.from_instance, "coord811-instance-a");
    const handoffEvents = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.command === "owner-lease-handoff");
    assert.equal(handoffEvents.length, 1);
    assert.equal(handoffEvents[0].to_instance, "coord811-instance-b");
    assert.equal(gate("b").action, "held");
    assert.equal(gate("a").action, "revoked");
  });
});

test("COORD-811 a handoff whose journal append and lease rollback both fail says so and reports no handoff", () => {
  coord811Harness("coord-811-rollback-failure-", "C811-004", ({ identityV2, runClaim, runSignedClaim, durableState, nonApprovalEvents }) => {
    assert.equal(runClaim("a").ok, true);
    const before = durableState();
    const originalWrite = fs.writeFileSync;
    const originalRestore = identityV2.restoreRegistry;
    fs.writeFileSync = function (file, data, ...args) {
      if (typeof data === "string" && data.includes('"command":"owner-lease-handoff"')) {
        throw new Error("simulated handoff audit append failure");
      }
      return originalWrite.call(this, file, data, ...args);
    };
    identityV2.restoreRegistry = () => { throw new Error("simulated lease rollback failure"); };
    let failed;
    try {
      failed = runSignedClaim("b", ["claudea11", "--handoff", ...COORD893_OVERRIDE]);
    } finally {
      fs.writeFileSync = originalWrite;
      identityV2.restoreRegistry = originalRestore;
    }
    assert.equal(failed.ok, false);
    assert.match(failed.error, /could not be journaled \(simulated handoff audit append failure\)/);
    assert.match(failed.error, /Rolling the lease transfer back ALSO failed \(simulated lease rollback failure\)/);
    assert.match(failed.error, /instances\.json/);
    assert.equal(failed.stdout, "", "no claim or handoff receipt is printed");
    const after = durableState();
    assert.equal(after.sessions, before.sessions);
    assert.deepEqual(nonApprovalEvents(after.events), nonApprovalEvents(before.events),
      "approval audit events may persist, but no lease-handoff mutation event is written");
  });
});

test("COORD-638 start transition keeps its lifecycle gates after the owner-lease preflight", () => {
  const { GovernanceError } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const build = (overrides = {}) => {
    const row = { ID: "C638-DI", Repo: "X", Status: "todo", Owner: "unassigned", Description: "DI start" };
    const board = { sections: [{ rows: [row] }], review_findings: {} };
    const calls = [];
    const noop = () => {};
    const deps = Object.fromEntries(createTicketTransitions.DEP_CONTRACT.callable.map((name) => [name, noop]));
    Object.assign(deps, {
      fail: (message) => { throw new GovernanceError(message); },
      readBoard: () => board,
      getTicketRef: (_board, id) => id === row.ID ? { row } : null,
      rowsById: () => new Map([[row.ID, row]]),
      inferTicketStatus: () => row.Status,
      withGovernanceMutation: (_mutation, fn) => fn(),
      resolveOwnerIdentity: (_owner, options) => {
        assert.equal(options.requireHeldOwnerLease, true);
        calls.push("lease-preflight");
        return { agent: { handle: "codexa42" }, session: { thread_id: "thread-42" }, autoClaimed: false };
      },
      detectColocatedForeignSessions: () => ({ present: false, foreign_sessions: [] }),
      buildColocatedForeignSessionMessage: () => "colocated",
      evaluateReadiness: () => ({ blockedBy: [], blockerChains: [], cycles: [] }),
      formatTransitiveBlockerDetails: () => "",
      formatDependencyCycleList: () => "",
      buildHistoricalCloseoutStartBlocker: () => null,
      buildStartOwnershipRaceMessage: (id, current) => `Ticket ${id} is \"${current.Status}\" and cannot start`,
      assertPromptRecord: (_ticketId, _row, _board, options) => {
        options.resolvePreconditionRef?.();
        return calls.push("preconditions");
      },
      findDoingTicketForOwner: () => null,
      canOwnerHoldConcurrentDoing: () => false,
      runBoardValidate: () => calls.push("validate"),
      ensurePlanStub: () => ({ createdMarkdownBlock: false }),
      updateCanonicalPlanState: () => calls.push("plan-update"),
      buildStartPlanSeedUpdate: () => ({}),
      seedStartIntendedFilesFromPrompt: () => calls.push("seed-files"),
      assertStartPlanReady: () => {},
      buildStartPlanBootstrapCommand: () => "gov plan bootstrap C638-DI",
      isRepoBackedCode: () => false,
      resolveTicketBaseRef: () => "dev",
      BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
      resolveTicketLockPath: () => "/tmp/coord638-no-lock",
      defaultWorktreePath: () => "/tmp/coord638-worktree",
      slugify: (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      repoNameForCode: () => "coord",
      withPreparedTicketWorkspace: (_options, fn) => fn(),
      withCoordStateLock: (fn) => fn(),
      applyTicketStatus: (_ref, status) => { row.Status = status; },
      assignTicketOwner: (_ref, owner) => { row.Owner = owner; },
      writeBoard: () => calls.push("write-board"),
      writeLock: () => calls.push("write-lock"),
      runBoardSync: () => calls.push("sync"),
      ...overrides,
    });
    return { transitions: createTicketTransitions(deps), row, board, calls };
  };

  assert.throws(() => build().transitions.startTicket(undefined, {}), /start-ticket requires <ticket-id>/);
  assert.throws(() => build().transitions.startTicket("C638-MISSING", { owner: "codexa42", allowSharedWorktree: true }), /Unknown ticket/);
  assert.throws(() => build({ getTicketRef: (_board, id) => id === "C638-DI" ? { row: { ID: "C638-DI", Repo: "X", Status: "review", Owner: "codexa42" } } : null })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), (error) => error.message.includes('is "review"'));
  assert.throws(() => build({ detectColocatedForeignSessions: () => ({ present: true, foreign_sessions: [{ handle: "codexa99" }] }) })
    .transitions.startTicket("C638-DI", { owner: "codexa42" }), /colocated/);
  assert.throws(() => build({ buildHistoricalCloseoutStartBlocker: () => ({ message: "historical block", next_steps: ["resolve first"] }) })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /historical block[\s\S]*resolve first/);
  assert.throws(() => build({ evaluateReadiness: () => ({ blockedBy: ["C638-BLOCKER"], blockerChains: [{ chain: ["C638-BLOCKER"] }], cycles: [["C638-DI", "C638-BLOCKER"]] }), formatTransitiveBlockerDetails: () => "via C638-BLOCKER", formatDependencyCycleList: () => "C638-DI -> C638-BLOCKER" })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /blocked by C638-BLOCKER[\s\S]*Transitive blocker chains: via C638-BLOCKER[\s\S]*Dependency cycle/);
  assert.throws(() => build({ evaluateReadiness: () => ({ blockedBy: ["C638-BLOCKER"], blockerChains: [], cycles: [] }) })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), (error) => {
      assert.match(error.message, /blocked by C638-BLOCKER/);
      assert.doesNotMatch(error.message, /Transitive blocker chains|Dependency cycle/);
      return true;
    });
  assert.throws(() => build({ assertPromptRecord: () => { throw new Error("Ticket C638-DI cannot start without prompt coverage or a recorded waiver."); } })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /without prompt coverage/);
  // COORD-963: the owner WIP cap is retired; an owner's other doing ticket no longer refuses start.
  try {
    build({ findDoingTicketForOwner: () => ({ ID: "C638-OTHER" }) })
      .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true });
  } catch (error) {
    assert.doesNotMatch(error.message, /already has an active doing ticket/);
  }
  assert.throws(() => build({ assertStartPlanReady: () => { throw new GovernanceError("attestation missing"); }, ensurePlanStub: () => ({ createdMarkdownBlock: true }) })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /Compatibility PLAN.md block prepared[\s\S]*gov plan bootstrap/);
  assert.throws(() => build({ assertStartPlanReady: () => { throw new GovernanceError("attestation missing"); } })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /Plan state already existed[\s\S]*gov plan bootstrap/);
  assert.throws(() => build({ assertStartPlanReady: () => { throw new TypeError("unexpected plan error"); } })
    .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /unexpected plan error/);
  const existingLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord638-existing-lock-"));
  const existingLockPath = path.join(existingLockDir, "C638-DI.lock");
  fs.writeFileSync(existingLockPath, "fixture lock\n", "utf8");
  try {
    assert.throws(() => build({ resolveTicketLockPath: () => existingLockPath, recordGovernanceCollision: () => {} })
      .transitions.startTicket("C638-DI", { owner: "codexa42", allowSharedWorktree: true }), /Lock file already exists/);
  } finally {
    fs.rmSync(existingLockDir, { recursive: true, force: true });
  }

  const started = build({
    isRepoBackedCode: () => true,
    getRepoRoot: () => "/tmp/coord638-repo",
    fetchRepoRef: () => true,
    resolveCommitishInRepo: (_root, ref) => { assert.equal(ref, "origin/dev"); return "immutable-base"; },
    ensurePlanStub: () => ({ createdMarkdownBlock: true }),
    assertStartPlanReady: () => {},
  });
  started.transitions.startTicket("C638-DI", {
    owner: "codexa42", branch: "agent/codexa42-c638-di", worktree: "/tmp/coord638-explicit-worktree", base: "dev", allowSharedWorktree: true,
  });
  assert.equal(started.row.Status, "doing");
  assert.equal(started.row.Owner, "codexa42");
  assert.deepEqual(started.calls.filter((call) => ["lease-preflight", "preconditions", "validate", "plan-update", "seed-files", "write-board", "write-lock", "sync"].includes(call)),
    ["lease-preflight", "preconditions", "validate", "plan-update", "seed-files", "write-board", "write-lock", "sync"]);

  let localBaseRef;
  const localBaseFallback = build({
    isRepoBackedCode: () => true,
    getRepoRoot: () => "/tmp/coord638-repo",
    fetchRepoRef: () => false,
    resolveCommitishInRepo: (_root, ref) => { assert.equal(ref, "dev"); return "immutable-local-base"; },
    assertPromptRecord: (_ticketId, _row, _board, options) => {
      localBaseRef = options.resolvePreconditionRef();
      throw new Error("stop after precondition reference selection");
    },
  });
  assert.throws(
    () => localBaseFallback.transitions.startTicket("C638-DI", { owner: "codexa42", base: "dev", allowSharedWorktree: true }),
    /stop after precondition reference selection/
  );
  assert.equal(localBaseRef, "dev", "when fetch is unavailable, start validates against the configured local base ref");

  const recoveredIdentity = build({
    resolveOwnerIdentity: (_owner, options) => {
      assert.equal(options.requireHeldOwnerLease, true);
      return { agent: { handle: "codexa42" }, session: null, autoClaimed: true };
    },
    detectColocatedForeignSessions: (options) => {
      assert.deepEqual(options, {});
      return { present: false, foreign_sessions: [] };
    },
  });
  recoveredIdentity.transitions.startTicket("C638-DI", { owner: "codexa42" });
  assert.equal(recoveredIdentity.row.Status, "doing");
  assert.ok(recoveredIdentity.calls.includes("write-lock"), "a trusted held lease without a legacy session still starts and writes the lock");
});

test("resolveCurrentAgentId auto-assign increments from the highest board-referenced user", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-agentid-high-water-"));
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
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
  }, () => {
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
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("buildAgentStatusPayload surfaces idle sessions as release candidates for orchestrator use", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-agent-status-release-"));
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
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
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
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
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

  const originalThread = process.env.AGENT_THREAD_ID;
  return withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    RUNTIME_DIR: runtimeDir,
  }, () => {
  try {
    process.env.AGENT_THREAD_ID = "thread-current";

    const held = governanceCommands.releaseTerminalTicketSession(ticketId, {
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

    const result = governanceCommands.releaseTerminalTicketSession(ticketId, {
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
    assert.equal(sessions.find((s) => s.session_id === "a00-current").release_reason, "terminal");
    assert.ok(sessions.find((s) => s.session_id === "a00-current").released_at);
    assert.equal(sessions.find((s) => s.session_id === "a00-other").status, "active");
  } finally {
    if (originalThread === undefined) {
      delete process.env.AGENT_THREAD_ID;
    } else {
      process.env.AGENT_THREAD_ID = originalThread;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("rebindAgent --fresh releases current session and claims a new unclaimed handle (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-rebind-fresh-"));
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
  const occupiedSession = {
    session_id: "a12-active",
    agent_id: "a12",
    handle: "claudea12",
    board_path: governanceState.BOARD_PATH,
    thread_id: "other-thread",
    claimed_at: now,
    last_seen_at: now,
    status: "active",
  };
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a11-old",
      agent_id: "a11",
      handle: "claudea11",
      board_path: governanceState.BOARD_PATH,
      thread_id: "claude-rebind-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    occupiedSession,
  ], null, 2));

  // Snapshot every path that withGovernanceMutation could write to, so the
  // mutation's journal entries stay inside the temp dir instead of leaking
  // into the live coord/.runtime/governance-events.ndjson and triggering
  // spurious "changed_paths references /tmp/..." drift on later doctor runs.
  const original = {
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  const stdoutLines = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    RUNTIME_DIR: runtimeDir,
  }, () => {
  process.env.CLAUDE_SESSION_ID = "claude-rebind-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    governanceCommands.rebindAgent({ fresh: true });

    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));

    // Released the original session.
    const oldSession = sessionsAfter.find((s) => s.session_id === "a11-old");
    assert.equal(oldSession.status, "released", "previous session must be released");
    assert.ok(oldSession.released_at, "previous session must carry released_at timestamp");

    const activeSessions = sessionsAfter.filter((s) => s.status === "active");
    assert.deepEqual(activeSessions.map((s) => s.handle).sort(), ["claudea12", "claudea13"]);
    assert.deepEqual(activeSessions.find((s) => s.session_id === occupiedSession.session_id), occupiedSession);
    const newSession = activeSessions.find((s) => s.handle === "claudea13");
    assert.equal(newSession.binding_sequence, 1, "fresh rebind records order after legacy history");
    assert.equal(newSession.thread_id, "claude-rebind-thread",
      "thread_id carries over so gov initiate in this process resolves to the new handle");

    // stdout contains both previous and current identity.
    const output = stdoutLines.join("\n");
    assert.match(output, /"handle": "claudea11"/, "output must name the previous handle");
    assert.match(output, new RegExp(`"handle": "${newSession.handle}"`), "output must name the new handle");
    assert.match(output, /Released claudea11/, "output must announce the release");
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("rebindAgent --fresh works when there is no prior binding (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-rebind-empty-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const runtimeDir = path.join(tempDir, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  const stdoutLines = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    RUNTIME_DIR: runtimeDir,
  }, () => {
  process.env.CLAUDE_SESSION_ID = "fresh-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => { stdoutLines.push(args.join(" ")); };
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    governanceCommands.rebindAgent({ fresh: true });

    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const activeSessions = sessionsAfter.filter((s) => s.status === "active");
    assert.equal(activeSessions.length, 1, "exactly one active session created");
    assert.equal(activeSessions[0].handle, "claudea11", "claims the only available handle in the pool");

    const output = stdoutLines.join("\n");
    assert.match(output, /"previous": null/, "output must report no prior binding");
    assert.match(output, /No prior binding to release/, "output must announce the empty-state case");
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("rebindAgent --fresh fails closed when the provider pool is exhausted (GOV-013)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-rebind-exhausted-"));
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
      board_path: governanceState.BOARD_PATH,
      thread_id: "claude-exhausted-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.writeFileSync(questionsPath, "# Questions\n\n## Instructions\n");
  const original = {
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: snapshotsDir,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  process.env.CLAUDE_SESSION_ID = "claude-exhausted-thread";
  process.env.CLAUDECODE = "1";
  delete process.env.CODEX_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.throws(
      () => governanceCommands.rebindAgent({ fresh: true }),
      /No unclaimed anthropic handle available/,
      "must fail closed when pool is exhausted (caller must register another handle first)"
    );

    // The caller's original session must remain active — rebind must roll back on failure.
    const sessionsAfter = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    const survivor = sessionsAfter.find((s) => s.session_id === "a11-only");
    assert.equal(survivor.status, "active",
      "failed rebind must not leave the caller unbound (transactional rollback)");
  } finally {
    for (const key of ["CLAUDE_SESSION_ID", "CLAUDECODE", "CODEX_THREAD_ID", "AGENT_THREAD_ID"]) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
  });
});

test("resolveCurrentAgentId can claim an explicit owner for the current thread", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-agentid-owner-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents-legacy.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions-legacy.json");
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2));

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  return withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
  }, () => {
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
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  });
});

test("COORD-011: a fresh same-owner other-thread Codex session cannot rebind a live ticket lock", () => {
  // Two fresh Codex threads share owner codexa00 against one doing ticket.
  // Thread A holds the lock; thread B (the current session) must NOT be able to
  // resume/claim it without an explicit human-admin override.
  const ticketId = "MSRV-011";
  const owner = "codexa00";
  const threadA = "codex-thread-A";
  const threadB = "codex-thread-B";
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("coord011-");

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
    repo: repoRegistryOwner.repoNameForCode("B"),
    branch: `agent/${owner}-${ticketId.toLowerCase()}`,
    head: "deadbeef",
    worktree: path.join(backendRoot, ".worktrees", owner, ticketId),
    started_at_utc: now,
    heartbeat_utc: now,
    session_id: "a00-aaaa",
  }, null, 2)}\n`, "utf8");

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });

  const logs = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { B: backendRoot },
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PROMPTS_DIR: path.join(coordRoot, "prompts"),
    RENDERED_DIR: path.join(coordRoot, "rendered"),
    PLAN_RECORDS_DIR: path.join(coordRoot, ".runtime", "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(coordRoot, "board", "plans"),
    LOCKS_DIR: path.join(coordRoot, ".runtime", "locks"),
    LEGACY_LOCKS_DIR: path.join(coordRoot, "locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  process.env.CODEX_THREAD_ID = threadB;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

    // Unit: the detector sees thread A as a live same-owner other-thread holder
    // from thread B's perspective, and ignores the released thread-C session.
    const fromB = sessionOwner.detectActiveSameOwnerOtherThread(ticketId, lock, { currentThreadId: threadB });
    assert.equal(fromB.present, true);
    assert.equal(fromB.active_owner_sessions.length, 1);
    assert.equal(fromB.active_owner_sessions[0].thread_id, threadA);

    // The holder thread itself sees no contending other-thread (B is excluded as
    // self; the released session never contends).
    const lockHeldByAOnly = { ...lock };
    const sessionsHolderOnly = [sessionA, sessionReleased];
    const fromA = sessionOwner.detectActiveSameOwnerOtherThread(ticketId, lockHeldByAOnly, {
      currentThreadId: threadA,
      sessions: sessionsHolderOnly,
    });
    assert.equal(fromA.present, false);

    // Integration: resume (force:true) from thread B must fail closed.
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    assert.throws(
      () => governanceCommands.resumeTicket(ticketId),
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
    governanceCommands.explainTicket(ticketId);
    const explainPayload = JSON.parse(logs.find((line) => line.trim().startsWith("{")) || "{}");
    assert.equal(explainPayload.active_same_owner_other_thread.present, true);
    assert.equal(explainPayload.active_same_owner_other_thread.active_owner_sessions[0].thread_id, threadA);

    // COORD-222: from thread B's vantage, the live thread-A session is also a
    // co-located FOREIGN session on the same runtime (the gate is owner-agnostic).
    // The detector sees it; the released thread-C session is ignored (not fresh-active).
    const colocatedFromB = sessionOwner.detectColocatedForeignSessions({ currentThreadId: threadB });
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
    for (const key of ["CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "AGENT_THREAD_ID"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
  });
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
// A downstream installation never passed `ensureGovernedWorkspaceForTicket`
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

// COORD-723 added a pre-effect acknowledgement check to claimTicket. These
// cases pin the claim decisions around it against recording collaborators, so
// each refusal is shown to happen before the effect it protects.
const UNJOURNALED_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "coord-1034-runtime-"));
function claimTicketHarness({ rows, lock = null, identity, transferPayload = null, sameOwnerOtherThread = false, colocated = false, planRecordsDir = null, gitContext = null, onBoardRead = () => {}, dependencyOverrides = {} }) {
  const calls = { identity: 0, boardReads: 0, boardWrites: 0, boardSyncs: 0, rebinds: [], lockWrites: [], collisions: [], ownerProbes: [], colocatedProbes: [], mutation: null };
  const board = { rows };
  let currentLock = lock;
  const commands = createAgentCommandsFactory({
    ...completeAgentCommandDeps(),
    STATUS: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-constants.js")).STATUS,
    // RUNTIME_DIR is an empty directory with no governance journal: no approval record is used yet (ADR 0031 single use).
    state: { PLAN_RECORDS_DIR: planRecordsDir, LEGACY_PLAN_RECORDS_DIR: null, RUNTIME_DIR: UNJOURNALED_RUNTIME_DIR },
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (mutation, action) => { calls.mutation = mutation; return action(); },
    withAgentStateLock: () => transferPayload,
    inferTicketStatus: (ticketId) => rows[ticketId]?.Status || null,
    withCoordStateLock: (action) => action(),
    readAgentsRegistry: () => {
      const agent = transferPayload?.agent || { id: "id-ownerb", handle: "ownerb", provider: "anthropic", status: "active" };
      return [agent];
    },
    readAgentSessions: () => [],
    resolveAgentIdentifier: (subject, agents) => {
      const agent = agents.find((candidate) => candidate.handle === subject || candidate.id === subject);
      return agent ? { agent } : null;
    },
    detectRuntimeProvider: () => "anthropic",
    identityV2: { readEnvIdentity: () => ({ present: false }) },
    readBoard: () => { calls.boardReads += 1; onBoardRead(calls.boardReads, rows); return board; },
    writeBoard: () => { calls.boardWrites += 1; },
    runBoardSync: () => { calls.boardSyncs += 1; },
    getTicketRef: (source, ticketId) => (source.rows[ticketId] ? { row: source.rows[ticketId] } : null),
    isDoingStatus: (status) => status === "doing",
    canonicalizeOwnerOrFail: (owner) => String(owner).trim().toLowerCase(),
    ensureCurrentAgentIdentity: () => { calls.identity += 1; return identity; },
    currentRuntimeThreadId: () => "runtime-thread",
    findLockForTicket: () => currentLock,
    resolveTicketGitContext: () => gitContext,
    writeLock: (written) => { calls.lockWrites.push(written); currentLock = { ticket: written.ticketId, owner: written.owner, branch: written.branch, worktree: written.worktree, session_id: null }; },
    rebindTicketLock: (current, agent, session, extra) => { calls.rebinds.push([current, agent, session, extra]); return { ...current, owner: agent.handle }; },
    detectActiveSameOwnerOtherThread: (ticketId, probedLock, { currentThreadId }) => {
      calls.ownerProbes.push([probedLock, currentThreadId]);
      return { present: sameOwnerOtherThread };
    },
    buildActiveSameOwnerOtherThreadMessage: (ticketId) => `active_same_owner_other_thread ${ticketId}`,
    detectColocatedForeignSessions: ({ currentThreadId }) => {
      calls.colocatedProbes.push(currentThreadId);
      return { present: colocated, current_thread_id: currentThreadId, foreign_sessions: colocated ? [{ thread_id: "foreign-thread" }] : [] };
    },
    buildColocatedForeignSessionMessage: (verb) => `co-located refusal for ${verb}`,
    recordGovernanceCollision: (collision) => { calls.collisions.push(collision); },
    ...dependencyOverrides,
  });
  const run = (ticketId, options) => {
    const lines = [];
    const originalLog = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      commands.claimTicket(ticketId, options);
    } finally {
      console.log = originalLog;
    }
    return JSON.parse(lines.join("\n"));
  };
  return { calls, run, commands };
}

// The optimistic claim reads the board twice: once to decide, and again under
// the coord state lock to commit. Another writer can land between the two, so
// the locked re-read re-checks the ticket and must refuse without writing.
test("COORD-723: an optimistic claim refuses when the board changes before the locked re-read", () => {
  const identity = { agent: { id: "id-ownera", handle: "ownera" }, session: { session_id: "ownera-session", handle: "ownera" } };
  const todo = () => ({ "T-1": { ID: "T-1", Repo: "X", Status: "todo", Owner: "unassigned" } });
  const refusedUnwritten = (harness) => {
    assert.equal(harness.calls.boardReads, 2, "the refusal comes from the locked re-read, not the first read");
    assert.equal(harness.calls.identity, 1);
    assert.equal(harness.calls.boardWrites, 0);
    assert.equal(harness.calls.boardSyncs, 0);
    assert.deepEqual(harness.calls.lockWrites, []);
    assert.deepEqual(harness.calls.rebinds, []);
    assert.equal(harness.calls.mutation.details, undefined, "no claim was recorded on the mutation");
  };

  // Control: with a stable board the same call commits the owner exactly once.
  const stableRows = todo();
  const stable = claimTicketHarness({ rows: stableRows, identity });
  const payload = stable.run("T-1", { optimistic: true });
  assert.equal(stable.calls.boardReads, 2);
  assert.equal(stable.calls.boardWrites, 1);
  assert.equal(stable.calls.boardSyncs, 1);
  assert.equal(stableRows["T-1"].Owner, "ownera");
  assert.equal(payload.owner, "ownera");
  assert.equal(payload.lock_created, false);

  // The ticket is removed from the board between the two reads.
  const removedRows = todo();
  const removed = claimTicketHarness({ rows: removedRows, identity, onBoardRead: (read, rows) => { if (read === 2) delete rows["T-1"]; } });
  assert.throws(() => removed.run("T-1", { optimistic: true }), /^Error: Unknown ticket "T-1"\.$/);
  refusedUnwritten(removed);

  // Another session starts the ticket between the two reads.
  const startedRows = todo();
  const started = claimTicketHarness({ rows: startedRows, identity, onBoardRead: (read, rows) => { if (read === 2) rows["T-1"] = { ...rows["T-1"], Status: "doing", Owner: "ownerb" }; } });
  assert.throws(
    () => started.run("T-1", { optimistic: true }),
    /^Error: Optimistic claim conflict for T-1: status changed to "doing" before claim commit\. Re-read the ticket and use resume\/start as appropriate\.$/,
  );
  refusedUnwritten(started);
  assert.deepEqual(startedRows["T-1"], { ID: "T-1", Repo: "X", Status: "doing", Owner: "ownerb" }, "the concurrent writer's row is left exactly as it landed");
});

test("COORD-723: claimTicket refuses before the effect each claim guard protects", (t) => {
  // ADR 0031 (COORD-1034): each transfer below needs a fixture-signed record for its own row.
  const approvalFixture = createApprovalFixture();
  const restoreApproval = installApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client());
  t.after(() => {
    restoreApproval();
    approvalFixture.cleanup();
  });
  const signAndRunTransfer = (harness, options) => {
    let refusal = null;
    try { harness.run("T-1", options); } catch (error) { refusal = error; }
    assert.ok(refusal, "a reason-only transfer request must refuse before authorization");
    assert.match(String(refusal.message), /requires a signed human-admin approval/);
    const subject = /Subject digest: ([0-9a-f]{64})/.exec(String(refusal.message));
    assert.ok(subject, String(refusal.message));
    approvalFixture.login({ verb: "claim --transfer-to", ticket: "T-1", subject_sha256: subject[1] });
    try { return { subject: subject[1], value: harness.run("T-1", options), error: null }; }
    catch (error) { return { subject: subject[1], value: null, error }; }
  };
  const session = (handle, extra = {}) => ({ session_id: `${handle}-session`, handle, ...extra });
  const identityOf = (handle, extra) => ({ agent: { id: `id-${handle}`, handle }, session: session(handle, extra) });
  const doing = (owner) => ({ "T-1": { ID: "T-1", Repo: "X", Status: "doing", Owner: owner } });
  const untouched = (calls) => {
    assert.equal(calls.boardWrites, 0);
    assert.equal(calls.boardSyncs, 0);
    assert.deepEqual(calls.lockWrites, []);
    assert.deepEqual(calls.rebinds, []);
  };

  const unknown = claimTicketHarness({ rows: {}, identity: identityOf("ownera") });
  assert.throws(() => unknown.run("T-404"), /^Error: Unknown ticket "T-404"\.$/);
  assert.equal(unknown.calls.identity, 0, "an unknown ticket is refused before any identity or session work");
  untouched(unknown.calls);

  const unowned = claimTicketHarness({ rows: doing("unassigned"), identity: identityOf("ownera") });
  assert.throws(() => unowned.run("T-1"), /Ticket T-1 has no assigned owner to claim\. Use start\/repair first/);
  assert.equal(unowned.calls.identity, 0);
  untouched(unowned.calls);

  const wrongOwnerFlag = claimTicketHarness({ rows: doing("ownera"), identity: identityOf("ownera") });
  assert.throws(() => wrongOwnerFlag.run("T-1", { owner: "OwnerB" }), /Ticket T-1 is owned by ownera; received --owner ownerb\./);
  assert.equal(wrongOwnerFlag.calls.identity, 0, "a contradicting --owner is refused before the session is consulted");
  untouched(wrongOwnerFlag.calls);

  const foreign = claimTicketHarness({ rows: doing("ownera"), identity: identityOf("ownerb") });
  assert.throws(() => foreign.run("T-1"), /Current session is ownerb \(id-ownerb\) and cannot resume or claim it\..*coord\/scripts\/gov claim T-1 --transfer-to ownerb --human-admin-override "<why the transfer is authorized>"$/);
  assert.deepEqual(foreign.calls.ownerProbes, [], "a foreign session is refused before any lock is probed");
  untouched(foreign.calls);

  // A session with no recorded thread falls back to the runtime thread for both
  // live-session guards; a matching --owner is accepted; with no lock there is
  // nothing to rebind and no prior session to report.
  const lockless = claimTicketHarness({ rows: doing("ownera"), identity: identityOf("ownera") });
  const locklessPayload = lockless.run("T-1", { owner: "OwnerA" });
  assert.deepEqual(lockless.calls.ownerProbes, [[null, "runtime-thread"]]);
  assert.deepEqual(lockless.calls.colocatedProbes, ["runtime-thread"]);
  assert.equal(locklessPayload.previous_session_id, null);
  assert.equal(locklessPayload.lock, null);
  assert.equal(locklessPayload.transferred, false);
  assert.equal(locklessPayload.owner, "ownera");
  untouched(lockless.calls);

  // A recorded session thread is the one both guards are asked about, and the
  // held lock is rebound to the claiming session.
  const heldLock = { ticket: "T-1", owner: "ownera", session_id: "prior-session" };
  const held = claimTicketHarness({ rows: doing("ownera"), lock: heldLock, identity: identityOf("ownera", { thread_id: "session-thread" }) });
  const heldPayload = held.run("T-1");
  assert.deepEqual(held.calls.ownerProbes, [[heldLock, "session-thread"]]);
  assert.deepEqual(held.calls.colocatedProbes, ["session-thread"]);
  assert.equal(heldPayload.previous_session_id, "prior-session");
  assert.equal(held.calls.rebinds.length, 1);
  assert.equal(held.calls.rebinds[0][0], heldLock);

  // One governed writer per runtime: the refusal is journaled as a collision
  // and the lock is left with its holder.
  const crowded = claimTicketHarness({ rows: doing("ownera"), lock: heldLock, identity: identityOf("ownera", { thread_id: "session-thread" }), colocated: true });
  assert.throws(() => crowded.run("T-1"), /^Error: co-located refusal for claim$/);
  assert.deepEqual(crowded.calls.collisions, [{
    ticket: "T-1",
    conflictType: "co-located-session",
    verb: "claim",
    contenders: [{ thread_id: "foreign-thread" }],
    extra: { current_thread_id: "session-thread" },
  }]);
  untouched(crowded.calls);
  const shared = claimTicketHarness({ rows: doing("ownera"), lock: heldLock, identity: identityOf("ownera", { thread_id: "session-thread" }), colocated: true });
  shared.run("T-1", { allowSharedWorktree: true });
  assert.deepEqual(shared.calls.colocatedProbes, [], "--allow-shared-worktree opts out of the co-located guard");
  assert.equal(shared.calls.rebinds.length, 1);

  const unsignedOverride = claimTicketHarness({ rows: doing("ownera"), lock: heldLock, identity: identityOf("ownera") });
  assert.throws(() => unsignedOverride.run("T-1", { humanAdminOverride: "bare reason is not approval" }),
    /requires a signed human-admin approval/);
  assert.equal(unsignedOverride.calls.mutation.details, undefined, "unsigned same-owner override refuses before mutation");
  untouched(unsignedOverride.calls);

  // COORD-729: a transfer of a doing ticket whose lock is missing must not
  // displace a live previous owner; nothing is rebuilt, written or transferred.
  const transferee = { agent: { id: "id-ownerb", handle: "ownerb", provider: "anthropic", status: "active" }, session: session("ownerb"), canonical_owner: "ownerb" };
  const liveOwner = claimTicketHarness({ rows: doing("ownera"), identity: identityOf("ownerb"), transferPayload: transferee, sameOwnerOtherThread: true });
  const liveTransfer = signAndRunTransfer(liveOwner, { transferTo: "ownerb", humanAdminOverride: "authorized transfer" });
  const expectedTransferSubject = liveTransfer.subject;
  assert.match(String(liveTransfer.error), /^Error: active_same_owner_other_thread T-1$/);
  assert.deepEqual(liveOwner.calls.ownerProbes, [[{ owner: "ownera", status: "doing", session_id: null }, "runtime-thread"]], "with the lock gone, ownership is probed from the board row");
  // COORD-893: a transfer journals the forced rebind it caused; none here.
  const { approval_record, approval_verified, approval_subject_sha256, human_admin_session, ...mutationDetails } = liveOwner.calls.mutation.details;
  assert.deepEqual(mutationDetails, { previous_owner: "ownera", previous_session_id: null, transfer_to: "ownerb", override_reason: "authorized transfer", legacy_force_alias: false, forced_rebind: null });
  assert.match(approval_record, /^[a-f0-9]{32}$/);
  assert.match(approval_verified, /^key_id=[a-f0-9]{64}$/);
  assert.match(approval_subject_sha256, /^[a-f0-9]{64}$/);
  assert.equal(approval_subject_sha256, expectedTransferSubject);
  assert.ok(human_admin_session);
  untouched(liveOwner.calls);

  // COORD-725: with no live previous owner, the missing lock is rebuilt in the
  // PREVIOUS owner's name from the ticket's own registered worktree, and only
  // then rebound to the transferee with the transfer attested on the lock.
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord723-claim-restore-")));
  try {
    const git = (...args) => require("node:child_process").execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "dev");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "seed");
    const worktree = path.join(repoRoot, ".worktrees", "T-1");
    git("worktree", "add", "-q", "-b", "agent/ownera-t-1", worktree);
    const restored = claimTicketHarness({ rows: doing("ownera"), identity: identityOf("ownerb"), transferPayload: transferee, gitContext: { worktree, branch: "agent/ownera-t-1", repoRoot } });
    const { value: payload } = signAndRunTransfer(restored, { transferTo: "ownerb", humanAdminOverride: "authorized transfer" });
    assert.deepEqual(restored.calls.lockWrites, [{ ticketId: "T-1", owner: "ownera", repoCode: "X", branch: "agent/ownera-t-1", worktree, session: transferee.session }]);
    assert.equal(restored.calls.rebinds.length, 1);
    assert.equal(restored.calls.rebinds[0][0].owner, "ownera", "the rebuilt lock, not a fresh one, is what gets rebound");
    assert.deepEqual(restored.calls.rebinds[0][3], { transfer: { from: "ownera", reason: "authorized transfer", previousSessionId: null } });
    assert.equal(restored.calls.mutation.details.recreated_lock, true);
    assert.deepEqual(restored.calls.mutation.details.preserved_workspace, { worktree, branch: "agent/ownera-t-1" });
    assert.equal(restored.calls.boardWrites, 1);
    assert.equal(payload.transferred, true);
    assert.equal(payload.owner, "ownerb");
    assert.equal(payload.override_reason, "authorized transfer");
    assert.equal(payload.lock.owner, "ownerb");

    // A review ticket has already released its lock. The signed transfer
    // changes the board owner while journaling where the PR workspace stays.
    const head = git("rev-parse", "HEAD").trim();
    const journal = path.join(repoRoot, "review-events.ndjson");
    const branch = "agent/ownera-t-1";
    fs.writeFileSync(journal, JSON.stringify({
      command: "move-review", ticket: "T-1", result: "succeeded",
      details: { workspace_evidence: { worktree, branch, head } },
    }) + "\n");
    withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOG_PATH: journal }, () => {
      const rows = { "T-1": { ID: "T-1", Repo: "X", Status: "review", Owner: "ownera" } };
      const review = claimTicketHarness({ rows, identity: identityOf("ownerb"), transferPayload: transferee });
      const { value, error } = signAndRunTransfer(review, { transferTo: "ownerb", humanAdminOverride: "authorized review transfer" });
      assert.ifError(error);
      assert.equal(value.lock, null);
      assert.equal(rows["T-1"].Owner, "ownerb");
      assert.deepEqual(review.calls.lockWrites, []);
      assert.deepEqual(review.calls.rebinds, []);
      assert.deepEqual(review.calls.mutation.details.preserved_workspace, {
        worktree, branch, pr_head: head, pr_url: null, workspace_owner: "ownera",
      });
      const [{ at, ...transfer }] = review.calls.mutation.details.transfer_provenance;
      assert.ok(Number.isFinite(Date.parse(at)));
      assert.deepEqual(transfer, {
        from: "ownera", to: "ownerb", workspace_owner: "ownera",
        reason: "authorized review transfer", previous_session_id: null,
      });
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }

  // COORD-723: a malformed stored acknowledgement is refused ahead of all of the
  // above, for a plain claim and for a transfer, naming the verb it refused.
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-claim-di-"));
  try {
    fs.writeFileSync(path.join(recordsDir, "T-1.json"), JSON.stringify({ context_pack_ack: { considered: { adrs: "sealed as a string" } } }));
    for (const [options, verb] of [[{}, "claim"], [{ transferTo: "ownerb", humanAdminOverride: "authorized transfer" }, "claim --transfer-to"]]) {
      const malformed = claimTicketHarness({ rows: doing("ownera"), lock: heldLock, identity: identityOf("ownera"), transferPayload: transferee, planRecordsDir: recordsDir });
      assert.throws(() => malformed.run("T-1", options), (error) => {
        assert.match(error.message, /context_pack_ack\.considered\.adrs must be an array of strings/);
        assert.ok(error.message.includes(`Refusing ${verb} before any ownership, lock, or session change.`), error.message);
        return true;
      });
      assert.equal(malformed.calls.identity, 0);
      assert.deepEqual(malformed.calls.ownerProbes, []);
      assert.equal(malformed.calls.mutation.details, undefined, "no transfer was authorized or recorded");
      untouched(malformed.calls);
    }
  } finally {
    fs.rmSync(recordsDir, { recursive: true, force: true });
  }
});

test("COORD-680: deferred helpers are injected as lazy forwarders, never bare shorthand", () => {
  const source = fs.readFileSync(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/lifecycle.js"), "utf8");

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
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("coord680-atomic-");

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
    repo: repoRegistryOwner.repoNameForCode("B"),
    branch: `agent/${owner}-${ticketId.toLowerCase()}`,
    head: "deadbeef",
    // Reconstruction from this fixture fails (no base ref in the sandbox repo),
    // which is the post-rebind failure the test needs.
    worktree: path.join(backendRoot, ".worktrees", owner, ticketId),
    started_at_utc: now, heartbeat_utc: now,
    session_id: "a00-cccc",
  }, null, 2)}\n`, "utf8");

  const original = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  // Make the required failure explicit, independent of the donor branch policy.
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });

  const logs = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { B: backendRoot },
    REPO_INTEGRATION_BRANCHES: { B: "missing-fixture-base" },
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: path.join(coordRoot, ".runtime", "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(coordRoot, "board", "plans"),
    PROMPTS_DIR: path.join(coordRoot, "prompts"),
    RENDERED_DIR: path.join(coordRoot, "rendered"),
    LOCKS_DIR: path.join(coordRoot, ".runtime", "locks"),
    LEGACY_LOCKS_DIR: path.join(coordRoot, "locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  process.env.CODEX_THREAD_ID = threadA;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    const before = {
      lock: fs.readFileSync(lockPath, "utf8"),
      board: fs.readFileSync(boardPath, "utf8"),
      agents: fs.readFileSync(agentsPath, "utf8"),
      sessions: fs.readFileSync(sessionsPath, "utf8"),
    };
    assert.equal(JSON.parse(before.lock).session_id, "a00-cccc", "fixture: lock starts on the stale session");

    // The workspace post-condition must fail, AFTER the rebind would have run.
    assert.throws(() => governanceCommands.resumeTicket(ticketId), /worktree|workspace/i,
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
    assert.equal(typeof governanceCommands.resumeTicket, "function");
  } finally {
    console.log = originalLog;
    if (original.CODEX_THREAD_ID === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = original.CODEX_THREAD_ID;
  }
});
});

test("COORD-680: a same-owner cross-thread resume SUCCEEDS through real wiring — no TypeError, no raw stack", () => {
  // The acceptance criterion the failure-path tests do not cover. CUST-009's
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
  const { coordRoot, backendRoot } = createMinimalGovernanceWorkspace("coord680-success-");

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
    repo: repoRegistryOwner.repoNameForCode("B"), branch, head,
    worktree: worktreePath, started_at_utc: now, heartbeat_utc: now,
    session_id: "a00-cccc",
  }, null, 2)}\n`, "utf8");

  const originalThread = process.env.CODEX_THREAD_ID;
  fs.mkdirSync(path.join(coordRoot, "prompts", "tickets"), { recursive: true });
  fs.mkdirSync(path.join(coordRoot, "rendered"), { recursive: true });

  const logs = [];
  const originalLog = console.log;
  return withScopedGovernanceTestContext({
    REPO_ROOTS: { B: backendRoot },
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    QUESTIONS_PATH: questionsPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    PLAN_RECORDS_DIR: path.join(coordRoot, ".runtime", "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(coordRoot, "board", "plans"),
    PROMPTS_DIR: path.join(coordRoot, "prompts"),
    RENDERED_DIR: path.join(coordRoot, "rendered"),
    LOCKS_DIR: path.join(coordRoot, ".runtime", "locks"),
    LEGACY_LOCKS_DIR: path.join(coordRoot, "locks"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
  process.env.CODEX_THREAD_ID = threadA;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    let thrown = null;
    __testing.ensureGovernanceJournalBaseline("COORD-835: seeded fixture state starts journaled");
    let result;
    try {
      result = governanceCommands.resumeTicket(ticketId);
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
    if (originalThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = originalThread;
  }
  });
});


test("COORD-680: the typed-error guarantee has no wiring-dependent escape hatch", () => {
  // An earlier revision took GovernanceError from deps/options and fell back to
  // a built-in Error when absent. The test helper always injected it, so the
  // fallback was never exercised — a guarantee with an unexercised escape hatch.
  // factory-deps.js now imports GovernanceError directly, so NO dependency set
  // can produce an untyped error.
  const { assertFactoryDependencies } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/factory-deps.js"));
  const { GovernanceError } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));

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
      file: require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/ticket-transitions.js"),
      marker: "module.exports = function createTicketTransitions",
      contract: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/ticket-transitions.js")).DEP_CONTRACT,
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
  const lifecycleSrc = fs.readFileSync(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/lifecycle.js"), "utf8");

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
    // Shared deferred readers are declared once and spread into factories.
    // Expand the exact object so the contract check still sees its keys.
    for (const match of body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)(?=\s*[,}])/g)) {
      const declaration = new RegExp(`const\\s+${match[1]}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(lifecycleSrc);
      assert.ok(declaration, `could not resolve shared dependency object ${match[1]}`);
      for (const entry of declaration[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) supplied.add(entry[1]);
      for (const entry of declaration[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?=,|$)/gm)) supplied.add(entry[1]);
    }
    return supplied;
  }

  for (const factory of [
    { name: "createAgentCommands", marker: "createAgentCommands({", contract: require("./agent-commands.js").DEP_CONTRACT },
    { name: "createTicketTransitions", marker: "createTicketTransitions({", contract: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/ticket-transitions.js")).DEP_CONTRACT },
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

// COORD-722: `gov claim` is one verb with three routes — a ticket id claims the
// ticket, `--owner` (no id) claims a registered agent session, and neither binds
// the current session. Pin all three routes through the public `claim`
// entry: a ticket id must win over `--owner` (claimTicket cross-checks --owner
// against the row owner itself), `--owner` alone reaches the agent claim, and
// neither attributes the mutation and output to the newly bound session.
test("COORD-722: claim routes a ticket id to the ticket claim and --owner to the agent claim", () => {
  const mutations = [];
  const lockedReads = [];
  const identity = { agent: { id: "a836", handle: "codexa836" }, session: { session_id: "claim-836" }, autoClaimed: true, autoRegistered: false };
  let identityCalls = 0;
  const commands = createAgentCommandsFactory({
    ...completeAgentCommandDeps(),
    STATUS: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-constants.js")).STATUS,
    state: { PLAN_RECORDS_DIR: null, LEGACY_PLAN_RECORDS_DIR: null, RUNTIME_DIR: null },
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (mutation, action) => { mutations.push(mutation); return action(); },
    withAgentStateLock: (action) => action(),
    readBoard: () => ({ rows: {} }),
    getTicketRef: (board, ticketId) => (board.rows[ticketId] ? { row: board.rows[ticketId] } : null),
    readAgentsRegistry: () => { lockedReads.push("agents"); return []; },
    ensureCurrentAgentIdentity: () => { identityCalls += 1; return identity; },
    resolveAgentIdentifier: () => null,
    // No identity-v2 env channel: the agent claim stays on the legacy session path.
    identityV2: { readEnvIdentity: () => ({ present: false }) },
  });
  assert.throws(() => commands.claim("T-404", { owner: "ghost" }), /^Error: Unknown ticket "T-404"\.$/);
  assert.deepEqual(lockedReads, [], "a ticket id never falls through to the agent-session claim");

  assert.throws(() => commands.claim(undefined, { owner: "ghost" }), /^Error: Unknown registered agent "ghost"\.$/);
  assert.equal(mutations.at(-1).command, "agent-claim");
  assert.equal(mutations.at(-1).allowProvenanceDrift, true);
  assert.deepEqual(lockedReads, ["agents"], "--owner resolves the subject against the agent registry");
  assert.equal(identityCalls, 0, "refused explicit routes must not implicitly claim a session");
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (line) => output.push(line);
    commands.claim();
  } finally {
    console.log = originalLog;
  }
  assert.equal(identityCalls, 1, "a claim without a ticket or owner binds the current session once");
  assert.deepEqual(mutations.at(-1), { command: "claim", allowProvenanceDrift: true, identity });
  assert.deepEqual(output.map((line) => JSON.parse(line)), [identity],
    "the reported identity is the same identity attributed to the governed mutation");
  assert.deepEqual(lockedReads, ["agents"], "implicit session claim does not use an explicit agent-owner lookup");
});

// COORD-868: the resume refusal arms (no ticket id, unknown ticket, a ticket
// that is neither doing nor review) had no direct test; they were only
// baseline-inherited. A comment edit inside resumeTicket (the journal move)
// changed the owner function's text, so per the 2026-10-27 ruling the arms are
// covered by a real test rather than written back into the coverage baseline.
test("COORD-868: resume refuses a missing, unknown and non-resumable ticket before touching governed state", () => {
  withRegisterPromptHarness("coord868-resume-refusal-", { ticketId: "IMP-868", status: "todo" }, ({ boardPath }) => {
    const eventLogPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeEvents = fs.existsSync(eventLogPath) ? fs.readFileSync(eventLogPath) : null;

    assert.throws(() => governanceCommands.resumeTicket(undefined), { message: "resume requires <ticket-id>." });
    assert.throws(() => governanceCommands.resumeTicket(""), { message: "resume requires <ticket-id>." });
    assert.throws(() => governanceCommands.resumeTicket("IMP-999"), { message: 'Unknown ticket "IMP-999".' });
    assert.throws(() => governanceCommands.resumeTicket("IMP-868"), {
      message: 'Ticket IMP-868 must be doing or review to resume; current status is "todo". ' +
        "Use `coord/scripts/gov claim IMP-868` for passive inspection or `coord/scripts/gov start IMP-868` for new work.",
    });

    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard, "a refused resume never rewrites the board");
    assert.deepEqual(fs.existsSync(eventLogPath) ? fs.readFileSync(eventLogPath) : null, beforeEvents, "a refused resume journals nothing");
  });
});

// COORD-893: a sub-agent force-rebound a handle that another live session held,
// under a session id it invented, and the coordinator's only way back was
// --allow-shared-worktree. These drive the public verbs against real files.
function coord893Harness(prefix, body) {
  withRegisterPromptHarness(prefix, { ticketId: "C893-001" }, ({ tempDir }) => {
    const now = new Date().toISOString();
    const agent = (id, handle) => ({
      id, handle, provider: "anthropic", status: "active", aliases: [], lane: "coord", default_repo: "X", created_at: now,
    });
    const session = (id, handle, threadId) => ({
      session_id: `${id}-${threadId}`, agent_id: id, handle, session_label: `test:${threadId}`, host: "test-host",
      cwd: tempDir, board_path: governanceState.BOARD_PATH, board_root: tempDir, thread_id: threadId,
      claimed_at: now, last_seen_at: now, released_at: null, status: "active", auto_claimed: false,
    });
    fs.writeFileSync(governanceState.AGENTS_PATH, JSON.stringify([agent("a11", "claudea11"), agent("a12", "claudea12")], null, 2) + "\n");
    const writeSessions = (rows) => fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, JSON.stringify(rows, null, 2) + "\n");
    const readSessions = () => JSON.parse(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"));
    const events = () => fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const rebinds = () => events().filter((event) => event.details?.forced_rebind).map((event) => ({
      command: event.command, ...event.details.forced_rebind }));
    const envFor = (threadId) => ({
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_SESSION_ID: threadId,
      CLAUDE_CODE_SESSION_ID: threadId,
      COORD_PROVIDER_SESSION_ID: undefined,
      COORD_INSTANCE_ID: undefined,
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
      CLAUDECODE: undefined,
      GEMINI_AGENT: undefined,
      GROK_AGENT: undefined,
    });
    const run = (args, threadId, env = {}) => governanceModule.executeCommand(args, { env: { ...envFor(threadId), ...env } });
    const runWithApprovalClient = (fixture, args, threadId) => withApprovalClient(fixture, () => run(args, threadId));
    body({ session, writeSessions, readSessions, events, rebinds, run, runWithApprovalClient, tempDir });
  });
}

function runWithSignedTestApproval(run, args, threadId, ticket, runWithApprovalClient, verb = "agent-release") {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const first = run(args, threadId);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
    assert.equal(first.ok, false, "bare override text must not release the session");
    assert.ok(digest, first.error);
    fixture.login({ verb, ticket, subject_sha256: digest[1] });
    return withApprovalClient(fixture, () => run(args, threadId));
  } finally { fixture.cleanup(); }
}

test("COORD-893: --force cannot rebind a handle held by another live session, and the refusal names agent-release", () => {
  coord893Harness("coord-893-refused-", ({ session, writeSessions, readSessions, events, rebinds, run }) => {
    writeSessions([session("a11", "claudea11", "coordinator-thread")]);
    const before = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8");
    const eventsBefore = events().length;
    for (const verb of [["agent-claim", "claudea11", "--force"], ["claim", "--owner", "claudea11", "--force"]]) {
      const refused = run(verb, "invented-subagent-thread");
      assert.equal(refused.ok, false, `${verb[0]} must refuse`);
      assert.match(refused.error, /Refusing a forced rebind of claudea11 \(a11\)/);
      assert.match(refused.error, /live session a11-coordinator-thread on another thread \(coordinator-thread\)/);
      assert.match(refused.error, /coord\/scripts\/gov agent-release a11-coordinator-thread/);
      assert.match(refused.error, /--human-admin-override "<reason>"/);
      assert.doesNotMatch(refused.error, /--allow-shared-worktree/);
    }
    assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), before, "the live binding is untouched");
    assert.equal(readSessions()[0].status, "active");
    assert.equal(rebinds().length, 0);
    assert.ok(events().length >= eventsBefore);
  });
});

test("COORD-893: a human-admin override permits the forced rebind and journals both session ids", () => {
  coord893Harness("coord-893-override-", ({ session, writeSessions, readSessions, events, rebinds, run, runWithApprovalClient }) => {
    writeSessions([session("a11", "claudea11", "coordinator-thread")]);
    const args = ["agent-claim", "claudea11", "--force", "--human-admin-override", "coordinator crashed; approved by admin"];
    const before = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8");
    const unsigned = run(args, "replacement-thread");
    assert.equal(unsigned.ok, false, "override text alone must not displace a live session");
    assert.match(unsigned.error, /requires a signed human-admin approval/);
    assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), before);
    assert.equal(rebinds().length, 0, "unsigned refusal must not journal a successful rebind");
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(unsigned.error);
    assert.ok(digest, unsigned.error);
    const approval = createApprovalFixture({ allowedVerbs: ["agent claim --human-admin-override"] });
    let result;
    try {
      approval.login({ verb: "agent claim --human-admin-override", ticket: "claudea11", subject_sha256: digest[1] });
      result = runWithApprovalClient(approval, args, "replacement-thread");
    } finally { approval.cleanup(); }
    assert.equal(result.ok, true, result.error);
    const signedEvent = events().filter((event) => event.command === "agent-claim" && event.details?.forced_rebind).at(-1);
    assert.ok(signedEvent.details.approval_record, "rebind is attributed to its signed approval record");
    assert.match(signedEvent.details.approval_verified, /^key_id=/);
    assert.equal(signedEvent.details.approval_subject_sha256, digest[1]);
    const newSession = JSON.parse(result.stdout).session;
    const rows = readSessions();
    assert.equal(rows.find((row) => row.session_id === "a11-coordinator-thread").status, "released");
    assert.equal(rows.find((row) => row.session_id === newSession.session_id).thread_id, "replacement-thread");
    assert.deepEqual(rebinds(), [{
      command: "agent-claim", kind: "agent-forced-rebind", flag: "--force", handle: "claudea11",
      from_session_ids: ["a11-coordinator-thread"], from_thread_ids: ["coordinator-thread"],
      to_session_id: newSession.session_id, to_thread_id: "replacement-thread",
      override_reason: "coordinator crashed; approved by admin",
    }]);
  });
});

test("COORD-893: a forced rebind of the caller's own thread needs no override and is still journaled", () => {
  coord893Harness("coord-893-own-thread-", ({ session, writeSessions, rebinds, run }) => {
    writeSessions([session("a11", "claudea11", "own-thread")]);
    const result = run(["agent-claim", "claudea12", "--force"], "own-thread");
    assert.equal(result.ok, true, result.error);
    const [rebind] = rebinds();
    assert.equal(rebind.handle, "claudea12");
    assert.deepEqual(rebind.from_session_ids, ["a11-own-thread"]);
    assert.equal(rebind.to_session_id, JSON.parse(result.stdout).session.session_id);
    assert.equal(rebind.override_reason, null);
    const fresh = run(["agent-claim", "claudea11", "--force"], "unbound-thread");
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(rebinds().length, 1,
      "a --force claim that displaces nothing is not a rebind");
  });
});

test("COORD-893: agent-release <session-id> --human-admin-override releases a stray foreign session that holds no work", () => {
  coord893Harness("coord-893-stray-", ({ session, writeSessions, readSessions, events, run, runWithApprovalClient }) => {
    // The coordinator lost its own binding; the stray holds the handle.
    writeSessions([session("a11", "claudea11", "invented-thread")]);
    const released = runWithSignedTestApproval(run, ["agent-release", "a11-invented-thread", "--human-admin-override", "stray sub-agent binding"], "coordinator-thread", "a11-invented-thread", runWithApprovalClient);
    assert.equal(released.ok, true, released.error);
    assert.match(released.stdout, /Session a11-invented-thread \(claudea11\) holds no work; released it\./);
    assert.equal(readSessions()[0].status, "released");
    assert.equal(readSessions()[0].release_reason, "explicit");
    const event = events().filter((row) => row.command === "agent-release").at(-1);
    assert.equal(event.details.release_reason, "stray_no_work");
    assert.deepEqual(event.details.sessions, ["a11-invented-thread"]);
    assert.equal(event.details.handle, "claudea11");
    assert.equal(event.details.reason, "stray sub-agent binding");
    assert.equal(event.identity.session_id, null);
    assert.equal(event.identity.thread_id, "coordinator-thread");
    const sessionsBeforeRetry = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH);
    const eventsBeforeRetry = events().length;
    const retry = run(["agent-release", "a11-invented-thread", "--human-admin-override", "stray sub-agent binding"], "coordinator-thread");
    assert.equal(retry.ok, true, retry.error);
    assert.match(retry.stdout, /already released/);
    assert.deepEqual(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH), sessionsBeforeRetry,
      "an idempotent exact-session retry does not rewrite session state");
    assert.equal(events().length, eventsBeforeRetry, "an idempotent exact-session retry records no mutation event");
    // With the stray gone the coordinator rebinds without any override.
    assert.equal(run(["agentid", "--owner", "claudea11"], "coordinator-thread").ok, true);
  });
});

test("COORD-893: a bound coordinator's stray release is journaled under its own identity", () => {
  coord893Harness("coord-893-stray-bound-", ({ session, writeSessions, events, run, runWithApprovalClient }) => {
    writeSessions([session("a12", "claudea12", "coordinator-thread"), session("a11", "claudea11", "invented-thread")]);
    const released = runWithSignedTestApproval(run,
      ["agent-release", "a11-invented-thread", "--human-admin-override", "stray sub-agent binding"],
      "coordinator-thread", "a11-invented-thread", runWithApprovalClient);
    assert.equal(released.ok, true, released.error);
    const event = events().filter((row) => row.command === "agent-release").at(-1);
    assert.equal(event.identity.owner, "claudea12");
    assert.equal(event.identity.session_id, "a12-coordinator-thread");
  });
});

test("COORD-893: the stray release refuses a session that holds a lock, or one named only by handle", () => {
  coord893Harness("coord-893-stray-refused-", ({ session, writeSessions, readSessions, run, tempDir }) => {
    writeSessions([session("a11", "claudea11", "other-thread")]);
    fs.writeFileSync(path.join(governanceState.LOCKS_DIR, "C893-HELD.lock"), JSON.stringify({
      owner: "claudea11", ticket: "C893-HELD", worktree: path.join(tempDir, "wt"), session_id: "a11-other-thread",
    }) + "\n");
    const held = run(["agent-release", "a11-other-thread"], "coordinator-thread");
    assert.equal(held.ok, false);
    assert.match(held.error, /Session a11-other-thread holds work \(C893-HELD\)/);
    assert.match(held.error, /requires --human-admin-override/);
    const byHandle = run(["agent-release", "claudea11"], "coordinator-thread");
    assert.equal(byHandle.ok, false);
    assert.match(byHandle.error, /Foreign session release requires --human-admin-override/);
    assert.match(byHandle.error, /coord\/scripts\/gov agent-release <session-id> --human-admin-override/);
    assert.equal(readSessions()[0].status, "active", "neither refusal released anything");
  });
});

test("COORD-893: a foreign release without --human-admin-override is refused even for a stray that holds no work, with byte-identical state", () => {
  coord893Harness("coord-893-stray-no-override-", ({ session, writeSessions, run }) => {
    writeSessions([session("a11", "claudea11", "invented-thread")]);
    const sessionsBefore = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8");
    const eventsBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    for (const args of [["agent-release", "a11-invented-thread"], ["agent-release", "a11-invented-thread", "--force"]]) {
      const refused = run(args, "coordinator-thread");
      assert.equal(refused.ok, false, args.join(" "));
      assert.match(refused.error, /Foreign session release requires --human-admin-override/);
      assert.match(refused.error, /even for a stray session that holds no work/);
      assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), sessionsBefore);
    }
    const eventsAfter = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    assert.equal(eventsAfter.split("\n").filter((line) => line.includes('"agent-release"') && line.includes('"succeeded"')).length,
      eventsBefore.split("\n").filter((line) => line.includes('"agent-release"') && line.includes('"succeeded"')).length,
      "no successful release was journaled");
  });
});

test("COORD-893: releasing your own session by its exact id needs no override", () => {
  coord893Harness("coord-893-own-release-", ({ session, writeSessions, readSessions, run }) => {
    writeSessions([session("a11", "claudea11", "coordinator-thread")]);
    const released = run(["agent-release", "a11-coordinator-thread"], "coordinator-thread");
    assert.equal(released.ok, true, released.error);
    assert.equal(readSessions()[0].status, "released");
  });
});

test("COORD-893: an authorized release of a foreign session that holds work, or one named by handle, is journaled under the bound caller", () => {
  coord893Harness("coord-893-authorized-held-", ({ session, writeSessions, readSessions, events, run, tempDir }) => {
    writeSessions([session("a12", "claudea12", "coordinator-thread"), session("a11", "claudea11", "other-thread")]);
    fs.writeFileSync(path.join(governanceState.LOCKS_DIR, "C893-HELD.lock"), JSON.stringify({
      owner: "claudea11", ticket: "C893-HELD", worktree: path.join(tempDir, "wt"), session_id: "a11-other-thread",
    }) + "\n");
    const held = runWithSignedTestApproval(run, ["agent-release", "a11-other-thread", "--human-admin-override", "handoff approved by admin"], "coordinator-thread", "a11-other-thread");
    assert.equal(held.ok, true, held.error);
    assert.match(held.stdout, /Released 1 session\(s\) for a11-other-thread\./);
    assert.doesNotMatch(held.stdout, /holds no work/);
    const heldEvent = events().filter((row) => row.command === "agent-release").at(-1);
    assert.equal(heldEvent.details.release_reason, "explicit");
    assert.deepEqual(heldEvent.details.sessions, ["a11-other-thread"]);
    assert.equal(heldEvent.details.reason, "handoff approved by admin");
    assert.equal(heldEvent.details.handle, undefined, "only a stray release names the handle");
    assert.equal(heldEvent.identity.owner, "claudea12");
    assert.equal(heldEvent.identity.session_id, "a12-coordinator-thread");
    assert.equal(readSessions().find((row) => row.session_id === "a11-other-thread").status, "released");

    writeSessions([...readSessions(), session("a11", "claudea11", "third-thread")]);
    const byHandle = runWithSignedTestApproval(run, ["agent-release", "claudea11", "--human-admin-override", "handoff approved by admin"], "coordinator-thread", "claudea11");
    assert.equal(byHandle.ok, true, byHandle.error);
    assert.match(byHandle.stdout, /Released 1 session\(s\) for claudea11\./);
    const handleEvent = events().filter((row) => row.command === "agent-release").at(-1);
    assert.equal(handleEvent.details.release_reason, "explicit");
    assert.deepEqual(handleEvent.details.sessions, ["a11-third-thread"]);
    assert.equal(handleEvent.identity.owner, "claudea12");
  });
});

test("COORD-893: an authorized non-stray release refuses an unbound caller and releases nothing", () => {
  coord893Harness("coord-893-authorized-unbound-", ({ session, writeSessions, readSessions, run }) => {
    writeSessions([session("a11", "claudea11", "other-thread")]);
    const refused = run(["agent-release", "claudea11", "--human-admin-override", "handoff approved by admin"], "coordinator-thread");
    assert.equal(refused.ok, false);
    assert.match(refused.error, /No active claimed agent session/);
    assert.equal(readSessions()[0].status, "active");
  });
});

test("COORD-893: a stray release does not mask a corrupt caller binding as a missing one", () => {
  coord893Harness("coord-893-stray-corrupt-caller-", ({ session, writeSessions, readSessions, run }) => {
    writeSessions([session("a99", "claudea99", "coordinator-thread"), session("a11", "claudea11", "invented-thread")]);
    const refused = run(["agent-release", "a11-invented-thread", "--human-admin-override", "stray sub-agent binding"], "coordinator-thread");
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Active session a99-coordinator-thread points at unknown agent claudea99\./);
    assert.equal(readSessions().find((row) => row.session_id === "a11-invented-thread").status, "active",
      "the stray stays bound when the caller's own identity is corrupt");
  });
});

// COORD-893 human-admin ruling (2026-11-05): --handoff is gated like --force
// when the session it would release is still live on another thread.
test("COORD-893: a --handoff over a live session on another thread is refused without the override", () => {
  coord893Harness("coord-893-handoff-refused-", ({ session, writeSessions, readSessions, rebinds, run }) => {
    writeSessions([session("a11", "claudea11", "coordinator-thread")]);
    const before = fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8");
    for (const verb of [["agent-claim", "claudea11", "--handoff"], ["claim", "--owner", "claudea11", "--handoff"]]) {
      const refused = run(verb, "invented-subagent-thread");
      assert.equal(refused.ok, false, `${verb[0]} --handoff must refuse`);
      assert.match(refused.error, /Refusing a forced rebind of claudea11 \(a11\)/);
      assert.match(refused.error, /--handoff does not authorize taking a handle from another session/);
      assert.match(refused.error, /coord\/scripts\/gov agent-release a11-coordinator-thread/);
      assert.doesNotMatch(refused.error, /--allow-shared-worktree/);
    }
    assert.equal(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"), before);
    assert.equal(readSessions()[0].status, "active");
    assert.equal(rebinds().length, 0);
  });
});

test("COORD-893: a --handoff over a live session with the override succeeds and journals both session ids", () => {
  coord893Harness("coord-893-handoff-override-", ({ session, writeSessions, readSessions, rebinds, run, runWithApprovalClient }) => {
    writeSessions([session("a11", "claudea11", "coordinator-thread")]);
    const result = runWithSignedTestApproval(run,
      ["agent-claim", "claudea11", "--handoff", "--human-admin-override", "admin-approved handoff"],
      "replacement-thread", "claudea11", runWithApprovalClient, "agent claim --human-admin-override");
    assert.equal(result.ok, true, result.error);
    const newSession = JSON.parse(result.stdout).session;
    assert.equal(readSessions().find((row) => row.session_id === "a11-coordinator-thread").status, "released");
    assert.deepEqual(rebinds(), [{
      command: "agent-claim", kind: "agent-forced-rebind", flag: "--handoff", handle: "claudea11",
      from_session_ids: ["a11-coordinator-thread"], from_thread_ids: ["coordinator-thread"],
      to_session_id: newSession.session_id, to_thread_id: "replacement-thread",
      override_reason: "admin-approved handoff",
    }]);
  });
});

test("COORD-893: a --handoff over a stale session is free crash recovery and needs no override", () => {
  coord893Harness("coord-893-handoff-stale-", ({ session, writeSessions, readSessions, rebinds, run }) => {
    const stale = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeSessions([{ ...session("a11", "claudea11", "crashed-thread"), claimed_at: stale, last_seen_at: stale }]);
    const result = run(["agent-claim", "claudea11", "--handoff"], "restarted-thread");
    assert.equal(result.ok, true, result.error);
    assert.equal(JSON.parse(result.stdout).session.thread_id, "restarted-thread");
    const rows = readSessions();
    assert.equal(rows.find((row) => row.session_id === "a11-crashed-thread").status, "expired");
    assert.equal(rows.filter((row) => row.handle === "claudea11" && row.status === "active").length, 1);
    assert.equal(rebinds().length, 0, "nothing live was displaced, so nothing was force-rebound");
  });
});

// COORD-893 liveness rule for --handoff: with v2 identity the owner lease
// (15-minute TTL) decides; without it, the legacy 4-hour session idle window.
function coord893V2Harness(prefix, body) {
  const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
  withRegisterPromptHarness(prefix, { ticketId: "C893-V2" }, () => {
    const envFor = (instance) => ({
      ...process.env,
      COORD_PROVIDER: "anthropic",
      COORD_PROVIDER_SESSION_ID: "coord893-provider",
      COORD_INSTANCE_ID: `coord893-instance-${instance}`,
      COORD_SESSION_ID: `coord893-thread-${instance}`,
      CLAUDE_CODE_SESSION_ID: `coord893-thread-${instance}`,
      CODEX_THREAD_ID: undefined,
      AGENT_THREAD_ID: undefined,
      COORD_INSTANCE_TTL: undefined,
    });
    const claim = (instance, args = []) => governanceModule.executeCommand(["agent-claim", "claudea11", ...args], { env: envFor(instance) });
    const registryFile = identityV2.registryPath(governanceState.RUNTIME_DIR);
    const claimEvents = () => fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).filter((event) => event.details?.forced_rebind);
    assert.equal(claim("a").ok, true, "instance A takes the lease");
    body({ claim, registryFile, claimEvents });
  });
}

test("COORD-893: a v2 --handoff over an expired owner lease is free crash recovery with no override", () => {
  coord893V2Harness("coord-893-v2-expired-", ({ claim, registryFile, claimEvents }) => {
    // A crashed: its lease heartbeat is past the 15-minute TTL, while its legacy
    // session is still inside the 4-hour idle window.
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    registry.instances.find((row) => row.instance_id === "coord893-instance-a").heartbeat_at =
      new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
    const restarted = claim("b", ["--handoff"]);
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(JSON.parse(fs.readFileSync(registryFile, "utf8")).leases.claudea11.instance_id, "coord893-instance-b");
    const [event] = claimEvents();
    assert.equal(event.details.forced_rebind.flag, "--handoff");
    assert.equal(event.details.forced_rebind.override_reason, null);
    assert.deepEqual(event.details.forced_rebind.from_thread_ids, ["coord893-thread-a"]);
  });
});

test("COORD-893: a v2 --handoff over a live owner lease is refused without the override", () => {
  coord893V2Harness("coord-893-v2-live-", ({ claim, registryFile, claimEvents }) => {
    const before = fs.readFileSync(registryFile, "utf8");
    const refused = claim("b", ["--handoff"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /--handoff does not authorize taking a handle from another session/);
    assert.match(refused.error, /coord\/scripts\/gov agent-release /);
    assert.equal(fs.readFileSync(registryFile, "utf8"), before, "the live lease holder is unchanged");
    assert.equal(claimEvents().length, 0);
  });
});

test("COORD-893: without v2, a --handoff over a session inside its 4-hour idle window is refused", () => {
  coord893Harness("coord-893-legacy-window-", ({ session, writeSessions, readSessions, rebinds, run }) => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeSessions([{ ...session("a11", "claudea11", "quiet-thread"), claimed_at: twoHoursAgo, last_seen_at: twoHoursAgo }]);
    const refused = run(["agent-claim", "claudea11", "--handoff"], "restarted-thread");
    assert.equal(refused.ok, false);
    assert.match(refused.error, /bound to live session a11-quiet-thread/);
    assert.equal(readSessions()[0].status, "active");
    assert.equal(rebinds().length, 0);
  });
});

// Exercise the real nested claimAgentSession and its under-lock validation.
// The fixture signer remains genuine; a competing state change is injected only
// after it returns a signed record, before the command can apply that approval.
function transferBindingHarness(t, { foreignThread = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1048-transfer-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardPath = path.join(root, "board.json");
  const rows = { "T-1": { ID: "T-1", Repo: "X", Status: "doing", Owner: "ownera", Description: "approved row" } };
  const target = { id: "id-ownerb", handle: "ownerb", provider: "anthropic", status: "active" };
  const sessions = [{ session_id: "target-session", agent_id: target.id, handle: target.handle,
    board_path: boardPath, thread_id: foreignThread ? "foreign-thread" : "runtime-thread", status: "active" }];
  const lock = { ticket: "T-1", owner: "ownera", head: "a".repeat(40), branch: "work/T-1",
    worktree: path.join(root, "approved-worktree"), session_id: "old-owner-session" };
  const writes = [];
  let lockedRegistryReads = 0;
  let retireOnRecheck = false;
  const harness = claimTicketHarness({ rows, lock, identity: { agent: target, session: { ...sessions[0], thread_id: "runtime-thread" } }, transferPayload: { agent: target },
    dependencyOverrides: {
      state: { BOARD_PATH: boardPath, AGENT_SESSIONS_PATH: path.join(root, "sessions.json"),
        PLAN_RECORDS_DIR: null, LEGACY_PLAN_RECORDS_DIR: null, RUNTIME_DIR: root },
      withAgentStateLock: (action) => action(),
      readAgentSessions: () => sessions,
      readAgentsRegistry: () => {
        if (retireOnRecheck && ++lockedRegistryReads === 2) target.status = "retired";
        return [target];
      },
      runtimeHasStableSessionIdentity: () => true,
      resolveOrCreateEffectiveThreadId: () => "runtime-thread",
      writeJsonFile: (...args) => writes.push(args),
    } });
  const snapshot = () => JSON.parse(JSON.stringify({ rows, target, sessions, lock }));
  const assertNoWrites = () => {
    assert.deepEqual(writes, [], "refusal precedes session writes, including same-thread early return");
    assert.equal(harness.calls.boardWrites, 0);
    assert.equal(harness.calls.boardSyncs, 0);
    assert.deepEqual(harness.calls.lockWrites, []);
    assert.deepEqual(harness.calls.rebinds, []);
  };
  const retireTargetOnRecheck = () => { retireOnRecheck = true; };
  return { ...harness, rows, target, sessions, lock, snapshot, assertNoWrites, retireTargetOnRecheck };
}

test("COORD-1048: transfer refuses state changed after signing before session or ownership writes", (t) => {
  for (const [name, change, expected = /changed after human approval/] of [
    ["registered destination identity", (f) => { f.target.id = "replacement-agent-id"; }],
    ["session replacement", (f) => { f.sessions[0].session_id = "replacement-session"; }],
    ["lock head", (f) => { f.lock.head = "b".repeat(40); }],
    ["workspace", (f) => { f.lock.worktree += "-replaced"; }],
    ["ticket row", (f) => { f.rows["T-1"].Description = "changed after signing"; }],
    ["removed ticket", (f) => { delete f.rows["T-1"]; }, /Unknown ticket "T-1"/],
    ["retired target on recheck", (f) => { f.retireTargetOnRecheck(); }, /Unknown or inactive transfer target "ownerb"/],
  ]) {
    const f = transferBindingHarness(t);
    const approval = createApprovalFixture({ allowedVerbs: ["claim --transfer-to"] });
    const options = { transferTo: "ownerb", humanAdminOverride: "approve exact fixture transfer" };
    try {
      const client = approval.client();
      let refusal;
      try { withApprovalTestClient(path.resolve(__dirname, "..", ".."), client, () => f.run("T-1", options)); }
      catch (error) { refusal = error; }
      assert.match(String(refusal?.message), /requires a signed human-admin approval/, name);
      const subject = /Subject digest: ([0-9a-f]{64})/.exec(String(refusal.message));
      assert.ok(subject, name);
      approval.login({ verb: "claim --transfer-to", ticket: "T-1", subject_sha256: subject[1] });
      let signed = 0, expectedState;
      const racingClient = { ...client, runSign(request) {
        const result = client.runSign(request);
        assert.equal(result.ok, true, `${name}: the genuine signer accepted the original approved state`);
        signed += 1;
        change(f);
        expectedState = f.snapshot();
        return result;
      } };
      assert.throws(() => withApprovalTestClient(path.resolve(__dirname, "..", ".."), racingClient,
        () => f.run("T-1", options)), expected, name);
      assert.equal(signed, 1, name);
      if (name === "retired target on recheck") expectedState.target.status = "retired";
      assert.deepEqual(f.snapshot(), expectedState, `${name}: only the injected external change remains`);
      f.assertNoWrites();
    } finally { approval.cleanup(); }
  }
});

test("COORD-1048: a plain forged transfer capability cannot bypass live-session approval", (t) => {
  const f = transferBindingHarness(t, { foreignThread: true });
  const approval = createApprovalFixture({ allowedVerbs: ["agent claim --human-admin-override"] });
  const before = f.snapshot();
  let validated = 0;
  const forged = { [Symbol("verified-claim-transfer-rebind")]: true, verified: true,
    approval: { record_id: "invented-record", subject_sha256: "0".repeat(64) },
    approvalStateJson: "{}", rebindStateJson: "{}", validate: () => { validated += 1; } };
  try {
    assert.throws(() => withApprovalTestClient(path.resolve(__dirname, "..", ".."), approval.client(),
      () => f.commands.claimAgentSession("ownerb", { force: true, humanAdminOverride: "invented permission" }, forged)),
    /requires a signed human-admin approval/);
    assert.equal(validated, 0, "an externally manufactured capability is never trusted");
    assert.deepEqual(f.snapshot(), before);
    f.assertNoWrites();
  } finally { approval.cleanup(); }
});

test("claim transfer rejects an incomplete verified rebind binding", (t) => {
  const { createClaimApprovalAuthority } = require("./claim-transfer-approval-state.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-claim-approval-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createApprovalFixture({ allowedVerbs: ["claim --transfer-to"] });
  t.after(fixture.cleanup);
  const row = { ID: "T-1", Status: "doing", Owner: "ownera" };
  const target = { handle: "ownerb", id: "target-id", status: "active" };
  const sessions = [];
  const events = [];
  const context = createClaimApprovalAuthority({
    state: { BOARD_PATH: path.join(root, "board.json"), RUNTIME_DIR: root },
    identityV2: {},
    readAgentSessions: () => sessions,
    currentRuntimeThreadId: () => "runtime-thread",
    detectRuntimeProvider: () => null,
    readBoard: () => ({ row }),
    getTicketRef: (board) => ({ row: board.row }),
    findLockForTicket: () => null,
    readAgentsRegistry: () => [target],
    resolveAgentIdentifier: () => ({ agent: target }),
    appendGovernanceEvent: (event) => events.push(event),
    fail: (message) => { throw new Error(message); },
  }, (_command, options) => ({ reason: options.humanAdminOverride }));
  const options = { humanAdminOverride: "approve fixture transfer" };
  const authorize = () => withApprovalClient(fixture, () => context.authorizeClaim({
    isOwnerTransfer: true, ticketId: "T-1", row, lock: null, previousOwner: "ownera",
    targetOwner: target.handle, targetAgent: target, options,
  }));
  assert.throws(authorize, (error) => {
    const subject = /Subject digest: ([0-9a-f]{64})/.exec(error.message);
    assert.ok(subject, error.message);
    fixture.login({ verb: "claim --transfer-to", ticket: "T-1", subject_sha256: subject[1] });
    return true;
  });

  const { transferAuthorization } = authorize();
  const current = {
    targetAgent: target, currentThreadId: "runtime-thread", ...options,
    ...context.sessionState({ sessions, targetAgent: target, currentThreadId: "runtime-thread", provider: null }),
  };
  assert.match(transferAuthorization.approval.record_id, /^[a-f0-9]{32}$/);
  assert.equal(context.validateTransfer(transferAuthorization, current), transferAuthorization);

  assert.throws(() => context.validateTransfer({ ...transferAuthorization, approval: {} }, current),
    /verified approval binding is incomplete/);
  assert.throws(() => context.validateTransfer({ ...transferAuthorization, validate: null }, current),
    /verified approval binding is incomplete/);
  assert.deepEqual(events.map((event) => event.event), ["approval.refused", "approval.verified"]);
  assert.equal(row.Owner, "ownera");
  assert.deepEqual(sessions, []);
});

test("claim transfer approval normalizes absent metadata from older records", () => {
  const {
    approvalActor, buildClaimTransferApprovalState, buildLiveSessionTakeoverState,
  } = require("./claim-transfer-approval-state.js");
  const ticket = "T-1";
  const targetAgent = { id: "target-id", handle: "ownerb", status: "active" };
  const payload = {
    ticket, row: { ID: ticket, Status: "doing", Owner: "ownera" }, lock: { ticket, status: "doing" },
    previousOwner: "ownera", targetAgent, currentThreadSession: {}, targetActiveSession: null,
  };
  const minimalSession = {
    session_id: null, agent_id: null, handle: null, board_path: null, thread_id: null, status: null,
  };
  const transfer = buildClaimTransferApprovalState(payload);
  assert.deepEqual(transfer.lock, {
    path: null, ticket, owner: null, agent_id: null, session_id: null, status: "doing",
    repo: null, branch: null, head: null, worktree: null, workspace_owner: null, transfer_provenance: [],
  });
  assert.deepEqual(transfer.current_thread_session, minimalSession);
  assert.equal(transfer.target_agent.provider, null);
  assert.equal(transfer.current_thread_id, null);
  assert.equal(transfer.actor, null);
  const takeover = buildLiveSessionTakeoverState(payload);
  assert.deepEqual(takeover.current_thread_session, minimalSession);
  assert.equal(takeover.target_agent.provider, null);
  assert.equal(takeover.current_thread_id, null);
  assert.equal(takeover.actor, null);
  assert.deepEqual(approvalActor({ runtimeIdentity: { present: true } }), {
    thread_id: null, provider: null, owner_lease_instance_id: null, current_session: null,
  });
});

test("claim refuses an inactive transfer target before rebinding any state", () => {
  const rows = { "T-1": { ID: "T-1", Repo: "X", Status: "doing", Owner: "ownera" } };
  const agent = { id: "id-ownerb", handle: "ownerb", status: "retired" };
  const f = claimTicketHarness({ rows, transferPayload: { agent } });
  assert.throws(() => f.run("T-1", { transferTo: "ownerb", humanAdminOverride: "approve transfer" }),
    /Unknown or inactive transfer target "ownerb"/);
  assert.equal(rows["T-1"].Owner, "ownera");
  assert.equal(f.calls.boardWrites, 0);
  assert.deepEqual(f.calls.lockWrites, []);
  assert.deepEqual(f.calls.rebinds, []);
});

test("same-owner claim binds the absence of a lock in its signed override", () => {
  const rows = { "T-1": { ID: "T-1", Repo: "X", Status: "review", Owner: "ownera" } };
  const identity = { agent: { id: "id-ownera", handle: "ownera" },
    session: { session_id: "owner-session", thread_id: "runtime-thread" } };
  const f = claimTicketHarness({ rows, identity });
  const reason = "approve same-owner review claim";
  const options = { humanAdminOverride: reason };
  const verb = "claim --human-admin-override";
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const subject = approvalVerifier.subjectSha256({ verb, ticket: "T-1", reason,
      state: approvalVerifier.canonicalJson({ ticket: rows["T-1"], lock: null, previous_owner: "ownera",
        transfer_to: "ownera", force: false, allowSharedWorktree: false }) });
    assert.throws(() => withApprovalClient(fixture, () => f.run("T-1", options)),
      new RegExp(`Subject digest: ${subject}`));
    assert.equal(f.calls.boardWrites, 0);
    fixture.login({ verb, ticket: "T-1", subject_sha256: subject });
    const result = withApprovalClient(fixture, () => f.run("T-1", options));
    assert.equal(result.owner, "ownera");
    assert.equal(f.calls.mutation.details.previous_session_id, null);
    assert.equal(f.calls.mutation.details.approval_subject_sha256, subject);
    assert.match(f.calls.mutation.details.approval_record, /^[a-f0-9]{32}$/);
    assert.deepEqual(f.calls.lockWrites, []);
  } finally {
    fixture.cleanup();
  }
});

test("approval state gives legacy missing identity and workspace fields a canonical null value", () => {
  const { approvalActor, buildClaimTransferApprovalState, buildLiveSessionTakeoverState } =
    require("./claim-transfer-approval-state.js");
  const actor = approvalActor({ runtimeIdentity: { present: true }, threadSession: {} });
  const missingSessionIdentity = { session_id: null, agent_id: null, handle: null, board_path: null,
    thread_id: null, status: null };
  assert.deepEqual(actor, { thread_id: null, provider: null, owner_lease_instance_id: null,
    current_session: missingSessionIdentity });

  const targetAgent = { id: "id-ownerb", handle: "ownerb", status: "active" };
  const transfer = buildClaimTransferApprovalState({ targetAgent, lock: { ticket: "T-1" } });
  assert.equal(transfer.current_thread_id, null);
  assert.equal(transfer.actor, null);
  assert.equal(transfer.target_agent.provider, null);
  assert.deepEqual(transfer.lock, { ticket: "T-1", path: null, owner: null, agent_id: null, session_id: null,
    status: null, repo: null, branch: null, head: null, worktree: null, workspace_owner: null,
    transfer_provenance: [] });
  const takeover = buildLiveSessionTakeoverState({ targetAgent });
  assert.deepEqual(takeover, { target_agent: { ...targetAgent, provider: null }, current_thread_id: null,
    actor: null, current_thread_session: null, target_active_session: null, force: false, handoff: false });
});

test("agent release acknowledges expired history and refuses an unknown session", () => {
  coord893Harness("coord-release-expired-", ({ session, writeSessions, readSessions, events, run }) => {
    const recorded = { ...session("a11", "claudea11", "old-thread"), status: "expired" };
    writeSessions([recorded]);
    const priorEvents = events();
    const expired = run(["agent-release", recorded.session_id], "current-thread");
    assert.equal(expired.ok, true, expired.error);
    assert.match(expired.stdout, /already expired; no active session was released/);
    assert.deepEqual(events(), priorEvents, "acknowledging expired history does not record a live release");

    const byHandle = run(["agent-release", recorded.handle], "current-thread");
    assert.equal(byHandle.ok, true, byHandle.error);
    assert.match(byHandle.stdout, /already expired; no active session was released/);
    assert.deepEqual(events(), priorEvents);

    const unknown = run(["agent-release", "unknown-session"], "current-thread");
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /No active session found for "unknown-session"/);
    assert.deepEqual(readSessions(), [recorded]);

    const unregistered = session("orphan", "unregistered", "current-thread");
    writeSessions([recorded, unregistered]);
    const refused = run(["agent-release", unregistered.session_id], "current-thread");
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Session release requires a registered owner/);
    assert.deepEqual(readSessions(), [recorded, unregistered]);
    assert.deepEqual(events(), priorEvents);
  });
});

test("agent and integration status report an unbound caller without writing authority", () => {
  coord893Harness("coord-cli-authority-status-", ({ session, writeSessions, readSessions, events, run }) => {
    const active = session("a11", "claudea11", "another-thread");
    writeSessions([active]);
    const priorEvents = events();
    for (const threadId of ["current-thread", undefined]) {
      const report = run(["agent-status"], threadId);
      assert.equal(report.ok, true, report.error);
      const status = JSON.parse(report.stdout);
      assert.equal(status.current_session, null);
      assert.equal(status.active_sessions[0].session_id, active.session_id);
    }

    const report = run(["integration", "status", "--json"], "current-thread");
    assert.equal(report.ok, true, report.error);
    const status = JSON.parse(report.stdout);
    assert.equal(status.established, false);
    assert.equal(status.holder, null);
    assert.equal(status.caller_holds_authority, false);
    assert.equal(path.dirname(status.record_path), governanceState.RUNTIME_DIR);
    assert.equal(fs.existsSync(status.record_path), false);
    assert.deepEqual(readSessions(), [active]);
    assert.deepEqual(events(), priorEvents);
  });
});

test("cwd claim hazard selects the deepest containing lock and acknowledges its bound session", () => {
  const parent = path.resolve("worktrees/parent");
  const child = path.join(parent, "child");
  const locks = [
    { ticket: "T-parent", worktree: parent },
    { ticket: "T-unrelated", worktree: path.resolve("worktrees/unrelated") },
    { ticket: "T-child", worktree: child, session_id: "bound-session" },
  ];
  const { detectCwdTicketClaimHazard } = createAgentCommandsFactory({
    ...completeAgentCommandDeps(),
    getLockFiles: () => [0, 1, 2],
    safeReadJson: (index) => locks[index],
    normalizeLockIdentityReferences: (lock) => lock,
  });
  assert.match(detectCwdTicketClaimHazard({ session_id: "other-session" }, child), /worktree for T-child/);
  assert.equal(detectCwdTicketClaimHazard({ session_id: "bound-session" }, child), null);
  assert.match(detectCwdTicketClaimHazard({ session_id: "bound-session" }, parent), /worktree for T-parent/);
});

test("agent rebind refuses missing intent or provider before reading sessions", () => {
  let sessionReads = 0;
  const { rebindAgent } = createAgentCommandsFactory({
    ...completeAgentCommandDeps(),
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (_mutation, action) => action(),
    withAgentStateLock: (action) => action(),
    detectRuntimeProvider: () => "unknown",
    PROVIDER_REGISTRY: [{ envThread: "CLAUDE_CODE_SESSION_ID" }],
    readAgentSessions: () => { sessionReads += 1; return []; },
  });
  assert.throws(() => rebindAgent(), /agent-rebind requires --fresh/);
  assert.throws(() => rebindAgent({ fresh: true }), /Cannot determine provider for agent-rebind/);
  assert.equal(sessionReads, 0);
});

test("agent release requires an exact active session when a handle has multiple records", () => {
  const state = { BOARD_PATH: "fixture-board.json" };
  const agent = { id: "a11", handle: "claudea11", status: "active" };
  const sessions = ["bound-thread", "other-thread"].map((threadId) => ({
    session_id: `a11-${threadId}`, handle: agent.handle, board_path: state.BOARD_PATH,
    thread_id: threadId, status: "active",
  }));
  const originalSessions = structuredClone(sessions);
  const writes = [];
  const { releaseAgent } = createAgentCommandsFactory({
    ...completeAgentCommandDeps(),
    state,
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (_mutation, action) => action(),
    withAgentStateLock: (action) => action(),
    currentRuntimeThreadId: () => "bound-thread",
    readAgentsRegistry: () => [agent],
    readAgentSessions: () => sessions,
    resolveAgentIdentifier: (subject) => subject === agent.handle ? { agent } : null,
    writeJsonFile: (...args) => writes.push(args),
  });
  assert.throws(() => releaseAgent(undefined, {}), /agent-release requires <handle\|simple-id\|session-id>/);
  assert.throws(() => releaseAgent(agent.handle, {}), /Multiple active sessions matched "claudea11"/);
  assert.throws(() => releaseAgent(agent.handle, { force: true }), /Foreign session release requires --human-admin-override/);
  assert.deepEqual(sessions, originalSessions);
  assert.deepEqual(writes, []);
});

test("agent rebind claims an unclaimed handle when the runtime has no prior thread token", () => {
  coord893Harness("coord-rebind-without-token-", ({ session, writeSessions, readSessions, run }) => {
    const other = session("a11", "claudea11", "other-thread");
    writeSessions([other]);
    const rebound = run(["agent-rebind", "--fresh"], undefined, {
      CLAUDE_SESSION_ID: undefined,
      CLAUDECODE: "1",
      GEMINI_THREAD_ID: undefined,
      GROK_THREAD_ID: undefined,
      GOVERNANCE_MCP_THREAD_ID: undefined,
    });
    assert.equal(rebound.ok, true, rebound.error);
    const output = JSON.parse(rebound.stdout);
    assert.equal(output.previous, null);
    assert.equal(output.current.handle, "claudea12");
    assert.ok(output.current.thread_id, "fresh binding receives a runtime token");
    const sessions = readSessions();
    assert.deepEqual(sessions.find((row) => row.session_id === other.session_id), other);
    assert.equal(sessions.find((row) => row.session_id === output.current.session_id).thread_id, output.current.thread_id);
  });
});
