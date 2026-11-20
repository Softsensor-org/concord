#!/usr/bin/env node
"use strict";

// COORD-480: the ONE authoritative governance test entrypoint.
//
// Every consumer of the suite — contributors, `npm test --prefix coord`, active
// PR CI (.github/workflows/governance-suite.yml), public-cut hygiene
// (release/check-public-release.sh), and binary verification
// (.github/workflows/release-linux-binary.yml) — calls this runner instead of
// maintaining its own `node --test` glob. The execution contract it enforces:
//
//   1. ROOT NORMALIZATION — the test root is resolved from THIS FILE's location
//      (never the caller's cwd), so the same command works from the repository
//      root, from coord/, and from inside a packed/vendored artifact where the
//      engine content sits at the package root without a coord/ prefix.
//   2. RECURSIVE, DETERMINISTIC DISCOVERY — every `*.test.js` under the engine
//      content root (board/, scripts/ including hooks/, gates/, enterprise/ and
//      any FUTURE nested directory) is discovered by a recursive walk and
//      classified into a module. A nested suite cannot exist without appearing
//      in the inventory (`--list`). In the donor checkout the packaging
//      (create-concord/, test/) and release (release/) suites are discovered
//      too; in a cut/packed artifact those roots are absent and skipped.
//      Discovery order is a byte-wise sort, so the aggregate order is stable.
//   3. SERIAL, IDENTITY-FREE EXECUTION — stateful governance tests run with
//      `--test-concurrency=1`, and ambient session identity is stripped from the
//      child environment BY THE RUNNER, so a governed shell cannot leak its
//      identity into ownership tests (the historical `env -u COORD_SESSION_ID`
//      footgun is baked in here, not left to callers). Stripping is
//      PROVIDER-COMPLETE (COORD-606): every provider thread variable in the
//      governance-session PROVIDER_REGISTRY (CODEX_THREAD_ID,
//      CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID, GEMINI_THREAD_ID,
//      GROK_THREAD_ID), the provider-neutral AGENT_THREAD_ID /
//      GOVERNANCE_MCP_THREAD_ID, the coord identity variables and CLAUDECODE
//      (COORD-880), GEMINI_AGENT and GROK_AGENT (COORD-883) are named explicitly, AND a shape-based sweep removes anything matching
//      IDENTITY_ENV_PATTERN so a NEW provider cannot leak by being added to the
//      registry without being added here. test-runner.test.js fails if any
//      registry variable is missing from the enumeration.
//   4. ISOLATION FAIL-CLOSED, IN TWO HALVES (COORD-606) — the guarantee is
//      "no test may mutate the live governed tree", and it is enforced by:
//        (a) coord/engine/scripts/test-isolation-guard.js preloaded (NODE_OPTIONS
//            --require) into every test worker, which throws on any IN-PROCESS
//            fs write to a guarded live surface: coord/prompts/**,
//            coord/rendered/** (seal class), coord/.runtime/**, the two state
//            locks, coord/memory/** (runtime class), and coord/board/**,
//            coord/PLAN.md, coord/QUESTIONS.md, coord/active/** (governed-state
//            class); AND
//        (b) a GOVERNED-TREE FINGERPRINT taken by this runner before and after
//            every module. An `fs` hook structurally cannot see a write made by a
//            SPAWNED process (`git`, a shell script, a `gov` child); the
//            fingerprint can, because it compares content hashes of the governed
//            tracked surfaces on disk. A module that leaves the tree changed
//            fails the run and is named in the report.
//      Scope statement, so the claim is not larger than the enforcement: what is
//      guaranteed is that the GOVERNED tracked surfaces above are unchanged. A
//      test writing to an unrelated path (engine source under coord/scripts/**,
//      or anywhere outside coord/) is NOT intercepted by either half.
//   5. MACHINE-READABLE INVENTORY + SUMMARY — `--list [--json]` publishes the
//      inventory; every run writes a JSON report (aggregate order, per-module
//      counts, failing test names, node version, stripped env, governed-tree
//      violations) so an aggregate failure can be reproduced with the exact order
//      and environment. An aggregate failure is NEVER downgraded because an
//      isolated rerun passes. A run whose report CANNOT be persisted fails
//      (COORD-606): a publication gate must never report PASS with no evidence.
//
// Focused local iteration stays cheap: `--module <name>` and `--file <path>`
// run subsets through the same contract (see coord/package.json test:* scripts).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");
const { checkGitPrerequisite } = require("./git-prerequisite.js");
const { sqliteTestNodeOptions } = require("./sqlite-runtime.js");
const { quoteNodeOption, withoutInheritedIsolationGuardOptions } = require("./test-node-options.js");
const TITLE_PRECHECK = path.join(__dirname, "test-title-precheck.js");
// COORD-910: loaded lazily like the title precheck, so contract fixtures that copy
// only the runner's core files keep working; the report records why it is absent.
const RUN_MANIFEST = path.join(__dirname, "run-manifest.js");
function loadRunManifest(file = RUN_MANIFEST) { return fs.existsSync(file) ? require(file) : null; }

// --- root normalization (independent of caller cwd) --------------------------
// CONTENT_ROOT is the engine content root: the directory that contains board/
// and scripts/. In the donor and in built release cuts that directory is named
// "coord" and sits inside a workspace root; in an npm-packed artifact the
// content root IS the package root.
const CONTENT_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = workspaceRootForContent(CONTENT_ROOT);

function workspaceRootForContent(contentRoot) {
  return path.basename(contentRoot) === "coord" ? path.dirname(contentRoot) : contentRoot;
}

// COORD-909: the provider-complete identity list, its shape pattern and the predicate live in
// ONE shared module, agent-identity-env.js, which gate-runtime.js also uses for product test and
// gate children. Re-exported here so existing consumers keep working. The in-place
// scrubIdentityEnv below (COORD-890) stays local to this runner.
const {
  STRIPPED_ENV_VARS,
  IDENTITY_ENV_PATTERN,
  isIdentityEnvVar,
} = require("./agent-identity-env.js");

// COORD-890: deletes every identity variable from `env` in place and returns the
// sorted names removed. buildChildEnv applies it to each child's copy; identity-
// sensitive suites call it on process.env at load so a bare `node --test` run in
// an agent shell is isolated the same way a runner child is.
function scrubIdentityEnv(env = process.env) {
  const removed = Object.keys(env).filter(isIdentityEnvVar).sort();
  for (const name of removed) delete env[name];
  return removed;
}

// Governed tracked surfaces that no test may mutate, content-root relative.
// Compared by content hash before and after every module so a mutation made by a
// SPAWNED process (git / a shell script / a gov child) — which the in-process fs
// guard structurally cannot see — still fails the run. `.runtime/**` is
// deliberately NOT fingerprinted: it is gitignored, legitimately churning
// process-local state, and already covered fail-closed by the fs guard.
const GOVERNED_FINGERPRINT_PATHS = Object.freeze([
  "board",
  "prompts",
  "rendered",
  "active",
  "PLAN.md",
  "QUESTIONS.md",
]);

// Directories the recursive walk never descends into. `__fixtures__` /
// `fixtures` may legitimately contain sample *.test.js files that are DATA for
// other tests, not suites.
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  ".runtime",
  "__fixtures__",
  "fixtures",
  "dist",
  ".next",
  "coverage",
  "reports",
]);

// Deterministic aggregate module order.
const MODULE_ORDER = Object.freeze([
  "board",
  "hooks",
  "gates",
  "core",
  "enterprise",
  "packaging",
  "release",
]);

// Node's default coverage exclusion also matches production files whose name
// starts with `test-` (including this runner). Use the production census's
// actual test suffix instead. Vendored engine dependencies are also outside
// the first-party production census and can carry source maps that the Node 22
// LCOV reporter cannot resolve when their source-map payload is not shipped.
const ENGINE_COVERAGE_ARGS = Object.freeze([
  "--experimental-test-coverage",
  "--test-coverage-exclude=**/*.test.js",
  "--test-coverage-exclude=**/engine/vendor/**",
]);

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

// Classify a content-root-relative posix path into a module. Total: anything
// not claimed by a named nested module lands in "core", so a NEW nested
// directory can never dodge the inventory.
function classifyContentTest(relPosix) {
  if (relPosix.startsWith("board/")) return "board";
  if (relPosix.startsWith("scripts/hooks/") || relPosix.startsWith("engine/scripts/hooks/")) return "hooks"; // COORD-872: hooks moved, module kept
  // COORD-867: the gate suites moved to engine/scripts/gates/ and keep their module.
  if (relPosix.startsWith("scripts/gates/") || relPosix.startsWith("engine/scripts/gates/")) return "gates";
  // COORD-874: the enterprise suites moved to engine/scripts/enterprise/ and keep their module.
  if (relPosix.startsWith("scripts/enterprise/") || relPosix.startsWith("engine/scripts/enterprise/")) return "enterprise";
  return "core";
}

// Recursive deterministic walk: byte-wise sorted entries, excluded dirs pruned.
function walkTests(dirAbs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkTests(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(abs);
    }
  }
  return out;
}

// The donor checkout (where the packaging/release suites live) is recognized
// by its release builder — never by guessing at generic directory names that an
// adopter workspace could also have.
function isDonorWorkspace(workspaceRoot, contentRoot) {
  if (workspaceRoot === contentRoot) return false;
  return fs.existsSync(
    path.join(workspaceRoot, "release", "build-public-release.sh")
  );
}

// Donor-only module roots, relative to the workspace root.
const DONOR_MODULE_ROOTS = Object.freeze({
  packaging: Object.freeze(["create-concord", "test"]),
  release: Object.freeze(["release"]),
});

// Build the full inventory. Files are workspace-root-relative posix paths in
// deterministic order. Roots are injectable for the contract tests.
function buildInventory(opts = {}) {
  const contentRoot = opts.contentRoot || CONTENT_ROOT;
  const workspaceRoot =
    opts.workspaceRoot ||
    (path.basename(contentRoot) === "coord"
      ? path.dirname(contentRoot)
      : contentRoot);

  const byModule = new Map(MODULE_ORDER.map((name) => [name, []]));

  for (const abs of walkTests(contentRoot, [])) {
    const relContent = toPosix(path.relative(contentRoot, abs));
    const relWorkspace = toPosix(path.relative(workspaceRoot, abs));
    byModule.get(classifyContentTest(relContent)).push(relWorkspace);
  }

  const donor = isDonorWorkspace(workspaceRoot, contentRoot);
  if (donor) {
    for (const [moduleName, roots] of Object.entries(DONOR_MODULE_ROOTS)) {
      for (const root of roots) {
        for (const abs of walkTests(path.join(workspaceRoot, root), [])) {
          byModule.get(moduleName).push(toPosix(path.relative(workspaceRoot, abs)));
        }
      }
    }
  }

  const modules = MODULE_ORDER.map((name) => ({
    name,
    files: byModule.get(name).slice().sort(),
  }));
  return {
    layout: donor ? "donor" : "engine",
    content_root: contentRoot,
    workspace_root: workspaceRoot,
    known_modules: MODULE_ORDER.slice(),
    modules,
    total_files: modules.reduce((n, m) => n + m.files.length, 0),
  };
}

function retainRawCoverageDiagnostic(rawCoverageModules, { root, nodeVersion, workspaceRoot, sourceCommit, coverageError }) {
  fs.mkdirSync(root, { recursive: true });
  let diagnosticDirectory = null;
  try {
    diagnosticDirectory = fs.mkdtempSync(path.join(root, "coord-coverage-raw-"));
    const modules = rawCoverageModules.map((module, index) => {
      const safeName = module.name.replace(/[^A-Za-z0-9_.-]/g, "_");
      const rawDirectory = path.posix.join("modules", `${String(index).padStart(2, "0")}-${safeName}`);
      const destination = path.join(diagnosticDirectory, rawDirectory);
      if (!module.rawDirectory || !fs.existsSync(module.rawDirectory) || !fs.statSync(module.rawDirectory).isDirectory()) {
        throw new Error(`raw coverage directory missing for module ${module.name}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(module.rawDirectory, destination, { recursive: true, errorOnExist: true });
      return { name: module.name, raw_directory: rawDirectory, lcov: module.lcov };
    });
    fs.writeFileSync(path.join(diagnosticDirectory, "manifest.json"), JSON.stringify({
      schema_version: 1, node_version: nodeVersion, workspace_root: workspaceRoot,
      source_commit: sourceCommit, coverage_error: coverageError, modules,
    }, null, 2) + "\n");
    return diagnosticDirectory;
  } catch (error) {
    if (diagnosticDirectory) fs.rmSync(diagnosticDirectory, { recursive: true, force: true });
    throw error;
  }
}

// Parse the node:test TAP side-channel: aggregate counts + failing test names
// + the identity of every skipped test or suite (COORD-816). A bare skip count
// cannot tell an approved, named skip from a new one, and a skipped SUITE is
// not in the count at all. A skip identity is its nesting path ("suite > test"),
// read from the indented `# Subtest:` lines that precede each result.
// TAP is the machine-readable half of the run; the human half (spec) streams
// LIVE to the terminal/CI log, so a long module is never silent.
function parseTapSummary(text) {
  const counts = {
    tests: 0,
    suites: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    duration_ms: 0,
  };
  const failing = [];
  const skipped = [];
  const outcomes = [];
  const ancestors = [];
  let rootIndent = null;
  // node:test escapes `#` and `\` inside names, so an unescaped ` # SKIP` is
  // always the directive and never part of the name.
  const unescape = (name) => name.replace(/\\([#\\])/g, "$1");
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    // Node may indent its root subtest block by four spaces when a test file
    // itself is nested. Treat the first subtest's indentation as the root;
    // each additional four spaces then adds one ancestor level.
    const indent = rawLine.length - rawLine.trimStart().length;
    const subtest = line.match(/^# Subtest: (.*)$/);
    if (subtest) {
      if (rootIndent === null) rootIndent = indent;
      const depth = Math.max(0, Math.floor((indent - rootIndent) / 4));
      ancestors.length = depth;
      ancestors[depth] = unescape(subtest[1]);
      continue;
    }
    const depth = Math.max(0, Math.floor((indent - (rootIndent || 0)) / 4));
    const skip = line.match(/^(?:not )?ok \d+ - (.*?) # SKIP\b/);
    if (skip) skipped.push([...ancestors.slice(0, depth), unescape(skip[1])].join(" > "));
    const outcome = line.match(/^(not )?ok \d+ - (.*)$/);
    if (outcome) {
      const decorated = outcome[2].match(/^(.*?)\s+#\s+(SKIP|TODO)\b.*$/i);
      const title = unescape((decorated ? decorated[1] : outcome[2]).trim());
      if (title) outcomes.push({ identity: [...ancestors.slice(0, depth), title].join(" > "),
        outcome: decorated ? decorated[2].toLowerCase() : outcome[1] ? "fail" : "pass" });
    }
    const summary = line.match(
      /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)$/
    );
    // Only the UNINDENTED trailer carries the aggregate totals; nested subtest
    // trailers are indented and must not be summed in.
    if (summary && rawLine === line) {
      counts[summary[1]] = Number(summary[2]);
      continue;
    }
    const notOk = line.match(/^not ok \d+ - (.+)$/);
    if (notOk) {
      const name = notOk[1].replace(/\s+#\s+(SKIP|TODO)\b.*$/i, "").trim();
      if (name) failing.push(name);
    }
  }
  // The names travel beside the `skipped` count they explain, so every module
  // entry in the run report carries both.
  counts.skipped_tests = skipped;
  return { counts, failing_tests: [...new Set(failing)], test_outcomes: outcomes };
}

// COORD-904: preloaded into each file process under --profile-costs; it records
// the wall time of child processes the test spawns (child-CLI time).
const COST_PROBE = path.join(__dirname, "test-cost-probe.js");

// Sum the per-process TAP summaries of one module (profile mode runs each file
// alone). Counts add; failing and skipped identities concatenate.
function mergeTapSummaries(parts) {
  const counts = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 0, skipped_tests: [] };
  const failing = [];
  const outcomes = [];
  for (const part of parts) {
    for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"]) counts[key] += part.counts[key] || 0;
    counts.skipped_tests.push(...part.counts.skipped_tests);
    failing.push(...part.failing_tests);
    outcomes.push(...part.test_outcomes);
  }
  return { counts, failing_tests: [...new Set(failing)], test_outcomes: outcomes };
}

// COORD-904: one file's profile. wall_ms is the directly observed process time;
// non_test_ms is what node reports outside the file's own test trailer (process
// start, module load and setup outside timed tests); child_cli_ms sums the spawns
// the probe recorded, where a spawn nested under another spawn is counted at each level.
function profileFileEntry(moduleName, file, wallMs, child, costPath, tapDurationMs) {
  let children = [];
  try {
    children = fs.readFileSync(costPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    children = [];
  }
  const childMs = children.reduce((sum, record) => sum + (record.ms || 0), 0);
  return {
    module: moduleName,
    file,
    exit_code: child.status == null ? -1 : child.status,
    wall_ms: Number(wallMs.toFixed(3)),
    node_tap_ms: Number(tapDurationMs.toFixed(3)),
    non_test_ms: Number(Math.max(0, wallMs - tapDurationMs).toFixed(3)),
    child_cli_ms: Number(childMs.toFixed(3)),
    child_cli_count: children.length,
    child_cli_nested_double_count_possible: true,
  };
}

// Child environment: inherited env minus ambient session identity, plus the
// isolation guard preloaded via NODE_OPTIONS.
function buildChildEnv(contentRoot, fixtureTemp) {
  const env = { ...process.env };
  if (fixtureTemp) Object.assign(env, { TMPDIR: fixtureTemp, TMP: fixtureTemp, TEMP: fixtureTemp, RUNNER_TEMP: fixtureTemp });
  // Enumerated identity variables first, then the shape-based sweep (shared module), so a
  // provider variable that is not (yet) enumerated still cannot be inherited.
  scrubIdentityEnv(env);
  // node:test sets NODE_TEST_CONTEXT in its workers; if the runner is itself
  // spawned from a test (the contract tests do exactly that) an inherited value
  // forces the child into the serializer reporter and the aggregate summary
  // would be unparseable. Drop it so the reporter contract is deterministic.
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_TEST_")) delete env[name];
  }
  // The aggregate LCOV destination and historical revision belong to this
  // runner; nested fixture runs cannot consume the maintainer inputs.
  for (const name of ["COORD_COVERAGE_MERGED_LCOV", "COORD_RELEASE_COVERAGE_HISTORY_HEAD"]) delete env[name];
  const guard = path.join(contentRoot, "engine", "scripts", "test-isolation-guard.js");
  const inheritedOptions = withoutInheritedIsolationGuardOptions(env.NODE_OPTIONS || "");
  const existing = sqliteTestNodeOptions(inheritedOptions);
  env.NODE_OPTIONS = [existing, `--require ${quoteNodeOption(guard)}`].filter(Boolean).join(" ");
  return { env, guard };
}

// --- governed-tree fingerprint (COORD-606) ------------------------------------
// Content hash of every file under the governed tracked surfaces. This is the
// half of the isolation guarantee that an in-process fs hook cannot provide:
// it observes the tree itself, so a mutation performed by a SPAWNED process is
// visible. Returns a Map of content-root-relative posix path -> "sha256:bytes".
function fingerprintGovernedTree(contentRoot, opts = {}) {
  const roots = opts.paths || GOVERNED_FINGERPRINT_PATHS;
  const out = new Map();
  const addFile = (abs) => {
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return; // vanished mid-walk; the compare reports it as removed
    }
    const rel = toPosix(path.relative(contentRoot, abs));
    out.set(rel, `${crypto.createHash("sha256").update(buf).digest("hex")}:${buf.length}`);
  };
  const walk = (dirAbs) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        addFile(abs);
      }
    }
  };
  for (const rel of roots) {
    const abs = path.join(contentRoot, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // absent in this layout (e.g. a packed artifact)
    }
    if (stat.isDirectory()) walk(abs);
    else if (stat.isFile()) addFile(abs);
  }
  return out;
}

// Compare two fingerprints; returns the added / removed / modified paths.
function diffFingerprints(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const [rel, hash] of after) {
    if (!before.has(rel)) added.push(rel);
    else if (before.get(rel) !== hash) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    changed: added.length + removed.length + modified.length > 0,
  };
}

function usage(out) {
  out.write(
    [
      "usage: node coord/scripts/test-runner.js [options] [-- <node --test passthrough args>]",
      "",
      "The authoritative recursive serial governance test entrypoint (COORD-480).",
      "Runs every discovered suite serially with ambient session identity stripped",
      "and the test-isolation guard enforced. Works from the repository root,",
      "coord/, or a packed artifact.",
      "",
      "options:",
      "  --list                print the discovered inventory and exit",
      "  --json                machine-readable output (--list) / print report JSON after a run",
      "  --module <names>      run only these modules (comma separated or repeated);",
      `                        known: ${MODULE_ORDER.join(", ")}`,
      "  --file <path>         run only this test file (repeatable)",
      "  --report <path>       write the JSON run report here (default: a temp file)",
      "  --manifest <path>     write the run manifest here (default: <report>.manifest.json)",
      "  --base <ref>          record this base commit in the run manifest (or COORD_RUN_BASE)",
      "  --engine-coverage     measure production scripts and enforce the measured baseline ratchet",
      "  --profile-costs      per-file wall, non-test and child-CLI time (one process per file)",
      "  --changed-since <ref> ADVISORY pre-gate: coverage of the suites the selector picks for the change",
      "                        since <ref>; reports likely new_uncovered arms; never gate evidence or a baseline",
      "  --shards <N|auto>          opt in to isolated serial shards; default remains serial",
      "  --qualification-stage <developer|pr|nightly|promotion|release>  resolved stage for sharding",
      "  --policy-stage <name>   exact adopter workflow stage (bound by donor receipt)",
      "  --qualification-mode full  assert this is a full-inventory qualification",
      "  --census-observer <descriptor>  explicit donor-observer transport for a full release qualification",
      "  --shard-history <file>     measured suite durations from a prior report",
      "  --write-coverage-baseline  measure and write the initial baseline (implies --engine-coverage)",
      "  -h, --help            show this help",
      "",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const opts = {
    list: false,
    json: false,
    help: false,
    modules: [],
    files: [],
    report: null,
    manifest: null,
    base: null,
    shards: null,
    qualificationStage: null,
    policyStage: null,
    qualificationMode: null,
    shardHistory: null,
    shardChild: false,
    censusObserverDescriptor: null,
    engineCoverage: false,
    profileCosts: false,
    writeCoverageBaseline: false,
    changedSince: null,
    passthrough: [],
    errors: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      opts.passthrough = argv.slice(i + 1);
      break;
    } else if (arg === "--list") {
      opts.list = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--module") {
      const value = argv[i + 1];
      if (value == null) {
        opts.errors.push("--module requires a value");
      } else {
        opts.modules.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        i += 1;
      }
    } else if (arg === "--file") {
      const value = argv[i + 1];
      if (value == null) {
        opts.errors.push("--file requires a value");
      } else {
        opts.files.push(value);
        i += 1;
      }
    } else if (arg === "--shards") {
      const value = argv[i + 1];
      if (value == null || (!/^\d+$/.test(value) && value !== "auto")) {
        opts.errors.push("--shards requires a positive integer or auto");
      } else {
        opts.shards = value;
        i += 1;
      }
    } else if (arg === "--qualification-stage") {
      const value = argv[i + 1];
      if (value == null || !["developer", "pr", "nightly", "promotion", "release"].includes(value)) {
        opts.errors.push("--qualification-stage requires developer, pr, nightly, promotion, or release");
      } else {
        opts.qualificationStage = value;
        i += 1;
      }
    } else if (arg === "--policy-stage" || arg === "--qualification-mode") {
      const value = argv[i + 1];
      if (value == null || !value.trim()) opts.errors.push(`${arg} requires a value`);
      else { opts[arg === "--policy-stage" ? "policyStage" : "qualificationMode"] = value; i += 1; }
    } else if (arg === "--shard-child") {
      opts.shardChild = true;
    } else if (arg === "--report" || arg === "--manifest" || arg === "--base" || arg === "--shard-history" || arg === "--census-observer") {
      const value = argv[i + 1];
      if (value == null) {
        opts.errors.push(`${arg} requires a value`);
      } else {
        const key = ({ "--report": "report", "--manifest": "manifest", "--base": "base",
          "--shard-history": "shardHistory", "--census-observer": "censusObserverDescriptor" })[arg];
        if (opts[key] != null) opts.errors.push(`${arg} may be provided only once`);
        else opts[key] = value;
        i += 1;
      }
    } else if (arg === "--profile-costs") {
      opts.profileCosts = true;
    } else if (arg === "--engine-coverage") {
      opts.engineCoverage = true;
    } else if (arg === "--write-coverage-baseline") {
      opts.engineCoverage = true;
      opts.writeCoverageBaseline = true;
    } else if (arg === "--changed-since") {
      const value = argv[i + 1];
      if (value == null || !value.trim()) opts.errors.push("--changed-since requires a value");
      else { opts.changedSince = value; i += 1; }
    } else {
      opts.errors.push(`unknown argument: ${arg}`);
    }
  }
  for (const name of opts.modules) {
    if (!MODULE_ORDER.includes(name)) {
      opts.errors.push(
        `unknown module "${name}" (known: ${MODULE_ORDER.join(", ")})`
      );
    }
  }
  if (opts.shards && !opts.qualificationStage) {
    opts.errors.push("--shards requires an explicit full-gate --qualification-stage; selected runs must remain serial");
  }
  if (opts.shards && !["full", "selection"].includes(opts.qualificationMode)) opts.errors.push("--shards requires --qualification-mode full or selection");
  if (opts.shards && !opts.policyStage) opts.errors.push("--shards requires the exact --policy-stage");
  if (opts.shards && opts.passthrough.length > 0) {
    opts.errors.push("--shards cannot use arbitrary node --test filters; use the resolved module/file selection");
  }
  if (opts.shards && opts.qualificationMode === "full" && (opts.modules.length > 0 || opts.files.length > 0)) {
    opts.errors.push("full qualification sharding is limited to the complete inventory");
  }
  if (opts.shards && opts.qualificationMode === "selection" && opts.modules.length === 0 && opts.files.length === 0) {
    opts.errors.push("selection sharding requires an explicit resolved module or file set");
  }
  if (opts.shards && opts.qualificationMode === "selection" && opts.engineCoverage) {
    opts.errors.push("selection sharding cannot apply the whole-suite coverage ratchet");
  }
  require("./test-census-observer.js").validateCensusObserverOptions(opts);
  if (opts.changedSince != null) {
    // COORD-907: the advisory pre-gate never writes a baseline, report or run manifest and never
    // takes the gate's own selection, so each gate-writing or gate-selecting option is refused here.
    if (opts.writeCoverageBaseline) opts.errors.push("advisory --changed-since cannot write a coverage baseline");
    if (opts.report || opts.manifest) opts.errors.push("advisory --changed-since writes no report or run manifest");
    if (opts.modules.length > 0 || opts.files.length > 0 || opts.list || opts.shards || opts.passthrough.length > 0) {
      opts.errors.push("advisory --changed-since selects its own suites; remove --module, --file, --list, --shards and node test filters");
    }
  }
  return opts;
}

function defaultReportPath() {
  if (process.env.COORD_TEST_REPORT) return process.env.COORD_TEST_REPORT;
  return path.join(
    os.tmpdir(),
    `concord-test-report-${Date.now()}-${process.pid}.json`
  );
}

function coverageBaselinePathForNode(contentRoot, nodeVersion = process.version) {
  const major = Number(/^v(\d+)\./.exec(nodeVersion)?.[1]);
  const name = major === 22 || major === 24
    ? `engine-coverage-baseline-node${major}.json`
    : "engine-coverage-baseline.json";
  return path.join(contentRoot, "engine", "scripts", name);
}

function assertCoverageBaselineProvenance(baseline, baselinePath, nodeVersion = process.version) {
  if (!/engine-coverage-baseline-node\d+\.json$/.test(baselinePath)) {
    if (baseline?.unstable_findings !== undefined) {
      throw new Error(`coverage unstable sites require a supported Node lane baseline: ${baselinePath}`);
    }
    return;
  }
  const major = Number(/^v(\d+)\./.exec(nodeVersion)?.[1]);
  if (baseline.unstable_findings !== undefined || baseline.unstable_observations !== undefined ||
      baseline.unstable_source_hashes !== undefined) {
    throw new Error(`source-range coverage v4 does not accept unstable-site exceptions: ${baselinePath}`);
  }
  if (baseline.identity_version !== 4 || baseline.identity_format !== "raw-v8-source-range-v1" ||
      baseline.aggregation !== "node-testcoverage-native-v1" || baseline.node_major !== major ||
      !new RegExp(`^v${major}\\.`).test(baseline.measured_node_version || "") ||
      !/^[0-9a-f]{40}$/.test(baseline.source_commit || "") ||
      !Number.isFinite(Date.parse(baseline.measured_at))) {
    throw new Error(`coverage baseline provenance or identity format requires Node ${nodeVersion} remeasurement: ${baselinePath}`);
  }
}

function selectModules(inventory, opts, out) {
  let modules = inventory.modules.filter((m) => m.files.length > 0);
  if (opts.modules.length > 0) {
    modules = modules.filter((m) => opts.modules.includes(m.name));
  }
  if (opts.files.length > 0) {
    const wanted = new Set(
      opts.files.map((f) =>
        toPosix(path.relative(inventory.workspace_root, path.resolve(f)))
      )
    );
    modules = modules
      .map((m) => ({ name: m.name, files: m.files.filter((f) => wanted.has(f)) }))
      .filter((m) => m.files.length > 0);
    const found = new Set(modules.flatMap((m) => m.files));
    for (const f of wanted) {
      if (!found.has(f)) {
        out.write(`test-runner: ERROR --file not in inventory: ${f}\n`);
        return null;
      }
    }
  }
  return modules;
}

function supportsNativeCoverageVersion(version = process.version) {
  const major = Number(/^v(\d+)\./.exec(version || "")?.[1]);
  return [22, 24].includes(major);
}

function formatCoverageLine(report, sharded = false) {
  const ratchet = report?.engine_coverage?.ratchet;
  const verdict = ratchet?.result === "fail" ? "FAIL" : "PASS";
  return `concord-coverage: ${report.coverage} ${sharded ? "ratchet" : "result"}=${verdict}\n`;
}

// COORD-907: the advisory pre-gate body lives in changed-since-advisory.js (lazy, under the flag).
function runChangedSinceAdvisory(inventory, opts, out, err, nodeVersion) {
  const advisory = require(require("../../paths.js").resolveEngineModule(inventory.content_root, "scripts/changed-since-advisory.js"));
  return advisory.runChangedSinceAdvisory(inventory, opts, out, err, nodeVersion, {
    supportsNativeCoverageVersion, buildChildEnv, ENGINE_COVERAGE_ARGS, parseTapSummary,
    coverageBaselinePathForNode, assertCoverageBaselineProvenance,
  });
}

function main(argv, {
  ownership,
  buildInventory: inventoryBuilder = buildInventory,
  nodeVersion = process.version,
  gitCheck = checkGitPrerequisite,
  runManifest = loadRunManifest(),
} = {}) {
  const out = process.stdout;
  const err = process.stderr;
  const opts = parseArgs(argv);
  if (opts.help) {
    usage(out);
    return 0;
  }
  if (opts.errors.length > 0) {
    for (const e of opts.errors) err.write(`test-runner: ${e}\n`);
    usage(err);
    return 2;
  }
  const gitPrerequisite = gitCheck();
  if (!gitPrerequisite.ok) {
    err.write(`test-runner: ${gitPrerequisite.diagnostic}\n`);
    return 2;
  }
  if (opts.engineCoverage && ((opts.modules.length > 0 || opts.files.length > 0) && !opts.shardChild || opts.passthrough.length > 0 || opts.list)) {
    err.write("test-runner: engine coverage requires the complete aggregate inventory and all tests; remove --module, --file, --list, and Node test filters after --\n");
    return 2;
  }
  if (opts.engineCoverage && !supportsNativeCoverageVersion(nodeVersion)) {
    err.write(`test-runner: raw engine coverage aggregation supports Node 22.x and 24.x; found ${nodeVersion}\n`);
    return 2;
  }
  // Focused/default runners are copied into minimal fixture workspaces by the
  // duration and isolation contract tests. Load coverage policy only for a
  // full coverage run, so those fixtures retain the original runner contract.
  const inventory = inventoryBuilder();
  const engineCoverage = opts.engineCoverage
    ? require(require("../../paths.js").resolveEngineModule(inventory.content_root, "scripts/engine-coverage.js"))
    : null;
  const coverageSourceProvider = opts.engineCoverage
    ? require(require("../../paths.js").resolveEngineModule(inventory.content_root, "scripts/coverage-source-provider.js"))
    : null;
  const coverageAggregator = opts.engineCoverage
    ? require(require("../../paths.js").resolveEngineModule(inventory.content_root, "scripts/coverage-aggregate.js"))
    : null;
  const coverageSourceBaseline = opts.engineCoverage
    ? engineCoverage.fingerprintProductionSources(inventory.content_root)
    : null;
  const governanceOnly = (() => {
    const configPath = path.join(inventory.content_root, "project.config.js");
    if (!fs.existsSync(configPath)) return false;
    try {
      delete require.cache[require.resolve(configPath)];
      const config = require(configPath);
      return Object.keys(config.repos || {}).length === 0;
    } catch {
      return false;
    }
  })();

  if (opts.list) {
    let modules = inventory.modules;
    if (opts.modules.length > 0) {
      modules = modules.filter((m) => opts.modules.includes(m.name));
    }
      if (opts.json) {
        out.write(
          JSON.stringify(
          { ...inventory, modules, schema_version: 1, execution_scope: governanceOnly ? "governance-only" : "configured-product", skip_reason: governanceOnly ? "product-repo-dependent tests are exercised at the release hygiene gate; this installed workspace contains no product repository by design" : null },
          null,
          2
        ) + "\n"
      );
    } else {
      out.write(`test inventory (${inventory.layout} layout)\n`);
      out.write(`  content root:   ${inventory.content_root}\n`);
      out.write(`  workspace root: ${inventory.workspace_root}\n`);
      if (governanceOnly) out.write("  execution scope: governance-only (product-repo-dependent tests are exercised at the release hygiene gate; this install contains no product repository by design)\n");
      for (const m of modules) {
        out.write(`\n  module ${m.name} (${m.files.length} files)\n`);
        for (const f of m.files) out.write(`    ${f}\n`);
      }
      const shown = modules.reduce((n, m) => n + m.files.length, 0);
      out.write(`\n  total: ${shown} test files\n`);
    }
    return 0;
  }

  if (opts.changedSince != null) return runChangedSinceAdvisory(inventory, opts, out, err, nodeVersion);
  const selected = selectModules(inventory, opts, err);
  if (selected == null) return 2;
  if (selected.length === 0) {
    err.write("test-runner: no test files selected\n");
    return 2;
  }
  // COORD-906: a targeted run checks its files' titles against the release
  // suite inventory first, so an unregistered title fails in seconds. Loaded
  // lazily: contract fixtures copy the runner with only its core dependencies.
  if (opts.files.length > 0 && fs.existsSync(TITLE_PRECHECK)) {
    const titlePrecheck = require(TITLE_PRECHECK);
    const titles = titlePrecheck.runnerTitlePrecheck({ root: inventory.workspace_root, files: selected.flatMap((m) => m.files) });
    if (titles.untracked && titles.untracked.length) err.write(`test-runner: title precheck skips untracked ${titles.untracked.join(", ")}; gov commit checks them\n`);
    if (!titles.ok) {
      err.write(`${titlePrecheck.refusal("test-runner: targeted run", titles)}\n`);
      return 1;
    }
  }

  let censusObserver = null;
  let censusDirectory = null;
  if (opts.censusObserverDescriptor) {
    try {
      ({ observer: censusObserver, censusDirectory } = require("./test-census-observer.js").prepareCensusObserver({
        descriptorPath: opts.censusObserverDescriptor, shards: opts.shards, shardChild: opts.shardChild,
        workerId: process.env.COORD_SHARD_ID,
      }));
    } catch (error) {
      err.write(`test-runner: release census observer refused: ${error.message}\n`);
      return 2;
    }
  }
  const reportPath = opts.report || defaultReportPath();
  if (opts.engineCoverage && !coverageAggregator.admitCoverageRun({ reportPath, censusOutput: censusObserver?.outputRoot, sharded: Boolean(opts.shards) }, err)) return 2;
  // Shard workers already have an isolated temp root whose files the parent
  // may need to read when aggregating coverage. Only serial runs own this one.
  const scratch = !opts.shards && !opts.shardChild && ownership?.recordTempDir(path.resolve(os.tmpdir(), `coord-test-fixtures-${ownership.runId}`));
  const { env, guard } = buildChildEnv(inventory.content_root, scratch);
  if (opts.writeCoverageBaseline) env.COORD_COVERAGE_BASELINE_CAPTURE = "1";
  else delete env.COORD_COVERAGE_BASELINE_CAPTURE;

  const startedAt = new Date().toISOString();
  const results = [];
  const executionOrder = [];
  const treeViolations = [];
  const coverageSourceViolations = [];
  const rawCoverageModules = [];
  const rawCoverageDirectories = [];
  let retainedRawCoverageDirectories = [];
  const profileFiles = [];
  let governedBaseline = fingerprintGovernedTree(inventory.content_root);
  let shardRun = null;
  let shardAuthority = null;

  out.write(`▸ authoritative governance test run (${inventory.layout} layout)\n`);
  out.write(`  workspace root: ${inventory.workspace_root}\n`);
  out.write(`  ${opts.shards ? `sharded (${opts.shards}) with serial workers (--test-concurrency=1)` : "serial (--test-concurrency=1)"}; isolation guard: ${toPosix(path.relative(inventory.workspace_root, guard))}\n`);
  out.write(`  stripped env: ${STRIPPED_ENV_VARS.join(", ")}\n`);

  if (opts.shards) {
    if (opts.shardChild) {
      err.write("test-runner: --shard-child is reserved for the internal shard executor\n");
      return 2;
    }
    try {
      const sharding = require("./test-sharding.js");
      let shardCount = sharding.resolveShardCount(opts.shards);
      if (opts.shards === "auto" && opts.qualificationMode === "selection") {
        const resolvedSuiteCount = selected.reduce((sum, module) => sum + module.files.length, 0);
        shardCount = Math.min(shardCount, resolvedSuiteCount);
      }
      let durations = {};
      let durationHistorySha256 = null;
      if (opts.shardHistory) {
        const historyBytes = fs.readFileSync(path.resolve(opts.shardHistory));
        durationHistorySha256 = crypto.createHash("sha256").update(historyBytes).digest("hex");
        const history = JSON.parse(historyBytes.toString("utf8"));
        durations = history.suite_durations_ms || history.suites || {};
        if (!durations || typeof durations !== "object" || Array.isArray(durations)) throw new Error("duration history must contain a suite_durations_ms map");
      }
      const timingSensitive = sharding.loadTimingSensitiveSuites(inventory.content_root);
      shardAuthority = sharding.resolveShardAuthority({ contentRoot: inventory.content_root, workspaceRoot: inventory.workspace_root });
      const shardOut = fs.mkdtempSync(path.join(path.dirname(path.resolve(reportPath)), `${path.basename(reportPath)}.shards-`));
      shardRun = sharding.executeShards({ workspaceRoot: inventory.workspace_root, contentRoot: inventory.content_root,
        selected, count: shardCount, engineCoverage: opts.engineCoverage, outDir: shardOut,
        node: process.execPath, env, durations, timingSensitive, durationHistorySha256,
        censusObserverDescriptorPath: censusObserver?.descriptorPath || null });
      executionOrder.push(...shardRun.workers.flatMap((worker) => worker.assigned || []));
      for (const worker of shardRun.workers) {
        results.push(sharding.summarizeShardWorker(worker, shardRun.plan));
        treeViolations.push(...(worker.report?.governed_tree_violations || []));
        coverageSourceViolations.push(...(worker.report?.coverage_source_violations || []));
      }
      if (shardRun.validationError) {
        results.push({ module: "shard-integrity", files: [], exit_code: 1, signal: null,
          tests: 0, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0, duration_ms: 0,
          failing_tests: [shardRun.validationError] });
      }
      // Raw V8 paths need one workspace root per worker. A failed child may
      // have no report at all, so do not feed incomplete worker metadata to the
      // path normalizer; the coverage gate below will preserve a failed parent
      // report with the exact assignment/worker error instead.
      if (opts.engineCoverage && shardRun.rawModules.length && !shardRun.validationError &&
          shardRun.workers.every((worker) => worker.result === "pass" && typeof worker.workspace === "string")) {
        const normalized = sharding.normalizeRawCoverageModules(shardRun.rawModules, {
          sourceWorkspaceRoots: shardRun.workers.map((worker) => worker.workspace),
          targetWorkspaceRoot: inventory.workspace_root, outDir: shardOut,
        });
        rawCoverageModules.push(...normalized.modules);
        rawCoverageDirectories.push(...normalized.modules.map((module) => module.rawDirectory));
        sharding.rewriteShardCoverageReports(shardRun, normalized.modules, inventory.workspace_root);
        retainedRawCoverageDirectories = rawCoverageDirectories.slice();
      }
      out.write(`test-runner: shard_count=${shardRun.plan.shard_count} plan=${path.join(shardOut, "shard-plan.json")} results=${path.join(shardOut, "shard-results.json")}\n`);
    } catch (error) {
      err.write(`test-runner: sharded run failed closed: ${error.message}\n`);
      return 1;
    }
  } else for (const m of selected) {
    out.write(`\n── module ${m.name} (${m.files.length} files) ─────────────\n`);
    executionOrder.push(...m.files);
    // Two reporters: spec streams LIVE to this process's stdout (a long module
    // is never silent in CI), TAP goes to a temp file we parse for the
    // machine-readable per-module summary.
    const tapPath = path.join(
      os.tmpdir(),
      `concord-tap-${process.pid}-${m.name}-${Date.now()}.tap`
    );
    const lcovPath = path.join(os.tmpdir(), `concord-lcov-${process.pid}-${m.name}-${Date.now()}.info`);
    const rawCoverageDirectory = opts.engineCoverage
      ? fs.mkdtempSync(path.join(os.tmpdir(), `concord-v8-${m.name}-`))
      : null;
    if (rawCoverageDirectory) rawCoverageDirectories.push(rawCoverageDirectory);
    // COORD-904: --profile-costs runs each file in its own process (node already
    // isolates files this way) so per-file wall time and child-CLI time are exact.
    const groups = opts.profileCosts && !opts.engineCoverage ? m.files.map((file) => [file]) : [m.files];
    const costDir = opts.profileCosts ? fs.mkdtempSync(path.join(os.tmpdir(), `concord-cost-${m.name}-`)) : null;
    let durationMs = 0;
    let exitCode = 0;
    let exitSignal = null;
    const tapParts = [];
    for (const [index, group] of groups.entries()) {
      const groupTapPath = index === 0 ? tapPath : `${tapPath}.${index}`;
      const args = [
        ...(censusObserver ? ["--require", censusObserver.loggerPath] : []),
        "--test",
        ...(opts.engineCoverage ? ENGINE_COVERAGE_ARGS : []),
        "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${groupTapPath}`,
        ...(opts.engineCoverage ? ["--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`] : []),
        ...opts.passthrough,
        ...group,
      ];
      const groupEnv = rawCoverageDirectory ? { ...env, NODE_V8_COVERAGE: rawCoverageDirectory } : { ...env };
      if (censusDirectory) groupEnv.COORD_TEST_CENSUS_DIR = censusDirectory;
      const costPath = costDir ? path.join(costDir, `${index}.jsonl`) : null;
      if (costPath) {
        groupEnv.COORD_TEST_COST_LOG = costPath;
        groupEnv.NODE_OPTIONS = `${groupEnv.NODE_OPTIONS} --require ${COST_PROBE}`;
      }
      const started = performance.now();
      const child = spawnSync(process.execPath, args, {
        cwd: inventory.workspace_root,
        env: groupEnv,
        stdio: "inherit",
      });
      const wallMs = performance.now() - started;
      durationMs += wallMs;
      if (exitCode === 0 && child.status !== 0) exitCode = child.status == null ? -1 : child.status;
      if (exitSignal == null && child.signal) exitSignal = child.signal;
      let groupTap = "";
      try {
        groupTap = fs.readFileSync(groupTapPath, "utf8");
      } catch (e) {
        err.write(`test-runner: WARNING could not read TAP summary for module ${m.name}: ${e.message}\n`);
      } finally {
        fs.rmSync(groupTapPath, { force: true });
      }
      tapParts.push(groupTap);
      if (costPath) profileFiles.push(profileFileEntry(m.name, group[0], wallMs, child, costPath, parseTapSummary(groupTap).counts.duration_ms));
    }
    if (costDir) fs.rmSync(costDir, { recursive: true, force: true });
    if (opts.engineCoverage) {
      try {
        rawCoverageModules.push({
          name: m.name,
          rawDirectory: rawCoverageDirectory,
          lcov: fs.readFileSync(lcovPath, "utf8"),
        });
      } catch (e) {
        err.write(`test-runner: ERROR could not read LCOV for module ${m.name}: ${e.message}\n`);
        rawCoverageModules.push({ name: m.name, rawDirectory: rawCoverageDirectory, lcov: null });
      } finally {
        fs.rmSync(lcovPath, { force: true });
      }
    }
    // COORD-606: did this module mutate the live governed tree? Catches the
    // subprocess writes (git, shell, gov children) the fs guard cannot see.
    const afterFingerprint = fingerprintGovernedTree(inventory.content_root);
    const treeDiff = diffFingerprints(governedBaseline, afterFingerprint);
    if (treeDiff.changed) {
      treeViolations.push({
        module: m.name,
        added: treeDiff.added,
        removed: treeDiff.removed,
        modified: treeDiff.modified,
      });
      // Re-baseline so the NEXT module is judged on its own writes.
      governedBaseline = afterFingerprint;
    }
    if (opts.engineCoverage) {
      const changed = engineCoverage.changedProductionSources(coverageSourceBaseline,
        engineCoverage.fingerprintProductionSources(inventory.content_root));
      if (changed.length > 0) coverageSourceViolations.push({ module: m.name, files: changed });
    }
    const parsed = mergeTapSummaries(tapParts.map((part) => parseTapSummary(part)));
    results.push({
      module: m.name,
      files: m.files,
      exit_code: exitCode,
      signal: exitSignal,
      ...parsed.counts,
      duration_ms: durationMs,
      failing_tests: parsed.failing_tests,
      test_outcomes: parsed.test_outcomes,
    });
  }

  const totals = results.reduce(
    (acc, r) => {
      for (const k of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
        acc[k] += r[k] || 0;
      }
      if (r.exit_code !== 0) acc.failed_modules.push(r.module);
      return acc;
    },
    { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, failed_modules: [] }
  );
  const testsPassed = totals.failed_modules.length === 0;
  // Keep the measured baseline in the packaged engine tree so installs carry
  // the same ratchet input as the donor and both release cuts.
  const coverageBaselinePath = coverageBaselinePathForNode(inventory.content_root);
  let coverageMeasurement = null;
  let coverageRatchet = null;
  let coverageError = null;
  let rawCoverageDiagnosticDirectory = null;
  if (opts.engineCoverage && !opts.shardChild) {
    try {
      if (shardRun && (shardRun.validationError || shardRun.workers.some((worker) => worker.result !== "pass"))) {
        throw new Error("coverage aggregation requires every shard to pass and report its exact assignment");
      }
      const expectedCoverageModules = shardRun
        ? shardRun.workers.reduce((sum, worker) => sum + (worker.report?.engine_coverage?.raw_modules?.length || 0), 0)
        : selected.length;
      if (rawCoverageModules.some((r) => r.lcov === null) || rawCoverageModules.length !== expectedCoverageModules || expectedCoverageModules === 0) {
        throw new Error("one or more module LCOV/raw coverage reports are missing");
      }
      if (coverageSourceViolations.length > 0) {
        throw new Error(`production source changed during coverage modules: ${JSON.stringify(coverageSourceViolations)}`);
      }
      const witnessFiles = [...coverageSourceBaseline.keys()].map((rel) => toPosix(
        path.relative(inventory.workspace_root, path.join(inventory.content_root, rel))));
      const aggregate = coverageAggregator.aggregateRawCoverage(rawCoverageModules, inventory.workspace_root, witnessFiles);
      coverageMeasurement = engineCoverage.measure(inventory.content_root, [aggregate.report], {
        rangeWitnesses: aggregate.witnesses,
      });
      if (["lines", "branches", "functions"].some((kind) => coverageMeasurement.totals[kind].found === 0)) {
        throw new Error("LCOV contains no measurable production line, branch or function coverage");
      }
      if (opts.writeCoverageBaseline) {
        if (!testsPassed || treeViolations.length > 0) {
          throw new Error("cannot write coverage baseline: aggregate tests or isolation checks failed");
        }
        const baseline = {
          schema_version: 1,
          identity_version: /engine-coverage-baseline-node\d+\.json$/.test(coverageBaselinePath) ? 4 : 1,
          ...(/engine-coverage-baseline-node\d+\.json$/.test(coverageBaselinePath)
            ? { identity_format: "raw-v8-source-range-v1", aggregation: "node-testcoverage-native-v1" }
            : {}),
          measured_at: new Date().toISOString(),
          node_major: Number(process.versions.node.split(".")[0]),
          measured_node_version: process.version,
          source_commit: require("node:child_process").spawnSync("git", ["rev-parse", "HEAD"],
            { cwd: inventory.workspace_root, encoding: "utf8" }).stdout?.trim() || "unknown",
          exclusions: coverageMeasurement.exclusions,
          production_file_count: coverageMeasurement.production_file_count,
          totals: coverageMeasurement.totals,
          findings: coverageMeasurement.findings,
        };
        assertCoverageBaselineProvenance(baseline, coverageBaselinePath);
        fs.mkdirSync(path.dirname(coverageBaselinePath), { recursive: true });
        fs.writeFileSync(coverageBaselinePath, JSON.stringify(baseline, null, 2) + "\n");
      } else {
        const baseline = JSON.parse(fs.readFileSync(coverageBaselinePath, "utf8"));
        assertCoverageBaselineProvenance(baseline, coverageBaselinePath);
        if (JSON.stringify(baseline.exclusions) !== JSON.stringify(engineCoverage.EXCLUSIONS)) {
          throw new Error("coverage exclusion contract differs from the measured baseline");
        }
        const historyHead = censusObserver && process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD || undefined;
        coverageRatchet = engineCoverage.ratchet(coverageMeasurement, baseline, {
          sourceProvider: (file, sourceCommit) => coverageSourceProvider.readBaselineCoverageSources({
            workspaceRoot: inventory.workspace_root,
            contentRoot: inventory.content_root,
            sourceCommit,
            file,
            expectedCurrentHash: coverageSourceBaseline.get(file),
            historyRoot: historyHead && path.dirname(path.dirname(censusObserver.loggerPath)),
            historyHead,
          }),
        });
      }
    } catch (e) {
      coverageError = e.message;
    }
  }
  if (coverageError && process.env.COORD_KEEP_RAW_COVERAGE_ON_ERROR === "1") {
    try {
      const diagnosticRoot = process.env.RUNNER_TEMP || os.tmpdir();
      const sourceCommit = require("node:child_process").spawnSync("git", ["rev-parse", "HEAD"],
        { cwd: inventory.workspace_root, encoding: "utf8" }).stdout?.trim() || "unknown";
      rawCoverageDiagnosticDirectory = retainRawCoverageDiagnostic(rawCoverageModules, {
        root: diagnosticRoot, nodeVersion: process.version, workspaceRoot: inventory.workspace_root,
        sourceCommit, coverageError,
      });
    } catch (diagnosticError) {
      coverageError += `; raw V8 diagnostic retention failed: ${diagnosticError.message}`;
      rawCoverageDiagnosticDirectory = null;
      retainedRawCoverageDirectories = [...rawCoverageDirectories];
    }
  }
  for (const rawDirectory of rawCoverageDirectories) {
    if (opts.shardChild || shardRun) continue;
    if (!retainedRawCoverageDirectories.includes(rawDirectory)) {
      fs.rmSync(rawDirectory, { recursive: true, force: true });
    }
  }
  // A run that mutated the live governed tree is NOT a passing run, however green
  // its assertions were: the suite corrupted the state it was supposed to isolate.
  const authoritativeCoverageRequired = opts.engineCoverage && !opts.shardChild;

  const manifestPath = runManifest ? runManifest.manifestPathFor(reportPath, opts.manifest) : null;
  const manifestDraft = runManifest ? runManifest.testRunnerManifest({ root: inventory.workspace_root, argv, opts, selected, results,
    scrubbedEnv: STRIPPED_ENV_VARS, toolFile: __filename }) : null;
  const censusEvidence = require("./test-census-observer.js").collectCensusEvidence({
    observer: censusObserver, manifestDraft, shardRun, censusDirectory,
  });
  const { artifactPaths: observerArtifactPaths, error: censusError } = censusEvidence;
  // Keep the full final predicate in one immutable declaration for the guard
  // registry. Census/index integrity is part of the release verdict, alongside
  // suite results, isolation and the aggregate coverage ratchet.
  const overallPass = testsPassed && treeViolations.length === 0 &&
    (!authoritativeCoverageRequired || !coverageError) &&
    (!authoritativeCoverageRequired || !coverageRatchet || coverageRatchet.result !== "fail") &&
    !censusError;

  const report = {
    schema_version: 1,
    tool: "coord/scripts/test-runner.js",
    ticket: "COORD-480",
    generated_at: startedAt,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    layout: inventory.layout,
    content_root: inventory.content_root,
    workspace_root: inventory.workspace_root,
    invoked_cwd: process.cwd(),
    argv,
    environment: {
      stripped_env_vars: STRIPPED_ENV_VARS.slice(),
      stripped_env_pattern: IDENTITY_ENV_PATTERN.source,
      stripped_env_removed: Object.keys(process.env)
        .filter((name) => isIdentityEnvVar(name))
        .sort(),
      node_options: env.NODE_OPTIONS,
      test_concurrency: 1,
      isolation_guard: guard,
      governed_fingerprint_paths: GOVERNED_FINGERPRINT_PATHS.slice(),
    },
    inventory: inventory.modules,
    execution_order: executionOrder,
    results,
    shard_plan: shardRun ? shardRun.plan : null,
    sharding_authority: shardRun ? shardAuthority : null,
    qualification: shardRun ? "provisional; donor receipt required" : "runner result only",
    ...require("./test-census-observer.js").censusReportFields({ observer: censusObserver,
      evidence: censusEvidence, shardRun, opts, censusDirectory }),
    profile: opts.profileCosts ? { schema_version: 1, files: profileFiles, note: "non_test_ms = wall minus node TAP duration (process start, module load, setup outside timed tests); child_cli_ms = wall time of child processes recorded by test-cost-probe" } : null,
    governed_tree_violations: treeViolations,
    coverage_source_violations: coverageSourceViolations,
    totals,
    suite_result: testsPassed && treeViolations.length === 0 ? "pass" : "fail",
    result: opts.shardChild ? (overallPass ? "partial" : "fail") : shardRun ? (overallPass ? "provisional" : "fail") : overallPass ? "pass" : "fail",
    engine_coverage: opts.engineCoverage ? {
      measurement: coverageMeasurement,
      ratchet: coverageRatchet,
      baseline_path: coverageBaselinePath,
      error: coverageError,
      shard_partial: opts.shardChild,
      raw_modules: opts.shardChild ? rawCoverageModules.map((module) => ({ ...module, workspace_root: inventory.workspace_root })) : undefined,
      raw_snapshot_diagnostic_directory: rawCoverageDiagnosticDirectory,
      raw_snapshot_directories: retainedRawCoverageDirectories,
    } : null,
  };
  if (opts.engineCoverage && !opts.shardChild) {
    const m = coverageMeasurement && coverageMeasurement.totals;
    report.coverage = m
      ? `engine lines=${m.lines.pct}% branches=${m.branches.pct}% functions=${m.functions.pct}% unobserved_files=${coverageMeasurement.unobserved_file_count} new_uncovered=${coverageRatchet ? coverageRatchet.new_uncovered.length : "baseline"} inherited_uncovered=${coverageRatchet ? coverageRatchet.inherited_uncovered : "baseline"}`
      : null;
    report.lane = "ci";
    report.commit = require("node:child_process").spawnSync("git", ["rev-parse", "HEAD"], { cwd: inventory.workspace_root, encoding: "utf8" }).stdout.trim() || "unknown";
    report.duration_ms = results.reduce((sum, r) => sum + r.duration_ms, 0);
    report.command_list = selected.map((m) => `node --test ${m.name}`);
    report.audit = null;
    report.audit_skip_reason = "coverage-only engine gate; repository audit is a separate gate";
    report.artifact_paths = [reportPath];
  }
  // COORD-910: the manifest's inputs are fixed before the report is written (the
  // report names its digest); its artifact hashes are taken after.
  report.run_manifest = manifestDraft
    ? { path: manifestPath, schema_version: manifestDraft.schema_version, input_digest: manifestDraft.input_digest }
    : null;
  if (!manifestDraft) report.run_manifest_skip_reason = "run-manifest.js is not present beside the runner";
  if (opts.engineCoverage && !opts.shardChild) {
    report.gate_artifact_validation = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/gate-artifact-schema.js")).validateGateArtifact(report);
  }
  // COORD-606: the report IS the evidence this gate publishes. If it cannot be
  // persisted the run has no evidence, so it must not claim success — a warning
  // plus exit 0 and a report path that does not exist is exactly the failure mode
  // a fail-closed publication gate cannot have.
  const reportWrite = require("./test-census-observer.js").persistCensusReport({ report, reportPath,
    manifestDraft, manifestPath, runManifest, artifactPaths: observerArtifactPaths });
  const reportWriteError = reportWrite.error;
  const reportPersisted = reportWrite.persisted;

  out.write("\n");
  for (const v of treeViolations) {
    out.write(
      `concord-tests: ISOLATION module=${v.module} mutated the live governed tree\n`
    );
    const entries = [
      ...v.modified.map((p) => ["modified", p]),
      ...v.added.map((p) => ["added", p]),
      ...v.removed.map((p) => ["removed", p]),
    ];
    for (const [kind, rel] of entries.slice(0, 20)) {
      out.write(`concord-tests:   ✖ ${kind} coord/${rel}\n`);
    }
    out.write(
      "concord-tests:   a test mutated live governed state. Sandbox the write via " +
        "withScopedGovernanceTestContext from governance-test-utils.js " +
        "(BOARD_PATH / PLAN_PATH / QUESTIONS_PATH / PROMPTS_DIR / " +
        "RENDERED_DIR) — and note the runner detects SUBPROCESS mutations (git, shell, " +
        "gov children) here, which the in-process fs guard cannot see. Do not run the " +
        "suite concurrently with governed mutations.\n"
    );
  }
  for (const r of results) {
    if (r.exit_code === 0) continue;
    out.write(
      `concord-tests: FAIL module=${r.module} exit=${r.exit_code} failing=${r.failing_tests.length}\n`
    );
    for (const name of r.failing_tests.slice(0, 20)) {
      out.write(`concord-tests:   ✖ ${name}\n`);
    }
  }
  // The published verdict can never be stronger than the evidence behind it.
  const publishedPass = !opts.shardChild && overallPass && reportPersisted &&
    (!opts.engineCoverage || report.gate_artifact_validation.complete);
  if (opts.engineCoverage && opts.shardChild) {
    out.write("concord-coverage: PARTIAL shard output; the aggregate ratchet has not run\n");
  } else if (opts.engineCoverage) {
    if (coverageError) out.write(`concord-coverage: FAIL ${coverageError}\n`);
    else {
      out.write(formatCoverageLine(report, Boolean(shardRun)));
      for (const f of (coverageRatchet?.new_uncovered || []).slice(0, 20)) {
        out.write(`concord-coverage:   ✖ ${f.file} ${f.message}\n`);
      }
    }
  }
  if (shardRun && shardAuthority.authoritative !== true && testsPassed && treeViolations.length === 0 &&
      (!opts.engineCoverage || (!coverageError && coverageRatchet?.result !== "fail"))) {
    out.write(`concord-tests: PRE-GATE only; sharded execution is not authorized as landing evidence (${shardAuthority.reason})\n`);
  }
  out.write(
    `concord-tests: modules=${results.length} files=${executionOrder.length} ` +
      `tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} ` +
    (shardRun
      ? `skipped=${totals.skipped} execution=${overallPass ? "PASS" : "FAIL"} qualification=${overallPass ? "PROVISIONAL" : "FAIL"}\n`
      : `skipped=${totals.skipped} result=${publishedPass ? "PASS" : "FAIL"}\n`)
  );
  if (reportPersisted) {
    out.write(`concord-tests: report=${reportPath}\n`);
    if (manifestDraft) out.write(`concord-tests: manifest=${manifestPath} input_digest=${manifestDraft.input_digest}\n`);
  } else {
    out.write(`concord-tests: report=NOT-WRITTEN (${reportPath})\n`);
    err.write(
      `test-runner: ERROR could not write the run report ${reportPath}: ` +
        `${reportWriteError.message}\n` +
        "test-runner: the run is reported as FAILED because its evidence could not " +
        "be persisted — a publication gate must not claim success with no report. " +
        "Re-run with a writable --report path (or COORD_TEST_REPORT).\n"
    );
  }
  if (!overallPass && !shardRun) {
    out.write(
      "concord-tests: aggregate failure — reproduce with the execution order and " +
        "environment recorded in the report; an isolated rerun passing does NOT " +
        "make the aggregate green.\n"
    );
  }
  const shardExecutionGreen = Boolean(shardRun && !shardRun.validationError && shardRun.workers.length === shardRun.plan.shard_count &&
    shardRun.workers.every((worker) => worker.result === "pass") && testsPassed && treeViolations.length === 0 &&
    (!opts.engineCoverage || (!coverageError && coverageRatchet?.result === "pass")));
  if (shardExecutionGreen && reportPersisted) {
    require("./test-sharding.js").cleanupShardWorkers(shardRun, { reportPersisted, allGreen: true, censusObserver });
  }
  if (opts.json) out.write(JSON.stringify(report, null, 2) + "\n");
  return opts.shardChild ? (overallPass && reportPersisted ? 0 : 1)
    : shardRun ? (overallPass && reportPersisted && (!opts.engineCoverage || report.gate_artifact_validation.complete) ? 2 : 1)
      : publishedPass ? 0 : 1;
}

// COORD-905: every runner invocation writes an owned-run manifest before it creates
// anything, and releases what it lists on every return path.
// A runner copied without run-ownership.js beside it runs unowned (as with run-manifest.js).
function runWithOwnership(argv) {
  const runOwnershipFile = path.join(__dirname, "run-ownership.js");
  if (!fs.existsSync(runOwnershipFile)) return main(argv);
  const runOwnership = require(runOwnershipFile);
  return runOwnership.runOwned({
    dir: runOwnership.defaultRunsDir(path.resolve(__dirname, "..", "..")),
    kind: "test-runner",
    argv,
    main: (args, ownership) => main(args, { ownership }),
  });
}

if (require.main === module) {
  process.exitCode = runWithOwnership(process.argv.slice(2));
}

module.exports = {
  CONTENT_ROOT,
  WORKSPACE_ROOT,
  STRIPPED_ENV_VARS,
  IDENTITY_ENV_PATTERN,
  isIdentityEnvVar,
  scrubIdentityEnv,
  GOVERNED_FINGERPRINT_PATHS,
  fingerprintGovernedTree,
  diffFingerprints,
  EXCLUDED_DIR_NAMES,
  MODULE_ORDER,
  ENGINE_COVERAGE_ARGS,
  DONOR_MODULE_ROOTS,
  classifyContentTest,
  walkTests,
  isDonorWorkspace,
  workspaceRootForContent,
  buildInventory,
  retainRawCoverageDiagnostic,
  loadRunManifest,
  parseTapSummary,
  buildChildEnv,
  parseArgs,
  supportsNativeCoverageVersion,
  formatCoverageLine,
  coverageBaselinePathForNode,
  assertCoverageBaselineProvenance,
  main,
};
// COORD-873: the permanent CLI shim calls main() with no arguments; only then run the
// command line and set the exit code, exactly as the require.main block above does.
const runTestRunnerMain = module.exports.main;
module.exports.main = function main(argv, options) {
  if (argv === undefined && options === undefined) return (process.exitCode = runWithOwnership(process.argv.slice(2)));
  return runTestRunnerMain(argv, options);
};
