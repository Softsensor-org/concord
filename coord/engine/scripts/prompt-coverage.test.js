const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test");
const governanceCommands = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js")).commands;
const assert = require("node:assert/strict");
const { state: governanceState, DEFAULT_PATHS } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));

const {
  __testing,
  createTempGitRepo,
  createTempGitRepoWithOrigin,
  executeCommand,
  withScopedGovernanceTestContext,
} = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));

// COORD-099 (governance.test residual split, slice 4): prompt-coverage
// behavior. Every subject here is DEFINED in prompt-coverage.js (the
// createPromptCoverage factory) — the module that owns prompt parsing, waiver
// reads, and precondition resolution:
//   - parsePromptLikelyFiles / parsePromptPreconditions
//   - classifyPreconditionArtifact / verifyPromptPreconditions
//   - hasPromptWaiver / buildPromptWaiverCommand
// Leaf parsing, waiver formatting and ref checks are exercised through the
// prompt-coverage owner factory. The register-prompt VERB and start-gate (assertPromptPrecondition
// Resolve) integration tests stay in governance.test.js: those drive the
// governance facade end-to-end (executeCommand / path-seam rebinding /
// GovernanceError), not the parsing units owned here.

test("hasPromptWaiver reads machine-readable waiver records from board state", () => {
  const board = {
    waiver_index: {
      "DEBT-046": {
        code: "prompt_coverage",
        reason: "Direct human instruction approved without prompt remap.",
        recorded_at: "2026-03-30T12:00:00.000Z",
        recorded_by: "codexa00",
      },
    },
  };

  assert.equal(promptTesting.hasPromptWaiver(board, "DEBT-046"), true);
  assert.equal(promptTesting.hasPromptWaiver(board, "DEBT-999"), false);
  assert.equal(
    promptTesting.buildPromptWaiverCommand("DEBT-046"),
    'coord/scripts/gov set-waiver DEBT-046 --reason "<why prompt coverage waiver is accepted>"'
  );
});

test("COORD-009: parsePromptLikelyFiles extracts the Likely Files section, ignoring annotations and TODO stubs", () => {
  const prompt = [
    "# SEC-010: harden session handling.",
    "",
    "## Context",
    "Some context paragraph mentioning `src/red-herring.ts` in prose.",
    "",
    "## Likely Files",
    "",
    "- `src/auth/session.ts`",
    "- `src/auth/token.ts` — the token mint path",
    "* services/api/middleware/auth.ts",
    "1. `src/auth/index.ts`",
    "- TODO: add more as discovered",
    "- (none)",
    "",
    "## Verification",
    "- `node --test`",
  ].join("\n");
  const parsed = promptTesting.parsePromptLikelyFiles(prompt);
  assert.deepEqual(parsed, [
    "src/auth/session.ts",
    "src/auth/token.ts",
    "services/api/middleware/auth.ts",
    "src/auth/index.ts",
  ]);
  // A prompt with no Likely Files section seeds nothing.
  assert.deepEqual(
    promptTesting.parsePromptLikelyFiles("# T\n\n## Context\nNothing here.\n"),
    []
  );
  // Non-string / empty input is tolerated.
  assert.deepEqual(promptTesting.parsePromptLikelyFiles(null), []);
  assert.deepEqual(promptTesting.parsePromptLikelyFiles(""), []);
});

test("COORD-008: parsePromptPreconditions extracts the optional section, ignoring everything else", () => {
  const prompt = [
    "# TICKET-1: do a thing",
    "",
    "## Context",
    "Some prose with a `## Preconditions` mention that is not a heading.",
    "",
    "## Preconditions",
    "- path:apps/ui/lib/floor.ts",
    "- `/floor-workscreen`",
    "- symbol:apps/ui/screens/Call.tsx#CallCenterWorkscreen — the gated screen",
    "- TODO: placeholder line that must be ignored",
    "",
    "## Likely Files",
    "- apps/ui/screens/NewThing.tsx",
  ].join("\n");
  const preconditions = promptTesting.parsePromptPreconditions(prompt);
  assert.deepEqual(preconditions, [
    "path:apps/ui/lib/floor.ts",
    "/floor-workscreen",
    "symbol:apps/ui/screens/Call.tsx#CallCenterWorkscreen",
  ]);
});

test("COORD-008: a prompt with no Preconditions section declares nothing (back-compat)", () => {
  const prompt = [
    "# TICKET-2",
    "## Context",
    "no preconditions here",
    "## Likely Files",
    "- a.ts",
  ].join("\n");
  assert.deepEqual(promptTesting.parsePromptPreconditions(prompt), []);
  assert.deepEqual(promptTesting.parsePromptPreconditions(null), []);
  assert.deepEqual(promptTesting.parsePromptPreconditions(""), []);
  assert.deepEqual(promptTesting.parsePromptPreconditions("## Preconditions\n- ``\n"), []);
});

test("COORD-008: classifyPreconditionArtifact distinguishes paths, routes, and symbols", () => {
  assert.equal(promptTesting.classifyPreconditionArtifact("path:a/b.ts").kind, "path");
  assert.equal(promptTesting.classifyPreconditionArtifact("route:/x").kind, "literal");
  const sym = promptTesting.classifyPreconditionArtifact("symbol:a/b.ts#Foo");
  assert.equal(sym.kind, "symbol");
  assert.equal(sym.path, "a/b.ts");
  assert.equal(sym.symbol, "Foo");
  // Bare tokens: a leading slash is a route literal, a path-like token is a path.
  assert.equal(promptTesting.classifyPreconditionArtifact("/floor-workscreen").kind, "literal");
  assert.equal(promptTesting.classifyPreconditionArtifact("apps/ui/lib/floor.ts").kind, "path");
  // A bare symbol name with no separator greps as a literal.
  assert.equal(promptTesting.classifyPreconditionArtifact("CallCenterWorkscreen").kind, "literal");
  // A malformed symbol entry is invalid.
  assert.equal(promptTesting.classifyPreconditionArtifact("symbol:nohash").kind, "invalid");
});

test("COORD-008: verifyPromptPreconditions passes when declared artifacts resolve on the integration ref", () => {
  const repo = createTempGitRepoWithOrigin("coord008-ok-", {
    "src/floor.ts": "export const floorWorkscreen = '/floor-workscreen';\n",
    "src/screens/Call.tsx": "export function CallCenterWorkscreen() { return null; }\n",
  });
  const report = promptTesting.verifyPromptPreconditions(repo.repoRoot, "dev", [
    "path:src/floor.ts",
    "/floor-workscreen",
    "symbol:src/screens/Call.tsx#CallCenterWorkscreen",
  ]);
  assert.equal(report.ok, true, `expected all preconditions to resolve; unresolved=${JSON.stringify(report.unresolved)}`);
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.verified.length, 3);
});

test("COORD-008: verifyPromptPreconditions fails when a declared artifact resolves in no branch", () => {
  const repo = createTempGitRepoWithOrigin("coord008-stale-", {
    "src/existing.ts": "export const ok = true;\n",
  });
  const report = promptTesting.verifyPromptPreconditions(repo.repoRoot, "dev", [
    "path:src/existing.ts",
    "path:src/screens/CallCenterWorkscreen.tsx",
    "/floor-workscreen",
  ]);
  assert.equal(report.ok, false);
  const unresolvedRaw = report.unresolved.map((u) => u.raw).sort();
  assert.deepEqual(unresolvedRaw, ["/floor-workscreen", "path:src/screens/CallCenterWorkscreen.tsx"]);
  // The artifact that DOES exist is still reported as verified.
  assert.deepEqual(report.verified.map((v) => v.raw), ["path:src/existing.ts"]);
});

test("COORD-008: verifyPromptPreconditions with an empty precondition list is a no-op pass", () => {
  const repo = createTempGitRepoWithOrigin("coord008-empty-", { "a.txt": "x\n" });
  const report = promptTesting.verifyPromptPreconditions(repo.repoRoot, "dev", []);
  assert.equal(report.ok, true);
  assert.equal(report.unresolved.length, 0);
});

test("COORD-662: absent prompt paths are tolerated and malformed artifact refs report a refusal", () => {
  // COORD-956: the prompt-record check runs the content contract and coverage before the
  // preconditions. An unmapped ticket with no on-disk prompt is a coverage refusal (the
  // start message the retired preconditions guard never reached), and a mapped prompt file
  // that is absent is a content refusal. Both refuse before any precondition is read.
  const missingBoard = { prompt_index: {} };
  assert.equal(admitsPrompt(() => __testing.assertPromptRecord("COORD-001", {}, missingBoard, {})), false);
  assert.doesNotThrow(() => __testing.seedStartIntendedFilesFromPrompt("COORD-001", missingBoard));

  const missingFileBoard = { prompt_index: { "COORD-001": "coord/prompts/tickets/COORD-001-not-present.md" } };
  assert.throws(() => __testing.assertPromptRecord("COORD-001", {}, missingFileBoard, {}), /COORD-001 cannot start[\s\S]*unreadable/);
  assert.doesNotThrow(() => __testing.seedStartIntendedFilesFromPrompt("COORD-001", missingFileBoard));

  const repo = createTempGitRepoWithOrigin("coord662-unresolved-ref-", { "src/existing.js": "export const ready = true;\n" });
  try {
    const missingRef = promptTesting.verifyPromptPreconditions(repo.repoRoot, "does-not-exist", ["path:src/existing.js"]);
    assert.equal(missingRef.ok, false);
    assert.equal(missingRef.unresolved[0].raw, "path:src/existing.js");
    assert.match(missingRef.unresolved[0].reason, /does not resolve/);

    const invalid = promptTesting.verifyPromptPreconditions(repo.repoRoot, "dev", ["symbol:missing-hash"]);
    assert.equal(invalid.ok, false);
    assert.match(invalid.unresolved[0].reason, /use "symbol:<repo-relative-path>#<symbol>"/);
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
  }
});

test("COORD-662: registerPrompt refuses empty and unknown ticket IDs without changing governed state", () => {
  withRegisterPromptHarness("coord662-register-refusal-", { ticketId: "IMP-720" }, ({ boardPath }) => {
    const eventLogPath = governanceState.GOVERNANCE_EVENT_LOG_PATH;
    const beforeBoard = fs.readFileSync(boardPath);
    const beforeEvents = fs.readFileSync(eventLogPath);

    assert.throws(() => governanceCommands.registerPrompt("", {}), /requires <ticket-id>/);
    assert.throws(() => governanceCommands.registerPrompt("IMP-999", {}), /Unknown ticket/);

    assert.deepEqual(fs.readFileSync(boardPath), beforeBoard);
    assert.deepEqual(fs.readFileSync(eventLogPath), beforeEvents);
  });
});

test("COORD-662: registerPrompt initializes a missing legacy prompt_index before writing its mapping", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-missing-prompt-index-"));
  const coordDir = path.join(root, "coord");
  const promptAbs = path.join(coordDir, "prompts", "tickets", "IMP-721.md");
  fs.mkdirSync(path.dirname(promptAbs), { recursive: true });
  fs.writeFileSync(promptAbs, "# IMP-721 existing prompt\n", "utf8");
  const board = { rows: [{ ID: "IMP-721" }] };
  const writes = [];
  const syncCalls = [];
  const coverage = createPromptCoverage({
    ROOT_DIR: root,
    COORD_DIR: coordDir,
    fail: (message) => { throw new Error(message); },
    inferTicketStatus: () => "todo",
    getTicketRef: (_board, ticketId) => {
      const row = board.rows.find((candidate) => candidate.ID === ticketId);
      return row ? { row } : null;
    },
    readBoard: () => board,
    withGovernanceMutation: (_mutation, run) => run(),
    withCoordStateLock: (run) => run(),
    writeBoard: (value) => writes.push(structuredClone(value)),
    runBoardSync: (options) => syncCalls.push(structuredClone(options)),
  });

  try {
    const result = coverage.registerPrompt("IMP-721", { path: "coord/prompts/tickets/IMP-721.md" });
    assert.equal(result.prompt, "coord/prompts/tickets/IMP-721.md");
    assert.deepEqual(board.prompt_index, { "IMP-721": "coord/prompts/tickets/IMP-721.md" });
    assert.deepEqual(writes, [board]);
    assert.deepEqual(syncCalls, [{ ignoreActiveTicketLockErrors: true }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-662: body authoring ignores empty peer mappings and safely handles malformed shared paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-malformed-shared-prompt-"));
  const coordDir = path.join(root, "coord");
  const promptsDir = path.join(coordDir, "prompts");
  const promptAbs = path.join(promptsDir, "tickets", "IMP-724.md");
  const bodyAbs = path.join(root, "replacement-body.md");
  fs.mkdirSync(path.dirname(promptAbs), { recursive: true });
  fs.writeFileSync(promptAbs, "previous body\n", "utf8");
  fs.writeFileSync(bodyAbs, "replacement body\n", "utf8");
  const board = {
    rows: [{ ID: "IMP-724", Status: "todo", Owner: "unassigned" }],
    prompt_index: {
      "IMP-724": "coord/prompts/tickets/IMP-724.md",
      "IMP-725": null,
      "IMP-726": "coord/prompts/../../outside.md",
    },
  };
  const syncCalls = [];
  const coverage = createPromptCoverage({
    ROOT_DIR: root,
    COORD_DIR: coordDir,
    fail: (message) => { throw new Error(message); },
    inferTicketStatus: () => "todo",
    getTicketRef: (_board, ticketId) => {
      const row = board.rows.find((candidate) => candidate.ID === ticketId);
      return row ? { row } : null;
    },
    readBoard: () => board,
    normalizeOwnerValue: (value) => value || "unassigned",
    ensureCurrentAgentIdentity: () => ({ owner: "codexa11" }),
    findLockForTicket: () => null,
    isDoingStatus: (status) => status === "doing",
    withGovernanceMutation: (_mutation, run) => run(),
    withCoordStateLock: (run) => run(),
    writeFileAtomicSync: (file, content) => fs.writeFileSync(file, content, "utf8"),
    runBoardSync: (options) => syncCalls.push(structuredClone(options)),
    getPromptsDir: () => promptsDir,
  });

  try {
    const result = coverage.registerPrompt("IMP-724", { bodyFile: bodyAbs });
    assert.equal(result.bodyAuthored, true);
    assert.equal(fs.readFileSync(promptAbs, "utf8"), "replacement body\n");
    assert.deepEqual(syncCalls, [{ ignoreActiveTicketLockErrors: true }]);
    assert.equal(board.prompt_index["IMP-725"], null);
    assert.equal(board.prompt_index["IMP-726"], "coord/prompts/../../outside.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-662: seedStartIntendedFilesFromPrompt returns for no likely files and a missing plan record", () => {
  withRegisterPromptHarness("coord662-seed-early-returns-", { ticketId: "IMP-722" }, ({ promptOnDisk, ticketId }) => {
    const board = { prompt_index: { [ticketId]: promptOnDisk } };
    fs.writeFileSync(promptOnDisk, "# Prompt\n\n## Context\nNo file list here.\n", "utf8");
    assert.doesNotThrow(() => __testing.seedStartIntendedFilesFromPrompt(ticketId, board));

    fs.writeFileSync(promptOnDisk, "# Prompt\n\n## Likely Files\n- src/real-file.js\n", "utf8");
    assert.doesNotThrow(() => __testing.seedStartIntendedFilesFromPrompt(ticketId, board));
    assert.deepEqual(fs.readdirSync(governanceState.PLAN_RECORDS_DIR), []);
  });
});

test("COORD-662: prompt preconditions for coordination-owned tickets resolve against the coord repository", () => {
  withRegisterPromptHarness("coord662-coord-precondition-", { ticketId: "IMP-723" }, ({ promptOnDisk, ticketId }) => {
    fs.writeFileSync(promptOnDisk,
      // COORD-867: a permanent coord entrypoint, so the precondition resolves on every reviewed ref including the canonical origin/HEAD.
      "# Prompt\n\n## Acceptance Criteria\n\n- The coordination entrypoint resolves on HEAD.\n\n## Preconditions\n- path:coord/scripts/governance.js\n", "utf8");
    const board = { prompt_index: { [ticketId]: promptOnDisk } };
    assert.doesNotThrow(() => __testing.assertPromptRecord(ticketId, { Repo: "X" }, board, { preconditionRef: "HEAD" }));
  });
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createPromptCoverage = require("./prompt-coverage.js");
const { COORD_DIR, ROOT_DIR } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const PROMPT_WAIVER_CODES = new Set(["prompt_coverage"]);
const createGovernanceBoardState = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-board-state.js"));
const createWorktreeOps = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/worktree-ops.js"));
const { gitTry } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/git-ops.js"));
const { gitPathExistsAtRef, gitRefContainsLiteral } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/feature-proof-resolution.js"));
const { withCanonicalTicketPrompt, withRegisterPromptHarness: promptHarness } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const promptBoardState = createGovernanceBoardState({ WAIVER_CODES: PROMPT_WAIVER_CODES });
const promptWorktreeOps = createWorktreeOps({ gitTry });
const promptTesting = createPromptCoverage({
  ROOT_DIR,
  COORD_DIR,
  uniqueStrings: (values) => [...new Set(values)],
  readTicketWaiver: promptBoardState.readTicketWaiver,
  gitCommitishExists: promptWorktreeOps.gitCommitishExists,
  gitPathExistsAtRef,
  gitRefContainsLiteral,
  getPromptsDir: () => governanceState.PROMPTS_DIR,
});
function withRegisterPromptHarness(prefix, options, body) {
  return promptHarness(prefix, { ...options, materializeViews: true }, body);
}


// ---------------------------------------------------------------------------
// COORD-023: prompt registration ergonomics — register-prompt verb + start
// auto-discover of an on-disk prompt.
// ---------------------------------------------------------------------------

// Fixture-self-contained canonical-prompt provisioning. These tests exercise the
// real on-disk prompt resolution (COORD_DIR/prompts/tickets/<id>.md), which the
// public-release builder strips (it deletes coord/prompts/tickets/*.md and resets
// the board). Rather than depend on a specific donor prompt that may not exist in
// a built/adopter checkout, write the canonical prompt on disk if it is missing
// and remove only what we created — so the coverage runs identically in the donor
// (file already present → no-op) and in a stripped public artifact (created
// transiently). Self-contained: no reliance on which donor tickets happen to ship.

test("COORD-023: defaultTicketPromptRelPath / ticketPromptRelPathExists resolve the canonical on-disk prompt", () => {
  // Self-contained: ensure COORD-023's canonical prompt exists on disk; a bogus id does not.
  withCanonicalTicketPrompt("COORD-023", "# COORD-023 fixture prompt\n", () => {
    const rel = promptTesting.defaultTicketPromptRelPath("COORD-023");
    assert.equal(rel, "coord/prompts/tickets/COORD-023.md");
    assert.equal(promptTesting.ticketPromptRelPathExists(rel), true);
    assert.equal(
      promptTesting.ticketPromptRelPathExists(promptTesting.defaultTicketPromptRelPath("COORD-999-NOPE")),
      false,
    );
  });
});


test("COORD-023: ensurePromptCoverageOrDiscover registers an on-disk prompt and reports false when neither exists", () => {
  // Exercise the production factory with only its discovery-path collaborators.
  // The broader lifecycle harness redirects mutable paths, but board.js
  // deliberately pins validation reads to its own checkout; calling its real
  // runBoardSync here made this unit test depend on whichever live tickets had
  // runtime plans or locks. Explicit collaborators keep the behavior hermetic
  // while still proving both durable writes are load-bearing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord023-discover-"));
  const coordDir = path.join(root, "coord");
  const promptsDir = path.join(coordDir, "prompts");
  const writtenBoards = [];
  const syncCalls = [];
  const promptCoverage = createPromptCoverage({
    ROOT_DIR: root,
    COORD_DIR: coordDir,
    getPromptsDir: () => promptsDir,
    readTicketWaiver: () => null,
    fail: (message) => { throw new Error(message); },
    withCoordStateLock: (fn) => fn(),
    writeBoard: (board) => writtenBoards.push(structuredClone(board)),
    runBoardSync: (options) => syncCalls.push(structuredClone(options)),
  });

  try {
    const promptAbs = path.join(promptsDir, "tickets", "COORD-024.md");
    fs.mkdirSync(path.dirname(promptAbs), { recursive: true });
    // COORD-813 ruling: the ticket's own prompt must carry an Acceptance heading.
    fs.writeFileSync(promptAbs, "# COORD-024 fixture prompt\n\n## Acceptance\n\n- The prompt is discovered.\n", "utf8");

    const discoveredBoard = { prompt_index: {}, waiver_index: {} };
    assert.equal(
      admitsPrompt(() => promptCoverage.assertPromptRecord("COORD-024", { Repo: "X" }, discoveredBoard, {})),
      true,
      "an on-disk prompt must be discovered",
    );
    assert.equal(discoveredBoard.prompt_index["COORD-024"], "coord/prompts/tickets/COORD-024.md");
    assert.equal(writtenBoards.length, 1, "discovery must persist the prompt mapping");
    assert.equal(writtenBoards[0].prompt_index["COORD-024"], "coord/prompts/tickets/COORD-024.md");
    assert.deepEqual(syncCalls, [{ ignoreActiveTicketLockErrors: true }]);

    const missingBoard = { prompt_index: {}, waiver_index: {} };
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("GHOST-001", { Repo: "X" }, missingBoard, {})), false);
    assert.equal(writtenBoards.length, 1, "a missing prompt must not write the board");
    assert.equal(syncCalls.length, 1, "a missing prompt must not render artifacts");

    // COORD-813: a mapping must point at a readable prompt; a dangling one no
    // longer counts as coverage.
    fs.writeFileSync(path.join(promptsDir, "implementer.md"), "# Implementer Role\n", "utf8");
    const registeredBoard = {
      prompt_index: { "IMP-700": "coord/prompts/implementer.md" },
      waiver_index: {},
    };
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("IMP-700", { Repo: "X" }, registeredBoard, {})), true);
    assert.equal(registeredBoard.prompt_index["IMP-700"], "coord/prompts/implementer.md");
    assert.equal(writtenBoards.length, 1, "an existing mapping must remain a read-only fast path");
    assert.equal(syncCalls.length, 1, "an existing mapping must not re-render artifacts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readLastJournalEvent(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function seedPromptWriterSession(ticketId) {
  const threadId = `coord662-thread-${ticketId}-${process.pid}`;
  const now = new Date().toISOString();
  fs.writeFileSync(governanceState.AGENT_SESSIONS_PATH, `${JSON.stringify([{
    session_id: `a11-${ticketId}`,
    agent_id: "a11",
    handle: "claudea11",
    board_path: governanceState.BOARD_PATH,
    thread_id: threadId,
    claimed_at: now,
    last_seen_at: now,
    status: "active",
    auto_claimed: false,
  }], null, 2)}\n`, "utf8");
  return {
    env: {
      COORD_SESSION_ID: threadId,
      CLAUDE_CODE_SESSION_ID: `provider-${threadId}`,
      CLAUDE_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
      GEMINI_THREAD_ID: undefined,
      GROK_THREAD_ID: undefined,
    },
    sessionId: `a11-${ticketId}`,
  };
}

function appendPromptFixtureBaseline() {
  // These tests intentionally seed or rewrite board state directly. Regenerate
  // the fixture's derived views before anchoring that synthetic state so the
  // governed command sees a coherent baseline.
  require("../../board/board.js").renderBoardArtifacts();
  __testing.appendGovernanceEvent({
    ts: new Date().toISOString(), command: "fixture-baseline", ticket: null,
    before_status: null, after_status: null, identity: null, details: null,
    changed_paths: [], snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function fixturePromptReference(promptPath) {
  return path.relative(process.cwd(), promptPath).replace(/\\/g, "/");
}


test("COORD-350: register-prompt --create creates a missing canonical prompt and mapping atomically", () => {
  withRegisterPromptHarness("coord350-create-", { ticketId: "IMP-701" }, ({ readBoard }) => {
    const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-701.md");
    const result = governanceCommands.registerPrompt("IMP-701", { create: true, path: promptPath });
    const board = readBoard();
    const promptRel = board.prompt_index["IMP-701"];

    assert.equal(result.created, true);
    assert.equal(promptRel.endsWith("/prompts/tickets/IMP-701.md"), true);
    assert.equal(fs.existsSync(path.resolve(__dirname, "..", "..", "..", promptRel)), true);

    const event = readLastJournalEvent(governanceState.GOVERNANCE_EVENT_LOG_PATH);
    assert.equal(event.command, "register-prompt");
    assert.equal(event.result, "succeeded");
    assert.ok(
      event.changed_paths.some((p) => String(p).endsWith("/prompts/tickets/IMP-701.md")),
      "created prompt file is inside the journaled mutation snapshot"
    );

    // A second governed command should be idempotent and should not require a
    // manual reconcile after the create/register command.
    const again = governanceCommands.registerPrompt("IMP-701", {});
    assert.equal(again, undefined);
  });
});

test("COORD-662: register-prompt --body-file updates only the existing mapped prompt and journals it", () => {
  withRegisterPromptHarness("coord662-body-", { ticketId: "IMP-704" }, ({ readBoard, renderFixtureViews }) => {
      const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-704.md");
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-body-source-"));
    const bodyPath = path.join(bodyDir, "body.md");
    const body = "## Exact body\n\nKeep $(date), `echo`, $HOME, 'single', and \"double\" quotes.\nNext line.\n";
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "old body\n", "utf8");
    fs.chmodSync(promptPath, 0o640);
    fs.writeFileSync(bodyPath, body, "utf8");
    try {
      const board = readBoard();
      board.prompt_index["IMP-704"] = fixturePromptReference(promptPath);
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      renderFixtureViews();
      const actor = seedPromptWriterSession("IMP-704");
      appendPromptFixtureBaseline();

      const result = executeCommand(["register-prompt", "IMP-704", "--body-file", bodyPath], actor);

      assert.equal(result.ok, true, result.error || result.stderr);
      assert.equal(result.value.bodyAuthored, true);
      assert.equal(fs.readFileSync(promptPath, "utf8"), body);
      assert.deepEqual(fs.readFileSync(promptPath), fs.readFileSync(bodyPath));
      assert.equal(fs.statSync(promptPath).mode & 0o777, 0o640, "atomic replacement preserves prompt permissions");
      assert.equal(readBoard().prompt_index["IMP-704"], fixturePromptReference(promptPath), "body authoring preserves the existing mapping");
      const event = readLastJournalEvent(governanceState.GOVERNANCE_EVENT_LOG_PATH);
      assert.equal(event.command, "register-prompt");
      assert.equal(event.result, "succeeded");
      assert.equal(event.details.body_authored, true);
      assert.ok(event.changed_paths.some((entry) => entry.endsWith("IMP-704.md")));
      assert.deepEqual(
        __testing.detectGovernanceProvenanceDrift().drift,
        [],
        "the successful prompt write and governed sync leave no unjournaled drift",
      );
      // Doctor also checks configured product integration refs. Give it real,
      // isolated repositories with committed dev branches instead of depending
      // on whichever product checkouts happen to accompany the donor or cut.
      const productRepos = {};
      try {
        for (const code of Object.keys(DEFAULT_PATHS.repoRoots).filter((code) => code !== "X")) {
          productRepos[code] = createTempGitRepoWithOrigin("coord662-body-product-", { "README.md": "prompt doctor fixture\n" });
        }
        const doctor = withScopedGovernanceTestContext({ REPO_ROOTS: Object.fromEntries(Object.entries(productRepos).map(([code, repo]) => [code, repo.repoRoot])) },
          () => executeCommand(["doctor", "--ticket", "IMP-704"]));
        assert.equal(doctor.ok, true, doctor.error || doctor.stderr);
        assert.match(doctor.stdout, /Governance doctor OK: no additional issues found\./);
        assert.doesNotMatch(doctor.stdout, /Canonical derived artifacts drift|out-of-band coordination-state mutations/);
      } finally {
        for (const repo of Object.values(productRepos)) {
          fs.rmSync(repo.repoRoot, { recursive: true, force: true });
          fs.rmSync(repo.remoteRoot, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
    }
  });
});

test("COORD-662: register-prompt --body-file refuses unregistered targets and mapping options before writes", () => {
  withRegisterPromptHarness("coord662-body-refuse-", { ticketId: "IMP-705" }, ({ readBoard }) => {
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-empty-body-"));
    const bodyPath = path.join(bodyDir, "body.md");
    fs.writeFileSync(bodyPath, "\n \t", "utf8");
    const boardBefore = fs.readFileSync(governanceState.BOARD_PATH);
    const eventsBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    try {
      const blank = executeCommand(["register-prompt", "IMP-705", "--body-file", bodyPath]);
      assert.equal(blank.ok, false);
      assert.match(blank.error, /empty or whitespace-only/);
      fs.writeFileSync(bodyPath, "replacement\n", "utf8");
      const unmapped = executeCommand(["register-prompt", "IMP-705", "--body-file", bodyPath]);
      assert.equal(unmapped.ok, false);
      assert.match(unmapped.error, /requires an existing prompt_index mapping/);
      const conflict = executeCommand(["register-prompt", "IMP-705", "--body-file", bodyPath, "--path", "coord/prompts/other.md"]);
      assert.equal(conflict.ok, false);
      assert.match(conflict.error, /do not combine it with mapping or template options/);
      assert.deepEqual(fs.readFileSync(governanceState.BOARD_PATH), boardBefore);
      assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), eventsBefore);
      assert.deepEqual(readBoard().prompt_index, {});
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
    }
  });
});

test("COORD-662: body authoring requires the bound owner for active tickets", () => {
  withRegisterPromptHarness("coord662-active-owner-", { ticketId: "IMP-706", status: "doing" }, ({ readBoard }) => {
      const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-706.md");
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-active-owner-body-"));
    const bodyPath = path.join(bodyDir, "body.md");
    const worktreeRepo = createTempGitRepo("coord662-active-owner-repo-", { "seed.txt": "fixture\n" });
    const canonicalWorktree = path.join(process.cwd(), "backend", ".worktrees", "claudea11", "IMP-706");
    fs.mkdirSync(path.dirname(canonicalWorktree), { recursive: true });
    fs.symlinkSync(worktreeRepo.repoRoot, canonicalWorktree, "dir");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "old active body\n", "utf8");
    fs.writeFileSync(bodyPath, "new active body\n", "utf8");
    try {
      const board = readBoard();
      const row = board.sections[0].rows.find((candidate) => candidate.ID === "IMP-706");
      row.Owner = "claudea11";
      board.prompt_index["IMP-706"] = fixturePromptReference(promptPath);
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      const actor = seedPromptWriterSession("IMP-706");
      fs.writeFileSync(path.join(governanceState.LOCKS_DIR, "IMP-706.lock"), `${JSON.stringify({
        version: 1,
        ticket: "IMP-706",
        owner: "claudea11",
        status: "doing",
        repo: "backend",
        branch: "agent/claudea11-imp-706-fixture",
        head: worktreeRepo.head,
        worktree: canonicalWorktree,
        started_at_utc: new Date().toISOString(),
        heartbeat_utc: new Date().toISOString(),
        session_id: actor.sessionId,
      }, null, 2)}\n`, "utf8");
      appendPromptFixtureBaseline();

      const result = executeCommand(["register-prompt", "IMP-706", "--body-file", bodyPath], actor);
      assert.equal(result.ok, true, result.error || result.stderr);
      assert.equal(fs.readFileSync(promptPath, "utf8"), "new active body\n");
      assert.equal(readLastJournalEvent(governanceState.GOVERNANCE_EVENT_LOG_PATH).identity.owner, "claudea11");
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
      fs.rmSync(canonicalWorktree, { force: true });
      // Remove only this fixture's empty owner directory; sibling worktrees
      // are not owned by this test and must survive cleanup.
      try { fs.rmdirSync(path.dirname(canonicalWorktree)); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
      fs.rmSync(worktreeRepo.repoRoot, { recursive: true, force: true });
    }
  });
});

test("COORD-662: body authoring refuses an unregistered actor and a foreign ticket owner without writes", () => {
  withRegisterPromptHarness("coord662-authorization-", { ticketId: "IMP-712" }, ({ readBoard }) => {
      const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-712.md");
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-authorization-body-"));
    const bodyPath = path.join(bodyDir, "body.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "original body\n", "utf8");
    fs.writeFileSync(bodyPath, "replacement body\n", "utf8");
    try {
      const board = readBoard();
      board.prompt_index["IMP-712"] = fixturePromptReference(promptPath);
      const agents = JSON.parse(fs.readFileSync(governanceState.AGENTS_PATH, "utf8"));
      agents.push({ id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] });
      fs.writeFileSync(governanceState.AGENTS_PATH, `${JSON.stringify(agents, null, 2)}\n`, "utf8");
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      appendPromptFixtureBaseline();
      const initialBoard = fs.readFileSync(governanceState.BOARD_PATH);
      const initialEvents = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");

      const unregistered = executeCommand(["register-prompt", "IMP-712", "--body-file", bodyPath]);
      assert.equal(unregistered.ok, false);
      assert.match(unregistered.error, /agent|session|registered/i);
      assert.deepEqual(fs.readFileSync(governanceState.BOARD_PATH), initialBoard);
      assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), initialEvents);
      assert.equal(fs.readFileSync(promptPath, "utf8"), "original body\n");

      const foreignBoard = readBoard();
      foreignBoard.sections[0].rows[0].Owner = "claudea12";
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(foreignBoard, null, 2)}\n`, "utf8");
      const actor = seedPromptWriterSession("IMP-712");
      appendPromptFixtureBaseline();
      const ownedBoard = fs.readFileSync(governanceState.BOARD_PATH);
      const ownedEvents = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");

      const foreign = executeCommand(["register-prompt", "IMP-712", "--body-file", bodyPath], actor);
      assert.equal(foreign.ok, false);
      assert.match(foreign.error, /owned by claudea12/);
      assert.deepEqual(fs.readFileSync(governanceState.BOARD_PATH), ownedBoard);
      assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), ownedEvents);
      assert.equal(fs.readFileSync(promptPath, "utf8"), "original body\n");
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
    }
  });
});

test("COORD-662: body authoring refuses shared prompt targets and hardlinks without changing either copy", () => {
  withRegisterPromptHarness(
    "coord662-shared-hardlink-",
    { ticketId: "IMP-707", extraRows: [{ ID: "IMP-708" }] },
    ({ readBoard }) => {
          const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-707.md");
      const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-shared-body-"));
      const bodyPath = path.join(bodyDir, "body.md");
      const hardlinkPath = path.join(bodyDir, "hardlink.md");
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });
      fs.writeFileSync(promptPath, "shared original\n", "utf8");
      fs.writeFileSync(bodyPath, "replacement\n", "utf8");
      const board = readBoard();
      board.prompt_index["IMP-707"] = fixturePromptReference(promptPath);
      board.prompt_index["IMP-708"] = fixturePromptReference(promptPath);
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      const actor = seedPromptWriterSession("IMP-707");
      appendPromptFixtureBaseline();
      const eventsBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
      try {
        const shared = executeCommand(["register-prompt", "IMP-707", "--body-file", bodyPath], actor);
        assert.equal(shared.ok, false);
        assert.match(shared.error, /shared by other tickets: IMP-708/);
        assert.equal(fs.readFileSync(promptPath, "utf8"), "shared original\n");
        assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), eventsBefore);

        fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify({ ...board, prompt_index: { "IMP-707": fixturePromptReference(promptPath) } }, null, 2)}\n`, "utf8");
        appendPromptFixtureBaseline();
        fs.linkSync(promptPath, hardlinkPath);
        const hardlinkEventsBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
        const linked = executeCommand(["register-prompt", "IMP-707", "--body-file", bodyPath], actor);
        assert.equal(linked.ok, false);
        assert.match(linked.error, /multiple hard links/);
        assert.equal(fs.readFileSync(promptPath, "utf8"), "shared original\n");
        assert.equal(fs.readFileSync(hardlinkPath, "utf8"), "shared original\n");
        assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), hardlinkEventsBefore);
      } finally {
        fs.rmSync(bodyDir, { recursive: true, force: true });
      }
    }
  );
});

test("COORD-662: body authoring refuses closed tickets and rolls back bytes after a post-write sync failure", () => {
  for (const status of ["done", "superseded"]) {
    withRegisterPromptHarness(`coord662-closed-${status}-`, { ticketId: `IMP-${status === "done" ? "709" : "710"}`, status }, ({ readBoard }) => {
      const ticketId = readBoard().sections[0].rows[0].ID;
      const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", `${ticketId}.md`);
      const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-closed-body-"));
      const bodyPath = path.join(bodyDir, "body.md");
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });
      fs.writeFileSync(promptPath, "closed original\n", "utf8");
      fs.writeFileSync(bodyPath, "must not be written\n", "utf8");
      const board = readBoard();
      board.prompt_index[ticketId] = fixturePromptReference(promptPath);
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      appendPromptFixtureBaseline();
      try {
        const before = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
        const result = executeCommand(["register-prompt", ticketId, "--body-file", bodyPath]);
        assert.equal(result.ok, false);
        assert.match(result.error, /closed ticket/);
        assert.equal(fs.readFileSync(promptPath, "utf8"), "closed original\n");
        assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), before);
      } finally {
        fs.rmSync(bodyDir, { recursive: true, force: true });
      }
    });
  }

  withRegisterPromptHarness("coord662-rollback-", { ticketId: "IMP-711" }, ({ readBoard }) => {
    const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-711.md");
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord662-rollback-body-"));
    const bodyPath = path.join(bodyDir, "body.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "must survive rollback\n", "utf8");
    fs.writeFileSync(bodyPath, "temporary replacement\n", "utf8");
    try {
      const board = readBoard();
      board.prompt_index["IMP-711"] = fixturePromptReference(promptPath);
      fs.writeFileSync(governanceState.BOARD_PATH, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      const actor = seedPromptWriterSession("IMP-711");
      appendPromptFixtureBaseline();
      const beforeEvents = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
      const originalWriteFileSync = fs.writeFileSync;
      const originalRenameSync = fs.renameSync;
      let bodyWasAtomicallyReplaced = false;
      let syncWriteFailed = false;
      fs.renameSync = function (source, destination) {
        const result = originalRenameSync.apply(this, arguments);
        if (path.resolve(String(destination)) === path.resolve(promptPath)) bodyWasAtomicallyReplaced = true;
        return result;
      };
      fs.writeFileSync = function (file, ...args) {
        if (
          bodyWasAtomicallyReplaced
          && !syncWriteFailed
          && typeof file === "string"
          && path.resolve(file) === path.resolve(governanceState.PLAN_PATH)
        ) {
          syncWriteFailed = true;
          throw new Error("fixture sync write failure after prompt replacement");
        }
        return originalWriteFileSync.call(this, file, ...args);
      };
      let result;
      let thrown;
      try {
        result = executeCommand(["register-prompt", "IMP-711", "--body-file", bodyPath], actor);
      } catch (error) {
        thrown = error;
      } finally {
        fs.writeFileSync = originalWriteFileSync;
        fs.renameSync = originalRenameSync;
      }
      assert.equal(bodyWasAtomicallyReplaced, true, "the real prompt file write must precede the injected downstream failure");
      assert.equal(syncWriteFailed, true, "the real board sync must hit the injected downstream write failure");
      assert.ok(thrown || result?.ok === false, "the downstream failure must abort the transaction");
      assert.match(thrown?.message || result?.error || "", /fixture sync write failure/);
      assert.equal(fs.readFileSync(promptPath, "utf8"), "must survive rollback\n");
      assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8"), beforeEvents);
    } finally {
      fs.rmSync(bodyDir, { recursive: true, force: true });
    }
  });
});

test("COORD-350: register-prompt without --create still fails closed on a missing file", () => {
  withRegisterPromptHarness("coord350-missing-", { ticketId: "IMP-702" }, () => {
    assert.throws(
      () => governanceCommands.registerPrompt("IMP-702", {}),
      (err) => err instanceof Error && /prompt file not found/.test(err.message)
    );
  });
});

test("COORD-350: register-prompt --create fails closed on duplicate mapping unless forced", () => {
  withRegisterPromptHarness(
    "coord350-duplicate-",
    { ticketId: "IMP-703", promptRegistered: "coord/prompts/old.md" },
    ({ readBoard }) => {
      const promptPath = path.join(governanceState.PROMPTS_DIR, "tickets", "IMP-703.md");
      assert.throws(
        () => governanceCommands.registerPrompt("IMP-703", { create: true, path: promptPath }),
        (err) => err instanceof Error && /already registered to coord\/prompts\/old\.md/.test(err.message)
      );

      const forced = governanceCommands.registerPrompt("IMP-703", { create: true, path: promptPath, force: true });
      const board = readBoard();
      assert.equal(forced.created, true);
      assert.equal(board.prompt_index["IMP-703"].endsWith("/prompts/tickets/IMP-703.md"), true);
    }
  );
});

// COORD-813: prompt coverage is a content contract, not file presence. These
// drive the production factory hermetically (same pattern as the COORD-023
// discovery test above) against real files on disk.
function withPromptContentFixture(run, { waiver = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord813-content-"));
  const coordDir = path.join(root, "coord");
  const promptsDir = path.join(coordDir, "prompts");
  fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
  const writtenBoards = [];
  const promptCoverage = createPromptCoverage({
    ROOT_DIR: root,
    COORD_DIR: coordDir,
    getPromptsDir: () => promptsDir,
    readTicketWaiver: (_board, ticketId, code) => (
      waiver && waiver.ticket === ticketId && code === "prompt_coverage" ? waiver : null
    ),
    fail: (message) => { throw new Error(message); },
    withCoordStateLock: (fn) => fn(),
    writeBoard: (board) => writtenBoards.push(structuredClone(board)),
    runBoardSync: () => {},
  });
  const writePrompt = (ticketId, body) => {
    const relPath = `coord/prompts/tickets/${ticketId}.md`;
    fs.writeFileSync(path.join(root, relPath), body);
    return relPath;
  };
  try {
    return run({ promptCoverage, root, writePrompt, writtenBoards });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const COORD813_SPECIFIC_PROMPT = [
  "# T-813: Reject scaffold-only prompts",
  "",
  "## Assignment",
  "",
  "Make the start gate read prompt content.",
  "",
  "## Acceptance Criteria",
  "",
  "- `gov start` refuses a prompt whose acceptance is only the generated scaffold.",
  "- Focused verification is recorded in the governed plan.",
  "",
  "## Likely Files",
  "",
  "- TODO: add likely files before start when known.",
  "",
  "## Verification",
  "",
  "- `node --test coord/engine/scripts/prompt-coverage.test.js`",
  "",
].join("\n");

test("COORD-813: a generated prompt without Description acceptance is rejected with ticket and path attribution", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const row = { ID: "T-813", Repo: "X", Type: "bug", Pri: "P2", Description: "Reject scaffold-only prompts" };
    const relPath = writePrompt("T-813", promptCoverage.buildTicketPromptTemplate("T-813", row));
    const board = { prompt_index: { "T-813": relPath }, waiver_index: {} };

    const report = promptCoverage.collectPromptRecordIssues("T-813", board);
    assert.equal(report.prompt, relPath);
    assert.equal(report.issues.length, 2, JSON.stringify(report.issues));
    assert.ok(report.issues.some((issue) => /Acceptance Criteria" has no ticket-specific criteria/.test(issue)));
    // The generated placeholder tells the author exactly what to add.
    assert.ok(report.issues.some((issue) => (
      /unresolved placeholder in "## Acceptance Criteria": - TODO: write this ticket's acceptance criteria/.test(issue)
      && issue.includes("gov register-prompt T-813 --body-file <file>")
      && issue.includes("`Acceptance: <criteria>` in --description")
    )));
    // Likely Files is a documented optional section: its TODO stub is not an
    // issue, and the generated Verification body is not a placeholder.
    assert.ok(!report.issues.some((issue) => /Likely Files|Verification/.test(issue)));

    assert.throws(
      () => promptCoverage.assertPromptRecord("T-813", { Repo: "X" }, board, {}),
      (error) => {
        assert.match(error.message, /Ticket T-813 cannot start/);
        assert.ok(error.message.includes(relPath));
        assert.match(error.message, /no ticket-specific criteria/);
        assert.match(error.message, /gov register-prompt T-813 --body-file/);
        assert.match(error.message, /gov set-waiver T-813/);
        return true;
      },
    );
  });
});

test("COORD-813: the file-ticket --with-prompt scaffold (multi-line Assignment body) is rejected too", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const relPath = writePrompt("T-814", [
      "# T-814: Title", "", "## Assignment", "", "Title", "", "**Acceptance:** real text lives only in the description.", "",
      "## Acceptance Criteria", "", "- Ticket scope is implemented.", "- Focused verification is recorded in the governed plan.", "",
      "## Likely Files", "", "- TODO: add likely files before start when known.", "",
      "## Verification", "", "- TODO: add focused verification command.", "",
    ].join("\n"));
    assert.throws(
      () => promptCoverage.assertPromptRecord("T-814", { Repo: "X" }, { prompt_index: { "T-814": relPath } }, {}),
      /T-814 cannot start[\s\S]*no ticket-specific criteria/,
    );
  });
});

test("COORD-813: a ticket-specific prompt passes, keeping optional sections and legacy shapes valid", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const board = { prompt_index: {}, waiver_index: {} };
    const accept = (ticketId, body) => {
      board.prompt_index[ticketId] = writePrompt(ticketId, body);
      assert.deepEqual(promptCoverage.collectPromptRecordIssues(ticketId, board).issues, [], ticketId);
      assert.doesNotThrow(() => promptCoverage.assertPromptRecord(ticketId, { Repo: "X" }, board, {}));
    };
    // Specific acceptance; optional Likely Files TODO stub; no Preconditions section.
    accept("T-1", COORD813_SPECIFIC_PROMPT);
    // (The former no-acceptance-heading back-compat cases T-2/T-3 are now
    // refused for ticket-specific prompts; see the 2026-10-14 ruling test.)
    // Criteria nested under sub-headings and alternate acceptance headings still count.
    accept("T-4", "# T-4\n\n## Acceptance\n\n### Functional\n\n1. The parser rejects empty input.\n\n## Verification\n\nRun the parser suite.\n");
    // A fenced `# comment` is not a heading and must not truncate the section.
    accept("T-5", "# T-5\n\n## Acceptance Criteria\n\n```sh\n# TODO-free comment\nnpm test\n```\n- Exit code is zero.\n");
  });
});

// COORD-813 human-admin ruling (2026-10-14): a ticket-specific prompt with no
// Acceptance heading is refused; a deliberately mapped shared role prompt is
// exempt; the waiver still bypasses everything.
const COORD813_ROLE_PROMPT = "# Implementer Role\n\n## Startup Gate\n\n- Read the checklist.\n\n## Finish Gate\n\n- Gates pass.\n";

test("COORD-813 ruling: a ticket-specific prompt without an Acceptance heading is refused with attribution", () => {
  withPromptContentFixture(({ promptCoverage, root, writePrompt, writtenBoards }) => {
    const expectMissingHeading = (ticketId, board, relPath) => {
      const report = promptCoverage.collectPromptRecordIssues(ticketId, board);
      assert.equal(report.prompt, relPath);
      assert.equal(report.issues.length, 1, JSON.stringify(report.issues));
      assert.match(report.issues[0], /no "## Acceptance" heading: a ticket-specific prompt/);
      assert.throws(() => promptCoverage.assertPromptRecord(ticketId, { Repo: "X" }, board, {}), (error) => {
        assert.match(error.message, new RegExp(`Ticket ${ticketId} cannot start`));
        assert.ok(error.message.includes(relPath), error.message);
        assert.match(error.message, /no "## Acceptance" heading/);
        assert.match(error.message, new RegExp(`gov set-waiver ${ticketId}`));
        return true;
      });
    };
    // The ticket's own prompt file, mapped: role-shaped and bare bodies alike.
    const own = writePrompt("T-2", COORD813_ROLE_PROMPT);
    expectMissingHeading("T-2", { prompt_index: { "T-2": own } }, own);
    const bare = writePrompt("T-3", "# T-3 fixture prompt\n");
    expectMissingHeading("T-3", { prompt_index: { "T-3": bare } }, bare);
    // Any other path mapped only to this ticket is ticket-specific too.
    fs.mkdirSync(path.join(root, "coord/docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "coord/docs/T-9.md"), COORD813_ROLE_PROMPT);
    expectMissingHeading("T-9", { prompt_index: { "T-9": "coord/docs/T-9.md" } }, "coord/docs/T-9.md");
    // Unmapped on-disk default: refused at start and nothing is registered.
    const discovered = writePrompt("T-10", COORD813_ROLE_PROMPT);
    const unmapped = { prompt_index: {} };
    expectMissingHeading("T-10", unmapped, discovered);
    assert.throws(() => admitsPrompt(() => promptCoverage.assertPromptRecord("T-10", { Repo: "X" }, unmapped, {})), /T-10 cannot start[\s\S]*Acceptance" heading/);
    assert.deepEqual(unmapped.prompt_index, {});
    assert.equal(writtenBoards.length, 0, "a refused prompt must not be auto-registered");
    // The ticket's own file stays ticket-specific even when other tickets share it.
    const owner = writePrompt("T-11", COORD813_ROLE_PROMPT);
    expectMissingHeading("T-11", { prompt_index: { "T-11": owner, "T-12": owner } }, owner);
  });
});

test("COORD-813 ruling: only an allowlisted shared role prompt is exempt; the waiver bypasses everything", () => {
  withPromptContentFixture(({ promptCoverage, root, writePrompt }) => {
    const pass = (ticketId, board) => {
      assert.deepEqual(promptCoverage.collectPromptRecordIssues(ticketId, board).issues, [], ticketId);
      assert.doesNotThrow(() => promptCoverage.assertPromptRecord(ticketId, { Repo: "X" }, board, {}));
    };
    const refuse = (ticketId, board) => {
      const { issues } = promptCoverage.collectPromptRecordIssues(ticketId, board);
      assert.equal(issues.length, 1, `${ticketId}: ${JSON.stringify(issues)}`);
      assert.match(issues[0], /no "## Acceptance" heading: a ticket-specific prompt/);
    };
    // An engine-shipped role prompt is allowlisted, even mapped to one ticket.
    fs.writeFileSync(path.join(root, "coord/prompts/implementer.md"), COORD813_ROLE_PROMPT);
    pass("R-1", { prompt_index: { "R-1": "coord/prompts/implementer.md" } });
    // CONVERTED (was a pass): a ticket file mapped to several tickets is under
    // the tickets directory, so mapping count confers nothing; refused.
    const shared = writePrompt("R-0", COORD813_ROLE_PROMPT);
    const board = { prompt_index: { "R-0": shared, "R-2": shared, "R-3": shared } };
    refuse("R-2", board);
    refuse("R-3", board);
    // CONVERTED (was a pass): a doubly mapped file outside the prompts tree is
    // refused until the project lists it in promptCoverage.rolePrompts, and
    // then both spellings of it pass.
    fs.mkdirSync(path.join(root, "coord/docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "coord/docs/shared.md"), COORD813_ROLE_PROMPT);
    const docsBoard = { prompt_index: { "R-4": "coord/docs/shared.md", "R-5": "./coord/docs/shared.md" } };
    refuse("R-4", docsBoard);
    refuse("R-5", docsBoard);
    fs.writeFileSync(
      path.join(root, "coord/project.config.js"),
      "module.exports = { promptCoverage: { rolePrompts: [\"coord/docs/shared.md\"] } };\n",
    );
    pass("R-4", docsBoard);
    pass("R-5", docsBoard);
    // The exemption covers only the missing heading: a shared prompt that does
    // declare acceptance is still judged on its content.
    fs.writeFileSync(path.join(root, "coord/prompts/planner.md"), "# Planner\n\n## Acceptance\n\n- TODO\n");
    assert.equal(promptCoverage.collectPromptRecordIssues("R-6", { prompt_index: { "R-6": "coord/prompts/planner.md" } }).issues.length, 2);
    // A ticket prompts subdirectory is not the role-prompt directory.
    fs.mkdirSync(path.join(root, "coord/prompts/tickets/sub"));
    fs.writeFileSync(path.join(root, "coord/prompts/tickets/sub/R-7.md"), COORD813_ROLE_PROMPT);
    assert.equal(promptCoverage.collectPromptRecordIssues("R-7", { prompt_index: { "R-7": "coord/prompts/tickets/sub/R-7.md" } }).issues.length, 1);
  });
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const own = writePrompt("W-3", COORD813_ROLE_PROMPT);
    const board = { prompt_index: { "W-3": own } };
    assert.deepEqual(promptCoverage.collectPromptRecordIssues("W-3", board), { prompt: null, issues: [] });
    assert.doesNotThrow(() => promptCoverage.assertPromptRecord("W-3", { Repo: "X" }, board, {}));
  }, { waiver: { ticket: "W-3", code: "prompt_coverage", reason: "accepted" } });
});

// COORD-813 review finding: placement in coord/prompts/, a `..` spelling, a
// dummy second mapping, or another ticket's own default prompt used to confer
// the shared-role exemption with no record. None does now; only the explicit
// allowlist (engine-shipped roles + promptCoverage.rolePrompts) exempts.
test("COORD-813 ruling: placement, traversal, dummy mappings and other tickets' prompts never confer the exemption", () => {
  const noAcceptance = "# COORD-900: do the thing\n\n## Assignment\nDo whatever seems right.\n";
  withPromptContentFixture(({ promptCoverage, root, writePrompt }) => {
    const refuse = (ticketId, board) => {
      const { issues } = promptCoverage.collectPromptRecordIssues(ticketId, board);
      assert.equal(issues.length, 1, `${JSON.stringify(board)}: ${JSON.stringify(issues)}`);
      assert.match(issues[0], /no "## Acceptance" heading/);
      assert.throws(() => promptCoverage.assertPromptRecord(ticketId, { Repo: "X" }, board, {}), /cannot start/);
    };
    const pass = (ticketId, board) => {
      assert.deepEqual(promptCoverage.collectPromptRecordIssues(ticketId, board).issues, [], JSON.stringify(board));
    };
    fs.writeFileSync(path.join(root, "coord/prompts/COORD-900.md"), noAcceptance);
    refuse("COORD-900", { prompt_index: { "COORD-900": "coord/prompts/COORD-900.md" } });
    refuse("COORD-900", { prompt_index: { "COORD-900": "coord/prompts/tickets/../COORD-900.md" } });
    fs.writeFileSync(path.join(root, "coord/prompts/tickets/COORD-900-specific.md"), noAcceptance);
    refuse("COORD-900", { prompt_index: {
      "COORD-900": "coord/prompts/tickets/COORD-900-specific.md",
      "COORD-901": "coord/prompts/tickets/COORD-900-specific.md",
    } });
    const other = writePrompt("COORD-902", noAcceptance);
    refuse("COORD-900", { prompt_index: { "COORD-900": other } });
    refuse("COORD-900", { prompt_index: { "COORD-900": other, "COORD-902": other } });

    // Shipped role prompts stay exempt.
    for (const role of ["implementer", "planner", "reviewer"]) {
      fs.writeFileSync(path.join(root, `coord/prompts/${role}.md`), COORD813_ROLE_PROMPT);
      pass("COORD-900", { prompt_index: { "COORD-900": `coord/prompts/${role}.md` } });
    }
    // A project-configured role prompt passes; config entries that escape with
    // `..`, point outside the workspace, or land under the tickets directory
    // (or name a ticket's own prompt) are ignored.
    fs.mkdirSync(path.join(root, "coord/roles"), { recursive: true });
    fs.writeFileSync(path.join(root, "coord/roles/designer.md"), COORD813_ROLE_PROMPT);
    fs.writeFileSync(path.join(root, "coord/roles/escaped.md"), COORD813_ROLE_PROMPT);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coord813-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "role.md"), COORD813_ROLE_PROMPT);
      fs.writeFileSync(path.join(root, "coord/project.config.js"), `module.exports = ${JSON.stringify({ promptCoverage: { rolePrompts: [
        "coord/roles/designer.md",
        "coord/prompts/../roles/escaped.md",
        path.join(outside, "role.md"),
        "coord/prompts/tickets/COORD-900-specific.md",
        other,
        42,
      ] } })};\n`);
      pass("COORD-900", { prompt_index: { "COORD-900": "coord/roles/designer.md" } });
      pass("COORD-900", { prompt_index: { "COORD-900": "./coord/roles/../roles/designer.md" } });
      refuse("COORD-900", { prompt_index: { "COORD-900": "coord/roles/escaped.md" } });
      refuse("COORD-900", { prompt_index: { "COORD-900": path.join(outside, "role.md") } });
      refuse("COORD-900", { prompt_index: { "COORD-900": "coord/prompts/tickets/COORD-900-specific.md" } });
      refuse("COORD-900", { prompt_index: { "COORD-900": other } });
      refuse("COORD-902", { prompt_index: { "COORD-902": other } });
      // An unloadable project config fails closed: no project role prompts.
      fs.writeFileSync(path.join(root, "coord/project.config.js"), "module.exports = {;\n");
      refuse("COORD-900", { prompt_index: { "COORD-900": "coord/roles/designer.md" } });
      pass("COORD-900", { prompt_index: { "COORD-900": "coord/prompts/implementer.md" } });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  // The structured waiver still bypasses a bypass-shaped mapping.
  withPromptContentFixture(({ promptCoverage, root }) => {
    fs.writeFileSync(path.join(root, "coord/prompts/COORD-900.md"), noAcceptance);
    const board = { prompt_index: { "COORD-900": "coord/prompts/COORD-900.md" } };
    assert.deepEqual(promptCoverage.collectPromptRecordIssues("COORD-900", board), { prompt: null, issues: [] });
  }, { waiver: { ticket: "COORD-900", code: "prompt_coverage", reason: "accepted" } });
});

test("COORD-813: placeholders in required sections fail even beside real criteria; an emptied acceptance section fails", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const mixed = writePrompt("T-6", COORD813_SPECIFIC_PROMPT.replace(
      "- `node --test coord/engine/scripts/prompt-coverage.test.js`",
      "- TODO: add focused verification command.",
    ));
    assert.deepEqual(
      promptCoverage.collectPromptRecordIssues("T-6", { prompt_index: { "T-6": mixed } }).issues,
      ['unresolved placeholder in "## Verification": - TODO: add focused verification command.'],
    );
    const empty = writePrompt("T-7", "# T-7\n\n## Acceptance Criteria\n\n## Verification\n\n- run it\n");
    assert.throws(
      () => promptCoverage.assertPromptRecord("T-7", { Repo: "X" }, { prompt_index: { "T-7": empty } }, {}),
      /no ticket-specific criteria/,
    );
    const todoOnly = writePrompt("T-8", "# T-8\n\n## Acceptance Criteria\n\n- [ ] TODO: write criteria\n");
    assert.equal(promptCoverage.collectPromptRecordIssues("T-8", { prompt_index: { "T-8": todoOnly } }).issues.length, 2);
  });
});

test("COORD-837: placeholder lines follow the human-admin token set; bracket slots and real criteria do not", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const issuesFor = (id, line) => promptCoverage.collectPromptRecordIssues(id, {
      prompt_index: { [id]: writePrompt(id, `# ${id}\n\n## Acceptance Criteria\n\n- The ticket ships its fix with a regression.\n${line}\n`) },
    }).issues;
    for (const [i, line] of ["- TBD", "- [ ] tba: later", "- FIXME before merge", "- XXX decide", "- N/A", "- None.", "* todo"].entries()) {
      assert.deepEqual(issuesFor(`P-${i}`, line), [`unresolved placeholder in "## Acceptance Criteria": ${line}`], line);
    }
    for (const [i, line] of ["- <fill in>", "- [criteria]", "- None of the old flags remain accepted", "- TBDs are listed in the report", "- n/a values are rejected"].entries()) {
      assert.deepEqual(issuesFor(`Q-${i}`, line), [], line);
    }
  });
});

test("COORD-813: malformed and unreadable mapped prompts fail closed with attribution", () => {
  withPromptContentFixture(({ promptCoverage, root, writePrompt }) => {
    const expectRefusal = (ticketId, relPath, pattern) => {
      assert.throws(
        () => promptCoverage.assertPromptRecord(ticketId, { Repo: "X" }, { prompt_index: { [ticketId]: relPath } }, {}),
        (error) => {
          assert.match(error.message, new RegExp(`Ticket ${ticketId} cannot start`));
          assert.ok(error.message.includes(String(relPath)), error.message);
          assert.match(error.message, pattern);
          return true;
        },
      );
    };
    expectRefusal("M-1", "coord/prompts/tickets/M-1.md", /prompt file is unreadable \(ENOENT\)/);
    fs.mkdirSync(path.join(root, "coord/prompts/tickets/M-2.md"));
    expectRefusal("M-2", "coord/prompts/tickets/M-2.md", /not a regular file/);
    expectRefusal("M-3", writePrompt("M-3", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])), /malformed: not valid UTF-8 text/);
    expectRefusal("M-4", writePrompt("M-4", " \n\t\n"), /malformed: empty or whitespace-only/);
    expectRefusal("M-5", 42, /mapping is not a path string/);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const denied = writePrompt("M-6", COORD813_SPECIFIC_PROMPT);
      fs.chmodSync(path.join(root, denied), 0o000);
      expectRefusal("M-6", denied, /prompt file is unreadable \(EACCES\)/);
    }
  });
});

test("COORD-813: a recorded prompt waiver is the only bypass; an unmapped on-disk scaffold is still judged", () => {
  const scaffold = (promptCoverage, ticketId) => promptCoverage.buildTicketPromptTemplate(ticketId, { Description: "d" });
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const relPath = writePrompt("W-1", scaffold(promptCoverage, "W-1"));
    const board = { prompt_index: { "W-1": relPath, "W-2": "coord/prompts/tickets/absent.md" } };
    assert.deepEqual(promptCoverage.collectPromptRecordIssues("W-1", board), { prompt: null, issues: [] });
    assert.doesNotThrow(() => promptCoverage.assertPromptRecord("W-1", { Repo: "X" }, board, {}));
    // The waiver is per ticket: a different ticket's unreadable mapping still fails.
    assert.throws(() => promptCoverage.assertPromptRecord("W-2", { Repo: "X" }, board, {}), /W-2 cannot start[\s\S]*unreadable/);
  }, { waiver: { ticket: "W-1", code: "prompt_coverage", reason: "accepted" } });

  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    // COORD-023 discovery path: no mapping yet, default file on disk is the scaffold.
    const relPath = writePrompt("D-1", scaffold(promptCoverage, "D-1"));
    const report = promptCoverage.collectPromptRecordIssues("D-1", { prompt_index: {} });
    assert.equal(report.prompt, relPath);
    assert.ok(report.issues.length > 0);
    // Neither mapping, waiver, nor file: the existing coverage gate owns that refusal.
    assert.deepEqual(promptCoverage.collectPromptRecordIssues("GHOST-1", { prompt_index: {} }), { prompt: null, issues: [] });
  });
});

test("COORD-813: the start coverage gate enforces the content contract before auto-registering", () => {
  const scaffold = (promptCoverage, ticketId) => promptCoverage.buildTicketPromptTemplate(ticketId, { Description: "d" });
  withPromptContentFixture(({ promptCoverage, writePrompt, writtenBoards }) => {
    // Mapped scaffold: presence no longer satisfies gov start.
    const mapped = { prompt_index: { "G-1": writePrompt("G-1", scaffold(promptCoverage, "G-1")) } };
    assert.throws(() => admitsPrompt(() => promptCoverage.assertPromptRecord("G-1", { Repo: "X" }, mapped, {})), /G-1 cannot start[\s\S]*prompt content contract/);

    // Unmapped scaffold on disk: refused, and NOT registered on the way out.
    writePrompt("G-2", scaffold(promptCoverage, "G-2"));
    const discovered = { prompt_index: {} };
    assert.throws(() => admitsPrompt(() => promptCoverage.assertPromptRecord("G-2", { Repo: "X" }, discovered, {})), /G-2 cannot start/);
    assert.deepEqual(discovered.prompt_index, {});
    assert.equal(writtenBoards.length, 0, "a refused prompt must not be auto-registered");

    // Unmapped specific prompt on disk: discovered and registered as before.
    writePrompt("G-3", COORD813_SPECIFIC_PROMPT);
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("G-3", { Repo: "X" }, discovered, {})), true);
    assert.equal(discovered.prompt_index["G-3"], "coord/prompts/tickets/G-3.md");
    assert.equal(writtenBoards.length, 1);

    // No mapping, waiver, or file: the pre-existing "no coverage" answer stands.
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("G-4", { Repo: "X" }, { prompt_index: {} }, {})), false);
  });
  withPromptContentFixture(({ promptCoverage, writePrompt, writtenBoards }) => {
    const board = { prompt_index: { "G-5": writePrompt("G-5", scaffold(promptCoverage, "G-5")) } };
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("G-5", { Repo: "X" }, board, {})), true);
    // Waived and unmapped: coverage holds without discovery or a board write,
    // even when the on-disk default prompt would fail the content contract.
    const unmapped = {};
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("G-5", { Repo: "X" }, unmapped, {})), true);
    assert.deepEqual(unmapped, {});
    assert.equal(writtenBoards.length, 0);
  }, { waiver: { ticket: "G-5", code: "prompt_coverage", reason: "accepted" } });
  withPromptContentFixture(({ promptCoverage, writePrompt, writtenBoards }) => {
    // A board with no prompt_index at all still discovers a specific prompt.
    writePrompt("G-6", COORD813_SPECIFIC_PROMPT);
    const board = {};
    assert.equal(admitsPrompt(() => promptCoverage.assertPromptRecord("G-6", { Repo: "X" }, board, {})), true);
    assert.deepEqual(board.prompt_index, { "G-6": "coord/prompts/tickets/G-6.md" });
    assert.equal(writtenBoards.length, 1);
  });
});

test("COORD-813: the production-wired start gate rejects a scaffold prompt and accepts a specific one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord813-wired-"));
  try {
    const scaffoldPath = path.join(dir, "scaffold.md");
    const specificPath = path.join(dir, "specific.md");
    fs.writeFileSync(scaffoldPath, "# R-1\n\n## Acceptance Criteria\n\n- Ticket scope is implemented.\n", "utf8");
    fs.writeFileSync(specificPath, COORD813_SPECIFIC_PROMPT, "utf8");
    // Absolute mappings are honored (same as the COORD-008 harness); a mapped
    // ticket is a read-only fast path, so no board write happens here.
    assert.throws(
      () => admitsPrompt(() => __testing.assertPromptRecord("R-1", { Repo: "X" }, { prompt_index: { "R-1": scaffoldPath }, waiver_index: {} }, {})),
      (error) => error.message.includes(scaffoldPath) && /R-1 cannot start[\s\S]*no ticket-specific criteria/.test(error.message),
    );
    assert.equal(
      admitsPrompt(() => __testing.assertPromptRecord("R-1", { Repo: "X" }, { prompt_index: { "R-1": specificPath }, waiver_index: {} }, {})),
      true,
    );
    assert.equal(
      admitsPrompt(() => __testing.assertPromptRecord("R-1", { Repo: "X" }, {
        prompt_index: { "R-1": scaffoldPath },
        waiver_index: { "R-1": { code: "prompt_coverage", reason: "accepted", recorded_at: new Date().toISOString(), recorded_by: "claudea11" } },
      }, {})),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// COORD-813: the generators lift the ticket's own acceptance text from the
// board Description, so a freshly generated prompt satisfies the content
// contract when (and only when) the Description carries recognisable criteria.
const { buildGeneratedPromptCriteria, evaluatePromptContent, inspectPromptContent } = createPromptCoverage;

test("COORD-813: generated criteria lift Description acceptance and verification text", () => {
  const lift = (description) => buildGeneratedPromptCriteria("L-1", description);
  // Board form: bold label, multi-line, ends at the blank line before Source.
  assert.deepEqual(lift(
    "Title\n\n**Problem:** p\n\n**Acceptance:** Reject generic acceptance.\nCover the waiver case.\n\nSource: census",
  ).acceptance, ["- Reject generic acceptance.", "- Cover the waiver case."]);
  // Quickstart one-liner: inline label after the title sentence.
  assert.deepEqual(
    lift("Initial setup. Acceptance: gov doctor reports the workspace healthy.").acceptance,
    ["- gov doctor reports the workspace healthy."],
  );
  // `Acceptance criteria:` label with bullets; a following **Label:** ends the section.
  assert.deepEqual(
    lift("T\nAcceptance criteria:\n- one\n1. two\n**Verification:** `npm test`").acceptance,
    ["- one", "1. two"],
  );
  assert.deepEqual(lift("T\nAcceptance criteria:\n- one\n**Verification:** `npm test`").verification, ["- `npm test`"]);
  // Heading form runs to the next heading, across blank lines.
  assert.deepEqual(lift("T\n## Acceptance\n\n- a\n\n- b\n## Notes\n- c").acceptance, ["- a", "- b"]);
  // Prose that merely mentions acceptance, generic-only and placeholder-only
  // text are not lifted: the generated body is the instructive TODO instead.
  for (const description of [
    "Improve user acceptance: faster onboarding.",
    "T. Acceptance: Ticket scope is implemented.",
    "T\n**Acceptance:** TODO\n",
    "T\nAcceptance:\n\nlater text",
    "",
    undefined,
  ]) {
    const criteria = lift(description);
    assert.equal(criteria.acceptance.length, 1, String(description));
    assert.match(criteria.acceptance[0], /^- TODO: write this ticket's acceptance criteria/);
    assert.ok(criteria.acceptance[0].includes("gov register-prompt L-1 --body-file <file>"));
    assert.deepEqual(criteria.verification, [
      "- Record the focused verification commands and their results in the governed plan (`coord/scripts/gov update-plan`).",
    ]);
  }
  // A later recognisable label is still found after a generic-only one.
  assert.deepEqual(lift("T. Acceptance: Ticket scope is implemented.\n**Acceptance:** real").acceptance, ["- real"]);
});

test("COORD-813: the lifter takes an Acceptance label only at a line or sentence start, never mid-phrase", () => {
  const lift = (description) => buildGeneratedPromptCriteria("L-2", description).acceptance;
  // Mid-sentence mentions are prose, not a label.
  for (const description of [
    "The Acceptance: section is weak.",
    "User Acceptance: the login form renders.",
    "Fix it\nUser Acceptance: the login form renders.",
  ]) {
    const acceptance = lift(description);
    assert.equal(acceptance.length, 1, description);
    assert.match(acceptance[0], /^- TODO: write this ticket's acceptance criteria/, description);
  }
  // Line-start (plain and bold) and sentence-start labels are still lifted.
  assert.deepEqual(lift("Acceptance: rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("T\n  **Acceptance:** rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("Fix it! Acceptance: rows persist."), ["- rows persist."]);
  // A later real label still wins after a mid-phrase mention on an earlier line.
  assert.deepEqual(lift("The Acceptance: section is weak.\nAcceptance: rows persist."), ["- rows persist."]);
});

// COORD-837 (COORD-813 review): the period of a mid-sentence abbreviation is
// not a sentence end, so the label after it is prose and nothing is lifted.
test("COORD-837: the lifter does not treat the period of e.g., i.e., vs. or cf. as a sentence end", () => {
  const lift = (description) => buildGeneratedPromptCriteria("L-3", description).acceptance;
  for (const description of [
    "Do it e.g. Acceptance: mid",
    "Do it i.e. Acceptance: mid",
    "Do it E.G. Acceptance: mid",
    "Speed vs. Acceptance: mid",
    "See cf. Acceptance: mid",
    "e.g. Acceptance: mid",
  ]) {
    const acceptance = lift(description);
    assert.equal(acceptance.length, 1, description);
    assert.match(acceptance[0], /^- TODO: write this ticket's acceptance criteria/, description);
  }
  // A real sentence end still lifts, including one after an abbreviation was
  // used earlier in the sentence and words that merely end in the same letters.
  assert.deepEqual(lift("Do it e.g. now. Acceptance: rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("Fix X. Acceptance: rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("Retire the devs. Acceptance: rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("Fix the pdf.cf. Acceptance: rows persist."), ["- rows persist."]);
  assert.deepEqual(lift("Do it e.g. Acceptance: mid\nAcceptance: rows persist."), ["- rows persist."]);
});

test("COORD-813: an acceptance line with no content after normalisation is not a criterion", () => {
  const prompt = (body) => `# T-1: Title\n\n## Acceptance Criteria\n\n${body}\n`;
  for (const body of ["-", "- ...", "```\n```"]) {
    assert.deepEqual(inspectPromptContent(prompt(body)), [
      "\"## Acceptance Criteria\" has no ticket-specific criteria (only the generated scaffold text, placeholders, or nothing)",
    ], JSON.stringify(body));
  }
  // A real criterion beside the empty shapes still satisfies the section.
  assert.deepEqual(inspectPromptContent(prompt("-\n- ...\n- Empty input exits 2.")), []);
});

test("COORD-813: register-prompt --create output passes when the Description carries acceptance, fails with guidance otherwise", () => {
  withPromptContentFixture(({ promptCoverage, writePrompt }) => {
    const board = { prompt_index: {}, waiver_index: {} };
    const generate = (ticketId, Description) => {
      board.prompt_index[ticketId] = writePrompt(ticketId, promptCoverage.buildTicketPromptTemplate(ticketId, { Description }));
      return promptCoverage.collectPromptRecordIssues(ticketId, board).issues;
    };
    assert.deepEqual(generate("C-1", "Fix the parser. Acceptance: empty input is rejected with exit code 2."), []);
    // A row without a Description falls back to a generic title and the
    // instructive acceptance TODO, never to passing criteria.
    const untitled = promptCoverage.buildTicketPromptTemplate("C-0");
    assert.match(untitled, /^# C-0: C-0 implementation prompt\n/);
    assert.equal(inspectPromptContent(untitled).length, 2);
    assert.doesNotThrow(() => admitsPrompt(() => promptCoverage.assertPromptRecord("C-1", { Repo: "X" }, board, {})));
    const issues = generate("C-2", "Fix the parser.");
    assert.equal(issues.length, 2);
    assert.throws(
      () => admitsPrompt(() => promptCoverage.assertPromptRecord("C-2", { Repo: "X" }, board, {})),
      /C-2 cannot start[\s\S]*TODO: write this ticket's acceptance criteria[\s\S]*`Acceptance: <criteria>` in --description/,
    );
  });
});

test("COORD-813: the start-readiness preflight reports the same prompt verdict and message as gov start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord813-parity-"));
  try {
    const write = (name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
    const scaffold = write("scaffold.md", "# P-1\n\n## Acceptance Criteria\n\n- Ticket scope is implemented.\n");
    const specific = write("specific.md", COORD813_SPECIFIC_PROMPT);
    const row = { ID: "P-1", Repo: "X", Type: "bug", Pri: "P2", Status: "todo", Description: "d", "Depends On": "" };
    const promptBlockers = (board) => __testing.collectStartReadinessBlockers("P-1", row, board)
      .filter((blocker) => blocker.code === "prompt_coverage");
    const startMessage = (board) => {
      try {
        admitsPrompt(() => __testing.assertPromptRecord("P-1", { Repo: "X" }, board, {}));
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const boardFor = (prompt, extra = {}) => ({ sections: [{ rows: [row] }], prompt_index: { "P-1": prompt }, waiver_index: {}, ...extra });

    for (const prompt of [scaffold, path.join(dir, "missing.md"), dir]) {
      const board = boardFor(prompt);
      const blockers = promptBlockers(board);
      assert.equal(blockers.length, 1, prompt);
      assert.equal(blockers[0].message, startMessage(board), "preflight and start must agree");
      assert.ok(blockers[0].message.includes(prompt));
      assert.deepEqual(blockers[0].next_steps, [
        "coord/scripts/gov register-prompt P-1 --body-file <file>",
        promptTesting.buildPromptWaiverCommand("P-1"),
      ]);
    }
    for (const board of [
      boardFor(specific),
      boardFor(scaffold, { waiver_index: { "P-1": { code: "prompt_coverage", reason: "accepted", recorded_at: new Date().toISOString(), recorded_by: "claudea11" } } }),
    ]) {
      assert.deepEqual(promptBlockers(board), []);
      assert.equal(startMessage(board), null);
    }

    // COORD-813 ruling: a no-heading prompt that is not on the role-prompt
    // allowlist is refused by both surfaces with one message, however many
    // tickets map it; the real coord/prompts/implementer.md role prompt passes
    // both.
    const noHeading = write("no-heading.md", "# Implementer Role\n\n## Finish Gate\n\n- Gates pass.\n");
    for (const refused of [
      boardFor(noHeading),
      boardFor(noHeading, { prompt_index: { "P-1": noHeading, "P-2": noHeading } }),
    ]) {
      const [headingBlocker] = promptBlockers(refused);
      assert.match(headingBlocker.message, /no "## Acceptance" heading/);
      assert.equal(headingBlocker.message, startMessage(refused), "preflight and start must agree");
    }
    const roleBoard = boardFor("coord/prompts/implementer.md");
    assert.deepEqual(promptBlockers(roleBoard), []);
    assert.equal(startMessage(roleBoard), null);

    // Unmapped tickets: the on-disk default prompt start would auto-register is
    // judged identically by both surfaces; a waiver needs no prompt at all; and
    // with neither, both keep the original "no prompt coverage" verdict.
    withScopedGovernanceTestContext({ PROMPTS_DIR: path.join(dir, "prompts") }, () => {
      fs.mkdirSync(path.join(dir, "prompts", "tickets"), { recursive: true });
      fs.writeFileSync(path.join(dir, "prompts", "tickets", "P-1.md"), fs.readFileSync(scaffold));
      const discovered = { sections: [{ rows: [row] }], prompt_index: {}, waiver_index: {} };
      const [blocker] = promptBlockers(discovered);
      assert.equal(blocker.message, startMessage(discovered));
      assert.match(blocker.message, /prompts\/tickets\/P-1\.md does not satisfy the prompt content contract/);
      assert.deepEqual(discovered.prompt_index, {}, "a refused prompt is not auto-registered");

      const waived = { sections: [{ rows: [row] }], waiver_index: { "P-1": { code: "prompt_coverage", reason: "accepted", recorded_at: new Date().toISOString(), recorded_by: "claudea11" } } };
      assert.deepEqual(promptBlockers(waived), []);
      assert.equal(startMessage(waived), null);

      fs.rmSync(path.join(dir, "prompts", "tickets", "P-1.md"));
      const uncovered = { sections: [{ rows: [row] }] };
      const [missing] = promptBlockers(uncovered);
      assert.equal(missing.message, "Ticket P-1 cannot start without prompt coverage or a recorded waiver.");
      assert.equal(admitsPrompt(() => __testing.assertPromptRecord("P-1", { Repo: "X" }, uncovered, {})), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-813: evaluatePromptContent resolves relative mappings against the caller's root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord813-eval-"));
  try {
    fs.writeFileSync(path.join(root, "p.md"), "# E-1\n\n## Acceptance\n\n- TODO\n");
    const context = {
      rootDir: root,
      hasPromptWaiver: () => false,
      defaultTicketPromptRelPath: () => "unused.md",
      ticketPromptRelPathExists: () => false,
    };
    const report = evaluatePromptContent("E-1", { prompt_index: { "E-1": "p.md" } }, context);
    assert.equal(report.prompt, "p.md");
    assert.deepEqual(report.issues, inspectPromptContent(fs.readFileSync(path.join(root, "p.md"), "utf8")));
    assert.equal(report.issues.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-837 (COORD-813 review): a promptCoverage.rolePrompts entry (or a
// shipped role prompt) that is a symlink resolving outside the workspace never
// confers the shared-role exemption, on either spelling.
test("COORD-837: a role prompt symlinked to a file outside the workspace is not allowlisted", () => {
  const noAcceptance = "# COORD-900: do the thing\n\n## Assignment\nDo whatever seems right.\n";
  withPromptContentFixture(({ promptCoverage, root }) => {
    const issuesOf = (rel) => promptCoverage.collectPromptRecordIssues("COORD-900", { prompt_index: { "COORD-900": rel } }).issues;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coord837-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "x.md"), noAcceptance);
      fs.mkdirSync(path.join(root, "coord/prompts/shared"), { recursive: true });
      fs.mkdirSync(path.join(root, "coord/roles"), { recursive: true });
      fs.symlinkSync(path.join(outside, "x.md"), path.join(root, "coord/prompts/shared/link.md"));
      fs.writeFileSync(path.join(root, "coord/roles/real.md"), COORD813_ROLE_PROMPT);
      fs.symlinkSync(path.join(root, "coord/roles/real.md"), path.join(root, "coord/prompts/shared/inside.md"));
      fs.writeFileSync(path.join(root, "coord/project.config.js"), `module.exports = ${JSON.stringify({ promptCoverage: { rolePrompts: [
        "coord/prompts/shared/link.md",
        "coord/prompts/shared/inside.md",
      ] } })};\n`);
      for (const rel of ["coord/prompts/shared/link.md", path.join(outside, "x.md")]) {
        const issues = issuesOf(rel);
        assert.equal(issues.length, 1, `${rel}: ${JSON.stringify(issues)}`);
        assert.match(issues[0], /no "## Acceptance" heading/);
      }
      // A listed symlink that stays inside the workspace keeps both spellings.
      assert.deepEqual(issuesOf("coord/prompts/shared/inside.md"), []);
      assert.deepEqual(issuesOf("coord/roles/real.md"), []);
      // The same holds for an engine-shipped role prompt name.
      fs.symlinkSync(path.join(outside, "x.md"), path.join(root, "coord/prompts/implementer.md"));
      assert.equal(issuesOf("coord/prompts/implementer.md").length, 1);
      assert.equal(issuesOf(path.join(outside, "x.md")).length, 1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// COORD-837: on a case-insensitive filesystem a differently cased spelling of a
// tickets directory or a ticket's own prompt is the same file, so the tickets
// exclusion and allowlist membership compare case-folded there (and only there).
test("COORD-837: classification case-folds paths only where the filesystem folds case", () => {
  const { classifyPromptMapping } = createPromptCoverage;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord837-case-"));
  try {
    fs.mkdirSync(path.join(root, "coord/prompts/tickets"), { recursive: true });
    fs.writeFileSync(path.join(root, "coord/project.config.js"), `module.exports = ${JSON.stringify({ promptCoverage: { rolePrompts: [
      "coord/prompts/TICKETS/COORD-902.md",
      "coord/prompts/Tickets/COORD-900.md",
      "coord/roles/designer.md",
    ] } })};\n`);
    const classify = (rel, caseInsensitiveFs, defaultRel = (id) => `coord/prompts/tickets/${id}.md`) => classifyPromptMapping("COORD-900", rel, {}, {
      rootDir: root,
      defaultTicketPromptRelPath: defaultRel,
      caseInsensitiveFs,
    });
    // Case-sensitive: TICKETS/ is a different directory, listed, so shared.
    assert.equal(classify("coord/prompts/TICKETS/COORD-902.md", false), "shared");
    assert.equal(classify("coord/roles/Designer.md", false), "ticket");
    // Case-insensitive: the same paths are the tickets directory / the listed file.
    assert.equal(classify("coord/prompts/TICKETS/COORD-902.md", true), "ticket");
    assert.equal(classify("coord/prompts/Tickets/COORD-900.md", true), "ticket");
    assert.equal(classify("coord/roles/Designer.md", true), "shared");
    // The own-default comparison folds too (a default outside any tickets dir).
    const flat = (id) => `coord/defaults/${id}.md`;
    assert.equal(classify("coord/defaults/coord-900.MD", true, flat), "ticket");
    // Without the override the filesystem is probed (this one is case-sensitive).
    assert.equal(createPromptCoverage.isCaseInsensitiveFs(root), false);
    assert.equal(classifyPromptMapping("COORD-900", "coord/prompts/TICKETS/COORD-902.md", {}, {
      rootDir: root,
      defaultTicketPromptRelPath: (id) => `coord/prompts/tickets/${id}.md`,
    }), "shared");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-837: isCaseInsensitiveFs probes the filesystem, not the platform name", () => {
  const { isCaseInsensitiveFs } = createPromptCoverage;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "coord837-probe-"));
  const originalStat = fs.statSync;
  try {
    const digits = path.join(base, "1234");
    fs.mkdirSync(digits);
    // A letterless name is skipped; the lettered parent decides (case-sensitive here).
    assert.equal(isCaseInsensitiveFs(digits), false);
    // A missing path walks up to its nearest existing ancestor.
    assert.equal(isCaseInsensitiveFs(path.join(base, "missing", "deeper")), false);
    // Nothing lettered exists all the way to the filesystem root.
    assert.equal(isCaseInsensitiveFs(path.parse(base).root), false);
    // A swapped-case spelling that answers with the same file means folding.
    const swapped = path.join(path.dirname(base), path.basename(base).replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())));
    fs.statSync = (target, ...rest) => originalStat(target === swapped ? base : target, ...rest);
    assert.equal(isCaseInsensitiveFs(base), true);
    // A distinct file at the swapped spelling is a case-sensitive sibling.
    fs.statSync = (target, ...rest) => originalStat(target === swapped ? digits : target, ...rest);
    assert.equal(isCaseInsensitiveFs(base), false);
  } finally {
    fs.statSync = originalStat;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// COORD-956: the boolean view of the merged check. True when the prompt is admitted,
// false when no prompt coverage or waiver exists (the start refusal the ticket
// transitions raise), and it rethrows content and precondition refusals unchanged.
function admitsPrompt(run) {
  try {
    run();
    return true;
  } catch (error) {
    if (/cannot start without prompt coverage or a recorded waiver\.$/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

// ===========================================================================
// COORD-956 (ADR 0021, human-admin approved 2026-11-12): the prompt-content-contract,
// prompt-coverage and prompt-preconditions guards are one prompt-record check. The
// merged check is assertPromptRecord (start: content, then coverage or discovery,
// then preconditions) plus collectPromptRecordBlockers (read-only preflight: coverage
// and content, never preconditions, exactly as before). The equivalence fixture was
// captured from the three guards before the merge over the same cases.
// ===========================================================================

const PROMPT_RECORD_GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__", "prompt-record-equivalence.json"), "utf8"),
);
const PROMPT_RECORD_SCAFFOLD = "# T-1\n\n## Acceptance Criteria\n\n- Ticket scope is implemented.\n";
const PROMPT_RECORD_SPECIFIC = "# T-1: specific\n\n## Acceptance Criteria\n\n- `gov start` refuses stub prompts.\n\n## Verification\n\n- `node --test x.test.js`\n";
const PROMPT_RECORD_CASES = [
  { name: "no-coverage (no mapping, no waiver, no file)", mapping: "none", body: null },
  { name: "waiver only, no prompt", mapping: "none", body: null, waiver: true },
  { name: "stub prompt mapped (COORD-813)", mapping: "abs", body: PROMPT_RECORD_SCAFFOLD },
  { name: "mapped prompt file missing", mapping: "abs", body: "__MISSING__" },
  { name: "mapped prompt empty", mapping: "abs", body: "" },
  { name: "mapped prompt without Acceptance heading", mapping: "abs", body: "# T-1\n\n## Finish Gate\n\n- Gates pass.\n" },
  { name: "mapped prompt with TODO placeholder", mapping: "abs", body: "# T-1\n\n## Acceptance Criteria\n\n- TODO: add criteria\n- real criterion here\n" },
  { name: "default on-disk scaffold, unmapped", mapping: "default", body: PROMPT_RECORD_SCAFFOLD },
  { name: "default on-disk specific, unmapped (COORD-023 discovery)", mapping: "default", body: PROMPT_RECORD_SPECIFIC },
  { name: "waiver over stub prompt", mapping: "abs", body: PROMPT_RECORD_SCAFFOLD, waiver: true },
  { name: "specific prompt, precondition unresolved (COORD-008)", mapping: "abs", body: `${PROMPT_RECORD_SPECIFIC}\n## Preconditions\n- path:src/does-not-exist.js\n` },
  { name: "specific prompt, precondition resolved", mapping: "abs", body: `${PROMPT_RECORD_SPECIFIC}\n## Preconditions\n- path:src/existing.js\n` },
  { name: "specific prompt, no Preconditions section", mapping: "abs", body: PROMPT_RECORD_SPECIFIC },
];
const PROMPT_RECORD_ROW = { ID: "T-1", Repo: "X", Type: "bug", Pri: "P2", Status: "todo", Description: "d", "Depends On": "" };
const PROMPT_RECORD_WAIVER = { code: "prompt_coverage", reason: "accepted", recorded_at: "2026-11-13T00:00:00.000Z", recorded_by: "claudea805" };

// Builds one prompt-record fixture: a temp git repo as the factory root, the case's
// prompt on disk, and a capturing board writer. Returns the merged-check bindings.
function promptRecordFixture(c, { preflightOnly = false } = {}) {
  const repo = createTempGitRepoWithOrigin("coord956-record-", { "src/existing.js": "export const ready = true;\n" });
  const root = repo.repoRoot;
  const promptsDir = path.join(root, "coord", "prompts");
  const writes = [];
  const board = { sections: [{ rows: [PROMPT_RECORD_ROW] }], prompt_index: {}, waiver_index: {} };
  const abs = path.join(promptsDir, "tickets", "T-1.hand.md");
  if (c.mapping === "abs") {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (c.body !== "__MISSING__") fs.writeFileSync(abs, c.body);
    board.prompt_index["T-1"] = abs;
  }
  if (c.mapping === "default") {
    fs.mkdirSync(path.join(promptsDir, "tickets"), { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "tickets", "T-1.md"), c.body);
  }
  if (c.waiver) board.waiver_index["T-1"] = PROMPT_RECORD_WAIVER;
  const factory = createPromptCoverage({
    ROOT_DIR: root,
    COORD_DIR: path.join(root, "coord"),
    getPromptsDir: () => promptsDir,
    readTicketWaiver: (b, id, code) => (b.waiver_index?.[id] && code === "prompt_coverage" ? b.waiver_index[id] : null),
    gitCommitishExists: promptWorktreeOps.gitCommitishExists,
    gitPathExistsAtRef,
    gitRefContainsLiteral,
    uniqueStrings: (values) => [...new Set(values)],
    isRepoBackedCode: () => false,
    getRepoRoot: () => root,
    resolveTicketBaseRef: () => "HEAD",
    repoDisplayNameForCode: () => "coord",
    fail: (message) => { throw new Error(message); },
    withCoordStateLock: (fn) => fn(),
    writeBoard: (b) => writes.push(structuredClone(b)),
    runBoardSync: () => {},
  });
  return { root, promptsDir, board, writes, factory, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function promptRecordNormalize(text, root) {
  const rootPath = path.resolve(root).replace(/\\/g, "/");
  const rootName = path.basename(rootPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Readiness reports this path relative to the checkout, so temp fixtures
  // outside that checkout have a variable ../tmp prefix. Normalize only the
  // unique mkdtemp root token; keep the rest of the refusal byte-for-byte.
  const tokenized = String(text)
    .replaceAll(rootPath, "<ROOT>")
    .replace(new RegExp(`(^|[\\s(])[^\\s\"'\x60]*${rootName}(?=/|$)`, "g"), "$1<ROOT>");
  return tokenized.replace(/(?:\.\.\/)+(?:\.\.)?<ROOT>/g, "<ROOT>");
}

test("COORD-956: the merged check reproduces every refusal and admission of the three retired guards", () => {
  assert.equal(PROMPT_RECORD_GOLDEN.length, PROMPT_RECORD_CASES.length, "fixture covers every case");
  for (const [index, c] of PROMPT_RECORD_CASES.entries()) {
    const golden = PROMPT_RECORD_GOLDEN[index];
    assert.equal(golden.name, c.name, "fixture and case table agree on order");
    const fixture = promptRecordFixture(c);
    try {
      // Preflight (prompt-coverage + prompt-content-contract blockers, read-only). Production readiness path.
      withScopedGovernanceTestContext({ PROMPTS_DIR: fixture.promptsDir }, () => {
        const preflight = __testing.collectStartReadinessBlockers("T-1", PROMPT_RECORD_ROW, structuredClone(fixture.board))
          .filter((blocker) => blocker.code === "prompt_coverage")
          .map((blocker) => ({
            code: blocker.code,
            message: promptRecordNormalize(blocker.message, fixture.root),
            next_steps: blocker.next_steps.map((step) => promptRecordNormalize(step, fixture.root)),
          }));
        const expectedPreflight = golden.preflight.map((blocker) => ({
          ...blocker,
          message: promptRecordNormalize(blocker.message, fixture.root),
          next_steps: blocker.next_steps.map((step) => promptRecordNormalize(step, fixture.root)),
        }));
        assert.deepEqual(preflight, expectedPreflight, `${c.name}: preflight`);
      });
      // Start: one merged check, content then coverage or discovery then preconditions.
      const startBoard = structuredClone(fixture.board);
      let outcome;
      try {
        fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, startBoard, { preconditionRef: "HEAD" });
        outcome = {
          admitted: true,
          mapping: startBoard.prompt_index?.["T-1"] ? promptRecordNormalize(startBoard.prompt_index["T-1"], fixture.root) : null,
          boardWrites: fixture.writes.length,
        };
      } catch (error) {
        outcome = { refused: promptRecordNormalize(error.message, fixture.root) };
      }
      const expectedRefusal = golden.start.refused || golden.preconditions?.refused;
      const normalizedExpectedRefusal = expectedRefusal ? promptRecordNormalize(expectedRefusal, fixture.root) : null;
      if (normalizedExpectedRefusal) {
        assert.deepEqual(outcome, { refused: normalizedExpectedRefusal }, `${c.name}: start refusal`);
      } else {
        assert.deepEqual(outcome, { admitted: true, mapping: golden.start.mapping, boardWrites: golden.boardWrites }, `${c.name}: start admission`);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("COORD-813 (must still cover): assertPromptRecord refuses a stub prompt at start before any discovery write", () => {
  const fixture = promptRecordFixture({ mapping: "default", body: PROMPT_RECORD_SCAFFOLD });
  try {
    assert.throws(
      () => fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, structuredClone(fixture.board), { preconditionRef: "HEAD" }),
      /T-1 cannot start: its prompt \S+T-1\.md does not satisfy the prompt content contract[\s\S]*no ticket-specific criteria/,
    );
    assert.equal(fixture.writes.length, 0, "a refused stub must not be auto-registered");
  } finally {
    fixture.cleanup();
  }
});

test("COORD-023 (must still cover): assertPromptRecord with no prompt or waiver refuses with the coverage message; preflight blocks", () => {
  const fixture = promptRecordFixture({ mapping: "none", body: null });
  try {
    const board = structuredClone(fixture.board);
    assert.throws(
      () => fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, board, { preconditionRef: "HEAD" }),
      (error) => error.message === "Ticket T-1 cannot start without prompt coverage or a recorded waiver.",
    );
    assert.equal(fixture.writes.length, 0);
    const blockers = fixture.factory.collectPromptRecordBlockers("T-1", board);
    assert.deepEqual(blockers.map((blocker) => blocker.code), ["prompt_coverage"]);
    assert.equal(blockers[0].message, "Ticket T-1 cannot start without prompt coverage or a recorded waiver.");
  } finally {
    fixture.cleanup();
  }
});

test("unresolvable prompt references (must still cover): assertPromptRecord refuses a stale prompt and names the unresolved artifact", () => {
  const fixture = promptRecordFixture({ mapping: "abs", body: `${PROMPT_RECORD_SPECIFIC}\n## Preconditions\n- path:src/does-not-exist.js\n` });
  try {
    let resolvedRefCalls = 0;
    assert.throws(
      () => fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, structuredClone(fixture.board), {
        resolvePreconditionRef: () => { resolvedRefCalls += 1; return "HEAD"; },
      }),
      (error) => /cannot start: its prompt declares precondition artifacts that do not resolve[\s\S]*path:src\/does-not-exist\.js \(not found on HEAD\)/.test(error.message),
    );
    assert.equal(resolvedRefCalls, 1, "the integration ref is resolved once, after coverage and before preconditions");
    // Preconditions are a start-only refusal: the read-only preflight does not report them.
    const blockers = fixture.factory.collectPromptRecordBlockers("T-1", structuredClone(fixture.board));
    assert.deepEqual(blockers, []);
    const board = structuredClone(fixture.board);
    const mapped = board.prompt_index["T-1"];
    assert.throws(() => fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, board, {
      resolvePreconditionRef() { fs.unlinkSync(mapped); return "HEAD"; },
    }), /unable to read prompt .* for precondition verification/);
    board.waiver_index = { "T-1": { code: "prompt_coverage", reason: "Approved fixture waiver" } };
    assert.doesNotThrow(() => fixture.factory.assertPromptRecord("T-1", { Repo: "X" }, board, { preconditionRef: "HEAD" }));
    assert.equal(fixture.writes.length, 0, "reading the waiver must not rewrite the prompt mapping");

  } finally {
    fixture.cleanup();
  }
});
