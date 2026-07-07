"use strict";

// COORD-143: tests for the Phase-3 GRAPH-LINK layer (memory-graph.js).
//
// Cover: every real edge type is built correctly (depends-on, deferred-to,
// shared-file, shared-citation, epic); graph expansion pulls graph-adjacent
// decisions (bounded + deterministic); the graph is derived/rebuildable; and
// edges never invent nodes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function derivedLifecycleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-derived-memory-"));
  copyFile(path.join(FIX, "board.json"), path.join(root, "coord", "board", "tasks.json"));
  copyFile(path.join(FIX, "governance-events.ndjson"), path.join(root, "coord", ".runtime", "governance-events.ndjson"));
  for (const name of fs.readdirSync(path.join(FIX, "plans")).sort()) {
    copyFile(path.join(FIX, "plans", name), path.join(root, "coord", ".runtime", "plans", name));
  }
  return root;
}

function snapshotAuthoritativeFixture(root) {
  const files = [
    "coord/board/tasks.json",
    "coord/.runtime/governance-events.ndjson",
    "coord/.runtime/plans/GR-001.json",
    "coord/.runtime/plans/GR-002.json",
    "coord/.runtime/plans/GR-003.json",
    "coord/.runtime/plans/GR-004.json",
  ];
  return Object.fromEntries(files.map((rel) => [rel, fs.readFileSync(path.join(root, rel), "utf8")]));
}

function continuityFixtureOptions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-continuity-seed-"));
  const questionsPath = path.join(root, "coord", "QUESTIONS.md");
  const adrDir = path.join(root, "coord", "docs", "decisions");
  const productDir = path.join(root, "coord", "product");
  const decisionsPath = path.join(root, "coord", "memory", "decisions.ndjson");
  writeFile(questionsPath, "- GR-001 needs human confirmation before broadening scope.\n");
  writeFile(
    path.join(adrDir, "0001-graph-memory.md"),
    "# Graph memory ADR\n\nStatus: Accepted\n\nLinked tickets: GR-001\n\nDecision: keep graph memory derived.\n"
  );
  writeFile(path.join(productDir, "REQUIREMENTS.md"), "# Requirements\n");
  writeFile(path.join(productDir, "CONTINUITY_PROFILE.md"), "# Continuity\n");
  writeFile(decisionsPath, "{\"ticket_id\":\"GR-001\"}\n");
  return {
    rootDir: root,
    boardPath: FIX_OPTS.boardPath,
    plansDir: FIX_OPTS.plansDir,
    journalPath: FIX_OPTS.journalPath,
    questionsPath,
    adrDir,
    productDir,
    decisionsPath,
  };
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

test("expand excludes stale, superseded, and conflicted memory nodes by default", () => {
  const decisions = [
    {
      ticket_id: "TV-001",
      status: "accepted",
      source: { path: "coord/.runtime/plans/TV-001.json" },
      requirement_closure: {
        implemented: "Current rule delegates to TV-STALE TV-SUPERSEDED TV-CONFLICT TV-CURRENT.",
        deferred_to_tickets: ["TV-STALE", "TV-SUPERSEDED", "TV-CONFLICT", "TV-CURRENT"],
      },
    },
    {
      ticket_id: "TV-CURRENT",
      status: "accepted",
      source: { path: "coord/.runtime/plans/TV-CURRENT.json" },
      requirement_closure: { implemented: "Current authoritative memory." },
    },
    {
      ticket_id: "TV-STALE",
      status: "stale",
      source: { path: "coord/.runtime/plans/TV-STALE.json" },
      requirement_closure: { implemented: "Stale memory." },
    },
    {
      ticket_id: "TV-SUPERSEDED",
      status: "accepted",
      superseded_by: "TV-CURRENT",
      source: { path: "coord/.runtime/plans/TV-SUPERSEDED.json" },
      requirement_closure: { implemented: "Superseded memory." },
    },
    {
      ticket_id: "TV-CONFLICT",
      status: "conflicted",
      source: { path: "coord/.runtime/plans/TV-CONFLICT.json" },
      requirement_closure: { implemented: "Conflicted memory." },
    },
  ];
  const graph = graphMod.buildGraph({ boardPath: path.join(FIX, "missing-board.json"), decisions });
  const adjacent = graphMod.expand(graph, ["TV-001"], { maxHops: 1, maxNodes: 10 });
  assert.deepEqual(adjacent.map((item) => item.id), ["TV-CURRENT"]);

  const historical = graphMod.expand(graph, ["TV-001"], {
    maxHops: 1,
    maxNodes: 10,
    excludeStatuses: [],
  });
  assert.deepEqual(
    historical.map((item) => item.id).sort(),
    ["TV-CONFLICT", "TV-CURRENT", "TV-STALE", "TV-SUPERSEDED"].sort()
  );
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

test("serializeGraph records temporal node status as derived metadata", () => {
  const graph = graphMod.buildGraph({
    boardPath: path.join(FIX, "missing-board.json"),
    decisions: [
      {
        ticket_id: "TV-OLD",
        status: "stale",
        source: { path: "coord/.runtime/plans/TV-OLD.json" },
        requirement_closure: { implemented: "Old memory." },
      },
    ],
  });
  const parsed = JSON.parse(graphMod.serializeGraph(graph));
  assert.deepEqual(parsed.node_meta, [{ id: "TV-OLD", status: "stale" }]);
});

test("buildContinuitySeed derives read-only cited facts from existing artifacts", () => {
  const seed = graphMod.buildContinuitySeed(continuityFixtureOptions());
  assert.equal(seed.kind, "continuity_seed");
  assert.equal(seed.authority, false);
  assert.equal(seed.mode, "read_only");
  assert.equal(seed.generated_at, null);
  assert.equal(seed.memory_generation.authority, false);
  assert.equal(seed.index_generation.authority, false);
  assert.equal(seed.counts.boardRows, 4);
  assert.equal(seed.counts.planRecords, 4);
  assert.equal(seed.counts.requirementClosures, 4);
  assert.equal(seed.counts.journalEvents, 1);
  assert.ok(seed.facts.some((fact) => fact.id === "board:GR-001"));
  assert.ok(seed.facts.some((fact) => fact.id === "board:GR-001:epic" && fact.status === "inferred"));
  assert.ok(seed.facts.some((fact) => fact.id === "plan:GR-001:requirement-closure"));
  assert.ok(seed.facts.some((fact) => fact.id === "journal:GR-001"));
  assert.ok(seed.facts.some((fact) => fact.fact_type === "adr"));
  assert.ok(seed.facts.some((fact) => fact.fact_type === "question_reference"));
  for (const fact of seed.facts) {
    assert.ok(["observed", "inferred"].includes(fact.status));
    assert.ok(Array.isArray(fact.sources));
    assert.ok(fact.sources.length > 0, `${fact.id} lacks provenance`);
  }
});

test("buildContinuitySeed is deterministic across reruns", () => {
  const options = continuityFixtureOptions();
  const first = JSON.stringify(graphMod.buildContinuitySeed(options));
  const second = JSON.stringify(graphMod.buildContinuitySeed(options));
  assert.equal(first, second);
});

test("buildContinuitySeed warns and prioritizes missing context for thin history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-continuity-thin-"));
  const boardPath = path.join(root, "coord", "board", "tasks.json");
  writeFile(boardPath, JSON.stringify({
    sections: [
      {
        kind: "table",
        rows: [
          {
            ID: "THIN-001",
            Repo: "X",
            Type: "feature",
            Pri: "P2",
            Status: "todo",
            Owner: "unassigned",
            Description: "[Thin] thin continuity history",
            "Depends On": "",
          },
        ],
      },
    ],
  }, null, 2));
  const seed = graphMod.buildContinuitySeed({
    rootDir: root,
    boardPath,
    plansDir: path.join(root, "coord", ".runtime", "plans"),
    journalPath: path.join(root, "coord", ".runtime", "governance-events.ndjson"),
    questionsPath: path.join(root, "coord", "QUESTIONS.md"),
    adrDir: path.join(root, "coord", "docs", "decisions"),
    productDir: path.join(root, "coord", "product"),
    decisionsPath: path.join(root, "coord", "memory", "decisions.ndjson"),
  });
  assert.equal(seed.sparse_memory_warning, true);
  assert.deepEqual(seed.missing_context.slice(0, 2).map((item) => item.item), [
    "plan records",
    "requirement closure",
  ]);
  assert.equal(seed.missing_context[0].priority, "P0");
});

test("rebuild regenerates derived decisions and graph deterministically without changing authoritative records", () => {
  const root = derivedLifecycleFixture();
  const before = snapshotAuthoritativeFixture(root);
  const first = graphMod.rebuild({ rootDir: root });
  const decisionsPath = path.join(root, "coord", "memory", "decisions.ndjson");
  const graphPath = path.join(root, "coord", "memory", "graph", "graph.json");
  const firstDecisions = fs.readFileSync(decisionsPath, "utf8");
  const firstGraph = fs.readFileSync(graphPath, "utf8");

  const second = graphMod.rebuild({ rootDir: root });
  assert.equal(fs.readFileSync(decisionsPath, "utf8"), firstDecisions);
  assert.equal(fs.readFileSync(graphPath, "utf8"), firstGraph);
  assert.equal(first.decisionCount, 4);
  assert.equal(second.decisionCount, 4);
  assert.equal(first.index_generation.decisions.valid, true);
  assert.equal(first.index_generation.graph.valid, true);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(snapshotAuthoritativeFixture(root), before);
});

test("checkDerivedIndexes returns actionable warnings for missing and corrupt derived indexes", () => {
  const root = derivedLifecycleFixture();
  const missing = graphMod.checkDerivedIndexes({ rootDir: root });
  assert.equal(missing.ok, false);
  assert.ok(missing.warnings.some((w) => w.code === "missing-decisions-index" && /memory rebuild/.test(w.action)));
  assert.ok(missing.warnings.some((w) => w.code === "missing-graph-index" && /memory rebuild/.test(w.action)));

  graphMod.rebuild({ rootDir: root });
  writeFile(path.join(root, "coord", "memory", "graph", "graph.json"), "{not json\n");
  const corrupt = graphMod.checkDerivedIndexes({ rootDir: root });
  assert.equal(corrupt.ok, false);
  assert.ok(corrupt.warnings.some((w) => w.code === "corrupt-graph-index" && /Regenerate/.test(w.action)));
});

test("portable export is classified, source-cited, and carries generation metadata", () => {
  const root = derivedLifecycleFixture();
  graphMod.rebuild({ rootDir: root });
  const bundle = graphMod.buildPortableBundle({ rootDir: root });
  assert.equal(bundle.kind, "concord.derived_memory_export");
  assert.equal(bundle.authority, false);
  assert.equal(bundle.portable, true);
  assert.equal(bundle.memory_generation.chain_head, bundle.index_generation.chain_head);
  assert.ok(bundle.sources.length > 0);
  assert.ok(bundle.sources.every((source) => source.classification));
  assert.ok(bundle.decisions.length >= 4);
  assert.ok(bundle.decisions.every((decision) => decision.source && decision.source.classification));
  assert.equal(bundle.graph.kind, "memory-graph");
  assert.equal(bundle.continuity_seed.authority, false);
});
