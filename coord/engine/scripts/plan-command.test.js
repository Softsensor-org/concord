process.env.COORD_PROJECT_CONFIG = require("node:path").resolve(__dirname, "fixtures", "hermetic-project.config.js"); // COORD-967: hermetic board/integration branch defaults
// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";
const governanceCommands = require("./lifecycle.js").commands;

// Wave 2 (COORD-060): plan-command tests relocated out of governance.test.js
// into a module-owned file. Exercise the plan-seed builder and the structured
// plan-block mutation verbs (requirement closure, feature proofs, review
// cycles) via the governance __testing surface. Wave 3 (COORD-069): the
// dedicated repo-gate attribution/formatting helper tests moved to
// gates.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const testUtils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { __testing } = testUtils;
const { state: governanceState } = require("./governance-context.js");
const { withScopedGovernanceTestContext } = testUtils;
const createPlanCommand = require("./plan-command.js");
const { selectPlanUpdateOptions } = require("./plan-update-options.js");
const boardValidation = require("../../board/board.js").__testing;
const { evidenceRef, stableSupersessionId, resolvePlanEvidence } = require("./plan-evidence-supersession.js");
const approvalVerifier = require("./approval-verifier.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function withSignedTicketApproval(verb, ticket, reason, state, run) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const subject_sha256 = approvalVerifier.subjectSha256({ verb, ticket, reason, state: approvalVerifier.canonicalJson(state) });
    fixture.login({ verb, ticket, subject_sha256 });
    return withApprovalTestClient(path.resolve(__dirname, "..", ".."), fixture.client(), run);
  } finally {
    fixture.cleanup();
  }
}

test("COORD-1048: plan mutation owner override requires a signature bound to the exact ticket, plan, and updates", () => {
  const tempRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "coord1048-plan-approval-"));
  const ticketId = "IMP-1048";
  const reason = "fixture admin approved this exact plan update";
  const row = { ID: ticketId, Owner: "claudea12", Status: "doing", Repo: "X", Type: "task", Pri: "P1", Description: "synthetic plan approval" };
  let plan = { ticket: ticketId, startup: "completed", traceability: "fixture traceability" };
  const events = [];
  const options = { startup: "completed", humanAdminOverride: reason };
  const resolveHumanAdminOverride = (commandName, input) => {
    const explicit = String(input.humanAdminOverride || "").trim();
    if (!explicit) throw new Error(`${commandName} requires --human-admin-override`);
    return { reason: explicit, legacyForceAlias: false };
  };
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => ({ row }),
    readPlanState: () => plan,
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "claudea11" }, session: { session_id: "synthetic-session" } }),
    ensureTicketMutationOwnership: () => { throw new Error("owner-only path must not be used for an authorized override"); },
    resolveHumanAdminOverride,
    appendGovernanceEvent: (event) => events.push(event),
    runtimeDir: tempRuntime,
  });
  const state = {
    ticket: row,
    plan,
    updates: selectPlanUpdateOptions(options),
  };
  try {
    assert.throws(
      () => command.assertTicketPlanMutationAuthority(ticketId, options),
      /signed human-admin approval.*Subject digest:/
    );
    const approved = withSignedTicketApproval("plan mutation", ticketId, reason, state, () =>
      command.assertTicketPlanMutationAuthority(ticketId, options));
    assert.equal(approved.agent.handle, "claudea11");
    assert.equal(events.filter((event) => event.event === "approval.verified").length, 1);

    const previousPlan = plan;
    plan = undefined;
    const withoutPlan = withSignedTicketApproval("plan mutation", ticketId, reason, { ...state, plan: null }, () =>
      command.assertTicketPlanMutationAuthority(ticketId, options));
    assert.equal(withoutPlan.agent.handle, "claudea11");
    plan = previousPlan;

    const staleFixture = createApprovalFixture({ allowedVerbs: ["plan mutation"] });
    try {
      const digest = approvalVerifier.subjectSha256({ verb: "plan mutation", ticket: ticketId, reason,
        state: approvalVerifier.canonicalJson(state) });
      staleFixture.login({ verb: "plan mutation", ticket: ticketId, subject_sha256: digest });
      plan = { ...plan, startup: "reopened" };
      const stale = withApprovalTestClient(path.resolve(__dirname, "..", ".."), staleFixture.client(), () =>
        command.assertTicketPlanMutationAuthority(ticketId, options));
      assert.equal(stale, undefined);
    } catch (error) {
      assert.match(error.message, /scope-mismatch/);
    } finally {
      staleFixture.cleanup();
    }
  } finally {
    fs.rmSync(tempRuntime, { recursive: true, force: true });
  }
});

function readPlanRecordFromSandbox(ticketId, recordsDir = governanceState.PLAN_RECORDS_DIR) {
  return JSON.parse(fs.readFileSync(path.join(recordsDir, `${ticketId}.json`), "utf8"));
}

test("buildPlanStatusPayload refuses missing and unknown tickets before plan effects", () => {
  const calls = { readBoard: 0, getTicketRef: 0, readPlanState: 0, readiness: 0, writes: 0, mutations: 0 };
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => { calls.readBoard += 1; return { sections: [] }; },
    getTicketRef: (_board, ticketId) => {
      calls.getTicketRef += 1;
      return ticketId === "PLAN-STATUS-EXISTS" ? { row: { ID: ticketId, Repo: "X", Status: "todo" } } : null;
    },
    readPlanState: () => { calls.readPlanState += 1; return null; },
    collectStartReadinessBlockers: () => { calls.readiness += 1; return []; },
    collectReviewPlanReadinessIssues: () => { calls.readiness += 1; return []; },
    updateCanonicalPlanState: () => { calls.writes += 1; },
    withGovernanceMutation: (_mutation, action) => { calls.mutations += 1; return action(); },
    isDoingStatus: () => false,
  });

  assert.throws(() => command.buildPlanStatusPayload(undefined), /plan requires <ticket-id>/);
  assert.deepEqual(calls, {
    readBoard: 0, getTicketRef: 0, readPlanState: 0, readiness: 0, writes: 0, mutations: 0,
  }, "a missing id is refused before any board read or plan effect");

  assert.throws(() => command.buildPlanStatusPayload("PLAN-STATUS-MISSING"), /Unknown ticket "PLAN-STATUS-MISSING"/);
  assert.deepEqual(calls, {
    readBoard: 1, getTicketRef: 1, readPlanState: 0, readiness: 0, writes: 0, mutations: 0,
  }, "an unknown id is refused after lookup but before plan/readiness writers or mutations");
});

test("buildPlanStatusPayload defaults omitted optional start advisories to an empty list", () => {
  const calls = { writes: 0, mutations: 0 };
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: (_board, ticketId) => ({ row: { ID: ticketId, Repo: "X", Status: "todo" } }),
    readPlanState: () => null,
    collectStartReadinessBlockers: () => [],
    collectReviewPlanReadinessIssues: () => [],
    updateCanonicalPlanState: () => { calls.writes += 1; },
    withGovernanceMutation: (_mutation, action) => { calls.mutations += 1; return action(); },
    isDoingStatus: () => false,
    // collectStartReadinessAdvisories is intentionally omitted to exercise the
    // factory's compatibility fallback for callers predating that collaborator.
  });

  const payload = command.buildPlanStatusPayload("PLAN-STATUS-LEGACY-CALLER");
  assert.deepEqual(payload.start_readiness.advisories, []);
  assert.deepEqual(payload.start_readiness.blockers, []);
  assert.equal(payload.start_readiness.ready, true);
  assert.deepEqual(calls, { writes: 0, mutations: 0 }, "status projection remains read-only");
});

test("plan next commands route review-plan blockers only for doing tickets and dedupe their next steps", () => {
  const plan = { ticket: "PLAN-NEXT" };
  const issuesByTicket = {
    "PLAN-NEXT-DOING": [
      { gate: "requirement_closure", next_steps: ["coord/scripts/gov set-requirement-closure PLAN-NEXT-DOING", "coord/scripts/gov plan PLAN-NEXT-DOING"] },
      { gate: "review_cycles", next_steps: ["coord/scripts/gov plan PLAN-NEXT-DOING", "coord/scripts/gov set-review-cycles PLAN-NEXT-DOING"] },
      { gate: "no_steps" },
    ],
    "PLAN-NEXT-REVIEW": [
      { gate: "requirement_closure", next_steps: ["coord/scripts/gov set-requirement-closure PLAN-NEXT-REVIEW"] },
    ],
  };
  const statusByTicket = { "PLAN-NEXT-DOING": "doing", "PLAN-NEXT-REVIEW": "review" };
  const calls = { writes: 0, mutations: 0 };
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: (_board, ticketId) => ({ row: { ID: ticketId, Repo: "X", Status: statusByTicket[ticketId] } }),
    readPlanState: () => plan,
    collectStartReadinessBlockers: () => [],
    collectReviewPlanReadinessIssues: (ticketId) => issuesByTicket[ticketId],
    updateCanonicalPlanState: () => { calls.writes += 1; },
    withGovernanceMutation: (_mutation, action) => { calls.mutations += 1; return action(); },
    // Same predicate as governance-session.js isDoingStatus.
    isDoingStatus: (status) => typeof status === "string" && status.startsWith("doing"),
  });

  // Doing ticket with review-plan blockers: each blocker's next steps in order,
  // a step shared by two blockers appears once, a blocker without steps adds none.
  const doing = command.buildPlanStatusPayload("PLAN-NEXT-DOING");
  assert.equal(doing.review_readiness.ready, false);
  assert.deepEqual(doing.next_commands, [
    "coord/scripts/gov set-requirement-closure PLAN-NEXT-DOING",
    "coord/scripts/gov plan PLAN-NEXT-DOING",
    "coord/scripts/gov set-review-cycles PLAN-NEXT-DOING",
  ]);

  // Non-doing ticket with review-plan blockers: the doing guard short-circuits,
  // so the blockers' steps never become next commands.
  const review = command.buildPlanStatusPayload("PLAN-NEXT-REVIEW");
  assert.equal(review.review_readiness.ready, false);
  assert.deepEqual(review.next_commands, []);

  // Doing ticket whose context carries no reviewIssues: defaults to no blockers
  // and yields no next commands (plan already exists, so no --seed either).
  const doingRow = { ID: "PLAN-NEXT-DOING", Repo: "X", Status: "doing" };
  assert.deepEqual(command.buildPlanNextCommands("PLAN-NEXT-DOING", doingRow, plan, {}), []);
  assert.deepEqual(command.buildPlanNextCommands("PLAN-NEXT-DOING", doingRow, plan), []);
  assert.deepEqual(command.buildPlanNextCommands("PLAN-NEXT-DOING", doingRow, null), [
    "coord/scripts/gov plan PLAN-NEXT-DOING --seed",
  ]);

  assert.deepEqual(calls, { writes: 0, mutations: 0 }, "next-command projection remains read-only");
});

// Also serialized into child processes so each configuration is loaded through
// the real registry before lifecycle composition, without mutating shared paths.
function verifyHistoricalBackfillWriter(scriptsDir, expected) {
  const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
  const u = require(path.join(scriptsDir, "governance-test-utils.js"));
  const workerGovernanceState = require(path.join(scriptsDir, "governance-context.js")).state;
  u.sandboxProcessRuntime();
  u.withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const repos = ["B", "F", "X", "B"];
    const rows = repos.map((Repo, i) => ({ ID: `COORD-${999990 + i}`, Repo,
      Type: "chore", Pri: "P2", Status: "todo", Owner: "unassigned",
      Description: "Isolated historical backfill fixture", "Depends On": "" }));
    const belowThreshold = [{ ...rows[0], ID: "COORD-999989" }, { ...rows[1], ID: "COORD-999988" }];
    const board = { version: 1, metadata: { title: "Backfill fixture", last_updated: "2026-01-01", canonical_references: [],
      plan_records_required_from_ticket: { B: rows[0].ID },
      landing_index_required_from_ticket: { F: rows[1].ID, X: rows[2].ID } },
      sections: [{ kind: "table", level: 3, heading: "Fixture", separator_before: false,
        columns: Object.keys(rows[0]), rows: [...belowThreshold, ...rows] }], prompt_index: {}, pr_index: {},
      landing_index: {}, review_findings: {}, followup_exceptions: {} };
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2) + "\n");
    const recordPath = (id) => path.join(workerGovernanceState.PLAN_RECORDS_DIR, id + ".json");
    u.__testing.ensureGovernanceJournalBaseline("COORD-693 fixture");
    const dispatch = require(path.join(scriptsDir, "cli.js")).__testing.dispatchCommand;
    const args = ["--status", "todo", "--from", rows[0].ID];
    dispatch("backfill-plan-records", args);
    for (const row of belowThreshold) assert.equal(fs.existsSync(recordPath(row.ID)), false, "explicit threshold excludes older records");
    for (const row of rows) {
      const record = JSON.parse(fs.readFileSync(recordPath(row.ID)));
      assert.equal(record.governance.expected_closeout.base_ref, expected[row.Repo]);
      assert.match(record.baseline_reproduction.join("\n"), /synthesized from board lifecycle evidence/);
    }
    const existing = JSON.parse(fs.readFileSync(recordPath(rows[3].ID), "utf8"));
    existing.governance.expected_closeout.base_ref = "preserved-historical-branch";
    existing.verification_commands = ["original evidence must survive unchanged"];
    fs.writeFileSync(recordPath(rows[3].ID), JSON.stringify(existing, null, 4) + "\n");
    u.__testing.advanceGovernanceProvenanceBaseline("COORD-693 seeded preexisting record");
    const existingBytes = fs.readFileSync(recordPath(rows[3].ID), "utf8");
    const paths = [boardPath, logPath, ...rows.map(r => recordPath(r.ID)), workerGovernanceState.PLAN_PATH];
    const after = paths.map(p => fs.readFileSync(p));
    dispatch("backfill-plan-records", ["--status", "todo"]);
    for (const row of belowThreshold) assert.equal(fs.existsSync(recordPath(row.ID)), false, "repository metadata thresholds exclude older records");
    assert.deepEqual(paths.map(p => fs.readFileSync(p)), after, "repeat is byte-identical, including journal");
    const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.command === "backfill-plan-records").length, 1);
  }, { isolateBoardValidation: true });
}

test("COORD-693: public backfill writer honors the active registry and preserves existing records", () => {
  verifyHistoricalBackfillWriter(path.join(__dirname, "..", "..", "scripts"), { B: repoRegistryOwner.resolveRepoIntegrationBranch("B"),
    F: repoRegistryOwner.resolveRepoIntegrationBranch("F"), X: "main" });
});

test("COORD-784: sandboxed board validation still rejects a doing row without a lock", () => {
  const canonicalBoardPath = boardValidation.paths.BOARD_PATH;
  const canonicalLocksDir = boardValidation.paths.LOCKS_DIR;
  testUtils.withGovernedSurfaceSandbox(({ boardPath }) => {
    assert.equal(boardValidation.paths.BOARD_PATH, boardPath);
    assert.notEqual(boardValidation.paths.LOCKS_DIR, canonicalLocksDir);
    const tickets = new Map([["TEST-784", { row: { Status: "doing", Owner: "fixture" } }]]);
    const errors = [];
    boardValidation.validateLocks(tickets, errors);
    assert.deepEqual(errors, [
      "Ticket TEST-784 is doing but has no governed lock file in coord/.runtime/locks/ (or legacy coord/locks/ during migration).",
    ]);
  }, { isolateBoardValidation: true });
  assert.equal(boardValidation.paths.BOARD_PATH, canonicalBoardPath, "fixture restores the live board path");
  assert.equal(boardValidation.paths.LOCKS_DIR, canonicalLocksDir, "fixture restores the live lock path");
});

for (const branch of ["main", null]) {
  test(`COORD-693: public backfill writer honors ${branch || "omitted-branch fallback"} configuration`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord693-config-"));
    try {
      const config = path.join(dir, "project.config.js");
      const repo = p => ({ path: p, ...(branch ? { integrationBranch: branch } : {}) });
      fs.writeFileSync(config, "module.exports=" + JSON.stringify({ repos: { B: repo("backend"), F: repo("frontend") } }));
      const expected = { B: branch || "dev", F: branch || "dev", X: "main" };
      const script = `(${verifyHistoricalBackfillWriter.toString()})(${JSON.stringify(path.join(__dirname, "..", "..", "scripts"))},${JSON.stringify(expected)})`;
      const child = require("node:child_process").spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, COORD_PROJECT_CONFIG: config }, encoding: "utf8", timeout: 30000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stdout + child.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("buildStartPlanSeedUpdate seeds startup and traceability and adds baseline only for tickets that require it", () => {
  const seedTest = __testing.buildStartPlanSeedUpdate({
    ID: "DEBT-043",
    Repo: "B",
    Type: "test",
  });
  assert.equal(seedTest.startup, "completed");
  assert.equal(seedTest.traceability, "closing-gap");
  assert.deepEqual(seedTest.baseline, [
    "Command: <repro command>",
    "Outcome: <observed result>",
  ]);

  const seedFeature = __testing.buildStartPlanSeedUpdate({
    ID: "DEBT-041",
    Repo: "X",
    Type: "feature",
  });
  assert.equal(seedFeature.startup, "completed");
  assert.equal(seedFeature.traceability, "exempt");
  assert.equal(seedFeature.baseline, undefined);
});

test("planCommandUpdateOptions carries ADR refs and decision-required metadata", () => {
  const planCommand = createPlanCommand({
    toArray: (value) => Array.isArray(value) ? value : value === undefined ? [] : [value],
  });
  const update = planCommand.planCommandUpdateOptions({
    summary: "Change decision surface.",
    adrRef: "ADR-0001",
    decisionRequired: "{\"required\":true,\"status\":\"required\"}",
    unrelated: "ignored",
  });
  assert.deepEqual(update, {
    summary: "Change decision surface.",
    adrRef: "ADR-0001",
    decisionRequired: "{\"required\":true,\"status\":\"required\"}",
  });

  const merged = planCommand.mergePlanCommandOptions(
    { adrRef: ["ADR-0001"] },
    { adrRef: ["ADR-0002"] }
  );
  assert.deepEqual(merged.adrRef, ["ADR-0001", "ADR-0002"]);
});

test("structured plan helper commands write canonical review evidence without raw update-plan strings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-plan-helpers-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: recordsDir,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    // COORD-273: anchor a journal baseline before the first governed plan mutation
    // so it runs over an INITIALIZED journal (a healthy repo). Without it the new
    // journal-loss-over-existing-state guard refuses to silently auto-baseline.
    __testing.ensureGovernanceJournalBaseline("plan-helpers-seed");
    __testing.ensurePlanStub("IMP-201", "X", "codexa02");
    __testing.advanceGovernanceProvenanceBaseline("plan-stub-fixture");
    governanceCommands.setRequirementClosureCommand("IMP-201", {
      ticketAsk: "normalize governance plan entry UX",
      implemented: "structured helper commands for strict plan fields",
      notImplemented: "none",
      deferredTo: "none",
      closeoutVerdict: "complete",
    });
    governanceCommands.addFeatureProofCommand("IMP-201", { proofText: "add-review-cycle" });
    governanceCommands.addRepoGateCommand("IMP-201", { commandText: "node --test coord/scripts/governance.test.js", note: "structured helper regression" });
    governanceCommands.addReviewCycleCommand("IMP-201", {
      lens: "contract/state invariants",
      diff: "structured helper command output",
      risk: ["missing field mapping", "duplicate cycle formatting"],
      findings: "none",
      verification: "node --test coord/scripts/governance.test.js",
      verdict: "pass",
    });

    const record = readPlanRecordFromSandbox("IMP-201", recordsDir);
    assert.equal(record.requirement_closure[0], "Ticket ask: normalize governance plan entry UX");
    assert.equal(record.feature_proof.includes("text:add-review-cycle"), true);
    assert.equal(record.repo_gates.includes("node --test coord/scripts/governance.test.js - structured helper regression"), true);
    assert.equal(record.self_review_cycles.length, 1);
    assert.equal(record.self_review_cycles[0].lens, "contract/state invariants");
    assert.deepEqual(record.self_review_cycles[0].risks, ["missing field mapping", "duplicate cycle formatting"]);
    // COORD-739: exercise the public dispatcher through the real plan writer,
    // not only the option-classification helper.
    const { dispatchCommand } = require("./cli.js").__testing;
    dispatchCommand("update-plan", ["IMP-201", "--gate-plan", '{"planner_version":"gate-plan-v1"}',
      "--bootstrap-risk", '{"startup_work_class":"local_bootstrap"}', "--verify", "node --test repair"]);
    dispatchCommand("update-plan", ["IMP-201", "--replace-review-cycle", "1", "--review-cycle",
      "lens=contract; diff=CLI writer; risks=lost input; findings=none; verification=node --test; verdict=pass"]);
    const updated = readPlanRecordFromSandbox("IMP-201", recordsDir);
    assert.equal(updated.gate_plan.planner_version, "gate-plan-v1");
    assert.equal(updated.bootstrap_risk.startup_work_class, "local_bootstrap");
    assert.ok(updated.verification_commands.includes("node --test repair"));
    assert.equal(updated.self_review_cycles[0].lens, "contract");
    const tracked = [path.join(recordsDir, "IMP-201.json"), planPath, boardPath, governanceState.GOVERNANCE_EVENT_LOG_PATH];
    const before = tracked.map((file) => fs.readFileSync(file, "utf8"));
    assert.throws(() => dispatchCommand("update-plan", ["IMP-201", "--verification", "discarded"]),
      /update-plan does not accept --verification.*--verify/);
    assert.deepEqual(tracked.map((file) => fs.readFileSync(file, "utf8")), before,
      "rejection must precede plan, board and journal writes");
  });
});

test("setReviewCyclesCommand replaces the full self-review cycle set in one governed write", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-set-review-cycles-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: recordsDir,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    // COORD-273: anchor a journal baseline before the first governed plan mutation
    // so it runs over an INITIALIZED journal (a healthy repo). Without it the new
    // journal-loss-over-existing-state guard refuses to silently auto-baseline.
    __testing.ensureGovernanceJournalBaseline("plan-helpers-seed");
    __testing.ensurePlanStub("IMP-202", "X", "codexa02");
    __testing.advanceGovernanceProvenanceBaseline("plan-stub-fixture");
    assert.throws(() => governanceCommands.planTicket(undefined), /plan requires <ticket-id>/);
    assert.throws(() => governanceCommands.dropFeatureProofCommand(undefined, {}), /requires <ticket-id>/);
    assert.throws(() => governanceCommands.dropFeatureProofCommand("IMP-202", {}), /requires exactly one/);
    assert.throws(() => governanceCommands.dropFeatureProofCommand("IMP-202", { proofPath: "src/a.js", proofText: "two selectors" }), /requires exactly one/);
    governanceCommands.setReviewCyclesCommand("IMP-202", {
      replace: true,
      reviewCycle: [
        "lens=contract/state invariants; diff=manual one; risks=state drift, parser mismatch; findings=none; verification=node test1; verdict=pass",
        "lens=auth/security/failure modes; diff=manual two; risks=auth drift, fallback failure; findings=none; verification=node test2; verdict=pass",
        "lens=tests/operability/performance; diff=manual three; risks=coverage gap, runtime stall; findings=none; verification=node test3; verdict=pass",
      ],
    });
    let record = readPlanRecordFromSandbox("IMP-202", recordsDir);
    assert.equal(record.self_review_cycles.length, 3);
    assert.equal(record.self_review_cycles[0].lens, "contract/state invariants");
    const beforeInvalidReplacement = [
      fs.readFileSync(path.join(recordsDir, "IMP-202.json")),
      fs.readFileSync(boardPath),
      fs.readFileSync(planPath),
      fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH),
    ];
    assert.throws(() => governanceCommands.setReviewCyclesCommand("IMP-202", {
      reviewCycle: ["lens=ignored; diff=no confirmation; risks=lost set, stale state; findings=none; verification=none; verdict=fail"],
    }), /pass --replace to confirm/);
    assert.throws(() => governanceCommands.setReviewCyclesCommand("IMP-202", { replace: true, reviewCycle: [] }),
      /requires at least one --review-cycle/);
    assert.throws(() => governanceCommands.setReviewCyclesCommand(undefined, { replace: true, reviewCycle: ["cycle"] }),
      /requires <ticket-id>/);
    assert.throws(() => require("./cli.js").__testing.dispatchCommand("update-plan", []), /update-plan requires <ticket-id>/,
      "the public update-plan dispatcher refuses a missing id inside the shared writer before persistence");
    assert.deepEqual([
      fs.readFileSync(path.join(recordsDir, "IMP-202.json")),
      fs.readFileSync(boardPath),
      fs.readFileSync(planPath),
      fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH),
    ], beforeInvalidReplacement, "all refusals preserve the prior full collection and governed bytes");

    const replacementCycles = [
      "lens=contract/state invariants; diff=replaced one; risks=contract drift, stale state; findings=none; verification=node new1; verdict=pass",
      "lens=auth/security/failure modes; diff=replaced two; risks=access drift, invalid fallback; findings=none; verification=node new2; verdict=pass",
      "lens=tests/operability/performance; diff=replaced three; risks=coverage loss, slow path; findings=none; verification=node new3; verdict=pass",
    ];
    governanceCommands.setReviewCyclesCommand("IMP-202", {
      replace: true,
      reviewCycle: replacementCycles,
    });
    record = readPlanRecordFromSandbox("IMP-202", recordsDir);
    assert.deepEqual(record.self_review_cycles.map((cycle) => cycle.raw), replacementCycles,
      "explicit replacement stores exactly the supplied resulting collection");
    assert.equal(record.self_review_cycles.some((cycle) => cycle.diff.includes("manual")), false,
      "replacement removes every prior cycle rather than appending or partially merging");
  });
});

test("setRequirementClosureCommand --supersede REPLACES the prior closure block instead of appending (COORD-198)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-supersede-closure-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: recordsDir,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    // COORD-273: anchor a journal baseline before the first governed plan mutation
    // so it runs over an INITIALIZED journal (a healthy repo). Without it the new
    // journal-loss-over-existing-state guard refuses to silently auto-baseline.
    __testing.ensureGovernanceJournalBaseline("plan-helpers-seed");
    __testing.ensurePlanStub("IMP-203", "X", "codexa02");
    __testing.advanceGovernanceProvenanceBaseline("plan-stub-fixture");
    // First closure: partial.
    governanceCommands.setRequirementClosureCommand("IMP-203", {
      ticketAsk: "ship the feature behind the acceptance bar",
      implemented: "first pass that fell short",
      notImplemented: "ACCEPTANCE-cut NOT met on the first closure",
      deferredTo: "none",
      closeoutVerdict: "partial",
    });
    let record = readPlanRecordFromSandbox("IMP-203", recordsDir);
    const partialVerdictLines = record.requirement_closure.filter((l) => /^Closeout verdict:/.test(l));
    assert.equal(partialVerdictLines.length, 1);
    assert.equal(partialVerdictLines[0], "Closeout verdict: partial");

    // Default (no --supersede) re-closure APPENDS, leaving both blocks.
    governanceCommands.setRequirementClosureCommand("IMP-203", {
      ticketAsk: "finish the feature so the acceptance bar is met",
      implemented: "second pass that landed the full bar",
      notImplemented: "none",
      deferredTo: "none",
      closeoutVerdict: "complete",
    });
    record = readPlanRecordFromSandbox("IMP-203", recordsDir);
    const appendedVerdictLines = record.requirement_closure.filter((l) => /^Closeout verdict:/.test(l));
    assert.equal(appendedVerdictLines.length, 2, "default behavior is append-only: both blocks remain");

    // --supersede REPLACES: exactly one block remains, the latest.
    governanceCommands.setRequirementClosureCommand("IMP-203", {
      ticketAsk: "finish the feature so the acceptance bar is met",
      implemented: "third pass, clean re-closure",
      notImplemented: "none",
      deferredTo: "none",
      closeoutVerdict: "complete",
      supersede: true,
    });
    record = readPlanRecordFromSandbox("IMP-203", recordsDir);
    const supersededVerdictLines = record.requirement_closure.filter((l) => /^Closeout verdict:/.test(l));
    assert.equal(supersededVerdictLines.length, 1, "--supersede replaces: exactly one closure block remains");
    assert.equal(supersededVerdictLines[0], "Closeout verdict: complete");
    assert.ok(
      record.requirement_closure.some((l) => /third pass, clean re-closure/.test(l)),
      "the latest block is the one that survives"
    );
    assert.ok(
      !record.requirement_closure.some((l) => /ACCEPTANCE-cut NOT met/.test(l)),
      "the superseded carve-out is gone after --supersede"
    );
  });
});

test("dropFeatureProofCommand removes a canonical feature-proof entry without editing plan JSON by hand", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-drop-feature-proof-"));
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  const runtimeDir = path.join(tempDir, ".runtime");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const questionsPath = path.join(tempDir, "QUESTIONS.md");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }, null, 2), "utf8");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(sessionsPath, "[]\n", "utf8");
  fs.writeFileSync(questionsPath, "## Instructions\n", "utf8");

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    PLAN_PATH: planPath,
    PLAN_RECORDS_DIR: recordsDir,
    AGENT_SESSIONS_PATH: sessionsPath,
    QUESTIONS_PATH: questionsPath,
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  }, () => {
    // COORD-273: anchor a journal baseline before the first governed plan mutation
    // so it runs over an INITIALIZED journal (a healthy repo). Without it the new
    // journal-loss-over-existing-state guard refuses to silently auto-baseline.
    __testing.ensureGovernanceJournalBaseline("plan-helpers-seed");
    __testing.ensurePlanStub("IMP-203", "X", "codexa02");
    __testing.advanceGovernanceProvenanceBaseline("plan-stub-fixture");
    governanceCommands.addFeatureProofCommand("IMP-203", { proofPath: "coord/scripts/governance.js" });
    governanceCommands.addFeatureProofCommand("IMP-203", { proofText: "structured-helper" });
    let record = readPlanRecordFromSandbox("IMP-203", recordsDir);
    assert.equal(record.feature_proof.includes("path:scripts/governance.js"), true);
    assert.equal(record.feature_proof.includes("text:structured-helper"), true);

    governanceCommands.dropFeatureProofCommand("IMP-203", { proofText: "structured-helper" });
    record = readPlanRecordFromSandbox("IMP-203", recordsDir);
    assert.equal(record.feature_proof.includes("path:scripts/governance.js"), true);
    assert.equal(record.feature_proof.includes("text:structured-helper"), false);
  });
});

test("COORD-647: incremental public review writes render a current denominator without retotalling history", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c647-cycles-", { ticketId: "IMP-647" }, () => {
    const run = args => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c647-render-thread" } });
    for (const args of [["agentid", "--owner", "claudea11"], ["plan", "IMP-647", "--seed"]]) {
      const result = run(args); assert.equal(result.ok, true, result.error);
    }
    let previous = [];
    for (let n = 1; n <= 5; n += 1) {
      const result = run(["add-review-cycle", "IMP-647", "--lens", `evidence lens ${n}`, "--diff", "incremental fixture review", "--risk", "stale display", "--risk", "rewritten history", "--findings", "fixture reviewed", "--verification", "actual writer fixture", "--verdict", "pass"]);
      assert.equal(result.ok, true, result.error);
      const record = readPlanRecordFromSandbox("IMP-647");
      assert.deepEqual(record.self_review_cycles.slice(0, -1), previous, "appending must preserve all earlier evidence fields");
      previous = structuredClone(record.self_review_cycles);
      const markdown = fs.readFileSync(governanceState.PLAN_PATH, "utf8");
      const rendered = [...markdown.matchAll(/Self-review cycle (\d+)\/(\d+):/g)].map(m => [Number(m[1]), Number(m[2])]);
      assert.deepEqual(rendered, Array.from({ length: n }, (_, i) => [i + 1, n]));
    }
  });
});

// Mutation canary: bypassing the CLI writer's applySupersession call makes the
// final ledger assertions fail; bypassing the current projection breaks the
// persisted/rendered assertions below.
test("COORD-713: governed CLI corrects both evidence kinds, refuses atomically, and replays without writes", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c713-supersession-", { ticketId: "IMP-713" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c713-fixture-thread" } });
    const identity = run(["agentid", "--owner", "claudea11"]);
    assert.equal(identity.ok, true, identity.error);
    assert.equal(run(["plan", "IMP-713"]).ok, true, "a no-option plan command reads and reports existing status without writing");
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm test [result=pass] on stale head", "--verify", "node --test stale.test.js"]).ok, true);
    // Seed a legacy duplicate exactly as it may exist in older string-list records.
    const fixtureRecord = readPlanRecordFromSandbox("IMP-713");
    fixtureRecord.repo_gates.push(fixtureRecord.repo_gates[0]);
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json"), `${JSON.stringify(fixtureRecord, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-713", fixtureRecord);
    __testing.advanceGovernanceProvenanceBaseline("COORD-713 duplicate legacy fixture setup");

    const paths = [
      path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json"), governanceState.PLAN_PATH,
      governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.BOARD_PATH,
    ];
    const snapshot = () => {
      const files = [...paths];
      const visit = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) visit(child);
          else files.push(child);
        }
      };
      visit(governanceState.LOCKS_DIR);
      return files.sort().map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null]);
    };
    const initial = readPlanRecordFromSandbox("IMP-713");
    const ambiguousBefore = snapshot();
    const ambiguous = run(["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", "npm test [result=pass] on stale head", "--replacement", "npm test corrected", "--reason", "same text has two identities"]);
    assert.equal(ambiguous.ok, false);
    assert.deepEqual(snapshot(), ambiguousBefore, "ambiguous selector must not touch record, view, journal, board, or lock");
    const malformed = run(["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", "repo_gate:1:bad", "--replacement", "npm test corrected", "--reason", "malformed reference"]);
    assert.equal(malformed.ok, false);
    assert.deepEqual(snapshot(), ambiguousBefore, "malformed selector must also refuse atomically");

    const gateRef = evidenceRef("repo_gate", 1, initial.repo_gates[0]);
    const gateArgs = ["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", gateRef,
      "--replacement", "npm test corrected [result=pass] on current head", "--reason", "The old result used a stale head."];
    const gateCorrection = run(gateArgs);
    assert.equal(gateCorrection.ok, true, gateCorrection.error);
    const afterGate = readPlanRecordFromSandbox("IMP-713");
    assert.deepEqual(afterGate.repo_gates.slice(0, 2), initial.repo_gates);
    assert.equal(afterGate.evidence_supersessions[0].actor, "claudea11");
    const correctionEvent = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).findLast((event) => event.command === "supersede-plan-evidence");
    assert.equal(correctionEvent.identity.owner, "claudea11", "the governed event attributes the correction to the registered actor");
    const journalAfterGate = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    const afterGateSnapshot = snapshot();
    assert.equal(run(gateArgs).ok, true);
    assert.deepEqual(snapshot(), afterGateSnapshot);
    assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), journalAfterGate, "identical replay emits no journal row");
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm run unrelated gate"]).ok, true);
    const afterUnrelatedAppend = snapshot();
    assert.equal(run(gateArgs).ok, true);
    assert.deepEqual(snapshot(), afterUnrelatedAppend, "replay after an unrelated append is byte-stable");

    const verifyRef = evidenceRef("verification_command", 1, initial.verification_commands[0]);
    const verifyArgs = ["supersede-plan-evidence", "IMP-713", "--kind", "verification_command", "--entry", verifyRef,
      "--replacement", "node --test current.test.js", "--reason", "The command referenced a removed test file."];
    assert.equal(run(verifyArgs).ok, true);
    const verifySnapshot = snapshot();
    const verifyAliasArgs = ["supersede-plan-evidence", "IMP-713", "--kind", "verification_command", "--entry", initial.verification_commands[0],
      "--replacement", "node --test current.test.js", "--reason", "The command referenced a removed test file."];
    assert.equal(run(verifyAliasArgs).ok, true, "exact-value selector for the same correction shares its stable identity key");
    assert.deepEqual(snapshot(), verifySnapshot, "stable-ref and exact-value replay are byte-identical and append no journal row");
    const finalRecord = readPlanRecordFromSandbox("IMP-713");
    assert.deepEqual(finalRecord.repo_gates.slice(0, 2), initial.repo_gates);
    assert.deepEqual(finalRecord.verification_commands, [initial.verification_commands[0], "node --test current.test.js"]);
    assert.equal(finalRecord.evidence_supersessions.length, 2);
    assert.deepEqual(snapshot()[3], afterUnrelatedAppend[3], "evidence corrections leave board bytes unchanged");
  });
});

test("COORD-713: correction command refuses missing arguments and absent canonical evidence without writes", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c713-supersession-refusal-", { ticketId: "IMP-713" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c713-refusal-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm test old head"]).ok, true);

    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json");
    const paths = [recordPath, governanceState.PLAN_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.BOARD_PATH];
    const snapshot = () => paths.map((file) => [file, fs.readFileSync(file, "utf8")]);
    const before = snapshot();
    const missingPlan = run(["supersede-plan-evidence", "IMP-999", "--kind", "critical_invariant", "--entry", "critical_invariant:1:missing", "--disposition", "retracted", "--reason", "No source plan exists."]);
    assert.equal(missingPlan.ok, false);
    assert.match(missingPlan.error, /requires an existing plan record for IMP-999/);
    assert.deepEqual(snapshot(), before, "missing-plan retraction must not mutate governed state");
    for (const args of [
      ["supersede-plan-evidence", "IMP-713"],
      ["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", "repo_gate:1:bad", "--replacement", "npm test new", "--reason", "invalid selector"],
      ["supersede-plan-evidence", "IMP-713", "--kind", "not-an-evidence-kind", "--entry", "repo_gate:1:0", "--replacement", "npm test new", "--reason", "invalid kind"],
      ["supersede-plan-evidence", "IMP-999", "--kind", "repo_gate", "--entry", "repo_gate:1:0", "--replacement", "npm test new", "--reason", "missing plan"],
    ]) {
      const result = run(args);
      assert.equal(result.ok, false, `expected refusal for ${args.join(" ")}`);
      assert.deepEqual(snapshot(), before, "invalid corrections preserve the persisted record, compatibility view, journal, and board");
    }
    assert.match(run(["supersede-plan-evidence", "IMP-713"]).error, /requires --kind/);
    assert.match(run(["supersede-plan-evidence", "IMP-999", "--kind", "repo_gate", "--entry", "repo_gate:1:0", "--replacement", "npm test new", "--reason", "missing plan"]).error, /existing plan record/);
  });
});

test("COORD-807 prototype: governed CLI retracts an invariant append-only and refuses contradictory writes", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c807-invariant-retraction-", { ticketId: "IMP-807" }, () => {
    const run = args => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c807-fixture-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-807", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-807", "--invariant", "timing probe 1", "--invariant", "Canonical journal state remains verifiable."]).ok, true);
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-807.json");
    const paths = [recordPath, governanceState.PLAN_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.BOARD_PATH];
    const snapshot = () => {
      const files = [...paths];
      const visit = dir => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) visit(child);
          else files.push(child);
        }
      };
      visit(governanceState.LOCKS_DIR);
      return [...new Set(files)].sort().map(file => [file, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null]);
    };
    const before = snapshot();
    for (const args of [
      ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", "critical_invariant:1:bad", "--disposition", "retracted", "--reason", "invalid selector"],
      ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", "timing probe 1", "--disposition", "superseded", "--reason", "invalid disposition"],
      ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", "timing probe 1", "--replacement", "fake invariant", "--disposition", "retracted", "--reason", "contradictory form"],
    ]) {
      assert.equal(run(args).ok, false);
      assert.deepEqual(snapshot(), before, "invalid correction forms must not write plan, view, journal, or board");
    }
    const initial = readPlanRecordFromSandbox("IMP-807");
    const source = evidenceRef("critical_invariant", 1, "timing probe 1");
    const args = ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", source,
      "--disposition", "retracted", "--reason", "This probe label is not a correctness invariant."];
    const retract = run(args);
    assert.equal(retract.ok, true, retract.error);
    const committed = snapshot();
    const after = readPlanRecordFromSandbox("IMP-807");
    assert.deepEqual(after.critical_invariants, initial.critical_invariants, "retraction preserves the source array as history");
    assert.deepEqual(resolvePlanEvidence(after).critical_invariants, ["Canonical journal state remains verifiable."]);
    assert.equal(after.evidence_dispositions[0].actor, "claudea11");
    assert.equal(run(args).ok, true, "same disposition/reason retry is idempotent");
    assert.deepEqual(snapshot(), committed, "idempotent replay is byte-stable");
    for (const conflictArgs of [
      [...args.slice(0, -1), "A conflicting reason."],
      ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", source,
        "--replacement", "fabricated substitute invariant", "--reason", "contradict disposed evidence"],
    ]) {
      assert.equal(run(conflictArgs).ok, false);
      assert.deepEqual(snapshot(), committed, "conflicting correction must preserve every governed byte");
    }
    const valid = "Canonical journal state remains verifiable.";
    assert.equal(run(["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", valid,
      "--disposition", "retracted", "--reason", "Review requires an explicit fresh assertion."]).ok, true);
    const withdrawn = readPlanRecordFromSandbox("IMP-807");
    assert.deepEqual(resolvePlanEvidence(withdrawn).critical_invariants, []);
    const restore = run(["update-plan", "IMP-807", "--invariant", valid]);
    assert.equal(restore.ok, true, restore.error);
    const restored = readPlanRecordFromSandbox("IMP-807");
    assert.deepEqual(restored.critical_invariants, [...withdrawn.critical_invariants, valid]);
    assert.deepEqual(restored.evidence_dispositions, withdrawn.evidence_dispositions);
    assert.deepEqual(resolvePlanEvidence(restored).critical_invariants, [valid]);
  });
});

// COORD-822 (2)+(6): the retraction CLI refuses an ambiguous text selector
// without touching one governed byte, then resolves the same text against the
// disposition ledger once only one active ordinal remains.
test("COORD-822: governed retraction refuses ambiguous text byte-for-byte and resolves text against dispositions", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c822-selector-", { ticketId: "IMP-822" }, () => {
    const run = args => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c822-fixture-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-822", "--seed"]).ok, true);
    const duplicate = "Journal state stays verifiable.";
    assert.equal(run(["update-plan", "IMP-822", "--invariant", "Board writes stay single-writer.", "--invariant", duplicate]).ok, true);
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-822.json");
    const fixtureRecord = readPlanRecordFromSandbox("IMP-822");
    fixtureRecord.critical_invariants.push(duplicate);
    fs.writeFileSync(recordPath, `${JSON.stringify(fixtureRecord, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-822", fixtureRecord);
    __testing.advanceGovernanceProvenanceBaseline("COORD-822 duplicate invariant fixture setup");
    const ordinals = fixtureRecord.critical_invariants.flatMap((value, offset) => value === duplicate ? [offset + 1] : []);
    assert.equal(ordinals.length, 2);

    const paths = [recordPath, governanceState.PLAN_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.BOARD_PATH];
    const snapshot = () => {
      const files = [...paths];
      const visit = dir => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) visit(child);
          else files.push(child);
        }
      };
      visit(governanceState.LOCKS_DIR);
      return [...new Set(files)].sort().map(file => [file, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null]);
    };
    const textArgs = ["supersede-plan-evidence", "IMP-822", "--kind", "critical_invariant", "--entry", duplicate,
      "--disposition", "retracted", "--reason", "Restated with a narrower scope."];
    const before = snapshot();
    const ambiguous = run(textArgs);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /ambiguous; use a stable entry reference/);
    assert.deepEqual(snapshot(), before, "an ambiguous retraction selector must not touch record, view, journal, board, or lock");

    const firstRef = evidenceRef("critical_invariant", ordinals[0], duplicate);
    const secondRef = evidenceRef("critical_invariant", ordinals[1], duplicate);
    assert.equal(run(["supersede-plan-evidence", "IMP-822", "--kind", "critical_invariant", "--entry", firstRef,
      "--disposition", "retracted", "--reason", "Duplicate of a later ordinal."]).ok, true);
    const textRetraction = run(textArgs);
    assert.equal(textRetraction.ok, true, textRetraction.error);
    const after = readPlanRecordFromSandbox("IMP-822");
    assert.deepEqual(after.evidence_dispositions.map(item => item.source_ref), [firstRef, secondRef],
      "exact text resolves the remaining active ordinal instead of the retracted one");
    assert.deepEqual(after.critical_invariants, fixtureRecord.critical_invariants, "the historical array keeps every byte-value");
    assert.deepEqual(resolvePlanEvidence(after).critical_invariants, ["Board writes stay single-writer."]);
    const activeRef = evidenceRef("critical_invariant", 1, "Board writes stay single-writer.");
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), new RegExp(`  - ${activeRef} = `),
      "PLAN.md lists the active invariant's stable ref for the operator");
  });
});

// COORD-822 (human-admin ruling): replaying an identical plan-evidence
// correction is a no-write operation with NO journal append. Each correction
// form is replayed by stable ref and by exact text; every replay must leave the
// record, PLAN.md, board, journal and locks byte-identical and claim no update.
test("COORD-822: identical supersession and retraction replays write nothing and append no journal row", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c822-replay-", { ticketId: "IMP-822" }, () => {
    const run = args => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c822-replay-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-822", "--seed"]).ok, true);
    const gate = "npm test [result=pass] on stale head";
    const invariant = "timing probe 1";
    assert.equal(run(["update-plan", "IMP-822", "--repo-gate", gate, "--invariant", invariant,
      "--invariant", "Canonical journal state remains verifiable."]).ok, true);
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-822.json");
    const journalPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const paths = [recordPath, governanceState.PLAN_PATH, journalPath, governanceState.BOARD_PATH];
    const snapshot = () => {
      const files = [...paths];
      const visit = dir => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) visit(child);
          else files.push(child);
        }
      };
      visit(governanceState.LOCKS_DIR);
      return [...new Set(files)].sort().map(file => [file, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null]);
    };
    const journalLines = () => fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).length;
    const assertReplayIsNoop = (args, label) => {
      const before = snapshot();
      const linesBefore = journalLines();
      const replay = run(args);
      assert.equal(replay.ok, true, `${label}: ${replay.error}`);
      assert.deepEqual(snapshot(), before, `${label}: record, PLAN.md, board, journal and locks stay byte-identical`);
      assert.equal(journalLines(), linesBefore, `${label}: no journal row is appended`);
      assert.equal(replay.value, undefined, `${label}: the replay returns no write result`);
      assert.equal(replay.stdout, "", `${label}: the replay does not report an update`);
    };

    const gateRef = evidenceRef("repo_gate", 1, gate);
    const supersede = (entry) => ["supersede-plan-evidence", "IMP-822", "--kind", "repo_gate", "--entry", entry,
      "--replacement", "npm test corrected [result=pass] on current head", "--reason", "The old result used a stale head."];
    let lines = journalLines();
    const superseded = run(supersede(gateRef));
    assert.equal(superseded.ok, true, superseded.error);
    assert.match(superseded.stdout, /^Superseded repo_gate evidence for IMP-822/, "the first correction reports its write");
    assert.equal(journalLines(), lines + 1, "the first correction appends exactly one journal row");
    assert.equal(readPlanRecordFromSandbox("IMP-822").evidence_supersessions.length, 1);
    assertReplayIsNoop(supersede(gateRef), "supersession replay by stable ref");
    assertReplayIsNoop(supersede(gate), "supersession replay by exact text");

    const invariantRef = evidenceRef("critical_invariant", 1, invariant);
    const retract = (entry) => ["supersede-plan-evidence", "IMP-822", "--kind", "critical_invariant", "--entry", entry,
      "--disposition", "retracted", "--reason", "This probe label is not a correctness invariant."];
    lines = journalLines();
    const retracted = run(retract(invariantRef));
    assert.equal(retracted.ok, true, retracted.error);
    assert.match(retracted.stdout, /"status": "updated"/, "the first retraction reports its write");
    assert.equal(journalLines(), lines + 1, "the first retraction appends exactly one journal row");
    assert.equal(readPlanRecordFromSandbox("IMP-822").evidence_dispositions.length, 1);
    assertReplayIsNoop(retract(invariantRef), "retraction replay by stable ref");
    assertReplayIsNoop(retract(invariant), "retraction replay by exact text");

    const final = readPlanRecordFromSandbox("IMP-822");
    assert.equal(final.evidence_supersessions.length, 1, "replays add no supersession relation");
    assert.equal(final.evidence_dispositions.length, 1, "replays add no disposition relation");
    assert.deepEqual(resolvePlanEvidence(final).critical_invariants, ["Canonical journal state remains verifiable."]);
  });
});

// COORD-822 (human-admin ruling, review finding): the journal's idempotency
// replay is keyed to the ticket's committed after_status, so after a real
// governed transition an identical correction used to re-run as a "new cycle"
// and append a succeeded event with no file change. Replay identity is decided
// from the plan record itself, so the status change cannot reopen the write.
test("COORD-822: identical corrections replayed after a governed status transition write nothing", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c822-status-replay-", { ticketId: "IMP-822", status: "proposed" }, ({ readBoard }) => {
    const run = args => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c822-status-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-822", "--seed"]).ok, true);
    const gate = "npm test [result=pass] on stale head";
    const invariant = "timing probe 1";
    assert.equal(run(["update-plan", "IMP-822", "--repo-gate", gate, "--invariant", invariant,
      "--invariant", "Canonical journal state remains verifiable."]).ok, true);
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-822.json");
    const journalPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const paths = [recordPath, governanceState.PLAN_PATH, journalPath, governanceState.BOARD_PATH];
    const snapshot = () => {
      const files = [...paths];
      const visit = dir => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          if (fs.statSync(child).isDirectory()) visit(child);
          else files.push(child);
        }
      };
      visit(governanceState.LOCKS_DIR);
      return [...new Set(files)].sort().map(file => [file, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null]);
    };
    const journalLines = () => fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean).length;
    const supersede = ["supersede-plan-evidence", "IMP-822", "--kind", "repo_gate", "--entry", evidenceRef("repo_gate", 1, gate),
      "--replacement", "npm test corrected [result=pass] on current head", "--reason", "The old result used a stale head."];
    const retract = ["supersede-plan-evidence", "IMP-822", "--kind", "critical_invariant", "--entry", evidenceRef("critical_invariant", 1, invariant),
      "--disposition", "retracted", "--reason", "This probe label is not a correctness invariant."];
    for (const args of [supersede, retract]) {
      const lines = journalLines();
      const first = run(args);
      assert.equal(first.ok, true, first.error);
      assert.equal(journalLines(), lines + 1, "each original correction appends exactly one journal row");
    }
    const correctionEvent = fs.readFileSync(journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .findLast(event => event.command === "supersede-plan-evidence");
    assert.equal(correctionEvent.after_status, "proposed", "the originals committed while the ticket was proposed");

    const row = readBoard().sections[0].rows.find((entry) => entry.ID === "IMP-822");
    const override = "human admin approves transition before replay check";
    const approved = withSignedTicketApproval("approve", "IMP-822", override, row, () =>
      run(["approve", "IMP-822", "--owner", "claudea11", "--human-admin-override", override]));
    assert.equal(approved.ok, true, approved.error);
    assert.equal(readBoard().sections[0].rows.find(row => row.ID === "IMP-822").Status, "todo", "a governed transition moved the ticket");

    for (const [label, args] of [["supersession", supersede], ["retraction", retract]]) {
      const before = snapshot();
      const lines = journalLines();
      const replay = run(args);
      assert.equal(replay.ok, true, `${label}: ${replay.error}`);
      assert.deepEqual(snapshot(), before, `${label}: record, PLAN.md, board, journal and locks stay byte-identical after the transition`);
      assert.equal(journalLines(), lines, `${label}: no journal row is appended after the transition`);
      assert.equal(replay.value, undefined, `${label}: the replay returns no write result`);
      assert.equal(replay.stdout, "", `${label}: the replay does not claim an update`);
    }
    const committed = snapshot();
    for (const conflict of [
      [...supersede.slice(0, -1), "A conflicting reason."],
      [...supersede.slice(0, 7), "npm test a different successor", ...supersede.slice(8)],
      [...retract.slice(0, -1), "A conflicting reason."],
    ]) {
      const refused = run(conflict);
      assert.equal(refused.ok, false, `conflicting correction must be refused: ${conflict.join(" ")}`);
      assert.match(refused.error, /conflicting (successor|disposition)/);
      assert.deepEqual(snapshot(), committed, "a conflicting correction after the transition writes nothing");
    }
    const final = readPlanRecordFromSandbox("IMP-822");
    assert.equal(final.evidence_supersessions.length, 1);
    assert.equal(final.evidence_dispositions.length, 1);
  });
});

test("COORD-713: correction command maps optimistic writer conflicts to a refusal", () => {
  const sourceValue = "npm test old head";
  let writerCalls = 0;
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => ({ row: { ID: "IMP-713", Owner: "unassigned" } }),
    readPlanState: () => ({ repo_gates: [sourceValue], verification_commands: [] }),
    updateCanonicalPlanState: () => { writerCalls += 1; throw new Error("Optimistic concurrency conflict: plan changed after selector resolution."); },
    withGovernanceMutation: (_mutation, action) => action(),
    inferTicketStatus: () => "todo",
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-agent" } }),
  });
  const entry = evidenceRef("repo_gate", 1, sourceValue);
  assert.throws(() => command.supersedePlanEvidenceCommand("IMP-713", {
    kind: "repo_gate", entry, replacement: "npm test current head", reason: "the plan changed during correction",
  }), /Optimistic concurrency conflict/);
  assert.equal(writerCalls, 1, "the refusal is raised from the canonical writer's conflict result");
});

test("COORD-713: correction command refuses absent ticket authority before invoking the writer", () => {
  let writerCalls = 0;
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => null,
    readPlanState: () => ({ repo_gates: ["npm test old head"], verification_commands: [] }),
    updateCanonicalPlanState: () => { writerCalls += 1; },
    withGovernanceMutation: (_mutation, action) => action(),
    inferTicketStatus: () => "todo",
  });
  assert.throws(() => command.supersedePlanEvidenceCommand("IMP-713", {
    kind: "repo_gate", entry: evidenceRef("repo_gate", 1, "npm test old head"),
    replacement: "npm test current head", reason: "the ticket authority disappeared",
  }), /could not resolve a registered acting agent/);
  assert.equal(writerCalls, 0, "unregistered or absent board authority cannot reach the plan writer");
  assert.throws(() => command.supersedePlanEvidenceCommand(undefined, {}), /requires <ticket-id>/);
});

test("COORD-713: correction command refuses a writer result that drops the requested relation", () => {
  const sourceValue = "npm test old head";
  let mutation;
  const command = createPlanCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    getTicketRef: () => ({ row: { ID: "IMP-713", Owner: "unassigned" } }),
    readPlanState: () => ({ repo_gates: [sourceValue], verification_commands: [] }),
    updateCanonicalPlanState: () => ({ record: { repo_gates: [sourceValue] } }),
    withGovernanceMutation: (nextMutation, action) => { mutation = nextMutation; return action(); },
    inferTicketStatus: () => "todo",
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-agent" } }),
  });
  assert.throws(() => command.supersedePlanEvidenceCommand("IMP-713", {
    kind: "repo_gate", entry: evidenceRef("repo_gate", 1, sourceValue),
    replacement: "npm test current head", reason: "the writer violated its successful-result contract",
  }), /did not preserve the requested evidence supersession/);
  assert.equal(mutation.details, undefined, "a broken writer cannot produce success metadata");
});

test("COORD-807: retraction refuses missing actor identity and a writer result without the disposition", () => {
  const value = "timing probe is not a safety invariant";
  const source = evidenceRef("critical_invariant", 1, value);
  const base = {
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ sections: [] }),
    readPlanState: () => ({ critical_invariants: [value] }),
    withGovernanceMutation: (_mutation, action) => action(),
    inferTicketStatus: () => "todo",
  };
  const options = { kind: "critical_invariant", entry: source, disposition: "retracted", reason: "The probe is not an invariant." };
  const missingIdentity = createPlanCommand({
    ...base,
    getTicketRef: () => null,
    updateCanonicalPlanState: () => { throw new Error("writer must not be called without identity"); },
  });
  assert.throws(() => missingIdentity.supersedePlanEvidenceCommand("IMP-807", options), /could not resolve a registered acting agent/);

  let writerCalls = 0;
  const missingRelation = createPlanCommand({
    ...base,
    getTicketRef: (_board, ticketId) => ({ row: { ID: ticketId, Owner: "unassigned" } }),
    ensureCurrentAgentIdentity: () => ({ agent: { handle: "fixture-agent" } }),
    updateCanonicalPlanState: () => {
      writerCalls += 1;
      return { record: { critical_invariants: [value] } };
    },
  });
  assert.throws(() => missingRelation.supersedePlanEvidenceCommand("IMP-807", options), /did not preserve the requested invariant disposition/);
  assert.equal(writerCalls, 1);
});

// COORD-822 (human-admin ruling) replaced the COORD-713 replay-metadata event:
// replaying a relation that is not the ledger's last is now a no-write, no-journal
// no-op, and a fresh correction still records its own relation id.
test("COORD-713/822: replaying a non-last relation writes nothing; a fresh correction records its own relation", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c713-relation-order-", { ticketId: "IMP-713" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c713-order-thread" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "gate one old", "--repo-gate", "gate two old"]).ok, true);
    const record = readPlanRecordFromSandbox("IMP-713");
    const corrections = [
      { kind: "repo_gate", sourceIndex: 1, replacementIndex: 3, replacement: "gate one current", reason: "gate one was stale" },
      { kind: "repo_gate", sourceIndex: 2, replacementIndex: 4, replacement: "gate two current", reason: "gate two was stale" },
    ].map(({ kind, sourceIndex, replacement, reason }) => {
      const sourceRef = evidenceRef(kind, sourceIndex, record.repo_gates[sourceIndex - 1]);
      const replacementRef = evidenceRef(kind, sourceIndex + 2, replacement);
      return {
        id: stableSupersessionId(sourceRef, replacementRef), kind,
        source_ref: sourceRef, successor_ref: replacementRef, reason, actor: "claudea11",
        timestamp: `2026-10-05T00:00:0${sourceIndex}.000Z`,
      };
    });
    record.repo_gates.push("gate one current", "gate two current");
    record.evidence_supersessions = corrections;
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json"), `${JSON.stringify(record, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-713", record);
    __testing.advanceGovernanceProvenanceBaseline("COORD-713 preexisting relation order fixture");

    const selected = corrections[0];
    const journalPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json");
    const before = [journalPath, recordPath, governanceState.PLAN_PATH].map((file) => fs.readFileSync(file, "utf8"));
    const result = run(["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", selected.source_ref,
      "--replacement", "gate one current", "--reason", selected.reason]);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, "", "a replay of a non-last relation claims no update");
    assert.deepEqual([journalPath, recordPath, governanceState.PLAN_PATH].map((file) => fs.readFileSync(file, "utf8")), before,
      "a replay of a non-last relation leaves journal, record and PLAN.md byte-identical");

    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "gate three old"]).ok, true);
    const third = evidenceRef("repo_gate", 5, "gate three old");
    const fresh = run(["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", third,
      "--replacement", "gate three current", "--reason", "gate three was stale"]);
    assert.equal(fresh.ok, true, fresh.error);
    const event = fs.readFileSync(journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).findLast((item) => item.command === "supersede-plan-evidence");
    assert.equal(event.details.supersession_id, stableSupersessionId(third, evidenceRef("repo_gate", 6, "gate three current")));
    assert.equal(event.details.replacement_recorded, true);
  });
});

test("COORD-713: concurrent governed corrections to separate entries retain both successors", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c713-concurrent-", { ticketId: "IMP-713" }, ({ tempDir }) => {
    const session = "c713-concurrent-fixture";
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: session } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "gate A [result=pass] old head", "--repo-gate", "gate B [result=pass] old head"]).ok, true);
    const record = readPlanRecordFromSandbox("IMP-713");
    const refs = record.repo_gates.map((value, index) => evidenceRef("repo_gate", index + 1, value));
    const pathKeys = ["BOARD_PATH", "PLAN_PATH", "PLAN_RECORDS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "GOVERNANCE_SNAPSHOT_PATH",
      "GOVERNANCE_SNAPSHOTS_DIR", "GOVERNANCE_EVENT_LOCK_DIR", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "AGENT_SESSIONS_PATH",
      "AGENTS_PATH", "QUESTIONS_PATH", "PROMPTS_DIR", "RENDERED_DIR", "RUNTIME_DIR", "COORD_STATE_LOCK_DIR",
      "AGENT_STATE_LOCK_DIR", "MEMORY_DIR", "DECISIONS_DIR"];
    const paths = Object.fromEntries(pathKeys.map((key) => [key, governanceState[key]]));
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (refs.length + 1));
    const outputPaths = [path.join(tempDir, "worker-a.json"), path.join(tempDir, "worker-b.json")];
    const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      try {
        const fs = require("node:fs");
        const utils = require(workerData.utilsPath);
        const result = utils.withScopedGovernanceTestContext(workerData.paths, () => utils.executeCommand(workerData.args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: workerData.session } }));
        require("node:fs").writeFileSync(workerData.outputPath, JSON.stringify(result));
      } catch (error) {
        try { require("node:fs").writeFileSync(workerData.outputPath, JSON.stringify({ ok: false, error: error.message })); } catch {}
      } finally {
        const state = new Int32Array(workerData.shared);
        Atomics.store(state, workerData.workerIndex + 1, 1);
        Atomics.notify(state, 0);
      }
    `;
    const workerFailures = [];
    const workers = refs.map((entry, index) => {
      const worker = new Worker(source, { eval: true, workerData: {
        utilsPath: path.join(__dirname, "..", "..", "scripts", "governance-test-utils.js"), paths, shared, outputPath: outputPaths[index], session,
        workerIndex: index,
        args: ["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", entry,
          "--replacement", `gate ${index ? "B" : "A"} [result=pass] current head`, "--reason", `gate ${index ? "B" : "A"} was run on the old head`],
      } });
      worker.on("error", (error) => {
        workerFailures.push(`worker ${index} error: ${error.message}`);
        const state = new Int32Array(shared);
        Atomics.store(state, index + 1, 1);
        Atomics.notify(state, 0);
      });
      worker.on("exit", (code) => {
        if (code !== 0) workerFailures.push(`worker ${index} exited with code ${code}`);
        const state = new Int32Array(shared);
        Atomics.store(state, index + 1, 1);
        Atomics.notify(state, 0);
      });
      return worker;
    });
    const state = new Int32Array(shared);
    const deadline = Date.now() + 30_000;
    try {
      while (workers.some((_, index) => Atomics.load(state, index + 1) === 0)) {
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, `concurrent correction workers timed out after 30s${workerFailures.length ? `: ${workerFailures.join("; ")}` : ""}`);
        Atomics.wait(state, 0, 0, Math.min(remaining, 1_000));
      }
      assert.deepEqual(workerFailures, [], workerFailures.join("; "));
    } finally {
      for (const worker of workers) void worker.terminate();
    }
    for (const outputPath of outputPaths) {
      const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      assert.equal(result.ok, true, result.error);
    }
    const finalRecord = readPlanRecordFromSandbox("IMP-713");
    assert.deepEqual(finalRecord.repo_gates.slice(0, 2), record.repo_gates);
    assert.equal(finalRecord.evidence_supersessions.length, 2);
    assert.deepEqual(resolvePlanEvidence(finalRecord).repo_gates,
      ["gate A [result=pass] current head", "gate B [result=pass] current head"]);
  });
});

test("COORD-713: later evidence appends preserve correction-bound ordinals and can add a fresh historical duplicate", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c713-ordinal-append-", { ticketId: "IMP-713" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: "c713-ordinal-fixture" } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-713", "--seed"]).ok, true);
    const originalGate = "npm run gate old.js";
    const originalVerification = "node --test old.test.js";
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", originalGate, "--verify", originalVerification]).ok, true);

    const record = readPlanRecordFromSandbox("IMP-713");
    const scaffoldGate = "TODO: add executed repo gate(s) before move-review, or not-required for coord-only tickets";
    record.repo_gates = [scaffoldGate, ...record.repo_gates];
    record.verification_commands = ["TODO", ...record.verification_commands];
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json"), `${JSON.stringify(record, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-713", record);
    __testing.advanceGovernanceProvenanceBaseline("COORD-713 legacy scaffold cleanup fixture setup");
    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm run gate before-correction.js", "--verify", "node --test before-correction.test.js"]).ok, true);
    const legacyCleaned = readPlanRecordFromSandbox("IMP-713");
    assert.deepEqual(legacyCleaned.repo_gates, [originalGate, "npm run gate before-correction.js"]);
    assert.deepEqual(legacyCleaned.verification_commands, [originalVerification, "node --test before-correction.test.js"]);

    // Reintroduce the legacy scaffold shape with the source at ordinal two so
    // the following governed corrections exercise identity stability exactly.
    record.repo_gates = [scaffoldGate, originalGate];
    record.verification_commands = ["TODO", originalVerification];
    delete record.scaffold_placeholders;
    fs.writeFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-713.json"), `${JSON.stringify(record, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord("IMP-713", record);
    __testing.advanceGovernanceProvenanceBaseline("COORD-713 ordinal-stability fixture setup");

    const gateSource = evidenceRef("repo_gate", 2, originalGate);
    const gateSuccessor = "npm run gate new.js";
    const verifySource = evidenceRef("verification_command", 2, originalVerification);
    const verifySuccessor = "node --test new.test.js";
    assert.equal(run(["supersede-plan-evidence", "IMP-713", "--kind", "repo_gate", "--entry", gateSource,
      "--replacement", gateSuccessor, "--reason", "The source gate used a stale command."]).ok, true);
    assert.equal(run(["supersede-plan-evidence", "IMP-713", "--kind", "verification_command", "--entry", verifySource,
      "--replacement", verifySuccessor, "--reason", "The source verification targeted a removed test."]).ok, true);
    const corrected = readPlanRecordFromSandbox("IMP-713");
    const stableLedger = structuredClone(corrected.evidence_supersessions);

    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", "npm run gate later.js", "--verify", "node --test later.test.js"]).ok, true);
    let appended = readPlanRecordFromSandbox("IMP-713");
    assert.deepEqual(appended.repo_gates, [scaffoldGate, originalGate, gateSuccessor, "npm run gate later.js"]);
    assert.deepEqual(appended.verification_commands, ["TODO", originalVerification, verifySuccessor, "node --test later.test.js"]);
    assert.deepEqual(appended.evidence_supersessions, stableLedger, "later appends cannot shift refs already bound into the ledger");

    assert.equal(run(["update-plan", "IMP-713", "--repo-gate", originalGate, "--verify", originalVerification]).ok, true);
    appended = readPlanRecordFromSandbox("IMP-713");
    assert.equal(appended.repo_gates.at(-1), originalGate);
    assert.equal(appended.verification_commands.at(-1), originalVerification);
    assert.deepEqual(appended.evidence_supersessions, stableLedger);
    assert.ok(resolvePlanEvidence(appended).repo_gates.includes(originalGate), "re-appending a historical value creates a new current identity");
    assert.ok(resolvePlanEvidence(appended).verification_commands.includes(originalVerification), "the same rule applies to commands");
    assert.equal(evidenceRef("repo_gate", 2, appended.repo_gates[1]), stableLedger[0].source_ref);
    assert.equal(evidenceRef("verification_command", 2, appended.verification_commands[1]), stableLedger[1].source_ref);
  });
});

test("COORD-807: concurrent invariant retractions retain both dispositions and original history", () => {
  const { executeCommand, withRegisterPromptHarness } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
  withRegisterPromptHarness("c807-concurrent-", { ticketId: "IMP-807" }, ({ tempDir }) => {
    const session = "c807-concurrent-fixture";
    const run = (args) => executeCommand(args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: session } });
    assert.equal(run(["agentid", "--owner", "claudea11"]).ok, true);
    assert.equal(run(["plan", "IMP-807", "--seed"]).ok, true);
    assert.equal(run(["update-plan", "IMP-807", "--invariant", "Invariant A awaiting review.", "--invariant", "Invariant B awaiting review."]).ok, true);
    const record = readPlanRecordFromSandbox("IMP-807");
    const refs = record.critical_invariants.map((value, index) => evidenceRef("critical_invariant", index + 1, value));
    const pathKeys = ["BOARD_PATH", "PLAN_PATH", "PLAN_RECORDS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "GOVERNANCE_SNAPSHOT_PATH",
      "GOVERNANCE_SNAPSHOTS_DIR", "GOVERNANCE_EVENT_LOCK_DIR", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "AGENT_SESSIONS_PATH",
      "AGENTS_PATH", "QUESTIONS_PATH", "PROMPTS_DIR", "RENDERED_DIR", "RUNTIME_DIR", "COORD_STATE_LOCK_DIR",
      "AGENT_STATE_LOCK_DIR", "MEMORY_DIR", "DECISIONS_DIR"];
    const paths = Object.fromEntries(pathKeys.map((key) => [key, governanceState[key]]));
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (refs.length + 1));
    const outputPaths = [path.join(tempDir, "worker-a.json"), path.join(tempDir, "worker-b.json")];
    const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      try {
        const fs = require("node:fs");
        const utils = require(workerData.utilsPath);
        const result = utils.withScopedGovernanceTestContext(workerData.paths, () => utils.executeCommand(workerData.args, { env: { ...process.env, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: workerData.session } }));
        require("node:fs").writeFileSync(workerData.outputPath, JSON.stringify(result));
      } catch (error) {
        try { require("node:fs").writeFileSync(workerData.outputPath, JSON.stringify({ ok: false, error: error.message })); } catch {}
      } finally {
        const state = new Int32Array(workerData.shared);
        Atomics.store(state, workerData.workerIndex + 1, 1);
        Atomics.notify(state, 0);
      }
    `;
    const workerFailures = [];
    const workers = refs.map((entry, index) => {
      const worker = new Worker(source, { eval: true, workerData: {
        utilsPath: path.join(__dirname, "..", "..", "scripts", "governance-test-utils.js"), paths, shared, outputPath: outputPaths[index], session,
        workerIndex: index,
        args: ["supersede-plan-evidence", "IMP-807", "--kind", "critical_invariant", "--entry", entry,
          "--disposition", "retracted", "--reason", `Invariant ${index ? "B" : "A"} is withdrawn after review`],
      } });
      worker.on("error", (error) => {
        workerFailures.push(`worker ${index} error: ${error.message}`);
        const state = new Int32Array(shared);
        Atomics.store(state, index + 1, 1);
        Atomics.notify(state, 0);
      });
      worker.on("exit", (code) => {
        if (code !== 0) workerFailures.push(`worker ${index} exited with code ${code}`);
        const state = new Int32Array(shared);
        Atomics.store(state, index + 1, 1);
        Atomics.notify(state, 0);
      });
      return worker;
    });
    const state = new Int32Array(shared);
    const deadline = Date.now() + 30_000;
    try {
      while (workers.some((_, index) => Atomics.load(state, index + 1) === 0)) {
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, `concurrent correction workers timed out after 30s${workerFailures.length ? `: ${workerFailures.join("; ")}` : ""}`);
        Atomics.wait(state, 0, 0, Math.min(remaining, 1_000));
      }
      assert.deepEqual(workerFailures, [], workerFailures.join("; "));
    } finally {
      for (const worker of workers) void worker.terminate();
    }
    for (const outputPath of outputPaths) {
      const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      assert.equal(result.ok, true, result.error);
    }
    const finalRecord = readPlanRecordFromSandbox("IMP-807");
    assert.deepEqual(finalRecord.critical_invariants, record.critical_invariants);
    assert.equal(finalRecord.evidence_dispositions.length, 2);
    assert.deepEqual(resolvePlanEvidence(finalRecord).critical_invariants, []);
  });
});
