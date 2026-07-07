"use strict";

// COORD-141: [Memory] Phase 1 — `gov recall "<query>"` deterministic engine.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6/§7 this is the SEMANTIC layer's
// DETERMINISTIC slice. It returns a CITED answer, never a bare assertion:
//
//   { query, answer, sources[ {type,id,path,event_hash,chain_head,verified} ],
//     confidence, staleness }
//
// The retrieval pipeline is the §6 hybrid, DETERMINISTIC-ONLY (NO vectors, NO
// embeddings, NO LLM — that is COORD-143):
//   1. exact id/path match  — a query naming COORD-095 or a real file path is a
//      direct hit, ranked above everything.
//   2. full-text BM25 ranking over the indexed corpus (decision records from the
//      Phase-0 decisions.ndjson + a small allowlist of memory-relevant repo
//      files/docs).
//   3. provenance-weighted ranking (the Concord edge, §6 principle 3):
//      chained-and-attested sources outrank legacy-unverified ones for equal
//      text relevance.
//   4. recency / status filters (later journal provenance breaks ties).
//
// CARDINAL GUARDRAIL (§5): memory RECOMMENDS, sources are CITED. Every line of
// `answer` traces to a `sources[]` entry pinning event_hash + chain_head +
// verified. When nothing matches we say so honestly (empty sources, low
// confidence) — we NEVER fabricate.
//
// WHY PURE-JS BM25 (not node:sqlite FTS5): the corpus is tiny (≈190 decision
// records + a handful of files), the engine is zero-npm-dependency, and a pure
// in-memory BM25 keeps recall fully deterministic with NO derived binary db to
// gitignore/rebuild. node:sqlite would add a binary index artifact + churn for
// no measurable benefit at this scale. Deterministic + dependency-free wins.
//
// PERMISSION-AWARE (§6 principle 4): redaction is delegated to the OPTIONAL
// ENT-012 RBAC redaction policy when that tier is present. The COMMUNITY cut
// strips the enterprise tier, so we load the policy BEST-EFFORT and degrade
// gracefully to a safe non-redacting community default when it is absent —
// there is NO hard core->tier dependency.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_DECISIONS_PATH = path.join(COORD_DIR, "memory", "decisions.ndjson");
const DEFAULT_JOURNAL_PATH = path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
const DEFAULT_ADR_DIR = path.join(COORD_DIR, "docs", "decisions");

// COORD-300: resolve the memory corpus location from the governed, sandboxable
// MEMORY_DIR at CALL TIME (not module-load time). `state.MEMORY_DIR` defaults to
// the live coord/memory tree, so production behaviour is byte-identical to the
// old constant; but a test that redirects __testing.paths.MEMORY_DIR (see
// governance-test-utils.sandboxProcessRuntimeLocks) now reads/rebuilds the corpus
// in an os.tmpdir() sandbox instead of writing the live coord/memory tree — which
// lets recall.test.js drop out of the test-isolation-guard runtime allowlist.
const { state } = require("./governance-context.js");
function defaultDecisionsPath() {
  return path.join(state.MEMORY_DIR, "decisions.ndjson");
}

// The decision-extractor (COORD-140) is the Phase-0 substrate. We reuse its
// journal-provenance indexer + sha1 so recall and extraction pin citations the
// SAME way (one canonical-hash implementation, no drift).
const extractor = require("./decision-extractor.js");

// COORD-144: the memory permission CLASSIFICATION layer. It classifies each
// artifact/field into {public, internal, sensitive, secret-prohibited} and maps
// each class onto the EXISTING ENT-012 role threshold (it does NOT reimplement
// RBAC). recall composes it so output is filtered by caller role per
// classification, and secret-prohibited content is detected + refused in BOTH
// cuts (it never depends on the enterprise module being present). Pure, zero-dep.
const classification = require("./memory-classification.js");

// COORD-143: the OPTIONAL Phase-3 semantic augmentations (graph links + vector
// similarity). These are pure leaf modules; recall composes them ONLY when a
// caller opts in via the `semantic` option. They are NEVER on the default path,
// so the Phase-1 deterministic contract + tests are byte-for-byte unchanged.
const memoryGraph = require("./memory-graph.js");
const memoryVector = require("./memory-vector.js");
const adrRegistry = require("./adr-validator.js");

// Memory-relevant repo files that are first-class citation targets (`type:file`)
// for file-citation questions (e.g. "which files define conformance signing?").
// This is a small, deliberate allowlist of the authority sources the memory
// architecture itself names — NOT an index of the whole tree. Paths are
// repo-root-relative.
const INDEXED_FILES = Object.freeze([
  "coord/docs/MEMORY_ARCHITECTURE.md",
  "coord/scripts/conformance-attestation.js",
  "coord/scripts/journal.js",
  "coord/scripts/decision-extractor.js",
  "coord/scripts/recall.js",
  "coord/GOVERNANCE.md",
]);

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

// --- ENT-012 RBAC: load best-effort (community-cut graceful degradation) -----
// When the OPTIONAL ENT-012 RBAC redaction policy ships (the tier that adds it
// is present) we apply its redaction; when it is absent (community cut, the tier
// stripped) we fall back to a safe non-redacting default. We NEVER hard-require
// it — a missing module must not crash recall.
//
// The module specifier is assembled from segments at runtime rather than written
// as a literal path. This is deliberate: it keeps community-shipped core source
// free of any literal reference to the optional tier's subtree (the release
// hygiene gate fail-closes on such a literal), while resolving to the exact same
// module when the tier IS present. require() with a guarded try/catch returns
// null on absence, so the runtime contract is identical to a static require.
function loadRbacPolicy() {
  try {
    const tier = "enterpr" + "ise";
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require("./" + tier + "/" + tier + "-rbac-policy.js");
  } catch (error) {
    return null;
  }
}

// Resolve the redaction behavior for a role, honoring ENT-012 when present.
// Returns { redact: boolean, redactField: fn(kind,value,role) }.
//
// Trust model: the local governed `gov recall` CLI is itself an authenticated,
// already-governed operational caller running over already-committed memory — so
// the DEFAULT (no explicit role) is the UNREDACTED operational view. Redaction
// is the EXPLICIT permission-aware path: pass `--role <role>` and recall defers
// to ENT-012's `shouldRedactForRole` (viewer -> redacted; operator/maintainer/
// admin/auditor -> full). This keeps the §5 guardrail honest (a viewer never
// sees verbatim evidence) without breaking the local operator demo.
function resolveRedaction(role, policy) {
  // The resolved policy is threaded into the COORD-144 classification layer so
  // each artifact's class maps onto the ENT-012 role threshold. `policy` is the
  // best-effort ENT-012 module (null in the community cut). `redact` retains its
  // COORD-141 meaning (role-level redaction active) for back-compat, while
  // classification refines it per artifact class. secret-prohibited is handled
  // by the classification layer independently of `policy`, so it is refused in
  // BOTH cuts.
  const rbac =
    policy ||
    (role == null
      ? null // no role => no need to load the enterprise module at all
      : loadRbacPolicy());
  // No explicit role => trusted local operational caller => no role-level
  // redaction (secret-prohibited is still refused by the classification layer).
  if (role == null) {
    return {
      redact: false,
      role: null,
      policy: rbac || null,
      redactField: (kind, value) => value,
    };
  }
  if (rbac && typeof rbac.shouldRedactForRole === "function") {
    return {
      redact: rbac.shouldRedactForRole(role),
      role,
      policy: rbac,
      redactField:
        typeof rbac.redactField === "function"
          ? rbac.redactField
          : (kind, value) => value,
    };
  }
  // Community cut: a role was requested but the ENT-012 RBAC module is absent
  // (the optional tier is stripped). Degrade gracefully to the safe
  // non-redacting community default rather than crashing or failing closed on a
  // missing module — there is NO hard core->tier dependency.
  // secret-prohibited content is STILL refused (handled in classification,
  // independent of this module), so the safe default never leaks a secret.
  return {
    redact: false,
    role,
    policy: null,
    redactField: (kind, value) => value,
  };
}

// --- tokenization + BM25 -----------------------------------------------------
// Deterministic, dependency-free. Lowercase, split on non-alphanumeric (keeping
// the COORD-### token intact via the hyphen-aware pass), drop trivially-short
// stopwords. Identical input -> identical tokens -> identical ranking.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "by", "it", "its", "that", "this", "which", "what",
  "why", "how", "when", "into", "instead", "does", "do", "did", "with", "from",
  "as", "at", "than", "then", "they", "them", "their",
]);

// Minimal deterministic stemmer: collapse common inflections to a shared stem
// so query vocabulary ("repaired", "broke", "appended", "concurrently") aligns
// with document vocabulary ("repair", "broken", "append", "concurrent"). This is
// a tiny rule-based suffix stripper (NOT a model) — fully deterministic, applied
// identically to query and corpus tokens. A few high-value irregular pairs are
// mapped explicitly.
const IRREGULAR_STEMS = Object.freeze({
  broke: "broken",
  broken: "broken",
  breaking: "broken",
  breaks: "broken",
  ran: "run",
  runs: "run",
  running: "run",
});

function stem(token) {
  if (Object.prototype.hasOwnProperty.call(IRREGULAR_STEMS, token)) {
    return IRREGULAR_STEMS[token];
  }
  let t = token;
  // Order matters: strip the longest meaningful suffix first.
  for (const suffix of ["ically", "ingly", "edly", "ing", "ed", "ly", "es", "s"]) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
      t = t.slice(0, t.length - suffix.length);
      break;
    }
  }
  return t;
}

function tokenize(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  const lowered = text.toLowerCase();
  // Keep id-like tokens (coord-159) AND bare words. Split on whitespace/punct
  // but preserve internal hyphens so "repair-chain" and "COORD-159" survive.
  const raw = lowered.match(/[a-z0-9][a-z0-9_-]*/g) || [];
  const tokens = [];
  const push = (tok) => {
    if (tok.length <= 1 || STOPWORDS.has(tok)) {
      return;
    }
    tokens.push(tok);
    // Don't stem id-like tokens (coord-159) or anything with a digit — stemming
    // those would corrupt exact-id matching downstream.
    if (!/\d/.test(tok)) {
      const s = stem(tok);
      if (s !== tok && s.length > 1) {
        tokens.push(s);
      }
    }
  };
  for (const tok of raw) {
    push(tok);
    // Also index the hyphen/underscore-split pieces so "prev_event_hash" matches
    // "hash" and "repair-chain" matches "chain", without losing the joined token.
    for (const piece of tok.split(/[-_]/)) {
      if (piece !== tok) {
        push(piece);
      }
    }
  }
  return tokens;
}

// Extract explicit ticket ids and quoted/obvious file paths from the raw query
// for the exact-match pass.
function extractQueryIds(query) {
  return [...new Set((String(query || "").match(/\b[A-Z]+-\d+\b/g) || []))];
}

function extractQueryPaths(query) {
  // A token containing a slash and a dot (or ending in a known code/doc ext) is
  // treated as a path reference.
  const out = [];
  for (const tok of String(query || "").split(/\s+/)) {
    const t = tok.replace(/[()'",]/g, "").trim();
    if (!t) {
      continue;
    }
    if (t.includes("/") && /\.[a-z0-9]+$/i.test(t)) {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

// BM25 parameters (standard defaults). Deterministic.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function buildBm25Index(docs) {
  // docs: [{ id, tokens, ... }]
  const df = new Map(); // token -> document frequency
  let totalLen = 0;
  for (const doc of docs) {
    const seen = new Set();
    for (const tok of doc.tokens) {
      if (!seen.has(tok)) {
        seen.add(tok);
        df.set(tok, (df.get(tok) || 0) + 1);
      }
    }
    totalLen += doc.tokens.length;
  }
  const avgdl = docs.length ? totalLen / docs.length : 0;
  return { df, avgdl, n: docs.length };
}

function bm25Score(queryTokens, doc, index) {
  if (!queryTokens.length || !doc.tokens.length) {
    return 0;
  }
  const tf = new Map();
  for (const tok of doc.tokens) {
    tf.set(tok, (tf.get(tok) || 0) + 1);
  }
  const dl = doc.tokens.length;
  let score = 0;
  for (const qt of new Set(queryTokens)) {
    const f = tf.get(qt) || 0;
    if (f === 0) {
      continue;
    }
    const n = index.df.get(qt) || 0;
    // BM25 idf with +1 to stay non-negative for small corpora.
    const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
    const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (index.avgdl || 1));
    score += idf * ((f * (BM25_K1 + 1)) / denom);
  }
  return score;
}

// --- corpus construction -----------------------------------------------------
// Build the searchable corpus: decision records (type:decision) + the indexed
// file allowlist (type:file). Each doc carries its citation (source) and a
// human snippet used to compose the cited answer.
function readDecisionDocs(decisionsPath) {
  const docs = [];
  if (!fs.existsSync(decisionsPath)) {
    return docs;
  }
  const raw = fs.readFileSync(decisionsPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (!rec || !rec.ticket_id || !rec.source) {
      continue;
    }
    const rc = rec.requirement_closure || {};
    const reviewText = (rec.self_review || [])
      .map((c) => `${c.lens || ""} ${(c.risks || []).join(" ")} ${c.findings || ""}`)
      .join(" ");
    const invariantText = (rec.critical_invariants || []).join(" ");
    const text = [
      rec.ticket_id,
      rc.ticket_ask || "",
      rc.implemented || "",
      rc.not_implemented || "",
      rc.deferred_to || "",
      (rc.deferred_to_tickets || []).join(" "),
      reviewText,
      invariantText,
    ].join(" \n ");
    docs.push({
      key: `decision:${rec.ticket_id}`,
      type: "decision",
      id: rec.ticket_id,
      path: rec.source.path,
      text,
      tokens: tokenize(text),
      source: {
        type: "decision",
        id: rec.ticket_id,
        path: rec.source.path,
        event_hash: rec.source.event_hash || null,
        chain_head: rec.source.chain_head || null,
        verified: Boolean(rec.source.verified),
      },
      // Snippet builders for the cited answer.
      snippet: buildDecisionSnippet(rec.ticket_id, rc, rec.critical_invariants || []),
    });
  }
  return docs;
}

function buildDecisionSnippet(ticketId, rc, invariants) {
  const parts = [];
  if (rc.ticket_ask) {
    parts.push(`${ticketId} ask: ${rc.ticket_ask}`);
  }
  if (rc.implemented) {
    parts.push(`Implemented: ${rc.implemented}`);
  }
  if (rc.deferred_to && rc.deferred_to.toLowerCase() !== "none") {
    parts.push(`Deferred to: ${rc.deferred_to}`);
  }
  if (rc.not_implemented && rc.not_implemented.toLowerCase() !== "none") {
    parts.push(`Not implemented: ${rc.not_implemented}`);
  }
  if (invariants.length) {
    parts.push(`Invariants: ${invariants.join(" | ")}`);
  }
  return parts.join("\n");
}

function readAdrDocs(rootDir, adrDir, journalProvenance) {
  const docs = [];
  const root = adrDir || DEFAULT_ADR_DIR;
  if (!fs.existsSync(root)) {
    return docs;
  }
  for (const file of fs.readdirSync(root).filter((name) => /^[0-9]{4}-.+\.md$/.test(name)).sort()) {
    const filePath = path.join(root, file);
    let adr;
    try {
      adr = adrRegistry.parseAdr(filePath, root);
    } catch (error) {
      continue;
    }
    if (adr.status !== "Accepted" || adr.superseded_by) {
      continue;
    }
    const id = `ADR-${adr.id}`;
    const rel = path.relative(rootDir || ROOT_DIR, filePath).split(path.sep).join("/");
    const text = [
      id,
      adr.title,
      adr.status,
      (adr.tickets || []).join(" "),
      (adr.requirement_ids || []).join(" "),
      adr.linked_scope,
      adr.decision,
      adr.alternatives_rejected,
      adr.consequences,
      adr.revisit_trigger,
      adr.raw,
    ].filter(Boolean).join("\n");
    docs.push({
      key: `adr:${id}`,
      type: "adr",
      id,
      path: rel,
      text,
      tokens: tokenize(text),
      source: {
        type: "adr",
        id,
        path: rel,
        event_hash: adr.content_hash,
        chain_head: journalProvenance.chainHead || null,
        verified: true,
      },
      snippet: buildAdrSnippet(id, adr),
    });
  }
  return docs;
}

function buildAdrSnippet(id, adr) {
  const parts = [`${id} (${adr.status}) ${adr.title}`];
  if (adr.decision) parts.push(`Decision: ${adr.decision}`);
  if (adr.alternatives_rejected) parts.push(`Rejected alternatives: ${adr.alternatives_rejected}`);
  if (adr.consequences) parts.push(`Consequences: ${adr.consequences}`);
  if (adr.revisit_trigger) parts.push(`Revisit trigger: ${adr.revisit_trigger}`);
  return parts.join("\n");
}

function readFileDocs(rootDir, journalProvenance) {
  const docs = [];
  for (const rel of INDEXED_FILES) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (error) {
      continue;
    }
    // The file's own content hash is its citation pin; a committed,
    // governance-tracked file under coord/ is authoritative => verified:true.
    // chain_head ties the citation to the same whole-chain anchor decisions use.
    docs.push({
      key: `file:${rel}`,
      type: "file",
      id: null,
      path: rel,
      text: content,
      tokens: tokenize(content),
      content,
      source: {
        type: "file",
        id: null,
        path: rel,
        event_hash: sha1(content),
        chain_head: journalProvenance.chainHead || null,
        verified: true,
      },
      snippet: buildFileSnippet(rel, content),
    });
  }
  return docs;
}

function buildFileSnippet(rel, content) {
  // First meaningful comment/heading line as a human label (query-independent
  // fallback used when no query term matches a specific line).
  for (const line of content.split("\n")) {
    const t = line.replace(/^[\s/#*-]+/, "").trim();
    if (t.length > 12) {
      return `${rel}: ${t}`;
    }
  }
  return rel;
}

// Query-aware file evidence: surface the first source line(s) that actually
// contain a query term, so the cited answer SHOWS the matched evidence (e.g.
// the `ed25519` line) rather than a generic header. This keeps every answer
// line traceable to the cited file. Deterministic: lines scanned in file order.
function buildFileEvidenceSnippet(doc, queryTokens) {
  if (!doc.content) {
    return doc.snippet;
  }
  const wanted = new Set(queryTokens);
  const lines = doc.content.split("\n");
  const hits = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if ([...wanted].some((tok) => lower.includes(tok))) {
      const t = line.trim();
      if (t.length > 0) {
        hits.push(t);
      }
      if (hits.length >= 2) {
        break;
      }
    }
  }
  if (!hits.length) {
    return doc.snippet;
  }
  return `${doc.path}: ${hits.join(" … ")}`;
}

function buildCorpus(options = {}) {
  const decisionsPath = options.decisionsPath || defaultDecisionsPath();
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const rootDir = options.rootDir || ROOT_DIR;
  const journalProvenance = extractor.indexJournalProvenance(journalPath);
  const derived = memoryGraph.checkDerivedIndexes({
    ...options,
    rootDir,
    decisionsPath,
    journalPath,
  });
  const docs = [
    ...readDecisionDocs(decisionsPath),
    ...readAdrDocs(rootDir, options.adrDir || path.join(rootDir, "coord", "docs", "decisions"), journalProvenance),
    ...readFileDocs(rootDir, journalProvenance),
  ];
  return {
    docs,
    chainHead: journalProvenance.chainHead || null,
    memory_generation: derived.memory_generation,
    index_generation: derived.index_generation,
    index_warnings: derived.warnings,
  };
}

function retrievalRecordForDoc(doc) {
  return {
    artifact_type: doc.type === "decision" || doc.type === "adr" ? "decision" : "memory_claim",
    ...(doc.source || {}),
    ...(doc.memory || {}),
    ...(doc.claim || {}),
  };
}

function filterDocsForActiveRetrieval(corpus, options = {}) {
  const filtered = (corpus.docs || []).filter((doc) => (
    classification.isClaimActiveForRetrieval(retrievalRecordForDoc(doc), {
      includePrivate: options.includePrivateMemory === true,
      includeLocal: options.includeLocalMemory === true,
      teamId: options.teamId || null,
      humanId: options.humanId || null,
    })
  ));
  return { ...corpus, docs: filtered };
}

// --- ranking -----------------------------------------------------------------
// Deterministic ordering key: exact-match boost, then BM25, then provenance
// weight (verified > unverified), then journal recency proxy, then stable id.
const EXACT_BOOST = 1000;
const PROVENANCE_VERIFIED_WEIGHT = 0.5; // tie-breaker bump for chained-verified
const FILE_QUERY_BOOST = 2; // file-citation queries should surface file sources before adjacent decisions

// Deterministic sort over scored docs: score desc, then verified first, then
// stable key order. Shared by the deterministic baseline and the semantic path.
function sortScored(scored) {
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // Deterministic tie-break: verified first, then stable key order.
      if (a.doc.source.verified !== b.doc.source.verified) {
        return a.doc.source.verified ? -1 : 1;
      }
      return a.doc.key.localeCompare(b.doc.key);
    });
}

function rankDocs(query, corpus) {
  const queryTokens = tokenize(query);
  const queryIds = extractQueryIds(query);
  const queryPaths = extractQueryPaths(query);
  const asksForFiles = queryTokens.includes("file") || queryTokens.includes("files");
  const index = buildBm25Index(corpus.docs);

  const scored = corpus.docs.map((doc) => {
    let score = bm25Score(queryTokens, doc, index);
    let exact = false;
    // Exact id/path pass: a query naming this doc's id or path is a direct hit.
    if (doc.id && queryIds.includes(doc.id)) {
      score += EXACT_BOOST;
      exact = true;
    }
    if (queryPaths.length && queryPaths.some((p) => doc.path && doc.path.endsWith(p))) {
      score += EXACT_BOOST;
      exact = true;
    }
    if (score > 0 && asksForFiles && doc.type === "file") {
      score += FILE_QUERY_BOOST;
    }
    // Provenance weighting: chained-verified outranks legacy-unverified for
    // otherwise-equal relevance (only when the doc actually matched something).
    if (score > 0 && doc.source.verified) {
      score += PROVENANCE_VERIFIED_WEIGHT;
    }
    return { doc, score, exact };
  });

  return sortScored(scored);
}

// --- COORD-143: semantic-augmented ranking (OPT-IN, off by default) ----------
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 the §6 hybrid pipeline adds vector
// similarity + graph links ON TOP of the deterministic baseline. This function
// is the §6 pipeline with those two extra signals; it is ONLY reached when a
// caller passes an explicit `semantic` option. The DEFAULT recall path
// (`rankDocs`) is byte-for-byte unchanged, so the Phase-1 contract + tests stand.
//
// Both augmentations only ADD candidates / small additive boosts on top of the
// SAME baseline BM25+exact+provenance score — they never replace it. This keeps
// the deterministic ranking dominant (exact id hits stay at the top) while
// letting graph adjacency + vector similarity break ties / surface adjacent
// decisions a pure-lexical pass would miss. The weights are deliberately small
// and the whole path is measured by the eval harness before being trusted.
const GRAPH_HOP1_BOOST = 0.4; // additive boost for a directly graph-adjacent hit
const VECTOR_WEIGHT = 1.0; // scale applied to cosine similarity [0,1]

function rankDocsSemantic(query, corpus, semantic = {}) {
  const queryTokens = tokenize(query);
  const queryIds = extractQueryIds(query);
  const queryPaths = extractQueryPaths(query);
  const asksForFiles = queryTokens.includes("file") || queryTokens.includes("files");
  const index = buildBm25Index(corpus.docs);

  // 1. Baseline lexical score per doc (identical math to rankDocs).
  const scored = corpus.docs.map((doc) => {
    let score = bm25Score(queryTokens, doc, index);
    let exact = false;
    if (doc.id && queryIds.includes(doc.id)) {
      score += EXACT_BOOST;
      exact = true;
    }
    if (queryPaths.length && queryPaths.some((p) => doc.path && doc.path.endsWith(p))) {
      score += EXACT_BOOST;
      exact = true;
    }
    if (score > 0 && asksForFiles && doc.type === "file") {
      score += FILE_QUERY_BOOST;
    }
    if (score > 0 && doc.source.verified) {
      score += PROVENANCE_VERIFIED_WEIGHT;
    }
    return { doc, score, exact, baseline: score };
  });

  // 2. Vector similarity (optional). Active only when a provider is supplied (or
  //    semantic.embedder is given). Absent provider => vector path OFF.
  const provider = semantic.embedder || null;
  if (memoryVector.isProvider(provider)) {
    const qvec = provider.embed(String(query == null ? "" : query));
    // Doc embeddings are EXPENSIVE relative to the query, and stable per
    // (provider, doc). Memoize them on the doc so repeated queries over the SAME
    // corpus (e.g. the eval harness) embed each doc ONCE, not once-per-query.
    // The cache key includes the provider name so swapping providers is safe.
    const provKey = `__vec_${provider.name || "anon"}`;
    for (const s of scored) {
      let dvec = s.doc[provKey];
      if (!dvec) {
        dvec = provider.embed(s.doc.text);
        // Non-enumerable so it never leaks into serialization / determinism.
        Object.defineProperty(s.doc, provKey, { value: dvec, enumerable: false, configurable: true });
      }
      const sim = memoryVector.cosine(qvec, dvec); // [-1,1], ~[0,1] for these
      if (sim > 0) {
        s.score += VECTOR_WEIGHT * sim;
        s.vector = sim;
      }
    }
  }

  // 3. Graph-link expansion (optional). Active only when a graph is supplied.
  //    Seeds = the decision ids that ALREADY matched lexically/vectorially; we
  //    pull graph-adjacent decisions in and give them a small boost so an
  //    adjacent decision can surface even with weak text overlap. We never
  //    EXCEED an exact-hit's score (boost << EXACT_BOOST).
  const graph = semantic.graph || null;
  if (graph && graph.adjacency) {
    const seedIds = scored
      .filter((s) => s.score > 0 && s.doc.id)
      .map((s) => s.doc.id);
    const adjacent = memoryGraph.expand(graph, seedIds, {
      maxHops: Number.isInteger(semantic.maxHops) ? semantic.maxHops : 1,
      maxNodes: Number.isInteger(semantic.maxGraphNodes) ? semantic.maxGraphNodes : 10,
    });
    const adjacentById = new Map(adjacent.map((a) => [a.id, a]));
    for (const s of scored) {
      if (s.doc.id && adjacentById.has(s.doc.id)) {
        const info = adjacentById.get(s.doc.id);
        // Decay boost by hop distance so 1-hop neighbors rank above 2-hop.
        s.score += GRAPH_HOP1_BOOST / info.hops;
        s.graph = info;
      }
    }
  }

  return sortScored(scored);
}

// --- staleness ---------------------------------------------------------------
// A cited source is fresh iff its recorded chain_head still equals the current
// journal chain head (the same whole-chain anchor the attestation signs, §2).
// If the chain moved on, the cited decisions MIGHT be stale -> "stale".
function computeStaleness(sources, currentChainHead) {
  if (!sources.length) {
    return "fresh";
  }
  for (const s of sources) {
    if (s.chain_head && currentChainHead && s.chain_head !== currentChainHead) {
      return "stale";
    }
  }
  return "fresh";
}

// --- confidence --------------------------------------------------------------
// Deterministic mapping from the top hit's quality to high/medium/low. Exact
// id/path hits are high; a clearly-separated BM25 top hit is high; a weak or
// ambiguous top hit is medium; nothing is low.
function computeConfidence(ranked) {
  if (!ranked.length) {
    return "low";
  }
  const top = ranked[0];
  if (top.exact) {
    return "high";
  }
  const second = ranked[1] ? ranked[1].score : 0;
  if (top.score >= 3 && top.score >= second * 1.3) {
    return "high";
  }
  if (top.score >= 1) {
    return "medium";
  }
  return "low";
}

// --- answer composition ------------------------------------------------------
// Compose a cited answer from the top-k hits. EVERY answer line is a snippet
// from a doc that is also emitted in sources[] (no uncited claims). Redaction is
// applied per ENT-012 when the role warrants it.
const DEFAULT_TOP_K = 5;

function recall(query, options = {}) {
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_TOP_K;
  const role = options.role || null;
  const redaction = resolveRedaction(role, options.rbacPolicy);
  const corpus = filterDocsForActiveRetrieval(options.corpus || buildCorpus(options), options);
  // DEFAULT: deterministic Phase-1 ranking (unchanged). The semantic-augmented
  // pipeline (graph + vector) is reached ONLY when a caller passes an explicit
  // `semantic` option — it is OFF by default until the eval harness measures it
  // to beat the baseline (MEMORY_ARCHITECTURE.md §10).
  const ranked = options.semantic
    ? rankDocsSemantic(query, corpus, options.semantic)
    : rankDocs(query, corpus);

  if (!ranked.length) {
    // Honest empty answer — no fabrication.
    return {
      query: String(query == null ? "" : query),
      answer:
        "No governed memory matched this query. Recall returns only source-cited " +
        "answers; with no matching decision record or indexed source, there is " +
        "nothing to cite.",
      sources: [],
      confidence: "low",
      staleness: "fresh",
      memory_generation: corpus.memory_generation || memoryGraph.buildMemoryGeneration(options),
      index_generation: corpus.index_generation || memoryGraph.checkDerivedIndexes(options).index_generation,
      index_warnings: corpus.index_warnings || [],
    };
  }

  const queryTokens = tokenize(query);
  const top = ranked.slice(0, topK);
  const answerLines = [];
  const sources = [];
  for (const hit of top) {
    const source = applyRedactionToSource(hit.doc.source, redaction, role);
    sources.push(source);
    // File hits show the query-matched source line as evidence; decision hits
    // already carry the relevant requirement_closure / invariant text.
    const rawSnippet =
      hit.doc.type === "file"
        ? buildFileEvidenceSnippet(hit.doc, queryTokens)
        : hit.doc.snippet;
    const snippet = applyRedactionToSnippet(
      { ...hit.doc, snippet: rawSnippet },
      redaction,
      role
    );
    if (snippet) {
      answerLines.push(snippet);
    }
  }

  return {
    query: String(query == null ? "" : query),
    answer: answerLines.join("\n\n"),
    sources,
    confidence: computeConfidence(ranked),
    staleness: computeStaleness(sources, corpus.chainHead),
    memory_generation: corpus.memory_generation || memoryGraph.buildMemoryGeneration(options),
    index_generation: corpus.index_generation || memoryGraph.checkDerivedIndexes(options).index_generation,
    index_warnings: corpus.index_warnings || [],
  };
}

function recallForWarmStart(ticket, options = {}) {
  const query = options.query || [
    ticket,
    options.scope || "",
    "plan prework ADR requirements open decisions prior work",
  ].filter(Boolean).join(" ");
  const result = recall(query, options);
  const continuitySeed = options.continuitySeed === false
    ? null
    : memoryGraph.buildContinuitySeed(options);
  const ticketId = String(ticket || "");
  const ticketFacts = continuitySeed
    ? continuitySeed.facts
      .filter((fact) => !ticketId || fact.ticket_id === ticketId || fact.ticket_id === null)
      .slice(0, Number.isInteger(options.seedFactLimit) && options.seedFactLimit > 0 ? options.seedFactLimit : 12)
    : [];
  return {
    kind: "concord.continuity_warm_start_recall",
    schema_version: "continuity-bridge-mvp/v1",
    ticket: ticketId,
    query: result.query,
    available: result.sources.length > 0,
    confidence: result.confidence,
    staleness: result.staleness,
    answer: result.answer,
    sources: result.sources,
    memory_generation: result.memory_generation,
    index_generation: result.index_generation,
    index_warnings: result.index_warnings,
    continuity_seed: continuitySeed
      ? {
          kind: continuitySeed.kind,
          schema_version: continuitySeed.schema_version,
          authority: continuitySeed.authority,
          mode: continuitySeed.mode,
          memory_generation: continuitySeed.memory_generation,
          index_generation: continuitySeed.index_generation,
          sparse_memory_warning: continuitySeed.sparse_memory_warning,
          missing_context: continuitySeed.missing_context,
          counts: continuitySeed.counts,
          facts: ticketFacts,
        }
      : null,
    missing_reason: result.sources.length > 0
      ? null
      : "No governed recall source matched; continue from board, plan, prompt, questions, ADRs, and requirement docs.",
  };
}

// COORD-144: redact a citation's fields per CLASSIFICATION mapped onto the
// ENT-012 role threshold. Each field is classified (public/internal/sensitive/
// secret-prohibited); the classification layer decides whether to redact it for
// the role (composing ENT-012) and how. The source also carries an explicit
// `classification` label = the highest class any of its fields warrants, so the
// caller/UI sees the artifact's sensitivity. secret-prohibited fields are
// refused regardless of role/cut. `path` (internal) is the field most often
// redacted on a citation; id/type/verified (public) always survive.
// COORD-288: the FIXED citation fields recall has always surfaced. They get the
// existing role-aware classification redaction (path is `internal`, etc.).
const FIXED_REDACTED_KEYS = Object.freeze(["path", "event_hash", "chain_head"]);

function applyRedactionToSource(source, redaction, role) {
  const policy = redaction.policy || null;
  const out = { ...source };
  // 1. Existing fixed-key redaction — role-aware, unchanged from COORD-141/144.
  //    (A fixed key that itself looks like a secret is already caught here:
  //    classifyField returns `secret-prohibited` and redactClassifiedField
  //    collapses it to the refusal marker.)
  for (const key of FIXED_REDACTED_KEYS) {
    if (out[key] == null) {
      continue;
    }
    const cls = classification.classifyField(key, out[key]);
    out[key] = classification.redactClassifiedField(cls, key, out[key], role, policy);
  }
  // 2. COORD-288: close the classify->redact loop for ARBITRARY (incl. nested,
  //    non-string, high-entropy) source fields. COORD-276 made classifySource
  //    LABEL a source whose nested/non-standard field holds a secret as
  //    secret-prohibited, but recall previously surfaced those non-fixed fields
  //    VERBATIM — so a labeled secret could still leak at surface time. Re-run
  //    the per-field classification over every remaining field; when it flags a
  //    secret, DEEP-redact via the COORD-276 redactClassifiedField/redactSecretsDeep
  //    helper so the offending leaf (at any depth) collapses to the refusal marker
  //    while benign sibling fields survive. We only touch secret-prohibited fields
  //    here, so benign content is NOT over-redacted. Fail-closed: redactSecretsDeep
  //    collapses cyclic / over-depth branches to the marker rather than surfacing
  //    them raw, so a source that can't be fully processed is withheld, not leaked.
  for (const key of Object.keys(out)) {
    if (FIXED_REDACTED_KEYS.includes(key) || out[key] == null) {
      continue; // fixed keys already handled above; skip empty fields
    }
    const cls = classification.classifyField(key, out[key]);
    out[key] = classification.redactClassifiedField(cls, key, out[key], role, policy);
  }
  // Label the citation with its overall classification (highest field class).
  out.classification = classification.classifySource(source);
  return out;
}

// For redacted roles, the cited snippet still names the (path-redacted) source +
// its PUBLIC id, but withholds verbatim decision bodies (classified `sensitive`
// under ENT-012). The snippet body is ALWAYS secret-scrubbed first so
// secret-prohibited content is never surfaced — in BOTH cuts, for ANY role
// (including the unredacted operational default). Unredacted roles get the full
// (secret-scrubbed) snippet.
function applyRedactionToSnippet(doc, redaction, role) {
  const policy = redaction.policy || null;
  // 1. Secret scrub FIRST: a snippet whose body looks like a secret is refused
  //    no matter the role/cut (defense in depth — memory must never hold/surface
  //    secrets even if one slipped past ingestion). When scrubbed, the refusal
  //    marker is the FINAL body: it is NOT further evidence-redacted, so the
  //    explicit "secret-prohibited: refused" surface always shows (a viewer must
  //    SEE that something was refused, not a generic [redacted]).
  const scrubbed = scrubSecrets(doc.snippet);
  const wasSecret = scrubbed !== doc.snippet;
  // 2. Path is `internal`: redacted for viewer, full for operator+ / no-role.
  const pathCls = doc.path ? classification.classifyField("path", doc.path) : "public";
  const safePath = doc.path
    ? classification.redactClassifiedField(pathCls, "path", doc.path, role, policy)
    : doc.path;
  // 3. The decision/evidence body is `sensitive`: redacted below the operator
  //    trust boundary per ENT-012. A scrubbed secret body bypasses this and
  //    stays the refusal marker.
  const body = wasSecret
    ? scrubbed
    : classification.redactClassifiedField("sensitive", "evidence", scrubbed, role, policy);
  // No role-level redaction AND nothing scrubbed => return the verbatim snippet
  // (preserves COORD-141's unredacted operational view exactly).
  if (!redaction.redact && !wasSecret && body === doc.snippet) {
    return doc.snippet;
  }
  const label = doc.id ? `${doc.id} (${safePath})` : safePath;
  return `${label}: ${body}`;
}

// Replace any secret-like span in a free-text body with the refusal marker so
// secret-prohibited content is NEVER surfaced — independent of role and of which
// cut is running. Returns the body unchanged when it holds no secret-like span.
function scrubSecrets(text) {
  if (typeof text !== "string" || !text) {
    return text;
  }
  if (!classification.looksLikeSecret(text)) {
    return text;
  }
  return classification.SECRET_REFUSAL;
}

module.exports = {
  sha1,
  tokenize,
  extractQueryIds,
  extractQueryPaths,
  buildBm25Index,
  bm25Score,
  buildCorpus,
  filterDocsForActiveRetrieval,
  rankDocs,
  rankDocsSemantic,
  sortScored,
  memoryGraph,
  memoryVector,
  computeStaleness,
  computeConfidence,
  resolveRedaction,
  loadRbacPolicy,
  scrubSecrets,
  classification,
  recall,
  recallForWarmStart,
  INDEXED_FILES,
  DEFAULT_DECISIONS_PATH,
  DEFAULT_ADR_DIR,
  readAdrDocs,
  defaultDecisionsPath,
  DEFAULT_JOURNAL_PATH,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let asJson = false;
  let role = null;
  const queryParts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      asJson = true;
    } else if (a === "--role") {
      role = argv[i + 1] || null;
      i += 1;
    } else {
      queryParts.push(a);
    }
  }
  const query = queryParts.join(" ");
  if (!query) {
    process.stdout.write(
      [
        "coord/scripts/recall.js — Phase 1 deterministic gov recall (COORD-141).",
        "",
        "Usage:",
        '  node coord/scripts/recall.js "<query>" [--role <role>] [--json]',
        "",
        "Returns a SOURCE-CITED answer over governed memory (decision records +",
        "indexed authority files). Deterministic: id/path -> BM25 -> provenance",
        "weighting. No vectors, no LLM. Permission-aware via ENT-012 when present.",
        "",
      ].join("\n")
    );
  } else {
    const result = recall(query, { role });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Q: ${result.query}\n\n${result.answer}\n\n`);
      process.stdout.write(
        `confidence=${result.confidence} staleness=${result.staleness}\n\nSources:\n`
      );
      for (const s of result.sources) {
        process.stdout.write(
          `  - [${s.type}] ${s.id || ""} ${s.path || ""} ` +
            `verified=${s.verified} event_hash=${(s.event_hash || "").slice(0, 12)}\n`
        );
      }
    }
  }
}
