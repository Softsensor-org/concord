// COORD-890: drop inherited agent-shell identity so a bare `node --test` run matches a runner child.
require("./test-runner.js").scrubIdentityEnv();
// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { state, withAgentStateLock } = require("./governance-context.js");
const governanceContext = require("./governance-context.js");

const {
  GovernanceError,
  withoutProcFs,
  runGit,
  createTempGitRepo,
  withScopedGovernanceTestContext,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const createGovernanceSession = require("./governance-session.js");
const sessionStateIo = require("./state-io.js");
const memoryClassification = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/memory-classification.js"));
const createSessionLockRecords = require("./session-lock-records.js");
const createLifecycleSessionReaping = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-session-reaping.js"));
const createTicketQueueService = require("./ticket-queue-service.js");
const createTicketLockService = require("./ticket-lock-service.js");
const { gitTry } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/git-ops.js"));
const createRepoRegistry = require("./repo-registry.js");
const repoRegistryOwner = createRepoRegistry();
const identityV2 = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js"));
const { STATUS } = require("./governance-constants.js");
const AGENT_SESSION_IDLE_MS = 60 * 60 * 1000;
const SESSION_FINGERPRINT_ENV_VARS = [
  "TERM_SESSION_ID",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "WT_SESSION",
  "KITTY_WINDOW_ID",
  "TAB_ID",
];
let sessionTesting;
const sessionBoardState = require("./governance-board-state.js")({
  BOARD_RAW_SYMBOL: sessionStateIo.BOARD_RAW_SYMBOL,
  BoardValidationError: GovernanceError,
  LEGAL_STATUSES: new Set(Object.values(STATUS)),
  WAIVER_CODES: new Set(["prompt_coverage"]),
  attachTrackedRaw: sessionStateIo.attachTrackedRaw,
  fail: governanceContext.defaultFail,
  normalizeBoardIdentityReferences: (...args) => sessionTesting.normalizeBoardIdentityReferences(...args),
  readCanonicalTextFile: sessionStateIo.readCanonicalTextFile,
  state,
  syncBoardArtifacts: () => {},
  writeCanonicalTextFile: sessionStateIo.writeCanonicalTextFile,
});
const sessionLockService = createTicketLockService({
  state,
  gitTry,
  isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
  repoCodeForLockRepoName: repoRegistryOwner.repoCodeForLockRepoName,
  fail: governanceContext.defaultFail,
});
const compareSessionsMostRecentFirst = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-session-reaping.js"))({}).compareSessionsMostRecentFirst;
const { integerOrDefault } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const sessionJournalReader = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/journal.js"))({ state, fs, path });
const lifecycleJournalQueries = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-journal-queries.js"))({
  integerOrDefault,
  readGovernanceEventLog: sessionJournalReader.readGovernanceEventLog,
});

let sessionReaping;
sessionTesting = createGovernanceSession({
  ...sessionStateIo,
  ...sessionBoardState,
  AGENT_SESSION_IDLE_MS,
  COORD_DIR: path.resolve(__dirname, "..", ".."),
  GovernanceError,
  SESSION_FINGERPRINT_ENV_VARS,
  ensureWaiverIndex: sessionBoardState.ensureWaiverIndex,
  fail: governanceContext.defaultFail,
  findLatestTicketGovernanceEvent: lifecycleJournalQueries.findLatestTicketGovernanceEvent,
  getRows: sessionBoardState.getRows,
  getTicketRef: sessionBoardState.getTicketRef,
  identityV2,
  isRepoBackedCode: repoRegistryOwner.isRepoBackedCode,
  moveFileIfNeeded: sessionStateIo.moveFileIfNeeded,
  reapIdleAutoClaimedProviderStubs: (...args) => sessionReaping.reapIdleAutoClaimedProviderStubs(...args),
  repoNameForCode: repoRegistryOwner.repoNameForCode,
  resolveLockHead: sessionLockService.resolveLockHead,
  compareSessionsMostRecentFirst,
  summarizeGovernanceEvent: lifecycleJournalQueries.summarizeGovernanceEvent,
  state: state,
  withAgentStateLock,
});
const sessionQueue = createTicketQueueService({
  STATUS,
  state,
  compareSessionsMostRecentFirst,
  findDoingTicketForOwner: (...args) => sessionTesting.findDoingTicketForOwner(...args),
  readAgentSessions: (...args) => sessionTesting.readAgentSessions(...args),
  readAgentsRegistry: (...args) => sessionTesting.readAgentsRegistry(...args),
  resolveAgentIdentifier: (...args) => sessionTesting.resolveAgentIdentifier(...args),
});
sessionReaping = createLifecycleSessionReaping({
  STATUS,
  AGENT_SESSION_IDLE_MS,
  findDoingTicketForOwner: (...args) => sessionTesting.findDoingTicketForOwner(...args),
  getTicketRef: sessionBoardState.getTicketRef,
  listIdleActiveAgentSessions: (...args) => sessionQueue.listIdleActiveAgentSessions(...args),
  normalizeOwnerValue: (...args) => sessionTesting.normalizeOwnerValue(...args),
  readAgentSessions: (...args) => sessionTesting.readAgentSessions(...args),
  readAgentsRegistry: (...args) => sessionTesting.readAgentsRegistry(...args),
  readBoard: sessionBoardState.readBoard,
  resolveEffectiveThreadId: (...args) => sessionTesting.resolveEffectiveThreadId(...args),
  state,
  withAgentStateLock,
  writeJsonFile: sessionStateIo.writeJsonFile,
});

// These Phase-6 tests cover lock serialization/rebind identity semantics, not
// Repo-X worktree authorization. Inject an explicit no-repository resolver so
// their temporary worktree strings stay hermetic under Git-backed test roots;
// public Repo-X registered-worktree behavior is covered by ticket-lock-service
// and board integration tests.
const gcvLockRecords = createSessionLockRecords({
  normalizeOwnerValue: (value) => String(value || "").trim().toLowerCase(),
  repoNameForCode: (repoCode) => repoCode,
  resolveLockHead: () => "coord-no-git-head",
  resolveAgentIdentifier: () => null,
  readAgentsRegistry: () => [],
  state: state,
  ensureParentDir: (filePath) => fs.mkdirSync(path.dirname(filePath), { recursive: true }),
  identityV2,
  moveFileIfNeeded: (source, destination) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (source !== destination && fs.existsSync(source)) fs.renameSync(source, destination);
    return destination;
  },
});

// COORD-097 (governance.test residual split, slice 2): lower-level
// session / identity / lock-authority ENGINE behavior. Every subject here is
// defined in governance-session.js (the session/identity/owner-lease/lock
// primitives it owns): registry/session read+migration, runtime session
// fingerprinting, effective-thread-id resolution, current-agent identity,
// session-token minting/reaping, mutation/repair ownership, owner identity
// resolution, and the v2 owner-authoritative lock writer/rebinder. The
// agent-COMMAND orchestration layer lives in agent-commands.test.js; the
// cross-module facade + lifecycle cases stay in governance.test.js.
//
// Hermetic session env: these tests control provider session/thread ids
// explicitly. Strip any ambient id the host injects (e.g. Claude Code exports
// CLAUDE_CODE_SESSION_ID) so it cannot leak into fingerprint/identity tests.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

test("isCompleteLockPayload rejects partial lock records that are missing governed fields", () => {
  assert.equal(
    sessionTesting.isCompleteLockPayload({
      owner: "claudea11",
      agent_id: "a11",
      session_id: "a11-session",
      heartbeat_utc: "2026-04-04T12:56:27.896Z",
    }),
    false
  );

  assert.equal(
    sessionTesting.isCompleteLockPayload({
      owner: "claudea11",
      agent_id: "a11",
      ticket: "FE-096",
      status: "doing",
      repo: repoRegistryOwner.repoNameForCode("F"),
      branch: "agent/claudea11-fe-096-fix",
      head: "39770ce0d590bf7afcabcf154589040366b473e9",
      worktree: `/tmp/${repoRegistryOwner.repoNameForCode("F")}/.worktrees/claudea11/FE-096`,
      session_id: "a11-session",
      started_at_utc: "2026-04-04T12:56:27.896Z",
      heartbeat_utc: "2026-04-04T12:56:27.896Z",
    }),
    true
  );
});

test("findDoingTicketForOwner treats blocked-doing statuses as active ownership", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: "DEBT-052",
            Status: "doing (blocked: awaiting policy fix)",
            Owner: "codexa00",
          },
          {
            ID: "DEBT-053",
            Status: "todo",
            Owner: "codexa00",
          },
        ],
      },
    ],
  };

  assert.equal(sessionTesting.isDoingStatus("doing"), true);
  assert.equal(sessionTesting.isDoingStatus("doing (blocked: awaiting policy fix)"), true);
  assert.equal(sessionTesting.findDoingTicketForOwner(board, "codexa00")?.ID, "DEBT-052");
  assert.equal(sessionTesting.findDoingTicketForOwner(board, "codexa00", "DEBT-052"), null);
});

test("allocateAgentSimpleId increments from the highest referenced board user instead of reusing gaps", () => {
  assert.equal(
    sessionTesting.allocateAgentSimpleId(
      [
        { id: "a00", handle: "codexa00" },
        { id: "a04", handle: "codexa04" },
      ],
      {
        sessions: [
          { agent_id: "a05", handle: "codexa05" },
        ],
        board: {
          sections: [
            {
              rows: [
                { Owner: "codexa32" },
              ],
            },
          ],
        },
      }
    ),
    "a33"
  );
});

test("readAgentSessions adopts legacy top-level session state into runtime path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-migrate-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeSessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const legacySessionsPath = path.join(tempDir, "agent_sessions.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const legacySessions = [
    {
      session_id: "s1",
      handle: "codexa00",
      status: "active",
      claimed_at: "2026-03-29T12:00:00.000Z",
    },
  ];

  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(legacySessionsPath, JSON.stringify(legacySessions, null, 2), "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: runtimeSessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: legacySessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      LEGACY_AGENT_SESSIONS_PATH: state.LEGACY_AGENT_SESSIONS_PATH,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = runtimeSessionsPath;
    state.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;

    try {
      const sessions = sessionTesting.readAgentSessions();
      assert.equal(fs.existsSync(runtimeSessionsPath), true);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].session_id, "s1");
      assert.equal(sessions[0].board_path, state.BOARD_PATH);

      const persisted = JSON.parse(fs.readFileSync(runtimeSessionsPath, "utf8"));
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].session_id, "s1");
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      state.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    }
  });
});

test("readAgentSessions fails explicitly when the runtime session file is corrupted", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-session-corrupt-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeSessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const agentsPath = path.join(tempDir, "agents.json");
  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: runtimeSessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: path.join(tempDir, "agent_sessions.json"),
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      LEGACY_AGENT_SESSIONS_PATH: state.LEGACY_AGENT_SESSIONS_PATH,
    };

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(runtimeSessionsPath, "{not json}\n", "utf8");
    fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = runtimeSessionsPath;
    state.LEGACY_AGENT_SESSIONS_PATH = path.join(tempDir, "agent_sessions.json");

    try {
      assert.throws(
        () => sessionTesting.readAgentSessions(),
        (error) => error instanceof GovernanceError && /not valid JSON/i.test(error.message)
      );
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      state.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    }
  });
});

test("readAgentsRegistry adopts legacy top-level registry into runtime path and preserves a compatibility copy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-agents-migrate-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeAgentsPath = path.join(runtimeDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents.json");
  const agents = [
    {
      id: "a99",
      handle: "codexa99",
      aliases: ["codex99"],
      provider: "openai",
      status: "active",
      notes: "temp agent",
      created_at: "2026-03-30T00:00:00.000Z",
    },
  ];
  withScopedGovernanceTestContext({
    AGENTS_PATH: runtimeAgentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      LEGACY_AGENTS_PATH: state.LEGACY_AGENTS_PATH,
    };

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(legacyAgentsPath, JSON.stringify(agents, null, 2), "utf8");

    state.AGENTS_PATH = runtimeAgentsPath;
    state.LEGACY_AGENTS_PATH = legacyAgentsPath;

    try {
      const registry = sessionTesting.readAgentsRegistry();
      assert.equal(fs.existsSync(runtimeAgentsPath), true);
      assert.deepEqual(registry, agents);
      assert.deepEqual(JSON.parse(fs.readFileSync(runtimeAgentsPath, "utf8")), agents);
      assert.deepEqual(JSON.parse(fs.readFileSync(legacyAgentsPath, "utf8")), agents);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    }
  });
});

test("readAgentsRegistry refreshes a stale legacy compatibility copy from the runtime registry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-agents-refresh-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeAgentsPath = path.join(runtimeDir, "agents.json");
  const legacyAgentsPath = path.join(tempDir, "agents.json");
  const runtimeAgents = [
    {
      id: "a00",
      handle: "codexa00",
      aliases: ["codex"],
      provider: "openai",
      status: "active",
      notes: "runtime truth",
      created_at: "2026-03-30T00:00:00.000Z",
    },
  ];
  const legacyAgents = [
    {
      id: "a00",
      handle: "codexa00",
      aliases: ["codex"],
      provider: "openai",
      status: "disabled",
      notes: "stale legacy copy",
      created_at: "2026-03-29T00:00:00.000Z",
    },
  ];
  withScopedGovernanceTestContext({
    AGENTS_PATH: runtimeAgentsPath,
    LEGACY_AGENTS_PATH: legacyAgentsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      LEGACY_AGENTS_PATH: state.LEGACY_AGENTS_PATH,
    };

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(runtimeAgentsPath, JSON.stringify(runtimeAgents, null, 2), "utf8");
    fs.writeFileSync(legacyAgentsPath, JSON.stringify(legacyAgents, null, 2), "utf8");

    state.AGENTS_PATH = runtimeAgentsPath;
    state.LEGACY_AGENTS_PATH = legacyAgentsPath;

    try {
      const registry = sessionTesting.readAgentsRegistry();
      assert.deepEqual(registry, runtimeAgents);
      assert.deepEqual(JSON.parse(fs.readFileSync(legacyAgentsPath, "utf8")), runtimeAgents);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
    }
  });
});

test("getOrCreateSessionToken writes provider fallback tokens under runtime instead of top-level coord", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-runtime-token-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const runtimeSessionThreadsDir = path.join(runtimeDir, "session-threads");
  const legacyTokenPath = path.join(tempDir, ".session-thread-anthropic");
  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    LEGACY_AGENT_SESSIONS_PATH: path.join(tempDir, "agent_sessions.json"),
    RUNTIME_DIR: runtimeDir,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      LEGACY_AGENT_SESSIONS_PATH: state.LEGACY_AGENT_SESSIONS_PATH,
      RUNTIME_DIR: state.RUNTIME_DIR,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      TERM_SESSION_ID: process.env.TERM_SESSION_ID,
      TMUX_PANE: process.env.TMUX_PANE,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
      WT_SESSION: process.env.WT_SESSION,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      TAB_ID: process.env.TAB_ID,
    };

    fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(sessionsPath, JSON.stringify([], null, 2), "utf8");

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    state.LEGACY_AGENT_SESSIONS_PATH = path.join(tempDir, "agent_sessions.json");
    state.RUNTIME_DIR = runtimeDir;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.AGENT_THREAD_ID;
    delete process.env.TERM_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.WEZTERM_PANE;
    delete process.env.WT_SESSION;
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.TAB_ID;

    try {
      const threadId = sessionTesting.getOrCreateSessionToken("anthropic");
      const tokenFiles = fs.readdirSync(runtimeSessionThreadsDir).filter((entry) => entry.endsWith(".json"));
      assert.equal(tokenFiles.length, 1);
      const runtimeTokenPath = path.join(runtimeSessionThreadsDir, tokenFiles[0]);
      assert.match(tokenFiles[0], /^anthropic-[a-f0-9]{12}\.json$/);
      assert.equal(fs.existsSync(legacyTokenPath), false);
      assert.equal(JSON.parse(fs.readFileSync(runtimeTokenPath, "utf8")).thread_id, threadId);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      state.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
      state.RUNTIME_DIR = original.RUNTIME_DIR;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("runtimeSessionFingerprint prefers terminal/session env vars over the sid auto-anchor", () => {
  const original = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
    WT_SESSION: process.env.WT_SESSION,
    KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
    TAB_ID: process.env.TAB_ID,
  };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.TERM_SESSION_ID;
  delete process.env.TMUX_PANE;
  delete process.env.WEZTERM_PANE;
  delete process.env.WT_SESSION;
  delete process.env.KITTY_WINDOW_ID;
  delete process.env.TAB_ID;

  try {
    // No env vars + no procfs → null (the fail-closed backstop in
    // getOrCreateSessionToken takes over from there).
    withoutProcFs(() => {
      assert.equal(sessionTesting.runtimeSessionFingerprint("anthropic"), null);
    });
    // An explicit terminal-multiplexer var anchors the fingerprint deterministically.
    process.env.TMUX_PANE = "%42";
    const tmux = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.match(tmux, /TMUX_PANE:%42/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("runtimeSessionFingerprint auto-anchors via /proc/self/stat session id when no env-var fingerprint exists (POSIX)", () => {
  // On Linux the sid is set by the controlling-terminal session leader and
  // inherited by every subprocess. So even with no CLAUDE_SESSION_ID and no
  // tmux/wezterm/etc. var, the fingerprint is deterministic for one Claude
  // session and different across two concurrent Claude sessions. This is the
  // primary fix; the fail-closed in getOrCreateSessionToken is the backstop.
  const envSnap = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
    WT_SESSION: process.env.WT_SESSION,
    KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
    TAB_ID: process.env.TAB_ID,
  };
  for (const key of Object.keys(envSnap)) delete process.env[key];

  try {
    if (!fs.existsSync("/proc/self/stat")) {
      return;
    }
    const fingerprint = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.ok(fingerprint, "must produce a non-null fingerprint via sid");
    assert.match(fingerprint, /provider:anthropic/);
    assert.match(fingerprint, /\|sid:\d+/, "must include the POSIX sid as the auto-anchor");
    assert.equal(sessionTesting.runtimeSessionFingerprint("anthropic"), fingerprint,
      "sid-based fingerprint must be deterministic across calls");
  } finally {
    for (const [key, value] of Object.entries(envSnap)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("runtimeSessionFingerprint prefers the provider session id (CLAUDE_CODE_SESSION_ID) over the /proc sid and isolates distinct conversations (COORD-013)", () => {
  const envSnap = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
    WT_SESSION: process.env.WT_SESSION,
    KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
    TAB_ID: process.env.TAB_ID,
  };
  for (const key of Object.keys(envSnap)) delete process.env[key];

  try {
    // The Claude Code Bash tool spawns each invocation in its own process
    // session, so the /proc sid changes per call. CLAUDE_CODE_SESSION_ID is the
    // env var Claude Code actually exports, constant for the whole conversation,
    // and must anchor the fingerprint instead of the per-call sid.
    process.env.CLAUDE_CODE_SESSION_ID = "conversation-A";
    const a1 = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.match(a1, /thread:conversation-A/,
      "fingerprint must anchor on the provider session id");
    assert.doesNotMatch(a1, /\|sid:\d+/,
      "the /proc sid must not be used when a provider session id is present");

    // Stable across calls even though the underlying /proc sid would differ.
    const a2 = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.equal(a2, a1, "fingerprint must be stable across calls in one conversation");

    // Two distinct conversations stay isolated.
    process.env.CLAUDE_CODE_SESSION_ID = "conversation-B";
    const b1 = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.notEqual(b1, a1, "distinct session ids must produce distinct fingerprints");

    // The legacy/documented CLAUDE_SESSION_ID name still works as an alias.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "legacy-conversation";
    const legacy = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.match(legacy, /thread:legacy-conversation/,
      "CLAUDE_SESSION_ID must be honored as an alias");
    assert.doesNotMatch(legacy, /\|sid:\d+/);
  } finally {
    for (const [key, value] of Object.entries(envSnap)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("runtimeSessionFingerprint: COORD_SESSION_ID is authoritative and overrides the harness provider thread id (COORD-015)", () => {
  const snap = {
    COORD_SESSION_ID: process.env.COORD_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  try {
    // The Claude harness injects ONE conversation id into every sub-agent.
    process.env.CLAUDE_CODE_SESSION_ID = "conversation-shared-id";
    process.env.CLAUDE_SESSION_ID = "conversation-shared-id";
    delete process.env.TMUX_PANE;

    // Two sub-agents with the SAME shared provider thread id but DISTINCT
    // COORD_SESSION_ID must resolve to DISTINCT fingerprints.
    process.env.COORD_SESSION_ID = "subagent-A";
    const a = sessionTesting.runtimeSessionFingerprint("anthropic");
    process.env.COORD_SESSION_ID = "subagent-B";
    const b = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.match(a, /coord-session:subagent-A/);
    assert.match(b, /coord-session:subagent-B/);
    assert.notEqual(a, b, "distinct COORD_SESSION_ID must yield distinct fingerprints despite a shared provider thread id");
    assert.ok(!a.includes("conversation-shared-id"), "COORD_SESSION_ID must override, not append to, the provider thread id");

    process.env.COORD_SESSION_ID = "subagent-A";
    assert.equal(sessionTesting.runtimeSessionFingerprint("anthropic"), a, "deterministic for a fixed value");

    // Unset → unchanged: falls through to the provider thread id.
    delete process.env.COORD_SESSION_ID;
    const none = sessionTesting.runtimeSessionFingerprint("anthropic");
    assert.match(none, /thread:conversation-shared-id/);
    assert.ok(!none.includes("coord-session:"));
  } finally {
    for (const [key, value] of Object.entries(snap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("resolveEffectiveThreadId: COORD_SESSION_ID overrides the harness provider thread id on the binding path (COORD-015)", () => {
  const snap = {
    COORD_SESSION_ID: process.env.COORD_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  try {
    process.env.CLAUDE_CODE_SESSION_ID = "conversation-shared-id";
    process.env.CLAUDE_SESSION_ID = "conversation-shared-id";
    delete process.env.AGENT_THREAD_ID;

    // The effective thread id (what claim/resume/agentid bind on) must be the
    // distinct override, not the shared conversation id.
    process.env.COORD_SESSION_ID = "subagent-A";
    assert.equal(sessionTesting.resolveEffectiveThreadId(), "subagent-A");
    process.env.COORD_SESSION_ID = "subagent-B";
    assert.equal(sessionTesting.resolveEffectiveThreadId(), "subagent-B");

    // Unset → falls back to the provider thread id exactly as before.
    delete process.env.COORD_SESSION_ID;
    assert.equal(sessionTesting.resolveEffectiveThreadId(), "conversation-shared-id");
  } finally {
    for (const [key, value] of Object.entries(snap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("buildContinuityAttribution records human sponsor and executing agent/session", () => {
  const snap = {
    COORD_SESSION_ID: process.env.COORD_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    GEMINI_THREAD_ID: process.env.GEMINI_THREAD_ID,
    GROK_THREAD_ID: process.env.GROK_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };
  try {
    process.env.CODEX_THREAD_ID = "provider-codex-thread-1";
    process.env.COORD_SESSION_ID = "coord-subagent-1";
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.GEMINI_THREAD_ID;
    delete process.env.GROK_THREAD_ID;
    delete process.env.AGENT_THREAD_ID;

    const attribution = sessionTesting.buildContinuityAttribution({
      identity: {
        agent: { handle: "codexa42", provider: "openai" },
        session: {
          handle: "codexa42",
          thread_id: "stored-thread",
          cwd: "/tmp/project/.worktrees/codexa42/COORD-339",
        },
      },
      human_id: "human-a",
      acting_for: "platform-team",
      team_id: "platform",
      project_id: "coord-template",
      ticket_id: "COORD-339",
    });

    assert.deepEqual(attribution, {
      human_id: "human-a",
      agent_handle: "codexa42",
      provider_session_id: "provider-codex-thread-1",
      coord_session_id: "coord-subagent-1",
      acting_for: "platform-team",
      team_id: "platform",
      project_id: "coord-template",
      source_worktree: "/tmp/project/.worktrees/codexa42/COORD-339",
      ticket_id: "COORD-339",
    });
  } finally {
    for (const [key, value] of Object.entries(snap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("buildContinuityAttribution keeps provider and coord sessions distinct for native sessions", () => {
  const snap = {
    COORD_SESSION_ID: process.env.COORD_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  try {
    delete process.env.COORD_SESSION_ID;
    process.env.CODEX_THREAD_ID = "codex-native-session";
    const attribution = sessionTesting.buildContinuityAttribution({
      agent: { handle: "codexa01", provider: "openai" },
      source_worktree: " /tmp/wt ",
    });
    assert.equal(attribution.provider_session_id, "codex-native-session");
    assert.equal(attribution.coord_session_id, "codex-native-session");
    assert.equal(attribution.agent_handle, "codexa01");
    assert.equal(attribution.source_worktree, "/tmp/wt");
    assert.equal(attribution.human_id, null);
  } finally {
    for (const [key, value] of Object.entries(snap)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("validateSharedAttribution refuses another human's private note as shared authority", () => {
  const privateNote = {
    artifact_type: "human_private_note",
    attribution: {
      human_id: "human-a",
      agent_handle: "codexa01",
      coord_session_id: "coord-session-a",
      project_id: "coord-template",
      ticket_id: "COORD-339",
    },
    source_refs: [{ path: "coord/product/CONTINUITY_PROFILE.md", section: "5.2" }],
    promoted_by: "reviewer",
    promoted_by_human_id: "human-b",
  };

  assert.equal(
    memoryClassification.validateSharedAttribution(privateNote, { human_id: "human-a" }).ok,
    true
  );
  assert.deepEqual(
    memoryClassification.validateSharedAttribution(privateNote, { human_id: "human-b" }).errors,
    ["human-private notes cannot be claimed as another human's shared authority"]
  );
  assert.equal(memoryClassification.validateSharedPromotion(privateNote).ok, false);
});

test("resolveEffectiveThreadId refuses to adopt a foreign active session when no stable env exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-provider-session-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a21", handle: "geminia21", provider: "google", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a21-test",
      agent_id: "a21",
      handle: "geminia21",
      board_path: state.BOARD_PATH,
      thread_id: "google-session-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDECODE: process.env.CLAUDECODE,
      GEMINI_AGENT: process.env.GEMINI_AGENT,
      GEMINI_THREAD_ID: process.env.GEMINI_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      TERM_SESSION_ID: process.env.TERM_SESSION_ID,
      TMUX_PANE: process.env.TMUX_PANE,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
      WT_SESSION: process.env.WT_SESSION,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      TAB_ID: process.env.TAB_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDECODE;
    process.env.GEMINI_AGENT = "1";
    delete process.env.GEMINI_THREAD_ID;
    delete process.env.AGENT_THREAD_ID;
    delete process.env.TERM_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.WEZTERM_PANE;
    delete process.env.WT_SESSION;
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.TAB_ID;

    try {
      // Previously this fell through a sticky-session fallback and returned "google-session-1",
      // silently adopting a claim this process never made. That fallback was removed — a
      // process with no runtime thread env, no scoped session-token file, and no legacy token
      // must be treated as unclaimed. Caller is expected to route to explicit claim/resume.
      assert.equal(sessionTesting.resolveEffectiveThreadId(), null);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("resolveEffectiveThreadId fails closed when multiple unstable provider sessions exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-provider-session-multi-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a21", handle: "geminia21", provider: "google", status: "active", aliases: [] },
    { id: "a22", handle: "geminia22", provider: "google", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a21-test",
      agent_id: "a21",
      handle: "geminia21",
      board_path: state.BOARD_PATH,
      thread_id: "google-session-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    {
      session_id: "a22-test",
      agent_id: "a22",
      handle: "geminia22",
      board_path: state.BOARD_PATH,
      thread_id: "google-session-2",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDECODE: process.env.CLAUDECODE,
      GEMINI_AGENT: process.env.GEMINI_AGENT,
      GEMINI_THREAD_ID: process.env.GEMINI_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      TERM_SESSION_ID: process.env.TERM_SESSION_ID,
      TMUX_PANE: process.env.TMUX_PANE,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
      WT_SESSION: process.env.WT_SESSION,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      TAB_ID: process.env.TAB_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDECODE;
    process.env.GEMINI_AGENT = "1";
    delete process.env.GEMINI_THREAD_ID;
    delete process.env.AGENT_THREAD_ID;
    delete process.env.TERM_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.WEZTERM_PANE;
    delete process.env.WT_SESSION;
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.TAB_ID;

    try {
      assert.equal(sessionTesting.resolveEffectiveThreadId(), null);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("ensureCurrentAgentIdentity can resolve without rewriting agent_sessions when touchSession is false", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-identity-no-touch-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-test",
      agent_id: "a04",
      handle: "codexa04",
      board_path: state.BOARD_PATH,
      thread_id: "codex-thread-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "codex-thread-1";
    delete process.env.AGENT_THREAD_ID;

    try {
      const before = fs.readFileSync(sessionsPath, "utf8");
      const identity = sessionTesting.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      const after = fs.readFileSync(sessionsPath, "utf8");
      assert.equal(identity.agent.handle, "codexa04");
      assert.equal(after, before);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("COORD-786 an active session cannot resolve to an unregistered agent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-unknown-agent-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  fs.writeFileSync(agentsPath, "[]\n");
  fs.writeFileSync(sessionsPath, JSON.stringify([{
    session_id: "missing-agent-session",
    agent_id: "a99",
    handle: "codexa99",
    board_path: state.BOARD_PATH,
    thread_id: "codex-missing-agent-thread",
    claimed_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    status: "active",
  }], null, 2));
  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };
    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "codex-missing-agent-thread";
    delete process.env.AGENT_THREAD_ID;
    try {
      assert.throws(() => sessionTesting.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false }),
        /points at unknown agent codexa99/);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("COORD-689: minting without a runtime anchor preserves recent auto-claimed siblings", () => {
  // COORD-010 removed the per-provider cap (the prior incarnation of this test
  // asserted refuse-to-mint). With COORD-011 anchoring the Claude Code
  // fingerprint via the claude-ancestor walk, the cap was redundant
  // defense-in-depth on procfs systems. On the auto-anchor-less path the mint
  // flow now reaps idle stubs (auto-claimed always, manual past 24h) and
  // proceeds — the foreign-adoption guard in resolveEffectiveThreadId and
  // explicit --owner on ticket-mutating claims remain the safety floor.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-noanchor-stubs-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const now = new Date().toISOString();

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [{ rows: [] }],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
    { id: "a13", handle: "claudea13", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a11-stub", agent_id: "a11", handle: "claudea11",
      board_path: boardPath, thread_id: "anthropic-prior-a",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: true,
    },
    {
      session_id: "a12-stub", agent_id: "a12", handle: "claudea12",
      board_path: boardPath, thread_id: "anthropic-prior-b",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: true,
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    RUNTIME_DIR: runtimeDir,
  }, () => {
    const original = {
      BOARD_PATH: state.BOARD_PATH,
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      RUNTIME_DIR: state.RUNTIME_DIR,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDECODE: process.env.CLAUDECODE,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      TERM_SESSION_ID: process.env.TERM_SESSION_ID,
      TMUX_PANE: process.env.TMUX_PANE,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
    };
    state.BOARD_PATH = boardPath;
    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    state.RUNTIME_DIR = runtimeDir;
    process.env.CLAUDECODE = "1";
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.AGENT_THREAD_ID;
    delete process.env.TERM_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.WEZTERM_PANE;

    try {
      withoutProcFs(() => {
        const threadId = sessionTesting.getOrCreateSessionToken("anthropic");
        assert.match(threadId, /^anthropic-/, "must mint a fresh anthropic thread id");

        const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
        const stillActive = after.filter((s) => s.status === "active");
        assert.equal(stillActive.length, 2,
          "COORD-689: minting an anchor must preserve recently active sibling sessions");
        const released = after.filter((s) => s.status === "released");
        assert.equal(released.length, 0, "recent siblings must not be released");
      });
    } finally {
      state.BOARD_PATH = original.BOARD_PATH;
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      state.RUNTIME_DIR = original.RUNTIME_DIR;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("getOrCreateSessionToken proceeds to mint even when N>1 manual claims with doing tickets exist (COORD-010 cap removal)", () => {
  // Cap-removal acceptance test (ticket scope #4 case 1). Pre-COORD-010 the
  // mint flow refused under this fixture, forcing operators of unpinned shells
  // to manually `gov agent-release` a foreign claim before /next would work.
  // Post-COORD-010 the mint proceeds unconditionally; the freshly-minted
  // thread_id only buys this thread a session anchor — it cannot adopt any
  // foreign doing/review ticket because resolveEffectiveThreadId still fails
  // closed on ambiguous identity and any ticket mutation still requires an
  // explicit --owner.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-noanchor-manual-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const boardPath = path.join(tempDir, "tasks.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const now = new Date().toISOString();

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({
    sections: [
      {
        rows: [
          { ID: "IMP-300", Status: "doing", Owner: "claudea11" },
          { ID: "IMP-301", Status: "doing", Owner: "claudea12" },
        ],
      },
    ],
  }, null, 2));
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a11", handle: "claudea11", provider: "anthropic", status: "active", aliases: [] },
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a11-manual", agent_id: "a11", handle: "claudea11",
      board_path: boardPath, thread_id: "thread-manual-a",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: false,
    },
    {
      session_id: "a12-manual", agent_id: "a12", handle: "claudea12",
      board_path: boardPath, thread_id: "thread-manual-b",
      claimed_at: now, last_seen_at: now, status: "active", auto_claimed: false,
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    BOARD_PATH: boardPath,
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
    RUNTIME_DIR: runtimeDir,
  }, () => {
    const original = {
      BOARD_PATH: state.BOARD_PATH,
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      RUNTIME_DIR: state.RUNTIME_DIR,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDECODE: process.env.CLAUDECODE,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      TERM_SESSION_ID: process.env.TERM_SESSION_ID,
      TMUX_PANE: process.env.TMUX_PANE,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
    };
    state.BOARD_PATH = boardPath;
    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    state.RUNTIME_DIR = runtimeDir;
    process.env.CLAUDECODE = "1";
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.AGENT_THREAD_ID;
    delete process.env.TERM_SESSION_ID;
    delete process.env.TMUX_PANE;
    delete process.env.WEZTERM_PANE;

    try {
      withoutProcFs(() => {
        const threadId = sessionTesting.getOrCreateSessionToken("anthropic");
        assert.match(threadId, /^anthropic-/, "must mint a fresh anthropic thread id");

        const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
        const stillActive = after.filter((s) => s.status === "active");
        assert.equal(stillActive.length, 2,
          "fresh manual claims with doing tickets must remain untouched after mint");
        const handles = stillActive.map((s) => s.handle).sort();
        assert.deepEqual(handles, ["claudea11", "claudea12"],
          "both fresh manual claims must survive — only the cap was lifted");
      });
    } finally {
      state.BOARD_PATH = original.BOARD_PATH;
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      state.RUNTIME_DIR = original.RUNTIME_DIR;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("assertTicketMutationOwnership validates without rewriting agent_sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-ownership-no-touch-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-test",
      agent_id: "a04",
      handle: "codexa04",
      board_path: state.BOARD_PATH,
      thread_id: "codex-thread-ownership",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "codex-thread-ownership";
    delete process.env.AGENT_THREAD_ID;

    try {
      const before = fs.readFileSync(sessionsPath, "utf8");
      const identity = sessionTesting.assertTicketMutationOwnership("IMP-999", { Owner: "codexa04" }, null);
      const after = fs.readFileSync(sessionsPath, "utf8");
      assert.equal(identity.agent.handle, "codexa04");
      assert.equal(after, before);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("ensureTicketMutationOwnership does not auto-hijack an active lock from another session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-no-hijack-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a12-current",
      agent_id: "a12",
      handle: "claudea12",
      board_path: state.BOARD_PATH,
      thread_id: "claude-thread-2",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const lock = {
    owner: "claudea12",
    session_id: "a12-other",
    ticket: "IMP-998",
    repo: repoRegistryOwner.repoNameForCode("F"),
    worktree: "/tmp/fake-worktree",
    branch: "agent/claudea12-imp-998",
  };
  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      // COORD-883: detection is fixture-owned, never inherited from the invoking shell.
      GEMINI_AGENT: process.env.GEMINI_AGENT,
      GROK_AGENT: process.env.GROK_AGENT,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.AGENT_THREAD_ID = "claude-thread-2";
    delete process.env.CODEX_THREAD_ID;
    delete process.env.GEMINI_AGENT;
    delete process.env.GROK_AGENT;

    try {
      assert.throws(
        () => sessionTesting.ensureTicketMutationOwnership("IMP-998", { Owner: "claudea12" }, lock, { owner: "claudea12" }),
        (error) => error instanceof GovernanceError && /Lock for IMP-998 is bound to session a12-other/i.test(error.message)
      );
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].session_id, "a12-current");
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("describeTicketMutationOwnershipIssue guides session mismatches toward resume and recover", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-session-mismatch-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a12", handle: "claudea12", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a12-current",
      agent_id: "a12",
      handle: "claudea12",
      board_path: state.BOARD_PATH,
      thread_id: "claude-thread-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      GEMINI_THREAD_ID: process.env.GEMINI_THREAD_ID,
      GROK_THREAD_ID: process.env.GROK_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    delete process.env.CODEX_THREAD_ID;
    process.env.CLAUDE_SESSION_ID = "claude-thread-1";
    delete process.env.GEMINI_THREAD_ID;
    delete process.env.GROK_THREAD_ID;
    delete process.env.AGENT_THREAD_ID;

    try {
      const issue = sessionTesting.describeTicketMutationOwnershipIssue(
        "IMP-245",
        { Owner: "claudea12" },
        { owner: "claudea12", session_id: "a12-oldsession" }
      );
      assert.equal(issue.code, "session_mismatch");
      assert.match(issue.message, /coord\/scripts\/gov resume IMP-245/);
      assert.deepEqual(issue.next_steps, [
        "coord/scripts/gov resume IMP-245",
        "coord/scripts/gov recover IMP-245",
      ]);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("describeTicketMutationOwnershipIssue includes the expected owner's active session in owner mismatch guidance", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-owner-mismatch-guidance-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a37", handle: "codexa37", provider: "openai", status: "active", aliases: [] },
    { id: "a47", handle: "codexa47", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a37-current",
      agent_id: "a37",
      handle: "codexa37",
      board_path: state.BOARD_PATH,
      thread_id: "codex-thread-current",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    {
      session_id: "a47-owner",
      agent_id: "a47",
      handle: "codexa47",
      board_path: state.BOARD_PATH,
      thread_id: "codex-thread-owner",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "codex-thread-current";
    delete process.env.AGENT_THREAD_ID;

    try {
      const issue = sessionTesting.describeTicketMutationOwnershipIssue("FE-132", {
        Owner: "codexa47",
      });
      assert.equal(issue.code, "owner_mismatch");
      assert.match(issue.message, /Recorded active session for codexa47: a47-owner/);
      assert.equal(issue.next_steps.includes("coord/scripts/gov claim --owner codexa47"), true);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("COORD-128 assertRegisteredBoundOwner: registered+bound owner mutates; unregistered/unbound is refused with remediation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-rbo-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a60", handle: "claudea60", provider: "anthropic", status: "active", aliases: [] },
    { id: "a61", handle: "claudea61", provider: "anthropic", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a60-current",
      agent_id: "a60",
      handle: "claudea60",
      board_path: state.BOARD_PATH,
      thread_id: "claude-thread-rbo",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      COORD_SESSION_ID: process.env.COORD_SESSION_ID,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.COORD_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "claude-thread-rbo";
    delete process.env.AGENT_THREAD_ID;

    try {
      // (a) registered + bound owner: proceeds, returns the acting identity.
      const okIdentity = sessionTesting.assertRegisteredBoundOwner("RBO-1", { Owner: "claudea60" }, null);
      assert.equal(okIdentity.agent.handle, "claudea60");

      // (b) registered-but-NOT-bound (different owner): refused, owner_mismatch.
      assert.throws(
        () => sessionTesting.assertRegisteredBoundOwner("RBO-2", { Owner: "claudea61" }, null),
        (error) => error instanceof GovernanceError &&
          /Ticket RBO-2 is owned by claudea61/i.test(error.message)
      );

      // (c) UNREGISTERED / no active session for this thread: refused with the
      // explicit-owner claim remediation, never assignment of a different handle.
      process.env.CLAUDE_SESSION_ID = "claude-thread-no-session";
      assert.throws(
        () => sessionTesting.assertRegisteredBoundOwner("RBO-3", { Owner: "claudea60" }, null),
        (error) => error instanceof GovernanceError &&
          /not a registered agent \/ not the bound owner of RBO-3/i.test(error.message) &&
          /gov claim --owner claudea60/.test(error.message) &&
          /gov agentid --assign/.test(error.message) === false
      );
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("assertTicketRepairOwnership validates explicit owner without rewriting agent_sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-repair-no-touch-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a04", handle: "codexa04", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a04-test",
      agent_id: "a04",
      handle: "codexa04",
      board_path: state.BOARD_PATH,
      thread_id: "codex-thread-repair",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "codex-thread-repair";
    delete process.env.AGENT_THREAD_ID;

    try {
      const before = fs.readFileSync(sessionsPath, "utf8");
      const identity = sessionTesting.assertTicketRepairOwnership("IMP-999", { Owner: "codexa04" }, { owner: "codexa04" });
      const after = fs.readFileSync(sessionsPath, "utf8");
      assert.equal(identity.agent.handle, "codexa04");
      assert.equal(after, before);
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("resolveOwnerIdentity can require the current claimed session for an explicit owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-governance-owner-session-"));
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(tempDir, "agent_sessions.json");
  const now = new Date().toISOString();
  fs.writeFileSync(agentsPath, JSON.stringify([
    { id: "a00", handle: "codexa00", provider: "openai", status: "active", aliases: [] },
  ], null, 2));
  fs.writeFileSync(sessionsPath, JSON.stringify([
    {
      session_id: "a00-other",
      agent_id: "a00",
      handle: "codexa00",
      board_path: state.BOARD_PATH,
      thread_id: "different-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  withScopedGovernanceTestContext({
    AGENTS_PATH: agentsPath,
    AGENT_SESSIONS_PATH: sessionsPath,
  }, () => {
    const original = {
      AGENTS_PATH: state.AGENTS_PATH,
      AGENT_SESSIONS_PATH: state.AGENT_SESSIONS_PATH,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    };

    state.AGENTS_PATH = agentsPath;
    state.AGENT_SESSIONS_PATH = sessionsPath;
    process.env.CODEX_THREAD_ID = "this-thread";
    delete process.env.AGENT_THREAD_ID;

    try {
      assert.throws(
        () => sessionTesting.resolveOwnerIdentity("codexa00", { requireCurrentSession: true }),
        (error) => error instanceof GovernanceError && /not bound to the current claimed session/i.test(error.message)
      );
    } finally {
      state.AGENTS_PATH = original.AGENTS_PATH;
      state.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
      for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test("GCV-1 Phase-6: writeLock is owner-authoritative under the v2 channel; legacy otherwise", () => {
  const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv1-lock-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv1-wt-"));
  const origLocks = state.LOCKS_DIR;
  state.LOCKS_DIR = locksDir;
  const saved = {
    p: process.env.COORD_PROVIDER,
    i: process.env.COORD_INSTANCE_ID,
  };
  try {
    // Channel ABSENT -> legacy lock: keeps a session_id field, no v2 tag.
    delete process.env.COORD_PROVIDER;
    delete process.env.COORD_INSTANCE_ID;
    gcvLockRecords.writeLock({
      ticketId: "X-900",
      owner: "claudea11",
      repoCode: "X",
      branch: "b",
      worktree: wt,
      now: "2026-05-19T00:00:00.000Z",
      repoName: "coord",
      session: null,
    });
    const legacy = JSON.parse(
      fs.readFileSync(path.join(locksDir, "X-900.lock"), "utf8")
    );
    assert.equal(legacy.owner, "claudea11");
    assert.equal("session_id" in legacy, true);
    assert.equal(legacy.identity_model, undefined);

    // Channel PRESENT -> owner-authoritative v2 lock: no authority
    // session_id even though the legacy field slot still serializes null,
    // tagged identity_model:"v2".
    process.env.COORD_PROVIDER = "claude-code";
    process.env.COORD_INSTANCE_ID = "uuid-int-1";
    gcvLockRecords.writeLock({
      ticketId: "X-901",
      owner: "claudea11",
      repoCode: "X",
      branch: "b",
      worktree: wt,
      now: "2026-05-19T00:00:00.000Z",
      repoName: "coord",
      session: null,
    });
    const v2 = JSON.parse(
      fs.readFileSync(path.join(locksDir, "X-901.lock"), "utf8")
    );
    assert.equal(v2.owner, "claudea11");
    assert.equal(v2.identity_model, "v2");
    assert.equal(v2.session_id, null);
    // Owner/ticket/workspace authority fields intact.
    assert.equal(v2.ticket, "X-901");
    assert.equal(v2.status, "doing");
  } finally {
    state.LOCKS_DIR = origLocks;
    fs.rmSync(locksDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    if (saved.p === undefined) delete process.env.COORD_PROVIDER;
    else process.env.COORD_PROVIDER = saved.p;
    if (saved.i === undefined) delete process.env.COORD_INSTANCE_ID;
    else process.env.COORD_INSTANCE_ID = saved.i;
  }
});

test("GCV-1 Phase-6: rebindTicketLock under v2 channel preserves owner-authority (no session_id downgrade)", () => {
  const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv1-rebind-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv1-rebind-wt-"));
  const origLocks = state.LOCKS_DIR;
  state.LOCKS_DIR = locksDir;
  const saved = {
    p: process.env.COORD_PROVIDER,
    i: process.env.COORD_INSTANCE_ID,
  };
  try {
    process.env.COORD_PROVIDER = "claude-code";
    process.env.COORD_INSTANCE_ID = "uuid-rb-1";
    gcvLockRecords.writeLock({
      ticketId: "X-902",
      owner: "claudea11",
      repoCode: "X",
      branch: "b",
      worktree: wt,
      now: "2026-05-19T00:00:00.000Z",
      repoName: "coord",
      session: null,
    });
    const lockPath = path.join(locksDir, "X-902.lock");
    const v2Lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(v2Lock.identity_model, "v2");
    assert.equal(v2Lock.session_id, null);

    // A rebind that ATTEMPTS to carry a legacy session_id must NOT
    // downgrade the v2 lock back to legacy authority.
    gcvLockRecords.rebindTicketLock(
      { ...v2Lock, path: lockPath },
      { handle: "claudea11", id: "a11" },
      { session_id: "should-not-appear-as-authority" }
    );
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(after.identity_model, "v2", "rebind must preserve identity_model:v2");
    assert.equal(after.session_id, null, "rebind under v2 must not write authority session_id");
    assert.equal(after.owner, "claudea11");
  } finally {
    state.LOCKS_DIR = origLocks;
    fs.rmSync(locksDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    if (saved.p === undefined) delete process.env.COORD_PROVIDER;
    else process.env.COORD_PROVIDER = saved.p;
    if (saved.i === undefined) delete process.env.COORD_INSTANCE_ID;
    else process.env.COORD_INSTANCE_ID = saved.i;
  }
});

// COORD-222: enforce "one governed writer per checkout/runtime". These unit
// tests exercise the detection primitive directly (deterministic clock +
// injected sessions) so the start/claim gates and the doctor surfacing all rest
// on a single, well-characterized freshness check that REUSES the existing
// heartbeat/idle model (no new freshness notion).
const COLOCATED_IDLE_MS = 4 * 60 * 60 * 1000;

function colocatedSession(overrides = {}) {
  return {
    session_id: "live-1",
    handle: "claudea11",
    thread_id: "thread-foreign",
    board_path: state.BOARD_PATH,
    status: "active",
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

test("COORD-222: a fresh foreign session co-located on the same runtime is detected", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "foreign-1", thread_id: "thread-foreign", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, true);
  assert.equal(result.foreign_sessions.length, 1);
  assert.equal(result.foreign_sessions[0].thread_id, "thread-foreign");
});

test("COORD-222: the caller's OWN session (same thread) is never a co-located conflict (resume/lone-safe)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "mine", thread_id: "thread-mine", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "same-thread session must not false-block the lone/resume case");
  assert.equal(result.foreign_sessions.length, 0);
});

test("COORD-222: a lone session (only the caller present) does not trip the gate", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "mine", thread_id: "thread-mine", last_seen_at: new Date(now).toISOString() }),
  ];
  // From the caller's own vantage there is no OTHER fresh session.
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: a STALE foreign session (heartbeat older than idle window) does NOT block", () => {
  const now = Date.now();
  const staleSeen = new Date(now - (COLOCATED_IDLE_MS + 60 * 1000)).toISOString();
  const sessions = [
    colocatedSession({ session_id: "old", thread_id: "thread-foreign", last_seen_at: staleSeen }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "stale sessions are ignored exactly as elsewhere");
});

test("COORD-222: a released/inactive foreign session does NOT block (only active liveness contends)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "released", thread_id: "thread-foreign", status: "released", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: a foreign session bound to a DIFFERENT runtime/board does NOT block", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "other-runtime", thread_id: "thread-foreign", board_path: "/some/other/coord/board/tasks.json", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "co-location is scoped to THIS runtime only");
});

test("COORD-222: a session with no parseable heartbeat is treated as not-fresh (does not block)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "no-hb", thread_id: "thread-foreign", last_seen_at: null, claimed_at: null }),
  ];
  const result = sessionTesting.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: the refusal message names the override and the topology doc", () => {
  const detection = {
    present: true,
    current_thread_id: "thread-mine",
    foreign_sessions: [{ session_id: "foreign-1", handle: "claudea11", thread_id: "thread-foreign" }],
  };
  const message = sessionTesting.buildColocatedForeignSessionMessage("start", detection);
  assert.match(message, /--allow-shared-worktree/);
  assert.match(message, /MULTI_AGENT_TOPOLOGIES\.md § "Concurrency contract"/);
  assert.match(message, /separate git worktree/i);
  assert.match(message, /foreign-1/);
});

test("COORD-893: the co-located refusal names agent-release for a stray session before the opt-out", () => {
  const detection = {
    present: true,
    current_thread_id: "thread-mine",
    foreign_sessions: [{ session_id: "stray-1", handle: "claudea11", thread_id: "thread-invented" }],
  };
  const message = sessionTesting.buildColocatedForeignSessionMessage("claim", detection);
  const release = message.indexOf("`coord/scripts/gov agent-release <session-id> --human-admin-override \"<reason>\"`");
  assert.ok(release > 0, message);
  assert.ok(release < message.indexOf("--allow-shared-worktree"), "the narrow recovery is offered first");
  assert.match(message, /stray that holds no work/);
});


test("identity references reject absent owners and allocate past mixed board sections", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(sessionTesting.parseAgentSimpleIdNumber(value), null);
  }
  assert.equal(sessionTesting.buildDefaultAgentHandle("openai", "a42"), "codexa42");
  assert.equal(sessionTesting.buildDefaultAgentHandle("unrecognized", "a42"), "agenta42");
  assert.equal(sessionTesting.ownerMatches(null, "codexa42"), false);
  assert.equal(sessionTesting.ownerMatches("codexa42", null), false);
  assert.equal(sessionTesting.normalizeBoardIdentityReferences(null), null);
  assert.equal(sessionTesting.normalizeBoardIdentityReferences("invalid"), "invalid");
  for (const args of [[null, "A", "B"], [{}, null, "B"], [{}, "A", null], [{}, "A", "A"]]) {
    assert.equal(sessionTesting.canOwnerHoldConcurrentDoing(...args), false);
  }
  assert.deepEqual(sessionTesting.collectReferencedAgentIdNumbers({
    agents: [], sessions: [], board: { sections: [{ title: "Notes" }, { rows: [{ Owner: "codexa42" }] }] },
  }), [42]);
});

function withSessionAuthorityFixture(fn, overrides = {}) {
  const io = require("./state-io.js");
  const context = require("./governance-context.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-authority-boundary-"));
  const state = { RUNTIME_DIR: path.join(dir, ".runtime"), BOARD_PATH: path.join(dir, "board.json"),
    AGENTS_PATH: path.join(dir, "agents.json"), AGENT_SESSIONS_PATH: path.join(dir, "sessions.json") };
  const boardHelpers = require("./governance-board-state.js")({ state });
  const subject = createGovernanceSession({ ...io, ...boardHelpers, state, GovernanceError,
    fail: context.defaultFail, withAgentStateLock: context.withAgentStateLock,
    COORD_DIR: dir, AGENT_SESSION_IDLE_MS: 3600000, SESSION_FINGERPRINT_ENV_VARS: [],
    identityV2: require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js")), compareSessionsMostRecentFirst, ...overrides });
  fs.writeFileSync(state.AGENTS_PATH, JSON.stringify([
    { id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] },
    { id: "a43", handle: "codexa43", provider: "openai", status: "disabled", aliases: [] },
  ]));
  try { return fn({ subject, state, dir }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("session initialization creates the default registry when neither runtime nor legacy registry exists", () => {
  withSessionAuthorityFixture(({ subject, state }) => {
    fs.rmSync(state.AGENTS_PATH, { force: true });
    assert.equal(fs.existsSync(state.AGENTS_PATH), false);
    assert.equal(fs.existsSync(state.AGENT_SESSIONS_PATH), false);

    subject.ensureAgentFiles();

    const agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
    assert.deepEqual(agents.map(({ id, handle, provider }) => [id, handle, provider]), [
      ["a00", "codexa00", "openai"],
      ["a01", "codexa01", "openai"],
      ["a02", "codexa02", "openai"],
      ["a03", "codexa03", "openai"],
      ["a04", "codexa04", "openai"],
      ["a11", "claudea11", "anthropic"],
      ["a12", "claudea12", "anthropic"],
      ["a13", "claudea13", "anthropic"],
      ["a21", "geminia21", "google"],
      ["a22", "geminia22", "google"],
      ["a23", "geminia23", "google"],
      ["a31", "groka31", "xai"],
      ["a32", "groka32", "xai"],
      ["a33", "groka33", "xai"],
    ]);
    assert.ok(agents.every((agent) => agent.status === "active" && Array.isArray(agent.aliases)));
    assert.deepEqual(JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8")), []);
  });
});

test("COORD-638 start owner preflight is read-only and requires an already-held v2 lease", () => {
  const names = ["COORD_PROVIDER", "COORD_PROVIDER_SESSION_ID", "COORD_INSTANCE_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.CLAUDECODE;
    delete process.env.GEMINI_AGENT;
    delete process.env.GROK_AGENT;
    process.env.COORD_PROVIDER = "openai";
    delete process.env.COORD_PROVIDER_SESSION_ID;
    process.env.COORD_INSTANCE_ID = "start-preflight-current";
    withSessionAuthorityFixture(({ subject, state }) => {
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, "[]\n");
      const sessionsBefore = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      assert.throws(
        () => subject.resolveOwnerIdentity("a42", { requireHeldOwnerLease: true }),
        /does not already hold.*Start refused before lifecycle state changes; run `coord\/scripts\/gov claim --owner codexa42`/
      );
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), sessionsBefore);
      assert.equal(fs.existsSync(identityV2.registryPath(state.RUNTIME_DIR)), false);

      const foreign = { ...identityV2.readEnvIdentity(), instanceId: "start-preflight-foreign" };
      const foreignReg = identityV2.registerAndAcquire(identityV2.emptyRegistry(), foreign, "codexa42").registry;
      identityV2.writeRegistry(state.RUNTIME_DIR, foreignReg);
      const registryBefore = fs.readFileSync(identityV2.registryPath(state.RUNTIME_DIR), "utf8");
      assert.throws(
        () => subject.resolveOwnerIdentity("a42", { requireHeldOwnerLease: true }),
        /live instance.*claim --owner codexa42.*--handoff/s
      );
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), sessionsBefore);
      assert.equal(fs.readFileSync(identityV2.registryPath(state.RUNTIME_DIR), "utf8"), registryBefore);

      const current = identityV2.readEnvIdentity();
      const heldReg = identityV2.registerAndAcquire(identityV2.emptyRegistry(), current, "codexa42").registry;
      identityV2.writeRegistry(state.RUNTIME_DIR, heldReg);
      const identity = subject.resolveOwnerIdentity("a42", { requireHeldOwnerLease: true });
      assert.equal(identity.agent.handle, "codexa42");
      assert.equal(identity.session, null);
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), sessionsBefore);
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("session authority initializes missing state and only touches an exact active binding", () => {
  withSessionAuthorityFixture(({ subject, state }) => {
    assert.deepEqual(subject.readAgentSessions(), []);
    assert.equal(subject.isRegisteredAgentHandle("a42"), true);
    assert.equal(subject.isRegisteredAgentHandle("missing"), false);
    assert.throws(() => subject.canonicalizeOwnerOrFail("a43"), /disabled agent/);
    assert.equal(subject.canonicalizeOwnerOrFail("a43", { requireActive: false }), "codexa43");
    const board = {};
    assert.equal(subject.normalizeBoardIdentityReferences(board), board);
    assert.deepEqual(board.waiver_index, {});
    const sessions = [{ session_id: "fixture-session", agent_id: "a42", handle: "codexa42",
      status: "active", board_path: state.BOARD_PATH, thread_id: "fixture-thread",
      claimed_at: new Date(Date.now() - 60000).toISOString(), last_seen_at: new Date(Date.now() - 60000).toISOString() }];
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(sessions));
    const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
    subject.touchActiveSession(null, "fixture-session");
    subject.touchActiveSession("codexa42", null);
    subject.touchActiveSession("codexa43", "fixture-session");
    assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
    subject.touchActiveSession("codexa42", "fixture-session");
    const after = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH));
    assert.ok(Date.parse(after[0].last_seen_at) > Date.parse(sessions[0].last_seen_at));
    after[0].last_seen_at = sessions[0].last_seen_at;
    assert.deepEqual(after, sessions);
  });
});


test("legacy session tokens migrate once and scoped reads preserve their identity", () => {
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "AGENT_THREAD_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.CLAUDECODE = "1";
    withSessionAuthorityFixture(({ subject, state }) => {
      const token = { thread_id: "legacy-thread", created_at: new Date().toISOString() };
      const legacy = subject.sessionTokenPath("anthropic", { legacy: true });
      fs.writeFileSync(legacy, JSON.stringify(token));
      assert.equal(subject.resolveEffectiveThreadId(), token.thread_id);
      assert.equal(subject.getOrCreateSessionToken("anthropic"), token.thread_id);
      assert.equal(fs.existsSync(legacy), false);
      const scoped = subject.sessionTokenPath("anthropic");
      const before = fs.readFileSync(scoped, "utf8");
      assert.deepEqual(JSON.parse(before), token);
      assert.equal(subject.resolveEffectiveThreadId(), token.thread_id);
      assert.equal(subject.getOrCreateSessionToken("anthropic"), token.thread_id);
      assert.equal(fs.readFileSync(scoped, "utf8"), before);
      assert.equal(subject.resolveOrCreateEffectiveThreadId(), token.thread_id);
      assert.equal(fs.readFileSync(scoped, "utf8"), before);
      withoutProcFs(() => {
        process.env.AGENT_THREAD_ID = "explicit-fallback";
        assert.match(subject.sessionTokenPath("unknown"), /unknown-[a-f0-9]{12}\.json$/);
        delete process.env.AGENT_THREAD_ID;
      });
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});


test("session authority refuses lock and foreign repair mismatches without altering bindings", () => {
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.COORD_SESSION_ID;
    delete process.env.COORD_PROVIDER;
    delete process.env.COORD_INSTANCE_ID;
    process.env.CODEX_THREAD_ID = "authority-boundary-thread";
    withSessionAuthorityFixture(({ subject, state }) => {
      const now = new Date().toISOString();
      const agent = { id: "a44", handle: "codexa44", provider: "openai", status: "active", aliases: [] };
      const agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH));
      fs.writeFileSync(state.AGENTS_PATH, JSON.stringify([...agents, agent]));
      const binding = { session_id: "active-boundary", agent_id: "a42", handle: "codexa42",
        status: "active", board_path: state.BOARD_PATH, thread_id: process.env.CODEX_THREAD_ID,
        claimed_at: now, last_seen_at: now };
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([binding]));
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      const mismatch = subject.describeTicketMutationOwnershipIssue("TEST-1", { Owner: "codexa42" }, { owner: "codexa44" });
      assert.equal(mismatch.code, "lock_owner_mismatch");
      assert.match(mismatch.message, /recover TEST-1/);
      assert.throws(() => subject.assertTicketRepairOwnership("TEST-2", { Owner: "codexa44" }), /cannot repair it/);
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
      process.env.COORD_PROVIDER = "openai";
      process.env.COORD_INSTANCE_ID = "missing-instance";
      const leased = subject.describeTicketMutationOwnershipIssue("TEST-1", { Owner: "codexa42" });
      assert.equal(leased.code, "ok");
      const registry = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/identity-v2.js")).readRegistry(state.RUNTIME_DIR);
      assert.equal(registry.leases.codexa42.instance_id, "missing-instance");
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("session normalization fails closed when its source disappears before the locked reread", () => {
  const io = require("./state-io.js");
  let raced = false;
  withSessionAuthorityFixture(({ subject, state }) => {
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([{ session_id: "stale", status: "active",
      last_seen_at: "2000-01-01T00:00:00.000Z", claimed_at: "2000-01-01T00:00:00.000Z" }]));
    assert.throws(() => subject.readAgentSessions(), /missing|not found/i);
    assert.equal(raced, true);
    assert.equal(fs.existsSync(state.AGENT_SESSIONS_PATH), false, "normalization must not recreate raced-away state");
  }, { readJsonFileState(file) {
    // Only the locked reread crosses this injected IO boundary; initial parsing
    // still uses the real production reader and the competing deletion is real.
    fs.unlinkSync(file);
    raced = true;
    return io.readJsonFileState(file);
  } });
});


test("terminal session continuation appends history while unsupported expired repair remains refused", () => {
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.CODEX_THREAD_ID = "continuation-boundary-thread";
    withSessionAuthorityFixture(({ subject, state }) => {
      const now = new Date().toISOString();
      const prior = { session_id: "terminal-interval", agent_id: "a42", handle: "codexa42",
        status: "released", release_reason: "terminal", board_path: state.BOARD_PATH,
        thread_id: process.env.CODEX_THREAD_ID, claimed_at: now, last_seen_at: now, released_at: now };
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([prior]));
      state.activeGovernanceMutationContext = { metadata: {} };
      const identity = subject.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      assert.equal(identity.continuedFromSession, prior.session_id);
      const history = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH));
      assert.equal(history.length, 2);
      assert.deepEqual(history[0], prior);
      assert.equal(history[1].previous_session_id, prior.session_id);
      assert.equal(history[1].status, "active");
      delete state.activeGovernanceMutationContext;
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([{ ...prior, status: "expired" }]));
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      assert.throws(() => subject.assertTicketRepairOwnership("TEST-3", { Owner: "codexa42" }, { owner: "codexa42" }),
        error => error.code === "NO_ACTIVE_SESSION");
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before,
        "absent recovery lock must not adopt the expired session");
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("COORD-592 missing-session refusal distinguishes explicit release, expiry, and no binding history", () => {
  withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
    const threadId = process.env.CODEX_THREAD_ID;
    const now = new Date().toISOString();
    const base = { session_id: "prior-session", agent_id: "a42", handle: "codexa42",
      board_path: state.BOARD_PATH, thread_id: threadId, claimed_at: now, last_seen_at: now };
    const assertRefusal = (history, pattern) => {
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(history));
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      state.activeGovernanceMutationContext = { metadata: {} };
      try {
        assert.throws(() => subject.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false }), error => {
          assert.equal(error.code, "NO_ACTIVE_SESSION");
          assert.match(error.message, pattern);
          return true;
        });
        assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before, "diagnostics must not rewrite session history");
      } finally { delete state.activeGovernanceMutationContext; }
    };

    assertRefusal([{ ...base, status: "released", release_reason: "explicit", released_at: now }],
      /explicitly released.*claim --owner <handle\|simple-id>|claim --owner <handle\|simple-id>.*explicitly released/i);
    assertRefusal([{ ...base, status: "expired", release_reason: "idle-expiry", released_at: now }],
      /expired.*idle|idle.*expired/i);
    assertRefusal([{ ...base, status: "expired", release_reason: "manual-repair", released_at: now }],
      /expired.*recorded reason: manual-repair/i);
    assertRefusal([{ ...base, status: "expired", released_at: now }],
      /expired.*release reason unknown/i);
    assertRefusal([], /no prior binding.*agentid --owner|agentid --owner.*no prior binding/i);
    assertRefusal([{ ...base, board_path: "/another/board/tasks.json" }],
      /no prior binding.*agentid --owner|agentid --owner.*no prior binding/i);
    assertRefusal([{ ...base, thread_id: "another-thread", status: "released", release_reason: "explicit" }],
      /no prior binding.*agentid --owner|agentid --owner.*no prior binding/i);
    assertRefusal([
      { ...base, session_id: "older-explicit", status: "released", release_reason: "explicit", claimed_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-01-01T00:00:00.000Z", released_at: "2026-01-01T00:00:00.000Z" },
      { ...base, session_id: "newer-explicit", status: "released", release_reason: "explicit", claimed_at: now, last_seen_at: now, released_at: now },
      { ...base, session_id: "foreign-newest", thread_id: "foreign-thread", status: "released", release_reason: "explicit", claimed_at: "2026-03-01T00:00:00.000Z", last_seen_at: "2026-03-01T00:00:00.000Z", released_at: "2026-03-01T00:00:00.000Z" },
    ], /newer-explicit.*explicitly released/i);
    assertRefusal([{ ...base, handle: "unassigned", status: "released", release_reason: "explicit", released_at: now }],
      /explicitly released.*claim --owner <handle\|simple-id>/i);
    assertRefusal([{ ...base, status: "expired", release_reason: "terminal", released_at: now }],
      /expired.*recorded reason: terminal.*agentid --owner/i);
  }));
});


test("a registered handle colliding with the unassigned sentinel receives a generic binding hint", () => {
  const names = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.CODEX_THREAD_ID = "unbound-sentinel-thread";
    withSessionAuthorityFixture(({ subject, state }) => {
      // Agent registration currently accepts arbitrary handles, including this
      // board sentinel. Reading such legacy state must not suggest binding to it.
      fs.writeFileSync(state.AGENTS_PATH, JSON.stringify([
        { id: "a45", handle: "unassigned", provider: "openai", status: "active", aliases: [] },
      ]));
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, "[]");
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      const issue = subject.describeTicketMutationOwnershipIssue("TEST-4", { Owner: "unassigned" });
      assert.equal(issue.code, "no_active_session");
      assert.match(issue.message, /gov claim --owner <handle>/);
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// These exercise recovery-session.js through the real governance-session authority
// and file IO. `withSessionAuthorityFixture` is the existing fixture above.
function withRecoveryThread(fn, threadId = "recovery-session-thread") {
  const keys = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
    "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "COORD_PROVIDER", "COORD_INSTANCE_ID", "CLAUDECODE",
    "GEMINI_AGENT", "GROK_AGENT"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.CODEX_THREAD_ID = threadId;
    return fn();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

// COORD-880/883: these fixtures register openai agents, so their detection env
// must not inherit an ambient CLAUDECODE, GEMINI_AGENT or GROK_AGENT from the
// invoking shell; a test that wants a provider detected sets its flag itself.
const RUNTIME_DETECTION_FLAGS = ["CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
function withoutAmbientClaudeDetection(fn) {
  const before = Object.fromEntries(RUNTIME_DETECTION_FLAGS.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_DETECTION_FLAGS) delete process.env[name];
  try { return fn(); } finally {
    for (const [name, value] of Object.entries(before)) if (value !== undefined) process.env[name] = value;
  }
}

function expiredRecoveryFixture(state, overrides = {}) {
  const now = new Date().toISOString();
  const prior = { session_id: "expired-a42", agent_id: "a42", handle: "codexa42",
    status: "expired", board_path: state.BOARD_PATH, thread_id: "prior-thread",
    claimed_at: "2000-01-01T00:00:00.000Z", last_seen_at: "2000-01-01T00:00:00.000Z",
    released_at: now, ...(overrides.prior || {}) };
  const lock = { ticket: "TEST-RECOVERY", owner: "codexa42", agent_id: "a42", session_id: prior.session_id,
    status: "doing", repo: "repo-fixture", branch: "agent/codexa42-test-recovery",
    head: "0123456789abcdef0123456789abcdef01234567", worktree: "/tmp/test-recovery-worktree",
    started_at_utc: now, ...(overrides.lock || {}) };
  const sessions = overrides.sessions || [prior];
  fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(sessions));
  return { prior, lock, sessions };
}

test("expired v1 recovery adopts only the matching owner session and persists one continuation", () => {
  const repo = createTempGitRepo("recovery-session-workspace-", { "README.md": "recovery fixture\n" });
  try {
    withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
      const { prior, lock, sessions } = expiredRecoveryFixture(state);
      lock.repo = "B";
      lock.branch = "dev";
      lock.head = repo.head;
      lock.worktree = repo.repoRoot;
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      const identity = subject.assertTicketRepairOwnership("TEST-RECOVERY", { Owner: "codexa42" },
        { owner: "codexa42" }, { lock, verifyWorkspace() {
          assert.equal(runGit(repo.repoRoot, ["rev-parse", "HEAD"]), lock.head);
          assert.equal(runGit(repo.repoRoot, ["branch", "--show-current"]), lock.branch);
          assert.equal(fs.realpathSync(repo.repoRoot), lock.worktree);
        } });
      const after = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"));
      assert.equal(identity.agent.handle, "codexa42");
      assert.equal(identity.recoveredFromSession, prior.session_id);
      assert.equal(after.length, sessions.length + 1);
      assert.deepEqual(after[0], prior);
      assert.equal(after[1].previous_session_id, prior.session_id);
      assert.equal(after[1].thread_id, process.env.CODEX_THREAD_ID);
      assert.equal(after[1].status, "active");
      assert.notEqual(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
    }));
  } finally {
    fs.rmSync(repo.repoRoot, { recursive: true, force: true });
  }
});

test("expired recovery refuses mismatched authority and workspace failures without rewriting bindings", () => {
  const cases = [
    { name: "no explicit requested owner", options: {} },
    { name: "wrong ticket", lock: { ticket: "TEST-OTHER" } },
    { name: "wrong lock owner", lock: { owner: "codexa43" } },
    { name: "non-doing lock", lock: { status: "review" } },
    { name: "v2 lock", lock: { identity_model: "v2" } },
    { name: "incomplete lock", lock: { worktree: " " } },
    { name: "wrong prior state", prior: { status: "released" } },
    { name: "wrong prior handle", prior: { handle: "codexa43" } },
    { name: "wrong prior agent id", prior: { agent_id: "a43" } },
    { name: "wrong prior board", prior: { board_path: "/different/board/tasks.json" } },
    { name: "duplicate prior id", duplicatePrior: true },
    { name: "another active owner session", activeOwner: true },
    { name: "disabled registered owner", disableOwner: true, expectedMessage: /disabled agent/ },
    { name: "missing registered owner", missingOwner: true, expectedMessage: /not a registered agent/ },
    { name: "workspace verification throws", workspaceThrows: true },
  ];
  for (const scenario of cases) {
    withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
      const { prior, lock } = expiredRecoveryFixture(state, {
        prior: scenario.prior,
        lock: scenario.lock,
      });
      let sessions = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"));
      if (scenario.duplicatePrior) sessions.push({ ...prior });
      if (scenario.activeOwner) sessions.push({ session_id: "active-a42", agent_id: "a42", handle: "codexa42",
        status: "active", board_path: state.BOARD_PATH, thread_id: "other-active-thread" });
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(sessions));
      if (scenario.disableOwner || scenario.missingOwner) {
        let agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
        agents = scenario.missingOwner ? agents.filter((agent) => agent.handle !== "codexa42") : agents;
        if (scenario.disableOwner) agents[0].status = "disabled";
        fs.writeFileSync(state.AGENTS_PATH, JSON.stringify(agents));
      }
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      let verified = 0;
      const verifyWorkspace = () => {
        verified += 1;
        if (scenario.workspaceThrows) throw new Error("workspace mismatch");
      };
      assert.throws(() => subject.assertTicketRepairOwnership("TEST-RECOVERY", { Owner: "codexa42" },
        scenario.options || { owner: "codexa42" }, { lock, verifyWorkspace }), error => {
        if (scenario.workspaceThrows) return error.message === "workspace mismatch";
        if (scenario.expectedMessage) return scenario.expectedMessage.test(error.message);
        return error.code === "NO_ACTIVE_SESSION";
      }, scenario.name);
      assert.equal(verified, scenario.workspaceThrows ? 1 : 0, scenario.name);
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before, scenario.name);
    }), `recovery-${scenario.name.replace(/[^a-z0-9]+/gi, "-")}`);
  }
});

test("expired same-thread session continuation requires a non-explicit idle history and no active collision", () => {
  const refuseCases = [
    { name: "explicit release", prior: { status: "released", release_reason: "explicit" } },
    { name: "recent expiry", prior: { status: "expired", last_seen_at: new Date().toISOString() } },
    { name: "different requested handle", requestedHandle: "codexa43" },
    { name: "duplicate session id", duplicatePrior: true },
    { name: "active same owner elsewhere", activeCollision: true },
  ];
  withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
    const prior = { session_id: "idle-a42", agent_id: "a42", handle: "codexa42", status: "expired",
      board_path: state.BOARD_PATH, thread_id: process.env.CODEX_THREAD_ID,
      claimed_at: "2000-01-01T00:00:00.000Z", last_seen_at: "2000-01-01T00:00:00.000Z" };
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([prior]));
    state.activeGovernanceMutationContext = { metadata: {} };
    const identity = subject.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    const continued = JSON.parse(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"));
    assert.equal(identity.continuedFromSession, prior.session_id);
    assert.equal(continued.length, 2);
    assert.deepEqual(continued[0], prior);
    assert.equal(continued[1].previous_session_id, prior.session_id);
    delete state.activeGovernanceMutationContext;

    for (const scenario of refuseCases) {
      const candidate = { ...prior, ...(scenario.prior || {}) };
      let history = [candidate];
      if (scenario.duplicatePrior) history.push({ ...candidate });
      if (scenario.activeCollision) history.push({ session_id: "active-other", agent_id: "a42", handle: "codexa42",
        status: "active", board_path: state.BOARD_PATH, thread_id: "foreign-thread" });
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify(history));
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      state.activeGovernanceMutationContext = { metadata: {} };
      if (scenario.requestedHandle) {
        const agents = JSON.parse(fs.readFileSync(state.AGENTS_PATH, "utf8"));
        agents[1].status = "active";
        fs.writeFileSync(state.AGENTS_PATH, JSON.stringify(agents));
        assert.throws(() => subject.resolveOwnerIdentity(scenario.requestedHandle,
          { requireCurrentSession: true, touchSession: false }), error => error.code === "NO_ACTIVE_SESSION", scenario.name);
      } else {
        assert.throws(() => subject.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false }),
          error => error.code === "NO_ACTIVE_SESSION", scenario.name);
      }
      delete state.activeGovernanceMutationContext;
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before, scenario.name);
    }
  }));
});


test("provider-session filtering, alias ID references, and automatic identity failure use real configured inputs", () => {
  withSessionAuthorityFixture(({ subject, state }) => {
    const referenced = subject.collectReferencedAgentIdNumbers({ agents: [
      { id: "a46", handle: "codexa46", aliases: ["codexa68"] },
    ], sessions: [], board: null });
    assert.deepEqual(referenced, [46, 68]);

    const active = subject.findActiveProviderSessions("openai", [
      { session_id: "openai-live", handle: "codexa42", status: "active", board_path: state.BOARD_PATH },
      { session_id: "wrong-board", handle: "codexa42", status: "active", board_path: "/elsewhere/tasks.json" },
    ], [{ id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] }]);
    assert.deepEqual(active.map((session) => session.session_id), ["openai-live"]);
  });

  withRecoveryThread(() => {
    const saved = process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_THREAD_ID;
    try {
      withSessionAuthorityFixture(({ subject }) => {
        assert.throws(() => subject.ensureCurrentAgentIdentity({ allowAutoClaim: true }),
          /No stable runtime thread id is available for automatic agent assignment/);
      });
    } finally {
      process.env.CODEX_THREAD_ID = saved;
    }
  });
});

test("repair ownership propagates malformed on-disk session data without entering recovery", () => {
  withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, "{ malformed sessions");
    const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
    assert.throws(() => subject.assertTicketRepairOwnership("TEST-IO", { Owner: "codexa42" }),
      error => /JSON|parse|array|agent sessions/i.test(error.message));
    assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
  }));
});

test("recovery helper rejects each invalid snapshot before workspace verification or session writes (unit contract)", () => {
  const recovery = require("./recovery-session.js");
  withoutAmbientClaudeDetection(() => withSessionAuthorityFixture(({ subject }) => {
  const makeInput = () => {
    const boardPath = "/tmp/recovery-helper-board/tasks.json";
    const prior = { session_id: "expired-a42", agent_id: "a42", handle: "codexa42", status: "expired",
      board_path: boardPath, thread_id: "old-thread" };
    return {
      error: Object.assign(new GovernanceError("no active session"), { code: "NO_ACTIVE_SESSION" }),
      ticketId: "TEST-HELPER", expectedOwner: "codexa42", requestedOwner: "codexa42",
      lock: { ticket: "TEST-HELPER", owner: "codexa42", agent_id: "a42", session_id: prior.session_id,
        status: "doing", repo: "B", branch: "agent/codexa42-test-helper", head: "0123456789abcdef0123456789abcdef01234567",
        worktree: "/tmp/test-helper-worktree", started_at_utc: new Date().toISOString() },
      agents: [{ id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] }],
      sessions: [prior], threadId: "new-thread", boardPath,
      assertProvider: subject.assertRuntimeProviderMatchesAgent,
      completeLock: subject.isCompleteLockPayload,
      buildSessionId: subject.buildSessionId,
      verifyWorkspace() { this.verified = (this.verified || 0) + 1; },
      writeSessions(next) { this.writes = (this.writes || 0) + 1; this.persisted = next; },
    };
  };
  const invalidCases = [
    ["missing thread", d => { d.threadId = null; }],
    ["requested owner mismatch", d => { d.requestedOwner = "codexa43"; }],
    ["incomplete lock", d => { d.lock.worktree = " "; }],
    ["wrong lock ticket", d => { d.lock.ticket = "TEST-OTHER"; }],
    ["wrong lock owner", d => { d.lock.owner = "codexa43"; }],
    ["wrong lock status", d => { d.lock.status = "review"; }],
    ["v2 lock", d => { d.lock.identity_model = "v2"; }],
    ["missing owner record", d => { d.agents = []; }],
    ["ambiguous owner records", d => { d.agents.push({ ...d.agents[0] }); }],
    ["disabled owner", d => { d.agents[0].status = "disabled"; }],
    ["owner id mismatch", d => { d.agents[0].id = "a43"; }],
    ["missing prior session", d => { d.sessions = []; }],
    ["duplicate prior session", d => { d.sessions.push({ ...d.sessions[0] }); }],
    ["prior is not expired", d => { d.sessions[0].status = "released"; }],
    ["prior handle mismatch", d => { d.sessions[0].handle = "codexa43"; }],
    ["prior agent id mismatch", d => { d.sessions[0].agent_id = "a43"; }],
    ["prior board mismatch", d => { d.sessions[0].board_path = "/other/tasks.json"; }],
    ["active session conflicts by owner", d => { d.sessions.push({ status: "active", handle: "codexa42", board_path: d.boardPath, thread_id: "elsewhere" }); }],
    ["active session conflicts by thread", d => { d.sessions.push({ status: "active", handle: "codexa43", board_path: d.boardPath, thread_id: d.threadId }); }],
    ["workspace callback missing", d => { delete d.verifyWorkspace; }],
  ];
  for (const [name, mutate] of invalidCases) {
    const d = makeInput();
    mutate(d);
    const before = JSON.stringify(d.sessions);
    assert.throws(() => recovery.adoptRecoverySession(d), error => error === d.error, name);
    assert.equal(d.writes || 0, 0, name);
    assert.equal(d.verified || 0, 0, name);
    assert.equal(JSON.stringify(d.sessions), before, name);
  }

  // Provider validation remains the real governance-session validator; this unit
  // boundary checks the helper's propagation before any write, not CLI authority.
  withRecoveryThread(() => {
    const d = makeInput();
    d.agents[0].provider = "anthropic";
    assert.throws(() => recovery.adoptRecoverySession(d), /Runtime provider openai cannot claim/);
    assert.equal(d.writes || 0, 0);
  });
  }));
});

test("recovery helper preserves both documented host fallback outcomes (unit contract)", () => {
  const recovery = require("./recovery-session.js");
  withoutAmbientClaudeDetection(() => withSessionAuthorityFixture(({ subject }) => {
  for (const [priorHost, expected] of [["prior-host", "prior-host"], [undefined, "unknown-host"]]) {
    const boardPath = "/tmp/recovery-helper-board/tasks.json";
    const prior = { session_id: "expired-a42", agent_id: "a42", handle: "codexa42", status: "expired",
      board_path: boardPath, thread_id: "old-thread", ...(priorHost ? { host: priorHost } : {}) };
    const sessions = [prior];
    const d = { error: new GovernanceError("no active session"), ticketId: "TEST-HELPER", expectedOwner: "codexa42",
      requestedOwner: "codexa42", lock: { ticket: "TEST-HELPER", owner: "codexa42", agent_id: "a42",
        session_id: prior.session_id, status: "doing", repo: "B", branch: "agent/codexa42-test-helper",
        head: "0123456789abcdef0123456789abcdef01234567", worktree: "/tmp/test-helper-worktree",
        started_at_utc: new Date().toISOString() },
      agents: [{ id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] }],
      sessions, threadId: "new-thread", boardPath, assertProvider: subject.assertRuntimeProviderMatchesAgent,
      completeLock: subject.isCompleteLockPayload, buildSessionId: subject.buildSessionId,
      verifyWorkspace() {}, writeSessions() {} };
    const result = recovery.adoptRecoverySession(d);
    assert.equal(result.session.host, expected);
  }
  }));
});

test("continuation helper checks duplicate history, timestamp fallback, owner eligibility, and active collisions (unit contract)", () => {
  const continuation = require("./recovery-session.js").continueReleasedSession;
  withoutAmbientClaudeDetection(() => withSessionAuthorityFixture(({ subject }) => {
    const makeInput = (overrides = {}) => {
      const boardPath = "/tmp/continuation-helper-board/tasks.json";
      const prior = { session_id: "expired-a42", agent_id: "a42", handle: "codexa42", status: "expired",
        board_path: boardPath, thread_id: "current-thread", claimed_at: "2000-01-01T00:00:00.000Z", binding_sequence: 2 };
      const sessions = [prior];
      const input = { inMutation: true, nativeThreadId: "current-thread", threadId: "current-thread",
        requestedHandle: null, agents: [{ id: "a42", handle: "codexa42", provider: "openai", status: "active" }],
        sessions, boardPath, idleMs: 3600000, assertProvider(agent) { this.providerChecks = (this.providerChecks || 0) + 1; subject.assertRuntimeProviderMatchesAgent(agent); },
        buildSessionId: subject.buildSessionId, host: "fixture-host", writeSessions(next) { this.writes = (this.writes || 0) + 1; this.saved = next; },
        ...overrides };
      return { input, prior, sessions };
    };

    // Public read normalization removes duplicate session ids before the helper;
    // pin this low-level defensive contract with the helper's explicit snapshot.
    {
      const { input, sessions } = makeInput();
      sessions.push({ ...sessions[0], binding_sequence: 3 });
      const before = JSON.stringify(sessions);
      assert.equal(continuation(input), null);
      assert.equal(input.writes || 0, 0);
      assert.equal(JSON.stringify(sessions), before);
    }

    // last_seen_at is legitimately absent in legacy intervals; claimed_at supplies
    // the age basis and the expired interval can continue after the idle threshold.
    {
      const { input, prior, sessions } = makeInput();
      const before = { ...prior };
      const result = continuation(input);
      assert.equal(result.continuedFromSession, prior.session_id);
      assert.equal(result.session.host, "fixture-host");
      assert.equal(input.writes, 1);
      assert.deepEqual(sessions[0], before);
      assert.equal(sessions[1].previous_session_id, prior.session_id);
    }

    for (const [name, mutate] of [
      ["no owner record", d => { d.agents = []; }],
      ["ambiguous owner", d => { d.agents.push({ ...d.agents[0] }); }],
      ["disabled owner", d => { d.agents[0].status = "disabled"; }],
      ["owner id mismatch", d => { d.agents[0].id = "a43"; }],
      ["active conflict by owner", d => { d.sessions.push({ claimed_at: "1999-01-01T00:00:00.000Z", binding_sequence: 1, status: "active", handle: "codexa42", thread_id: "other-thread", board_path: d.boardPath }); }],
      ["active conflict by current thread", d => { d.sessions.push({ claimed_at: "1999-01-01T00:00:00.000Z", binding_sequence: 1, status: "active", handle: "codexa43", thread_id: d.threadId, board_path: d.boardPath }); }],
      ["active session with neither owner nor thread match", d => { d.sessions.push({ claimed_at: "1999-01-01T00:00:00.000Z", binding_sequence: 1, status: "active", handle: "codexa43", thread_id: "other-thread", board_path: d.boardPath }); }],
    ]) {
      const { input, sessions } = makeInput();
      mutate(input);
      const before = JSON.stringify(sessions);
      const result = continuation(input);
      if (name.startsWith("active")) assert.equal(input.providerChecks, 1, name);
      if (name === "active session with neither owner nor thread match") {
        assert.equal(result.continuedFromSession, "expired-a42", name);
        assert.equal(input.writes, 1, name);
      } else {
        assert.equal(result, null, name);
        assert.equal(input.writes || 0, 0, name);
        assert.equal(JSON.stringify(sessions), before, name);
      }
      assert.deepEqual(sessions[0], JSON.parse(before)[0], name);
    }
  }));
});


function withAnthropicSessionEnv(fn) {
  const keys = ["COORD_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
    "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "CLAUDECODE", "COORD_PROVIDER", "COORD_INSTANCE_ID",
    "GEMINI_AGENT", "GROK_AGENT"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.CLAUDECODE = "1";
    process.env.COORD_SESSION_ID = "legacy-token-migration-test";
    return fn();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("legacy provider token migration counts actual registered active sessions", () => {
  withAnthropicSessionEnv(() => withSessionAuthorityFixture(({ subject, state }) => {
    const agent = { id: "a58", handle: "claudea58", provider: "anthropic", status: "active", aliases: [] };
    fs.writeFileSync(state.AGENTS_PATH, JSON.stringify([agent]));
    fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([{
      session_id: "claudea58-existing", agent_id: agent.id, handle: agent.handle, status: "active",
      board_path: state.BOARD_PATH, thread_id: "existing-anthropic-session",
      claimed_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    }]));
    const legacyPath = subject.sessionTokenPath("anthropic", { legacy: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ provider: "anthropic", thread_id: "legacy-thread",
      created_at: new Date().toISOString() }));

    const beforeSessions = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
    assert.equal(subject.getOrCreateSessionToken("anthropic"), "legacy-thread");
    const scopedPath = subject.sessionTokenPath("anthropic");
    assert.equal(JSON.parse(fs.readFileSync(scopedPath, "utf8")).thread_id, "legacy-thread");
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), beforeSessions);
  }));
});


test("COORD-592 read-only diagnostics retain closeout history and tolerate incomplete historical timestamps", () => {
  withRecoveryThread(() => withSessionAuthorityFixture(({ subject, state }) => {
    const now = new Date().toISOString();
    const base = { board_path: state.BOARD_PATH, thread_id: process.env.CODEX_THREAD_ID,
      session_id: "closed-session", agent_id: "a42", handle: "codexa42" };
    const cases = [
      [{ ...base, status: "released", release_reason: "terminal", released_at: now }, /released after ticket closeout.*automatically/i],
      [{ ...base, status: "released", release_reason: "explicit", claimed_at: now }, /explicitly released at an unknown time/i],
      [{ ...base, status: "released", release_reason: "terminal", last_seen_at: now }, /released after ticket closeout at an unknown time/i],
      [{ ...base, session_id: "", status: "released", release_reason: "explicit" }, /session \? was explicitly released at an unknown time/i],
      [{ ...base, status: "expired", release_reason: "idle-expiry" }, /idle-session sweep.*last seen unknown/i],
      [{ ...base, status: "expired", release_reason: "operator-recovery" }, /recorded reason: operator-recovery.*last seen unknown/i],
      [{ ...base, status: "disabled", last_seen_at: now }, /most recent binding closed-session is disabled/i],
      [{ ...base, session_id: "", status: "", last_seen_at: "" }, /most recent binding \? is inactive.*unknown/i],
    ];
    for (const [prior, expected] of cases) {
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([prior]));
      const before = fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8");
      assert.throws(() => subject.ensureCurrentAgentIdentity({ readOnly: true }), (error) => {
        assert.equal(error.code, "NO_ACTIVE_SESSION");
        assert.match(error.message, expected);
        assert.match(error.message, /start and update-plan require a claimed binding/);
        assert.match(error.message, /claim --owner <handle\|simple-id>/);
        return true;
      });
      assert.equal(fs.readFileSync(state.AGENT_SESSIONS_PATH, "utf8"), before);
    }
  }));
});

test("COORD-678 explicit owner survives a registry read race without inventing identity", () => {
  let reads = 0;
  const registry = [{ id: "a42", handle: "codexa42", provider: "openai", status: "active", aliases: [] }];
  withSessionAuthorityFixture(({ subject, state }) => {
    const result = subject.resolveOwnerIdentity("a42");
    assert.equal(result.agent, null, "the second read is absent, so identity is not fabricated");
    assert.equal(result.session, null);
    assert.equal(reads, 2);
    assert.deepEqual(subject.readAgentSessions(), []);
  }, { readJsonArrayFileOrFail: (file, label) => {
    if (String(file).endsWith("agents.json")) return ++reads === 1 ? registry : [];
    return require("./state-io.js").readJsonArrayFileOrFail(file, label);
  } });
});

test("COORD-678 explicit owner continues only an eligible released session inside a governed mutation", () => {
  const saved = Object.fromEntries(["CODEX_THREAD_ID", "AGENT_THREAD_ID"].map((name) => [name, process.env[name]]));
  try {
    process.env.CODEX_THREAD_ID = "coord678-continuation-thread";
    process.env.AGENT_THREAD_ID = "coord678-continuation-thread";
    withSessionAuthorityFixture(({ subject, state }) => {
      const prior = { session_id: "prior-terminal-session", agent_id: "a42", handle: "codexa42",
        status: "released", release_reason: "terminal", board_path: state.BOARD_PATH,
        thread_id: "coord678-continuation-thread", claimed_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString() };
      fs.writeFileSync(state.AGENT_SESSIONS_PATH, JSON.stringify([prior]) + "\n");
      state.activeGovernanceMutationContext = { metadata: { command: "test-continuation" } };
      const result = subject.resolveOwnerIdentity("codexa42", { requireCurrentSession: true });
      assert.equal(result.session.previous_session_id, prior.session_id);
      assert.equal(result.session.status, "active");
      assert.equal(result.session.thread_id, "coord678-continuation-thread");
      assert.equal(result.agent.handle, "codexa42");
      const sessions = subject.readAgentSessions();
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].status, "released", "history is preserved");
      assert.equal(sessions[1].status, "active");
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("COORD-880 production provider detection still answers anthropic from CLAUDECODE alone", () => {
  // The test runner strips CLAUDECODE from test children; production detection is
  // untouched, so a fixture that sets it explicitly still detects Claude, and the
  // same fixture without it falls through to unknown regardless of the invoking shell.
  const names = ["COORD_SESSION_ID", "COORD_PROVIDER", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
    "AGENT_THREAD_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(sessionTesting.detectRuntimeProvider(), "unknown");
    process.env.CLAUDECODE = "1";
    assert.equal(sessionTesting.detectRuntimeProvider(), "anthropic");
    process.env.CODEX_THREAD_ID = "coord880-codex-thread";
    assert.equal(sessionTesting.detectRuntimeProvider(), "openai", "a thread id still outranks the detection flag");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("COORD-883 production provider detection still answers google from GEMINI_AGENT and xai from GROK_AGENT alone", () => {
  // The test runner strips GEMINI_AGENT and GROK_AGENT from test children;
  // production detection is untouched, so a fixture that sets one explicitly still
  // detects its provider, registry order still decides between flags, and a thread
  // id still outranks every flag.
  const names = ["COORD_SESSION_ID", "COORD_PROVIDER", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
    "AGENT_THREAD_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(sessionTesting.detectRuntimeProvider(), "unknown");
    process.env.GEMINI_AGENT = "1";
    assert.equal(sessionTesting.detectRuntimeProvider(), "google");
    delete process.env.GEMINI_AGENT;
    process.env.GROK_AGENT = "1";
    assert.equal(sessionTesting.detectRuntimeProvider(), "xai");
    process.env.GEMINI_AGENT = "1";
    assert.equal(sessionTesting.detectRuntimeProvider(), "google", "registry order decides between detection flags");
    process.env.CODEX_THREAD_ID = "coord883-codex-thread";
    assert.equal(sessionTesting.detectRuntimeProvider(), "openai", "a thread id still outranks the detection flags");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

// COORD-951 (2): a session token whose created_at is in the future is not fresh forever.
// Symmetric skew tolerance: up to one idle window ahead is fresh; beyond it is stale.
test("COORD-951 T2: a future session created_at is fresh within one idle window and stale beyond it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord951-session-skew-"));
  try {
    const file = path.join(dir, "token.json");
    const tokenAt = (offsetMs) => {
      fs.writeFileSync(file, JSON.stringify({ thread_id: "t-skew", created_at: new Date(Date.now() + offsetMs).toISOString() }));
      return sessionTesting.readFreshSessionToken(file);
    };
    assert.equal(tokenAt(AGENT_SESSION_IDLE_MS - 1000)?.thread_id, "t-skew", "one idle window minus 1s ahead is fresh");
    assert.equal(tokenAt(AGENT_SESSION_IDLE_MS + 1000), null, "one idle window plus 1s ahead is stale");
    assert.equal(tokenAt(-1000)?.thread_id, "t-skew", "a past created_at inside the window is fresh");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-1052: product lock records the origin cut point and leaves an unprovable base unset", (t) => {
  const { gitFixture } = require("./test-git-fixture.js");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "coord1052-lock-base-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  gitFixture(temp, ["init", "-b", "dev", "."]);
  gitFixture(temp, ["commit", "--allow-empty", "-m", "origin cut point"]);
  const cutPoint = gitFixture(temp, ["rev-parse", "HEAD"]);
  gitFixture(temp, ["update-ref", "refs/remotes/origin/dev", cutPoint]);
  gitFixture(temp, ["commit", "--allow-empty", "-m", "local dev ahead of origin"]);
  const localTip = gitFixture(temp, ["rev-parse", "HEAD"]);
  gitFixture(temp, ["switch", "-c", "ticket"]);
  gitFixture(temp, ["commit", "--allow-empty", "-m", "ticket implementation"]);
  const ticketHead = gitFixture(temp, ["rev-parse", "HEAD"]);
  gitFixture(temp, ["switch", "--orphan", "unrelated"]);
  gitFixture(temp, ["commit", "--allow-empty", "-m", "independent root"]);
  gitFixture(temp, ["switch", "ticket"]);

  const locksDir = path.join(temp, "locks");
  const agentsPath = path.join(temp, "agents.json");
  fs.writeFileSync(agentsPath, "[]");
  withScopedGovernanceTestContext({ LOCKS_DIR: locksDir, AGENTS_PATH: agentsPath }, () => {
    const write = (ticketId, baseRef, transferProvenance) => {
      sessionTesting.writeLock({
        ticketId, baseRef, owner: "codexa11", repoCode: "B", branch: "ticket",
        worktree: temp, workspaceOwner: "claudea11", transferProvenance,
      });
      return JSON.parse(fs.readFileSync(path.join(locksDir, `${ticketId}.lock`), "utf8"));
    };
    const lock = write("COORD-1052", "dev");
    assert.equal(lock.head, ticketHead);
    assert.notEqual(localTip, cutPoint);
    assert.equal(lock.base_commit, cutPoint);
    assert.equal(lock.workspace_owner, "claudea11");
    assert.deepEqual(lock.transfer_provenance, []);
    assert.equal(write("COORD-1053", "missing").base_commit, null);
    assert.equal(write("COORD-1054", "unrelated").base_commit, null);
    const provenance = [{
      from: "claudea11",
      to: "codexa11",
      at: "2026-06-01T12:00:00.000Z",
      workspace_owner: "claudea11",
      reason: "Worktree handoff",
      previous_session_id: null,
    }];
    const transferred = write("COORD-1056", "dev", provenance);
    assert.equal(transferred.base_commit, cutPoint);
    assert.equal(transferred.workspace_owner, "claudea11");
    assert.deepEqual(transferred.transfer_provenance, provenance);

    gcvLockRecords.writeLock({
      ticketId: "COORD-1055", baseRef: "dev", owner: "codexa11", repoCode: "X", branch: "ticket",
      worktree: path.join(temp, "absent-worktree"),
    });
    const preWorkspace = JSON.parse(fs.readFileSync(path.join(locksDir, "COORD-1055.lock"), "utf8"));
    assert.equal(preWorkspace.base_commit, null);
  });
});

test("only a recorded closeout blocker permits concurrent doing for its parent", () => {
  const parent = "COORD-100";
  const child = "COORD-101";
  const unrelated = "COORD-102";
  const board = {
    sections: [{ rows: [parent, child, unrelated].map((ID) => ({ ID, Status: "doing", Owner: "claudea11" })) }],
  };
  const canHold = (left, right) => sessionTesting.canOwnerHoldConcurrentDoing(board, left, right);
  assert.equal(canHold(parent, child), false, "older boards may omit the exception registry");
  assert.equal(canHold(parent, "COORD-999"), false, "both tickets must exist");
  assert.equal(canHold("COORD-999", parent), false);
  board.followup_exceptions = {
    [child]: { type: "closeout-blocker", parent },
    [unrelated]: { type: "other", parent },
  };
  assert.equal(canHold(child, parent), true, "the closeout child permits concurrent work on its parent");
  assert.equal(canHold(parent, child), true, "the relation is independent of argument order");
  assert.equal(canHold(child, unrelated), false, "the exception applies to its named parent");
  assert.equal(canHold(unrelated, parent), false, "other exception types do not permit concurrent work");
});
