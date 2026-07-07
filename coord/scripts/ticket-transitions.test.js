// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  GovernanceError,
  __testing,
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
