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
const createTicketGuidance = require("./ticket-guidance.js");
const { buildCostPhaseAdvisory } = createTicketGuidance;

test("COORD-772: explain cost coverage is advisory, unknown can be resolved by late actual usage, and missing phases stay visible", () => {
  const report = buildCostPhaseAdvisory("COST-1", [
    { result: "failed", ticket: "COST-1", command: "start", details: { dispatch_execution_id: "exec-failed" } },
    { result: "succeeded", ticket: "COST-1", command: "start", details: { dispatch_execution_id: "exec-1" } },
    { result: "succeeded", ticket: "COST-1", details: { event_type: "cost.observed", cost: {
      ticket: "COST-1", dispatch_execution_id: "exec-1", attempt_id: "boundary:plan-e1",
      phase: "plan", measurement_status: "unknown", measurement_source: "lifecycle_boundary", usage_scope: "phase_delta",
      input_tokens: null, output_tokens: null,
    } } },
    { result: "succeeded", ticket: "COST-1", details: { event_type: "cost.observed", cost: {
      ticket: "COST-1", dispatch_execution_id: "exec-1", attempt_id: "provider:plan-a1",
      phase: "plan", measurement_status: "measured", measurement_source: "provider_reported", usage_scope: "phase_delta",
      input_tokens: 0, output_tokens: 0,
    } } },
    { result: "succeeded", ticket: "COST-1", details: { event_type: "cost.observed", cost: {
      ticket: "COST-1", dispatch_execution_id: "exec-1", attempt_id: "provider:plan-incomplete",
      phase: "plan", measurement_status: "partial", measurement_source: "provider_reported", usage_scope: "phase_delta",
      input_tokens: 0, output_tokens: null,
    } } },
    { result: "failed", ticket: "COST-1", details: { event_type: "cost.observed", cost: {
      ticket: "COST-1", dispatch_execution_id: "exec-1", attempt_id: "refused:review",
      phase: "review", measurement_status: "measured", measurement_source: "provider_reported", usage_scope: "phase_delta",
      input_tokens: 4, output_tokens: 9,
    } } },
    { ticket: "OTHER", command: "start", details: { dispatch_execution_id: "exec-other" } },
  ]);
  assert.equal(report.advisory_only, true);
  assert.equal(report.blocking, false);
  assert.equal(report.executions.length, 1);
  assert.deepEqual(report.executions[0].phases.map((phase) => phase.status), ["partial", "missing", "missing"]);
  assert.deepEqual(report.executions[0].phases.map((phase) => phase.observations), [3, 0, 0]);
});

test("COORD-772: explain cost advisory covers missing and unknown refusals plus each phase status", () => {
  let costEvents;
  const row = { ID: "COST-2", Repo: "X", Status: "doing" };
  const events = [
    { result: "succeeded", ticket: "COST-2", command: "start", details: { dispatch_execution_id: "exec-z" } },
    { result: "succeeded", ticket: "COST-2", command: "start", details: { dispatch_execution_id: "exec-empty" } },
    { result: "succeeded", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "plan", measurement_status: "unknown",
      measurement_source: "lifecycle_boundary", usage_scope: "phase_delta",
    } } },
    { result: "succeeded", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "plan", measurement_status: "measured",
      measurement_source: "provider_reported", usage_scope: "phase_delta",
    } } },
    { result: "succeeded", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "plan", measurement_status: "partial",
      measurement_source: "provider_reported", usage_scope: "phase_delta",
    } } },
    { result: "succeeded", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "implement", measurement_status: "measured",
      usage_scope: "phase_delta",
    } } },
    { result: "succeeded", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "review", measurement_status: "unknown",
      measurement_source: "provider_reported", usage_scope: "phase_delta",
    } } },
    { result: "failed", ticket: "COST-2", details: { event_type: "cost.observed", cost: {
      ticket: "COST-2", dispatch_execution_id: "exec-z", phase: "review", measurement_status: "measured",
      measurement_source: "failed_attempt", usage_scope: "phase_delta",
    } } },
    { result: "succeeded", ticket: "OTHER", command: "start", details: { dispatch_execution_id: "ignored" } },
  ];
  const guidance = createTicketGuidance({
    readBoard: () => ({ sections: [], prompt_index: {} }),
    getTicketRef: (_board, ticketId) => ticketId === row.ID ? { row } : null,
    rowsById: () => [row],
    readPlanState: () => null,
    readTicketWaiver: () => null,
    evaluateReadiness: () => ({ ready: true }),
    collectStartReadinessBlockers: () => [],
    collectSubmitReadinessBlockers: () => [],
    deriveGovernanceReadiness: () => ({ ready: true }),
    isDoingStatus: () => true,
    isRepoBackedCode: () => false,
    findLockForTicket: () => null,
    detectActiveSameOwnerOtherThread: () => ({ present: false }),
    resolveOwnerIdentity: () => null,
    detectGovernanceProvenanceDrift: () => ({ drift: [] }),
    splitGovernanceProvenanceDrift: () => ({ blocking: [], warnings: [] }),
    buildQuestionQueueReport: () => ({ total: 0, by_type: {}, by_severity: {}, by_aging: {}, oldest: [] }),
    readActiveOrchestratorQuestionRows: () => [],
    buildExplainQuestionsGuidance: () => ({ required: false }),
    collectTicketGovernanceIssueEvents: (_ticketId, _limit, options) => options?.forCostAdvisory ? costEvents : [],
    findLatestTicketGovernanceEvent: () => null,
    summarizeGovernanceEvent: () => null,
    buildPostCloseFollowupCommand: () => "coord/scripts/gov next-ticket",
    shellEscape: (value) => String(value),
  });

  assert.throws(() => guidance.explainTicket(), /explain requires <ticket-id>/);
  assert.throws(() => guidance.explainTicket("MISSING-2"), /Unknown ticket "MISSING-2"/);

  const originalLog = console.log;
  const output = [];
  console.log = (value) => output.push(value);
  try {
    costEvents = undefined;
    guidance.explainTicket(row.ID);
    const emptyReport = JSON.parse(output.pop());
    assert.deepEqual(emptyReport.cost_phase_advisory, {
      advisory_only: true,
      blocking: false,
      executions: [],
    }, "a missing event-reader result safely becomes an empty advisory");

    costEvents = events;
    guidance.explainTicket(row.ID);
    const report = JSON.parse(output.pop());
    const [empty, execution] = report.cost_phase_advisory.executions;
    assert.equal(empty.dispatch_execution_id, "exec-empty");
    assert.deepEqual(empty.phases.map((phase) => phase.status), ["missing", "missing", "missing"]);
    assert.equal(execution.dispatch_execution_id, "exec-z");
    assert.deepEqual(execution.phases.map((phase) => phase.status), ["partial", "measured", "unknown_or_incomplete"]);
    assert.deepEqual(execution.phases.map((phase) => phase.measurement_sources), [
      ["lifecycle_boundary", "provider_reported"],
      ["legacy"],
      ["provider_reported"],
    ]);
    assert.deepEqual(execution.phases.map((phase) => phase.observations), [3, 1, 1],
      "failed events do not inflate successful observation counts");
    assert.equal(report.cost_phase_advisory.advisory_only, true);
    assert.equal(report.cost_phase_advisory.blocking, false);
  } finally {
    console.log = originalLog;
  }
});

test("todo guidance recommends start when there are no dependency blockers", () => {
  assert.deepEqual(__testing.buildTicketNextCommands({
    board: { sections: [], review_findings: {}, pr_index: {} },
    row: { ID: "COORD-713", Status: "todo", Repo: "X" },
    ticketId: "COORD-713", lock: null, provenanceDrift: [], startBlockers: [],
  }), ["coord/scripts/gov start COORD-713"]);
  assert.deepEqual(__testing.buildTicketNextCommands({
    board: { sections: [] }, row: { ID: "COORD-713", Status: "todo", Repo: "X" }, ticketId: "COORD-713",
    lock: null, provenanceDrift: [], startBlockers: [{ code: "legacy-blocker-without-remediation" }],
  }), [], "a blocker without next_steps must not invent an unsafe start command");
});

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

test("buildTicketNextCommands starts an unblocked todo and safely deduplicates blocker guidance", () => {
  const base = {
    board: { sections: [], review_findings: {}, pr_index: {} },
    row: { ID: "IMP-313", Status: "todo", Repo: "F" },
    ticketId: "IMP-313",
    lock: null,
    provenanceDrift: [],
  };

  assert.deepEqual(
    __testing.buildTicketNextCommands(base),
    ["coord/scripts/gov start IMP-313"],
    "a valid todo with no readiness blockers points to the governed start command",
  );

  assert.deepEqual(
    __testing.buildTicketNextCommands({
      ...base,
      startBlockers: [{ code: "fixture", message: "No suggested command is available." }],
    }),
    [],
    "a blocker without next_steps does not invent an operator command",
  );

  const repair = "coord/scripts/gov explain DEP-1";
  assert.deepEqual(
    __testing.buildTicketNextCommands({
      ...base,
      startBlockers: [
        { code: "dependency-a", next_steps: [repair, "coord/scripts/gov explain DEP-2"] },
        { code: "dependency-b", next_steps: [repair] },
      ],
    }),
    ["coord/scripts/gov explain DEP-1", "coord/scripts/gov explain DEP-2"],
    "multiple blockers preserve first-seen repair guidance without duplicate commands",
  );
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
