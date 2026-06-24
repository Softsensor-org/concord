"use strict";

// COORD-143: [Memory] Phase 3 — the GRAPH-LINK layer of the semantic retriever.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 principle 2 ("hybrid retrieval, not
// vector-only") the §6 pipeline is:
//   exact id/path -> BM25 -> vector similarity -> GRAPH LINKS -> recency/status
//   -> source-trust weighting.
// COORD-141 (recall.js) shipped the deterministic id/path + BM25 + provenance
// slice. THIS module adds the deterministic GRAPH-LINK slice: it builds a graph
// over the SAME corpus recall already indexes (decision records + indexed
// files), drawn ENTIRELY FROM REAL EDGES — no model, no external dependency, no
// inference. The edges are facts already present in the governed data:
//
//   1. depends-on    — board "Depends On" column (A depends on B).
//   2. deferred-to   — a decision record's requirement_closure.deferred_to_tickets
//                      (A deferred work forward to B).
//   3. shared-file   — two decisions whose source plan paths, OR whose
//                      implemented/closure text, name the SAME repo file/path.
//   4. shared-citation — two decisions that co-mention the SAME third ticket id
//                      (e.g. both reference COORD-124) — a real "these decisions
//                      talk about the same thing" edge.
//   5. epic          — two tickets sharing the same bracketed "[Epic]" prefix
//                      from the board description (the same grouping
//                      summary-tiers.js rolls up).
//
// All edges are UNDIRECTED for traversal (retrieval just wants "what is
// adjacent"), but the build records the relation type on each edge so the graph
// is auditable. The graph is a DERIVED, REBUILDABLE index (§6 principle 1) — it
// can be deleted and regenerated from the board + decision records + journal; it
// holds NO authority. Its on-disk cache (coord/memory/graph/graph.json) is
// gitignored exactly like decisions.ndjson.
//
// GRAPH EXPANSION (the retrieval value): given a set of seed hits (the ids the
// deterministic/vector passes ranked), `expand()` pulls in graph-adjacent
// decisions up to a bounded hop depth, so a query that hits COORD-139 can also
// surface COORD-140 (its deferred-to child) even when COORD-140 shares few query
// terms. Expansion is bounded + deterministic (BFS in sorted id order) and only
// ever ADDS candidates the ranker then scores — it never reorders the
// deterministic baseline on its own.
//
// ZERO new runtime deps. Reuses decision-extractor for the decision corpus +
// journal provenance + sha1.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_BOARD_PATH = path.join(COORD_DIR, "board", "tasks.json");
const DEFAULT_GRAPH_PATH = path.join(COORD_DIR, "memory", "graph", "graph.json");

const extractor = require("./decision-extractor.js");

const RELATIONS = Object.freeze([
  "depends-on",
  "deferred-to",
  "shared-file",
  "shared-citation",
  "epic",
]);

// --- helpers -----------------------------------------------------------------

function extractTicketIds(text) {
  const ids = String(text || "").match(/\b[A-Z]+-\d+\b/g) || [];
  return [...new Set(ids)];
}

// A repo-ish path token: contains a slash and ends in a known code/doc ext.
function extractPathRefs(text) {
  const out = new Set();
  for (const tok of String(text || "").split(/\s+/)) {
    const t = tok.replace(/[()'",;]/g, "").trim();
    if (t.includes("/") && /\.[a-z0-9]+$/i.test(t)) {
      out.add(t);
    }
  }
  return [...out];
}

function epicOf(description) {
  const match = String(description || "").match(/^\s*\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

// --- board ingestion (depends-on + epic) -------------------------------------
function readBoardTickets(boardPath) {
  if (!fs.existsSync(boardPath)) {
    return [];
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch (error) {
    return [];
  }
  const tickets = [];
  for (const section of Array.isArray(board.sections) ? board.sections : []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) {
      continue;
    }
    for (const row of section.rows) {
      if (!row || typeof row !== "object" || !row.ID) {
        continue;
      }
      tickets.push({
        id: String(row.ID),
        depends_on: extractTicketIds(row["Depends On"]),
        epic: epicOf(row.Description),
      });
    }
  }
  tickets.sort((a, b) => a.id.localeCompare(b.id));
  return tickets;
}

// --- edge construction -------------------------------------------------------
// An edge is { a, b, relation }. We canonicalize each edge so a<b lexically and
// dedup on `${a}|${b}|${relation}`, keeping the graph deterministic + reviewable.
function edgeKey(a, b, relation) {
  return a < b ? `${a}|${b}|${relation}` : `${b}|${a}|${relation}`;
}

function addEdge(edgeMap, a, b, relation) {
  if (!a || !b || a === b) {
    return;
  }
  const key = edgeKey(a, b, relation);
  if (!edgeMap.has(key)) {
    const [x, y] = a < b ? [a, b] : [b, a];
    edgeMap.set(key, { a: x, b: y, relation });
  }
}

// buildGraph: pure function over the board + decision records. Returns
// { nodes:Set, edges:[], adjacency:Map<id, [{id, relation}]> }. Only NODES that
// are real ticket ids (present in the board OR carrying a decision record) are
// kept, so the graph never invents a node.
function buildGraph(options = {}) {
  const boardPath = options.boardPath || DEFAULT_BOARD_PATH;
  const decisions =
    options.decisions ||
    extractor.extractDecisions({
      plansDir: options.plansDir,
      journalPath: options.journalPath,
      rootDir: options.rootDir,
    });

  const tickets = readBoardTickets(boardPath);
  const knownIds = new Set();
  for (const t of tickets) {
    knownIds.add(t.id);
  }
  for (const d of decisions) {
    knownIds.add(d.ticket_id);
  }

  const edgeMap = new Map();

  // (1) depends-on + (5) epic, from the board.
  const epicMembers = new Map(); // epic -> [ids]
  for (const t of tickets) {
    for (const dep of t.depends_on) {
      if (knownIds.has(dep)) {
        addEdge(edgeMap, t.id, dep, "depends-on");
      }
    }
    if (t.epic) {
      if (!epicMembers.has(t.epic)) {
        epicMembers.set(t.epic, []);
      }
      epicMembers.get(t.epic).push(t.id);
    }
  }
  // Epic edges: connect every pair within an epic. Bounded — epics are small
  // groupings; if an epic is pathologically large we still stay O(n^2) over a
  // single small group, which is fine at this corpus scale.
  for (const members of epicMembers.values()) {
    const sorted = [...new Set(members)].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        addEdge(edgeMap, sorted[i], sorted[j], "epic");
      }
    }
  }

  // (2) deferred-to, (3) shared-file, (4) shared-citation, from decisions.
  // First index each decision's path refs + cited ids so shared-* edges are a
  // pairwise intersection over those keys (deterministic, sorted).
  const byPathRef = new Map(); // path -> Set<ticketId>
  const byCitedId = new Map(); // citedId -> Set<ticketId>
  for (const d of decisions) {
    const id = d.ticket_id;
    const rc = d.requirement_closure || {};
    // deferred-to is an explicit forward edge.
    for (const target of rc.deferred_to_tickets || []) {
      if (knownIds.has(target)) {
        addEdge(edgeMap, id, target, "deferred-to");
      }
    }
    // Collect text once: implemented + ticket_ask + invariants + the plan path.
    const text = [
      rc.implemented || "",
      rc.ticket_ask || "",
      rc.not_implemented || "",
      (d.critical_invariants || []).join(" "),
    ].join(" ");
    const paths = new Set(extractPathRefs(text));
    if (d.source && d.source.path) {
      paths.add(d.source.path);
    }
    for (const p of paths) {
      if (!byPathRef.has(p)) {
        byPathRef.set(p, new Set());
      }
      byPathRef.get(p).add(id);
    }
    // Cited ids: any OTHER ticket id mentioned in the decision text (excluding
    // self). The CO-CITED id is the shared subject — it need NOT itself be a
    // known node; the edge is between the two decisions that both mention it
    // (both endpoints ARE known decisions). This captures "these two decisions
    // talk about the same third thing" even when that thing is an external ref.
    const cited = new Set(extractTicketIds(text));
    cited.delete(id);
    for (const c of cited) {
      if (!byCitedId.has(c)) {
        byCitedId.set(c, new Set());
      }
      byCitedId.get(c).add(id);
    }
  }
  // shared-file: tickets that reference the same path.
  for (const ids of byPathRef.values()) {
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        addEdge(edgeMap, sorted[i], sorted[j], "shared-file");
      }
    }
  }
  // shared-citation: tickets that co-mention the same third ticket.
  for (const ids of byCitedId.values()) {
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        addEdge(edgeMap, sorted[i], sorted[j], "shared-citation");
      }
    }
  }

  const edges = [...edgeMap.values()].sort((x, y) =>
    edgeKey(x.a, x.b, x.relation).localeCompare(edgeKey(y.a, y.b, y.relation))
  );

  // Adjacency for traversal (undirected). Sorted neighbor lists keep BFS
  // deterministic.
  const adjacency = new Map();
  const link = (from, to, relation) => {
    if (!adjacency.has(from)) {
      adjacency.set(from, []);
    }
    adjacency.get(from).push({ id: to, relation });
  };
  for (const e of edges) {
    link(e.a, e.b, e.relation);
    link(e.b, e.a, e.relation);
  }
  for (const list of adjacency.values()) {
    list.sort((p, q) => (p.id === q.id ? p.relation.localeCompare(q.relation) : p.id.localeCompare(q.id)));
  }

  return { nodes: knownIds, edges, adjacency };
}

// expand: deterministic bounded BFS. Given seed ids, return the set of
// graph-adjacent ids within `maxHops` (default 1), EXCLUDING the seeds
// themselves. Capped at `maxNodes` newly-discovered ids to keep retrieval
// bounded on a dense graph. Returns ids in sorted order with the hop distance +
// the relation by which each was first reached (for auditability).
function expand(graph, seedIds, options = {}) {
  const maxHops = Number.isInteger(options.maxHops) && options.maxHops > 0 ? options.maxHops : 1;
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 10;
  const seeds = [...new Set(seedIds)].filter((id) => graph.adjacency.has(id));
  const visited = new Set(seedIds);
  const discovered = new Map(); // id -> { id, hops, relation }
  let frontier = [...seeds].sort();
  for (let hop = 1; hop <= maxHops && frontier.length; hop += 1) {
    const next = [];
    for (const id of frontier) {
      const neighbors = graph.adjacency.get(id) || [];
      for (const n of neighbors) {
        if (visited.has(n.id)) {
          continue;
        }
        visited.add(n.id);
        discovered.set(n.id, { id: n.id, hops: hop, relation: n.relation });
        next.push(n.id);
        if (discovered.size >= maxNodes) {
          break;
        }
      }
      if (discovered.size >= maxNodes) {
        break;
      }
    }
    frontier = next.sort();
    if (discovered.size >= maxNodes) {
      break;
    }
  }
  return [...discovered.values()].sort((a, b) =>
    a.hops === b.hops ? a.id.localeCompare(b.id) : a.hops - b.hops
  );
}

// --- derived cache (rebuildable, gitignored) ---------------------------------
function serializeGraph(graph) {
  // Stable shape for the on-disk cache. nodes -> sorted array; edges already
  // sorted. No wall-clock so rebuilds are byte-identical.
  return `${JSON.stringify(
    {
      kind: "memory-graph",
      authority: false,
      nodes: [...graph.nodes].sort(),
      edges: graph.edges,
    },
    null,
    2
  )}\n`;
}

function rebuild(options = {}) {
  const graph = buildGraph(options);
  const outputPath = options.graphPath || DEFAULT_GRAPH_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serializeGraph(graph), "utf8");
  return { outputPath, nodeCount: graph.nodes.size, edgeCount: graph.edges.length };
}

module.exports = {
  RELATIONS,
  extractTicketIds,
  extractPathRefs,
  epicOf,
  readBoardTickets,
  buildGraph,
  expand,
  serializeGraph,
  rebuild,
  DEFAULT_BOARD_PATH,
  DEFAULT_GRAPH_PATH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--rebuild" || cmd === "rebuild") {
    const { outputPath, nodeCount, edgeCount } = rebuild();
    process.stdout.write(
      `Rebuilt ${path.relative(ROOT_DIR, outputPath)} — ${nodeCount} node(s), ${edgeCount} edge(s).\n`
    );
  } else if (cmd === "--print" || cmd === "print") {
    process.stdout.write(serializeGraph(buildGraph({})));
  } else if (cmd === "--expand" || cmd === "expand") {
    const graph = buildGraph({});
    const seeds = args.slice(1).filter((a) => /^[A-Z]+-\d+$/.test(a));
    const out = expand(graph, seeds);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "coord/scripts/memory-graph.js — Phase 3 graph-link layer (COORD-143).",
        "",
        "Usage:",
        "  node coord/scripts/memory-graph.js --rebuild        regenerate coord/memory/graph/graph.json (derived)",
        "  node coord/scripts/memory-graph.js --print          write the derived graph to stdout",
        "  node coord/scripts/memory-graph.js --expand <IDs>   show graph-adjacent ids for the given seed ticket ids",
        "",
        "Edges are built ONLY from REAL governed relations (depends-on, deferred-to,",
        "shared-file, shared-citation, epic). The graph is a DERIVED, REBUILDABLE",
        "index with NO authority; its cache is gitignored like decisions.ndjson.",
        "",
      ].join("\n")
    );
  }
}
