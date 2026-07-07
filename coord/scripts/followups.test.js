"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing, GovernanceError } = require("./governance-test-utils.js");
const createFollowups = require("./followups.js");

// COORD-279 (item 3): a followups instance with an INJECTED historical-ticket-id
// set (stands in for the journal), so id allocation can be tested in isolation
// without touching the live journal.
function followupsWithJournal(historicalIds) {
  return createFollowups({
    fail: (m) => {
      throw new GovernanceError(m);
    },
    getRows: (board) =>
      (board.sections || []).flatMap((s) => s.rows || []),
    historicalTicketIds: () => new Set(historicalIds),
  });
}

// COORD-100 (governance.test residual split, capstone): behavior tests whose
// primary subject is DEFINED in followups.js — id allocation (nextTicketId),
// followup-prompt inheritance/coverage (resolveFollowupPromptPath), and
// followup relation mapping (applyFollowupRelation). The open-followup /
// split-ticket VERB flows (driven end-to-end via the governed workspace)
// stay in governance.test.js as facade/integration coverage.


test("resolveFollowupPromptPath inherits the parent prompt when none is passed", () => {
  const board = {
    prompt_index: {
      "IMP-219": "coord/prompts/IMP-219-missing-signatures.md",
    },
  };

  assert.equal(
    __testing.resolveFollowupPromptPath({
      board,
      parentTicketId: "IMP-219",
      explicitPrompt: null,
    }),
    "coord/prompts/IMP-219-missing-signatures.md"
  );
});

test("resolveFollowupPromptPath fails when neither explicit nor parent prompt coverage exists", () => {
  assert.throws(
    () =>
      __testing.resolveFollowupPromptPath({
        board: { prompt_index: {} },
        parentTicketId: "IMP-999",
        explicitPrompt: null,
      }),
    (error) => error instanceof GovernanceError && /open-followup requires prompt coverage/i.test(error.message)
  );
});

test("applyFollowupRelation maps blocking, related, closeout-blocker, and independent modes into board metadata", () => {
  const board = { followup_exceptions: {} };

  assert.equal(__testing.applyFollowupRelation(board, "DEBT-042", "IMP-245", "blocking"), "IMP-245");
  assert.equal(board.followup_exceptions["DEBT-042"], undefined);

  assert.equal(__testing.applyFollowupRelation(board, "DEBT-042", "IMP-245", "related"), "IMP-245");
  assert.deepEqual(board.followup_exceptions["DEBT-042"], {
    parent: "IMP-245",
    type: "related-followup",
  });

  assert.equal(__testing.applyFollowupRelation(board, "DEBT-042", "IMP-245", "closeout-blocker"), "IMP-245");
  assert.deepEqual(board.followup_exceptions["DEBT-042"], {
    parent: "IMP-245",
    type: "closeout-blocker",
  });

  assert.equal(__testing.applyFollowupRelation(board, "DEBT-042", null, "independent"), "");
  assert.equal(board.followup_exceptions["DEBT-042"], undefined);
});

// ---------------------------------------------------------------------------
// Upstream: config-aware base default + auto-id (next-id / open-followup
// --prefix / split-ticket) + ghPrView retry-with-backoff. See
// docs/UPSTREAM-CHANGESET-base-aware-autoid-ghretry.md.
// ---------------------------------------------------------------------------

test("nextTicketId allocates 001 for a fresh prefix and max+1 for an existing one", () => {
  // Fresh prefix → zero-padded 001 (min width 3).
  assert.equal(
    __testing.nextTicketId({ sections: [{ rows: [] }] }, "TRUST"),
    "TRUST-001"
  );
  // Existing prefix → max+1, ignoring other prefixes; case-insensitive prefix.
  assert.equal(
    __testing.nextTicketId(
      { sections: [{ rows: [{ ID: "TRUST-003" }, { ID: "TRUST-007" }, { ID: "OTHER-009" }] }] },
      "trust"
    ),
    "TRUST-008"
  );
  // Width follows the widest existing id (min 3).
  assert.equal(
    __testing.nextTicketId({ sections: [{ rows: [{ ID: "FOO-0042" }] }] }, "FOO"),
    "FOO-0043"
  );
  // A letters-only prefix is required.
  assert.throws(
    () => __testing.nextTicketId({ sections: [{ rows: [] }] }, "123"),
    (error) => error instanceof GovernanceError && /letters-only --prefix/i.test(error.message)
  );
});

test("COORD-279: nextTicketId never reuses a JOURNAL-historical id after its board row was removed", () => {
  // The board no longer carries TRUST-005 (its row was removed), but the journal
  // still records that TRUST-005 once existed. A max+1 over LIVE rows alone would
  // hand back TRUST-005 again and collide with history.
  const { nextTicketId } = followupsWithJournal(["TRUST-005", "TRUST-002"]);
  const board = { sections: [{ rows: [{ ID: "TRUST-003" }] }] };

  // Live max is 003; journal historical max is 005 → reserve 006, NOT 004/005.
  assert.equal(nextTicketId(board, "TRUST"), "TRUST-006");
});

test("COORD-279: nextTicketId reserves against the MAX of live rows and journal", () => {
  // Live rows go HIGHER than the journal-historical set → live wins.
  const { nextTicketId } = followupsWithJournal(["TRUST-002"]);
  const board = { sections: [{ rows: [{ ID: "TRUST-009" }] }] };
  assert.equal(nextTicketId(board, "TRUST"), "TRUST-010");

  // COORD-430 (supersedes the prior COORD-279 fallback): a journal read failure
  // must NOT silently fall back to live-rows-only — that re-enables the exact
  // historical-id reuse COORD-279 exists to prevent. It now fails CLOSED so the
  // enclosing governed mutation aborts and can retry once the journal is readable,
  // rather than allocating a possibly-colliding id.
  const brittle = createFollowups({
    fail: (m) => {
      throw new GovernanceError(m);
    },
    getRows: (b) => (b.sections || []).flatMap((s) => s.rows || []),
    historicalTicketIds: () => {
      throw new Error("journal unavailable");
    },
  });
  assert.throws(
    () => brittle.nextTicketId(board, "TRUST"),
    /journal read failed|journal history/i,
    "nextTicketId must fail closed (not narrow to live rows) when journal history is unreadable"
  );
});
