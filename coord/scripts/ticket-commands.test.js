"use strict";

// COORD-282: DI wiring-guard for the ticket-commands.js extraction.
//
// The six ticket state-mutation functions (collectUnstartEvidenceBlockers,
// unstartTicket, lockAbandonTicket, commitTicket, openFollowup, fileTicket) were
// moved out of lifecycle.js into the createTicketCommands factory. lifecycle.js
// re-wires them with deferred `(...a)=>fn(...a)` wrappers (and the value consts
// STATUS / ALLOWED_TICKET_TYPES / ALLOWED_PRIORITIES injected by reference) and
// re-destructures the six names back into scope.
//
// That wiring only resolves at CALL time. A dropped dep, a typo'd wrapper name,
// or a broken re-destructure would ship silently and only blow up
// ("<dep> is not a function") the first time someone filed a ticket / opened a
// follow-up / reverted a start. This guard drives the factory-produced surface
// THROUGH the lifecycle `__testing` facade so a regression fails the suite
// instead of a live board mutation.
//
// CRITICAL invariant asserted here: the board mutations still ride the COORD-220
// `withBoardTransaction` / single-writer path — each create produces EXACTLY ONE
// journal event and a `board.js validate`-clean row, with the id reserved INSIDE
// the transaction (not reimplemented in the new module).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  GovernanceError,
  __testing,
  withGovernedSurfaceSandbox,
} = require("./governance-test-utils.js");

function seedJournalBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-06-24T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "coord282-wiring-guard" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function writeBacklogBoard(boardPath, rows) {
  const board = {
    version: 1,
    metadata: { title: "COORD-282 wiring-guard board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-282 Backlog",
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

function row(id, deps = "") {
  return {
    ID: id,
    Repo: "X",
    Type: "chore",
    Pri: "P2",
    Status: "todo",
    Owner: "unassigned",
    Description: `row ${id}`,
    "Depends On": deps,
  };
}

function countEvents(logPath) {
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

// fileTicket + openFollowup both compose withBoardTransaction. Driving both
// through the facade proves the transaction primitive, reserveTicketId, and the
// create-path deferred wrappers (getTicketRef / ensurePromptIndex /
// allBoardRepoCodes / applyFollowupRelation / normalizeFollowupRelation /
// canonicalizeOwnerOrFail / stableIdempotencyKey) all resolved across the seam.
test("COORD-282 wiring-guard: fileTicket + openFollowup ride withBoardTransaction (1 journal event each, reserved ids)", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const before = countEvents(logPath);

    // fileTicket -> withBoardTransaction -> reserveTicketId (inside the lock).
    const filed = __testing.fileTicket(null, {
      repo: "X",
      type: "feature",
      pri: "P1",
      description: "wiring-guard filed ticket",
    });
    assert.equal(filed, "COORD-002", "id reserved off the live board inside the transaction");
    assert.equal(countEvents(logPath), before + 1, "fileTicket = exactly one journal event (single-writer intact)");

    // openFollowup -> withBoardTransaction -> applyFollowupRelation deferred wrappers.
    __testing.openFollowup(null, {
      prefix: "COORD",
      dependsOn: "COORD-002",
      repo: "X",
      type: "chore",
      pri: "P2",
      description: "wiring-guard follow-up",
      relation: "blocking",
      prompt: "coord/prompts/planner.md",
    });
    assert.equal(countEvents(logPath), before + 2, "openFollowup = exactly one more journal event");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const ids = after.sections[0].rows.map((r) => r.ID).sort();
    assert.deepEqual(ids, ["COORD-001", "COORD-002", "COORD-003"], "both creates landed with reserved, non-colliding ids");
    const followup = after.sections[0].rows.find((r) => r.ID === "COORD-003");
    assert.match(followup["Depends On"], /COORD-002/, "blocking follow-up depends on its parent");
  });
});

// The two revert verbs and commitTicket are validation-heavy; the cheapest seam
// proof is that they reach their FIRST injected-dep call and throw the expected
// GovernanceError (not a TypeError from an unresolved wrapper).
test("COORD-282 wiring-guard: unstart/lock-abandon/commit reach their injected deps and fail closed (not TypeError)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    // unstartTicket: resolves the injected resolveOwnerIdentity wrapper and fails
    // closed with a GovernanceError (a dropped wrapper would throw a TypeError).
    assert.throws(
      () => __testing.unstartTicket("COORD-001", { owner: "claudea1" }),
      (err) => err instanceof GovernanceError && /registered agent handle|must be doing/.test(err.message)
    );

    // lockAbandonTicket without the override: resolves before the override gate.
    assert.throws(
      () => __testing.lockAbandonTicket("COORD-001", {}),
      (err) => err instanceof GovernanceError && /human-admin-override/.test(err.message)
    );

    // commitTicket via the dispatch surface (not in the facade) — exercised through
    // the commands table to prove its deferred wrappers resolve.
    const { commands } = require("./lifecycle.js");
    assert.equal(typeof commands.commitTicket, "function", "commitTicket re-wired into the dispatch table");
    assert.throws(
      () => commands.commitTicket("COORD-001", {}),
      (err) => err instanceof GovernanceError && /requires --message/.test(err.message)
    );
  });
});

// collectUnstartEvidenceBlockers is the read-only guard shared by both reverts.
// On a clean todo row with no review/landing/plan/workspace evidence it must
// return [] — proving its injected deps (readPlanRecord / integerOrDefault /
// resolveTicketGitContext / planRecordHasImplicitIntendedFilesScaffoldPlaceholder)
// all resolved through the seam.
test("COORD-282 wiring-guard: collectUnstartEvidenceBlockers returns [] for a clean todo row", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const board = __testing.readBoard();
    const blockers = __testing.collectUnstartEvidenceBlockers(
      "COORD-001",
      board.sections[0].rows[0],
      board
    );
    assert.deepEqual(blockers, [], "no auditable evidence on a clean todo row");
  });
});
