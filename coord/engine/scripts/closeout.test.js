process.env.COORD_PROJECT_CONFIG = require("node:path").resolve(__dirname, "fixtures", "hermetic-project.config.js"); // COORD-967: hermetic board/integration branch defaults
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const createGovernanceSession = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-session.js"));

// COORD-854 / COORD-856: fixture dirs live under the temp dir, which may hold
// spaces or shell metacharacters. A printed recovery step quotes each path with
// the shared git-ops shellQuote, so tests capture it as a shell word, split it
// with a POSIX shell-word splitter and run the resulting argv, never through a
// shell. TEMP_PATH_RE still matches a path named in prose (not a command).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMP_PATH_RE = (() => {
  const tmp = require("node:os").tmpdir();
  return `(?:${[...new Set([tmp, fs.realpathSync(tmp)])].map(escapeRegExp).join("|")})\\S*`;
})();
const SHELL_WORD_RE = "(?:'[^']*'|\\\\.|[^\\s'\\\\()])+";
const { shellQuote, formatGitCommand } = require("./git-ops.js");
const { hostileTempDir, splitPosixShellWords, shellArgv } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/fixtures/posix-shell-words.js"));
const closeoutTesting = require("./closeout.js").__testing;
// COORD-952: closeout fixtures verify Repo X engine integrity against a fixture pin whose
// manifest surface comes from the live manifest but whose verdict is the pinned state. An
// un-re-pinned engine edit in this checkout therefore cannot turn unrelated fixtures red.
{
  const livePin = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/engine-pin.js"))({ coordDir: ENGINE_COORD_DIR });
  require("./lifecycle-repox-closeout.js").__testing.setEngineIntegrityPinOverride({
    deriveManifestFingerprint: () => livePin.deriveManifestFingerprint(),
    verifyManifest: () => ({ ok: true, failures: [] }),
    verify: () => ({ ok: true, pinned: true, drifted_files: [], problems: [] }),
  });
}
const createCloseout = require("./closeout.js");

test("COORD-1047: closeout uses the canonical ticket-fence provider and rejects an invalid override", () => {
  assert.doesNotThrow(() => createCloseout({}), "the composition factory resolves the canonical fence provider");
  assert.throws(
    () => createCloseout({ assertTicketFence: null }),
    (error) => error && error.code === "governance_factory_dependency_missing" && error.missing_callable.includes("assertTicketFence"),
  );
});
const createRepoRegistry = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/repo-registry.js"));
const closeoutRepoRegistry = createRepoRegistry();
const closeoutOwner = createCloseout({
  isRepoBackedCode: closeoutRepoRegistry.isRepoBackedCode,
  resolveRepoIntegrationBranch: closeoutRepoRegistry.resolveRepoIntegrationBranch,
});
function runPrintedGitStep(step) {
  const argv = splitPosixShellWords(step);
  assert.deepEqual(argv.slice(0, 2), ["git", "-C"], `a printed git -C step: ${step}`);
  return execFileSync("git", argv.slice(1), { encoding: "utf8", stdio: "pipe" });
}

const {
  __testing,
  executeCommand,
  sandboxProcessRuntimeLocks,
  setupCoord003Workspace,
  readBoardRow,
  withScopedGovernanceTestContext,
} = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-test-utils.js"));

const sessionOwner = createGovernanceSession({ state: governanceState });
sandboxProcessRuntimeLocks();

test("COORD-808: merge recovery reads the active runtime journal without donor history", () => {
  const { findRecordedWorkspaceMerge } = require("./control-plane-merge-history.js");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord808-merge-history-"));
  const journalPath = path.join(root, "governance-events.ndjson");
  try {
    withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOG_PATH: journalPath }, () => {
      assert.equal(findRecordedWorkspaceMerge(null), null);
      assert.equal(findRecordedWorkspaceMerge("COORD-809"), null, "a missing journal is best-effort");
      fs.writeFileSync(journalPath, "");
      assert.equal(findRecordedWorkspaceMerge("COORD-809"), null, "an empty active journal cannot recover a donor landing");
      const receipt = {
        type: "control_plane_workspace_merge",
        ticket: "COORD-809",
        merge_commit_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        repo_root: process.cwd(),
      };
      fs.appendFileSync(journalPath, `${JSON.stringify({ details: { external_side_effects: [receipt] } })}\n`);
      const foreign = { ...receipt, merge_commit_sha: "a".repeat(40), repo_root: `${process.cwd()}-other-clone` };
      fs.appendFileSync(journalPath, `${JSON.stringify({ details: { external_side_effects: [foreign] } })}\n`);
      const unusable = [
        { ...receipt, repo_root: null },
        { ...receipt, merge_commit_sha: "0".repeat(40) },
      ];
      fs.appendFileSync(journalPath, `${JSON.stringify({ details: { external_side_effects: unusable } })}\n{"torn":`);

      assert.equal(findRecordedWorkspaceMerge("COORD-809", { repoRoot: process.cwd() }).mergeCommitSha, receipt.merge_commit_sha,
        "recovery observes the receipt appended in the active runtime");
      assert.equal(findRecordedWorkspaceMerge("COORD-809", { repoRoot: `${process.cwd()}-other-clone` }), null,
        "a receipt from another checkout cannot be adopted even when its path is named in the journal");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-595: consecutive landed notices retain the seed and both question rows", () => {
  const tempDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord595-land-"));
  const questionPath = path.join(tempDir, "QUESTIONS.md");
  const seed = "| 2026-07-31 | prior | orchestrator | Prior resolved question | Its answer | yes |";
  try {
    fs.writeFileSync(questionPath, `# Questions\n\n${seed}\n\n## Instructions\n`, "utf8");
    withScopedGovernanceTestContext({ QUESTIONS_PATH: questionPath }, () => {
      const rows = ["COORD-476", "COORD-477"].map((id) => ({ ID: id, Repo: "B", Status: "review", Owner: "owner" }));
      const board = { sections: [{ rows }], pr_index: Object.fromEntries(rows.map((row) => [row.ID, ["local-review (no PR)"]])), review_findings: {}, landing_index: {} };
      const questions = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/questions.js"))({
        readCanonicalTextFile: __testing.readCanonicalTextFile,
        writeCanonicalTextFile: __testing.writeCanonicalTextFile,
        todayIso: () => "2026-07-31",
        escapeTable: require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/lifecycle-utils.js")).escapeTable,
      });
      const closeout = require("./closeout.js")({
        fail: (message) => { throw new Error(message); },
        withGovernanceMutation: (_metadata, run) => run(),
        inferTicketStatus: (id) => rows.find((row) => row.ID === id).Status,
        readBoard: () => board,
        getTicketRef: (_board, id) => ({ row: rows.find((row) => row.ID === id) }),
        ensureTicketMutationOwnership: () => ({}),
        isRepoBackedCode: (code) => code === "B",
        resolveRepoIntegrationBranch: () => "dev",
        getRepoRoot: () => "/tmp/coord595-fixture-repo",
        assertReviewPlanReady: () => {},
        findOutstandingCloseoutBlockerFollowups: () => [],
        findLockForTicket: () => null,
        verifyPrEvidence: () => {},
        ensureLandingRecord: () => ({ evidence: ["fixture landing"] }),
        assertLandingIntegrity: () => {},
        ensureTestingInfrastructureLandingAudit: () => {},
        ensureFeatureProofLandingAudit: () => {},
        cleanupTicketWorktree: () => {},
        buildQuestionRow: questions.buildQuestionRow,
        buildLandCloseoutAnswer: ({ ticketId }) => `${ticketId} landed`,
        appendQuestionRowText: questions.appendQuestionRowText,
        removeQuestionRowText: questions.removeQuestionRowText,
        applyMarkDone: (id) => { rows.find((row) => row.ID === id).Status = "done"; },
        updateCanonicalPlanState: () => {},
      });
      closeout.landTicket("COORD-476", {});
      closeout.landTicket("COORD-477", {});
      const content = fs.readFileSync(questionPath, "utf8");
      assert.ok(content.includes(seed), "the prior resolved row survived both landings");
      for (const id of ["COORD-476", "COORD-477"]) {
        assert.equal(content.split(`${id} landed through governance.`).length - 1, 1);
        assert.equal(rows.find((row) => row.ID === id).Status, "done");
      }
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

  assert.deepEqual(closeoutOwner.buildNoPrCloseoutPlanUpdate(row, {
    alreadyLanded: true,
    landed: "manual landing evidence",
  }), {
    closeoutMethod: "no_pr",
    closeoutBaseRef: governanceDefaultPaths.repoIntegrationBranches.F || "dev",
    provenanceNote: "manual landing evidence",
  });

  assert.deepEqual(closeoutOwner.buildNoPrCloseoutPlanUpdate(row, {
    fulfilledByCommit: "abc123",
  }), {
    closeoutMethod: "fulfilled_by",
    closeoutBaseRef: governanceDefaultPaths.repoIntegrationBranches.F || "dev",
    provenanceNote: null,
  });
});

// COORD-667: prepareDoneCloseout must FORWARD its options to the Repo-X gate.
//
// The in-process control-plane workspace merge is opt-in (`--merge-workspace`),
// and the opt-in reaches the gate only through this one argument. The gate was
// previously called as `ensureRepoXCloseoutReady(ticketId)` with no options at
// all, so dropping the second argument again would not break a single existing
// test — it would just silently make the flag a no-op and leave every repo-X
// ticket unlandable exactly as COORD-667 found them.
test("COORD-667: prepareDoneCloseout forwards closeout options to the Repo-X gate", () => {
  const createCloseout = require("./closeout.js");
  const seen = [];
  const board = {
    pr_index: { "COORD-667": ["local-review (no PR)"] },
    review_findings: {},
    landing_index: {},
  };
  const ref = { row: { Repo: "X", Status: "review", Owner: "claudea675" } };
  const closeout = createCloseout({
    fail: (m) => { throw new Error(m); },
    assertReviewPlanReady: () => {},
    verifyPrEvidence: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    resolveSourceCommitOrRefuse: () => "a".repeat(40),
    ensureControlPlaneLandingRecord: () => null,
    ensureRepoXCloseoutReady: (ticketId, options) => { seen.push([ticketId, options]); },
    cleanupTicketWorktree: () => {},
    isRepoBackedCode: (code) => code === "B" || code === "F",
  });

  closeout.prepareDoneCloseout("COORD-667", board, ref, { mergeWorkspace: true, base: "main" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "COORD-667");
  assert.equal(seen[0][1].mergeWorkspace, true, "the --merge-workspace opt-in never reached the Repo-X gate");
  assert.equal(seen[0][1].base, "main");
});

// COORD-869: the closeout preflight's two Repo-X early returns. `land` only
// reaches runCloseoutPreflight for a PR-backed ticket, and refuses a PR-backed
// Repo-X ticket before it, so no verb drives a Repo-X ref through these arms;
// they keep a future caller from resolving Repo-X provenance against a product
// repository. Exercised through the factory's __testing hook.
test("COORD-869: the closeout preflight resolves no product-repo provenance for a Repo-X ticket", () => {
  const board = { pr_index: { "COORD-869": ["https://github.com/o/r/pull/9"] }, review_findings: {}, landing_index: {} };
  const ref = { row: { ID: "COORD-869", Repo: "X", Status: "review", Owner: "claudea869" } };
  const consulted = [];
  const closeout = createCloseout({
    fail: (message) => { throw new Error(message); },
    assertReviewPlanReady: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    isRepoBackedCode: (code) => code === "B" || code === "F",
    getRepoRoot: (code) => { consulted.push(["getRepoRoot", code]); return "/nonexistent"; },
    resolveCommitishInRepo: (root, commitish) => { consulted.push(["resolve", commitish]); return null; },
    resolveSourceCommitSha: () => { consulted.push(["resolveSourceCommitSha"]); return "f".repeat(40); },
  });
  const { runCloseoutPreflight } = closeout.__testing;
  const receipt = runCloseoutPreflight(
    "COORD-869", board, ref, { sourceCommit: "abc1234", landed: "abc1234 landed by hand" }, "https://github.com/o/r/pull/9"
  );
  assert.deepEqual(receipt, { preflighted: true, ticketId: "COORD-869", sourceCommitSha: null });
  assert.deepEqual(consulted, [], "a Repo-X preflight never resolves commits in a product repository");

  const repoBacked = { row: { ...ref.row, Repo: "B" } };
  assert.throws(
    () => runCloseoutPreflight("COORD-869", board, repoBacked, { landed: "abc1234 landed by hand" }, "https://github.com/o/r/pull/9"),
    /manual landing evidence but no resolvable commit SHA/
  );
});

test("COORD-855: finishTicket passes its resolved refs into mark-done atomically", () => {
  const createCloseout = require("./closeout.js");
  const calls = [];
  const board = { pr_index: { "ARCH-748": ["old (no PR)"] }, landing_index: {}, review_findings: {} };
  const closeout = createCloseout({
    fail: (message) => { throw new Error(message); },
    readBoard: () => board,
    getTicketRef: () => ({ row: { ID: "ARCH-748", Repo: "X", Status: "review", Owner: "codexa742" } }),
    resolveLifecyclePrRefs: () => ["authoritative complete set (no PR)"],
    setPrRefs: (ticketId, options) => calls.push({ ticketId, options }),
    markDone: (ticketId, options) => calls.push({ ticketId, closeoutPrRefs: options.closeoutPrRefs }),
  });

  closeout.finishTicket("ARCH-748", {});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ticketId, "ARCH-748");
  assert.deepEqual(calls[0], { ticketId: "ARCH-748", closeoutPrRefs: ["authoritative complete set (no PR)"] });

  const finalizeCalls = [];
  const finalize = createCloseout({
    fail: (message) => { throw new Error(message); },
    STATUS: { DOING: "doing", REVIEW: "review", DONE: "done" },
    readBoard: () => ({ pr_index: {}, landing_index: {}, review_findings: {} }),
    getTicketRef: () => ({ row: { ID: "ARCH-749", Repo: "X", Status: "review", Owner: "codexa742" } }),
    withGovernanceMutation: (_mutation, action) => action(),
    mergeUniqueRefs: (existing, additions) => [...new Set([...(existing || []), ...(additions || [])])],
    toArray: (value) => value == null ? [] : Array.isArray(value) ? value : [value],
    setPrRefs: (ticketId, options) => finalizeCalls.push({ operation: "set-pr", ticketId, options }),
    markDone: (ticketId, options) => finalizeCalls.push({ operation: "mark-done", ticketId, closeoutPrRefs: options.closeoutPrRefs }),
    updateCanonicalPlanState: () => {},
    isRepoBackedCode: () => false,
  });
  finalize.finalizeTicket("ARCH-749", { noPr: true });
  assert.deepEqual(finalizeCalls, [{
    operation: "mark-done",
    ticketId: "ARCH-749",
    closeoutPrRefs: ["local-review (no PR)"],
  }], "finalize --no-pr passes its complete evidence set to the terminal transaction");
});

test("COORD-855: a stale doing read cannot authorize ignoring a lock after markDone re-reads review", () => {
  const createTransitions = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/ticket-transitions.js"));
  const row = { ID: "COORD-855", Repo: "B", Status: "doing", Owner: "codexa782" };
  const durableBoard = { sections: [{ rows: [row] }], pr_index: {}, review_findings: {}, landing_index: {} };
  const lock = { path: "/tmp/COORD-855.lock", ticket: row.ID };
  const writes = [];
  const transDeps = Object.fromEntries(createTransitions.DEP_CONTRACT.callable.map((name) => [name, () => {}]));
  Object.assign(transDeps, {
    BOARD_RAW_SYMBOL: Symbol.for("test.plan.raw"),
    fail: (message) => { throw new Error(message); },
    readBoard: () => structuredClone(durableBoard),
    getTicketRef: (board, id) => ({ row: board.sections[0].rows.find((candidate) => candidate.ID === id) }),
    findLockForTicket: () => lock,
    ensureDoingTicketLockIntegrity: () => lock,
    ensureTicketMutationOwnership: () => ({}),
    assertTicketMutationOwnership: () => ({}),
    rowsById: (board) => new Map(board.sections[0].rows.map((candidate) => [candidate.ID, candidate])),
    evaluateReadiness: () => ({ blockedBy: [], blockerChains: [], cycles: [] }),
    formatTransitiveBlockerDetails: () => "",
    formatDependencyCycleList: () => "",
    assertReviewPlanReady: () => {},
    assertCommittedReviewState: () => {},
    assertAlreadyLandedNoPrReconcileReady: () => false,
    refsContainMergedPrForTicket: () => false,
    setTicketPrRefs: (board, id, refs) => { board.pr_index[id] = refs; },
    prepareDoneCloseout: (_id, _board, _ref, options) => {
      assert.equal(options.closeoutFromDoing, false, "the re-read REVIEW state has no validated doing lock");
      if (lock) throw new Error("ticket still has a lock file");
    },
    withGovernanceMutation: (_mutation, action) => action(),
    withCoordStateLock: (action) => action(),
    applyTicketStatus: (ref, status) => { ref.row.Status = status; },
    writeBoard: (board) => writes.push(["board", board]),
    runBoardSync: () => writes.push(["sync"]),
    resolveTicketLockPath: () => lock.path,
    toArray: (value) => value == null ? [] : (Array.isArray(value) ? value : [value]),
  });
  const transitions = createTransitions(transDeps);
  const originalRefs = [];
  durableBoard.pr_index[row.ID] = originalRefs;
  const closeout = require("./closeout.js")({
    fail: (message) => { throw new Error(message); },
    STATUS: { DOING: "doing", REVIEW: "review", DONE: "done" },
    readBoard: () => structuredClone(durableBoard),
    getTicketRef: (board, id) => ({ row: board.sections[0].rows.find((candidate) => candidate.ID === id) }),
    resolveLifecyclePrRefs: () => {
      // Simulate a concurrent state transition after finishTicket's outer read
      // but before the governed markDone transaction re-reads the board.
      durableBoard.sections[0].rows[0].Status = "review";
      return ["https://github.com/acme/repo/pull/2"];
    },
    markDone: (id, options) => transitions.markDone(id, options),
    assertWorkspaceDecisionPacket: () => {},
  });

  assert.throws(() => closeout.finishTicket(row.ID, { pr: ["https://github.com/acme/repo/pull/2"] }), /ticket still has a lock file/);
  assert.equal(durableBoard.sections[0].rows[0].Status, "review");
  assert.deepEqual(durableBoard.pr_index[row.ID], originalRefs, "prospective refs were not persisted");
  assert.deepEqual(writes, [], "the refusal wrote no board or sync state");
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
//     -> markDone with prospective refs (ticket-transitions, injected as a deferred wrapper)
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
// residue. All path overrides are restored in `finally` via
// ctx.restore(); we never touch the live board or coord/.runtime.
function setupRepoXReviewReadyFixture(prefix, ticketId, owner, {
  status = "review",
  keepDoingWorkspace = false,
  keepDoingLock = false,
} = {}) {
  const ctx = setupCoord003Workspace(prefix, ticketId, owner);

  // The harness provisions a backend worktree for the ticket; a Repo X ticket
  // must have no governed product-repo residue or ensureRepoXCloseoutReady
  // (rightly) refuses to close it. Remove it.
  if (!keepDoingWorkspace) {
    spawnSync("git", ["-C", ctx.backendRoot, "worktree", "remove", "--force", ctx.worktreePath], { encoding: "utf8" });
    fs.rmSync(ctx.worktreePath, { recursive: true, force: true });
    // COORD-977 made the reuse-lens check fail closed when a doing lock names a worktree
    // that cannot be read. This fixture removed the product worktree but a kept doing lock
    // still named it, so every composed DOING closeout refused on that unreadable path, not
    // on the behavior under test. The lock now names the backend checkout (on dev, so the
    // submission diff is empty); a lock naming a missing worktree still refuses, as intended.
    if (keepDoingLock && fs.existsSync(ctx.lockPath)) {
      const lockPayload = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
      lockPayload.worktree = ctx.backendRoot;
      fs.writeFileSync(ctx.lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, "utf8");
    }
  }

  // Repoint the ticket to Repo X / review with no-PR evidence.
  const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const row = board.sections[0].rows.find((r) => r.ID === ticketId);
  row.Repo = "X";
  row.Status = status;
  board.pr_index = { [ticketId]: ["local-review (no PR)"] };
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

  // Review state needs no doing lock.
  if (!keepDoingLock && fs.existsSync(ctx.lockPath)) {
    fs.unlinkSync(ctx.lockPath);
  }

  // Bind the owner's session to the live effective thread id so the
  // mutation-ownership gate inside markDone resolves to the ticket owner.
  const threadId = sessionOwner.resolveEffectiveThreadId();
  const sessions = JSON.parse(fs.readFileSync(governanceState.AGENT_SESSIONS_PATH, "utf8"));
  sessions[0].thread_id = threadId;
  fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");

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
    verification: "node --test coord/engine/scripts/closeout.test.js",
    verdict: "pass",
    raw: "lens=seam; diff=test; risks=a, b; findings=none; verification=node --test; verdict=pass",
  }));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  // COORD-273: this fixture edits the board (repo/status/pr_index) and plan record
  // out-of-band after the harness anchored its journal baseline. Re-anchor the
  // baseline to the review-ready fixture state so the closeout commands under test
  // run over a consistent journal (intent: exercise the finish/finalize seam, not
  // the out-of-band coordination-state seal).
  __testing.advanceGovernanceProvenanceBaseline("coord066-review-ready-fixture");

  return ctx;
}

test("COORD-066: finishTicket drives a Repo-X ticket review -> done through the transitions<->closeout deferred-wiring seam", () => {
  const ticketId = "ARCH-901";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord066-finish-seam-", ticketId, owner);
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
  const ctx = setupRepoXReviewReadyFixture("coord066-finalize-seam-", ticketId, owner);
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

test("COORD-855: direct markDone without closeout refs preserves existing ref metadata", () => {
  const ticketId = "ARCH-904";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-direct-markdone-no-ref-options-", ticketId, owner);
  try {
    __testing.markDone(ticketId, { owner });
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "done");
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).pr_index[ticketId], ["local-review (no PR)"]);
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const closeouts = events.filter((event) => event.command === "mark-done" && event.ticket === ticketId);
    assert.equal(closeouts.length, 1);
    assert.equal(Object.hasOwn(closeouts[0].details || {}, "closeout_pr_refs"), false,
      "a direct markDone call does not claim that finalize supplied prospective refs");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: markDone missing ticket id refuses before prospective refs or closeout side effects", () => {
  const ticketId = "ARCH-906";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-markdone-missing-id-", ticketId, owner, {
    status: "doing",
    keepDoingLock: true,
  });
  try {
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const lockBefore = fs.readFileSync(ctx.lockPath);
    const governedBefore = coord843GovernanceBytes(ticketId, ctx);

    assert.throws(
      () => __testing.markDone(null, { owner, closeoutFromDoing: true, closeoutPrRefs: ["must not persist"] }),
      /mark-done requires <ticket-id>/
    );

    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "missing ID does not write prospective refs, status, or landing evidence");
    assert.ok(lockBefore.equals(fs.readFileSync(ctx.lockPath)), "missing ID leaves the active ticket lock untouched");
    assertCoord843Unchanged(governedBefore, "markDone with missing ticket ID", ticketId, ctx);
  } finally {
    ctx.restore();
  }
});

test("COORD-855: markDone unknown ticket refuses before prospective refs or closeout side effects", () => {
  const ticketId = "ARCH-907";
  const unknownTicketId = "ARCH-999";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-markdone-unknown-id-", ticketId, owner, {
    status: "doing",
    keepDoingLock: true,
  });
  try {
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const lockBefore = fs.readFileSync(ctx.lockPath);
    const governedBefore = coord843GovernanceBytes(ticketId, ctx);

    assert.throws(
      () => __testing.markDone(unknownTicketId, { owner, closeoutFromDoing: true, closeoutPrRefs: ["must not persist"] }),
      new RegExp(`Unknown ticket \\"${unknownTicketId}\\"`)
    );

    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "unknown ID does not write prospective refs, status, or landing evidence");
    assert.ok(lockBefore.equals(fs.readFileSync(ctx.lockPath)), "unknown ID leaves the active ticket lock untouched");
    assertCoord843Unchanged(governedBefore, "markDone with unknown ticket ID", ticketId, ctx);
  } finally {
    ctx.restore();
  }
});

test("COORD-855: composed DOING no-PR closeout persists refs and DONE once, then removes its lock", () => {
  const ticketId = "ARCH-903";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-doing-nopr-success-", ticketId, owner, {
    status: "doing",
    keepDoingLock: true,
  });
  try {
    assert.ok(fs.existsSync(ctx.lockPath), "the temporary DOING lock exists before closeout");
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    // Lock lookup spreads JSON payload fields over its computed disk path. A
    // valid payload can therefore carry a foreign `path`; closeout must still
    // remove only the actual ticket lock resolved from governed paths.
    const sentinelPath = path.join(ctx.coordRoot, "must-not-delete.txt");
    fs.writeFileSync(sentinelPath, "outside the lock namespace\n");
    const lockPayload = JSON.parse(fs.readFileSync(ctx.lockPath, "utf8"));
    lockPayload.path = sentinelPath;
    fs.writeFileSync(ctx.lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`);
    assert.equal(sessionOwner.isCompleteLockPayload(lockPayload), true, "the actual lock validator permits unrelated payload keys");
    __testing.finalizeTicket(ticketId, { owner, noPr: true });

    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "done");
    const finalBoard = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    assert.deepEqual(finalBoard.pr_index[ticketId], ["local-review (no PR)"], "the full no-PR ref set is persisted");
    assert.equal(fs.existsSync(ctx.lockPath), false, "successful terminal transition releases the doing lock");
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "outside the lock namespace\n", "an untrusted payload path is never unlinked");
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const closeouts = events.filter((event) => event.command === "mark-done" && event.ticket === ticketId);
    assert.equal(closeouts.length, 1, "the composed closeout writes one terminal journal event");
    assert.equal(closeouts[0].result, "succeeded");
    assert.deepEqual(closeouts[0].details?.closeout_pr_refs, ["local-review (no PR)"]);
    assert.equal(events.filter((event) => event.command === "move-review" && event.ticket === ticketId).length, 0,
      "no intermediate review transition is persisted");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: doing markDone without prospective refs refuses without consuming the lock", () => {
  const ticketId = "ARCH-905";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-doing-no-refs-refusal-", ticketId, owner, {
    status: "doing",
    keepDoingLock: true,
  });
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    delete board.pr_index[ticketId];
    __testing.writeBoard(board);
    __testing.advanceGovernanceProvenanceBaseline("coord855-doing-no-refs-refusal");
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const lockBefore = fs.readFileSync(ctx.lockPath);
    const before = coord843GovernanceBytes(ticketId, ctx);

    assert.throws(() => __testing.markDone(ticketId, { owner, closeoutFromDoing: true }), /review but has no pr_index evidence/);
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "doing");
    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "missing prospective refs do not persist a review/done status");
    assert.ok(lockBefore.equals(fs.readFileSync(ctx.lockPath)), "the active doing lock is retained on refusal");
    assertCoord843Unchanged(before, "doing markDone without prospective refs", ticketId, ctx);
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
  withScopedGovernanceTestContext({ REPO_INTEGRATION_BRANCHES: { B: "main", F: "dev" } }, () => {
    // Repo-backed code row on a main-integration repo -> "main".
    assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "B" }, null).closeoutBaseRef, "main");
    assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "B" }).closeoutBaseRef, "main");
    // Repo-backed code row on a dev-integration repo stays "dev" (byte-identical donor behavior).
    assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "F" }, null).closeoutBaseRef, "dev");
    assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "F" }).closeoutBaseRef, "dev");
    // Non-code coordination row (X) keeps "main" regardless of integration branches.
    assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "X" }, null).closeoutBaseRef, "main");
    assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }).closeoutBaseRef, "main");
  });
});

// COORD-706: the join between "the merge returned a sha" and "the record writer
// received it".
//
// This decision was inlined at first and the suite could not see it:
// ensureControlPlaneLandingRecord is imported directly rather than injected, so
// no closeout-level test can observe its arguments, and deleting the join left
// every test green. Extracted so the join itself is pinned.
test("COORD-706: the governed merge's commit is handed to the landing record when the operator supplied none", () => {
  const { resolveControlPlaneCommitOptions } = require("./closeout.js").__testing;
  const MERGE = "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f";
  const out = resolveControlPlaneCommitOptions({ mergeWorkspace: true }, { mergeCommitSha: MERGE });
  assert.equal(out.commitSha, MERGE, "without this the writer finds no commit and records local_only");
  assert.equal(out.mergeWorkspace, true, "the other options must survive");
});

test("COORD-706: --source-commit does not compete with the landing commit — both survive", () => {
  const { resolveControlPlaneCommitOptions } = require("./closeout.js").__testing;
  const MERGE = "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f";
  const REVIEWED_SOURCE = "7082ea7c7082ea7c7082ea7c7082ea7c7082ea7c";
  // The KEY MATTERS. `--source-commit` parses to `sourceCommit` (cli.js:757),
  // never to `commitSha`. The first version of this test supplied `commitSha`
  // directly and "proved" a precedence rule for a key the CLI cannot produce —
  // a test that passed because it tested a fiction.
  const out = resolveControlPlaneCommitOptions({ sourceCommit: REVIEWED_SOURCE }, { mergeCommitSha: MERGE });
  assert.equal(out.commitSha, MERGE, "the landing commit is what the governed merge created");
  assert.equal(out.sourceCommit, REVIEWED_SOURCE, "the reviewed source must not be dropped on the way through");
});

test("COORD-706: an internally supplied landing commit is still not overridden", () => {
  const { resolveControlPlaneCommitOptions } = require("./closeout.js").__testing;
  // No CLI flag produces commitSha today; this guards the internal callers that
  // can, so inference never replaces a commit someone deliberately passed.
  const out = resolveControlPlaneCommitOptions(
    { commitSha: "1111111111111111111111111111111111111111" },
    { mergeCommitSha: "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f" }
  );
  assert.equal(out.commitSha, "1111111111111111111111111111111111111111");
});

test("COORD-706: no governed merge means no inferred commit", () => {
  const { resolveControlPlaneCommitOptions } = require("./closeout.js").__testing;
  assert.equal(resolveControlPlaneCommitOptions({}, null).commitSha, undefined);
  assert.equal(resolveControlPlaneCommitOptions({}, { mergeCommitSha: null }).commitSha, undefined);
  assert.equal(
    resolveControlPlaneCommitOptions({}, { merged: [], mergeCommitSha: null }).commitSha,
    undefined,
    "a record must never gain a commit no step in this closeout produced"
  );
});

test("COORD-809: an observed integration HEAD is eligible only when no workspace merge occurred", () => {
  const { resolveControlPlaneIntegrationCommit } = require("./closeout.js").__testing;
  const existingHead = "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f";
  const freshMerge = "7082ea7c7082ea7c7082ea7c7082ea7c7082ea7c";

  assert.equal(resolveControlPlaneIntegrationCommit(
    { merged: [], mergeCommitSha: null, recoveredMerge: null }, existingHead, existingHead
  ), existingHead, "the current HEAD is a valid candidate after an empty integration plan");
  assert.equal(resolveControlPlaneIntegrationCommit(
    { merged: [{ merge_commit_sha: freshMerge }], mergeCommitSha: freshMerge }, existingHead, "f".repeat(40)
  ), freshMerge, "a real workspace merge retains priority over the observed starting HEAD");
  assert.equal(resolveControlPlaneIntegrationCommit(
    { merged: [], mergeCommitSha: null, recoveredMerge: null }, null, existingHead
  ), null, "an incoming-branch candidate must never become a fallback when its merge was not returned");
  assert.equal(resolveControlPlaneIntegrationCommit(
    { merged: [{ merge_commit_sha: null }], mergeCommitSha: null }, existingHead, existingHead
  ), null, "a missing actual merge OID cannot be replaced by the old HEAD");
  assert.throws(() => resolveControlPlaneIntegrationCommit(
    { merged: [], mergeCommitSha: null, recoveredMerge: null }, existingHead, "f".repeat(40)
  ), /HEAD changed after PR ancestry preflight/);
  assert.throws(() => resolveControlPlaneIntegrationCommit(
    { merged: [], mergeCommitSha: null, recoveredMerge: null }, existingHead, null
  ), /HEAD changed after PR ancestry preflight/, "an unresolvable current HEAD cannot reuse the observed preflight HEAD");
  assert.equal(resolveControlPlaneIntegrationCommit(
    { merged: [], mergeCommitSha: null, recoveredMerge: { mergeCommitSha: freshMerge } }, existingHead, existingHead
  ), null, "a recovery receipt remains authoritative and the no-receipt fallback stays closed");
});

// COORD-834: the two refusal arms of the PR-backed Repo-X closeout, exercised
// through prepareDoneCloseout itself (not the helper) so a closeout that drops
// either guard and proceeds to record a landing fails here.
function makeCoord834PrCloseout(overrides = {}) {
  const createCloseout = require("./closeout.js");
  const ticketId = "COORD-834";
  const prUrl = "https://github.com/acme/control-plane/pull/834";
  const effects = { ghRepoView: 0, integration: 0, writer: 0, cleanup: 0 };
  const closeout = createCloseout({
    fail: (m) => { throw new Error(m); },
    assertReviewPlanReady: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    resolveSourceCommitOrRefuse: () => overrides.sourceCommit || null,
    ghRepoView: () => { effects.ghRepoView += 1; return { nameWithOwner: "acme/control-plane" }; },
    verifyPrEvidence: () => overrides.verifiedPrs || [],
    ensureRepoXCloseoutReady: () => { effects.integration += 1; return overrides.readiness === undefined ? null : overrides.readiness; },
    ensureControlPlaneLandingRecord: () => { effects.writer += 1; return null; },
    cleanupTicketWorktree: () => { effects.cleanup += 1; },
    isRepoBackedCode: (code) => code === "B" || code === "F",
  });
  const board = { pr_index: { [ticketId]: [prUrl] }, review_findings: {}, landing_index: {} };
  const ref = { row: { ID: ticketId, Repo: "X", Status: "review", Owner: "claudea834" } };
  return { closeout, ticketId, prUrl, board, ref, effects };
}

test("COORD-834: PR-backed Repo-X closeout without --merge-workspace refuses before any effect", () => {
  const { closeout, ticketId, board, ref, effects } = makeCoord834PrCloseout();

  for (const mergeWorkspace of [undefined, false, "true"]) {
    assert.throws(
      () => closeout.prepareDoneCloseout(ticketId, board, ref, { mergeWorkspace, base: "dev" }),
      /PR-backed Repo-X closeout requires --merge-workspace so the governed integration commit can be verified/,
      `mergeWorkspace=${String(mergeWorkspace)} must not reach the integration`
    );
  }
  assert.deepEqual(
    effects,
    { ghRepoView: 0, integration: 0, writer: 0, cleanup: 0 },
    "the refusal must precede the repository lookup, the workspace integration and the landing record"
  );
});

test("COORD-834: a PR closeout whose integration returns no verifiable commit is refused before the landing record", () => {
  const os = require("node:os");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coord834-pr-closeout-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "COORD-834 fixture",
    GIT_AUTHOR_EMAIL: "coord834@example.invalid",
    GIT_COMMITTER_NAME: "COORD-834 fixture",
    GIT_COMMITTER_EMAIL: "coord834@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return String(result.stdout || "").trim();
  };
  try {
    git("init", "-q", "-b", "dev");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const branch = "agent/claudea834-coord-834-reviewed-change";
    git("checkout", "-q", "-b", branch);
    git("commit", "-q", "--allow-empty", "-m", "reviewed source");
    const source = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "PR head");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "dev");
    git("merge", "-q", "--no-ff", "-m", "GitHub merge", branch);
    const githubMerge = git("rev-parse", "HEAD");

    const prUrl = "https://github.com/acme/control-plane/pull/834";
    const verifiedPrs = [{
      ref: prUrl,
      payload: {
        number: 834, url: prUrl, state: "MERGED", mergedAt: "2026-10-17T00:00:00Z",
        headRefName: branch, headRefOid: head, baseRefName: "dev", mergeCommit: { oid: githubMerge },
      },
    }];
    // Each readiness result names no merge commit and offers no preflighted
    // HEAD (the stub never runs the planned-integration validator), so there
    // is nothing the closeout may record as the integration commit.
    const readinessResults = [
      null,
      { merged: [{ branch, merge_commit_sha: null }], mergeCommitSha: null, recoveredMerge: null },
      { merged: [], mergeCommitSha: null, recoveredMerge: null },
    ];
    for (const readiness of readinessResults) {
      const { closeout, ticketId, board, ref, effects } = makeCoord834PrCloseout({ sourceCommit: source, verifiedPrs, readiness });
      assert.throws(
        () => closeout.prepareDoneCloseout(ticketId, board, ref, {
          mergeWorkspace: true, base: "dev", layout: { coordRepoRoot: repo },
        }),
        /PR closeout did not produce or preflight a verified control-plane integration commit/,
        `readiness ${JSON.stringify(readiness)} must not yield a recordable integration commit`
      );
      assert.equal(effects.ghRepoView, 1, "the PR evidence was verified against the repository identity");
      assert.equal(effects.integration, 1, "the refusal is the post-integration check, not an earlier one");
      assert.equal(effects.writer, 0, "no landing record may be written without a verified integration commit");
      assert.equal(effects.cleanup, 0, "the worktree must survive a refused closeout");
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("COORD-706: the closeout CALL SITE actually hands the resolved commit to the record writer", () => {
  const createCloseout = require("./closeout.js");
  const MERGE_SHA = "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f";
  const seen = [];
  const board = { pr_index: { "COORD-706": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const ref = { row: { Repo: "X", Status: "review", Owner: "claudea674" } };
  const closeout = createCloseout({
    fail: (m) => { throw new Error(m); },
    assertReviewPlanReady: () => {},
    verifyPrEvidence: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    ensureRepoXCloseoutReady: () => ({ merged: [{ merge_commit_sha: MERGE_SHA }], mergeCommitSha: MERGE_SHA }),
    ensureControlPlaneLandingRecord: (ticketId, b, row, options) => { seen.push(options); return null; },
    cleanupTicketWorktree: () => {},
    isRepoBackedCode: (code) => code === "B" || code === "F",
  });

  closeout.prepareDoneCloseout("COORD-706", board, ref, { mergeWorkspace: true });

  assert.equal(seen.length, 1, "the control-plane record writer must have been called");
  assert.equal(
    seen[0].commitSha,
    MERGE_SHA,
    "the resolved commit must reach the writer — pinning the helper alone does not pin the join"
  );
});

// COORD-706 round 2: the CLI parser -> closeout -> persisted record path.
//
// Round 1's defect was that a helper arbitrated over `commitSha` while the flag
// produces `sourceCommit`, and the unit test supplied the key the parser cannot
// emit. Pinning the parser's ACTUAL output is what stops that recurring.
test("COORD-706: --source-commit parses to sourceCommit and survives the closeout options untouched", () => {
  const { parseFlags } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/cli.js")).__testing;
  const parsed = parseFlags(["--source-commit", "7082ea7c", "--merge-workspace"]);
  // The key the parser really produces. If this ever becomes `commitSha`, the
  // round-1 defect is back and this test says so.
  assert.equal(parsed.sourceCommit, "7082ea7c", "the flag must parse to sourceCommit, not commitSha");
  assert.equal(parsed.commitSha, undefined, "no CLI flag sets the LANDING commit");
  assert.equal(parsed.mergeWorkspace, true);

  const { resolveControlPlaneCommitOptions } = require("./closeout.js").__testing;
  const out = resolveControlPlaneCommitOptions(parsed, { mergeCommitSha: "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f" });
  assert.equal(out.sourceCommit, "7082ea7c", "the reviewed source must reach the writer");
  assert.equal(out.commitSha, "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f", "the landing commit is the governed merge's");
});

// COORD-706 round 3: ORDER, proven on the production path.
//
// The reviewed source used to be validated inside the landing-record writer,
// which runs AFTER the in-process integration and after the pre-closeout push
// the writer performs. A production-order probe returned
// ["workspace-merge", "source-validation"] — an invalid source still left a
// real irreversible act behind. Outcome tests could not see this: the record
// was never written either way, so both orders looked identical at the end.
// These assert the SEQUENCE, and the invalid case asserts the irreversible
// collaborators were never reached at all.

function buildOrderProbeCloseout({ sourceValid, order }) {
  const createCloseout = require("./closeout.js");
  const MERGE_SHA = "8abccf8f8abccf8f8abccf8f8abccf8f8abccf8f";
  const seen = [];
  const closeout = createCloseout({
    fail: (m) => { throw new Error(m); },
    assertReviewPlanReady: () => {},
    verifyPrEvidence: () => {},
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    resolveSourceCommitOrRefuse: (ticketId, options) => {
      order.push("source-validation");
      if (!sourceValid) {
        throw new Error(`Ticket ${ticketId} names source commit "${options.sourceCommit}", which does not resolve`);
      }
      return `resolved:${options.sourceCommit}`;
    },
    ensureRepoXCloseoutReady: () => {
      order.push("workspace-integration");
      return { merged: [{ merge_commit_sha: MERGE_SHA }], mergeCommitSha: MERGE_SHA };
    },
    ensureControlPlaneLandingRecord: (ticketId, b, row, options) => {
      order.push("record-write");
      seen.push(options);
      return null;
    },
    cleanupTicketWorktree: () => {},
    isRepoBackedCode: (code) => code === "B" || code === "F",
  });
  return { closeout, seen, MERGE_SHA };
}

test("COORD-706: an INVALID --source-commit refuses before any irreversible collaborator runs", () => {
  const { parseFlags } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/cli.js")).__testing;
  const parsed = parseFlags(["--source-commit", "f".repeat(40), "--merge-workspace"]);
  const order = [];
  const { closeout } = buildOrderProbeCloseout({ sourceValid: false, order });
  const board = { pr_index: { "COORD-706": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const ref = { row: { Repo: "X", Status: "review", Owner: "claudea674" } };

  assert.throws(() => closeout.prepareDoneCloseout("COORD-706", board, ref, parsed), /does not resolve/);

  assert.deepEqual(
    order,
    ["source-validation"],
    "validation must run FIRST and alone — the integration and the record write must never be reached"
  );
});

test("COORD-706: a VALID parser-produced source is validated first, then reaches the persisted record", () => {
  const { parseFlags } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/cli.js")).__testing;
  const parsed = parseFlags(["--source-commit", "7082ea7c", "--merge-workspace"]);
  const order = [];
  const { closeout, seen, MERGE_SHA } = buildOrderProbeCloseout({ sourceValid: true, order });
  const board = { pr_index: { "COORD-706": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const ref = { row: { Repo: "X", Status: "review", Owner: "claudea674" } };

  closeout.prepareDoneCloseout("COORD-706", board, ref, parsed);

  assert.deepEqual(
    order,
    ["source-validation", "workspace-integration", "record-write"],
    "validation precedes every irreversible step"
  );
  assert.equal(seen.length, 1);
  // The NORMALIZED value the preflight returned — not the raw operator string —
  // is what reaches the writer, so the record states what was actually checked.
  assert.equal(seen[0].sourceCommit, "resolved:7082ea7c");
  assert.equal(seen[0].commitSha, MERGE_SHA, "the landing commit is still the governed integration's");
});

// COORD-703: `land` must not merge before its fallible checks pass.
//
// Measured on CONS-025: gov land squash-merged PR #12, then failed provenance
// validation and rolled the governed files back — leaving a merged PR with no
// board record until an operator noticed and retried. The engine reported the
// external effect honestly and offered a recovery, but idempotent recovery is a
// second line of defence, not a substitute for not creating the state.
//
// These assert the ORDER on the production path with collaborator spies. An
// outcome assertion cannot see this defect: on the failing path no landing
// record is written under either order, so both look identical at the end.

function buildLandOrderProbe({ order, failing = null, lock = null, sourceResolves = true, unresolvableToken = null, useDefaultCommitResolver = false, overrides = {} }) {
  const createCloseout = require("./closeout.js");
  return createCloseout({
    fail: (m) => { throw new Error(m); },
    readBoard: () => ({
      pr_index: { "COORD-703": ["https://github.com/x/y/pull/12"] },
      review_findings: {},
      landing_index: {},
      sections: [{ kind: "table", rows: [{ ID: "COORD-703", Repo: "B", Status: "review", Owner: "claudea674" }] }],
    }),
    getTicketRef: (board) => ({ row: board.sections[0].rows[0] }),
    inferTicketStatus: () => "review",
    withGovernanceMutation: (mutation, fn) => fn(),
    ensureTicketMutationOwnership: () => ({}),
    resolvePrUrlForTicket: () => "https://github.com/x/y/pull/12",
    assertReviewPlanReady: () => {
      order.push("validate:review-plan");
      if (failing === "review-plan") throw new Error("Ticket COORD-703 has an incomplete self-review cycle (1/3).");
    },
    // MERGE-DEPENDENT by construction: it asserts the PR *is* merged, which can
    // only be true after the act. Named "verify:" so the assertion below can
    // distinguish "ran late because it must" from "ran late because it was left
    // behind".
    verifyPrEvidence: () => { order.push("verify:merged-pr"); },
    findOutstandingCloseoutBlockerFollowups: () => { order.push("validate:followups"); return []; },
    findLockForTicket: () => { order.push("validate:lock"); return lock; },
    ...(!useDefaultCommitResolver ? {
      resolveCommitishInRepo: (repoRoot, commitish) => {
        order.push("validate:provenance");
        if (!sourceResolves) return null;
        if (unresolvableToken && String(commitish) === unresolvableToken) return null;
        return `resolved-${commitish}`;
      },
    } : {}),
    getRepoRoot: () => "/repo/backend",
    prMerge: () => { order.push("ACT:pr-merge"); return { status: "merged" }; },
    refreshLandingBaseRef: () => {},
    // ROUND 2 REVIEW: this stub returned NULL, which aborts landTicket right
    // after the merge (closeout.js: "Landing evidence ... could not be
    // recorded"). The order assertion therefore never reached
    // prepareDoneCloseout and passed while the duplicate post-merge checks were
    // still there. A stub whose return value cuts the path short makes an
    // ordering test assert nothing about the rest of it.
    persistMergedPrLandingSnapshot: (t, row, url, opts) => {
      order.push(`record:landing-snapshot(source=${opts.sourceCommit || "none"})`);
      return { recorded_at: "2026-08-29T00:00:00.000Z", evidence: ["landed"], commit_sha: "abc1234" };
    },
    assertLandingIntegrity: () => { order.push("verify:landing-integrity"); },
    ensureLandingRecord: () => ({ recorded_at: "2026-08-29T00:00:00.000Z", evidence: ["landed"] }),
    ensureTestingInfrastructureLandingAudit: () => { order.push("verify:testing-audit"); },
    ensureFeatureProofLandingAudit: () => { order.push("verify:feature-proof"); },
    setPrRefs: () => {},
    markDone: () => {},
    applyMarkDone: () => {},
    moveReview: () => {},
    buildQuestionRow: () => "",
    buildLandCloseoutAnswer: () => "",
    appendQuestionRowText: () => {},
    resolveSourceCommitSha: (t, row, opts) => {
      order.push("validate:provenance-implicit");
      return opts.sourceCommit ? `resolved-${opts.sourceCommit}` : "resolved-implicit-head";
    },
    withCoordStateLock: (fn) => fn(),
    writeBoard: () => {},
    updateCanonicalPlanState: () => {},
    isRepoBackedCode: (code) => code === "B" || code === "F",
    cleanupTicketWorktree: () => {},
    ...overrides,
  });
}

test("COORD-809: manual landing evidence resolves against the actual repo before merge", (t) => {
  const repoRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord809-default-resolver-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 resolver fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 resolver fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "fixture\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "-q", "-m", "resolver fixture"]);
  const validCommit = git(["rev-parse", "HEAD"]);
  const order = [];
  const mergeFailure = new Error("stop after successful preflight");
  const closeout = buildLandOrderProbe({
    order,
    useDefaultCommitResolver: true,
    overrides: {
      getRepoRoot: () => repoRoot,
      prMerge: () => { order.push("ACT:pr-merge"); throw mergeFailure; },
    },
  });

  assert.throws(() => closeout.landTicket("COORD-703", { landed: `manual evidence at ${validCommit}` }), (error) => error === mergeFailure);
  assert.ok(order.indexOf("ACT:pr-merge") > order.indexOf("validate:review-plan"), "the real resolver accepted the existing commit before the merge collaborator");
  assert.throws(() => closeout.landTicket("COORD-703", { sourceCommit: validCommit }), (error) => error === mergeFailure);
  assert.throws(() => closeout.landTicket("COORD-703", { sourceCommit: "f".repeat(40) }), /source commit .* does not resolve.*Refusing before the merge/);


  const refusedOrder = [];
  const refused = buildLandOrderProbe({
    order: refusedOrder,
    useDefaultCommitResolver: true,
    overrides: {
      getRepoRoot: () => repoRoot,
      prMerge: () => { refusedOrder.push("ACT:pr-merge"); throw new Error("must not merge an unresolved commit"); },
    },
  });
  assert.throws(
    () => refused.landTicket("COORD-703", { landed: "manual evidence at deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    /no resolvable commit SHA/,
  );
  assert.ok(!refusedOrder.includes("ACT:pr-merge"), "an unresolved commit must refuse before the merge");

  const missingRepoOrder = [];
  const missingRepo = buildLandOrderProbe({
    order: missingRepoOrder,
    useDefaultCommitResolver: true,
    overrides: {
      getRepoRoot: () => null,
      prMerge: () => { missingRepoOrder.push("ACT:pr-merge"); throw new Error("must not merge without a repository"); },
    },
  });
  assert.throws(
    () => missingRepo.landTicket("COORD-703", { landed: `manual evidence at ${validCommit}` }),
    /no resolvable commit SHA/,
  );
  assert.ok(!missingRepoOrder.includes("ACT:pr-merge"), "missing repository context must refuse before the merge");
});

function landAndCapture(closeout, options = {}) {
  try {
    closeout.landTicket("COORD-703", options);
    return null;
  } catch (error) {
    return String(error.message || error);
  }
}

// ROUND 1 REVIEW: the previous version of this test asserted only that ONE
// validation preceded the merge, so a preflight that ran a SUBSET passed it. The
// reviewer's probe with a lingering lock produced
// validate:review-plan / ACT:pr-merge / record / validate:merged-pr /
// validate:lock / ERROR — merge, then refuse. These assert that EVERY validation
// precedes the act, and each failure mode is exercised on the production path.

test("COORD-703: EVERY validation precedes the merge, not merely the first", () => {
  const order = [];
  landAndCapture(buildLandOrderProbe({ order }), { landed: "landed as abc1234 on dev" });
  const mergeAt = order.indexOf("ACT:pr-merge");
  assert.notEqual(mergeAt, -1, `the merge should have been reached — ${JSON.stringify(order)}`);
  // Nothing PREFLIGHT-ELIGIBLE may run after the act. Steps named "verify:" are
  // merge-DEPENDENT by construction — the merged-PR assertion and the landing
  // audits can only be true once the merge exists — and are expected late.
  const lateValidations = order
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => step.startsWith("validate:") && index > mergeAt);
  assert.deepEqual(
    lateValidations.map(({ step }) => step),
    [],
    `no preflight-eligible validation may run after the irreversible act — ${JSON.stringify(order)}`
  );
  // ...and the closeout really did continue past the merge, or the assertion
  // above would be vacuous — which is exactly how the previous version passed.
  assert.ok(
    order.includes("verify:landing-integrity") && order.includes("verify:feature-proof"),
    `the probe must complete the whole closeout path — ${JSON.stringify(order)}`
  );
  // The implicit source was resolved BEFORE the act and threaded to the writer.
  assert.ok(order.indexOf("validate:provenance-implicit") < mergeAt, JSON.stringify(order));
  assert.ok(
    order.includes("record:landing-snapshot(source=resolved-implicit-head)"),
    `the writer must receive the pre-resolved implicit source — ${JSON.stringify(order)}`
  );
  // And the set is not empty, or the assertion above would be vacuous.
  assert.ok(order.filter((s) => s.startsWith("validate:")).length >= 4, JSON.stringify(order));

  const noImplicitSource = [];
  const captured = new Error("stop after observing absent landing source");
  const withoutSource = buildLandOrderProbe({
    order: noImplicitSource,
    overrides: {
      resolveSourceCommitSha: () => { noImplicitSource.push("validate:provenance-implicit"); return undefined; },
      persistMergedPrLandingSnapshot: (_ticket, _row, _url, options) => {
        assert.equal(options.sourceCommit, undefined);
        throw captured;
      },
    },
  });
  assert.throws(() => withoutSource.landTicket("COORD-703", { landed: "landed as abc1234 on dev" }),
    (error) => error === captured);
  assert.ok(noImplicitSource.indexOf("validate:provenance-implicit") < noImplicitSource.indexOf("ACT:pr-merge"));
});

test("COORD-703 RED: a lingering LOCK refuses before the merge", () => {
  const order = [];
  const message = landAndCapture(
    buildLandOrderProbe({ order, lock: { path: "/repo/coord/.runtime/locks/COORD-703.lock" } }),
    { landed: "landed as abc1234 on dev" }
  );
  assert.match(String(message), /still has a lock file/);
  assert.ok(!order.includes("ACT:pr-merge"), `merge must not be reached — ${JSON.stringify(order)}`);
});

test("COORD-703 RED: the literal CONS-025 case — manual evidence with no resolvable commit", () => {
  const order = [];
  const message = landAndCapture(
    buildLandOrderProbe({ order, sourceResolves: false }),
    { landed: "merged and closed via the governed path, no sha recorded" }
  );
  assert.match(String(message), /no resolvable commit SHA/);
  assert.ok(
    !order.includes("ACT:pr-merge"),
    `CONS-025 squash-merged PR #12 and THEN failed this check — ${JSON.stringify(order)}`
  );
});

test("COORD-703 RED: an unresolvable --source-commit refuses before the merge", () => {
  const order = [];
  const message = landAndCapture(
    buildLandOrderProbe({ order, unresolvableToken: "f".repeat(40) }),
    { sourceCommit: "f".repeat(40), landed: "landed as abc1234 on dev" }
  );
  assert.match(String(message), /does not resolve/);
  assert.ok(!order.includes("ACT:pr-merge"), `merge must not be reached — ${JSON.stringify(order)}`);
});

test("COORD-703: the pre-resolved source is threaded to the writer, not resolved again after merging", () => {
  const order = [];
  landAndCapture(
    buildLandOrderProbe({ order }),
    { sourceCommit: "a273fc89", landed: "landed as abc1234 on dev" }
  );
  const record = order.find((step) => step.startsWith("record:landing-snapshot"));
  assert.equal(
    record,
    "record:landing-snapshot(source=resolved-a273fc89)",
    `the writer must receive the value resolved BEFORE the merge — ${JSON.stringify(order)}`
  );
});

test("COORD-703 RED: a failing closeout precondition means the PR merge is never attempted", () => {
  const order = [];
  const message = landAndCapture(
    buildLandOrderProbe({ order, failing: "review-plan" }),
    { landed: "landed as abc1234 on dev" }
  );
  assert.match(String(message), /incomplete self-review cycle/);
  assert.ok(!order.includes("ACT:pr-merge"), `merge must not be reached — ${JSON.stringify(order)}`);
  assert.equal(order[0], "validate:review-plan", "validation must come first, not merely eventually");
});


test("COORD-803: public finalize dispatcher records dev ancestry without advancing main", () => {
  const ticket = "ARCH-903", owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord803-public-finalize-", ticket, owner);
  const layoutModule = require("./control-plane-paths.js");
  const { __testing: layoutTesting } = layoutModule;
  const boardPaths = require("../../board/board.js").__testing.paths;
  const boardKeys = ["BOARD_PATH", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "PLAN_RECORDS_DIR", "LEGACY_PLAN_RECORDS_DIR"];
  const originalBoardPaths = Object.fromEntries(boardKeys.map(key => [key, boardPaths[key]]));
  for (const key of boardKeys) boardPaths[key] = governanceState[key];
  const fixtureBoard = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  fixtureBoard.prompt_index[ticket] = path.relative(path.resolve(__dirname, "../../.."), path.join(ctx.coordRoot, "prompts", `${ticket}.md`));
  fs.writeFileSync(ctx.boardPath, `${JSON.stringify(fixtureBoard, null, 2)}\n`);
  __testing.advanceGovernanceProvenanceBaseline("coord803-public-fixture");
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    git(ctx.coordRoot, "init", "-b", "main");
    git(ctx.coordRoot, "config", "user.name", "Branch contract fixture");
    git(ctx.coordRoot, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(ctx.coordRoot, "branch-evidence.txt"), "main baseline\n");
    git(ctx.coordRoot, "add", "branch-evidence.txt");
    git(ctx.coordRoot, "commit", "-m", "main fixture baseline");
    const remote = path.join(ctx.coordRoot, "origin.git");
    git(ctx.coordRoot, "init", "--bare", "-b", "main", remote);
    git(ctx.coordRoot, "remote", "add", "origin", remote);
    git(ctx.coordRoot, "push", "origin", "main");
    git(ctx.coordRoot, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const main = git(remote, "rev-parse", "refs/heads/main");
    git(ctx.coordRoot, "checkout", "-b", "dev");
    fs.appendFileSync(path.join(ctx.coordRoot, "branch-evidence.txt"), "dev implementation\n");
    git(ctx.coordRoot, "commit", "-am", "dev fixture implementation");
    const source = git(ctx.coordRoot, "rev-parse", "HEAD");
    git(ctx.coordRoot, "push", "origin", "dev");
    layoutTesting.override(layoutModule.resolveControlPlaneLayout({ coordDir: ctx.coordRoot, workspaceRoot: path.dirname(ctx.coordRoot) }));
    const result = executeCommand(["finalize", ticket, "--no-pr", "--base", "dev", "--fulfilled-by-commit", source, "--source-commit", source]);
    assert.equal(result.ok, true, JSON.stringify(result));
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.equal(board.landing_index[ticket].base_ref, "dev");
    const persistedPlan = JSON.parse(fs.readFileSync(path.join(ctx.planRecordsDir, `${ticket}.json`), "utf8"));
    assert.equal(persistedPlan.governance.expected_closeout.base_ref, "dev");
    assert.equal(board.landing_index[ticket].commit_sha, source);
    assert.equal(board.landing_index[ticket].source_commit_sha, source);
    assert.equal(board.landing_index[ticket].control_plane_verification, "remote_ancestry");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), main);
    assert.equal(git(ctx.coordRoot, "rev-parse", "refs/heads/main"), main);
  } finally {
    layoutTesting.reset();
    for (const key of boardKeys) boardPaths[key] = originalBoardPaths[key];
    ctx.restore();
  }
});

function withCoord809PublicPrFixture(run, { doing = false } = {}) {
  const ticket = "COORD-809", owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord809-public-pr-finalize-", ticket, owner, {
    status: doing ? "doing" : "review",
    keepDoingWorkspace: doing,
    keepDoingLock: doing,
  });
  const landingGh = require("./landing-gh.js");
  const layoutModule = require("./control-plane-paths.js");
  const layoutTesting = layoutModule.__testing;
  const boardPaths = require("../../board/board.js").__testing.paths;
  const boardKeys = ["BOARD_PATH", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "PLAN_RECORDS_DIR", "LEGACY_PLAN_RECORDS_DIR"];
  const originalBoardPaths = Object.fromEntries(boardKeys.map(key => [key, boardPaths[key]]));
  for (const key of boardKeys) boardPaths[key] = governanceState[key];
  const prUrl = "https://github.com/Softsensor-org/coord-template/pull/809";
  const runGit = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return String(result.stdout || "").trim();
  };
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.pr_index[ticket] = [prUrl];
    board.prompt_index[ticket] = path.relative(
      path.resolve(__dirname, "../../.."),
      path.join(ctx.coordRoot, "prompts", `${ticket}.md`)
    );
    // Match the normalized canonical board shape before refusal snapshots.
    // The first lifecycle write may materialize this empty index otherwise.
    board.waiver_index ||= {};
    __testing.writeBoard(board);

    runGit(ctx.coordRoot, "init", "-b", "dev");
    runGit(ctx.coordRoot, "config", "user.name", "COORD-809 fixture");
    runGit(ctx.coordRoot, "config", "user.email", "coord809@example.invalid");
    fs.mkdirSync(path.join(ctx.coordRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ctx.coordRoot, "docs", "reviewed-source.txt"), "line one\nline two\nline three\nline four\n");
    runGit(ctx.coordRoot, "add", "-A");
    runGit(ctx.coordRoot, "commit", "-m", "fixture canonical baseline");
    const base = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    const remote = path.join(ctx.coordRoot, "origin.git");
    runGit(ctx.coordRoot, "init", "--bare", "-b", "dev", remote);
    runGit(ctx.coordRoot, "remote", "add", "origin", remote);
    runGit(ctx.coordRoot, "push", "origin", "dev");
    runGit(ctx.coordRoot, "fetch", "origin", "dev");

    const feature = path.join(ctx.coordRoot, ".worktrees", owner, ticket);
    const branch = `agent/${owner}-${ticket.toLowerCase()}-reviewed-change`;
    fs.mkdirSync(path.dirname(feature), { recursive: true });
    runGit(ctx.coordRoot, "worktree", "add", "-b", branch, feature, "dev");
    fs.mkdirSync(path.join(feature, "docs"), { recursive: true });
    fs.writeFileSync(path.join(feature, "docs", "reviewed-source.txt"), "reviewed line one\nline two\nline three\nline four\n");
    runGit(feature, "add", "docs/reviewed-source.txt");
    runGit(feature, "commit", "-m", "reviewed source");
    const source = runGit(feature, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(feature, "docs", "pr-head-update.txt"), "PR head update\n");
    runGit(feature, "add", "docs/pr-head-update.txt");
    runGit(feature, "commit", "-m", "PR head update");
    const head = runGit(feature, "rev-parse", "HEAD");
    const tree = runGit(feature, "rev-parse", `${head}^{tree}`);
    // Model a real squash landing: the GitHub merge commit has the base as its
    // parent and uses the reviewed PR head's tree, so neither source nor head
    // needs to be an ancestor of the squash commit.
    const mergeCommit = spawnSync("git", ["-C", feature, "commit-tree", tree, "-p", base, "-m", "fixture GitHub squash merge"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);
    const githubMerge = mergeCommit.stdout.trim();
    runGit(feature, "reset", "--hard", githubMerge);
    runGit(ctx.coordRoot, "push", "origin", `${githubMerge}:refs/heads/dev`);
    const unrelatedTree = runGit(ctx.coordRoot, "rev-parse", `${base}^{tree}`);
    const unrelatedMergeResult = spawnSync("git", ["-C", ctx.coordRoot, "commit-tree", unrelatedTree, "-p", base, "-m", "unrelated valid merge OID"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(unrelatedMergeResult.status, 0, unrelatedMergeResult.stderr);
    const unrelatedMerge = unrelatedMergeResult.stdout.trim();

    const payload = {
      number: 809,
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-10-06T14:00:00Z",
      headRefName: branch,
      headRefOid: head,
      baseRefName: "dev",
      mergeCommit: { oid: githubMerge },
    };
    const active = { payload, repository: "Softsensor-org/coord-template" };
    landingGh.setRunGhForTesting((_cwd, args) => {
      if (args[0] === "repo" && args[1] === "view") {
        return JSON.stringify({ nameWithOwner: active.repository });
      }
      if (args[0] === "pr" && args[1] === "view") {
        const requestedUrl = args.find((value) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(String(value)));
        return JSON.stringify(active.payloadByUrl?.[requestedUrl] || active.payload);
      }
      assert.fail(`unexpected GitHub query: ${args.join(" ")}`);
    });
    layoutTesting.override(layoutModule.resolveControlPlaneLayout({
      coordDir: ctx.coordRoot,
      workspaceRoot: path.dirname(ctx.coordRoot),
    }));
    __testing.advanceGovernanceProvenanceBaseline("coord809-pr-review-fixture");

    const unrelatedSourceTree = runGit(ctx.coordRoot, "rev-parse", `${base}^{tree}`);
    const unrelatedResult = spawnSync("git", ["-C", ctx.coordRoot, "commit-tree", unrelatedSourceTree, "-p", base, "-m", "unrelated reviewed source"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(unrelatedResult.status, 0, unrelatedResult.stderr);
    const unrelatedSource = unrelatedResult.stdout.trim();
    const argsFor = (sourceSha = source) => [
      "finalize", ticket,
      "--pr", prUrl,
      ...(sourceSha ? ["--source-commit", sourceSha] : []),
      "--merge-workspace", "--push-before-closeout", "--base", "dev",
    ];
    const attempt = (args) => {
      try { return executeCommand(args); }
      catch (error) { return { ok: false, error: error.message }; }
    };
    return run({ ticket, ctx, layoutModule, prUrl, runGit, remote, source, head, githubMerge, unrelatedMerge, base,
      unrelatedSource, payload, active, argsFor, attempt });
  } finally {
    landingGh.resetRunGhForTesting();
    layoutTesting.reset();
    for (const key of boardKeys) boardPaths[key] = originalBoardPaths[key];
    ctx.restore();
  }
}

test("COORD-809: prepareDoneCloseout refuses missing or malformed PR index before integration", () => {
  const createCloseout = require("./closeout.js");
  const effects = { verify: 0, integration: 0, writer: 0 };
  const closeout = createCloseout({
    verifyPrEvidence: () => { effects.verify += 1; return []; },
    ensureRepoXCloseoutReady: () => { effects.integration += 1; return null; },
    ensureControlPlaneLandingRecord: () => { effects.writer += 1; return null; },
  });
  const ref = { row: { ID: "COORD-809", Repo: "X", Status: "review", Owner: "codexa755" } };
  const malformedIndexes = [
    { name: "missing", board: { review_findings: {}, landing_index: {} } },
    { name: "non-array", board: { pr_index: { "COORD-809": "https://github.com/acme/widget/pull/145" } } },
    { name: "empty", board: { pr_index: { "COORD-809": [] } } },
  ];

  for (const { name, board } of malformedIndexes) {
    assert.throws(
      () => closeout.prepareDoneCloseout(
        "COORD-809", board, ref, { mergeWorkspace: true }, { preflighted: true }
      ),
      /is review but has no pr_index evidence/,
      `${name} PR index must fail closed`
    );
  }

  assert.deepEqual(effects, { verify: 0, integration: 0, writer: 0 });
});

test("COORD-809: public PR-backed finalize refuses invalid evidence without effects", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, runGit, remote, unrelatedSource, unrelatedMerge, payload, active, argsFor, attempt }) => {
    const invalidCases = [
      ["missing reviewed source", () => { active.payload = payload; return argsFor(null); }],
      ["unmerged PR", () => { active.payload = { ...payload, state: "OPEN", mergedAt: null }; return argsFor(); }],
      ["wrong PR repository", () => { active.payload = { ...payload, url: "https://github.com/other/repository/pull/809" }; return argsFor(); }],
      ["wrong configured repository", () => { active.payload = payload; active.repository = "other/repository"; return argsFor(); }],
      ["wrong selected base", () => { active.payload = { ...payload, baseRefName: "main" }; return argsFor(); }],
      ["unaffiliated PR head", () => { active.payload = { ...payload, headRefName: "agent/COORD-1809-unrelated" }; return argsFor(); }],
      // COORD-1013: COORD-809 named only inside another ticket's governed slug is not this ticket's PR.
      ["PR head names COORD-809 only in another ticket's slug", () => { active.payload = { ...payload, headRefName: "agent/h2-coord-1012-found-by-the-coord-809-y" }; return argsFor(); }],
      ["unrelated reviewed source", () => { active.payload = payload; return argsFor(unrelatedSource); }],
      ["unrelated but resolvable GitHub merge OID", () => { active.payload = { ...payload, mergeCommit: { oid: unrelatedMerge } }; return argsFor(); }],
    ];
    for (const [label, prepare] of invalidCases) {
      active.repository = "Softsensor-org/coord-template";
      const boardBefore = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
      const localHeadBefore = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
      const remoteHeadBefore = runGit(remote, "rev-parse", "refs/heads/dev");
      const result = attempt(prepare());
      assert.equal(result.ok, false, `${label} must refuse: ${JSON.stringify(result)}`);
      assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review", `${label} cannot mark done`);
      assert.deepEqual(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")), boardBefore, `${label} cannot change board state`);
      assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localHeadBefore, `${label} cannot integrate workspace changes`);
      assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteHeadBefore, `${label} cannot publish remote changes`);
      assert.equal(boardBefore.landing_index[ticket], undefined, `${label} cannot write landing evidence`);
    }
  });
});

test("COORD-809: public PR-backed finalize records distinct reviewed, GitHub-merge, and governed-integration commits", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, layoutModule, prUrl, runGit, remote, source, head, githubMerge, base, payload, attempt }) => {
    for (const commit of [source, head]) {
      const squashAncestry = spawnSync("git", ["-C", ctx.coordRoot, "merge-base", "--is-ancestor", commit, githubMerge], { encoding: "utf8" });
      assert.equal(squashAncestry.status, 1, `squash merge must not require ${commit} to be its ancestor`);
    }
    const finalizeArgs = [
      "finalize", ticket,
      "--pr", prUrl,
      "--source-commit", source,
      "--merge-workspace",
      "--push-before-closeout",
      "--push-after-sync",
      "--base", "dev",
    ];
    const result = executeCommand(finalizeArgs);
    assert.equal(result.ok, true, JSON.stringify(result));
    const persisted = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    const landing = persisted.landing_index[ticket];
    assert.ok(landing, "successful PR-backed finalize must persist landing provenance");
    assert.equal(landing && landing.method, "pr", "successful PR-backed closeout must persist a structured PR landing rather than omit or misclassify it");
    assert.equal(landing.source_commit_sha, source);
    assert.equal(landing.pr_evidence.head_sha, head);
    assert.equal(landing.pr_evidence.merge_sha, githubMerge);
    assert.equal(landing.pr_evidence.url, prUrl.toLowerCase());
    assert.equal(landing.pr_evidence.base_ref, "dev");
    assert.equal(landing.control_plane_verification, "remote_ancestry");
    assert.notEqual(source, head);
    assert.notEqual(head, githubMerge);
    assert.notEqual(githubMerge, landing.commit_sha);
    const remoteHead = runGit(remote, "rev-parse", "refs/heads/dev");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", landing.commit_sha, remoteHead), "");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", githubMerge, landing.commit_sha), "");
    const errors = [];
    const boardTesting = require("../../board/board.js").__testing;
    boardTesting.validateSchema(require("../../board/tasks.schema.json"), persisted, "tasks.json", errors);
    assert.deepEqual(errors, []);

    const evidenceHelper = require("./control-plane-pr-evidence.js");
    const replayProof = evidenceHelper.verifyControlPlanePrEvidence({
      ticketId: ticket,
      refs: [prUrl],
      verifiedPrs: [{ ref: prUrl, payload }],
      expectedRepository: "Softsensor-org/coord-template",
      selectedBaseRef: "dev",
      sourceCommitSha: source,
      repoRoot: ctx.coordRoot,
    });
    const originalRecordedAt = landing.recorded_at;
    const originalRemoteHead = runGit(remote, "rev-parse", "refs/heads/dev");
    const writer = require("./control-plane-landing.js").ensureControlPlaneLandingRecord;
    assert.equal(writer(ticket, persisted, readBoardRow(ctx.boardPath, ticket), {
      layout: layoutModule.resolveControlPlaneLayout({ coordDir: ctx.coordRoot, workspaceRoot: path.dirname(ctx.coordRoot) }),
      base: "dev", sourceCommit: source, commitSha: landing.commit_sha, prEvidence: replayProof,
    }), landing, "identical PR provenance replay returns the original record");
    assert.equal(landing.recorded_at, originalRecordedAt);
    assert.equal(landing.evidence.length, 1);
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), originalRemoteHead, "replay performs no second publication");

    const conflictingProof = evidenceHelper.verifyControlPlanePrEvidence({
      ticketId: ticket,
      refs: [prUrl],
      verifiedPrs: [{ ref: prUrl, payload: { ...payload, mergeCommit: { oid: base } } }],
      expectedRepository: "Softsensor-org/coord-template",
      selectedBaseRef: "dev",
      sourceCommitSha: source,
      repoRoot: ctx.coordRoot,
    });
    const beforeConflict = structuredClone(persisted.landing_index[ticket]);
    assert.throws(() => writer(ticket, persisted, readBoardRow(ctx.boardPath, ticket), {
      layout: layoutModule.resolveControlPlaneLayout({ coordDir: ctx.coordRoot, workspaceRoot: path.dirname(ctx.coordRoot) }),
      base: "dev", sourceCommit: source, commitSha: landing.commit_sha, prEvidence: conflictingProof,
    }), /conflicting PR evidence replay/);
    assert.deepEqual(persisted.landing_index[ticket], beforeConflict);
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), originalRemoteHead);

    const boardBytesBeforeRepeat = fs.readFileSync(ctx.boardPath, "utf8");
    const landingBeforeRepeat = structuredClone(persisted.landing_index[ticket]);
    const remoteBeforeRepeat = runGit(remote, "rev-parse", "refs/heads/dev");
    const journalBeforeRepeat = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    const repeatedFinalize = attempt(finalizeArgs);
    assert.equal(repeatedFinalize.ok, true, `identical done PR-backed finalize retry is idempotent: ${JSON.stringify(repeatedFinalize)}`);
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.equal(fs.readFileSync(ctx.boardPath, "utf8"), boardBytesBeforeRepeat, "public repeat cannot rewrite the landing or board");
    assert.ok(journalBeforeRepeat.equals(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH)), "public repeat cannot duplicate closeout/ref-change events");
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).landing_index[ticket], landingBeforeRepeat);
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBeforeRepeat, "public repeat cannot publish again");
  });

  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, source, githubMerge, payload, active, attempt }) => {
    const secondUrl = "https://github.com/Softsensor-org/coord-template/pull/810";
    const secondBranch = `agent/codexa755-${ticket.toLowerCase()}-integrity`;
    runGit(ctx.coordRoot, "checkout", "-b", secondBranch, githubMerge);
    fs.writeFileSync(path.join(ctx.coordRoot, "docs", "integrity-generated.txt"), "verified generated state\n");
    runGit(ctx.coordRoot, "add", "docs/integrity-generated.txt");
    runGit(ctx.coordRoot, "commit", "-m", "supplemental integrity update");
    const secondHead = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    const secondTree = runGit(ctx.coordRoot, "rev-parse", `${secondHead}^{tree}`);
    const secondMergeResult = spawnSync("git", ["-C", ctx.coordRoot, "commit-tree", secondTree, "-p", githubMerge, "-p", secondHead, "-m", "fixture supplemental GitHub merge"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "COORD-809 fixture",
        GIT_AUTHOR_EMAIL: "coord809@example.invalid",
        GIT_COMMITTER_NAME: "COORD-809 fixture",
        GIT_COMMITTER_EMAIL: "coord809@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    assert.equal(secondMergeResult.status, 0, secondMergeResult.stderr);
    const secondMerge = secondMergeResult.stdout.trim();
    runGit(ctx.coordRoot, "push", "origin", `${secondMerge}:refs/heads/dev`);
    runGit(ctx.coordRoot, "checkout", "dev");
    runGit(ctx.coordRoot, "merge", "--ff-only", secondMerge);
    const secondPayload = {
      number: 810, url: secondUrl, state: "MERGED", mergedAt: "2026-10-06T16:00:00Z",
      headRefName: secondBranch, headRefOid: secondHead, baseRefName: "dev", mergeCommit: { oid: secondMerge },
    };
    active.payloadByUrl = { [secondUrl]: secondPayload };
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.pr_index[ticket].push(secondUrl);
    fs.writeFileSync(ctx.boardPath, `${JSON.stringify(board, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("coord809-multi-pr-review-fixture");

    const args = ["finalize", ticket, "--pr", prUrl, "--pr", secondUrl, "--source-commit", source,
      "--merge-workspace", "--push-before-closeout", "--push-after-sync", "--base", "dev"];
    const boardBeforeBadSecondPr = fs.readFileSync(ctx.boardPath, "utf8");
    const localBeforeBadSecondPr = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
    const remoteBeforeBadSecondPr = runGit(remote, "rev-parse", "refs/heads/dev");
    const journalBeforeBadSecondPr = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    active.payloadByUrl[secondUrl] = { ...secondPayload, baseRefName: "main" };
    const badSecondPr = attempt(args);
    assert.equal(badSecondPr.ok, false, "wrong supplemental base refuses");
    assert.match(badSecondPr.error, /does not match selected control-plane base/);
    assert.equal(fs.readFileSync(ctx.boardPath, "utf8"), boardBeforeBadSecondPr);
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localBeforeBadSecondPr);
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBeforeBadSecondPr);
    assert.ok(journalBeforeBadSecondPr.equals(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH)));
    active.payloadByUrl[secondUrl] = secondPayload;
    const result = attempt(args);
    assert.equal(result.ok, true, `dependent PR closeout succeeds: ${JSON.stringify(result)}`);
    const persisted = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const landing = persisted.landing_index[ticket];
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.equal(landing.pr_evidence.number, 809);
    assert.deepEqual(landing.additional_pr_evidence.map((proof) => proof.number), [810]);
    assert.equal(landing.additional_pr_evidence[0].source_commit_sha, githubMerge, "the supplemental PR is attributed to the preceding verified merge");
    assert.ok(landing.evidence.some((entry) => entry.includes(secondUrl.toLowerCase())));
    const errors = [];
    require("../../board/board.js").__testing.validateSchema(require("../../board/tasks.schema.json"), persisted, "tasks.json", errors);
    assert.deepEqual(errors, []);
    const localHead = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", githubMerge, localHead), "");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", secondMerge, localHead), "");
    const repeatBoard = fs.readFileSync(ctx.boardPath, "utf8");
    const repeatJournal = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    const repeatRemote = runGit(remote, "rev-parse", "refs/heads/dev");
    const repeated = attempt(args);
    assert.equal(repeated.ok, true, `multi-PR retry is idempotent: ${JSON.stringify(repeated)}`);
    assert.equal(fs.readFileSync(ctx.boardPath, "utf8"), repeatBoard);
    assert.ok(repeatJournal.equals(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH)));
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), repeatRemote);
  });
});

test("COORD-809: public PR finalize records an already-integrated, preflight-observed HEAD", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, source, head, githubMerge, payload, attempt }) => {
    // This models the authorized bootstrap integration shape: the verified
    // GitHub merge is already in canonical dev and origin/dev before finalize,
    // leaving no pending ticket branch for the closeout transaction to merge.
    runGit(ctx.coordRoot, "merge", "--no-ff", "-m", "approved bootstrap integration", githubMerge);
    const observedIntegration = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    assert.notEqual(observedIntegration, githubMerge, "integration commit remains distinct from the GitHub PR merge");
    runGit(ctx.coordRoot, "push", "origin", "dev");

    const finalizeArgs = [
      "finalize", ticket,
      "--pr", prUrl,
      "--source-commit", source,
      "--merge-workspace",
      "--push-before-closeout",
      "--push-after-sync",
      "--base", "dev",
    ];
    const result = attempt(finalizeArgs);
    assert.equal(result.ok, true, JSON.stringify(result));
    const persisted = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const landing = persisted.landing_index[ticket];
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.ok(landing, "the observed integration HEAD must receive structured landing evidence");
    assert.equal(landing.method, "pr");
    assert.equal(landing.source_commit_sha, source);
    assert.equal(landing.pr_evidence.head_sha, head);
    assert.equal(landing.pr_evidence.merge_sha, githubMerge);
    assert.equal(landing.commit_sha, observedIntegration);
    assert.equal(landing.control_plane_verification, "remote_ancestry");
    assert.notEqual(source, landing.commit_sha);
    assert.notEqual(head, landing.commit_sha);
    assert.notEqual(githubMerge, landing.commit_sha);
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "HEAD"), observedIntegration, "finalize must not create another workspace merge");
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), observedIntegration, "the exact observed integration HEAD must be remotely verified");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", githubMerge, landing.commit_sha), "");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", landing.commit_sha, `origin/dev`), "");
    assert.ok(landing.evidence.some((entry) => entry.includes(`Verified GitHub PR ${prUrl.toLowerCase()} merged as ${githubMerge}`)));
  });
});


// COORD-830 review finding 4: drive the COMPOSED closeout — the real CLI
// dispatch, lifecycle wiring, closeout, review readiness and gate, with only
// GitHub stubbed — so the reviewed head comes from the real verifyPrEvidence.
// Why measurement itself is not end-to-end here: the readiness gate is anchored
// to the module-level COORD_DIR (this checkout), which no in-process fixture can
// redirect, so the fixture's PR head cannot exist in the object store the gate
// reads. The test therefore proves the binding end to end and that an accepted
// head proceeds to resolution in the real COORD_DIR, never the canonical tree;
// the measurement at a resolved commit is pinned in decomposition-proof-gate.test.js.
test("COORD-830: public PR finalize binds a refactor's --source-commit to the verified PR head through the real wiring", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, runGit, remote, source, head, argsFor, attempt }) => {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    const row = board.sections.flatMap((section) => section.rows).find((entry) => entry.ID === ticket);
    row.Type = "refactor";
    row.Description = "Decomposition refactor: extract helpers out of the composition root.";
    __testing.writeBoard(board);
    const recordPath = path.join(ctx.planRecordsDir, `${ticket}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.repo_gates = ["decomposition-proof: file=coord/engine/scripts/lifecycle.js; before=3000; after=2000; claimed_reduction=1000; target_max=3000; extracted=helpers moved"];
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    __testing.advanceGovernanceProvenanceBaseline("coord830-refactor-fixture");

    const refuses = (sourceSha, pattern, label) => {
      const boardBefore = fs.readFileSync(ctx.boardPath, "utf8");
      const localHead = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
      const remoteHead = runGit(remote, "rev-parse", "refs/heads/dev");
      const result = attempt(argsFor(sourceSha));
      assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
      assert.match(String(result.error), pattern, label);
      assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review", `${label} cannot mark done`);
      assert.equal(fs.readFileSync(ctx.boardPath, "utf8"), boardBefore, `${label} cannot change the board`);
      assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localHead, `${label} cannot integrate`);
      assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteHead, `${label} cannot publish`);
    };
    assert.notEqual(source, head);
    refuses(source, new RegExp(`source commit ${source} is not the verified PR head of \\S+ ${head}`), "an ancestor of the PR head");
    refuses("dev", new RegExp(`"dev" is not a full 40-character commit SHA.*--source-commit ${head}`, "s"), "a branch name");
    refuses(head.slice(0, 12), /is not a full 40-character commit SHA/, "an abbreviated PR head");
    refuses(head, new RegExp(`source commit "${head}" does not resolve in `), "the exact PR head passes the binding and is resolved, never substituted");
  });
});

for (const base of ["dev", "origin/dev", "refs/heads/dev"]) test(`COORD-803: both closeout plan builders preserve explicit ${base}`, () => {
  const row = { Repo: "X" };
  assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate(row, "https://example.invalid/pull/803", { base }).closeoutBaseRef, "dev");
  assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate(row, { base }).closeoutBaseRef, "dev");
});

test("COORD-803: plan builders reject conflicting and invalid explicit bases", () => {
  for (const options of [{ base: "dev", configuredBranch: "main" }, { base: "bad..branch" }]) {
    assert.throws(() => closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "X" }, null, options), /Conflicting|Invalid/);
    assert.throws(() => closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, options), /Conflicting|Invalid/);
  }
});

for (const options of [{ configuredBranch: "dev" }, { base: "   ", configuredBranch: "origin/dev" }]) {
  test(`COORD-803: plan builders honor configured selector ${JSON.stringify(options)}`, () => {
    assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "X" }, null, options).closeoutBaseRef, "dev");
    assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, options).closeoutBaseRef, "dev");
  });
}
test("COORD-803: blank plan selectors retain the legacy default without probing Git", () => {
  const options = { base: "   ", configuredBranch: " ", gitTry: () => assert.fail("blank selectors must preserve the plan default") };
  assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "X" }, null, options).closeoutBaseRef, "main");
  assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, options).closeoutBaseRef, "main");
});

// COORD-895: the board branch is the project-configured `boardBranch`.
test("COORD-895: a configured non-main board branch is the Repo-X closeout base, and a conflicting --base is refused", () => {
  const layout = { coordRepoRoot: null, configuredBranch: "governance" };
  const gitTry = () => assert.fail("a configured board branch is never derived from git");
  assert.equal(closeoutOwner.buildPrCloseoutPlanUpdate({ Repo: "X" }, null, { layout, gitTry }).closeoutBaseRef, "governance");
  assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, { layout, gitTry }).closeoutBaseRef, "governance");
  assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, { layout, base: "origin/governance" }).closeoutBaseRef, "governance");
  assert.throws(() => closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }, { layout, base: "main" }), /Conflicting control-plane base selectors: --base "main" and configured branch "governance"/);
  assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "F" }, { layout }).closeoutBaseRef, "dev", "product repos keep their integration branch");
});

test("COORD-895: the engine's default layout carries the configured board branch from project config", () => {
  const controlPlanePaths = require("./control-plane-paths.js");
  // Bind the layout reset without a `__testing.<key>` access: this suite imports
  // the governance facade, whose census would count `reset` as a governance key.
  const { reset: resetControlPlaneLayout } = controlPlanePaths.__testing;
  const original = governanceDefaultPaths.controlPlaneIntegrationBranch;
  try {
    governanceDefaultPaths.controlPlaneIntegrationBranch = "governance";
    resetControlPlaneLayout();
    const layout = controlPlanePaths.defaultControlPlaneLayout();
    assert.equal(layout.configuredBranch, "governance");
    assert.equal(controlPlanePaths.configuredBoardBranch(layout), "governance");
    assert.equal(controlPlanePaths.resolveControlPlaneIntegrationBranch(layout, { gitTry: () => assert.fail("no git probe") }), "governance");
    assert.equal(closeoutOwner.buildNoPrCloseoutPlanUpdate({ Repo: "X" }).closeoutBaseRef, "governance");
    governanceDefaultPaths.controlPlaneIntegrationBranch = null;
    resetControlPlaneLayout();
    assert.equal("configuredBranch" in controlPlanePaths.defaultControlPlaneLayout(), false, "unset config leaves the layout shape unchanged");
    assert.equal(controlPlanePaths.configuredBoardBranch(controlPlanePaths.defaultControlPlaneLayout()), "main");
    assert.equal(controlPlanePaths.configuredBoardBranch(null), "main");
  } finally {
    governanceDefaultPaths.controlPlaneIntegrationBranch = original;
    resetControlPlaneLayout();
  }
});

// These factory-level tests exercise orchestration refusal and retry contracts.
// GitHub and board readers are injected collaborators; these are not real merges.
for (const [name, id, overrides, expected] of [
  ["missing id", undefined, {}, /land requires <ticket-id>/],
  ["unknown ticket", "COORD-703", { getTicketRef: () => null }, /Unknown ticket/],
  ["non-review state", "COORD-703", { getTicketRef: () => ({ row: { Repo: "B", Status: "doing" } }) }, /must be in review/],
  ["Repo-X PR", "COORD-703", { getTicketRef: () => ({ row: { Repo: "X", Status: "review" } }) }, /Close PR-backed X.*finalize/],
  ["no recorded PR evidence", "COORD-703", {
    readBoard: () => ({}),
    getTicketRef: () => ({ row: { Repo: "B", Status: "review" } }),
    resolvePrUrlForTicket: () => null,
  }, /no explicit.*no PR.*evidence/],
]) test(`COORD-803: landing refuses ${name} before external effects`, () => {
  const order = [];
  const closeout = buildLandOrderProbe({ order, overrides });
  assert.throws(() => closeout.landTicket(id, {}), expected);
  assert.ok(!order.some(entry => entry.startsWith("ACT:") || entry.startsWith("record:")), "refusal must precede merge or landing record");
});

test("COORD-803: explicit no-PR landing uses default owner without invoking a PR merge", () => {
  const order = [], plans = [], questions = [];
  const board = { pr_index: { "COORD-703": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const row = { ID: "COORD-703", Repo: "B", Status: "review" };
  const closeout = buildLandOrderProbe({ order, overrides: {
    readBoard: () => board,
    getTicketRef: () => ({ row }),
    resolveRepoIntegrationBranch: () => "dev",
    buildQuestionRow: value => { questions.push(value); return "closeout note"; },
    updateCanonicalPlanState: (_id, plan) => plans.push(plan),
    applyMarkDone: () => { row.Status = "done"; },
  } });
  closeout.landTicket("COORD-703", { base: "   " });
  assert.equal(row.Status, "done");
  assert.equal(questions[0].from, "unassigned");
  assert.equal(plans[0].closeoutBaseRef, "dev");
  assert.ok(!order.includes("ACT:pr-merge"));
  assert.ok(order.includes("verify:landing-integrity"));
});

test("COORD-803: already-merged PR retry refreshes the requested base and persists source evidence", () => {
  const order = [], refreshed = [], snapshots = [];
  let done = 0;
  const closeout = buildLandOrderProbe({ order, overrides: {
    prMerge: () => { order.push("observe:already-merged"); return { status: "already_merged" }; },
    refreshLandingBaseRef: (repo, base) => refreshed.push([repo, base]),
    persistMergedPrLandingSnapshot: (_id, _row, _url, options) => { snapshots.push(options); return { commit_sha: "abc1234" }; },
    resolveRepoIntegrationBranch: () => "dev",
    applyMarkDone: () => { done++; },
  } });
  closeout.landTicket("COORD-703", { base: "dev" });
  assert.deepEqual(refreshed, [["/repo/backend", "dev"]]);
  assert.equal(snapshots[0].sourceCommit, "resolved-implicit-head");
  assert.equal(done, 1);
  assert.equal(order.filter(entry => entry === "observe:already-merged").length, 1);
});

for (const [name, missingRead, missingSnapshot, expected] of [
  ["ticket disappears after merge", 2, false, /Unknown ticket.*after PR merge/],
  ["landing snapshot fails", 0, true, /Landing evidence.*could not be recorded after PR merge.*Recovery:/],
  ["ticket disappears after snapshot", 3, false, /Unknown ticket.*after recording landing evidence/],
]) test(`COORD-803: injected post-merge collaborator failure refuses closeout when ${name}`, () => {
  const order = []; let reads = 0, done = 0, snapshotWrites = 0;
  const closeout = buildLandOrderProbe({ order, overrides: {
    getTicketRef: board => ++reads === missingRead ? null : ({ row: board.sections[0].rows[0] }),
    persistMergedPrLandingSnapshot: () => { snapshotWrites++; return missingSnapshot ? null : { commit_sha: "abc1234" }; },
    applyMarkDone: () => { done++; },
  } });
  assert.throws(() => closeout.landTicket("COORD-703", {}), expected);
  assert.equal(order.filter(entry => entry === "ACT:pr-merge").length, 1, "failure happened after the injected merge collaborator");
  assert.equal(snapshotWrites, missingRead === 2 ? 0 : 1);
  assert.equal(done, 0, "missing post-merge evidence must never mark the ticket done");
});

// COORD-748: orchestration contract. These factory tests assert which existing
// transition/evidence writers are called, not the gates those writers enforce.
// COORD-834: the PR containment rule held only when a decomposition proof was
// measured. A PR-backed Repo-X closeout with no proof merged the ticket-branch
// TIP, so a local commit after the reviewed PR head landed unreviewed.
test("COORD-834: an unmeasured PR-backed finalize refuses a ticket-branch commit beyond the PR merge", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, source, head, githubMerge, attempt }) => {
    const feature = path.join(ctx.coordRoot, ".worktrees", "claudea0000", ticket);
    const branch = runGit(feature, "rev-parse", "--abbrev-ref", "HEAD");
    assert.equal(runGit(feature, "rev-parse", "HEAD"), githubMerge, "the fixture branch starts at the GitHub squash merge");
    fs.writeFileSync(path.join(feature, "docs", "unreviewed.txt"), "after the PR head\n");
    runGit(feature, "add", "docs/unreviewed.txt");
    runGit(feature, "commit", "-m", "local commit after the reviewed PR head");
    const beyond = runGit(feature, "rev-parse", "HEAD");
    const localBefore = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
    const remoteBefore = runGit(remote, "rev-parse", "refs/heads/dev");
    const args = ["finalize", ticket, "--pr", prUrl, "--source-commit", source, "--merge-workspace", "--push-before-closeout", "--base", "dev"];

    const refused = attempt(args);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    const refusal = String(refused.error || "");
    assert.match(refusal, new RegExp(`ticket branch ${branch} is at ${beyond}, which is not contained in the merged PR ${prUrl.toLowerCase().replace(/[.]/g, "\\.")}`), refusal);
    assert.match(refusal, new RegExp(`\\(head ${head}, merge ${githubMerge}\\)`));
    assert.match(refusal, /reviewed at that head, so merging this tip would land commits no review covered/);
    assert.doesNotMatch(refusal, /decomposition proof/, "no proof was measured, so the refusal does not claim one");
    assert.match(refusal, /land the extra commits through their own reviewed PR instead/);
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localBefore, "refused before any workspace merge");
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBefore, "refused before any publication");

    // The named save then reset, executed, make the next closeout accepted.
    const save = new RegExp(`saving the commits beyond the reviewed head \\((git -C ${SHELL_WORD_RE} branch COORD-809-beyond-review-[0-9a-f]{40} [0-9a-f]{40})\\)`).exec(refusal)[1];
    const reset = new RegExp(`resetting the branch to what the PR merged \\((git -C ${SHELL_WORD_RE} reset --keep [0-9a-f]{40})\\)`).exec(refusal)[1];
    assert.ok(reset.includes(feature), reset);
    assert.ok(reset.endsWith(githubMerge), "the squash reset names the GitHub merge, which carries the reviewed head's tree");
    runPrintedGitStep(save);
    runPrintedGitStep(reset);
    assert.equal(runGit(ctx.coordRoot, "rev-parse", `COORD-809-beyond-review-${beyond}`), beyond, "the commit beyond review is kept");
    const accepted = attempt(args);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    const landing = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).landing_index[ticket];
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", githubMerge, landing.commit_sha), "");
    const landed = spawnSync("git", ["-C", ctx.coordRoot, "merge-base", "--is-ancestor", beyond, landing.commit_sha], { encoding: "utf8" });
    assert.equal(landed.status, 1, "the unreviewed commit did not land");
  });
});

function coord748CloseoutFixture(status = "review", refs = []) {
  const id = "COORD-748";
  const row = { ID: id, Repo: "X", Status: status, Owner: "claudea0000" };
  const board = { pr_index: { [id]: [...refs] } };
  const effects = [];
  const closeout = require("./closeout.js")({
    readBoard: () => board,
    getTicketRef: (_board, requested) => requested === id ? { row } : null,
    mergeUniqueRefs: (a, b) => [...new Set([...a, ...b])],
    toArray: value => value == null ? [] : Array.isArray(value) ? value : [value],
    resolveLifecyclePrRefs: () => ["https://example.invalid/repo/pull/748"],
    setPrRefs: (ticket, options) => {
      assert.equal(ticket, id);
      effects.push({ operation: "set-pr", options });
      board.pr_index[id] = [...options.pr];
    },
    moveReview: (ticket, options) => {
      assert.equal(ticket, id);
      effects.push({ operation: "move-review", options });
      row.Status = "review";
      board.pr_index[id] = [...options.pr];
    },
    markDone: (ticket, options = {}) => {
      assert.equal(ticket, id);
      effects.push({ operation: "mark-done", options });
      if (Array.isArray(options.closeoutPrRefs)) board.pr_index[id] = [...options.closeoutPrRefs];
      row.Status = "done";
    },
    withGovernanceMutation: (_metadata, operation) => operation(),
    updateCanonicalPlanState: () => effects.push({ operation: "write-plan" }),
    isRepoBackedCode: () => false,
  });
  return { id, row, board, effects, closeout };
}

for (const method of ["finalizeTicket", "finishTicket"]) {
  test(`COORD-748: ${method} refuses invalid identity or state before evidence writes`, () => {
    for (const [id, options, pattern] of [
      [undefined, {}, /requires <ticket-id>/],
      ["COORD-MISSING", {}, /Unknown ticket/],
      ["COORD-748", method === "finalizeTicket" ? { noPr: true } : {}, /must be doing or review/],
    ]) {
      const f = coord748CloseoutFixture("todo");
      const before = structuredClone(f.board);
      assert.throws(() => f.closeout[method](id, options), pattern);
      assert.deepEqual(f.effects, []);
      assert.deepEqual(f.board, before);
    }
  });
}

test("COORD-748: no-PR finalize rejects PR conflicts and incompatible already-landed intent atomically", () => {
  for (const options of [{ noPr: true }, { alreadyLanded: true }]) {
    const f = coord748CloseoutFixture("review", ["https://example.invalid/repo/pull/748"]);
    const before = structuredClone(f.board);
    assert.throws(() => f.closeout.finalizeTicket(f.id, options), /already has PR evidence|requires --no-pr/);
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.board, before);
  }
});

test("COORD-748: finalize and finish explicitly replace only their fully resolved evidence sets", () => {
  for (const method of ["finalizeTicket", "finishTicket"]) {
    for (const status of ["doing", "review"]) {
      const f = coord748CloseoutFixture(status);
      f.closeout[method](f.id, method === "finalizeTicket" ? { noPr: true } : {});
      assert.equal(f.row.Status, "done");
      const expectedRefs = method === "finalizeTicket" ? ["local-review (no PR)"] : ["https://example.invalid/repo/pull/748"];
      assert.deepEqual(f.board.pr_index[f.id], expectedRefs);
      const first = f.effects[0];
      assert.equal(first.operation, "mark-done", "refs and terminal transition are handled by the closeout transaction");
      assert.deepEqual(first.options.closeoutPrRefs, expectedRefs);
      assert.equal(f.effects.filter(effect => effect.operation === "mark-done").length, 1);
      if (method === "finalizeTicket") {
        // Without --no-pr, finalize delegates to the PR-backed finish path and
        // inherits its explicit full-set replacement.
        const delegated = coord748CloseoutFixture(status);
        delegated.closeout.finalizeTicket(delegated.id, {});
        assert.equal(delegated.row.Status, "done");
        assert.deepEqual(delegated.board.pr_index[delegated.id], ["https://example.invalid/repo/pull/748"]);
        if (status === "review") {
          assert.deepEqual(delegated.effects[0], {
            operation: "mark-done",
            options: { closeoutPrRefs: ["https://example.invalid/repo/pull/748"] },
          });
        }
      }
      if (method === "finalizeTicket") {
        const before = structuredClone(f.board);
        f.effects.length = 0;
        f.closeout.finalizeTicket(f.id, { noPr: true });
        assert.deepEqual(f.effects, [{ operation: "write-plan" }]);
        assert.deepEqual(f.board, before, "done retry must not reauthor evidence or repeat transitions");
      }
    }
  }
});

// COORD-830: move-review releases the lock, so closeout hands the operator's
// reviewed source commit (--source-commit) to review readiness, where the
// decomposition-proof gate measures at that commit instead of the canonical tree.
function coord830Workspace(t) {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const { DEFAULT_CONFIG } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/arch-checks.js"));
  const rel = "coord/engine/scripts/lifecycle.js", cap = DEFAULT_CONFIG.checks.prodloc.highWater[rel];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord830-closeout-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace"), locksDir = path.join(base, "locks");
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.mkdirSync(locksDir);
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const commit = (lines, message) => { fs.writeFileSync(path.join(root, rel), "void 0;\n".repeat(lines)); git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  const canonical = commit(cap, "canonical");
  git("branch", "-q", "-M", "dev");
  git("checkout", "-q", "-b", "COORD-830-refactor");
  const reviewed = commit(cap - 68, "COORD-830 reviewed head");
  git("checkout", "-q", "dev");
  return { root, locksDir, rel, cap, canonical, reviewed };
}

function coord830Closeout(assertReviewPlanReady, extra = {}) {
  return require("./closeout.js")({
    fail: (message) => { throw new Error(message); },
    assertReviewPlanReady,
    findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null,
    verifyPrEvidence: () => {},
    ensureLandingRecord: () => ({ evidence: ["fixture landing"] }),
    assertLandingIntegrity: () => {},
    ensureTestingInfrastructureLandingAudit: () => {},
    ensureFeatureProofLandingAudit: () => {},
    cleanupTicketWorktree: () => {},
    isRepoBackedCode: (code) => code === "B",
    resolveRepoIntegrationBranch: () => "dev",
    ...extra,
  });
}

test("COORD-830: every closeout readiness call receives the reviewed source commit", () => {
  const seen = [];
  const board = { pr_index: { "COORD-830": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const record = (_ticketId, _row, context) => {
    assert.equal(typeof context.resolveReviewedSource, "function", "every call can bind the source to durable provenance");
    seen.push({ sourceCommit: context.sourceCommit });
  };
  coord830Closeout(record).prepareDoneCloseout("COORD-830", board, { row: { Repo: "B", Status: "review" } }, { sourceCommit: "abc1234" });
  assert.deepEqual(seen, [{ sourceCommit: "abc1234" }], "finalize/mark-done path");

  seen.length = 0;
  const resolved = "b".repeat(40);
  assert.throws(() => coord830Closeout(record, {
    resolveSourceCommitOrRefuse: () => resolved,
    ensureRepoXCloseoutReady: () => null,
    ensureControlPlaneLandingRecord: () => { throw new Error("stop after readiness"); },
  }).prepareDoneCloseout("COORD-830", board, { row: { Repo: "X", Status: "review" } }, { sourceCommit: "bbbbbbb" }), /stop after readiness/);
  assert.deepEqual(seen, [{ sourceCommit: "bbbbbbb" }, { sourceCommit: resolved }], "Repo-X: raw before, preflight-resolved before the workspace integration");

  seen.length = 0;
  assert.throws(() => coord830Closeout(record, {
    readBoard: () => ({ ...board, pr_index: { "COORD-830": ["https://github.com/example/repo/pull/1"] } }),
    getTicketRef: () => ({ row: { ID: "COORD-830", Repo: "B", Status: "review", Owner: "o" } }),
    inferTicketStatus: () => "review",
    withGovernanceMutation: (_mutation, run) => run(),
    ensureTicketMutationOwnership: () => ({}),
    getRepoRoot: () => null,
    resolveCommitishInRepo: () => "c".repeat(40),
    prMerge: () => { throw new Error("stop at merge"); },
  }).landTicket("COORD-830", { pr: "https://github.com/example/repo/pull/1", sourceCommit: "ccccccc" }), /stop at merge/);
  assert.deepEqual(seen, [{ sourceCommit: "ccccccc" }], "land preflight path");
});

function coord830Gate(root, locksDir, rel, cap) {
  const { collectDecompositionProofIssues } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/decomposition-proof-gate.js"));
  const planState = { repo_gates: [`decomposition-proof: file=${rel}; before=${cap}; after=${cap - 68}; claimed_reduction=68; target_max=${cap}; extracted=helpers moved`] };
  return (ticketId, gateRow, context = {}) => {
    const issues = collectDecompositionProofIssues({ ticketId, row: gateRow, planState, coordDir: path.join(root, "coord"), locksDir, repoRoot: path.join(root, "coord"),
      sourceCommit: context.sourceCommit, resolveReviewedSource: context.resolveReviewedSource });
    if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" | "));
  };
}

test("COORD-830: finalize-style readiness qualifies the proof only at the verified PR head (COORD-486 live case)", (t) => {
  const { root, locksDir, rel, cap, canonical, reviewed } = coord830Workspace(t);
  const row = { ID: "COORD-830", Repo: "B", Status: "review", Type: "refactor", Description: "decomposition refactor" };
  const prUrl = "https://github.com/example/repo/pull/1";
  const board = { pr_index: { "COORD-830": [prUrl] }, review_findings: {}, landing_index: {} };
  const prViews = [];
  const closeout = coord830Closeout(coord830Gate(root, locksDir, rel, cap), {
    verifyPrEvidence: (ticketId, refs, options) => {
      prViews.push({ refs, options });
      return refs.map((ref) => ({ ref, payload: { state: "MERGED", headRefOid: reviewed } }));
    },
  });
  const run = (options) => closeout.prepareDoneCloseout("COORD-830", board, { row }, options);
  assert.equal(fs.readFileSync(path.join(root, rel), "utf8").split("\n").length - 1, cap, "canonical still holds the pre-change file");
  assert.throws(() => run({}), /no live lock and no reviewed source commit was supplied/, "no source: refuse, never measure canonical");
  assert.throws(() => run({ sourceCommit: canonical }), new RegExp(`source commit ${canonical} is not the verified PR head of ${prUrl.replace(/[.]/g, "\\.")} ${reviewed}`));
  assert.throws(() => run({ sourceCommit: "dev" }), new RegExp(`not a full 40-character commit SHA.*exact reviewed head ${reviewed} with --source-commit`));
  assert.ok(prViews.every((view) => view.options.requireMerged === false && view.options.allowNoPr === false), "the head is read from the verified PR, merged or not yet merged (land preflight)");
  assert.doesNotThrow(() => run({ sourceCommit: reviewed }));
});

test("COORD-830: the reviewed head comes from durable provenance, never from the operator's value", (t) => {
  const { root, locksDir, rel, cap, canonical, reviewed } = coord830Workspace(t);
  const row = { ID: "COORD-830", Repo: "B", Status: "review", Type: "refactor", Description: "decomposition refactor" };
  const gate = coord830Gate(root, locksDir, rel, cap);
  const run = (board, options, extra = {}) => coord830Closeout(gate, extra).prepareDoneCloseout("COORD-830", board, { row }, options);
  const noPr = (landing) => ({ pr_index: { "COORD-830": ["local-review (no PR)"] }, review_findings: {}, landing_index: landing ? { "COORD-830": landing } : {} });

  // No-PR: the recorded landing source wins over the governed-commit journal.
  assert.doesNotThrow(() => run(noPr({ source_commit_sha: reviewed }), { sourceCommit: reviewed }, { readGovernedCommitHead: () => canonical }));
  assert.throws(() => run(noPr({ source_commit_sha: reviewed }), { sourceCommit: canonical }), new RegExp(`is not the recorded landing source ${reviewed}`));
  // No-PR with no landing record yet: the last governed commit the engine journalled.
  assert.doesNotThrow(() => run(noPr(), { sourceCommit: reviewed }, { readGovernedCommitHead: (ticketId) => ticketId === "COORD-830" ? reviewed : null }));
  assert.throws(() => run(noPr(), { sourceCommit: canonical }, { readGovernedCommitHead: () => reviewed }), new RegExp(`is not the ticket's last governed commit ${reviewed}`));
  assert.throws(() => run(noPr(), { sourceCommit: reviewed }, { readGovernedCommitHead: () => null }), /no PR, recorded landing source, or governed commit names the reviewed head/);
  assert.throws(() => run({ review_findings: {}, landing_index: {} }, { sourceCommit: reviewed }, { readGovernedCommitHead: () => null }),
    /no PR, recorded landing source, or governed commit names the reviewed head/, "a board with no pr_index entry still resolves provenance before its own pr_index check");

  // PR-backed: ambiguous or unverifiable PR evidence refuses rather than trusting the operator.
  const twoPrs = { pr_index: { "COORD-830": ["https://github.com/example/repo/pull/1", "https://github.com/example/repo/pull/2"] }, review_findings: {}, landing_index: {} };
  assert.throws(() => run(twoPrs, { sourceCommit: reviewed }, { verifyPrEvidence: () => [] }), /names 2 PRs, so the reviewed head is ambiguous/);
  const onePr = { pr_index: { "COORD-830": ["https://github.com/example/repo/pull/1"] }, review_findings: {}, landing_index: {} };
  assert.throws(() => run(onePr, { sourceCommit: reviewed }, { verifyPrEvidence: () => { throw new Error("PR is closed"); } }), /could not be verified \(PR is closed\)/);
  assert.throws(() => run(onePr, { sourceCommit: reviewed }, { verifyPrEvidence: (_t, refs) => refs.map((ref) => ({ ref, payload: { headRefOid: "" } })) }), /GitHub returned no full head OID/);
});

// COORD-830 review finding 1: the expected head must be the head of the PR the
// command merges or records; an operator --pr naming a different PR is refused
// before any side effect.
function coord830LandProbe({ recorded, log, heads }) {
  return require("./closeout.js")({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ pr_index: { "T-1": recorded }, review_findings: {}, landing_index: {} }),
    getTicketRef: () => ({ row: { ID: "T-1", Repo: "B", Status: "review", Owner: "o" } }),
    inferTicketStatus: () => "review", withGovernanceMutation: (_m, run) => run(), ensureTicketMutationOwnership: () => ({}),
    getRepoRoot: () => "/nonexistent", resolveCommitishInRepo: (_r, sha) => sha, isRepoBackedCode: () => true,
    findOutstandingCloseoutBlockerFollowups: () => [], findLockForTicket: () => null,
    resolvePrUrlForTicket: () => recorded.find((ref) => /^https:/.test(ref)),
    verifyPrEvidence: (_t, refs) => { log.push(["verify", ...refs]); return refs.map((ref) => ({ ref, payload: { state: "OPEN", headRefOid: heads[ref] } })); },
    assertReviewPlanReady: (_t, _row, ctx) => { log.push(["gate-expected", ctx.resolveReviewedSource()]); },
    prMerge: (_t, options) => { log.push(["prMerge", options.pr]); throw new Error("stop at merge"); },
  });
}

test("COORD-830: land refuses a --pr that is not the recorded PR before the gate or the merge", () => {
  const A = "https://github.com/o/r/pull/1", B = "https://github.com/o/r/pull/2";
  const heads = { [A]: "a".repeat(40), [B]: "b".repeat(40) };
  let log = [];
  assert.throws(() => coord830LandProbe({ recorded: [A], log, heads }).landTicket("T-1", { pr: B, sourceCommit: heads[A] }),
    /records https:\/\/github\.com\/o\/r\/pull\/1; --pr "https:\/\/github\.com\/o\/r\/pull\/2" is not a recorded PR.*gov set-pr T-1 --replace --pr/s);
  assert.deepEqual(log, [], "no gate, verification or merge ran");
  assert.throws(() => coord830LandProbe({ recorded: [A], log, heads }).landTicket("T-1", { pr: "https://github.com/o/r/pull/1/files" }), /is not a canonical GitHub PR URL/);
  assert.throws(() => coord830LandProbe({ recorded: [A], log, heads }).landTicket("T-1", { pr: [A, A] }), /land merges one PR/);
  assert.deepEqual(log, []);

  // The recorded PR (spelled with a trailing slash) is normalised; the gate's
  // expected head and the merge both name exactly that PR.
  assert.throws(() => coord830LandProbe({ recorded: [A], log, heads }).landTicket("T-1", { pr: `${A}/`, sourceCommit: heads[A] }), /stop at merge/);
  assert.deepEqual(log, [
    ["verify", A],
    ["gate-expected", { sha: heads[A], label: `the verified PR head of ${A}`, reason: `GitHub returned no full head OID for ${A}`, fetchRef: "pull/1/head", closeout: { flags: [], landable: true } }],
    ["prMerge", A],
  ]);

  // Two recorded PRs: the PR the command names is the one qualified and merged.
  log = [];
  assert.throws(() => coord830LandProbe({ recorded: [A, B], log, heads }).landTicket("T-1", { pr: B, sourceCommit: heads[B] }), /stop at merge/);
  assert.equal(log.find((entry) => entry[0] === "gate-expected")[1].sha, heads[B]);
  assert.deepEqual(log.find((entry) => entry[0] === "prMerge"), ["prMerge", B]);
});

test("COORD-830: finalize refuses a --pr that replaces the recorded PR unless the governed replacement recorded it", () => {
  const A = "https://github.com/o/r/pull/1", B = "https://github.com/o/r/pull/2";
  const run = (recorded, options, status = "review") => {
    const effects = [];
    const board = { pr_index: { "T-1": [...recorded] } };
    const closeout = require("./closeout.js")({
      fail: (message) => { throw new Error(message); },
      readBoard: () => board,
      getTicketRef: () => ({ row: { ID: "T-1", Repo: "B", Status: status } }),
      toArray: (value) => value == null ? [] : [].concat(value),
      mergeUniqueRefs: (a, b) => [...new Set([...a, ...b])],
      resolveLifecyclePrRefs: (_t, _row, _board, opts) => { effects.push("resolve-pr-refs"); return [].concat(opts.pr || recorded); },
      setPrRefs: (_t, opts) => { effects.push("set-pr"); board.pr_index["T-1"] = opts.pr; },
      moveReview: () => effects.push("move-review"),
      markDone: (_ticket, opts = {}) => {
        effects.push("mark-done");
        if (Array.isArray(opts.closeoutPrRefs)) board.pr_index["T-1"] = opts.closeoutPrRefs;
      },
    });
    closeout.finalizeTicket("T-1", options);
    return { effects, board };
  };
  for (const [label, recorded, options] of [
    ["finalize --pr B over recorded A", [A], { pr: B }],
    ["finalize --pr adding B beside recorded A", [A], { pr: [A, B] }],
    ["finalize --pr replacing a PR with no-PR evidence", [A], { pr: "local-review (no PR)" }],
    ["finalize --no-pr --pr B over recorded A", [A], { noPr: true, pr: B }],
  ]) {
    assert.throws(() => run(recorded, options), /is not a recorded PR.*gov set-pr T-1 --replace/s, label);
  }
  assert.throws(() => run([A], { pr: B }, "doing"), /is not a recorded PR/, "doing-state finalize is refused the same way");
  // After `gov set-pr T-1 --replace --pr B` recorded it, --pr B agrees.
  // Changed and unchanged sets both flow through mark-done; no separate
  // set-pr transaction can run before closeout preflights.
  assert.deepEqual(run([B], { pr: B }).effects, ["resolve-pr-refs", "mark-done"]);
  assert.deepEqual(run([A], { pr: `${A}/` }).effects, ["resolve-pr-refs", "mark-done"], "the recorded PR in another spelling agrees and is unchanged");
  assert.deepEqual(run([], { pr: B }).effects, ["resolve-pr-refs", "mark-done"], "with no recorded PR, mark-done persists the prospective refs with closeout");
  assert.deepEqual(run([A], {}).effects, ["resolve-pr-refs", "mark-done"]);
  const narrowed = run([A, "fulfilled by COORD-1"], { pr: A });
  assert.deepEqual(narrowed.effects, ["resolve-pr-refs", "mark-done"], "a changed ref set is carried into mark-done rather than a prior set-pr transaction");
  assert.deepEqual(narrowed.board.pr_index["T-1"], [A], "the resolver's complete set is what the closeout transaction persists");
});

test("COORD-830: finish-ticket applies the same recorded-PR rule", () => {
  const A = "https://github.com/o/r/pull/1", B = "https://github.com/o/r/pull/2";
  const effects = [];
  const closeout = require("./closeout.js")({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ pr_index: { "T-1": [A] } }),
    getTicketRef: () => ({ row: { ID: "T-1", Repo: "B", Status: "review" } }),
    resolveLifecyclePrRefs: () => effects.push("resolve-pr-refs"),
    setPrRefs: () => effects.push("set-pr"),
  });
  assert.throws(() => closeout.finishTicket("T-1", { pr: B }), /is not a recorded PR/);
  assert.deepEqual(effects, []);
});

// COORD-830 review findings 2 and 4 at the resolver: fulfilled-by shapes, PR URL
// spellings, and the fetch ref carried for an unfetched head.
test("COORD-830: the reviewed-source resolver handles fulfilled-by shapes and PR URL spellings", () => {
  const pr = "https://github.com/Softsensor-org/coord-template/pull/141";
  const fulfilled = "Fulfilled by COORD-808 PR141 verified integration5b0cef3a (no PR)";
  const resolveWith = (refs, landing, verify, extra = {}) => {
    let resolved;
    const closeout = coord830Closeout((_t, _row, ctx) => { resolved = ctx.resolveReviewedSource(); throw new Error("stop"); }, {
      verifyPrEvidence: verify || ((_t, urls) => urls.map((ref) => ({ ref, payload: { headRefOid: "a".repeat(40) } }))),
      readGovernedCommitHead: () => null,
      ...extra,
    });
    assert.throws(() => closeout.prepareDoneCloseout("T-1", { pr_index: { "T-1": refs }, landing_index: landing ? { "T-1": landing } : {} }, { row: { Repo: "B", Status: "review" } }, { sourceCommit: "a".repeat(40) }), /stop/);
    return resolved;
  };
  // A recorded fulfilment landing supplies the provenance.
  assert.deepEqual(resolveWith([pr, fulfilled], { fulfilled_by_ticket: "COORD-808", fulfilled_by_commit_sha: "5".repeat(40), source_commit_sha: "c".repeat(40) }),
    { sha: "c".repeat(40), label: "the recorded fulfilment landing source", closeout: { flags: [], landable: true } });
  // Without one, the refusal names only the replacements that can resolve it
  // (third pass, finding 3), and each named replacement, executed, resolves.
  const prStep = `coord/scripts/gov set-pr T-1 --replace --pr "${pr}"`, fulfilledStep = `coord/scripts/gov set-pr T-1 --replace --pr "${fulfilled}"`;
  const headed = (headRefName) => (_t, urls) => urls.map((ref) => ({ ref, payload: { headRefOid: "a".repeat(40), headRefName } }));
  const own = headed("agent/x-t-1-refactor"), foreign = headed("agent/x-coord-808-work");
  const governed = { readGovernedCommitHead: (id) => (id === "T-1" ? "e".repeat(40) : null) };
  for (const [landing, verify, extra, expected] of [
    [{ source_commit_sha: "c".repeat(40) }, foreign, {}, [fulfilledStep]],
    [{ fulfilled_by_ticket: "COORD-808" }, foreign, governed, [fulfilledStep]],
    [null, own, {}, [prStep]],
    [{ source_commit_sha: "c".repeat(40) }, own, {}, [prStep, fulfilledStep]],
    [null, () => { throw new Error("PR unreadable"); }, {}, null],
  ]) {
    const ambiguous = resolveWith([pr, fulfilled], landing, verify, extra);
    assert.equal(ambiguous.sha, undefined);
    assert.match(ambiguous.reason, /names https:\/\/github\.com\/Softsensor-org\/coord-template\/pull\/141 beside non-PR evidence/);
    if (expected) {
      assert.deepEqual(ambiguous.recovery, expected);
      for (const step of expected) {
        const value = /--pr "(.*)"$/.exec(step)[1];
        assert.match(resolveWith([value], landing, verify, extra).sha, /^[0-9a-f]{40}$/, `executing ${step} resolves the head`);
      }
    } else {
      // Neither replacement can resolve: the recovery creates provenance, and
      // once a governed commit exists the non-PR replacement resolves.
      assert.ok(!ambiguous.recovery.includes(prStep), "an unaffiliated or unreadable PR is never offered");
      assert.match(ambiguous.recovery.join("\n"), /gov return-doing T-1 [^\n]*\n.*-before-provenance-[^\n]* HEAD [^\n]*\n.*reset --soft[^\n]*\ncoord\/scripts\/gov commit T-1 /);
      assert.equal(resolveWith([fulfilled], landing, verify, governed).sha, "e".repeat(40));
    }
  }
  assert.ok(resolveWith([pr, "local-review (no PR)"], { fulfilled_by_ticket: "X", source_commit_sha: "c".repeat(40) }).recovery, "only fulfilled-by evidence uses the fulfilment source");
  // After either replacement the shape resolves.
  assert.equal(resolveWith([pr]).sha, "a".repeat(40));
  assert.equal(resolveWith([fulfilled], { source_commit_sha: "c".repeat(40) }).sha, "c".repeat(40));

  // URL spellings: a trailing slash or duplicate is the same PR, verified canonically.
  const verified = [];
  const head = resolveWith(["https://github.com/o/r/pull/5/", "https://github.com/o/r/pull/5"], null, (_t, urls) => { verified.push(...urls); return urls.map((ref) => ({ ref, payload: { headRefOid: "d".repeat(40) } })); });
  assert.deepEqual(head, { sha: "d".repeat(40), label: "the verified PR head of https://github.com/o/r/pull/5", reason: "GitHub returned no full head OID for https://github.com/o/r/pull/5", fetchRef: "pull/5/head", closeout: { flags: [], landable: true } });
  assert.deepEqual(verified, ["https://github.com/o/r/pull/5"]);
  // A ref that looks like a PR URL but does not parse is refused explicitly,
  // never read as no-PR provenance.
  for (const bad of ["https://github.com/o/r/pull/5/files", "http://github.com/o/r/pull/5", "https://github.com/o/r/pull/abc"]) {
    const refused = resolveWith([bad], { source_commit_sha: "c".repeat(40) });
    assert.equal(refused.sha, undefined, bad);
    assert.match(refused.reason, /is not a canonical GitHub PR URL/, bad);
    assert.match(refused.recovery[0], /gov set-pr T-1 --replace --pr/, bad);
  }
  const { classifyPrRef } = require("./closeout.js").__testing;
  assert.deepEqual(classifyPrRef("https://github.com/O/R/pull/9?x=1#y"), { kind: "pr", text: "https://github.com/O/R/pull/9?x=1#y", url: "https://github.com/O/R/pull/9", key: "https://github.com/o/r/pull/9", number: "9" });
  assert.equal(classifyPrRef(undefined).kind, "other");
});

test("COORD-830: an unresolvable incoming tip or repository refuses the measured workspace merge", (t) => {
  const os = require("node:os");
  const { assertIncomingTipsMeasured } = require("./closeout.js").__testing;
  const measured = { sha: "a".repeat(40), label: "the ticket's last governed commit" };
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coord830-not-a-repo-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const tips = [{ branch: "agent/x-coord-830-a", head_sha: undefined }];
  assert.throws(() => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured, repoRoot: outside, incomingBranchTips: tips }), (error) => {
    const reset = new RegExp(`\\((git -C ${SHELL_WORD_RE} branch -f \\S+ [0-9a-f]{40})\\)`).exec(error.message);
    assert.ok(reset, error.message);
    assert.deepEqual(splitPosixShellWords(reset[1]), ["git", "-C", outside, "branch", "-f", "agent/x-coord-830-a", measured.sha]);
    return true;
  });
  assert.throws(() => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured, repoRoot: outside, incomingBranchTips: tips }),
    /branch COORD-830-beyond-review-agent-x-coord-830-a agent\/x-coord-830-a\)/, "an unresolved tip is saved by branch name");
  assert.throws(() => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured, repoRoot: outside, incomingBranchTips: tips,
    prEvidence: { url: "https://github.com/o/r/pull/1", head_sha: measured.sha, merge_sha: null } }), /not contained in the merged PR/);
  const proofs = [1, 2].map((id) => ({ url: `https://github.com/o/r/pull/${id}`, head_sha: measured.sha, merge_sha: null }));
  assert.throws(() => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured, repoRoot: outside, incomingBranchTips: tips,
    prEvidence: proofs }), /not contained in the verified PR set \(https:\/\/github.com\/o\/r\/pull\/1, https:\/\/github.com\/o\/r\/pull\/2\)/);
});

test("COORD-830: a land --pr that the resolver cannot find in pr_index is refused by the gate", () => {
  // Defence in depth behind the land guard: the resolver itself never reads an
  // unrecorded PR's head.
  let resolved;
  const closeout = coord830Closeout((_t, _row, ctx) => { resolved = ctx.resolveReviewedSource(); }, {
    readBoard: () => ({ pr_index: { "T-1": [] }, review_findings: {}, landing_index: {} }),
    getTicketRef: () => ({ row: { ID: "T-1", Repo: "B", Status: "review", Owner: "o" } }),
    inferTicketStatus: () => "review", withGovernanceMutation: (_m, run) => run(), ensureTicketMutationOwnership: () => ({}),
    getRepoRoot: () => null, resolveCommitishInRepo: () => null,
    prMerge: () => assert.fail("must not merge"),
  });
  assert.throws(() => closeout.landTicket("T-1", { pr: "https://github.com/o/r/pull/3" }), /no pr_index evidence/);
  assert.deepEqual(resolved, { reason: "the PR this command lands (https://github.com/o/r/pull/3) is not recorded in pr_index for T-1", recovery: ['coord/scripts/gov set-pr T-1 --replace --pr "https://github.com/o/r/pull/3"'], closeout: { flags: [], landable: true } });
  assert.throws(() => closeout.landTicket("T-1", { pr: "not-a-pr-url" }), /no pr_index evidence/);
  assert.deepEqual(resolved, { reason: "the PR this command lands (not-a-pr-url) is not recorded in pr_index for T-1", recovery: ['coord/scripts/gov set-pr T-1 --replace --pr "not-a-pr-url"'], closeout: { flags: [], landable: true } });
});

test("COORD-830: the PR-beside-fulfilment resolver reads the engine journal when no reader is injected", () => {
  const pr = "https://github.com/o/r/pull/7";
  let resolved;
  const closeout = coord830Closeout((_t, _row, ctx) => { resolved = ctx.resolveReviewedSource(); throw new Error("stop"); }, {
    verifyPrEvidence: (_t, urls) => urls.map((ref) => ({ ref, payload: { headRefOid: "a".repeat(40), headRefName: "agent/x-other-1" } })),
  });
  assert.throws(() => closeout.prepareDoneCloseout("NOPROV-830", { pr_index: { "NOPROV-830": [pr, "Fulfilled by X-1 (no PR)"] }, landing_index: {} },
    { row: { Repo: "B", Status: "review" } }, { sourceCommit: "a".repeat(40) }), /stop/);
  assert.match(resolved.recovery.join("\n"), /gov return-doing NOPROV-830 /, "no journalled governed commit: provenance-creating steps");
});

test("COORD-830: readGovernedCommitHead returns the last succeeded governed commit head for the ticket", (t) => {
  const os = require("node:os");
  const { readGovernedCommitHead } = require("./closeout.js").__testing;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord830-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = path.join(dir, "governance-events.ndjson");
  assert.equal(readGovernedCommitHead("COORD-830", journal), null, "a missing journal names nothing");
  const event = (ticket, sha, result = "succeeded", command = "commit") => JSON.stringify({ command, ticket, result, details: { source_commit_sha: sha } });
  fs.writeFileSync(journal, [
    event("COORD-830", "a".repeat(40)),
    event("COORD-830", "b".repeat(40)),
    event("COORD-830", "c".repeat(40), "failed"),
    event("COORD-999", "d".repeat(40)),
    event("COORD-830", "e".repeat(40), "succeeded", "land"),
    "{torn source_commit_sha",
    JSON.stringify({ command: "start", ticket: "COORD-830", result: "succeeded" }),
  ].join("\n") + "\n");
  assert.equal(readGovernedCommitHead("COORD-830", journal), "b".repeat(40));
  assert.equal(readGovernedCommitHead("COORD-404", journal), null);
});

// COORD-830 review (third pass), finding 1 (reviewer probe rnopr.js B/C): the
// proof is measured at the reviewed source H1, but the workspace merge lands the
// ticket branch TIP. A manual commit H2 after `gov commit` must not land unmeasured.
function coord830RepoXBranch(t) {
  const { execFileSync } = require("node:child_process");
  const ws = coord830Workspace(t);
  const git = (...args) => execFileSync("git", ["-C", ws.root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const branch = "agent/x-coord-830-refactor";
  git("branch", "-q", branch, ws.reviewed);
  git("checkout", "-q", branch);
  fs.writeFileSync(path.join(ws.root, ws.rel), "void 0;\n".repeat(ws.cap - 1));
  git("commit", "-q", "-am", "COORD-830 manual commit after gov commit (regrown)");
  const manual = git("rev-parse", "HEAD");
  git("checkout", "-q", "dev");
  return { ...ws, git, branch, manual };
}

function coord830RepoXCloseout(ws, extra = {}) {
  const row = { ID: "COORD-830", Repo: "X", Status: "review", Type: "refactor", Description: "decomposition refactor" };
  const board = { pr_index: { "COORD-830": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const planned = [];
  const closeout = coord830Closeout(coord830Gate(ws.root, ws.locksDir, ws.rel, ws.cap), {
    readGovernedCommitHead: () => ws.reviewed,
    resolveSourceCommitOrRefuse: (_t, options) => options.sourceCommit,
    ensureRepoXCloseoutReady: (_t, options) => {
      const tip = ws.git("rev-parse", ws.branch);
      if (typeof options.validatePlannedWorkspaceIntegration === "function") {
        options.validatePlannedWorkspaceIntegration({ currentHeadSha: ws.git("rev-parse", "HEAD"), incomingBranchTips: [{ branch: ws.branch, head_sha: tip }] });
      }
      planned.push(tip);
      throw new Error("stop: the workspace merge would run now");
    },
    ...extra,
  });
  const run = () => closeout.prepareDoneCloseout("COORD-830", board, { row }, { sourceCommit: ws.reviewed, mergeWorkspace: true, layout: { coordRepoRoot: ws.root } });
  return { run, planned };
}

test("COORD-830: a Repo-X workspace merge refuses a ticket-branch tip beyond the measured reviewed source", (t) => {
  const ws = coord830RepoXBranch(t);
  const { run, planned } = coord830RepoXCloseout(ws);
  let refusal = null;
  try { run(); } catch (error) { refusal = error.message; }
  assert.match(refusal, new RegExp(`ticket branch ${ws.branch} is at ${ws.manual}, which is not the ticket's last governed commit ${ws.reviewed}`));
  assert.match(refusal, /would land a commit the proof never measured/);
  assert.match(refusal, /gov return-doing COORD-830 .*gov commit COORD-830 .*--source-commit <the new governed head>/);
  assert.deepEqual(planned, [], "refused before the merge");
  // COORD-830 (fourth pass), finding 4: the save step comes first and keeps the
  // commit beyond review reachable once the branch is moved back.
  const save = new RegExp(`saving the commits beyond the reviewed head \\((git -C ${SHELL_WORD_RE} branch COORD-830-beyond-review-[0-9a-f]{40} [0-9a-f]{40})\\)`).exec(refusal)[1];
  assert.ok(save.endsWith(ws.manual), save);
  const savedAs = save.split(" ").at(-2);
  assert.equal(savedAs, `COORD-830-beyond-review-${ws.manual}`, "the save name carries the tip, so saves never collide");
  runPrintedGitStep(save);
  // The named reset step, executed, makes the next closeout reach the merge.
  const reset = new RegExp(`\\((git -C ${SHELL_WORD_RE} branch -f \\S+ [0-9a-f]{40})\\)`).exec(refusal)[1];
  runPrintedGitStep(reset);
  assert.equal(ws.git("rev-parse", savedAs), ws.manual, "the commit beyond review is not stranded");
  assert.throws(() => run(), /stop: the workspace merge would run now/);
  assert.deepEqual(planned, [ws.reviewed], "the merge lands exactly the measured commit");
});

test("COORD-830: the workspace-merge refusal names the checkout's reset when the ticket branch is checked out", (t) => {
  const ws = coord830RepoXBranch(t);
  const worktree = path.join(path.dirname(ws.root), "ticket-worktree");
  ws.git("worktree", "add", "-q", worktree, ws.branch);
  const { run, planned } = coord830RepoXCloseout(ws);
  let refusal = null;
  try { run(); } catch (error) { refusal = error.message; }
  const reset = new RegExp(`\\((git -C ${SHELL_WORD_RE} reset --keep [0-9a-f]{40})\\)`).exec(refusal)[1];
  assert.ok(reset.includes(worktree), reset);
  runPrintedGitStep(reset);
  assert.throws(() => run(), /stop: the workspace merge would run now/);
  assert.deepEqual(planned, [ws.reviewed]);
});

test("COORD-830: no measured proof leaves the no-PR workspace merge unconstrained", (t) => {
  const ws = coord830RepoXBranch(t);
  const { run, planned } = coord830RepoXCloseout(ws, { assertReviewPlanReady: () => {} });
  assert.throws(() => run(), /stop: the workspace merge would run now/);
  assert.deepEqual(planned, [ws.manual], "a non-refactor closeout is not gated on a measurement it never made");
});

test("COORD-830: on the PR path every incoming tip must be inside what the PR merged", (t) => {
  const { assertIncomingTipsMeasured } = require("./closeout.js").__testing;
  const ws = coord830RepoXBranch(t);
  const squash = ws.git("commit-tree", `${ws.reviewed}^{tree}`, "-p", ws.canonical, "-m", "squash of the PR");
  const merge = ws.git("commit-tree", `${ws.reviewed}^{tree}`, "-p", ws.canonical, "-p", ws.reviewed, "-m", "merge of the PR");
  const measured = { sha: ws.reviewed, label: "the verified PR head" };
  const check = (tip, mergeSha) => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured, repoRoot: ws.root,
    prEvidence: { url: "https://github.com/o/r/pull/1", head_sha: ws.reviewed, merge_sha: mergeSha }, incomingBranchTips: [{ branch: ws.branch, head_sha: tip }] });
  assert.doesNotThrow(() => check(ws.reviewed, merge), "tip equal to the PR head");
  assert.doesNotThrow(() => check(ws.canonical, merge), "tip that is an ancestor of the merge");
  assert.doesNotThrow(() => check(ws.reviewed, squash), "squash merge: tip equal to the PR head");
  assert.throws(() => check(ws.manual, merge), new RegExp(`is at ${ws.manual}, which is not contained in the merged PR https://github.com/o/r/pull/1`));
  assert.throws(() => check(ws.manual, squash), /land the extra commits through their own reviewed PR/);
  assert.doesNotThrow(() => assertIncomingTipsMeasured({ ticketId: "COORD-830", measured: null, repoRoot: ws.root, incomingBranchTips: [{ branch: ws.branch, head_sha: ws.manual }] }));
});

test("COORD-834: with no measured proof every PR-backed incoming tip must still be inside what the PR merged", (t) => {
  const { assertIncomingTipsMeasured } = require("./closeout.js").__testing;
  const ws = coord830RepoXBranch(t);
  const squash = ws.git("commit-tree", `${ws.reviewed}^{tree}`, "-p", ws.canonical, "-m", "squash of the PR");
  const merge = ws.git("commit-tree", `${ws.reviewed}^{tree}`, "-p", ws.canonical, "-p", ws.reviewed, "-m", "merge of the PR");
  const check = (tip, mergeSha) => assertIncomingTipsMeasured({ ticketId: "COORD-834", measured: null, repoRoot: ws.root,
    prEvidence: { url: "https://github.com/o/r/pull/2", head_sha: ws.reviewed, merge_sha: mergeSha }, incomingBranchTips: [{ branch: ws.branch, head_sha: tip }] });
  for (const [mergeSha, shape] of [[merge, "merge commit"], [squash, "squash"]]) {
    assert.doesNotThrow(() => check(ws.reviewed, mergeSha), `${shape}: tip equal to the PR head`);
    assert.doesNotThrow(() => check(mergeSha, mergeSha), `${shape}: tip is the GitHub merge commit`);
    assert.doesNotThrow(() => check(ws.canonical, mergeSha), `${shape}: tip already in the base`);
    assert.throws(() => check(ws.manual, mergeSha), (error) => {
      assert.match(error.message, new RegExp(`ticket branch ${ws.branch} is at ${ws.manual}, which is not contained in the merged PR https://github.com/o/r/pull/2 \\(head ${ws.reviewed}, merge ${mergeSha}\\)`));
      assert.match(error.message, /no review covered/);
      assert.doesNotMatch(error.message, /decomposition proof/);
      assert.match(error.message, new RegExp(`saving the commits beyond the reviewed head \\(git -C ${SHELL_WORD_RE} branch COORD-834-beyond-review-${ws.manual} ${ws.manual}\\)`));
      assert.match(error.message, new RegExp(`resetting the branch to what the PR merged \\(git -C ${SHELL_WORD_RE} branch -f ${ws.branch} ${mergeSha}\\)`));
      return true;
    }, `${shape}: a local commit after the PR head is refused`);
  }
  assert.throws(() => check(ws.manual, null), new RegExp(`branch -f ${ws.branch} ${ws.reviewed}\\)`), "no recorded merge commit: the reset names the PR head");
  assert.doesNotThrow(() => assertIncomingTipsMeasured({ ticketId: "COORD-834", measured: null, repoRoot: ws.root, incomingBranchTips: [{ branch: ws.branch, head_sha: ws.manual }] }),
    "no PR and no proof: the no-PR closeout is unchanged");
});

// COORD-830 review (third pass), finding 2: land hands the head the gate
// measured to the merge, which GitHub then refuses if the PR head moved.
test("COORD-830: land merges with --match-head-commit set to the measured PR head", () => {
  const A = "https://github.com/o/r/pull/1";
  const heads = { [A]: "a".repeat(40) };
  const merges = [];
  const probe = (gate) => require("./closeout.js")({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({ pr_index: { "T-1": [A] }, review_findings: {}, landing_index: {} }),
    getTicketRef: () => ({ row: { ID: "T-1", Repo: "B", Status: "review", Owner: "o" } }),
    inferTicketStatus: () => "review", withGovernanceMutation: (_m, run) => run(), ensureTicketMutationOwnership: () => ({}),
    getRepoRoot: () => "/nonexistent", resolveCommitishInRepo: (_r, sha) => sha, isRepoBackedCode: () => true,
    findOutstandingCloseoutBlockerFollowups: () => [], findLockForTicket: () => null,
    verifyPrEvidence: (_t, refs) => refs.map((ref) => ({ ref, payload: { state: "OPEN", headRefOid: heads[ref] } })),
    assertReviewPlanReady: gate,
    prMerge: (_t, options) => { merges.push(options.matchHeadCommit); throw new Error("stop at merge"); },
  });
  assert.throws(() => probe((_t, _row, ctx) => ctx.resolveReviewedSource()).landTicket("T-1", { pr: A, sourceCommit: heads[A] }), /stop at merge/);
  assert.deepEqual(merges, [heads[A]], "the measured head is the head the merge must match");
  assert.throws(() => probe(() => {}).landTicket("T-1", { pr: A }), /stop at merge/);
  assert.deepEqual(merges, [heads[A], undefined], "no measurement: mergePrUrl pins the head it viewed instead");
});

// COORD-830 review (third pass), finding 3 (reviewer probe rnopr.js case A): a
// no-PR ticket whose work was committed by hand has no recorded landing source
// and no governed commit. The recovery must create that provenance, never name
// a "<reviewed PR head sha>" no value can satisfy; once the named governed
// commit exists, the next closeout is accepted.
test("COORD-830: a no-PR ticket with no provenance is told how to create it, and the next closeout is accepted", (t) => {
  const os = require("node:os");
  const { collectDecompositionProofIssues } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/decomposition-proof-gate.js"));
  const { readGovernedCommitHead } = require("./closeout.js").__testing;
  const { root, locksDir, rel, cap, reviewed } = coord830Workspace(t);
  const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coord830-journal-")), "governance-events.ndjson");
  t.after(() => fs.rmSync(path.dirname(journal), { recursive: true, force: true }));
  const row = { ID: "COORD-830", Repo: "B", Status: "review", Type: "refactor", Description: "decomposition refactor" };
  const board = { pr_index: { "COORD-830": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} };
  const gate = (ticketId, gateRow, context) => {
    const issues = collectDecompositionProofIssues({ ticketId, row: gateRow, coordDir: path.join(root, "coord"), locksDir, repoRoot: path.join(root, "coord"),
      planState: { repo_gates: [`decomposition-proof: file=${rel}; before=${cap}; after=${cap - 68}; claimed_reduction=68; target_max=${cap}; extracted=helpers moved`] },
      sourceCommit: context.sourceCommit, resolveReviewedSource: context.resolveReviewedSource });
    if (issues.length > 0) throw Object.assign(new Error(issues.map((issue) => issue.message).join(" | ")), { steps: issues.flatMap((issue) => issue.next_steps) });
  };
  const closeout = coord830Closeout(gate, { readGovernedCommitHead: (ticketId) => readGovernedCommitHead(ticketId, journal) });
  const refusalFor = (options) => {
    try { closeout.prepareDoneCloseout("COORD-830", board, { row }, options); } catch (error) { return error; }
    return assert.fail("expected a refusal");
  };
  for (const options of [{ sourceCommit: reviewed }, {}]) {
    const refusal = refusalFor(options);
    assert.ok(!refusal.steps.join("\n").includes("<reviewed PR head sha>"), refusal.steps.join("\n"));
    assert.match(refusal.message, /create governed provenance for the reviewed head first/);
    assert.match(refusal.steps.join("\n"), /gov return-doing COORD-830 [\s\S]*gov commit COORD-830 [\s\S]*gov finalize COORD-830 --no-pr --source-commit <head printed by gov commit>/);
  }
  // Execute the named step's durable effect: `gov commit` journals exactly this
  // event (ticket-commands.js: details.source_commit_sha = the new head).
  fs.writeFileSync(journal, `${JSON.stringify({ command: "commit", ticket: "COORD-830", result: "succeeded", details: { source_commit_sha: reviewed } })}\n`);
  assert.doesNotThrow(() => closeout.prepareDoneCloseout("COORD-830", board, { row }, { sourceCommit: reviewed }));
  // Without --source-commit the refusal now names the head to pass.
  // COORD-830 (fourth pass), finding 5: with the --no-pr flag this ticket needs,
  // and no land step (land is for a PR-backed ticket).
  const named = refusalFor({}).steps;
  assert.ok(named.includes(`coord/scripts/gov finalize COORD-830 --no-pr --source-commit ${reviewed}`), named.join("\n"));
  assert.ok(!named.some((step) => step.startsWith("coord/scripts/gov land ")), named.join("\n"));
});

// COORD-830 review (fourth pass), finding 2 (reviewer probe rsoft.sh): the
// no-provenance recovery's soft reset, read literally as "reset onto the
// integration branch", made the governed commit silently revert another
// ticket's later change to the same file. The printed step must re-parent onto
// the fork point; executed here, the other ticket's change survives the merge.
test("COORD-830: the no-provenance recovery's soft reset keeps another ticket's later change to a shared file", (t) => {
  const os = require("node:os");
  const { execSync } = require("node:child_process");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord830-soft-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"), wt = path.join(base, "wt");
  fs.mkdirSync(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const file = (dir) => path.join(dir, "big.js");
  git(root, "init", "-q", "-b", "dev");
  fs.writeFileSync(file(root), "a1\nm1\nm2\nm3\nshared-top\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "worktree", "add", "-q", "-b", "agent/b-t-1", wt);
  fs.writeFileSync(file(wt), "a1-refactored\nm1\nm2\nm3\nshared-top\n");
  git(wt, "commit", "-qam", "manual T-1 commit");
  fs.writeFileSync(file(root), "a1\nm1\nm2\nm3\nshared-top-OTHER-TICKET-FIX\n");
  git(root, "commit", "-qam", "other ticket lands on dev");

  let resolved;
  coord830Closeout((_t, _row, ctx) => { resolved = ctx.resolveReviewedSource(); }, { readGovernedCommitHead: () => null })
    .prepareDoneCloseout("T-1", { pr_index: { "T-1": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} }, { row: { Repo: "B", Status: "review" } }, {});
  const reset = resolved.recovery.find((step) => step.includes("reset --soft"));
  // COORD-830 (fifth pass): the hand-made commits are saved before the soft reset moves the branch.
  const keep = resolved.recovery.find((step) => step.includes("-before-provenance"));
  assert.ok(resolved.recovery.indexOf(keep) < resolved.recovery.indexOf(reset), "the save precedes the reset");
  const manualHead = git(wt, "rev-parse", "HEAD");
  execSync(keep.split("  #")[0].replaceAll("<ticket worktree>", shellQuote(wt)), { shell: "/bin/bash" });
  assert.equal(reset.split("  #")[0], 'b="dev"; case "$b" in ""|agent/*) echo "refused: the integration checkout must be on its integration branch, not \'$b\'" >&2; false;; esac' +
    ' && f=$(git -C <ticket worktree> merge-base HEAD "$b") && [ -n "$f" ] && git -C <ticket worktree> reset --soft "$f"', "the fork point of the named integration branch");
  assert.equal(resolved.recovery.at(-1), "coord/scripts/gov finalize T-1 --no-pr --source-commit <head printed by gov commit>");

  execSync(reset.split("  #")[0].replaceAll("<ticket worktree>", shellQuote(wt)), { shell: "/bin/bash" });
  git(wt, "commit", "-qm", "T-1 governed commit"); // the durable effect of `gov commit --all`
  assert.equal(git(wt, "rev-parse", `T-1-before-provenance-${manualHead.slice(0, 12)}`), manualHead, "the hand-made commits stay reachable");
  assert.equal(git(wt, "rev-parse", "HEAD^"), git(root, "rev-parse", "dev^"), "re-parented onto the fork point");
  git(root, "merge", "-q", "--no-ff", "--no-edit", "agent/b-t-1");
  assert.equal(fs.readFileSync(file(root), "utf8"), "a1-refactored\nm1\nm2\nm3\nshared-top-OTHER-TICKET-FIX\n", "both the ticket's change and the other ticket's change survive");

  const { resolveControlPlaneIntegrationBranch, defaultControlPlaneLayout } = require("./control-plane-paths.js");
  const xSteps = (() => {
    let steps;
    try {
      coord830Closeout((_t, _row, ctx) => { steps = ctx.resolveReviewedSource().recovery; throw new Error("stop"); }, { readGovernedCommitHead: () => null })
        .prepareDoneCloseout("T-3", { pr_index: { "T-3": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} }, { row: { Repo: "X", Status: "review" } }, {});
    } catch { /* stop */ }
    return steps;
  })();
  // COORD-830 (fifth and sixth pass): a Repo-X fork point is resolved against the
  // branch the workspace merge lands on (the integration checkout's branch), never
  // origin/HEAD, and the step refuses a detached or ticket-branch checkout. Run the
  // printed steps for real against a fixture integration checkout.
  const coordRoot = defaultControlPlaneLayout().coordRepoRoot;
  assert.ok(xSteps[2].includes(`b="$(${formatGitCommand(coordRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])})"`), xSteps[2]);
  const xRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord830-x-fork-"));
  t.after(() => fs.rmSync(xRoot, { recursive: true, force: true }));
  git(xRoot, "init", "-q", "-b", "integration");
  git(xRoot, "config", "user.email", "t@example.invalid"); git(xRoot, "config", "user.name", "t");
  fs.writeFileSync(file(xRoot), "a1\nm1\nm2\nm3\nshared-top\n");
  git(xRoot, "add", "-A"); git(xRoot, "commit", "-qm", "base");
  const xWt = path.join(xRoot, "wt-t3");
  git(xRoot, "worktree", "add", "-q", "-b", "agent/x-t-3", xWt);
  fs.writeFileSync(file(xWt), "a1-refactored\nm1\nm2\nm3\nshared-top\n");
  git(xWt, "commit", "-qam", "manual T-3 commit");
  fs.writeFileSync(file(xRoot), "a1\nm1\nm2\nm3\nshared-top-OTHER-TICKET-FIX\n");
  git(xRoot, "commit", "-qam", "other ticket lands on the integration branch");
  const runX = (step) => spawnSync("/bin/bash", ["-c", step.split("  #")[0].replaceAll(shellQuote(coordRoot), shellQuote(xRoot)).replaceAll("<ticket worktree>", shellQuote(xWt))], { encoding: "utf8" });
  const manualX = git(xWt, "rev-parse", "HEAD");
  git(xRoot, "checkout", "-q", "--detach");
  const detached = runX(xSteps[2]);
  assert.notEqual(detached.status, 0, "a detached integration checkout is refused");
  assert.match(detached.stderr, /refused: the integration checkout must be on its integration branch, not ''/);
  git(xRoot, "checkout", "-q", "-b", "agent/other-ticket");
  const onTicket = runX(xSteps[2]);
  assert.notEqual(onTicket.status, 0, "a ticket-branch integration checkout is refused");
  assert.match(onTicket.stderr, /not 'agent\/other-ticket'/);
  assert.equal(git(xWt, "rev-parse", "HEAD"), manualX, "a refused step leaves the ticket branch untouched");
  git(xRoot, "checkout", "-q", "integration");
  assert.equal(runX(xSteps[1]).status, 0);
  assert.equal(git(xWt, "rev-parse", `T-3-before-provenance-${manualX.slice(0, 12)}`), manualX);
  assert.equal(runX(xSteps[2]).status, 0, "the integration checkout on its branch re-parents");
  git(xWt, "commit", "-qm", "T-3 governed commit");
  assert.equal(git(xWt, "rev-parse", "HEAD^"), git(xRoot, "rev-parse", "integration^"), "re-parented onto the fork point");
  git(xRoot, "merge", "-q", "--no-ff", "--no-edit", "agent/x-t-3");
  assert.equal(fs.readFileSync(file(xRoot), "utf8"), "a1-refactored\nm1\nm2\nm3\nshared-top-OTHER-TICKET-FIX\n", "both changes survive the Repo-X merge");
  assert.equal(typeof resolveControlPlaneIntegrationBranch, "function");
  assert.equal(xSteps.at(-1), "coord/scripts/gov finalize T-3 --no-pr --merge-workspace --source-commit <head printed by gov commit>");
});

// COORD-830 review (fourth pass), finding 5: the no-PR tip validator must be
// attached whether or not a measurement existed when the readiness options were
// built; it reads measuredSources itself when the merge is planned. Here only
// the readiness re-run (the workspace-integration validation) measures.
test("COORD-830: the no-PR tip validator reads the measurement made by the readiness re-run", (t) => {
  const ws = coord830RepoXBranch(t);
  let calls = 0;
  const gate = coord830Gate(ws.root, ws.locksDir, ws.rel, ws.cap);
  const { run, planned } = coord830RepoXCloseout(ws, { assertReviewPlanReady: (ticketId, row, ctx) => { calls += 1; if (calls > 1) gate(ticketId, row, ctx); } });
  assert.throws(() => run(), new RegExp(`ticket branch ${ws.branch} is at ${ws.manual}, which is not the ticket's last governed commit ${ws.reviewed}`));
  assert.equal(calls, 2, "the first readiness measured nothing; the re-run did");
  assert.deepEqual(planned, [], "refused before the merge");
});

// COORD-830 review (fourth pass), finding 5: the gate's re-run steps carry the
// flags the ticket's closeout needs, and land only where land applies.
test("COORD-830: decomposition-proof recovery names the closeout flags each ticket shape needs", (t) => {
  const { root, locksDir, rel, cap, reviewed } = coord830Workspace(t);
  const pr = ["https://github.com/o/r/pull/1"], noPr = ["local-review (no PR)"];
  const gateSteps = (Repo, refs) => {
    const { collectDecompositionProofIssues } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/decomposition-proof-gate.js"));
    let captured;
    try {
      coord830Closeout((_t, _row, ctx) => { captured = ctx.resolveReviewedSource; throw new Error("stop"); }, {
        readGovernedCommitHead: () => reviewed,
        verifyPrEvidence: (_t, urls) => urls.map((ref) => ({ ref, payload: { headRefOid: reviewed } })),
      }).prepareDoneCloseout("COORD-830", { pr_index: { "COORD-830": refs }, review_findings: {}, landing_index: {} }, { row: { Repo, Status: "review" } }, {});
    } catch { /* stop */ }
    return collectDecompositionProofIssues({ ticketId: "COORD-830", row: { Type: "refactor", Description: "decomposition refactor" },
      planState: { repo_gates: [`decomposition-proof: file=${rel}; before=${cap}; after=${cap - 68}; claimed_reduction=68; target_max=${cap}; extracted=helpers moved`] },
      coordDir: path.join(root, "coord"), locksDir, repoRoot: path.join(root, "coord"), sourceCommit: "dev", resolveReviewedSource: captured })[0].next_steps;
  };
  assert.deepEqual(gateSteps("B", pr), [`coord/scripts/gov finalize COORD-830 --source-commit ${reviewed}`, `coord/scripts/gov land COORD-830 --source-commit ${reviewed}`]);
  assert.deepEqual(gateSteps("B", noPr), [`coord/scripts/gov finalize COORD-830 --no-pr --source-commit ${reviewed}`]);
  assert.deepEqual(gateSteps("X", pr), [`coord/scripts/gov finalize COORD-830 --merge-workspace --source-commit ${reviewed}`]);
  assert.deepEqual(gateSteps("X", noPr), [`coord/scripts/gov finalize COORD-830 --no-pr --merge-workspace --source-commit ${reviewed}`]);
});

// The merge-independent closeout preconditions each refuse on their own, in
// order, before any PR evidence is verified.
test("COORD-830: merge-independent closeout preconditions refuse a non-review ticket, open findings, and open closeout blockers", () => {
  const { FINDING_STATUS } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-constants.js"));
  const board = (extra = {}) => ({ pr_index: { "COORD-830": ["local-review (no PR)"] }, review_findings: {}, landing_index: {}, ...extra });
  const verified = [];
  const probe = (extra = {}) => coord830Closeout(() => {}, {
    verifyPrEvidence: (ticketId) => { verified.push(ticketId); throw new Error("stop at PR evidence"); },
    ...extra,
  });

  let gateCalls = 0;
  assert.throws(() => coord830Closeout(() => { gateCalls += 1; }).prepareDoneCloseout("COORD-830", board(), { row: { Repo: "B", Status: "doing" } }, {}),
    /Ticket COORD-830 must be in review; current status is "doing"\./);
  assert.equal(gateCalls, 0, "a non-review ticket is refused before the readiness gate");

  assert.throws(() => probe().prepareDoneCloseout("COORD-830",
    board({ review_findings: { "COORD-830": [{ status: FINDING_STATUS.OPEN }, { status: "resolved" }] } }), { row: { Repo: "B", Status: "review" } }, {}),
  /Ticket COORD-830 still has open review findings\./);

  assert.throws(() => probe({
    findOutstandingCloseoutBlockerFollowups: (_board, ticketId) => (ticketId === "COORD-830" ? [{ ID: "COORD-901", Status: "doing" }, { ID: "COORD-902", Status: "todo" }] : []),
  }).prepareDoneCloseout("COORD-830", board({ review_findings: { "COORD-830": [{ status: "resolved" }] } }), { row: { Repo: "B", Status: "review" } }, {}),
  /cannot close while closeout-blocker follow-up tickets remain open: COORD-901 \(doing\), COORD-902 \(todo\)\./);

  assert.deepEqual(verified, [], "every refusal precedes PR-evidence verification");
  assert.throws(() => probe().prepareDoneCloseout("COORD-830", board(), { row: { Repo: "B", Status: "review" } }, {}), /stop at PR evidence/,
    "with every precondition met the closeout proceeds to PR evidence");
});

test("COORD-830: the no-PR resolver reads the engine journal when no reader is injected", () => {
  let resolved;
  const closeout = coord830Closeout((_t, _row, ctx) => { resolved = ctx.resolveReviewedSource(); throw new Error("stop"); });
  assert.throws(() => closeout.prepareDoneCloseout("NOPROV-831", { pr_index: { "NOPROV-831": ["local-review (no PR)"] }, landing_index: {} },
    { row: { Repo: "B", Status: "review" } }, { sourceCommit: "a".repeat(40) }), /stop/);
  assert.equal(resolved.sha, null, "the engine journal records no governed commit for this ticket");
  assert.equal(resolved.label, "the ticket's last governed commit");
  assert.match(resolved.reason, /no PR, recorded landing source, or governed commit names the reviewed head of NOPROV-831/);
  assert.match(resolved.recovery.join("\n"), /gov return-doing NOPROV-831 /, "no journalled governed commit: provenance-creating steps");
});

// COORD-834 review: a fulfilled-by closeout of a ticket with a recorded PR used
// to skip the PR containment check (no verified PR evidence was built), so the
// workspace merge landed a ticket-branch commit made after the reviewed PR head.
function coord834FulfilledByBeyond({ ctx, ticket, runGit }) {
  const feature = path.join(ctx.coordRoot, ".worktrees", "claudea0000", ticket);
  fs.writeFileSync(path.join(feature, "docs", "unreviewed.txt"), "after the PR head\n");
  runGit(feature, "add", "docs/unreviewed.txt");
  runGit(feature, "commit", "-m", "local commit after the reviewed PR head");
  return { feature, beyond: runGit(feature, "rev-parse", "HEAD") };
}

for (const withPrFlag of [true, false]) {
  test(`COORD-834: a fulfilled-by finalize with a recorded PR refuses a ticket-branch commit beyond the PR merge${withPrFlag ? " (--pr given)" : ""}`, () => {
    withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, head, githubMerge, attempt }) => {
      runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
      const { beyond } = coord834FulfilledByBeyond({ ctx, ticket, runGit });
      const localBefore = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
      const remoteBefore = runGit(remote, "rev-parse", "refs/heads/dev");
      const args = ["finalize", ticket, ...(withPrFlag ? ["--pr", prUrl] : []), "--fulfilled-by-commit", githubMerge,
        "--merge-workspace", "--push-before-closeout", "--base", "dev"];
      const refused = attempt(args);
      assert.equal(refused.ok, false, JSON.stringify(refused));
      const refusal = String(refused.error || "");
      assert.match(refusal, new RegExp(`is at ${beyond}, which is not contained in the merged PR`), refusal);
      assert.match(refusal, new RegExp(`\\(head ${head}, merge ${githubMerge}\\)`), refusal);
      assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
      assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localBefore, "refused before any workspace merge");
      assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBefore, "refused before any publication");
    });
  });
}

test("COORD-834: a clean fulfilled-by finalize with a recorded PR merges a tip inside what the PR merged", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, head, githubMerge, attempt }) => {
    // Squash shape: local dev carries the GitHub merge, and the ticket branch
    // sits at the reviewed PR head, which is inside what the PR merged.
    runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
    runGit(path.join(ctx.coordRoot, ".worktrees", "claudea0000", ticket), "reset", "--hard", head);
    const args = ["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"];
    const accepted = attempt(args);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.equal(runGit(ctx.coordRoot, "merge-base", "--is-ancestor", head, "refs/heads/dev"), "", "the contained tip was merged");
  });
});

test("COORD-834: an unverifiable recorded PR refuses a fulfilled-by workspace merge instead of skipping the check", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, payload, active, githubMerge, attempt }) => {
    runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
    coord834FulfilledByBeyond({ ctx, ticket, runGit });
    active.payload = { ...payload, mergeCommit: { oid: "f".repeat(40) } };
    const localBefore = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
    const remoteBefore = runGit(remote, "rev-parse", "refs/heads/dev");
    const refused = attempt(["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /the recorded PR \S+ cannot be verified \(the PR head [0-9a-f]{40} or GitHub merge f{40} does not resolve/);
    assert.match(String(refused.error), new RegExp(`Recover by fetching the PR's commits \\(git -C ${SHELL_WORD_RE} fetch origin\\)`));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localBefore, "refused before any workspace merge");
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBefore, "refused before any publication");
  });
});

test("COORD-834: recorded-PR containment resolves the PR head and merge, and names why it cannot", (t) => {
  const { resolveRecordedPrContainment } = require("./closeout.js").__testing;
  const ws = coord830Workspace(t);
  const url = "https://github.com/acme/widget/pull/834";
  const pr = (extra) => ({ ref: url, payload: { headRefOid: ws.reviewed, mergeCommit: { oid: ws.canonical }, ...extra } });
  assert.deepEqual(resolveRecordedPrContainment({ ticketId: "COORD-834", prRefs: [url], verifiedPrs: [pr()], repoRoot: ws.root }),
    { evidence: { url, head_sha: ws.reviewed, merge_sha: ws.canonical } });
  assert.deepEqual(resolveRecordedPrContainment({ ticketId: "COORD-834", prRefs: [url], verifiedPrs: [pr({ mergeCommit: ws.canonical })], repoRoot: ws.root }).evidence.merge_sha, ws.canonical, "a bare merge OID string is read too");
  for (const [label, prRefs, verifiedPrs, pattern] of [
    ["no verified PR", [url], undefined, /found 1 recorded and 0 verified/],
    ["two recorded PRs", [url, `${url}5`], [pr()], /found 2 recorded and 1 verified/],
    ["missing merge", [url], [pr({ mergeCommit: null })], /GitHub merge \(missing\) does not resolve/],
    ["missing head", [url], [pr({ headRefOid: undefined })], /the PR head \(missing\) or GitHub merge/],
  ]) {
    const result = resolveRecordedPrContainment({ ticketId: "COORD-834", prRefs, verifiedPrs, repoRoot: ws.root });
    assert.equal(result.evidence, undefined, label);
    assert.match(result.error, pattern, label);
    assert.match(result.error, /coord\/scripts\/gov set-pr COORD-834 --pr <url> --replace/, label);
  }
});

test("COORD-834: an unverifiable recorded PR does not block a fulfilled-by closeout with nothing to merge", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, payload, active, githubMerge, attempt }) => {
    runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
    active.payload = { ...payload, mergeCommit: { oid: "f".repeat(40) } };
    const accepted = attempt(["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), githubMerge);
  });
});

// COORD-855: a refused finalize --pr with changed refs must leave the board,
// journal, snapshot, and plan exactly as they were before preflight.
function coord843GovernanceBytes(ticketId = null, ctx = null) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  return {
    journal: read(governanceState.GOVERNANCE_EVENT_LOG_PATH),
    snapshot: read(governanceState.GOVERNANCE_SNAPSHOT_PATH),
    plan: ticketId && ctx ? read(path.join(ctx.planRecordsDir, `${ticketId}.json`)) : null,
  };
}
function assertCoord843Unchanged(before, label, ticketId = null, ctx = null) {
  const after = coord843GovernanceBytes(ticketId, ctx);
  assert.ok(before.journal && before.snapshot, `${label}: the fixture has a journal and a snapshot to compare`);
  assert.ok(after.journal && before.journal.equals(after.journal), `${label}: the journal is byte-identical`);
  assert.ok(after.snapshot && before.snapshot.equals(after.snapshot), `${label}: the snapshot is byte-identical`);
  if (before.plan) assert.ok(after.plan && before.plan.equals(after.plan), `${label}: the plan is byte-identical`);
}

test("COORD-843: a refused finalize --pr leaves the journal and snapshot byte-identical", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, source, githubMerge, attempt }) => {
    assert.equal(runGit(path.join(ctx.coordRoot, ".worktrees", "claudea0000", ticket), "rev-parse", "HEAD"), githubMerge);
    coord834FulfilledByBeyond({ ctx, ticket, runGit });
    const unrecorded = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    delete unrecorded.pr_index[ticket];
    __testing.writeBoard(unrecorded);
    __testing.advanceGovernanceProvenanceBaseline("coord855-changed-ref-containment-fixture");
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const before = coord843GovernanceBytes(ticket, ctx);
    const refused = attempt(["finalize", ticket, "--pr", prUrl, "--source-commit", source, "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /which is not contained in the merged PR/, String(refused.error));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "the board is byte-identical");
    assertCoord843Unchanged(before, "refused finalize --pr", ticket, ctx);
  });
});

test("COORD-843: samePrRefs compares recorded evidence by normalised PR key and exact non-PR text", () => {
  const { samePrRefs } = require("./closeout.js").__testing;
  const A = "https://github.com/o/r/pull/1";
  assert.equal(samePrRefs([A], [A]), true);
  assert.equal(samePrRefs([`${A}/`, "fulfilled by COORD-1"], ["fulfilled by COORD-1", "HTTPS://GITHUB.COM/O/R/PULL/1"]), true, "order and PR spelling do not matter");
  assert.equal(samePrRefs([A], [A, "fulfilled by COORD-1"]), false, "a narrower set is a change");
  assert.equal(samePrRefs([A], ["https://github.com/o/r/pull/2"]), false);
  assert.equal(samePrRefs([A], []), false, "nothing recorded: the refs must be recorded");
  assert.equal(samePrRefs([A], undefined), false);
  assert.equal(samePrRefs(undefined, [A]), false);
});

// COORD-843 (3): the same PR recorded under two spellings was refused as two.
test("COORD-843: recorded-PR containment counts one PR recorded under several spellings once", (t) => {
  const { resolveRecordedPrContainment } = require("./closeout.js").__testing;
  const ws = coord830Workspace(t);
  const url = "https://github.com/acme/widget/pull/834";
  const payload = { headRefOid: ws.reviewed, mergeCommit: { oid: ws.canonical } };
  const variants = [url, "https://github.com/ACME/Widget/pull/834", `${url}/`, "https://github.com/acme/widget/pulls/834"];
  const expected = { evidence: { url, head_sha: ws.reviewed, merge_sha: ws.canonical } };
  assert.deepEqual(resolveRecordedPrContainment({ ticketId: "COORD-843", prRefs: variants, verifiedPrs: [{ ref: variants[1], payload }], repoRoot: ws.root }), expected,
    "four spellings of one PR are one recorded PR, matched to a verified entry in yet another spelling");
  assert.deepEqual(resolveRecordedPrContainment({ ticketId: "COORD-843", prRefs: [url, variants[2]], verifiedPrs: variants.map((ref) => ({ ref, payload })), repoRoot: ws.root }), expected,
    "one PR verified under several spellings is one verified PR");
  const two = resolveRecordedPrContainment({ ticketId: "COORD-843", prRefs: [variants[1], "https://github.com/acme/widget/pull/835"], verifiedPrs: [{ ref: url, payload }], repoRoot: ws.root });
  assert.match(two.error, /found 2 recorded and 1 verified/, "two distinct PRs are still two");
  assert.match(two.error, /the recorded PR https:\/\/github\.com\/ACME\/Widget\/pull\/834, https:\/\/github\.com\/acme\/widget\/pull\/835 cannot be verified/);
  const unrelated = resolveRecordedPrContainment({ ticketId: "COORD-843", prRefs: [url], verifiedPrs: [null, { ref: url }, { ref: "local-review (no PR)", payload }], repoRoot: ws.root });
  assert.match(unrelated.error, /found 1 recorded and 0 verified/, "entries without a payload or for a non-PR ref verify nothing");
});

// COORD-843 (2): a small repository whose local dev carries a PR merge and the
// commits the local-base rule must judge.
function coord843LocalBase(t) {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord843-local-base-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "workspace"), remote = path.join(base, "origin.git");
  fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "dev");
  const baseline = commit({ "src/app.js": "v0\n", "board/tasks.json": "{}\n" }, "baseline");
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "dev");
  git("checkout", "-q", "-b", "agent/coord-843");
  const head = commit({ "src/app.js": "v1\n", "src/new file.js": "added\n" }, "PR head");
  git("checkout", "-q", "dev");
  const squash = git("commit-tree", `${head}^{tree}`, "-p", baseline, "-m", "GitHub squash merge");
  git("merge", "-q", "--ff-only", squash);
  git("push", "-q", "origin", "dev");
  const prEvidence = { url: "https://github.com/acme/widget/pull/843", head_sha: head, merge_sha: squash };
  const closeoutTesting = require("./closeout.js").__testing;
  const find = (extra = {}) => closeoutTesting.findUnreviewedLocalBaseCommits({
    ticketId: "COORD-843", repoRoot: root, baseBranch: "dev", prEvidence, landingIndex: {}, ...extra,
  });
  return { root, git, commit, baseline, head, squash, prEvidence, find };
}

test("COORD-843: the local-base rule refuses only unpublished non-merge commits touching the PR's files", (t) => {
  const ws = coord843LocalBase(t);
  assert.deepEqual(ws.find(), [], "local dev equal to the published PR merge carries nothing unreviewed");
  ws.commit({ "board/tasks.json": "{\"rows\":1}\n", "journal.ndjson": "{}\n" }, "board-only sync commit");
  assert.deepEqual(ws.find(), [], "an unpublished governed-artifact commit does not touch the PR's files");
  ws.commit({ "src/other.js": "unrelated\n" }, "unrelated code commit");
  assert.deepEqual(ws.find(), [], "a commit outside the PR's files is not this PR's review gap");
  const hand = ws.commit({ "src/new file.js": "changed by hand\n" }, "unreviewed hand edit after the PR merge");
  assert.deepEqual(ws.find(), [{ sha: hand, files: ["src/new file.js"] }], "a hand commit on a PR file is found, with the file it touched");
  assert.deepEqual(ws.find({ landingIndex: { "COORD-1": { commit_sha: hand }, "COORD-2": { commit_sha: "not-a-sha" }, "COORD-3": null, "COORD-4": { commit_sha: "f".repeat(40) }, "COORD-5": {} } }), [],
    "a commit inside another ticket's recorded landing was reviewed by that closeout; malformed and unknown landings are ignored");
  assert.deepEqual(ws.find({ landingIndex: { "COORD-843": { commit_sha: hand } } }), [{ sha: hand, files: ["src/new file.js"] }],
    "the ticket's own landing record does not excuse its own local commit");
  assert.deepEqual(ws.find({ landingIndex: null }).map((commit) => commit.sha), [hand], "a board with no landing index excuses nothing");
  ws.git("push", "-q", "origin", `${hand}:refs/heads/agent/coord-843`);
  ws.git("fetch", "-q", "origin");
  assert.deepEqual(ws.find().map((commit) => commit.sha), [hand],
    "a commit pushed only to a ticket branch on the remote is still unreviewed");
  ws.git("push", "-q", "origin", "dev");
  ws.git("fetch", "-q", "origin");
  assert.deepEqual(ws.find(), [], "a commit in the remote integration branch's history is not judged here");
});

test("COORD-855: local-base allows only an exact stable patch-id cherry-pick from the verified PR range", (t) => {
  const exact = coord843LocalBase(t);
  exact.git("branch", "local-dev", exact.baseline);
  exact.git("checkout", "-q", "local-dev");
  exact.git("cherry-pick", "-x", exact.head);
  const cherryPick = exact.git("rev-parse", "HEAD");
  assert.deepEqual(exact.find({ baseBranch: "local-dev" }), [],
    `the reviewed source patch ${exact.head} and cherry-pick -x ${cherryPick} have the same stable patch-id`);

  const altered = coord843LocalBase(t);
  altered.git("branch", "local-dev", altered.baseline);
  altered.git("checkout", "-q", "local-dev");
  altered.git("cherry-pick", "--no-commit", altered.head);
  fs.appendFileSync(path.join(altered.root, "src/app.js"), "// altered after cherry-pick\n");
  altered.git("add", "src/app.js");
  altered.git("commit", "-q", "-m", `cherry-pick: ${altered.head}`);
  const alteredCherryPick = altered.git("rev-parse", "HEAD");
  assert.deepEqual(altered.find({ baseBranch: "local-dev" }).map((entry) => entry.sha), [alteredCherryPick],
    "a cherry-pick trailer does not excuse content whose patch-id differs");

  const unavailable = (_root, args, options) => {
    if (args[0] === "patch-id") return { status: 0, stdout: "ambiguous patch identity\n", stderr: "" };
    return require("./git-ops.js").gitTry(_root, args, options);
  };
  assert.deepEqual(exact.find({ baseBranch: "local-dev", git: unavailable }).map((entry) => entry.sha), [cherryPick],
    "ambiguous patch-id output fails closed and leaves the local commit reportable");
});

test("COORD-855: patch identity uses the unique merge-base for divergent merge and squash topology", (t) => {
  for (const topology of ["merge", "squash"]) {
    const ws = coord856Repo(t, `coord855-divergent-${topology}`);
    const base = ws.commit(ws.root, "reviewed.txt", "base\n", "base B");
    ws.commit(ws.root, "other.txt", "base other\n", "base other");
    ws.git(ws.root, "branch", "feature");
    ws.git(ws.root, "checkout", "-q", "feature");
    const reviewedHead = ws.commit(ws.root, "reviewed.txt", "reviewed patch\n", "reviewed P");
    ws.git(ws.root, "checkout", "-q", "dev");
    ws.commit(ws.root, "other.txt", "base other plus U\n", "base advances U");
    let githubMerge;
    if (topology === "merge") {
      ws.git(ws.root, "merge", "--no-ff", "-m", "GitHub merge M", "feature");
      githubMerge = ws.git(ws.root, "rev-parse", "HEAD");
    } else {
      ws.git(ws.root, "merge", "--squash", "feature");
      ws.git(ws.root, "commit", "-q", "-m", "GitHub squash M");
      githubMerge = ws.git(ws.root, "rev-parse", "HEAD");
    }
    ws.git(ws.root, "branch", "local-dev", base);
    ws.git(ws.root, "checkout", "-q", "local-dev");
    ws.git(ws.root, "cherry-pick", "-x", reviewedHead);
    const cherryPick = ws.git(ws.root, "rev-parse", "HEAD");
    const prEvidence = {
      url: `https://github.com/acme/widget/pull/855`,
      head_sha: reviewedHead,
      merge_sha: githubMerge,
    };
    const find = (extra = {}) => closeoutTesting.findUnreviewedLocalBaseCommits({
      repoRoot: ws.root,
      baseBranch: "local-dev",
      prEvidence,
      landingIndex: {},
      ticketId: "COORD-855",
      ...extra,
    });
    assert.deepEqual(find(), [], `${topology} topology recognizes exact cherry-pick ${cherryPick} of ${reviewedHead}`);
    const ambiguousBase = (_root, args, options) => args[0] === "merge-base" && args[1] === "--all"
      ? { status: 0, stdout: `${base}\n${reviewedHead}\n`, stderr: "" }
      : require("./git-ops.js").gitTry(_root, args, options);
    assert.deepEqual(find({ git: ambiguousBase }).map(({ sha }) => sha), [cherryPick],
      `${topology} topology fails closed when Git reports multiple merge-bases`);
    ws.git(ws.root, "reset", "-q", "--hard", base);
    ws.git(ws.root, "cherry-pick", "--no-commit", reviewedHead);
    fs.appendFileSync(path.join(ws.root, "reviewed.txt"), "altered\n");
    ws.git(ws.root, "add", "reviewed.txt");
    ws.git(ws.root, "commit", "-q", "-m", `altered copy of ${reviewedHead}`);
    const altered = ws.git(ws.root, "rev-parse", "HEAD");
    assert.deepEqual(find().map(({ sha }) => sha), [altered], `${topology} topology does not excuse a changed patch`);
  }
});

test("COORD-855: missing or ambiguous Git proof never excuses an exact-looking local patch", (t) => {
  const ws = coord843LocalBase(t);
  ws.git("branch", "local-dev", ws.baseline);
  ws.git("checkout", "-q", "local-dev");
  ws.git("cherry-pick", "-x", ws.head);
  const offender = ws.git("rev-parse", "HEAD");
  const mergeParent = ws.git("rev-parse", `${ws.squash}^1`);
  const realGit = require("./git-ops.js").gitTry;
  const wrapped = (intercept) => (_root, args, options) => intercept(_root, args, options) || realGit(_root, args, options);
  const cases = [
    ["missing reviewed head", { prEvidence: { ...ws.prEvidence, head_sha: undefined } }, null],
    ["malformed reviewed head", { prEvidence: { ...ws.prEvidence, head_sha: "not-a-full-oid" } }, null],
    ["merge first-parent resolution fails", {}, (_root, args) => args[0] === "rev-parse" && args[2] === `${ws.squash}^1`
      ? { status: 128, stdout: "", stderr: "missing parent" } : null],
    ["merge first-parent resolution returns empty output", {}, (_root, args) => args[0] === "rev-parse" && args[2] === `${ws.squash}^1`
      ? { status: 0, stdout: "", stderr: "" } : null],
    ["merge-base command fails", {}, (_root, args) => args[0] === "merge-base" && args[1] === "--all"
      ? { status: 1, stdout: "", stderr: "no merge base" } : null],
    ["merge-base command returns empty output", {}, (_root, args) => args[0] === "merge-base" && args[1] === "--all"
      ? { status: 0, stdout: "", stderr: "" } : null],
    ["merge-base output is ambiguous", {}, (_root, args) => args[0] === "merge-base" && args[1] === "--all"
      ? { status: 0, stdout: `${ws.baseline}\n${ws.head}\n`, stderr: "" } : null],
    ["reviewed base is not proven ancestor of head", {}, (_root, args) => args[0] === "merge-base" && args[1] === "--is-ancestor" && args[3] === ws.head
      ? { status: 1, stdout: "", stderr: "" } : null],
    ["reviewed base is not proven ancestor of integration parent", {}, (_root, args) => args[0] === "merge-base" && args[1] === "--is-ancestor" && args[3] === mergeParent
      ? { status: 1, stdout: "", stderr: "" } : null],
    ["git show fails", {}, (_root, args) => args[0] === "show"
      ? { status: 128, stdout: "", stderr: "bad object" } : null],
    ["git show returns empty patch", {}, (_root, args) => args[0] === "show"
      ? { status: 0, stdout: "", stderr: "" } : null],
    ["git patch-id fails", {}, (_root, args) => args[0] === "patch-id"
      ? { status: 1, stdout: "", stderr: "failed" } : null],
    ["git patch-id returns no identity", {}, (_root, args) => args[0] === "patch-id"
      ? { status: 0, stdout: "", stderr: "" } : null],
    ["git patch-id returns multiple identities", {}, (_root, args) => args[0] === "patch-id"
      ? { status: 0, stdout: `${"a".repeat(40)} ${"b".repeat(40)}\n${"c".repeat(40)} ${"d".repeat(40)}\n`, stderr: "" } : null],
  ];
  for (const [label, args, intercept] of cases) {
    const git = intercept ? wrapped(intercept) : undefined;
    const found = ws.find({ baseBranch: "local-dev", ...args, ...(git ? { git } : {}) });
    assert.deepEqual(found.map(({ sha }) => sha), [offender], `${label} keeps the local commit reportable`);
  }
});

test("COORD-843: a zero-padded PR number names the same PR", () => {
  const { classifyPrRef } = require("./closeout.js").__testing;
  assert.equal(classifyPrRef("https://github.com/acme/widget/pull/0843").key, classifyPrRef("https://github.com/acme/widget/pull/843").key);
  assert.equal(classifyPrRef("https://github.com/acme/widget/pull/0843").url, "https://github.com/acme/widget/pull/843");
});

test("COORD-843: the local-base rule skips merge commits, has nothing to judge without a base or PR diff, and fails closed on git errors", (t) => {
  const ws = coord843LocalBase(t);
  ws.git("checkout", "-q", "-b", "side", ws.squash);
  const sideCommit = ws.commit({ "src/app.js": "side\n" }, "side change to a PR file");
  ws.git("checkout", "-q", "dev");
  ws.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  assert.deepEqual(ws.find().map((commit) => commit.sha), [sideCommit], "the merge commit is skipped; the commit it brings in is judged");
  assert.deepEqual(ws.find({ baseBranch: "missing" }), [], "no local base branch: nothing local to judge");
  assert.deepEqual(ws.find({ baseBranch: "" }), []);
  assert.deepEqual(ws.find({ prEvidence: { ...ws.prEvidence, merge_sha: null } }), [], "no GitHub merge: the rule cannot name the PR's files");
  assert.deepEqual(ws.find({ prEvidence: null }), []);
  const empty = ws.git("commit-tree", `${ws.squash}^{tree}`, "-p", ws.squash, "-m", "empty merge");
  assert.deepEqual(ws.find({ prEvidence: { ...ws.prEvidence, merge_sha: empty } }), [], "a PR that changed no file has no files to protect");
  assert.throws(() => ws.find({ git: (_root, args) => (args[0] === "for-each-ref" ? { status: 128, stderr: "fatal: broken refs" } : require("./git-ops.js").gitTry(_root, args)) }),
    /COORD-843 closeout refused: could not read the remote-tracking refs in .*: fatal: broken refs/);
  assert.throws(() => ws.find({ git: (_root, args) => (args[0] === "diff-tree" ? { status: 1, stderr: "" } : require("./git-ops.js").gitTry(_root, args)) }),
    /could not read the files the PR changed \([0-9a-f]{40}\) in .*: git exited 1/);
});

test("COORD-843: the local-base refusal names the commits, the files and the recovery", (t) => {
  const { assertLocalBaseContainedInPr } = require("./closeout.js").__testing;
  const ws = coord843LocalBase(t);
  const args = { ticketId: "COORD-843", repoRoot: ws.root, baseBranch: "dev", prEvidence: ws.prEvidence, landingIndex: {} };
  assert.doesNotThrow(() => assertLocalBaseContainedInPr(args));
  const first = ws.commit({ "src/app.js": "hand 1\n" }, "hand 1");
  assert.throws(() => assertLocalBaseContainedInPr(args), (error) => {
    assert.match(error.message, new RegExp(`local dev in ${TEMP_PATH_RE} carries 1 commit\\(s\\) touching files the PR https://github.com/acme/widget/pull/843 changed`));
    assert.match(error.message, /outside its verified reviewed patch range/);
    assert.match(error.message, new RegExp(`\\(head ${ws.head}, merge ${ws.squash}\\)`));
    assert.match(error.message, new RegExp(`: ${first} \\(src/app\\.js\\)\\. Closing now`));
    assert.match(error.message, new RegExp(`branch COORD-843-unreviewed-${first} ${first}\\), removing it from local dev history, and landing it through its own reviewed PR`));
    assert.doesNotMatch(error.message, /; \.\.\./);
    return true;
  });
  const secondPr = { ...ws.prEvidence, url: "https://github.com/acme/widget/pull/844" };
  assert.throws(() => assertLocalBaseContainedInPr({ ...args, prEvidence: [ws.prEvidence, secondPr] }), (error) => {
    assert.match(error.message, /outside its verified reviewed patch ranges/);
    assert.ok(error.message.includes(`the verified PR set (${ws.prEvidence.url}, ${secondPr.url})`));
    assert.ok(error.message.includes(`${first} (src/app.js)`));
    return true;
  });
  for (let index = 2; index <= 6; index += 1) ws.commit({ "src/app.js": `hand ${index}\n` }, `hand ${index}`);
  assert.throws(() => assertLocalBaseContainedInPr(args), (error) => {
    assert.match(error.message, /carries 6 commit\(s\)/);
    assert.match(error.message, /; \.\.\.\. Closing now/, "more than five offenders are elided");
    return true;
  });
});

// COORD-843 (2), end to end: an unreviewed commit made on local dev after the
// PR merge was brought in by hand let a fulfilled-by finalize reach done,
// because no ticket branch was merged and so no containment check ran.
for (const mergeWorkspace of [false, true]) {
  test(`COORD-843: a fulfilled-by finalize refuses an unreviewed local dev commit on the PR's files${mergeWorkspace ? " (--merge-workspace)" : ""}`, () => {
    withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, remote, head, githubMerge, attempt }) => {
      runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
      const unrecorded = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
      delete unrecorded.pr_index[ticket];
      __testing.writeBoard(unrecorded);
      __testing.advanceGovernanceProvenanceBaseline("coord855-changed-ref-local-base-fixture");
      fs.writeFileSync(path.join(ctx.coordRoot, "docs", "reviewed-source.txt"), "changed on local dev by hand\n");
      runGit(ctx.coordRoot, "add", "docs/reviewed-source.txt");
      runGit(ctx.coordRoot, "commit", "-m", "unreviewed hand edit on local dev");
      const hand = runGit(ctx.coordRoot, "rev-parse", "HEAD");
      const remoteBefore = runGit(remote, "rev-parse", "refs/heads/dev");
      const boardBefore = fs.readFileSync(ctx.boardPath);
      const before = coord843GovernanceBytes(ticket, ctx);
      const args = ["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
        ...(mergeWorkspace ? ["--merge-workspace", "--push-before-closeout"] : []), "--base", "dev"];
      const refused = attempt(args);
      assert.equal(refused.ok, false, JSON.stringify(refused));
      const refusal = String(refused.error || "");
      assert.match(refusal, new RegExp(`closeout refused: local dev in ${TEMP_PATH_RE} carries 1 commit\\(s\\) touching files the PR`), refusal);
      assert.match(refusal, new RegExp(`\\(head ${head}, merge ${githubMerge}\\)`), refusal);
      assert.match(refusal, new RegExp(`${hand} \\(docs/reviewed-source\\.txt\\)`), refusal);
      assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
      assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "the board is byte-identical");
      assertCoord843Unchanged(before, "refused local-base containment", ticket, ctx);
      assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), hand, "local dev is untouched");
      assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteBefore, "nothing was published");
    });
  });
}

test("COORD-843: an unpublished local dev commit off the PR's files does not block a fulfilled-by finalize", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, githubMerge, attempt }) => {
    runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
    fs.writeFileSync(path.join(ctx.coordRoot, "governed-note.txt"), "a board-style commit local dev routinely carries\n");
    runGit(ctx.coordRoot, "add", "governed-note.txt");
    runGit(ctx.coordRoot, "commit", "-m", "chore(coord): sync canonical derived artifacts");
    const accepted = attempt(["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
  });
});

// COORD-843 (1), the other side: finalize --pr skips set-pr only when the refs
// are already recorded. When pr_index holds no refs for the ticket, the real
// finalize still runs set-pr, records the refs, and journals the event.
test("COORD-855: finalize --pr hands changed refs to the mark-done transaction", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, runGit, githubMerge, attempt }) => {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    delete board.pr_index[ticket];
    __testing.writeBoard(board);
    __testing.advanceGovernanceProvenanceBaseline("coord843-unrecorded-pr-refs");
    runGit(ctx.coordRoot, "merge", "--ff-only", githubMerge);
    const accepted = attempt(["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const after = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.deepEqual(after.pr_index[ticket], [prUrl], "set-pr recorded the finalize refs");
    const events = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const closeouts = events.filter((event) => event.command === "mark-done" && event.ticket === ticket);
    assert.equal(closeouts.length, 1, "changed refs and landing are recorded by one mark-done transaction");
    assert.equal(closeouts[0].result, "succeeded");
    assert.deepEqual(closeouts[0].details?.closeout_pr_refs, [prUrl]);
    assert.equal(events.filter((event) => event.command === "set-pr" && event.ticket === ticket).length, 0,
      "closeout no longer commits a separate set-pr event");
    const journalAfterFirstCloseout = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    const retry = attempt(["finalize", ticket, "--pr", prUrl, "--fulfilled-by-commit", githubMerge,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.ok(journalAfterFirstCloseout.equals(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH)),
      "an identical changed-ref retry does not duplicate landing or ref-change evidence");
  });
});

test("COORD-855: a doing-state changed-ref local-base refusal leaves all governed bytes unchanged", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, prUrl, source, head, githubMerge, runGit, attempt }) => {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    board.sections[0].rows.find((row) => row.ID === ticket).Status = "doing";
    delete board.pr_index[ticket];
    __testing.writeBoard(board);
    __testing.advanceGovernanceProvenanceBaseline("coord855-doing-changed-ref-local-base-fixture");

    fs.writeFileSync(path.join(ctx.coordRoot, "docs/reviewed-source.txt"), "line one\nline two\nline three\nlocal dev edit\n");
    runGit(ctx.coordRoot, "add", "docs/reviewed-source.txt");
    runGit(ctx.coordRoot, "commit", "-m", "fixture local dev change to reviewed PR file");
    const localHead = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    const localOffenders = closeoutTesting.findUnreviewedLocalBaseCommits({
      repoRoot: ctx.coordRoot,
      baseBranch: "dev",
      prEvidence: { url: prUrl, head_sha: head, merge_sha: githubMerge },
      landingIndex: {},
      ticketId: ticket,
    });
    assert.deepEqual(localOffenders.map(({ sha }) => sha), [localHead], "fixture actually presents the independent local-base preflight blocker");

    const boardBefore = fs.readFileSync(ctx.boardPath);
    const before = coord843GovernanceBytes(ticket, ctx);
    assert.ok(fs.existsSync(ctx.lockPath), "the DOING ticket has its governed lock before closeout");
    const refused = attempt(["finalize", ticket, "--pr", prUrl, "--source-commit", source,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /local dev in .* carries 1 commit\(s\).*outside its verified reviewed patch range/i);
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "doing", "the ticket never persists an intermediate REVIEW status");
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).pr_index?.[ticket], undefined,
      "the new PR ref set is not persisted on refusal");
    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "board bytes remain identical");
    assertCoord843Unchanged(before, "doing-state changed-ref local-base refusal", ticket, ctx);
    assert.ok(fs.existsSync(ctx.lockPath), "the DOING lock remains present after refusal");
  }, { doing: true });
});

test("COORD-855: the public land command uses lifecycle status and ownership adapters before refusing an invalid source", () => {
  const ticketId = "MSRV-855";
  const owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord855-land-lifecycle-adapters-", ticketId, owner);
  try {
    const planPath = path.join(ctx.planRecordsDir, `${ticketId}.json`);
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const planBefore = fs.readFileSync(planPath);
    const questionsBefore = fs.readFileSync(governanceState.QUESTIONS_PATH);
    const journalBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "review");
    assert.ok(!fs.existsSync(ctx.lockPath), "a REVIEW ticket has no active doing lock");

    let refused;
    try {
      refused = executeCommand(["land", ticketId, "--source-commit", "not-a-real-oid"]);
    } catch (error) {
      refused = { ok: false, error: error.message };
    }

    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /source commit.*does not resolve/i);
    assert.equal(readBoardRow(ctx.boardPath, ticketId).Status, "review", "the preflight refusal keeps REVIEW status");
    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "the failed land wrote no board transition");
    assert.ok(planBefore.equals(fs.readFileSync(planPath)), "the failed land left the canonical plan unchanged");
    assert.ok(questionsBefore.equals(fs.readFileSync(governanceState.QUESTIONS_PATH)), "the failed land wrote no closeout question");
    assert.ok(!fs.existsSync(ctx.lockPath), "the refused REVIEW closeout did not create or remove a doing lock");

    assert.ok(journalBefore.equals(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH)),
      "a preflight refusal before external effects restores state without a journal append");
  } finally {
    ctx.restore();
  }
});

test("COORD-855: a changed-ref prodloc refusal leaves governed bytes unchanged", () => {
  withCoord809PublicPrFixture(({ ticket, ctx, layoutModule, prUrl, runGit, remote, source, attempt }) => {
    const unrecorded = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    delete unrecorded.pr_index[ticket];
    __testing.writeBoard(unrecorded);
    __testing.advanceGovernanceProvenanceBaseline("coord855-changed-ref-prodloc-fixture");

    // This local integration commit is deliberately outside the PR's changed
    // files. It pushes lifecycle.js over its trusted prodloc budget, making the
    // real closeout preflight refuse before either the PR refs or terminal
    // state can be written.
    const lifecycle = path.join(ctx.coordRoot, "coord/engine/scripts/lifecycle.js");
    fs.mkdirSync(path.dirname(lifecycle), { recursive: true });
    fs.appendFileSync(lifecycle, `${Array.from({ length: 3000 }, (_, i) => `const coord855FixtureLine${i} = ${i};`).join("\n")}\n`);
    runGit(ctx.coordRoot, "add", "coord/engine/scripts/lifecycle.js");
    runGit(ctx.coordRoot, "commit", "-m", "fixture exceed lifecycle production LOC budget");

    const layout = layoutModule.resolveControlPlaneLayout({ coordDir: ctx.coordRoot, workspaceRoot: path.dirname(ctx.coordRoot) });
    const layoutTesting = layoutModule.__testing;
    layoutTesting.override({ ...layout, coordDir: path.join(ctx.coordRoot, "coord"), coordPathPrefix: "coord" });

    const localHead = runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev");
    const remoteHead = runGit(remote, "rev-parse", "refs/heads/dev");
    const boardBefore = fs.readFileSync(ctx.boardPath);
    const before = coord843GovernanceBytes(ticket, ctx);
    const refused = attempt(["finalize", ticket, "--pr", prUrl, "--source-commit", source,
      "--merge-workspace", "--push-before-closeout", "--base", "dev"]);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(String(refused.error), /prodloc closeout refused/i);
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review");
    assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), "board bytes are unchanged");
    assertCoord843Unchanged(before, "changed-ref prodloc refusal", ticket, ctx);
    assert.equal(runGit(ctx.coordRoot, "rev-parse", "refs/heads/dev"), localHead, "preflight did not move local dev");
    assert.equal(runGit(remote, "rev-parse", "refs/heads/dev"), remoteHead, "preflight did not publish");
  });
});

// COORD-856: each closeout recovery command, printed for a workspace path with
// a space, parentheses, a dollar sign and a single quote, parses with a POSIX
// shell-word splitter (and /bin/sh) to the argv the recovery intends, and runs.
function coord856Argv(command, expected) {
  assert.deepEqual(splitPosixShellWords(command), expected, command);
  assert.deepEqual(shellArgv(command), expected, `/bin/sh agrees: ${command}`);
}
function coord856Repo(t, label) {
  const base = fs.realpathSync(hostileTempDir(label));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "work tree (repo)");
  fs.mkdirSync(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const commit = (cwd, file, text, message) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  git(root, "init", "-q", "-b", "dev");
  return { base, root, git, commit };
}

test("COORD-856: closeout workspace-merge recoveries quote the repository and checkout paths", (t) => {
  const { assertIncomingTipsMeasured, resolveRecordedPrContainment } = require("./closeout.js").__testing;
  const { base, root, git, commit } = coord856Repo(t, "closeout-tips");
  const reviewed = commit(root, "a.txt", "reviewed\n", "reviewed");
  git(root, "branch", "agent/x-coord-856");
  git(root, "checkout", "-q", "agent/x-coord-856");
  const beyond = commit(root, "a.txt", "beyond\n", "beyond review");
  git(root, "checkout", "-q", "dev");
  const refusal = () => {
    try {
      assertIncomingTipsMeasured({ ticketId: "COORD-856", measured: { sha: reviewed, label: "the measured reviewed source" }, repoRoot: root,
        incomingBranchTips: [{ branch: "agent/x-coord-856", head_sha: beyond }] });
    } catch (error) { return error.message; }
    return assert.fail("the tip beyond the measured source is refused");
  };
  const first = refusal();
  const save = new RegExp(`saving the commits beyond the reviewed head \\((git -C ${SHELL_WORD_RE} branch \\S+ [0-9a-f]{40})\\)`).exec(first)[1];
  coord856Argv(save, ["git", "-C", root, "branch", `COORD-856-beyond-review-${beyond}`, beyond]);
  const moveBranch = new RegExp(`resetting the branch to the reviewed commit \\((git -C ${SHELL_WORD_RE} branch -f \\S+ [0-9a-f]{40})\\)`).exec(first)[1];
  coord856Argv(moveBranch, ["git", "-C", root, "branch", "-f", "agent/x-coord-856", reviewed]);
  runPrintedGitStep(save);
  assert.equal(git(root, "rev-parse", `COORD-856-beyond-review-${beyond}`), beyond, "the printed save ran against the hostile path");

  const checkout = path.join(base, "ticket $(checkout) 'wt'");
  git(root, "worktree", "add", "-q", checkout, "agent/x-coord-856");
  const reset = new RegExp(`\\((git -C ${SHELL_WORD_RE} reset --keep [0-9a-f]{40})\\)`).exec(refusal())[1];
  coord856Argv(reset, ["git", "-C", checkout, "reset", "--keep", reviewed]);
  runPrintedGitStep(reset);
  assert.equal(git(checkout, "rev-parse", "HEAD"), reviewed, "the printed reset ran against the hostile checkout");

  const unverified = resolveRecordedPrContainment({ ticketId: "COORD-856", prRefs: ["https://github.com/o/r/pull/856"], verifiedPrs: [], repoRoot: root });
  const fetch = new RegExp(`Recover by fetching the PR's commits \\((git -C ${SHELL_WORD_RE} fetch origin)\\)`).exec(unverified.error)[1];
  coord856Argv(fetch, ["git", "-C", root, "fetch", "origin"]);
});

test("COORD-856: the local-base refusal quotes the repository path in its save step", (t) => {
  const { assertLocalBaseContainedInPr } = require("./closeout.js").__testing;
  const { root, git, commit } = coord856Repo(t, "closeout-local-base");
  commit(root, "src.js", "v0\n", "baseline");
  const merged = commit(root, "src.js", "v1\n", "PR merge");
  const hand = commit(root, "src.js", "by hand\n", "unreviewed hand edit");
  const prEvidence = { url: "https://github.com/o/r/pull/856", head_sha: merged, merge_sha: merged };
  assert.throws(() => assertLocalBaseContainedInPr({ ticketId: "COORD-856", repoRoot: root, baseBranch: "dev", prEvidence, landingIndex: {} }), (error) => {
    const save = new RegExp(`saving each commit on its own branch \\((git -C ${SHELL_WORD_RE} branch \\S+ [0-9a-f]{40})\\)`).exec(error.message)[1];
    coord856Argv(save, ["git", "-C", root, "branch", `COORD-856-unreviewed-${hand}`, hand]);
    runPrintedGitStep(save);
    assert.equal(git(root, "rev-parse", `COORD-856-unreviewed-${hand}`), hand);
    return true;
  });
});

test("COORD-856: the Repo-X no-provenance fork-point step quotes the control-plane root and runs verbatim", (t) => {
  const controlPlanePaths = require("./control-plane-paths.js");
  const { __testing: layoutTesting } = controlPlanePaths;
  const { base, root: xRoot, git, commit } = coord856Repo(t, "closeout-repo-x");
  git(xRoot, "branch", "-q", "-M", "integration");
  commit(xRoot, "big.js", "a1\nshared-top\n", "base");
  const xWt = path.join(base, "wt (T-3) $x");
  git(xRoot, "worktree", "add", "-q", "-b", "agent/x-t-3", xWt);
  const manual = commit(xWt, "big.js", "a1-refactored\nshared-top\n", "manual T-3 commit");
  commit(xRoot, "big.js", "a1\nshared-top-OTHER\n", "other ticket lands");
  layoutTesting.override({ ...controlPlanePaths.defaultControlPlaneLayout(), coordRepoRoot: xRoot });
  t.after(() => layoutTesting.reset());
  let steps;
  try {
    coord830Closeout((_t, _row, ctx) => { steps = ctx.resolveReviewedSource().recovery; throw new Error("stop"); }, { readGovernedCommitHead: () => null })
      .prepareDoneCloseout("T-3", { pr_index: { "T-3": ["local-review (no PR)"] }, review_findings: {}, landing_index: {} }, { row: { Repo: "X", Status: "review" } }, {});
  } catch { /* stop */ }
  const branchProbe = /b="\$\((git -C .+? symbolic-ref --quiet --short HEAD)\)"/.exec(steps[2]);
  assert.ok(branchProbe, steps[2]);
  coord856Argv(branchProbe[1], ["git", "-C", xRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  // Only the documented <ticket worktree> placeholder is filled in; the
  // control-plane path is used exactly as printed.
  const run = (step) => spawnSync("/bin/bash", ["-c", step.split("  #")[0].replaceAll("<ticket worktree>", shellQuote(xWt))], { encoding: "utf8" });
  assert.equal(run(steps[1]).status, 0);
  assert.equal(git(xWt, "rev-parse", `T-3-before-provenance-${manual.slice(0, 12)}`), manual);
  const reparented = run(steps[2]);
  assert.equal(reparented.status, 0, reparented.stderr);
  git(xWt, "commit", "-qm", "T-3 governed commit");
  assert.equal(git(xWt, "rev-parse", "HEAD^"), git(xRoot, "rev-parse", "integration^"), "re-parented onto the fork point of the hostile-path checkout");
});

// COORD-839, end to end through the real CLI dispatch and lifecycle wiring: a
// no-PR finalize whose workspace merge changes an accepted ADR recorded the new
// bytes as the governance baseline with no approval. The ticket has no
// recorded PR refs, so finalize would journal set-pr BEFORE mark-done; the
// refusal must come first and leave every governed byte as it was.
function withCoord839AdrLanding(run) {
  const crypto = require("node:crypto");
  const ticket = "ARCH-939", owner = "claudea0000";
  const ctx = setupRepoXReviewReadyFixture("coord839-adr-landing-", ticket, owner);
  const layoutModule = require("./control-plane-paths.js");
  const layoutTesting = layoutModule.__testing;
  const boardPaths = require("../../board/board.js").__testing.paths;
  const boardKeys = ["BOARD_PATH", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "PLAN_RECORDS_DIR", "LEGACY_PLAN_RECORDS_DIR"];
  const originalBoardPaths = Object.fromEntries(boardKeys.map(key => [key, boardPaths[key]]));
  for (const key of boardKeys) boardPaths[key] = governanceState[key];
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "COORD-839 fixture", GIT_AUTHOR_EMAIL: "coord839@example.invalid",
    GIT_COMMITTER_NAME: "COORD-839 fixture", GIT_COMMITTER_EMAIL: "coord839@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const runGit = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return String(result.stdout || "").trim();
  };
  const adr = path.join(governanceState.DECISIONS_DIR, "0001-accepted.md");
  // COORD-1025: a Status-only edit is ADR metadata and admits without a packet, so the fixture
  // changes its Decision section too: the body change is what must refuse without the packet.
  const accepted = "# ADR-0001\n\nStatus: Accepted\n\n## Decision\n\nUse the queue.\n";
  const superseded = "# ADR-0001\n\nStatus: Superseded\n\n## Decision\n\nUse the stack.\n";
  try {
    const board = JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
    delete board.pr_index[ticket];
    board.prompt_index[ticket] = path.relative(path.resolve(__dirname, "../../.."), path.join(ctx.coordRoot, "prompts", `${ticket}.md`));
    board.waiver_index ||= {};
    __testing.writeBoard(board);
    fs.writeFileSync(adr, accepted);
    runGit(ctx.coordRoot, "init", "-b", "dev");
    runGit(ctx.coordRoot, "add", "-A");
    runGit(ctx.coordRoot, "commit", "-m", "fixture baseline with an accepted ADR");
    runGit(ctx.coordRoot, "checkout", "-b", `agent/${owner}-${ticket.toLowerCase()}-adr-status`);
    fs.writeFileSync(adr, superseded);
    runGit(ctx.coordRoot, "commit", "-am", "reviewed ADR status change");
    runGit(ctx.coordRoot, "checkout", "dev");
    layoutTesting.override(layoutModule.resolveControlPlaneLayout({ coordDir: ctx.coordRoot, workspaceRoot: path.dirname(ctx.coordRoot) }));
    __testing.advanceGovernanceProvenanceBaseline("coord839-adr-landing-fixture");
    const relative = path.relative(ctx.coordRoot, adr).split(path.sep).join("/");
    const packetFile = (text) => {
      const file = path.join(path.dirname(ctx.coordRoot), `${path.basename(ctx.coordRoot)}-packet-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(file, text);
      return file;
    };
    const attempt = (args) => {
      try { return executeCommand(args); } catch (error) { return { ok: false, error: error.message }; }
    };
    return run({ ticket, ctx, runGit, adr, accepted, superseded, relative, packetFile, attempt,
      sha256: (text) => crypto.createHash("sha256").update(text).digest("hex") });
  } finally {
    layoutTesting.reset();
    for (const key of boardKeys) boardPaths[key] = originalBoardPaths[key];
    ctx.restore();
  }
}

test("COORD-839: finalize refuses an ADR-changing workspace merge without, or against a mismatching, approved packet, writing nothing", () => {
  withCoord839AdrLanding(({ ticket, ctx, runGit, adr, accepted, relative, packetFile, attempt, sha256 }) => {
    const head = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    for (const [label, extra, pattern] of [
      ["no packet", [], new RegExp(`re-run with --expect-paths-file <approved packet> listing exactly these paths with their post-merge sha256: [0-9a-f]{64} ${escapeRegExp(relative)}`)],
      ["mismatching packet", ["--expect-paths-file", packetFile(`${sha256(accepted)} ${relative}\n`)], /bytes differ from the packet/],
    ]) {
      const boardBefore = fs.readFileSync(ctx.boardPath);
      const before = coord843GovernanceBytes(ticket, ctx);
      const refused = attempt(["finalize", ticket, "--no-pr", "--merge-workspace", ...extra]);
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused)}`);
      assert.match(String(refused.error), pattern, `${label}: ${refused.error}`);
      assert.match(String(refused.error), /--expect-paths-file/, `${label}: the refusal names the packet option`);
      assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "review", `${label}: not done`);
      assert.ok(boardBefore.equals(fs.readFileSync(ctx.boardPath)), `${label}: the board is byte-identical (no set-pr)`);
      assertCoord843Unchanged(before, label, ticket, ctx);
      assert.equal(runGit(ctx.coordRoot, "rev-parse", "HEAD"), head, `${label}: nothing was merged`);
      assert.equal(fs.readFileSync(adr, "utf8"), accepted, `${label}: the accepted ADR is untouched`);
    }
  });
});

test("COORD-839: finalize with a matching approved packet lands the ADR change and adopts exactly the approved bytes", () => {
  withCoord839AdrLanding(({ ticket, ctx, runGit, adr, superseded, relative, packetFile, attempt, sha256 }) => {
    const head = runGit(ctx.coordRoot, "rev-parse", "HEAD");
    const accepted = attempt(["finalize", ticket, "--no-pr", "--merge-workspace", "--expect-paths-file", packetFile(`${sha256(superseded)} ${relative}\n`)]);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(readBoardRow(ctx.boardPath, ticket).Status, "done");
    assert.notEqual(runGit(ctx.coordRoot, "rev-parse", "HEAD"), head, "the workspace merge ran");
    assert.equal(fs.readFileSync(adr, "utf8"), superseded);
    assert.equal(runGit(ctx.coordRoot, "show", `HEAD:${relative}`), superseded.trimEnd(), "the approved bytes are on the integration branch");
  });
});
