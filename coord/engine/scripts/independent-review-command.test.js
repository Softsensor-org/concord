// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";


const { state: governanceState } = require("./governance-context.js");
// COORD-718: production-path tests for `gov record-independent-review` and the
// readers it feeds. Every scenario runs the real CLI dispatcher against a
// sandboxed governed fixture (board, plan record, journal, lock) and a real
// temporary git repository for commit binding.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const testUtils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { DEFAULT_PATHS } = require("./governance-context.js");
const closeout = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/closeout-summary.js"));

const { __testing, executeCommand, withRegisterPromptHarness, createTempGitRepo, runGit, withScopedGovernanceTestContext } = testUtils;
const TICKET = "IMP-718";
const OWNER = "claudea11";
const REVIEWERS = ["claudea13", "claudea14"];

function readPlanRecordFromSandbox(ticketId) {
  return JSON.parse(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`), "utf8"));
}

function run(args, session) {
  return executeCommand(args, { env: { ...process.env, COORD_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: session } });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function governedFiles() {
  const files = [
    path.join(governanceState.PLAN_RECORDS_DIR, `${TICKET}.json`), governanceState.PLAN_PATH,
    governanceState.GOVERNANCE_EVENT_LOG_PATH, governanceState.BOARD_PATH, path.join(governanceState.LOCKS_DIR, `${TICKET}.lock`),
  ];
  return files.map((file) => [path.basename(file), fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]);
}

function events(command) {
  return fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((event) => !command || event.command === command);
}

function writeLock(head, overrides = {}) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(governanceState.LOCKS_DIR, `${TICKET}.lock`), `${JSON.stringify({
    agent_id: "a11", owner: OWNER, ticket: TICKET, status: "doing", repo: DEFAULT_PATHS.repoRegistry.B,
    branch: `agent/${OWNER}-imp-718`, worktree: "/tmp/imp-718", head, started_at_utc: now, heartbeat_utc: now, identity_model: "v2",
    ...overrides,
  }, null, 2)}\n`);
}

// A doing ticket owned by claudea11, two registered reviewers, a seeded plan,
// a lock at the second of two real commits, and repo B pointed at that repo.
function withReviewFixture(prefix, body, { lifecycleWorktree = false, absoluteRepository = false } = {}) {
  withRegisterPromptHarness(prefix, { ticketId: TICKET, status: "doing" }, (fixture) => {
    const repo = createTempGitRepo(`${prefix}repo-`, { "a.txt": "1\n" });
    const oldHead = repo.head;
    fs.writeFileSync(path.join(repo.repoRoot, "a.txt"), "2\n");
    runGit(repo.repoRoot, ["commit", "-am", lifecycleWorktree ? `${TICKET}: absolute repository identity fixture` : "second"]);
    const head = runGit(repo.repoRoot, ["rev-parse", "HEAD"]);
    let worktree = repo.repoRoot;
    let branch = `agent/${OWNER}-imp-718`;
    if (lifecycleWorktree) {
      runGit(repo.repoRoot, ["branch", branch, head]);
      runGit(repo.repoRoot, ["reset", "--hard", oldHead]);
      worktree = path.join(repo.repoRoot, ".worktrees", OWNER, TICKET);
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      runGit(repo.repoRoot, ["worktree", "add", worktree, branch]);
    }
    try {
      withScopedGovernanceTestContext({
        REPO_ROOTS: { ...DEFAULT_PATHS.repoRoots, B: repo.repoRoot },
        ...(absoluteRepository ? { repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: repo.repoRoot } } : {}),
      }, () => {
        const agents = readJson(governanceState.AGENTS_PATH);
        for (const [index, handle] of REVIEWERS.entries()) {
          agents.push({ id: `a${13 + index}`, handle, provider: "anthropic", status: "active", aliases: [] });
        }
        fs.writeFileSync(governanceState.AGENTS_PATH, `${JSON.stringify(agents, null, 2)}\n`);
        const board = readJson(fixture.boardPath);
        board.sections[0].rows[0].Owner = OWNER;
        fs.writeFileSync(fixture.boardPath, `${JSON.stringify(board, null, 2)}\n`);
        writeLock(head, { branch, worktree });
        __testing.advanceGovernanceProvenanceBaseline("COORD-718 reviewer fixture setup");
        assert.equal(run(["agentid", "--owner", OWNER], "c718-owner").ok, true);
        assert.equal(run(["plan", TICKET, "--seed"], "c718-owner").ok, true);
        for (const handle of REVIEWERS) {
          const bound = run(["agentid", "--owner", handle], `c718-${handle}`);
          assert.equal(bound.ok, true, bound.error);
        }
        body({ ...fixture, head, oldHead, repoRoot: repo.repoRoot, worktree });
      });
    } finally {
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
  });
}

function review(handle, commit, extra = []) {
  return run(["record-independent-review", TICKET, "--commit", commit, "--method", "code review: contract and failure modes",
    "--verdict", "pass-with-findings", "--finding", "F1", "--finding", "F2", ...extra], `c718-${handle}`);
}

function explainReviews() {
  const explained = run(["explain", TICKET], "c718-owner");
  assert.equal(explained.ok, true, explained.error);
  return JSON.parse(explained.stdout).governance_readiness.independent_reviews;
}

test("COORD-718: a bound non-owner reviewer records a commit-bound review without claiming or changing the ticket", () => {
  withReviewFixture("c718-record-", ({ head }) => {
    const before = Object.fromEntries(governedFiles());
    const planBefore = readPlanRecordFromSandbox(TICKET);
    const result = review("claudea13", head, ["--summary", "Two low findings."]);
    assert.equal(result.ok, true, result.error);
    const after = Object.fromEntries(governedFiles());
    assert.equal(after["tasks.json"], before["tasks.json"], "board row, owner and status are untouched");
    assert.equal(after[`${TICKET}.lock`], before[`${TICKET}.lock`], "the ticket lock is untouched");

    const record = readPlanRecordFromSandbox(TICKET);
    assert.equal(record.independent_reviews.length, 1);
    const [stored] = record.independent_reviews;
    assert.equal(stored.reviewer.handle, "claudea13");
    assert.equal(stored.owner_at_review, OWNER, "reviewer and owner are distinct recorded identities");
    assert.equal(stored.reviewer.thread_id, "c718-claudea13");
    assert.match(stored.reviewer.session_id, /\S/);
    assert.equal(stored.repository, DEFAULT_PATHS.repoRegistry.B);
    assert.equal(stored.commit, head);
    assert.deepEqual(stored.findings, ["F1", "F2"]);
    assert.deepEqual(record.self_review_cycles, planBefore.self_review_cycles, "self-review cycles are unchanged");

    const [event] = events("record-independent-review");
    assert.equal(event.identity.owner, "claudea13", "the journal attributes the write to the reviewer, not the owner");
    assert.equal(event.details.review_id, stored.id);
    assert.deepEqual(event.changed_paths.filter((file) => /tasks\.json|\.lock$/.test(file)), []);

    const readiness = explainReviews();
    assert.deepEqual(readiness.scope, { repository: DEFAULT_PATHS.repoRegistry.B, commit: head, source: "lock" });
    assert.equal(readiness.counts.current, 1, "the writer feeds explain readiness");
    assert.equal(readiness.current[0].id, stored.id);
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), new RegExp(`- Independent reviews \\(append-only\\):[\\s\\S]*reviewer=claudea13 owner_at_review=${OWNER}`));
  });
});

test("COORD-858: absolute configured repository identity survives review, move-review, and current-scope projection", () => {
  withReviewFixture("c858-absolute-repo-", ({ head, repoRoot, worktree }) => {
    const beforeUnknownRepository = governedFiles();
    const otherRepository = path.join(path.dirname(repoRoot), "other-backend");
    const refused = review("claudea13", head, ["--repository", otherRepository]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /cannot resolve repository/);
    assert.deepEqual(governedFiles(), beforeUnknownRepository, "an unconfigured absolute repository cannot write review evidence");

    const recorded = review("claudea13", head);
    assert.equal(recorded.ok, true, recorded.error);
    const record = readPlanRecordFromSandbox(TICKET);
    const reviewed = record.independent_reviews[0];
    assert.equal(reviewed.repository, repoRoot, "the writer preserves the exact configured absolute identity");
    assert.equal(reviewed.commit, head);

    const planPath = path.join(governanceState.PLAN_RECORDS_DIR, `${TICKET}.json`);
    const plan = readJson(planPath);
    const lenses = ["contract/state invariants", "auth/security/failure modes", "tests/operability/performance", "requirement closure"];
    Object.assign(plan, {
      startup_checklist: ["verified startup"], traceability_gate: ["exempt"], baseline_reproduction: ["not-required"],
      intended_files: [path.join(repoRoot, "a.txt")], change_summary: ["Review absolute configured repository identities."],
      verification_commands: ["node --test coord/scripts/independent-review-command.test.js"],
      critical_invariants: ["Repository identity is exact and bounded.", "No review scope is inferred from mutable refs."],
      requirement_closure: ["Ticket ask: preserve absolute repository identity", "Implemented: exact review scope", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
      feature_proof: [], repo_gates: ["not-required: isolated absolute repository identity fixture"], rollback_strategy: ["Governed mutation restores plan and lock snapshots."],
      self_review_cycles: lenses.map((lens, index) => ({
        cycle: index + 1, total: 4, lens, diff: "absolute repository identity fixture", risks: ["scope mismatch", "plan rollback"],
        findings: "none", verification: "focused absolute identity regression", verdict: "pass",
        raw: `lens=${lens}; diff=absolute identity fixture; risks=scope mismatch, plan rollback; findings=none; verification=focused regression; verdict=pass`,
      })),
    });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    __testing.writePlanCompatibilityBlockFromRecord(TICKET, plan);
    __testing.advanceGovernanceProvenanceBaseline("COORD-858 absolute repository identity plan fixture");

    const moved = run(["move-review", TICKET, "--pr", "local-review (no PR)"], "c718-owner");
    assert.equal(moved.ok, true, moved.error);
    const submitted = readPlanRecordFromSandbox(TICKET);
    assert.deepEqual(submitted.review_submission, { repository: repoRoot, commit: head });
    assert.equal(JSON.stringify(submitted.independent_reviews[0]), JSON.stringify(reviewed), "review ID and entry bytes remain stable");
    assert.equal(fs.existsSync(path.join(governanceState.LOCKS_DIR, `${TICKET}.lock`)), false);

    const readiness = explainReviews();
    assert.deepEqual(readiness.scope, { repository: repoRoot, commit: head, source: "submission" });
    assert.equal(readiness.counts.current, 1);
    assert.equal(readiness.current[0].id, reviewed.id);
    assert.equal(path.resolve(worktree), path.resolve(path.join(repoRoot, ".worktrees", OWNER, TICKET)));
  }, { lifecycleWorktree: true, absoluteRepository: true });
});

test("COORD-718: identical retry writes nothing and conflicting reuse of a review id fails with no writes", () => {
  withReviewFixture("c718-retry-", ({ head }) => {
    assert.equal(review("claudea13", head).ok, true);
    const recorded = governedFiles();
    const retry = review("claudea13", head);
    assert.equal(retry.ok, true, retry.error);
    assert.match(retry.stdout, /"status": "unchanged"/);
    assert.deepEqual(governedFiles(), recorded, "identical retry leaves plan, PLAN.md, journal, board and lock byte-identical");
    const conflict = run(["record-independent-review", TICKET, "--commit", head, "--method", "code review: contract and failure modes", "--verdict", "fail"], "c718-claudea13");
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /already recorded with different content/);
    assert.deepEqual(governedFiles(), recorded, "a conflicting reuse refuses atomically");
    assert.equal(events("record-independent-review").length, 1);
  });
});

test("COORD-718: owner, unbound, unknown-commit, abbreviated-commit, unknown-repository and update-plan writes are refused", () => {
  withReviewFixture("c718-refuse-", ({ head, oldHead }) => {
    const before = governedFiles();
    const cases = [
      [run(["record-independent-review", TICKET, "--commit", head, "--method", "m", "--verdict", "pass"], "c718-owner").error, /owns IMP-718; an owner's review is self-review/],
      [run(["record-independent-review", TICKET, "--commit", head, "--method", "m", "--verdict", "pass"], "c718-unbound-thread").error, /requires a bound reviewer session/],
      [review("claudea13", "f".repeat(40)).error, /does not exist in/],
      [review("claudea13", head.slice(0, 12)).error, /full immutable commit id/],
      [review("claudea13", head, ["--repository", "nowhere"]).error, /cannot resolve repository "nowhere"/],
      [review("claudea13", head, ["--owner", "claudea13"]).error, /takes no --owner/],
      [review("claudea13", head, ["--supersedes", `irv1-${"0".repeat(64)}`]).error, /needs a reason/],
      [review("claudea13", head, ["--supersedes", `irv1-${"0".repeat(64)}`, "--reason", "x"]).error, /not recorded before it/],
      [run(["record-independent-review", "IMP-404", "--commit", head, "--method", "m", "--verdict", "pass"], "c718-claudea13").error, /existing plan record/],
    ];
    for (const [error, expected] of cases) {
      assert.match(String(error), expected);
      assert.deepEqual(governedFiles(), before, `refusal ${expected} must not write`);
    }
    const injected = run(["update-plan", TICKET, "--independent-review", JSON.stringify({ id: "x" })], "c718-owner");
    assert.equal(injected.ok, false, "the owner's update-plan surface cannot write independent reviews");
    assert.deepEqual(governedFiles(), before);
    assert.equal(oldHead.length, 40);
  });
});

test("COORD-718: concurrent reviewers both land without claiming the ticket", () => {
  withReviewFixture("c718-concurrent-", ({ tempDir, head }) => {
    const pathKeys = ["BOARD_PATH", "PLAN_PATH", "PLAN_RECORDS_DIR", "GOVERNANCE_EVENT_LOG_PATH", "GOVERNANCE_SNAPSHOT_PATH",
      "GOVERNANCE_SNAPSHOTS_DIR", "GOVERNANCE_EVENT_LOCK_DIR", "LOCKS_DIR", "LEGACY_LOCKS_DIR", "AGENT_SESSIONS_PATH",
      "AGENTS_PATH", "QUESTIONS_PATH", "PROMPTS_DIR", "RENDERED_DIR", "RUNTIME_DIR", "COORD_STATE_LOCK_DIR",
      "AGENT_STATE_LOCK_DIR", "MEMORY_DIR", "DECISIONS_DIR"];
    const paths = Object.fromEntries(pathKeys.map((key) => [key, governanceState[key]]));
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (REVIEWERS.length + 1));
    const source = `
      const { workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      try {
        const utils = require(workerData.utilsPath);
        const context = require(workerData.contextPath);
        const { createGovernanceTestContextHarness } = require(workerData.harnessPath);
        createGovernanceTestContextHarness({ state: context.state, defaultPaths: context.DEFAULT_PATHS })
          .installWorkerContext({ ...workerData.paths, REPO_ROOTS: { B: workerData.repoRoot } });
        const result = utils.executeCommand(workerData.args, { env: { ...process.env, COORD_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: workerData.session } });
        fs.writeFileSync(workerData.outputPath, JSON.stringify({ ok: result.ok, error: result.error || null }));
      } catch (error) {
        fs.writeFileSync(workerData.outputPath, JSON.stringify({ ok: false, error: error.message }));
      } finally {
        const state = new Int32Array(workerData.shared);
        Atomics.store(state, workerData.index + 1, 1);
        Atomics.notify(state, 0);
      }
    `;
    const outputs = REVIEWERS.map((handle) => path.join(tempDir, `${handle}.json`));
    const failures = [];
    const workers = REVIEWERS.map((handle, index) => {
      const worker = new Worker(source, { eval: true, workerData: {
        utilsPath: path.join(__dirname, "..", "..", "scripts", "governance-test-utils.js"), contextPath: path.join(__dirname, "governance-context.js"),
        harnessPath: path.join(__dirname, "../../engine/scripts/governance-test-context.js"),
        repoRoot: DEFAULT_PATHS.repoRoots.B, paths, shared, index, outputPath: outputs[index], session: `c718-${handle}`,
        args: ["record-independent-review", TICKET, "--commit", head, "--method", `lens ${handle}`, "--verdict", "pass"],
      } });
      const done = () => { const state = new Int32Array(shared); Atomics.store(state, index + 1, 1); Atomics.notify(state, 0); };
      worker.on("error", (error) => { failures.push(`${handle}: ${error.message}`); done(); });
      worker.on("exit", (code) => { if (code !== 0) failures.push(`${handle} exited ${code}`); done(); });
      return worker;
    });
    const state = new Int32Array(shared);
    const deadline = Date.now() + 30_000;
    try {
      while (REVIEWERS.some((_, index) => Atomics.load(state, index + 1) === 0)) {
        assert.ok(Date.now() < deadline, `concurrent reviewers timed out ${failures.join("; ")}`);
        Atomics.wait(state, 0, 0, 1_000);
      }
    } finally {
      for (const worker of workers) void worker.terminate();
    }
    assert.deepEqual(failures, []);
    for (const output of outputs) {
      const result = readJson(output);
      assert.equal(result.ok, true, result.error);
    }
    const record = readPlanRecordFromSandbox(TICKET);
    assert.deepEqual(record.independent_reviews.map((entry) => entry.reviewer.handle).sort(), REVIEWERS);
    const readiness = explainReviews();
    assert.equal(readiness.counts.current, 2);
    assert.equal(readiness.counts.current_reviewers, 2);
    assert.equal(readJson(governanceState.BOARD_PATH).sections[0].rows[0].Owner, OWNER, "neither reviewer claimed the ticket");
  });
});

test("COORD-718: a moved head turns a review historical, and a superseding review at the new head is current", () => {
  withReviewFixture("c718-stale-", ({ head, oldHead }) => {
    writeLock(oldHead);
    __testing.advanceGovernanceProvenanceBaseline("COORD-718 lock at the first head");
    assert.equal(review("claudea13", oldHead, ["--review-key", "first pass"]).ok, true);
    assert.equal(explainReviews().counts.current, 1);
    writeLock(head);
    __testing.advanceGovernanceProvenanceBaseline("COORD-718 lock advanced to the fix head");
    const stale = explainReviews();
    assert.equal(stale.counts.current, 0, "a review of the old head is not current once the head moves");
    assert.equal(stale.historical[0].currency, "stale_head");
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), /status=active; current only when/);
    const firstId = stale.historical[0].id;
    const superseding = review("claudea13", head, ["--review-key", "second pass", "--supersedes", firstId, "--reason", "re-reviewed the fix head"]);
    assert.equal(superseding.ok, true, superseding.error);
    const fresh = explainReviews();
    assert.equal(fresh.counts.current, 1);
    assert.equal(fresh.historical[0].id, firstId);
    assert.equal(fresh.historical[0].currency, "superseded");
    assert.equal(fresh.historical[0].successor, fresh.current[0].id);
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), new RegExp(`status=superseded by ${fresh.current[0].id}; historical`));
    const foreign = review("claudea14", head, ["--review-key", "hijack", "--corrects", firstId, "--reason", "not mine"]);
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /same reviewer/);
  });
});

test("COORD-718: a QUESTIONS.md row claiming an independent review is neither counted nor rendered as satisfaction", () => {
  withReviewFixture("c718-questions-", ({ head, tempDir }) => {
    const claim = `Independent review of ${TICKET} at ${head} by claudea13: verdict pass, findings none`;
    const logged = run(["log-question", "--from", "claudea13", "--to", "orchestrator", "--question", claim, "--answer", "recorded here because no writer existed", "--resolved", "yes"], "c718-claudea13");
    assert.equal(logged.ok, true, logged.error);
    assert.match(fs.readFileSync(governanceState.QUESTIONS_PATH, "utf8"), new RegExp(head));

    const readiness = explainReviews();
    assert.equal(readiness.counts.current, 0);
    assert.equal(readiness.counts.total, 0);
    assert.deepEqual(readiness.historical, [], "the question row is not even listed as history");
    assert.equal(JSON.stringify(readiness.current).includes("verdict pass"), false);
    assert.deepEqual(readiness.not_evidence, ["QUESTIONS.md", "self_review_cycles"]);
    assert.equal(fs.readFileSync(governanceState.PLAN_PATH, "utf8").includes("Independent reviews"), false, "PLAN.md renders no review section");

    const summary = closeout.buildSummary({
      ticketId: TICKET, boardPath: governanceState.BOARD_PATH, plansDir: governanceState.PLAN_RECORDS_DIR,
      journalPath: governanceState.GOVERNANCE_EVENT_LOG_PATH, locksDir: governanceState.LOCKS_DIR, rootDir: tempDir,
    });
    const trail = summary.sections.evidence_trail.independent_reviews;
    assert.equal(trail.counts.current, 0);
    assert.deepEqual(trail.current, []);
    assert.equal(closeout.renderText(summary).includes("independent reviews"), false, "closeout text claims no review");
    assert.equal(closeout.renderText(summary).includes(claim), false);
  });
});

test("COORD-718: a control-plane review binds to the coord repository through the default layout", () => {
  withReviewFixture("c718-coord-repo-", () => {
    const layout = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/control-plane-paths.js")).defaultControlPlaneLayout();
    const coordHead = runGit(layout.coordRepoRoot, ["rev-parse", "HEAD"]);
    const result = review("claudea13", coordHead, ["--repository", "coord", "--findings", "F3, F4"]);
    assert.equal(result.ok, true, result.error);
    const [stored] = readPlanRecordFromSandbox(TICKET).independent_reviews;
    assert.deepEqual([stored.repository, stored.commit], ["coord", coordHead]);
    assert.deepEqual(stored.findings, ["F1", "F2", "F3", "F4"], "--finding and a --findings list combine");
    const readiness = explainReviews();
    assert.equal(readiness.counts.current, 0, "a coord commit is not the backend ticket's claimed head");
    assert.equal(readiness.historical[0].currency, "other_repository");
  });
});

test("COORD-718: writer guards refuse an inactive reviewer, an unknown ticket, an unresolvable root, an identity swap and a lost write", () => {
  const createCommand = require("./independent-review-command.js");
  const head = "c".repeat(40);
  const identity = (handle = "claudea13", status = "active") => ({ agent: { id: "a13", handle, status }, session: { session_id: "s13", thread_id: "t13" } });
  const make = (over = {}) => createCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({}),
    getTicketRef: () => ({ row: { Repo: "X", Owner: "unassigned" } }),
    readPlanState: () => ({ ticket_id: "COORD-1" }),
    updateCanonicalPlanState: (_ticket, options) => ({ record: { independent_reviews: [options.independentReview.review] } }),
    withGovernanceMutation: (_mutation, fn) => fn(),
    inferTicketStatus: () => "doing",
    ensureCurrentAgentIdentity: () => identity(),
    context: { repoRegistry: {}, repoRoots: {} },
    controlPlaneLayout: () => ({ coordRepoRoot: "/coord" }),
    gitCommitExists: (root, commit) => root === "/coord" && commit === head,
    ...over,
  }).recordIndependentReviewCommand;
  const args = { commit: head, method: "m", verdict: "pass" };
  const log = console.log;
  console.log = () => {};
  try {
    const stored = make()("COORD-1", args).record.independent_reviews[0];
    assert.deepEqual([stored.repository, stored.owner_at_review, stored.reviewer.session_id], ["coord", null, "s13"], "an unassigned control-plane ticket");
    assert.throws(() => make()(undefined, args), /requires <ticket-id>/);
    assert.throws(() => make({ ensureCurrentAgentIdentity: () => identity("claudea13", "disabled") })("COORD-1", args), /not an active registered agent/);
    assert.throws(() => make({ getTicketRef: () => null })("COORD-1", args), /unknown ticket COORD-1/);
    assert.throws(() => make({ controlPlaneLayout: () => ({ coordRepoRoot: null }) })("COORD-1", args), /cannot resolve repository "coord"/);
    let calls = 0;
    assert.throws(() => make({ ensureCurrentAgentIdentity: () => identity(calls++ ? "claudea14" : "claudea13") })("COORD-1", args), /reviewer identity changed/);
    assert.throws(() => make({ updateCanonicalPlanState: () => ({ record: {} }) })("COORD-1", args), /did not keep the review/);
    assert.throws(() => make({ updateCanonicalPlanState: () => { throw new Error("stale raw token"); } })("COORD-1", args), /record-independent-review: stale raw token/);
  } finally {
    console.log = log;
  }
});
