"use strict";

// COORD-718: unit contract of the independent-review record, retry rule,
// supersession/correction links, claimed scope and current/historical projection.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const reviews = require("./independent-reviews.js");
const supersession = require("./plan-evidence-supersession.js");
const { createGovernanceReadiness } = require("./governance-readiness.js");

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const T = "2026-10-21T20:00:00.000Z";
const reviewer = (handle = "claudea13", extra = {}) => ({ handle, agent_id: "a13", session_id: "a13-s1", thread_id: "lane-708", ...extra });

function review(overrides = {}) {
  return reviews.buildIndependentReview({
    ticketId: "COORD-718",
    reviewer: reviewer(),
    ownerAtReview: "claudea12",
    repository: "coord",
    commit: HEAD,
    method: "code review: contract and failure modes",
    findings: ["F1", "F2"],
    verdict: "pass-with-findings",
    summary: "Two low findings, both fixed.",
    timestamp: T,
    ...overrides,
  });
}

function plan(entries = []) {
  return { ticket_id: "COORD-718", independent_reviews: entries };
}

const scope = { repository: "coord", commit: HEAD, source: "lock" };

test("schema records id, reviewer and session evidence, repository, commit, method, findings, verdict, time and links", () => {
  const entry = review();
  assert.match(entry.id, /^irv1-[a-f0-9]{64}$/);
  assert.equal(entry.id, reviews.independentReviewId("COORD-718", "claudea13", `coord@${HEAD}:code review: contract and failure modes`));
  assert.deepEqual(entry.reviewer, reviewer());
  assert.equal(entry.owner_at_review, "claudea12");
  assert.deepEqual(Object.keys(entry), ["id", "review_key", "ticket_id", "reviewer", "owner_at_review", "repository", "commit", "method",
    "findings", "verdict", "summary", "supersedes", "corrects", "reason", "timestamp"]);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "board", "plan.schema.json"), "utf8"));
  const item = schema.properties.independent_reviews.items;
  assert.deepEqual([...item.required].sort(), Object.keys(entry).sort(), "the JSON schema requires every recorded field");
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(schema.properties.review_submission.required, ["repository", "commit"]);
  assert.equal(schema.properties.review_submission.additionalProperties, false);
  assert.deepEqual(item.properties.verdict.enum, reviews.VERDICTS);
  assert.deepEqual(schema.properties.self_review_cycles.items.required, ["cycle", "total", "raw"], "self-review schema is unchanged");
});

test("reviewer and owner stay distinguishable: owner-authored and identity-less entries are refused", () => {
  assert.throws(() => review({ reviewer: reviewer("claudea12") }), /authored by the ticket owner/);
  assert.throws(() => review({ reviewer: reviewer("claudea13", { session_id: null, thread_id: null }) }), /session or thread evidence/);
  assert.throws(() => review({ reviewer: { handle: "" } }), /reviewer/);
  const forged = { ...review(), reviewer: reviewer("claudea14") };
  assert.throws(() => reviews.validateIndependentReviews(plan([forged])), /id that does not match/, "changing the reviewer breaks the stable id");
});

test("only full immutable commit ids and known verdicts are accepted", () => {
  assert.throws(() => review({ commit: "abc1234" }), /full immutable commit id/);
  assert.throws(() => review({ commit: "HEAD" }), /full immutable commit id/);
  assert.equal(review({ commit: HEAD.toUpperCase() }).commit, HEAD, "commit ids are normalized to lower case");
  assert.equal(review({ commit: "c".repeat(64) }).commit, "c".repeat(64), "sha256 object ids are accepted");
  assert.throws(() => review({ verdict: "approved" }), /verdict must be one of/);
  assert.throws(() => review({ findings: ["F1", "F1"] }), /unique finding ids/);
  assert.throws(() => review({ findings: ["bad id"] }), /unique finding ids/);
  assert.throws(() => review({ repository: "../escape" }), /repository/);
  assert.throws(() => review({ reviewKey: "k", method: "line\nbreak" }), /single-line review method/);
  assert.throws(() => review({ timestamp: "not a date" }), /valid timestamp/);
});

test("identical retry is idempotent and conflicting reuse of a review id fails closed", () => {
  const first = review();
  const applied = reviews.applyIndependentReview(plan(), first);
  assert.equal(applied.changed, true);
  const retry = review({ timestamp: "2026-10-22T00:00:00.000Z", reviewer: reviewer("claudea13", { session_id: "a13-s2" }) });
  const replay = reviews.applyIndependentReview(applied.record, retry);
  assert.equal(replay.changed, false, "a retry from a later session at a later time is the same review");
  assert.equal(replay.record, applied.record);
  assert.throws(() => reviews.applyIndependentReview(applied.record, review({ verdict: "fail" })), /already recorded with different content/);
  assert.throws(() => reviews.applyIndependentReview(applied.record, review({ findings: ["F1"] })), /already recorded with different content/);
  assert.equal(applied.record.independent_reviews.length, 1);
  const other = review({ reviewKey: "second pass" });
  assert.notEqual(other.id, first.id, "a new review key is a new review");
});

test("only canonical exact-commit reviews are current; stale heads stay visible as history", () => {
  const stale = review({ commit: OLD, reviewKey: "first pass" });
  const fresh = review({ reviewKey: "second pass", supersedes: stale.id, reason: "re-reviewed after the fix commit" });
  const otherRepo = review({ repository: "backend", reviewKey: "backend pass" });
  const unlinkedStale = review({ reviewer: reviewer("codexa760", { agent_id: "a760" }), commit: OLD });
  const record = plan([stale, fresh, otherRepo, unlinkedStale]);
  const projection = reviews.resolveIndependentReviews(record, { scope, owner: "claudea12" });
  assert.deepEqual(projection.current.map((item) => item.id), [fresh.id]);
  assert.deepEqual(projection.historical.map((item) => [item.id, item.currency]), [
    [stale.id, "superseded"], [otherRepo.id, "other_repository"], [unlinkedStale.id, "stale_head"],
  ]);
  assert.equal(projection.historical[0].successor, fresh.id);
  assert.deepEqual(projection.counts, { current: 1, current_reviewers: 1, historical: 3, total: 4 });
  const unresolved = reviews.resolveIndependentReviews(record, { scope: null });
  assert.equal(unresolved.counts.current, 0, "without a claimed scope nothing is current");
  assert.ok(unresolved.historical.every((item) => item.currency === "scope_unresolved" || item.status !== "active"));
  const ownerNow = reviews.resolveIndependentReviews(plan([review()]), { scope, owner: "claudea13" });
  assert.equal(ownerNow.counts.current, 0, "a review by the current owner is not independent");
  assert.equal(ownerNow.historical[0].currency, "reviewer_is_owner");
});

test("COORD-858: review status uses immutable submitted scope, ignores stray locks, and leaves legacy scope unresolved", () => {
  const submitted = { repository: "coord", commit: HEAD };
  const landing = { source_commit_sha: OLD };
  assert.deepEqual(reviews.resolveClaimedReviewScope({
    status: "review", reviewSubmission: submitted, lock: { repo: "coord", head: OLD }, landing, repository: "coord",
  }), { ...submitted, source: "submission" });
  assert.equal(reviews.resolveClaimedReviewScope({ status: "review", lock: { repo: "coord", head: HEAD }, landing, repository: "coord" }), null,
    "legacy review must not infer its scope from a mutable lock or landing pointer");
  assert.equal(reviews.resolveClaimedReviewScope({ status: "review", reviewSubmission: { repository: "coord", commit: "HEAD" }, landing, repository: "coord" }), null,
    "malformed persisted scope fails closed");
  assert.equal(reviews.resolveClaimedReviewScope({ status: "review", reviewSubmission: { repository: "backend", commit: HEAD }, repository: "coord" }), null,
    "cross-repository persisted scope fails closed");
  assert.deepEqual(reviews.resolveClaimedReviewScope({ status: "doing", reviewSubmission: submitted, lock: { repo: "coord", head: OLD }, repository: "coord" }),
    { repository: "coord", commit: OLD, source: "lock" }, "an active lock takes precedence while doing");
  assert.equal(reviews.resolveClaimedReviewScope({ status: "doing", reviewSubmission: submitted, repository: "coord" }), null,
    "a prior submission cannot shadow a missing active lock");
  assert.deepEqual(reviews.resolveClaimedReviewScope({ status: "done", lock: { repo: "coord", head: HEAD }, landing, repository: "coord" }),
    { repository: "coord", commit: OLD, source: "landing" }, "the immutable landing-source fallback wins over a stray lock after landing");
});

test("COORD-858: review submission compatibility block round-trips and rejects malformed values", () => {
  const record = { review_submission: { repository: "coord", commit: HEAD } };
  const lines = [];
  supersession.renderReviewSubmissionSection(lines, record);
  const text = lines.join("\\n");
  const parsed = supersession.readPlanEvidenceFromBlock({ "Review submission": [JSON.stringify(record.review_submission)] }, {
    readList: (block, name) => block[name] || [], stripTicks: (value) => value, fail: (message) => { throw new Error(message); },
  });
  assert.deepEqual(parsed.review_submission, record.review_submission);
  assert.ok(text.includes(JSON.stringify(record.review_submission)));
  assert.throws(() => supersession.readPlanEvidenceFromBlock({ "Review submission": ['{"repository":"coord","commit":"HEAD"}'] }, {
    readList: (block, name) => block[name] || [], stripTicks: (value) => value, fail: (message) => { throw new Error(message); },
  }), /full lowercase commit/);
  const readBlock = (values) => supersession.readPlanEvidenceFromBlock({ "Review submission": values }, {
    readList: (block, name) => block[name] || [], stripTicks: (value) => value, fail: (message) => { throw new Error(message); },
  });
  assert.throws(() => readBlock([JSON.stringify(record.review_submission), JSON.stringify(record.review_submission)]), /exactly one JSON object/);
  assert.throws(() => readBlock(["{not-json"]), /Could not parse plan record review submission/);
  assert.equal(readBlock([]).review_submission, undefined, "a legacy plan without this section stays unresolved");
  const emptyLines = [];
  supersession.renderReviewSubmissionSection(emptyLines, {});
  assert.deepEqual(emptyLines, [], "legacy records without a submitted scope render no fabricated section");
  assert.throws(() => supersession.renderReviewSubmissionSection([], { review_submission: { repository: "coord", commit: "HEAD" } }), /review submission is invalid/);
});

test("corrections and supersessions are forward-only, single-successor and same-reviewer", () => {
  const original = review({ commit: OLD });
  const correction = review({ reviewKey: "corrected", corrects: original.id, reason: "recorded the wrong commit" });
  const projection = reviews.resolveIndependentReviews(plan([original, correction]), { scope });
  assert.deepEqual(projection.historical.map((item) => [item.status, item.successor]), [["corrected", correction.id]]);
  assert.throws(() => review({ supersedes: original.id }), /needs a reason/);
  assert.throws(() => review({ reason: "no link" }), /needs a reason exactly/);
  assert.throws(() => review({ supersedes: original.id, corrects: original.id, reason: "both" }), /cannot both/);
  assert.throws(() => reviews.validateIndependentReviews(plan([correction, original])), /not recorded before it/);
  const fork = review({ reviewKey: "fork", supersedes: original.id, reason: "fork" });
  assert.throws(() => reviews.validateIndependentReviews(plan([original, correction, fork])), /already has a successor/);
  const foreign = review({ reviewer: reviewer("codexa760"), supersedes: original.id, reason: "not mine" });
  assert.throws(() => reviews.validateIndependentReviews(plan([original, foreign])), /same reviewer/);
  assert.throws(() => reviews.validateIndependentReviews(plan([original, original])), /repeats review id/);
  assert.throws(() => reviews.validateIndependentReviews({ ticket_id: "COORD-1", independent_reviews: [original] }), /belongs to COORD-718/);
  assert.throws(() => reviews.validateIndependentReviews({ independent_reviews: {} }), /must be an array/);
  assert.throws(() => reviews.validateIndependentReviews(plan([{ ...original, extra: 1 }])), /unknown field/);
});

test("readers fail closed: an invalid ledger yields zero current reviews and the refusal", () => {
  const projection = reviews.projectIndependentReviews(plan([{ id: "x" }]), { scope });
  assert.deepEqual(projection.counts, { current: 0, current_reviewers: 0, historical: 0, total: 0 });
  assert.match(projection.error, /Independent review entry 1/);
  assert.deepEqual(projection.not_evidence, ["QUESTIONS.md", "self_review_cycles"]);
  assert.equal(reviews.projectIndependentReviews(null).counts.total, 0);
});

test("claimed scope is the lock head, then the landed source commit, else unresolved", () => {
  assert.deepEqual(reviews.resolveClaimedReviewScope({ lock: { repo: "coord", head: HEAD.toUpperCase() }, landing: { source_commit_sha: OLD }, repository: "coord" }),
    { repository: "coord", commit: HEAD, source: "lock" });
  assert.deepEqual(reviews.resolveClaimedReviewScope({ lock: { repo: "coord", head: "coord-no-git-head" }, landing: { source_commit_sha: OLD }, repository: "coord" }),
    { repository: "coord", commit: OLD, source: "landing" });
  assert.equal(reviews.resolveClaimedReviewScope({ landing: { source_commit_sha: OLD } }), null, "a landing without a repository is unresolved");
  assert.equal(reviews.resolveClaimedReviewScope({}), null);
  assert.equal(reviews.repositoryForRepoCode("X"), "coord");
  assert.equal(reviews.repositoryForRepoCode("B", { B: "backend" }), "backend");
  assert.equal(reviews.repositoryForRepoCode("Q", {}), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c718-scope-"));
  try {
    fs.writeFileSync(path.join(dir, "COORD-718.lock"), JSON.stringify({ ticket: "COORD-718", repo: "coord", head: HEAD }));
    fs.writeFileSync(path.join(dir, "COORD-9.lock"), JSON.stringify({ ticket: "COORD-1", repo: "coord", head: HEAD }));
    const read = (ticketId) => reviews.readClaimedReviewScope({ fs, path, locksDir: dir, ticketId, board: { landing_index: { "COORD-9": { source_commit_sha: OLD } } }, repoCode: "X" });
    assert.deepEqual(read("COORD-718"), { repository: "coord", commit: HEAD, source: "lock" });
    assert.deepEqual(read("COORD-9"), { repository: "coord", commit: OLD, source: "landing" }, "a lock for another ticket is ignored");
    assert.equal(read("COORD-404"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PLAN.md renders lifecycle status and round-trips the ledger; empty ledgers render nothing", () => {
  const stale = review({ commit: OLD, reviewKey: "first" });
  const fresh = review({ reviewKey: "second", supersedes: stale.id, reason: "new head" });
  const record = { ...plan([stale, fresh]), repo_gates: [], verification_commands: [], critical_invariants: [] };
  const lines = [];
  supersession.renderPlanEvidenceSections(lines, record, (out, name, values) => { out.push(`- ${name}:`); for (const v of values) out.push(`  - ${v}`); }, "repo");
  supersession.renderIndependentReviewSection(lines, record);
  const block = lines.join("\n");
  assert.match(block, /^- Independent reviews \(append-only\):$/m);
  assert.match(block, new RegExp(`status=superseded by ${fresh.id}; historical`));
  assert.match(block, /status=active; current only when coord@a{40} is the claimed head in gov explain/);
  const readList = (text, name) => {
    const all = text.split("\n");
    const start = all.indexOf(`- ${name}:`);
    if (start < 0) return [];
    const out = [];
    for (const line of all.slice(start + 1)) {
      if (/^- [^:]+:$/.test(line)) break;
      const match = /^  - (.*)$/.exec(line);
      if (match) out.push(match[1]);
    }
    return out;
  };
  const parsed = supersession.readPlanEvidenceFromBlock(block, { readList, stripTicks: (v) => v, fail: (m) => { throw new Error(m); } });
  assert.deepEqual(parsed.independent_reviews, [stale, fresh]);
  const emptyLines = [];
  supersession.renderPlanEvidenceSections(emptyLines, { repo_gates: [], verification_commands: [], critical_invariants: [] }, () => {}, "repo");
  supersession.renderIndependentReviewSection(emptyLines, { repo_gates: [] });
  assert.equal(emptyLines.join("\n").includes("Independent reviews"), false);
  assert.equal("independent_reviews" in supersession.readPlanEvidenceFromBlock("", { readList, stripTicks: (v) => v, fail: () => {} }), false);
  assert.throws(() => reviews.readIndependentReviewsFromBlock(`- ${reviews.SECTION_NAME}:\n  - {bad`, { readList, fail: (m) => { throw new Error(m); } }), /Could not parse/);
  assert.throws(() => reviews.readIndependentReviewsFromBlock(`- ${reviews.SECTION_NAME}:\n  - [1]`, { readList, fail: (m) => { throw new Error(m); } }), /must be a JSON object/);
  const rejected = [];
  supersession.validatePlanEvidenceRecord({ ...record, independent_reviews: [fresh] }, (m) => rejected.push(m));
  assert.match(rejected[0], /not recorded before it/, "plan-record validation rejects an invalid ledger");
});

test("the canonical writer hook accepts only the governed writer's branded request", () => {
  const entry = review();
  const record = plan();
  assert.throws(() => supersession.applyCorrectionsToRecord(record, { independentReview: JSON.stringify(entry) }), /written only by gov record-independent-review/);
  assert.throws(() => supersession.applyCorrectionsToRecord(record, { independentReview: { review: entry } }), /written only by gov record-independent-review/);
  supersession.applyCorrectionsToRecord(record, { independentReview: { [reviews.INDEPENDENT_REVIEW_WRITE]: true, review: entry } });
  assert.deepEqual(record.independent_reviews, [entry]);
  supersession.applyCorrectionsToRecord(record, { independentReview: { [reviews.INDEPENDENT_REVIEW_WRITE]: true, review: entry } });
  assert.equal(record.independent_reviews.length, 1, "identical replay through the hook appends nothing");
  supersession.applyCorrectionsToRecord(record, {});
  assert.equal(record.independent_reviews.length, 1);
});

function readinessFor(planState, lock, row = { Owner: "claudea12", Repo: "X" }, board = { metadata: {} }) {
  const { deriveGovernanceReadiness } = createGovernanceReadiness({
    normalizeGovernancePlanShape: () => ({ expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null }, ticket_local_repairs: [] }),
    resolveRepoCodeForTicket: (_id, r) => r?.Repo || "X",
    repoNameForCode: (code) => (code === "X" ? "coord" : "backend"),
    isMeaningfulText: (value) => Boolean(String(value || "").trim()),
    collectReviewPlanReadinessIssues: () => [{ code: "self_review_cycle_count" }],
    resolveTicketLightLane: () => ({ eligible: false, reason: "test" }),
    requiresFeatureProofGovernance: () => false,
    isTestingInfrastructureTicket: () => false,
    collectTicketGovernanceIssueEvents: () => [],
    hasResolvedGovernanceRepairQuestion: () => false,
    fieldHasMeaningfulValue: (values) => values.length > 0,
    deriveDecisionRequiredGuidance: () => null,
  });
  return deriveGovernanceReadiness("COORD-718", row, board, lock, planState, { required: true, issue_codes: ["independent_review"] });
}

test("readiness counts the projection, keeps self-review semantics, and ignores question guidance", () => {
  const stale = review({ commit: OLD, reviewKey: "first" });
  const fresh = review({ reviewKey: "second", supersedes: stale.id, reason: "new head" });
  const planState = { ...plan([stale, fresh]), self_review_cycles: [] };
  const readiness = readinessFor(planState, { repo: "coord", head: HEAD });
  assert.equal(readiness.independent_reviews.counts.current, 1);
  assert.deepEqual(readiness.independent_reviews.scope, scope);
  assert.equal(readiness.independent_reviews.historical[0].currency, "superseded");
  assert.equal(readiness.review_prep.self_review_cycles_complete, false, "independent reviews never satisfy self-review");
  assert.equal("independent_reviews" in readiness.review_prep, false, "review_prep shape is unchanged");
  const landed = readinessFor(planState, null, { Owner: "claudea12", Repo: "X" }, { metadata: {}, landing_index: { "COORD-718": { source_commit_sha: OLD } } });
  assert.equal(landed.independent_reviews.scope.source, "landing");
  assert.equal(landed.independent_reviews.counts.current, 0, "the superseded old-head review is not revived by the landing scope");
  const invalid = readinessFor({ ...planState, independent_reviews: [fresh] }, { repo: "coord", head: HEAD });
  assert.equal(invalid.independent_reviews.counts.current, 0);
  assert.match(invalid.independent_reviews.error, /not recorded before it/);
});

test("every stored field is validated with a specific refusal", () => {
  const good = review();
  const bad = (patch) => () => reviews.validateIndependentReviews(plan([{ ...good, ...patch }]));
  assert.throws(() => reviews.validateIndependentReviews(plan([null])), /entry 1 must be an object/);
  assert.throws(bad({ reviewer: null }), /reviewer must be an object/);
  const { summary: omitted, ...withoutSummary } = good;
  assert.equal(typeof omitted, "string");
  assert.throws(() => reviews.validateIndependentReviews(plan([withoutSummary])), /missing field "summary"/);
  assert.throws(bad({ reviewer: { ...good.reviewer, agent_id: 5 } }), /reviewer.agent_id must be a single-line string or null/);
  assert.throws(bad({ reviewer: { ...good.reviewer, thread_id: "two\nlines" } }), /reviewer.thread_id must be a single-line string or null/);
  assert.throws(bad({ supersedes: "not-a-review-id" }), /supersedes must be a review id or null/);
  assert.throws(bad({ ticket_id: "lowercase-1" }), /invalid ticket_id/);
  assert.throws(bad({ review_key: " padded" }), /single-line review_key/);
  assert.throws(bad({ owner_at_review: "not a handle" }), /owner_at_review must be a handle or null/);
  assert.throws(bad({ summary: "x".repeat(4001) }), /summary must be text or null/);
  assert.throws(() => review({ ticketId: "bad" }), /invalid ticket_id/);
  assert.throws(() => review({ reviewKey: "two\nlines" }), /single-line review_key/);
  assert.throws(() => review({ ownerAtReview: "bad handle" }), /owner_at_review must be a handle/);
  assert.throws(() => review({ supersedes: "bad", reason: "r" }), /supersedes must be a review id/);
  assert.throws(() => review({ commit: undefined }), /full immutable commit id/);
  assert.throws(() => review({ reviewer: undefined }), /registered reviewer handle/);
  const sparse = review({ findings: undefined, summary: "   ", ownerAtReview: null, timestamp: undefined });
  assert.deepEqual(sparse.findings, []);
  assert.equal(sparse.summary, null, "blank text is stored as null");
  assert.equal(sparse.owner_at_review, null, "an unassigned ticket records no owner");
  assert.ok(Number.isFinite(Date.parse(sparse.timestamp)), "the writer stamps the time");
  assert.deepEqual(reviews.validateIndependentReviews({ independent_reviews: [good] }).map((item) => item.status), ["active"],
    "a record without ticket_id is validated entry by entry");
  assert.deepEqual(reviews.validateIndependentReviews({}), [], "a plan without the field has no reviews");
});

test("owner normalization, scope normalization and file-scope edge cases", () => {
  assert.equal(reviews.reviewOwnerOf("claudea12"), "claudea12");
  assert.equal(reviews.reviewOwnerOf("unassigned"), null);
  assert.equal(reviews.reviewOwnerOf(""), null);
  assert.equal(reviews.reviewOwnerOf(undefined), null);
  const entries = plan([review()]);
  assert.deepEqual(reviews.resolveIndependentReviews(entries, { scope: { repository: "coord", commit: HEAD } }).scope,
    { repository: "coord", commit: HEAD, source: null }, "a scope without a source is still a scope");
  for (const broken of [{ repository: "coord" }, { repository: "coord", commit: "abc" }, { repository: "", commit: HEAD }]) {
    assert.equal(reviews.resolveIndependentReviews(entries, { scope: broken }).scope, null, `${JSON.stringify(broken)} is not a claimed scope`);
  }
  assert.equal(reviews.resolveIndependentReviews(entries).counts.current, 0, "no options means no claimed scope");
  assert.equal(reviews.resolveClaimedReviewScope({ lock: { repo: "coord" } }), null, "a lock without a head claims nothing");
  assert.equal(reviews.resolveClaimedReviewScope({ lock: { repo: "", head: HEAD } }), null, "a lock without a repository claims nothing");
  assert.equal(reviews.resolveClaimedReviewScope({ landing: {}, repository: "coord" }), null, "a landing without a source commit claims nothing");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c718-scope-board-"));
  try {
    assert.equal(reviews.readClaimedReviewScope({ fs, path, locksDir: dir, ticketId: "COORD-1", board: null, repoCode: "X" }), null);
    assert.equal(reviews.readClaimedReviewScope({ fs, path, locksDir: dir, ticketId: "COORD-1", board: {}, repoCode: "X" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readClaimedReviewScope derives legacy status from the board row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c858-scope-status-fallback-"));
  try {
    const ticketId = "COORD-1";
    fs.writeFileSync(path.join(dir, `${ticketId}.lock`), JSON.stringify({ ticket: ticketId, repo: "coord", head: HEAD }));
    const scope = reviews.readClaimedReviewScope({
      fs, path, locksDir: dir, ticketId,
      board: { sections: [{ rows: [{ ID: ticketId, Status: "doing" }] }] },
      repoCode: "X",
    });
    assert.deepEqual(scope, { repository: "coord", commit: HEAD, source: "lock" });

    const submission = { repository: "coord", commit: OLD };
    const reviewScope = reviews.readClaimedReviewScope({
      fs, path, locksDir: dir, ticketId,
      board: { sections: [{}, { rows: [{ ID: ticketId, Status: "review" }] }] },
      repoCode: "X", status: "", reviewSubmission: submission,
    });
    assert.deepEqual(reviewScope, { repository: "coord", commit: OLD, source: "submission" },
      "empty explicit status falls back across absent row lists and uses the matching row status");

    const unknownTicketScope = reviews.readClaimedReviewScope({
      fs, path, locksDir: dir, ticketId,
      board: { sections: [{}] }, repoCode: "X",
    });
    assert.deepEqual(unknownTicketScope, { repository: "coord", commit: HEAD, source: "lock" },
      "missing ticket status keeps the validated lock claim as the legacy fallback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("block parsing refuses non-object entries and render marks a record without owner", () => {
  const readList = (text) => text.split("\n").slice(1).map((line) => line.replace(/^  - /, ""));
  const reject = (m) => { throw new Error(m); };
  for (const value of ["null", "5"]) {
    assert.throws(() => reviews.readIndependentReviewsFromBlock(`- x:\n  - ${value}`, { readList, fail: reject }), /must be a JSON object/);
  }
  const lines = [];
  reviews.renderIndependentReviewSection(lines, plan([review({ ownerAtReview: null, findings: [] })]));
  assert.match(lines.join("\n"), /owner_at_review=none .* findings=none status=active/);
  assert.throws(() => reviews.applyIndependentReviewToRecord(plan(), { independentReview: null }), /written only by gov record-independent-review/);
});

test("readiness tolerates a missing plan, an unassigned owner and an unresolvable repository name", () => {
  const unassigned = readinessFor(null, { repo: "coord", head: HEAD }, { Owner: "unassigned", Repo: "X" });
  assert.deepEqual([unassigned.independent_reviews.counts.total, unassigned.independent_reviews.error], [0, null]);
  const { deriveGovernanceReadiness } = createGovernanceReadiness({
    normalizeGovernancePlanShape: () => ({ expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null }, ticket_local_repairs: [] }),
    resolveRepoCodeForTicket: () => "B",
    repoNameForCode: () => { throw new Error("repo root missing"); },
    isMeaningfulText: () => true,
    collectReviewPlanReadinessIssues: () => [],
    resolveTicketLightLane: () => ({ eligible: false, reason: "test" }),
    requiresFeatureProofGovernance: () => false,
    isTestingInfrastructureTicket: () => false,
    collectTicketGovernanceIssueEvents: () => [],
    hasResolvedGovernanceRepairQuestion: () => false,
    fieldHasMeaningfulValue: () => false,
    deriveDecisionRequiredGuidance: () => null,
  });
  const landed = deriveGovernanceReadiness("COORD-718", { Owner: "claudea12", Repo: "B" }, { metadata: {}, landing_index: { "COORD-718": { source_commit_sha: HEAD } } }, null, plan([review()]));
  assert.equal(landed.independent_reviews.scope, null, "an unknown repository name leaves the landing scope unresolved");
  const defaults = createGovernanceReadiness({
    normalizeGovernancePlanShape: () => ({ expected_closeout: { method: "pr", base_ref: "dev", provenance_note: null }, ticket_local_repairs: [] }),
    resolveRepoCodeForTicket: (_ticket, row) => row.Repo,
    isMeaningfulText: () => true,
    collectReviewPlanReadinessIssues: () => [],
    resolveTicketLightLane: () => ({ eligible: false, reason: "test" }),
    requiresFeatureProofGovernance: () => false,
    isTestingInfrastructureTicket: () => false,
    collectTicketGovernanceIssueEvents: () => [],
    hasResolvedGovernanceRepairQuestion: () => false,
    fieldHasMeaningfulValue: () => false,
    deriveDecisionRequiredGuidance: () => null,
  });
  const landedBoard = { metadata: {}, landing_index: { "COORD-718": { source_commit_sha: HEAD } } };
  assert.equal(defaults.deriveGovernanceReadiness("COORD-718", { Owner: "claudea12", Repo: "B" }, landedBoard, null, plan([review()])).independent_reviews.scope, null,
    "without an injected repo naming only the control plane has a known repository");
  const controlPlane = defaults.deriveGovernanceReadiness("COORD-718", { Owner: "claudea12", Repo: "X" }, landedBoard, null, plan([review()]));
  assert.deepEqual(controlPlane.independent_reviews.scope, { ...scope, source: "landing" }, "the default repository naming maps the control plane to coord");
  assert.equal(controlPlane.independent_reviews.counts.current, 1);
});
