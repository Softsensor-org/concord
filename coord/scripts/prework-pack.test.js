"use strict";

// COORD-148: tests for the pre-work context-pack generator.
//
// Coverage maps to the ticket ask + the cardinal guardrail:
//  - the pack has the three sections and is marked RECOMMENDS-only / non-authority;
//  - SECTION 1 retrieves relevant prior work for a ticket touching a known area
//    (composing recall.js), each hit cited;
//  - SECTION 2 surfaces a RELEVANT past failure from the touched area (PRW-101's
//    checkout refund failure) and does NOT surface an UNRELATED failure (PRW-200's
//    email/smtp failure) — the prevent-repeated-failed-approaches core;
//  - SECTION 3 recommends tests that map to the touched area + what historically
//    broke here;
//  - the §5 invariant: EVERY emitted item across every section carries a citation
//    pinning the §7 shape (no uncited recommendation);
//  - RECOMMENDS-only: the generator mutates NOTHING — fixture sources are byte-
//    unchanged after a run;
//  - determinism: same history + same ticket -> byte-identical content digest;
//  - honest degradation: a meta-ticket with no distinctive domain area surfaces no
//    failed approaches rather than over-claiming;
//  - the live repo pack also emits no uncited item (real-history check).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const prework = require("./prework-pack.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "prework-pack");
const FIXTURE_BOARD = path.join(FIXTURE_DIR, "board.json");
const FIXTURE_PLANS = path.join(FIXTURE_DIR, "plans");
const FIXTURE_JOURNAL = path.join(FIXTURE_DIR, "governance-events.ndjson");
const FIXTURE_DECISIONS = path.join(FIXTURE_DIR, "decisions.ndjson");

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

// rootDir points at the fixture dir so recall's INDEXED_FILES allowlist resolves
// to NOTHING (those files do not exist under the fixture root) and the recall
// corpus is exactly the fixture decisions — fully isolated + deterministic.
function packFromFixture(overrides = {}) {
  return prework.buildPack({
    ticketId: "PRW-100",
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    decisionsPath: FIXTURE_DECISIONS,
    rootDir: FIXTURE_DIR,
    now: FIXED_NOW,
    ...overrides,
  });
}

// --- pack shape + guardrail --------------------------------------------------

test("pack has the three sections and is marked RECOMMENDS-only / non-authority", () => {
  const p = packFromFixture();
  assert.equal(p.kind, "prework-context-pack");
  assert.equal(p.authority, false);
  assert.equal(p.recommends_only, true);
  assert.deepEqual(
    Object.keys(p.sections).sort(),
    ["already_failed_approaches", "recommended_plan", "relevant_prior_work"]
  );
  assert.equal(p.scope.ticket_id, "PRW-100");
  assert.equal(p.scope.repo, "B");
  assert.equal(p.scope.subsystem, "Checkout Subsystem");
});

// --- SECTION 1: relevant prior work (composes recall.js) ---------------------

test("relevant prior work retrieves the touched-area prior ticket, cited", () => {
  const p = packFromFixture();
  const prior = p.sections.relevant_prior_work;
  assert.ok(prior.items.length >= 1, "at least one prior-work hit");
  // PRW-101 (the prior checkout refund work) is the relevant prior ticket.
  const hit = prior.items.find((it) =>
    it.citations.some((c) => c.id === "PRW-101")
  );
  assert.ok(hit, "PRW-101 surfaced as relevant prior work");
  // Every prior-work item is cited.
  for (const it of prior.items) {
    assert.ok(it.citations.length > 0);
  }
});

// --- SECTION 2: already-failed approaches (relevant surfaces, unrelated does not)

test("already-failed approaches surfaces the RELEVANT checkout failure (review + recovery)", () => {
  const p = packFromFixture();
  const failed = p.sections.already_failed_approaches.items;

  // PRW-101's failed review cycle (checkout refund rounding) is surfaced.
  const reviewFail = failed.find(
    (it) => it.kind === "review-failure" && it.ticket === "PRW-101"
  );
  assert.ok(reviewFail, "PRW-101 review failure surfaced");
  assert.match(reviewFail.warning, /refund rounding/i);
  assert.ok(reviewFail.citations.length > 0);
  assert.equal(reviewFail.citations[0].id, "PRW-101");

  // PRW-101's checkout recovery event is surfaced.
  const recovery = failed.find(
    (it) => it.kind === "recovery" && it.ticket === "PRW-101"
  );
  assert.ok(recovery, "PRW-101 checkout recovery surfaced");
  assert.match(recovery.warning, /checkout refund/i);
  // The recovery citation pins an event_hash (verified by the chain).
  assert.ok(recovery.citations[0].event_hash, "recovery cites an event_hash");
});

test("already-failed approaches does NOT surface an UNRELATED failure (email/smtp)", () => {
  const p = packFromFixture();
  const failed = p.sections.already_failed_approaches.items;
  // PRW-200 is an email/smtp ticket — no shared checkout-area vocabulary, so its
  // failure (real, and a failed review cycle) must NOT be pulled in.
  assert.ok(
    !failed.some((it) => it.ticket === "PRW-200"),
    "unrelated PRW-200 email failure is not surfaced"
  );
  for (const it of failed) {
    assert.doesNotMatch(it.warning, /smtp|email/i);
  }
});

// --- SECTION 3: recommended decomposition + test selection -------------------

test("recommended plan derives steps from prior work + each failed approach, cited", () => {
  const p = packFromFixture();
  const plan = p.sections.recommended_plan;
  assert.ok(plan.steps.length >= 1);
  // There is a guard step for the known checkout failure.
  const guard = plan.steps.find((s) => /refund rounding/i.test(s.step));
  assert.ok(guard, "a guard step for the checkout refund failure");
  assert.ok(guard.citations.length > 0);
  // The full-suite fallback is always sound advice.
  assert.match(plan.full_suite_command, /node --test/);
  // Every step is cited.
  for (const s of plan.steps) {
    assert.ok(s.citations.length > 0);
  }
});

test("recommended test selection maps to the touched area + names existing test files", () => {
  // Point the test scan at the REAL repo (rootDir = repo root) so the area-token
  // -> *.test.js mapping has files to match. The ticket touches the prework area;
  // the prework-pack test file should be selected by basename area match.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const p = prework.buildPack({
    scope: "prework context pack recall insight decision",
    boardPath: FIXTURE_BOARD, // no such ticket id -> free-text scope
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    decisionsPath: FIXTURE_DECISIONS,
    rootDir: repoRoot,
    now: FIXED_NOW,
  });
  const tests = p.sections.recommended_plan.recommended_tests;
  // Every recommended test path actually exists and is cited.
  for (const t of tests) {
    assert.ok(fs.existsSync(path.join(repoRoot, t.path)), `${t.path} exists`);
    assert.ok(t.citations.length > 0, `${t.path} is cited`);
  }
});

// --- the §5 invariant: NO uncited item ---------------------------------------

test("EVERY emitted item across every section carries a §7-shaped citation", () => {
  const p = packFromFixture();
  assert.deepEqual(prework.uncitedItems(p), [], "no item may be emitted uncited");
  for (const { item } of prework.allItems(p)) {
    for (const c of item.citations) {
      assert.ok(c.type, "citation has a type");
      assert.ok(Object.prototype.hasOwnProperty.call(c, "chain_head"));
      assert.ok(Object.prototype.hasOwnProperty.call(c, "verified"));
      assert.equal(typeof c.verified, "boolean");
      assert.ok(c.event_hash || c.path || c.id, "citation names a source pin");
    }
  }
});

test("the live repo pack also emits no uncited item (real-history check)", () => {
  // Strongest proof: a pack for a REAL ticket, over real history, with zero
  // uncited items, and RECOMMENDS-only.
  const p = prework.buildPack({ ticketId: "COORD-148", now: FIXED_NOW });
  assert.equal(prework.uncitedItems(p).length, 0);
  assert.equal(p.authority, false);
  assert.equal(p.recommends_only, true);
});

// --- RECOMMENDS-only: the generator mutates nothing --------------------------

test("generator is a pure read: fixture sources are byte-unchanged after a run", () => {
  const before = {
    board: fs.readFileSync(FIXTURE_BOARD, "utf8"),
    journal: fs.readFileSync(FIXTURE_JOURNAL, "utf8"),
    decisions: fs.readFileSync(FIXTURE_DECISIONS, "utf8"),
    plan: fs.readFileSync(path.join(FIXTURE_PLANS, "PRW-101.json"), "utf8"),
  };
  packFromFixture();
  assert.equal(fs.readFileSync(FIXTURE_BOARD, "utf8"), before.board);
  assert.equal(fs.readFileSync(FIXTURE_JOURNAL, "utf8"), before.journal);
  assert.equal(fs.readFileSync(FIXTURE_DECISIONS, "utf8"), before.decisions);
  assert.equal(
    fs.readFileSync(path.join(FIXTURE_PLANS, "PRW-101.json"), "utf8"),
    before.plan
  );
});

// --- determinism -------------------------------------------------------------

test("determinism: same history + same ticket -> byte-identical content digest", () => {
  const a = packFromFixture({ now: "2020-01-01T00:00:00.000Z" });
  const b = packFromFixture({ now: "2099-12-31T23:59:59.000Z" });
  assert.equal(prework.contentDigest(a), prework.contentDigest(b));
  // Full serialization with the SAME now is byte-identical.
  assert.equal(
    prework.stableStringify(packFromFixture()),
    prework.stableStringify(packFromFixture())
  );
});

// --- honest degradation ------------------------------------------------------

test("a meta-ticket with no distinctive domain area surfaces no failed approaches (no over-claim)", () => {
  // PRW-100's area is checkout (distinctive) -> failures surface. A scope made ONLY
  // of generic governance vocabulary has an empty touched area and must surface
  // nothing rather than dumping all history.
  const p = prework.buildPack({
    scope: "memory ticket plan board agent start work governed gated",
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    decisionsPath: FIXTURE_DECISIONS,
    rootDir: FIXTURE_DIR,
    now: FIXED_NOW,
  });
  assert.equal(prework.touchedAreaTokens(prework.resolveScope({ scope: "memory ticket plan board agent start work governed gated" })).size, 0);
  assert.equal(p.sections.already_failed_approaches.items.length, 0);
});

// --- text rendering ----------------------------------------------------------

test("text rendering shows all three sections + the recommends-only note", () => {
  const text = prework.renderText(packFromFixture());
  assert.match(text, /RELEVANT PRIOR WORK/);
  assert.match(text, /ALREADY-FAILED APPROACHES/);
  assert.match(text, /RECOMMENDED SAFE DECOMPOSITION/);
  assert.match(text, /RECOMMENDS only/);
  assert.match(text, /cites:/);
});
