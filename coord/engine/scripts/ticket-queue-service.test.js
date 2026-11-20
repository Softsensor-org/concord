"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createTicketQueueService = require("./ticket-queue-service.js");
const lifecycleModule = require("./lifecycle.js");

// COORD-294: behavior tests for the ticket QUEUE / ranking / recommendation
// service extracted from lifecycle.js into ticket-queue-service.js (lifecycle
// decomposition slice #3, per the COORD-291 boundary contract). The factory is
// exercised directly with injected fake deps so the scoring model, the COORD-285
// proposed-exclusion, the mode bias, and the idle/busy agent summaries are pinned
// at the unit level; the `gov counts/list/pick/recommend` OUTPUT parity continues
// to be exercised end-to-end through the fully-wired CLI in governance.test.js
// (counts proposed-exclusion) — those assertions are unchanged by this move.

// A constant STATUS map matching the live governance status vocabulary the queue
// service reads (TODO candidate set + the DONE/SUPERSEDED/PROPOSED downstream
// exclusion).
const STATUS = {
  TODO: "todo",
  DOING: "doing",
  REVIEW: "review",
  DONE: "done",
  SUPERSEDED: "superseded",
  PROPOSED: "proposed",
};

function buildService(overrides = {}) {
  const deps = {
    state: { BOARD_PATH: "/board/tasks.json" },
    STATUS,
    readBoard: () => ({}),
    getRows: () => [],
    resolveOwnerIdentity: () => ({ agent: { id: "a1", handle: "agent1" } }),
    ensureCurrentAgentIdentity: () => ({ agent: { id: "a1", handle: "agent1" } }),
    maybeCanonicalOwner: (o) => o,
    findDoingTicketForOwner: () => null,
    readAgentsRegistry: () => [],
    readAgentSessions: () => [],
    resolveAgentIdentifier: () => null,
    compareSessionsMostRecentFirst: () => 0,
    resolveEffectiveThreadId: () => null,
    evaluateReadiness: () => ({ ready: true, deps: [], blockedBy: [], cycles: [], blockerChains: [] }),
    splitDependsOn: (value) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : []),
    isRepoBackedCode: (code) => code === "B" || code === "F",
    formatTransitiveBlockerDetails: () => "",
    formatDependencyCycleList: () => "",
    integerOrDefault: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    fail: (msg) => {
      throw new Error(msg);
    },
    ...overrides,
  };
  return { svc: createTicketQueueService(deps), deps };
}

// --- DI wiring guard: factory shape + lifecycle composition-root wiring --------

test("COORD-294 wiring: createTicketQueueService returns exactly the nine public functions", () => {
  const { svc } = buildService();
  const expected = [
    "listTickets",
    "pickTickets",
    "recommendTickets",
    "recommendationModeForAgent",
    "summarizeBusyActiveAgents",
    "listIdleActiveAgentSessions",
    "buildReleaseCandidates",
    "scoreTicket",
    "buildDownstreamCounts",
  ];
  assert.deepEqual(Object.keys(svc).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof svc[name], "function", `${name} must be a function`);
  }
});

test("COORD-294/297 wiring: lifecycle.js dispatches the queue verbs via commands; the facade no longer re-exports queue internals", () => {
  // BRACKET form (COORD-280 facade-scanner safe): the command dispatch keeps the
  // three queue verbs. COORD-297 dropped the `buildReleaseCandidates` re-export
  // from the `__testing` facade — it was a dead facade key (no test reached it
  // through the facade; agent-commands.js consumes it via DI injection, not the
  // facade), and its behavior is owned by this module's tests below.
  for (const name of ["listTickets", "pickTickets", "recommendTickets"]) {
    assert.equal(typeof lifecycleModule.commands[name], "function", `lifecycle commands[${name}] resolves`);
  }
  assert.equal(
    lifecycleModule.__testing["buildReleaseCandidates"],
    undefined,
    "COORD-297: lifecycle __testing[buildReleaseCandidates] is dropped (queue-service owned)"
  );
});

// --- scoring model (scoreTicket + mode bias) -----------------------------------

test("scoreTicket sums the ready/priority/repo/downstream/prompt/dependency/mode bonuses", () => {
  const { svc } = buildService();
  const row = { ID: "T-1", Repo: "B", Pri: "P0" };
  const readiness = { ready: true, deps: [] };
  const breakdown = svc.scoreTicket(row, readiness, { downstreamOpen: 3, hasPrompt: true, mode: "backend" });
  assert.equal(breakdown.ready_bonus, 1000);
  assert.equal(breakdown.priority_bonus, 300);
  assert.equal(breakdown.repo_bonus, 30);
  assert.equal(breakdown.downstream_bonus, 75); // min(200, 3*25)
  assert.equal(breakdown.prompt_bonus, 25);
  assert.equal(breakdown.dependency_bonus, 20);
  assert.equal(breakdown.mode_bonus, 180); // backend bias on a Repo B ticket
  assert.equal(breakdown.mode, "backend");
  assert.equal(
    breakdown.total,
    1000 + 300 + 30 + 75 + 25 + 20 + 180
  );
});

test("scoreTicket mode bias penalizes off-lane repos and rewards design on X", () => {
  const { svc } = buildService();
  const base = { ready: false, deps: ["X-9"] };
  // backend mode on a frontend ticket -> -120 mode bonus
  const backendOnF = svc.scoreTicket({ ID: "F-1", Repo: "F", Pri: "P3" }, base, { mode: "backend" });
  assert.equal(backendOnF.mode_bonus, -120);
  // design mode on an X ticket -> +200
  const designOnX = svc.scoreTicket({ ID: "X-1", Repo: "X", Pri: "P3" }, base, { mode: "design" });
  assert.equal(designOnX.mode_bonus, 200);
  // missing prompt costs -60; one dependency reduces the dependency bonus to 15
  assert.equal(designOnX.prompt_bonus, -60);
  assert.equal(designOnX.dependency_bonus, 15);
});

// --- COORD-285 proposed-exclusion from downstream scoring -----------------------

test("buildDownstreamCounts excludes proposed/done/superseded dependents from the unblocks count", () => {
  const { svc } = buildService();
  const rows = [
    { ID: "DEP-OPEN", Status: "todo", "Depends On": "BASE" },
    { ID: "DEP-DOING", Status: "doing", "Depends On": "BASE" },
    { ID: "DEP-PROPOSED", Status: "proposed", "Depends On": "BASE" },
    { ID: "DEP-DONE", Status: "done", "Depends On": "BASE" },
    { ID: "DEP-SUPERSEDED", Status: "superseded", "Depends On": "BASE" },
  ];
  const counts = svc.buildDownstreamCounts(rows);
  // only the todo + doing dependents count toward BASE's unblocks; proposed/done/
  // superseded are excluded (COORD-285 + terminal exclusion).
  assert.equal(counts.get("BASE"), 2);
});

// --- mode bias resolver --------------------------------------------------------

test("recommendationModeForAgent prefers explicit filter, then lane, then repo, then default-repo", () => {
  const { svc } = buildService();
  assert.equal(svc.recommendationModeForAgent({ lane: "frontend" }, { mode: "backend" }), "backend");
  assert.equal(svc.recommendationModeForAgent({ lane: "frontend" }, {}), "frontend");
  assert.equal(svc.recommendationModeForAgent({ lane: "general" }, { repo: "B" }), "backend");
  assert.equal(svc.recommendationModeForAgent({ default_repo: "F" }, {}), "frontend");
  assert.equal(svc.recommendationModeForAgent({}, {}), "general");
});

// --- idle / busy active-agent summaries ----------------------------------------

const AGENTS = [
  { id: "a1", handle: "agent1", status: "active" },
  { id: "a2", handle: "agent2", status: "active" },
];

function sessionsFixture() {
  return [
    { session_id: "s1", handle: "agent1", status: "active", board_path: "/board/tasks.json", thread_id: "t1" },
    { session_id: "s2", handle: "agent2", status: "active", board_path: "/board/tasks.json", thread_id: "t2" },
  ];
}

test("summarizeBusyActiveAgents returns active agents that currently hold a doing ticket", () => {
  const doing = { agent1: { ID: "DOING-1", Repo: "B", Pri: "P1", Description: "busy work" } };
  const { svc } = buildService({
    resolveAgentIdentifier: (handle) => {
      const agent = AGENTS.find((a) => a.handle === handle);
      return agent ? { agent } : null;
    },
    findDoingTicketForOwner: (_board, handle) => doing[handle] || null,
  });
  const busy = svc.summarizeBusyActiveAgents({}, { agents: AGENTS, sessions: sessionsFixture() });
  assert.deepEqual(busy.map((e) => e.agent.handle), ["agent1"]);
  assert.equal(busy[0].ticket.ID, "DOING-1");
});

test("listIdleActiveAgentSessions returns active agents WITHOUT a doing ticket, deduped + id-sorted", () => {
  const doing = { agent1: { ID: "DOING-1" } };
  const { svc } = buildService({
    resolveAgentIdentifier: (handle) => {
      const agent = AGENTS.find((a) => a.handle === handle);
      return agent ? { agent } : null;
    },
    findDoingTicketForOwner: (_board, handle) => doing[handle] || null,
  });
  const idle = svc.listIdleActiveAgentSessions({}, { agents: AGENTS, sessions: sessionsFixture() });
  assert.deepEqual(idle.map((e) => e.agent.handle), ["agent2"]);
});

test("listIdleActiveAgentSessions skips handle-less, repeated, unknown and disabled-agent sessions", () => {
  const agents = [...AGENTS, { id: "a3", handle: "agent3", status: "disabled" }];
  const lookups = [];
  const { svc } = buildService({
    resolveAgentIdentifier: (handle) => {
      lookups.push(handle);
      const agent = agents.find((a) => a.handle === handle);
      return agent ? { agent } : null;
    },
    findDoingTicketForOwner: () => null,
  });
  const board = "/board/tasks.json";
  const sessions = [
    { session_id: "s0", status: "active", board_path: board, thread_id: "t0" },
    { session_id: "s2", handle: "agent2", status: "active", board_path: board, thread_id: "t2" },
    { session_id: "s2-older", handle: "agent2", status: "active", board_path: board, thread_id: "t2b" },
    { session_id: "s9", handle: "ghost", status: "active", board_path: board, thread_id: "t9" },
    { session_id: "s3", handle: "agent3", status: "active", board_path: board, thread_id: "t3" },
    { session_id: "s1", handle: "agent1", status: "active", board_path: board, thread_id: "t1" },
  ];
  const idle = svc.listIdleActiveAgentSessions({}, { agents, sessions });
  // The first (most recent) session per handle wins; the repeat is never resolved.
  assert.deepEqual(idle.map((e) => [e.agent.handle, e.session.session_id]), [["agent1", "s1"], ["agent2", "s2"]]);
  assert.deepEqual(lookups, ["agent2", "ghost", "agent3", "agent1"], "a handle-less or repeated session is skipped before resolution");
});

test("buildReleaseCandidates plans agent-release for every idle active session and flags the current thread", () => {
  const { svc } = buildService({
    resolveAgentIdentifier: (handle) => {
      const agent = AGENTS.find((a) => a.handle === handle);
      return agent ? { agent } : null;
    },
    findDoingTicketForOwner: () => null,
    resolveEffectiveThreadId: () => "t2",
  });
  const candidates = svc.buildReleaseCandidates({}, { agents: AGENTS, sessions: sessionsFixture() });
  assert.deepEqual(candidates.map((c) => c.agent.handle), ["agent1", "agent2"]);
  assert.equal(candidates.find((c) => c.agent.handle === "agent2").is_current_thread, true);
  assert.equal(candidates.find((c) => c.agent.handle === "agent1").is_current_thread, false);
  assert.match(candidates[0].release_commands[0], /gov agent-release s1/);
});

test("COORD-1047: recommend/next-ticket --why includes advisory attempts without refusing", () => {
  const row = { ID: "TEST-1047", Status: "todo", Repo: "B", Pri: "P1", Description: "attempt visibility" };
  const calls = [];
  const { svc } = buildService({
    getRows: () => [row],
    evaluateReadiness: () => ({ ready: true, deps: [], blockedBy: [], cycles: [], blockerChains: [] }),
    listTicketAttempts: (_root, options) => {
      calls.push(options.ticket);
      return { skipped: null, attempts: [{ attempt_id: "att-1", classes: ["attempt-stale"] }], problems: [] };
    },
  });
  let output = "";
  const originalLog = console.log;
  console.log = (value) => { output = String(value); };
  try {
    svc.recommendTickets({ why: row.ID });
    assert.deepEqual(JSON.parse(output).attempts.attempts, [{ attempt_id: "att-1", classes: ["attempt-stale"] }]);
    svc.pickTickets(undefined, { why: row.ID });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(calls, [row.ID, row.ID]);
  assert.deepEqual(JSON.parse(output).attempts.attempts, [{ attempt_id: "att-1", classes: ["attempt-stale"] }]);
});

function captureQueueOutput(action) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try { action(); } finally { console.log = original; }
  return lines.join("\n");
}

test("COORD-1052: advisory attempt failures cannot block ticket recommendations or picks", () => {
  const row = { ID: "T-1", Status: "todo", Repo: "B", Pri: "P1", Description: "ready work" };
  for (const missingBoardPath of [false, true]) {
    let attempts = 0;
    const { svc } = buildService({ state: missingBoardPath ? {} : { BOARD_PATH: "/coord/board/tasks.json" },
      getRows: () => [row], listTicketAttempts: () => { attempts += 1; throw new Error("advisory store unavailable"); } });
    for (const action of [() => svc.recommendTickets({ why: row.ID }), () => svc.pickTickets(undefined, { why: row.ID })]) {
      const result = JSON.parse(captureQueueOutput(action));
      assert.equal(result.ticket.ID, row.ID);
      assert.equal(result.readiness.ready, true);
      assert.deepEqual(result.attempts, missingBoardPath ? { skipped: "no-board-path", attempts: [], problems: [] } : []);
    }
    assert.equal(attempts, missingBoardPath ? 0 : 2, "missing location must not probe an unrelated store");
  }
});

test("COORD-1052: recommendation filters preserve readiness, deterministic ties and empty-set diagnostics", () => {
  const rows = [
    { ID: "T-2", Status: "todo", Repo: "B", Pri: "P1", Description: "second ready" },
    { ID: "T-1", Status: "todo", Repo: "B", Pri: "P1", Description: "first ready" },
    { ID: "T-3", Status: "todo", Repo: "B", Pri: "P1", Description: "blocked" },
    { ID: "T-4", Status: "todo", Repo: "F", Pri: "P1", Description: "other repository" },
    { ID: "T-5", Status: "todo", Repo: "B", Pri: "P2", Description: "other priority" },
    { ID: "T-6", Status: "proposed", Repo: "B", Pri: "P1", Description: "unapproved" },
  ];
  const { svc } = buildService({ getRows: () => rows, evaluateReadiness: (row) => ({ ready: row.ID !== "T-3", deps: [],
    blockedBy: row.ID === "T-3" ? ["dependency"] : [], cycles: [], blockerChains: [] }) });
  const filters = { repo: "B", pri: "P1", limit: 10 };
  let active;
  const board = { prompt_index: { "T-2": "prompts/t-2.md" } };
  const { svc: ownerQueue } = buildService({
    readBoard: () => board,
    getRows: () => rows,
    resolveOwnerIdentity: (owner, options) => {
      assert.equal(owner, "agent2");
      assert.deepEqual(options, { allowAutoClaim: false, touchSession: false });
      return { agent: { id: "a2", handle: owner } };
    },
    findDoingTicketForOwner: (boardRead, owner) => {
      assert.equal(boardRead, board);
      assert.equal(owner, "agent2");
      return active;
    },
  });
  const pick = () => captureQueueOutput(() => ownerQueue.pickTickets(undefined, { ...filters, owner: "agent2" }));
  const idleOutput = pick();
  assert.match(idleOutput, /^Current agent: a2\tagent2\tlane:general\tdefault-repo:X/m);
  assert.match(idleOutput, /^1\. T-2\t.*\tprompt\t/m);
  active = { ID: "T-ACTIVE" };
  assert.equal(pick(), "Current agent a2 (agent2) already owns active doing ticket T-ACTIVE.");
  const ready = captureQueueOutput(() => svc.recommendTickets(filters));
  assert.ok(ready.indexOf("T-1") < ready.indexOf("T-2"), ready);
  assert.match(ready, /T-1/); assert.match(ready, /T-2/);
  assert.doesNotMatch(ready, /T-[3456]/);
  const blocked = captureQueueOutput(() => svc.recommendTickets({ ...filters, includeBlocked: true }));
  assert.match(blocked, /T-3/); assert.doesNotMatch(blocked, /T-[456]/);
  assert.equal(captureQueueOutput(() => svc.recommendTickets({ repo: "X" })), "No matching recommended tickets.");
  assert.equal(captureQueueOutput(() => svc.pickTickets(undefined, { repo: "X" })), "No matching recommended tickets for agent1.");
  assert.throws(() => captureQueueOutput(() => svc.recommendTickets({ ...filters, why: "T-4" })), /not found in the current recommendation candidate set/);
  assert.throws(() => captureQueueOutput(() => svc.pickTickets(undefined, { ...filters, why: "T-4" })), /not found in the current pick candidate set/);
  assert.throws(() => svc.pickTickets("unknown-scope", {}), /Unknown pick scope/);
  assert.throws(() => svc.pickTickets("all", { owner: "agent1" }), /does not accept --owner/);
  assert.throws(() => svc.pickTickets("all", { why: "T-1" }), /does not support --why/);
});
test("COORD-1052: ranked recommendations explain cycles, direct blockers and transitive blockers", () => {
  const scenarios = [
    { cycles: [["T-2", "T-3"]], expected: "blocked by cycle T-2 -> T-3" },
    { blockedBy: ["T-2"], expected: "blocked by T-2" },
    { blockedBy: [], expected: "blocked by dependency state" },
    { blockedBy: ["T-2"], blockerChains: ["T-2 -> T-3"], expected: "blocked by T-2 via T-2 -> T-3" },
    { blockedBy: [], blockerChains: ["T-2 -> T-3"], expected: "blocked by dependency state via T-2 -> T-3" },
  ];
  for (const { expected, ...details } of scenarios) {
    const { svc } = buildService({
      getRows: () => [{ ID: "T-1", Status: "todo", Repo: "B", Pri: "P1", Description: "blocked work" }],
      evaluateReadiness: () => ({ ready: false, deps: [], blockedBy: [], cycles: [], blockerChains: [], ...details }),
      formatDependencyCycleList: (cycles) => cycles[0].join(" -> "),
      formatTransitiveBlockerDetails: (chains) => chains.join(", "),
    });
    const output = captureQueueOutput(() => svc.recommendTickets({ includeBlocked: true }));
    assert.equal(output.split("\n")[1].split("\t")[3], expected);
  }
});

test("COORD-1052: multi-agent picks assign distinct tickets and respect the requested limit", () => {
  const agents = AGENTS.map((agent) => ({ ...agent }));
  let secondRepo = "B";
  let busy = false;
  const { svc } = buildService({
    readAgentsRegistry: () => agents,
    readAgentSessions: sessionsFixture,
    resolveAgentIdentifier: (handle, agents) => ({ agent: agents.find((entry) => entry.handle === handle) }),
    findDoingTicketForOwner: () => busy ? { ID: "ACTIVE", Repo: "B", Pri: "P0", Description: "active work" } : null,
    getRows: () => ["T-1", "T-2"].map((ID) => ({ ID, Status: "todo", Repo: ID === "T-1" ? "B" : secondRepo, Pri: "P1", Description: ID })),
  });
  const picks = (limit) => captureQueueOutput(() => svc.pickTickets("all", { limit }))
    .split("\n").filter((line) => /^\d+\./.test(line)).map((line) => line.split("\t").slice(0, 4));
  assert.deepEqual(picks(2), [
    ["1. a1", "agent1", "mode:general", "-> T-1"],
    ["2. a2", "agent2", "mode:general", "-> T-2"],
  ]);
  assert.deepEqual(picks(1), [["1. a1", "agent1", "mode:general", "-> T-1"]]);
  assert.match(captureQueueOutput(() => svc.pickTickets("all", { repo: "F" })), /No matching recommended tickets/);
  agents[1].lane = "backend";
  assert.deepEqual(picks(1), [["1. a2", "agent2", "mode:backend", "-> T-1"]]);
  agents[0].lane = "frontend";
  secondRepo = "F";
  assert.deepEqual(picks(2), [
    ["1. a2", "agent2", "mode:backend", "-> T-1"],
    ["2. a1", "agent1", "mode:frontend", "-> T-2"],
  ]);
  secondRepo = "X";
  assert.deepEqual(picks(2)[1], ["2. a1", "agent1", "mode:frontend", "-> T-2"]);
  busy = true;
  const unavailable = captureQueueOutput(() => svc.pickTickets("all", {}));
  assert.match(unavailable, /No idle active agents/);
  assert.match(unavailable, /a1\/agent1\s+ACTIVE/);
  assert.match(unavailable, /a2\/agent2\s+ACTIVE/);
  const unclaimed = buildService({ ensureCurrentAgentIdentity: () => { throw new Error("unclaimed"); } });
  assert.match(captureQueueOutput(() => unclaimed.svc.pickTickets("all", {})), /gov claim --owner/);
});
