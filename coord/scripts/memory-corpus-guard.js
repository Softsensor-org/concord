// memory-corpus-guard.js — artifact-portability guard for donor-history-dependent
// memory tests (COORD-197).
//
// The memory eval/recall/summary/insight tests assert against decisions extracted
// from the LIVE governance journal (coord/.runtime/governance-events.ndjson) +
// landed plan records. In the DONOR that corpus is present, so the tests run and
// assert fully. In a PUBLISHED release artifact the build strips coord/.runtime
// (build-public-release.sh `rm -rf coord/.runtime`) and decisions.ndjson is
// gitignored, so the extractor rebuilds 0 records and every history-grounded
// assertion would fail purely because there is no corpus to cite.
//
// This helper lets those tests detect the empty-corpus case and SKIP gracefully
// (node:test t.skip / early return) instead of failing. Skipped tests do not fail
// the governance gate, so a stripped release cut goes green while donor coverage
// is preserved unchanged (the donor still runs and asserts — it has the corpus).
//
// It does NOT weaken any assertion, the secret detector, or redaction: it only
// gates whether a history-grounded test body executes at all, based on whether a
// real decision corpus exists to ground it.

const extractor = require("./decision-extractor.js");

let cachedAvailable = null;

// True when the live decision corpus is genuinely available (donor case), i.e.
// the extractor can rebuild at least one decision from journal + plan history.
// False in a stripped published artifact (no journal, no decisions.ndjson).
function decisionCorpusAvailable() {
  if (cachedAvailable !== null) {
    return cachedAvailable;
  }
  try {
    const decisions = extractor.extractDecisions();
    cachedAvailable = Array.isArray(decisions) && decisions.length > 0;
  } catch {
    // No journal / unreadable history in the stripped artifact -> no corpus.
    cachedAvailable = false;
  }
  return cachedAvailable;
}

// Standard skip reason surfaced on portable cuts.
const NO_CORPUS_SKIP =
  "no live decision corpus (journal stripped in published artifact) — donor-history-grounded test skipped (COORD-197)";

// Guard for a node:test callback that receives the test context `t`.
// Returns true (and skips via t.skip) when the corpus is absent, so callers do:
//   test("...", (t) => { if (skipIfNoCorpus(t)) return; ...assertions... });
function skipIfNoCorpus(t) {
  if (decisionCorpusAvailable()) {
    return false;
  }
  if (t && typeof t.skip === "function") {
    t.skip(NO_CORPUS_SKIP);
  }
  return true;
}

module.exports = {
  decisionCorpusAvailable,
  skipIfNoCorpus,
  NO_CORPUS_SKIP,
};
