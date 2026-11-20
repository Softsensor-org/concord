"use strict";

// COORD-718: every projection surface — explain readiness, PLAN.md, evidence
// export, closeout summary and the cockpit read model — reports the same
// current-versus-historical split for one fixture, and none of them counts or
// renders a QUESTIONS.md row as independent-review satisfaction.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const reviews = require("../engine/scripts/independent-reviews.js");
const supersession = require("../engine/scripts/plan-evidence-supersession.js");
const { createGovernanceReadiness } = require("../engine/scripts/governance-readiness.js");
const closeout = require(require("../paths.js").resolveEngineModule(path.resolve(__dirname, ".."), "scripts/closeout-summary.js"));

const HEAD = "1".repeat(40);
const OLD = "2".repeat(40);
const TICKET = "COORD-9718";
const QUESTION = `Independent review of ${TICKET} at ${HEAD} by codexa760: verdict pass, findings none`;

function entry(handle, commit, extra = {}) {
  return reviews.buildIndependentReview({
    ticketId: TICKET, reviewer: { handle, agent_id: null, session_id: `${handle}-s`, thread_id: null },
    ownerAtReview: "claudea12", repository: "coord", commit, method: "code review", findings: [], verdict: "pass",
    timestamp: "2026-10-21T20:00:00.000Z", ...extra,
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(independentReviews, { status = "doing", reviewSubmission = undefined, lockHead = HEAD, landing = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c718-projections-"));
  const coord = path.join(root, "coord");
  const board = {
    version: 1, metadata: { title: "T" },
    sections: [{ kind: "table", heading: "X", columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [{ ID: TICKET, Repo: "X", Type: "feature", Pri: "P1", Status: status, Owner: "claudea12", Description: "", "Depends On": "" }] },
      { kind: "text", heading: "Notes", lines: ["a non-table section carries no rows"] }],
    prompt_index: {}, pr_index: {}, landing_index: landing ? { [TICKET]: landing } : {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  };
  writeJson(path.join(coord, "board", "tasks.json"), board);
  const plan = {
    ticket_id: TICKET, requirement_closure: [], feature_proof: [], repo_gates: [], verification_commands: [], critical_invariants: [],
    self_review_cycles: [{ cycle: 1, total: 3, lens: "contract", verdict: "pass", raw: "lens=contract; verdict=pass", risks: [] }],
    independent_reviews: independentReviews,
    ...(reviewSubmission ? { review_submission: reviewSubmission } : {}),
  };
  writeJson(path.join(coord, ".runtime", "plans", `${TICKET}.json`), plan);
  writeJson(path.join(coord, ".runtime", "locks", `${TICKET}.lock`), { ticket: TICKET, owner: "claudea12", status: "doing", repo: "coord", head: lockHead });
  fs.writeFileSync(path.join(coord, ".runtime", "governance-events.ndjson"),
    `${JSON.stringify({ ts: "2026-10-21T19:00:00Z", command: "start", ticket: TICKET, after_status: "doing", identity: { owner: "claudea12" } })}\n`);
  fs.writeFileSync(path.join(coord, "QUESTIONS.md"), `| Date | From | To | Question | Answer | Resolved |\n|---|---|---|---|---|---|\n| 2026-10-21 | codexa760 | orchestrator | ${QUESTION} | ok | yes |\n`);
  return { root, coord, board, plan };
}

function readiness(board, plan, lock) {
  const { deriveGovernanceReadiness } = createGovernanceReadiness({
    normalizeGovernancePlanShape: () => ({ expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null }, ticket_local_repairs: [] }),
    resolveRepoCodeForTicket: () => "X",
    repoNameForCode: () => "coord",
    isMeaningfulText: () => true,
    collectReviewPlanReadinessIssues: () => [],
    resolveTicketLightLane: () => ({ eligible: false, reason: "test" }),
    requiresFeatureProofGovernance: () => false,
    isTestingInfrastructureTicket: () => false,
    collectTicketGovernanceIssueEvents: () => [],
    hasResolvedGovernanceRepairQuestion: () => true,
    fieldHasMeaningfulValue: () => true,
    deriveDecisionRequiredGuidance: () => null,
  });
  const row = board.sections[0].rows[0];
  return deriveGovernanceReadiness(TICKET, row, board, lock, plan, { required: true, question_template: QUESTION }).independent_reviews;
}

async function surfaces({ coord, board, plan, root }) {
  const lock = JSON.parse(fs.readFileSync(path.join(coord, ".runtime", "locks", `${TICKET}.lock`), "utf8"));
  const exporter = await import(pathToFileURL(path.join(__dirname, "../engine/scripts/evidence-export.mjs")).href);
  const exported = exporter.buildEvidenceExport({ tickets: [TICKET], framework: "all", format: "json", coordDir: coord });
  const markdown = exporter.buildEvidenceExport({ tickets: [TICKET], framework: "all", format: "md", coordDir: coord }).body;
  const summary = closeout.buildSummary({
    ticketId: TICKET, boardPath: path.join(coord, "board", "tasks.json"), plansDir: path.join(coord, ".runtime", "plans"),
    journalPath: path.join(coord, ".runtime", "governance-events.ndjson"), attestationsDir: path.join(coord, ".runtime", "attestations"), rootDir: root,
  });
  const ui = await import(pathToFileURL(path.join(__dirname, "..", "..", "frontend", "apps", "coord-ui", "lib", "plan-evidence.js")).href);
  const scope = reviews.readClaimedReviewScope({ fs, path, locksDir: path.join(coord, ".runtime", "locks"), ticketId: TICKET, board, repoCode: "X", status: board.sections[0].rows[0].Status, reviewSubmission: plan.review_submission });
  const lines = [];
  try {
    supersession.renderPlanEvidenceSections(lines, plan, (out, name, values) => { out.push(`- ${name}:`); for (const v of values) out.push(`  - ${v}`); }, "repo");
    supersession.renderIndependentReviewSection(lines, plan);
  } catch (error) {
    lines.push(`render refused: ${error.message}`);
  }
  return {
    scope,
    explain: readiness(board, plan, lock),
    exported: exported.pkg.tickets[0].independent_reviews,
    markdown,
    closeout: summary.sections.evidence_trail.independent_reviews,
    closeoutText: closeout.renderText(summary),
    uncited: closeout.uncitedClaims(summary),
    ui: ui.independentReviewView(plan, { scope, owner: "claudea12" }, reviews.projectIndependentReviews),
    plan: lines.join("\n"),
  };
}

test("COORD-718: explain, PLAN.md, export, closeout and cockpit agree on current versus historical reviews", async () => {
  const stale = entry("codexa760", OLD, { reviewKey: "first" });
  const fresh = entry("codexa760", HEAD, { reviewKey: "second", supersedes: stale.id, reason: "fix head" });
  const unlinkedStale = entry("claudea13", OLD);
  const current = entry("claudea13", HEAD);
  const env = fixture([stale, fresh, unlinkedStale, current]);
  try {
    const s = await surfaces(env);
    const ids = (list) => list.map((item) => item.id).sort();
    const expectedCurrent = [fresh.id, current.id].sort();
    const expectedHistorical = [stale.id, unlinkedStale.id].sort();
    for (const [name, projection] of [["explain", s.explain], ["export", s.exported], ["closeout", s.closeout]]) {
      assert.deepEqual(ids(projection.current), expectedCurrent, `${name} current`);
      assert.deepEqual(ids(projection.historical), expectedHistorical, `${name} historical`);
      assert.deepEqual(projection.scope, { repository: "coord", commit: HEAD, source: "lock" }, `${name} scope`);
    }
    assert.deepEqual(ids(s.ui.current), expectedCurrent, "cockpit current");
    assert.deepEqual(ids(s.ui.historical), expectedHistorical, "cockpit historical");
    assert.deepEqual(s.ui.historical.map((item) => item.currency).sort(), ["stale_head", "superseded"]);
    assert.equal(s.ui.currentReviewers, 2);
    assert.match(s.markdown, new RegExp(`- Independent reviews: current 2 at coord@${HEAD} · historical 2`));
    assert.match(s.closeoutText, /independent reviews: 2 current at coord@1{40}, 2 historical/);
    assert.match(s.closeoutText, /- historical \(superseded\)/);
    assert.match(s.closeoutText, /- historical \(stale_head\)/);
    assert.deepEqual(s.uncited, [], "every reported review is cited to the plan record");
    assert.match(s.plan, new RegExp(`status=superseded by ${fresh.id}; historical`));
    assert.equal((s.plan.match(/status=active; current only when/g) || []).length, 3, "PLAN.md marks lifecycle, not currency");
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});


test("COORD-858: every projection uses immutable review submission and legacy review remains unresolved", async () => {
  const submitted = fixture([entry("codexa760", HEAD)], {
    status: "review", reviewSubmission: { repository: "coord", commit: HEAD }, lockHead: OLD,
    landing: { source_commit_sha: OLD },
  });
  try {
    const current = await surfaces(submitted);
    for (const [name, projection] of [["explain", current.explain], ["export", current.exported], ["closeout", current.closeout]]) {
      assert.ok(projection.scope, `${name} resolves submitted scope`);
      assert.equal(projection.scope.commit, HEAD, `${name} uses submitted commit`);
      assert.equal(projection.scope.source, "submission", `${name} identifies submitted scope`);
      assert.equal(projection.counts.current, 1, `${name} marks review current`);
    }
    assert.deepEqual(current.scope, { repository: "coord", commit: HEAD, source: "submission" });
    assert.equal(current.ui.currentCount, 1);
  } finally {
    fs.rmSync(submitted.root, { recursive: true, force: true });
  }

  const legacy = fixture([entry("codexa760", HEAD)], {
    status: "review", lockHead: HEAD, landing: { source_commit_sha: HEAD },
  });
  try {
    const unresolved = await surfaces(legacy);
    for (const [name, projection] of [["explain", unresolved.explain], ["export", unresolved.exported], ["closeout", unresolved.closeout]]) {
      assert.equal(projection.scope, null, `${name} does not infer legacy scope`);
      assert.equal(projection.counts.current, 0, `${name} counts no current reviews`);
      assert.equal(projection.historical[0].currency, "scope_unresolved");
    }
    assert.equal(unresolved.scope, null);
    assert.equal(unresolved.ui.currentCount, 0);
  } finally {
    fs.rmSync(legacy.root, { recursive: true, force: true });
  }
});

test("COORD-718: a QUESTIONS.md review claim is neither counted nor rendered on any surface", async () => {
  const env = fixture([]);
  try {
    const s = await surfaces(env);
    for (const [name, projection] of [["explain", s.explain], ["export", s.exported], ["closeout", s.closeout]]) {
      assert.equal(projection.counts.current, 0, `${name} counts no review`);
      assert.deepEqual([...projection.current, ...projection.historical], [], `${name} lists no review`);
    }
    assert.equal(s.ui.currentCount, 0);
    assert.deepEqual(s.ui.current, []);
    for (const [name, text] of [["export", s.markdown], ["closeout", s.closeoutText], ["plan", s.plan], ["explain", JSON.stringify(s.explain)], ["ui", JSON.stringify(s.ui)]]) {
      assert.equal(text.includes(QUESTION), false, `${name} does not render the question row`);
      assert.equal(/codexa760/.test(text), false, `${name} does not attribute a review to the question author`);
    }
    assert.match(s.markdown, /- Independent reviews: current 0 at coord@1{40} · historical 0/);
    assert.equal(s.closeoutText.includes("independent reviews"), false, "closeout claims no independent review");
    assert.equal(s.plan.includes("Independent reviews"), false);
    assert.equal(s.closeout.counts.current + s.exported.counts.current + s.explain.counts.current, 0);
    assert.equal(env.plan.self_review_cycles.length, 1, "a self-review cycle is not an independent review either");
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("COORD-718: an invalid ledger fails closed on every surface", async () => {
  const fresh = entry("claudea13", HEAD, { reviewKey: "second", supersedes: `irv1-${"0".repeat(64)}`, reason: "dangling" });
  const env = fixture([fresh]);
  try {
    const s = await surfaces(env);
    for (const [name, projection] of [["explain", s.explain], ["export", s.exported], ["closeout", s.closeout], ["ui", s.ui]]) {
      assert.match(projection.error, /not recorded before it/, `${name} reports the refusal`);
      assert.deepEqual(projection.current, [], `${name} counts nothing`);
    }
    assert.match(s.markdown, /Independent reviews: ⚠️ invalid ledger, none counted/);
    assert.match(s.closeoutText, /independent reviews: invalid ledger, none counted/);
    assert.match(s.plan, /render refused: Independent review entry 1 links to a review that is not recorded before it/);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("COORD-718: without a claimed head every surface reports reviews as history, and an unknown ticket reports none", async () => {
  const env = fixture([entry("claudea13", HEAD)]);
  try {
    fs.rmSync(path.join(env.coord, ".runtime", "locks", `${TICKET}.lock`));
    fs.writeFileSync(path.join(env.coord, ".runtime", "locks", `${TICKET}.lock`), "{ not json");
    const exporter = await import(pathToFileURL(path.join(__dirname, "../engine/scripts/evidence-export.mjs")).href);
    const markdown = exporter.buildEvidenceExport({ tickets: [TICKET], framework: "all", format: "md", coordDir: env.coord }).body;
    assert.match(markdown, /- Independent reviews: current 0 at unresolved · historical 1/);
    const options = {
      boardPath: path.join(env.coord, "board", "tasks.json"), plansDir: path.join(env.coord, ".runtime", "plans"),
      journalPath: path.join(env.coord, ".runtime", "governance-events.ndjson"), rootDir: env.root,
    };
    const summary = closeout.buildSummary({ ...options, ticketId: TICKET });
    assert.equal(summary.sections.evidence_trail.independent_reviews.historical[0].currency, "scope_unresolved");
    assert.match(closeout.renderText(summary), /independent reviews: 0 current at unresolved claimed scope, 1 historical/);
    const unknown = closeout.buildSummary({ ...options, ticketId: "COORD-404" });
    assert.deepEqual(unknown.sections.evidence_trail.independent_reviews.counts, { current: 0, current_reviewers: 0, historical: 0, total: 0 });
    assert.equal(unknown.sections.evidence_trail.independent_reviews.scope, null);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("COORD-718: closeout text and claim census keep their fallbacks for sparse summaries", () => {
  const cite = (id) => ({ type: "decision", id, path: `p/${id}`, event_hash: null, chain_head: null, verified: true });
  const sparse = {
    ticket_id: null,
    chain_head: null,
    subject: { id: "X-1", repo: null, type: null, status: null, subsystem: null, citations: [cite("board")] },
    grounded_in: { plan_record: false, journal_events: 0, board_row: true, conformance_attestation: false },
    sections: {
      ask_and_delivered: { claims: [] },
      evidence_trail: {
        gate_results: [], review_cycles: [{ lens: "contract", verdict: null, citations: [cite("a"), cite("b"), cite("c"), cite("d")] }],
        independent_reviews: { scope: null, counts: { current: 0, current_reviewers: 0, historical: 0, total: 0 }, error: null, current: [], historical: [] },
        landing: [], conformance: { file: "coord/.runtime/attestations/a.json", algorithm: "ed25519", citations: [cite("att")] }, has_evidence: false,
      },
      decisions: { claims: [{ kind: "deferral", text: "later", citations: undefined }] },
    },
  };
  const text = closeout.renderText(sparse);
  assert.match(text, /— \(no ticket\) —/);
  assert.match(text, /subject: X-1 repo=\? type=\? status=\? subsystem=\?/);
  assert.match(text, /chain_head=\(none\)/);
  assert.match(text, /NO cited evidence found/);
  assert.match(text, /contract -> verdict=\?/);
  assert.match(text, /cites: a, b, c \(\+1\)/, "more than three citations are counted, not listed");
  assert.match(text, /cites: $/m, "a claim without citations renders an empty citation list");
  assert.match(text, /a\.json \(ed25519\) subject_digest=$/m, "an attestation without a digest renders an empty digest");
  const census = closeout.allClaims({ subject: null, sections: { ask_and_delivered: {}, evidence_trail: { independent_reviews: { current: [], historical: [] } }, decisions: {} } });
  assert.deepEqual(census, [], "absent claim lists are empty, not errors");
  const unnamed = closeout.buildSummary({ boardPath: "/nonexistent/tasks.json", plansDir: "/nonexistent/plans", journalPath: "/nonexistent/events.ndjson" });
  assert.equal(unnamed.ticket_id, null);
  assert.equal(unnamed.sections.evidence_trail.has_evidence, false);
  assert.equal(unnamed.sections.evidence_trail.independent_reviews.counts.total, 0);
});
