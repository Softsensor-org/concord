"use strict";

// COORD-673: `set-followup-relation` must never silently DISCARD a governed
// dependency edge.
//
// Filed reproduction (COORD-661, blocked by TWO independent P0s): calling the
// verb twice with different --depends-on values printed success both times and
// left only the LAST edge on the row. `readiness.blockedBy` is what stops a
// blocked ticket from being picked up, so a dropped edge makes governance report
// a ticket READY while a known blocker is still open.
//
// Board-contract decision proved here: `Depends On` is a COMMA-SEPARATED LIST
// (governance-validation.js splitDependsOn -> evaluateReadiness iterates every
// entry), so multiple edges per ticket are contract-legal and only the writer
// was single-valued. `followup_exceptions[<ticket>]` is by contrast a SINGLE
// {parent, type} record, so the relations that need one (related /
// closeout-blocker) still bind exactly one parent — and the verb FAILS CLOSED
// rather than overwriting an existing one.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  executeCommand,
  withRegisterPromptHarness,
  __testing,
} = require("./governance-test-utils.js");

const TICKET = "IMP-700";
const DEP_A = "IMP-245";
const DEP_B = "IMP-246";

function withFixture(prefix, body, overrides = {}) {
  return withRegisterPromptHarness(
    prefix,
    {
      ticketId: TICKET,
      status: "doing",
      extraRows: [{ ID: DEP_A }, { ID: DEP_B }],
      ...overrides,
    },
    body
  );
}

function rowOf(board, id = TICKET) {
  return board.sections[0].rows.find((row) => row.ID === id);
}

function depsOf(board, id = TICKET) {
  return String(rowOf(board, id)["Depends On"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function blockedByOf(board, id = TICKET) {
  const byId = new Map(board.sections[0].rows.map((row) => [row.ID, row]));
  return __testing.evaluateReadiness(rowOf(board, id), byId, board).blockedBy;
}

function errorTextOf(result) {
  return String(result.error || result.stderr || result.stdout || "");
}

// --- the filed defect: sequential calls must ACCUMULATE ----------------------

test("COORD-673: two sequential blocking edges accumulate — the first is not silently dropped", () => {
  withFixture("c673-accumulate-", ({ readBoard }) => {
    const first = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A, "--relation", "blocking"]);
    assert.equal(first.ok, true, `first edge should be recorded: ${errorTextOf(first)}`);
    assert.deepEqual(depsOf(readBoard()), [DEP_A]);

    const second = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_B, "--relation", "blocking"]);
    assert.equal(second.ok, true, `second edge should be recorded: ${errorTextOf(second)}`);

    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_A, DEP_B], "both governed edges must survive");
    assert.deepEqual(blockedByOf(board), [DEP_A, DEP_B], "readiness.blockedBy must reflect EVERY recorded edge");
    assert.match(String(second.stdout), new RegExp(DEP_A), "the printed result must show the full edge set");
  });
});

test("COORD-673: re-recording an edge that already exists is idempotent, not duplicated", () => {
  withFixture("c673-idempotent-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A]);
    const again = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A]);
    assert.equal(again.ok, true, `repeat should succeed: ${errorTextOf(again)}`);
    assert.deepEqual(depsOf(readBoard()), [DEP_A]);
  });
});

// --- the two unparsed input shapes -------------------------------------------

test("COORD-673: the comma form records every edge in one call", () => {
  withFixture("c673-comma-", ({ readBoard }) => {
    const result = executeCommand(["set-followup-relation", TICKET, "--depends-on", `${DEP_A},${DEP_B}`]);
    assert.equal(result.ok, true, `comma form must parse: ${errorTextOf(result)}`);
    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_A, DEP_B]);
    assert.deepEqual(blockedByOf(board), [DEP_A, DEP_B]);
  });
});

test("COORD-673: the repeated-flag form records every edge in one call", () => {
  withFixture("c673-repeated-", ({ readBoard }) => {
    const result = executeCommand([
      "set-followup-relation", TICKET,
      "--depends-on", DEP_A,
      "--depends-on", DEP_B,
    ]);
    assert.equal(result.ok, true, `repeated flag must accumulate: ${errorTextOf(result)}`);
    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_A, DEP_B]);
    assert.deepEqual(blockedByOf(board), [DEP_A, DEP_B]);
  });
});

test("COORD-673: an unknown id anywhere in the list refuses and leaves the row untouched", () => {
  withFixture("c673-unknown-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A]);
    const result = executeCommand(["set-followup-relation", TICKET, "--depends-on", `${DEP_B},IMP-999`]);
    assert.equal(result.ok, false, "an unknown dependency must be refused");
    assert.match(errorTextOf(result), /IMP-999 does not exist/);
    assert.deepEqual(depsOf(readBoard()), [DEP_A], "a refused call must not partially mutate the row");
  });
});

test("COORD-673: a self-dependency is still refused", () => {
  withFixture("c673-self-", ({ readBoard }) => {
    const result = executeCommand(["set-followup-relation", TICKET, "--depends-on", `${DEP_A},${TICKET}`]);
    assert.equal(result.ok, false, "self-dependency must be refused");
    assert.match(errorTextOf(result), /cannot depend on itself/);
    assert.deepEqual(depsOf(readBoard()), []);
  });
});

// --- fail-closed on the single-slot followup_exceptions record ----------------

test("COORD-673: replacing an existing exception parent FAILS CLOSED and names the edge and the flag", () => {
  withFixture("c673-failclosed-", ({ readBoard }) => {
    const first = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A, "--relation", "related"]);
    assert.equal(first.ok, true, `first relation should be recorded: ${errorTextOf(first)}`);
    assert.equal(readBoard().followup_exceptions[TICKET].parent, DEP_A);

    const second = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_B, "--relation", "related"]);
    assert.equal(second.ok, false, "silently overwriting the exception record must be refused");
    const message = errorTextOf(second);
    assert.match(message, new RegExp(DEP_A), "the refusal must name the existing edge");
    assert.match(message, /--replace/, "the refusal must name the explicit flag required to replace it");

    const board = readBoard();
    assert.equal(board.followup_exceptions[TICKET].parent, DEP_A, "the existing exception must be preserved");
    assert.equal(board.followup_exceptions[TICKET].type, "related-followup");
  });
});

test("COORD-673: a blocking edge does not silently drop an existing exception record", () => {
  withFixture("c673-blocking-vs-exception-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A, "--relation", "closeout-blocker"]);
    const result = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_B, "--relation", "blocking"]);
    assert.equal(result.ok, false, "clearing another parent's exception must be refused");
    assert.match(errorTextOf(result), new RegExp(DEP_A));
    assert.match(errorTextOf(result), /--replace/);
    assert.equal(readBoard().followup_exceptions[TICKET].type, "closeout-blocker");
  });
});

test("COORD-673: an exception relation refuses MULTIPLE parents in one call — the record holds one", () => {
  withFixture("c673-multi-exception-", ({ readBoard }) => {
    const result = executeCommand([
      "set-followup-relation", TICKET,
      "--depends-on", `${DEP_A},${DEP_B}`,
      "--relation", "related",
    ]);
    assert.equal(result.ok, false, "two exception parents in one call must be refused");
    assert.match(errorTextOf(result), /one parent/i);
    assert.deepEqual(depsOf(readBoard()), [], "a refused call must not mutate the row");
  });
});

test("COORD-673: an exception on one parent leaves the OTHER accumulated edges blocking", () => {
  withFixture("c673-mixed-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_B, "--relation", "blocking"]);
    const related = executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A, "--relation", "related"]);
    assert.equal(related.ok, true, `adding a related edge alongside a blocking one: ${errorTextOf(related)}`);

    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_B, DEP_A], "both edges stay recorded");
    assert.deepEqual(blockedByOf(board), [DEP_B], "only the non-excepted edge blocks readiness");
  });
});

// --- explicit replacement + explicit removal ---------------------------------

test("COORD-673: --replace replaces the edge set explicitly", () => {
  withFixture("c673-replace-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", DEP_A, "--relation", "related"]);
    const result = executeCommand([
      "set-followup-relation", TICKET,
      "--depends-on", DEP_B,
      "--relation", "related",
      "--replace",
    ]);
    assert.equal(result.ok, true, `--replace must be accepted: ${errorTextOf(result)}`);
    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_B]);
    assert.equal(board.followup_exceptions[TICKET].parent, DEP_B);
  });
});

test("COORD-673: --relation independent with --depends-on removes only the named edge", () => {
  withFixture("c673-independent-one-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", `${DEP_A},${DEP_B}`]);
    const result = executeCommand([
      "set-followup-relation", TICKET,
      "--depends-on", DEP_A,
      "--relation", "independent",
    ]);
    assert.equal(result.ok, true, `targeted removal must succeed: ${errorTextOf(result)}`);
    const board = readBoard();
    assert.deepEqual(depsOf(board), [DEP_B], "only the named edge is removed");
    assert.deepEqual(blockedByOf(board), [DEP_B]);
  });
});

test("COORD-673: --relation independent with no --depends-on still clears every edge", () => {
  withFixture("c673-independent-all-", ({ readBoard }) => {
    executeCommand(["set-followup-relation", TICKET, "--depends-on", `${DEP_A},${DEP_B}`, "--relation", "related"]);
    const result = executeCommand(["set-followup-relation", TICKET, "--relation", "independent"]);
    assert.equal(result.ok, true, `clear-all must succeed: ${errorTextOf(result)}`);
    const board = readBoard();
    assert.deepEqual(depsOf(board), []);
    assert.equal(board.followup_exceptions[TICKET], undefined);
  });
});
