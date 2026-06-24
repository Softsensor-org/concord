"use strict";

// COORD-141: tests for the Phase 1 deterministic `gov recall` engine.
//
// The headline test runs recall over the REAL Phase-0 eval benchmark
// (coord/memory/eval/benchmark.json) and asserts every case returns its
// expected hash-linked citations + required answer substrings — the payoff demo
// AND the regression guard. The rest cover the retrieval invariants: exact-id
// hits, BM25 ranking, provenance weighting (verified outranks unverified for
// equal text relevance), empty-result honesty, the §7 contract shape,
// determinism, and permission-aware redaction (ENT-012 present + community-cut
// graceful degradation).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const recall = require("./recall.js");
const extractor = require("./decision-extractor.js");
const { skipIfNoCorpus } = require("./memory-corpus-guard.js");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const BENCHMARK_PATH = path.join(ROOT_DIR, "coord", "memory", "eval", "benchmark.json");
const DECISIONS_PATH = path.join(ROOT_DIR, "coord", "memory", "decisions.ndjson");

// The derived decisions.ndjson is gitignored; rebuild it deterministically from
// source so the benchmark test runs against current repo history without
// depending on a committed artifact.
function ensureDecisions() {
  extractor.rebuild({ outputPath: DECISIONS_PATH });
}

// COORD-197: history-grounded tests skip when no live decision corpus exists
// (stripped published artifact). In the donor the journal is present, so this
// returns false and the test runs+asserts fully. Returns true when it skipped.
function skipUnlessCorpus(t) {
  if (skipIfNoCorpus(t)) {
    return true;
  }
  ensureDecisions();
  return false;
}

function sourceKey(s) {
  return s.type === "decision" ? `decision:${s.id}` : `file:${s.path}`;
}

// --- the benchmark acceptance test (the payoff demo + regression guard) ------

test("recall answers the real-history eval benchmark with the expected citations", (t) => {
  if (skipUnlessCorpus(t)) return;
  const benchmark = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf8"));
  assert.ok(Array.isArray(benchmark.cases) && benchmark.cases.length >= 5);

  for (const testCase of benchmark.cases) {
    const result = recall.recall(testCase.question);

    // §7: never a bare assertion — a non-empty answer must carry sources.
    assert.ok(result.sources.length > 0, `${testCase.id}: expected cited sources`);

    // Every expected hash-linked source is cited.
    const citedKeys = new Set(result.sources.map(sourceKey));
    for (const expected of testCase.expected_sources) {
      const key =
        expected.type === "decision"
          ? `decision:${expected.id}`
          : `file:${expected.path}`;
      assert.ok(
        citedKeys.has(key),
        `${testCase.id}: expected source ${key} not cited; got ${[...citedKeys].join(", ")}`
      );
    }

    // Every required substring is grounded in the cited answer.
    for (const needle of testCase.must_include || []) {
      assert.ok(
        result.answer.includes(needle),
        `${testCase.id}: answer missing required substring "${needle}"`
      );
    }

    // Each cited source pins the §7 provenance fields.
    for (const s of result.sources) {
      assert.ok(["ticket", "decision", "event", "file"].includes(s.type));
      assert.ok(Object.prototype.hasOwnProperty.call(s, "event_hash"));
      assert.ok(Object.prototype.hasOwnProperty.call(s, "chain_head"));
      assert.equal(typeof s.verified, "boolean");
    }
  }
});

// --- §7 contract shape -------------------------------------------------------

test("recall output matches the §7 cited-answer contract shape", () => {
  ensureDecisions();
  const result = recall.recall("conformance attestation ed25519 signing");
  assert.deepEqual(
    Object.keys(result).sort(),
    ["answer", "confidence", "query", "sources", "staleness"]
  );
  assert.equal(typeof result.answer, "string");
  assert.ok(["high", "medium", "low"].includes(result.confidence));
  assert.ok(["fresh", "stale"].includes(result.staleness));
  for (const s of result.sources) {
    assert.deepEqual(
      // COORD-144 adds a `classification` label to every cited source.
      Object.keys(s).sort(),
      ["chain_head", "classification", "event_hash", "id", "path", "type", "verified"]
    );
  }
});

// --- exact id hit ------------------------------------------------------------

test("an exact ticket-id in the query is a direct top hit", (t) => {
  if (skipUnlessCorpus(t)) return;
  const result = recall.recall("COORD-124");
  assert.equal(result.sources[0].type, "decision");
  assert.equal(result.sources[0].id, "COORD-124");
  assert.equal(result.confidence, "high");
});

test("an exact file path in the query is a direct top hit", () => {
  ensureDecisions();
  const result = recall.recall("what is in coord/scripts/journal.js");
  assert.equal(result.sources[0].type, "file");
  assert.equal(result.sources[0].path, "coord/scripts/journal.js");
});

// --- BM25 ranking ------------------------------------------------------------

test("BM25 ranks the most textually-relevant decision first for a topical query", (t) => {
  if (skipUnlessCorpus(t)) return;
  const corpus = recall.buildCorpus({});
  const ranked = recall.rankDocs("bootstrap risk fields added to plan records", corpus);
  assert.ok(ranked.length > 0);
  // COORD-159 (the bootstrap_risk ticket) should be the top decision hit.
  const topDecision = ranked.find((r) => r.doc.type === "decision");
  assert.equal(topDecision.doc.id, "COORD-159");
});

// --- provenance weighting ----------------------------------------------------

test("provenance weighting: a verified source outranks an unverified one for equal text relevance", () => {
  // Two synthetic docs with identical text; only provenance differs. The
  // verified one must rank first (the Concord edge, §6 principle 3).
  const sharedText = "alpha beta gamma delta epsilon zeta";
  const corpus = {
    chainHead: "headXYZ",
    docs: [
      {
        key: "decision:UNVERIFIED-1",
        type: "decision",
        id: "UNVERIFIED-1",
        path: "p/unverified.json",
        text: sharedText,
        tokens: recall.tokenize(sharedText),
        source: {
          type: "decision",
          id: "UNVERIFIED-1",
          path: "p/unverified.json",
          event_hash: "h1",
          chain_head: "headXYZ",
          verified: false,
        },
        snippet: "unverified",
      },
      {
        key: "decision:VERIFIED-1",
        type: "decision",
        id: "VERIFIED-1",
        path: "p/verified.json",
        text: sharedText,
        tokens: recall.tokenize(sharedText),
        source: {
          type: "decision",
          id: "VERIFIED-1",
          path: "p/verified.json",
          event_hash: "h2",
          chain_head: "headXYZ",
          verified: true,
        },
        snippet: "verified",
      },
    ],
  };
  const ranked = recall.rankDocs("alpha beta gamma", corpus);
  assert.equal(ranked[0].doc.id, "VERIFIED-1", "verified source must outrank unverified");
  assert.equal(ranked[1].doc.id, "UNVERIFIED-1");
});

// --- empty-result honesty ----------------------------------------------------

test("recall is honest when nothing matches — empty sources, low confidence, no fabrication", () => {
  ensureDecisions();
  const result = recall.recall("zzzqqqx wwwvvv qqxxzz vvwwqq xxzzqq");
  assert.equal(result.sources.length, 0);
  assert.equal(result.confidence, "low");
  assert.equal(result.staleness, "fresh");
  assert.match(result.answer, /No governed memory matched/);
});

// --- determinism -------------------------------------------------------------

test("recall is deterministic — same query yields byte-identical output", () => {
  ensureDecisions();
  const q = "what broke when agents appended to the journal concurrently";
  const a = JSON.stringify(recall.recall(q));
  const b = JSON.stringify(recall.recall(q));
  assert.equal(a, b);
});

// --- staleness ---------------------------------------------------------------

test("staleness flips to stale when a cited chain_head no longer matches the current head", () => {
  const sources = [{ chain_head: "OLD_HEAD", event_hash: "x", verified: true }];
  assert.equal(recall.computeStaleness(sources, "OLD_HEAD"), "fresh");
  assert.equal(recall.computeStaleness(sources, "NEW_HEAD"), "stale");
  assert.equal(recall.computeStaleness([], "NEW_HEAD"), "fresh");
});

// --- permission-aware redaction (ENT-012 present) ----------------------------

test("no explicit role => unredacted operational view (verbatim evidence shown)", (t) => {
  if (skipUnlessCorpus(t)) return;
  const result = recall.recall("COORD-159 bootstrap risk");
  assert.ok(!result.answer.includes("[redacted]"));
  assert.ok(result.answer.includes("bootstrap_risk"));
});

test("role=viewer => ENT-012 redacts verbatim evidence bodies", (t) => {
  if (skipUnlessCorpus(t)) return;
  // This assertion exercises the ENT-012 redaction path, which only exists when
  // the optional tier ships. In the community cut (tier stripped) loadRbacPolicy
  // returns null and recall degrades to the documented non-redacting default —
  // covered by the dedicated community-cut test below — so skip the
  // redaction-present assertion when ENT-012 is absent.
  if (!recall.loadRbacPolicy()) {
    return;
  }
  const result = recall.recall("COORD-159 bootstrap risk", { role: "viewer" });
  // Viewer still sees WHICH sources back the answer (id + path) but not the
  // verbatim evidence body.
  assert.ok(result.answer.includes("[redacted]"), "viewer evidence must be redacted");
  assert.ok(result.answer.includes("COORD-159"), "viewer still sees the cited id");
});

test("role=operator => unredacted (operational trust per ENT-012)", () => {
  ensureDecisions();
  const result = recall.recall("COORD-159 bootstrap risk", { role: "operator" });
  assert.ok(!result.answer.includes("[redacted]"));
});

// --- community-cut graceful degradation --------------------------------------

test("recall degrades gracefully when the enterprise RBAC module is absent (community cut)", () => {
  // Simulate the community cut: pass an explicit non-RBAC policy object (one
  // WITHOUT shouldRedactForRole, standing in for the stripped enterprise
  // module). resolveRedaction must NOT crash and must default to safe
  // non-redacting community behavior — there is no hard core->enterprise dep.
  const communityStub = {}; // no shouldRedactForRole / redactField
  const resolved = recall.resolveRedaction("viewer", communityStub);
  assert.equal(resolved.redact, false, "community cut never redacts (safe default)");
  assert.equal(typeof resolved.redactField, "function");
  // The fallback redactField is identity (no redaction).
  assert.equal(resolved.redactField("path", "/abs/secret.json", "viewer"), "/abs/secret.json");
  // And recall over the same query stays unredacted under the community stub.
  const result = recall.recall("COORD-159 bootstrap risk", {
    role: "viewer",
    rbacPolicy: communityStub,
  });
  assert.ok(!result.answer.includes("[redacted]"), "community cut returns full answer");
});

test("loadRbacPolicy returns the ENT-012 policy when present (enterprise cut)", () => {
  // In this repo the enterprise tier is present, so the policy loads and exposes
  // the ENT-012 redaction surface recall relies on.
  const policy = recall.loadRbacPolicy();
  if (policy) {
    assert.equal(typeof policy.shouldRedactForRole, "function");
    assert.equal(typeof policy.redactField, "function");
    assert.equal(policy.shouldRedactForRole("viewer"), true);
    assert.equal(policy.shouldRedactForRole("operator"), false);
  }
});

// --- COORD-144: classification + role-based recall ---------------------------

test("every cited source carries a COORD-144 classification label", () => {
  ensureDecisions();
  const result = recall.recall("COORD-159 bootstrap risk");
  assert.ok(result.sources.length > 0);
  for (const s of result.sources) {
    assert.ok(
      ["public", "internal", "sensitive", "secret-prohibited"].includes(s.classification),
      `unexpected classification ${s.classification}`
    );
  }
  // A decision/file citation carries a path + hashes => internal-or-higher.
  const withPath = result.sources.find((s) => s.path);
  assert.ok(withPath);
  assert.notEqual(withPath.classification, "public");
});

test("viewer recall redacts internal path + sensitive evidence; public id survives", (t) => {
  if (skipUnlessCorpus(t)) return;
  // Redaction requires the optional ENT-012 tier; in the community cut it is
  // stripped and recall degrades to the non-redacting default (covered by the
  // dedicated community-cut test). Skip the redaction-present assertion when the
  // tier is absent.
  if (!recall.loadRbacPolicy()) {
    return;
  }
  const result = recall.recall("COORD-159 bootstrap risk", { role: "viewer" });
  // public: the ticket id is still visible.
  assert.ok(result.answer.includes("COORD-159"), "public id must survive for viewer");
  // sensitive: verbatim evidence body redacted.
  assert.ok(result.answer.includes("[redacted]"), "viewer sensitive body must be redacted");
  // internal: the absolute/repo path is redacted to a basename in the citation.
  const src = result.sources.find((s) => s.id === "COORD-159") || result.sources[0];
  if (src && src.path) {
    assert.ok(
      src.path.startsWith(".../") || !src.path.includes("/coord/"),
      "viewer internal path should be basename-redacted"
    );
  }
});

test("operator/admin recall returns full provenance (no redaction)", (t) => {
  if (skipUnlessCorpus(t)) return;
  for (const role of ["operator", "admin"]) {
    const result = recall.recall("COORD-159 bootstrap risk", { role });
    assert.ok(!result.answer.includes("[redacted]"), `${role} must see full provenance`);
    assert.ok(result.answer.includes("bootstrap_risk"), `${role} sees verbatim evidence`);
    // Full path preserved (not basename-redacted) for operator+.
    const src = result.sources.find((s) => s.path);
    if (src) {
      assert.ok(!src.path.startsWith(".../"), `${role} path must not be redacted`);
    }
  }
});

test("secret-like content is detected and NEVER surfaced — both cuts, any role", () => {
  // A synthetic corpus with a single doc whose snippet embeds a secret. Recall
  // must refuse the secret in the answer regardless of role/cut.
  // The example token is ASSEMBLED AT RUNTIME from fragments so this test source
  // carries no literal substring matching a real secret pattern (the release
  // hygiene secret-scan fail-closes on such a literal, even in example test
  // data). The assembled string still matches the COORD-144 detector, so the
  // secret-refusal path stays exercised.
  const ghToken = "gh" + "p_" + "A".repeat(36);
  const secretSnippet = `deploy used token ${ghToken} to push`;
  const makeCorpus = () => ({
    chainHead: "headXYZ",
    docs: [
      {
        key: "decision:SECRET-1",
        type: "decision",
        id: "SECRET-1",
        path: "p/secret.json",
        text: "alpha beta gamma deploy token push",
        tokens: recall.tokenize("alpha beta gamma deploy token push"),
        source: {
          type: "decision",
          id: "SECRET-1",
          path: "p/secret.json",
          event_hash: "h1",
          chain_head: "headXYZ",
          verified: true,
        },
        snippet: secretSnippet,
      },
    ],
  });
  // Sanity: the detector flags it.
  assert.equal(recall.scrubSecrets(secretSnippet), recall.classification.SECRET_REFUSAL);
  // Enterprise cut + community stub + every role.
  const communityStub = {};
  for (const policy of [recall.loadRbacPolicy(), communityStub]) {
    for (const role of [null, "viewer", "operator", "admin", "auditor"]) {
      const result = recall.recall("alpha beta gamma deploy", {
        role,
        corpus: makeCorpus(),
        rbacPolicy: policy,
      });
      assert.ok(
        !result.answer.includes("ghp_"),
        `raw secret leaked for role=${role}, policy=${policy ? "ent" : "community"}`
      );
      assert.ok(
        result.answer.includes("secret-prohibited"),
        `secret refusal marker missing for role=${role}`
      );
    }
  }
});

test("community cut: classification still refuses secrets but does not role-differentiate other classes", (t) => {
  if (skipUnlessCorpus(t)) return;
  const communityStub = {}; // no shouldRedactForRole / redactField
  // viewer under the community stub sees the full (non-secret) answer — no role
  // differentiation available, safe default per the documented stance.
  const result = recall.recall("COORD-159 bootstrap risk", {
    role: "viewer",
    rbacPolicy: communityStub,
  });
  assert.ok(!result.answer.includes("[redacted]"), "community cut returns full non-secret answer");
  assert.ok(result.answer.includes("bootstrap_risk"));
});

// --- COORD-143: semantic layer is OPT-IN; Phase-1 default is unchanged --------

test("the semantic layer is OFF by default — default recall equals the deterministic ranker", () => {
  ensureDecisions();
  const corpus = recall.buildCorpus({});
  const q = "what broke when agents appended to the journal concurrently";
  // The default recall path must use rankDocs (deterministic), unchanged from
  // Phase 1. Compare the default result against the explicit deterministic rank.
  const deterministic = recall.rankDocs(q, corpus).map((r) => r.doc.key);
  const result = recall.recall(q, { corpus });
  const defaultKeys = result.sources.map((s) =>
    s.type === "decision" ? `decision:${s.id}` : `file:${s.path}`
  );
  assert.deepEqual(defaultKeys, deterministic.slice(0, defaultKeys.length));
});

test("vector path is OFF when no embedding provider is present (deterministic baseline stands)", () => {
  ensureDecisions();
  const corpus = recall.buildCorpus({});
  const q = "conformance attestation ed25519 signing";
  // semantic requested but NO embedder + NO graph => the ranking equals the
  // deterministic baseline (vector path simply off — graceful skip).
  const baseline = recall.rankDocs(q, corpus).map((r) => r.doc.key);
  const semantic = recall
    .rankDocsSemantic(q, corpus, {})
    .map((r) => r.doc.key);
  assert.deepEqual(semantic, baseline);
});

test("vector path activates when a (local, dependency-free) provider is present", () => {
  ensureDecisions();
  const corpus = recall.buildCorpus({});
  const q = "hash chain repair";
  const ranked = recall.rankDocsSemantic(q, corpus, {
    embedder: recall.memoryVector.localEmbedder(),
  });
  assert.ok(ranked.length > 0);
  // At least one hit carries a vector-similarity component (proves it ran).
  assert.ok(ranked.some((r) => typeof r.vector === "number" && r.vector > 0));
});

test("graph expansion pulls graph-adjacent decisions into the candidate set with a graph marker", (t) => {
  if (skipUnlessCorpus(t)) return;
  const corpus = recall.buildCorpus({});
  const graph = recall.memoryGraph.buildGraph({});
  const q = "COORD-139 memory architecture spec phased backlog";
  // WITHOUT the graph: the lexically-matched candidate set (the deterministic
  // baseline) — these are the "seeds".
  const baseline = recall.rankDocsSemantic(q, corpus, {});
  const seedIds = new Set(baseline.filter((r) => r.doc.id).map((r) => r.doc.id));
  // WITH the graph: expansion ADDS graph-adjacent decisions that were NOT lexical
  // seeds, each carrying a `.graph` adjacency marker (id + hops + relation).
  const withGraph = recall.rankDocsSemantic(q, corpus, { graph, maxHops: 1 });
  const graphSurfaced = withGraph.filter((r) => r.graph);
  assert.ok(graphSurfaced.length > 0, "graph expansion must surface adjacent decisions");
  for (const r of graphSurfaced) {
    // Anything carrying a graph marker was pulled in by adjacency, not lexically.
    assert.ok(!seedIds.has(r.doc.id), `${r.doc.id} was a lexical seed, not graph-surfaced`);
    assert.equal(typeof r.graph.hops, "number");
    assert.ok(recall.memoryGraph.RELATIONS.includes(r.graph.relation));
  }
});

test("an exact-id hit always outranks a graph/vector-boosted neighbor (deterministic dominance)", (t) => {
  if (skipUnlessCorpus(t)) return;
  const corpus = recall.buildCorpus({});
  const graph = recall.memoryGraph.buildGraph({});
  // Even with semantic boosts, an exact id hit (EXACT_BOOST=1000) must stay top.
  const ranked = recall.rankDocsSemantic("COORD-124", corpus, {
    graph,
    embedder: recall.memoryVector.localEmbedder(),
    maxHops: 1,
  });
  assert.equal(ranked[0].doc.id, "COORD-124", "exact id hit must dominate semantic boosts");
});
