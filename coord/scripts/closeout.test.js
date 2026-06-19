const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __testing,
  setupCoord003Workspace,
  readBoardRow,
} = require("./governance-test-utils.js");

// COORD-062: tests for the extracted closeout.js surface (finalize / land /
// finish-ticket / prepareDoneCloseout plus the closeout plan-update builders).
// The closeout functions are reached through the lifecycle __testing facade,
// which now wires the createCloseout factory after createTicketTransitions.
// Hermetic identity env: strip ambient ids.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

test("buildNoPrCloseoutPlanUpdate keeps already-landed no-pr closeouts distinct from fulfilled_by", () => {
  const row = { Repo: "F" };

  assert.deepEqual(__testing.buildNoPrCloseoutPlanUpdate(row, {
    alreadyLanded: true,
    landed: "manual landing evidence",
  }), {
    closeoutMethod: "no_pr",
    closeoutBaseRef: __testing.paths.REPO_INTEGRATION_BRANCHES.F || "dev",
    provenanceNote: "manual landing evidence",
  });

  assert.deepEqual(__testing.buildNoPrCloseoutPlanUpdate(row, {
    fulfilledByCommit: "abc123",
  }), {
    closeoutMethod: "fulfilled_by",
    closeoutBaseRef: __testing.paths.REPO_INTEGRATION_BRANCHES.F || "dev",
    provenanceNote: null,
  });
});

// COORD-066: end-to-end finalize/land wiring-guard test.
//
// Wave 2 (COORD-061/062) split the lifecycle into a near-circular pair:
// ticket-transitions.js (markDone) needs closeout.js (prepareDoneCloseout), and
// closeout.js (finalize/finish/land) needs ticket-transitions (moveReview /
// markDone / applyMarkDone). lifecycle.js resolves this with deferred
// `(...args) => fn(...args)` wrappers AND a strict factory ordering
// (createTicketTransitions BEFORE createCloseout). That wiring only resolves at
// CALL time, and until now nothing in the suite called these exec functions —
// so a reorder or a dropped deferred wrapper would ship silently and only blow
// up ("prepareDoneCloseout is not a function") the first time someone finalized
// a real ticket.
//
// This test drives a Repo-X ticket through the FULL closeout in one call:
//   finishTicket (closeout)
//     -> setPrRefs + markDone (ticket-transitions, injected as deferred wrappers)
//        -> prepareDoneCloseout (closeout, injected back into transitions as a
//           deferred wrapper — the near-circular edge)
//        -> applyMarkDone (ticket-transitions)
// crossing the transitions<->closeout seam in BOTH directions. We assert the
// board row reaches `done`, which is only reachable if every deferred wrapper
// resolved and the factory ordering held. If someone reorders the factories or
// drops a deferred wrapper, markDone calls `undefined` and this test fails with
// a TypeError instead of reaching `done` — which is the whole point.
//
// Repo X is deliberate: it is the NARROWEST precondition that still calls
// through the seam. The X branch of prepareDoneCloseout runs
// ensureRepoXCloseoutReady (a worktree-residue check) instead of the heavy
// product-repo landing/PR/feature-proof audits, so the test needs no merged-PR
// scaffolding while still exercising the deferred markDone<->prepareDoneCloseout
// edge that is the actual regression surface.
//
// Fixture: reuse setupCoord003Workspace (the shared temp board + .runtime + temp
// git repo harness) and repoint the ticket to Repo X / review with `(no PR)`
// evidence, a review-ready plan record, no lock, and no product-worktree
// residue. All `__testing.paths` overrides are restored in `finally` via
// ctx.restore(); we never touch the live board or coord/.runtime.
function setupRepoXReviewReadyFixture(prefix, ticketId, owner) {
  const ctx = setupCoord003Workspace(prefix, ticketId, owner);

  // The harness provisions a backend worktree for the ticket; a Repo X ticket
  // must have no governed product-repo residue or ensureRepoXCloseoutReady
  // (rightly) refuses to close it. Remove it.
  spawnSync("git", ["-C", ctx.backendRoot, "worktree", "remove", "--force", ctx.worktreePath], { encoding: "utf8" });
  fs.rmSync(ctx.worktreePath, { recursive: true, force: true });

  // Repoint the ticket to Repo X / review with no-PR evidence.
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const row = board.sections[0].rows.find((r) => r.ID === ticketId);
  row.Repo = "X";
  row.Status = "review";
  board.pr_index = { [ticketId]: ["local-review (no PR)"] };
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  // Review state needs no doing lock.
  if (fs.existsSync(ctx.lockPath)) {
    fs.unlinkSync(ctx.lockPath);
  }

  // Bind the owner's session to the live effective thread id so the
  // mutation-ownership gate inside markDone resolves to the ticket owner.
  const threadId = __testing.resolveEffectiveThreadId();
  const sessions = JSON.parse(fs.readFileSync(__testing.paths.AGENT_SESSIONS_PATH, "utf8"));
  sessions[0].thread_id = threadId;
  fs.writeFileSync(__testing.paths.AGENT_SESSIONS_PATH, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");

  // Make the plan record review-ready: real repo_gates + complete, passing
  // self-review cycles. (The scaffold the harness seeds is intentionally TODO.)
  const recordPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.repo_gates = ["not-required"];
  record.self_review_cycles = [1, 2, 3, 4].map((cycle) => ({
    cycle,
    total: 4,
    lens: "transitions<->closeout seam",
    diff: "test-only wiring guard",
    risks: ["deferred wrapper regression", "factory ordering regression"],
    findings: "none",
    verification: "node --test coord/scripts/closeout.test.js",
    verdict: "pass",
    raw: "lens=seam; diff=test; risks=a, b; findings=none; verification=node --test; verdict=pass",
  }));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return ctx;
}

test("COORD-066: finishTicket drives a Repo-X ticket review -> done through the transitions<->closeout deferred-wiring seam", () => {
  const ticketId = "ARCH-901";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("ebmr-coord066-finish-seam-", ticketId, owner);
  try {
    // finishTicket lives in closeout.js and calls moveReview/markDone/applyMarkDone
    // (ticket-transitions) via deferred wrappers; markDone calls back into
    // closeout.prepareDoneCloseout via the near-circular deferred wrapper. This
    // is the only call in the suite that exercises that full round trip.
    __testing.finishTicket(ticketId, { owner });

    const finalRow = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(
      finalRow.Status,
      "done",
      "finishTicket must drive the ticket to done; reaching done proves the deferred " +
      "markDone<->prepareDoneCloseout wiring and the createTicketTransitions-before-createCloseout " +
      "factory ordering both resolved at call time"
    );
  } finally {
    ctx.restore();
  }
});

test("COORD-066: finalizeTicket --no-pr drives a review-state Repo-X ticket to done through markDone -> prepareDoneCloseout", () => {
  // finalizeTicket is the other public closeout entrypoint. For a review-state
  // no-PR ticket it calls markDone directly (markDone -> deferred
  // prepareDoneCloseout), guarding the same seam from the finalize side.
  const ticketId = "ARCH-902";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("ebmr-coord066-finalize-seam-", ticketId, owner);
  try {
    __testing.finalizeTicket(ticketId, { owner, noPr: true });

    const finalRow = readBoardRow(ctx.boardPath, ticketId);
    assert.equal(
      finalRow.Status,
      "done",
      "finalizeTicket --no-pr must reach done via markDone -> deferred prepareDoneCloseout"
    );
  } finally {
    ctx.restore();
  }
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


// ---------------------------------------------------------------------------
// COORD-022: governance.js portability — config-aware base ref, package-
// manager-aware gate, off-git sync guard.
// ---------------------------------------------------------------------------

test("COORD-022: closeout builders resolve a main-integration repo to main, non-code rows stay main", () => {
  const original = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  try {
    __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "main", F: "dev" };
    // Repo-backed code row on a main-integration repo -> "main".
    assert.equal(__testing.buildPrCloseoutPlanUpdate({ Repo: "B" }, null).closeoutBaseRef, "main");
    assert.equal(__testing.buildNoPrCloseoutPlanUpdate({ Repo: "B" }).closeoutBaseRef, "main");
    // Repo-backed code row on a dev-integration repo stays "dev" (byte-identical donor behavior).
    assert.equal(__testing.buildPrCloseoutPlanUpdate({ Repo: "F" }, null).closeoutBaseRef, "dev");
    assert.equal(__testing.buildNoPrCloseoutPlanUpdate({ Repo: "F" }).closeoutBaseRef, "dev");
    // Non-code coordination row (X) keeps "main" regardless of integration branches.
    assert.equal(__testing.buildPrCloseoutPlanUpdate({ Repo: "X" }, null).closeoutBaseRef, "main");
    assert.equal(__testing.buildNoPrCloseoutPlanUpdate({ Repo: "X" }).closeoutBaseRef, "main");
  } finally {
    __testing.paths.REPO_INTEGRATION_BRANCHES = original;
  }
});
