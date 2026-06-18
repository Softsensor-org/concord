const path = require("path");
const fs = require("fs");

// GCV-4 slice 1: engine/config seam.
//
// Project-specific repo layout used to live as inline constants in this
// file (REPO_REGISTRY / LEGACY_REPO_ALIASES). Every consumer had to
// hand-edit them and every upstream change replayed the merge. Now this
// file is engine-managed and reads the project-owned `coord/project.config.js`.
// Engine internals derive `repoRoots`, `repoIntegrationBranches`,
// `repoRegistry`, and `legacyRepoAliases` from that config.
//
// See coord/docs/GCV4_ENGINE_CONFIG_SEAM.md for the full contract.

const DEFAULT_INTEGRATION_BRANCH = "dev";
const DEFAULT_REQUIREMENTS_PATH = "product/REQUIREMENTS.md";
const DEFAULT_COORD_TICKET_PREFIX = "COORD";

// Transitional fallback: the template default config, used only when no
// project.config.js can be located AND no `projectConfig` was passed in.
// Existing tests that construct `createCoordPaths({coordDir: "/tmp/coord"})`
// without writing a config file rely on this default. Will be removed once
// all consumers adopt the GCV-4 library model — at that point a missing
// config should fail-closed at load.
const TEMPLATE_DEFAULT_CONFIG = Object.freeze({
  coordTicketPrefix: DEFAULT_COORD_TICKET_PREFIX,
  repos: {
    B: { path: "backend", integrationBranch: DEFAULT_INTEGRATION_BRANCH, origin: null, legacyAliases: [], ticketPrefixes: ["MSRV"], testCommand: "npm run test:ci" },
    F: { path: "frontend", integrationBranch: DEFAULT_INTEGRATION_BRANCH, origin: null, legacyAliases: [], ticketPrefixes: ["FE"], testCommand: "npm run test:ci" },
  },
  requirements: { path: DEFAULT_REQUIREMENTS_PATH },
});

// COORD-010: the config-matrix seam. When `COORD_PROJECT_CONFIG` is set in
// the environment, the engine loads THAT file as the project config instead
// of `coord/project.config.js`. This lets CI (and `node --test`) run the full
// governance suite against a synthetic non-default repo registry — a 7-repo
// layout on a non-`dev` integration branch — so config-sensitive assumptions
// fail in CI rather than late in a downstream workspace. The path may be
// absolute or relative to the process CWD. An unset/empty var preserves the
// default `coord/project.config.js` behavior exactly.
function resolveProjectConfigPath(coordDir) {
  const override = process.env.COORD_PROJECT_CONFIG;
  if (typeof override === "string" && override.trim() !== "") {
    return path.resolve(override.trim());
  }
  return path.join(coordDir, "project.config.js");
}

function loadProjectConfig(coordDir, options = {}) {
  // COORD-010: `forceDefault` bypasses the `COORD_PROJECT_CONFIG` matrix
  // override and reads only the coordDir-local `project.config.js`. The board
  // validator (board.js) uses this so it stays bound to THIS coord checkout's
  // real registry even when the governance suite is run under a synthetic
  // fixture registry — the validator must not reinterpret the real coord
  // board through a fake config.
  const configPath = options.forceDefault
    ? path.join(coordDir, "project.config.js")
    : resolveProjectConfigPath(coordDir);
  if (!fs.existsSync(configPath)) return null;
  // Always clear the cache so tests that mutate a config file between
  // calls don't see a stale module.
  try {
    delete require.cache[require.resolve(configPath)];
  } catch {
    /* require.resolve may throw on first load; ignore */
  }
  return require(configPath);
}

// COORD-104: validateProjectConfig was a single ~44-complexity guard ladder.
// Extracted into cohesive per-section validators below. Each validator throws
// the SAME error message in the SAME order as the original inline checks —
// behavior parity is byte-for-byte; only the lexical grouping changed.

// COORD-082 (CONTRACT-002): optional, backward-compatible `contract` block
// binding this repo to the OpenAPI artifact it generates a client from. The
// shape is validated (and resolved) by coord/scripts/contract-policy.js so the
// policy stays single-sourced; here we only reject an obviously malformed block
// so a typo fails at config-load rather than gate time.
function validateRepoContractBlock(code, entry) {
  if (entry.contract === undefined || entry.contract === null) return;
  if (typeof entry.contract !== "object" || Array.isArray(entry.contract)) {
    throw new Error(`project.config.js: repos.${code}.contract must be an object when provided`);
  }
  for (const key of ["sourceRepo", "sourcePath", "generatedPath"]) {
    if (typeof entry.contract[key] !== "string" || entry.contract[key].trim() === "") {
      throw new Error(
        `project.config.js: repos.${code}.contract.${key} must be a non-empty string when contract is provided`
      );
    }
  }
}

function validateRepoTicketPrefixes(code, entry) {
  if (entry.ticketPrefixes === undefined) return;
  if (!Array.isArray(entry.ticketPrefixes)) {
    throw new Error(`project.config.js: repos.${code}.ticketPrefixes must be an array when provided`);
  }
  for (const prefix of entry.ticketPrefixes) {
    if (typeof prefix !== "string" || prefix.trim() === "") {
      throw new Error(`project.config.js: repos.${code}.ticketPrefixes entries must be non-empty strings`);
    }
  }
}

function validateRepoCode(code) {
  if (code === "X") {
    throw new Error(
      `project.config.js: repo code "X" is reserved for cross-repo / coord work and must not appear in repos`
    );
  }
  if (!/^[A-Z]$/.test(code)) {
    throw new Error(
      `project.config.js: repo code "${code}" must be a single uppercase letter`
    );
  }
}

// Scalar field checks that appear BEFORE the ticketPrefixes loop in the
// original ladder. testCommand is checked separately (after ticketPrefixes)
// to preserve the original throw ORDER when multiple fields are invalid.
function validateRepoLeadingScalars(code, entry) {
  if (typeof entry.path !== "string" || entry.path.trim() === "") {
    throw new Error(`project.config.js: repos.${code}.path must be a non-empty string`);
  }
  if (entry.integrationBranch !== undefined && typeof entry.integrationBranch !== "string") {
    throw new Error(`project.config.js: repos.${code}.integrationBranch must be a string when provided`);
  }
  if (entry.origin !== undefined && entry.origin !== null && typeof entry.origin !== "string") {
    throw new Error(`project.config.js: repos.${code}.origin must be a string or null when provided`);
  }
  if (entry.legacyAliases !== undefined && !Array.isArray(entry.legacyAliases)) {
    throw new Error(`project.config.js: repos.${code}.legacyAliases must be an array when provided`);
  }
}

function validateRepoEntry(code, entry) {
  validateRepoCode(code);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`project.config.js: repos.${code} must be an object`);
  }
  validateRepoLeadingScalars(code, entry);
  validateRepoTicketPrefixes(code, entry);
  if (entry.testCommand !== undefined && typeof entry.testCommand !== "string") {
    throw new Error(`project.config.js: repos.${code}.testCommand must be a string when provided`);
  }
  validateRepoContractBlock(code, entry);
}

function validateTopLevelOptionals(config) {
  if (config.coordTicketPrefix !== undefined) {
    if (typeof config.coordTicketPrefix !== "string" || config.coordTicketPrefix.trim() === "") {
      throw new Error("project.config.js: `coordTicketPrefix` must be a non-empty string when provided");
    }
  }
  if (config.requirements !== undefined) {
    if (typeof config.requirements !== "object" || Array.isArray(config.requirements)) {
      throw new Error("project.config.js: `requirements` must be an object when provided");
    }
    if (config.requirements.path !== undefined && typeof config.requirements.path !== "string") {
      throw new Error("project.config.js: `requirements.path` must be a string when provided");
    }
  }
}

function validateProjectConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("project.config.js must export an object");
  }
  if (!config.repos || typeof config.repos !== "object" || Array.isArray(config.repos)) {
    throw new Error("project.config.js: `repos` must be an object");
  }
  for (const [code, entry] of Object.entries(config.repos)) {
    validateRepoEntry(code, entry);
  }
  validateTopLevelOptionals(config);
  return config;
}

function normalizeProjectConfig(config) {
  const repos = {};
  for (const [code, entry] of Object.entries(config.repos)) {
    repos[code] = {
      path: entry.path,
      integrationBranch:
        typeof entry.integrationBranch === "string" && entry.integrationBranch.trim() !== ""
          ? entry.integrationBranch
          : DEFAULT_INTEGRATION_BRANCH,
      origin: entry.origin === undefined ? null : entry.origin,
      legacyAliases: Array.isArray(entry.legacyAliases) ? [...entry.legacyAliases] : [],
      ticketPrefixes: Array.isArray(entry.ticketPrefixes)
        ? entry.ticketPrefixes.map((p) => String(p).trim()).filter(Boolean)
        : [],
      testCommand:
        typeof entry.testCommand === "string" && entry.testCommand.trim() !== ""
          ? entry.testCommand
          : null,
      // COORD-082: preserve the optional contract block (or null) so
      // contract-policy.js can resolve the OpenAPI source via repoRoots.
      contract:
        entry.contract && typeof entry.contract === "object" && !Array.isArray(entry.contract)
          ? {
              sourceRepo: entry.contract.sourceRepo,
              sourcePath: entry.contract.sourcePath,
              generatedPath: entry.contract.generatedPath,
            }
          : null,
    };
  }
  const requirementsPath =
    (config.requirements && typeof config.requirements.path === "string" && config.requirements.path) ||
    DEFAULT_REQUIREMENTS_PATH;
  const coordTicketPrefix =
    typeof config.coordTicketPrefix === "string" && config.coordTicketPrefix.trim() !== ""
      ? config.coordTicketPrefix.trim()
      : DEFAULT_COORD_TICKET_PREFIX;
  return { repos, requirements: { path: requirementsPath }, coordTicketPrefix };
}

function resolveProjectConfig(coordDir, override, options = {}) {
  if (override !== undefined) {
    return normalizeProjectConfig(validateProjectConfig(override));
  }
  const loaded = loadProjectConfig(coordDir, { forceDefault: Boolean(options.forceDefault) });
  if (loaded !== null) {
    return normalizeProjectConfig(validateProjectConfig(loaded));
  }
  // Transitional fallback only — see TEMPLATE_DEFAULT_CONFIG above.
  return normalizeProjectConfig(TEMPLATE_DEFAULT_CONFIG);
}

function createCoordPaths(options = {}) {
  const coordDir = options.coordDir || __dirname;
  const rootDir = options.rootDir || path.dirname(coordDir);
  const boardDir = path.join(coordDir, "board");
  const renderedDir = path.join(coordDir, "rendered");
  const runtimeDir = options.runtimeDir || path.join(coordDir, ".runtime");
  const legacyLocksDir = path.join(coordDir, "locks");
  const legacyAgentSessionsPath = path.join(coordDir, "agent_sessions.json");
  const sessionThreadsDir = path.join(runtimeDir, "session-threads");

  const config = resolveProjectConfig(coordDir, options.projectConfig, {
    forceDefault: Boolean(options.forceProjectConfig),
  });

  const repoRoots = {};
  const repoOrigins = {};
  const repoIntegrationBranches = {};
  const repoRegistry = {};
  const legacyRepoAliases = {};
  const repoTestCommands = {};
  const ticketPrefixToRepoCode = {};
  for (const [code, entry] of Object.entries(config.repos)) {
    repoRoots[code] = path.isAbsolute(entry.path) ? entry.path : path.join(rootDir, entry.path);
    repoOrigins[code] = entry.origin;
    repoIntegrationBranches[code] = entry.integrationBranch;
    repoRegistry[code] = entry.path;
    legacyRepoAliases[code] = [...entry.legacyAliases];
    repoTestCommands[code] = entry.testCommand || null;
    for (const prefix of entry.ticketPrefixes) {
      // Normalize to a trailing-hyphen, uppercased prefix key so callers can
      // match "FE-123" against "FE". First config wins on duplicate prefixes.
      const key = String(prefix).trim().toUpperCase().replace(/-+$/, "");
      if (key && !(key in ticketPrefixToRepoCode)) {
        ticketPrefixToRepoCode[key] = code;
      }
    }
  }
  const coordTicketPrefix = config.coordTicketPrefix;
  const requirementsPath = path.isAbsolute(config.requirements.path)
    ? config.requirements.path
    : path.join(coordDir, config.requirements.path);

  return {
    coordDir,
    rootDir,
    boardDir,
    renderedDir,
    boardPath: path.join(boardDir, "tasks.json"),
    tasksSchemaPath: path.join(boardDir, "tasks.schema.json"),
    planRecordSchemaPath: path.join(boardDir, "plan.schema.json"),
    planRecordsDir: path.join(runtimeDir, "plans"),
    legacyPlanRecordsDir: path.join(boardDir, "plans"),
    renderedTasksMdPath: path.join(renderedDir, "TASKS.md"),
    renderedPromptIndexMdPath: path.join(renderedDir, "PROMPT_INDEX.md"),
    tasksMdPath: path.join(coordDir, "TASKS.md"),
    promptIndexMdPath: path.join(coordDir, "PROMPT_INDEX.md"),
    planPath: path.join(coordDir, "PLAN.md"),
    questionsPath: path.join(coordDir, "QUESTIONS.md"),
    agentsPath: path.join(runtimeDir, "agents.json"),
    legacyAgentsPath: path.join(coordDir, "agents.json"),
    agentSessionsPath: path.join(runtimeDir, "agent_sessions.json"),
    legacyAgentSessionsPath,
    locksDir: path.join(runtimeDir, "locks"),
    legacyLocksDir,
    runtimeDir,
    // COORD-092: gate process-orphan containment registry. Each governed gate
    // run that launches heavy child processes records a pidfile entry here so a
    // crash/OOM-kill leaves a recoverable, PROVENANCE-SCOPED record the reaper
    // can act on. Lives under .runtime (gitignored — runtime output, not tracked).
    gateProcsDir: path.join(runtimeDir, "gate-procs"),
    sessionThreadsDir,
    governanceEventLogPath: path.join(runtimeDir, "governance-events.ndjson"),
    governanceSnapshotPath: path.join(runtimeDir, "governance-latest-snapshot.json"),
    governanceSnapshotsDir: path.join(runtimeDir, "governance-snapshots"),
    governanceEventLockDir: path.join(runtimeDir, "governance.lock"),
    agentStateLockDir: path.join(coordDir, ".agent-state.lock"),
    coordStateLockDir: path.join(coordDir, ".coord-state.lock"),
    requirementsPath,
    repoRoots,
    repoOrigins,
    repoIntegrationBranches,
    repoRegistry,
    legacyRepoAliases,
    repoTestCommands,
    ticketPrefixToRepoCode,
    coordTicketPrefix,
    projectConfig: config,
  };
}

function allBoardRepoCodes(paths = createCoordPaths()) {
  const repoRoots = (paths && paths.repoRoots) || {};
  return [...new Set([...Object.keys(repoRoots), "X"])].sort();
}

module.exports = {
  createCoordPaths,
  allBoardRepoCodes,
  // Config-seam helpers exported for tests and migration tooling.
  loadProjectConfig,
  resolveProjectConfigPath,
  validateProjectConfig,
  normalizeProjectConfig,
  resolveProjectConfig,
  TEMPLATE_DEFAULT_CONFIG,
  DEFAULT_INTEGRATION_BRANCH,
  DEFAULT_COORD_TICKET_PREFIX,
};
