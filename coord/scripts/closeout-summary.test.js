"use strict";

// COORD-149: tests for the auto evidence-backed closeout-summary generator.
//
// Coverage maps to the ticket ask + the cardinal guardrail:
//  - the summary has the three sections and is marked REPORTS-only / non-authority;
//  - it GROUNDS delivered / gate / review / commit / attestation claims in the
//    ticket's REAL artifacts, each citation pinning event_hash + chain_head +
//    verified (the §7 shape);
//  - source commit(s) / landing events are surfaced from the journal, cited to a
//    verified (hash-chained) event_hash;
//  - a conformance attestation that anchors the closeout (its signed chain head ==
//    a ticket event hash) is cited; one that does NOT anchor is absent (not
//    fabricated);
//  - the §5 invariant: EVERY emitted claim across every section carries a citation
//    (no uncited claim) — assertable via uncitedClaims();
//  - honest degradation: a ticket lacking gate / review / attestation evidence
//    OMITS those sections rather than fabricating them;
//  - REPORTS-only: the generator mutates NOTHING — fixture sources are byte-
//    unchanged after a run;
//  - determinism: same ticket history -> byte-identical content digest;
//  - the live repo summary for an already-landed ticket (COORD-141) also emits no
//    uncited claim and grounds delivered/gate/review/commit claims (real-history
//    proof / feature-proof).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const closeout = require("./closeout-summary.js");
const { skipIfNoCorpus } = require("./memory-corpus-guard.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "closeout-summary");
const FIXTURE_BOARD = path.join(FIXTURE_DIR, "board.json");
const FIXTURE_PLANS = path.join(FIXTURE_DIR, "plans");
const FIXTURE_JOURNAL = path.join(FIXTURE_DIR, "governance-events.ndjson");
const FIXTURE_ATTESTATIONS = path.join(FIXTURE_DIR, "attestations");

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

function summaryFromFixture(ticketId, overrides = {}) {
  return closeout.buildSummary({
    ticketId,
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    attestationsDir: FIXTURE_ATTESTATIONS,
    rootDir: FIXTURE_DIR,
    now: FIXED_NOW,
    ...overrides,
  });
}

// --- summary shape + guardrail -----------------------------------------------

test("summary has the three sections and is marked REPORTS-only / non-authority", () => {
  const s = summaryFromFixture("CLS-100");
  assert.equal(s.kind, "closeout-summary");
  assert.equal(s.authority, false);
  assert.equal(s.recommends_only, true);
  assert.equal(s.ticket_id, "CLS-100");
  assert.deepEqual(
    Object.keys(s.sections).sort(),
    ["ask_and_delivered", "decisions", "evidence_trail"]
  );
  // The subject is grounded in the board row and cited.
  assert.ok(s.subject);
  assert.equal(s.subject.status, "done");
  assert.ok(s.subject.citations.length > 0);
});

// --- SECTION 1: ask & delivered, grounded in requirement_closure -------------

test("ask & delivered grounds what-was-asked / delivered / verdict in the plan record", () => {
  const s = summaryFromFixture("CLS-100");
  const claims = s.sections.ask_and_delivered.claims;
  const byField = Object.fromEntries(claims.map((c) => [c.field, c]));
  assert.match(byField.ticket_ask.text, /idempotent refund reconciliation/i);
  assert.match(byField.implemented.text, /reconciliation ledger|idempotency guard/i);
  assert.match(byField.not_implemented.text, /multi-currency/i);
  assert.equal(byField.closeout_verdict.text, "complete");
  // Every claim cites the plan record path + chain_head.
  for (const c of claims) {
    assert.equal(c.citations[0].type, "decision");
    assert.match(c.citations[0].path, /CLS-100\.json$/);
    assert.ok(c.citations[0].chain_head);
  }
});

// --- SECTION 2: evidence trail (gates + reviews + commits/landing + attestation)

test("evidence trail grounds repo-gate results + review cycles in the plan record", () => {
  const s = summaryFromFixture("CLS-100");
  const ev = s.sections.evidence_trail;
  assert.ok(ev.has_evidence);
  // repo gates: the recorded results are surfaced verbatim + cited.
  assert.equal(ev.gate_results.length, 2);
  assert.ok(ev.gate_results.some((g) => /412 pass \/ 0 fail/.test(g.result)));
  for (const g of ev.gate_results) {
    assert.match(g.citations[0].path, /CLS-100\.json$/);
  }
  // review cycles: lens + verdict, cited.
  assert.equal(ev.review_cycles.length, 2);
  assert.ok(ev.review_cycles.every((r) => r.verdict === "pass"));
  assert.ok(ev.review_cycles.some((r) => /Contract and state invariants/.test(r.lens)));
});

test("evidence trail surfaces source commit + landing events cited to a VERIFIED event_hash", () => {
  const s = summaryFromFixture("CLS-100");
  const landing = s.sections.evidence_trail.landing;
  // commit, move-review, mark-done all appear.
  const cmds = landing.map((l) => l.command).sort();
  assert.deepEqual(cmds, ["commit", "mark-done", "move-review"]);
  // The commit event carries the extracted source commit sha.
  const commit = landing.find((l) => l.command === "commit");
  assert.equal(commit.commit, "abc1234deadbeef");
  // Every landing claim is cited to a hash-chained, VERIFIED event_hash.
  for (const l of landing) {
    assert.equal(l.citations[0].type, "event");
    assert.ok(l.citations[0].event_hash, "landing cites an event_hash");
    assert.equal(l.citations[0].verified, true, "fixture events are hash-chained");
    assert.ok(l.citations[0].chain_head);
  }
});

test("evidence trail cites the conformance attestation that ANCHORS the closeout", () => {
  const s = summaryFromFixture("CLS-100");
  const conf = s.sections.evidence_trail.conformance;
  assert.ok(conf, "an anchoring attestation is surfaced");
  assert.match(conf.file, /attestations\/.*\.json$/);
  assert.equal(conf.algorithm, "ed25519");
  // The attestation citation pins the signed subject digest + the chain head.
  const c = conf.citations[0];
  assert.equal(c.type, "attestation");
  assert.ok(c.event_hash, "cites the signed subject digest");
  assert.equal(c.verified, true);
  // grounded_in honestly records the attestation was found.
  assert.equal(s.grounded_in.conformance_attestation, true);
});

// --- the §5 invariant: NO uncited claim --------------------------------------

test("EVERY emitted claim across every section carries a §7-shaped citation", () => {
  const s = summaryFromFixture("CLS-100");
  assert.deepEqual(closeout.uncitedClaims(s), [], "no claim may be emitted uncited");
  for (const { item } of closeout.allClaims(s)) {
    assert.ok(Array.isArray(item.citations) && item.citations.length > 0);
    for (const c of item.citations) {
      assert.ok(c.type, "citation has a type");
      assert.ok(Object.prototype.hasOwnProperty.call(c, "chain_head"));
      assert.ok(Object.prototype.hasOwnProperty.call(c, "verified"));
      assert.equal(typeof c.verified, "boolean");
      assert.ok(c.event_hash || c.path || c.id, "citation names a source pin");
    }
  }
});

// --- honest degradation: omit unbacked claims, never fabricate ----------------

test("a ticket lacking gate / review / attestation evidence OMITS those sections (no fabrication)", () => {
  // CLS-200 has a plan with NO repo_gates, NO self_review_cycles, NO verdict, and
  // no anchoring attestation. The summary must reflect that honestly.
  const s = summaryFromFixture("CLS-200");
  const ev = s.sections.evidence_trail;
  assert.equal(ev.gate_results.length, 0, "no fabricated gate result");
  assert.equal(ev.review_cycles.length, 0, "no fabricated review cycle");
  assert.equal(ev.conformance, null, "no attestation anchors -> absent, not fabricated");
  assert.equal(s.grounded_in.conformance_attestation, false);
  // No verdict claim (the plan recorded none).
  const fields = s.sections.ask_and_delivered.claims.map((c) => c.field);
  assert.ok(!fields.includes("closeout_verdict"));
  assert.ok(!fields.includes("not_implemented"));
  // It STILL grounds what it can (ask + implemented + landing events) — and emits
  // no uncited claim.
  assert.ok(fields.includes("ticket_ask"));
  assert.ok(fields.includes("implemented"));
  assert.ok(s.sections.evidence_trail.landing.length > 0);
  assert.equal(closeout.uncitedClaims(s).length, 0);
});

test("an unrelated ticket's attestation does not leak into this ticket's summary", () => {
  // The fixture attestation anchors CLS-100's chain head; CLS-200's own events do
  // not include that hash, so CLS-200 must NOT claim it.
  const s = summaryFromFixture("CLS-200");
  assert.equal(s.sections.evidence_trail.conformance, null);
});

// --- REPORTS-only: the generator mutates nothing -----------------------------

test("generator is a pure read: fixture sources are byte-unchanged after a run", () => {
  const before = {
    board: fs.readFileSync(FIXTURE_BOARD, "utf8"),
    journal: fs.readFileSync(FIXTURE_JOURNAL, "utf8"),
    plan100: fs.readFileSync(path.join(FIXTURE_PLANS, "CLS-100.json"), "utf8"),
    plan200: fs.readFileSync(path.join(FIXTURE_PLANS, "CLS-200.json"), "utf8"),
  };
  summaryFromFixture("CLS-100");
  summaryFromFixture("CLS-200");
  closeout.renderText(summaryFromFixture("CLS-100"));
  assert.equal(fs.readFileSync(FIXTURE_BOARD, "utf8"), before.board);
  assert.equal(fs.readFileSync(FIXTURE_JOURNAL, "utf8"), before.journal);
  assert.equal(fs.readFileSync(path.join(FIXTURE_PLANS, "CLS-100.json"), "utf8"), before.plan100);
  assert.equal(fs.readFileSync(path.join(FIXTURE_PLANS, "CLS-200.json"), "utf8"), before.plan200);
});

// --- determinism -------------------------------------------------------------

test("determinism: same ticket history -> byte-identical content digest (now excluded)", () => {
  const a = summaryFromFixture("CLS-100", { now: "2020-01-01T00:00:00.000Z" });
  const b = summaryFromFixture("CLS-100", { now: "2099-12-31T23:59:59.000Z" });
  assert.equal(closeout.contentDigest(a), closeout.contentDigest(b));
  assert.equal(
    closeout.stableStringify(summaryFromFixture("CLS-100")),
    closeout.stableStringify(summaryFromFixture("CLS-100"))
  );
});

// --- text rendering ----------------------------------------------------------

test("text rendering shows all three sections + the reports-only note", () => {
  const text = closeout.renderText(summaryFromFixture("CLS-100"));
  assert.match(text, /ASK & DELIVERED/);
  assert.match(text, /EVIDENCE TRAIL/);
  assert.match(text, /KEY DECISIONS & DEFERRALS/);
  assert.match(text, /REPORTS ONLY/);
  assert.match(text, /cites:/);
  // The honest absence note appears for CLS-200's missing attestation.
  const text200 = closeout.renderText(summaryFromFixture("CLS-200"));
  assert.match(text200, /conformance attestation: \(none anchors this closeout/);
});

// --- live real-history proof (feature-proof) ---------------------------------

test("live repo summary for an already-landed ticket (COORD-141) grounds claims + no uncited claim", (t) => {
  if (skipIfNoCorpus(t)) return;
  // Strongest proof: a summary for a REAL landed ticket, over real history, with
  // zero uncited claims and REPORTS-only. Grounds delivered + gate + review +
  // commit/landing claims in the ticket's real plan record + journal events.
  const s = closeout.buildSummary({ ticketId: "COORD-141", now: FIXED_NOW });
  assert.equal(closeout.uncitedClaims(s).length, 0);
  assert.equal(s.authority, false);
  assert.equal(s.recommends_only, true);
  // It is grounded in the real plan record + real journal events.
  assert.equal(s.grounded_in.plan_record, true);
  assert.ok(s.grounded_in.journal_events > 0);
  // The real ticket delivered (requirement_closure present) and passed gates.
  assert.ok(s.sections.ask_and_delivered.claims.some((c) => c.field === "ticket_ask"));
  assert.ok(s.sections.evidence_trail.gate_results.length > 0);
  assert.ok(s.sections.evidence_trail.review_cycles.length > 0);
  // The landing record surfaces the real mark-done event, cited to a verified hash.
  const markDone = s.sections.evidence_trail.landing.find((l) => l.command === "mark-done");
  assert.ok(markDone, "the real mark-done landing event is surfaced");
  assert.ok(markDone.citations[0].event_hash);
  assert.equal(markDone.citations[0].verified, true);
});
