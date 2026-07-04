"use strict";

// COORD-432: direct coverage for memory-corpus-guard.js — the artifact-portability
// test helper (skipIfNoCorpus / decisionCorpusAvailable) used by the memory
// eval/recall/summary/insight suites, plus the COORD-344 red-team fixture builder.
// It was wired into 6 test files but had no test of its own.

const test = require("node:test");
const assert = require("node:assert");
const guard = require("./memory-corpus-guard.js");

test("COORD-432: decisionCorpusAvailable returns a boolean", () => {
  assert.equal(typeof guard.decisionCorpusAvailable(), "boolean");
});

test("COORD-432: skipIfNoCorpus does not skip and returns false when the corpus is available", () => {
  // The donor ships the live decision corpus, so the guard must let the test run.
  // (In a stripped artifact the corpus is absent; that path is exercised by the
  // null-safety assertion below.)
  if (!guard.decisionCorpusAvailable()) return;
  let skipped = false;
  const t = { skip: () => { skipped = true; } };
  assert.equal(guard.skipIfNoCorpus(t), false);
  assert.equal(skipped, false, "must not skip when the corpus is present");
});

test("COORD-432: skipIfNoCorpus is null-safe and NO_CORPUS_SKIP is a stable reason", () => {
  assert.doesNotThrow(() => guard.skipIfNoCorpus(undefined));
  assert.match(guard.NO_CORPUS_SKIP, /COORD-197/);
  assert.ok(guard.NO_CORPUS_SKIP.length > 0);
});

test("COORD-432: buildPoisoningRedTeamCorpus is a well-formed hostile fixture (COORD-344)", () => {
  const corpus = guard.buildPoisoningRedTeamCorpus();
  assert.ok(corpus.policy && Array.isArray(corpus.claims));
  assert.ok(corpus.claims.length >= 7, "models each adversarial source channel");
  for (const claim of corpus.claims) {
    assert.ok(claim.id && claim.kind && claim.statement, "each claim has id/kind/statement");
    assert.ok(Array.isArray(claim.evidence) && claim.evidence.length > 0, "each claim carries evidence");
  }
  // The fixture must model every distinct hostile channel the compiler treats as
  // evidence-only (docs, code comments, support notes, runtime receipts, web/MCP,
  // daily journal).
  const channels = new Set(corpus.claims.flatMap((c) => c.evidence.map((e) => e.type)));
  for (const ch of ["doc", "code_comment", "support_note", "runtime_receipt", "web", "mcp", "daily_journal"]) {
    assert.ok(channels.has(ch), `red-team corpus must model the ${ch} channel`);
  }
});
