"use strict";

// COORD-147: tests for the strategic execution-insight report generator.
//
// Coverage maps to the four report sections + the cardinal guardrail:
//  - failure-theme clustering groups repeated failures across >=2 tickets;
//  - architectural-debt by subsystem ranks deferral / not-implemented / follow-up
//    debt and attributes it to the right board section;
//  - churn detection flags a high-rework fixture ticket (review rounds + re-entry
//    into doing + recoveries) and classifies value vs motion;
//  - gate/review/recovery health is computed correctly per repo (weak gate from
//    failing review cycles, review duration, recovery load);
//  - EVERY emitted claim carries citations (assert no uncited claim) — the §5
//    invariant;
//  - determinism (same history -> byte-identical content digest, ignoring the
//    injected generated_at);
//  - honest thin-signal behavior on a sparse area;
//  - the report RECOMMENDS only (authority:false, recommends_only:true) and the
//    pure generator writes nothing back to the journal/board/plans.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const insights = require("./insight-reports.js");
const { skipIfNoCorpus } = require("./memory-corpus-guard.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "insight-reports");
const FIXTURE_BOARD = path.join(FIXTURE_DIR, "board.json");
const FIXTURE_PLANS = path.join(FIXTURE_DIR, "plans");
const FIXTURE_JOURNAL = path.join(FIXTURE_DIR, "governance-events.ndjson");
const ROOT_DIR = path.resolve(__dirname, "..", "..");

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

function reportFromFixture(overrides = {}) {
  return insights.generateReport({
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    rootDir: ROOT_DIR,
    now: FIXED_NOW,
    ...overrides,
  });
}

// --- report shape + guardrail ------------------------------------------------

test("report has the four sections and is marked RECOMMENDS-only / non-authority", () => {
  const r = reportFromFixture();
  assert.equal(r.kind, "execution-insight-report");
  assert.equal(r.authority, false);
  assert.equal(r.recommends_only, true);
  assert.deepEqual(
    Object.keys(r.sections).sort(),
    [
      "architectural_debt_by_subsystem",
      "churn_instead_of_value",
      "gate_review_recovery_health_by_repo",
      "repeated_failure_themes",
    ]
  );
  // History scope reflects the fixture sources.
  assert.equal(r.history_scope.board_tickets, 5);
  assert.equal(r.history_scope.plan_records, 3);
  assert.ok(r.history_scope.journal_events > 0);
});

// --- SECTION 1: repeated-failure-theme detection -----------------------------

test("failure-theme clustering groups repeated failures across >=2 tickets, each cited", () => {
  const r = reportFromFixture();
  const themes = r.sections.repeated_failure_themes.claims;

  // journal-chain-integrity recurs across INS-001 (review finding + risk) and
  // INS-002 (risk) -> a real repeated theme.
  const chain = themes.find((t) => t.theme === "journal-chain-integrity");
  assert.ok(chain, "chain-integrity theme detected");
  assert.deepEqual(chain.tickets, ["INS-001", "INS-002"]);
  assert.ok(chain.ticket_count >= 2);
  assert.ok(chain.citations.length > 0, "theme is cited");

  // board-state-reconciliation recurs across INS-001 (recover reason) and INS-003
  // (manual-reconcile reason).
  const board = themes.find((t) => t.theme === "board-state-reconciliation");
  assert.ok(board, "board-reconciliation theme detected");
  assert.deepEqual(board.tickets, ["INS-001", "INS-003"]);

  // EVERY theme spans >=2 distinct tickets (single occurrences are not "repeated").
  for (const t of themes) {
    assert.ok(t.ticket_count >= 2, `${t.theme} spans >=2 tickets`);
  }
});

test("a single-ticket failure is NOT reported as a repeated theme", () => {
  const r = reportFromFixture();
  const themes = r.sections.repeated_failure_themes.claims;
  // INS-005's lone doctor-fix (worktree-lifecycle) touches only one ticket, so the
  // worktree-lifecycle theme must NOT be emitted as a repeated theme.
  assert.ok(!themes.some((t) => t.theme === "worktree-lifecycle"));
});

// --- SECTION 2: architectural-debt by subsystem ------------------------------

test("arch-debt ranks subsystems by deferral / not-implemented / follow-up debt", () => {
  const r = reportFromFixture();
  const debt = r.sections.architectural_debt_by_subsystem.claims;

  // The Memory Subsystem carries: INS-003 deferred + INS-002 not-implemented +
  // INS-002 deferred_to -> the highest debt. Bootstrap has none.
  assert.ok(debt.length >= 1);
  const top = debt[0];
  assert.equal(top.subsystem, "Memory Subsystem");
  assert.ok(top.deferred_tickets.includes("INS-003"));
  assert.ok(top.not_implemented_tickets.includes("INS-002"));
  assert.ok(top.deferred_to_tickets.includes("INS-002"));
  assert.ok(top.debt_score >= 3);
  assert.ok(top.citations.length > 0);

  // The Bootstrap subsystem has no debt -> no claim emitted for it.
  assert.ok(!debt.some((d) => d.subsystem === "Bootstrap Subsystem"));
});

// COORD-198: requirement_closure is append-only, so a re-closed ticket (partial ->
// complete) keeps the superseded "Not implemented: X" line in the ordered array.
// The recency-correct parse resolves to the LATEST line ("Not implemented: none —
// ...", a none-class value), so arch-debt must NOT flag the ticket as a
// not-implemented carve-out.
const extractor = require("./decision-extractor.js");

test("arch-debt does NOT flag a re-closed (partial -> complete) ticket as a not-implemented carve-out", () => {
  const reclosedClosure = extractor.parseRequirementClosure([
    "Ticket ask: ship the feature behind the acceptance bar.",
    "Implemented: first pass that fell short.",
    "Not implemented: ACCEPTANCE-cut NOT met on the first closure.",
    "Deferred to: none",
    "Closeout verdict: partial",
    "Ticket ask: finish the feature so the acceptance bar is met.",
    "Implemented: second pass that landed the full bar.",
    "Not implemented: none — full acceptance bar met",
    "Deferred to: none",
    "Closeout verdict: complete",
  ]);
  const stillOpenClosure = extractor.parseRequirementClosure([
    "Ticket ask: ship the second feature.",
    "Implemented: partial.",
    "Not implemented: the edge-case path is left unhandled.",
    "Deferred to: none",
    "Closeout verdict: partial",
  ]);
  const tickets = [
    { id: "RC-198", repo: "coord", type: "bug", status: "done", description: "", subsystem: "Recency Subsystem" },
    { id: "RC-199", repo: "coord", type: "bug", status: "done", description: "", subsystem: "Recency Subsystem" },
  ];
  const plansById = new Map([
    ["RC-198", { ticket_id: "RC-198", path: "coord/.runtime/plans/RC-198.json", closure: reclosedClosure }],
    ["RC-199", { ticket_id: "RC-199", path: "coord/.runtime/plans/RC-199.json", closure: stillOpenClosure }],
  ]);

  const section = insights.detectArchDebtBySubsystem(tickets, plansById, "coord/board/tasks.json", "deadbeefchainhead");
  const claim = section.claims.find((c) => c.subsystem === "Recency Subsystem");
  assert.ok(claim, "the still-open RC-199 keeps the subsystem on the debt list");
  // The re-closed RC-198 is NOT flagged; only the genuinely-open RC-199 is.
  assert.ok(!claim.not_implemented_tickets.includes("RC-198"), "re-closed-complete ticket is not a carve-out");
  assert.ok(claim.not_implemented_tickets.includes("RC-199"), "the genuinely-open ticket IS a carve-out");
});

// --- SECTION 3: churn-instead-of-value ---------------------------------------

test("churn detection flags a high-rework ticket and counts true doing re-entries (not in-doing self-loops)", () => {
  const r = reportFromFixture();
  const churn = r.sections.churn_instead_of_value.claims;

  const ins001 = churn.find((c) => c.ticket === "INS-001");
  assert.ok(ins001, "INS-001 flagged as churn");
  // INS-001: 2 move-review events, a recover that re-enters doing (1 true
  // re-entry beyond the initial start), 1 manual-reconcile recovery.
  assert.equal(ins001.move_review_count, 2);
  // The in-doing update-plan self-loop must NOT count as a re-entry; only the
  // recover (review->doing) is a true re-entry beyond the initial start.
  assert.equal(ins001.doing_entries, 2);
  assert.equal(ins001.recovery_count, 1);
  assert.equal(ins001.reached_done, true);
  assert.equal(ins001.classification, "high-cost-delivery");
  assert.ok(ins001.rework_score >= 1);
  assert.ok(ins001.citations.length > 0);

  // A clean ticket (INS-004: one review round, no recoveries, no re-entry) shows
  // NO rework and is not flagged.
  assert.ok(!churn.some((c) => c.ticket === "INS-004"));
});

// --- SECTION 4: gate/review/recovery health by repo --------------------------

test("repo health computes weak-gate fail rate, review duration, recovery load per repo", () => {
  const r = reportFromFixture();
  const repos = r.sections.gate_review_recovery_health_by_repo.claims;
  const byRepo = new Map(repos.map((c) => [c.repo, c]));

  // Repo X: INS-001 has one failing review cycle of three total cycles (INS-001
  // has 2 cycles, INS-002 has 1) -> 1/3 fail rate, weak gate.
  const x = byRepo.get("X");
  assert.ok(x);
  assert.equal(x.gate.total_review_cycles, 3);
  assert.equal(x.gate.failing_review_cycles, 1);
  assert.equal(x.gate.weak_gate, true);
  assert.ok(x.gate.gate_fail_rate > 0);
  // INS-001 review->done spanned 01:30 -> 03:30 = 2h; INS-002 01:00 -> 02:00 = 1h;
  // median over the two completions = 1.5h.
  assert.equal(x.review.measured_review_completions, 2);
  assert.equal(x.review.median_review_hours, 1.5);
  // INS-001 manual-reconcile + INS-001 recover + INS-003 manual-reconcile = 3
  // recovery events attributed to repo X tickets.
  assert.equal(x.recovery.recovery_events, 3);

  // Repo B (INS-004): clean — no failing cycles, no recoveries.
  const b = byRepo.get("B");
  assert.equal(b.gate.failing_review_cycles, 0);
  assert.equal(b.gate.weak_gate, false);
  assert.equal(b.recovery.recovery_events, 0);

  // Health is aggregated per REPO only — never per individual owner/agent.
  for (const c of repos) {
    assert.ok(!Object.prototype.hasOwnProperty.call(c, "owner"));
    assert.ok(!Object.prototype.hasOwnProperty.call(c, "agent"));
  }
});

// --- the §5 invariant: NO uncited claim --------------------------------------

test("EVERY emitted claim across every section carries at least one citation", () => {
  const r = reportFromFixture();
  const uncited = insights.uncitedClaims(r);
  assert.deepEqual(uncited, [], "no claim may be emitted without a citation");

  // And spot-check the citation shape: each citation pins chain_head + verified.
  for (const { claim } of insights.allClaims(r)) {
    for (const c of claim.citations) {
      assert.ok(c.type, "citation has a type");
      assert.ok(Object.prototype.hasOwnProperty.call(c, "chain_head"));
      assert.ok(Object.prototype.hasOwnProperty.call(c, "verified"));
      assert.equal(typeof c.verified, "boolean");
      // An event/decision/ticket citation always names its source pin.
      assert.ok(c.event_hash || c.path || c.id, "citation names a source pin");
    }
  }
});

test("the live repo report also emits no uncited claim (real-history check)", (t) => {
  if (skipIfNoCorpus(t)) return;
  // Run over the REAL repo history (default paths). This is the strongest proof:
  // a generated report citing real tickets, with zero uncited claims.
  const r = insights.generateReport({ now: FIXED_NOW });
  assert.equal(insights.uncitedClaims(r).length, 0);
  // And it is RECOMMENDS-only.
  assert.equal(r.authority, false);
  assert.equal(r.recommends_only, true);
});

// --- determinism -------------------------------------------------------------

test("determinism: same history -> byte-identical content digest, ignoring generated_at", () => {
  const a = reportFromFixture({ now: "2020-01-01T00:00:00.000Z" });
  const b = reportFromFixture({ now: "2099-12-31T23:59:59.000Z" });
  assert.equal(insights.contentDigest(a), insights.contentDigest(b));

  // Full serialization with the SAME now is byte-identical.
  const c = insights.stableStringify(reportFromFixture());
  const d = insights.stableStringify(reportFromFixture());
  assert.equal(c, d);
});

// --- honest thin-signal behavior ---------------------------------------------

test("thin-signal honesty: sparse evidence is flagged, not over-claimed", () => {
  const r = reportFromFixture();
  // The questions-log-format / worktree-lifecycle single-ticket signals are NOT
  // emitted as themes at all. Where a section IS emitted on sparse evidence, it
  // carries thin_signal. Repo F (INS-005) has only an isolated doctor-fix and no
  // review cycles -> its health claim is thin.
  const repos = r.sections.gate_review_recovery_health_by_repo.claims;
  const f = repos.find((c) => c.repo === "F");
  assert.ok(f);
  assert.equal(f.thin_signal, true);
});

test("empty history degrades honestly to no claims (graceful skip)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ins-empty-"));
  try {
    const emptyBoard = path.join(tmp, "board.json");
    const emptyPlans = path.join(tmp, "plans");
    const emptyJournal = path.join(tmp, "journal.ndjson");
    fs.writeFileSync(emptyBoard, JSON.stringify({ sections: [] }));
    fs.mkdirSync(emptyPlans);
    fs.writeFileSync(emptyJournal, "");
    const r = insights.generateReport({
      boardPath: emptyBoard,
      plansDir: emptyPlans,
      journalPath: emptyJournal,
      rootDir: ROOT_DIR,
      now: FIXED_NOW,
    });
    assert.equal(r.sections.repeated_failure_themes.claims.length, 0);
    assert.equal(r.sections.architectural_debt_by_subsystem.claims.length, 0);
    assert.equal(r.sections.churn_instead_of_value.claims.length, 0);
    // No uncited claims even when empty (there are none).
    assert.equal(insights.uncitedClaims(r).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- text rendering ----------------------------------------------------------

test("text report renders all four sections and the recommends-only note", () => {
  const text = insights.renderText(reportFromFixture());
  assert.match(text, /REPEATED FAILURE THEMES/);
  assert.match(text, /ARCHITECTURAL DEBT BY SUBSYSTEM/);
  assert.match(text, /CHURN-INSTEAD-OF-VALUE/);
  assert.match(text, /GATE \/ REVIEW \/ RECOVERY HEALTH BY REPO/);
  assert.match(text, /RECOMMENDS only/);
  assert.match(text, /cites:/);
});

// --- pure generator mutates nothing ------------------------------------------

test("generator is a pure read: fixture sources are not mutated", () => {
  const before = {
    board: fs.readFileSync(FIXTURE_BOARD, "utf8"),
    journal: fs.readFileSync(FIXTURE_JOURNAL, "utf8"),
    plan: fs.readFileSync(path.join(FIXTURE_PLANS, "INS-001.json"), "utf8"),
  };
  reportFromFixture();
  assert.equal(fs.readFileSync(FIXTURE_BOARD, "utf8"), before.board);
  assert.equal(fs.readFileSync(FIXTURE_JOURNAL, "utf8"), before.journal);
  assert.equal(fs.readFileSync(path.join(FIXTURE_PLANS, "INS-001.json"), "utf8"), before.plan);
});
