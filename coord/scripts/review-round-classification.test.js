// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// COORD-649: review-round CLASSIFICATION.
//
// The defect: `add-finding` defaulted the finding's round to inferNextRound —
// the round the ticket ADVANCES INTO — so three findings recorded from ONE
// review landed on rounds 1, 2 and 3. The review-readiness check requires the
// plan record's `review_round` to equal max(finding rounds), and the ONLY writer
// of `review_round` is the `return-doing` transition, which requires
// status=review — precisely what the check blocks. Closed loop: submit and
// move-review both refuse and no governed writer can satisfy them.
//
// These tests pin the whole class:
//   * a finding is recorded under the round the ticket is CURRENTLY in,
//   * `return-doing` still ADVANCES the round (the fix is not "make the round
//     meaningless"), and fresh review evidence is still required after it,
//   * an explicit --round inconsistent with lifecycle state fails closed on both
//     writers,
//   * `correct-finding-round` repairs an already-misclassified round under
//     human-admin authority, journaling before AND after, and touches nothing
//     else.
const {
  __testing,
  executeCommand,
  setupCoord003Workspace,
} = require("./governance-test-utils.js");

// Hermetic identity env: strip ambient ids (mirrors ticket-transitions.test.js).
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const OWNER = "claudea0000";

function readBoard(boardPath) {
  return JSON.parse(fs.readFileSync(boardPath, "utf8"));
}

function findings(boardPath, ticketId) {
  return readBoard(boardPath).review_findings[ticketId] || [];
}

function rounds(boardPath, ticketId) {
  return findings(boardPath, ticketId).map((finding) => finding.round);
}

function planRecordPath(ctx, ticketId) {
  return path.join(ctx.planRecordsDir, `${ticketId}.json`);
}

function planRound(ctx, ticketId) {
  return JSON.parse(fs.readFileSync(planRecordPath(ctx, ticketId), "utf8")).review_round;
}

function ticketRow(boardPath, ticketId) {
  return readBoard(boardPath).sections[0].rows.find((row) => row.ID === ticketId);
}

function reviewRoundIssue(ticketId, boardPath) {
  const row = ticketRow(boardPath, ticketId);
  return __testing
    .collectReviewPlanReadinessIssues(ticketId, row)
    .find((issue) => issue.code === "review_round") || null;
}

function events(ctx) {
  return fs
    .readFileSync(path.join(ctx.coordRoot, ".runtime", "governance-events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The engine SEALS the board against out-of-band edits, so a fixture that
// materializes legacy state (findings auto-incremented to 1/2/3 by the pre-fix
// add-finding) must re-anchor the seal exactly as a fresh journal baseline
// would. This is fixture setup for state the shipped engine can no longer
// produce — not a sanctioned way to mutate a live board.
function reanchorSeal(reason) {
  __testing.appendGovernanceEvent({
    ts: new Date().toISOString(),
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function addFinding(ticketId, summary, extra = []) {
  return executeCommand([
    "add-finding",
    ticketId,
    "--severity",
    "HIGH",
    "--summary",
    summary,
    "--qref",
    "L1",
    ...extra,
  ]);
}

function expectOk(result, label) {
  assert.equal(result.ok, true, `${label} should have succeeded; got: ${result.error}`);
}

function expectRefusal(result, label, pattern) {
  assert.equal(result.ok, false, `${label} must fail closed`);
  assert.match(result.error, pattern, `${label} refusal message`);
}

test("COORD-649: three findings recorded during ONE review all belong to round 1 and do not wedge move-review/submit", () => {
  const ticketId = "MSRV-640";
  const ctx = setupCoord003Workspace("coord649-one-review-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  try {
    // Baseline: a review-round-1 ticket with a matching plan record is ready.
    assert.equal(planRound(ctx, ticketId), 1);
    assert.equal(reviewRoundIssue(ticketId, ctx.boardPath), null);

    expectOk(addFinding(ticketId, "finding one from the single review"), "first add-finding");
    expectOk(addFinding(ticketId, "finding two from the single review"), "second add-finding");
    expectOk(addFinding(ticketId, "finding three from the single review"), "third add-finding");

    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 1, 1]);
    assert.deepEqual(
      findings(ctx.boardPath, ticketId).map((finding) => finding.id),
      [`${ticketId}-F1`, `${ticketId}-F2`, `${ticketId}-F3`]
    );
    // The plan record is untouched by add-finding, and the required round still
    // equals it — no wedge.
    assert.equal(planRound(ctx, ticketId), 1);
    assert.equal(
      reviewRoundIssue(ticketId, ctx.boardPath),
      null,
      "recording several findings from one review must not manufacture an unsatisfiable required round"
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-649: add-finding --round that disagrees with lifecycle state fails closed and changes nothing", () => {
  const ticketId = "MSRV-641";
  const ctx = setupCoord003Workspace("coord649-explicit-round-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  try {
    expectOk(addFinding(ticketId, "first finding"), "seed add-finding");
    const before = JSON.stringify(findings(ctx.boardPath, ticketId));

    // Round 2 has not been reached: only return-doing can produce it.
    const refused = addFinding(ticketId, "claims a round the ticket never reached", ["--round", "2"]);
    expectRefusal(refused, "add-finding --round 2 on a round-1 ticket", /disagrees with lifecycle state/);
    assert.match(refused.error, /currently in review round 1/);
    assert.match(refused.error, /correct-finding-round/, "the refusal must name the governed repair path");
    assert.equal(JSON.stringify(findings(ctx.boardPath, ticketId)), before, "refused add-finding must not write");

    // Not a blanket refusal: the CONSISTENT explicit value is accepted.
    expectOk(addFinding(ticketId, "explicitly round 1", ["--round", "1"]), "add-finding --round 1");
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 1]);

    // A non-integer round is refused rather than silently defaulted.
    expectRefusal(
      addFinding(ticketId, "garbage round", ["--round", "later"]),
      "add-finding --round later",
      /must be a positive integer/
    );
    assert.equal(reviewRoundIssue(ticketId, ctx.boardPath), null);
  } finally {
    ctx.restore();
  }
});

test("COORD-649: return-doing still ADVANCES the round — findings after a genuine repair transition are round 2 and need fresh review evidence", () => {
  const ticketId = "MSRV-642";
  const ctx = setupCoord003Workspace("coord649-advance-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  try {
    expectOk(addFinding(ticketId, "round one finding"), "round-1 add-finding");
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1]);

    // An explicit --round on return-doing that is not the round this transition
    // advances into fails closed.
    expectRefusal(
      executeCommand([
        "return-doing",
        ticketId,
        "--severity",
        "HIGH",
        "--summary",
        "wrong explicit round",
        "--qref",
        "L9",
        "--round",
        "5",
      ]),
      "return-doing --round 5",
      /disagrees with lifecycle state/
    );
    assert.equal(ticketRow(ctx.boardPath, ticketId).Status, "review", "the refused transition must not move the ticket");
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1]);

    // The genuine transition: review -> doing, recording the repair round.
    expectOk(
      executeCommand([
        "return-doing",
        ticketId,
        "--severity",
        "HIGH",
        "--summary",
        "reviewer returns the ticket for repair",
        "--qref",
        "L10",
      ]),
      "return-doing"
    );
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 2], "return-doing advances into round 2");
    assert.equal(planRound(ctx, ticketId), 2, "return-doing is the writer of the plan review_round");

    // Fresh review evidence is required for the new round: the plan record and
    // the required round moved together, so nothing is wedged...
    assert.equal(reviewRoundIssue(ticketId, ctx.boardPath), null);
    // ...but a plan record still claiming round 1 IS flagged.
    const record = JSON.parse(fs.readFileSync(planRecordPath(ctx, ticketId), "utf8"));
    fs.writeFileSync(planRecordPath(ctx, ticketId), `${JSON.stringify({ ...record, review_round: 1 }, null, 2)}\n`, "utf8");
    const staleIssue = reviewRoundIssue(ticketId, ctx.boardPath);
    assert.ok(staleIssue, "a stale round-1 plan record against a round-2 finding must be refused");
    assert.match(staleIssue.message, /must record "- Review round:" as 2/);
    fs.writeFileSync(planRecordPath(ctx, ticketId), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    // A finding recorded now belongs to the CURRENT round — which is now 2.
    expectOk(addFinding(ticketId, "second-round finding"), "post-return-doing add-finding");
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 2, 2]);
    assert.equal(reviewRoundIssue(ticketId, ctx.boardPath), null);
  } finally {
    ctx.restore();
  }
});

test("COORD-649: correct-finding-round repairs a misclassified round under human-admin authority, journaling before AND after", () => {
  const ticketId = "MSRV-643";
  const ctx = setupCoord003Workspace("coord649-correct-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  try {
    // Reproduce the shape COORD-645 was left in: one review, three findings,
    // auto-incremented to rounds 1/2/3 against a plan record at round 1.
    expectOk(addFinding(ticketId, "finding one"), "seed F1");
    expectOk(addFinding(ticketId, "finding two"), "seed F2");
    expectOk(addFinding(ticketId, "finding three"), "seed F3");
    const board = readBoard(ctx.boardPath);
    board.review_findings[ticketId][1].round = 2;
    board.review_findings[ticketId][2].round = 3;
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    reanchorSeal("coord649-legacy-misclassified-rounds-fixture");

    // The wedge reproduces, and now NAMES its governed repair.
    const wedge = reviewRoundIssue(ticketId, ctx.boardPath);
    assert.ok(wedge, "rounds 1/2/3 against a round-1 plan record must be refused");
    assert.match(wedge.message, /must record "- Review round:" as 3/);
    assert.match(
      wedge.message,
      /correct-finding-round/,
      "a required round above the plan round must name its governed repair, not leave a closed loop"
    );
    assert.match(wedge.message, /--human-admin-override/);

    const planBefore = fs.readFileSync(planRecordPath(ctx, ticketId), "utf8");
    const f1Before = JSON.stringify(findings(ctx.boardPath, ticketId)[0]);

    // Authority is required.
    expectRefusal(
      executeCommand(["correct-finding-round", ticketId, "--id", `${ticketId}-F2`, "--round", "1"]),
      "correct-finding-round without authority",
      /requires --human-admin-override/
    );
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 2, 3]);

    // A round the ticket never reached is refused even WITH authority: the
    // command repairs classification, it does not manufacture review history.
    expectRefusal(
      executeCommand([
        "correct-finding-round", ticketId, "--id", `${ticketId}-F1`, "--round", "4",
        "--human-admin-override", "trying to invent a round",
      ]),
      "correct-finding-round above the reached round",
      /has only reached review round/
    );
    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 2, 3]);

    // The repair itself.
    expectOk(
      executeCommand([
        "correct-finding-round", ticketId, "--id", `${ticketId}-F2`, "--round", "1",
        "--human-admin-override", "one review produced all three findings",
      ]),
      "correct F2"
    );
    expectOk(
      executeCommand([
        "correct-finding-round", ticketId, "--id", `${ticketId}-F3`, "--round", "1",
        "--human-admin-override", "one review produced all three findings",
      ]),
      "correct F3"
    );

    assert.deepEqual(rounds(ctx.boardPath, ticketId), [1, 1, 1]);
    assert.equal(reviewRoundIssue(ticketId, ctx.boardPath), null, "the wedge is cleared");

    // Requirement 7: nothing else moved.
    assert.equal(
      fs.readFileSync(planRecordPath(ctx, ticketId), "utf8"),
      planBefore,
      "the correction must not touch the plan record"
    );
    assert.equal(
      JSON.stringify(findings(ctx.boardPath, ticketId)[0]),
      f1Before,
      "the correction must not touch unrelated findings"
    );
    for (const finding of findings(ctx.boardPath, ticketId)) {
      assert.equal(finding.severity, "HIGH");
      assert.equal(finding.status, "open");
      assert.equal(finding.qref, "L1");
    }

    // The journal carries BEFORE and AFTER for each correction.
    const corrections = events(ctx).filter((event) => event.command === "correct-finding-round");
    assert.equal(corrections.length, 2);
    assert.deepEqual(
      corrections.map((event) => [event.details.finding_id, event.details.before_round, event.details.after_round]),
      [[`${ticketId}-F2`, 2, 1], [`${ticketId}-F3`, 3, 1]]
    );
    for (const event of corrections) {
      assert.equal(event.result, "succeeded");
      assert.match(event.details.human_admin_override_reason, /one review produced all three findings/);
    }

    // Idempotence guard: a no-op correction is refused rather than journaled as
    // a repair that did nothing.
    expectRefusal(
      executeCommand([
        "correct-finding-round", ticketId, "--id", `${ticketId}-F2`, "--round", "1",
        "--human-admin-override", "again",
      ]),
      "no-op correction",
      /already recorded under round 1/
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-649: correct-finding-round refuses an unknown finding and an unknown ticket", () => {
  const ticketId = "MSRV-644";
  const ctx = setupCoord003Workspace("coord649-unknown-", ticketId, OWNER, {
    ticketStatus: "review",
    withCommit: true,
  });
  try {
    expectRefusal(
      executeCommand([
        "correct-finding-round", ticketId, "--id", `${ticketId}-F9`, "--round", "1",
        "--human-admin-override", "reason",
      ]),
      "unknown finding",
      /does not exist under/
    );
    expectRefusal(
      executeCommand([
        "correct-finding-round", "MSRV-999", "--id", "MSRV-999-F1", "--round", "1",
        "--human-admin-override", "reason",
      ]),
      "unknown ticket",
      /Unknown ticket/
    );
  } finally {
    ctx.restore();
  }
});
