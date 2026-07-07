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

// COORD-198: requirement_closure is APPEND-ONLY, so a re-closure (e.g. a takeover
// that drives partial -> complete) leaves BOTH the superseded and the latest
// labelled block in the ordered array. The derived verdict/debt signals must read
// the LATEST occurrence of each labelled line (recency), not the first/any. FIX-003
// is a fixture whose closure was re-set from partial -> complete.
test("requirement_closure parse uses verdict RECENCY: a partial superseded by complete reads as complete", () => {
  const decisions = extractFromFixture();
  const fix3 = decisions.find((d) => d.ticket_id === "FIX-003");
  assert.ok(fix3, "FIX-003 re-closure decision record exists");
  const c = fix3.requirement_closure;
  // The LAST "Closeout verdict:" line wins (complete), not the earlier "partial".
  assert.equal(c.verdict, "complete");
  // The LAST "Not implemented:" line wins ("none — full acceptance bar met"),
  // superseding the earlier "ACCEPTANCE-cut NOT met" carve-out.
  assert.match(c.not_implemented, /^none\b/);
  // The LAST "Ticket ask:" / "Implemented:" / "Deferred to:" lines win too.
  assert.match(c.ticket_ask, /finish the cut/);
  assert.match(c.implemented, /second-pass/);
  assert.equal(c.deferred_to, "none");
  assert.deepEqual(c.deferred_to_tickets, [], "the later 'Deferred to: none' supersedes the earlier FIX-009 deferral");
});

test("not_implemented_is_none treats a recency-correct 'none — ...' as none (no carve-out)", () => {
  const decisions = extractFromFixture();
  const fix3 = decisions.find((d) => d.ticket_id === "FIX-003");
  assert.ok(fix3);
  // "none — full acceptance bar met" is a none-class value: present-but-no-debt.
  assert.equal(fix3.requirement_closure.not_implemented_is_none, true);
  // The single-closure FIX-001 ("Not implemented: none") is also none-class.
  const fix1 = decisions.find((d) => d.ticket_id === "FIX-001");
  assert.equal(fix1.requirement_closure.not_implemented_is_none, true);
});

test("isNoneClosureValue: leading-none token is none; a real carve-out is not", () => {
  assert.equal(extractor.isNoneClosureValue("none"), true);
  assert.equal(extractor.isNoneClosureValue("None"), true);
  assert.equal(extractor.isNoneClosureValue("none — full acceptance bar met"), true);
  assert.equal(extractor.isNoneClosureValue("none, nothing deferred"), true);
  assert.equal(extractor.isNoneClosureValue(null), true);
  assert.equal(extractor.isNoneClosureValue(""), true);
  // Real carve-outs (and "none"-prefixed WORDS) are NOT none-class.
  assert.equal(extractor.isNoneClosureValue("ACCEPTANCE-cut NOT met"), false);
  assert.equal(extractor.isNoneClosureValue("nonexistent edge case left unhandled"), false);
});

test("scaffold-only (unworked) plan records are dropped, not asserted", () => {
  const decisions = extractFromFixture();
  assert.equal(
    decisions.find((d) => d.ticket_id === "FIX-002"),
    undefined,
    "a TODO-scaffold-only record must not produce a decision"
  );
});

test("decision objects normalize operational human decisions without requiring ADR shape", () => {
  const os = require("os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord330-decisions-"));
  const plansDir = path.join(tmpDir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(
    path.join(plansDir, "OPS-010.json"),
    JSON.stringify({
      schema_version: 1,
      ticket_id: "OPS-010",
      decision_objects: [
        {
          id: "DEC-010",
          status: "open",
          type: "human",
          subject: "pilot rollout owner",
          question: "Who owns the pilot enablement decision?",
          why_now: "The next risky rollout ticket needs a named approver.",
          options: [
            { id: "a", label: "Product owner decides", tradeoffs: ["fast"] },
            "Escalate to steering review",
          ],
          recommendation: "Product owner decides.",
          owner: "product",
          needed_by: "before OPS-011",
          sources: [{ type: "ticket", ref: "OPS-010" }],
          linked: { tickets: ["OPS-011"], cadences: ["weekly-pilot"] },
        },
      ],
    }),
    "utf8"
  );

  const decisions = extractor.extractDecisions({
    plansDir,
    journalPath: path.join(tmpDir, "missing.ndjson"),
    rootDir: tmpDir,
  });

  assert.equal(decisions.length, 1);
  const [object] = decisions[0].decision_objects;
  assert.equal(object.schema_version, extractor.DECISION_OBJECT_SCHEMA_VERSION);
  assert.equal(object.id, "DEC-010");
  assert.equal(object.status, "open");
  assert.equal(object.type, "human");
  assert.equal(object.subject, "pilot rollout owner");
  assert.equal(object.question, "Who owns the pilot enablement decision?");
  assert.equal(object.why_now, "The next risky rollout ticket needs a named approver.");
  assert.deepEqual(object.options.map((option) => option.label), [
    "Product owner decides",
    "Escalate to steering review",
  ]);
  assert.equal(object.recommendation, "Product owner decides.");
  assert.equal(object.owner, "product");
  assert.equal(object.needed_by, "before OPS-011");
  assert.deepEqual(object.sources, [{ type: "ticket", ref: "OPS-010", note: null }]);
  assert.deepEqual(object.supersession, { supersedes: [], superseded_by: null, reason: null });
  assert.deepEqual(object.linked, { tickets: ["OPS-011"], cadences: ["weekly-pilot"] });
  assert.equal(object.blocking.unresolved_blocks, "scoped_risky_work");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("open decisions are selectable for warm-start in linked ticket or cadence scope", () => {
  const open = extractor.normalizeDecisionObject(
    {
      id: "DEC-OPEN",
      status: "open",
      question: "Approve risky import?",
      linked: { tickets: ["T-200"], cadences: ["monthly-import"] },
    },
    0,
    "T-100"
  );
  const resolved = extractor.normalizeDecisionObject(
    {
      id: "DEC-DONE",
      status: "resolved",
      question: "Pick memory target?",
      resolution: { answer: "memory", durable: true, promote_to: ["memory"] },
      linked: { tickets: ["T-200"] },
    },
    1,
    "T-100"
  );
  const records = [{ ticket_id: "T-100", decision_objects: [resolved, open] }];

  assert.deepEqual(
    extractor.selectWarmStartDecisionObjects(records, { ticket_id: "T-200" }).map((d) => d.id),
    ["DEC-OPEN"]
  );
  assert.deepEqual(
    extractor.selectWarmStartDecisionObjects(records, { cadence: "monthly-import" }).map((d) => d.id),
    ["DEC-OPEN"]
  );
  assert.deepEqual(
    extractor.selectWarmStartDecisionObjects(records, { ticket_id: "T-999" }).map((d) => d.id),
    []
  );
});

test("resolved durable decisions can feed memory or ADR promotion selectors", () => {
  const durableMemory = extractor.normalizeDecisionObject({
    id: "DEC-MEM",
    status: "resolved",
    question: "Should this become reusable memory?",
    resolution: { answer: "yes", durable: true, promote_to: ["memory"] },
  });
  const durableAdr = extractor.normalizeDecisionObject({
    id: "DEC-ADR",
    status: "accepted",
    question: "Should this become an ADR?",
    resolution: { answer: "yes", promote_to: ["adr"] },
  });
  const localOnly = extractor.normalizeDecisionObject({
    id: "DEC-LOCAL",
    status: "resolved",
    question: "Should this remain local?",
    resolution: { answer: "yes" },
  });

  assert.deepEqual(
    extractor
      .selectResolvedDurableDecisionObjects([
        { ticket_id: "T-1", decision_objects: [localOnly, durableAdr, durableMemory] },
      ])
      .map((d) => d.id),
    ["DEC-ADR", "DEC-MEM"]
  );
});

test("unresolved decisions block only scoped risky work, not ordinary tickets", () => {
  const decision = extractor.normalizeDecisionObject({
    id: "DEC-RISK",
    status: "open",
    question: "Can the migration delete old state?",
    linked: { tickets: ["T-RISK"] },
  });

  assert.equal(
    extractor.decisionBlocksScopedRiskyWork(decision, { ticket_id: "T-RISK", risky: true }),
    true
  );
  assert.equal(
    extractor.decisionBlocksScopedRiskyWork(decision, { ticket_id: "T-RISK", risky: false }),
    false
  );
  assert.equal(
    extractor.decisionBlocksScopedRiskyWork(decision, { ticket_id: "T-ORDINARY", risky: true }),
    false
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

// COORD-289: era-aware line citations. A post-migration event (hash_alg:"sha256")
// is cited via sha256 of its verbatim stored line; a pre-migration event keeps the
// sha1 citation byte-for-byte. The chain head follows the last event's era.
test("COORD-289: indexJournalProvenance cites sha256 for post-migration events, sha1 for pre", () => {
  const os = require("os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord289-extractor-"));
  const journalPath = path.join(tmpDir, "governance-events.ndjson");

  const pre = { ts: "t1", command: "start", ticket: "P", prev_event_hash: "genesis" };
  const post = { ts: "t2", command: "start", ticket: "Q", hash_alg: "sha256", prev_event_hash: "x".repeat(64) };
  const preLine = JSON.stringify(pre);
  const postLine = JSON.stringify(post);
  fs.writeFileSync(journalPath, `${preLine}\n${postLine}\n`, "utf8");

  const sha1 = (v) => crypto.createHash("sha1").update(v).digest("hex");
  const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

  const { index, chainHead } = extractor.indexJournalProvenance(journalPath);
  assert.equal(index.get("P").event_hash, sha1(preLine), "pre-migration event cited via sha1");
  assert.equal(index.get("P").event_hash.length, 40);
  assert.equal(index.get("Q").event_hash, sha256(postLine), "post-migration event cited via sha256");
  assert.equal(index.get("Q").event_hash.length, 64);
  assert.equal(chainHead, sha256(postLine), "chain head follows the last event's era (sha256)");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
