// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
"use strict";

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

test("buildDoctorResolutionGuidance adds a QUESTIONS.md reminder for ticket-scoped doctor issues", () => {
  const guidance = __testing.buildDoctorResolutionGuidance([
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
  assert.equal(__testing.buildDoctorResolutionGuidance([
    "frontend unknown ticket worktree: /tmp/ebmr-review",
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
