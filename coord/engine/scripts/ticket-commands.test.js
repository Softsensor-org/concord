"use strict";
const governanceCommands = require("./lifecycle.js").commands;

// COORD-282: DI wiring-guard for the ticket-commands.js extraction.
//
// The six ticket state-mutation functions (collectUnstartEvidenceBlockers,
// unstartTicket, lockAbandonTicket, commitTicket, openFollowup, fileTicket) were
// moved out of lifecycle.js into the createTicketCommands factory. lifecycle.js
// re-wires them with deferred `(...a)=>fn(...a)` wrappers (and the value consts
// STATUS / ALLOWED_TICKET_TYPES / ALLOWED_PRIORITIES injected by reference) and
// re-destructures the six names back into scope.
//
// That wiring only resolves at CALL time. A dropped dep, a typo'd wrapper name,
// or a broken re-destructure would ship silently and only blow up
// ("<dep> is not a function") the first time someone filed a ticket / opened a
// follow-up / reverted a start. This guard drives the factory-produced surface
// THROUGH the lifecycle `__testing` facade so a regression fails the suite
// instead of a live board mutation.
//
// CRITICAL invariant asserted here: the board mutations still ride the COORD-220
// `withBoardTransaction` / single-writer path — each create produces EXACTLY ONE
// journal event and a `board.js validate`-clean row, with the id reserved INSIDE
// the transaction (not reimplemented in the new module).

const test = require("node:test");
const { state } = require("./governance-context.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  withGovernedSurfaceSandbox,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

function seedJournalBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-06-24T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "coord282-wiring-guard" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function writeBacklogBoard(boardPath, rows) {
  const board = {
    version: 1,
    metadata: { title: "COORD-282 wiring-guard board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "COORD-282 Backlog",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows,
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
  fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
}

function row(id, deps = "") {
  return {
    ID: id,
    Repo: "X",
    Type: "chore",
    Pri: "P2",
    Status: "todo",
    Owner: "unassigned",
    Description: `row ${id}`,
    "Depends On": deps,
  };
}

function countEvents(logPath) {
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

// fileTicket + openFollowup both compose withBoardTransaction. Driving both
// through the facade proves the transaction primitive, reserveTicketId, and the
// create-path deferred wrappers (getTicketRef / ensurePromptIndex /
// allBoardRepoCodes / applyFollowupRelation / normalizeFollowupRelation /
// canonicalizeOwnerOrFail / stableIdempotencyKey) all resolved across the seam.
test("COORD-282 wiring-guard: fileTicket + openFollowup ride withBoardTransaction (1 journal event each, reserved ids)", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const before = countEvents(logPath);

    // fileTicket -> withBoardTransaction -> reserveTicketId (inside the lock).
    const filed = governanceCommands.fileTicket(null, {
      repo: "X",
      type: "feature",
      pri: "P1",
      description: "wiring-guard filed ticket",
    });
    assert.equal(filed, "COORD-002", "id reserved off the live board inside the transaction");
    assert.equal(countEvents(logPath), before + 1, "fileTicket = exactly one journal event (single-writer intact)");

    // openFollowup -> withBoardTransaction -> applyFollowupRelation deferred wrappers.
    governanceCommands.openFollowup(null, {
      prefix: "COORD",
      dependsOn: "COORD-002",
      repo: "X",
      type: "chore",
      pri: "P2",
      description: "wiring-guard follow-up",
      relation: "blocking",
      prompt: "coord/prompts/planner.md",
    });
    assert.equal(countEvents(logPath), before + 2, "openFollowup = exactly one more journal event");

    const after = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    const ids = after.sections[0].rows.map((r) => r.ID).sort();
    assert.deepEqual(ids, ["COORD-001", "COORD-002", "COORD-003"], "both creates landed with reserved, non-colliding ids");
    const followup = after.sections[0].rows.find((r) => r.ID === "COORD-003");
    assert.match(followup["Depends On"], /COORD-002/, "blocking follow-up depends on its parent");
  });
});

test("COORD-662: fileTicket prompt titles fall back when the description starts with a blank line", () => {
  withGovernedSurfaceSandbox(() => {
    writeBacklogBoard(state.BOARD_PATH, [row("COORD-001")]);
    seedJournalBaseline();
    const ticket = governanceCommands.fileTicket(null, {
      repo: "X", type: "chore", pri: "P2", description: "\nsecond line remains in the prompt", withPrompt: true,
    });
    const promptRel = JSON.parse(fs.readFileSync(state.BOARD_PATH, "utf8")).prompt_index[ticket];
    const prompt = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", promptRel), "utf8");
    assert.match(prompt, new RegExp(`# ${ticket}: ${ticket} implementation prompt`));
    assert.match(prompt, /\n\nsecond line remains in the prompt/);
  });
});

test("COORD-662: fileTicket refuses unsupported repos and missing backlog sections", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [];
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    seedJournalBaseline();
    const beforeBoard = fs.readFileSync(boardPath);
    assert.throws(() => governanceCommands.fileTicket("COORD-002", {
      repo: "NO-SUCH-REPO", type: "chore", pri: "P2", description: "must not be filed",
    }), /Unsupported repo code/);
    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);

    assert.throws(() => governanceCommands.fileTicket("COORD-002", {
      repo: "X", type: "chore", pri: "P2", description: "must not be filed",
    }), /Could not find a backlog table section/);
    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
    assert.ok(fs.readFileSync(logPath, "utf8").includes("journal-baseline"));
  });
});

test("COORD-662: fileTicket missing required fields refuses before changing board or journal", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeEvents = fs.readFileSync(logPath);

    assert.throws(() => governanceCommands.fileTicket("COORD-002", {}), /requires --repo, --type, --pri, and --description/);

    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
    assert.deepEqual(fs.readFileSync(logPath), beforeEvents);
  });
});

// The two revert verbs and commitTicket are validation-heavy; the cheapest seam
// proof is that they reach their FIRST injected-dep call and throw the expected
// GovernanceError (not a TypeError from an unresolved wrapper).
test("COORD-282 wiring-guard: unstart/lock-abandon/commit reach their injected deps and fail closed (not TypeError)", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    // unstartTicket: resolves the injected resolveOwnerIdentity wrapper and fails
    // closed with a GovernanceError (a dropped wrapper would throw a TypeError).
    assert.throws(
      () => governanceCommands.unstartTicket("COORD-001", { owner: "claudea1" }),
      (err) => err instanceof GovernanceError && /registered agent handle|must be doing/.test(err.message)
    );

    assert.throws(() => governanceCommands.lockAbandonTicket(undefined), /lock-abandon requires <ticket-id>/);
    const { lockAbandonTicket } = createTicketCommands({
      inferTicketStatus: () => null,
      withGovernanceMutation: (_mutation, run) => run(),
      ensureCurrentAgentIdentity: () => ({ agent: { handle: "claudea1" } }),
      readBoard: () => ({}),
      getTicketRef: () => null,
      fail: (message) => { throw new GovernanceError(message); },
    });
    assert.throws(() => lockAbandonTicket("COORD-404", { humanAdminOverride: "administrative recovery" }),
      /Unknown ticket "COORD-404"/);

    // lockAbandonTicket without the override: resolves before the override gate.
    assert.throws(
      () => governanceCommands.lockAbandonTicket("COORD-001", {}),
      (err) => err instanceof GovernanceError && /human-admin-override/.test(err.message)
    );

    // commitTicket via the dispatch surface (not in the facade) — exercised through
    // the commands table to prove its deferred wrappers resolve.
    const { commands } = require("./lifecycle.js");
    assert.equal(typeof commands.commitTicket, "function", "commitTicket re-wired into the dispatch table");
    assert.throws(
      () => commands.commitTicket("COORD-001", {}),
      (err) => err instanceof GovernanceError && /requires --message/.test(err.message)
    );
  });
});

// collectUnstartEvidenceBlockers is the read-only guard shared by both reverts.
// On a clean todo row with no review/landing/plan/workspace evidence it must
// return [] — proving its injected deps (readPlanRecord / integerOrDefault /
// resolveTicketGitContext / planRecordHasImplicitIntendedFilesScaffoldPlaceholder)
// all resolved through the seam.
test("COORD-282 wiring-guard: collectUnstartEvidenceBlockers returns [] for a clean todo row", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();

    const board = __testing.readBoard();
    const blockers = __testing.collectUnstartEvidenceBlockers(
      "COORD-001",
      board.sections[0].rows[0],
      board
    );
    assert.deepEqual(blockers, [], "no auditable evidence on a clean todo row");
  });
});

// COORD-873: the factory's default getPromptsDir hops from coord/engine/scripts up to
// <coord>/prompts. Build the factory WITHOUT getPromptsDir and read the default prompt
// path back through fileTicket's refusal (raised before any file is written).
test("COORD-873: the default getPromptsDir resolves to <coord>/prompts", () => {
  const createTicketCommands = require("./ticket-commands.js");
  const coordRoot = path.resolve(__dirname, "..", "..");
  const ticketId = "COORD-87399";
  const board = {
    sections: [{ kind: "table", columns: ["ID"], rows: [] }],
    prompt_index: { [ticketId]: "coord/prompts/tickets/registered-elsewhere.md" },
  };
  const fail = (message) => { throw new Error(message); };
  const commands = createTicketCommands({
    fail,
    stableIdempotencyKey: () => "coord-873",
    withBoardTransaction: (_mutation, fn) => fn({ board, reserveTicketId: () => ticketId }),
    STATUS: { TODO: "todo", PROPOSED: "proposed" },
    ALLOWED_TICKET_TYPES: ["chore"],
    ALLOWED_PRIORITIES: ["P2"],
    allBoardRepoCodes: () => ["X"],
    getTicketRef: () => null,
  });
  let message = null;
  try {
    commands.fileTicket(ticketId, { repo: "X", type: "chore", pri: "P2", description: "d", withPrompt: true });
  } catch (error) {
    message = error.message;
  }
  const match = /Pass --force to overwrite with (\S+)\.$/.exec(message || "");
  assert.ok(match, `expected the already-registered refusal; got ${message}`);
  assert.equal(
    path.resolve(path.dirname(coordRoot), match[1]),
    path.join(coordRoot, "prompts", "tickets", `${ticketId}.md`),
    "the default prompt path must live under <coord>/prompts"
  );
  assert.equal(path.dirname(path.dirname(path.resolve(path.dirname(coordRoot), match[1]))), path.join(coordRoot, "prompts"));
});

// --- COORD-993 characterization: the workspace refusals in collectUnstartEvidenceBlockers.
// The product-repo branch and the control-plane (Repo X) branch each measure uncommitted
// changes and commits ahead of the base. These tests drive the real factory with stubbed
// collaborators and real git fixtures, and pin the exact blocker text and order. They must
// pass unchanged before and after the shared ahead-count helper is extracted.
const os = require("node:os");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { gitTry } = require("./git-ops.js");
const createTicketCommands = require("./ticket-commands.js");
const { defaultControlPlaneLayout } = require("./control-plane-paths.js");

const COORD993_IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function coord993Git(cwd, args) {
  return gitFixture(cwd, args, { env: COORD993_IDENTITY });
}

// A repo whose origin/dev ref sits at its single base commit.
function coord993BaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord993-"));
  coord993Git(dir, ["init", "-q", "-b", "dev"]);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  coord993Git(dir, ["add", "base.txt"]);
  coord993Git(dir, ["commit", "-q", "-m", "base"]);
  coord993Git(dir, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  return dir;
}

function coord993AddCommit(dir, name) {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  coord993Git(dir, ["add", name]);
  coord993Git(dir, ["commit", "-q", "-m", name]);
}

test("COORD-906: commit refuses unregistered titles before staging the ticket files", (t) => {
  const worktree = coord993BaseRepo();
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(worktree, "release"));
  fs.writeFileSync(path.join(worktree, "release", "suite-inventory.json"), "{}\n");
  fs.writeFileSync(path.join(worktree, "release", "suite-titles.js"),
    "console.error('Unregistered fixture title'); process.exitCode = 1;\n");
  const testFile = "fixture.test.js";
  fs.writeFileSync(path.join(worktree, testFile), "// unregistered fixture\n");
  const commands = createTicketCommands({
    withGovernanceMutation: (_mutation, run) => run(),
    inferTicketStatus: () => "doing",
    readBoard: () => ({}),
    getTicketRef: () => ({ row: { Status: "doing", Repo: "B" } }),
    STATUS: { DOING: "doing" },
    isRepoBackedCode: () => true,
    findLockForTicket: () => ({ worktree }),
    assertTicketMutationOwnership: () => ({}),
    toArray: (value) => value ?? [],
    resolveTicketGitContext: () => ({ repoRoot: defaultControlPlaneLayout().workspaceRoot }),
    readPlanRecord: () => ({ intended_files: [testFile] }),
    gitTry: gitFixtureSpawn,
    runGit: () => assert.fail("title refusal must precede any worktree Git mutation"),
    fail: (message) => { throw new GovernanceError(message); },
  });
  const head = gitFixture(worktree, ["rev-parse", "HEAD"]);
  assert.throws(() => commands.commitTicket("B-697", { files: [testFile], message: "fixture" }),
    /commit refused: changed test titles are not registered for both editions\.\nUnregistered fixture title/);
  assert.equal(gitFixture(worktree, ["diff", "--cached", "--name-only"]), "");
  assert.equal(gitFixture(worktree, ["rev-parse", "HEAD"]), head);
});

function coord993Blockers(worktree, repoCode) {
  const commands = createTicketCommands({
    readPlanRecord: () => null,
    resolveTicketGitContext: () => ({ worktree }),
    resolveTicketBaseRef: () => "dev",
    resolveWorktreeBaseCompareRef: (_worktree, base) => `origin/${base}`,
    isRepoBackedCode: (code) => code !== "X",
    gitTry,
    integerOrDefault: (value, fallback) => (Number.isInteger(value) ? value : fallback),
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder: () => true,
    fail: (message) => {
      throw new Error(message);
    },
  });
  return commands.collectUnstartEvidenceBlockers(
    "COORD-993-T",
    { ID: "COORD-993-T", Repo: repoCode },
    { review_findings: {}, pr_index: {}, landing_index: {} }
  );
}

function coord993WithRepo(run) {
  const dir = coord993BaseRepo();
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-993 characterization: product worktree at origin/dev has no workspace blocker", () => {
  coord993WithRepo((dir) => {
    assert.deepEqual(coord993Blockers(dir, "B"), []);
  });
});

test("COORD-993 characterization: product worktree one commit ahead is refused with the exact text", () => {
  coord993WithRepo((dir) => {
    coord993AddCommit(dir, "ahead.txt");
    assert.deepEqual(coord993Blockers(dir, "B"), [`worktree ${dir} has 1 commit(s) ahead of origin/dev`]);
  });
});

test("COORD-993 characterization: product worktree with untracked work is refused as uncommitted", () => {
  coord993WithRepo((dir) => {
    fs.writeFileSync(path.join(dir, "scratch.txt"), "work\n");
    assert.deepEqual(coord993Blockers(dir, "B"), [`worktree ${dir} has uncommitted changes`]);
  });
});

test("COORD-993 characterization: product worktree reports uncommitted changes before commits ahead", () => {
  coord993WithRepo((dir) => {
    coord993AddCommit(dir, "ahead.txt");
    fs.writeFileSync(path.join(dir, "scratch.txt"), "work\n");
    assert.deepEqual(coord993Blockers(dir, "F"), [
      `worktree ${dir} has uncommitted changes`,
      `worktree ${dir} has 1 commit(s) ahead of origin/dev`,
    ]);
  });
});

test("COORD-993 characterization: control-plane worktree at origin/dev has no workspace blocker", () => {
  coord993WithRepo((dir) => {
    assert.deepEqual(coord993Blockers(dir, "X"), []);
  });
});

test("COORD-993 characterization: control-plane worktree with untracked work is refused as uncommitted", () => {
  coord993WithRepo((dir) => {
    fs.writeFileSync(path.join(dir, "scratch.txt"), "work\n");
    assert.deepEqual(coord993Blockers(dir, "X"), [`control-plane worktree ${dir} has uncommitted changes`]);
  });
});

test("COORD-993 characterization: control-plane worktree one commit ahead is refused with the exact text", () => {
  coord993WithRepo((dir) => {
    coord993AddCommit(dir, "ahead.txt");
    assert.deepEqual(coord993Blockers(dir, "X"), [`control-plane worktree ${dir} has 1 commit(s) ahead of origin/dev`]);
  });
});

test("COORD-993 characterization: a non-git control-plane worktree with entries is refused as not empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord993-plain-"));
  try {
    fs.writeFileSync(path.join(dir, "leftover.txt"), "x\n");
    assert.deepEqual(coord993Blockers(dir, "X"), [`coord worktree ${dir} is not empty`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-1052: unstart refuses unreadable workspace evidence before cleanup or state writes", (t) => {
  coord993WithRepo((dir) => {
    coord993AddCommit(dir, "authored-work.txt");
    const ticket = "COORD-993";
    for (const failure of ["history-error", "history-malformed", "history-missing", "history-empty", "history-unsafe", "directory-error"]) {
      const board = { sections: [{ rows: [{ ID: ticket, Repo: "X", Status: "doing", Owner: "fixture-owner" }] }] };
      const original = JSON.stringify(board);
      const journal = path.join(dir, "fixture-journal");
      const lockPath = path.join(dir, "fixture-lock");
      fs.writeFileSync(journal, "existing journal\n");
      fs.writeFileSync(lockPath, "existing owner binding\n");
      const identity = { agent: { handle: "fixture-owner" } };
      const commands = createTicketCommands({
        inferTicketStatus: () => "doing",
        withGovernanceMutation: (_metadata, run) => run(),
        resolveOwnerIdentity: () => identity,
        readBoard: () => board,
        getTicketRef: () => ({ row: board.sections[0].rows[0] }),
        isDoingStatus: (status) => status === "doing",
        findLockForTicket: () => ({ path: lockPath }),
        canonicalizeOwnerOrFail: (owner) => owner,
        assertTicketMutationOwnership: () => identity,
        readPlanRecord: () => null,
        resolveTicketGitContext: () => ({ worktree: dir }),
        isRepoBackedCode: () => false,
        resolveTicketBaseRef: () => "dev",
        resolveWorktreeBaseCompareRef: () => "origin/dev",
        gitTry: (_cwd, args) => args[0] === "status"
          ? { status: failure === "directory-error" ? 128 : 0, stdout: "" }
          : failure === "history-missing" ? null
          : { status: failure === "history-error" ? 128 : 0, stdout: failure === "history-malformed" ? "not a count" : failure === "history-unsafe" ? "9007199254740992" : "", stderr: "fixture read failed" },
        cleanupClosedTicketWorkspace: () => assert.fail("unverified evidence must not reach workspace cleanup"),
        writeBoard: () => assert.fail("unverified evidence must not change board"),
        fail: (message) => { throw new Error(message); },
      });
      const originalRead = fs.readdirSync;
      const mock = failure === "directory-error" ? t.mock.method(fs, "readdirSync", (target, ...args) => {
        if (target === dir) throw Object.assign(new Error("fixture directory unreadable"), { code: "EIO" });
        return originalRead(target, ...args);
      }) : null;
      try {
        assert.throws(() => commands.unstartTicket(ticket), failure === "directory-error" ? /cannot inspect directory/ : /cannot verify commits ahead/);
        if (failure !== "directory-error") {
          const productCommands = createTicketCommands({
            readPlanRecord: () => null,
            resolveTicketGitContext: () => ({ worktree: dir }),
            isRepoBackedCode: () => true,
            resolveTicketBaseRef: () => "dev",
            resolveWorktreeBaseCompareRef: () => "origin/dev",
            gitTry: (_cwd, args) => args[0] === "status" ? { status: 0, stdout: "" }
              : failure === "history-missing" ? null
              : { status: failure === "history-error" ? 128 : 0, stdout: failure === "history-malformed" ? "not a count" : failure === "history-unsafe" ? "9007199254740992" : "" },
          });
          assert.match(productCommands.collectUnstartEvidenceBlockers(ticket, { ID: ticket, Repo: "B" }, board).join("; "), /cannot verify commits ahead/);
        }
        assert.equal(JSON.stringify(board), original);
        assert.equal(fs.readFileSync(journal, "utf8"), "existing journal\n");
        assert.equal(fs.readFileSync(lockPath, "utf8"), "existing owner binding\n");
        assert.equal(fs.readFileSync(path.join(dir, "authored-work.txt"), "utf8"), "authored-work.txt\n");
      } finally {
        if (mock) mock.mock.restore();
      }
    }
  });
});

test("COORD-1052: contradictory or unresolved duplicate links refuse filing without changing governed state", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    writeBacklogBoard(boardPath, [row("COORD-001")]);
    seedJournalBaseline();
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeJournal = fs.readFileSync(logPath);
    const base = { repo: "X", type: "chore", pri: "P2", description: "candidate remains unfiled" };
    const cases = [
      [{ duplicateOf: "COORD-001", distinctFrom: [" COORD-001 ", "COORD-001"], reason: "contradictory links" }, /either --duplicate-of or --distinct-from, not both/],
      [{ duplicateOf: "COORD-999999" }, /Duplicate-of ticket COORD-999999 does not exist/],
      [{ distinctFrom: " COORD-999999, COORD-999999 ", reason: "missing comparison" }, /Distinct-from ticket COORD-999999 does not exist/],
      [{ distinctFrom: ["COORD-001"], reason: "  " }, /--distinct-from requires --reason/],
    ];
    for (const [links, expected] of cases) {
      assert.throws(() => governanceCommands.fileTicket("COORD-002", { ...base, ...links }), expected);
      assert.deepEqual(fs.readFileSync(boardPath), beforeBoard, "failed relation validation cannot allocate a row or write link metadata");
      assert.deepEqual(fs.readFileSync(logPath), beforeJournal, "failed filing cannot append a success event or advance the journal baseline");
    }
  });
});


test("COORD-1052: prompt replacement refuses without force and preserves the registered file and board", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "coord1052-prompt-replace-"));
  try {
    const promptDir = path.join(root, "prompts");
    const promptPath = path.join(promptDir, "ticket.md");
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(promptPath, "existing approved prompt\n");
    const relPrompt = path.relative(path.resolve(__dirname, "..", "..", ".."), promptPath).replace(/\\/g, "/");
    const board = { sections: [{ kind: "table", columns: ["ID"], rows: [] }], prompt_index: { "COORD-1052": relPrompt } };
    const initialBoard = structuredClone(board);
    const originalPrompt = fs.readFileSync(promptPath);
    const createTicketCommands = require("./ticket-commands.js");
    const commands = createTicketCommands({
      fail: (message) => { throw new Error(message); },
      stableIdempotencyKey: () => "coord1052-prompt-replace",
      withBoardTransaction: (_mutation, run) => {
        const draft = structuredClone(board);
        const result = run({ board: draft, reserveTicketId: () => "COORD-1052" });
        Object.assign(board, draft);
        return result;
      },
      STATUS: { TODO: "todo", PROPOSED: "proposed" }, CREATABLE_STATUSES: ["todo", "proposed"],
      ALLOWED_TICKET_TYPES: ["chore"], ALLOWED_PRIORITIES: ["P2"],
      allBoardRepoCodes: () => ["X"], getTicketRef: () => null,
      getPromptsDir: () => promptDir, getDuplicateGuardIds: () => [],
    });
    const options = { repo: "X", type: "chore", pri: "P2", description: "replacement must be explicit",
      prompt: promptPath, withPrompt: true, replace: true,
      duplicatePolicy: require("../duplicate-check-policy.json") };
    assert.throws(() => commands.fileTicket("COORD-1052", options), /Pass --force with --replace/);
    assert.deepEqual(board, initialBoard, "failed prompt replacement does not publish the drafted ticket or index");
    assert.deepEqual(fs.readFileSync(promptPath), originalPrompt, "the existing prompt is byte-preserved on refusal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1052: PR references block unstart even without other evidence", () => {
  const commands = createTicketCommands({
    readPlanRecord: () => null,
    resolveTicketGitContext: () => ({}),
  });
  assert.deepEqual(commands.collectUnstartEvidenceBlockers("COORD-1", { Repo: "X" }, {
    review_findings: {}, pr_index: { "COORD-1": ["#42", "#43"] }, landing_index: {},
  }), ["pr_index evidence recorded (#42, #43)"]);
});

test("COORD-1052: duplicate and distinct filing record attribution and preserve the right board state", () => {
  for (const identity of [{ agent: { handle: "claudea1" } }, null, new Error("identity unavailable")]) {
    const existing = row("COORD-001");
    const board = { sections: [{ kind: "table", columns: ["ID"], rows: [existing] }], landing_index: { "COORD-001": { recorded_at: "2026-01-01" } } };
    const mutations = [];
    const commands = createTicketCommands({
      fail: (message) => { throw new Error(message); },
      stableIdempotencyKey: () => "test",
      withBoardTransaction: (mutation, run) => { const result = run({ board, reserveTicketId: () => "COORD-002" }); mutations.push(structuredClone(mutation)); return result; },
      withCoordStateLock: (run) => run(), writeBoard: () => {}, runBoardSync: () => {},
      STATUS: { TODO: "todo", PROPOSED: "proposed" }, ALLOWED_TICKET_TYPES: ["chore"], ALLOWED_PRIORITIES: ["P2"],
      allBoardRepoCodes: () => ["X"], getTicketRef: (_board, id) => id === "COORD-001" ? { row: existing } : null,
      getDuplicateGuardIds: () => [],
      ensureCurrentAgentIdentity: () => { if (identity instanceof Error) throw identity; return identity || {}; },
    });
    const base = { repo: "X", type: "chore", pri: "P2", description: "separate behavior", duplicatePolicy: { enforcement: "off" } };
    assert.equal(commands.fileTicket(null, { ...base, duplicateOf: "COORD-001" }), null);
    assert.equal(board.sections[0].rows.length, 1);
    assert.equal(mutations[0].ticket, "COORD-001");
    assert.equal(mutations[0].details.duplicate_note.recorded_by, identity?.agent?.handle || "unknown");
    assert.equal(commands.fileTicket(null, { ...base, distinctFrom: [" COORD-001 ", "COORD-001"], reason: "different scope" }), "COORD-002");
    assert.equal(board.sections[0].rows.length, 2);
    assert.deepEqual(mutations[1].details.distinct_record.distinct_from, ["COORD-001"]);
    assert.equal(mutations[1].details.distinct_record.recorded_by, identity?.agent?.handle || "unknown");
  }
});

test("COORD-1052: prompt creation initializes an absent index, and force replaces an existing prompt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-prompt-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const promptDir = path.join(root, "prompts");
  const board = { sections: [{ kind: "table", columns: ["ID"], rows: [] }] };
  const mutations = [];
  const commands = createTicketCommands({
    fail: (message) => { throw new Error(message); }, stableIdempotencyKey: () => "prompt",
    withBoardTransaction: (mutation, run) => { const result = run({ board, reserveTicketId: () => "COORD-1052" }); mutations.push(structuredClone(mutation)); return result; },
    withCoordStateLock: (run) => run(), writeBoard: () => {}, runBoardSync: () => {},
    STATUS: { TODO: "todo", PROPOSED: "proposed" }, ALLOWED_TICKET_TYPES: ["chore"], ALLOWED_PRIORITIES: ["P2"],
    allBoardRepoCodes: () => ["X"], getTicketRef: () => null, getDuplicateGuardIds: () => [], getPromptsDir: () => promptDir,
  });
  const options = { repo: "X", type: "chore", pri: "P2", description: "first prompt", withPrompt: true, duplicatePolicy: { enforcement: "off" } };
  assert.equal(commands.fileTicket("COORD-1052", options), "COORD-1052");
  const promptPath = path.join(promptDir, "tickets", "COORD-1052.md");
  assert.match(fs.readFileSync(promptPath, "utf8"), /first prompt/);
  assert.equal(mutations[0].details.prompt.created, true);
  assert.ok(board.prompt_index["COORD-1052"]);
  assert.equal(commands.fileTicket("COORD-1052", { ...options, description: "replacement prompt", replace: true, force: true }), "COORD-1052");
  assert.match(fs.readFileSync(promptPath, "utf8"), /replacement prompt/);
  assert.equal(mutations[1].details.prompt.overwritten, true);
});

test("COORD-1052: follow-up refuses to replace an existing unregistered child prompt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-followup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const promptDir = path.join(root, "prompts");
  const childPrompt = path.join(promptDir, "tickets", "COORD-002.md");
  fs.mkdirSync(path.dirname(childPrompt), { recursive: true });
  fs.writeFileSync(childPrompt, "existing child prompt\n");
  const parent = row("COORD-001");
  const original = { sections: [{ kind: "table", columns: ["ID"], rows: [parent] }], prompt_index: {} };
  let writes = 0;
  const commands = createTicketCommands({
    fail: (message) => { throw new Error(message); }, stableIdempotencyKey: () => "followup",
    withBoardTransaction: (_mutation, run) => run({ board: structuredClone(original), reserveTicketId: () => "COORD-002" }),
    withCoordStateLock: (run) => run(), writeBoard: () => { writes++; }, runBoardSync: () => {},
    STATUS: { TODO: "todo" }, allBoardRepoCodes: () => ["X"],
    getTicketRef: (board, id) => id === "COORD-001" ? { section: board.sections[0], rowIndex: 0 } : null,
    normalizeFollowupRelation: () => "blocking", applyFollowupRelation: () => "COORD-001", getPromptsDir: () => promptDir,
  });
  assert.throws(() => commands.openFollowup("COORD-002", { dependsOn: "COORD-001", repo: "X", type: "chore", pri: "P2", description: "child" }), /already exists; use --prompt/);
  assert.equal(fs.readFileSync(childPrompt, "utf8"), "existing child prompt\n");
  assert.equal(writes, 0);
  assert.equal(original.sections[0].rows.length, 1);
});

test("COORD-1052: duplicate enforcement refuses before allocation even when guard registry is unreadable", (t) => {
  const description = "repair landing-resolution.js with reliable recovery";
  const parent = { ...row("COORD-001"), Description: description };
  const backlog = { kind: "table", columns: ["ID"], rows: [parent] };
  const prose = { kind: "markdown", level: 2, heading: "Context", body: [description] };
  const board = { sections: [prose, backlog] };
  let reservations = 0;
  let writes = 0;
  const realRead = fs.readFileSync;
  const registry = path.join(__dirname, "..", "governance-guards.json");
  let registryContents = null;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === registry) {
      if (registryContents === null) throw new Error("unreadable registry");
      return registryContents;
    }
    return realRead.call(fs, file, ...args);
  });
  const commands = createTicketCommands({
    fail: (message) => { throw new Error(message); }, stableIdempotencyKey: () => "duplicate",
    withBoardTransaction: (_mutation, run) => run({ board, reserveTicketId: () => { reservations++; return "COORD-002"; } }),
    withCoordStateLock: (run) => run(), writeBoard: () => { writes++; }, runBoardSync: () => {},
    STATUS: { TODO: "todo", PROPOSED: "proposed" }, ALLOWED_TICKET_TYPES: ["chore"], ALLOWED_PRIORITIES: ["P2"],
    allBoardRepoCodes: () => ["X"], getTicketRef: (_board, id) => id === "COORD-001" ? { row: parent } : null,
  });
  const options = { repo: "X", type: "chore", pri: "P2", description, duplicatePolicy: { enforcement: "on" } };
  assert.throws(() => commands.fileTicket(null, options), /likely duplicate of COORD-001/);
  assert.equal(reservations, 0);
  assert.equal(writes, 0);
  registryContents = "{}";
  assert.throws(() => commands.fileTicket(null, options), /likely duplicate of COORD-001/);
  assert.equal(reservations, 0);
  assert.equal(writes, 0);
  assert.equal(backlog.rows.length, 1);
  assert.throws(() => commands.fileTicket(null, { ...options, type: "bogus" }), /requires --type/);
  assert.throws(() => commands.fileTicket(null, { ...options, pri: "bogus" }), /requires --pri/);

  delete board.sections;
  assert.throws(() => commands.fileTicket("COORD-002", options), /Could not find a backlog table section/);
  assert.equal(reservations, 0);
  assert.equal(writes, 0);
});

test("COORD-1052: filing rejects invalid status and records a canonicalized owner", () => {
  const board = { sections: [{ kind: "table", columns: ["ID"], rows: [] }] };
  let writes = 0;
  const commands = createTicketCommands({
    fail: (message) => { throw new Error(message); }, stableIdempotencyKey: () => "owner",
    withBoardTransaction: (_mutation, run) => run({ board, reserveTicketId: () => "COORD-002" }),
    withCoordStateLock: (run) => run(), writeBoard: () => { writes++; }, runBoardSync: () => {},
    STATUS: { TODO: "todo", PROPOSED: "proposed" }, ALLOWED_TICKET_TYPES: ["chore"], ALLOWED_PRIORITIES: ["P2"],
    allBoardRepoCodes: () => ["X"], getTicketRef: () => null, getDuplicateGuardIds: () => [],
    canonicalizeOwnerOrFail: (owner) => owner.toLowerCase(),
  });
  const base = { repo: "X", type: "chore", pri: "P2", description: "distinct work", owner: "CLAUDEA1", duplicatePolicy: { enforcement: "off" } };
  assert.throws(() => commands.fileTicket(null, { ...base, status: "done" }), /requires --status/);
  assert.equal(writes, 0);
  assert.equal(commands.fileTicket(null, { ...base, status: "proposed" }), "COORD-002");
  assert.equal(board.sections[0].rows[0].Owner, "claudea1");
  assert.equal(board.sections[0].rows[0].Status, "proposed");
  assert.equal(writes, 1);
});
