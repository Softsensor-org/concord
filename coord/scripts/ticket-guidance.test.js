"use strict";

// COORD-086 (Wave 4 slice 2): behavior tests for the OPERATOR-GUIDANCE surface
// (ticket-guidance.js) — buildTicketNextCommands, the per-status "what should I
// run next" planner. These are the deep guidance assertions relocated out of
// governance.test.js when the guidance surface was extracted from lifecycle.js.
// They reach the surface through the stable governance.js __testing facade,
// which re-exports the ticket-guidance factory bindings (explainTicket /
// buildTicketNextCommands), so the move preserves the public test contract while
// keeping the deep behavior coverage co-located with the module it exercises.
// (explainTicket / runTicketCycle are exercised through their lifecycle/lock
// integration tests, which intentionally stay with governance.test.js.)

const test = require("node:test");
const assert = require("node:assert/strict");

const governanceModule = require("./governance.js");
const { __testing } = governanceModule;

test("buildTicketNextCommands keeps normal ticket flow while surfacing unrelated governance drift", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "IMP-311",
      Status: "doing",
      Repo: "F",
    },
    ticketId: "IMP-311",
    lock: {
      ticket: "IMP-311",
      worktree: "/tmp/frontend/.worktrees/codexa00/IMP-311",
    },
    provenanceDrift: [".runtime/locks/IMP-311.lock"],
  });

  assert.deepEqual(commands, [
    "coord/scripts/gov doctor",
    "coord/scripts/gov heartbeat IMP-311",
    'coord/scripts/gov commit IMP-311 --message "<message>"',
    "coord/scripts/gov submit IMP-311",
  ]);
});

test("buildTicketNextCommands does not escalate warning-class runtime drift into a blocking doctor step", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "IMP-312",
      Status: "doing",
      Repo: "F",
    },
    ticketId: "IMP-312",
    lock: {
      ticket: "IMP-312",
      worktree: "/tmp/frontend/.worktrees/codexa00/IMP-312",
    },
    provenanceDrift: [".runtime/agent_sessions.json"],
  });

  assert.deepEqual(commands, [
    "coord/scripts/gov heartbeat IMP-312",
    'coord/scripts/gov commit IMP-312 --message "<message>"',
    "coord/scripts/gov submit IMP-312",
  ]);
});

test("buildTicketNextCommands gives single-parent blocked todo tickets actionable relation repair commands", () => {
  const startBlockers = [
    {
      code: "dependencies",
      message: "Ticket DEBT-042 cannot start until these dependencies land: IMP-245. If this dependency should only track a related or closeout-only follow-up, repair the relation with set-followup-relation instead of editing board state directly.",
      next_steps: [
        "coord/scripts/gov explain IMP-245",
        "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation related",
        "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation closeout-blocker",
      ],
    },
  ];

  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "DEBT-042",
      Status: "todo",
      Repo: "B",
    },
    ticketId: "DEBT-042",
    lock: null,
    provenanceDrift: [],
    startBlockers,
  });

  assert.deepEqual(commands, [
    "coord/scripts/gov explain IMP-245",
    "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation related",
    "coord/scripts/gov set-followup-relation DEBT-042 --depends-on IMP-245 --relation closeout-blocker",
  ]);
});

test("buildTicketNextCommands routes local-review closeout through finalize", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {
        "IMP-311": [],
      },
      pr_index: {
        "IMP-311": ["local-review (no PR)"],
      },
    },
    row: {
      ID: "IMP-311",
      Status: "review",
      Repo: "F",
    },
    ticketId: "IMP-311",
    lock: null,
    provenanceDrift: [],
  });

  assert.deepEqual(commands, [
    'coord/scripts/gov finalize IMP-311 --no-pr --landed "<landing-evidence>"',
  ]);
});

test("COORD-055: buildTicketNextCommands routes PR-backed repo-X review tickets to finalize --pr, not the land dead-end", () => {
  // A repo-X (coord / cross-repo, TRUST-style) ticket in review with real PR
  // evidence: `land` -> prMerge fails for non-repo-backed codes, so explain must
  // not recommend it. The executable governed closeout is a PR-backed finalize.
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: { "COORD-900": [] },
      pr_index: { "COORD-900": ["https://github.com/org/repo/pull/123"] },
    },
    row: { ID: "COORD-900", Status: "review", Repo: "X" },
    ticketId: "COORD-900",
    lock: null,
    provenanceDrift: [],
  });

  assert.deepEqual(commands, [
    'coord/scripts/gov finalize COORD-900 --pr "https://github.com/org/repo/pull/123"',
  ]);
});

test("COORD-055: buildTicketNextCommands still routes PR-backed repo-backed review tickets through land", () => {
  // Regression guard: the repo-X fix must not change repo-backed (B/F) closeout,
  // which still performs the real GitHub merge via land.
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: { "FE-900": [] },
      pr_index: { "FE-900": ["https://github.com/org/repo/pull/456"] },
    },
    row: { ID: "FE-900", Status: "review", Repo: "F" },
    ticketId: "FE-900",
    lock: null,
    provenanceDrift: [],
  });

  assert.deepEqual(commands, ["coord/scripts/gov land FE-900"]);
});

test("buildTicketNextCommands gives done tickets a governed follow-up path", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "DEBT-052",
      Status: "done",
      Repo: "X",
      Type: "infra",
      Pri: "P2",
    },
    ticketId: "DEBT-052",
    lock: null,
    provenanceDrift: [],
  });

  assert.deepEqual(commands, [
    'coord/scripts/gov open-followup <NEW-FOLLOWUP-ID> --depends-on DEBT-052 --repo X --type infra --pri P2 --description "Follow-up for post-close finding"',
  ]);
});

test("buildTicketNextCommands gives repo X doing tickets an explicit no-PR submit path", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "DEBT-043",
      Status: "doing",
      Repo: "X",
      Type: "infra",
      Pri: "P2",
    },
    ticketId: "DEBT-043",
    lock: {
      ticket: "DEBT-043",
      owner: "codexa00",
    },
    provenanceDrift: [],
    submitBlockers: [],
  });

  assert.deepEqual(commands, [
    "coord/scripts/gov heartbeat DEBT-043",
    'coord/scripts/gov submit DEBT-043 --pr "local-review (no PR)"',
  ]);
});

test("buildTicketNextCommands treats blocked doing as active work", () => {
  const commands = __testing.buildTicketNextCommands({
    board: {
      sections: [],
      review_findings: {},
      pr_index: {},
    },
    row: {
      ID: "DEBT-043",
      Status: "doing (blocked: awaiting repair)",
      Repo: "X",
      Type: "infra",
      Pri: "P2",
    },
    ticketId: "DEBT-043",
    lock: {
      ticket: "DEBT-043",
      owner: "codexa00",
    },
    provenanceDrift: [],
    submitBlockers: [],
  });

  assert.deepEqual(commands, [
    "coord/scripts/gov heartbeat DEBT-043",
    'coord/scripts/gov submit DEBT-043 --pr "local-review (no PR)"',
  ]);
});
