const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { STATUS } = require("./governance-constants.js");

// COORD-104 (annotated residual): createGovernanceSession is a
// dependency-injection FACTORY closure that wires the agent-identity / session /
// lock-ownership helpers over one destructured `deps` bundle and returns them as
// a facade. Like createGovernanceValidation, its reported ~84 complexity is an
// estimator artifact of that closure shape — every nested helper is already
// under the per-function budget (none is individually reported), so there is no
// real per-function hotspot left to split. The residual decision tokens are
// inline arrow callbacks lexically inside the closure body that the zero-AST
// heuristic cannot attribute to a named child. Reducing the factory's own number
// would require hoisting ~40 helpers to module scope and re-threading every
// `deps` binding by hand — a high-risk rewrite of core session/identity
// governance with no behavioral upside. Annotated and accepted per the ticket's
// inherently-complex carve-out.
function createGovernanceSession(deps) {
  const {
    AGENT_SESSION_IDLE_MS,
    COORD_DIR,
    GovernanceError,
    SESSION_FINGERPRINT_ENV_VARS,
    compareSessionsMostRecentFirst,
    ensureParentDir,
    ensureWaiverIndex,
    fail,
    findLatestTicketGovernanceEvent,
    formatJsonFileIssue,
    getRows,
    getTicketRef,
    identityV2,
    isRepoBackedCode,
    moveFileIfNeeded,
    readJsonArrayFileOrFail,
    readJsonFileState,
    reapIdleAutoClaimedProviderStubs,
    repoNameForCode,
    resolveLockHead,
    safeReadJson,
    state,
    summarizeGovernanceEvent,
    withAgentStateLock,
    writeJsonFile,
  } = deps;

function heartbeatAgeMsForSession(session, now = Date.now()) {
  const seen = Date.parse(session?.last_seen_at || session?.claimed_at || "");
  return Number.isFinite(seen) ? Math.max(0, now - seen) : null;
}

function summarizeRecentOwnerLeaseEvidence(ticketId) {
  try {
    const event = findLatestTicketGovernanceEvent(ticketId);
    if (!event) return null;
    if (!/handoff|release|owner-lease|claim/i.test(String(event.command || ""))) {
      return null;
    }
    return summarizeGovernanceEvent(event);
  } catch {
    return null;
  }
}

function detectActiveSameOwnerOtherThread(ticketId, lock, options = {}) {
  const result = {
    present: false,
    ticket: ticketId,
    current_thread_id: null,
    lock_session_id: lock?.session_id || null,
    active_owner_sessions: [],
    recent_owner_lease_evidence: null,
  };
  if (!lock || lock.status !== STATUS.DOING) {
    return result;
  }
  const canonicalOwner = normalizeOwnerValue(lock.owner);
  if (!canonicalOwner) {
    return result;
  }
  const currentThreadId = options.currentThreadId !== undefined
    ? options.currentThreadId
    : currentRuntimeThreadId();
  result.current_thread_id = currentThreadId || null;
  const now = typeof options.now === "number" ? options.now : Date.now();
  const sessions = (options.sessions || readAgentSessions()).filter(
    (session) => session.board_path === state.BOARD_PATH,
  );
  // A live, same-owner session on a DIFFERENT thread than the caller is the
  // contended holder. "active" is the registry's own liveness signal (matching
  // the doctor mirror-state check); a released/expired session never contends.
  const liveOtherThread = sessions.filter((session) =>
    session.handle === canonicalOwner &&
    session.status === "active" &&
    typeof session.thread_id === "string" &&
    session.thread_id.trim() !== "" &&
    session.thread_id !== currentThreadId,
  );
  result.active_owner_sessions = liveOtherThread.map((session) => ({
    session_id: session.session_id,
    thread_id: session.thread_id,
    last_seen_at: session.last_seen_at || null,
    heartbeat_age_ms: heartbeatAgeMsForSession(session, now),
  }));
  result.present = liveOtherThread.length > 0;
  result.recent_owner_lease_evidence = summarizeRecentOwnerLeaseEvidence(ticketId);
  return result;
}

function buildActiveSameOwnerOtherThreadMessage(ticketId, detection, options = {}) {
  const verb = options.handoff
    ? "claim --handoff"
    : (options.force ? "resume/claim" : "claim");
  const others = detection.active_owner_sessions
    .map((session) => `${session.session_id || "?"}@thread:${session.thread_id}`)
    .join(", ");
  return (
    `Ticket ${ticketId} is held by a live same-owner session on a different thread ` +
    `(active_same_owner_other_thread): ${others}. ` +
    `The current thread (${detection.current_thread_id || "unknown"}) is not the holder, ` +
    `so ${verb} must not displace a fresh same-owner other-thread lock. ` +
    `Return to the original session, or — if this is an authorized takeover — use ` +
    `\`coord/scripts/gov claim ${ticketId} --human-admin-override "<reason>"\`. ` +
    `Run \`coord/scripts/gov explain ${ticketId}\` to see the live owner/session picture.`
  );
}


function assertRuntimeProviderMatchesAgent(agent, options = {}) {
  if (options.allowProviderMismatch === true) {
    return;
  }
  const runtimeProvider = detectRuntimeProvider();
  const agentProvider = String(agent?.provider || "").trim();
  if (!agentProvider || runtimeProvider === "unknown" || agentProvider === runtimeProvider) {
    return;
  }
  fail(
    `Runtime provider ${runtimeProvider} cannot claim ${agent.handle} (${agent.id}, provider=${agentProvider}). ` +
    "Use a matching provider session, or perform an explicit human-admin transfer if this is intentional."
  );
}


function resolveLegacyAgentsCompatibilityPath() {
  const fileName = path.basename(state.AGENTS_PATH);
  const parentDir = path.basename(path.dirname(state.AGENTS_PATH));
  if (fileName === "agents.json" && parentDir === ".runtime") {
    return path.join(path.dirname(path.dirname(state.AGENTS_PATH)), "agents.json");
  }
  if (state.LEGACY_AGENTS_PATH && state.LEGACY_AGENTS_PATH !== state.AGENTS_PATH && path.dirname(state.LEGACY_AGENTS_PATH) === path.dirname(state.AGENTS_PATH)) {
    return state.LEGACY_AGENTS_PATH;
  }
  return state.AGENTS_PATH;
}

function writeAgentRegistryFile(value) {
  writeJsonFile(state.AGENTS_PATH, value);
  const compatibilityPath = resolveLegacyAgentsCompatibilityPath();
  if (compatibilityPath !== state.AGENTS_PATH) {
    writeJsonFile(compatibilityPath, value);
  }
}

function readAgentsRegistry() {
  ensureAgentFiles();
  return readJsonArrayFileOrFail(state.AGENTS_PATH, "agent registry");
}

function readAgentSessions() {
  ensureAgentFiles();
  const payload = readJsonArrayFileOrFail(state.AGENT_SESSIONS_PATH, "agent sessions file");
  const { sessions, changed } = normalizeAgentSessions(payload);
  if (changed) {
    withAgentStateLock(() => {
      const latestState = readJsonFileState(state.AGENT_SESSIONS_PATH);
      if (!latestState.exists || latestState.error) {
        fail(formatJsonFileIssue(state.AGENT_SESSIONS_PATH, "agent sessions file", latestState));
      }
      const latest = Array.isArray(latestState.value) ? latestState.value : payload;
      const normalized = normalizeAgentSessions(latest);
      if (normalized.changed) {
        writeJsonFile(state.AGENT_SESSIONS_PATH, normalized.sessions);
      }
    });
  }
  return sessions;
}

function ensureAgentFiles() {
  withAgentStateLock(() => {
    if (!fs.existsSync(state.AGENTS_PATH)) {
      const compatibilityPath = resolveLegacyAgentsCompatibilityPath();
      const legacyAgents = compatibilityPath !== state.AGENTS_PATH ? safeReadJson(compatibilityPath) : null;
      if (Array.isArray(legacyAgents)) {
        writeAgentRegistryFile(legacyAgents);
      } else {
        writeAgentRegistryFile(defaultAgentRegistry());
      }
    } else {
      const compatibilityPath = resolveLegacyAgentsCompatibilityPath();
      if (compatibilityPath !== state.AGENTS_PATH) {
        const agents = safeReadJson(state.AGENTS_PATH);
        if (Array.isArray(agents)) {
          const runtimeRaw = fs.readFileSync(state.AGENTS_PATH, "utf8");
          const compatibilityRaw = fs.existsSync(compatibilityPath)
            ? fs.readFileSync(compatibilityPath, "utf8")
            : null;
          if (compatibilityRaw !== runtimeRaw) {
            writeJsonFile(compatibilityPath, agents);
          }
        }
      }
    }
    if (
      shouldUseLegacyAgentSessionsCompatibility() &&
      !fs.existsSync(state.AGENT_SESSIONS_PATH) &&
      fs.existsSync(state.LEGACY_AGENT_SESSIONS_PATH)
    ) {
      const legacySessions = safeReadJson(state.LEGACY_AGENT_SESSIONS_PATH);
      if (Array.isArray(legacySessions)) {
        writeJsonFile(state.AGENT_SESSIONS_PATH, legacySessions);
      }
    }
    if (!fs.existsSync(state.AGENT_SESSIONS_PATH)) {
      writeJsonFile(state.AGENT_SESSIONS_PATH, []);
    }
  });
}

function defaultAgentRegistry() {
  return [
    { id: "a00", handle: "codexa00", aliases: ["codex"], provider: "openai", status: "active", notes: "Recyclable Codex session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a01", handle: "codexa01", aliases: ["codex1"], provider: "openai", status: "active", notes: "Recyclable Codex session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a02", handle: "codexa02", aliases: ["codex2"], provider: "openai", status: "active", notes: "Recyclable Codex session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a03", handle: "codexa03", aliases: ["codex3"], provider: "openai", status: "active", notes: "Recyclable Codex session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a04", handle: "codexa04", aliases: ["codex4"], provider: "openai", status: "active", notes: "Recyclable Codex session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a11", handle: "claudea11", aliases: ["claude1"], provider: "anthropic", status: "active", notes: "Recyclable Claude session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a12", handle: "claudea12", aliases: ["claude2"], provider: "anthropic", status: "active", notes: "Recyclable Claude session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a13", handle: "claudea13", aliases: ["claude3"], provider: "anthropic", status: "active", notes: "Recyclable Claude session id", created_at: "2026-03-21T00:00:00.000Z" },
    { id: "a21", handle: "geminia21", aliases: ["gemini1"], provider: "google", status: "active", notes: "Recyclable Gemini session id", created_at: "2026-03-22T00:00:00.000Z" },
    { id: "a22", handle: "geminia22", aliases: ["gemini2"], provider: "google", status: "active", notes: "Recyclable Gemini session id", created_at: "2026-03-22T00:00:00.000Z" },
    { id: "a23", handle: "geminia23", aliases: ["gemini3"], provider: "google", status: "active", notes: "Recyclable Gemini session id", created_at: "2026-03-22T00:00:00.000Z" },
    { id: "a31", handle: "groka31", aliases: ["grok1"], provider: "xai", status: "active", notes: "Recyclable Grok session id", created_at: "2026-03-22T00:00:00.000Z" },
    { id: "a32", handle: "groka32", aliases: ["grok2"], provider: "xai", status: "active", notes: "Recyclable Grok session id", created_at: "2026-03-22T00:00:00.000Z" },
    { id: "a33", handle: "groka33", aliases: ["grok3"], provider: "xai", status: "active", notes: "Recyclable Grok session id", created_at: "2026-03-22T00:00:00.000Z" },
  ];
}

function parseAgentSimpleIdNumber(subject) {
  if (subject === null || subject === undefined) {
    return null;
  }
  const raw = String(subject).trim();
  if (!raw) {
    return null;
  }
  const directMatch = raw.match(/^a(\d+)$/i);
  if (directMatch) {
    return Number.parseInt(directMatch[1], 10);
  }
  const suffixMatch = raw.match(/a(\d+)$/i);
  if (suffixMatch) {
    return Number.parseInt(suffixMatch[1], 10);
  }
  return null;
}

function formatAgentSimpleId(value) {
  return `a${String(value).padStart(2, "0")}`;
}

function collectReferencedAgentIdNumbers({ agents = null, sessions = null, board = undefined } = {}) {
  const values = new Set();
  const activeAgents = Array.isArray(agents) ? agents : readAgentsRegistry();
  const activeSessions = Array.isArray(sessions) ? sessions : readAgentSessions();
  const activeBoard = board === undefined ? safeReadJson(state.BOARD_PATH) : board;

  const addValue = (subject) => {
    const parsed = parseAgentSimpleIdNumber(subject);
    if (Number.isInteger(parsed) && parsed >= 0) {
      values.add(parsed);
    }
  };

  for (const agent of activeAgents) {
    addValue(agent?.id);
    addValue(agent?.handle);
    for (const alias of Array.isArray(agent?.aliases) ? agent.aliases : []) {
      addValue(alias);
    }
  }

  for (const session of activeSessions) {
    addValue(session?.agent_id);
    addValue(session?.handle);
  }

  if (activeBoard && Array.isArray(activeBoard.sections)) {
    for (const section of activeBoard.sections) {
      if (!Array.isArray(section?.rows)) {
        continue;
      }
      for (const row of section.rows) {
        addValue(row?.Owner);
      }
    }
  }

  return [...values].sort((left, right) => left - right);
}

function allocateAgentSimpleId(agents, options = {}) {
  const referenced = collectReferencedAgentIdNumbers({
    agents,
    sessions: options.sessions,
    board: options.board,
  });
  const floor = Number.isInteger(options.floor) ? Math.max(0, options.floor) : 0;
  const maxValue = referenced.length > 0 ? referenced[referenced.length - 1] : floor - 1;
  return formatAgentSimpleId(maxValue + 1);
}

function resolveAgentIdentifier(subject, agents = readAgentsRegistry()) {
  if (!subject) {
    return null;
  }
  const needle = String(subject).trim().toLowerCase();
  return agents
    .map((agent) => ({
      agent,
      matched:
        agent.id.toLowerCase() === needle ||
        agent.handle.toLowerCase() === needle ||
        (Array.isArray(agent.aliases) && agent.aliases.some((alias) => String(alias).toLowerCase() === needle)),
    }))
    .find((entry) => entry.matched) || null;
}

function canonicalizeOwnerOrFail(subject, options = {}) {
  const agents = readAgentsRegistry();
  const resolved = resolveAgentIdentifier(subject, agents);
  if (!resolved) {
    fail(`Owner ${subject} is not a registered agent handle/simple-id. Use "coord/scripts/gov agents list" first.`);
  }
  if ((options.requireActive ?? true) && resolved.agent.status !== "active") {
    fail(`Owner ${subject} resolves to disabled agent ${resolved.agent.handle} (${resolved.agent.id}).`);
  }
  return resolved.agent.handle;
}

function maybeCanonicalOwner(subject) {
  const resolved = resolveAgentIdentifier(subject, readAgentsRegistry());
  return resolved ? resolved.agent.handle : null;
}

function normalizeOwnerValue(subject) {
  if (!subject) {
    return subject;
  }
  return maybeCanonicalOwner(subject) || subject;
}

function normalizeBoardIdentityReferences(board) {
  if (!board || typeof board !== "object") {
    return board;
  }
  ensureWaiverIndex(board);
  for (const waiver of Object.values(board.waiver_index || {})) {
    if (waiver && waiver.recorded_by) {
      waiver.recorded_by = normalizeOwnerValue(waiver.recorded_by);
    }
  }
  if (!Array.isArray(board.sections)) {
    return board;
  }
  for (const section of board.sections) {
    if (!Array.isArray(section.rows)) {
      continue;
    }
    for (const row of section.rows) {
      if (row && row.Owner) {
        row.Owner = normalizeOwnerValue(row.Owner);
      }
    }
  }
  return board;
}

function normalizeLockIdentityReferences(lock) {
  if (!lock || typeof lock !== "object") {
    return lock;
  }
  const normalizedOwner = normalizeOwnerValue(lock.owner);
  if (normalizedOwner) {
    lock.owner = normalizedOwner;
    const agent = resolveAgentIdentifier(normalizedOwner, readAgentsRegistry())?.agent || null;
    if (agent) {
      lock.agent_id = agent.id;
    }
  }
  return lock;
}

function ownerMatches(ownerValue, canonicalOwner) {
  if (!ownerValue || !canonicalOwner) {
    return false;
  }
  const ownerCanonical = maybeCanonicalOwner(ownerValue) || String(ownerValue);
  return ownerCanonical === canonicalOwner;
}

function isDoingStatus(status) {
  return typeof status === "string" && status.startsWith("doing");
}

function findDoingTicketForOwner(board, canonicalOwner, excludeTicketId = null) {
  return getRows(board).find((row) =>
    isDoingStatus(row.Status) &&
    ownerMatches(row.Owner, canonicalOwner) &&
    row.ID !== excludeTicketId
  ) || null;
}

function canOwnerHoldConcurrentDoing(board, leftTicketId, rightTicketId) {
  if (!board || !leftTicketId || !rightTicketId || leftTicketId === rightTicketId) {
    return false;
  }
  const left = getTicketRef(board, leftTicketId)?.row || null;
  const right = getTicketRef(board, rightTicketId)?.row || null;
  if (!left || !right) {
    return false;
  }
  const leftException = board.followup_exceptions?.[leftTicketId];
  const rightException = board.followup_exceptions?.[rightTicketId];
  if (leftException?.type === "closeout-blocker" && leftException.parent === rightTicketId) {
    return true;
  }
  if (rightException?.type === "closeout-blocker" && rightException.parent === leftTicketId) {
    return true;
  }
  return false;
}

function isRegisteredAgentHandle(handle) {
  return Boolean(resolveAgentIdentifier(handle, readAgentsRegistry()));
}

function buildSessionId(agent) {
  return `${agent.id}-${Date.now().toString(36)}`;
}

function defaultHostLabel() {
  return process.env.HOSTNAME || process.env.COMPUTERNAME || "unknown-host";
}

// Provider registry: add a row here to support a new agent provider.
// - envThread: env var that carries a stable session/thread id (preferred)
// - envThreadAliases: additional env var names for the same id across host
//   versions (e.g. Claude Code exports CLAUDE_CODE_SESSION_ID; the documented/
//   legacy name is CLAUDE_SESSION_ID). Honored after envThread.
// - envDetect: env var whose presence identifies the runtime (fallback detection)
// - handlePrefix: used when auto-registering agents for this provider
const PROVIDER_REGISTRY = [
  { name: "openai",    envThread: "CODEX_THREAD_ID",   envDetect: null,            handlePrefix: "codex" },
  { name: "anthropic", envThread: "CLAUDE_CODE_SESSION_ID", envThreadAliases: ["CLAUDE_SESSION_ID"], envDetect: "CLAUDECODE", handlePrefix: "claude" },
  { name: "google",    envThread: "GEMINI_THREAD_ID",  envDetect: "GEMINI_AGENT",  handlePrefix: "gemini" },
  { name: "xai",       envThread: "GROK_THREAD_ID",    envDetect: "GROK_AGENT",    handlePrefix: "grok" },
];

// A provider may expose its session/thread id under more than one env var name.
// Resolve the primary first, then any aliases. (COORD-013: Claude Code exports
// CLAUDE_CODE_SESSION_ID, not the previously-assumed CLAUDE_SESSION_ID.)
function providerThreadEnvNames(entry) {
  if (!entry) return [];
  return [entry.envThread, ...(entry.envThreadAliases || [])].filter(Boolean);
}

function providerThreadIdValue(entry) {
  for (const name of providerThreadEnvNames(entry)) {
    if (process.env[name]) {
      return process.env[name];
    }
  }
  return null;
}

function currentRuntimeThreadId() {
  // COORD-015: an explicit orchestrator-injected COORD_SESSION_ID is the
  // authoritative effective thread id and overrides the harness-injected provider
  // thread id, mirroring the fingerprint override in runtimeSessionFingerprint.
  // This is the binding path: claim/resume/agentid resolve the current session via
  // resolveEffectiveThreadId -> currentRuntimeThreadId. Codex (CODEX_THREAD_ID) and
  // Gemini (GEMINI_THREAD_ID) carry a distinct per-agent id natively, so they
  // isolate without this; but Claude Code injects ONE CLAUDE_CODE_SESSION_ID into
  // every sub-agent of a conversation, collapsing concurrent sub-agents onto one
  // session. A distinct COORD_SESSION_ID per sub-agent restores isolation. Unset →
  // behavior is unchanged.
  if (process.env.COORD_SESSION_ID) {
    return process.env.COORD_SESSION_ID;
  }
  // Check provider-specific thread env vars, then the generic fallback
  for (const entry of PROVIDER_REGISTRY) {
    const value = providerThreadIdValue(entry);
    if (value) {
      return value;
    }
  }
  return process.env.AGENT_THREAD_ID || null;
}

function detectRuntimeProvider() {
  // First pass: match on thread-id env var (strongest signal)
  for (const entry of PROVIDER_REGISTRY) {
    if (providerThreadIdValue(entry)) {
      return entry.name;
    }
  }
  // Second pass: match on detection env var
  for (const entry of PROVIDER_REGISTRY) {
    if (entry.envDetect && process.env[entry.envDetect]) {
      return entry.name;
    }
  }
  return "unknown";
}

function providerConfig(provider) {
  return PROVIDER_REGISTRY.find((entry) => entry.name === provider) || null;
}

function buildDefaultAgentHandle(provider, id) {
  const config = providerConfig(provider);
  const prefix = config ? config.handlePrefix : "agent";
  return `${prefix}${id}`;
}

function runtimeSessionFingerprint(provider) {
  const parts = [`provider:${provider}`];
  // Absolute highest precedence: an explicit operator/orchestrator-injected
  // session id (`COORD_SESSION_ID`). It wins over EVERYTHING below, including the
  // provider's own harness-injected thread id, and short-circuits the rest of the
  // anchor chain. This is the multi-agent escape hatch (COORD-015) for the Claude
  // orchestrator+sub-agents topology: the harness injects one identical
  // `CLAUDE_CODE_SESSION_ID` into every sub-process, so without an explicit override
  // they all collapse to one fingerprint and churn each other's claims. Giving each
  // sub-agent a distinct `COORD_SESSION_ID` makes them distinct sessions. It is
  // provider-agnostic and is the only anchor that overrides the provider thread id,
  // so an operator can always assert identity explicitly (the policy preference for
  // explicit operator choice over inferred continuity). Unset → behavior is
  // unchanged. Codex/Gemini already carry distinct per-agent thread ids and do not
  // need this; it is required for Claude in-conversation sub-agents.
  const explicitCoordSession = process.env.COORD_SESSION_ID;
  if (explicitCoordSession) {
    parts.push(`coord-session:${explicitCoordSession}`);
    return parts.join("|");
  }
  // Highest precedence: this provider's stable session/thread id (e.g.
  // CLAUDE_SESSION_ID for Claude Code, CODEX_THREAD_ID for Codex). The harness
  // injects it into every tool invocation and keeps it constant for the whole
  // conversation, so it is the correct per-conversation anchor. It MUST win over
  // the /proc sid auto-anchor below: some harnesses (notably the Claude Code Bash
  // tool) spawn each invocation in its own process session, so the POSIX sid is
  // NOT stable per conversation and would otherwise mint a fresh identity on
  // every call. Two concurrent conversations carry two distinct session ids and
  // still resolve to two distinct fingerprints. (COORD-013)
  const providerSessionId = providerThreadIdValue(providerConfig(provider));
  if (providerSessionId) {
    parts.push(`thread:${providerSessionId}`);
  }
  for (const envName of SESSION_FINGERPRINT_ENV_VARS) {
    const value = process.env[envName];
    if (value) {
      parts.push(`${envName}:${value}`);
    }
  }
  // Auto-anchor for unpinned shells: on POSIX systems with /proc, the session
  // id (sid) is set once per controlling-terminal session and inherited by every
  // subprocess. So all `gov` invocations spawned by one Claude/Codex session
  // share the same sid, giving us a deterministic fingerprint without requiring
  // CLAUDE_SESSION_ID, .envrc, or terminal-multiplexer env vars. Two concurrent
  // claude instances in two terminals get two different sids and two different
  // fingerprints, so they don't collide. /proc/self/stat layout: `pid (comm) state
  // ppid pgrp session ...`; we slice past the closing `)` to skip arbitrary
  // process names containing spaces or parens.
  if (parts.length === 1) {
    try {
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const session = afterComm[3];
      if (session && session !== "0") {
        parts.push(`sid:${session}`);
      }
    } catch {
      // Non-procfs platform (macOS, BSD, Windows under WSL1 with /proc disabled);
      // fall through to the pid/ppid digest path. The fail-closed backstop in
      // getOrCreateSessionToken still prevents silent claim-stacking.
    }
  }
  if (parts.length === 1) {
    return null;
  }
  return parts.join("|");
}

function sessionTokenPath(provider, options = {}) {
  if (options.legacy) {
    return path.join(path.dirname(state.RUNTIME_DIR), `.session-thread-${provider}`);
  }
  const fingerprint = runtimeSessionFingerprint(provider);
  if (!fingerprint) {
    const explicitSessionId = process.env.CLAUDE_SESSION_ID || process.env.AGENT_THREAD_ID || "";
    if (explicitSessionId) {
      const explicitDigest = crypto.createHash("sha1")
        .update(`${provider}:explicit:${explicitSessionId}`)
        .digest("hex").slice(0, 12);
      return path.join(state.RUNTIME_DIR, "session-threads", `${provider}-${explicitDigest}.json`);
    }
    const processFingerprint = `provider:${provider}|pid:${process.pid}|ppid:${process.ppid}|cwd:${process.cwd()}`;
    const processDigest = crypto.createHash("sha1").update(processFingerprint).digest("hex").slice(0, 12);
    return path.join(state.RUNTIME_DIR, "session-threads", `${provider}-${processDigest}.json`);
  }
  const digest = crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 12);
  return path.join(state.RUNTIME_DIR, "session-threads", `${provider}-${digest}.json`);
}

function readFreshSessionToken(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (raw.thread_id && raw.created_at) {
      const age = Date.now() - new Date(raw.created_at).getTime();
      if (age < AGENT_SESSION_IDLE_MS) {
        return raw;
      }
    }
  } catch {}
  return null;
}

function countActiveSessionsForProvider(provider, sessions = readAgentSessions(), agents = readAgentsRegistry()) {
  const handles = new Set(
    agents
      .filter((agent) => agent.provider === provider)
      .map((agent) => agent.handle)
  );
  return sessions.filter((session) =>
    session.status === "active" &&
    session.board_path === state.BOARD_PATH &&
    handles.has(session.handle)
  ).length;
}

function findActiveProviderSessions(provider, sessions = readAgentSessions(), agents = readAgentsRegistry()) {
  const handles = new Set(
    agents
      .filter((agent) => agent.provider === provider)
      .map((agent) => agent.handle)
  );
  return sessions
    .filter((session) =>
      session.status === "active" &&
      session.board_path === state.BOARD_PATH &&
      handles.has(session.handle)
    )
    .sort(compareSessionsMostRecentFirst);
}

function runtimeHasStableSessionIdentity(provider = detectRuntimeProvider()) {
  if (currentRuntimeThreadId()) {
    return true;
  }
  if (provider === "unknown") {
    return false;
  }
  return Boolean(runtimeSessionFingerprint(provider));
}

function formatGovernanceJournalUninitializedMessage() {
  return (
    "Governance journal is uninitialized. Provenance before the first journaled gov mutation is unavailable. " +
    "Run a governed mutation to establish the baseline from current state."
  );
}

function resolveOrCreateEffectiveThreadId() {
  const fromEnv = currentRuntimeThreadId();
  if (fromEnv) {
    return fromEnv;
  }
  const provider = detectRuntimeProvider();
  if (provider === "unknown") {
    return null;
  }
  return getOrCreateSessionToken(provider);
}

/**
 * For runtimes that don't expose a stable thread/session env var (e.g. Claude
 * Code, Gemini CLI), we persist a generated token under coord/.runtime/session-threads
 * keyed to the current runtime instance. The token is reused until it goes stale
 * (AGENT_SESSION_IDLE_MS).
 */
/**
 * Resolves the effective thread ID for the current runtime, checking env vars
 * first, then falling back to the file-based session token for known providers.
 * Unlike getOrCreateSessionToken, this never creates a new token — read-only.
 */
function resolveEffectiveThreadId() {
  const fromEnv = currentRuntimeThreadId();
  if (fromEnv) return fromEnv;
  const provider = detectRuntimeProvider();
  if (provider === "unknown") return null;
  const scopedPath = sessionTokenPath(provider);
  const scoped = scopedPath ? readFreshSessionToken(scopedPath) : null;
  if (scoped?.thread_id) {
    return scoped.thread_id;
  }
  const legacy = readFreshSessionToken(sessionTokenPath(provider, { legacy: true }));
  if (legacy?.thread_id && countActiveSessionsForProvider(provider) <= 1) {
    return legacy.thread_id;
  }
  // A process with no runtime thread env, no scoped session-token file, and no legacy token
  // has no evidence it claimed any session. Returning the thread_id of the single active
  // session on this board would silently adopt a foreign claim (observed cross-terminal
  // collision 2026-04-22 where a second claude TTY inherited the first TTY's doing ticket).
  // Fail closed — the caller surfaces a clear "claim/resume first" error.
  return null;
}

function getOrCreateSessionToken(provider) {
  const fingerprint = runtimeSessionFingerprint(provider);
  const tokenFile = sessionTokenPath(provider);
  const activeProviderSessions = findActiveProviderSessions(provider);
  const activeSessions = activeProviderSessions.length;
  const existing = tokenFile ? readFreshSessionToken(tokenFile) : null;
  if (existing?.thread_id) {
    return existing.thread_id;
  }
  const legacy = readFreshSessionToken(sessionTokenPath(provider, { legacy: true }));
  if (legacy?.thread_id && countActiveSessionsForProvider(provider) <= 1) {
    if (tokenFile) {
      ensureParentDir(tokenFile);
      fs.writeFileSync(tokenFile, JSON.stringify(legacy) + "\n", "utf8");
      if (sessionTokenPath(provider, { legacy: true }) !== tokenFile) {
        fs.rmSync(sessionTokenPath(provider, { legacy: true }), { force: true });
      }
    }
    return legacy.thread_id;
  }
  // (COORD-010) When no stable runtime anchor exists, drain stale provider
  // stubs (auto-claimed regardless of age, manual claims past 24h) before
  // minting. The cap that previously fired here was redundant defense-in-depth
  // once COORD-011 anchored the Claude Code fingerprint via the claude-ancestor
  // walk; outside Claude Code, the foreign-adoption guard in
  // resolveEffectiveThreadId and the explicit --owner requirement on
  // ticket-mutating claims remain the safety floor. A freshly-minted token
  // here only buys this thread a thread_id — it cannot adopt a foreign
  // doing/review ticket without an explicit claim.
  if (!fingerprint && activeSessions >= 1) {
    reapIdleAutoClaimedProviderStubs({
      provider,
      includeManualStaleAfterMs: 24 * 60 * 60 * 1000,
    });
  }
  const threadId = `${provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  ensureParentDir(tokenFile);
  fs.writeFileSync(
    tokenFile,
    JSON.stringify({ provider, thread_id: threadId, created_at: new Date().toISOString() }) + "\n",
    "utf8"
  );
  return threadId;
}

function ensureCurrentAgentIdentity(options = {}) {
  const allowAutoClaim = options.allowAutoClaim === true;
  const touchSession = options.touchSession !== false;
  return withAgentStateLock(() => {
    const provider = detectRuntimeProvider();
    const threadId = allowAutoClaim
      ? resolveOrCreateEffectiveThreadId()
      : resolveEffectiveThreadId();
    if (!threadId) {
      const threadVars = PROVIDER_REGISTRY.flatMap((e) => providerThreadEnvNames(e)).join(", ");
      fail(
        allowAutoClaim
          ? "No stable runtime thread id is available for automatic agent assignment. " +
            `Set one of: ${threadVars}, or AGENT_THREAD_ID in the environment.`
          : "No active claimed agent session for this thread. " +
            "Bind explicitly with `claim --owner <handle|simple-id>` (human approval), " +
            "run `coord/scripts/gov resume <ticket-id>` when resuming an active ticket, or use --owner on lifecycle commands."
      );
    }

    const agents = readAgentsRegistry();
    const sessions = readAgentSessions();
    const existingSession = sessions.find((session) =>
      session.thread_id === threadId &&
      session.board_path === state.BOARD_PATH &&
      session.status === "active"
    );
    if (existingSession) {
      const existingAgent = agents.find((agent) => agent.handle === existingSession.handle) || null;
      if (!existingAgent) {
        fail(`Active session ${existingSession.session_id} points at unknown agent ${existingSession.handle}.`);
      }
      assertRuntimeProviderMatchesAgent(existingAgent);
      if (touchSession) {
        existingSession.last_seen_at = new Date().toISOString();
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
      }
      const identity = { agent: existingAgent, session: existingSession, autoClaimed: false, autoRegistered: false };
      return identity;
    }

    if (!allowAutoClaim) {
      fail(
        "No active claimed agent session for this thread. " +
        "Bind explicitly with `claim --owner <handle|simple-id>` (human approval), " +
        "run `coord/scripts/gov resume <ticket-id>` when resuming an active ticket, or use --owner on lifecycle commands."
      );
    }

    const nextId = allocateLiveSessionId(sessions, provider);
    let agent = agents.find((candidate) => candidate.id === nextId) || null;

    let autoRegistered = false;
    if (!agent) {
      agent = autoRegisterAgent(agents, nextId, provider);
      autoRegistered = true;
      writeAgentRegistryFile(agents);
    }

    const now = new Date().toISOString();
    const session = {
      session_id: buildSessionId(agent),
      agent_id: agent.id,
      handle: agent.handle,
      session_label: `auto:${threadId.slice(0, 8)}`,
      host: defaultHostLabel(),
      cwd: process.cwd(),
      board_path: state.BOARD_PATH,
      board_root: COORD_DIR,
      thread_id: threadId,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: true,
    };
    sessions.push(session);
    writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
    const identity = { agent, session, autoClaimed: true, autoRegistered };
    return identity;
  });
}

function resolveOwnerIdentity(ownerInput, options = {}) {
  if (ownerInput) {
    const handle = canonicalizeOwnerOrFail(ownerInput);
    const agent = resolveAgentIdentifier(handle, readAgentsRegistry())?.agent || null;
    if (agent) {
      assertRuntimeProviderMatchesAgent(agent, options);
    }
    const effectiveThread = resolveEffectiveThreadId();
    let session = effectiveThread
      ? readAgentSessions().find((candidate) =>
        candidate.thread_id === effectiveThread &&
        candidate.handle === handle &&
        candidate.board_path === state.BOARD_PATH &&
        candidate.status === "active"
      ) || null
      : null;
    if (options.requireCurrentSession === true && !session) {
      fail(
        `Owner ${handle} is not bound to the current claimed session. ` +
        `Run \`coord/scripts/gov claim --owner ${handle}\` or \`coord/scripts/gov claim <ticket-id> --force\` first.`
      );
    }
    return { agent, session, autoClaimed: false, autoRegistered: false };
  }
  return ensureCurrentAgentIdentity(options);
}


// COORD-128: the canonical, fail-closed remediation for a governed MUTATION
// attempted by a session that is not a registered agent AND/OR not the bound
// owner of the ticket. Centralized here so every gated mutation surfaces the
// same actionable next-steps (register -> bind -> recover) rather than ad-hoc
// per-verb prose. The unregistered/unbound state is exactly the condition that
// let governed work drift back to todo/unassigned because reconciliation could
// not attribute it to an owner; the guard below refuses to let work proceed in
// an un-ownable state.
function registeredBoundOwnerRemediation(ticketId, expectedOwner = null) {
  const ownerHint = expectedOwner && expectedOwner !== "unassigned" ? expectedOwner : "<handle>";
  return (
    `This session is not a registered agent / not the bound owner of ${ticketId}. ` +
    "Register with `coord/scripts/gov agentid --assign`, then bind with " +
    `\`coord/scripts/gov start ${ticketId} --owner ${ownerHint}\` ` +
    `(or \`coord/scripts/gov resume ${ticketId}\` / \`coord/scripts/gov agent-rebind --fresh\` ` +
    "for handoff/collisions)."
  );
}

function describeTicketMutationOwnershipIssue(ticketId, row, lock = null) {
  const expectedOwner = canonicalizeOwnerOrFail(row.Owner);
  let identity = null;
  try {
    identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
  } catch (error) {
    if (!(error instanceof GovernanceError)) {
      throw error;
    }
    return {
      code: "no_active_session",
      message: registeredBoundOwnerRemediation(ticketId, expectedOwner),
      next_steps: [
        `coord/scripts/gov agentid --assign`,
        `coord/scripts/gov start ${ticketId} --owner ${expectedOwner}`,
        `coord/scripts/gov resume ${ticketId}`,
      ],
      identity: null,
    };
  }
  if (identity.agent.handle !== expectedOwner) {
    const expectedOwnerSession = findActiveSessionForHandle(expectedOwner);
    return {
      code: "owner_mismatch",
      message:
        `Ticket ${ticketId} is owned by ${expectedOwner}. ` +
        `Current session is ${identity.agent.handle} (${identity.agent.id}) and cannot mutate it. ` +
        (expectedOwnerSession?.session_id ? `Recorded active session for ${expectedOwner}: ${expectedOwnerSession.session_id}. ` : "") +
        `If this is a legitimate session handoff or recovery, run \`coord/scripts/gov resume ${ticketId}\` ` +
        `(or \`coord/scripts/gov agent-rebind --fresh\` / \`coord/scripts/gov claim ${ticketId} --force\`) first.`,
      next_steps: [
        `coord/scripts/gov resume ${ticketId}`,
        `coord/scripts/gov claim --owner ${expectedOwner}`,
        `coord/scripts/gov agent-rebind --fresh`,
        `coord/scripts/gov recover ${ticketId}`,
      ],
      identity,
    };
  }
  if (lock && !ownerMatches(lock.owner, identity.agent.handle)) {
    return {
      code: "lock_owner_mismatch",
      message: `Lock for ${ticketId} is owned by ${lock.owner}, not ${identity.agent.handle}. Run \`coord/scripts/gov recover ${ticketId}\` to repair the governed lock.`,
      next_steps: [`coord/scripts/gov recover ${ticketId}`],
      identity,
    };
  }
  // GCV-1 Phase-4: route the live-mutation gate through the v2 owner-lease
  // model WHEN the durable identity channel is present. O5 migration rule:
  // legacy lock.session_id stays readable but is IGNORED for authority
  // under v2; GCV-1 deletes nothing. When the channel is absent, the
  // pre-v2 session-token check is preserved verbatim so the live
  // downstream fleet and existing flows are unaffected.
  const envIdent = identityV2.readEnvIdentity();
  if (envIdent.present) {
    let reg;
    try {
      reg = identityV2.readRegistry(state.RUNTIME_DIR);
    } catch {
      reg = identityV2.emptyRegistry();
    }
    const v2 = identityV2.assertCanMutate(
      reg,
      envIdent,
      {
        owner: identity.agent.handle,
        ticketOwner: expectedOwner,
        // owner already validated == expectedOwner above; this layer only
        // enforces the live owner-lease (holder / split-brain / revoked).
        requireTicketOwner: false,
      }
    );
    if (!v2.decision.allowed) {
      return {
        code: `v2_${v2.decision.action}`,
        message:
          `${v2.decision.message} ` +
          `(ticket ${ticketId}; owner ${expectedOwner})`,
        next_steps: [
          `coord/scripts/gov claim --owner ${expectedOwner}`,
          `coord/scripts/gov claim --owner ${expectedOwner} --handoff`,
        ],
        identity,
      };
    }
    try {
      identityV2.writeRegistry(state.RUNTIME_DIR, v2.registry);
    } catch {
      // Best-effort heartbeat/lease persist; the authority decision is
      // already made. Never wedge an authorized mutation on a runtime
      // write failure (diagnostics, not gate).
    }
    return { code: "ok", message: null, next_steps: [], identity };
  }
  if (lock && lock.session_id && identity.session?.session_id !== lock.session_id) {
    return {
      code: "session_mismatch",
      message:
        `Lock for ${ticketId} is bound to session ${lock.session_id}. ` +
        `Current session is ${identity.session?.session_id || "none"}. ` +
        `If you are resuming this ticket in the current thread, run \`coord/scripts/gov resume ${ticketId}\` ` +
        `(or \`coord/scripts/gov claim ${ticketId} --force\`). ` +
        `If the lock/worktree state drifted, run \`coord/scripts/gov recover ${ticketId}\`.`,
      next_steps: [
        `coord/scripts/gov resume ${ticketId}`,
        `coord/scripts/gov recover ${ticketId}`,
      ],
      identity,
    };
  }
  return { code: "ok", message: null, next_steps: [], identity };
}

function assertTicketMutationOwnership(ticketId, row, lock = null) {
  const evaluation = describeTicketMutationOwnershipIssue(ticketId, row, lock);
  if (evaluation.code !== "ok") {
    fail(evaluation.message);
  }
  return evaluation.identity;
}

// COORD-128: the single, named, fail-closed precondition that the operating
// model references. A governed MUTATION must refuse to proceed unless the
// acting session is BOTH a registered agent AND the bound owner of the ticket,
// so work can never be performed in an un-ownable state that later drifts to
// todo/unassigned. This delegates to describeTicketMutationOwnershipIssue (the
// real owner/lease/session authority) and is the public name the lifecycle
// mutations and docs point at. Read-only verbs (explain/conform/doctor/agents
// list) and the binding/recovery verbs themselves (start/claim/resume/
// agent-rebind/agentid/takeover) deliberately do NOT call this — they are how a
// session BECOMES a registered, bound owner in the first place.
function assertRegisteredBoundOwner(ticketId, row, lock = null) {
  return assertTicketMutationOwnership(ticketId, row, lock);
}

function ensureTicketMutationOwnership(ticketId, row, lock = null, options = {}) {
  const expectedOwner = canonicalizeOwnerOrFail(row.Owner);
  if (options.owner) {
    const requestedOwner = canonicalizeOwnerOrFail(options.owner);
    if (requestedOwner !== expectedOwner) {
      fail(`Ticket ${ticketId} is owned by ${expectedOwner}; received --owner ${requestedOwner}.`);
    }
  }
  const evaluation = describeTicketMutationOwnershipIssue(ticketId, row, lock);
  if (evaluation.code === "ok") {
    return evaluation.identity;
  }
  fail(evaluation.message);
}


function assertTicketRepairOwnership(ticketId, row, options = {}) {
  const expectedOwner = canonicalizeOwnerOrFail(row.Owner);
  const identity = options.owner
    ? resolveOwnerIdentity(options.owner, { allowAutoClaim: false, requireCurrentSession: true, touchSession: false })
    : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
  if (identity.agent.handle !== expectedOwner) {
    fail(
      `Ticket ${ticketId} is owned by ${expectedOwner}. ` +
      `Current session is ${identity.agent.handle} (${identity.agent.id}) and cannot repair it. ` +
      `If this is a legitimate handoff or recovery, run \`coord/scripts/gov claim ${ticketId} --force\` first.`
    );
  }
  return identity;
}

function autoRegisterAgent(agents, id = allocateAgentSimpleId(agents), provider = "unknown") {
  const config = providerConfig(provider);
  const prefix = config ? config.handlePrefix : "agent";
  const handle = `${prefix}${id}`;
  const agent = {
    id,
    handle,
    provider: provider,
    status: "active",
    aliases: [],
    notes: "Auto-registered recyclable session id",
    created_at: new Date().toISOString(),
  };
  agents.push(agent);
  return agent;
}

function allocateLiveSessionId(sessions, provider = "unknown") {
  return allocateAgentSimpleId(readAgentsRegistry(), {
    sessions,
    board: safeReadJson(state.BOARD_PATH),
  });
}

function normalizeAgentSessions(rawSessions) {
  let changed = false;
  const now = Date.now();
  const sessions = rawSessions.map((session) => {
    const next = { ...session };
    if (!next.board_path) {
      next.board_path = state.BOARD_PATH;
      next.board_root = COORD_DIR;
      changed = true;
    }
    const lastSeen = Date.parse(next.last_seen_at || next.claimed_at || 0);
    if (
      next.status === "active" &&
      Number.isFinite(lastSeen) &&
      now - lastSeen > AGENT_SESSION_IDLE_MS
    ) {
      next.status = "expired";
      next.released_at = new Date(now).toISOString();
      changed = true;
    }
    return next;
  });
  return { sessions, changed };
}

function findActiveSessionForHandle(handle) {
  const sessions = readAgentSessions()
    .filter((session) => session.handle === handle && session.board_path === state.BOARD_PATH && session.status === "active")
    .sort((left, right) => String(right.claimed_at).localeCompare(String(left.claimed_at)));
  return sessions[0] || null;
}

function touchActiveSession(handle, sessionId) {
  if (!handle || !sessionId) {
    return;
  }
  withAgentStateLock(() => {
    const sessions = readAgentSessions();
    const match = sessions.find((session) =>
      session.status === "active" &&
      session.board_path === state.BOARD_PATH &&
      session.session_id === sessionId &&
      session.handle === handle
    );
    if (!match) {
      return;
    }
    match.last_seen_at = new Date().toISOString();
    writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
  });
}


function writeLock({ ticketId, owner, repoCode, branch, worktree, now, repoName, session }) {
  const canonicalOwner = normalizeOwnerValue(owner);
  const timestamp = now || new Date().toISOString();
  const repo = repoName || repoNameForCode(repoCode);
  const head = resolveLockHead(repoCode, worktree);
  const agent = resolveAgentIdentifier(canonicalOwner, readAgentsRegistry())?.agent || null;
  const activeSession =
    session?.status === "active" &&
    session.board_path === state.BOARD_PATH &&
    session.handle === canonicalOwner
      ? session
      : null;
  const lockPath = path.join(state.LOCKS_DIR, `${ticketId}.lock`);
  ensureParentDir(lockPath);
  // GCV-1 Phase-6 lock-write migration (O5): under the durable v2 channel
  // the lock is OWNER-authoritative — it no longer emits session_id as an
  // authority field, and is tagged identity_model:"v2" so readers/doctor
  // know the absence is intentional. When the channel is absent, the
  // legacy session_id binding is preserved verbatim (fleet-safe; GCV-1
  // deletes nothing and old locks stay fully readable).
  const v2Channel = identityV2.readEnvIdentity().present;
  const lockPayload = {
    agent_id: agent?.id || null,
    owner: canonicalOwner,
    ticket: ticketId,
    status: STATUS.DOING,
    repo,
    branch,
    head,
    worktree,
    session_id: v2Channel ? null : activeSession?.session_id || null,
    started_at_utc: timestamp,
    heartbeat_utc: timestamp,
  };
  if (v2Channel) {
    lockPayload.identity_model = "v2";
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, "utf8");
}

function isCompleteLockPayload(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    return false;
  }
  const requiredFields = [
    "ticket",
    "status",
    "repo",
    "branch",
    "head",
    "worktree",
    "started_at_utc",
  ];
  return requiredFields.every((field) => typeof lock[field] === "string" && lock[field].trim().length > 0);
}

function rebindTicketLock(lock, agent, session) {
  if (!lock?.path) {
    return null;
  }
  const nextPath = moveFileIfNeeded(lock.path, path.join(state.LOCKS_DIR, path.basename(lock.path)));
  // GCV-1 Phase-6: a rebind must not DOWNGRADE a v2 owner-authoritative
  // lock back to a legacy session-authority lock. If the durable channel
  // is present or the lock is already identity_model:"v2", keep it
  // owner-authoritative (session_id null, v2 tag retained).
  const v2Lock = identityV2.readEnvIdentity().present || lock.identity_model === "v2";
  const next = {
    ...lock,
    agent_id: agent?.id || null,
    owner: agent?.handle || lock.owner,
    session_id: v2Lock ? null : session?.session_id || null,
    heartbeat_utc: new Date().toISOString(),
  };
  if (v2Lock) {
    next.identity_model = "v2";
  }
  delete next.path;
  fs.writeFileSync(nextPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    path: nextPath,
    session_id: session?.session_id || null,
    owner: agent?.handle || lock.owner,
  };
}


function shouldUseLegacyAgentSessionsCompatibility() {
  return (
    path.basename(state.AGENT_SESSIONS_PATH) === "agent_sessions.json" &&
    path.basename(path.dirname(state.AGENT_SESSIONS_PATH)) === ".runtime"
  );
}


  return {
    PROVIDER_REGISTRY,
    allocateAgentSimpleId,
    allocateLiveSessionId,
    assertRuntimeProviderMatchesAgent,
    assertRegisteredBoundOwner,
    assertTicketMutationOwnership,
    assertTicketRepairOwnership,
    buildActiveSameOwnerOtherThreadMessage,
    buildDefaultAgentHandle,
    buildSessionId,
    canOwnerHoldConcurrentDoing,
    canonicalizeOwnerOrFail,
    collectReferencedAgentIdNumbers,
    currentRuntimeThreadId,
    defaultAgentRegistry,
    defaultHostLabel,
    describeTicketMutationOwnershipIssue,
    detectActiveSameOwnerOtherThread,
    detectRuntimeProvider,
    ensureAgentFiles,
    ensureCurrentAgentIdentity,
    ensureTicketMutationOwnership,
    findActiveProviderSessions,
    findActiveSessionForHandle,
    findDoingTicketForOwner,
    formatAgentSimpleId,
    formatGovernanceJournalUninitializedMessage,
    getOrCreateSessionToken,
    heartbeatAgeMsForSession,
    isCompleteLockPayload,
    isDoingStatus,
    isRegisteredAgentHandle,
    maybeCanonicalOwner,
    normalizeAgentSessions,
    normalizeBoardIdentityReferences,
    normalizeLockIdentityReferences,
    normalizeOwnerValue,
    ownerMatches,
    parseAgentSimpleIdNumber,
    providerConfig,
    providerThreadEnvNames,
    providerThreadIdValue,
    readAgentSessions,
    readAgentsRegistry,
    rebindTicketLock,
    resolveAgentIdentifier,
    resolveEffectiveThreadId,
    resolveLegacyAgentsCompatibilityPath,
    resolveOrCreateEffectiveThreadId,
    resolveOwnerIdentity,
    runtimeHasStableSessionIdentity,
    runtimeSessionFingerprint,
    sessionTokenPath,
    shouldUseLegacyAgentSessionsCompatibility,
    summarizeRecentOwnerLeaseEvidence,
    touchActiveSession,
    writeAgentRegistryFile,
    writeLock,
  };
}

module.exports = createGovernanceSession;
