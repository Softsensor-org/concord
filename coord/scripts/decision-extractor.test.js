"use strict";

// COORD-140: tests for the Phase 0 decision-record extractor + eval benchmark.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const extractor = require("./decision-extractor.js");
const { skipIfNoCorpus } = require("./memory-corpus-guard.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "decision-extractor");
const FIXTURE_PLANS = path.join(FIXTURE_DIR, "plans");
const FIXTURE_JOURNAL = path.join(FIXTURE_DIR, "governance-events.ndjson");
const ROOT_DIR = path.resolve(__dirname, "..", "..");

function extractFromFixture() {
  return extractor.extractDecisions({
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    rootDir: ROOT_DIR,
  });
}

test("extractor produces a well-formed record for a worked ticket", () => {
  const decisions = extractFromFixture();
  const fix1 = decisions.find((d) => d.ticket_id === "FIX-001");
  assert.ok(fix1, "FIX-001 decision record exists");

  // requirement_closure transformed including deferred-to + verdict.
  assert.equal(fix1.requirement_closure.verdict, "complete");
  assert.equal(fix1.requirement_closure.deferred_to, "FIX-002 (follow-up scenario)");
  assert.deepEqual(fix1.requirement_closure.deferred_to_tickets, ["FIX-002"]);
  assert.match(fix1.requirement_closure.ticket_ask, /sample decision-bearing plan record/);
  assert.equal(fix1.requirement_closure.not_implemented, "none");

  // self_review risks/findings/verdict carried through.
  assert.equal(fix1.self_review.length, 1);
  assert.equal(fix1.self_review[0].verdict, "pass");
  assert.equal(fix1.self_review[0].findings, "none");
  assert.equal(fix1.self_review[0].risks.length, 2);

  // critical_invariants carried (scaffold-free).
  assert.equal(fix1.critical_invariants.length, 2);
});

test("scaffold-only (unworked) plan records are dropped, not asserted", () => {
  const decisions = extractFromFixture();
  assert.equal(
    decisions.find((d) => d.ticket_id === "FIX-002"),
    undefined,
    "a TODO-scaffold-only record must not produce a decision"
  );
});

test("each decision record carries provenance for citations (event_hash, chain_head, verified)", () => {
  const decisions = extractFromFixture();
  const fix1 = decisions.find((d) => d.ticket_id === "FIX-001");

  const lines = fs
    .readFileSync(FIXTURE_JOURNAL, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
  // Latest FIX-001 event is the second line (mark-done), which carries a real
  // prev_event_hash -> verified. chain_head is the hash of the last stored line.
  const expectedEventHash = sha1(lines[1]);
  const expectedChainHead = sha1(lines[lines.length - 1]);

  assert.equal(fix1.source.type, "decision");
  assert.equal(fix1.source.id, "FIX-001");
  assert.equal(fix1.source.path, "coord/scripts/__fixtures__/decision-extractor/plans/FIX-001.json");
  assert.equal(fix1.source.event_hash, expectedEventHash);
  assert.equal(fix1.source.chain_head, expectedChainHead);
  assert.equal(fix1.source.verified, true);
});

test("rebuild is deterministic: extracting twice yields byte-identical output", () => {
  const first = extractor.serializeDecisions(extractFromFixture());
  const second = extractor.serializeDecisions(extractFromFixture());
  assert.equal(first, second);
  // And the ordering is pinned by ticket id.
  const ids = extractFromFixture().map((d) => d.ticket_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test("extractor tolerates a missing journal (provenance degrades, never throws)", () => {
  const decisions = extractor.extractDecisions({
    plansDir: FIXTURE_PLANS,
    journalPath: path.join(FIXTURE_DIR, "does-not-exist.ndjson"),
    rootDir: ROOT_DIR,
  });
  const fix1 = decisions.find((d) => d.ticket_id === "FIX-001");
  assert.ok(fix1);
  assert.equal(fix1.source.event_hash, null);
  assert.equal(fix1.source.chain_head, null);
  assert.equal(fix1.source.verified, false);
});

// --- eval benchmark grounding ----------------------------------------------

const BENCHMARK_PATH = path.join(ROOT_DIR, "coord", "memory", "eval", "benchmark.json");

test("eval benchmark is well-formed and grounded in REAL repo history", (t) => {
  if (skipIfNoCorpus(t)) return;
  const benchmark = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf8"));
  assert.ok(Array.isArray(benchmark.cases) && benchmark.cases.length >= 5, "at least 5 real-history cases");

  // Rebuild decisions from the LIVE repo so we can validate decision-id citations.
  const liveDecisions = extractor.extractDecisions();
  const decisionIds = new Set(liveDecisions.map((d) => d.ticket_id));

  for (const testCase of benchmark.cases) {
    assert.ok(testCase.id, "case has an id");
    assert.ok(testCase.question, `${testCase.id} has a question`);
    assert.ok(
      Array.isArray(testCase.expected_sources) && testCase.expected_sources.length > 0,
      `${testCase.id} cites at least one source`
    );
    assert.ok(
      Array.isArray(testCase.must_include) && testCase.must_include.length > 0,
      `${testCase.id} states what a correct answer must include`
    );

    for (const source of testCase.expected_sources) {
      if (source.type === "file") {
        const abs = path.join(ROOT_DIR, source.path);
        assert.ok(fs.existsSync(abs), `${testCase.id}: cited file ${source.path} must exist`);
      } else if (source.type === "decision" || source.type === "ticket") {
        // The cited plan record must exist on disk...
        const abs = path.join(ROOT_DIR, source.path);
        assert.ok(fs.existsSync(abs), `${testCase.id}: cited plan record ${source.path} must exist`);
        // ...and it must actually yield a decision record (real, worked history).
        assert.ok(
          decisionIds.has(source.id),
          `${testCase.id}: cited decision ${source.id} must be extractable from real history`
        );
      } else {
        assert.fail(`${testCase.id}: unknown source type ${source.type}`);
      }
    }
  }
});

test("each benchmark must_include string is grounded in a cited source", (t) => {
  if (skipIfNoCorpus(t)) return;
  const benchmark = JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf8"));
  const liveDecisions = extractor.extractDecisions();
  const decisionById = new Map(liveDecisions.map((d) => [d.ticket_id, d]));

  for (const testCase of benchmark.cases) {
    // Gather the text a correct cited answer could draw from: the cited decision
    // records' content + the cited files' content.
    let corpus = "";
    for (const source of testCase.expected_sources) {
      if (source.type === "file") {
        corpus += fs.readFileSync(path.join(ROOT_DIR, source.path), "utf8");
      } else {
        const decision = decisionById.get(source.id);
        if (decision) {
          corpus += JSON.stringify(decision);
        }
      }
    }
    for (const fragment of testCase.must_include) {
      assert.ok(
        corpus.includes(fragment),
        `${testCase.id}: required answer fragment "${fragment}" must be grounded in a cited source`
      );
    }
  }
});
