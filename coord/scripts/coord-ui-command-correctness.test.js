"use strict";

// COORD-106: coord-ui operator-command correctness.
//
// The /ticket explain panel (lib/ticket-explain.ts) and /dispatch view
// (lib/dispatch.ts) USED to re-derive governed command strings in TypeScript:
//   - the explain panel hardcoded `gov finalize <id> --pr` for any review
//     ticket, regardless of repo type (a repo-BACKED review ticket must `land`,
//     not finalize --pr — advisory drift that can close a ticket the WRONG way);
//   - the dispatch view hardcoded `gov finalize <id> --pr <url>` as the post-
//     landing closeout, again ignoring repo type;
//   - the dispatch view emitted `gov precheck --record <id>`, but the CLI takes
//     the ticket from args[0] BEFORE flags, so that parses the TICKET as the
//     --record value (F1).
//
// The fix makes the coord-ui RENDER the canonical planner output
// (buildTicketNextCommands in ticket-guidance.js, reached via the stable
// governance.js __testing facade — the SAME source these tests and the CLI use)
// instead of re-deriving commands, and fixes the precheck arg order.
//
// This suite is two-pronged:
//   (A) pin the CANONICAL routing the UI now renders (so the contract the UI
//       depends on is itself locked), and
//   (B) assert the coord-ui TS source sources from the canonical helper and no
//       longer carries the drift patterns (read as source text, mirroring
//       gate-vocab-contract.test.js's coord-ui assertions).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { __testing } = require("./governance.js");
const buildTicketNextCommands = __testing.buildTicketNextCommands;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI_LIB = path.join(REPO_ROOT, "frontend", "apps", "coord-ui", "lib");

// (A) CANONICAL routing the coord-ui renders verbatim ----------------------------

test("COORD-106: canonical routing — repo-backed review with PR -> gov land", () => {
  const commands = buildTicketNextCommands({
    board: { sections: [], review_findings: { "FE-900": [] }, pr_index: { "FE-900": ["https://x/pull/1"] } },
    row: { ID: "FE-900", Status: "review", Repo: "F" },
    ticketId: "FE-900",
    lock: null,
    provenanceDrift: [],
  });
  assert.deepEqual(commands, ["coord/scripts/gov land FE-900"]);
});

test("COORD-106: canonical routing — repo-X review with PR -> finalize --pr (not land)", () => {
  const commands = buildTicketNextCommands({
    board: { sections: [], review_findings: { "COORD-900": [] }, pr_index: { "COORD-900": ["https://x/pull/2"] } },
    row: { ID: "COORD-900", Status: "review", Repo: "X" },
    ticketId: "COORD-900",
    lock: null,
    provenanceDrift: [],
  });
  assert.deepEqual(commands, ['coord/scripts/gov finalize COORD-900 --pr "https://x/pull/2"']);
});

test("COORD-106: canonical routing — no-PR evidence review -> finalize --no-pr", () => {
  const commands = buildTicketNextCommands({
    board: { sections: [], review_findings: { "IMP-311": [] }, pr_index: { "IMP-311": ["local-review (no PR)"] } },
    row: { ID: "IMP-311", Status: "review", Repo: "F" },
    ticketId: "IMP-311",
    lock: null,
    provenanceDrift: [],
  });
  assert.deepEqual(commands, ['coord/scripts/gov finalize IMP-311 --no-pr --landed "<landing-evidence>"']);
});

test("COORD-106: canonical routing — open finding review -> repair (not a close verb)", () => {
  const commands = buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: { "FE-901": [{ id: "L1", status: "open" }] },
      pr_index: { "FE-901": ["https://x/pull/3"] },
    },
    row: { ID: "FE-901", Status: "review", Repo: "F" },
    ticketId: "FE-901",
    lock: null,
    provenanceDrift: [],
  });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^coord\/scripts\/gov repair FE-901 /);
});

test("COORD-106: canonical routing — empty pr_index review -> set-pr", () => {
  const commands = buildTicketNextCommands({
    board: { sections: [], review_findings: { "FE-902": [] }, pr_index: {} },
    row: { ID: "FE-902", Status: "review", Repo: "F" },
    ticketId: "FE-902",
    lock: null,
    provenanceDrift: [],
  });
  assert.deepEqual(commands, ['coord/scripts/gov set-pr FE-902 --pr "local-review (no PR)"']);
});

// The dispatch view renders the canonical CLOSEOUT verb by projecting a ticket
// into review with a placeholder PR — repo-backed -> land, repo-X -> finalize --pr.
function canonicalCloseoutFirst(ticketId, repo) {
  const commands = buildTicketNextCommands({
    board: { sections: [], review_findings: { [ticketId]: [] }, pr_index: { [ticketId]: ["<url>"] } },
    row: { ID: ticketId, Status: "review", Repo: repo },
    ticketId,
    lock: null,
    provenanceDrift: [],
  });
  return commands[0];
}

test("COORD-106: dispatch closeout projection — repo-backed -> land; repo-X -> finalize --pr", () => {
  assert.equal(canonicalCloseoutFirst("FE-903", "F"), "coord/scripts/gov land FE-903");
  assert.equal(canonicalCloseoutFirst("COORD-903", "X"), 'coord/scripts/gov finalize COORD-903 --pr "<url>"');
});

// (B) coord-ui source no longer re-derives / has the right arg order --------------

test("COORD-106: ticket-explain.ts renders canonical next-commands (no hardcoded finalize --pr)", () => {
  const src = fs.readFileSync(path.join(UI_LIB, "ticket-explain.ts"), "utf8");
  assert.match(src, /canonicalNextCommands\(/, "must source from the canonical planner helper");
  assert.doesNotMatch(
    src,
    /gov finalize \$\{id\}/,
    "must not hardcode a finalize command for the review/closeout case"
  );
  assert.doesNotMatch(src, /gov move-review \$\{id\}/, "must not hardcode move-review");
});

test("COORD-106: dispatch.ts uses canonical closeout + correct precheck arg order", () => {
  const src = fs.readFileSync(path.join(UI_LIB, "dispatch.ts"), "utf8");
  // F1: ticket id must precede the --record flag.
  assert.match(src, /gov precheck \$\{ticketId\} --record/, "precheck: ticket id must precede --record");
  assert.doesNotMatch(src, /gov precheck --record \$\{ticketId\}/, "F1 regression: flag before ticket");
  // F2: closeout sourced from the canonical helper, not a hardcoded finalize --pr.
  assert.match(src, /canonicalCloseoutCommand\(/, "closeout must come from the canonical helper");
  assert.match(src, /canonicalNextCommands\(/, "must call the canonical planner helper");
});

test("COORD-106: shared helper is a thin pass-through to governance.js canonical planner", () => {
  const src = fs.readFileSync(path.join(UI_LIB, "ticket-guidance.ts"), "utf8");
  assert.match(src, /governance\.js/, "helper must load the canonical governance module");
  assert.match(src, /buildTicketNextCommands/, "helper must expose the canonical planner");
});
