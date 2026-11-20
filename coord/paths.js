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
// See coord/engine/docs/GCV4_ENGINE_CONFIG_SEAM.md for the full contract.

const DEFAULT_INTEGRATION_BRANCH = "dev";
const DEFAULT_REQUIREMENTS_PATH = "product/REQUIREMENTS.md";
const DEFAULT_COORD_TICKET_PREFIX = "COORD";
// COORD-895: the coord workspace (board) branch when project.config.js does not
// set `boardBranch`. The ONLY engine literal for it outside the hook fail-closed
// fallback: every other engine site reads the configured value.
const DEFAULT_BOARD_BRANCH = "main";
// A conservative git branch-name shape (git check-ref-format is stricter still).
// COORD-894: how finalize/land publishes the board commit.
const BOARD_LANDING_MODES = Object.freeze(["push", "pr"]);
// COORD-894: how long PR landing waits for the board PR to merge (seconds).
const DEFAULT_BOARD_LANDING_WAIT_SECONDS = 300;
const BOARD_BRANCH_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<![./])$/;

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
// shape is validated (and resolved) by coord/engine/scripts/contract-policy.js so the
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
  if (entry.startBaseRef !== undefined && entry.startBaseRef !== null && typeof entry.startBaseRef !== "string") {
    throw new Error(`project.config.js: repos.${code}.startBaseRef must be a string when provided`);
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

// COORD-895: `boardBranch` names a local branch, never a remote-tracking ref.
function validateBoardBranch(value) {
  if (value === undefined || value === null) return;
  const name = typeof value === "string" ? value.trim() : "";
  if (!BOARD_BRANCH_PATTERN.test(name) || /^(?:origin\/|refs\/)/.test(name)) {
    throw new Error("project.config.js: `boardBranch` must be a plain branch name (e.g. \"main\") when provided");
  }
}

// COORD-894: boardLanding mode and the PR-landing wait.
function validateBoardLanding(config) {
  if (config.boardLanding !== undefined && config.boardLanding !== null && !BOARD_LANDING_MODES.includes(config.boardLanding)) {
    throw new Error('project.config.js: `boardLanding` must be "push" or "pr" when provided');
  }
  const wait = config.boardLandingWaitSeconds;
  if (wait !== undefined && wait !== null && !(Number.isInteger(wait) && wait >= 0 && wait <= 3600)) {
    throw new Error("project.config.js: `boardLandingWaitSeconds` must be an integer from 0 to 3600 when provided");
  }
}

function validateTopLevelOptionals(config) {
  if (config.coordTicketPrefix !== undefined) {
    if (typeof config.coordTicketPrefix !== "string" || config.coordTicketPrefix.trim() === "") {
      throw new Error("project.config.js: `coordTicketPrefix` must be a non-empty string when provided");
    }
  }
  if (
    config.defaultStartBaseRef !== undefined &&
    config.defaultStartBaseRef !== null &&
    typeof config.defaultStartBaseRef !== "string"
  ) {
    throw new Error("project.config.js: `defaultStartBaseRef` must be a string when provided");
  }
  validateBoardBranch(config.boardBranch);
  validateBoardLanding(config);
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
      // COORD-125: optional per-repo override for the base `gov start` branches
      // new governed work off. null when unset (falls back to the global
      // defaultStartBaseRef, then integrationBranch).
      startBaseRef:
        typeof entry.startBaseRef === "string" && entry.startBaseRef.trim() !== ""
          ? entry.startBaseRef.trim()
          : null,
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
  // COORD-125: project-wide fallback base for `gov start`, applied when a repo
  // has no explicit startBaseRef. null when unset (falls back to per-repo
  // integrationBranch).
  const defaultStartBaseRef =
    typeof config.defaultStartBaseRef === "string" && config.defaultStartBaseRef.trim() !== ""
      ? config.defaultStartBaseRef.trim()
      : null;
  // COORD-895: the coord workspace (board) branch. null when unset, so callers
  // that derive it (origin/HEAD) keep doing so; `boardBranch` on the paths
  // object applies the engine default for callers that need a concrete name.
  const boardBranch = typeof config.boardBranch === "string" ? config.boardBranch.trim() : null;
  const boardLanding = config.boardLanding || BOARD_LANDING_MODES[0];
  const boardLandingWaitSeconds = Number.isInteger(config.boardLandingWaitSeconds)
    ? config.boardLandingWaitSeconds : DEFAULT_BOARD_LANDING_WAIT_SECONDS;
  return { repos, requirements: { path: requirementsPath }, coordTicketPrefix, defaultStartBaseRef, boardBranch, boardLanding, boardLandingWaitSeconds };
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

// COORD-863: the shim registry is the only way a legacy coord/<path> may
// coexist with a divergent coord/engine/<path>. Each shim is a same-name
// compatibility file at the legacy path that delegates to its engine target;
// `permanent` shims are the stable adopter entrypoints, everything else is
// `removable` once no live reference uses the legacy spelling. Paths are
// coord-relative so the registry is independent of the coord directory name.
const SHIM_REGISTRY_RELATIVE_PATH = "engine/shim-registry.json";
const ENGINE_ONLY_PREFIX = "engine-only:";
const SHIM_KINDS = Object.freeze(["permanent", "removable"]);
const EMPTY_SHIM_REGISTRY = Object.freeze({ schema_version: 1, stable_entrypoints: Object.freeze([]), shims: Object.freeze([]) });

function assertCoordRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty coord-relative path`);
  }
  if (value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`${label} must be a normalized coord-relative path: ${value}`);
  }
}

// A stable-entrypoint pattern is an exact path or a path whose final segment
// contains `*` (matching within that directory only). Test suites are never
// entrypoints, so `scripts/hooks/*.js` does not pin the hook tests in place.
function stableEntrypointMatcher(pattern) {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  const expression = new RegExp(`^${escaped}$`);
  return (rel) => !rel.endsWith(".test.js") && expression.test(rel);
}

function isStableEntrypoint(registry, rel) {
  return registry.stable_entrypoints.some((pattern) => stableEntrypointMatcher(pattern)(rel));
}

// Structural validation only; filesystem facts are checked by
// verifyShimRegistry and, for the collision it resolves, by the resolver.
function validateShimRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("shim registry must be an object");
  if (registry.schema_version !== 1) throw new Error(`shim registry schema_version must be 1, got ${JSON.stringify(registry.schema_version)}`);
  if (!Array.isArray(registry.stable_entrypoints) || !Array.isArray(registry.shims)) {
    throw new Error("shim registry must declare stable_entrypoints and shims arrays");
  }
  const patterns = new Set();
  for (const pattern of registry.stable_entrypoints) {
    assertCoordRelative(pattern, "stable entrypoint");
    if (pattern.slice(0, pattern.lastIndexOf("/") + 1).includes("*")) throw new Error(`stable entrypoint wildcard must be in the final segment: ${pattern}`);
    if (patterns.has(pattern)) throw new Error(`duplicate stable entrypoint: ${pattern}`);
    patterns.add(pattern);
  }
  const seen = new Set();
  for (const shim of registry.shims) {
    if (!shim || typeof shim !== "object") throw new Error("shim registry entries must be objects");
    assertCoordRelative(shim.path, "shim path");
    if (shim.path.startsWith("engine/")) throw new Error(`shim path must be a legacy path outside engine/: ${shim.path}`);
    if (shim.target !== `engine/${shim.path}`) throw new Error(`shim ${shim.path} must target its same-name engine path engine/${shim.path}, got ${JSON.stringify(shim.target)}`);
    if (!SHIM_KINDS.includes(shim.kind)) throw new Error(`shim ${shim.path} kind must be one of ${SHIM_KINDS.join("|")}`);
    const stable = isStableEntrypoint(registry, shim.path);
    if (stable && shim.kind !== "permanent") throw new Error(`shim ${shim.path} is a stable entrypoint and must be permanent`);
    if (!stable && shim.kind !== "removable") throw new Error(`shim ${shim.path} is not a stable entrypoint and must be removable`);
    if (seen.has(shim.path)) throw new Error(`duplicate shim path: ${shim.path}`);
    seen.add(shim.path);
  }
  return registry;
}

// A missing registry is an install that predates COORD-863 and therefore has
// no shims. A present but unreadable or invalid registry fails closed.
function loadShimRegistry(coordDir) {
  const registryPath = path.join(coordDir, SHIM_REGISTRY_RELATIVE_PATH);
  let text;
  try {
    text = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return EMPTY_SHIM_REGISTRY;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`shim registry ${registryPath} is not valid JSON: ${error.message}`);
  }
  return validateShimRegistry(parsed);
}

// COORD-864: the exact source of a registered JavaScript shim. A removable
// internal-module shim re-exports its engine target through the engine-only
// resolver form; a CLI shim (`cli: true`) additionally re-dispatches the
// engine module's main when it is the process entrypoint. The coord directory
// is reached from the shim's own directory, so a nested legacy path climbs one
// more level. An ES module shim (`.mjs`, COORD-878) cannot call the resolver
// before its static re-exports link, so it names the same engine-only target
// by its fixed relative specifier and re-exports the named and default
// bindings; its CLI form calls the engine main when the shim is the entrypoint.
// COORD-991 (ARCH-AUDIT-2026-11-13 F-09; human-admin decision 2026-11-13): a deprecated removable
// shim writes one stderr line when it loads (a module loads once per process). The line names the
// engine path and the removal version. Only removable, non-fail-closed shims are deprecated: hook
// and guard shims are permanent entrypoints, and fail-closed templates ignore the option.
const SHIM_REMOVAL_VERSION = "0.3.0";
function deprecationLines(rel, deprecated) {
  if (!deprecated) return [];
  const message = `DEPRECATED: coord/${rel} is a legacy shim and will be removed in ${SHIM_REMOVAL_VERSION}. Use coord/engine/${rel} instead.\n`;
  return [`process.stderr.write(${JSON.stringify(message)});`];
}

function renderShimSource(rel, { cli = false, failClosed = false, deprecated = false } = {}) {
  assertCoordRelative(rel, "shim path");
  if (!/\.[cm]?js$/.test(rel)) throw new Error(`only JavaScript shims have a rendered template: ${rel}`);
  const hops = rel.split("/").length - 1;
  if (rel.endsWith(".mjs")) return renderEsmShimSource(rel, hops, cli, deprecated);
  const coordDir = `path.resolve(__dirname, ${Array(hops).fill('".."').join(", ")})`;
  if (failClosed) return renderFailClosedShimSource(rel, { cli, hops, coordDir });
  const target = `require(resolveEngineModule(${coordDir}, "${ENGINE_ONLY_PREFIX}${rel}"))`;
  const lines = [
    '"use strict";',
    ...deprecationLines(rel, deprecated),
    'const path = require("node:path");',
    `const { resolveEngineModule } = require("${"../".repeat(hops)}paths.js");`,
    "",
    ...(cli
      ? [`const engine = ${target};`, "if (require.main === module) engine.main();", "module.exports = engine;"]
      : [`module.exports = ${target};`]),
    "",
  ];
  return lines.join("\n");
}

// COORD-872 (human-admin ruling 2026-11-04): a hook entrypoint must block, never
// fail open. When the engine copy (or paths.js itself) cannot be loaded while the
// shim runs as the entrypoint, it reports and exits 2 (block), the hook runner's
// block code; required as a module it rethrows, so a caller still sees the real error.
// COORD-971: the barrier shim is the one entrypoint that is lock-gated, exactly like
// runtime-authority-hook.js: it exits 2 only while governed work is in flight (an
// active `doing` lock, or a lock entry or lock directory it cannot read), else 0.
// The guard shim always blocks (a required guard never fails open). The shim cannot
// import the engine's own rule (the engine is what failed to load), so the lock read
// below is an engine-free copy of locksActiveWithoutEngine(), and the two recovery
// texts are the exact OUT_OF_BAND_RECOVERY strings of the engine entrypoints they front.
const BARRIER_SHIM_RELATIVE = "scripts/runtime-authority-hook.js";
const BARRIER_OUT_OF_BAND_RECOVERY =
  "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent " +
  "harness, restore the engine copy under coord/engine/scripts and restart the session; or, if no governed work is in " +
  "flight, release the active lock through the governance CLI.";
const GUARD_OUT_OF_BAND_RECOVERY =
  "OUT-OF-BAND RECOVERY (this block also stops the shell you would repair it from): in a terminal outside the agent " +
  "harness, restore the engine copy under coord/engine/scripts/hooks, restart the session, or land the change through " +
  "governance (gov land / gov finalize) from that terminal.";

function renderFailClosedShimSource(rel, { cli, hops, coordDir }) {
  const target = `require(require("${"../".repeat(hops)}paths.js").resolveEngineModule(${coordDir}, "${ENGINE_ONLY_PREFIX}${rel}"))`;
  const barrier = rel === BARRIER_SHIM_RELATIVE;
  const recovery = barrier ? BARRIER_OUT_OF_BAND_RECOVERY : GUARD_OUT_OF_BAND_RECOVERY;
  const lockGate = barrier
    ? [
        "// COORD-971: engine-free copy of the barrier's locksActiveWithoutEngine(). Coord dir: the",
        "// canonical one for a worktree copy, else this shim's own coord dir.",
        "function lockDirectory() {",
        '  const marker = `${path.sep}coord${path.sep}.worktrees${path.sep}`;',
        "  const index = __dirname.indexOf(marker);",
        '  const coord = index >= 0 ? __dirname.slice(0, index + `${path.sep}coord`.length) : path.resolve(__dirname, "..");',
        '  return path.join(coord, ".runtime", "locks");',
        "}",
        "function governedWorkInFlight() {",
        "  const dir = lockDirectory();",
        "  let names;",
        "  try { names = fs.readdirSync(dir); }",
        '  catch (error) { return !(error && error.code === "ENOENT"); }',
        '  return names.filter((name) => name.endsWith(".lock")).some((name) => {',
        "    try {",
        '      const lock = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));',
        '      return Boolean(lock) && lock.status === "doing";',
        "    } catch { return true; }",
        "  });",
        "}",
      ]
    : [];
  const exit = barrier ? "process.exit(governedWorkInFlight() ? 2 : 0);" : "process.exit(2);";
  return [
    '"use strict";',
    'const path = require("node:path");',
    ...(barrier ? ['const fs = require("node:fs");'] : []),
    "let engine;",
    "try {",
    `  engine = ${target};`,
    "} catch (error) {",
    "  if (require.main !== module) throw error;",
    `  process.stderr.write(\`BLOCKED (fail-closed): coord/${rel} cannot load its engine module: \${(error && error.message) || error} ${recovery}\\n\`);`,
    ...lockGate,
    `  ${exit}`,
    "}",
    ...(cli ? ["if (require.main === module) engine.main();"] : []),
    "module.exports = engine;",
    "",
  ].join("\n");
}

function renderEsmShimSource(rel, hops, cli, deprecated) {
  const target = JSON.stringify(`${"../".repeat(hops)}engine/${rel}`);
  const lines = [
    ...deprecationLines(rel, deprecated),
    ...(cli
      ? ['import path from "node:path";', 'import { fileURLToPath } from "node:url";', `import * as engine from ${target};`, ""]
      : []),
    `export * from ${target};`,
    `export { default } from ${target};`,
    ...(cli ? ["if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) engine.main();"] : []),
    "",
  ];
  return lines.join("\n");
}

// Only a leading shebang, whole-line `//` comment lines, blank lines, line
// endings and trailing whitespace are ignored; every remaining line must equal
// the rendered template's line byte for byte. Nothing inside a line is
// stripped, so a comment marker inside a string literal cannot hide code
// (COORD-864 review: `"use strict/*"; evil(); "*/";`). The rendered template
// has no block comments or multi-line literals, so a whole-line `//` line is
// always a comment.
function normalizeShimSource(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^#!.*\n/, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.trimStart().startsWith("//"))
    .join("\n");
}

// A JavaScript shim delegates only when it is exactly the rendered module or
// CLI template for its own path; any other entrypoint (a shell launcher) by
// naming the literal engine path. JavaScript also ends a line at U+2028/U+2029
// (and other non-ASCII text could hide code from the line-wise comparison), so
// a JavaScript shim may contain only printable ASCII, tab, CR and LF (COORD-864
// review: `// note<U+2028>globalThis.PWNED=1;`).
// COORD-991: a removable shim is checked against the deprecated template and a permanent one against
// the plain template. With no kind (an unregistered path), either template is accepted.
function shimDelegates(text, rel, kind) {
  if (/\.[cm]?js$/.test(rel)) {
    if (/[^\t\n\r\x20-\x7e]/.test(text)) return false;
    const actual = normalizeShimSource(text);
    const deprecatedModes = kind === undefined ? [false, true] : [kind === "removable"];
    return [false, true].some((cli) => [false, true].some((failClosed) => deprecatedModes.some((deprecated) =>
      actual === normalizeShimSource(renderShimSource(rel, { cli, failClosed, deprecated })))));
  }
  return text.includes(`engine/${rel}`);
}

function readTextIfFile(file) {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

// Returns one message per registered shim whose legacy file or engine target
// is missing, or whose legacy file does not delegate to its target.
function verifyShimRegistry(coordDir, registry = loadShimRegistry(coordDir)) {
  const problems = [];
  for (const shim of registry.shims) {
    const text = readTextIfFile(path.join(coordDir, shim.path));
    if (text === null) problems.push(`registered shim ${shim.path} is missing`);
    else if (!shimDelegates(text, shim.path, shim.kind)) problems.push(`registered shim ${shim.path} does not delegate to ${shim.target}`);
    if (readTextIfFile(path.join(coordDir, shim.target)) === null) problems.push(`registered shim target ${shim.target} is missing`);
  }
  return problems;
}

// COORD-514: engine modules may be migrated one area at a time. New callers
// pass an engine-relative path (for example `engine/scripts/cli.js`); during the
// migration the resolver accepts either coord/engine/<path> or the legacy
// coord/<path>. A collision is unsafe because silently choosing one copy would
// make provenance and upgrades ambiguous, unless the legacy copy is a
// byte-identical staged copy or a registered shim that delegates to the engine
// copy. `engine-only:<path>` (COORD-863) resolves only the engine copy; a shim
// uses it so it can never resolve back to itself.
function resolveEngineModule(coordDir, engineRelativePath) {
  if (!coordDir || typeof engineRelativePath !== "string" || !engineRelativePath.trim()) {
    throw new TypeError("engine module path must be a non-empty relative string");
  }
  const engineOnly = engineRelativePath.startsWith(ENGINE_ONLY_PREFIX);
  const requested = engineOnly ? engineRelativePath.slice(ENGINE_ONLY_PREFIX.length) : engineRelativePath;
  if (!requested.trim()) throw new TypeError("engine module path must be a non-empty relative string");
  const relative = requested.replace(/\\/g, "/");
  if (path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error(`engine module path must stay relative to coord: ${engineRelativePath}`);
  }
  const enginePath = path.join(coordDir, "engine", relative);
  const engineExists = fs.existsSync(enginePath);
  if (engineOnly) {
    if (engineExists) return enginePath;
    throw new Error(`engine-only module not found in ${enginePath}`);
  }
  const legacyPath = path.join(coordDir, relative);
  const legacyExists = fs.existsSync(legacyPath);
  if (engineExists && legacyExists) {
    // A byte-identical legacy copy is a staged migration shim. It is safe to
    // resolve the engine copy while retaining old paths for external callers;
    // divergent copies remain a hard provenance error.
    try {
      if (fs.statSync(enginePath).isFile() && fs.statSync(legacyPath).isFile() && fs.readFileSync(enginePath).equals(fs.readFileSync(legacyPath))) return enginePath;
    } catch {
      // Fall through to the registered-shim check below.
    }
    const shim = loadShimRegistry(coordDir).shims.find((entry) => entry.path === path.posix.normalize(relative));
    if (shim) {
      const text = readTextIfFile(legacyPath);
      if (text !== null && shimDelegates(text, shim.path, shim.kind)) return enginePath;
      throw new Error(`engine module collision: registered shim ${legacyPath} does not delegate to ${enginePath}`);
    }
    throw new Error(`engine module collision: both ${enginePath} and ${legacyPath} exist`);
  }
  if (engineExists) return enginePath;
  if (legacyExists) return legacyPath;
  throw new Error(`engine module not found in ${enginePath} or ${legacyPath}`);
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
  const repoStartBaseRefs = {};
  const repoRegistry = {};
  const legacyRepoAliases = {};
  const repoTestCommands = {};
  const ticketPrefixToRepoCode = {};
  for (const [code, entry] of Object.entries(config.repos)) {
    repoRoots[code] = path.isAbsolute(entry.path) ? entry.path : path.join(rootDir, entry.path);
    repoOrigins[code] = entry.origin;
    repoIntegrationBranches[code] = entry.integrationBranch;
    repoStartBaseRefs[code] = entry.startBaseRef;
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
    decisionsDir: path.join(coordDir, "docs", "decisions"),
    engineDir: path.join(coordDir, "engine"),
    boardDir,
    renderedDir,
    boardPath: path.join(boardDir, "tasks.json"),
    // COORD-586: board schemas are engine-owned. Keep the legacy paths in
    // place for downstream readers during the staged migration, but resolve
    // canonical reads from coord/engine first.
    tasksSchemaPath: resolveEngineModule(coordDir, "board/tasks.schema.json"),
    planRecordSchemaPath: resolveEngineModule(coordDir, "board/plan.schema.json"),
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
    repoStartBaseRefs,
    defaultStartBaseRef: config.defaultStartBaseRef,
    repoRegistry,
    legacyRepoAliases,
    repoTestCommands,
    ticketPrefixToRepoCode,
    coordTicketPrefix,
    // COORD-895: configured board branch (null = derive) and its effective value.
    controlPlaneIntegrationBranch: config.boardBranch,
    boardBranch: config.boardBranch || DEFAULT_BOARD_BRANCH,
    boardLanding: config.boardLanding,
    boardLandingWaitSeconds: config.boardLandingWaitSeconds,
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
  resolveEngineModule,
  // COORD-863 shim registry helpers for the engine migration.
  loadShimRegistry,
  validateShimRegistry,
  verifyShimRegistry,
  shimDelegates,
  renderShimSource,
  isStableEntrypoint,
  SHIM_REGISTRY_RELATIVE_PATH,
  ENGINE_ONLY_PREFIX,
  // Config-seam helpers exported for tests and migration tooling.
  loadProjectConfig,
  resolveProjectConfigPath,
  validateProjectConfig,
  normalizeProjectConfig,
  resolveProjectConfig,
  TEMPLATE_DEFAULT_CONFIG,
  DEFAULT_INTEGRATION_BRANCH,
  DEFAULT_COORD_TICKET_PREFIX,
  DEFAULT_BOARD_BRANCH,
  BOARD_LANDING_MODES,
  DEFAULT_BOARD_LANDING_WAIT_SECONDS,
};
