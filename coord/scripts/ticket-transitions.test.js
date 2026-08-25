// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const createTicketTransitions = require("./ticket-transitions.js");

const {
  GovernanceError,
  __testing,
  executeCommand,
  setupCoord003Workspace,
  readBoardRow,
} = require("./governance-test-utils.js");

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
    formatTransitiveBlockerDetails: () => "",
    formatDependencyCycleList: () => "",
    assertReviewPlanReady: () => calls.push("review-plan"),
    assertCommittedReviewState: () => calls.push("committed-state"),
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
  const ctx = setupCoord003Workspace("ebmr-coord003-block-roundtrip-", ticketId, owner);
  try {
    __testing.blockTicket(ticketId, { reason: "waiting on upstream API" });
    let row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "doing (blocked: waiting on upstream API)");
    // Lock keeps status:"doing" — consistent with isDoingStatus, no drift.
    const lock = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    assert.equal(lock.status, "doing");

    __testing.unblockTicket(ticketId, {});
    row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 3: block requires --reason", () => {
  const ticketId = "MSRV-311";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-block-noreason-", ticketId, owner);
  try {
    assert.throws(
      () => __testing.blockTicket(ticketId, {}),
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
  const ctx = setupCoord003Workspace("ebmr-coord003-block-illegal-", ticketId, owner, { ticketStatus: "todo" });
  try {
    assert.throws(
      () => __testing.blockTicket(ticketId, { reason: "x" }),
      (error) => error instanceof GovernanceError && /must be plain "doing"/.test(error.message)
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-003 Fix 3: unblock rejects a ticket that is not blocked", () => {
  const ticketId = "MSRV-313";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord003-unblock-illegal-", ticketId, owner);
  try {
    assert.throws(
      () => __testing.unblockTicket(ticketId, {}),
      (error) => error instanceof GovernanceError && /must be "doing \(blocked: \.\.\.\)"/.test(error.message)
    );
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
  } finally {
    ctx.restore();
  }
});

test("COORD-065: supersede records inline provenance (Supersede Reason + Superseded By) on the board row", () => {
  const ticketId = "MSRV-314";
  const owner = "claudea0000";
  const ctx = setupCoord003Workspace("ebmr-coord065-supersede-provenance-", ticketId, owner);
  try {
    __testing.supersedeTicket(ticketId, {
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
  const ctx = setupCoord003Workspace("ebmr-coord065-supersede-noreason-", ticketId, owner);
  try {
    __testing.supersedeTicket(ticketId, {});
    const row = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(row.Status, "superseded");
    assert.ok(!("Superseded By" in row), "no replacement pointer when none provided");
    assert.ok(!("Supersede Reason" in row), "no reason field when none provided");
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

test("COORD-692 RED: return-doing permits a declared closeout-blocker pair the same owner already holds", () => {
  const { ctx, childId, parentId } = setupCloseoutBlockerPair("ebmr-coord692-permitted-");
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

test("COORD-692: an unrelated same-owner pair still refuses — the WIP limit is not relaxed", () => {
  const { ctx, childId, parentId } = setupCloseoutBlockerPair("ebmr-coord692-unrelated-", {
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
    assert.equal(result.ok, false, "without the recorded exception return-doing must refuse");
    assert.match(
      result.error,
      new RegExp(`already has an active doing ticket: ${parentId}`),
      "the unrelated-pair refusal message must remain unchanged",
    );
    assert.equal(
      readBoardRow(ctx.boardPath, childId).Status,
      "review",
      "a refused return-doing must leave the ticket in review",
    );
  } finally {
    ctx.restore();
  }
});
