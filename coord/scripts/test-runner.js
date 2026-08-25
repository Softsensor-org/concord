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
//      GOVERNANCE_MCP_THREAD_ID, and the coord identity variables are named
//      explicitly, AND a shape-based sweep removes anything matching
//      IDENTITY_ENV_PATTERN so a NEW provider cannot leak by being added to the
//      registry without being added here. test-runner.test.js fails if any
//      registry variable is missing from the enumeration.
//   4. ISOLATION FAIL-CLOSED, IN TWO HALVES (COORD-606) — the guarantee is
//      "no test may mutate the live governed tree", and it is enforced by:
//        (a) coord/scripts/test-isolation-guard.js preloaded (NODE_OPTIONS
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
const { spawnSync } = require("node:child_process");

// --- root normalization (independent of caller cwd) --------------------------
// CONTENT_ROOT is the engine content root: the directory that contains board/
// and scripts/. In the donor and in built release cuts that directory is named
// "coord" and sits inside a workspace root; in an npm-packed artifact the
// content root IS the package root.
const CONTENT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT =
  path.basename(CONTENT_ROOT) === "coord"
    ? path.dirname(CONTENT_ROOT)
    : CONTENT_ROOT;

// Ambient session identity stripped from every test child process. See
// coord/GOVERNANCE.md §10.3 and the COORD_SESSION_ID ownership-test footgun.
//
// COORD-606: this list is PROVIDER-COMPLETE. COORD-478 made the workspace
// provider-neutral (Claude / Codex / Gemini / Grok adapters share one contract),
// so an enumeration that only knew about Claude let a Codex or Gemini agent's
// ambient thread id reach the child and contaminate ownership/session tests.
// Every `envThread` + `envThreadAliases` value in the governance-session
// PROVIDER_REGISTRY must appear here; test-runner.test.js reads that registry and
// FAILS when a provider adapter exists without a matching stripped variable, so
// the enumeration cannot silently rot as providers are added.
const STRIPPED_ENV_VARS = Object.freeze([
  // coord identity
  "COORD_SESSION_ID",
  "COORD_PROVIDER_SESSION_ID",
  "COORD_INSTANCE_ID",
  // provider thread identity (PROVIDER_REGISTRY, governance-session.js)
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "GEMINI_THREAD_ID",
  "GROK_THREAD_ID",
  // provider-neutral fallbacks honored by the identity resolver
  "AGENT_THREAD_ID",
  "GOVERNANCE_MCP_THREAD_ID",
]);

// Shape-based backstop for the enumeration above: any variable whose NAME has the
// documented identity shape (`*_SESSION_ID` / `*_THREAD_ID` / `*_INSTANCE_ID`) is
// also removed. This covers a provider variable that lands in the registry before
// anyone updates this file, and the ambient terminal identity
// (TERM_SESSION_ID) that feeds session fingerprinting. Tests that need such a
// variable set it themselves; none may INHERIT one.
const IDENTITY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*_(?:SESSION|THREAD|INSTANCE)_ID$/;

function isIdentityEnvVar(name) {
  return STRIPPED_ENV_VARS.includes(name) || IDENTITY_ENV_PATTERN.test(name);
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

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

// Classify a content-root-relative posix path into a module. Total: anything
// not claimed by a named nested module lands in "core", so a NEW nested
// directory can never dodge the inventory.
function classifyContentTest(relPosix) {
  if (relPosix.startsWith("board/")) return "board";
  if (relPosix.startsWith("scripts/hooks/")) return "hooks";
  if (relPosix.startsWith("scripts/gates/")) return "gates";
  if (relPosix.startsWith("scripts/enterprise/")) return "enterprise";
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

// Parse the node:test TAP side-channel: aggregate counts + failing test names.
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
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
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
  return { counts, failing_tests: [...new Set(failing)] };
}

// Child environment: inherited env minus ambient session identity, plus the
// isolation guard preloaded via NODE_OPTIONS.
function buildChildEnv(contentRoot) {
  const env = { ...process.env };
  // Enumerated identity variables first, then the shape-based sweep, so a
  // provider variable that is not (yet) enumerated still cannot be inherited.
  for (const name of Object.keys(env)) {
    if (isIdentityEnvVar(name)) delete env[name];
  }
  // node:test sets NODE_TEST_CONTEXT in its workers; if the runner is itself
  // spawned from a test (the contract tests do exactly that) an inherited value
  // forces the child into the serializer reporter and the aggregate summary
  // would be unparseable. Drop it so the reporter contract is deterministic.
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_TEST_")) delete env[name];
  }
  const guard = path.join(contentRoot, "scripts", "test-isolation-guard.js");
  const guardArg = /\s/.test(guard) ? `"${guard}"` : guard;
  const requireFlag = `--require ${guardArg}`;
  const existing = env.NODE_OPTIONS || "";
  if (!existing.includes(guard)) {
    env.NODE_OPTIONS = existing ? `${existing} ${requireFlag}` : requireFlag;
  }
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
    } else if (arg === "--report") {
      const value = argv[i + 1];
      if (value == null) {
        opts.errors.push("--report requires a value");
      } else {
        opts.report = value;
        i += 1;
      }
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
  return opts;
}

function defaultReportPath() {
  if (process.env.COORD_TEST_REPORT) return process.env.COORD_TEST_REPORT;
  return path.join(
    os.tmpdir(),
    `concord-test-report-${Date.now()}-${process.pid}.json`
  );
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

function main(argv) {
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

  const inventory = buildInventory();

  if (opts.list) {
    let modules = inventory.modules;
    if (opts.modules.length > 0) {
      modules = modules.filter((m) => opts.modules.includes(m.name));
    }
    if (opts.json) {
      out.write(
        JSON.stringify(
          { ...inventory, modules, schema_version: 1 },
          null,
          2
        ) + "\n"
      );
    } else {
      out.write(`test inventory (${inventory.layout} layout)\n`);
      out.write(`  content root:   ${inventory.content_root}\n`);
      out.write(`  workspace root: ${inventory.workspace_root}\n`);
      for (const m of modules) {
        out.write(`\n  module ${m.name} (${m.files.length} files)\n`);
        for (const f of m.files) out.write(`    ${f}\n`);
      }
      const shown = modules.reduce((n, m) => n + m.files.length, 0);
      out.write(`\n  total: ${shown} test files\n`);
    }
    return 0;
  }

  const selected = selectModules(inventory, opts, err);
  if (selected == null) return 2;
  if (selected.length === 0) {
    err.write("test-runner: no test files selected\n");
    return 2;
  }

  const { env, guard } = buildChildEnv(inventory.content_root);
  const reportPath = opts.report || defaultReportPath();
  const startedAt = new Date().toISOString();
  const results = [];
  const executionOrder = [];
  const treeViolations = [];
  let governedBaseline = fingerprintGovernedTree(inventory.content_root);

  out.write(`▸ authoritative governance test run (${inventory.layout} layout)\n`);
  out.write(`  workspace root: ${inventory.workspace_root}\n`);
  out.write(`  serial (--test-concurrency=1); isolation guard: ${toPosix(path.relative(inventory.workspace_root, guard))}\n`);
  out.write(`  stripped env: ${STRIPPED_ENV_VARS.join(", ")}\n`);

  for (const m of selected) {
    out.write(`\n── module ${m.name} (${m.files.length} files) ─────────────\n`);
    executionOrder.push(...m.files);
    // Two reporters: spec streams LIVE to this process's stdout (a long module
    // is never silent in CI), TAP goes to a temp file we parse for the
    // machine-readable per-module summary.
    const tapPath = path.join(
      os.tmpdir(),
      `concord-tap-${process.pid}-${m.name}-${Date.now()}.tap`
    );
    const args = [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${tapPath}`,
      ...opts.passthrough,
      ...m.files,
    ];
    const started = Date.now();
    const child = spawnSync(process.execPath, args, {
      cwd: inventory.workspace_root,
      env,
      stdio: "inherit",
    });
    const durationMs = Date.now() - started;
    let tap = "";
    try {
      tap = fs.readFileSync(tapPath, "utf8");
    } catch (e) {
      err.write(`test-runner: WARNING could not read TAP summary for module ${m.name}: ${e.message}\n`);
    } finally {
      fs.rmSync(tapPath, { force: true });
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
    const parsed = parseTapSummary(tap);
    results.push({
      module: m.name,
      files: m.files,
      exit_code: child.status == null ? -1 : child.status,
      signal: child.signal || null,
      duration_ms: durationMs,
      ...parsed.counts,
      failing_tests: parsed.failing_tests,
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
  // A run that mutated the live governed tree is NOT a passing run, however green
  // its assertions were: the suite corrupted the state it was supposed to isolate.
  const overallPass = testsPassed && treeViolations.length === 0;

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
      node_options: env.NODE_OPTIONS || "",
      test_concurrency: 1,
      isolation_guard: guard,
      governed_fingerprint_paths: GOVERNED_FINGERPRINT_PATHS.slice(),
    },
    inventory: inventory.modules,
    execution_order: executionOrder,
    results,
    governed_tree_violations: treeViolations,
    totals,
    result: overallPass ? "pass" : "fail",
  };
  // COORD-606: the report IS the evidence this gate publishes. If it cannot be
  // persisted the run has no evidence, so it must not claim success — a warning
  // plus exit 0 and a report path that does not exist is exactly the failure mode
  // a fail-closed publication gate cannot have.
  let reportWriteError = null;
  try {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  } catch (e) {
    reportWriteError = e;
  }
  const reportPersisted = reportWriteError === null;

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
        "__testing.paths (BOARD_PATH / PLAN_PATH / QUESTIONS_PATH / PROMPTS_DIR / " +
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
  const publishedPass = overallPass && reportPersisted;
  out.write(
    `concord-tests: modules=${results.length} files=${executionOrder.length} ` +
      `tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} ` +
      `skipped=${totals.skipped} result=${publishedPass ? "PASS" : "FAIL"}\n`
  );
  if (reportPersisted) {
    out.write(`concord-tests: report=${reportPath}\n`);
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
  if (!overallPass) {
    out.write(
      "concord-tests: aggregate failure — reproduce with the execution order and " +
        "environment recorded in the report; an isolated rerun passing does NOT " +
        "make the aggregate green.\n"
    );
  }
  if (opts.json) out.write(JSON.stringify(report, null, 2) + "\n");
  return publishedPass ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  CONTENT_ROOT,
  WORKSPACE_ROOT,
  STRIPPED_ENV_VARS,
  IDENTITY_ENV_PATTERN,
  isIdentityEnvVar,
  GOVERNED_FINGERPRINT_PATHS,
  fingerprintGovernedTree,
  diffFingerprints,
  EXCLUDED_DIR_NAMES,
  MODULE_ORDER,
  DONOR_MODULE_ROOTS,
  classifyContentTest,
  walkTests,
  isDonorWorkspace,
  buildInventory,
  parseTapSummary,
  buildChildEnv,
  parseArgs,
  main,
};
