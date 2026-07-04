// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  __testing,
  withoutProcFs,
  runGit,
  createTempGitRepo,
} = require("./governance-test-utils.js");
const createGovernanceSession = require("./governance-session.js");
const memoryClassification = require("./memory-classification.js");

const sessionTesting = createGovernanceSession({
  AGENT_SESSION_IDLE_MS: 60 * 60 * 1000,
  COORD_DIR: process.cwd(),
  GovernanceError,
  SESSION_FINGERPRINT_ENV_VARS: [],
  state: __testing.paths,
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
    __testing.isCompleteLockPayload({
      owner: "claudea11",
      agent_id: "a11",
      session_id: "a11-session",
      heartbeat_utc: "2026-04-04T12:56:27.896Z",
    }),
    false
  );

  assert.equal(
    __testing.isCompleteLockPayload({
      owner: "claudea11",
      agent_id: "a11",
      ticket: "FE-096",
      status: "doing",
      repo: __testing.repoNameForCode("F"),
      branch: "agent/claudea11-fe-096-fix",
      head: "39770ce0d590bf7afcabcf154589040366b473e9",
      worktree: `/tmp/${__testing.repoNameForCode("F")}/.worktrees/claudea11/FE-096`,
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

  assert.equal(__testing.isDoingStatus("doing"), true);
  assert.equal(__testing.isDoingStatus("doing (blocked: awaiting policy fix)"), true);
  assert.equal(__testing.findDoingTicketForOwner(board, "codexa00")?.ID, "DEBT-052");
  assert.equal(__testing.findDoingTicketForOwner(board, "codexa00", "DEBT-052"), null);
});

test("allocateAgentSimpleId increments from the highest referenced board user instead of reusing gaps", () => {
  assert.equal(
    __testing.allocateAgentSimpleId(
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-migrate-"));
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

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = runtimeSessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = legacySessionsPath;

  try {
    const sessions = __testing.readAgentSessions();
    assert.equal(fs.existsSync(runtimeSessionsPath), true);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, "s1");
    assert.equal(sessions[0].board_path, __testing.paths.BOARD_PATH);

    const persisted = JSON.parse(fs.readFileSync(runtimeSessionsPath, "utf8"));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].session_id, "s1");
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
  }
});

test("readAgentSessions fails explicitly when the runtime session file is corrupted", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-session-corrupt-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const runtimeSessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const agentsPath = path.join(tempDir, "agents.json");
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(runtimeSessionsPath, "{not json}\n", "utf8");
  fs.writeFileSync(agentsPath, JSON.stringify([], null, 2), "utf8");

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = runtimeSessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = path.join(tempDir, "agent_sessions.json");

  try {
    assert.throws(
      () => __testing.readAgentSessions(),
      (error) => error instanceof GovernanceError && /not valid JSON/i.test(error.message)
    );
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
  }
});

test("readAgentsRegistry adopts legacy top-level registry into runtime path and preserves a compatibility copy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-agents-migrate-"));
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
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
  };

  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(legacyAgentsPath, JSON.stringify(agents, null, 2), "utf8");

  __testing.paths.AGENTS_PATH = runtimeAgentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;

  try {
    const registry = __testing.readAgentsRegistry();
    assert.equal(fs.existsSync(runtimeAgentsPath), true);
    assert.deepEqual(registry, agents);
    assert.deepEqual(JSON.parse(fs.readFileSync(runtimeAgentsPath, "utf8")), agents);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyAgentsPath, "utf8")), agents);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
  }
});

test("readAgentsRegistry refreshes a stale legacy compatibility copy from the runtime registry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-agents-refresh-"));
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
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    LEGACY_AGENTS_PATH: __testing.paths.LEGACY_AGENTS_PATH,
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(runtimeAgentsPath, JSON.stringify(runtimeAgents, null, 2), "utf8");
  fs.writeFileSync(legacyAgentsPath, JSON.stringify(legacyAgents, null, 2), "utf8");

  __testing.paths.AGENTS_PATH = runtimeAgentsPath;
  __testing.paths.LEGACY_AGENTS_PATH = legacyAgentsPath;

  try {
    const registry = __testing.readAgentsRegistry();
    assert.deepEqual(registry, runtimeAgents);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyAgentsPath, "utf8")), runtimeAgents);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.LEGACY_AGENTS_PATH = original.LEGACY_AGENTS_PATH;
  }
});

test("getOrCreateSessionToken writes provider fallback tokens under runtime instead of top-level coord", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-runtime-token-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentsPath = path.join(tempDir, "agents.json");
  const sessionsPath = path.join(runtimeDir, "agent_sessions.json");
  const runtimeSessionThreadsDir = path.join(runtimeDir, "session-threads");
  const legacyTokenPath = path.join(tempDir, ".session-thread-anthropic");
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    LEGACY_AGENT_SESSIONS_PATH: __testing.paths.LEGACY_AGENT_SESSIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
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

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.LEGACY_AGENT_SESSIONS_PATH = path.join(tempDir, "agent_sessions.json");
  __testing.paths.RUNTIME_DIR = runtimeDir;
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
    const threadId = __testing.getOrCreateSessionToken("anthropic");
    const tokenFiles = fs.readdirSync(runtimeSessionThreadsDir).filter((entry) => entry.endsWith(".json"));
    assert.equal(tokenFiles.length, 1);
    const runtimeTokenPath = path.join(runtimeSessionThreadsDir, tokenFiles[0]);
    assert.match(tokenFiles[0], /^anthropic-[a-f0-9]{12}\.json$/);
    assert.equal(fs.existsSync(legacyTokenPath), false);
    assert.equal(JSON.parse(fs.readFileSync(runtimeTokenPath, "utf8")).thread_id, threadId);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.LEGACY_AGENT_SESSIONS_PATH = original.LEGACY_AGENT_SESSIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
      assert.equal(__testing.runtimeSessionFingerprint("anthropic"), null);
    });
    // An explicit terminal-multiplexer var anchors the fingerprint deterministically.
    process.env.TMUX_PANE = "%42";
    const tmux = __testing.runtimeSessionFingerprint("anthropic");
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
    const fingerprint = __testing.runtimeSessionFingerprint("anthropic");
    assert.ok(fingerprint, "must produce a non-null fingerprint via sid");
    assert.match(fingerprint, /provider:anthropic/);
    assert.match(fingerprint, /\|sid:\d+/, "must include the POSIX sid as the auto-anchor");
    assert.equal(__testing.runtimeSessionFingerprint("anthropic"), fingerprint,
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
    const a1 = __testing.runtimeSessionFingerprint("anthropic");
    assert.match(a1, /thread:conversation-A/,
      "fingerprint must anchor on the provider session id");
    assert.doesNotMatch(a1, /\|sid:\d+/,
      "the /proc sid must not be used when a provider session id is present");

    // Stable across calls even though the underlying /proc sid would differ.
    const a2 = __testing.runtimeSessionFingerprint("anthropic");
    assert.equal(a2, a1, "fingerprint must be stable across calls in one conversation");

    // Two distinct conversations stay isolated.
    process.env.CLAUDE_CODE_SESSION_ID = "conversation-B";
    const b1 = __testing.runtimeSessionFingerprint("anthropic");
    assert.notEqual(b1, a1, "distinct session ids must produce distinct fingerprints");

    // The legacy/documented CLAUDE_SESSION_ID name still works as an alias.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "legacy-conversation";
    const legacy = __testing.runtimeSessionFingerprint("anthropic");
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
    const a = __testing.runtimeSessionFingerprint("anthropic");
    process.env.COORD_SESSION_ID = "subagent-B";
    const b = __testing.runtimeSessionFingerprint("anthropic");
    assert.match(a, /coord-session:subagent-A/);
    assert.match(b, /coord-session:subagent-B/);
    assert.notEqual(a, b, "distinct COORD_SESSION_ID must yield distinct fingerprints despite a shared provider thread id");
    assert.ok(!a.includes("conversation-shared-id"), "COORD_SESSION_ID must override, not append to, the provider thread id");

    process.env.COORD_SESSION_ID = "subagent-A";
    assert.equal(__testing.runtimeSessionFingerprint("anthropic"), a, "deterministic for a fixed value");

    // Unset → unchanged: falls through to the provider thread id.
    delete process.env.COORD_SESSION_ID;
    const none = __testing.runtimeSessionFingerprint("anthropic");
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
    assert.equal(__testing.resolveEffectiveThreadId(), "subagent-A");
    process.env.COORD_SESSION_ID = "subagent-B";
    assert.equal(__testing.resolveEffectiveThreadId(), "subagent-B");

    // Unset → falls back to the provider thread id exactly as before.
    delete process.env.COORD_SESSION_ID;
    assert.equal(__testing.resolveEffectiveThreadId(), "conversation-shared-id");
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-provider-session-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "google-session-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
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

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
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
    assert.equal(__testing.resolveEffectiveThreadId(), null);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("resolveEffectiveThreadId fails closed when multiple unstable provider sessions exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-provider-session-multi-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "google-session-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    {
      session_id: "a22-test",
      agent_id: "a22",
      handle: "geminia22",
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "google-session-2",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
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

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
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
    assert.equal(__testing.resolveEffectiveThreadId(), null);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("ensureCurrentAgentIdentity can resolve without rewriting agent_sessions when touchSession is false", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-identity-no-touch-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "codex-thread-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-1";
  delete process.env.AGENT_THREAD_ID;

  try {
    const before = fs.readFileSync(sessionsPath, "utf8");
    const identity = __testing.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    const after = fs.readFileSync(sessionsPath, "utf8");
    assert.equal(identity.agent.handle, "codexa04");
    assert.equal(after, before);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("getOrCreateSessionToken reaps auto-claimed stubs and proceeds to mint when no runtime anchor exists (COORD-010)", () => {
  // COORD-010 removed the per-provider cap (the prior incarnation of this test
  // asserted refuse-to-mint). With COORD-011 anchoring the Claude Code
  // fingerprint via the claude-ancestor walk, the cap was redundant
  // defense-in-depth on procfs systems. On the auto-anchor-less path the mint
  // flow now reaps idle stubs (auto-claimed always, manual past 24h) and
  // proceeds — the foreign-adoption guard in resolveEffectiveThreadId and
  // explicit --owner on ticket-mutating claims remain the safety floor.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-noanchor-stubs-"));
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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  process.env.CLAUDECODE = "1";
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  delete process.env.TERM_SESSION_ID;
  delete process.env.TMUX_PANE;
  delete process.env.WEZTERM_PANE;

  try {
    withoutProcFs(() => {
      const threadId = __testing.getOrCreateSessionToken("anthropic");
      assert.match(threadId, /^anthropic-/, "must mint a fresh anthropic thread id");

      const after = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
      const stillActive = after.filter((s) => s.status === "active");
      assert.equal(stillActive.length, 0,
        "auto-claimed stubs must be reaped before/during mint");
      const released = after.filter((s) => s.status === "released");
      assert.equal(released.length, 2, "both stubs must transition to released");
    });
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-noanchor-manual-"));
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

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    TERM_SESSION_ID: process.env.TERM_SESSION_ID,
    TMUX_PANE: process.env.TMUX_PANE,
    WEZTERM_PANE: process.env.WEZTERM_PANE,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  process.env.CLAUDECODE = "1";
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.AGENT_THREAD_ID;
  delete process.env.TERM_SESSION_ID;
  delete process.env.TMUX_PANE;
  delete process.env.WEZTERM_PANE;

  try {
    withoutProcFs(() => {
      const threadId = __testing.getOrCreateSessionToken("anthropic");
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
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    __testing.paths.RUNTIME_DIR = original.RUNTIME_DIR;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("assertTicketMutationOwnership validates without rewriting agent_sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-ownership-no-touch-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "codex-thread-ownership",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-ownership";
  delete process.env.AGENT_THREAD_ID;

  try {
    const before = fs.readFileSync(sessionsPath, "utf8");
    const identity = __testing.assertTicketMutationOwnership("IMP-999", { Owner: "codexa04" }, null);
    const after = fs.readFileSync(sessionsPath, "utf8");
    assert.equal(identity.agent.handle, "codexa04");
    assert.equal(after, before);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("ensureTicketMutationOwnership does not auto-hijack an active lock from another session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-no-hijack-"));
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
      board_path: __testing.paths.BOARD_PATH,
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
    repo: __testing.repoNameForCode("F"),
    worktree: "/tmp/fake-worktree",
    branch: "agent/claudea12-imp-998",
  };
  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  delete process.env.CLAUDE_SESSION_ID;
  process.env.AGENT_THREAD_ID = "claude-thread-2";
  delete process.env.CODEX_THREAD_ID;

  try {
    assert.throws(
      () => __testing.ensureTicketMutationOwnership("IMP-998", { Owner: "claudea12" }, lock, { owner: "claudea12" }),
      (error) => error instanceof GovernanceError && /Lock for IMP-998 is bound to session a12-other/i.test(error.message)
    );
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, "a12-current");
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("describeTicketMutationOwnershipIssue guides session mismatches toward resume and recover", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-session-mismatch-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "claude-thread-1",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    GEMINI_THREAD_ID: process.env.GEMINI_THREAD_ID,
    GROK_THREAD_ID: process.env.GROK_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  delete process.env.CODEX_THREAD_ID;
  process.env.CLAUDE_SESSION_ID = "claude-thread-1";
  delete process.env.GEMINI_THREAD_ID;
  delete process.env.GROK_THREAD_ID;
  delete process.env.AGENT_THREAD_ID;

  try {
    const issue = __testing.describeTicketMutationOwnershipIssue(
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
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("describeTicketMutationOwnershipIssue includes the expected owner's active session in owner mismatch guidance", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-owner-mismatch-guidance-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "codex-thread-current",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
    {
      session_id: "a47-owner",
      agent_id: "a47",
      handle: "codexa47",
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "codex-thread-owner",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-current";
  delete process.env.AGENT_THREAD_ID;

  try {
    const issue = __testing.describeTicketMutationOwnershipIssue("FE-132", {
      Owner: "codexa47",
    });
    assert.equal(issue.code, "owner_mismatch");
    assert.match(issue.message, /Recorded active session for codexa47: a47-owner/);
    assert.equal(issue.next_steps.includes("coord/scripts/gov claim --owner codexa47"), true);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("COORD-128 assertRegisteredBoundOwner: registered+bound owner mutates; unregistered/unbound is refused with remediation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-rbo-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "claude-thread-rbo",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    COORD_SESSION_ID: process.env.COORD_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.COORD_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = "claude-thread-rbo";
  delete process.env.AGENT_THREAD_ID;

  try {
    // (a) registered + bound owner: proceeds, returns the acting identity.
    const okIdentity = __testing.assertRegisteredBoundOwner("RBO-1", { Owner: "claudea60" }, null);
    assert.equal(okIdentity.agent.handle, "claudea60");

    // (b) registered-but-NOT-bound (different owner): refused, owner_mismatch.
    assert.throws(
      () => __testing.assertRegisteredBoundOwner("RBO-2", { Owner: "claudea61" }, null),
      (error) => error instanceof GovernanceError &&
        /Ticket RBO-2 is owned by claudea61/i.test(error.message)
    );

    // (c) UNREGISTERED / no active session for this thread: refused with the
    // COORD-128 register->bind remediation.
    process.env.CLAUDE_SESSION_ID = "claude-thread-no-session";
    assert.throws(
      () => __testing.assertRegisteredBoundOwner("RBO-3", { Owner: "claudea60" }, null),
      (error) => error instanceof GovernanceError &&
        /not a registered agent \/ not the bound owner of RBO-3/i.test(error.message) &&
        /gov agentid --assign/.test(error.message) &&
        /gov start RBO-3 --owner claudea60/.test(error.message)
    );
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("assertTicketRepairOwnership validates explicit owner without rewriting agent_sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-repair-no-touch-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "codex-thread-repair",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "codex-thread-repair";
  delete process.env.AGENT_THREAD_ID;

  try {
    const before = fs.readFileSync(sessionsPath, "utf8");
    const identity = __testing.assertTicketRepairOwnership("IMP-999", { Owner: "codexa04" }, { owner: "codexa04" });
    const after = fs.readFileSync(sessionsPath, "utf8");
    assert.equal(identity.agent.handle, "codexa04");
    assert.equal(after, before);
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("resolveOwnerIdentity can require the current claimed session for an explicit owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-owner-session-"));
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
      board_path: __testing.paths.BOARD_PATH,
      thread_id: "different-thread",
      claimed_at: now,
      last_seen_at: now,
      status: "active",
    },
  ], null, 2));

  const original = {
    AGENTS_PATH: __testing.paths.AGENTS_PATH,
    AGENT_SESSIONS_PATH: __testing.paths.AGENT_SESSIONS_PATH,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    AGENT_THREAD_ID: process.env.AGENT_THREAD_ID,
  };

  __testing.paths.AGENTS_PATH = agentsPath;
  __testing.paths.AGENT_SESSIONS_PATH = sessionsPath;
  process.env.CODEX_THREAD_ID = "this-thread";
  delete process.env.AGENT_THREAD_ID;

  try {
    assert.throws(
      () => __testing.resolveOwnerIdentity("codexa00", { requireCurrentSession: true }),
      (error) => error instanceof GovernanceError && /not bound to the current claimed session/i.test(error.message)
    );
  } finally {
    __testing.paths.AGENTS_PATH = original.AGENTS_PATH;
    __testing.paths.AGENT_SESSIONS_PATH = original.AGENT_SESSIONS_PATH;
    for (const [key, value] of Object.entries(original).filter(([key]) => key === key.toUpperCase())) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("GCV-1 Phase-6: writeLock is owner-authoritative under the v2 channel; legacy otherwise", () => {
  const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv1-lock-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv1-wt-"));
  const origLocks = __testing.paths.LOCKS_DIR;
  __testing.paths.LOCKS_DIR = locksDir;
  const saved = {
    p: process.env.COORD_PROVIDER,
    i: process.env.COORD_INSTANCE_ID,
  };
  try {
    // Channel ABSENT -> legacy lock: keeps a session_id field, no v2 tag.
    delete process.env.COORD_PROVIDER;
    delete process.env.COORD_INSTANCE_ID;
    __testing.writeLock({
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
    __testing.writeLock({
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
    __testing.paths.LOCKS_DIR = origLocks;
    if (saved.p === undefined) delete process.env.COORD_PROVIDER;
    else process.env.COORD_PROVIDER = saved.p;
    if (saved.i === undefined) delete process.env.COORD_INSTANCE_ID;
    else process.env.COORD_INSTANCE_ID = saved.i;
  }
});

test("GCV-1 Phase-6: rebindTicketLock under v2 channel preserves owner-authority (no session_id downgrade)", () => {
  const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv1-rebind-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv1-rebind-wt-"));
  const origLocks = __testing.paths.LOCKS_DIR;
  __testing.paths.LOCKS_DIR = locksDir;
  const saved = {
    p: process.env.COORD_PROVIDER,
    i: process.env.COORD_INSTANCE_ID,
  };
  try {
    process.env.COORD_PROVIDER = "claude-code";
    process.env.COORD_INSTANCE_ID = "uuid-rb-1";
    __testing.writeLock({
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
    __testing.rebindTicketLock(
      { ...v2Lock, path: lockPath },
      { handle: "claudea11", id: "a11" },
      { session_id: "should-not-appear-as-authority" }
    );
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(after.identity_model, "v2", "rebind must preserve identity_model:v2");
    assert.equal(after.session_id, null, "rebind under v2 must not write authority session_id");
    assert.equal(after.owner, "claudea11");
  } finally {
    __testing.paths.LOCKS_DIR = origLocks;
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
    board_path: __testing.paths.BOARD_PATH,
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
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, true);
  assert.equal(result.foreign_sessions.length, 1);
  assert.equal(result.foreign_sessions[0].thread_id, "thread-foreign");
});

test("COORD-222: the caller's OWN session (same thread) is never a co-located conflict (resume/lone-safe)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "mine", thread_id: "thread-mine", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "same-thread session must not false-block the lone/resume case");
  assert.equal(result.foreign_sessions.length, 0);
});

test("COORD-222: a lone session (only the caller present) does not trip the gate", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "mine", thread_id: "thread-mine", last_seen_at: new Date(now).toISOString() }),
  ];
  // From the caller's own vantage there is no OTHER fresh session.
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: a STALE foreign session (heartbeat older than idle window) does NOT block", () => {
  const now = Date.now();
  const staleSeen = new Date(now - (COLOCATED_IDLE_MS + 60 * 1000)).toISOString();
  const sessions = [
    colocatedSession({ session_id: "old", thread_id: "thread-foreign", last_seen_at: staleSeen }),
  ];
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "stale sessions are ignored exactly as elsewhere");
});

test("COORD-222: a released/inactive foreign session does NOT block (only active liveness contends)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "released", thread_id: "thread-foreign", status: "released", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: a foreign session bound to a DIFFERENT runtime/board does NOT block", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "other-runtime", thread_id: "thread-foreign", board_path: "/some/other/coord/board/tasks.json", last_seen_at: new Date(now).toISOString() }),
  ];
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false, "co-location is scoped to THIS runtime only");
});

test("COORD-222: a session with no parseable heartbeat is treated as not-fresh (does not block)", () => {
  const now = Date.now();
  const sessions = [
    colocatedSession({ session_id: "no-hb", thread_id: "thread-foreign", last_seen_at: null, claimed_at: null }),
  ];
  const result = __testing.detectColocatedForeignSessions({ currentThreadId: "thread-mine", sessions, now });
  assert.equal(result.present, false);
});

test("COORD-222: the refusal message names the override and the topology doc", () => {
  const detection = {
    present: true,
    current_thread_id: "thread-mine",
    foreign_sessions: [{ session_id: "foreign-1", handle: "claudea11", thread_id: "thread-foreign" }],
  };
  const message = __testing.buildColocatedForeignSessionMessage("start", detection);
  assert.match(message, /--allow-shared-worktree/);
  assert.match(message, /MULTI_AGENT_TOPOLOGIES\.md:136/);
  assert.match(message, /separate git worktree/i);
  assert.match(message, /foreign-1/);
});
