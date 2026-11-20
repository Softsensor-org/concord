"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-141: tests for the Phase 1 deterministic `gov recall` engine.
//
// The headline test runs recall over the REAL Phase-0 eval benchmark
// (coord/memory/eval/benchmark.json) and asserts every case keeps its expected
// hash-linked citations retrievable with required answer substrings — the
// payoff demo AND the regression guard. The live history grows over time, so
// this test intentionally checks a bounded top-K retrieval invariant rather
// than freezing exact membership in a tiny top-N window. The rest cover the
// stricter retrieval invariants: exact-id hits, BM25 ranking, provenance
// weighting (verified outranks unverified for equal text relevance),
// empty-result honesty, the §7 contract shape, determinism, and
// permission-aware redaction (ENT-012 present + community-cut graceful
// degradation).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const recall = require("./recall.js");
const extractor = require("./decision-extractor.js");
const { skipIfNoCorpus } = require("./memory-corpus-guard.js");
const { sandboxProcessRuntimeLocks } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));

// COORD-300: redirect the governed runtime (incl. MEMORY_DIR) to a per-process
// os.tmpdir() sandbox so rebuilding the derived decisions corpus does not write
// the live coord/memory tree. recall.js now resolves the corpus from
// state.MEMORY_DIR at call time, so the rebuild below and recall()'s own reads
// both land in the sandbox. This is what lets recall.test.js leave the
// test-isolation-guard RUNTIME_ALLOWLIST_FILES set.
sandboxProcessRuntimeLocks();

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
// The benchmark is a LIVE committed read (ground truth); only the derived
// decisions corpus is rebuilt, and that goes to the sandboxed MEMORY_DIR.
const BENCHMARK_PATH = path.join(ROOT_DIR, "coord", "memory", "eval", "benchmark.json");
const LIVE_HISTORY_BENCHMARK_TOP_K = 25;

// The derived decisions.ndjson is gitignored; rebuild it deterministically from
// source so the benchmark test runs against current repo history without
// depending on a committed artifact. COORD-300: rebuild into the sandboxed
// MEMORY_DIR (the same path recall() resolves at call time), not the live tree.
function ensureDecisions() {
  extractor.rebuild({ outputPath: recall.defaultDecisionsPath() });
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
  if (s.type === "decision") return `decision:${s.id}`;
  if (s.type === "adr") return `adr:${s.id}`;
  return `file:${s.path}`;
}

// --- the benchmark acceptance test (the payoff demo + regression guard) ------

test("recall answers the real-history eval benchmark with bounded expected citations", (t) => {
  if (skipUnlessCorpus(t)) return;
  const benchmark = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf8"));
  assert.ok(Array.isArray(benchmark.cases) && benchmark.cases.length >= 5);

  for (const testCase of benchmark.cases) {
    const result = recall.recall(testCase.question, {
      topK: LIVE_HISTORY_BENCHMARK_TOP_K,
    });

    // §7: never a bare assertion — a non-empty answer must carry sources.
    assert.ok(result.sources.length > 0, `${testCase.id}: expected cited sources`);

    // Every expected hash-linked source remains cited within a bounded live
    // history retrieval window. Do not shrink this to expected_sources + N:
    // new governed history legitimately changes BM25/provenance ordering, and
    // exact tiny-window membership makes the test fail for corpus growth rather
    // than a recall regression.
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
      assert.ok(["ticket", "decision", "event", "file", "adr"].includes(s.type));
      assert.ok(Object.prototype.hasOwnProperty.call(s, "event_hash"));
      assert.ok(Object.prototype.hasOwnProperty.call(s, "chain_head"));
      assert.equal(typeof s.verified, "boolean");
    }
  }
});

test("recall indexes ADRs as cited settled decision sources for prework composition", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-adr-"));
  const adrDir = path.join(dir, "coord/docs/decisions");
  fs.mkdirSync(adrDir, { recursive: true });
  fs.writeFileSync(path.join(adrDir, "0001-orders-api-contract.md"), [
    "# ADR 0001: Orders API Contract",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** ORDER-ADR",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "",
    "Orders API context.",
    "",
    "## Linked Scope",
    "",
    "- Affected file: backend/src/api/orders.ts.",
    "- Requirement: REQ-ADR-1.",
    "",
    "## Decision Criteria",
    "",
    "- Preserve stable route semantics.",
    "",
    "## Options Evaluated",
    "",
    "- Explicit route contract.",
    "- Handler inference.",
    "",
    "## Decision",
    "",
    "Orders API work must preserve the explicit route contract.",
    "",
    "## Alternatives Rejected",
    "",
    "Handler inference was rejected because it hides breaking changes.",
    "",
    "## Consequences",
    "",
    "Agents must see this settled ADR before planning orders API changes.",
    "",
    "## Revisit Trigger",
    "",
    "Revisit if orders routes move out of backend/src/api/orders.ts.",
    "",
  ].join("\n"), "utf8");

  const corpus = recall.buildCorpus({
    rootDir: dir,
    decisionsPath: path.join(dir, "missing-decisions.ndjson"),
    journalPath: path.join(dir, "missing-journal.ndjson"),
  });
  const result = recall.recall("ADR-0001 orders API rejected consequences revisit", { corpus });

  assert.equal(result.sources[0].type, "adr");
  assert.equal(result.sources[0].id, "ADR-0001");
  assert.equal(result.sources[0].path, "coord/docs/decisions/0001-orders-api-contract.md");
  assert.match(result.answer, /Decision: Orders API work must preserve/);
  assert.match(result.answer, /Rejected alternatives: Handler inference/);
  assert.match(result.answer, /Consequences: Agents must see/);
  assert.match(result.answer, /Revisit trigger: Revisit if orders routes move/);
  assert.equal(result.confidence, "high");
});

test("COORD-338: recall warm-start wrapper labels unavailable memory honestly", () => {
  const result = recall.recallForWarmStart("COORD-338", {
    corpus: { chainHead: null, docs: [] },
  });
  assert.equal(result.kind, "concord.continuity_warm_start_recall");
  assert.equal(result.ticket, "COORD-338");
  assert.equal(result.available, false);
  assert.equal(result.sources.length, 0);
  assert.match(result.missing_reason, /No governed recall source matched/);
  assert.match(result.answer, /No governed memory matched/);
});

// --- §7 contract shape -------------------------------------------------------

test("recall output matches the §7 cited-answer contract shape", () => {
  ensureDecisions();
  const result = recall.recall("conformance attestation ed25519 signing");
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "answer",
      "confidence",
      "index_generation",
      "index_warnings",
      "memory_generation",
      "query",
      "sources",
      "staleness",
    ]
  );
  assert.equal(typeof result.answer, "string");
  assert.ok(["high", "medium", "low"].includes(result.confidence));
  assert.ok(["fresh", "stale"].includes(result.staleness));
  assert.equal(result.memory_generation.authority, false);
  assert.equal(result.index_generation.authority, false);
  assert.equal(result.memory_generation.chain_head, result.index_generation.chain_head);
  for (const s of result.sources) {
    assert.deepEqual(
      // COORD-144 adds a `classification` label to every cited source.
      Object.keys(s).sort(),
      ["chain_head", "classification", "event_hash", "id", "path", "type", "verified"]
    );
  }
});

test("recall output carries caller-supplied memory and index generation metadata", () => {
  const corpus = {
    chainHead: "chain-head-fixture",
    memory_generation: {
      schema_version: "memory-generation/v1",
      authority: false,
      chain_head: "chain-head-fixture",
    },
    index_generation: {
      schema_version: "memory-index-generation/v1",
      authority: false,
      chain_head: "chain-head-fixture",
      decisions: { valid: true },
      graph: { valid: true },
    },
    index_warnings: [
      {
        code: "fixture-warning",
        severity: "warning",
        message: "fixture",
        action: "fixture action",
      },
    ],
    docs: [
      {
        key: "decision:META-001",
        type: "decision",
        id: "META-001",
        path: "coord/.runtime/plans/META-001.json",
        text: "alpha generation metadata",
        tokens: recall.tokenize("alpha generation metadata"),
        source: {
          type: "decision",
          id: "META-001",
          path: "coord/.runtime/plans/META-001.json",
          event_hash: "event",
          chain_head: "chain-head-fixture",
          verified: true,
        },
        snippet: "META-001 records alpha generation metadata.",
      },
    ],
  };
  const result = recall.recall("alpha generation", { corpus });
  assert.equal(result.memory_generation.chain_head, "chain-head-fixture");
  assert.equal(result.index_generation.chain_head, "chain-head-fixture");
  assert.equal(result.index_warnings[0].code, "fixture-warning");
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
  const result = recall.recall("what is in coord/engine/scripts/journal.js");
  assert.equal(result.sources[0].type, "file");
  assert.equal(result.sources[0].path, "coord/engine/scripts/journal.js");
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
  assert.equal(recall.computeChainHeadStaleness(sources, "OLD_HEAD"), "fresh");
  assert.equal(recall.computeChainHeadStaleness(sources, "NEW_HEAD"), "stale");
  assert.equal(recall.computeChainHeadStaleness([], "NEW_HEAD"), "fresh");
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

// --- COORD-288: close the classify->redact loop for NESTED source fields ------
// COORD-276 made classifySource LABEL a source whose nested/non-string/high-
// entropy field holds a secret as secret-prohibited, but recall.js
// applyRedactionToSource previously redacted ONLY the fixed keys path/event_hash/
// chain_head — so a secret nested in an arbitrary source field could still LEAK
// verbatim in result.sources at surface time. These tests reproduce the leak,
// then prove the deep-redaction wiring closes it without over-redacting.

// Build a single-doc corpus whose citation `source` carries an arbitrary nested
// field. `extra` lives on the surfaced source object (recall pushes hit.doc.source
// into result.sources verbatim aside from redaction), so it is a real surface path.
function makeNestedSourceCorpus(extra) {
  return {
    chainHead: "headXYZ",
    docs: [
      {
        key: "decision:NEST-1",
        type: "decision",
        id: "NEST-1",
        path: "p/nest.json",
        text: "alpha beta gamma delta epsilon",
        tokens: recall.tokenize("alpha beta gamma delta epsilon"),
        source: {
          type: "decision",
          id: "NEST-1",
          path: "p/nest.json",
          event_hash: "h1",
          chain_head: "headXYZ",
          verified: true,
          extra,
        },
        snippet: "alpha beta gamma summary",
      },
    ],
  };
}

test("COORD-288 NESTED-SECRET-NOT-SURFACED: a secret nested in a source field is deep-redacted, benign siblings survive", () => {
  // Assemble the token at runtime so this test source carries no literal secret
  // substring (release hygiene secret-scan), while still matching the detector.
  const ghToken = "gh" + "p_" + "B".repeat(36);
  const nested = {
    label: "keep-me",
    meta: { note: "benign-detail", credential: ghToken },
    list: ["plain", { deep: ghToken }],
  };

  // Sanity: COORD-276 LABELS this source secret-prohibited (the detector recurses).
  assert.equal(
    recall.classification.classifySource(makeNestedSourceCorpus(nested).docs[0].source),
    "secret-prohibited",
    "precondition: nested secret must be labeled secret-prohibited"
  );

  // Reproduce the LEAK first: the pre-COORD-288 behavior only redacted the three
  // fixed keys, leaving arbitrary nested fields verbatim. Emulate that old logic
  // and assert the secret WOULD have surfaced — proving the regression is real.
  const oldFixedKeyOnly = (source) => {
    const out = { ...source };
    for (const k of ["path", "event_hash", "chain_head"]) {
      if (out[k] != null) out[k] = recall.classification.redactClassifiedField(
        recall.classification.classifyField(k, out[k]), k, out[k], null, null);
    }
    return out;
  };
  const leaked = oldFixedKeyOnly(makeNestedSourceCorpus(nested).docs[0].source);
  assert.ok(
    JSON.stringify(leaked).includes(ghToken),
    "precondition: old fixed-key-only redaction WOULD leak the nested secret"
  );

  // Now the real recall path: the nested secret must be ABSENT from the surfaced
  // sources, replaced by the refusal marker, with benign siblings preserved.
  const result = recall.recall("alpha beta gamma delta", {
    corpus: makeNestedSourceCorpus(nested),
  });
  const serialized = JSON.stringify(result.sources);
  assert.ok(!serialized.includes(ghToken), "raw nested secret must NOT surface in sources");
  assert.ok(serialized.includes("secret-prohibited"), "refusal marker must be present");
  const src = result.sources.find((s) => s.id === "NEST-1");
  // Benign siblings preserved (no over-redaction of the structure).
  assert.equal(src.extra.label, "keep-me", "benign sibling field must survive");
  assert.equal(src.extra.meta.note, "benign-detail", "benign nested sibling must survive");
  assert.equal(src.extra.list[0], "plain", "benign array element must survive");
  // The secret leaves only become the marker.
  assert.equal(src.extra.meta.credential, recall.classification.SECRET_REFUSAL);
  assert.equal(src.extra.list[1].deep, recall.classification.SECRET_REFUSAL);
  // Source still carries the secret-prohibited classification label.
  assert.equal(src.classification, "secret-prohibited");
});

test("COORD-288 FIXED-KEYS-STILL-REDACTED: path/event_hash/chain_head handling is unchanged", () => {
  // (a) A benign source with no role surfaces the fixed keys VERBATIM (the
  //     COORD-141 unredacted operational view is preserved — no regression).
  const benign = recall.recall("alpha beta gamma delta", {
    corpus: makeNestedSourceCorpus({ label: "ok" }),
  });
  const bsrc = benign.sources.find((s) => s.id === "NEST-1");
  assert.equal(bsrc.path, "p/nest.json", "benign path must surface verbatim (no role)");
  assert.equal(bsrc.event_hash, "h1");
  assert.equal(bsrc.chain_head, "headXYZ");

  // (b) A secret placed IN a fixed key is still collapsed to the marker by the
  //     existing fixed-key pass (the secret path was already covered; assert it).
  const ghToken = "gh" + "p_" + "C".repeat(36);
  const corpus = makeNestedSourceCorpus({ label: "ok" });
  corpus.docs[0].source.event_hash = `prefix ${ghToken}`;
  const result = recall.recall("alpha beta gamma delta", { corpus });
  const src = result.sources.find((s) => s.id === "NEST-1");
  assert.ok(!JSON.stringify(src).includes(ghToken), "secret in a fixed key must not surface");
  assert.equal(src.event_hash, recall.classification.SECRET_REFUSAL);
});

test("COORD-288 BENIGN-PRESERVED: a source with no secret surfaces normally (no over-redaction)", () => {
  const benignExtra = {
    label: "release-notes",
    meta: { note: "ordinary text", sha: "a".repeat(40) }, // git SHA: NOT a secret
    list: ["one", "two", { kind: "info" }],
  };
  // Precondition: this source is NOT labeled secret-prohibited.
  const cls = recall.classification.classifySource(
    makeNestedSourceCorpus(benignExtra).docs[0].source
  );
  assert.notEqual(cls, "secret-prohibited", "benign source must not be flagged secret");
  const result = recall.recall("alpha beta gamma delta", {
    corpus: makeNestedSourceCorpus(benignExtra),
  });
  const src = result.sources.find((s) => s.id === "NEST-1");
  // The entire benign structure surfaces unchanged — no refusal marker injected.
  assert.deepEqual(src.extra, benignExtra, "benign nested structure must surface unchanged");
  assert.ok(
    !JSON.stringify(src.extra).includes("secret-prohibited"),
    "no over-redaction: benign content must carry no refusal marker"
  );
});

test("COORD-345 active recall excludes rejected, forgotten, and private claim records", () => {
  const makeDoc = (id, text, memory = {}) => ({
    key: `decision:${id}`,
    type: "decision",
    id,
    path: `p/${id}.json`,
    text,
    tokens: recall.tokenize(text),
    memory,
    source: {
      type: "decision",
      id,
      path: `p/${id}.json`,
      event_hash: `h-${id}`,
      chain_head: "headXYZ",
      verified: true,
    },
    snippet: `${id}: ${text}`,
  });
  const corpus = {
    chainHead: "headXYZ",
    docs: [
      makeDoc("ACTIVE-1", "alpha durable active claim", {
        claim_id: "ACTIVE-1",
        memory_scope: "shared",
      }),
      makeDoc("REJECTED-1", "alpha rejected claim should not rank", {
        claim_id: "REJECTED-1",
        memory_status: "rejected",
        memory_scope: "shared",
      }),
      makeDoc("FORGOTTEN-1", "alpha forgotten claim should not rank", {
        claim_id: "FORGOTTEN-1",
        memory_status: "forgotten",
        memory_scope: "shared",
      }),
      makeDoc("PRIVATE-1", "alpha private claim should not rank", {
        claim_id: "PRIVATE-1",
        memory_scope: "human-private",
      }),
    ],
  };

  const result = recall.recall("alpha claim", { corpus, topK: 10 });
  assert.deepEqual(result.sources.map((s) => s.id), ["ACTIVE-1"]);

  const withPrivate = recall.recall("alpha private", {
    corpus,
    topK: 10,
    includePrivateMemory: true,
  });
  assert.ok(withPrivate.sources.some((s) => s.id === "PRIVATE-1"));
  assert.ok(!withPrivate.sources.some((s) => s.id === "REJECTED-1"));
  assert.ok(!withPrivate.sources.some((s) => s.id === "FORGOTTEN-1"));
});

test("COORD-346 recall retrieval is deterministic by caller team/human/local scope and rejects secrets", () => {
  const ghToken = "gh" + "p_" + "D".repeat(36);
  const makeDoc = (id, text, memory = {}) => ({
    key: `decision:${id}`,
    type: "decision",
    id,
    path: `p/${id}.json`,
    text,
    tokens: recall.tokenize(text),
    memory,
    source: {
      type: "decision",
      id,
      path: `p/${id}.json`,
      event_hash: `h-${id}`,
      chain_head: "headXYZ",
      verified: true,
    },
    snippet: `${id}: ${text}`,
  });
  const corpus = {
    chainHead: "headXYZ",
    docs: [
      makeDoc("PROJECT-1", "alpha project shared memory", {
        claim_id: "PROJECT-1",
        memory_scope: "project-shared",
      }),
      makeDoc("TEAM-1", "alpha platform team memory", {
        claim_id: "TEAM-1",
        memory_scope: "team-shared",
        team_id: "platform",
      }),
      makeDoc("PRIVATE-1", "alpha private human memory", {
        claim_id: "PRIVATE-1",
        memory_scope: "human-private",
        human_id: "human-1",
      }),
      makeDoc("LOCAL-1", "alpha local scratch memory", {
        claim_id: "LOCAL-1",
        memory_scope: "local-only",
      }),
      makeDoc("SECRET-1", `alpha secret token ${ghToken}`, {
        claim_id: "SECRET-1",
        memory_scope: "secret-prohibited",
      }),
    ],
  };

  const sharedOnly = recall.recall("alpha memory", { corpus, topK: 10 });
  assert.deepEqual(sharedOnly.sources.map((s) => s.id), ["PROJECT-1"]);

  const platform = recall.recall("alpha memory", { corpus, topK: 10, teamId: "platform" });
  assert.deepEqual(new Set(platform.sources.map((s) => s.id)), new Set(["PROJECT-1", "TEAM-1"]));

  const privateOwner = recall.recall("alpha memory", {
    corpus,
    topK: 10,
    teamId: "platform",
    includePrivateMemory: true,
    humanId: "human-1",
    includeLocalMemory: true,
  });
  assert.deepEqual(
    new Set(privateOwner.sources.map((s) => s.id)),
    new Set(["PROJECT-1", "TEAM-1", "PRIVATE-1", "LOCAL-1"])
  );
  const serialized = JSON.stringify(privateOwner);
  assert.ok(!serialized.includes("ghp_"), "secret-prohibited record must be rejected before recall promotion");
  assert.ok(!privateOwner.sources.some((s) => s.id === "SECRET-1"));

  const wrongHuman = recall.recall("alpha private", {
    corpus,
    topK: 10,
    includePrivateMemory: true,
    humanId: "human-2",
  });
  assert.ok(!wrongHuman.sources.some((s) => s.id === "PRIVATE-1"));
});

test("COORD-346 warm-start recall readout redacts low-privilege sensitive text and citations", () => {
  if (!recall.loadRbacPolicy()) {
    return;
  }
  const sensitiveLiteral = "sensitive warm start evidence literal";
  const corpus = {
    chainHead: "headXYZ",
    docs: [
      {
        key: "decision:WARM-346",
        type: "decision",
        id: "WARM-346",
        path: "coord/.runtime/private/warm-start.json",
        text: "alpha warm start privacy evidence",
        tokens: recall.tokenize("alpha warm start privacy evidence"),
        memory: { claim_id: "WARM-346", memory_scope: "sensitive" },
        source: {
          type: "decision",
          id: "WARM-346",
          path: "coord/.runtime/private/warm-start.json",
          event_hash: "h-WARM-346",
          chain_head: "headXYZ",
          verified: true,
          snippet: sensitiveLiteral,
        },
        snippet: sensitiveLiteral,
      },
    ],
  };
  const result = recall.recallForWarmStart("WARM-346", {
    query: "alpha warm start privacy evidence",
    corpus,
    role: "viewer",
    continuitySeed: false,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(sensitiveLiteral), "warm-start answer/citations must redact sensitive literal");
  assert.ok(!serialized.includes("coord/.runtime/private/warm-start.json"), "warm-start citation path must be redacted");
  assert.match(result.answer, /\[redacted\]/);
  assert.ok(result.sources[0].path.startsWith(".../"));
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
  const defaultKeys = result.sources.map(sourceKey);
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

test("recall preserves source citations for empty queries and optional warm-start context", () => {
  const doc = {
    key: "decision:MEM-001", type: "decision", id: "MEM-001",
    text: "cited deployment evidence", tokens: recall.tokenize("cited deployment evidence"), snippet: null,
    source: { type: "decision", id: "MEM-001", path: "coord/.runtime/plans/MEM-001.json", verified: true },
  };
  const corpus = { docs: [doc], memory_generation: {}, index_generation: {} };
  const calls = [];
  const embedder = { embed: (text) => { calls.push(text); return [1, 0]; } };
  const empty = recall.recall(null, { corpus });
  assert.equal(empty.query, "");
  assert.deepEqual(empty.sources, []);
  assert.match(empty.answer, /No governed memory matched/);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const match = recall.recall(null, { corpus, semantic: { embedder } });
    assert.equal(match.query, "");
    assert.deepEqual(match.sources.map(({ id }) => id), ["MEM-001"]);
    assert.equal(match.answer, "", "a missing snippet does not create uncited answer text");
  }
  assert.deepEqual(calls, ["", doc.text, ""], "cache document embeddings for the anonymous provider");
  assert.ok(!Object.keys(doc).includes("__vec_anon"));

  const available = recall.recallForWarmStart("MEM-001", { corpus, query: "MEM-001", continuitySeed: false });
  assert.equal(available.available, true);
  assert.equal(available.continuity_seed, null);
  assert.equal(available.missing_reason, null);
  assert.equal(available.sources[0].id, "MEM-001");
  const absent = recall.recallForWarmStart("MEM-404", { corpus, query: "nomatchx", continuitySeed: false });
  assert.equal(absent.available, false);
  assert.deepEqual(absent.sources, []);
  assert.match(absent.missing_reason, /continue from board, plan, prompt/);

  const policy = {
    shouldRedactForRole: (role) => role === "viewer",
    redactField: (kind, value) => kind === "evidence" ? "[redacted]" : value,
  };
  const redaction = recall.resolveRedaction("viewer", policy);
  assert.equal(redaction.redact, true);
  assert.equal(redaction.redactField("evidence", "cited text"), "[redacted]");
  assert.equal(redaction.redactField("ticket", "MEM-001"), "MEM-001");
});

test("graph recall bounds default expansion and prefers verified sources at equal scores", () => {
  const makeDoc = (id, text) => ({
    id, key: id, type: "decision", text, tokens: recall.tokenize(text), source: { verified: false },
  });
  const [seed, adjacent, distant] = [
    makeDoc("MEM-001", "seed"),
    makeDoc("MEM-002", "neighbor"),
    makeDoc("MEM-003", "distant"),
  ];
  const corpus = { docs: [seed, adjacent, distant] };
  const graph = {
    nodes: new Set(corpus.docs.map(({ id }) => id)),
    adjacency: new Map([
      [seed.id, [{ id: adjacent.id, relation: "depends-on" }]],
      [adjacent.id, [{ id: seed.id, relation: "depends-on" }, { id: distant.id, relation: "depends-on" }]],
      [distant.id, [{ id: adjacent.id, relation: "depends-on" }]],
    ]),
  };
  const defaultHops = recall.rankDocsSemantic("MEM-001", corpus, { graph, maxGraphNodes: 3 });
  assert.deepEqual(defaultHops.map(({ doc, graph: association }) => [doc.id, association?.hops]), [["MEM-001", undefined], ["MEM-002", 1]]);
  const expanded = recall.rankDocsSemantic("MEM-001", corpus, { graph, maxHops: 2, maxGraphNodes: 3 });
  assert.deepEqual(expanded.map(({ doc }) => doc.id), ["MEM-001", "MEM-002", "MEM-003"]);
  assert.ok(expanded[1].score > expanded[2].score);
  const capped = recall.rankDocsSemantic("MEM-001", corpus, { graph, maxHops: 2, maxGraphNodes: 1 });
  assert.deepEqual(capped.map(({ doc }) => doc.id), ["MEM-001", "MEM-002"]);
  adjacent.source.verified = true;
  const tied = [{ doc: seed, score: 4 }, { doc: adjacent, score: 4 }];
  for (const input of [tied, tied.slice().reverse()]) {
    assert.deepEqual(recall.sortScored(input).map(({ doc }) => doc.id), ["MEM-002", "MEM-001"]);
  }
});

test("COORD-807: recall ignores decision lines it cannot cite and still indexes correction history beside them", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord807-recall-lines-"));
  const decisionsPath = path.join(rootDir, "decisions.ndjson");
  const journalPath = path.join(rootDir, "governance-events.ndjson");
  const source = { path: "coord/.runtime/plans/IMP-807.json", verified: true };
  fs.writeFileSync(decisionsPath, [
    "{ truncated decision line",
    JSON.stringify({ critical_invariants: ["no ticket id to cite"], source }),
    JSON.stringify({ ticket_id: "IMP-807-NO-SOURCE", critical_invariants: ["no source to cite"] }),
    "null",
    "",
    JSON.stringify({
      ticket_id: "IMP-807",
      requirement_closure: { not_implemented: "Timed integration probe.", deferred_to: "IMP-808" },
      critical_invariants: [],
      critical_invariant_history: [{ value: "timing probe finished in 12ms", status: "retracted", reason: "Not an invariant." }],
      source,
    }),
  ].join("\n"));
  fs.writeFileSync(journalPath, "");
  try {
    const decisionDocs = recall.buildCorpus({ decisionsPath, journalPath, rootDir, adrDir: path.join(rootDir, "decisions") }).docs
      .filter((entry) => entry.type === "decision");
    assert.deepEqual(decisionDocs.map((entry) => entry.id), ["IMP-807"]);
    assert.match(decisionDocs[0].snippet, /^Deferred to: IMP-808\nNot implemented: Timed integration probe\./);
    assert.match(decisionDocs[0].snippet, /Historical retracted invariant: timing probe finished in 12ms/);
    assert.doesNotMatch(decisionDocs[0].snippet, /Active critical invariants:.*timing probe/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("COORD-807 prototype: recall labels retracted invariants as history, never active evidence", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord807-recall-"));
  const decisionsPath = path.join(rootDir, "decisions.ndjson");
  const journalPath = path.join(rootDir, "governance-events.ndjson");
  const value = "timing probe must not govern release";
  fs.writeFileSync(decisionsPath, `${JSON.stringify({
    ticket_id: "IMP-807",
    critical_invariants: ["Append-only history remains auditable."],
    critical_invariant_history: [
      { value, status: "retracted", reason: "This was a probe, not an invariant." },
    ],
    source: { path: "coord/.runtime/plans/IMP-807.json", verified: true },
  })}\n${JSON.stringify({
    ticket_id: "IMP-807-MALFORMED-HISTORY",
    critical_invariant_history: "legacy malformed field",
    source: { path: "coord/.runtime/plans/IMP-807-MALFORMED-HISTORY.json", verified: true },
  })}\n${JSON.stringify({
    ticket_id: "IMP-807-MISSING-ACTIVE-LIST",
    critical_invariant_history: [{ value: null, status: null, reason: null }],
    source: { path: "coord/.runtime/plans/IMP-807-MISSING-ACTIVE-LIST.json", verified: true },
  })}\n`);
  fs.writeFileSync(journalPath, "");
  const decisionDocs = recall.buildCorpus({ decisionsPath, journalPath, rootDir, adrDir: path.join(rootDir, "decisions") }).docs
    .filter((entry) => entry.type === "decision");
  const doc = decisionDocs.find((entry) => entry.id === "IMP-807");

  assert.ok(doc);
  assert.match(doc.text, /Append-only history remains auditable/);
  assert.match(doc.text, /historical retracted invariant timing probe must not govern release/);
  assert.doesNotMatch(doc.snippet, /Active critical invariants:.*timing probe/);
  assert.match(doc.snippet, /Historical retracted invariant: timing probe must not govern release/);
  assert.match(doc.snippet, /Reason: This was a probe, not an invariant/);
  const malformedHistory = decisionDocs.find((entry) => entry.id === "IMP-807-MALFORMED-HISTORY");
  assert.ok(malformedHistory);
  assert.doesNotMatch(malformedHistory.text, /historical .* invariant/);
  const missingActiveList = decisionDocs.find((entry) => entry.id === "IMP-807-MISSING-ACTIVE-LIST");
  assert.ok(missingActiveList);
  assert.match(missingActiveList.snippet, /Historical inactive invariant: \./);
  assert.doesNotMatch(missingActiveList.snippet, /Reason:/);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

// COORD-807: the CLI tail is an injectable main(argv, io). The corpus (or its
// roots) is handed in through io.options, so nothing reads the live memory tree.
function cliCorpus() {
  const text = "alpha beta gamma delta";
  const doc = (id, source) => ({
    key: `decision:${id}`,
    type: "decision",
    id,
    path: `p/${id}.json`,
    text,
    tokens: recall.tokenize(text),
    source: { type: "decision", chain_head: "headCLI", ...source },
    snippet: `${id} summary`,
  });
  return {
    chainHead: "headCLI",
    memory_generation: { chain_head: "headCLI" },
    index_generation: { chain_head: "headCLI" },
    index_warnings: [],
    docs: [
      doc("CLI-1", { id: "CLI-1", path: "p/CLI-1.json", event_hash: "0123456789abcdefXYZ", verified: true }),
      // A source with no id, path or event hash renders as empty fields.
      doc("CLI-2", { verified: false }),
    ],
  };
}

function runRecallMain(argv, options) {
  const chunks = [];
  const returned = recall.main(argv, { stdout: { write: (chunk) => chunks.push(chunk) }, options });
  assert.equal(returned, undefined);
  return chunks.join("");
}

const RECALL_USAGE = [
  "coord/engine/scripts/recall.js — Phase 1 deterministic gov recall (COORD-141).",
  "",
  "Usage:",
  '  node coord/engine/scripts/recall.js "<query>" [--role <role>] [--json]',
  "",
  "Returns a SOURCE-CITED answer over governed memory (decision records +",
  "indexed authority files). Deterministic: id/path -> BM25 -> provenance",
  "weighting. No vectors, no LLM. Permission-aware via ENT-012 when present.",
  "",
].join("\n");

test("COORD-807: recall main prints usage when no query words are given", () => {
  const refuseCorpus = { get corpus() { throw new Error("usage must not read the corpus"); } };
  assert.equal(runRecallMain([], refuseCorpus), RECALL_USAGE);
  assert.equal(runRecallMain(["--json", "--role", "viewer"], refuseCorpus), RECALL_USAGE);
});

test("COORD-807: recall main renders the cited answer and one line per source", () => {
  const out = runRecallMain(["alpha", "beta"], { corpus: cliCorpus() });
  assert.equal(out, [
    "Q: alpha beta",
    "",
    "CLI-1 summary",
    "",
    "CLI-2 summary",
    "",
    "confidence=low staleness=fresh",
    "",
    "Sources:",
    "  - [decision] CLI-1 p/CLI-1.json verified=true event_hash=0123456789ab",
    "  - [decision]   verified=false event_hash=",
    "",
  ].join("\n"));
});

test("COORD-807: recall main lists no sources when nothing matches", () => {
  const out = runRecallMain(["zzzqqqx"], { corpus: cliCorpus() });
  assert.match(out, /^Q: zzzqqqx\n\nNo governed memory matched this query\./);
  assert.ok(out.endsWith("\n\nconfidence=low staleness=fresh\n\nSources:\n"));
});

test("COORD-807: recall main --json emits the recall() result as indented JSON", () => {
  const options = { corpus: cliCorpus() };
  const out = runRecallMain(["--json", "alpha"], options);
  assert.equal(out, `${JSON.stringify(recall.recall("alpha", options), null, 2)}\n`);
  assert.deepEqual(JSON.parse(out).sources.map((s) => s.id), ["CLI-1", undefined]);
});

test("COORD-807: recall main passes --role through to redaction and treats a bare --role as no role", () => {
  // A stand-in for the optional RBAC policy, so the outcome does not depend on the cut.
  const options = { corpus: cliCorpus(), rbacPolicy: { shouldRedactForRole: (role) => role === "viewer" } };
  const tail = (out) => out.slice(out.indexOf("Sources:\n"));

  const viewer = runRecallMain(["alpha", "--role", "viewer"], options);
  assert.match(viewer, /^Q: alpha\n\nCLI-1 \(\[redacted\]\): \[redacted\]\n\n/);
  assert.equal(tail(viewer), [
    "Sources:",
    "  - [decision] CLI-1 [redacted] verified=true event_hash=[redacted]",
    "  - [decision]   verified=false event_hash=",
    "",
  ].join("\n"));

  const operator = runRecallMain(["--role", "operator", "alpha"], options);
  assert.equal(operator, runRecallMain(["alpha"], options));
  assert.doesNotMatch(operator, /\[redacted\]/);

  // `--role` with no value falls back to the unredacted no-role view.
  assert.equal(runRecallMain(["alpha", "--role"], options), runRecallMain(["alpha"], options));
});

test("COORD-807: recall main reads the corpus from injected roots", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord807-recall-cli-"));
  const decisionsPath = path.join(rootDir, "decisions.ndjson");
  const journalPath = path.join(rootDir, "governance-events.ndjson");
  fs.writeFileSync(decisionsPath, `${JSON.stringify({
    ticket_id: "IMP-807",
    critical_invariants: ["Append-only history remains auditable."],
    source: { path: "coord/.runtime/plans/IMP-807.json", verified: true },
  })}\n`);
  fs.writeFileSync(journalPath, "");
  try {
    const out = runRecallMain(["IMP-807"], { decisionsPath, journalPath, rootDir, adrDir: path.join(rootDir, "decisions") });
    assert.match(out, /^Q: IMP-807\n\n/);
    assert.match(out, /Append-only history remains auditable/);
    assert.match(out, /\nSources:\n {2}- \[decision\] IMP-807 coord\/\.runtime\/plans\/IMP-807\.json verified=true event_hash=\n$/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("COORD-807: the recall script run as a process prints usage and exits 0", () => {
  const { spawnSync } = require("child_process");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coord807-recall-spawn-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "recall.js")], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, RECALL_USAGE);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- the command-line entrypoint ---------------------------------------------
// The CLI has no corpus flag, so the child process gets the same MEMORY_DIR
// redirect this file uses in-process (COORD-300), pointed at a one-record corpus
// whose source carries no path and no event hash.
function makeRecallCliSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir);
  fs.writeFileSync(
    path.join(memoryDir, "decisions.ndjson"),
    JSON.stringify({
      ticket_id: "ZZTOP-901",
      source: {},
      requirement_closure: { ticket_ask: "quokka telemetry ingestion", implemented: "quokka telemetry shipped" },
    }) + "\n",
  );
  const preload = path.join(dir, "redirect-memory.js");
  const contextPath = resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js");
  const pathsModulePath = path.join(COORD_ROOT_DIR, "paths.js");
  fs.writeFileSync(
    preload,
    "const context = require(" + JSON.stringify(contextPath) + ");\n" +
      "const { resolveEngineModule } = require(" + JSON.stringify(pathsModulePath) + ");\n" +
      "const { createGovernanceTestContextHarness } = require(resolveEngineModule(context.COORD_DIR, \"scripts/governance-test-context.js\"));\n" +
      "createGovernanceTestContextHarness({ state: context.state, defaultPaths: context.DEFAULT_PATHS })" +
        ".installWorkerContext({ MEMORY_DIR: " + JSON.stringify(memoryDir) + " });\n",
  );
  const { spawnSync } = require("child_process");
  return (args) => {
    const result = spawnSync(process.execPath, ["-r", preload, path.join(__dirname, "recall.js"), ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
}

test("recall CLI: no query prints usage instead of running an empty recall", (t) => {
  const run = makeRecallCliSandbox(t);
  for (const args of [[], ["--json"], ["--role", "viewer"]]) {
    const out = run(args);
    assert.match(out, /^coord\/engine\/scripts\/recall\.js — Phase 1 deterministic gov recall \(COORD-141\)\.\n/);
    assert.ok(out.includes('  node coord/engine/scripts/recall.js "<query>" [--role <role>] [--json]\n'));
    assert.doesNotMatch(out, /Sources:|confidence=/);
  }
});

test("recall CLI: text output cites every source and renders absent provenance as empty, never undefined", (t) => {
  const run = makeRecallCliSandbox(t);
  // Separate argv words are one query; it names a decision id and a file path.
  const out = run(["ZZTOP-901", "coord/engine/scripts/journal.js"]);
  assert.match(out, /^Q: ZZTOP-901 coord\/engine\/scripts\/journal\.js\n\n/);
  assert.match(out, /\nconfidence=high staleness=(fresh|stale)\n\nSources:\n/);
  assert.ok(out.includes("  - [decision] ZZTOP-901  verified=false event_hash=\n"), out);
  assert.match(out, /\n {2}- \[file\] {2}coord\/engine\/scripts\/journal\.js verified=(true|false) event_hash=[0-9a-f]{12}\n/);
  assert.doesNotMatch(out, /undefined|null/);
});

test("recall CLI: --json emits the cited-answer contract and --role is optional", (t) => {
  const run = makeRecallCliSandbox(t);
  const plain = JSON.parse(run(["--json", "ZZTOP-901"]));
  assert.equal(plain.query, "ZZTOP-901");
  assert.equal(plain.confidence, "high");
  assert.equal(plain.sources[0].type, "decision");
  assert.equal(plain.sources[0].id, "ZZTOP-901");
  assert.equal(plain.sources[0].event_hash, null);
  assert.match(plain.answer, /quokka telemetry ingestion/);

  // A trailing --role with no value is "no role": the unredacted operational view.
  assert.deepEqual(JSON.parse(run(["ZZTOP-901", "--json", "--role"])), plain);

  const operator = JSON.parse(run(["--role", "operator", "ZZTOP-901", "--json"]));
  assert.equal(operator.query, "ZZTOP-901");
  assert.equal(operator.sources[0].id, "ZZTOP-901");
});

test("COORD-866: the optional-tier policy loader degrades to null when the tier module cannot be loaded", () => {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function loadWithoutTier(request, ...rest) {
    if (/-rbac-policy\.js$/.test(String(request))) throw new Error("optional tier is absent in this cut");
    return originalLoad.call(this, request, ...rest);
  };
  try {
    assert.equal(recall.loadRbacPolicy(), null);
  } finally {
    Module._load = originalLoad;
  }
});

// --- COORD-993 characterization: the BM25 baseline shared by rankDocs and
// rankDocsSemantic. The pinned values were captured from the pre-refactor
// ranker on a fixed synthetic corpus. Both paths must keep producing them
// unchanged after the shared preamble is extracted.
test("COORD-993 characterization: rankDocs and rankDocsSemantic baseline output is pinned", () => {
  const doc = ({ key, type, id, path: p, text, verified }) => ({
    key,
    type,
    id,
    path: p,
    text,
    tokens: recall.tokenize(text),
    source: { type, id, path: p, event_hash: "h-" + key, chain_head: "headXYZ", verified },
  });
  const corpus = {
    chainHead: "headXYZ",
    docs: [
      doc({ key: "decision:COORD-901", type: "decision", id: "COORD-901", path: "p/a.json", text: "alpha beta gamma replay journal", verified: false }),
      doc({ key: "decision:COORD-902", type: "decision", id: "COORD-902", path: "p/b.json", text: "alpha alpha delta lock recovery", verified: true }),
      doc({ key: "decision:COORD-903", type: "decision", id: "COORD-903", path: "p/c.json", text: "beta epsilon zeta stale worktree", verified: true }),
      doc({ key: "file:coord/engine/scripts/journal.js", type: "file", id: undefined, path: "coord/engine/scripts/journal.js", text: "journal file alpha replay", verified: false }),
      doc({ key: "file:coord/engine/scripts/recall.js", type: "file", id: undefined, path: "coord/engine/scripts/recall.js", text: "recall bm25 ranking file", verified: true }),
      doc({ key: "decision:COORD-904", type: "decision", id: "COORD-904", path: "p/d.json", text: "unrelated words only here", verified: false }),
    ],
  };
  const pinned = {"alpha beta":{"rankDocs":[["decision:COORD-901",1.7227665977411033,false],["decision:COORD-903",1.5296194171811581,false],["decision:COORD-902",1.490210257942779,false],["file:coord/engine/scripts/journal.js",0.7617001984175223,false]],"rankDocsSemantic":[["decision:COORD-901",1.7227665977411033,false,1.7227665977411033],["decision:COORD-903",1.5296194171811581,false,1.5296194171811581],["decision:COORD-902",1.490210257942779,false,1.490210257942779],["file:coord/engine/scripts/journal.js",0.7617001984175223,false,0.7617001984175223]]},"COORD-901 alpha":{"rankDocs":[["decision:COORD-901",1000.6931471805599,true],["decision:COORD-902",1.490210257942779,false],["file:coord/engine/scripts/journal.js",0.7617001984175223,false]],"rankDocsSemantic":[["decision:COORD-901",1000.6931471805599,true,1000.6931471805599],["decision:COORD-902",1.490210257942779,false,1.490210257942779],["file:coord/engine/scripts/journal.js",0.7617001984175223,false,0.7617001984175223]]},"files journal alpha":{"rankDocs":[["file:coord/engine/scripts/journal.js",3.893150107407806,false],["decision:COORD-901",1.7227665977411033,false],["decision:COORD-902",1.490210257942779,false]],"rankDocsSemantic":[["file:coord/engine/scripts/journal.js",3.893150107407806,false,3.893150107407806],["decision:COORD-901",1.7227665977411033,false,1.7227665977411033],["decision:COORD-902",1.490210257942779,false,1.490210257942779]]},"coord/engine/scripts/journal.js":{"rankDocs":[["file:coord/engine/scripts/journal.js",1001.1314499089902,true],["decision:COORD-901",1.0296194171811581,false]],"rankDocsSemantic":[["file:coord/engine/scripts/journal.js",1001.1314499089902,true,1001.1314499089902],["decision:COORD-901",1.0296194171811581,false,1.0296194171811581]]},"zeta stale":{"rankDocs":[["decision:COORD-903",3.5808900818942977,false]],"rankDocsSemantic":[["decision:COORD-903",3.5808900818942977,false,3.5808900818942977]]},"nomatchtokenxyz":{"rankDocs":[],"rankDocsSemantic":[]}};
  for (const [query, expected] of Object.entries(pinned)) {
    assert.deepEqual(
      recall.rankDocs(query, corpus).map((r) => [r.doc.key, r.score, r.exact]),
      expected.rankDocs,
      "rankDocs output drifted for query: " + query
    );
    assert.deepEqual(
      recall.rankDocsSemantic(query, corpus).map((r) => [r.doc.key, r.score, r.exact, r.baseline]),
      expected.rankDocsSemantic,
      "rankDocsSemantic baseline drifted for query: " + query
    );
  }
});
