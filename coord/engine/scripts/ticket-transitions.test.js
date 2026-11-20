// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
const { gitFixture, gitFixtureEnv } = require("./test-git-fixture.js"); // COORD-952
const { findUnrelatedOwnerDoingPairs } = require("./followups.js"); // COORD-963
const test = require("node:test");
const governanceCommands = require("./lifecycle.js").commands;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { state } = require("./governance-context.js");
const createTicketTransitions = require("./ticket-transitions.js");
const { installCanonicalEngine } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js"));

const {
  GovernanceError,
  __testing,
  executeCommand,
  setupCoord003Workspace,
  readBoardRow,
  runGit,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

// COORD-061: tests for the extracted ticket-transitions.js state machine
// (start / submit / move-review / return-doing / mark-done / block / unblock /
// supersede, plus the persistReturnDoingState primitive). The transition
// functions are reached through the lifecycle __testing facade, which now wires
// the createTicketTransitions factory. Hermetic identity env: strip ambient ids.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

function buildCoord697SubmitHarness(overrides = {}) {
  const row = { ID: "B-697", Repo: "B", Status: "doing", Owner: "codexa680" };
  const board = { pr_index: {}, sections: [{ rows: [row] }] };
  const lock = { ticket: "B-697", branch: "agent/codexa680-b-697", worktree: "/tmp/coord697" };
  const calls = [];
  const noop = () => {};
  const deps = Object.fromEntries(
    createTicketTransitions.DEP_CONTRACT.callable.map((name) => [name, noop]),
  );
  Object.assign(deps, {
    fail: (message) => { throw new GovernanceError(message); },
    readBoard: () => board,
    getTicketRef: () => ({ row }),
    rowsById: () => new Map([[row.ID, row]]),
    findLockForTicket: () => lock,
    ensureDoingTicketLockIntegrity: () => lock,
    ensureTicketMutationOwnership: () => ({}),
    toArray: (value) => value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]),
    isRepoBackedCode: () => true,
    evaluateReadiness: () => ({ blockedBy: [], blockerChains: [], cycles: [] }),
    BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
    coordRepoRoot: "/tmp/coord-test",
    formatTransitiveBlockerDetails: () => "",
    formatDependencyCycleList: () => "",
    assertReviewPlanReady: () => calls.push("review-plan"),
    assertCommittedReviewState: () => calls.push("committed-state"),
    resolveReviewSubmission: () => ({ submission: { repository: "backend", commit: "a".repeat(40) }, unresolved_reason: null }),
    persistReviewSubmission: (_ticketId, prepared) => prepared,
    prCreate: () => {
      calls.push("pr-create");
      board.pr_index[row.ID] = ["https://github.com/acme/repo/pull/697"];
    },
    withGovernanceMutation: (_mutation, fn) => fn(),
    withCoordStateLock: (fn) => fn(),
    resolveLifecyclePrRefs: () => board.pr_index[row.ID] || [],
    assertAlreadyLandedNoPrReconcileReady: () => false,
    refsContainMergedPrForTicket: () => false,
    resolveTicketLockPath: () => "/tmp/nonexistent-coord697.lock",
    setTicketPrRefs: (_board, ticketId, refs) => { board.pr_index[ticketId] = refs; },
    applyTicketStatus: (ref, status) => { ref.row.Status = status; },
    writeBoard: () => calls.push("board-write"),
    runBoardSync: () => calls.push("board-sync"),
    ...overrides,
  });
  return { transitions: createTicketTransitions(deps), row, board, calls };
}

function buildReturnDoingOwnerRaceHarness(ownerAtLock) {
  const row = { ID: "B-844", Repo: "B", Status: "review", Owner: "codexa680" };
  const board = { sections: [{ rows: [row] }] };
  const calls = [];
  const noop = () => {};
  const deps = Object.fromEntries(
    createTicketTransitions.DEP_CONTRACT.callable.map((name) => [name, noop]),
  );
  Object.assign(deps, {
    BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
    fail: (message) => { throw new GovernanceError(message); },
    readBoard: () => board,
    getTicketRef: (_board, ticketId) => ticketId === row.ID ? { row } : null,
    canonicalizeOwnerOrFail: (owner) => owner,
    inferTicketStatus: () => row.Status,
    withGovernanceMutation: (_mutation, fn) => {
      // Model a different writer changing ownership after the command's early
      // assertion and immediately before this call receives the mutation lock.
      row.Owner = ownerAtLock;
      return fn();
    },
    assertTicketMutationOwnership: () => {
      calls.push("assert-ticket-ownership");
      return { agent: { handle: "codexa680" } };
    },
  });
  return { transitions: createTicketTransitions(deps), row, calls };
}

test("COORD-906: submit warns if the title-check base is missing and refuses unregistered titles once the base exists", (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "submit-title-check-"));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  gitFixture(worktree, ["init", "-q", "-b", "work"]);
  gitFixture(worktree, ["commit", "-q", "--allow-empty", "-m", "base"]);
  fs.mkdirSync(path.join(worktree, "release"));
  fs.writeFileSync(path.join(worktree, "release", "suite-inventory.json"), "{}\n");
  fs.writeFileSync(path.join(worktree, "release", "suite-titles.js"),
    "console.error('Unregistered fixture title'); process.exitCode = 1;\n");

  const harness = buildCoord697SubmitHarness({
    findLockForTicket: () => ({ worktree }),
    resolveTicketBaseRef: () => "fixture-base",
    resolveLifecyclePrRefs: (_ticket, _row, _board, options) => options.pr,
  });
  const warnings = t.mock.method(console, "error", () => {});
  const options = { pr: ["local-review (no PR)"] };
  harness.transitions.submitTicket(harness.row.ID, options);
  assert.equal(harness.row.Status, "review");
  assert.match(warnings.mock.calls[0].arguments[0], /neither origin\/fixture-base nor fixture-base resolves/);

  gitFixture(worktree, ["branch", "fixture-base"]);
  harness.row.Status = "doing";
  harness.calls.length = 0;
  assert.throws(() => harness.transitions.submitTicket(harness.row.ID, options),
    /submit refused: changed test titles are not registered for both editions\.\nUnregistered fixture title/);
  assert.equal(harness.row.Status, "doing");
  assert.deepEqual(harness.calls, []);
});

test("COORD-772: startTicket binds dispatch execution identity into mutation details and retry key", () => {
  const ticketId = "B-772-START";
  const owner = "codexa772";
  const executionId = "dispatch-exec-772";
  const row = { ID: ticketId, Repo: "B", Status: "todo", Owner: "", Description: "phase cost identity" };
  const board = { sections: [{ rows: [row] }] };
  const ref = { row };
  const sessionIdentity = { agent: { handle: owner }, session: { thread_id: "coord772-transition-test" }, autoClaimed: false };
  const workspace = path.join(os.tmpdir(), `coord772-unused-${process.pid}-${Date.now()}`);
  const lockPath = path.join(workspace, ".runtime", "locks", `${ticketId}.lock`);
  const noop = () => {};
  const deps = Object.fromEntries(createTicketTransitions.DEP_CONTRACT.callable.map((name) => [name, noop]));
  let capturedMutation = null;
  Object.assign(deps, {
    BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
    fail: (message) => { throw new GovernanceError(message); },
    readBoard: () => board,
    getTicketRef: () => ref,
    rowsById: () => new Map([[ticketId, row]]),
    inferTicketStatus: () => row.Status,
    withGovernanceMutation: (mutation, fn) => { capturedMutation = mutation; return fn(); },
    resolveOwnerIdentity: () => sessionIdentity,
    isRepoBackedCode: () => false,
    buildHistoricalCloseoutStartBlocker: () => null,
    evaluateReadiness: () => ({ blockedBy: [], blockerChains: [], cycles: [] }),
    assertPromptRecord: (_ticketId, _row, _board, options) => {
      options.resolvePreconditionRef?.();
      return true;
    },
    resolveTicketBaseRef: () => "dev",
    findDoingTicketForOwner: () => null,
    ensurePlanStub: () => ({ createdMarkdownBlock: false }),
    buildStartPlanSeedUpdate: () => ({}),
    slugify: (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    defaultWorktreePath: () => workspace,
    resolveTicketLockPath: () => lockPath,
    repoNameForCode: () => "backend",
    withPreparedTicketWorkspace: (_options, fn) => fn(),
    withCoordStateLock: (fn) => fn(),
    applyTicketStatus: (ticketRef, status) => { ticketRef.row.Status = status; },
    assignTicketOwner: (ticketRef, nextOwner) => { ticketRef.row.Owner = nextOwner; },
  });
  const transitions = createTicketTransitions(deps);
  transitions.startTicket(ticketId, { owner, topic: "phase costs", allowSharedWorktree: true, dispatchExecutionId: executionId });

  assert.equal(capturedMutation.command, "start");
  assert.deepEqual(capturedMutation.details, { dispatch_execution_id: executionId });
  assert.equal(row.Status, "doing", "the factory path completed without consulting production workspace state");
  const identityPayload = {
    owner,
    branch: null,
    worktree: null,
    topic: "phase costs",
    base: null,
    allowSharedWorktree: true,
    dispatchExecutionId: executionId,
  };
  const { stableIdempotencyKey } = require("./idempotency.js");
  assert.equal(capturedMutation.idempotencyKey, stableIdempotencyKey("start", ticketId, identityPayload));
  const identityWithoutExecution = { ...identityPayload };
  delete identityWithoutExecution.dispatchExecutionId;
  assert.notEqual(capturedMutation.idempotencyKey, stableIdempotencyKey("start", ticketId, identityWithoutExecution),
    "a distinct dispatch execution cannot reuse the same start retry key");
});

test("COORD-697: submit blocks unmet dependencies before delegating to PR creation", () => {
  const { transitions, calls } = buildCoord697SubmitHarness({
    evaluateReadiness: () => ({ blockedBy: ["B-1"], blockerChains: [], cycles: [] }),
  });
  assert.throws(() => transitions.submitTicket("B-697", { fill: true }), /unmet dependencies: B-1/);
  assert.equal(calls.includes("pr-create"), false);
});

test("COORD-697: submit completes review and commit preflight before PR creation", () => {
  const { transitions, row, calls } = buildCoord697SubmitHarness();
  transitions.submitTicket("B-697", { fill: true });
  assert.equal(row.Status, "review");
  const prCreateAt = calls.indexOf("pr-create");
  assert.ok(prCreateAt > calls.indexOf("review-plan"));
  assert.ok(prCreateAt > calls.indexOf("committed-state"));
  assert.deepEqual(calls.slice(0, 3), ["review-plan", "committed-state", "pr-create"]);
});

test("COORD-844: return-doing rechecks asserted ownership under the mutation lock", () => {
  const harness = buildReturnDoingOwnerRaceHarness("claudea99");
  assert.throws(
    () => harness.transitions.returnDoing("B-844", {
      owner: "codexa680",
      summary: "stale owner assertion",
      severity: "LOW",
      qref: "L13",
    }),
    (error) => error instanceof GovernanceError && /only an assertion of the current owner \(claudea99\); received codexa680/.test(error.message),
  );
  assert.equal(harness.row.Owner, "claudea99", "the concurrent ownership update remains authoritative");
  assert.equal(harness.row.Status, "review", "the stale owner cannot transition the ticket");
  assert.deepEqual(harness.calls, [], "refusal occurs before ticket-mutation ownership or finding attribution");
});

test("COORD-858: submit validates its routing branches before mutation", () => {
  const invalid = buildCoord697SubmitHarness();
  assert.throws(() => invalid.transitions.submitTicket("", {}), /submit requires/);
  assert.throws(() => buildCoord697SubmitHarness({ getTicketRef: () => null }).transitions.submitTicket("B-404", {}), /Unknown ticket/);
  const wrongStatus = buildCoord697SubmitHarness();
  wrongStatus.row.Status = "todo";
  assert.throws(() => wrongStatus.transitions.submitTicket("B-697", {}), /must be doing or review/);
  const noLock = buildCoord697SubmitHarness({ findLockForTicket: () => null });
  assert.throws(() => noLock.transitions.submitTicket("B-697", {}), /has no active lock/);

  const alreadyReview = buildCoord697SubmitHarness({ resolveLifecyclePrRefs: () => ["existing-pr"] });
  alreadyReview.row.Status = "review";
  const originalLog = console.log;
  let output = "";
  console.log = (value) => { output = value; };
  try { alreadyReview.transitions.submitTicket("B-697", {}); } finally { console.log = originalLog; }
  assert.deepEqual(JSON.parse(output), { ticket: "B-697", status: "already_review", pr_refs: ["existing-pr"] });
  assert.deepEqual(alreadyReview.calls, [], "already-review routing does not create a PR or write the board");

  const explicitPr = buildCoord697SubmitHarness({ resolveLifecyclePrRefs: (_ticket, _row, _board, options) => options.pr });
  explicitPr.transitions.submitTicket("B-697", { fill: true, pr: ["local-review (no PR)"] });
  assert.equal(explicitPr.row.Status, "review");
  assert.deepEqual(explicitPr.board.pr_index["B-697"], ["local-review (no PR)"]);

  const indexedPr = buildCoord697SubmitHarness();
  indexedPr.board.pr_index["B-697"] = ["pr-2"];
  indexedPr.transitions.submitTicket("B-697", {});
  assert.equal(indexedPr.row.Status, "review");
  assert.deepEqual(indexedPr.board.pr_index["B-697"], ["pr-2"]);

  const repoX = buildCoord697SubmitHarness({ isRepoBackedCode: () => false });
  repoX.row.Repo = "X";
  assert.throws(() => repoX.transitions.submitTicket("B-697", {}), /repo X and has no recorded PR evidence/);
  assert.equal(repoX.calls.includes("pr-create"), false);
});

test("persistReturnDoingState passes the repair round into the PLAN follow-up append", () => {
  const board = {
    sections: [
      {
        heading: "In Progress",
        rows: [
          {
            ID: "IMP-200",
            Repo: "X",
            Status: "review",
            Owner: "codexa01",
            Description: "Template quality closure",
          },
        ],
      },
    ],
    review_findings: {},
  };
  const ref = {
    row: board.sections[0].rows[0],
    rowIndex: 0,
    section: board.sections[0],
  };
  const observed = [];
  let syncWrites = 0;

  __testing.persistReturnDoingState({
    board,
    ref,
    finding: {
      id: "IMP-200-F2",
      severity: "HIGH",
      summary: "Repair stale review evidence",
      status: "open",
      round: 2,
      qref: "L42",
    },
    owner: "codexa02",
    branch: "agent/codexa02-imp-200",
    worktree: "/tmp/coord/.worktrees/codexa02/IMP-200",
    session: null,
    appendPlan(ticketId, findingId, summary, repoCode, owner, round) {
      observed.push({ ticketId, findingId, summary, repoCode, owner, round });
    },
    boardWriter() {},
    lockWriter() {},
    syncWriter() {
      syncWrites += 1;
    },
  });

  assert.deepEqual(observed, [
    {
      ticketId: "IMP-200",
      findingId: "IMP-200-F2",
      summary: "Repair stale review evidence",
      repoCode: "X",
      owner: "codexa02",
      round: 2,
    },
  ]);
  assert.equal(syncWrites, 1);
});

test("persistReturnDoingState does not write board or lock when the PLAN follow-up append fails", () => {
  const board = {
    sections: [
      {
        heading: "In Progress",
        rows: [
          {
            ID: "IMP-193",
            Repo: "X",
            Status: "review",
            Owner: "codexa01",
            Description: "Governance concurrency hardening",
          },
        ],
      },
    ],
    review_findings: {},
  };
  const ref = {
    row: board.sections[0].rows[0],
    rowIndex: 0,
    section: board.sections[0],
  };
  let boardWrites = 0;
  let lockWrites = 0;
  let syncWrites = 0;

  assert.throws(
    () =>
      __testing.persistReturnDoingState({
        board,
        ref,
        finding: {
          id: "IMP-193-F1",
          severity: "HIGH",
          summary: "Repair PLAN ordering",
          status: "open",
          round: 1,
          qref: "L10",
        },
        owner: "codexa02",
        branch: "agent/codexa02-imp-193",
        worktree: "/tmp/coord/.worktrees/codexa02/IMP-193",
        session: null,
        appendPlan() {
          throw new GovernanceError("simulated plan append failure");
        },
        boardWriter() {
          boardWrites += 1;
        },
        lockWriter() {
          lockWrites += 1;
        },
        syncWriter() {
          syncWrites += 1;
        },
      }),
    (error) => error instanceof GovernanceError && /simulated plan append failure/.test(error.message)
  );

  assert.equal(boardWrites, 0);
  assert.equal(lockWrites, 0);
  assert.equal(syncWrites, 0);
});

test("COORD-003 Fix 3: block then unblock round-trips doing <-> doing (blocked: ...)", () => {
  const ticketId = "MSRV-310";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-block-roundtrip-", ticketId, owner);
  try {
    governanceCommands.blockTicket(ticketId, { reason: "waiting on upstream API" });
    let row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "doing (blocked: waiting on upstream API)");
    // Lock keeps status:"doing" — consistent with isDoingStatus, no drift.
    const lock = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    assert.equal(lock.status, "doing");

    governanceCommands.unblockTicket(ticketId, {});
    row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 3: block requires --reason", () => {
  const ticketId = "MSRV-311";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-block-noreason-", ticketId, owner);
  try {
    assert.throws(
      () => governanceCommands.blockTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /requires --reason/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 3: block rejects an illegal source status (not plain doing)", () => {
  const ticketId = "MSRV-312";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-block-illegal-", ticketId, owner, { ticketStatus: "todo" });
  try {
    assert.throws(
      () => governanceCommands.blockTicket(ticketId, { reason: "x" }),
      (error) => error instanceof GovernanceError && /must be plain "doing"/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 3: unblock rejects a ticket that is not blocked", () => {
  const ticketId = "MSRV-313";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord003-unblock-illegal-", ticketId, owner);
  try {
    assert.throws(
      () => governanceCommands.unblockTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /must be "doing \(blocked: \.\.\.\)"/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});


test("COORD-547: amendment captures the prior reason after acquiring the mutation lock", () => {
  let recorded;
  const harness = buildCoord697SubmitHarness({
    inferTicketStatus: () => "doing (blocked: original)",
    isLegalStatus: () => true,
    withGovernanceMutation: (mutation, fn) => {
      // Another writer completed while this call was waiting for the lock.
      harness.row.Status = "doing (blocked: concurrent update)";
      fn();
      recorded = mutation;
    },
  });
  harness.transitions.blockTicket(harness.row.ID, { reason: "latest dependency" });
  assert.equal(recorded.beforeStatus, "doing (blocked: concurrent update)");
  assert.equal(recorded.afterStatus, "doing (blocked: latest dependency)");
  assert.equal(harness.row.Status, recorded.afterStatus);
});

for (const method of ["blockTicket", "unblockTicket"]) {
  for (const missing of ["ticket id", "board row"]) {
    test(`COORD-547: ${method} refuses missing ${missing} before writes`, () => {
      const harness = buildCoord697SubmitHarness(missing === "board row" ? { getTicketRef: () => null } : {});
      const before = { ...harness.row };
      assert.throws(() => harness.transitions[method](missing === "ticket id" ? "" : "UNKNOWN-547", { reason: "dependency" }),
        (error) => error instanceof GovernanceError && (missing === "ticket id" ? /requires <ticket-id>/.test(error.message) : /Unknown ticket "UNKNOWN-547"/.test(error.message)));
      assert.deepEqual(harness.row, before);
      assert.deepEqual(harness.calls, []);
    });
  }
}

test("COORD-547: block refuses a multiline reason through the real status validator", () => {
  const ticketId = "MSRV-550";
  const ctx = setupCoord003Workspace("coord547-multiline-", ticketId, "claudea0000");
  try {
    const before = blockStateSnapshot(ctx);
    assert.throws(() => governanceCommands.blockTicket(ticketId, { reason: "dependency\nsecond line" }),
      (error) => error instanceof GovernanceError && error.message.includes("is not a legal status"));
    assert.deepEqual(blockStateSnapshot(ctx), before);
  } finally {
    ctx.restore();
  }
});

test("COORD-547: unblock refuses a missing status before writes", () => {
  const harness = buildCoord697SubmitHarness();
  delete harness.row.Status;
  const before = { ...harness.row };
  assert.throws(() => harness.transitions.unblockTicket(harness.row.ID),
    (error) => error instanceof GovernanceError && /must be "doing \(blocked: \.\.\.\)" to unblock/.test(error.message));
  assert.deepEqual(harness.row, before);
  assert.deepEqual(harness.calls, []);
});

function blockStateSnapshot(ctx) {
  return [ctx.boardPath, ctx.lockPath, state.GOVERNANCE_EVENT_LOG_PATH, state.AGENT_SESSIONS_PATH]
    .map((file) => fs.readFileSync(file, "utf8"));
}

test("COORD-547: amend a blocked reason in one event and replay idempotently", () => {
  const ticketId = "MSRV-547";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord547-amend-", ticketId, owner);
  try {
    governanceCommands.blockTicket(ticketId, { reason: "old dependency" });
    const lockBefore = fs.readFileSync(ctx.lockPath, "utf8");
    const eventsBefore = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    governanceCommands.blockTicket(ticketId, { reason: "new dependency" });
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "doing (blocked: new dependency)");
    assert.equal(row.Owner, owner);
    assert.equal(fs.readFileSync(ctx.lockPath, "utf8"), lockBefore);
    const eventsAfter = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    assert.ok(eventsAfter.startsWith(eventsBefore));
    const appended = eventsAfter.slice(eventsBefore.length).trim().split("\n").map(JSON.parse);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].command, "block");
    assert.equal(appended[0].result, "succeeded");
    assert.equal(appended[0].before_status, "doing (blocked: old dependency)");
    assert.equal(appended[0].after_status, "doing (blocked: new dependency)");
    assert.equal(appended[0].details.reason, "new dependency");
    const amended = blockStateSnapshot(ctx);
    governanceCommands.blockTicket(ticketId, { reason: "new dependency" });
    assert.deepEqual(blockStateSnapshot(ctx), amended);
    governanceCommands.blockTicket(ticketId, { reason: "  new dependency  " });
    assert.deepEqual(blockStateSnapshot(ctx), amended);
    assert.throws(() => governanceCommands.blockTicket(ticketId, { reason: "   " }), /requires --reason/);
    assert.deepEqual(blockStateSnapshot(ctx), amended);
  } finally {
    ctx.restore();
  }
});

test("COORD-547: a foreign session cannot amend the owner's blocked reason", () => {
  const ticketId = "MSRV-548";
  const ctx = setupCoord003Workspace("coord547-foreign-", ticketId, "claudea0000");
  try {
    governanceCommands.blockTicket(ticketId, { reason: "owner dependency" });
    const sessions = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"));
    sessions.push({ ...sessions[0], session_id: "a99-foreign", agent_id: "a99", handle: "claudea99", thread_id: "coord547-foreign" });
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(sessions));
    process.env.CLAUDE_SESSION_ID = "coord547-foreign";
    const before = blockStateSnapshot(ctx);
    assert.throws(() => governanceCommands.blockTicket(ticketId, { reason: "foreign change" }),
      (error) => error instanceof GovernanceError && /is owned by claudea0000/.test(error.message));
    assert.deepEqual(blockStateSnapshot(ctx), before);
  } finally {
    ctx.restore();
  }
});

for (const status of ["todo", "review", "doing (other: pending)"]) {
  test(`COORD-547: block refuses source status ${status} without writes`, () => {
    const ticketId = "MSRV-549";
    const ctx = setupCoord003Workspace("coord547-status-", ticketId, "claudea0000", { ticketStatus: status });
    try {
      const before = blockStateSnapshot(ctx);
      assert.throws(() => governanceCommands.blockTicket(ticketId, { reason: "dependency" }),
        (error) => error instanceof GovernanceError && /must be.*doing/.test(error.message));
      assert.deepEqual(blockStateSnapshot(ctx), before);
    } finally {
      ctx.restore();
    }
  });
}

test("COORD-065: supersede records inline provenance (Supersede Reason + Superseded By) on the board row", () => {
  const ticketId = "MSRV-314";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord065-supersede-provenance-", ticketId, owner);
  try {
    governanceCommands.supersedeTicket(ticketId, {
      reason: "Re-scoped into MSRV-999; original deliverables never produced.",
      consolidatedInto: "MSRV-999",
    });
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "superseded");
    assert.equal(row["Superseded By"], "MSRV-999");
    assert.equal(
      row["Supersede Reason"],
      "Re-scoped into MSRV-999; original deliverables never produced."
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-065: supersede without --reason leaves no empty provenance fields on the row", () => {
  const ticketId = "MSRV-315";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("coord065-supersede-noreason-", ticketId, owner);
  try {
    governanceCommands.supersedeTicket(ticketId, {});
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "superseded");
    assert.ok(!("Superseded By" in row), "no replacement pointer when none provided");
    assert.ok(!("Supersede Reason" in row), "no reason field when none provided");
  } finally {
    ctx.restore();
  }
});

function supersedeStateSnapshot(ctx) {
  const paths = [
    ctx.boardPath,
    path.join(ctx.coordRoot, "PLAN.md"),
    path.join(ctx.planRecordsDir, `${ctx.ticketId}.json`),
    ctx.lockPath,
    state.GOVERNANCE_EVENT_LOG_PATH,
    state.GOVERNANCE_SNAPSHOT_PATH,
  ];
  return paths.map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
}

test("COORD-855: supersede refuses a missing or unknown ticket without changing governed state", () => {
  const ticketId = "MSRV-851";
  const ctx = setupCoord003Workspace("coord855-supersede-input-", ticketId, "claudea0000");
  try {
    const before = supersedeStateSnapshot({ ...ctx, ticketId });
    assert.throws(() => governanceCommands.supersedeTicket(null, {}),
      (error) => error instanceof GovernanceError && /supersede requires <ticket-id>/.test(error.message));
    assert.deepEqual(supersedeStateSnapshot({ ...ctx, ticketId }), before,
      "missing IDs must not write board, plan, lock, snapshot or journal state");

    assert.throws(() => governanceCommands.supersedeTicket("MSRV-999", {}),
      (error) => error instanceof GovernanceError && /Unknown ticket/.test(error.message));
    assert.deepEqual(supersedeStateSnapshot({ ...ctx, ticketId }), before,
      "unknown IDs must not write board, plan, lock, snapshot or journal state");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: superseding an already-superseded row is idempotent and leaves its residue untouched", () => {
  const ticketId = "MSRV-852";
  const ctx = setupCoord003Workspace("coord855-supersede-idempotent-", ticketId, "claudea0000", {
    ticketStatus: "superseded",
  });
  try {
    const lockBefore = fs.readFileSync(ctx.lockPath);
    const worktreeBefore = runGit(ctx.backendRoot, ["worktree", "list", "--porcelain"]);
    governanceCommands.supersedeTicket(ticketId, {});
    const firstJournal = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH);
    governanceCommands.supersedeTicket(ticketId, {});
    assert.equal(fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8"), firstJournal.toString("utf8"),
      "a retry must not append a duplicate supersede event");
    assert.deepEqual(fs.readFileSync(ctx.lockPath), lockBefore, "the no-op must not remove an unrelated stale lock");
    assert.equal(runGit(ctx.backendRoot, ["worktree", "list", "--porcelain"]), worktreeBefore,
      "the no-op must not clean a worktree for an already-superseded row");
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "superseded");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: doing supersede without its active lock refuses before changing governed state", () => {
  const ticketId = "MSRV-853";
  const ctx = setupCoord003Workspace("coord855-supersede-no-lock-", ticketId, "claudea0000");
  try {
    fs.unlinkSync(ctx.lockPath);
    const before = supersedeStateSnapshot({ ...ctx, ticketId });
    assert.throws(() => governanceCommands.supersedeTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /is doing but has no active lock/.test(error.message));
    assert.deepEqual(supersedeStateSnapshot({ ...ctx, ticketId }), before,
      "a missing-lock refusal must leave all governed bytes unchanged");
    assert.ok(fs.existsSync(ctx.worktreePath), "refusal must not remove the active worktree");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: review supersede enforces owner authority before changing governed state", () => {
  const ticketId = "MSRV-854";
  const ctx = setupCoord003Workspace("coord855-supersede-review-owner-", ticketId, "claudea0000", {
    ticketStatus: "review",
  });
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.sections[0].rows[0].Owner = "claudea99";
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-855 review owner refusal fixture");
    const before = supersedeStateSnapshot({ ...ctx, ticketId });
    assert.throws(() => governanceCommands.supersedeTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /owned by claudea99|owner|session|identity/i.test(error.message));
    assert.deepEqual(supersedeStateSnapshot({ ...ctx, ticketId }), before,
      "review ownership refusal must not rewrite the board, lock, plan or journal");
    assert.ok(fs.existsSync(ctx.worktreePath), "ownership refusal must not clean the reviewed worktree");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: unlocked todo supersede resolves the canonical lock path and journals cleanup result", () => {
  const ticketId = "MSRV-855";
  const ctx = setupCoord003Workspace("coord855-supersede-cleanup-", ticketId, "claudea0000", {
    ticketStatus: "todo",
  });
  try {
    fs.unlinkSync(ctx.lockPath);
    assert.equal(fs.existsSync(ctx.worktreePath), true);
    governanceCommands.supersedeTicket(ticketId, { reason: "replaced", consolidatedInto: "MSRV-855-REPLACEMENT" });
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "superseded");
    assert.equal(fs.existsSync(ctx.worktreePath), false, "successful cleanup removes the governed worktree");
    assert.equal(fs.existsSync(ctx.lockPath), false, "the canonical lock path remains absent");
    const events = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse);
    const event = events.findLast((entry) => entry.command === "supersede" && entry.ticket === ticketId);
    assert.ok(event, "successful supersede is journaled");
    assert.equal(event.details.previous_status, "todo");
    assert.deepEqual(event.details.cleaned_workspace, {
      worktree: ctx.worktreePath,
      branch: `agent/claudea0000-${ticketId.toLowerCase()}-coord003`,
    });
    assert.equal(event.details.reason, "replaced");
    assert.equal(event.details.consolidated_into, "MSRV-855-REPLACEMENT");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: unlocked todo supersede journals null when no governed worktree is discoverable", () => {
  const ticketId = "MSRV-856";
  const ctx = setupCoord003Workspace("coord855-supersede-no-worktree-", ticketId, "claudea0000", {
    ticketStatus: "todo",
  });
  try {
    fs.unlinkSync(ctx.lockPath);
    runGit(ctx.backendRoot, ["worktree", "remove", ctx.worktreePath]);
    assert.equal(fs.existsSync(ctx.worktreePath), false, "the fixture starts with no on-disk worktree");
    assert.equal(runGit(ctx.backendRoot, ["worktree", "list", "--porcelain"])
      .split("\n").includes(`worktree ${ctx.worktreePath}`), false,
      "the worktree is not registered under the ticket's repository");

    governanceCommands.supersedeTicket(ticketId, { reason: "no workspace exists" });

    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "superseded");
    assert.equal(fs.existsSync(ctx.lockPath), false, "the canonical lock path remains absent");
    const events = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map(JSON.parse);
    const event = events.findLast((entry) => entry.command === "supersede" && entry.ticket === ticketId);
    assert.ok(event, "successful supersede is journaled");
    assert.equal(event.details.previous_status, "todo");
    assert.equal(event.details.cleaned_workspace, null,
      "the journal accurately records that no governed workspace was found to clean");
  } finally {
    ctx.restore();
  }
});

test("COORD-858: supersede landing refusal uses the lifecycle repository display-name binding", () => {
  const ticketId = "MSRV-858-LANDED";
  const ctx = setupCoord003Workspace("coord858-supersede-landed-label-", ticketId, "claudea0000", { withCommit: true });
  try {
    const sourceHead = runGit(ctx.worktreePath, ["rev-parse", "HEAD"]);
    runGit(ctx.backendRoot, ["checkout", "dev"]);
    runGit(ctx.backendRoot, ["merge", "--ff-only", sourceHead]);
    assert.throws(() => governanceCommands.supersedeTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /already be landed on backend\/dev/.test(error.message));
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing", "the lifecycle refusal leaves the ticket active");
  } finally {
    ctx.restore();
  }
});

// COORD-692: return-doing must consult the closeout-blocker exception.
//
// COORD-558 established `canOwnerHoldConcurrentDoing` as the supported route
// for one owner to hold a declared closeout-blocker pair, and `startTicket`
// honours it. `returnDoing` did not: it failed on any same-owner doing ticket.
// So an owner the model permits to hold both could start the follow-up and then
// not take a review rejection on it — measured on the COORD-667/COORD-691 pair
// on 2026-08-22.
function setupCloseoutBlockerPair(prefix, { withException = true } = {}) {
  const parentId = "MSRV-670";
  const childId = "MSRV-671";
  const owner = "claudea0000";
  // The child is the ticket being returned, so it owns the worktree/lock the
  // fixture builds; the parent is added as the concurrent `doing` ticket.
  const ctx = setupCoord003Workspace(prefix, childId, owner, { ticketStatus: "review" });
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  // Match the branch slug that setupCoord003Workspace already created. In the
  // real lane startTicket and returnDoing derive the same slug from the stable
  // ticket description; leaving the fixture's generic description in place
  // would manufacture a branch rename unrelated to COORD-692.
  board.sections[0].rows[0].Description = "coord003";
  board.sections[0].rows.push({
    ID: parentId,
    Repo: "X",
    Status: "doing",
    Owner: owner,
    Description: "Parent held concurrently under the recorded exception",
  });
  if (withException) {
    // This is the exact state written by:
    // set-followup-relation <child> --depends-on <parent> --relation closeout-blocker
    board.followup_exceptions = {
      ...(board.followup_exceptions || {}),
      [childId]: { type: "closeout-blocker", parent: parentId },
    };
  }
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`);
  // Fixture setup materializes the state that set-followup-relation would have
  // written. Re-anchor the seal so the test exercises return-doing rather than
  // correctly tripping the out-of-band board-write detector.
  __testing.appendGovernanceEvent({
    ts: new Date().toISOString(),
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "COORD-692 closeout-blocker fixture" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
  return { ctx, parentId, childId, owner };
}

function setupPreservedReturnDoingWorkspace(prefix, { movedToWrongBranch = false } = {}) {
  const ticketId = "B-1052";
  const originalOwner = "claudea99";
  const currentOwner = "claudea0000";
  const ctx = setupCoord003Workspace(prefix, ticketId, currentOwner, { ticketStatus: "review" });
  try {
    const originalWorktree = path.join(ctx.backendRoot, ".worktrees", originalOwner, ticketId);
    runGit(ctx.backendRoot, ["worktree", "remove", "--force", ctx.worktreePath]);
    runGit(ctx.backendRoot, ["branch", "-D", ctx.branch]);
    const branch = `agent/${originalOwner}-${ticketId.toLowerCase()}-coord003`;
    runGit(ctx.backendRoot, ["branch", branch, "dev"]);
    fs.mkdirSync(path.dirname(originalWorktree), { recursive: true });
    runGit(ctx.backendRoot, ["worktree", "add", originalWorktree, branch]);
    const head = runGit(originalWorktree, ["rev-parse", "HEAD"]);

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.pr_index[ticketId] = ["https://github.com/example/backend/pull/1052"];
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`);
    const planPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    plan.ticket_id = ticketId;
    plan.review_submission = { repository: "backend", commit: head };
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    fs.rmSync(ctx.lockPath, { force: true }); // move-review releases the ticket lock.

    const append = (command, details) => __testing.appendGovernanceEvent({
      ts: new Date().toISOString(), command, ticket: ticketId, result: "succeeded", details,
      changed_paths: [], snapshot: __testing.buildGovernanceSnapshot(),
    });
    append("pr-create", { external_side_effects: [{ type: "git_branch_push", ticket: ticketId, delivered: true, branch, commit_sha: head, worktree: originalWorktree }] });
    append("claim-ticket", { previous_owner: originalOwner, new_owner: currentOwner });

    let checkedOutBranch = branch;
    if (movedToWrongBranch) {
      checkedOutBranch = `${branch}-wrong`;
      runGit(originalWorktree, ["checkout", "-b", checkedOutBranch]);
    }
    return { ctx, ticketId, originalOwner, currentOwner, originalWorktree, branch, head, checkedOutBranch };
  } catch (error) {
    ctx.restore();
    throw error;
  }
}

function preservedReturnDoingState(ctx, worktree) {
  return {
    board: fs.readFileSync(ctx.boardPath, "utf8"),
    plan: fs.readFileSync(path.join(ctx.planRecordsDir, "B-1052.json"), "utf8"),
    journal: fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8"),
    lock: fs.existsSync(ctx.lockPath) ? fs.readFileSync(ctx.lockPath, "utf8") : null,
    worktrees: runGit(ctx.backendRoot, ["worktree", "list", "--porcelain"]),
    branches: runGit(ctx.backendRoot, ["branch", "--list"]),
    worktreeBranch: runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    worktreeHead: runGit(worktree, ["rev-parse", "HEAD"]),
    worktreeStatus: runGit(worktree, ["status", "--porcelain"]),
  };
}

test("COORD-1052: return-doing preserves the transferred PR workspace and refuses damaged or mismatched evidence without writes", () => {
  for (const scenario of [
    { name: "journaled workspace problems", options: [], movedToWrongBranch: true, error: /not the PR branch/ },
    { name: "branch override mismatch", options: ["--branch", "agent/other-b-1052-return"], error: /disagrees with the PR branch/ },
    { name: "worktree override mismatch", options: ["--worktree", path.join(os.tmpdir(), "coord1052-wrong-worktree")], error: /disagrees with the PR worktree/ },
  ]) {
    const fixture = setupPreservedReturnDoingWorkspace(`coord1052-return-refusal-${scenario.name.replaceAll(" ", "-")}-`, scenario);
    try {
      const before = preservedReturnDoingState(fixture.ctx, fixture.originalWorktree);
      const result = executeCommand(["return-doing", fixture.ticketId, "--summary", "address the reviewed finding", "--severity", "HIGH", "--qref", "L1", ...scenario.options]);
      assert.equal(result.ok, false, `${scenario.name} must refuse`);
      assert.match(result.error, scenario.error);
      assert.deepEqual(preservedReturnDoingState(fixture.ctx, fixture.originalWorktree), before,
        `${scenario.name} preserves board, plan, journal, lock, branch, worktree and head bytes`);
    } finally { fixture.ctx.restore(); }
  }

  const fixture = setupPreservedReturnDoingWorkspace("coord1052-return-preserved-success-");
  try {
    const result = executeCommand(["return-doing", fixture.ticketId, "--summary", "address the reviewed finding", "--severity", "HIGH", "--qref", "L1"]);
    assert.equal(result.ok, true, `return-doing must reopen the preserved PR workspace: ${result.error}`);
    const row = readBoardRow(fixture.ctx.boardPath, fixture.ticketId);
    assert.equal(row.Status, "doing");
    assert.equal(row.Owner, fixture.currentOwner);
    const lock = JSON.parse(fs.readFileSync(fixture.ctx.lockPath, "utf8"));
    assert.equal(lock.owner, fixture.currentOwner);
    assert.equal(lock.branch, fixture.branch);
    assert.equal(lock.worktree, fixture.originalWorktree);
    assert.equal(lock.workspace_owner, fixture.originalOwner);
    assert.deepEqual(lock.transfer_provenance?.map(({ from, to, workspace_owner }) => ({ from, to, workspace_owner })),
      [{ from: fixture.originalOwner, to: fixture.currentOwner, workspace_owner: fixture.originalOwner }]);
    const events = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const returned = events.findLast((event) => event.command === "return-doing" && event.ticket === fixture.ticketId && event.result === "succeeded");
    assert.equal(returned.details.preserved_workspace.worktree, fixture.originalWorktree);
    assert.equal(returned.details.preserved_workspace.branch, fixture.branch);
    assert.equal(returned.details.preserved_workspace.workspace_owner, fixture.originalOwner);
    assert.ok(runGit(fixture.ctx.backendRoot, ["worktree", "list", "--porcelain"]).includes(fixture.originalWorktree));
    assert.equal(runGit(fixture.ctx.backendRoot, ["worktree", "list", "--porcelain"]).includes(path.join(".worktrees", fixture.currentOwner)), false,
      "the new owner does not receive a duplicate worktree namespace");
  } finally { fixture.ctx.restore(); }
});

test("COORD-692 RED: return-doing permits a declared closeout-blocker pair the same owner already holds", () => {
  const { ctx, childId, parentId } = setupCloseoutBlockerPair("coord692-permitted-");
  try {
    const lockBefore = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));

    const result = executeCommand([
      "return-doing",
      childId,
      "--summary",
      "review rejected: the follow-up needs another round",
      "--severity",
      "HIGH",
      "--qref",
      "L1",
    ]);
    assert.equal(result.ok, true, `return-doing should succeed; got: ${result.error}`);

    const child = readBoardRow(ctx.boardPath, childId);
    assert.equal(child.Status, "doing", "the rejected follow-up must reach doing");
    assert.equal(child.Owner, lockBefore.owner, "ownership must be unchanged");
    assert.equal(
      readBoardRow(ctx.boardPath, parentId).Status,
      "doing",
      "the parent is untouched — this is concurrency, not a handoff",
    );

    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const findings = board.review_findings[childId] || [];
    assert.equal(findings.length, 1, "the rejection must record a finding");
    assert.equal(findings[0].round, 1, "COORD-649: the round advances onto the finding");
    const plan = JSON.parse(
      fs.readFileSync(path.join(ctx.planRecordsDir, `${childId}.json`), "utf8"),
    );
    assert.equal(plan.review_round, 1, "COORD-649: the same round advances onto the plan record");

    const lockAfter = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    assert.equal(lockAfter.status, "doing", "the lock is reacquired");
    // A 2026-08-22 return-doing after an owner change cut a new canonical
    // branch from main and orphaned the ticket's work. Preserve both identities.
    assert.equal(lockAfter.branch, lockBefore.branch, "the existing branch identity must be preserved");
    assert.equal(lockAfter.worktree, lockBefore.worktree, "the existing worktree must be preserved");
  } finally {
    ctx.restore();
  }
});

test("COORD-963: an unrelated same-owner pair is admitted (wip-cap retired) and the owner-doing warning names it", () => {
  const { ctx, childId, parentId } = setupCloseoutBlockerPair("coord692-unrelated-", {
    withException: false,
  });
  try {
    const result = executeCommand([
      "return-doing",
      childId,
      "--summary",
      "x",
      "--severity",
      "HIGH",
      "--qref",
      "L1",
    ]);
    assert.equal(result.ok, true, `return-doing must no longer refuse on the owner WIP cap: ${result.error}`);
    assert.match(readBoardRow(ctx.boardPath, childId).Status, /^doing/, "return-doing advances the ticket to doing");
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const pairs = findUnrelatedOwnerDoingPairs(board);
    assert.ok(
      pairs.some((pair) => (pair.left === childId && pair.right === parentId) || (pair.left === parentId && pair.right === childId)),
      "the unrelated same-owner pair must be reported by the owner-doing detector",
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-858: move-review persists validated submission before board/lock transition and journals exact scope", () => {
  const events = [];
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord858-move-review-lock-"));
  const lockPath = path.join(lockDir, "B-697.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ ticket: "B-697", owner: "codexa680" }));
  let mutation;
  let persistedSubmission = null;
  const prepared = { submission: { repository: "backend", commit: "a".repeat(40) }, unresolved_reason: null };
  const { transitions, row, board } = buildCoord697SubmitHarness({
    withGovernanceMutation: (entry, run) => { mutation = entry; return run(); },
    ensureDoingTicketLockIntegrity: () => ({ repo: "backend", head: "a".repeat(40), path: lockPath }),
    resolveReviewSubmission: () => { events.push("validate"); return prepared; },
    persistReviewSubmission: (_ticket, value) => {
      events.push("persist");
      assert.equal(value, prepared);
      assert.equal(fs.existsSync(lockPath), true, "the lock remains until the plan scope is persisted");
      persistedSubmission = { ...value.submission };
      return prepared;
    },
    resolveLifecyclePrRefs: () => ["https://example.test/pr/858"],
    assertCommittedReviewState: () => events.push("committed"),
    setTicketPrRefs: (_board, ticket, refs) => { events.push("pr-refs"); board.pr_index[ticket] = refs; },
    applyTicketStatus: (_ref, status) => { events.push("status"); row.Status = status; },
    writeBoard: () => {
      events.push("board");
      assert.equal(fs.existsSync(lockPath), true, "the lock remains until the review board state is written");
    },
    runBoardSync: () => {
      events.push("sync");
      assert.equal(fs.existsSync(lockPath), false, "the lock is released before the synchronized review state is exposed");
    },
    withCoordStateLock: (fn) => { events.push("lock-enter"); fn(); events.push("lock-exit"); },
  });
  try {
    assert.equal(fs.existsSync(lockPath), true, "the transition starts with a real lock file");
    transitions.moveReview("B-697", { pr: ["https://example.test/pr/858"] });
    assert.deepEqual(events, ["validate", "committed", "lock-enter", "persist", "pr-refs", "status", "board", "sync", "lock-exit"]);
    assert.deepEqual(mutation.details.review_submission, prepared);
    assert.deepEqual(persistedSubmission, prepared.submission, "submitted scope is persisted before the status and lock transition");
    assert.equal(row.Status, "review");
    assert.deepEqual(board.pr_index[row.ID], ["https://example.test/pr/858"]);
    assert.equal(fs.existsSync(lockPath), false, "successful review transition removes the existing lock file");
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("COORD-858: move-review records unresolved no-Git scope in its transition result", (t) => {
  const url = "https://github.com/acme/repo/pull/697";
  const output = t.mock.method(console, "log", () => {});
  for (const pr of ["local-review (no PR)", url]) {
    let mutation;
    const { transitions, row, board } = buildCoord697SubmitHarness({
      isRepoBackedCode: () => false,
      resolveLifecyclePrRefs: () => [pr],
      resolveReviewSubmission: () => ({ submission: null, unresolved_reason: "no repository-backed commit" }),
      withGovernanceMutation: (value, run) => { mutation = value; return run(); },
    });
    row.Repo = "X";
    transitions.moveReview(row.ID, { pr: [pr] });
    assert.match(output.mock.calls.at(-1).arguments[0], /left no-Git submission scope unresolved/);
    assert.equal(row.Status, "review");
    assert.deepEqual(board.pr_index[row.ID], [pr]);
    if (pr === url) {
      assert.deepEqual(mutation.details.workspace_evidence, {
        branch: "agent/codexa680-b-697", worktree: "/tmp/coord697", head: null, pr_url: null, pr_head_ref: null,
      });
    } else {
      assert.equal(mutation.details.workspace_evidence, undefined);
    }
  }
});

test("COORD-858: move-review refusals leave submission, board, and real lock untouched", () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord858-move-review-refusal-"));
  try {
    for (const scenario of [
      { name: "missing ticket id", ticketId: "", error: /move-review requires/ },
      { name: "missing ticket row", ticketId: "B-697", getTicketRef: () => null, error: /Unknown ticket/ },
      { name: "non-doing status", ticketId: "B-697", status: "review", error: /must be doing/ },
    ]) {
      const lockPath = path.join(lockDir, `${scenario.name.replaceAll(" ", "-")}.lock`);
      fs.writeFileSync(lockPath, JSON.stringify({ ticket: "B-697", owner: "codexa680" }));
      const writes = [];
      const overrides = {
        ensureDoingTicketLockIntegrity: () => ({ repo: "backend", head: "a".repeat(40), path: lockPath }),
        resolveReviewSubmission: () => { writes.push("validate"); return { submission: { repository: "backend", commit: "a".repeat(40) } }; },
        persistReviewSubmission: () => writes.push("persist"),
        setTicketPrRefs: () => writes.push("pr-refs"),
        applyTicketStatus: () => writes.push("status"),
        writeBoard: () => writes.push("board"),
        runBoardSync: () => writes.push("sync"),
        ...(scenario.getTicketRef ? { getTicketRef: scenario.getTicketRef } : {}),
      };
      const harness = buildCoord697SubmitHarness(overrides);
      if (scenario.status) harness.row.Status = scenario.status;
      assert.throws(() => harness.transitions.moveReview(scenario.ticketId, { pr: ["https://example.test/pr/858"] }), scenario.error,
        `${scenario.name} must refuse`);
      assert.deepEqual(writes, [], `${scenario.name} must refuse before submission or board writes`);
      assert.equal(fs.existsSync(lockPath), true, `${scenario.name} must preserve the existing lock`);
      fs.rmSync(lockPath);
    }
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test("COORD-858: move-review refuses declared-repository mismatch before PR, board, status, or persistence writes", () => {
  const writes = [];
  const { transitions, row, board } = buildCoord697SubmitHarness({
    resolveReviewSubmission: () => { throw new GovernanceError("lock repository does not match declared repository B"); },
    resolveLifecyclePrRefs: () => { writes.push("resolve-pr"); return ["pr"]; },
    persistReviewSubmission: () => writes.push("persist"),
    setTicketPrRefs: () => writes.push("pr-write"),
    applyTicketStatus: () => writes.push("status"),
    writeBoard: () => writes.push("board"),
    runBoardSync: () => writes.push("sync"),
  });
  assert.throws(() => transitions.moveReview("B-697", { pr: ["pr"] }), /lock repository does not match/);
  assert.deepEqual(writes, []);
  assert.equal(row.Status, "doing");
  assert.deepEqual(board.pr_index[row.ID], undefined);
});

// COORD-921: a fake `gh` on PATH. Its PR head follows the bare origin branch
// (like a real provider) unless the config pins a head, so a test can show a
// re-submit that never pushed, or a head that does not verify after the push.
const FAKE_GH_SOURCE = `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, "utf8"));
fs.appendFileSync(cfg.log, JSON.stringify(args) + "\\n");
const headOid = () => cfg.headOid || cp.execFileSync("git", ["--git-dir", cfg.origin, "rev-parse", "--verify", "-q", "refs/heads/" + cfg.branch], { encoding: "utf8" }).trim();
const pr = () => ({ number: cfg.number, url: cfg.url, state: "OPEN", mergedAt: null, title: "fixture PR", headRefName: cfg.branch, headRefOid: headOid(), baseRefName: "dev", isDraft: false, author: { login: "fixture" }, mergeStateStatus: "CLEAN", mergeCommit: null });
if (args[0] === "pr" && args[1] === "view") { process.stdout.write(JSON.stringify(pr())); process.exit(0); }
if (args[0] === "pr" && args[1] === "list") { process.stdout.write(JSON.stringify([pr()])); process.exit(0); }
process.stderr.write("fake gh: unsupported " + args.join(" ") + "\\n");
process.exit(1);
`;

function createIsolatedReviewSubmissionFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord858-resubmission-"));
  const coord = path.join(root, "coord");
  const backend = path.join(root, "backend");
  fs.mkdirSync(coord, { recursive: true });
  fs.mkdirSync(backend, { recursive: true });
  const sourceCoord = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    const source = path.join(sourceCoord, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(coord, name), {
      recursive: true,
      filter: (entry) => !/\.test\.js$/.test(entry) && !path.relative(source, entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)),
    });
  }
  installCanonicalEngine(coord, sourceCoord, (entry) => !/\.test\.js$/.test(entry) && !path.relative(path.join(sourceCoord, "engine"), entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)));

  const ticket = "MSRV-858";
  const owner = "codexa858";
  const reviewer = "claudea99";
  const branch = `agent/${owner}-${ticket.toLowerCase()}-coord858`;
  const worktree = path.join(backend, ".worktrees", owner, ticket);
  const cliPath = path.join(coord, "scripts", "governance.js");
  const configPath = path.join(coord, "project.config.js");
  const baseEnv = gitFixtureEnv({ COORD_PROJECT_CONFIG: configPath }); // COORD-952: isolated host git config
  const ghBin = path.join(root, "bin");
  const ghConfigPath = path.join(root, "fake-gh.json");
  const ghLogPath = path.join(root, "fake-gh.log");
  const prUrl = "https://github.com/acme/backend/pull/858";
  if (options.prOrigin) {
    fs.mkdirSync(ghBin, { recursive: true });
    fs.writeFileSync(path.join(ghBin, "gh"), FAKE_GH_SOURCE, { mode: 0o755 });
    baseEnv.PATH = `${ghBin}${path.delimiter}${process.env.PATH || ""}`;
    baseEnv.FAKE_GH_CONFIG = ghConfigPath;
  }
  for (const key of ["COORD_SESSION_ID", "COORD_PROVIDER_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID"]) delete baseEnv[key];
  const ownerEnv = { ...baseEnv, CLAUDE_SESSION_ID: "coord858-owner-thread" };
  const reviewerEnv = { ...baseEnv, CLAUDE_SESSION_ID: "coord858-reviewer-thread" };
  const run = (cwd, command, args, env = baseEnv) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 45000 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const git = (cwd, ...args) => {
    const result = run(cwd, "git", ["-C", cwd, ...args]);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
    return String(result.stdout || "").trim();
  };
  const cli = (env, ...args) => run(root, process.execPath, [cliPath, ...args], env);
  const ok = (env, ...args) => {
    const result = cli(env, ...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  git(backend, "init", "-b", "dev");
  git(backend, "config", "user.email", "coord858@example.test");
  git(backend, "config", "user.name", "COORD-858 fixture");
  git(backend, "config", "maintenance.autoDetach", "false");
  fs.writeFileSync(path.join(backend, "seed.txt"), "submission fixture\n");
  git(backend, "add", "seed.txt");
  git(backend, "commit", "-m", "seed COORD-858 isolated repo");
  git(backend, "worktree", "add", "-b", branch, worktree, "dev");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "submission.txt"), "initial submitted source\n");
  git(worktree, "add", "src/submission.txt");
  git(worktree, "commit", "-m", "initial submitted source");
  const initialHead = git(worktree, "rev-parse", "HEAD");
  // COORD-921: a bare origin holds the ticket branch at the PR's head (initialHead).
  const originDir = path.join(root, "origin.git");
  if (options.prOrigin) {
    gitFixture(root, ["init", "-q", "--bare", originDir]);
    git(backend, "remote", "add", "origin", originDir);
    git(backend, "push", "-q", "origin", "dev");
    git(worktree, "push", "-q", "-u", "origin", branch);
    fs.writeFileSync(ghConfigPath, `${JSON.stringify({ log: ghLogPath, origin: originDir, branch, url: prUrl, number: 858, headOid: options.prHeadOid || null })}\n`);
  }

  const row = { ID: ticket, Repo: "B", Type: "bug", Pri: "P1", Status: "doing", Owner: owner, Description: "COORD-858 submitted scope regression", "Depends On": "" };
  writeJson(path.join(coord, "board", "tasks.json"), {
    version: 1,
    metadata: { title: "COORD-858 isolated submission fixture", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: { B: "MSRV-999" }, landing_index_required_from_ticket: { B: "MSRV-999" }, pr_index_required_from_ticket: { B: "MSRV-999" }, feature_proof_required_from_ticket: { B: "MSRV-999" } },
    sections: [{ kind: "table", level: 2, heading: "COORD-858", separator_before: false, columns: Object.keys(row), rows: [row] }],
    prompt_index: { [ticket]: "coord/prompts/tickets/MSRV-858.md" }, pr_index: options.prOrigin ? { [ticket]: [prUrl] } : {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  });
  fs.mkdirSync(path.join(coord, "prompts", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(coord, "prompts", "tickets", "MSRV-858.md"), "# MSRV-858\n\n## Acceptance Criteria\n\n- Keep submitted review scope immutable.\n");
  fs.writeFileSync(path.join(coord, "PLAN.md"), "");
  fs.writeFileSync(path.join(coord, "QUESTIONS.md"), "# Questions\n");
  fs.mkdirSync(path.join(coord, ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(coord, ".runtime", "plans"), { recursive: true });
  writeJson(path.join(coord, ".runtime", "agents.json"), [owner, reviewer].map((handle, index) => ({ id: `a${858 + index}`, handle, provider: "anthropic", status: "active", aliases: [], lane: "backend", default_repo: "B", created_at: new Date().toISOString() })));
  writeJson(path.join(coord, ".runtime", "agent_sessions.json"), []);
  const now = new Date().toISOString();
  writeJson(path.join(coord, ".runtime", "locks", `${ticket}.lock`), { agent_id: "a858", owner, ticket, status: "doing", repo: "backend", branch, head: initialHead, worktree, started_at_utc: now, heartbeat_utc: now });

  const evalCode = (code) => {
    const result = run(root, process.execPath, ["-e", code], baseEnv);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
  };
  evalCode(`require(${JSON.stringify(cliPath)}).__testing.ensureGovernanceJournalBaseline("COORD-858 isolated fixture");`);
  ok(ownerEnv, "agentid", "--owner", owner);
  ok(ownerEnv, "plan", ticket, "--seed");
  const planPath = path.join(coord, ".runtime", "plans", `${ticket}.json`);
  const cycles = ["contract/state invariants", "auth/security/failure modes", "tests/operability/performance", "requirement closure"];
  const cycleLine = (lens) => `lens=${lens}; diff=reviewed source transition; risks=repo mismatch, plan write failure; findings=none; verification=node --test coord/scripts/ticket-transitions.test.js; verdict=pass`;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  Object.assign(plan, {
    startup_checklist: ["verified startup"], traceability_gate: ["exempt"], baseline_reproduction: ["not-required"],
    intended_files: ["backend/src/submission.txt"], change_summary: ["Persist exact submitted source."],
    verification_commands: ["node --test coord/scripts/ticket-transitions.test.js"],
    critical_invariants: ["Submitted scope matches the exact Git commit.", "Reviews of older heads remain history."],
    requirement_closure: ["Ticket ask: persist review scope", "Implemented: immutable source pair", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [], repo_gates: ["node --test coord/scripts/ticket-transitions.test.js — passed"], rollback_strategy: ["Restore plan and board snapshot."],
    self_review_cycles: cycles.map((lens, index) => ({ cycle: index + 1, total: 4, lens, diff: "reviewed source transition", risks: ["repo mismatch", "plan write failure"], findings: "none", verification: "node --test coord/scripts/ticket-transitions.test.js", verdict: "pass", raw: cycleLine(lens) })),
  });
  writeJson(planPath, plan);
  evalCode(`const g=require(${JSON.stringify(cliPath)}).__testing;const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},"utf8"));g.writePlanCompatibilityBlockFromRecord(${JSON.stringify(ticket)},p);g.advanceGovernanceProvenanceBaseline("COORD-858 fixture plan ready");`);
  ok(reviewerEnv, "agentid", "--owner", reviewer);

  return { root, coord, worktree, backend, branch, ticket, owner, initialHead, planPath, baseEnv, ownerEnv, reviewerEnv, ok, git, run, cycleLine, cycles, originDir, ghLogPath, prUrl, lockPath: path.join(coord, ".runtime", "locks", `${ticket}.lock`), boardPath: path.join(coord, "board", "tasks.json") };
}

test("COORD-858: CLI move-review pins and resubmits Git scope while retaining stale reviews as history", async () => {
  const fixture = createIsolatedReviewSubmissionFixture();
  const { root, coord, worktree, ticket, initialHead, planPath, ownerEnv, reviewerEnv, ok, git, run, cycleLine, cycles } = fixture;
  const lockPath = path.join(coord, ".runtime", "locks", `${ticket}.lock`);
  const boardPath = path.join(coord, "board", "tasks.json");
  try {
    const recordReview = ok(reviewerEnv, "record-independent-review", ticket, "--commit", initialHead,
      "--method", "code review: submitted scope retention", "--verdict", "pass");
    const reviewedEntry = JSON.parse(recordReview.stdout).review;
    assert.equal(reviewedEntry.repository, "backend");
    assert.equal(reviewedEntry.commit, initialHead);
    const reviewedEntryBytes = JSON.stringify(reviewedEntry);

    const submitArgs = ["move-review", ticket, "--pr", "local-review (no PR)"];
    assert.equal(fs.existsSync(lockPath), true, "the fixture starts with the owner's real ticket lock file");
    ok(ownerEnv, ...submitArgs);
    let stored = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(stored.review_submission, { repository: "backend", commit: initialHead });
    const submittedBoard = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(submittedBoard.sections[0].rows[0].Status, "review");
    assert.deepEqual(submittedBoard.pr_index[ticket], ["local-review (no PR)"]);
    assert.equal(fs.existsSync(lockPath), false, "successful submission removes the existing lock file after persisting scope and review state");
    const explained = ok(ownerEnv, "explain", ticket);
    let reviewReadiness = JSON.parse(explained.stdout).governance_readiness.independent_reviews;
    assert.equal(reviewReadiness.counts.current, 1, "the first submitted head keeps its independent review current");
    assert.equal(reviewReadiness.current[0].id, reviewedEntry.id);

    const submittedPlanBytes = fs.readFileSync(planPath, "utf8");
    const journalPath = path.join(coord, ".runtime", "governance-events.ndjson");
    const eventCount = fs.readFileSync(journalPath, "utf8").trim().split("\n").length;
    ok(ownerEnv, ...submitArgs);
    assert.equal(fs.readFileSync(planPath, "utf8"), submittedPlanBytes, "identical first-submission retry preserves the plan bytes");
    assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, eventCount, "identical retry does not append a journal event");

    fs.writeFileSync(path.join(worktree, "src", "submission.txt"), "resubmitted source\n");
    git(worktree, "add", "src/submission.txt");
    git(worktree, "commit", "-m", "new submitted source head");
    const newHead = git(worktree, "rev-parse", "HEAD");
    assert.notEqual(newHead, initialHead);
    ok(ownerEnv, "return-doing", ticket, "--summary", "addressed review feedback", "--severity", "HIGH", "--qref", "L1");
    ok(ownerEnv, "set-review-cycles", ticket, "--replace", ...cycles.flatMap((lens) => ["--review-cycle", cycleLine(lens)]));
    ok(ownerEnv, "update-finding", ticket, "--id", `${ticket}-F1`, "--status", "resolved");
    ok(ownerEnv, ...submitArgs);
    stored = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.deepEqual(stored.review_submission, { repository: "backend", commit: newHead });
    assert.equal(JSON.stringify(stored.independent_reviews[0]), reviewedEntryBytes,
      "resubmission retains the original immutable review entry byte-for-byte");

    const afterResubmissionExplain = ok(ownerEnv, "explain", ticket);
    reviewReadiness = JSON.parse(afterResubmissionExplain.stdout).governance_readiness.independent_reviews;
    assert.equal(reviewReadiness.counts.current, 0);
    assert.equal(reviewReadiness.counts.historical, 1);
    assert.equal(reviewReadiness.historical[0].id, reviewedEntry.id);
    const exportResult = run(root, process.execPath, [path.join(coord, "engine/scripts/evidence-export.mjs"), "--ticket", ticket, "--framework", "all", "--format", "json", "--coord-dir", coord], fixture.baseEnv);
    assert.ok([0, 3].includes(exportResult.status), `${exportResult.stdout}\n${exportResult.stderr}`);
    const exportedReviews = JSON.parse(exportResult.stdout).tickets[0].independent_reviews;
    assert.equal(exportedReviews.counts.current, 0);
    assert.equal(exportedReviews.counts.historical, 1);
    assert.equal(exportedReviews.historical[0].id, reviewedEntry.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("COORD-858: CLI rollback restores plan JSON, PLAN block, board, lock and journal after later write failure", () => {
  const ticketId = "B-858";
  const owner = "codexa858";
  const ctx = setupCoord003Workspace("coord858-rollback-", ticketId, owner, { withCommit: true });
  const planPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
  const journalPath = path.join(ctx.coordRoot, ".runtime", "governance-events.ndjson");
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const lenses = ["contract/state invariants", "auth/security/failure modes", "tests/operability/performance", "requirement closure"];
    Object.assign(plan, {
      startup_checklist: ["verified startup"], traceability_gate: ["exempt"], baseline_reproduction: ["not-required"],
      intended_files: ["backend/src/coord003.txt"], change_summary: ["Persist exact submitted source."],
      verification_commands: ["node --test coord/scripts/ticket-transitions.test.js"],
      critical_invariants: ["Submitted scope matches the exact Git commit.", "Older review scope stays historical."],
      requirement_closure: ["Ticket ask: persist review scope", "Implemented: immutable source pair", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      feature_proof: [], repo_gates: ["not-required: isolated lifecycle regression"], rollback_strategy: ["Restore exact governed snapshot."],
      self_review_cycles: lenses.map((lens, index) => ({ cycle: index + 1, total: 4, lens, diff: "reviewed source transition",
        risks: ["repo mismatch", "plan write failure"], findings: "none", verification: "node --test coord/scripts/ticket-transitions.test.js",
        verdict: "pass", raw: `lens=${lens}; diff=reviewed source transition; risks=repo mismatch, plan write failure; findings=none; verification=node --test coord/scripts/ticket-transitions.test.js; verdict=pass` })),
    });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("COORD-858 rollback fixture seed");
    const planBefore = fs.readFileSync(planPath);
    const compatBefore = fs.readFileSync(state.PLAN_PATH);
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const lockBefore = fs.readFileSync(ctx.lockPath);
    const eventsBefore = fs.readFileSync(journalPath, "utf8").trim().split("\n").length;
    const submittedHead = require("node:child_process").spawnSync("git", ["-C", ctx.worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const originalRename = fs.renameSync;
    let failedBoardReplacement = false;
    fs.renameSync = function (source, target) {
      if (!failedBoardReplacement && path.resolve(String(target)) === path.resolve(ctx.boardPath)) {
        failedBoardReplacement = true;
        assert.deepEqual(JSON.parse(fs.readFileSync(planPath, "utf8")).review_submission, {
          repository: "backend", commit: submittedHead,
        });
        assert.match(fs.readFileSync(state.PLAN_PATH, "utf8"), /Review submission:[\s\S]*[0-9a-f]{40}/);
        throw new Error("injected board write failure after submission persistence");
      }
      return originalRename.call(this, source, target);
    };
    try {
      assert.throws(() => executeCommand(["move-review", ticketId, "--pr", "local-review (no PR)"]), /injected board write failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(failedBoardReplacement, true, "failure was injected after the plan JSON and compatibility writes");
    assert.deepEqual(fs.readFileSync(planPath), planBefore);
    assert.deepEqual(fs.readFileSync(state.PLAN_PATH), compatBefore);
    assert.deepEqual(fs.readFileSync(ctx.boardPath), boardBefore);
    assert.deepEqual(fs.readFileSync(ctx.lockPath), lockBefore);
    assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, eventsBefore,
      "a failed transition has no succeeded journal event");
  } finally {
    ctx.restore();
  }
});


test("COORD-825: ticket transitions use the imported defaultFail in a valid factory", () => {
  let identityReads = 0;
  const { transitions, calls } = buildCoord697SubmitHarness({
    getTicketRef: () => null,
    withBoardTransaction: (_mutation, run) => run({ board: {} }),
    ensureCurrentAgentIdentity: (options) => {
      assert.deepEqual(options, { allowAutoClaim: false, touchSession: false });
      identityReads += 1;
      return { agent: { handle: "codexa680" } };
    },
  });
  assert.throws(() => transitions.approveTicket(), /approve requires <ticket-id>/);
  assert.throws(() => transitions.rejectTicket(), /reject requires <ticket-id>/);
  assert.equal(identityReads, 0);
  assert.throws(() => transitions.approveTicket("B-404"), /Unknown ticket "B-404"/);
  assert.throws(() => transitions.rejectTicket("B-404", { reason: "duplicate proposal" }), /Unknown ticket "B-404"/);
  assert.equal(identityReads, 2);
  assert.deepEqual(calls, []);

  // Keep the dependency contract valid while omitting only the optional fail
  // override. The factory must retain its imported typed GovernanceError path.
  const harness = buildCoord697SubmitHarness({ fail: undefined });
  assert.throws(
    () => harness.transitions.moveReview("", {}),
    (error) => error instanceof GovernanceError && /move-review requires <ticket-id>/.test(error.message),
  );
  assert.deepEqual(harness.calls, [], "defaultFail refuses before invoking any mutation collaborator");
});

// COORD-921: re-submitting a ticket whose pr_index already holds its PR must push
// the lock head to the PR head branch and verify the PR head equals the submitted
// commit before move-review. Gate T (acme, 2026-11-06): the ticket committed B,
// re-submitted, moved to review, and PR #101 stayed at A with no push.
function originHead(fixture) {
  const result = fixture.run(fixture.root, "git", ["--git-dir", fixture.originDir, "rev-parse", "--verify", "-q", `refs/heads/${fixture.branch}`]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitResubmittedSource(fixture, text) {
  fs.writeFileSync(path.join(fixture.worktree, "src", "submission.txt"), text);
  fixture.git(fixture.worktree, "commit", "-am", "new submitted source head");
  const head = fixture.git(fixture.worktree, "rev-parse", "HEAD");
  // `gov commit` records the new head in the ticket lock; mirror that here.
  const lock = JSON.parse(fs.readFileSync(fixture.lockPath, "utf8"));
  fs.writeFileSync(fixture.lockPath, `${JSON.stringify({ ...lock, head }, null, 2)}\n`);
  return head;
}

test("COORD-921: re-submit with an existing PR pushes the lock head and records the verified PR head", () => {
  const fixture = createIsolatedReviewSubmissionFixture({ prOrigin: true });
  try {
    const submittedHead = commitResubmittedSource(fixture, "resubmitted source\n");
    assert.notEqual(submittedHead, fixture.initialHead);
    fixture.ok(fixture.ownerEnv, "submit", fixture.ticket);

    assert.equal(originHead(fixture), submittedHead, "the PR head branch must carry the submitted commit before move-review");
    const board = JSON.parse(fs.readFileSync(fixture.boardPath, "utf8"));
    assert.equal(board.sections[0].rows[0].Status, "review");
    assert.deepEqual(board.pr_index[fixture.ticket], [fixture.prUrl]);
    const stored = JSON.parse(fs.readFileSync(fixture.planPath, "utf8"));
    assert.deepEqual(stored.review_submission, { repository: "backend", commit: submittedHead });
    const journal = fs.readFileSync(path.join(fixture.coord, ".runtime", "governance-events.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const submitted = journal.find((event) => event.command === "move-review" && event.ticket === fixture.ticket);
    assert.ok(submitted, "the review submission is journaled");
    assert.deepEqual(submitted.details.verified_pr_head, { url: fixture.prUrl, head_ref_name: fixture.branch, head_sha: submittedHead },
      "the journaled submission record cites the verified PR head");
    const ghCalls = fs.readFileSync(fixture.ghLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ghCalls.some((args) => args[0] === "pr" && args[1] === "create"), false, "an existing PR is reused, never re-created");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("COORD-921: re-submit stays in doing when the PR head does not verify after the push", () => {
  const fixture = createIsolatedReviewSubmissionFixture({ prOrigin: true, prHeadOid: "f".repeat(40) });
  try {
    commitResubmittedSource(fixture, "resubmitted source\n");
    const failed = fixture.run(fixture.root, process.execPath, [path.join(fixture.coord, "scripts", "governance.js"), "submit", fixture.ticket], fixture.ownerEnv);
    assert.notEqual(failed.status, 0, "a PR head that does not equal the submitted commit must refuse the submission");
    assert.match(`${failed.stdout}${failed.stderr}`, /does not equal submitted commit/);
    const board = JSON.parse(fs.readFileSync(fixture.boardPath, "utf8"));
    assert.equal(board.sections[0].rows[0].Status, "doing", "the ticket stays doing");
    const stored = JSON.parse(fs.readFileSync(fixture.planPath, "utf8"));
    assert.equal(stored.review_submission, undefined, "nothing is journaled as submitted");
    assert.equal(fs.existsSync(fixture.lockPath), true, "the lock survives the refused submission");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("COORD-921: explicit submit --pr with a PR head that does not verify keeps the ticket doing", () => {
  const fixture = createIsolatedReviewSubmissionFixture({ prOrigin: true, prHeadOid: "e".repeat(40) });
  try {
    commitResubmittedSource(fixture, "explicit source\n");
    const refused = fixture.run(fixture.root, process.execPath, [path.join(fixture.coord, "scripts", "governance.js"), "submit", fixture.ticket, "--pr", fixture.prUrl], fixture.ownerEnv);
    assert.notEqual(refused.status, 0, "an explicit PR whose head does not verify must refuse the submission");
    assert.match(`${refused.stdout}${refused.stderr}`, /does not equal submitted commit/);
    const board = JSON.parse(fs.readFileSync(fixture.boardPath, "utf8"));
    assert.equal(board.sections[0].rows[0].Status, "doing", "the ticket stays doing");
    const stored = JSON.parse(fs.readFileSync(fixture.planPath, "utf8"));
    assert.equal(stored.review_submission, undefined, "nothing is journaled as submitted");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
// Use landing-gh's supported transport seam: ghPrView remains real, while
// no provider process is spawned and every requested URL is recorded.
function withTransitionFixtureGh(responses, run) {
  const landingGh = require("./landing-gh.js");
  const calls = [];
  landingGh.setRunGhForTesting((_cwd, args) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    calls.push(args);
    assert.ok(calls.length <= responses.length, "unexpected extra PR read");
    return JSON.stringify(responses[calls.length - 1]);
  });
  try { return run(() => calls); }
  finally { landingGh.resetRunGhForTesting(); }
}

test("COORD-1052: existing PR submission verifies branch and exact head before recording review", () => {
  const url = "https://github.com/acme/repo/pull/697";
  const branch = "agent/codexa680-b-697";
  const head = "a".repeat(40);
  for (const repo of ["B", "X"]) {
    for (const explicit of [false, true]) {
      withTransitionFixtureGh([
        { state: "OPEN", headRefName: branch, headRefOid: head },
        { state: "OPEN", headRefName: branch, headRefOid: head },
      ], (readCalls) => {
      const pushes = [];
      let mutation;
      const harness = buildCoord697SubmitHarness({
        prCreate: (ticket, options) => pushes.push({ ticket, options }),
        resolveLifecyclePrRefs: (_ticket, _row, board, options) => options.pr || board.pr_index["B-697"] || [],
        withGovernanceMutation: (value, run) => { mutation = value; return run(); },
      });
      harness.row.Repo = repo;
      if (!explicit) harness.board.pr_index["B-697"] = [url];
      harness.transitions.submitTicket("B-697", explicit ? { pr: [url] } : {});
      assert.equal(harness.row.Status, "review");
      assert.deepEqual(readCalls().map((args) => args[2]), [url, url]);
      assert.equal(pushes.length, repo === "X" ? 0 : 1);
      if (pushes.length) {
        assert.equal(pushes[0].ticket, "B-697");
        assert.equal(pushes[0].options.requireExistingPr, true);
        assert.equal(pushes[0].options.push, true);
        assert.equal(pushes[0].options.fill, true);
      }
      assert.deepEqual(mutation.details.verified_pr_head, { url, head_ref_name: branch, head_sha: head });
      assert.deepEqual(mutation.details.workspace_evidence, {
        branch, worktree: "/tmp/coord697", head, pr_url: url, pr_head_ref: branch,
      });
      assert.deepEqual(harness.board.pr_index["B-697"], [url]);
      });
    }
  }

  let mutation;
  const { transitions } = buildCoord697SubmitHarness({
    resolveLifecyclePrRefs: () => [url],
    withGovernanceMutation: (value, run) => { mutation = value; return run(); },
  });
  transitions.moveReview("B-697", { pr: [url] });
  assert.deepEqual(mutation.details.workspace_evidence, {
    branch, worktree: "/tmp/coord697", head, pr_url: null, pr_head_ref: null,
  });
  assert.equal(mutation.details.verified_pr_head, undefined);
});

test("COORD-1052: PR resubmission refusals preserve doing state and avoid review writes", () => {
  const url = "https://github.com/acme/repo/pull/697";
  const valid = { state: "OPEN", headRefName: "agent/codexa680-b-697", headRefOid: "a".repeat(40) };
  for (const scenario of [
    { before: null, error: /unknown, not OPEN/, pushes: 0 },
    { before: { ...valid, state: "CLOSED" }, error: /CLOSED, not OPEN/, pushes: 0 },
    { before: { ...valid, headRefName: "other" }, error: /not the ticket branch/, pushes: 0 },
    { before: valid, after: null, error: /head unknown does not equal submitted commit/, pushes: 1 },
    { before: valid, after: { ...valid, headRefOid: "b".repeat(40) }, error: /push did not publish/, pushes: 1 },
    { repo: "X", before: valid, after: null, error: /push .* and re-submit/, pushes: 0 },
  ]) {
    withTransitionFixtureGh([scenario.before, scenario.after], (readCalls) => {
    let pushes = 0;
    let submissions = 0;
    const harness = buildCoord697SubmitHarness({
      prCreate: () => { pushes += 1; },
      persistReviewSubmission: () => { submissions += 1; },
    });
    harness.row.Repo = scenario.repo || "B";
    harness.board.pr_index["B-697"] = [url];
    assert.throws(() => harness.transitions.submitTicket("B-697", {}), scenario.error);
    assert.equal(harness.row.Status, "doing");
    assert.equal(pushes, scenario.pushes);
    assert.ok(readCalls().length >= 1);
    assert.equal(submissions, 0);
    assert.equal(harness.calls.includes("board-write"), false);
    assert.equal(harness.calls.includes("board-sync"), false);
    assert.deepEqual(harness.board.pr_index["B-697"], [url]);
    });
  }
});
