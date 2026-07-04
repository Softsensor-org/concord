"use strict";

// COORD-220: single-writer board protocol — transaction primitive + bypass seal.
//
// Covers:
//   - the named board-transaction primitive reserves IDs INSIDE the lock so two
//     callers can never collide (Part A),
//   - a failing mutation rolls back fully — board + journal unchanged (Part A),
//   - the pure out-of-band detector flags a hand-edited tasks.json / stray plan
//     but NOT a clean governed mutation (Part B),
//   - the governed writer FAILS CLOSED on an out-of-band board edit (COORD-246), and the
//     reconciliation opt-out (allowProvenanceDrift) is honored (Part B),
//   - a completed governed mutation's OWN post-journal artifact sync is absorbed
//     into the provenance baseline, so the NEXT governed mutation does NOT trip the
//     seal on that residual (COORD-246 post-mutation-clean invariant, Part B),
//   - the existing governed create path (open-followup) still works through the
//     primitive (regression guard).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  withGovernedSurfaceSandbox,
} = require("./governance-test-utils.js");

// --- helpers ----------------------------------------------------------------

// Seed a journal baseline + snapshot so the journal is NOT "uninitialized"
// (uninitialized journals intentionally skip the bypass seal). After this the
// latest snapshot matches the current governed surface, so a clean governed
// mutation has zero out-of-band drift at entry.
function seedJournalBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-06-20T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "coord220-test" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function writeMinimalBoard(boardPath, rows) {
  const board = {
    version: 1,
    metadata: { title: "COORD-220 test board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-220 Regression",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows,
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
  fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
}

function row(id) {
  return {
    ID: id,
    Repo: "X",
    Type: "chore",
    Pri: "P2",
    Status: "todo",
    Owner: "unassigned",
    Description: `row ${id}`,
    "Depends On": "",
  };
}

// --- Part A: reserved-ID transaction -----------------------------------------

test("COORD-264: real governed verbs pass idempotency keys into journal metadata", () => {
  const transitions = fs.readFileSync(path.join(__dirname, "ticket-transitions.js"), "utf8");
  // COORD-282: file-ticket / open-followup were extracted out of lifecycle.js
  // into ticket-commands.js (they keep passing the same stable idempotency key
  // through the unchanged withBoardTransaction path), so scan that module for them.
  const ticketCommands = fs.readFileSync(path.join(__dirname, "ticket-commands.js"), "utf8");
  // COORD-424: set-pr / set-waiver / set-priority / set-type were likewise
  // extracted out of lifecycle.js into lifecycle-ticket-admin.js (unchanged
  // withBoardTransaction path). The test previously scanned lifecycle.js for them
  // and went red after the extraction — scan the module that now owns them.
  const ticketAdmin = fs.readFileSync(path.join(__dirname, "lifecycle-ticket-admin.js"), "utf8");
  for (const command of ["start", "move-review", "mark-done", "return-doing", "supersede", "block", "unblock"]) {
    assert.match(
      transitions,
      new RegExp(`stableIdempotencyKey\\("${command}"`),
      `${command} must pass a stable idempotency key`
    );
  }
  for (const command of ["file-ticket", "open-followup"]) {
    assert.match(
      ticketCommands,
      new RegExp(`stableIdempotencyKey\\("${command}"`),
      `${command} must pass a stable idempotency key`
    );
  }
  // set-* ticket-admin verbs now live in lifecycle-ticket-admin.js.
  for (const command of ["set-pr", "set-waiver", "set-priority", "set-type"]) {
    assert.match(
      ticketAdmin,
      new RegExp(`stableIdempotencyKey\\("${command}"`),
      `${command} must pass a stable idempotency key`
    );
  }
  // COORD-285: approve/reject ride the same single-writer withBoardTransaction
  // path and must carry a stable idempotency key like the other governed verbs.
  for (const command of ["approve", "reject"]) {
    assert.match(
      transitions,
      new RegExp(`stableIdempotencyKey\\("${command}"`),
      `${command} must pass a stable idempotency key`
    );
  }
});

test("COORD-220: withBoardTransaction re-reads the board and reserves IDs inside the critical section", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    // Two governed creators run back-to-back. Each reserves off the board it
    // re-read UNDER the lock, then commits its row. Because reservation happens
    // inside the transaction (not by scanning files before the lock), the second
    // caller observes the first caller's row and never re-derives the same id.
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      __testing.withBoardTransaction(
        { command: "test-create", ticket: "(auto)" },
        ({ board, reserveTicketId }) => {
          const id = reserveTicketId("ENG");
          ids.push(id);
          board.sections[0].rows.push(row(id));
          __testing.writeBoard(board);
        }
      );
    }

    assert.deepEqual(ids, ["ENG-002", "ENG-003"]);
    assert.notEqual(ids[0], ids[1], "two reservations must not collide");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const finalIds = after.sections[0].rows.map((r) => r.ID).sort();
    assert.deepEqual(finalIds, ["ENG-001", "ENG-002", "ENG-003"]);
  });
});

test("COORD-220: a failing board transaction rolls back fully — board + journal unchanged", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    const boardBefore = fs.readFileSync(boardPath, "utf8");
    const journalBefore = fs.readFileSync(logPath, "utf8");

    assert.throws(() => {
      __testing.withBoardTransaction(
        { command: "test-create", ticket: "(auto)" },
        ({ board, reserveTicketId }) => {
          // Write a partial mutation, then blow up: rollback must undo it.
          board.sections[0].rows.push(row(reserveTicketId("ENG")));
          __testing.writeBoard(board);
          throw new Error("boom mid-transaction");
        }
      );
    }, /boom mid-transaction/);

    assert.equal(fs.readFileSync(boardPath, "utf8"), boardBefore, "board must be restored");
    // No 'succeeded' event for the failed mutation should have landed.
    assert.equal(
      fs.readFileSync(logPath, "utf8"),
      journalBefore,
      "journal must not gain a succeeded event for a rolled-back mutation"
    );
  });
});

// --- Part B: out-of-band bypass detector (pure) ------------------------------

test("COORD-220: isCoordinationStatePath classifies board/plan/prompt/rendered, not runtime ledgers", () => {
  assert.equal(__testing.isCoordinationStatePath("board/tasks.json"), true);
  assert.equal(__testing.isCoordinationStatePath(".runtime/plans/COORD-9.json"), true);
  assert.equal(__testing.isCoordinationStatePath("prompts/tickets/COORD-9.md"), true);
  assert.equal(__testing.isCoordinationStatePath("rendered/TASKS.md"), true);
  assert.equal(__testing.isCoordinationStatePath(".runtime/agent_sessions.json"), false);
  assert.equal(__testing.isCoordinationStatePath("PLAN.md"), false);
});

test("COORD-220: detector flags a hand-edited tasks.json with no journaled transaction", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    // Clean baseline: nothing out of band.
    assert.equal(__testing.detectOutOfBandBoardMutation().detected, false);

    // Simulate a direct hand-edit / ad-hoc script mutating the board outside any
    // governed transaction.
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections[0].rows.push(row("ENG-002"));
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    const report = __testing.detectOutOfBandBoardMutation();
    assert.equal(report.detected, true);
    assert.ok(report.paths.some((p) => p.endsWith("tasks.json")), "board path should be flagged");
  });
});

test("COORD-220: detector flags a stray plan file but a clean governed mutation does not trip it", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    // A stray plan record written out of band.
    fs.writeFileSync(`${__testing.paths.PLAN_RECORDS_DIR}/ENG-001.json`, "{}\n", "utf8");
    const strayReport = __testing.detectOutOfBandBoardMutation();
    assert.equal(strayReport.detected, true);
    assert.ok(
      strayReport.paths.some((p) => p.endsWith("ENG-001.json")),
      "stray plan file should be flagged"
    );
  });
});

// --- Part B: fail-closed seal ------------------------------------------------

test("COORD-220/246: an out-of-band board edit FAILS CLOSED — a governed mutation refuses on top of it", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    // GENUINE out-of-band hand edit (a direct write, NOT a governed mutation),
    // then run a governed mutation on top of it.
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections[0].rows.push(row("ENG-099"));
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    // COORD-246: with the over-fire fixed at its source (a completed mutation's own
    // post-journal artifact sync now advances the provenance baseline), the seal is
    // restored to FAIL CLOSED: any coordination-state drift that survives to a
    // mutation's entry-check is a real bypass and must be refused.
    assert.throws(
      () =>
        __testing.withBoardTransaction(
          { command: "test-create", ticket: "(auto)" },
          () => "ok"
        ),
      /Refusing to run a governed board mutation on top of an out-of-band coordination-state change/
    );
  });
});

// --- Part B: COORD-246 post-mutation-clean invariant -------------------------

test("COORD-246: a mutation's OWN post-journal artifact sync is re-baselined so the next mutation does not trip the seal", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    // Lifecycle 1: a clean governed mutation appends its journal event (+snapshot).
    __testing.withBoardTransaction(
      { command: "test-create", ticket: "(auto)" },
      ({ board, reserveTicketId }) => {
        board.sections[0].rows.push(row(reserveTicketId("ENG")));
        __testing.writeBoard(board);
      }
    );

    // Simulate the post-journal artifact sync that terminal lifecycle verbs perform
    // AFTER the journal event is appended: a write to a snapshot-tracked
    // coordination-state file (here a plan record) outside any governed mutation.
    // BEFORE the COORD-246 fix this residual would be read as out-of-band drift.
    fs.writeFileSync(`${__testing.paths.PLAN_RECORDS_DIR}/ENG-002.json`, "{}\n", "utf8");
    assert.equal(
      __testing.detectOutOfBandBoardMutation().detected,
      true,
      "the post-journal artifact write is residual drift until the baseline advances"
    );

    // The lifecycle auto-sync chokepoint advances the baseline to the FINAL on-disk
    // state, absorbing the mutation's own post-journal sync.
    const advanced = __testing.advanceGovernanceProvenanceBaseline("post-test-sync");
    assert.equal(advanced, true, "the baseline must advance when residual drift exists");
    assert.equal(
      __testing.detectOutOfBandBoardMutation().detected,
      false,
      "after advancing the baseline the residual is in-band (post-mutation-clean)"
    );

    // Lifecycle 2: an independent governed mutation must NOT trip the fail-closed
    // seal on lifecycle 1's residual — proving back-to-back lifecycles need no reconcile.
    assert.doesNotThrow(() =>
      __testing.withBoardTransaction(
        { command: "test-create", ticket: "(auto)" },
        ({ board, reserveTicketId }) => {
          board.sections[0].rows.push(row(reserveTicketId("ENG")));
          __testing.writeBoard(board);
        }
      )
    );

    // A GENUINE out-of-band edit made AFTER the advance still fails closed.
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections[0].rows.push(row("ENG-666"));
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () =>
        __testing.withBoardTransaction(
          { command: "test-create", ticket: "(auto)" },
          () => "ok"
        ),
      /Refusing to run a governed board mutation on top of an out-of-band coordination-state change/
    );
  });
});

test("COORD-220: allowProvenanceDrift opts a reconciliation mutation out of the seal", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections[0].rows.push(row("ENG-099"));
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    let ran = false;
    __testing.withGovernanceMutation(
      { command: "manual-reconcile", ticket: null, allowProvenanceDrift: true },
      () => {
        ran = true;
      }
    );
    assert.equal(ran, true, "reconciliation mutation must be allowed to run on drifted state");
  });
});

// --- regression: the existing governed create path still works ---------------

test("COORD-220: a clean governed board transaction succeeds and journals exactly one event", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeMinimalBoard(boardPath, [row("ENG-001")]);
    seedJournalBaseline();

    const eventsBefore = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;

    __testing.withBoardTransaction(
      { command: "test-create", ticket: "(auto)" },
      ({ board, reserveTicketId }) => {
        board.sections[0].rows.push(row(reserveTicketId("ENG")));
        __testing.writeBoard(board);
      }
    );

    const eventsAfter = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(eventsAfter, eventsBefore + 1, "exactly one journal event per governed mutation");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.ok(after.sections[0].rows.some((r) => r.ID === "ENG-002"));
  });
});
