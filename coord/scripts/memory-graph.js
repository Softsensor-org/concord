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
const DEFAULT_QUESTIONS_PATH = path.join(COORD_DIR, "QUESTIONS.md");
const DEFAULT_PRODUCT_DIR = path.join(COORD_DIR, "product");
const DEFAULT_ADR_DIR = path.join(COORD_DIR, "docs", "decisions");
const DEFAULT_DECISIONS_PATH = path.join(COORD_DIR, "memory", "decisions.ndjson");

const extractor = require("./decision-extractor.js");
const classification = require("./memory-classification.js");

const RELATIONS = Object.freeze([
  "depends-on",
  "deferred-to",
  "shared-file",
  "shared-citation",
  "epic",
]);
const DEFAULT_EXCLUDED_STATUSES = Object.freeze(["stale", "superseded", "conflicted"]);

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

function decisionStatus(decision) {
  const rc = decision.requirement_closure || {};
  if (decision.superseded_by || rc.superseded_by) {
    return "superseded";
  }
  return decision.status || decision.memory_status || rc.status || rc.memory_status || null;
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

function readBoardRows(boardPath) {
  if (!fs.existsSync(boardPath)) {
    return [];
  }
  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch (error) {
    return [];
  }
  const rows = [];
  for (const section of Array.isArray(board.sections) ? board.sections : []) {
    if (section.kind !== "table" || !Array.isArray(section.rows)) {
      continue;
    }
    for (const row of section.rows) {
      if (!row || typeof row !== "object" || !row.ID) {
        continue;
      }
      rows.push({
        id: String(row.ID),
        repo: String(row.Repo || ""),
        type: String(row.Type || ""),
        priority: String(row.Pri || ""),
        status: String(row.Status || ""),
        owner: String(row.Owner || ""),
        description: String(row.Description || ""),
        depends_on: extractTicketIds(row["Depends On"]),
        epic: epicOf(row.Description),
      });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
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
// { nodes:Set, nodeMeta:Map, edges:[], adjacency:Map<id, [{id, relation}]> }.
// Only NODES that are real ticket ids (present in the board OR carrying a
// decision record) are kept, so the graph never invents a node.
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
  const nodeMeta = new Map();
  for (const t of tickets) {
    knownIds.add(t.id);
    nodeMeta.set(t.id, { id: t.id, status: null });
  }
  for (const d of decisions) {
    knownIds.add(d.ticket_id);
    nodeMeta.set(d.ticket_id, {
      ...(nodeMeta.get(d.ticket_id) || { id: d.ticket_id }),
      status: decisionStatus(d),
    });
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

  return { nodes: knownIds, nodeMeta, edges, adjacency };
}

function statusExcluded(graph, id, excludedStatuses) {
  const status = graph.nodeMeta && graph.nodeMeta.get(id) && graph.nodeMeta.get(id).status;
  return Boolean(status && excludedStatuses.has(status));
}

// expand: deterministic bounded BFS. Given seed ids, return the set of
// graph-adjacent ids within `maxHops` (default 1), EXCLUDING the seeds
// themselves. Capped at `maxNodes` newly-discovered ids to keep retrieval
// bounded on a dense graph. Returns ids in sorted order with the hop distance +
// the relation by which each was first reached (for auditability). COORD-343:
// stale/superseded/conflicted nodes are excluded by default so graph adjacency
// cannot resurrect invalid memory as active semantic context; pass
// { excludeStatuses: [] } for historical/debug expansion.
function expand(graph, seedIds, options = {}) {
  const maxHops = Number.isInteger(options.maxHops) && options.maxHops > 0 ? options.maxHops : 1;
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 10;
  const excludeStatuses = new Set(
    Array.isArray(options.excludeStatuses) ? options.excludeStatuses : DEFAULT_EXCLUDED_STATUSES
  );
  const seeds = [...new Set(seedIds)].filter((id) => graph.adjacency.has(id) && !statusExcluded(graph, id, excludeStatuses));
  const visited = new Set(seedIds);
  const discovered = new Map(); // id -> { id, hops, relation }
  let frontier = [...seeds].sort();
  for (let hop = 1; hop <= maxHops && frontier.length; hop += 1) {
    const next = [];
    for (const id of frontier) {
      const neighbors = graph.adjacency.get(id) || [];
      for (const n of neighbors) {
        if (statusExcluded(graph, n.id, excludeStatuses)) {
          visited.add(n.id);
          continue;
        }
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
      node_meta: [...(graph.nodeMeta || new Map()).values()]
        .filter((node) => node.status)
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: graph.edges,
    },
    null,
    2
  )}\n`;
}

function relPath(filePath, rootDir = ROOT_DIR) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function sourceFor(type, filePath, extra = {}, rootDir = ROOT_DIR) {
  return {
    type,
    path: filePath ? relPath(filePath, rootDir) : null,
    ...extra,
  };
}

function addSeedFact(facts, fact) {
  if (!fact || !fact.statement) {
    return;
  }
  facts.push({
    id: fact.id,
    fact_type: fact.fact_type,
    status: fact.status || "observed",
    statement: fact.statement,
    ticket_id: fact.ticket_id || null,
    sources: Array.isArray(fact.sources) ? fact.sources : [],
  });
}

function normalizePlanArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
}

function readPlanRecordsRaw(plansDir, rootDir = ROOT_DIR) {
  if (!fs.existsSync(plansDir)) {
    return [];
  }
  return fs.readdirSync(plansDir)
    .filter((name) => /^[A-Z]+-\d+\.json$/.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(plansDir, name);
      try {
        return {
          path: filePath,
          rel: relPath(filePath, rootDir),
          record: JSON.parse(fs.readFileSync(filePath, "utf8")),
        };
      } catch (error) {
        return null;
      }
    })
    .filter((entry) => entry && entry.record && typeof entry.record === "object");
}

function readJournalEvents(journalPath, rootDir = ROOT_DIR) {
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const events = [];
  const raw = fs.readFileSync(journalPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed);
      events.push({
        ticket: typeof record.ticket === "string" ? record.ticket : null,
        command: typeof record.command === "string" ? record.command : null,
        event_hash: extractor.sha1(trimmed),
        source: sourceFor("journal", journalPath, { event_hash: extractor.sha1(trimmed) }, rootDir),
      });
    } catch (error) {
      // Malformed scratch journal lines are not continuity facts.
    }
  }
  return events;
}

function readQuestionsFacts(questionsPath, rootDir = ROOT_DIR) {
  if (!fs.existsSync(questionsPath)) {
    return [];
  }
  const raw = fs.readFileSync(questionsPath, "utf8");
  const facts = [];
  const source = sourceFor("questions", questionsPath, {}, rootDir);
  raw.split("\n").forEach((line, index) => {
    const ids = extractTicketIds(line);
    if (!ids.length) {
      return;
    }
    for (const id of ids) {
      facts.push({
        id: `question:${id}:${index + 1}`,
        fact_type: "question_reference",
        status: "observed",
        ticket_id: id,
        statement: `QUESTIONS.md references ${id} on line ${index + 1}.`,
        sources: [{ ...source, line: index + 1 }],
      });
    }
  });
  facts.sort((a, b) => a.id.localeCompare(b.id));
  return facts;
}

function readAdrFacts(adrDir, rootDir = ROOT_DIR) {
  if (!fs.existsSync(adrDir)) {
    return [];
  }
  const facts = [];
  for (const name of fs.readdirSync(adrDir).filter((file) => /^[0-9]{4}-.+\.md$/.test(file)).sort()) {
    const filePath = path.join(adrDir, name);
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      continue;
    }
    const title = raw.split("\n").find((line) => /^#\s+/.test(line)) || name;
    const ids = extractTicketIds(raw);
    addSeedFact(facts, {
      id: `adr:${name}`,
      fact_type: "adr",
      status: "observed",
      statement: `ADR source exists: ${title.replace(/^#\s+/, "").trim()}.`,
      sources: [sourceFor("adr", filePath, { ticket_ids: ids }, rootDir)],
    });
  }
  return facts;
}

function readDocFacts(productDir, rootDir = ROOT_DIR) {
  if (!fs.existsSync(productDir)) {
    return [];
  }
  const canonicalNames = new Set([
    "ARCHITECTURE.md",
    "REQUIREMENTS.md",
    "REQUIREMENTS_ASSURANCE_PLAN.md",
    "REQUIREMENTS_ASSURANCE_PROTOCOL.md",
    "CONTINUITY_PROFILE.md",
    "TESTING_AND_GATES.md",
    "LOCAL_AUTOMATION_AND_GATES.md",
    "REPOS.md",
  ]);
  return fs.readdirSync(productDir)
    .filter((name) => canonicalNames.has(name))
    .sort()
    .map((name) => ({
      id: `doc:${name}`,
      fact_type: "existing_doc",
      status: "observed",
      ticket_id: null,
      statement: `Continuity-relevant product document exists: coord/product/${name}.`,
      sources: [sourceFor("doc", path.join(productDir, name), {}, rootDir)],
    }));
}

function readDecisionIndexFact(decisionsPath, rootDir = ROOT_DIR) {
  if (!fs.existsSync(decisionsPath)) {
    return null;
  }
  const raw = fs.readFileSync(decisionsPath, "utf8");
  const count = raw.split("\n").filter((line) => line.trim()).length;
  return {
    id: "recall:decisions-index",
    fact_type: "known_recall_output",
    status: "observed",
    ticket_id: null,
    statement: `Derived recall decision index exists with ${count} record(s).`,
    sources: [sourceFor("recall", decisionsPath, {}, rootDir)],
  };
}

function fileSha1(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return extractor.sha1(fs.readFileSync(filePath, "utf8"));
}

function readDerivedDecisionRecords(decisionsPath) {
  if (!fs.existsSync(decisionsPath)) {
    return { exists: false, valid: false, records: [], errors: ["derived decisions index is missing"] };
  }
  const records = [];
  const errors = [];
  const raw = fs.readFileSync(decisionsPath, "utf8");
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const record = JSON.parse(trimmed);
      if (!record || !record.ticket_id || !record.source) {
        errors.push(`line ${index + 1}: decision record must include ticket_id and source`);
      } else {
        records.push(record);
      }
    } catch (error) {
      errors.push(`line ${index + 1}: ${error.message}`);
    }
  });
  return { exists: true, valid: errors.length === 0, records, errors };
}

function inspectGraphIndex(graphPath) {
  if (!fs.existsSync(graphPath)) {
    return {
      exists: false,
      valid: false,
      path: graphPath,
      sha1: null,
      node_count: 0,
      edge_count: 0,
      errors: ["derived graph index is missing"],
    };
  }
  const raw = fs.readFileSync(graphPath, "utf8");
  const errors = [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`graph JSON is corrupt: ${error.message}`);
  }
  if (parsed) {
    if (parsed.kind !== "memory-graph") {
      errors.push('graph kind must be "memory-graph"');
    }
    if (parsed.authority !== false) {
      errors.push("graph authority must be false");
    }
    if (!Array.isArray(parsed.nodes)) {
      errors.push("graph nodes must be an array");
    }
    if (!Array.isArray(parsed.edges)) {
      errors.push("graph edges must be an array");
    }
    for (const edge of Array.isArray(parsed.edges) ? parsed.edges : []) {
      if (!edge || !edge.a || !edge.b || !RELATIONS.includes(edge.relation)) {
        errors.push("graph edges must include a, b, and a known relation");
        break;
      }
    }
  }
  return {
    exists: true,
    valid: errors.length === 0,
    path: graphPath,
    sha1: extractor.sha1(raw),
    node_count: parsed && Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
    edge_count: parsed && Array.isArray(parsed.edges) ? parsed.edges.length : 0,
    errors,
  };
}

function buildMemoryGeneration(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const journalPath = options.journalPath || path.join(rootDir, "coord", ".runtime", "governance-events.ndjson");
  const provenance = extractor.indexJournalProvenance(journalPath);
  return {
    schema_version: "memory-generation/v1",
    authority: false,
    deterministic: true,
    chain_head: provenance.chainHead || null,
    source_hashes: {
      board: fileSha1(options.boardPath || path.join(rootDir, "coord", "board", "tasks.json")),
      journal: fileSha1(journalPath),
      questions: fileSha1(options.questionsPath || path.join(rootDir, "coord", "QUESTIONS.md")),
    },
    sources: [
      sourceFor("board", options.boardPath || path.join(rootDir, "coord", "board", "tasks.json"), {}, rootDir),
      sourceFor("plans_dir", options.plansDir || path.join(rootDir, "coord", ".runtime", "plans"), {}, rootDir),
      sourceFor("journal", journalPath, {}, rootDir),
    ],
  };
}

function checkDerivedIndexes(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const decisionsPath = options.decisionsPath || path.join(rootDir, "coord", "memory", "decisions.ndjson");
  const graphPath = options.graphPath || path.join(rootDir, "coord", "memory", "graph", "graph.json");
  const decisionRead = readDerivedDecisionRecords(decisionsPath);
  const graphRead = inspectGraphIndex(graphPath);
  const warnings = [];
  const push = (code, message, action, source) => {
    warnings.push({ code, severity: "warning", message, action, source });
  };
  if (!decisionRead.exists) {
    push(
      "missing-decisions-index",
      `Derived decisions index is missing at ${relPath(decisionsPath, rootDir)}.`,
      "Regenerate derived memory indexes with `coord/scripts/gov memory rebuild` or `node coord/scripts/memory-graph.js rebuild`.",
      sourceFor("recall", decisionsPath, {}, rootDir)
    );
  } else if (!decisionRead.valid) {
    push(
      "corrupt-decisions-index",
      `Derived decisions index is corrupt: ${decisionRead.errors.join("; ")}.`,
      "Delete/regenerate the derived decisions index from plan records and journal; do not edit it by hand.",
      sourceFor("recall", decisionsPath, {}, rootDir)
    );
  }
  if (!graphRead.exists) {
    push(
      "missing-graph-index",
      `Derived graph index is missing at ${relPath(graphPath, rootDir)}.`,
      "Regenerate derived memory indexes with `coord/scripts/gov memory rebuild` or `node coord/scripts/memory-graph.js rebuild`.",
      sourceFor("graph", graphPath, {}, rootDir)
    );
  } else if (!graphRead.valid) {
    push(
      "corrupt-graph-index",
      `Derived graph index is corrupt: ${graphRead.errors.join("; ")}.`,
      "Regenerate the graph from board rows and decision records; do not edit the derived cache by hand.",
      sourceFor("graph", graphPath, {}, rootDir)
    );
  }

  return {
    ok: warnings.length === 0,
    memory_generation: buildMemoryGeneration(options),
    index_generation: {
      schema_version: "memory-index-generation/v1",
      authority: false,
      chain_head: buildMemoryGeneration(options).chain_head,
      decisions: {
        path: relPath(decisionsPath, rootDir),
        exists: decisionRead.exists,
        valid: decisionRead.valid,
        sha1: fileSha1(decisionsPath),
        record_count: decisionRead.records.length,
        errors: decisionRead.errors,
      },
      graph: {
        path: relPath(graphPath, rootDir),
        exists: graphRead.exists,
        valid: graphRead.valid,
        sha1: graphRead.sha1,
        node_count: graphRead.node_count,
        edge_count: graphRead.edge_count,
        errors: graphRead.errors,
      },
      vector: {
        materialized: false,
        reason: "Vector embeddings are provider-supplied or local in-memory signals; no authoritative vector cache is required.",
      },
    },
    warnings,
  };
}

function classifySources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({
    ...source,
    classification: classification.classifySource(source),
  }));
}

function buildPortableBundle(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const decisionsPath = options.decisionsPath || path.join(rootDir, "coord", "memory", "decisions.ndjson");
  const graphPath = options.graphPath || path.join(rootDir, "coord", "memory", "graph", "graph.json");
  const decisionRead = readDerivedDecisionRecords(decisionsPath);
  let graph = null;
  if (fs.existsSync(graphPath)) {
    try {
      graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    } catch (error) {
      graph = null;
    }
  }
  const consistency = checkDerivedIndexes(options);
  const continuitySeed = buildContinuitySeed(options);
  const sources = [
    ...consistency.memory_generation.sources,
    sourceFor("recall", decisionsPath, {}, rootDir),
    sourceFor("graph", graphPath, {}, rootDir),
    ...continuitySeed.sources_read,
  ];
  return {
    kind: "concord.derived_memory_export",
    schema_version: "derived-memory-export/v1",
    authority: false,
    portable: true,
    deterministic: true,
    memory_generation: consistency.memory_generation,
    index_generation: consistency.index_generation,
    warnings: consistency.warnings,
    sources: classifySources(sources).sort((a, b) =>
      `${a.type}:${a.path || ""}:${a.id || ""}`.localeCompare(`${b.type}:${b.path || ""}:${b.id || ""}`)
    ),
    decisions: decisionRead.records.map((record) => ({
      ...record,
      classification: classification.classifySource(record.source || {}),
      source: {
        ...(record.source || {}),
        classification: classification.classifySource(record.source || {}),
      },
    })),
    graph,
    continuity_seed: continuitySeed,
  };
}

function missingContextList(counts) {
  const missing = [];
  const push = (priority, item, reason, source_type) => {
    missing.push({ priority, item, reason, source_type });
  };
  if (counts.boardRows === 0) {
    push("P0", "board rows", "No canonical board rows were readable; warm-start cannot identify active work.", "board");
  }
  if (counts.planRecords === 0) {
    push("P0", "plan records", "No plan records were readable; requirement closure and review history are unavailable.", "plan_record");
  }
  if (counts.requirementClosures === 0) {
    push("P0", "requirement closure", "No non-empty requirement_closure fields were found in plan records.", "plan_record");
  }
  if (counts.selfReviewCycles === 0) {
    push("P1", "self-review cycles", "No self_review_cycles were found; prior risks and review lenses are thin.", "plan_record");
  }
  if (counts.journalEvents === 0) {
    push("P1", "journal events", "No governance journal events were readable; lifecycle provenance is sparse.", "journal");
  }
  if (counts.adrs === 0) {
    push("P1", "ADRs", "No ADR sources were found; durable architecture decisions may be undocumented.", "adr");
  }
  if (counts.questions === 0) {
    push("P2", "questions", "No ticket-linked QUESTIONS.md entries were found; unresolved human decisions may be hidden in chat.", "questions");
  }
  if (counts.contextRefs === 0) {
    push("P2", "context-pack acknowledgements", "No context_pack_ack refs were found in plan records.", "plan_record");
  }
  if (counts.recallOutputs === 0) {
    push("P2", "known recall outputs", "No derived recall decision index was found.", "recall");
  }
  return missing;
}

function buildContinuitySeed(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const boardPath = options.boardPath || path.join(rootDir, "coord", "board", "tasks.json");
  const plansDir = options.plansDir || path.join(rootDir, "coord", ".runtime", "plans");
  const journalPath = options.journalPath || path.join(rootDir, "coord", ".runtime", "governance-events.ndjson");
  const questionsPath = options.questionsPath || path.join(rootDir, "coord", "QUESTIONS.md");
  const adrDir = options.adrDir || path.join(rootDir, "coord", "docs", "decisions");
  const productDir = options.productDir || path.join(rootDir, "coord", "product");
  const decisionsPath = options.decisionsPath || path.join(rootDir, "coord", "memory", "decisions.ndjson");

  const rows = readBoardRows(boardPath);
  const planEntries = readPlanRecordsRaw(plansDir, rootDir);
  const decisions = options.decisions || extractor.extractDecisions({ plansDir, journalPath, rootDir });
  const journalEvents = readJournalEvents(journalPath, rootDir);
  const facts = [];

  for (const row of rows) {
    const source = sourceFor("board", boardPath, { id: row.id }, rootDir);
    addSeedFact(facts, {
      id: `board:${row.id}`,
      fact_type: "board_row",
      status: "observed",
      ticket_id: row.id,
      statement: `${row.id} is a ${row.priority || "unprioritized"} ${row.type || "ticket"} in ${row.status || "unknown"} status.`,
      sources: [source],
    });
    if (row.depends_on.length) {
      addSeedFact(facts, {
        id: `board:${row.id}:depends-on`,
        fact_type: "dependency",
        status: "observed",
        ticket_id: row.id,
        statement: `${row.id} depends on ${row.depends_on.join(", ")}.`,
        sources: [source],
      });
    }
    if (row.epic) {
      addSeedFact(facts, {
        id: `board:${row.id}:epic`,
        fact_type: "epic_grouping",
        status: "inferred",
        ticket_id: row.id,
        statement: `${row.id} appears in the "${row.epic}" board grouping inferred from the description prefix.`,
        sources: [source],
      });
    }
  }

  for (const entry of planEntries) {
    const record = entry.record;
    const ticketId = String(record.ticket_id || path.basename(entry.path, ".json"));
    const source = sourceFor("plan_record", entry.path, { id: ticketId }, rootDir);
    const closures = normalizePlanArray(record.requirement_closure);
    if (closures.length) {
      addSeedFact(facts, {
        id: `plan:${ticketId}:requirement-closure`,
        fact_type: "requirement_closure",
        status: "observed",
        ticket_id: ticketId,
        statement: `${ticketId} has ${closures.length} requirement-closure entr${closures.length === 1 ? "y" : "ies"}.`,
        sources: [source],
      });
    }
    const cycles = Array.isArray(record.self_review_cycles) ? record.self_review_cycles : [];
    if (cycles.length) {
      addSeedFact(facts, {
        id: `plan:${ticketId}:self-review`,
        fact_type: "self_review",
        status: "observed",
        ticket_id: ticketId,
        statement: `${ticketId} has ${cycles.length} self-review cycle(s).`,
        sources: [source],
      });
    }
    const contextRefs = normalizePlanArray(record.context_pack_ack?.refs);
    if (contextRefs.length) {
      addSeedFact(facts, {
        id: `plan:${ticketId}:context-pack`,
        fact_type: "context_pack_ack",
        status: "observed",
        ticket_id: ticketId,
        statement: `${ticketId} acknowledges context-pack refs: ${contextRefs.join(", ")}.`,
        sources: [source],
      });
    }
  }

  for (const decision of decisions) {
    const rc = decision.requirement_closure || {};
    if (rc.present || rc.implemented || rc.ticket_ask) {
      addSeedFact(facts, {
        id: `decision:${decision.ticket_id}`,
        fact_type: "decision_record",
        status: "observed",
        ticket_id: decision.ticket_id,
        statement: `${decision.ticket_id} has a derived decision record from requirement closure.`,
        sources: [decision.source || sourceFor("decision", null, { id: decision.ticket_id }, rootDir)],
      });
    }
  }

  const journalByTicket = new Map();
  for (const event of journalEvents) {
    if (!event.ticket) {
      continue;
    }
    journalByTicket.set(event.ticket, (journalByTicket.get(event.ticket) || 0) + 1);
  }
  for (const [ticketId, count] of [...journalByTicket.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    addSeedFact(facts, {
      id: `journal:${ticketId}`,
      fact_type: "journal_activity",
      status: "observed",
      ticket_id: ticketId,
      statement: `${ticketId} has ${count} governance journal event(s).`,
      sources: journalEvents.filter((event) => event.ticket === ticketId).map((event) => event.source),
    });
  }

  for (const fact of readQuestionsFacts(questionsPath, rootDir)) addSeedFact(facts, fact);
  for (const fact of readAdrFacts(adrDir, rootDir)) addSeedFact(facts, fact);
  for (const fact of readDocFacts(productDir, rootDir)) addSeedFact(facts, fact);
  const decisionIndexFact = readDecisionIndexFact(decisionsPath, rootDir);
  if (decisionIndexFact) addSeedFact(facts, decisionIndexFact);

  const counts = {
    boardRows: rows.length,
    planRecords: planEntries.length,
    requirementClosures: planEntries.filter((entry) => normalizePlanArray(entry.record.requirement_closure).length > 0).length,
    selfReviewCycles: planEntries.reduce((sum, entry) => sum + (Array.isArray(entry.record.self_review_cycles) ? entry.record.self_review_cycles.length : 0), 0),
    journalEvents: journalEvents.length,
    adrs: facts.filter((fact) => fact.fact_type === "adr").length,
    questions: facts.filter((fact) => fact.fact_type === "question_reference").length,
    docs: facts.filter((fact) => fact.fact_type === "existing_doc").length,
    contextRefs: facts.filter((fact) => fact.fact_type === "context_pack_ack").length,
    recallOutputs: decisionIndexFact ? 1 : 0,
  };
  const missing = missingContextList(counts);
  const derived = checkDerivedIndexes(options);

  return {
    kind: "continuity_seed",
    schema_version: "continuity-seed/v1",
    authority: false,
    mode: "read_only",
    deterministic: true,
    generated_at: null,
    memory_generation: derived.memory_generation,
    index_generation: derived.index_generation,
    sources_read: [
      sourceFor("board", boardPath, {}, rootDir),
      sourceFor("plans_dir", plansDir, {}, rootDir),
      sourceFor("journal", journalPath, {}, rootDir),
      sourceFor("questions", questionsPath, {}, rootDir),
      sourceFor("adr_dir", adrDir, {}, rootDir),
      sourceFor("product_dir", productDir, {}, rootDir),
      sourceFor("recall", decisionsPath, {}, rootDir),
    ],
    counts,
    sparse_memory_warning: missing.length > 0,
    missing_context: missing,
    facts: facts.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function rebuild(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const decisionsPath = options.decisionsPath || path.join(rootDir, "coord", "memory", "decisions.ndjson");
  const decisionResult = extractor.rebuild({
    rootDir,
    plansDir: options.plansDir || path.join(rootDir, "coord", ".runtime", "plans"),
    journalPath: options.journalPath || path.join(rootDir, "coord", ".runtime", "governance-events.ndjson"),
    outputPath: decisionsPath,
  });
  const graph = buildGraph({
    ...options,
    rootDir,
    boardPath: options.boardPath || path.join(rootDir, "coord", "board", "tasks.json"),
    decisions: extractor.extractDecisions({
      rootDir,
      plansDir: options.plansDir || path.join(rootDir, "coord", ".runtime", "plans"),
      journalPath: options.journalPath || path.join(rootDir, "coord", ".runtime", "governance-events.ndjson"),
    }),
  });
  const outputPath = options.graphPath || path.join(rootDir, "coord", "memory", "graph", "graph.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serializeGraph(graph), "utf8");
  const consistency = checkDerivedIndexes({ ...options, rootDir, decisionsPath, graphPath: outputPath });
  return {
    outputPath,
    graphPath: outputPath,
    decisionsPath,
    decisionCount: decisionResult.count,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    memory_generation: consistency.memory_generation,
    index_generation: consistency.index_generation,
    warnings: consistency.warnings,
  };
}

module.exports = {
  RELATIONS,
  DEFAULT_EXCLUDED_STATUSES,
  extractTicketIds,
  extractPathRefs,
  epicOf,
  decisionStatus,
  readBoardTickets,
  buildGraph,
  expand,
  serializeGraph,
  rebuild,
  readBoardRows,
  buildContinuitySeed,
  buildMemoryGeneration,
  checkDerivedIndexes,
  buildPortableBundle,
  readDerivedDecisionRecords,
  inspectGraphIndex,
  missingContextList,
  DEFAULT_BOARD_PATH,
  DEFAULT_GRAPH_PATH,
  DEFAULT_QUESTIONS_PATH,
  DEFAULT_PRODUCT_DIR,
  DEFAULT_ADR_DIR,
  DEFAULT_DECISIONS_PATH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "--rebuild" || cmd === "rebuild") {
    const { outputPath, decisionsPath, decisionCount, nodeCount, edgeCount } = rebuild();
    process.stdout.write(
      `Rebuilt ${path.relative(ROOT_DIR, decisionsPath)} — ${decisionCount} decision record(s).\n` +
      `Rebuilt ${path.relative(ROOT_DIR, outputPath)} — ${nodeCount} node(s), ${edgeCount} edge(s).\n`
    );
  } else if (cmd === "--doctor" || cmd === "doctor" || cmd === "check") {
    process.stdout.write(`${JSON.stringify(checkDerivedIndexes({}), null, 2)}\n`);
  } else if (cmd === "--export" || cmd === "export") {
    process.stdout.write(`${JSON.stringify(buildPortableBundle({}), null, 2)}\n`);
  } else if (cmd === "--print" || cmd === "print") {
    process.stdout.write(serializeGraph(buildGraph({})));
  } else if (cmd === "--expand" || cmd === "expand") {
    const graph = buildGraph({});
    const seeds = args.slice(1).filter((a) => /^[A-Z]+-\d+$/.test(a));
    const out = expand(graph, seeds);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (cmd === "--continuity-seed" || cmd === "continuity-seed") {
    process.stdout.write(`${JSON.stringify(buildContinuitySeed({}), null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "coord/scripts/memory-graph.js — Phase 3 graph-link layer (COORD-143).",
        "",
        "Usage:",
        "  node coord/scripts/memory-graph.js --rebuild        regenerate derived decisions + graph indexes",
        "  node coord/scripts/memory-graph.js doctor           check derived indexes for missing/corrupt caches",
        "  node coord/scripts/memory-graph.js export           print a portable classified/source-cited bundle",
        "  node coord/scripts/memory-graph.js --print          write the derived graph to stdout",
        "  node coord/scripts/memory-graph.js --expand <IDs>   show graph-adjacent ids for the given seed ticket ids",
        "  node coord/scripts/memory-graph.js continuity-seed   print a read-only initial continuity seed",
        "",
        "Edges are built ONLY from REAL governed relations (depends-on, deferred-to,",
        "shared-file, shared-citation, epic). The graph is a DERIVED, REBUILDABLE",
        "index with NO authority; its cache is gitignored like decisions.ndjson.",
        "",
      ].join("\n")
    );
  }
}
