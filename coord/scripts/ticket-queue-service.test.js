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
