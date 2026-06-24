"use strict";

// COORD-143: tests for the Phase-3 GRAPH-LINK layer (memory-graph.js).
//
// Cover: every real edge type is built correctly (depends-on, deferred-to,
// shared-file, shared-citation, epic); graph expansion pulls graph-adjacent
// decisions (bounded + deterministic); the graph is derived/rebuildable; and
// edges never invent nodes.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const graphMod = require("./memory-graph.js");

const FIX = path.join(__dirname, "__fixtures__", "memory-phase3");
const FIX_OPTS = {
  boardPath: path.join(FIX, "board.json"),
  plansDir: path.join(FIX, "plans"),
  journalPath: path.join(FIX, "governance-events.ndjson"),
};

function buildFixtureGraph() {
  return graphMod.buildGraph(FIX_OPTS);
}

function hasEdge(graph, a, b, relation) {
  return graph.edges.some(
    (e) =>
      ((e.a === a && e.b === b) || (e.a === b && e.b === a)) && e.relation === relation
  );
}

test("graph builds a depends-on edge from the board Depends On column", () => {
  const graph = buildFixtureGraph();
  assert.ok(hasEdge(graph, "GR-001", "GR-002", "depends-on"));
});

test("graph builds a deferred-to edge from requirement_closure.deferred_to_tickets", () => {
  const graph = buildFixtureGraph();
  assert.ok(hasEdge(graph, "GR-001", "GR-003", "deferred-to"));
});

test("graph builds a shared-file edge when two decisions reference the same path", () => {
  const graph = buildFixtureGraph();
  // GR-002 and GR-003 both reference coord/scripts/shared-target.js.
  assert.ok(hasEdge(graph, "GR-002", "GR-003", "shared-file"));
});

test("graph builds a shared-citation edge when two decisions co-mention a third id", () => {
  const graph = buildFixtureGraph();
  // GR-002 and GR-004 both reference GR-009 (which need not be a node itself).
  assert.ok(hasEdge(graph, "GR-002", "GR-004", "shared-citation"));
});

test("graph builds an epic edge between tickets sharing a bracket prefix", () => {
  const graph = buildFixtureGraph();
  // GR-001 + GR-002 share [Graph]; GR-003 + GR-004 share [Other].
  assert.ok(hasEdge(graph, "GR-001", "GR-002", "epic"));
  assert.ok(hasEdge(graph, "GR-003", "GR-004", "epic"));
});

test("every relation type the module declares is exercised by the fixture", () => {
  const graph = buildFixtureGraph();
  const built = new Set(graph.edges.map((e) => e.relation));
  for (const relation of graphMod.RELATIONS) {
    assert.ok(built.has(relation), `relation ${relation} not built`);
  }
});

test("edges never invent a node — every endpoint is a known ticket id", () => {
  const graph = buildFixtureGraph();
  for (const e of graph.edges) {
    assert.ok(graph.nodes.has(e.a), `unknown node ${e.a}`);
    assert.ok(graph.nodes.has(e.b), `unknown node ${e.b}`);
  }
});

test("expand pulls graph-adjacent decisions for a seed, excluding the seed", () => {
  const graph = buildFixtureGraph();
  const adjacent = graphMod.expand(graph, ["GR-001"], { maxHops: 1 });
  const ids = adjacent.map((a) => a.id);
  // 1-hop from GR-001: GR-002 (depends-on/epic) and GR-003 (deferred-to).
  assert.ok(ids.includes("GR-002"));
  assert.ok(ids.includes("GR-003"));
  assert.ok(!ids.includes("GR-001"), "seed must be excluded from its own expansion");
  // Each carries hop distance + the relation it was reached by.
  for (const a of adjacent) {
    assert.equal(a.hops, 1);
    assert.ok(graphMod.RELATIONS.includes(a.relation));
  }
});

test("expand is bounded by maxNodes", () => {
  const graph = buildFixtureGraph();
  const adjacent = graphMod.expand(graph, ["GR-001", "GR-002", "GR-003"], {
    maxHops: 5,
    maxNodes: 1,
  });
  assert.ok(adjacent.length <= 1);
});

test("expand is deterministic — same seeds yield identical output", () => {
  const graph = buildFixtureGraph();
  const a = JSON.stringify(graphMod.expand(graph, ["GR-001"], { maxHops: 2 }));
  const b = JSON.stringify(graphMod.expand(graph, ["GR-001"], { maxHops: 2 }));
  assert.equal(a, b);
});

test("expand returns nothing for an unknown seed (graceful)", () => {
  const graph = buildFixtureGraph();
  assert.deepEqual(graphMod.expand(graph, ["NOPE-999"]), []);
});

test("buildGraph over the real repo produces edges and never crashes", () => {
  // Smoke test against live sources — proves the graph builds over real history.
  const graph = graphMod.buildGraph({});
  assert.ok(graph.nodes.size > 0);
  assert.ok(graph.edges.length > 0);
  // The real [Memory] backlog should connect COORD-139 to COORD-140 (deferred-to).
  if (graph.nodes.has("COORD-139") && graph.nodes.has("COORD-140")) {
    const adj = graphMod.expand(graph, ["COORD-139"], { maxHops: 1, maxNodes: 50 });
    assert.ok(adj.some((a) => a.id === "COORD-140"));
  }
});

test("serializeGraph is deterministic and marks the graph non-authoritative", () => {
  const graph = buildFixtureGraph();
  const a = graphMod.serializeGraph(graph);
  const b = graphMod.serializeGraph(graphMod.buildGraph(FIX_OPTS));
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.equal(parsed.authority, false);
  assert.equal(parsed.kind, "memory-graph");
});
