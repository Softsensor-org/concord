// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";


const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require("./governance-context.js");
// COORD-085 (Wave 4 slice 1): behavior tests for the READ-ONLY governance
// doctor REPORTING surface (doctor-report.js) — scope resolution
// (resolveDoctorScope / resolveDoctorOwnerScope), the ticket-scoped
// resolution-guidance builder, and the canonical-derived drift report builder.
// These are the deep doctor-report assertions relocated out of
// governance.test.js when the report surface was extracted from lifecycle.js
// (the MUTATING repair behavior tests stay with doctor-recovery). They reach
// the report surface through the stable governance.js __testing facade, which
// re-exports the doctor-report factory bindings.

const test = require("node:test");
const assert = require("node:assert/strict");
const createGovernanceSession = require("./governance-session.js");
const createGovernanceRepair = require("./governance-repair.js");
const governanceRepair = createGovernanceRepair({ getRows: () => [], readCanonicalTextFile: () => "" });

// Hermetic session env: the scope-self test below asserts the no-active-claim
// branch, so strip any ambient provider session/thread id the host injects
// (e.g. Claude Code exports CLAUDE_CODE_SESSION_ID) before requiring the
// governance facade — otherwise a live claim leaks an owner handle into the
// resolveDoctorOwnerScope({ scopeSelf: true }) result. Mirrors the same guard
// at the top of governance.test.js.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.COORD_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;

test("COORD-836: wired doctor reports invalid board metadata without repairing governed files", () => {
  const fs = require("node:fs");
  const { withGovernedSurfaceSandbox } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.version = "invalid";
    fs.writeFileSync(boardPath, JSON.stringify(board));
    const files = [boardPath, logPath, governanceState.PLAN_PATH];
    const read = (file) => fs.existsSync(file) ? fs.readFileSync(file) : null;
    const before = files.map(read);
    const result = governanceModule.executeCommand(["doctor"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /version/i, "the schema diagnostic survives the wired validation error boundary");
    assert.deepEqual(files.map(read), before, "read-only validation preserves board, journal and plan bytes");
  }, { isolateBoardValidation: true });
});

test("wired doctor reports dependency, prompt, lock and landing defects without repairing them", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { withGovernedSurfaceSandbox } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withGovernedSurfaceSandbox(({ boardPath, tempDir }) => {
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.metadata.landing_index_required_from_ticket = "IMP-001";
    const row = (id, status, deps = "") => ({
      ID: id, Repo: "B", Type: "infra", Pri: "P2", Status: status,
      Owner: "unassigned", Description: "Doctor diagnostic fixture", "Depends On": deps,
    });
    board.sections = [{ kind: "table", level: 2, heading: "Diagnostics", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [row("IMP-901", "doing", "IMP-902"), row("IMP-902", "todo", "IMP-901"),
        row("IMP-903", "done")],
    }];
    fs.writeFileSync(boardPath, JSON.stringify(board));
    const lockPath = path.join(governanceState.LOCKS_DIR, "IMP-901.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ ticket: "IMP-901", owner: "unassigned", status: "doing",
      repo: "backend", branch: "agent/fixture", worktree: path.join(tempDir, "missing-worktree"),
      head: "missing", started_at_utc: new Date().toISOString(), heartbeat_utc: new Date().toISOString(),
    }));
    const before = [boardPath, lockPath].map((file) => fs.readFileSync(file, "utf8"));
    const result = governanceModule.executeCommand(["doctor", "--ticket", "IMP-901"]);
    assert.equal(result.ok, false);
    assert.match(result.error, /participates in dependency cycle/);
    assert.match(result.error, /doing but blocked by/);
    assert.match(result.error, /without prompt coverage or waiver/);
    assert.match(result.error, /non-canonical worktree path/);
    assert.match(result.error, /without a readable git HEAD/);
    const done = governanceModule.executeCommand(["doctor", "--ticket", "IMP-903"]);
    assert.equal(done.ok, false);
    assert.match(done.error, /missing landing_index evidence/);
    assert.deepEqual([boardPath, lockPath].map((file) => fs.readFileSync(file, "utf8")), before);
  }, { isolateBoardValidation: true });
});

test("buildDoctorResolutionGuidance adds a QUESTIONS.md reminder for ticket-scoped doctor issues", () => {
  const guidance = governanceRepair.buildDoctorResolutionGuidance([
    "Ticket IMP-245 is doing but has no lock.",
    "backend missing doing worktree for DEBT-042",
  ]);

  assert.match(guidance, /Ticket-scoped governance issues must be closed with a recorded resolution in coord\/QUESTIONS\.md/);
  assert.match(guidance, /Affected tickets: IMP-245, DEBT-042|Affected tickets: DEBT-042, IMP-245/);
  assert.match(guidance, /coord\/scripts\/gov log-question --from <agent> --to orchestrator/);
});

test("resolveDoctorScope narrows ticket-scoped doctor rows without discarding dependency context", () => {
  const board = {
    sections: [
      {
        rows: [
          { ID: "FE-045", Repo: "F", Status: "done", Owner: "codexa00", "Depends On": "FE-019" },
          { ID: "FE-019", Repo: "F", Status: "done", Owner: "codexa00", "Depends On": "" },
        ],
      },
    ],
  };

  const scope = __testing.resolveDoctorScope(board, "FE-045");

  assert.equal(scope.targetRef.row.ID, "FE-045");
  assert.deepEqual(scope.rows.map((row) => row.ID), ["FE-045"]);
  assert.equal(scope.byId.get("FE-019").ID, "FE-019");
});

test("buildDoctorResolutionGuidance stays empty for non-ticket doctor issues", () => {
  assert.equal(governanceRepair.buildDoctorResolutionGuidance([
    "frontend unknown ticket worktree: /tmp/legacy-review",
    "Invalid governance event log entry in coord/.runtime/governance-events.ndjson: unexpected token",
  ]), "");
});

test("resolveDoctorOwnerScope returns null when neither --owner nor --scope-self is set", () => {
  assert.equal(__testing.resolveDoctorOwnerScope({}), null);
  assert.equal(__testing.resolveDoctorOwnerScope({ owner: "" }), null);
  assert.equal(__testing.resolveDoctorOwnerScope({ scopeSelf: false }), null);
});

test("resolveDoctorOwnerScope returns null when --scope-self is set but no claimed session exists", () => {
  // No agent state mutation needed: ensureCurrentAgentIdentity throws
  // NoActiveClaimedSessionError when the current thread has no active claim,
  // which the helper catches and converts to a null scope (i.e. unfiltered doctor).
  const original = process.env.AGENT_THREAD_ID;
  process.env.AGENT_THREAD_ID = `scope-self-test-${Date.now()}`;
  try {
    assert.equal(__testing.resolveDoctorOwnerScope({ scopeSelf: true }), null);
  } finally {
    if (original === undefined) {
      delete process.env.AGENT_THREAD_ID;
    } else {
      process.env.AGENT_THREAD_ID = original;
    }
  }
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError is null on clean state (no false positive)", () => {
  assert.equal(__testing.buildCanonicalDerivedDriftError([]), null);
  assert.equal(__testing.buildCanonicalDerivedDriftError(null), null);
  assert.equal(__testing.buildCanonicalDerivedDriftError(undefined), null);
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError names every drifting path + remediation", () => {
  const msg = __testing.buildCanonicalDerivedDriftError([
    "rendered/TASKS.md",
    "PLAN.md",
  ]);
  assert.match(msg, /Canonical derived artifacts drift from HEAD on 2 path\(s\)/);
  // Both paths surfaced, sorted (PLAN.md before rendered/TASKS.md).
  assert.match(msg, /PLAN\.md, rendered\/TASKS\.md/);
  // Remediation pointer to gov sync --commit (not gov recover; this is
  // derived-state drift, not journal/lock drift).
  assert.match(msg, /gov sync --commit/);
  // Mentions the slice-2 opt-out so operators learn the connection.
  assert.match(msg, /--no-sync/);
});

test("COORD-243: doctor wires the coverage-maturity DETECT line into WARNINGS (advisory, never an error)", () => {
  // Build the report factory directly with benign no-op stubs so doctor() reaches
  // the board-wide maturity DETECT block on an empty board. The injected
  // detectMaturityStaleness returns a finding; we assert it surfaces as a printed
  // WARNING (not a fail()) — proving the routing AND that a stale maturity file
  // never wedges doctor (so finalize stays doctor-clean).
  const createDoctorReport = require("./doctor-report.js");
  const noop = () => {};
  const emptyArr = () => [];
  let detectCalled = false;
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let failed = null;
  try {
    const report = createDoctorReport({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      readBoard: () => ({ sections: [] }),
      getTicketRef: () => null,
      getRows: () => [],
      rowsById: () => new Map(),
      runBoardValidate: noop,
      runBoardSync: noop,
      readAgentSessions: emptyArr,
      repoNameForCode: (code) => String(code),
      auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
      appendGovernanceProvenanceIssues: noop,
      detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
      detectOutOfBandBoardMutation: () => ({ detected: false }),
      verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
      readGovernanceEventLog: emptyArr,
      collectStaleTemplateFeedbackErrors: emptyArr,
      detectMaturityStaleness: () => {
        detectCalled = true;
        return ["coord/TEST_MATURITY.md stale (99d old) -> run gov coverage-rollup"];
      },
      detectRollbackDrift: () => ({ reasons: [] }),
      detectGateProcOrphans: emptyArr,
      computeSyncDelta: () => [],
      canonicalSyncablePaths: emptyArr,
      buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
      readActiveOrchestratorQuestionRows: emptyArr,
      formatBucketCounts: () => "",
      buildDoctorResolutionGuidance: () => "",
      collectLandingAuditReport: () => ({}),
      formatLandingAuditSummary: emptyArr,
    });
    report.doctor({});
  } finally {
    console.log = originalLog;
  }
  assert.equal(failed, null, "a stale maturity file must NOT fail() doctor");
  assert.equal(detectCalled, true, "doctor must invoke the injected coverage-maturity detector");
  const joined = logs.join("\n");
  assert.match(joined, /\[coverage-maturity\] coord\/TEST_MATURITY\.md stale/);
});

// COORD-894: the board push preflight reaches doctor's WARNINGS before any finalize.
function doctorWithBoardPushPreflight(runBoardPushPreflight) {
  const createDoctorReport = require("./doctor-report.js");
  const noop = () => {};
  const emptyArr = () => [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let failed = null;
  try {
    createDoctorReport({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      readBoard: () => ({ sections: [] }),
      getTicketRef: () => null,
      getRows: () => [],
      rowsById: () => new Map(),
      runBoardValidate: noop,
      readAgentSessions: emptyArr,
      repoNameForCode: (code) => String(code),
      auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
      appendGovernanceProvenanceIssues: noop,
      detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
      detectOutOfBandBoardMutation: () => ({ detected: false }),
      verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
      readGovernanceEventLog: emptyArr,
      collectStaleTemplateFeedbackErrors: emptyArr,
      detectRollbackDrift: () => ({ reasons: [] }),
      computeSyncDelta: () => [],
      canonicalSyncablePaths: emptyArr,
      buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
      readActiveOrchestratorQuestionRows: emptyArr,
      formatBucketCounts: () => "",
      buildDoctorResolutionGuidance: () => "",
      collectLandingAuditReport: () => ({}),
      formatLandingAuditSummary: emptyArr,
      runBoardPushPreflight,
    }).doctor({});
  } finally {
    console.log = originalLog;
  }
  return { failed, text: logs.join("\n") };
}

test("COORD-894: doctor reports a blocked board push with remedies, and an unknown preflight as unknown", () => {
  const blocked = doctorWithBoardPushPreflight(() => ({
    status: "blocked", repo: "acme/acme-coord", branch: "main", board_landing: "push", reason: "direct_push_blocked",
    findings: [{ source: 'ruleset "default branches"', type: "pull_request", effect: "requires a pull request", bypass: "pull_requests_only" }],
    remedies: ["exclude the board repository from the ruleset", 'switch to PR landing: set boardLanding: "pr" in coord/project.config.js'],
  }));
  assert.equal(blocked.failed, null, "a warning, never a doctor failure");
  assert.match(blocked.text, /\[board-push\] direct push to acme\/acme-coord branch "main": BLOCKED/);
  assert.match(blocked.text, /boardLanding: "pr"/);
  const unknown = doctorWithBoardPushPreflight(() => ({ status: "unknown", repo: "acme/acme-coord", branch: "main", reason: "gh_unauthenticated", findings: [], remedies: [] }));
  assert.match(unknown.text, /\[board-push\] direct push to acme\/acme-coord branch "main": UNKNOWN \(not observed\) — gh is not authenticated/);
  assert.match(unknown.text, /This is not a pass/);
  const quiet = doctorWithBoardPushPreflight(() => ({ status: "allowed", repo: "a/b", branch: "main", reason: "no_blocking_rules", findings: [], remedies: [] }));
  assert.doesNotMatch(quiet.text, /board-push/);
  const crashed = doctorWithBoardPushPreflight(() => { throw new Error("probe exploded"); });
  assert.match(crashed.text, /\[board-push\] preflight did not complete: probe exploded/);
  const crashedBare = doctorWithBoardPushPreflight(() => { throw "bare"; }); // eslint-disable-line no-throw-literal
  assert.match(crashedBare.text, /\[board-push\] preflight did not complete: bare/);
});

test("COORD-894: doctor --offline (or COORD_DOCTOR_OFFLINE=1) skips the remote rules check and reports unknown (skipped)", () => {
  const createDoctorReport = require("./doctor-report.js");
  const run = (options) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      createDoctorReport({
        fail: (msg) => { throw new Error(msg); },
        readBoard: () => ({ sections: [] }), getTicketRef: () => null, getRows: () => [], rowsById: () => new Map(),
        runBoardValidate: () => {}, readAgentSessions: () => [], repoNameForCode: String,
        auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
        appendGovernanceProvenanceIssues: () => {}, detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
        detectOutOfBandBoardMutation: () => ({ detected: false }),
        verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
        readGovernanceEventLog: () => [], collectStaleTemplateFeedbackErrors: () => [], detectRollbackDrift: () => ({ reasons: [] }),
        computeSyncDelta: () => [], canonicalSyncablePaths: () => [],
        buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
        readActiveOrchestratorQuestionRows: () => [], formatBucketCounts: () => "", buildDoctorResolutionGuidance: () => "",
        collectLandingAuditReport: () => ({}), formatLandingAuditSummary: () => [],
      }).doctor(options);
    } finally {
      console.log = originalLog;
    }
    return logs.join("\n");
  };
  assert.match(run({ offline: true }), /\[board-push\] direct push to board remote branch "[^"]+": UNKNOWN \(skipped\) — the remote rules check was skipped/);
  const saved = process.env.COORD_DOCTOR_OFFLINE;
  process.env.COORD_DOCTOR_OFFLINE = "1";
  try {
    assert.match(run({}), /UNKNOWN \(skipped\)/);
  } finally {
    if (saved === undefined) delete process.env.COORD_DOCTOR_OFFLINE;
    else process.env.COORD_DOCTOR_OFFLINE = saved;
  }
  const { __testing: cliTesting } = require("./governance.js");
  assert.deepEqual(cliTesting.parseFlags(["--offline"]), { offline: true });
});

test("COORD-391: doctor wires journal retention health into WARNINGS (read-only)", () => {
  const createDoctorReport = require("./doctor-report.js");
  const noop = () => {};
  const emptyArr = () => [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let failed = null;
  let healthCalled = false;
  try {
    const report = createDoctorReport({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      readBoard: () => ({ sections: [] }),
      getTicketRef: () => null,
      getRows: () => [],
      rowsById: () => new Map(),
      runBoardValidate: noop,
      runBoardSync: noop,
      readAgentSessions: emptyArr,
      repoNameForCode: (code) => String(code),
      auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
      appendGovernanceProvenanceIssues: noop,
      detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
      detectOutOfBandBoardMutation: () => ({ detected: false }),
      verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 1, broken: [] }),
      buildJournalHealthReport: () => {
        healthCalled = true;
        return { status: "warning", event_count: 5000, bytes: 2048, warnings: [{ message: "journal event count 5000 exceeds warning threshold 5000" }], policy: { policy_path: "coord/product/JOURNAL_RETENTION_POLICY.md" } };
      },
      formatJournalHealthWarning: (health) => `[journal-retention] ${health.status}: ${health.warnings[0].message}`,
      readGovernanceEventLog: emptyArr,
      collectStaleTemplateFeedbackErrors: emptyArr,
      detectMaturityStaleness: emptyArr,
      detectRollbackDrift: () => ({ reasons: [] }),
      detectGateProcOrphans: emptyArr,
      computeSyncDelta: () => [],
      canonicalSyncablePaths: emptyArr,
      buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
      readActiveOrchestratorQuestionRows: emptyArr,
      formatBucketCounts: () => "",
      buildDoctorResolutionGuidance: () => "",
      collectLandingAuditReport: () => ({}),
      formatLandingAuditSummary: emptyArr,
    });
    report.doctor({});
  } finally {
    console.log = originalLog;
  }

  assert.equal(failed, null);
  assert.equal(healthCalled, true);
  assert.match(logs.join("\n"), /\[journal-retention\] warning: journal event count 5000 exceeds warning threshold 5000/);
});

test("COORD-265: plain doctor is read-only and never runs board sync repair", () => {
  const createDoctorReport = require("./doctor-report.js");
  const noop = () => {};
  const emptyArr = () => [];
  let syncCalled = false;
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const report = createDoctorReport({
      fail: (msg) => { throw new Error(msg); },
      readBoard: () => ({ sections: [] }),
      getTicketRef: () => null,
      getRows: () => [],
      rowsById: () => new Map(),
      runBoardValidate: noop,
      runBoardSync: () => {
        syncCalled = true;
        throw new Error("runBoardSync must not be called by read-only doctor");
      },
      readAgentSessions: emptyArr,
      repoNameForCode: (code) => String(code),
      auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
      appendGovernanceProvenanceIssues: noop,
      detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
      detectOutOfBandBoardMutation: () => ({ detected: false }),
      verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
      readGovernanceEventLog: emptyArr,
      collectStaleTemplateFeedbackErrors: emptyArr,
      detectMaturityStaleness: emptyArr,
      detectRollbackDrift: () => ({ reasons: [] }),
      detectGateProcOrphans: emptyArr,
      computeSyncDelta: () => [],
      canonicalSyncablePaths: () => ["PLAN.md", "rendered/TASKS.md"],
      buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
      readActiveOrchestratorQuestionRows: emptyArr,
      formatBucketCounts: () => "",
      buildDoctorResolutionGuidance: () => "",
      collectLandingAuditReport: () => ({}),
      formatLandingAuditSummary: emptyArr,
    });

    report.doctor({});
  } finally {
    console.log = originalLog;
  }

  assert.equal(syncCalled, false);
  assert.match(logs.join("\n"), /Governance doctor OK/);
});

test("GCV-3 slice 3: buildCanonicalDerivedDriftError is deterministic on path order", () => {
  // Input order should not affect the formatted message — it sorts before
  // formatting, so two runs with the same set produce identical output.
  const a = __testing.buildCanonicalDerivedDriftError([
    "rendered/TASKS.md",
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
  ]);
  const b = __testing.buildCanonicalDerivedDriftError([
    "PLAN.md",
    "rendered/PROMPT_INDEX.md",
    "rendered/TASKS.md",
  ]);
  assert.equal(a, b);
});

test("COORD-362: read-only doctor includes the tree-mutation hazard in the sync recommendation", () => {
  const createDoctorReport = require("./doctor-report.js");
  const emptyArr = () => [];
  const board = {
    sections: [
      {
        rows: [
          { ID: "OTHER-1", Repo: "X", Status: "doing", Owner: "codexb00", "Depends On": "" },
        ],
      },
    ],
    prompt_index: { "OTHER-1": { path: "coord/prompts/tickets/OTHER-1.md" } },
  };
  let failed = null;
  const report = createDoctorReport({
    fail: (message) => {
      failed = message;
      throw new Error(message);
    },
    readBoard: () => board,
    getTicketRef: () => null,
    getRows: (b) => b.sections.flatMap((section) => section.rows || []),
    rowsById: (b) => new Map(b.sections.flatMap((section) => section.rows || []).map((row) => [row.ID, row])),
    runBoardValidate: () => {},
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    formatDependencyCycleList: (cycles) => cycles.join(", "),
    formatTransitiveBlockerDetails: () => "",
    isDoingStatus: (status) => status === "doing",
    isRepoBackedCode: () => false,
    getRepoRoot: () => "/repo/coord",
    repoNameForCode: (code) => String(code),
    requiresLandingGovernance: () => false,
    hasPromptWaiver: () => false,
    findLockForTicket: (ticket) => ({
      ticket,
      owner: "codexb00",
      status: "doing",
      head: "coord-no-git-head",
      path: `/repo/coord/.runtime/locks/${ticket}.lock`,
      worktree: `/repo/coord/.worktrees/codexb00/${ticket}`,
    }),
    safeResolveLockHead: () => "actual-ticket-head",
    isStaleTicketLock: () => false,
    inspectCanonicalLockMirrorState: () => ({ issues: [], conflicts: [] }),
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    readAgentSessions: emptyArr,
    isRegisteredAgentHandle: () => true,
    detectActiveSameOwnerOtherThread: () => ({ present: false, active_owner_sessions: [] }),
    detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
    appendGovernanceProvenanceIssues: () => {},
    detectOutOfBandBoardMutation: () => ({ detected: false }),
    verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 1, broken: [] }),
    readGovernanceEventLog: emptyArr,
    collectStaleTemplateFeedbackErrors: emptyArr,
    detectMaturityStaleness: emptyArr,
    detectRollbackDrift: () => ({ reasons: [] }),
    detectGateProcOrphans: emptyArr,
    computeSyncDelta: () => ["rendered/TASKS.md"],
    canonicalSyncablePaths: () => ["rendered/TASKS.md"],
    gitTry: (repoRoot, args) => (
      args[0] === "status"
        ? { status: 0, stdout: " M coord/scripts/foo.js\n M coord/rendered/TASKS.md\n" }
        : { status: 0, stdout: "" }
    ),
    buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
    readActiveOrchestratorQuestionRows: emptyArr,
    formatBucketCounts: () => "",
    buildDoctorResolutionGuidance: () => "",
    collectLandingAuditReport: () => ({}),
    formatLandingAuditSummary: emptyArr,
  });

  assert.throws(() => report.doctor({}), /Refusing tree-wide governance mutation/);
  assert.match(failed, /Canonical derived artifacts drift from HEAD/);
  assert.match(failed, /Refusing tree-wide governance mutation/);
  assert.match(failed, /coord\/scripts\/foo\.js/);
  assert.match(failed, /does not match worktree HEAD actual-ticket-head/);
});

// ---------------------------------------------------------------------------
// COORD-477: bootstrap-pending classification for an unborn CONTROL-PLANE
// repository. COORD-631/ADR-0008: the classified directory is coord/, never the
// workspace container — the container is never a Git repository, so "coord/ is
// merely inside some other repository" is `ancestor`, not bootstrap-pending.
// ---------------------------------------------------------------------------

const doctorReportModule = require("./doctor-report.js");

test("COORD-477/COORD-631: classifyCoordGitState distinguishes outside / ancestor / unborn / established / unknown", () => {
  const classify = doctorReportModule.classifyCoordGitState;
  // No gitTry injected -> unknown (strict checks stay on; fail-safe).
  assert.equal(classify({}).state, "unknown");
  assert.equal(classify({}).root, null);
  // Outside git entirely.
  assert.equal(classify({ gitTry: () => ({ status: 128, stdout: "" }), coordDir: "/w/coord" }).state, "outside");
  // COORD-631: toplevel resolves ABOVE coord/ — the container (or an ancestor)
  // is the repository. That is NOT bootstrap-pending: the container is never
  // initialized or committed, so the answer is a reviewed migration.
  const ancestor = classify({
    gitTry: (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: "/w\n" } : { status: 128, stdout: "" }),
    coordDir: "/w/coord",
  });
  assert.equal(ancestor.state, "ancestor");
  assert.equal(ancestor.root, "/w");
  assert.equal(ancestor.is_coord_repository, false);
  // Unborn: coord/ IS the toplevel, HEAD does not resolve.
  const unborn = classify({
    gitTry: (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: "/w/coord\n" } : { status: 128, stdout: "" }),
    coordDir: "/w/coord",
  });
  assert.equal(unborn.state, "unborn");
  assert.equal(unborn.root, "/w/coord");
  assert.equal(unborn.is_coord_repository, true);
  assert.equal(unborn.coord_dir, "/w/coord");
  // Established: coord/ is the toplevel and HEAD resolves.
  const established = classify({
    gitTry: (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: "/w/coord\n" } : { status: 0, stdout: "abc123\n" }),
    coordDir: "/w/coord",
  });
  assert.equal(established.state, "established");
  assert.equal(established.root, "/w/coord");
  // A throwing gitTry degrades to unknown, never a crash.
  assert.equal(classify({ gitTry: () => { throw new Error("no git"); }, coordDir: "/w/coord" }).state, "unknown");
  const unavailableHead = classify({
    coordDir: "/w/coord",
    gitTry: (_root, args) => {
      if (args.includes("--show-toplevel")) return { status: 0, stdout: "/w/coord\n" };
      throw new Error("could not run Git to verify HEAD");
    },
  });
  assert.equal(unavailableHead.state, "unknown");
  assert.equal(unavailableHead.root, "/w/coord");
  assert.equal(doctorReportModule.buildBootstrapPendingNotice(unavailableHead), null);
});

test("COORD-477/COORD-631: buildBootstrapPendingNotice gives exact next steps for an unborn coord/ only, and names coord/", () => {
  const build = doctorReportModule.buildBootstrapPendingNotice;
  assert.equal(build(null), null);
  assert.equal(build({ state: "established", root: "/w/coord" }), null);
  assert.equal(build({ state: "outside", root: null }), null);
  // COORD-631: an ancestor repository (e.g. a legacy parent-Git container) is
  // never given bootstrap guidance — that would advise committing the container.
  assert.equal(build({ state: "ancestor", root: "/w" }), null);
  const notice = build({ state: "unborn", root: "/w/coord" });
  assert.match(notice, /\[bootstrap-pending\]/);
  assert.match(notice, /coord\/ control-plane repository \/w\/coord/);
  assert.match(notice, /no commits yet \(unborn HEAD\)/);
  assert.match(notice, /git -C coord status --short/);
  assert.match(notice, /--git-stage/);
  assert.match(notice, /Never run `git add \.` or `git add -A`/);
  assert.match(notice, /--git-baseline-commit/);
  assert.match(notice, /git -C coord commit --no-verify/);
  // The guidance must never point the adopter at the container.
  assert.match(notice, /the workspace container above it is not a Git repository and must never become one/);
  assert.match(notice, /strict diagnostics resume after the first committed baseline/i);
});

// Shared benign stub set for board-wide doctor() factory tests.
function bootstrapDoctorDeps(overrides = {}) {
  const noop = () => {};
  const emptyArr = () => [];
  return {
    fail: (msg) => { const e = new Error(msg); e.doctorFail = true; throw e; },
    inspectMaterializedViews: () => [], // Other diagnostic probes are isolated from filesystem views.
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => null,
    getRows: () => [],
    rowsById: () => new Map(),
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    findLockForTicket: () => null,
    isDoingStatus: (status) => String(status).startsWith("doing"),
    isStaleTicketLock: () => false,
    isRepoBackedCode: () => false,
    isRegisteredAgentHandle: () => true,
    requiresLandingGovernance: () => false,
    runBoardValidate: noop,
    readAgentSessions: emptyArr,
    repoNameForCode: (code) => String(code),
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    appendGovernanceProvenanceIssues: noop,
    detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
    detectOutOfBandBoardMutation: () => ({ detected: false }),
    verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
    readGovernanceEventLog: emptyArr,
    collectStaleTemplateFeedbackErrors: emptyArr,
    detectMaturityStaleness: emptyArr,
    detectRollbackDrift: () => ({ reasons: [] }),
    detectGateProcOrphans: emptyArr,
    computeSyncDelta: () => [],
    canonicalSyncablePaths: emptyArr,
    buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
    readActiveOrchestratorQuestionRows: emptyArr,
    formatBucketCounts: () => "",
    buildDoctorResolutionGuidance: () => "",
    collectLandingAuditReport: () => ({}),
    formatLandingAuditSummary: emptyArr,
    ...overrides,
  };
}

function captureDoctorFeedbackRun({ feedback = [], actionable = [], lateActionable = false, options = {} } = {}) {
  const createDoctorReport = require("./doctor-report.js");
  let failure = null;
  const output = [];
  const originalLog = console.log;
  const report = createDoctorReport(bootstrapDoctorDeps({
    fail: (message) => {
      failure = message;
      const error = new Error(message);
      error.doctorFail = true;
      throw error;
    },
    appendGovernanceProvenanceIssues: (errors) => errors.push(...actionable),
    collectStaleTemplateFeedbackErrors: () => feedback,
    computeSyncDelta: () => lateActionable ? ["coord/PLAN.md"] : [],
    // Use the production helper: it extracts and prints every ticket ID, so
    // this catches leaks through remediation guidance as well as error lines.
    buildDoctorResolutionGuidance: governanceRepair.buildDoctorResolutionGuidance,
  }));
  console.log = (...args) => output.push(args.join(" "));
  try {
    report.doctor(options);
  } catch (error) {
    if (!error.doctorFail) throw error;
  } finally {
    console.log = originalLog;
  }
  return { failure, output: output.join("\n") };
}

function doctorBoardFixture(rows = [], overrides = {}) {
  const board = { sections: [{ rows }], prompt_index: Object.fromEntries(rows.map((row) => [row.ID, { path: `coord/prompts/tickets/${row.ID}.md` }])) };
  const byId = new Map(rows.map((row) => [row.ID, row]));
  return require("./doctor-report.js")(bootstrapDoctorDeps({
    readBoard: () => board,
    getTicketRef: (_board, ticket) => {
      const row = byId.get(ticket);
      return row ? { row, sectionIndex: 0, rowIndex: rows.indexOf(row) } : null;
    },
    getRows: () => rows,
    rowsById: () => byId,
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    formatDependencyCycleList: (cycles) => cycles.join(", "),
    formatTransitiveBlockerDetails: () => "",
    isDoingStatus: (status) => status === "doing",
    isRepoBackedCode: (code) => code === "B" || code === "F",
    getRepoRoot: (code) => `/repos/${code}`,
    hasPromptWaiver: () => true,
    findLockForTicket: () => null,
    isStaleTicketLock: () => false,
    safeResolveLockHead: () => null,
    inspectCanonicalLockMirrorState: () => ({ issues: [], conflicts: [] }),
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    auditCoordWorktrees: () => ({ stale_worktrees: [], unknown_ticket_worktrees: [], orphaned_registrations: [], missing_doing_worktrees: [] }),
    isRegisteredAgentHandle: () => true,
    canonicalizeOwnerOrFail: (owner) => owner,
    detectActiveSameOwnerOtherThread: () => ({ present: false, active_owner_sessions: [] }),
    detectColocatedForeignSessions: () => ({ foreign_sessions: [] }),
    requiresLandingGovernance: () => false,
    assertLandingIntegrity: () => {},
    ensureTestingInfrastructureLandingAudit: () => {},
    appendGovernanceProvenanceIssues: () => {},
    detectOutOfBandBoardMutation: () => ({ detected: false }),
    verifyGovernanceChain: () => ({ ok: true, preChainCount: 0, chainedCount: 0, broken: [] }),
    buildJournalHealthReport: () => null,
    formatJournalHealthWarning: () => null,
    detectMaturityStaleness: () => [],
    detectRollbackDrift: () => ({ reasons: [] }),
    detectGateProcOrphans: () => [],
    computeSyncDelta: () => [],
    canonicalSyncablePaths: () => [],
    buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {} }),
    readActiveOrchestratorQuestionRows: () => [],
    formatBucketCounts: (counts) => Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(","),
    buildDoctorResolutionGuidance: () => "",
    collectLandingAuditReport: () => ({}),
    formatLandingAuditSummary: () => [],
    ...overrides,
  }));
}

test("COORD-902: doctor warns with found and required Git versions", () => {
  const report = doctorBoardFixture([], {
    checkGitPrerequisite: () => ({ ok: false, diagnostic: "Git 2.38.0 or newer is required for merge-tree; found 2.34.1." }),
  });
  const result = captureDoctor(report);
  assert.equal(result.failure, null);
  assert.match(result.output, /Governance doctor warnings:/);
  assert.match(result.output, /\[git-prerequisite\] Git 2\.38\.0 or newer is required for merge-tree; found 2\.34\.1/);
});

function captureDoctor(report, options = {}) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    report.doctor(options);
  } catch (error) {
    if (!error.doctorFail && !/^Governance doctor found issues:/.test(error.message)) throw error;
    return { failure: error.message, output: logs.join("\n") };
  } finally {
    console.log = originalLog;
  }
  return { failure: null, output: logs.join("\n") };
}

test("COORD-562 coverage: doctor default failure and repair options remain distinct", () => {
  const row = { ID: "FE-901", Repo: "F", Status: "doing", Owner: "unassigned" };
  const board = { sections: [{ rows: [row] }], prompt_index: { "FE-901": { path: "prompt" } } };
  const failing = require("./doctor-report.js")(bootstrapDoctorDeps({
    readBoard: () => board, getRows: () => [row], rowsById: () => new Map([[row.ID, row]]),
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    isDoingStatus: (status) => status === "doing", isRepoBackedCode: () => false,
    findLockForTicket: () => ({ worktree: `${__dirname}/.worktrees/owner/FE-901`, head: "coord-no-git-head" }),
    safeResolveLockHead: () => "coord-no-git-head",
    hasPromptWaiver: () => true, isRegisteredAgentHandle: () => true,
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
  }));
  assert.throws(() => failing.doctor(), /Ticket FE-901 is doing but unassigned/);

  const calls = [];
  const delegated = require("./doctor-report.js")({ doctorFix: (options) => { calls.push(options); return "repaired"; } });
  assert.equal(delegated.doctor({ ticket: "FE-901", repairAll: true }), "repaired");
  assert.equal(delegated.doctor({ ticket: "FE-901", fix: true }), "repaired");
  assert.deepEqual(calls, [{ ticket: "FE-901", repairAll: true }, { ticket: "FE-901", fix: true }]);
});

test("COORD-562 coverage: coord and Repo-X worktree audits preserve scope and owner severity", () => {
  const own = { ID: "FE-902", Repo: "B", Status: "doing", Owner: "codexa2" };
  const report = doctorBoardFixture([own], {
    findLockForTicket: () => ({ owner: "codexa2", status: "doing", worktree: "/repos/B/.worktrees/codexa2/FE-902", head: "abc" }),
    safeResolveLockHead: () => "abc",
    auditRepoWorktrees: () => ({
      is_own_repository: false, repo_root: "/repo/B", enclosing_repository: "/repo",
      stale_ticket_worktrees: [{ ticket: "FE-902", path: "/repo/B/.worktrees/old", owner: "codexa2" }, { ticket: "FE-999", path: "/elsewhere", owner: "codexa3" }],
      unknown_ticket_worktrees: [], missing_doing_worktrees: [],
    }),
    auditCoordWorktrees: (prior) => ({
      control_plane_repo_root: "/repo/coord",
      stale_worktrees: [{ ticket: "FE-902", status: "done", path: "/repo/coord/.worktrees/codexa2/FE-902", owner: null }, { ticket: "FE-903", status: "todo", path: "/other", owner: "codexa3" }],
      unknown_ticket_worktrees: [], orphaned_registrations: [], missing_doing_worktrees: [],
    }),
  });
  const result = captureDoctor(report, { ticket: "FE-902", owner: "codexa1" });
  assert.equal(result.failure, null);
  assert.match(result.output, /Configured repo directory/);
  assert.match(result.output, /\[other owner: codexa2\].*stale coord worktree/);
  assert.match(result.output, /\[other owner: codexa2\] B stale worktree/);
  assert.doesNotMatch(result.output, /FE-903/);

  const errors = captureDoctor(doctorBoardFixture([], {
    auditCoordWorktrees: () => ({ stale_worktrees: [], unknown_ticket_worktrees: [{ path: "/coord/unknown" }], orphaned_registrations: ["FE-904"], missing_doing_worktrees: [] }),
  }));
  assert.match(errors.failure, /unknown coord worktree/);
  assert.match(errors.failure, /orphaned coord worktree registration/);

  const fallbackLabel = doctorBoardFixture([], {
    auditCoordWorktrees: () => { throw new Error("coord audit unavailable"); },
  });
  assert.match(captureDoctor(fallbackLabel).output, /could not audit coord worktrees: coord audit unavailable/);
});

test("COORD-805: doctor reports bounded donor audit accurately and retains invalid-path failures", () => {
  const row = { ID: "FE-805", Repo: "F", Status: "doing", Owner: "codexa805" };
  const baseAudit = {
    is_own_repository: false,
    worktrees_audited: true,
    audit_scope: "configured-product-worktrees",
    repo_root: "/workspace/frontend",
    enclosing_repository: "/workspace",
    worktrees: [],
    review_ticket_worktrees: [],
    stale_ticket_worktrees: [],
    unknown_ticket_worktrees: [],
    wrong_repo_ticket_worktrees: [],
    invalid_ticket_worktrees: [],
    helper_worktrees: [],
    missing_doing_worktrees: [],
  };
  const valid = captureDoctor(doctorBoardFixture([row], {
    findLockForTicket: () => ({ owner: row.Owner, status: "doing", worktree: "/repos/F/.worktrees/codexa805/FE-805", head: "abc" }),
    safeResolveLockHead: () => "abc",
    auditRepoWorktrees: () => baseAudit,
  }));
  assert.equal(valid.failure, null);
  assert.match(valid.output, /Only its configured \.worktrees subtree is audited; other enclosing-repository worktrees are excluded/);
  assert.doesNotMatch(valid.output, /F missing doing worktree for FE-805/);

  const invalid = captureDoctor(doctorBoardFixture([row], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      invalid_ticket_worktrees: [{ ticket: "FE-805", path: "/workspace/frontend/.worktrees/codexa805/FE-805", reason: "registered branch does not match the ticket lock", owner: "codexa805" }],
      missing_doing_worktrees: ["FE-805"],
    }),
  }));
  assert.match(invalid.failure, /F invalid registered worktree for FE-805: registered branch does not match the ticket lock/);
  assert.doesNotMatch(invalid.failure, /F missing doing worktree for FE-805/);

  const invalidWithoutDetails = captureDoctor(doctorBoardFixture([row], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      invalid_ticket_worktrees: [{ ticket: "FE-805", path: null, reason: "resolver failed", owner: null }],
    }),
  }), { ticket: "FE-805", owner: "another-agent" });
  assert.equal(invalidWithoutDetails.failure, null);
  assert.match(invalidWithoutDetails.output, /\[other owner: codexa805\] F invalid registered worktree for FE-805: resolver failed/);
  assert.doesNotMatch(invalidWithoutDetails.output, /\(null\)/);

  const unownedRow = { ...row, Owner: null };
  const invalidWithoutOwner = captureDoctor(doctorBoardFixture([unownedRow], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      invalid_ticket_worktrees: [{ ticket: "FE-805", path: null, reason: "resolver failed", owner: null }],
    }),
  }), { ticket: "FE-805" });
  assert.match(invalidWithoutOwner.failure, /F invalid registered worktree for FE-805: resolver failed/);

  const wrongRepo = captureDoctor(doctorBoardFixture([row], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      wrong_repo_ticket_worktrees: [{ ticket: "FE-805", repo: "B", path: "/workspace/frontend/.worktrees/codexa805/FE-805" }],
    }),
  }));
  assert.match(wrongRepo.failure, /F contains a registered worktree for FE-805.*board assigns that ticket to B/);

  const wrongRepoOutsideTicketScope = captureDoctor(doctorBoardFixture([row], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      wrong_repo_ticket_worktrees: [{ ticket: "BE-806", repo: "B", path: "/workspace/frontend/.worktrees/codexa805/BE-806" }],
    }),
  }), { ticket: "FE-805" });
  assert.doesNotMatch(wrongRepoOutsideTicketScope.failure || wrongRepoOutsideTicketScope.output, /contains a registered worktree for BE-806/);

  const wrongRepoWithoutRepoName = captureDoctor(doctorBoardFixture([row], {
    auditRepoWorktrees: () => ({
      ...baseAudit,
      wrong_repo_ticket_worktrees: [{ ticket: "FE-805", repo: null, path: "/workspace/frontend/.worktrees/codexa805/FE-805" }],
    }),
  }), { ticket: "FE-805" });
  assert.match(wrongRepoWithoutRepoName.failure, /board assigns that ticket to another repo/);
});

test("COORD-562 coverage: lock mirror and same-owner concurrent sessions are reported", () => {
  const row = { ID: "FE-905", Repo: "F", Status: "doing", Owner: "codexa1" };
  const lock = { owner: "codexa1", status: "doing", worktree: "/repos/F/.worktrees/codexa1/FE-905", head: "abc", session_id: "holder", thread_id: "thread-holder" };
  const result = captureDoctor(doctorBoardFixture([row], {
    findLockForTicket: () => lock,
    safeResolveLockHead: () => "abc",
    inspectCanonicalLockMirrorState: () => ({ issues: ["mirror issue"], conflicts: ["mirror conflict"] }),
    readAgentSessions: () => [{ session_id: "holder", thread_id: "thread-holder" }],
    detectActiveSameOwnerOtherThread: (_ticket, _lock, options) => {
      assert.equal(options.currentThreadId, "thread-holder");
      return { present: true, active_owner_sessions: [{ session_id: "other", thread_id: "thread-other" }] };
    },
  }));
  assert.match(result.failure, /mirror issue/);
  assert.match(result.failure, /mirror conflict/);
  assert.match(result.failure, /other@thread:thread-other/);
});

test("COORD-562 coverage: landing failures and board-wide warning collaborators remain visible", () => {
  const row = { ID: "FE-906", Repo: "F", Status: "done", Owner: "codexa1" };
  const board = { sections: [{ rows: [row] }], prompt_index: {}, landing_index: { "FE-906": { evidence: [{ kind: "commit", sha: "abc" }] } } };
  const landing = require("./doctor-report.js")(bootstrapDoctorDeps({
    readBoard: () => board, getRows: () => [row], rowsById: () => new Map([[row.ID, row]]),
    getTicketRef: (_board, ticket) => ticket === row.ID ? { row, sectionIndex: 0, rowIndex: 0 } : null,
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    isDoingStatus: (status) => status === "doing",
    findLockForTicket: () => null,
    requiresLandingGovernance: () => true, isRepoBackedCode: () => true,
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    assertLandingIntegrity: () => { throw new Error("landing integrity mismatch"); },
  }));
  assert.throws(() => landing.doctor(), /landing integrity mismatch/);

  const serious = captureDoctor(doctorBoardFixture([], {
    detectOutOfBandBoardMutation: () => ({ detected: true, paths: ["coord/PLAN.md"], latestEvent: { ts: "today" } }),
    verifyGovernanceChain: () => ({ ok: false, broken: [{ index: 4, reason: "link mismatch", command: "update-plan", ts: "then" }] }),
  }));
  assert.match(serious.failure, /Out-of-band board mutation detected/);
  assert.match(serious.failure, /journal hash-chain is broken at 1 event/);

  const healthy = captureDoctor(doctorBoardFixture([], {
    detectColocatedForeignSessions: () => ({ foreign_sessions: [{ session_id: null, handle: null, thread_id: "t1" }, { session_id: "s2", handle: "codexa2", thread_id: "t2" }] }),
    buildJournalHealthReport: () => { throw new Error("retention unavailable"); },
    detectMaturityStaleness: () => { throw new Error("maturity unavailable"); },
    detectGateProcOrphans: ({ isTicketDoing }) => {
      assert.equal(isTicketDoing("FE-907"), false);
      return [{ gateRunId: "g1", entry: { ticket: "FE-907", lane: "test", repo: "F" }, reason: "pid absent" }];
    },
    computeSyncDelta: () => { throw new Error("sync scan unavailable"); },
    buildQuestionQueueReport: () => ({ total: 1, by_type: { repair: 1 }, by_severity: { high: 1 }, by_aging: { stale: 1 } }),
    formatLandingAuditSummary: () => ["landing audit summary"],
  }));
  assert.match(healthy.output, /Governance doctor OK/);
  assert.match(healthy.output, /co-located on this runtime/);
  assert.match(healthy.output, /health check did not complete: retention unavailable/);
  assert.match(healthy.output, /staleness check did not complete: maturity unavailable/);
  assert.match(healthy.output, /gate-run g1 \(ticket FE-907 repo=F lane=test\) is orphaned/);
  assert.match(healthy.output, /drift check did not complete: sync scan unavailable/);
  assert.match(healthy.output, /Queue debt: unresolved orchestrator questions=1/);
  assert.match(healthy.output, /landing audit summary/);
});

test("COORD-562 coverage: readiness, owner-scope, and ticket audit refusals are actionable", () => {
  const cycleRow = { ID: "FE-908", Repo: "F", Status: "doing", Owner: "unknown-owner" };
  const cycles = captureDoctor(doctorBoardFixture([cycleRow], {
    evaluateReadiness: () => ({ cycles: [["FE-908", "FE-909", "FE-908"]], blockedBy: ["FE-909"], blockerChains: [["FE-908", "FE-909"]] }),
    formatDependencyCycleList: (value) => value.join(" -> "),
    formatTransitiveBlockerDetails: (value) => value.map((chain) => chain.join(" -> ")).join("; "),
    isRegisteredAgentHandle: () => false,
    hasPromptWaiver: () => false,
    findLockForTicket: () => null,
    readBoard: () => ({ sections: [{ rows: [cycleRow] }], prompt_index: {} }),
  }), { ticket: "FE-908" });
  assert.match(cycles.failure, /dependency cycle/);
  assert.match(cycles.failure, /blocked by FE-909/);
  assert.match(cycles.failure, /Transitive blocker chains/);
  assert.match(cycles.failure, /unregistered owner unknown-owner/);
  assert.match(cycles.failure, /without prompt coverage or waiver/);
  assert.match(cycles.failure, /has no lock/);
  const blockerWithoutChain = captureDoctor(doctorBoardFixture([cycleRow], {
    evaluateReadiness: () => ({ cycles: [], blockedBy: ["FE-909"], blockerChains: [] }),
    formatTransitiveBlockerDetails: () => "",
  }), { ticket: "FE-908" });
  assert.match(blockerWithoutChain.failure, /blocked by FE-909/);
  assert.doesNotMatch(blockerWithoutChain.failure, /Transitive blocker chains/);

  const missing = captureDoctor(doctorBoardFixture([]), { ticket: "FE-999" });
  assert.match(missing.failure, /Unknown ticket "FE-999"/);
  assert.throws(() => doctorBoardFixture([] , {
    ensureCurrentAgentIdentity: () => { throw new Error("identity store unavailable"); },
    isNoActiveClaimedSessionError: () => false,
  }).doctor({ scopeSelf: true }), /identity store unavailable/);
});

test("COORD-562 coverage: landing evidence is required and control-plane verification is enforced", () => {
  const missingRow = { ID: "COORD-909", Repo: "X", Status: "done", Owner: "codexa1" };
  const missing = require("./doctor-report.js")(bootstrapDoctorDeps({
    readBoard: () => ({ sections: [{ rows: [missingRow] }], landing_index: {} }),
    getRows: () => [missingRow], rowsById: () => new Map([[missingRow.ID, missingRow]]),
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    isDoingStatus: (status) => status === "doing", isRepoBackedCode: () => false, requiresLandingGovernance: () => true,
    findLockForTicket: () => null,
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
  }));
  assert.throws(() => missing.doctor(), /done but missing landing_index evidence/);

  const row = { ID: "COORD-910", Repo: "X", Status: "done", Owner: "codexa1" };
  const withLanding = (integrity) => require("./doctor-report.js")(bootstrapDoctorDeps({
    readBoard: () => ({ sections: [{ rows: [row] }], landing_index: { [row.ID]: { evidence: [{ kind: "local_commit", sha: "abc" }] } } }),
    getRows: () => [row], rowsById: () => new Map([[row.ID, row]]),
    evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
    isDoingStatus: (status) => status === "doing", isRepoBackedCode: () => false, requiresLandingGovernance: () => true,
    findLockForTicket: () => null,
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    assertControlPlaneLandingIntegrity: integrity,
  }));
  assert.doesNotThrow(() => withLanding(() => {}).doctor(), "historical local-only control-plane evidence remains accepted");
});

test("COORD-562 coverage: missing worktree filters and warning-only audit failures keep scope", () => {
  const row = { ID: "FE-911", Repo: "B", Status: "doing", Owner: "codexa1" };
  const missing = captureDoctor(doctorBoardFixture([row], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: "/repos/B/.worktrees/codexa1/FE-911", head: "abc" }),
    safeResolveLockHead: () => "abc",
    auditCoordWorktrees: () => ({ stale_worktrees: [], unknown_ticket_worktrees: [], orphaned_registrations: [], missing_doing_worktrees: ["FE-911", "FE-912"] }),
    auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [{ ticket: "FE-911", path: "/unknown/target" }, { ticket: "FE-912", path: "/unknown/other" }], missing_doing_worktrees: ["FE-911", "FE-912"] }),
  }), { ticket: "FE-911" });
  assert.match(missing.failure, /missing coord worktree for doing ticket FE-911/);
  assert.match(missing.failure, /B missing doing worktree for FE-911/);
  assert.match(missing.failure, /B unknown ticket worktree: \/unknown\/target/);
  assert.doesNotMatch(missing.failure, /FE-912/);

  const warnings = captureDoctor(doctorBoardFixture([], {
    auditCoordWorktrees: () => { throw new Error("coord audit failed"); },
    detectColocatedForeignSessions: () => { throw new Error("session detector failed"); },
    detectOutOfBandBoardMutation: () => { throw new Error("provenance read failed"); },
    verifyGovernanceChain: () => ({ ok: true, preChainCount: 2, chainedCount: 0, broken: [] }),
    buildJournalHealthReport: () => ({ status: "ok" }),
    formatJournalHealthWarning: () => null,
    detectGateProcOrphans: () => { throw new Error("gate registry unavailable"); },
  }));
  assert.equal(warnings.failure, null);
  assert.match(warnings.output, /could not audit coord worktrees: coord audit failed/);
  assert.match(warnings.output, /pre-chain \(legacy\) event\(s\)/);
  assert.match(warnings.output, /orphan check did not complete: gate registry unavailable/);
  assert.doesNotMatch(warnings.output, /session detector failed|provenance read failed/);
});

test("COORD-562 coverage: advisory catch paths and optional fields remain non-blocking", () => {
  const row = { ID: "FE-915", Repo: "B", Status: "doing", Owner: "codexa1" };
  const report = doctorBoardFixture([row], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: "/repos/B/.worktrees/codexa1/FE-915", head: "abc" }),
    safeResolveLockHead: () => "abc",
    auditRepoWorktrees: () => ({ is_own_repository: false, repo_root: "/repo/B", enclosing_repository: null, stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    detectOutOfBandBoardMutation: () => ({ detected: false }),
    verifyGovernanceChain: () => { throw new Error(""); },
    buildJournalHealthReport: () => ({ status: "warning" }),
    formatJournalHealthWarning: undefined,
    detectMaturityStaleness: () => { throw new Error(""); },
    detectGateProcOrphans: ({ isTicketDoing }) => {
      assert.equal(isTicketDoing("FE-915"), true);
      assert.equal(isTicketDoing("FE-unknown"), false);
      return [
        { gateRunId: "without-context", entry: {}, reason: "pid absent" },
        { gateRunId: "without-message", entry: { ticket: "FE-915" }, reason: "pid absent" },
      ];
    },
    computeSyncDelta: () => { throw new Error(""); },
    buildQuestionQueueReport: () => ({ total: 1, by_type: {}, by_severity: {}, by_aging: {} }),
  });
  const result = captureDoctor(report);
  assert.equal(result.failure, null);
  assert.match(result.output, /not a Git repository of its own/);
  assert.match(result.output, /chain verification did not complete: Error/);
  assert.doesNotMatch(result.output, /journal-retention.*health check/);
  assert.match(result.output, /staleness check did not complete: Error/);
  assert.match(result.output, /gate-run without-context \(no ticket\) is orphaned/);
  assert.match(result.output, /gate-run without-message \(ticket FE-915\) is orphaned/);
  assert.match(result.output, /drift check did not complete: Error/);
  assert.match(result.output, /Queue debt: unresolved orchestrator questions=1/);

  const detailedFailures = captureDoctor(doctorBoardFixture([], {
    verifyGovernanceChain: () => { throw new Error("chain read detail"); },
    buildJournalHealthReport: () => { throw new Error(""); },
    formatJournalHealthWarning: undefined,
    detectMaturityStaleness: () => { throw new Error("maturity read detail"); },
    detectGateProcOrphans: () => { throw new Error(""); },
    computeSyncDelta: () => { throw new Error("sync read detail"); },
  }));
  assert.match(detailedFailures.output, /chain verification did not complete: chain read detail/);
  assert.match(detailedFailures.output, /health check did not complete: Error/);
  assert.match(detailedFailures.output, /staleness check did not complete: maturity read detail/);
  assert.match(detailedFailures.output, /orphan check did not complete: Error/);
  assert.match(detailedFailures.output, /drift check did not complete: sync read detail/);

  const incompleteChain = captureDoctor(doctorBoardFixture([], {
    verifyGovernanceChain: () => ({ ok: false, broken: [{ index: 9, reason: "missing predecessor" }] }),
  }));
  assert.match(incompleteChain.failure, /#9 \(missing predecessor\)/);
  assert.doesNotMatch(incompleteChain.failure, /#9 \(missing predecessor,|#9 \(missing predecessor @/);
});

test("COORD-562 coverage: a failed control-plane integrity collaborator is surfaced as a doctor error", () => {
  const controlPlane = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/control-plane-landing.js"));
  const originalAssert = controlPlane.assertControlPlaneLandingIntegrity;
  const doctorPath = require.resolve("./doctor-report.js");
  const cachedDoctor = require.cache[doctorPath];
  let report;
  try {
    controlPlane.assertControlPlaneLandingIntegrity = () => { throw new Error("remote landing no longer resolves"); };
    delete require.cache[doctorPath];
    const createDoctorReport = require("./doctor-report.js");
    const row = { ID: "COORD-916", Repo: "X", Status: "done", Owner: "codexa1" };
    report = createDoctorReport(bootstrapDoctorDeps({
      readBoard: () => ({ sections: [{ rows: [row] }], landing_index: { [row.ID]: { evidence: [{ kind: "remote_ancestry", sha: "abc" }] } } }),
      getRows: () => [row], rowsById: () => new Map([[row.ID, row]]),
      evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
      isDoingStatus: (status) => status === "doing", isRepoBackedCode: () => false,
      requiresLandingGovernance: () => true, findLockForTicket: () => null,
      auditRepoWorktrees: () => ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
    }));
  } finally {
    controlPlane.assertControlPlaneLandingIntegrity = originalAssert;
    delete require.cache[doctorPath];
    if (cachedDoctor) require.cache[doctorPath] = cachedDoctor;
  }
  assert.throws(() => report.doctor(), /remote landing no longer resolves/);
});

test("COORD-562 coverage: lock head anomalies are fail-closed for Repo-X and Repo-B rows", () => {
  const repoRow = { ID: "FE-913", Repo: "B", Status: "doing", Owner: "codexa1" };
  const makeRepoLock = (head) => doctorBoardFixture([repoRow], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: "/repos/B/.worktrees/codexa1/FE-913", head }),
    safeResolveLockHead: () => "live-head",
  });
  assert.match(captureDoctor(makeRepoLock("old-head"), { ticket: repoRow.ID }).failure, /does not match worktree HEAD live-head/);
  assert.equal(captureDoctor(makeRepoLock("live-head"), { ticket: repoRow.ID }).failure, null);
  assert.match(captureDoctor(doctorBoardFixture([repoRow], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: "/repos/B/.worktrees/codexa1/FE-913", head: "" }),
    safeResolveLockHead: () => "live-head",
  }), { ticket: repoRow.ID }).failure, /lock head \(missing\) does not match/);
  const unreadable = doctorBoardFixture([repoRow], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: "/repos/B/.worktrees/codexa1/FE-913", head: "live-head" }),
    safeResolveLockHead: () => null,
  });
  assert.match(captureDoctor(unreadable, { ticket: repoRow.ID }).failure, /without a readable git HEAD/);

  const coordRow = { ID: "COORD-914", Repo: "X", Status: "doing", Owner: "codexa1" };
  const coord = doctorBoardFixture([coordRow], {
    findLockForTicket: () => ({ owner: "codexa1", status: "doing", worktree: `${__dirname}/.worktrees/codexa1/COORD-914`, head: "wrong-head" }),
    safeResolveLockHead: () => "coord-no-git-head",
  });
  assert.match(captureDoctor(coord, { ticket: coordRow.ID }).failure, /coord lock head must be coord-no-git-head/);
});

test("COORD-562 coverage: board-wide audit branches include unknown time and unscoped worktrees", () => {
  const result = captureDoctor(doctorBoardFixture([], {
    auditCoordWorktrees: () => ({
      control_plane_repo_root: null,
      stale_worktrees: [{ ticket: "FE-917", status: "todo", path: "/coord/old", owner: "codexa2" }, { ticket: "FE-921", status: "todo", path: "/coord/unowned", owner: null }],
      unknown_ticket_worktrees: [{ path: "/coord/unknown" }],
      orphaned_registrations: ["FE-918"],
      missing_doing_worktrees: ["FE-919"],
    }),
    auditRepoWorktrees: () => ({ is_own_repository: false, repo_root: "/repo/B", enclosing_repository: null, stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: ["FE-920"] }),
    detectOutOfBandBoardMutation: () => ({ detected: true, paths: ["coord/PLAN.md"] }),
  }));
  assert.match(result.failure, /control plane \(coord\/\)/);
  assert.match(result.failure, /missing coord worktree for doing ticket FE-919/);
  assert.match(result.failure, /B missing doing worktree for FE-920/);
  assert.match(result.failure, /unknown time/);
  assert.match(result.failure, /stale coord worktree for FE-921/);
});

test("COORD-562: default doctor summarizes feedback without leaking IDs through resolution guidance", () => {
  const feedback = Array.from({ length: 133 }, (_, index) =>
    `Ticket COORD-${91000 + index} is a done governance/template ticket older than 7 days without feedback.`
  );
  const actionable = ["Ticket FE-409 is doing but has no lock."];
  const result = captureDoctorFeedbackRun({ feedback, actionable });
  assert.ok(result.failure, "stale feedback remains a hard doctor failure");
  assert.match(result.failure, /^Governance doctor found issues:/);
  assert.match(result.failure, /errors=134/);
  assert.match(result.failure, /actionable=1/);
  assert.match(result.failure, /TEMPLATE_FEEDBACK=133/);
  assert.match(result.failure, /Ticket FE-409 is doing but has no lock\./);
  assert.match(result.failure, /Affected tickets: FE-409/);
  assert.match(result.failure, /--show-template-feedback/);
  assert.ok(
    result.failure.indexOf("Ticket FE-409") < result.failure.indexOf("TEMPLATE_FEEDBACK: 133"),
    "actionable guidance must precede the feedback summary"
  );
  assert.doesNotMatch(result.failure, /Governance doctor OK/);
  const fullDefaultOutput = `${result.failure}\n${result.output}`;
  for (let index = 0; index < feedback.length; index += 1) {
    assert.ok(!fullDefaultOutput.includes(`COORD-${91000 + index}`), `feedback ID ${91000 + index} leaked`);
    assert.ok(!fullDefaultOutput.includes(feedback[index]), `feedback message ${index} leaked`);
  }
});

test("COORD-562: detail mode preserves the same failure and exposes all feedback guidance", () => {
  const feedback = Array.from({ length: 133 }, (_, index) =>
    `Ticket COORD-${91000 + index} is a done governance/template ticket older than 7 days without feedback.`
  );
  const actionable = ["Ticket FE-409 is doing but has no lock."];
  const normal = captureDoctorFeedbackRun({ feedback, actionable, lateActionable: true });
  const detailed = captureDoctorFeedbackRun({
    feedback,
    actionable,
    lateActionable: true,
    options: { showTemplateFeedback: true },
  });
  assert.ok(detailed.failure, "detail mode remains a hard doctor failure");
  for (const count of ["errors=135", "actionable=2", "TEMPLATE_FEEDBACK=133"]) {
    assert.ok(normal.failure.includes(count), `default output lacks ${count}`);
    assert.ok(detailed.failure.includes(count), `detail output lacks ${count}`);
  }
  assert.match(detailed.failure, /Affected tickets: FE-409, COORD-91000/);
  assert.match(detailed.failure, /Canonical derived artifacts drift from HEAD on 1 path/);
  assert.ok(
    detailed.failure.indexOf("Ticket FE-409") < detailed.failure.indexOf(feedback[0]) &&
      detailed.failure.indexOf("Canonical derived artifacts drift") < detailed.failure.indexOf(feedback[0]),
    "early and late actionable errors must precede per-ticket feedback details"
  );
  for (let index = 0; index < feedback.length; index += 1) {
    assert.ok(detailed.failure.includes(`COORD-${91000 + index}`), `detail mode omitted feedback ID ${91000 + index}`);
    assert.ok(detailed.failure.includes(feedback[index]), `detail mode omitted feedback message ${index}`);
  }
});

test("COORD-562: single feedback finding stays failed and zero feedback adds no category", () => {
  const single = captureDoctorFeedbackRun({
    feedback: ["Ticket COORD-92001 is a stale template-feedback finding."],
  });
  assert.ok(single.failure, "one stale feedback finding remains a hard failure");
  assert.match(single.failure, /errors=1/);
  assert.match(single.failure, /TEMPLATE_FEEDBACK=1/);
  assert.match(single.failure, /--show-template-feedback/);
  assert.doesNotMatch(`${single.failure}\n${single.output}`, /COORD-92001/);
  const singleDetailed = captureDoctorFeedbackRun({
    feedback: ["Ticket COORD-92001 is a stale template-feedback finding."],
    options: { showTemplateFeedback: true },
  });
  assert.ok(singleDetailed.failure);
  assert.match(singleDetailed.failure, /Ticket COORD-92001 is a stale template-feedback finding\./);

  const repeatedFinding = "Ticket COORD-92002 is duplicated stale template feedback.";
  const repeated = captureDoctorFeedbackRun({
    feedback: [repeatedFinding, repeatedFinding],
    actionable: [repeatedFinding],
  });
  assert.match(repeated.failure, /errors=3 actionable=1 TEMPLATE_FEEDBACK=2/);
  assert.equal(repeated.failure.split(repeatedFinding).length - 1, 1);
  const repeatedDetailed = captureDoctorFeedbackRun({
    feedback: [repeatedFinding, repeatedFinding],
    actionable: [repeatedFinding],
    options: { showTemplateFeedback: true },
  });
  assert.equal(repeatedDetailed.failure.split(repeatedFinding).length - 1, 3);

  const empty = captureDoctorFeedbackRun();
  assert.equal(empty.failure, null);
  assert.match(empty.output, /Governance doctor OK: no additional issues found\./);
  assert.doesNotMatch(`${empty.failure || ""}\n${empty.output}`, /TEMPLATE_FEEDBACK|show-template-feedback/);
  const noFeedbackWithActionableError = captureDoctorFeedbackRun({ actionable: ["Actionable issue."] });
  assert.match(noFeedbackWithActionableError.failure, /errors=1 actionable=1/);
  assert.doesNotMatch(noFeedbackWithActionableError.failure, /TEMPLATE_FEEDBACK|show-template-feedback/);
});

test("COORD-755: doctor suppresses timestamp-only freshness and reports causal board drift", () => {
  const fs = require("node:fs");
  const { withGovernedSurfaceSandbox } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  const createDoctorReport = require("./doctor-report.js");
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const snapshot = __testing.buildGovernanceSnapshot();
    __testing.writeGovernanceSnapshotArtifact(snapshot);
    __testing.writeGovernanceSnapshotCheckpoint(snapshot, { ts: new Date().toISOString(), command: "finalize" });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(logPath,
      `${JSON.stringify({ ts: new Date().toISOString(), command: "finalize", snapshot_digest: snapshot.digest })}\n` +
      `${JSON.stringify({ ts: future, command: "update-plan", snapshot_digest: snapshot.digest })}\n`);
    fs.utimesSync(boardPath, new Date(0), new Date(0));
    const report = createDoctorReport(bootstrapDoctorDeps({
      gitTry: establishedGitTry,
      detectRollbackDrift: __testing.detectRollbackDrift,
    }));
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      report.doctor({});
      assert.doesNotMatch(logs.join("\n"), /\[freshness\]/);
      logs.length = 0;
      fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [] }] }));
      report.doctor({});
      assert.match(logs.join("\n"), /\[freshness\] board content differs from the latest journaled governance snapshot/);
    } finally {
      console.log = originalLog;
    }
  });
});

// COORD-631: the classified toplevel is COORD_DIR itself — coord/ is the
// control-plane repository. A toplevel ABOVE it is `ancestor`, which is
// deliberately NOT bootstrap-pending.
const { COORD_DIR: DOCTOR_COORD_DIR } = require("./governance-context.js");
const unbornGitTry = (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${DOCTOR_COORD_DIR}\n` } : { status: 128, stdout: "" });
const establishedGitTry = (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${DOCTOR_COORD_DIR}\n` } : { status: 0, stdout: "abc123\n" });
const containerAncestorGitTry = (root, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${require("node:path").dirname(DOCTOR_COORD_DIR)}\n` } : { status: 128, stdout: "" });

test("COORD-477/COORD-631: doctor reports bootstrap-pending for an unborn coord/ instead of generic drift/provenance errors", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let provenanceCalled = false;
  let outOfBandCalled = false;
  let rollbackCalled = false;
  let syncDeltaCalled = false;
  let failed = null;
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      gitTry: unbornGitTry,
      appendGovernanceProvenanceIssues: (errors) => { provenanceCalled = true; errors.push("generic journal drift"); },
      detectOutOfBandBoardMutation: () => { outOfBandCalled = true; return { detected: true, paths: ["board/tasks.json"], latestEvent: null }; },
      detectRollbackDrift: () => { rollbackCalled = true; return { reasons: ["stale"] }; },
      computeSyncDelta: () => { syncDeltaCalled = true; return ["PLAN.md", "rendered/TASKS.md"]; },
      canonicalSyncablePaths: () => ["PLAN.md", "rendered/TASKS.md"],
    }));
    report.doctor({});
  } finally {
    console.log = originalLog;
  }
  assert.equal(failed, null, "an unborn root must not fail doctor with generic drift errors");
  assert.equal(provenanceCalled, false, "journal provenance drift is deferred while bootstrap-pending");
  assert.equal(outOfBandCalled, false, "out-of-band board mutation detection is deferred while bootstrap-pending");
  assert.equal(rollbackCalled, false, "freshness/rollback drift is deferred while bootstrap-pending");
  assert.equal(syncDeltaCalled, false, "canonical-derived drift is deferred while bootstrap-pending");
  const joined = logs.join("\n");
  assert.match(joined, /Governance doctor OK/);
  assert.match(joined, new RegExp(`\\[bootstrap-pending\\] The coord/ control-plane repository ${DOCTOR_COORD_DIR} has no commits yet`));
  assert.match(joined, /strict diagnostics resume after the first committed baseline/i);
});

// COORD-631/ADR-0008: a legacy container-Git installation (coord/ merely inside
// some other repository) must NOT be reported as bootstrap-pending — that would
// tell the adopter to stage and commit the workspace container, which is exactly
// what the ADR forbids. Strict diagnostics stay ON.
test("COORD-631: a container-Git ancestor is NOT bootstrap-pending and does not defer strict diagnostics", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let provenanceCalled = false;
  let failed = null;
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      gitTry: containerAncestorGitTry,
      appendGovernanceProvenanceIssues: () => { provenanceCalled = true; },
    }));
    try { report.doctor({}); } catch { /* fail() throws by design */ }
  } finally {
    console.log = originalLog;
  }
  assert.equal(provenanceCalled, true, "strict provenance diagnostics are NOT deferred for an ancestor repository");
  const joined = logs.join("\n");
  assert.equal(/bootstrap-pending/.test(joined), false, "never advise bootstrapping the workspace container");
  assert.equal(/Workspace root/.test(joined), false);
  assert.equal(failed === null || !/bootstrap/.test(String(failed)), true);
});

test("COORD-678: doctor turns a derived-view inspector exception into an actionable diagnostic", () => {
  const createDoctorReport = require("./doctor-report.js");
  let failureMessage = "";
  const report = createDoctorReport(bootstrapDoctorDeps({
    inspectMaterializedViews: () => { throw new Error("fixture projection read failed"); },
    fail: (message) => { failureMessage = String(message); throw new Error("doctor-fail"); },
  }));
  assert.throws(() => report.doctor({}), /doctor-fail/);
  assert.match(failureMessage, /\[derived_view_inspection_failed\] fixture projection read failed/);
});

test("COORD-477: strict diagnostics resume once coord/ is established (first baseline commit exists)", () => {
  const createDoctorReport = require("./doctor-report.js");
  let failed = null;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      fail: (msg) => { failed = msg; throw new Error("doctor-fail"); },
      gitTry: establishedGitTry,
      computeSyncDelta: () => ["rendered/TASKS.md"],
      canonicalSyncablePaths: () => ["rendered/TASKS.md"],
    }));
    assert.throws(() => report.doctor({}), /doctor-fail/);
  } finally {
    console.log = originalLog;
  }
  assert.match(failed, /Canonical derived artifacts drift from HEAD/, "the strict drift error is back after the baseline commit");
  assert.equal(/bootstrap-pending/.test(failed), false);
});

test("COORD-644: board-wide doctor keeps freshness and journal-health findings advisory", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      auditRepoWorktrees: () => ({
        is_own_repository: false,
        repo_root: "/tmp/coord644-configured-repo",
        enclosing_repository: "/tmp/coord644-workspace",
        stale_ticket_worktrees: [],
        unknown_ticket_worktrees: [],
        missing_doing_worktrees: [],
      }),
      auditCoordWorktrees: () => { throw new Error("disposable coord worktree registry unavailable"); },
      detectColocatedForeignSessions: () => ({ foreign_sessions: [
        { session_id: "session-a", handle: "codexa01", thread_id: "thread-a" },
        { session_id: "session-b", handle: "codexa02", thread_id: "thread-b" },
      ] }),
      verifyGovernanceChain: () => ({ ok: true, preChainCount: 2, chainedCount: 0, broken: [] }),
      buildJournalHealthReport: () => ({ status: "warning", warnings: [{ message: "retention threshold reached" }] }),
      formatJournalHealthWarning: () => "[journal-retention] retention threshold reached",
      detectMaturityStaleness: () => ["coord/TEST_MATURITY.md is stale; run gov coverage-rollup"],
      detectRollbackDrift: () => ({ reasons: ["journaled board content changed"] }),
      detectGateProcOrphans: () => [{
        gateRunId: "gate-run-644",
        entry: { ticket: "DEBT-644", lane: "default", repo: "coord" },
        reason: "ticket is no longer doing",
      }],
      buildQuestionQueueReport: () => ({
        total: 1,
        by_type: { informational: 1 },
        by_severity: { low: 1 },
        by_aging: { "same-day": 1 },
      }),
      formatBucketCounts: (counts, order) => order.filter((key) => counts[key]).map((key) => `${key}=${counts[key]}`).join(","),
      collectLandingAuditReport: () => ({ findings: ["landing row needs review"] }),
      formatLandingAuditSummary: () => ["Landing audit: one row needs review"],
    }));
    report.doctor({});
  } finally {
    console.log = originalLog;
  }

  const output = logs.join("\n");
  assert.match(output, /Governance doctor OK/);
  assert.match(output, /not a Git repository of its own; it sits inside \/tmp\/coord644-workspace/);
  assert.match(output, /could not audit coord worktrees: disposable coord worktree registry unavailable/);
  assert.match(output, /identity\/concurrency.*2 heartbeat-fresh governed sessions/);
  assert.match(output, /journal-chain.*2 pre-chain/);
  assert.match(output, /journal-retention.*retention threshold reached/);
  assert.match(output, /coverage-maturity.*TEST_MATURITY\.md is stale/);
  assert.match(output, /\[freshness\] journaled board content changed/);
  assert.match(output, /gate-proc-orphan.*gate-run-644.*ticket DEBT-644.*repo=coord lane=default/);
  assert.match(output, /Queue debt: unresolved orchestrator questions=1/);
  assert.match(output, /Landing audit: one row needs review/);
});

test("COORD-644: ticket-scoped doctor demotes another owner's missing-lock issue to a warning", () => {
  const createDoctorReport = require("./doctor-report.js");
  const row = { ID: "DEBT-644-OWNER", Repo: "X", Status: "doing", Owner: "codexa01" };
  const board = { sections: [{ rows: [row] }], prompt_index: { [row.ID]: "coord/prompts/tickets/DEBT-644-OWNER.md" } };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      readBoard: () => board,
      getTicketRef: (_board, id) => id === row.ID ? { row } : null,
      getRows: (candidate) => candidate.sections.flatMap((section) => section.rows || []),
      rowsById: (candidate) => new Map(candidate.sections.flatMap((section) => section.rows || []).map((item) => [item.ID, item])),
      evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
      findLockForTicket: () => null,
      isDoingStatus: (status) => status === "doing",
      isRegisteredAgentHandle: () => true,
      hasPromptWaiver: () => false,
      canonicalizeOwnerOrFail: (owner) => owner,
      appendGovernanceProvenanceIssues: () => {},
    }));
    report.doctor({ ticket: row.ID, owner: "codexa02" });
  } finally {
    console.log = originalLog;
  }
  const output = logs.join("\n");
  assert.match(output, /Governance doctor OK/);
  assert.match(output, /\[other owner: codexa01\] Ticket DEBT-644-OWNER is doing but has no lock/);
  assert.doesNotMatch(output, /Governance doctor found issues/,
    "owner-scoped physical drift is reported without blocking a different owner");
});

test("COORD-644: doctor delegates repair modes and preserves the default unknown-ticket refusal", () => {
  const createDoctorReport = require("./doctor-report.js");
  const delegated = [];
  const report = createDoctorReport({
    doctorFix: (options) => { delegated.push(options); return { repaired: true }; },
    readBoard: () => assert.fail("repair modes must delegate before the read-only report path"),
  });
  assert.deepEqual(report.doctor({ repairAll: true, confirm: true }), { repaired: true });
  assert.deepEqual(report.doctor({ fix: true, ticket: "DEBT-644" }), { repaired: true });
  assert.deepEqual(delegated, [
    { repairAll: true, confirm: true },
    { fix: true, ticket: "DEBT-644" },
  ]);

  const defaultFailure = createDoctorReport({
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => null,
  });
  assert.throws(() => defaultFailure.doctor({ ticket: "UNKNOWN-644" }), /Unknown ticket/,
    "without an injected failure handler an unknown target still uses the governance default refusal");
});

test("COORD-644: doctor names all control-plane and product-worktree audit classes", () => {
  const createDoctorReport = require("./doctor-report.js");
  let failed = null;
  const report = createDoctorReport(bootstrapDoctorDeps({
    fail: (message) => { failed = message; throw new Error("doctor-audit-fail"); },
    repoNameForCode: (code) => code === "B" ? "backend" : String(code),
    auditCoordWorktrees: () => ({
      control_plane_repo_root: "/tmp/coord644-control-plane",
      stale_worktrees: [{ ticket: "DEBT-644-OLD", path: "/tmp/old", status: "done", owner: "codexa01" }],
      unknown_ticket_worktrees: [{ path: "/tmp/unknown" }],
      orphaned_registrations: ["/tmp/removed"],
      missing_doing_worktrees: ["DEBT-644-MISSING"],
    }),
    auditRepoWorktrees: (repoCode) => repoCode === "B" ? ({
      is_own_repository: false,
      repo_root: "/tmp/coord644-backend",
      enclosing_repository: null,
      stale_ticket_worktrees: [{ ticket: "DEBT-644-PRODUCT-OLD", path: "/tmp/product-old", owner: "codexa02" }],
      unknown_ticket_worktrees: [{ ticket: "DEBT-644-UNKNOWN", path: "/tmp/product-unknown" }],
      missing_doing_worktrees: ["DEBT-644-PRODUCT-MISSING"],
    }) : ({ stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] }),
  }));
  assert.throws(() => report.doctor({}), /doctor-audit-fail/);
  assert.match(failed, /stale coord worktree.*control-plane repository \/tmp\/coord644-control-plane/);
  assert.match(failed, /unknown coord worktree.*control-plane repository \/tmp\/coord644-control-plane/);
  assert.match(failed, /orphaned coord worktree registration.*\/tmp\/removed/);
  assert.match(failed, /missing coord worktree for doing ticket DEBT-644-MISSING/);
  assert.match(failed, /backend stale worktree for DEBT-644-PRODUCT-OLD/);
  assert.match(failed, /backend unknown ticket worktree: \/tmp\/product-unknown/);
  assert.match(failed, /backend missing doing worktree for DEBT-644-PRODUCT-MISSING/);
});

test("COORD-644: clean control-plane worktree audit has no stale, unknown, orphaned, or missing findings", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      auditCoordWorktrees: () => ({
        control_plane_repo_root: "/tmp/coord644-clean-audit",
        stale_worktrees: [],
        unknown_ticket_worktrees: [],
        orphaned_registrations: [],
        missing_doing_worktrees: [],
      }),
    }));
    report.doctor({});
  } finally {
    console.log = originalLog;
  }
  assert.match(logs.join("\n"), /Governance doctor OK/,
    "an empty real audit result stays clean across each control-plane worktree category");
});

test("COORD-644: board-wide doctor preserves diagnostic channels when optional probes fail", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      auditCoordWorktrees: () => ({
        control_plane_repo_root: null,
        stale_worktrees: [],
        unknown_ticket_worktrees: [],
        orphaned_registrations: [],
        missing_doing_worktrees: [],
      }),
      readAgentSessions: () => [{ thread_id: "fixture-thread" }, { thread_id: "other-thread" }],
      detectColocatedForeignSessions: () => { throw new Error("advisory session probe failed"); },
      detectOutOfBandBoardMutation: () => { throw new Error("provenance probe failed"); },
      verifyGovernanceChain: () => { throw new Error("chain reader failed"); },
      buildJournalHealthReport: () => { throw new Error("retention reader failed"); },
      detectMaturityStaleness: () => { throw new Error("maturity reader failed"); },
      detectGateProcOrphans: () => { throw new Error("gate registry failed"); },
      canonicalSyncablePaths: () => { throw new Error("sync scope failed"); },
    }));

    report.doctor({});
  } finally {
    console.log = originalLog;
  }

  const output = logs.join("\n");
  assert.match(output, /\[journal-chain\] chain verification did not complete: chain reader failed/);
  assert.match(output, /\[journal-retention\] health check did not complete: retention reader failed/);
  assert.match(output, /\[coverage-maturity\] staleness check did not complete: maturity reader failed/);
  assert.match(output, /\[gate-proc-orphan\] orphan check did not complete: gate registry failed/);
  assert.match(output, /\[canonical-derived-drift\] drift check did not complete: sync scope failed/);
  assert.doesNotMatch(output, /Governance doctor found issues/,
    "optional report probes must not turn unavailable diagnostics into hard errors");
  assert.doesNotMatch(output, /provenance probe failed/,
    "out-of-band read failures remain the responsibility of the primary provenance check");
});

test("COORD-644: journal health stays quiet when no optional formatter is registered", () => {
  const createDoctorReport = require("./doctor-report.js");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      buildJournalHealthReport: () => ({ status: "healthy", warnings: [] }),
    }));
    report.doctor({});
  } finally {
    console.log = originalLog;
  }
  assert.match(logs.join("\n"), /Governance doctor OK/);
  assert.doesNotMatch(logs.join("\n"), /journal-retention/,
    "absence of the optional formatter produces no fabricated health warning");
});

test("COORD-644: doctor reports detected protocol drift with explicit journal evidence", () => {
  const createDoctorReport = require("./doctor-report.js");
  let failure = "";
  const report = createDoctorReport(bootstrapDoctorDeps({
    fail: (message) => { failure = message; throw new Error(message); },
    auditCoordWorktrees: () => ({
      control_plane_repo_root: null,
      stale_worktrees: [{ ticket: "DEBT-644-STALE", path: "/tmp/stale-worktree", status: "done", owner: "codexa01" }],
      unknown_ticket_worktrees: [],
      orphaned_registrations: [],
      missing_doing_worktrees: [],
    }),
    detectOutOfBandBoardMutation: () => ({
      detected: true,
      paths: ["coord/board/tasks.json"],
      latestEvent: { ts: "2026-10-03T12:00:00.000Z" },
    }),
    verifyGovernanceChain: () => ({
      ok: false,
      broken: [{ index: 7, reason: "previous hash mismatch", command: "update-plan", ts: "2026-10-03T12:00:00.000Z" }],
    }),
    collectStaleTemplateFeedbackErrors: () => ["stale template feedback requires review"],
  }));

  assert.throws(() => report.doctor({}), /Out-of-band board mutation detected/);
  assert.match(failure, /stale coord worktree for DEBT-644-STALE in the control plane \(coord\/\)/,
    "a no-repository topology labels stale control-plane state without borrowing a product-repository root");
  assert.match(failure, /coord\/board\/tasks\.json changed with no journaled transaction since 2026-10-03/);
  assert.match(failure, /Governance journal hash-chain is broken at 1 event/);
  assert.match(failure, /previous hash mismatch, update-plan/);
  assert.match(failure, /TEMPLATE_FEEDBACK=1/);
  assert.doesNotMatch(failure, /stale template feedback requires review/, "default output keeps feedback collapsed while retaining its failure count");
});

test("COORD-644: journal diagnostics omit optional command and timestamp fields", () => {
  let failure = "";
  const report = require("./doctor-report.js")(bootstrapDoctorDeps({
    fail: (message) => { failure = message; throw new Error(message); },
    verifyGovernanceChain: () => ({
      ok: false,
      broken: [
        { index: 1, reason: "legacy-shaped event after chain start", command: null, ts: null },
        { index: 2, reason: "missing command", command: null, ts: "2026-10-03T12:01:00.000Z" },
        { index: 3, reason: "missing timestamp", command: "update-plan", ts: null },
      ],
    }),
  }));

  assert.throws(() => report.doctor({}), /Governance doctor found issues/);
  assert.match(failure, /#1 \(legacy-shaped event after chain start\)/);
  assert.match(failure, /#2 \(missing command @ 2026-10-03T12:01:00\.000Z\)/);
  assert.match(failure, /#3 \(missing timestamp, update-plan\)/);
});

test("COORD-644: ticket-scoped worktree audit skips other-ticket physical drift but keeps global findings", () => {
  const createDoctorReport = require("./doctor-report.js");
  const target = { ID: "DEBT-644-TARGET", Repo: "X", Status: "done", Owner: "codexa01" };
  let failure = "";
  const report = createDoctorReport(bootstrapDoctorDeps({
    fail: (message) => { failure = message; throw new Error(message); },
    readBoard: () => ({ sections: [{ rows: [target] }] }),
    getTicketRef: (_board, id) => id === target.ID ? { row: target } : null,
    getRows: (board) => board.sections.flatMap((section) => section.rows || []),
    rowsById: (board) => new Map(board.sections.flatMap((section) => section.rows || []).map((row) => [row.ID, row])),
    auditCoordWorktrees: () => ({
      control_plane_repo_root: "/tmp/coord644-audit",
      stale_worktrees: [{ ticket: "DEBT-644-OTHER-STALE", path: "/tmp/other-stale", status: "done", owner: "codexa02" }],
      unknown_ticket_worktrees: [{ path: "/tmp/unowned-worktree" }],
      orphaned_registrations: ["/tmp/removed-worktree"],
      missing_doing_worktrees: ["DEBT-644-OTHER-MISSING"],
    }),
  }));

  assert.throws(() => report.doctor({ ticket: target.ID }), /Governance doctor found issues/);
  assert.match(failure, /unknown coord worktree.*\/tmp\/unowned-worktree/,
    "unknown worktrees remain board-level errors under ticket scope");
  assert.match(failure, /orphaned coord worktree registration.*\/tmp\/removed-worktree/,
    "orphaned Git registrations remain board-level errors under ticket scope");
  assert.doesNotMatch(failure, /other-stale|OTHER-MISSING/,
    "ticket scope skips physical stale/missing worktree findings belonging to other tickets");
});

test("COORD-644: colocation warning formats incomplete detector identities safely", () => {
  const createDoctorReport = require("./doctor-report.js");
  const { state } = require("./governance-context.js");
  const sessionOwner = createGovernanceSession({ state, AGENT_SESSION_IDLE_MS: 15 * 60 * 1000 });
  const logs = [];
  const originalLog = console.log;
  const sessions = ["first-thread", "second-thread"].map((thread_id) => ({
    board_path: state.BOARD_PATH,
    status: "active",
    thread_id,
    claimed_at: new Date().toISOString(),
  }));
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      readAgentSessions: () => sessions,
      detectColocatedForeignSessions: (options) => sessionOwner.detectColocatedForeignSessions(options),
    }));
    report.doctor({});
  } finally {
    console.log = originalLog;
  }
  assert.match(logs.join("\n"), /\?\(\?\)@thread:first-thread/);
  assert.match(logs.join("\n"), /\?\(\?\)@thread:second-thread/,
    "the real session detector can return incomplete identities and doctor keeps the warning readable");
});

test("COORD-644: ticket-scoped worktree audit filters unrelated physical findings", () => {
  const createDoctorReport = require("./doctor-report.js");
  const target = { ID: "DEBT-644-SCOPED", Repo: "X", Status: "todo", Owner: "unassigned" };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const report = createDoctorReport(bootstrapDoctorDeps({
      readBoard: () => ({ sections: [{ rows: [target] }] }),
      getTicketRef: (_board, id) => id === target.ID ? { row: target } : null,
      getRows: (board) => board.sections.flatMap((section) => section.rows || []),
      rowsById: (board) => new Map(board.sections.flatMap((section) => section.rows || []).map((row) => [row.ID, row])),
      evaluateReadiness: () => ({ cycles: [], blockedBy: [], blockerChains: [] }),
      findLockForTicket: () => null,
      isDoingStatus: () => false,
      isStaleTicketLock: () => true,
      auditCoordWorktrees: () => ({
        control_plane_repo_root: "/tmp/coord644-audit",
        stale_worktrees: [{ ticket: "DEBT-644-OTHER-STALE", path: "/tmp/other-stale", status: "done", owner: "codexa02" }],
        unknown_ticket_worktrees: [],
        orphaned_registrations: [],
        missing_doing_worktrees: ["DEBT-644-OTHER-MISSING"],
      }),
    }));
    report.doctor({ ticket: target.ID });
  } finally {
    console.log = originalLog;
  }
  assert.match(logs.join("\n"), /Governance doctor OK/);
  assert.doesNotMatch(logs.join("\n"), /other-stale|OTHER-MISSING/,
    "ticket-scoped diagnosis does not report another ticket's stale or missing worktree");
});

// COORD-856: the cleanup-worktree command printed for an unknown or orphaned
// coord worktree quotes its path, so a copy names exactly that worktree.
test("COORD-856: doctor cleanup-worktree commands quote a hostile worktree path", () => {
  const { HOSTILE_PATH_SEGMENT, splitPosixShellWords, shellArgv } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/posix-shell-words.js"));
  const unknown = `/srv/${HOSTILE_PATH_SEGMENT}unknown`;
  const orphan = `/srv/${HOSTILE_PATH_SEGMENT}orphan`;
  const { failure } = captureDoctor(doctorBoardFixture([], {
    auditCoordWorktrees: () => ({ stale_worktrees: [], unknown_ticket_worktrees: [{ path: unknown }], orphaned_registrations: [orphan], missing_doing_worktrees: [] }),
  }));
  const printed = [...String(failure).matchAll(/Remove it with `([^`]+)`/g)].map((match) => match[1]);
  assert.equal(printed.length, 2, String(failure));
  for (const [command, target] of [[printed[0], unknown], [printed[1], orphan]]) {
    const expected = ["coord/scripts/gov", "cleanup-worktree", "coord", target, "--yes"];
    assert.deepEqual(splitPosixShellWords(command), expected, command);
    assert.deepEqual(shellArgv(command), expected, `/bin/sh agrees: ${command}`);
  }
});

// COORD-862 (COORD-516a): doctor names the drift scope and the remedy per scope.
test("COORD-862: doctor scopes the out-of-band finding and reports pending committed-state adoption", () => {
  const { buildOutOfBandFinding, buildCanonicalDerivedDriftError, buildEngineDriftWarning } = require("./doctor-report.js");
  const latestEvent = { ts: "2026-10-24T00:00:00.000Z" };
  const scopes = { engine: [], governed: ["board/tasks.json", "prompts/tickets/T-1.md"], derived: [], runtime: [] };

  const declined = buildOutOfBandFinding({
    paths: ["board/tasks.json", "prompts/tickets/T-1.md"], scopes, latestEvent,
    committedState: { adopted: [], rejected: [{ path: "prompts/tickets/T-1.md", reason: "differs_from_head" }] },
  });
  assert.match(declined.error, /single-writer protocol bypass\): board\/tasks\.json, prompts\/tickets\/T-1\.md changed/);
  assert.match(declined.error, /Scope: engine intact, 2 project paths unjournaled \(governed 2\)\. Remedy by scope: governed: /);
  assert.match(declined.error, /declined: prompts\/tickets\/T-1\.md \(differs_from_head\)\./);
  assert.equal(declined.warning, null);

  const pending = buildOutOfBandFinding({
    paths: ["board/tasks.json", "prompts/tickets/T-1.md"], scopes, latestEvent,
    committedState: { adopted: ["prompts/tickets/T-1.md"], rejected: [], commit: "abc123", integration_branch: "dev" },
  });
  assert.match(pending.error, /bypass\): board\/tasks\.json changed/);
  assert.match(pending.warning, /^\[committed-state\] prompts\/tickets\/T-1\.md committed at abc123 on dev; the next governed mutation adopts it/);

  const onlyPending = buildOutOfBandFinding({
    paths: ["prompts/tickets/T-1.md"], latestEvent: null,
    committedState: { adopted: ["prompts/tickets/T-1.md"], rejected: [], commit: "abc123", integration_branch: "dev" },
  });
  assert.equal(onlyPending.error, null, "adoptable authored content alone is not a bypass");
  assert.match(onlyPending.warning, /ADR 0020/);
  assert.match(buildOutOfBandFinding({ paths: ["board/tasks.json"] }).error, /since unknown time/);

  assert.match(buildCanonicalDerivedDriftError(["rendered/TASKS.md", "board/tasks.json"]),
    /Scope: engine intact, 2 project paths uncommitted \(governed 1, derived 1\)\./);
  assert.equal(buildEngineDriftWarning(["backend/a.js"]), null);
  assert.match(buildEngineDriftWarning(["coord/scripts/a.js", "backend/a.js"]),
    /^\[engine-drift\] engine drift on 1 path: coord\/scripts\/a\.js, 1 project path uncommitted \(governed 1\)\. Engine remedy: /);
});

test("COORD-862: an empty out-of-band report yields no finding", () => {
  const { buildOutOfBandFinding } = require("./doctor-report.js");
  assert.deepEqual(buildOutOfBandFinding({}), { error: null, warning: null });
});

test("COORD-892: doctor reports a visible product worktree root with the clone-local remedy, and stays quiet once excluded", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const nodePath = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { ensureProductWorktreeExclude } = require("./product-worktree-exclude.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "doctor-coord892-")));
  try {
    const clone = nodePath.join(tmp, "product");
    fs.mkdirSync(nodePath.join(clone, ".worktrees", "claudea892", "BE-892"), { recursive: true });
    fs.writeFileSync(nodePath.join(clone, ".worktrees", "claudea892", "BE-892", "f.txt"), "x\n");
    assert.equal(spawnSync("git", ["-C", clone, "init", "-q", "-b", "main"]).status, 0);
    const audit = { repo_root: clone, stale_ticket_worktrees: [], unknown_ticket_worktrees: [], missing_doing_worktrees: [] };
    const visible = captureDoctor(doctorBoardFixture([], { auditRepoWorktrees: () => audit }));
    assert.equal(visible.failure, null, "the visibility finding is advisory, never a hard doctor error");
    assert.match(visible.output, /\[worktree-visibility\] .*\.worktrees shows as an untracked folder/);
    assert.match(visible.output, /printf '%s\\n' '?\/\.worktrees\/'? >> .*\.git\/info\/exclude/);

    ensureProductWorktreeExclude({ repoRoot: clone });
    const clean = captureDoctor(doctorBoardFixture([], { auditRepoWorktrees: () => audit }));
    assert.doesNotMatch(clean.output, /worktree-visibility/);

    // An unreadable exclude location is reported as an incomplete check, not a crash.
    const excludeFile = nodePath.join(clone, ".git", "info", "exclude");
    fs.writeFileSync(excludeFile, "");
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (target, ...args) {
      if (String(target) === excludeFile) throw Object.assign(new Error("EIO: injected exclude read failure"), { code: "EIO" });
      return originalRead.call(this, target, ...args);
    };
    let unreadable;
    try {
      unreadable = captureDoctor(doctorBoardFixture([], { auditRepoWorktrees: () => audit }));
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(unreadable.failure, null);
    assert.match(unreadable.output, /\[worktree-visibility\] .*could not check whether .*\.worktrees is ignored: EIO: injected exclude read failure/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-931: doctor reports a dangling runtime lock link explicitly and read-only.
test("COORD-931: doctor warns for a dangling runtime lock link, not for absent or live locks", () => {
  const { buildDanglingLockWarnings } = require("./doctor-report.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord931-doctor-"));
  try {
    const dangling = path.join(tmp, ".agent-state.lock");
    fs.symlinkSync(path.join(tmp, ".agent-state.lock.acquire-gone"), dangling, "dir");
    const live = path.join(tmp, "coord-state.lock");
    fs.mkdirSync(path.join(tmp, "coord-state.acquire-live"));
    fs.symlinkSync(path.join(tmp, "coord-state.acquire-live"), live, "dir");
    const absent = path.join(tmp, "governance.lock");

    const warnings = buildDanglingLockWarnings([
      { kind: "agent-state", path: dangling },
      { kind: "coord-state", path: live },
      { kind: "governance-runtime", path: absent },
    ]);
    assert.equal(warnings.length, 1, "only the dangling link is reported");
    assert.match(warnings[0], /^\[runtime-lock\] agent-state lock at .*\.agent-state\.lock is a dangling link/);
    assert.match(warnings[0], /target_exists=no/);
    assert.match(warnings[0], /break-runtime-lock --kind agent-state --yes/);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true, "the report never removes the link");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-928: doctor reports prompt_index entries whose prompt file has no committed
// copy (read-only; the publication refusal lives in sync-provenance.js).
test("COORD-928: doctor warns for prompt_index entries without a committed file, and not for committed ones", () => {
  const { buildPromptIndexDoctorWarnings } = require("./doctor-report.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord928-doctor-"));
  const git = (cwd, args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).trim();
  try {
    const repo = path.join(tmp, "repo");
    const coord = path.join(repo, "coord");
    fs.mkdirSync(path.join(coord, "board"), { recursive: true });
    fs.writeFileSync(path.join(coord, "board", "tasks.json"), "{}\n");
    require("./test-git-fixture.js").gitFixture(repo, ["init", "--initial-branch=dev"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    fs.mkdirSync(path.join(coord, "prompts", "tickets"), { recursive: true });
    fs.writeFileSync(path.join(coord, "prompts", "tickets", "COORD-971.md"), "# COORD-971\n");
    git(repo, ["add", "coord/prompts/tickets/COORD-971.md"]);
    git(repo, ["commit", "-m", "prompt 971"]);
    const board = {
      prompt_index: {
        "COORD-887": "coord/prompts/tickets/COORD-887.md",
        "COORD-913": "coord/prompts/tickets/COORD-913.md",
        "COORD-971": "coord/prompts/tickets/COORD-971.md",
      },
    };
    const { gitTry } = require("./git-ops.js");
    const warnings = buildPromptIndexDoctorWarnings({ board, coordDir: coord, gitTry });
    assert.equal(warnings.length, 2, "only the two entries without a committed file are reported");
    assert.match(warnings[0], /^\[prompt-index\] COORD-887 -> coord\/prompts\/tickets\/COORD-887\.md has no committed file \(absent\)/);
    assert.match(warnings[1], /^\[prompt-index\] COORD-913 -> .* \(absent\)/);
    assert.ok(warnings.every((w) => !/COORD-971/.test(w)), "a committed prompt is not reported");

    const failing = (dir, args, options) => (args[0] === "ls-tree"
      ? { status: 128, stdout: "", stderr: "fatal: bad object HEAD" }
      : gitTry(dir, args, options));
    const inspected = buildPromptIndexDoctorWarnings({ board, coordDir: coord, gitTry: failing });
    assert.equal(inspected.length, 1);
    assert.match(inspected[0], /^\[prompt-index\] could not inspect git state/);

    assert.deepEqual(buildPromptIndexDoctorWarnings({ board: {}, coordDir: coord, gitTry }), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-1015: git reports the REAL toplevel. coord/ reached through a symlinked
// parent IS that toplevel, so it must classify as established, not as an ancestor.
test("COORD-1015 classifyCoordGitState: coord/ reached through a symlinked parent is its own toplevel", () => {
  const os = require("node:os");
  const fsn = require("node:fs");
  const pathMod = require("node:path");
  const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
  const real = fsn.realpathSync(fsn.mkdtempSync(pathMod.join(os.tmpdir(), "doctor-1015-")));
  const linkParent = fsn.mkdtempSync(pathMod.join(os.tmpdir(), "doctor-1015-link-"));
  try {
    gitFixture(real, ["init", "-q"]);
    gitFixture(real, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const link = pathMod.join(linkParent, "coord");
    fsn.symlinkSync(real, link, "dir");
    const gitTry = (cwd, args) => gitFixtureSpawn(cwd, args);
    const state = doctorReportModule.classifyCoordGitState({ gitTry, coordDir: link });
    assert.equal(state.state, "established", JSON.stringify(state));
    assert.equal(state.is_coord_repository, true);
  } finally {
    fsn.rmSync(linkParent, { recursive: true, force: true });
    fsn.rmSync(real, { recursive: true, force: true });
  }
});

test("COORD-1052: doctor reports attempts, read failures and unrelated active tickets without changing attempt refs", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { gitFixture } = require("./test-git-fixture.js");
  const { withScopedGovernanceTestContext } = require("../../scripts/governance-test-utils.js");
  const { COORD_STATE_ROOT, ATTEMPT_ORPHAN_MS } = require("./attempt-coordination.js");
  const { attemptRef, makeAttemptRecord } = require("./attempt-ref-lease.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-doctor-attempts-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  gitFixture(repo, ["init", "-b", "dev", "."]);
  gitFixture(repo, ["commit", "--allow-empty", "-m", "seed"]);
  const seed = gitFixture(repo, ["rev-parse", "HEAD"]);
  gitFixture(repo, ["remote", "add", "origin", repo]);

  const staleTicket = "COORD-99991";
  const brokenTicket = "COORD-99992";
  const owner = "codexa11";
  const domainId = "a".repeat(32);
  const record = makeAttemptRecord({
    ticket: staleTicket, agent: { handle: owner }, domainId, journalTxId: "doctor-diagnostic",
    baseSha: seed, branch: "ticket", observedCanonical: { generation: 0 },
    now: new Date(Date.now() - ATTEMPT_ORPHAN_MS - 60_000).toISOString(),
  });
  fs.writeFileSync(path.join(repo, "record.json"), JSON.stringify(record));
  gitFixture(repo, ["add", "record.json"]);
  gitFixture(repo, ["commit", "-m", "record stale attempt"]);
  gitFixture(repo, ["update-ref", attemptRef(COORD_STATE_ROOT, staleTicket, domainId, record.attempt_id), "HEAD"]);
  gitFixture(repo, ["update-ref", attemptRef(COORD_STATE_ROOT, brokenTicket, domainId, record.attempt_id), seed]);
  const refs = gitFixture(repo, ["for-each-ref", COORD_STATE_ROOT]);
  const rows = [staleTicket, brokenTicket].map((ID) => ({ ID, Repo: "X", Status: "doing", Owner: owner }));
  const report = doctorBoardFixture(rows);
  const runtime = path.join(repo, ".runtime");
  fs.mkdirSync(runtime);
  const danglingLock = path.join(runtime, "governance.lock");
  fs.symlinkSync(path.join(runtime, "missing-acquisition"), danglingLock, "dir");
  const result = withScopedGovernanceTestContext({
    RUNTIME_DIR: runtime,
    GOVERNANCE_EVENT_LOCK_DIR: danglingLock,
  }, () => captureDoctor(report, { ticket: staleTicket, owner: "codexa22" }));
  assert.equal(result.failure, null);
  const warnings = result.output.split("\n");
  for (const severity of ["attempt-stale", "attempt-orphaned"]) {
    assert.ok(warnings.some((line) => line ===
      `[${severity}] ${staleTicket}: attempt ${record.attempt_id} by ${owner} (domain ${domainId}) ` +
      `last updated ${record.updated_at}. Report only; nothing is deleted (ADR 0023 section 7).`), result.output);
  }
  assert.ok(warnings.some((line) => line.startsWith(`[attempt-health] ${brokenTicket}: check did not complete: Could not read record.json`)), result.output);
  assert.ok(warnings.some((line) => line.startsWith(`[owner-doing] ${owner} holds unrelated doing tickets ${staleTicket} and ${brokenTicket}`)), result.output);
  assert.ok(warnings.some((line) => line.startsWith("[prompt-index] ")), result.output);
  assert.ok(warnings.some((line) => line.startsWith(`[runtime-lock] governance-runtime lock at ${danglingLock} is a dangling link`)), result.output);
  assert.equal(fs.lstatSync(danglingLock).isSymbolicLink(), true);
  assert.equal(gitFixture(repo, ["for-each-ref", COORD_STATE_ROOT]), refs);
});

test("COORD-1052: doctor distinguishes stale integration refs from missing integration refs", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { gitFixture } = require("./test-git-fixture.js");
  const { withScopedGovernanceTestContext } = require("../../scripts/governance-test-utils.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-doctor-integration-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  gitFixture(repo, ["init", "-b", "dev", "."]);
  gitFixture(repo, ["commit", "--allow-empty", "-m", "initial dev"]);
  gitFixture(repo, ["switch", "--detach"]);
  gitFixture(repo, ["commit", "--allow-empty", "-m", "new origin dev"]);
  gitFixture(repo, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  const row = { ID: "COORD-99993", Repo: "X", Status: "todo", Owner: "unassigned" };
  const report = doctorBoardFixture([row], { getRepoRoot: () => repo, repoNameForCode: () => "sample-product" });
  withScopedGovernanceTestContext({ REPO_ROOTS: { B: repo }, REPO_INTEGRATION_BRANCHES: {} }, () => {
    const refs = gitFixture(repo, ["for-each-ref"]);
    const stale = captureDoctor(report, { ticket: row.ID });
    assert.equal(stale.failure, null);
    assert.match(stale.output, /\[integration-base-ref-lags-origin\] sample-product: .*Remedy: .*git branch -f dev origin\/dev/);
    assert.equal(gitFixture(repo, ["for-each-ref"]), refs);

    // If Git becomes unavailable between checking the refs and reading their
    // SHAs, keep doctor read-only and report that the check was inconclusive.
    const { execFileSync } = require("node:child_process");
    const gitExecutable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(repo, "fixture-bin");
    fs.mkdirSync(bin);
    const git = path.join(bin, "git");
    fs.writeFileSync(git, [
      "#!/bin/sh",
      'if [ "$2" = "$COORD_DOCTOR_FIXTURE_REPO" ] && [ "$6" = "dev^{commit}" ]; then',
      '  /bin/rm "$0"',
      'fi',
      'exec "$COORD_DOCTOR_FIXTURE_GIT" "$@"',
      "",
    ].join("\n"), { mode: 0o700 });
    const originalPath = process.env.PATH;
    let interrupted;
    try {
      process.env.PATH = bin;
      process.env.COORD_DOCTOR_FIXTURE_REPO = repo;
      process.env.COORD_DOCTOR_FIXTURE_GIT = gitExecutable;
      interrupted = captureDoctor(report, { ticket: row.ID });
    } finally {
      process.env.PATH = originalPath;
      delete process.env.COORD_DOCTOR_FIXTURE_REPO;
      delete process.env.COORD_DOCTOR_FIXTURE_GIT;
    }
    assert.equal(fs.existsSync(git), false, "the fixture withdrew Git after the local ref probe");
    assert.equal(interrupted.failure, null);
    assert.match(interrupted.output, /\[integration-base-ref\] sample-product: check did not complete:/);
    assert.equal(gitFixture(repo, ["for-each-ref"]), refs);

    gitFixture(repo, ["update-ref", "-d", "refs/remotes/origin/dev"]);
    gitFixture(repo, ["update-ref", "-d", "refs/heads/dev"]);
    const missing = captureDoctor(report, { ticket: row.ID });
    assert.match(missing.failure, /\[integration-base-ref-missing\] sample-product: .*Remedy: git fetch origin dev/);
    assert.equal(gitFixture(repo, ["for-each-ref"]), "");
  });
});
