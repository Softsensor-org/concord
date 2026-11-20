"use strict";

// COORD-480 contract tests for the ONE authoritative test entrypoint.
// These lock the execution contract itself: root normalization, recursive
// deterministic discovery (a nested suite cannot dodge the inventory), serial
// identity-free execution, isolation-guard preloading, machine-readable
// inventory/summary, and the single-entrypoint wiring of npm / PR CI /
// public-cut hygiene / binary verification.

const test = require("node:test");
const { gitFixture } = require("./test-git-fixture.js");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const runner = require("./test-runner.js");
const nativeCoverageUnsupported = ![22, 24].includes(Number(process.versions.node.split(".")[0]));

const CONTENT_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.dirname(CONTENT_ROOT);
const RUNNER_PATH = path.join(CONTENT_ROOT, "scripts", "test-runner.js");
const { resolveEngineModule } = require("../../paths.js");
const engineCoverage = require(resolveEngineModule(CONTENT_ROOT, "scripts/engine-coverage.js"));
const coverageSourceProvider = require(resolveEngineModule(CONTENT_ROOT, "scripts/coverage-source-provider.js"));
const changedSinceAdvisory = require("./changed-since-advisory.js");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function callRunnerMain(args, options) {
  let stdout = "";
  let stderr = "";
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    return { status: runner.main(args, options), stdout, stderr };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

test("COORD-906: targeted runner warns about untracked tests and refuses an unregistered tracked title", (t) => {
  const root = mkTmp("coord906-runner-title-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contentRoot = path.join(root, "coord");
  const releaseRoot = path.join(root, "release");
  fs.mkdirSync(contentRoot);
  fs.mkdirSync(releaseRoot);
  const tracked = "coord/tracked.test.js";
  const untracked = "coord/probe.test.js";
  for (const item of [tracked, untracked]) fs.writeFileSync(path.join(root, item), "\n");
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["add", "--", tracked]);
  fs.writeFileSync(path.join(releaseRoot, "suite-inventory.json"), "{}\n");
  fs.writeFileSync(path.join(releaseRoot, "suite-titles.js"), [
    'const assert = require("node:assert/strict");',
    'assert.deepEqual(process.argv.slice(2), ["check", "--", "coord/tracked.test.js"]);',
    'console.error("fixture: unregistered title");',
    'process.exitCode = 1;',
  ].join("\n"));

  const result = callRunnerMain(["--file", path.join(root, tracked), "--file", path.join(root, untracked)], {
    buildInventory: () => ({
      workspace_root: root, content_root: contentRoot, modules: [{ name: "core", files: [tracked, untracked] }],
    }),
    gitCheck: () => ({ ok: true }),
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /title precheck skips untracked coord\/probe\.test\.js/);
  assert.match(result.stderr, /targeted run refused: changed test titles are not registered/);
  assert.match(result.stderr, /fixture: unregistered title/);
});

// --- root normalization ------------------------------------------------------

test("test root is resolved from the runner's own location, not the caller cwd", () => {
  assert.equal(runner.workspaceRootForContent(path.join(os.tmpdir(), "coord")), os.tmpdir(),
    "a donor content root named coord resolves to its containing workspace");
  const fromRoot = runNode([RUNNER_PATH, "--list", "--json"], {
    cwd: WORKSPACE_ROOT,
  });
  const fromCoord = runNode([RUNNER_PATH, "--list", "--json"], {
    cwd: CONTENT_ROOT,
  });
  const fromTmp = runNode([RUNNER_PATH, "--list", "--json"], {
    cwd: os.tmpdir(),
  });
  assert.equal(fromRoot.status, 0, fromRoot.stderr);
  assert.equal(fromCoord.status, 0, fromCoord.stderr);
  assert.equal(fromTmp.status, 0, fromTmp.stderr);
  const a = JSON.parse(fromRoot.stdout);
  const b = JSON.parse(fromCoord.stdout);
  const c = JSON.parse(fromTmp.stdout);
  assert.deepEqual(a.modules, b.modules);
  assert.deepEqual(a.modules, c.modules);
  assert.equal(a.content_root, CONTENT_ROOT);
  assert.equal(a.workspace_root, WORKSPACE_ROOT);
});

test("inventory paths are workspace-root relative and all exist", () => {
  const inv = runner.buildInventory();
  assert.ok(inv.total_files > 0);
  for (const m of inv.modules) {
    for (const rel of m.files) {
      assert.ok(!path.isAbsolute(rel), `expected relative path, got ${rel}`);
      assert.ok(
        fs.existsSync(path.join(inv.workspace_root, rel)),
        `inventory path does not exist: ${rel}`
      );
    }
  }
});

test("cli.js direct help entrypoint executes its guarded main path without writing state", () => {
  const cliPath = path.join(CONTENT_ROOT, "engine", "scripts", "cli.js");
  const result = runNode([cliPath, "help", "--all"], { cwd: WORKSPACE_ROOT });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Governance helper CLI/);
  assert.match(result.stdout, /Runtime evidence receipts/);
  assert.match(result.stdout, /--ack-outside-scope/);
  assert.equal(result.stderr, "");
});

test("cli.js guarded main reports a governed refusal through its process boundary", () => {
  const cliPath = path.join(CONTENT_ROOT, "engine", "scripts", "cli.js");
  const result = runNode([cliPath, "not-a-real-command"], { cwd: WORKSPACE_ROOT });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command "not-a-real-command"/);
  assert.equal(result.stdout, "");
});

test("cli.js guarded main preserves unexpected dependency errors and their stack", () => {
  const root = mkTmp("coord-cli-unexpected-error-");
  const cliPath = path.join(CONTENT_ROOT, "engine", "scripts", "cli.js");
  const preloadPath = path.join(root, "inject-unexpected-error.cjs");
  fs.writeFileSync(preloadPath, [
    '"use strict";',
    'const Module = require("node:module");',
    'const originalLoad = Module._load;',
    'Module._load = function (request, parent, isMain) {',
    '  const loaded = originalLoad.call(this, request, parent, isMain);',
    '  if (request === "./lifecycle.js" && /[\\\\/]coord[\\\\/](?:engine[\\\\/])?scripts[\\\\/]cli\\.js$/.test(parent?.filename || "")) {',
    '    loaded.commands.printCounts = () => { throw new TypeError("injected unexpected CLI dependency failure"); };',
    '  }',
    '  return loaded;',
    '};',
    "",
  ].join("\n"));
  try {
    const result = runNode(["--require", preloadPath, cliPath, "counts"], { cwd: WORKSPACE_ROOT });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /TypeError: injected unexpected CLI dependency failure/);
    assert.match(result.stderr, /cli\.js:\d+:\d+/,
      "unexpected failures retain their stack location at the public process boundary");
    assert.doesNotMatch(result.stderr, /Unknown command|requires a value/,
      "unexpected errors are not converted to ordinary governed refusals");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- recursive deterministic discovery ---------------------------------------

test("discovery is recursive: a NESTED suite cannot dodge the inventory", () => {
  const root = mkTmp("coord480-nested-");
  try {
    const content = path.join(root, "coord");
    const deep = path.join(content, "scripts", "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(content, "board"), { recursive: true });
    fs.writeFileSync(path.join(deep, "deeply-nested.test.js"), "");
    fs.writeFileSync(path.join(content, "board", "board.test.js"), "");
    const inv = runner.buildInventory({ contentRoot: content });
    const all = inv.modules.flatMap((m) => m.files);
    assert.ok(all.includes("coord/scripts/a/b/c/deeply-nested.test.js"));
    assert.ok(all.includes("coord/board/board.test.js"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real repo inventory covers every *.test.js outside excluded dirs", () => {
  const inv = runner.buildInventory();
  const seen = new Set(inv.modules.flatMap((m) => m.files));
  // Independent walk of the content root that does NOT reuse the runner's own
  // classification, so a classification bug cannot hide a file.
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (runner.EXCLUDED_DIR_NAMES.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.name.endsWith(".test.js")) {
        found.push(
          path
            .relative(inv.workspace_root, path.join(dir, e.name))
            .split(path.sep)
            .join("/")
        );
      }
    }
  };
  walk(CONTENT_ROOT);
  const missing = found.filter((f) => !seen.has(f));
  assert.deepEqual(missing, [], `suites missing from the inventory: ${missing}`);
});

test("discovery is deterministic and byte-wise sorted", () => {
  const a = runner.buildInventory();
  const b = runner.buildInventory();
  assert.deepEqual(a.modules, b.modules);
  for (const m of a.modules) {
    assert.deepEqual(m.files, m.files.slice().sort(), `${m.name} not sorted`);
  }
});

test("classification is total: unknown nested dirs fall into core, never dropped", () => {
  assert.equal(runner.classifyContentTest("board/board.test.js"), "board");
  assert.equal(runner.classifyContentTest("scripts/hooks/x.test.js"), "hooks");
  assert.equal(runner.classifyContentTest("scripts/gates/x.test.js"), "gates");
  assert.equal(runner.classifyContentTest("engine/scripts/gates/x.test.js"), "gates");
  assert.equal(
    runner.classifyContentTest("scripts/enterprise/deploy/x.test.js"),
    "enterprise"
  );
  assert.equal(
    runner.classifyContentTest("engine/scripts/enterprise/deploy/x.test.js"),
    "enterprise"
  );
  assert.equal(runner.classifyContentTest("scripts/x.test.js"), "core");
  assert.equal(
    runner.classifyContentTest("scripts/brand/new/dir/x.test.js"),
    "core"
  );
});

test("fixture directories are excluded so sample suites are not executed", () => {
  assert.ok(runner.EXCLUDED_DIR_NAMES.has("__fixtures__"));
  assert.ok(runner.EXCLUDED_DIR_NAMES.has("node_modules"));
  assert.ok(runner.EXCLUDED_DIR_NAMES.has(".worktrees"));
  assert.ok(runner.EXCLUDED_DIR_NAMES.has(".runtime"));
});

test("COORD-902: test-runner refuses an unsupported Git before discovery", () => {
  const result = callRunnerMain(["--list"], {
    gitCheck: () => ({ ok: false, found: "2.34.1", required: "2.38.0", diagnostic: "Git 2.38.0 or newer is required; found 2.34.1." }),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Git 2\.38\.0 or newer is required; found 2\.34\.1/);
  assert.equal(result.stdout, "");
});

// --- packed-artifact layout ---------------------------------------------------

test("a packed artifact (content root == package root) still resolves and discovers", () => {
  const packed = mkTmp("coord480-packed-");
  try {
    fs.mkdirSync(path.join(packed, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(packed, "board"), { recursive: true });
    fs.writeFileSync(path.join(packed, "scripts", "x.test.js"), "");
    // COORD-873: a packed artifact ships the runner at engine/scripts (content root two levels up).
    fs.mkdirSync(path.join(packed, "engine", "scripts"), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "test-runner.js"), path.join(packed, "engine", "scripts", "test-runner.js"));
    fs.copyFileSync(path.join(__dirname, "test-census-observer.js"), path.join(packed, "engine", "scripts", "test-census-observer.js"));
    fs.copyFileSync(path.join(__dirname, "git-prerequisite.js"), path.join(packed, "engine", "scripts", "git-prerequisite.js"));
    fs.copyFileSync(path.join(__dirname, "sqlite-runtime.js"), path.join(packed, "engine", "scripts", "sqlite-runtime.js"));
    fs.copyFileSync(path.join(__dirname, "test-node-options.js"), path.join(packed, "engine", "scripts", "test-node-options.js"));
    // COORD-909: the runner requires the shared identity module, so a packed engine ships it too.
    fs.copyFileSync(path.join(__dirname, "agent-identity-env.js"), path.join(packed, "engine", "scripts", "agent-identity-env.js"));
    fs.writeFileSync(path.join(packed, "board", "board.test.js"), "");
    const inv = runner.buildInventory({ contentRoot: packed });
    assert.equal(inv.workspace_root, packed);
    assert.equal(inv.layout, "engine");
    assert.equal(runner.workspaceRootForContent(packed), packed,
      "an installed package uses its content root as its workspace root");
    const all = inv.modules.flatMap((m) => m.files);
    assert.ok(all.includes("scripts/x.test.js"));
    assert.ok(all.includes("board/board.test.js"));
    const packedList = runNode([path.join(packed, "engine", "scripts", "test-runner.js"), "--list", "--json"], {
      cwd: os.tmpdir(),
    });
    assert.equal(packedList.status, 0, packedList.stderr);
    const packedInventory = JSON.parse(packedList.stdout);
    assert.equal(packedInventory.content_root, packed);
    assert.equal(packedInventory.workspace_root, packed,
      "the packed CLI executes the package-root side of root normalization");
  } finally {
    fs.rmSync(packed, { recursive: true, force: true });
  }
});

test("donor-only packaging/release roots are only claimed in a donor workspace", () => {
  const root = mkTmp("coord480-donor-");
  try {
    const content = path.join(root, "coord");
    fs.mkdirSync(path.join(content, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(content, "scripts", "x.test.js"), "");
    fs.mkdirSync(path.join(root, "release"), { recursive: true });
    fs.writeFileSync(path.join(root, "release", "r.test.js"), "");
    // No build-public-release.sh yet -> not a donor: release/ is NOT claimed.
    let inv = runner.buildInventory({ contentRoot: content });
    assert.equal(inv.layout, "engine");
    assert.deepEqual(
      inv.modules.find((m) => m.name === "release").files,
      []
    );
    // Now it looks like the donor.
    fs.writeFileSync(path.join(root, "release", "build-public-release.sh"), "");
    inv = runner.buildInventory({ contentRoot: content });
    assert.equal(inv.layout, "donor");
    assert.ok(
      inv.modules.find((m) => m.name === "release").files.includes("release/r.test.js")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- serial, identity-free, isolation-guarded execution ----------------------

test("ambient session identity is stripped from the child environment", () => {
  const before = { ...process.env };
  try {
    process.env.COORD_SESSION_ID = "leaky-session";
    process.env.CLAUDE_CODE_SESSION_ID = "leaky-claude";
    process.env.CLAUDE_SESSION_ID = "leaky-claude-2";
    process.env.COORD_PROVIDER_SESSION_ID = "leaky-provider";
    process.env.COORD_INSTANCE_ID = "leaky-instance";
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    for (const name of runner.STRIPPED_ENV_VARS) {
      assert.ok(!(name in env), `${name} leaked into the child env`);
    }
  } finally {
    for (const k of runner.STRIPPED_ENV_VARS) delete process.env[k];
    for (const k of runner.STRIPPED_ENV_VARS) {
      if (before[k] !== undefined) process.env[k] = before[k];
    }
  }
});

test("the isolation guard is preloaded into every test worker", () => {
  const { env, guard } = runner.buildChildEnv(CONTENT_ROOT);
  assert.equal(guard, path.join(CONTENT_ROOT, "engine", "scripts", "test-isolation-guard.js"));
  assert.ok(fs.existsSync(guard), "isolation guard module must exist");
  assert.match(env.NODE_OPTIONS, /--require /);
  assert.ok(env.NODE_OPTIONS.includes(guard));
});

test("an existing NODE_OPTIONS is preserved, and the guard is not doubled", () => {
  const before = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = "--max-old-space-size=512";
    const first = runner.buildChildEnv(CONTENT_ROOT).env;
    assert.ok(first.NODE_OPTIONS.includes("--max-old-space-size=512"));
    process.env.NODE_OPTIONS = first.NODE_OPTIONS;
    const second = runner.buildChildEnv(CONTENT_ROOT).env;
    assert.equal(second.NODE_OPTIONS, first.NODE_OPTIONS);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
});

test("a test that writes outside its allowed temp roots FAILS the run", () => {
  // End-to-end proof of the fail-closed isolation contract: a suite that writes
  // into the live coord/rendered/** seal surface must make the runner exit non-zero.
  const offender = path.join(CONTENT_ROOT, "scripts", ".coord480-offender.test.js");
  const body = [
    'const test = require("node:test");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'test("writes into the live sealed tree", () => {',
    `  fs.writeFileSync(path.join(${JSON.stringify(CONTENT_ROOT)}, "rendered", ".coord480-should-not-exist"), "x");`,
    "});",
  ].join("\n");
  fs.writeFileSync(offender, body);
  const report = path.join(mkTmp("coord480-report-"), "report.json");
  try {
    const res = runNode(
      [
        RUNNER_PATH,
        "--file",
        path.relative(WORKSPACE_ROOT, offender).split(path.sep).join("/"),
        "--report",
        report,
      ],
      { cwd: WORKSPACE_ROOT }
    );
    assert.notEqual(res.status, 0, "isolation violation must fail the run");
    assert.match(
      `${res.stdout}${res.stderr}`,
      /test-isolation-guard\] BLOCKED/,
      "the guard must name the blocked write"
    );
    assert.ok(
      !fs.existsSync(path.join(CONTENT_ROOT, "rendered", ".coord480-should-not-exist")),
      "the guarded write must never land on disk"
    );
  } finally {
    // Only the offending fixture is removed. The sealed path is deliberately NOT
    // touched here: this test process runs under the same guard, so even a
    // cleanup rmSync under coord/rendered/** is (correctly) blocked — and the
    // assertion above already proves the write never landed.
    fs.rmSync(offender, { force: true });
    fs.rmSync(path.dirname(report), { recursive: true, force: true });
  }
});

// --- machine-readable inventory + summary ------------------------------------

test("--list --json emits a machine-readable inventory", () => {
  const res = runNode([RUNNER_PATH, "--list", "--json"], { cwd: os.tmpdir() });
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.schema_version, 1);
  assert.deepEqual(json.known_modules, runner.MODULE_ORDER);
  assert.ok(Array.isArray(json.modules));
  assert.ok(typeof json.total_files === "number" && json.total_files > 0);
});

test("a run publishes a report with the aggregate order and reproduction environment", () => {
  const dir = mkTmp("coord480-run-");
  const report = path.join(dir, "report.json");
  try {
    const res = runNode(
      [RUNNER_PATH, "--module", "gates", "--report", report],
      { cwd: os.tmpdir() }
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const json = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(json.schema_version, 1);
    assert.equal(json.ticket, "COORD-480");
    assert.equal(json.result, "pass");
    assert.equal(json.environment.test_concurrency, 1);
    assert.deepEqual(
      json.environment.stripped_env_vars,
      runner.STRIPPED_ENV_VARS.slice()
    );
    assert.ok(json.environment.node_options.includes("test-isolation-guard.js"));
    assert.ok(json.node_version.startsWith("v"));
    assert.ok(Array.isArray(json.execution_order) && json.execution_order.length > 0);
    // Execution order is exactly what ran, in aggregate order.
    assert.deepEqual(
      json.execution_order,
      json.results.flatMap((r) => r.files)
    );
    assert.ok(json.totals.tests > 0);
    assert.match(res.stdout, /concord-tests: modules=\d+ files=\d+ tests=\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summary parsing captures counts and failing test names", () => {
  const parsed = runner.parseTapSummary(
    [
      "TAP version 13",
      "ok 1 - ok one",
      "not ok 2 - alpha fails",
      "    # Subtest: nested",
      "    not ok 1 - beta fails",
      "    # tests 1",
      "    # pass 0",
      "    # fail 1",
      "ok 3 - skipped one # SKIP",
      "# tests 12",
      "# suites 0",
      "# pass 10",
      "# fail 2",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 42.5",
    ].join("\n")
  );
  // Only the UNINDENTED trailer supplies the aggregate totals.
  assert.equal(parsed.counts.tests, 12);
  assert.equal(parsed.counts.pass, 10);
  assert.equal(parsed.counts.fail, 2);
  assert.equal(parsed.counts.duration_ms, 42.5);
  assert.deepEqual(parsed.failing_tests, ["alpha fails", "beta fails"]);
});

test("COORD-816: summary parsing names every skipped test and suite by its nesting path", () => {
  const parsed = runner.parseTapSummary(
    [
      "TAP version 13",
      "# Subtest: top skip",
      "ok 1 - top skip # SKIP release cuts intentionally omit init.sh",
      "# Subtest: parent",
      "    # Subtest: child \\# 1",
      "    ok 1 - child \\# 1 # SKIP",
      "    # Subtest: inner",
      "        # Subtest: deep",
      "        ok 1 - deep # SKIP dynamic",
      "    ok 2 - inner",
      "ok 2 - parent",
      "# Subtest: skipped suite",
      "ok 3 - skipped suite # SKIP",
      "# Subtest: literal \\# SKIP in a passing name",
      "ok 4 - literal \\# SKIP in a passing name",
      "# Subtest: later",
      "ok 5 - later # TODO",
      "# Subtest: fails",
      "not ok 6 - fails",
      "# Subtest: odd indent",
      "  ok 7 - odd indent # SKIP",
      "# tests 7",
      "# skipped 3",
      "# todo 1",
    ].join("\n")
  );
  // A skipped SUITE is absent from the `# skipped` count, so the named list is
  // the only place it is visible at all.
  assert.deepEqual(parsed.counts.skipped_tests, [
    "top skip", "parent > child # 1", "parent > inner > deep", "skipped suite", "odd indent",
  ]);
  assert.equal(parsed.counts.skipped, 3);
  assert.deepEqual(parsed.failing_tests, ["fails"]);
});

test("module output streams live (the runner does not buffer a long module)", () => {
  // spawnSync with stdio:"inherit" is what makes a 20-minute module visible in
  // CI as it runs; the machine-readable half comes from the TAP side-channel.
  const src = fs.readFileSync(path.join(__dirname, "test-runner.js"), "utf8");
  assert.match(src, /stdio: "inherit"/);
  assert.match(src, /--test-reporter=spec/);
  assert.match(src, /--test-reporter=tap/);
});

// --- focused module commands stay available ----------------------------------

test("focused module and file selection run through the same contract", () => {
  const opts = runner.parseArgs(["--module", "board,gates", "--file", "x.test.js"]);
  assert.deepEqual(opts.modules, ["board", "gates"]);
  assert.deepEqual(opts.files, ["x.test.js"]);
  assert.deepEqual(opts.errors, []);
});

test("COORD-900: TAP summaries preserve each test identity and outcome for serial/sharded comparison", () => {
  const summary = runner.parseTapSummary([
    "    # Subtest: coord/engine/example.test.js",
    "        # Subtest: nested passing test",
    "        ok 1 - nested passing test",
    "        # Subtest: named skip",
    "        ok 2 - named skip # SKIP platform constraint",
    "    ok 1 - coord/engine/example.test.js",
    "# tests 2", "# pass 1", "# fail 0", "# skipped 1", "# todo 0",
  ].join("\n"));
  assert.deepEqual(summary.test_outcomes, [
    { identity: "coord/engine/example.test.js > nested passing test", outcome: "pass" },
    { identity: "coord/engine/example.test.js > named skip", outcome: "skip" },
    { identity: "coord/engine/example.test.js", outcome: "pass" },
  ]);
});

test("COORD-900: sharded runner output separates green execution from provisional qualification", () => {
  const report = { coverage: "engine lines=99% branches=98%", engine_coverage: { ratchet: { result: "pass" } } };
  assert.match(runner.formatCoverageLine(report, true), /ratchet=PASS/);
  assert.doesNotMatch(runner.formatCoverageLine(report, true), /result=PASS/);
  assert.match(runner.formatCoverageLine(report, false), /result=PASS/);
});

test("coverage baselines bind each supported CI lane to its measured runtime", () => {
  const root = path.join(os.tmpdir(), "coverage-lane-test");
  const node22 = runner.coverageBaselinePathForNode(root, "v22.8.0");
  const node24 = runner.coverageBaselinePathForNode(root, "v24.13.0");
  assert.notEqual(node22, node24);
  assert.match(node22, /engine-coverage-baseline-node22\.json$/);
  assert.match(node24, /engine-coverage-baseline-node24\.json$/);
  assert.match(runner.coverageBaselinePathForNode(root, "v25.8.1"), /engine-coverage-baseline\.json$/);
  const measured = {
    identity_version: 4,
    identity_format: "raw-v8-source-range-v1",
    aggregation: "node-testcoverage-native-v1",
    node_major: 22,
    measured_node_version: "v22.8.0",
    source_commit: "a".repeat(40),
    measured_at: "2026-09-29T00:00:00.000Z",
  };
  assert.doesNotThrow(() => runner.assertCoverageBaselineProvenance(measured, node22, "v22.8.0"));
  assert.throws(() => runner.assertCoverageBaselineProvenance({ ...measured, identity_version: 3 }, node22, "v22.8.0"), /remeasurement/);
  assert.throws(() => runner.assertCoverageBaselineProvenance({ ...measured, identity_format: "ordinal-v3" }, node22, "v22.8.0"), /remeasurement/);
  assert.throws(() => runner.assertCoverageBaselineProvenance(measured, node24, "v24.13.0"), /provenance/);
  assert.throws(() => runner.assertCoverageBaselineProvenance({ ...measured, source_commit: "unknown" }, node22, "v22.8.0"), /provenance/);
  const genericBaseline = path.join(root, "engine", "scripts", "engine-coverage-baseline.json");
  assert.doesNotThrow(() => runner.assertCoverageBaselineProvenance({}, genericBaseline, "v20.20.0"),
    "the generic baseline remains valid when it has no unstable-site exceptions");
  assert.throws(() => runner.assertCoverageBaselineProvenance({ unstable_findings: [] }, genericBaseline, "v20.20.0"),
    /require a supported Node lane baseline/,
    "the generic baseline cannot carry unstable-site exceptions without a supported lane identity");
});

test("COORD-800 source relocation reads only the explicit baseline Git blob and hash-bound current file", () => {
  const workspaceRoot = mkTmp("coord800-source-provider-");
  const outsideContentRoot = mkTmp("coord800-outside-content-");
  const contentRoot = path.join(workspaceRoot, "coord");
  const relativeFile = "scripts/sample.js";
  const sourcePath = path.join(contentRoot, ...relativeFile.split("/"));
  const bomPath = path.join(contentRoot, "scripts", "bom.js");
  const invalidBaselinePath = path.join(contentRoot, "scripts", "invalid-baseline.js");
  const ancestorFile = path.join(contentRoot, "redirect", "escaped.js");
  const ancestorBaseline = "function escaped() { return 2; }\n";
  const bomSource = "\uFEFFconst orbit = '🪐';\n";
  const invalidBaselineBytes = Buffer.from([0xff, 0xfe]);
  const baselineSource = "function sample() { return 1; }\n";
  const currentSource = "// harmless prefix\n" + baselineSource;
  const git = (args, cwd = workspaceRoot) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(ancestorFile), { recursive: true });
    fs.writeFileSync(sourcePath, baselineSource);
    fs.writeFileSync(bomPath, bomSource);
    fs.writeFileSync(invalidBaselinePath, invalidBaselineBytes);
    fs.writeFileSync(ancestorFile, ancestorBaseline);
    git(["init", "-q"]);
    git(["config", "user.name", "Coverage Fixture"]);
    git(["config", "user.email", "coverage@example.invalid"]);
    git(["add", "coord/scripts/sample.js", "coord/scripts/bom.js", "coord/scripts/invalid-baseline.js", "coord/redirect/escaped.js"]);
    git(["commit", "-q", "-m", "baseline source fixture"]);
    const baselineCommit = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(sourcePath, currentSource);
    const replacementSource = "function replacement() { return 3; }\n";
    fs.writeFileSync(invalidBaselinePath, replacementSource);
    const expectedCurrentHash = require("node:crypto").createHash("sha256").update(currentSource).digest("hex");

    // COORD-881: the lazy baselineHistory accessor is covered by engine-coverage.test.js.
    const withoutHistory = ({ baselineHistory, ...sources }) => sources;
    assert.deepEqual(withoutHistory(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash })), {
      baselineSource, currentSource,
    });
    git(["commit", "-q", "-m", "edition donor snapshot", "--", "coord/scripts/sample.js"]);
    const donorCommit = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(sourcePath, "// after the cut\n" + currentSource);
    git(["commit", "-q", "-m", "later donor change", "--", "coord/scripts/sample.js"]);
    fs.writeFileSync(sourcePath, currentSource);
    const orphanRoot = path.join(outsideContentRoot, "cut");
    const orphanContent = path.join(orphanRoot, "coord");
    const orphanFile = path.join(orphanContent, relativeFile);
    const provenance = path.join(orphanContent, "RELEASE_PROVENANCE.json");
    fs.mkdirSync(path.dirname(orphanFile), { recursive: true });
    fs.writeFileSync(orphanFile, currentSource);
    fs.writeFileSync(provenance, JSON.stringify({ donor_commit: donorCommit }));
    gitFixture(orphanRoot, ["init", "-q"]);
    git(["add", "coord"], orphanRoot);
    git(["-c", "user.name=Coverage Fixture", "-c", "user.email=coverage@example.invalid",
      "commit", "-q", "-m", "orphan cut"], orphanRoot);
    const fromCut = { workspaceRoot: orphanRoot, contentRoot: orphanContent,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash };
    assert.equal(coverageSourceProvider.readBaselineCoverageSources(fromCut), null);
    const history = { historyRoot: workspaceRoot, historyHead: donorCommit };
    const cutLookup = coverageSourceProvider.readBaselineCoverageSources({ ...fromCut, ...history });
    assert.deepEqual(withoutHistory(cutLookup), { baselineSource, currentSource });
    assert.deepEqual(cutLookup.baselineHistory(), [currentSource], "history stops at the cut's donor commit");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({
      ...fromCut, ...history, expectedCurrentHash: "f".repeat(64),
    }), null, "donor access does not waive the current artifact source hash");
    assert.equal(git(["rev-list", "--count", "HEAD"], orphanRoot), "1");
    assert.equal(git(["remote"], orphanRoot), "");
    assert.equal(spawnSync("git", ["cat-file", "-e", baselineCommit], { cwd: orphanRoot }).status, 1);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({
      ...fromCut, ...history, historyHead: "HEAD",
    }), null, "a cut cannot use the mutable donor HEAD as history horizon");
    const bomHash = require("node:crypto").createHash("sha256").update(bomSource).digest("hex");
    const bomLookup = coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "scripts/bom.js", expectedCurrentHash: bomHash });
    assert.deepEqual(withoutHistory(bomLookup), { currentSource: bomSource, baselineSource: bomSource });
    assert.equal(bomLookup.currentSource.indexOf("const orbit"), 1,
      "BOM decoding retains the same UTF-16 start offset used by V8 range witnesses");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash: "0".repeat(64) }), null,
    "a current checkout that does not match the coverage census fingerprint gets no relocation source");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: "f".repeat(40), file: relativeFile, expectedCurrentHash }), null,
    "an unavailable immutable Git blob grants no inherited credit");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: "bad", file: relativeFile, expectedCurrentHash }), null,
    "malformed immutable commit identifiers fail closed before git lookup");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: null, file: relativeFile, expectedCurrentHash }), null,
    "a missing immutable commit identifier cannot be coerced into a usable source lookup");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash: null }), null,
    "missing measured-source hashes grant no relocation source");
    for (const file of ["../outside.js", "/absolute.js", "scripts\\sample.js", "scripts/./sample.js", "scripts//sample.js"]) {
      assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
        sourceCommit: baselineCommit, file, expectedCurrentHash }), null, file);
    }
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "scripts/missing.js", expectedCurrentHash }), null);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash: "not-a-sha256" }), null);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: null, expectedCurrentHash }), null);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "C:/outside.js", expectedCurrentHash }), null);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot: outsideContentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash }), null,
    "content-root source lookup cannot escape its explicit workspace root");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot: path.join(workspaceRoot, "missing"), contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash }), null,
    "missing roots fail closed");

    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    const invalidSourcePath = path.join(contentRoot, "scripts", "invalid-encoding.js");
    fs.writeFileSync(invalidSourcePath, invalidUtf8);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "scripts/invalid-encoding.js",
      expectedCurrentHash: require("node:crypto").createHash("sha256").update(invalidUtf8).digest("hex") }), null,
    "non-UTF-8 source is not coerced into a different JavaScript range coordinate space");
    const replacementHash = require("node:crypto").createHash("sha256").update(replacementSource).digest("hex");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "scripts/invalid-baseline.js", expectedCurrentHash: replacementHash }), null,
    "an invalid-UTF-8 baseline Git blob grants no relocation source");

    const directoryPath = path.join(contentRoot, "scripts", "directory");
    fs.mkdirSync(directoryPath);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "scripts/directory", expectedCurrentHash }), null,
    "directories are not accepted as source files");

    fs.unlinkSync(sourcePath);
    fs.symlinkSync(path.join(workspaceRoot, "coord", "scripts", "linked.js"), sourcePath);
    fs.writeFileSync(path.join(contentRoot, "scripts", "linked.js"), currentSource);
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: relativeFile, expectedCurrentHash }), null,
    "the source provider accepts regular source files only, without following a repository symlink");

    fs.unlinkSync(sourcePath);
    fs.rmSync(path.join(contentRoot, "redirect"), { recursive: true, force: true });
    const outside = path.join(workspaceRoot, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "escaped.js"), ancestorBaseline);
    fs.symlinkSync(outside, path.join(contentRoot, "redirect"), "dir");
    const ancestorHash = require("node:crypto").createHash("sha256").update(ancestorBaseline).digest("hex");
    assert.equal(coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot, contentRoot,
      sourceCommit: baselineCommit, file: "redirect/escaped.js", expectedCurrentHash: ancestorHash }), null,
    "an ancestor directory symlink cannot redirect current-source reads outside the content root");

    const packedRoot = path.join(workspaceRoot, "packed");
    const packedFile = path.join(packedRoot, "scripts", "packed.js");
    const packedSource = "function packed() { return 4; }\n";
    fs.mkdirSync(path.dirname(packedFile), { recursive: true });
    fs.writeFileSync(packedFile, packedSource);
    git(["init", "-q"], packedRoot);
    git(["config", "user.name", "Coverage Fixture"], packedRoot);
    git(["config", "user.email", "coverage@example.invalid"], packedRoot);
    git(["add", "scripts/packed.js"], packedRoot);
    git(["commit", "-q", "-m", "packed source fixture"], packedRoot);
    const packedCommit = git(["rev-parse", "HEAD"], packedRoot);
    const packedLookup = coverageSourceProvider.readBaselineCoverageSources({ workspaceRoot: packedRoot,
      contentRoot: packedRoot, sourceCommit: packedCommit, file: "scripts/packed.js",
      expectedCurrentHash: require("node:crypto").createHash("sha256").update(packedSource).digest("hex") });
    assert.deepEqual(withoutHistory(packedLookup), {
      currentSource: packedSource, baselineSource: packedSource,
    }, "packed layout with content root equal to workspace root is supported");
    const packedLater = "function packed() { return 5; }\n";
    fs.writeFileSync(packedFile, packedLater);
    git(["commit", "-q", "-am", "packed source edit"], packedRoot);
    assert.deepEqual(packedLookup.baselineHistory(), [packedLater],
      "packed history resolves committed versions without a content-root prefix");
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideContentRoot, { recursive: true, force: true });
  }
});

test("COORD-800 runner joins native coverage to the immutable baseline source provider",
  { skip: nativeCoverageUnsupported ? `native coverage fixture supports Node 22.x/24.x, found ${process.version}` : false }, () => {
  const workspaceRoot = mkTmp("coord800-runner-source-join-");
  const contentRoot = path.join(workspaceRoot, "coord");
  const fixtureFile = path.join(contentRoot, "scripts", "fixture.js");
  const fixtureTest = path.join(contentRoot, "scripts", "fixture.test.js");
  const baselineReport = path.join(workspaceRoot, "baseline-report.json");
  const currentReport = path.join(workspaceRoot, "current-report.json");
  const baselineSource = "function choose(flag) {\n  if (flag) return 'yes';\n  return 'no';\n}\nmodule.exports = choose;\n";
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: workspaceRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  const buildFixtureInventory = () => ({
    layout: "engine",
    content_root: contentRoot,
    workspace_root: workspaceRoot,
    modules: [{ name: "core", files: [path.relative(workspaceRoot, fixtureTest).split(path.sep).join("/")] }],
  });
  try {
    fs.mkdirSync(contentRoot, { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "scripts"), path.join(contentRoot, "scripts"), { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "engine"), path.join(contentRoot, "engine"), { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "paths.js"), path.join(contentRoot, "paths.js"));
    fs.writeFileSync(fixtureFile, baselineSource);
    fs.writeFileSync(fixtureTest,
      "const test = require('node:test');\n" +
      "const choose = require('./fixture.js');\n" +
      "test('leave one real source-range branch uncovered', () => require('node:assert/strict').equal(choose(true), 'yes'));\n");
    runGit(["init", "-q"]);
    runGit(["config", "user.name", "Coverage Fixture"]);
    runGit(["config", "user.email", "coverage@example.invalid"]);
    runGit(["add", "coord"]);
    runGit(["commit", "-q", "-m", "coverage source-provider fixture baseline"]);

    assert.equal(runner.main(["--write-coverage-baseline", "--report", baselineReport], {
      buildInventory: buildFixtureInventory,
    }), 0, "the fixture baseline is produced by the real native aggregation path");
    const baseline = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
    assert.equal(baseline.result, "pass");
    const baselineBytes = fs.readFileSync(runner.coverageBaselinePathForNode(contentRoot));

    // Preserve compatibility for the generic legacy baseline filename.
    const originalProcessVersion = Object.getOwnPropertyDescriptor(process, "version");
    try {
      Object.defineProperty(process, "version", { ...originalProcessVersion, value: "v20.20.0" });
      const legacyReport = path.join(workspaceRoot, "legacy-baseline-report.json");
      assert.equal(runner.main(["--write-coverage-baseline", "--report", legacyReport], {
        buildInventory: buildFixtureInventory,
        nodeVersion: "v24.22.1",
      }), 0);
      const legacyBaseline = JSON.parse(fs.readFileSync(runner.coverageBaselinePathForNode(contentRoot), "utf8"));
      assert.equal(legacyBaseline.identity_version, 1);
      assert.equal(legacyBaseline.identity_format, undefined);
      assert.equal(legacyBaseline.aggregation, undefined);
    } finally {
      Object.defineProperty(process, "version", originalProcessVersion);
    }

    assert.ok(baseline.engine_coverage.measurement.findings.some((finding) =>
      finding.file === "scripts/fixture.js" && finding.value.startsWith("branches:range:")),
    "the immutable fixture baseline records an actual V8 source-range branch finding");

    const previousReport = process.env.COORD_TEST_REPORT;
    let defaultReport;
    try {
      const overrideReport = path.join(workspaceRoot, "environment-report.json");
      process.env.COORD_TEST_REPORT = overrideReport;
      const overriddenReportRun = callRunnerMain(["--module", "core"], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(overriddenReportRun.status, 0, overriddenReportRun.stderr);
      assert.ok(overriddenReportRun.stdout.includes("concord-tests: report=" + overrideReport));
      assert.equal(JSON.parse(fs.readFileSync(overrideReport, "utf8")).result, "pass");

      delete process.env.COORD_TEST_REPORT;
      const defaultReportRun = callRunnerMain(["--module", "core"], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(defaultReportRun.status, 0, defaultReportRun.stderr);
      defaultReport = /concord-tests: report=(.+)\n/.exec(defaultReportRun.stdout)?.[1];
      assert.ok(defaultReport && fs.existsSync(defaultReport), "the default report path is published and exists");
      assert.equal(path.dirname(defaultReport), os.tmpdir());
    } finally {
      if (previousReport === undefined) delete process.env.COORD_TEST_REPORT;
      else process.env.COORD_TEST_REPORT = previousReport;
      if (defaultReport) fs.rmSync(defaultReport, { force: true });
    }

    const currentSource = `// inserted before the unchanged function\n${baselineSource}`;
    fs.writeFileSync(fixtureFile, currentSource);
    const currentRun = callRunnerMain(["--engine-coverage", "--json", "--report", currentReport], {
      buildInventory: buildFixtureInventory,
    });
    assert.equal(currentRun.status, 0, currentRun.stderr);
    assert.match(currentRun.stdout, /\"engine_coverage\"/,
      "JSON report output remains available after the native runner path");
    const current = JSON.parse(fs.readFileSync(currentReport, "utf8"));
    assert.equal(current.result, "pass");
    assert.ok(current.engine_coverage.ratchet.relocated_uncovered.some((finding) =>
      finding.file === "scripts/fixture.js" && finding.kind === "branches"),
    "the report proves a real V8 range was joined to its immutable baseline source");
    assert.equal(current.engine_coverage.ratchet.new_uncovered.length, 0,
      "the fixture introduces only a line relocation, with no new uncovered behavior");

    const donorRoot = mkTmp("coord800-fixture-donor-");
    const donorGit = path.join(donorRoot, ".git");
    const cutGit = path.join(workspaceRoot, ".git");
    const donorHead = runGit(["rev-parse", "HEAD"]);
    const logger = path.join(donorRoot, "release", "suite-skip-log.js");
    const outputRoot = path.join(donorRoot, "records");
    const descriptorPath = path.join(donorRoot, "observer.json");
    const loggerSource = "// Coverage history observer fixture\n";
    const loggerDigest = require("node:crypto").createHash("sha256").update(loggerSource).digest("hex");
    fs.mkdirSync(path.dirname(logger));
    fs.mkdirSync(outputRoot);
    fs.writeFileSync(logger, loggerSource);
    fs.writeFileSync(descriptorPath, JSON.stringify({ schema_version: 1, kind: "release-suite-census",
      mode: "serial", logger_path: logger, logger_sha256: `sha256:${loggerDigest}`, output_root: outputRoot }));
    fs.renameSync(cutGit, donorGit);
    const previousHistory = process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD;
    try {
      gitFixture(workspaceRoot, ["init", "-q"]);
      runGit(["add", "coord/scripts/fixture.js"]);
      runGit(["-c", "user.name=Coverage Fixture", "-c", "user.email=coverage@example.invalid",
        "commit", "-q", "-m", "orphan edition fixture"]);
      assert.notEqual(runGit(["rev-parse", "HEAD"]), donorHead);

      const releaseArgs = ["--engine-coverage", "--qualification-stage", "release", "--policy-stage", "release",
        "--qualification-mode", "full", "--census-observer", descriptorPath, "--report", currentReport];
      process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD = donorHead;
      const released = callRunnerMain(releaseArgs, { buildInventory: buildFixtureInventory });
      assert.equal(released.status, 0, released.stderr);
      const releaseReport = JSON.parse(fs.readFileSync(currentReport, "utf8"));
      assert.ok(releaseReport.engine_coverage.ratchet.relocated_uncovered.some((finding) =>
        finding.file === "scripts/fixture.js" && finding.kind === "branches"));
      assert.equal(releaseReport.engine_coverage.ratchet.new_uncovered.length, 0);
      assert.equal(spawnSync("git", ["cat-file", "-e", donorHead], { cwd: workspaceRoot }).status, 1);
    } finally {
      if (previousHistory === undefined) delete process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD;
      else process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD = previousHistory;
      fs.rmSync(cutGit, { recursive: true, force: true });
      fs.renameSync(donorGit, cutGit);
      fs.rmSync(donorRoot, { recursive: true, force: true });
    }

    const exclusions = JSON.parse(baselineBytes.toString("utf8"));
    exclusions.exclusions = ["**/different-contract/**"];
    fs.writeFileSync(runner.coverageBaselinePathForNode(contentRoot), JSON.stringify(exclusions));
    const diagnosticRoot = path.join(workspaceRoot, "retained-coverage-diagnostics");
    const previousKeep = process.env.COORD_KEEP_RAW_COVERAGE_ON_ERROR;
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    process.env.COORD_KEEP_RAW_COVERAGE_ON_ERROR = "1";
    process.env.RUNNER_TEMP = diagnosticRoot;
    try {
      const exclusionsReport = path.join(workspaceRoot, "exclusions-report.json");
      const exclusionsRun = callRunnerMain(["--engine-coverage", "--report", exclusionsReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(exclusionsRun.status, 1, "a changed baseline exclusion contract fails closed");
      const exclusionsResult = JSON.parse(fs.readFileSync(exclusionsReport, "utf8"));
      assert.match(exclusionsResult.engine_coverage.error, /exclusion contract differs/);
      assert.ok(exclusionsResult.engine_coverage.raw_snapshot_diagnostic_directory);
      assert.ok(fs.existsSync(exclusionsResult.engine_coverage.raw_snapshot_diagnostic_directory),
        "the opt-in failure path preserves native coverage evidence under RUNNER_TEMP");

      // With no RUNNER_TEMP, use the OS temp directory and retain an unknown
      // Git commit in both the report and diagnostic manifest.
      delete process.env.RUNNER_TEMP;
      const gitDirectory = path.join(workspaceRoot, ".git");
      const savedGitDirectory = path.join(workspaceRoot, ".git-unavailable-fixture");
      fs.renameSync(gitDirectory, savedGitDirectory);
      let fallbackDiagnostic = null;
      let unknownWriteDiagnostic = null;
      try {
        const fixtureBaselinePath = runner.coverageBaselinePathForNode(contentRoot);
        const bytesBeforeUnknownCommitWrite = fs.readFileSync(fixtureBaselinePath);
        const unknownWriteReport = path.join(workspaceRoot, "unknown-commit-baseline-report.json");
        const unknownWriteRun = callRunnerMain(["--write-coverage-baseline", "--report", unknownWriteReport], {
          buildInventory: buildFixtureInventory,
        });
        assert.equal(unknownWriteRun.status, 1);
        const unknownWriteResult = JSON.parse(fs.readFileSync(unknownWriteReport, "utf8"));
        assert.match(unknownWriteResult.engine_coverage.error, /provenance or identity format/);
        assert.equal(unknownWriteResult.commit, "unknown");
        assert.deepEqual(fs.readFileSync(fixtureBaselinePath), bytesBeforeUnknownCommitWrite,
          "a baseline cannot be refreshed without a verifiable Git commit");
        unknownWriteDiagnostic = unknownWriteResult.engine_coverage.raw_snapshot_diagnostic_directory;
        assert.ok(unknownWriteDiagnostic.startsWith(os.tmpdir() + path.sep));
        assert.equal(JSON.parse(fs.readFileSync(path.join(unknownWriteDiagnostic, "manifest.json"), "utf8")).source_commit, "unknown");

        const fallbackReport = path.join(workspaceRoot, "fallback-diagnostics-report.json");
        const fallbackRun = callRunnerMain(["--engine-coverage", "--report", fallbackReport], {
          buildInventory: buildFixtureInventory,
        });
        assert.equal(fallbackRun.status, 1);
        const fallbackResult = JSON.parse(fs.readFileSync(fallbackReport, "utf8"));
        fallbackDiagnostic = fallbackResult.engine_coverage.raw_snapshot_diagnostic_directory;
        assert.ok(fallbackDiagnostic.startsWith(os.tmpdir() + path.sep));
        const fallbackManifest = JSON.parse(fs.readFileSync(path.join(fallbackDiagnostic, "manifest.json"), "utf8"));
        assert.equal(fallbackManifest.source_commit, "unknown");
        assert.equal(fallbackResult.commit, "unknown");
      } finally {
        if (fallbackDiagnostic) fs.rmSync(fallbackDiagnostic, { recursive: true, force: true });
        if (unknownWriteDiagnostic) fs.rmSync(unknownWriteDiagnostic, { recursive: true, force: true });
        fs.renameSync(savedGitDirectory, gitDirectory);
        process.env.RUNNER_TEMP = diagnosticRoot;
      }

      // If diagnostic storage itself is unavailable, keep the original worker
      // snapshots and publish that retention failure in the coverage report.
      const blockedDiagnosticRoot = path.join(workspaceRoot, "diagnostic-root-is-a-file");
      fs.writeFileSync(blockedDiagnosticRoot, "not a directory");
      process.env.RUNNER_TEMP = blockedDiagnosticRoot;
      const retentionFailureReport = path.join(workspaceRoot, "retention-failure-report.json");
      const retentionFailureRun = callRunnerMain(["--engine-coverage", "--report", retentionFailureReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(retentionFailureRun.status, 1);
      const retentionFailure = JSON.parse(fs.readFileSync(retentionFailureReport, "utf8"));
      assert.match(retentionFailure.engine_coverage.error, /raw V8 diagnostic retention failed/);
      assert.equal(retentionFailure.engine_coverage.raw_snapshot_diagnostic_directory, null);
      assert.equal(retentionFailure.engine_coverage.raw_snapshot_directories.length, 1,
        "worker snapshots remain available when copying them to the diagnostic root fails");
      assert.ok(fs.existsSync(retentionFailure.engine_coverage.raw_snapshot_directories[0]));
      fs.rmSync(retentionFailure.engine_coverage.raw_snapshot_directories[0], { recursive: true, force: true });
      process.env.RUNNER_TEMP = diagnosticRoot;

      fs.writeFileSync(runner.coverageBaselinePathForNode(contentRoot), baselineBytes);

      // A changed covered arm must be reported as a ratchet failure, with the
      // finding printed for the operator and retained in the machine report.
      fs.writeFileSync(fixtureTest,
        "const test = require('node:test');\n" +
        "const choose = require('./fixture.js');\n" +
        "test('exercise the opposite source-range arm', () => require('node:assert/strict').equal(choose(false), 'no'));\n");
      const ratchetFailureReport = path.join(workspaceRoot, "ratchet-failure-report.json");
      const ratchetFailureRun = callRunnerMain(["--engine-coverage", "--report", ratchetFailureReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(ratchetFailureRun.status, 1);
      assert.match(ratchetFailureRun.stdout, /concord-coverage: .*result=FAIL/);
      assert.match(ratchetFailureRun.stdout, /concord-coverage:   ✖ scripts\/fixture\.js/);
      const ratchetFailure = JSON.parse(fs.readFileSync(ratchetFailureReport, "utf8"));
      assert.equal(ratchetFailure.result, "fail");
      assert.ok(ratchetFailure.engine_coverage.ratchet.new_uncovered.some((finding) =>
        finding.file === "scripts/fixture.js" && String(finding.value).startsWith("branches:range:")));

      // A failed suite blocks a baseline refresh and leaves the measured bytes
      // untouched, even though coverage aggregation itself succeeds.
      const failedTest = "const test = require('node:test');\n" +
        "const choose = require('./fixture.js');\n" +
        "test('fail the baseline write gate after exercising source', () => { require('node:assert/strict').equal(choose(true), 'yes'); throw new Error('fixture failure'); });\n";
      fs.writeFileSync(fixtureTest, failedTest);
      const failedBaselineReport = path.join(workspaceRoot, "failed-baseline-report.json");
      const failedBaselineRun = callRunnerMain(["--write-coverage-baseline", "--report", failedBaselineReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(failedBaselineRun.status, 1);
      const failedBaseline = JSON.parse(fs.readFileSync(failedBaselineReport, "utf8"));
      assert.match(failedBaseline.engine_coverage.error, /aggregate tests or isolation checks failed/);
      assert.deepEqual(fs.readFileSync(runner.coverageBaselinePathForNode(contentRoot)), baselineBytes,
        "failed suite results cannot replace the existing baseline");

      // Missing worker LCOV is a hard coverage error, even when the test passed.
      fs.writeFileSync(fixtureTest,
        "const test = require('node:test');\n" +
        "const choose = require('./fixture.js');\n" +
        "test('fixture passes while LCOV is unavailable', () => require('node:assert/strict').equal(choose(true), 'yes'));\n");
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        if (String(file).includes("concord-lcov-") && String(file).endsWith(".info")) {
          const error = new Error("injected missing LCOV fixture");
          error.code = "ENOENT";
          throw error;
        }
        return originalReadFileSync.call(this, file, ...args);
      };
      try {
        const missingLcovReport = path.join(workspaceRoot, "missing-lcov-report.json");
        const missingLcovRun = callRunnerMain(["--engine-coverage", "--report", missingLcovReport], {
          buildInventory: buildFixtureInventory,
        });
        assert.equal(missingLcovRun.status, 1);
        const missingLcov = JSON.parse(originalReadFileSync(missingLcovReport, "utf8"));
        assert.match(missingLcov.engine_coverage.error, /LCOV\/raw coverage reports are missing/);

        fs.readFileSync = function (file, ...args) {
          if (String(file).includes("concord-lcov-") && String(file).endsWith(".info")) return "";
          return originalReadFileSync.call(this, file, ...args);
        };
        const emptyLcovReport = path.join(workspaceRoot, "empty-lcov-report.json");
        const emptyLcovRun = callRunnerMain(["--engine-coverage", "--report", emptyLcovReport], {
          buildInventory: buildFixtureInventory,
        });
        assert.equal(emptyLcovRun.status, 1);
        const emptyLcov = JSON.parse(originalReadFileSync(emptyLcovReport, "utf8"));
        assert.equal(emptyLcov.result, "fail");
        assert.match(emptyLcov.engine_coverage.error, /empty or duplicate source census/);
      } finally {
        fs.readFileSync = originalReadFileSync;
      }

      // A real constant-only production module has measurable line coverage,
      // but no branches or functions. The runner must refuse to write a
      // baseline when the measured coverage is not useful enough to ratchet.
      const sourceBeforeNoMeasurableCoverage = fs.readFileSync(fixtureFile);
      const testBeforeNoMeasurableCoverage = fs.readFileSync(fixtureTest);
      fs.writeFileSync(fixtureFile, "module.exports = 1;\n");
      fs.writeFileSync(fixtureTest,
        "const test = require('node:test');\n" +
        "const value = require('./fixture.js');\n" +
        "test('load the constant-only production module', () => require('node:assert/strict').equal(value, 1));\n");
      try {
        const noMeasurableReport = path.join(workspaceRoot, "no-measurable-report.json");
        const noMeasurableRun = callRunnerMain(["--write-coverage-baseline", "--report", noMeasurableReport], {
          buildInventory: buildFixtureInventory,
        });
        assert.equal(noMeasurableRun.status, 1);
        const noMeasurable = JSON.parse(fs.readFileSync(noMeasurableReport, "utf8"));
        assert.match(noMeasurable.engine_coverage.error, /no measurable production line, branch or function coverage/);
        assert.deepEqual(fs.readFileSync(runner.coverageBaselinePathForNode(contentRoot)), baselineBytes,
          "a measurement without branch or function data cannot replace the baseline");
      } finally {
        fs.writeFileSync(fixtureFile, sourceBeforeNoMeasurableCoverage);
        fs.writeFileSync(fixtureTest, testBeforeNoMeasurableCoverage);
      }

      const fixtureBaselinePath = runner.coverageBaselinePathForNode(contentRoot);
      fs.writeFileSync(fixtureBaselinePath, "{ invalid baseline json\n");
      const corruptBaselineReport = path.join(workspaceRoot, "corrupt-baseline-report.json");
      const corruptBaselineRun = callRunnerMain(["--engine-coverage", "--report", corruptBaselineReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(corruptBaselineRun.status, 1);
      const corruptBaseline = JSON.parse(fs.readFileSync(corruptBaselineReport, "utf8"));
      assert.match(corruptBaseline.engine_coverage.error, /JSON|property|position|Unexpected token/i);
      assert.equal(corruptBaseline.result, "fail",
        "corrupt baseline data cannot produce a passing coverage report");
      fs.writeFileSync(fixtureBaselinePath, baselineBytes);
      runGit(["update-ref", "-d", "HEAD"]);
      const missingCommitReport = path.join(workspaceRoot, "missing-commit-report.json");
      const missingCommitRun = callRunnerMain(["--write-coverage-baseline", "--report", missingCommitReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(missingCommitRun.status, 1, "baseline writing fails closed when Git cannot name a source commit");
      const missingCommitResult = JSON.parse(fs.readFileSync(missingCommitReport, "utf8"));
      assert.match(missingCommitResult.engine_coverage.error, /provenance or identity format/);
      assert.deepEqual(fs.readFileSync(runner.coverageBaselinePathForNode(contentRoot)), baselineBytes,
        "invalid source identity never replaces the measured baseline bytes");

      fs.writeFileSync(fixtureFile, `${currentSource}// changed during child execution\n`);
      const mutatingTest = [
        "const test = require('node:test');",
        "const { spawnSync } = require('node:child_process');",
        "test('mutate a production source through a child process', () => {",
        `  const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(fixtureFile)}, "\\n// changed\\n");`)}]);`,
        "  if (child.status !== 0) throw new Error(child.stderr.toString());",
        "});",
      ].join("\n");
      fs.writeFileSync(fixtureTest, mutatingTest);
      const mutationReport = path.join(workspaceRoot, "source-mutation-report.json");
      const mutationRun = callRunnerMain(["--engine-coverage", "--report", mutationReport], {
        buildInventory: buildFixtureInventory,
      });
      assert.equal(mutationRun.status, 1, "a production source changed by a test is a hard coverage failure");
      const mutationResult = JSON.parse(fs.readFileSync(mutationReport, "utf8"));
      assert.ok(mutationResult.coverage_source_violations.some((entry) =>
        entry.files.includes("scripts/fixture.js")));
      assert.match(mutationResult.engine_coverage.error, /production source changed during coverage modules/);
    } finally {
      if (previousKeep === undefined) delete process.env.COORD_KEEP_RAW_COVERAGE_ON_ERROR;
      else process.env.COORD_KEEP_RAW_COVERAGE_ON_ERROR = previousKeep;
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    }
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("COORD-800 coverage runtime predicate keeps supported lanes and rejection testable", () => {
  assert.equal(runner.supportsNativeCoverageVersion("v22.19.0"), true);
  assert.equal(runner.supportsNativeCoverageVersion("v24.21.0"), true);
  assert.equal(runner.supportsNativeCoverageVersion("v20.20.0"), false);
  assert.equal(runner.supportsNativeCoverageVersion("not-a-node-version"), false);
  assert.equal(runner.supportsNativeCoverageVersion(""), false,
    "an empty injected version is rejected instead of being interpreted as a supported lane");
});

test("COORD-800 main keeps usage, inventory-list and selection failures observable", () => {
  const root = mkTmp("coord800-main-boundaries-");
  const content = path.join(root, "coord");
  fs.mkdirSync(path.join(content, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(content, "project.config.js"), "module.exports = { repos: {} };\n");
  fs.writeFileSync(path.join(content, "scripts", "example.test.js"),
    "require('node:test')('fixture', () => require('node:assert/strict').ok(true));\n");
  const inventory = {
    layout: "engine", content_root: content, workspace_root: root,
    modules: [{ name: "core", files: ["coord/scripts/example.test.js"] }],
  };
  const buildInventory = () => inventory;
  try {
    assert.deepEqual(runner.parseArgs(["--list", "--", "--test-name-pattern=fixture"]).passthrough,
      ["--test-name-pattern=fixture"], "arguments after -- remain an explicit Node test-runner passthrough");

    const help = callRunnerMain(["--help"], { buildInventory: () => { throw new Error("help must not build inventory"); } });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);

    const invalid = callRunnerMain(["--unknown-option"], { buildInventory });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /unknown argument/);

    const partialCoverage = callRunnerMain(["--engine-coverage", "--module", "core"], { buildInventory });
    assert.equal(partialCoverage.status, 2);
    assert.match(partialCoverage.stderr, /requires the complete aggregate inventory/);

    const unsupported = callRunnerMain(["--engine-coverage"], {
      buildInventory: () => { throw new Error("unsupported Node must be rejected before inventory discovery"); },
      nodeVersion: "v20.20.0",
    });
    assert.equal(unsupported.status, 2);
    assert.match(unsupported.stderr, /supports Node 22\.x and 24\.x; found v20\.20\.0/);

    const listedJson = callRunnerMain(["--list", "--module", "core", "--json"], { buildInventory });
    assert.equal(listedJson.status, 0);
    const listed = JSON.parse(listedJson.stdout);
    assert.deepEqual(listed.modules.map((module) => module.name), ["core"]);
    assert.equal(listed.execution_scope, "governance-only");
    const listedText = callRunnerMain(["--list"], { buildInventory });
    assert.equal(listedText.status, 0);
    assert.match(listedText.stdout, /module core/);

    const unknownModule = callRunnerMain(["--module", "absent"], { buildInventory });
    assert.equal(unknownModule.status, 2);
    assert.match(unknownModule.stderr, /unknown module/);
    const unknownFile = callRunnerMain(["--file", "coord/scripts/missing.test.js"], { buildInventory });
    assert.equal(unknownFile.status, 2);
    assert.match(unknownFile.stderr, /not in inventory/);
    const empty = callRunnerMain(["--list"], { buildInventory: () => ({ ...inventory, modules: [] }) });
    assert.equal(empty.status, 0);
    const noSelection = callRunnerMain(["--module", "core"], {
      buildInventory: () => ({ ...inventory, modules: [{ name: "core", files: [] }] }),
    });
    assert.equal(noSelection.status, 2);
    assert.match(noSelection.stderr, /no test files selected/);

    const originalExecPath = process.execPath;
    const failedChildReport = path.join(root, "failed-child-report.json");
    try {
      process.execPath = path.join(root, "node-binary-that-does-not-exist");
      const failedChild = callRunnerMain(["--module", "core", "--report", failedChildReport], { buildInventory });
      assert.equal(failedChild.status, 1);
      assert.match(failedChild.stderr, /WARNING could not read TAP summary for module core/);
      const failedChildResult = JSON.parse(fs.readFileSync(failedChildReport, "utf8"));
      assert.equal(failedChildResult.results[0].exit_code, -1,
        "a child launch failure is reported as an unavailable process status, not success");
    } finally {
      process.execPath = originalExecPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 failed coverage diagnostics retain ordered module LCOV and raw snapshots", () => {
  const base = mkTmp("coverage-diagnostic-test-");
  const root = path.join(base, "runner-temp-not-created-yet");
  const rawOne = path.join(base, "raw-one");
  const rawTwo = path.join(base, "raw-two");
  fs.mkdirSync(rawOne);
  fs.mkdirSync(rawTwo);
  fs.writeFileSync(path.join(rawOne, "coverage-1-1234567890123-1.json"), "{\"raw\":1}\n");
  fs.writeFileSync(path.join(rawTwo, "coverage-2-1234567890123-2.json"), "{\"raw\":2}\n");
  const modules = [
    { name: "core", rawDirectory: rawOne, lcov: "SF:core.js\nend_of_record\n" },
    { name: "gates", rawDirectory: rawTwo, lcov: "SF:gates.js\nend_of_record\n" },
  ];
  const diagnostic = runner.retainRawCoverageDiagnostic(modules, {
    root, nodeVersion: "v24.21.0", workspaceRoot: "/workspace", sourceCommit: "a".repeat(40),
    coverageError: "synthetic aggregation failure",
  });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(diagnostic, "manifest.json"), "utf8"));
    assert.ok(fs.statSync(root).isDirectory(), "retention creates a missing runner temp root");
    assert.equal(manifest.node_version, "v24.21.0");
    assert.equal(manifest.workspace_root, "/workspace");
    assert.equal(manifest.source_commit, "a".repeat(40));
    assert.equal(manifest.coverage_error, "synthetic aggregation failure");
    assert.deepEqual(manifest.modules.map((module) => module.name), ["core", "gates"]);
    assert.equal(manifest.modules[0].lcov, modules[0].lcov);
    assert.equal(manifest.modules[1].lcov, modules[1].lcov);
    for (const module of manifest.modules) {
      assert.equal(fs.readdirSync(path.join(diagnostic, module.raw_directory)).length, 1);
    }
    assert.throws(() => runner.retainRawCoverageDiagnostic([{
      name: "missing-source", rawDirectory: path.join(base, "missing-raw"), lcov: "SF:missing.js\nend_of_record\n",
    }], { root, nodeVersion: "v24.21.0", workspaceRoot: "/workspace",
      sourceCommit: "a".repeat(40), coverageError: "copy failure" }), /raw coverage directory missing/);
    assert.equal(fs.readdirSync(rawOne).length, 1, "failed diagnostic copying leaves original evidence untouched");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("COORD-786 native coverage includes production test-prefix files and excludes test suffixes",
  { skip: nativeCoverageUnsupported ? `native coverage fixture supports Node 22.x/24.x, found ${process.version}` : false }, () => {
    const root = mkTmp("coord786-test-prefix-coverage-");
    const lcovPath = path.join(root, "coverage.info");
    const fixture = path.join(root, "test-prefix-fixture.test.js");
    const insideTest = path.join(root, "test", "inside.js");
    const fixtureHelper = path.join(root, "__fixtures__", "helper.js");
    const vendorProbe = path.join(root, "engine", "vendor", "probe", "index.js");
    try {
      fs.mkdirSync(path.dirname(insideTest), { recursive: true });
      fs.mkdirSync(path.dirname(fixtureHelper), { recursive: true });
      fs.mkdirSync(path.dirname(vendorProbe), { recursive: true });
      fs.writeFileSync(fixtureHelper, "module.exports = () => 7;\n");
      fs.writeFileSync(vendorProbe, "module.exports = () => 11;\n//# sourceMappingURL=index.js.map\n");
      fs.writeFileSync(fixture,
        `require(${JSON.stringify(RUNNER_PATH)});\n` +
        `require("node:test")("fixture", () => require("node:assert/strict").ok(true));\n`);
      fs.writeFileSync(insideTest,
        `require(${JSON.stringify(RUNNER_PATH)});\n` +
        `const test = require("node:test");\n` +
        `test("out-of-census test path", () => require("node:assert/strict").equal(require(${JSON.stringify(fixtureHelper)} )(), 7));\n` +
        `test("vendored source-map input stays outside first-party coverage", () => require("node:assert/strict").equal(require(${JSON.stringify(vendorProbe)} )(), 11));\n`);
      const result = runNode([
        "--test", ...runner.ENGINE_COVERAGE_ARGS,
        "--test-concurrency=1", "--test-reporter=spec", "--test-reporter-destination=stdout",
        "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
        fixture, insideTest,
      ], { cwd: WORKSPACE_ROOT,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_TEST_"))) });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.ok(fs.existsSync(lcovPath), `native LCOV reporter did not create output: ${result.stderr}\n${result.stdout}`);
      const lcov = fs.readFileSync(lcovPath, "utf8");
      const runnerRelative = path.relative(WORKSPACE_ROOT, path.join(__dirname, "test-runner.js")).split(path.sep).join("/"); // COORD-873: the engine module, not its shim
      assert.ok(lcov.includes(`SF:${runnerRelative}\n`), "production test-runner.js must be measured");
      assert.ok(!lcov.includes(`SF:${path.relative(WORKSPACE_ROOT, fixture).split(path.sep).join("/")}\n`),
        "test suffix remains excluded from coverage");
      const sources = [...lcov.matchAll(/^SF:(.+)$/gm)].map((match) => match[1]);
      assert.ok(sources.some((source) => source.endsWith("/test/inside.js")), "native report includes the out-of-census test path");
      assert.ok(sources.some((source) => source.endsWith("/__fixtures__/helper.js")), "native report includes its fixture helper");
      assert.ok(!sources.some((source) => source.endsWith("/engine/vendor/probe/index.js")),
        "vendored engine implementation is excluded consistently with the production census");
      const measured = engineCoverage.measure(CONTENT_ROOT, [lcov]);
      const withoutOutOfCensus = lcov.split(/(?=^SF:)/m)
        .filter((record) => !record.includes("/test/inside.js") && !record.includes("/__fixtures__/helper.js"))
        .join("");
      assert.deepEqual(engineCoverage.measure(CONTENT_ROOT, [withoutOutOfCensus]).totals, measured.totals,
        "out-of-census native LCOV sources do not affect production totals");
      assert.equal(engineCoverage.isProductionPath("scripts/__fixtures__/coverage-probe.js"), false);
      const withDeclaredFixture = `${lcov}\nSF:coord/scripts/__fixtures__/coverage-probe.js\nDA:1,0\nend_of_record\n`;
      assert.deepEqual(engineCoverage.measure(CONTENT_ROOT, [withDeclaredFixture]).totals, measured.totals,
        "declared in-root fixture exclusions remain outside production totals");
      assert.ok(measured.files.find((file) => file.file === "engine/scripts/test-runner.js")?.observed, // COORD-873: moved
        "the declared production census observes the test-prefix runner");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("COORD-786 coverage mode refuses unsupported Node runtimes before suite execution",
  { skip: [22, 24].includes(Number(process.versions.node.split(".")[0]))
    ? "unsupported-runtime refusal is exercised only outside Node 22/24 coverage lanes" : false }, () => {
    const result = runNode([RUNNER_PATH, "--engine-coverage"], { cwd: WORKSPACE_ROOT });
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stderr, /raw engine coverage aggregation supports Node 22\.x and 24\.x/);
    assert.match(result.stderr, new RegExp(`found ${process.version.replaceAll(".", "\\.")}`));
  });

test("COORD-786 source-range baseline v4 rejects the legacy unstable-site envelope", () => {
  const root = os.tmpdir();
  const baselinePath = runner.coverageBaselinePathForNode(root, "v22.8.0");
  const baseline = {
    identity_version: 4, identity_format: "raw-v8-source-range-v1",
    aggregation: "node-testcoverage-native-v1", node_major: 22, measured_node_version: "v22.8.0",
    source_commit: "a".repeat(40), measured_at: "2026-09-29T00:00:00.000Z", findings: [],
  };
  assert.throws(() => runner.assertCoverageBaselineProvenance({ ...baseline, unstable_findings: [] }, baselinePath, "v22.8.0"),
    /does not accept unstable-site exceptions/);
  assert.throws(() => runner.assertCoverageBaselineProvenance({ ...baseline, unstable_observations: [] }, baselinePath, "v22.8.0"),
    /does not accept unstable-site exceptions/);
});

test("an unknown module is a usage error, not a silent empty run", () => {
  const opts = runner.parseArgs(["--module", "nope"]);
  assert.ok(opts.errors.some((e) => /unknown module "nope"/.test(e)));
  const res = runNode([RUNNER_PATH, "--module", "nope"], { cwd: os.tmpdir() });
  assert.equal(res.status, 2);
});

test("coord/package.json keeps focused commands and points test at the runner", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(CONTENT_ROOT, "package.json"), "utf8")
  );
  assert.equal(pkg.scripts.test, "node scripts/test-runner.js");
  for (const focused of ["test:core", "test:board", "test:hooks", "test:gates"]) {
    assert.ok(pkg.scripts[focused], `missing focused command ${focused}`);
    assert.match(pkg.scripts[focused], /test-runner\.js --module /);
  }
  // No consumer may reintroduce a second glob in the npm surface.
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (name === "mutation") continue;
    assert.ok(
      !/node --test/.test(cmd),
      `${name} must call the authoritative runner, not a raw node --test glob`
    );
  }
});

// --- single-entrypoint wiring of every consumer -------------------------------

test("check-test-isolation.sh delegates to the authoritative runner", () => {
  const sh = fs.readFileSync(
    path.join(CONTENT_ROOT, "scripts", "check-test-isolation.sh"),
    "utf8"
  );
  assert.match(sh, /test-runner\.js/);
  // Comments may still DISCUSS node --test; no executable line may run one.
  const code = sh
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(
    !/node --test/.test(code),
    "the shim must not maintain its own node --test glob"
  );
});

test("public-cut hygiene runs the authoritative runner and forgives no aggregate failure", () => {
  const p = path.join(WORKSPACE_ROOT, "release", "check-public-release.sh");
  if (!fs.existsSync(p)) return; // stripped in the public cut
  const sh = fs.readFileSync(p, "utf8");
  assert.match(sh, /coord\/scripts\/test-runner\.js/);
  assert.ok(
    !/node --test --test-concurrency=1/.test(sh),
    "hygiene must not maintain its own test glob"
  );
  assert.ok(
    !/--test-name-pattern/.test(sh),
    "the isolated-rerun forgiveness path must stay removed (COORD-480 non-goal)"
  );
});

test("active PR CI runs board validation, the suite, sync, engine pin and ratchets", () => {
  const p = path.join(WORKSPACE_ROOT, ".github", "workflows", "governance-suite.yml");
  if (!fs.existsSync(p)) return; // stripped in the public cut
  const yml = fs.readFileSync(p, "utf8");
  assert.match(yml, /pull_request:/, "must be active PR CI");
  assert.match(yml, /node coord\/board\/board\.js validate/);
  assert.match(yml, /node coord\/scripts\/test-runner\.js/);
  assert.match(yml, /check-template-sync\.sh/);
  assert.match(yml, /verify-engine/);
  assert.match(yml, /arch-checks\.js classify/);
  // Explicit Node lanes: minimum supported + current.
  const engines = JSON.parse(
    fs.readFileSync(path.join(CONTENT_ROOT, "package.json"), "utf8")
  ).engines.node;
  const min = engines.replace(/[^\d.]/g, "");
  assert.ok(
    yml.includes(`node: "${min}"`),
    `CI must declare the minimum supported Node lane ${min}`
  );
  assert.match(yml, /lane: min-supported/);
  assert.match(yml, /lane: current/);
  assert.match(yml, /cancel-in-progress:\s+false/, "authoritative runs must not be cancelled");
  // Pre-existing arch debt must be attributed, not silently absorbed.
  assert.match(yml, /COORD-594/);
});

test("binary verification calls the same entrypoint against the scaffolded tree", () => {
  // COORD-598: this guard used to pin the invocation to a `/tmp/concord-smoke`
  // path inside the release workflow. COORD-481 moved every channel behind ONE
  // builder (release/build-release-artifacts.sh), so the scaffolded-tree run now
  // lives in the builder and the workflow only calls the builder. The guard
  // therefore asserts BOTH halves: the workflow still routes through the builder
  // (location), and the builder still EXECUTES the authoritative suite against the
  // scaffolded tree (substance). Both files are donor-only, stripped from cuts.
  const wf = path.join(
    WORKSPACE_ROOT,
    ".github",
    "workflows",
    "release-linux-binary.yml"
  );
  const builder = path.join(
    WORKSPACE_ROOT,
    "release",
    "build-release-artifacts.sh"
  );
  if (!fs.existsSync(wf) || !fs.existsSync(builder)) return; // stripped in the public cut

  // location — binary verification is reached through the single release builder.
  assert.match(
    fs.readFileSync(wf, "utf8"),
    /release\/build-release-artifacts\.sh/,
    "the release workflow must build every channel through the one release builder"
  );

  // location — the builder runs THIS entrypoint from inside the scaffolded
  // workspace it installed from the packed tarball (not from the donor tree).
  const sh = fs.readFileSync(builder, "utf8");
  const invocations = (
    sh.match(/^.*node coord\/scripts\/test-runner\.js.*$/gm) || []
  ).filter((line) => !/^\s*#/.test(line));
  assert.ok(
    invocations.length > 0,
    "the release builder must call coord/scripts/test-runner.js against the scaffolded tree"
  );
  assert.match(
    sh,
    /cd "\$SMOKE\/work\/ws"/,
    "the scaffolded-tree run must happen inside the installed workspace"
  );

  // substance — COORD-480 required the packed artifact to PASS the same suite, not
  // merely to enumerate it.
  //
  // COORD-624 changed WHERE that execution can honestly happen. Installation is
  // now governance-only: an installed workspace contains no sample product tree,
  // and a large part of the shipped suite (the product `gate.sh` modules, the
  // coord-ui modules, and every case that needs a configured product repo) cannot
  // run without one. The old builder installed that tree purely so this run would
  // pass — which made the assertion true by scaffolding product code during an
  // install, the exact thing the install invariant forbids.
  //
  // So the guard keeps BOTH halves, re-pointed at where each is real:
  //   * the scaffolded tree must still be exercised through THIS entrypoint
  //     (inventory resolves from the packed bytes), and
  //   * the authoritative suite must still be EXECUTED with a report over the
  //     same verified cut, inside the same builder, via the hygiene gate.
  // A `--list`-only builder with no execution anywhere would still fail here.
  assert.match(
    sh,
    /build-public-release\.sh/,
    "the release builder must build the cut through the hygiene-gated builder"
  );
  const cutBuilder = fs.readFileSync(path.join(WORKSPACE_ROOT, "release", "build-public-release.sh"), "utf8");
  assert.match(
    cutBuilder,
    /check-public-release\.sh/,
    "the cut builder must run the hygiene gate, which EXECUTES the authoritative " +
      "suite (with --report) against the verified cut — the packed bytes"
  );
  const gate = fs.readFileSync(path.join(WORKSPACE_ROOT, "release", "check-public-release.sh"), "utf8");
  assert.match(
    gate,
    /node coord\/scripts\/test-runner\.js[\s\S]{0,120}--report /,
    "the hygiene gate must execute the authoritative entrypoint and record a report"
  );
  // And the builder must assert the install it smoke-tests is governance-only,
  // so nobody restores product scaffolding to make a suite run pass.
  assert.match(
    sh,
    /governance-only \(COORD-624 sibling-workspace model\)/,
    "the builder must verify the default install emits no sample product tree"
  );
});

// --- COORD-606: provider-complete identity stripping --------------------------

test("STRIPPED_ENV_VARS covers every provider adapter's thread variables", () => {
  // The failure this locks: COORD-478 made the workspace provider-neutral, but the
  // runner's identity allowlist only knew about Claude, so a Codex/Gemini/Grok
  // agent's ambient thread id leaked into the child env. Read the PROVIDER_REGISTRY
  // itself, so ADDING a provider adapter without adding its variable here fails.
  const src = fs.readFileSync(
    path.join(CONTENT_ROOT, "engine", "scripts", "governance-session.js"),
    "utf8"
  );
  const registry = src.slice(
    src.indexOf("const PROVIDER_REGISTRY = ["),
    src.indexOf("];", src.indexOf("const PROVIDER_REGISTRY = ["))
  );
  assert.ok(registry.includes("envThread"), "PROVIDER_REGISTRY not found");
  const declared = new Set();
  for (const m of registry.matchAll(/envThread:\s*"([A-Z0-9_]+)"/g)) declared.add(m[1]);
  for (const m of registry.matchAll(/envThreadAliases:\s*\[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/"([A-Z0-9_]+)"/g)) declared.add(a[1]);
  }
  assert.ok(declared.size >= 4, `expected several providers, saw ${[...declared]}`);
  // COORD-909: the list is the shared module's. The runner must re-export that same list, so the
  // coord runner and the product gate scrub with one provider-complete enumeration.
  const shared = require("./agent-identity-env.js");
  assert.equal(runner.STRIPPED_ENV_VARS, shared.STRIPPED_ENV_VARS, "runner must use the shared identity list");
  const missing = [...declared].filter((n) => !shared.STRIPPED_ENV_VARS.includes(n));
  assert.deepEqual(
    missing,
    [],
    `provider identity variables missing from the shared STRIPPED_ENV_VARS: ${missing}`
  );
});

test("ambient identity from EVERY provider is stripped from the child env", () => {
  const names = [
    "CODEX_THREAD_ID",
    "GEMINI_THREAD_ID",
    "GROK_THREAD_ID",
    "AGENT_THREAD_ID",
    "GOVERNANCE_MCP_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "COORD_SESSION_ID",
    "COORD_PROVIDER_SESSION_ID",
    "COORD_INSTANCE_ID",
  ];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = `leaky-${n}`;
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    for (const n of names) assert.ok(!(n in env), `${n} leaked into the child env`);
  } finally {
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  }
});

test("COORD-849 the merged-LCOV artifact path never reaches a test child", () => {
  const before = process.env.COORD_COVERAGE_MERGED_LCOV;
  const previousHistory = process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD;
  try {
    process.env.COORD_COVERAGE_MERGED_LCOV = path.join(os.tmpdir(), "coord849-leak.info");
    process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD = "a".repeat(40);
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    assert.ok(!("COORD_COVERAGE_MERGED_LCOV" in env), "COORD_COVERAGE_MERGED_LCOV leaked into the child env");
    assert.ok(!("COORD_RELEASE_COVERAGE_HISTORY_HEAD" in env), "donor history input leaked into the child env");
  } finally {
    if (before === undefined) delete process.env.COORD_COVERAGE_MERGED_LCOV;
    else process.env.COORD_COVERAGE_MERGED_LCOV = before;
    if (previousHistory === undefined) delete process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD;
    else process.env.COORD_RELEASE_COVERAGE_HISTORY_HEAD = previousHistory;
  }
});

test("an identity-SHAPED variable is stripped even when not enumerated", () => {
  // Backstop against enumeration rot: a provider added tomorrow leaks nothing even
  // if this file is not touched.
  const name = "FUTUREPROVIDER_THREAD_ID";
  const before = process.env[name];
  try {
    process.env[name] = "future-leak";
    assert.ok(runner.isIdentityEnvVar(name));
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    assert.ok(!(name in env), `${name} leaked into the child env`);
    // ...and the pattern is narrow enough not to eat ordinary configuration.
    assert.ok(!runner.isIdentityEnvVar("PATH"));
    assert.ok(!runner.isIdentityEnvVar("NODE_OPTIONS"));
    assert.ok(!runner.isIdentityEnvVar("COORD_TEST_REPORT"));
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

// --- COORD-606: governed-tree fingerprint (catches SUBPROCESS writes) ---------

test("the governed-tree fingerprint detects modify / add / remove", () => {
  const root = mkTmp("coord606-fp-");
  try {
    fs.mkdirSync(path.join(root, "board"), { recursive: true });
    fs.writeFileSync(path.join(root, "board", "tasks.json"), "{}");
    fs.writeFileSync(path.join(root, "PLAN.md"), "plan");
    const opts = { paths: ["board", "PLAN.md"] };
    const base = runner.fingerprintGovernedTree(root, opts);
    assert.ok(base.has("board/tasks.json") && base.has("PLAN.md"));
    assert.equal(
      runner.diffFingerprints(base, runner.fingerprintGovernedTree(root, opts)).changed,
      false
    );
    fs.writeFileSync(path.join(root, "board", "tasks.json"), "{ }");
    let d = runner.diffFingerprints(base, runner.fingerprintGovernedTree(root, opts));
    assert.deepEqual(d.modified, ["board/tasks.json"]);
    assert.ok(d.changed);
    fs.writeFileSync(path.join(root, "board", "extra.json"), "1");
    d = runner.diffFingerprints(base, runner.fingerprintGovernedTree(root, opts));
    assert.deepEqual(d.added, ["board/extra.json"]);
    fs.rmSync(path.join(root, "PLAN.md"));
    d = runner.diffFingerprints(base, runner.fingerprintGovernedTree(root, opts));
    assert.deepEqual(d.removed, ["PLAN.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the governed-tree fingerprint reports removal when a directory vanishes before readdir", () => {
  const root = mkTmp("coord606-fingerprint-readdir-race-");
  const governed = path.join(root, "coord");
  const originalReaddir = fs.readdirSync;
  let injectedRace = false;
  try {
    fs.mkdirSync(governed);
    fs.writeFileSync(path.join(governed, "QUESTIONS.md"), "before\n");
    const opts = { paths: ["coord"] };
    const before = runner.fingerprintGovernedTree(root, opts);
    assert.deepEqual([...before.keys()], ["coord/QUESTIONS.md"]);

    fs.readdirSync = function (directory, ...args) {
      if (!injectedRace && path.resolve(directory) === governed) {
        injectedRace = true;
        fs.rmSync(governed, { recursive: true, force: true });
      }
      return originalReaddir.call(this, directory, ...args);
    };
    const after = runner.fingerprintGovernedTree(root, opts);
    assert.equal(injectedRace, true,
      "the fixture removes the directory after stat succeeds and before readdir");
    const drift = runner.diffFingerprints(before, after);
    assert.deepEqual(drift.removed, ["coord/QUESTIONS.md"],
      "the caught filesystem race remains observable as removed governed content");
  } finally {
    fs.readdirSync = originalReaddir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a SUBPROCESS write to the live governed tree FAILS the run", () => {
  // The gap COORD-606 closes: the isolation guard is an in-process fs hook, so a
  // mutation made by a spawned `git`/shell/`gov` child is structurally invisible to
  // it. The runner's per-module tree fingerprint is what catches it. The probe
  // writes a NEW file under coord/active/** through `sh`, exactly as a stray
  // subprocess would.
  const probeRel = "active/.coord606-subprocess-probe.md";
  const probeAbs = path.join(CONTENT_ROOT, probeRel);
  const offender = path.join(CONTENT_ROOT, "scripts", ".coord606-subproc.test.js");
  const body = [
    'const test = require("node:test");',
    'const { spawnSync } = require("node:child_process");',
    'test("subprocess writes the live governed tree", () => {',
    `  spawnSync("sh", ["-c", "printf probe > " + ${JSON.stringify(JSON.stringify(probeAbs))}]);`,
    "});",
  ].join("\n");
  fs.writeFileSync(offender, body);
  const dir = mkTmp("coord606-subproc-");
  try {
    const res = runNode(
      [
        RUNNER_PATH,
        "--file",
        path.relative(WORKSPACE_ROOT, offender).split(path.sep).join("/"),
        "--report",
        path.join(dir, "report.json"),
      ],
      { cwd: WORKSPACE_ROOT }
    );
    assert.notEqual(res.status, 0, "a subprocess mutation must fail the run");
    assert.match(res.stdout, /mutated the live governed tree/);
    assert.match(res.stdout, /added coord\/active\/\.coord606-subprocess-probe\.md/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.equal(report.result, "fail");
    assert.ok(report.governed_tree_violations.length > 0);
    assert.ok(
      report.governed_tree_violations[0].added.includes(probeRel),
      "the report must name the mutated path"
    );
  } finally {
    fs.rmSync(offender, { force: true });
    // The probe lives under a guarded surface, so THIS process cannot delete it
    // through fs (the guard would correctly block it). Remove it the same way it
    // was created — through a subprocess — so the live tree is left byte-identical.
    spawnSync("rm", ["-f", probeAbs]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard fails-closed on the live board / PLAN / QUESTIONS (governed class)", () => {
  const guard = require("./test-isolation-guard.js");
  assert.ok(guard.isGovernedViolation(path.join(CONTENT_ROOT, "board", "tasks.json")));
  assert.ok(guard.isGovernedViolation(path.join(CONTENT_ROOT, "PLAN.md")));
  assert.ok(guard.isGovernedViolation(path.join(CONTENT_ROOT, "QUESTIONS.md")));
  assert.ok(guard.isGovernedViolation(path.join(CONTENT_ROOT, "active", "X.md")));
  assert.ok(!guard.isGovernedViolation(path.join(os.tmpdir(), "board", "tasks.json")));
  assert.equal(guard.governedMode(), "enforce");
});

// --- COORD-606: the run report is evidence, not a courtesy --------------------

test("a run whose report cannot be persisted FAILS instead of claiming PASS", () => {
  // Before COORD-606 this printed result=PASS, exited 0, and named a report path
  // that did not exist. A parent file (not a directory) makes the write fail with
  // ENOTDIR for every user, including root in CI.
  const dir = mkTmp("coord606-report-");
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "");
  try {
    const res = runNode(
      [RUNNER_PATH, "--module", "gates", "--report", path.join(blocker, "report.json")],
      { cwd: WORKSPACE_ROOT }
    );
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /result=FAIL/);
    assert.match(res.stdout, /report=NOT-WRITTEN/);
    assert.match(res.stderr, /could not write the run report/);
    // The tests themselves passed — the run fails ONLY because the evidence is gone.
    assert.match(res.stdout, /fail=0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- COORD-606: the release-critical runner is under integrity coverage -------

test("the authoritative runner and its guard are manifest- and pin-tracked", () => {
  // COORD-598 was allowed to change the runner with "no re-pin needed" because
  // check-template-sync and verify-engine could not see these files at all.
  const required = [
    "coord/scripts/test-runner.js", // COORD-873: the permanent shim CI and gate.sh invoke
    "coord/engine/scripts/test-runner.js",
    "coord/engine/scripts/test-runner.test.js",
    "coord/engine/scripts/test-node-options.js",
    "coord/engine/scripts/test-isolation-guard.js",
    "coord/engine/scripts/test-isolation-guard.test.js",
    "coord/engine/scripts/git-prerequisite.js",
    "coord/engine/scripts/git-prerequisite.test.js",
  ];
  const manifestPath = path.join(CONTENT_ROOT, "TEMPLATE_SYNC_MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const tracked = new Set(manifest.items.map((i) => i.path));
  for (const rel of required) {
    assert.ok(tracked.has(rel), `${rel} is not tracked by TEMPLATE_SYNC_MANIFEST.json`);
  }
  const pinPath = path.join(CONTENT_ROOT, "engine-pin.json");
  if (!fs.existsSync(pinPath)) return; // stripped in some cuts
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  for (const rel of required) {
    assert.ok(pin.files[rel], `${rel} is not covered by coord/engine-pin.json`);
  }
});

test("COORD-816: each module entry in the run report names its skipped tests", () => {
  const root = mkTmp('coord816-runner-');
  const scripts = path.join(root, 'coord', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  // COORD-873: the runner ships at coord/engine/scripts and measures coord/ from there.
  const engineScripts = path.join(root, 'coord', 'engine', 'scripts');
  fs.mkdirSync(engineScripts, { recursive: true });
  for (const name of ['test-runner.js', 'test-census-observer.js', 'test-isolation-guard.js', 'sqlite-runtime.js', 'test-node-options.js', 'git-prerequisite.js', 'agent-identity-env.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(engineScripts, name));
  }
  fs.writeFileSync(path.join(scripts, 'skips.test.js'), [
    "const test = require('node:test');",
    "test('runs', () => {});",
    "test('static skip', { skip: 'reason' }, () => {});",
    "test.describe('group', () => { test.it('dynamic skip', (t) => t.skip('later')); });",
  ].join('\n') + '\n');
  const report = path.join(root, 'report.json');
  try {
    const child = runNode([path.join(engineScripts, 'test-runner.js'), '--report', report], { cwd: root, timeout: 30000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const [core] = JSON.parse(fs.readFileSync(report, 'utf8')).results;
    assert.equal(core.module, 'core');
    assert.equal(core.skipped, 2);
    assert.deepEqual(core.skipped_tests, ['static skip', 'group > dynamic skip']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const direction of [1, -1]) test(`COORD-754: published runner duration measures real child lifetime under ${direction > 0 ? 'forward' : 'backward'} clock jumps`, () => {
  const root = mkTmp('coord754-runner-');
  const scripts = path.join(root, 'coord', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  // COORD-873: the runner ships at coord/engine/scripts and measures coord/ from there.
  const engineScripts = path.join(root, 'coord', 'engine', 'scripts');
  fs.mkdirSync(engineScripts, { recursive: true });
  for (const name of ['test-runner.js', 'test-census-observer.js', 'test-isolation-guard.js', 'sqlite-runtime.js', 'test-node-options.js', 'git-prerequisite.js', 'agent-identity-env.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(engineScripts, name));
  }
  fs.writeFileSync(path.join(scripts, 'smoke.test.js'), "require('node:test')('real child',()=>require('node:assert/strict').ok(true));\n");
  const report = path.join(root, 'report.json'), timing = path.join(root, 'timing.json');
  const code = `
    const cp=require('node:child_process'),fs=require('node:fs'),{performance}=require('node:perf_hooks');
    const original=cp.spawnSync;let childDuration=null;
    cp.spawnSync=(...args)=>{const start=performance.now();const result=original(...args);childDuration=performance.now()-start;return result;};
    const real=Date.now;let calls=0;Date.now=()=>real()+(${direction}*calls++*120000);
    const runner=require(${JSON.stringify(path.join(engineScripts, 'test-runner.js'))});
    const start=performance.now();process.exitCode=runner.main(['--report',${JSON.stringify(report)}]);
    const elapsed=performance.now()-start;Date.now=real;
    fs.writeFileSync(${JSON.stringify(timing)},JSON.stringify({childDuration,elapsed}));
  `;
  try {
    const child = runNode(['-e', code], { cwd: root, timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    const observed = JSON.parse(fs.readFileSync(timing, 'utf8'));
    assert.equal(result.result, 'pass');
    assert.equal(result.totals.pass, 1);
    assert.equal(result.results.length, 1);
    const duration = result.results[0].duration_ms;
    assert.ok(Number.isFinite(duration) && duration >= 0);
    assert.ok(duration >= observed.childDuration, JSON.stringify({ duration, ...observed }));
    assert.ok(duration <= observed.elapsed, JSON.stringify({ duration, ...observed }));
    assert.ok(Math.abs(Date.now() - Date.parse(result.generated_at)) < 60000, 'report UTC timestamp is unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// COORD-873: every runner smoke above enters through the legacy coord/scripts shim or
// calls main() in-process, so the moved engine file's own `require.main === module`
// block never ran. Launch the ENGINE path directly and prove that block sets the exit
// code from main(process.argv.slice(2)).
test("COORD-873: launching the engine test-runner.js directly sets the exit code from main", () => {
  const enginePath = path.join(__dirname, "test-runner.js");
  assert.notEqual(enginePath, RUNNER_PATH, "this smoke must not reuse the legacy shim entrypoint");

  const bogus = runNode([enginePath, "--coord-873-bogus-flag"], { cwd: WORKSPACE_ROOT });
  assert.equal(bogus.status, 2, `unknown argument must exit 2; stderr: ${bogus.stderr}`);
  assert.match(bogus.stderr, /test-runner: unknown argument: --coord-873-bogus-flag/);
  assert.match(bogus.stderr, /usage: node coord\/scripts\/test-runner\.js/);

  const help = runNode([enginePath, "--help"], { cwd: WORKSPACE_ROOT });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: node coord\/scripts\/test-runner\.js/);
});

test("runner shim can report usage without the optional ownership module", (t) => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalExists = fs.existsSync;
  const ownershipPath = path.join(__dirname, "run-ownership.js");
  let probed = false;
  t.mock.method(fs, "existsSync", (file) => {
    if (file === ownershipPath) {
      probed = true;
      return false;
    }
    return originalExists(file);
  });
  try {
    process.argv = [process.execPath, RUNNER_PATH, "--help"];
    const result = callRunnerMain();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(process.exitCode, 0);
    assert.match(result.stdout, /usage: node coord\/scripts\/test-runner\.js/);
    assert.equal(probed, true);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
});

// --- COORD-880: CLAUDECODE runtime-detection flag never reaches a test child ---

test("COORD-880 CLAUDECODE is stripped from the child env while the parent env keeps it", () => {
  const before = process.env.CLAUDECODE;
  try {
    process.env.CLAUDECODE = "1";
    assert.ok(runner.STRIPPED_ENV_VARS.includes("CLAUDECODE"));
    assert.ok(runner.isIdentityEnvVar("CLAUDECODE"));
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    assert.ok(!("CLAUDECODE" in env), "CLAUDECODE leaked into the child env");
    // The runner builds a copy; its own process environment is unchanged.
    assert.equal(process.env.CLAUDECODE, "1");
    // Only the exact name is stripped, not look-alike configuration.
    assert.ok(!runner.isIdentityEnvVar("CLAUDECODE_EXTRA"));
    assert.ok(!runner.isIdentityEnvVar("CLAUDE_CODE_ENTRYPOINT"));
  } finally {
    if (before === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = before;
  }
});

test("COORD-880 a real test child sees no CLAUDECODE when the invoking shell exports it", () => {
  const root = mkTmp("coord880-runner-");
  const scripts = path.join(root, "coord", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  // The runner ships at coord/engine/scripts (COORD-873) and measures coord/ from there.
  const engineScripts = path.join(root, "coord", "engine", "scripts");
  fs.mkdirSync(engineScripts, { recursive: true });
  for (const name of ["test-runner.js", "test-census-observer.js", "test-isolation-guard.js", "sqlite-runtime.js", "test-node-options.js", "git-prerequisite.js", "agent-identity-env.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(engineScripts, name));
  }
  fs.writeFileSync(path.join(scripts, "claudecode.test.js"), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('inherits no CLAUDECODE', () => assert.equal(process.env.CLAUDECODE, undefined));",
  ].join("\n") + "\n");
  const report = path.join(root, "report.json");
  try {
    for (const claudecode of ["1", undefined]) {
      const env = { ...process.env };
      if (claudecode === undefined) delete env.CLAUDECODE;
      else env.CLAUDECODE = claudecode;
      const child = runNode([path.join(engineScripts, "test-runner.js"), "--report", report], { cwd: root, timeout: 30000, env });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const json = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.equal(json.result, "pass");
      assert.equal(json.totals.pass, 1);
      assert.equal(json.environment.stripped_env_removed.includes("CLAUDECODE"), claudecode !== undefined);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("governed runner isolates and disposes child fixture temps after pass and fail", (t) => {
  const root = mkTmp("coord-owned-fixture-test-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, "coord");
  const engine = path.join(content, "engine", "scripts");
  const scripts = path.join(content, "scripts");
  const parentTemp = path.join(root, "caller-temp");
  const unrelated = path.join(parentTemp, "unrelated");
  const observed = path.join(root, "observed.json");
  for (const dir of [engine, scripts, unrelated]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(unrelated, "marker"), "keep me");
  for (const name of [
    "test-runner.js", "test-census-observer.js", "test-isolation-guard.js", "sqlite-runtime.js",
    "test-node-options.js", "git-prerequisite.js", "agent-identity-env.js",
    "run-ownership.js", "directory-locks.js", "process-identity.js",
  ]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(engine, name));
  }
  fs.writeFileSync(path.join(scripts, "fixture.test.js"), [
    "const test = require('node:test'), assert = require('node:assert/strict');",
    "const fs = require('node:fs'), os = require('node:os'), path = require('node:path');",
    "test('fixture temp ownership', () => {",
    "  const tmp = os.tmpdir();",
    "  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'RUNNER_TEMP']) assert.equal(process.env[name], tmp);",
    "  assert.equal(fs.readFileSync(path.join(tmp, '.coord-run-id'), 'utf8'), process.env.COORD_RUN_ID);",
    "  const fixtureDir = fs.mkdtempSync(path.join(tmp, 'abandoned-fixture-'));",
    "  fs.writeFileSync(path.join(fixtureDir, 'payload'), 'remove me');",
    "  fs.writeFileSync(path.resolve('observed.json'), JSON.stringify(tmp));",
    "  assert.equal(process.env.FIXTURE_OUTCOME, 'pass');",
    "});",
  ].join("\n"));
  const temps = [];
  for (const outcome of ["pass", "fail"]) {
    const report = path.join(root, outcome + ".json");
    const env = { ...process.env, TMPDIR: parentTemp, TMP: unrelated, TEMP: unrelated,
      RUNNER_TEMP: unrelated, FIXTURE_OUTCOME: outcome };
    const child = runNode([path.join(engine, "test-runner.js"), "--report", report], { cwd: root, env, timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.status, outcome === "pass" ? 0 : 1, child.stderr + child.stdout);
    assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).result, outcome);
    const temp = JSON.parse(fs.readFileSync(observed, "utf8"));
    assert.equal(path.dirname(temp), parentTemp);
    assert.notEqual(temp, temps[0]);
    assert.equal(fs.existsSync(temp), false);
    temps.push(temp);
  }
  assert.equal(fs.readFileSync(path.join(unrelated, "marker"), "utf8"), "keep me");
});

// --- COORD-883: GEMINI_AGENT / GROK_AGENT runtime-detection flags never reach a test child ---

test("COORD-883 every provider detection flag is stripped from the child env while the parent env keeps it", () => {
  // Read the PROVIDER_REGISTRY itself, so a provider whose envDetect flag is not
  // stripped fails here (the thread-variable twin of this check is above).
  const src = fs.readFileSync(path.join(CONTENT_ROOT, "engine", "scripts", "governance-session.js"), "utf8");
  const start = src.indexOf("const PROVIDER_REGISTRY = [");
  const registry = src.slice(start, src.indexOf("];", start));
  const flags = [...registry.matchAll(/envDetect:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(flags, ["CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"]);
  const before = Object.fromEntries(flags.map((name) => [name, process.env[name]]));
  try {
    for (const name of flags) process.env[name] = "1";
    const { env } = runner.buildChildEnv(CONTENT_ROOT);
    for (const name of flags) {
      assert.ok(runner.STRIPPED_ENV_VARS.includes(name), `${name} missing from STRIPPED_ENV_VARS`);
      assert.ok(runner.isIdentityEnvVar(name));
      assert.ok(!(name in env), `${name} leaked into the child env`);
      // The runner builds a copy; its own process environment is unchanged.
      assert.equal(process.env[name], "1");
    }
    // Only the exact names are stripped, not look-alike configuration.
    for (const name of ["GEMINI_AGENT_MODE", "GEMINI_API_KEY", "GROK_AGENT_EXTRA", "GROK_API_KEY"]) {
      assert.ok(!runner.isIdentityEnvVar(name), name);
    }
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("COORD-883 a real test child sees no GEMINI_AGENT or GROK_AGENT when the invoking shell exports them", () => {
  const root = mkTmp("coord883-runner-");
  const scripts = path.join(root, "coord", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  // The runner ships at coord/engine/scripts (COORD-873) and measures coord/ from there.
  const engineScripts = path.join(root, "coord", "engine", "scripts");
  fs.mkdirSync(engineScripts, { recursive: true });
  for (const name of ["test-runner.js", "test-census-observer.js", "test-isolation-guard.js", "sqlite-runtime.js", "test-node-options.js", "git-prerequisite.js", "agent-identity-env.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(engineScripts, name));
  }
  fs.writeFileSync(path.join(scripts, "provider-flags.test.js"), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('inherits no provider detection flag', () => {",
    "  assert.equal(process.env.GEMINI_AGENT, undefined);",
    "  assert.equal(process.env.GROK_AGENT, undefined);",
    "});",
  ].join("\n") + "\n");
  const report = path.join(root, "report.json");
  try {
    for (const value of ["1", undefined]) {
      const env = { ...process.env };
      for (const name of ["GEMINI_AGENT", "GROK_AGENT"]) {
        if (value === undefined) delete env[name]; else env[name] = value;
      }
      const child = runNode([path.join(engineScripts, "test-runner.js"), "--report", report], { cwd: root, timeout: 30000, env });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const json = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.equal(json.result, "pass");
      assert.equal(json.totals.pass, 1);
      for (const name of ["GEMINI_AGENT", "GROK_AGENT"]) {
        assert.equal(json.environment.stripped_env_removed.includes(name), value !== undefined, name);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- COORD-890: identity-sensitive suites isolate themselves outside the runner ---

test("COORD-890 scrubIdentityEnv removes identity variables in place and keeps everything else", () => {
  const env = { PATH: "/bin", COORD_SESSION_ID: "a", CLAUDECODE: "1", GROK_AGENT: "1", TERM_SESSION_ID: "t", CLAUDECODE_EXTRA: "x" };
  assert.deepEqual(runner.scrubIdentityEnv(env), ["CLAUDECODE", "COORD_SESSION_ID", "GROK_AGENT", "TERM_SESSION_ID"]);
  assert.deepEqual(env, { PATH: "/bin", CLAUDECODE_EXTRA: "x" });
  assert.deepEqual(runner.scrubIdentityEnv(env), []);
});

test("COORD-890 a bare node --test run of doctor-recovery in an agent shell has no failures", () => {
  const env = { ...process.env, COORD_SESSION_ID: "coord890-leaked", CLAUDECODE: "1" };
  for (const name of Object.keys(env)) if (name.startsWith("NODE_TEST_")) delete env[name];
  const pattern = "recovery-session (adoption|continuation) helper|recover tolerates a transiently missing owner entry";
  const child = runNode([
    "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`,
    path.join(__dirname, "doctor-recovery.test.js"),
  ], { cwd: CONTENT_ROOT, timeout: 120000, env });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /^# pass 3$/m);
  assert.match(child.stdout, /^# fail 0$/m);
});

// COORD-890: buildChildEnv's NODE_OPTIONS assembly, arm by arm. The runtime is
// pinned through process.versions.node so both sqlite-flag outcomes run on
// every supported Node line instead of only the one that happens to execute.
function withChildEnvRuntime(nodeVersion, nodeOptions, fn) {
  const versionDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  const before = process.env.NODE_OPTIONS;
  try {
    Object.defineProperty(process.versions, "node", { ...versionDescriptor, value: nodeVersion });
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
    return fn();
  } finally {
    Object.defineProperty(process.versions, "node", versionDescriptor);
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
}

test("COORD-890 buildChildEnv quotes a guard path that contains whitespace", () => {
  const contentRoot = path.join(path.sep, "srv", "concord content root", "coord");
  const { env, guard } = withChildEnvRuntime("24.0.0", "--max-old-space-size=512",
    () => runner.buildChildEnv(contentRoot));
  assert.equal(guard, path.join(contentRoot, "engine", "scripts", "test-isolation-guard.js"));
  assert.equal(env.NODE_OPTIONS, `--max-old-space-size=512 --require "${guard}"`);
});

test("COORD-890 buildChildEnv builds NODE_OPTIONS from nothing when the parent has none", () => {
  const guard = path.join(CONTENT_ROOT, "engine", "scripts", "test-isolation-guard.js");
  assert.ok(!/\s/.test(guard), "this case needs an unquoted guard path");
  const unflagged = withChildEnvRuntime("24.0.0", undefined, () => runner.buildChildEnv(CONTENT_ROOT));
  assert.equal(unflagged.env.NODE_OPTIONS, `--require ${guard}`, "no sqlite flag, so the guard is the whole value");
  const flagged = withChildEnvRuntime("22.8.0", undefined, () => runner.buildChildEnv(CONTENT_ROOT));
  assert.equal(flagged.env.NODE_OPTIONS, `--experimental-sqlite --require ${guard}`);
  assert.equal(process.versions.node, process.version.slice(1), "the real runtime version is restored");
});

test("COORD-1050 buildChildEnv captures only the checkout-local guard and preserves unrelated preloads", () => {
  const root = mkTmp("coord1050-local-guard-capture-");
  const outerGuard = path.join(root, "outer checkout", "test-isolation-guard.js");
  const innerRoot = path.join(root, "inner workspace", "coord");
  const innerGuard = path.join(innerRoot, "engine", "scripts", "test-isolation-guard.js");
  const unrelated = path.join(root, "unrelated preload", "preload.js");
  const coverageDir = path.join(root, "coverage");
  for (const file of [outerGuard, innerGuard, unrelated]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(coverageDir);
  const preload = (name) => `globalThis.__coordPreloads = [...(globalThis.__coordPreloads || []), ${JSON.stringify(name)}];\n`;
  fs.writeFileSync(outerGuard, preload("outer"));
  fs.writeFileSync(innerGuard, preload("inner"));
  fs.writeFileSync(unrelated, preload("unrelated"));
  const priorNodeOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--require "${outerGuard}" --require "${unrelated}" --trace-warnings`;
    const { env, guard } = runner.buildChildEnv(innerRoot);
    assert.equal(guard, innerGuard);
    assert.doesNotMatch(env.NODE_OPTIONS, /outer checkout/);
    assert.match(env.NODE_OPTIONS, /unrelated preload/);
    assert.match(env.NODE_OPTIONS, /--trace-warnings/);
    const child = runNode(["-e", "process.stdout.write(JSON.stringify(globalThis.__coordPreloads || []))"], {
      cwd: root, timeout: 10000, env: { ...env, NODE_V8_COVERAGE: coverageDir },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ["unrelated", "inner"]);
    const snapshots = fs.readdirSync(coverageDir).map((file) => JSON.parse(fs.readFileSync(path.join(coverageDir, file), "utf8")));
    const urls = snapshots.flatMap((snapshot) => snapshot.result.map((script) => script.url));
    assert.ok(urls.includes(pathToFileURL(innerGuard).href), "raw capture contains the checkout-local guard");
    assert.ok(urls.includes(pathToFileURL(unrelated).href), "raw capture preserves unrelated preload coverage");
    assert.ok(!urls.includes(pathToFileURL(outerGuard).href), "raw capture excludes the inherited outer guard copy");
  } finally {
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorNodeOptions;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1050: sharded raw coverage reaches aggregation and reports missing module evidence", () => {
  const sharding = require("./test-sharding.js");
  const original = {
    resolveShardCount: sharding.resolveShardCount,
    loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority,
    executeShards: sharding.executeShards,
    normalizeRawCoverageModules: sharding.normalizeRawCoverageModules,
    rewriteShardCoverageReports: sharding.rewriteShardCoverageReports,
  };
  const root = mkTmp("coord1050-sharded-coverage-");
  const rawDirectory = path.join(root, "raw");
  const reportPath = path.join(root, "report.json");
  fs.mkdirSync(rawDirectory);
  const normalizedCalls = [], rewriteCalls = [];
  Object.assign(sharding, {
    resolveShardCount: () => 1,
    loadTimingSensitiveSuites: () => [],
    resolveShardAuthority: () => ({ mode: "fixture" }),
    executeShards: () => ({
      plan: { shard_count: 1, shards: [{ id: 1, suites: [] }] },
      workers: [{
        id: 1, assigned: [], result: "pass", exit_code: 0, workspace: WORKSPACE_ROOT,
        report: { results: [], engine_coverage: { raw_modules: [{ name: "core" }] } },
      }],
      rawModules: [{ name: "core" }],
      validationError: null,
    }),
    normalizeRawCoverageModules: (modules, options) => {
      normalizedCalls.push({ modules, options });
      return { modules: [{ name: "core", rawDirectory, lcov: null }], scratch: null };
    },
    rewriteShardCoverageReports: (...args) => rewriteCalls.push(args),
  });
  try {
    const result = callRunnerMain([
      "--shards", "1", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "full", "--engine-coverage", "--report", reportPath,
    ], { gitCheck: () => ({ ok: true }), runManifest: null });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.doesNotMatch(result.stderr, /Cannot access 'retainedRawCoverageDirectories' before initialization/);
    assert.match(result.stdout, /execution=FAIL qualification=FAIL/);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "fail");
    assert.equal(normalizedCalls.length, 1, "complete passing worker metadata reaches normalization before aggregate completeness enforcement");
    assert.deepEqual(normalizedCalls[0].options.sourceWorkspaceRoots, [WORKSPACE_ROOT]);
    assert.equal(normalizedCalls[0].options.targetWorkspaceRoot, WORKSPACE_ROOT);
    assert.equal(rewriteCalls.length, 1);
    assert.equal(rewriteCalls[0][1][0].rawDirectory, rawDirectory);
    assert.equal(rewriteCalls[0][2], WORKSPACE_ROOT);
    assert.match(report.engine_coverage.error, /module LCOV\/raw coverage reports are missing/);
  } finally {
    Object.assign(sharding, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-910: a run writes a valid manifest beside its report, and the report names it", () => {
  const dir = mkTmp("coord910-runner-");
  const report = path.join(dir, "report.json");
  try {
    const file = path.join(__dirname, "sqlite-runtime.test.js");
    const res = callRunnerMain(["--file", file, "--report", report, "--base", "HEAD"]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const json = JSON.parse(fs.readFileSync(report, "utf8"));
    const manifestPath = path.join(dir, "report.manifest.json");
    assert.equal(json.run_manifest.path, manifestPath);
    assert.match(res.stdout, /concord-tests: manifest=.*report\.manifest\.json input_digest=sha256:/);
    const runManifest = runner.loadRunManifest();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(runManifest.validateManifest(manifest), []);
    assert.equal(manifest.input_digest, json.run_manifest.input_digest);
    assert.equal(manifest.inputs.source.base, manifest.inputs.source.commit);
    assert.deepEqual(manifest.inputs.environment.scrubbed_env, [...runner.STRIPPED_ENV_VARS].sort());
    assert.deepEqual(manifest.plan.shards, [{ lane: "core", files: [path.relative(WORKSPACE_ROOT, file)] }]);
    assert.deepEqual(manifest.lanes.map((l) => [l.name, l.exit_code]), [["core", 0]]);
    assert.deepEqual(manifest.artifacts.map((a) => a.path), [report]);
    assert.equal(manifest.artifacts[0].sha256, runManifest.artifactDigests([report])[0].sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-910: without run-manifest.js the report says why, and an unwritable manifest fails the run", () => {
  const dir = mkTmp("coord910-runner-skip-");
  const file = path.join(__dirname, "sqlite-runtime.test.js");
  try {
    assert.equal(runner.loadRunManifest(path.join(dir, "absent.js")), null);
    const report = path.join(dir, "report.json");
    const skipped = callRunnerMain(["--file", file, "--report", report], { runManifest: null });
    assert.equal(skipped.status, 0, skipped.stderr);
    const json = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(json.run_manifest, null);
    assert.equal(json.run_manifest_skip_reason, "run-manifest.js is not present beside the runner");
    assert.doesNotMatch(skipped.stdout, /concord-tests: manifest=/);
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const failed = callRunnerMain(["--file", file, "--report", path.join(dir, "r2.json"), "--manifest", path.join(blocker, "m.json")]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /run manifest .*not-a-dir\/m\.json/);
    assert.match(failed.stdout, /result=FAIL/);
    assert.deepEqual(runner.parseArgs(["--manifest"]).errors, ["--manifest requires a value"]);
    assert.deepEqual(runner.parseArgs(["--module"]).errors, ["--module requires a value"]);
    assert.deepEqual(runner.parseArgs(["--file"]).errors, ["--file requires a value"]);
    assert.match(runner.parseArgs(["--shards", "many"]).errors.join(" "), /--shards requires a positive integer or auto/);
    assert.match(runner.parseArgs(["--qualification-stage", "unsupported"]).errors.join(" "), /--qualification-stage requires/);
    assert.deepEqual(runner.parseArgs(["--shard-history"]).errors, ["--shard-history requires a value"]);
    assert.equal(runner.parseArgs(["--base", "dev"]).base, "dev");
    assert.match(runner.parseArgs(["--shards", "2"]).errors.join(" "), /requires an explicit full-gate --qualification-stage/);
    assert.match(runner.parseArgs(["--shards", "2", "--qualification-stage", "nightly"]).errors.join(" "), /requires --qualification-mode full or selection/);
    assert.match(runner.parseArgs(["--shards", "2", "--qualification-stage", "promotion", "--policy-stage", "staging", "--qualification-mode", "full", "--module", "core"]).errors.join(" "), /complete inventory/);
    assert.equal(runner.parseArgs(["--shards", "2", "--qualification-stage", "release", "--policy-stage", "release", "--qualification-mode", "full"]).errors.length, 0);
    assert.equal(runner.parseArgs(["--shards", "2", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "full"]).errors.length, 0);
    assert.match(runner.parseArgs(["--shards", "2", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "full", "--", "--test-name-pattern=fixture"]).errors.join(" "), /cannot use arbitrary node --test filters/);
    assert.match(runner.parseArgs(["--shards", "auto", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "selection"]).errors.join(" "), /requires an explicit resolved module or file set/);
    assert.equal(runner.parseArgs(["--shards", "auto", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "selection", "--file", "coord/a.test.js"]).errors.length, 0);
    assert.match(runner.parseArgs(["--shards", "2", "--qualification-stage", "pr", "--policy-stage", "pr", "--qualification-mode", "selection", "--file", "coord/a.test.js", "--engine-coverage"]).errors.join(" "), /whole-suite coverage ratchet/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// COORD-904: --profile-costs and the child-CLI probe (contract tests).
const PROBE = path.join(__dirname, "test-cost-probe.js");

test("COORD-904: probe records each child spawn and returns the unmodified child result", () => {
  const root = mkTmp("coord904-probe-");
  const cp = require("node:child_process");
  const originals = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFileSync: cp.execFileSync };
  const previousLog = process.env.COORD_TEST_COST_LOG;
  const log = path.join(root, "cost.jsonl");
  try {
    process.env.COORD_TEST_COST_LOG = log;
    require(PROBE);
    const run = () => {
      const withArgs = cp.spawnSync(process.execPath, ["-e", 'process.stdout.write("hi"); process.exitCode = 3'], { encoding: "utf8" });
      const noArgs = cp.spawnSync(process.execPath, { stdio: "ignore" });
      return { status: withArgs.status, stdout: withArgs.stdout, noArgs: noArgs.status };
    };
    const expected = { status: 3, stdout: "hi", noArgs: 0 };
    assert.deepEqual(run(), expected);
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[0].status, 3);
    assert.ok(records[0].ms >= 0);
    assert.equal(typeof records[0].cmd, "string");
    assert.deepEqual(records[1].args, []);

    fs.unlinkSync(log);
    fs.mkdirSync(log);
    assert.deepEqual(run(), expected, "a cost log error preserves both child results");
    assert.deepEqual(fs.readdirSync(log), []);
  } finally {
    Object.assign(cp, originals);
    delete require.cache[PROBE];
    if (previousLog === undefined) delete process.env.COORD_TEST_COST_LOG;
    else process.env.COORD_TEST_COST_LOG = previousLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-904: probe without COORD_TEST_COST_LOG writes nothing and changes no result", () => {
  const root = mkTmp("coord904-probe-off-");
  try {
    const env = { ...process.env };
    delete env.COORD_TEST_COST_LOG;
    const code = `
      const r = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exitCode = 5']);
      process.stdout.write(String(r.status));
    `;
    const child = spawnSync(process.execPath, ["--require", PROBE, "-e", code], { encoding: "utf8", cwd: root, env });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "5");
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-904: default runner report carries no profile and the per-module shape is unchanged", () => {
  const root = mkTmp("coord904-default-");
  try {
    const { report } = runOnSmokeTree(root, []);
    assert.equal(report.profile, null);
    const [only] = report.results;
    assert.equal(only.module, "core");
    assert.equal(only.pass, 2);
    assert.equal(only.exit_code, 0);
    assert.ok(!("child_cli_ms" in only));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-904: --profile-costs reports per-file wall, node, non-test and child-CLI time", () => {
  const root = mkTmp("coord904-profile-");
  try {
    const { report } = runOnSmokeTree(root, ["--profile-costs"]);
    assert.equal(report.profile.schema_version, 1);
    assert.equal(report.profile.files.length, 2);
    for (const entry of report.profile.files) {
      assert.equal(entry.exit_code, 0);
      assert.ok(entry.wall_ms >= entry.node_tap_ms, "wall covers node's own duration");
      assert.ok(entry.non_test_ms >= 0);
      assert.ok(entry.child_cli_ms >= 0);
      assert.equal(entry.child_cli_nested_double_count_possible, true);
    }
    const [only] = report.results;
    assert.equal(only.pass, 2, "per-file runs merge into the same module counts");
    assert.equal(only.exit_code, 0);
    assert.equal(only.files.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-1052: the smoke-tree profile contract above copies the runner into a
// fixture process. Exercise the canonical runner module too, so coverage sees
// the actual profileFileEntry implementation rather than only its copy.
test("COORD-1052: canonical runner records per-file profile data", (t) => {
  const root = mkTmp("coord1052-profile-canonical-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "profile-smoke.test.js");
  const noChildren = path.join(root, "profile-no-children.test.js");
  const zeroDuration = path.join(root, "profile-zero-duration.test.js");
  const reportPath = path.join(root, "report.json");
  fs.writeFileSync(noChildren, "require('node:test')('no spawned processes', () => {});\n");
  fs.writeFileSync(file, `
    const assert = require('node:assert/strict');
    require('node:test')('profile smoke', () => {
      assert.equal(require('node:child_process').spawnSync(process.execPath, ['--version']).status, 0);
    });
  `);
  fs.writeFileSync(zeroDuration, `
    const assert = require('node:assert/strict');
    const { performance } = require('node:perf_hooks');
    require('node:test')('profile a zero-duration sample', () => {
      // Hold the clock still for the actual spawn so the probe emits 0 ms.
      Object.defineProperty(performance, 'now', { configurable: true, value: () => 100 });
      try {
        assert.equal(require('node:child_process').spawnSync(process.execPath, ['--version']).status, 0);
      } finally {
        delete performance.now;
      }
    });
  `);
  const result = runner.main(["--profile-costs", "--module", "core", "--report", reportPath], {
    buildInventory: () => ({ layout: "engine", content_root: CONTENT_ROOT, workspace_root: root,
      modules: [{ name: "core", files: [file, noChildren, zeroDuration] }] }),
    gitCheck: () => ({ ok: true }),
    runManifest: null,
  });
  assert.equal(result, 0);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.profile.schema_version, 1);
  assert.equal(report.profile.files.length, 3);
  assert.equal(report.profile.files[0].file, file);
  assert.equal(report.profile.files[0].exit_code, 0);
  assert.ok(report.profile.files[0].wall_ms >= report.profile.files[0].node_tap_ms);
  assert.ok(report.profile.files[0].non_test_ms >= 0);
  assert.ok(report.profile.files[0].child_cli_count >= 1);
  assert.ok(report.profile.files[0].child_cli_ms > 0);
  assert.equal(report.profile.files[0].child_cli_nested_double_count_possible, true);
  assert.equal(report.profile.files[1].file, noChildren);
  assert.equal(report.profile.files[1].child_cli_count, 0);
  assert.equal(report.profile.files[1].child_cli_ms, 0);
  assert.equal(report.profile.files[2].file, zeroDuration);
  assert.equal(report.profile.files[2].child_cli_count, 1);
  assert.equal(report.profile.files[2].child_cli_ms, 0);
});

test("COORD-1052: runner keeps shard execution internal and rejects malformed duration history", (t) => {
  const root = mkTmp("coord1052-runner-shard-refusal-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report.json");
  const options = {
    buildInventory: () => ({ layout: "engine", content_root: CONTENT_ROOT, workspace_root: root,
      modules: [{ name: "core", files: ["coord/engine/scripts/example.test.js"] }] }),
    gitCheck: () => ({ ok: true }),
    runManifest: null,
  };
  const shardedArgs = ["--shards", "1", "--qualification-stage", "pr", "--qualification-mode", "full", "--policy-stage", "pr"];
  let output = callRunnerMain([...shardedArgs, "--shard-child", "--report", reportPath], options);
  assert.equal(output.status, 2);
  assert.match(output.stderr, /--shard-child is reserved for the internal shard executor/);
  for (const option of ["--policy-stage", "--qualification-mode"]) {
    output = callRunnerMain(["--shards", "1", option], options);
    assert.equal(output.status, 2);
    assert.ok(output.stderr.includes(`${option} requires a value`));
    assert.equal(fs.existsSync(reportPath), false);
  }

  for (const historyText of ["{", JSON.stringify({ suites: [] })]) {
    const historyPath = path.join(root, `history-${historyText.length}.json`);
    fs.writeFileSync(historyPath, historyText);
    output = callRunnerMain([...shardedArgs, "--shard-history", historyPath, "--report", reportPath], options);
    assert.equal(output.status, 1);
    assert.match(output.stderr, /sharded run failed closed/);
    assert.doesNotMatch(output.stderr, /could not persist|coverage baseline/);
  }
});

// A minimal copy of the runner with two passing suites, so the runner's own
// inventory, report and profile paths run for real without the whole repository.
function runOnSmokeTree(root, extraArgs) {
  const engineScripts = path.join(root, "coord", "engine", "scripts");
  const scripts = path.join(root, "coord", "scripts");
  fs.mkdirSync(engineScripts, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ["test-runner.js", "test-census-observer.js", "test-isolation-guard.js", "sqlite-runtime.js", "test-node-options.js", "git-prerequisite.js", "agent-identity-env.js", "test-cost-probe.js"]) {
    const source = path.join(__dirname, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(engineScripts, name));
  }
  fs.writeFileSync(path.join(scripts, "alpha.test.js"), "require('node:test')('alpha',()=>require('node:assert/strict').ok(true));\n");
  fs.writeFileSync(path.join(scripts, "beta.test.js"), "require('node:test')('beta',()=>require('node:assert/strict').ok(true));\n");
  const reportPath = path.join(root, "report.json");
  const child = spawnSync(process.execPath, [path.join(engineScripts, "test-runner.js"), ...extraArgs,
    "--file", path.join(scripts, "alpha.test.js"), "--file", path.join(scripts, "beta.test.js"), "--report", reportPath],
  { cwd: root, encoding: "utf8", timeout: 120000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return { report: JSON.parse(fs.readFileSync(reportPath, "utf8")), stdout: child.stdout };
}

// COORD-907: --changed-since is an ADVISORY pre-gate over the changed suites (contract tests).
test("COORD-907: --changed-since parses as an advisory selector and refuses gate-writing combinations", () => {
  assert.equal(runner.parseArgs([]).changedSince, null, "default runs carry no advisory selector");
  assert.equal(runner.parseArgs(["--changed-since", "origin/dev"]).changedSince, "origin/dev");
  assert.deepEqual(runner.parseArgs(["--changed-since"]).errors, ["--changed-since requires a value"]);
  assert.equal(runner.parseArgs(["--engine-coverage", "--changed-since", "origin/dev"]).errors.length, 0,
    "the ticket's example invocation is accepted");
  for (const extra of [["--write-coverage-baseline"], ["--report", "r.json"], ["--manifest", "m.json"],
    ["--file", "coord/a.test.js"], ["--module", "core"], ["--list"], ["--", "--test-name-pattern=x"]]) {
    const errors = runner.parseArgs(["--changed-since", "origin/dev", ...extra]).errors.join(" ");
    assert.match(errors, /advisory/, `advisory refuses ${extra.join(" ")}`);
  }
  const shardedAdvisory = ["--changed-since", "origin/dev", "--shards", "2", "--qualification-stage", "promotion",
    "--policy-stage", "promotion", "--qualification-mode", "full"];
  assert.match(runner.parseArgs(shardedAdvisory).errors.join("\n"), /advisory.*shards/, "advisory itself refuses otherwise-valid full sharding");
  const refused = callRunnerMain(shardedAdvisory, {
    buildInventory: () => assert.fail("invalid advisory sharding must not reach inventory or worker dispatch"),
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /advisory.*shards/);
});

test("COORD-907: the advisory flag leaves the default usage and the default option set unchanged", () => {
  const help = runNode([RUNNER_PATH, "--help"], { cwd: WORKSPACE_ROOT });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--changed-since <ref>/);
  const plain = runner.parseArgs(["--module", "core"]);
  assert.equal(plain.errors.length, 0);
  assert.equal(plain.changedSince, null);
  assert.equal(plain.engineCoverage, false);
  assert.equal(plain.writeCoverageBaseline, false);
});

test("COORD-907: test-runner.js keeps its top-level requires and lazy-loads the advisory engine modules", () => {
  const source = fs.readFileSync(path.join(CONTENT_ROOT, "engine", "scripts", "test-runner.js"), "utf8");
  // Top-level requires are the unindented `const ...= require(...)` lines plus the multi-line
  // `const {` ... `} = require(...)` destructuring blocks. Both must stay exactly this list.
  const topLevel = [];
  for (const block of source.split(/^(?=const |\} = )/m)) {
    if (!/^(const|\})/.test(block)) continue;
    const spec = /require\("([^"]+)"\)/.exec(block.slice(0, block.indexOf(";") + 1));
    if (spec) topLevel.push(spec[1]);
  }
  assert.deepEqual(topLevel, ["node:fs", "node:os", "node:path", "node:crypto", "node:perf_hooks",
    "node:child_process", "./git-prerequisite.js", "./sqlite-runtime.js", "./test-node-options.js", "./agent-identity-env.js"],
  "COORD-910: mandatory packed runtime helpers stay top-level; advisory engine modules load lazily under the flag only");
});

test("COORD-907: --changed-since reports a newly executed finer arm, labels itself advisory and writes no baseline",
  { skip: nativeCoverageUnsupported ? `native coverage fixture supports Node 22.x/24.x, found ${process.version}` : false }, (t) => {
  const workspaceRoot = mkTmp("coord907-changed-since-");
  const contentRoot = path.join(workspaceRoot, "coord");
  const fixtureFile = path.join(contentRoot, "scripts", "fixture.js");
  const fixtureTest = path.join(contentRoot, "scripts", "fixture.test.js");
  const innerTest = path.join(contentRoot, "scripts", "inner.test.js");
  const commonJsFile = path.join(contentRoot, "scripts", "value.cjs");
  const removedFile = path.join(contentRoot, "scripts", "unused.js");
  const mentionTest = path.join(contentRoot, "scripts", "mention.test.js");
  const baselineSource = "function choose(flag) {\n  if (flag) return 'yes';\n  return 'no';\n}\n" +
    "function inner(x) {\n  if (x) return 'a';\n  return 'b';\n}\nmodule.exports = { choose, inner };\n";
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: workspaceRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  const buildFixtureInventory = () => ({
    layout: "engine",
    content_root: contentRoot,
    workspace_root: workspaceRoot,
    modules: [{ name: "core", files: ["coord/scripts/fixture.test.js", "coord/scripts/inner.test.js"] }],
  });
  const helpers = {
    supportsNativeCoverageVersion: runner.supportsNativeCoverageVersion,
    buildChildEnv: runner.buildChildEnv,
    ENGINE_COVERAGE_ARGS: runner.ENGINE_COVERAGE_ARGS,
    parseTapSummary: runner.parseTapSummary,
    coverageBaselinePathForNode: runner.coverageBaselinePathForNode,
    assertCoverageBaselineProvenance: runner.assertCoverageBaselineProvenance,
  };
  // Invoke the canonical module so coverage records its execution with the fixture.
  const runAdvisory = (changedSince, { json = true, overrides = {} } = {}) => {
    let stdout = "";
    let stderr = "";
    const status = changedSinceAdvisory.runChangedSinceAdvisory(buildFixtureInventory(),
      { changedSince, json },
      { write: (chunk) => { stdout += chunk; } },
      { write: (chunk) => { stderr += chunk; } },
      process.version, { ...helpers, ...overrides });
    return { status, stdout, stderr };
  };
  try {
    fs.mkdirSync(contentRoot, { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "scripts"), path.join(contentRoot, "scripts"), { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "engine"), path.join(contentRoot, "engine"), { recursive: true });
    fs.cpSync(path.join(CONTENT_ROOT, "paths.js"), path.join(contentRoot, "paths.js"));
    fs.writeFileSync(fixtureFile, baselineSource);
    fs.writeFileSync(commonJsFile, "module.exports = 1;\n");
    fs.writeFileSync(removedFile, "module.exports = null;\n");
    fs.writeFileSync(mentionTest, [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "test('fixture source exports choose', () => {",
      "  const source = fs.readFileSync(path.join(__dirname, 'fixture.js'), 'utf8');",
      "  require('node:assert/strict').match(source, /module.exports = { choose/);",
      "});",
    ].join("\n"));
    // Baseline suite: choose(true) only. inner is never executed.
    fs.writeFileSync(fixtureTest, "const test = require('node:test');\nconst choose = require('./fixture.js').choose;\nrequire('./value.cjs');\n" +
      "test('choose true arm', () => require('node:assert/strict').equal(choose(true), 'yes'));\n");
    runGit(["init", "-q"]);
    runGit(["config", "user.name", "Coverage Fixture"]);
    runGit(["config", "user.email", "coverage@example.invalid"]);
    runGit(["add", "coord"]);
    runGit(["commit", "-q", "-m", "COORD-907 fixture baseline"]);
    const noChanges = runAdvisory("HEAD", { json: false, overrides: {
      buildChildEnv: () => assert.fail("a change without selected suites should skip coverage"),
    } });
    assert.equal(noChanges.status, 0, noChanges.stderr);
    assert.match(noChanges.stdout, /suites \(0\): none touch the change/);
    assert.doesNotMatch(noChanges.stdout, /suite results:/);

    const baselineReport = path.join(workspaceRoot, "baseline-report.json");
    assert.equal(runner.main(["--write-coverage-baseline", "--report", baselineReport], { buildInventory: buildFixtureInventory }), 0);
    const baselinePath = runner.coverageBaselinePathForNode(contentRoot);
    const baselineBytes = fs.readFileSync(baselinePath);

    // CJS imports select the suite, even though the advisory's .js text diff is empty.
    fs.writeFileSync(commonJsFile, "module.exports = 2;\n");
    const commonJs = runAdvisory("HEAD");
    assert.equal(commonJs.status, 0, commonJs.stderr);
    const commonJsReport = JSON.parse(commonJs.stdout);
    assert.deepEqual(commonJsReport.selected_suites, ["coord/scripts/fixture.test.js"]);
    assert.deepEqual(commonJsReport.tests, { pass: 1, fail: 0 });
    assert.deepEqual(commonJsReport.text_changed, []);

    // Change: one changed text line in choose, and a new suite that executes inner(true) only.
    fs.rmSync(removedFile);
    fs.writeFileSync(fixtureFile, baselineSource.replace("return 'no';", "return 'nope';"));
    fs.writeFileSync(innerTest, "const test = require('node:test');\nconst inner = require('./fixture.js').inner;\n" +
      "test('inner true arm', () => require('node:assert/strict').equal(inner(true), 'a'));\n");
    runGit(["add", "coord"]);
    runGit(["commit", "-q", "-m", "COORD-907 fixture change"]);

    const run = callRunnerMain(["--changed-since", "HEAD~1", "--json"], { buildInventory: buildFixtureInventory });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
    assert.equal(report.advisory, true);
    assert.equal(report.gate_evidence, false);
    assert.equal(report.baseline_written, false);
    assert.deepEqual(report.selected_suites, ["coord/scripts/fixture.test.js", "coord/scripts/inner.test.js"],
      "the changed suite and the suite that directly imports the changed fixture module, nothing wider");
    assert.ok(report.selector_suites_not_run > 0, "the selector's wider reach is counted and left to the whole-suite gate");
    assert.ok(report.text_changed.some((f) => f.file === "scripts/fixture.js" && f.line === 3),
      "a changed uncovered line is text-changed and needs real tests");
    assert.ok(report.unchanged_arms.some((f) => f.file === "scripts/fixture.js" && f.line >= 5 && f.line <= 8),
      "the finer arm of the newly executed inner function is an unchanged arm");
    assert.deepEqual(fs.readFileSync(baselinePath), baselineBytes, "the advisory never writes the baseline");
    assert.equal(/concord-test-report|concord-tests: report=/.test(run.stdout), false, "the advisory writes no gate report");

    const direct = runAdvisory("HEAD~1");
    assert.equal(direct.status, 0, direct.stderr);
    const directReport = JSON.parse(direct.stdout);
    assert.equal(directReport.gate_evidence, false);
    assert.deepEqual(directReport.selected_suites, report.selected_suites);
    assert.ok(directReport.text_changed.some((f) => f.file === "scripts/fixture.js" && f.line === 3));
    const fixtureRel = "coord/scripts/fixture.js";
    const mentionRel = "coord/scripts/mention.test.js";
    const graph = require("./affected-graph.js").buildGraph({ root: workspaceRoot, files: [fixtureRel, mentionRel] });
    assert.ok(graph.reverse.get(fixtureRel).has(mentionRel));
    assert.deepEqual(graph.loadEdges.get(mentionRel), new Set(), "mention-only suites still have a load-edge set");
    assert.ok(!directReport.selected_suites.includes(mentionRel), "reading source text is not a direct import");

    const lowDisk = t.mock.method(fs, "statfsSync", () => ({ bsize: 4096n, bavail: 0n }));
    try {
      const result = runAdvisory("HEAD~1", { overrides: {
        buildChildEnv: () => assert.fail("coverage must not start when preflight fails"),
      } });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /insufficient free disk space for coverage/);
      assert.equal(result.stdout, "");
    } finally {
      lowDisk.mock.restore();
    }

    let scratch;
    const missingBaseline = runAdvisory("HEAD~1", { overrides: {
      buildChildEnv: (root, directory) => {
        scratch = directory;
        return runner.buildChildEnv(root, directory);
      },
      coverageBaselinePathForNode: () => path.join(workspaceRoot, "missing-baseline.json"),
    } });
    assert.equal(missingBaseline.status, 2);
    assert.match(missingBaseline.stderr, /advisory --changed-since unavailable: .*missing-baseline\.json/);
    assert.equal(missingBaseline.stdout, "");
    assert.ok(scratch, "the measurement started before the baseline read failed");
    assert.equal(fs.existsSync(scratch), false, "the advisory removes failed measurement artifacts");
    assert.deepEqual(fs.readFileSync(baselinePath), baselineBytes, "the canonical advisory leaves the baseline byte-identical");
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("COORD-1052: canonical advisory module refuses unsupported runtimes and invalid refs", () => {
  let stderr = "";
  const err = { write: (chunk) => { stderr += chunk; } };
  const helpers = { supportsNativeCoverageVersion: (version) => ["v22.8.0", "v24.22.0"].includes(version) };
  const inventory = { workspace_root: WORKSPACE_ROOT, content_root: CONTENT_ROOT };
  assert.equal(changedSinceAdvisory.runChangedSinceAdvisory(inventory, { changedSince: "HEAD" }, { write() {} }, err,
    "v20.0.0", helpers), 2);
  assert.match(stderr, /supports Node 22\.x and 24\.x/);

  stderr = "";
  assert.equal(changedSinceAdvisory.runChangedSinceAdvisory(inventory,
    { changedSince: "COORD-1052-not-a-commit" }, { write() {} }, err, "v22.8.0", helpers), 2);
  assert.match(stderr, /is not a commit/);
});

test("COORD-1052: advisory formatter reports selected coverage without claiming gate evidence", () => {
  const plan = { base: "origin/dev", selector_decision: "exact", fallback_reasons: [],
    selected_suites: ["coord/engine/scripts/example.test.js"], selector_suites_not_run: 2,
    tests: { pass: 4, fail: 0 }, candidates: [{ file: "scripts/example.js", line: 8 }],
    text_changed: [{ file: "scripts/example.js", line: 8, message: "new branch" }],
    unchanged_arms: [{ file: "scripts/example.js", line: 9, message: "unchanged arm" }],
    unobserved_files: ["scripts/unused.js"] };
  let jsonText = "";
  assert.equal(changedSinceAdvisory.emitChangedSinceAdvisory(plan, { write: (chunk) => { jsonText += chunk; } }, { json: true }), 0);
  assert.deepEqual(JSON.parse(jsonText), plan);

  let text = "";
  const fallbackPlan = { ...plan, selector_decision: "full", fallback_reasons: ["unknown_dependents"] };
  assert.equal(changedSinceAdvisory.emitChangedSinceAdvisory(fallbackPlan, { write: (chunk) => { text += chunk; } }, { json: false }), 0);
  assert.match(text, /not gate evidence; no baseline written/);
  assert.match(text, /selector: full \(fallbacks: unknown_dependents; shown set is the direct-impact selection\)/);
  assert.match(text, /suites \(1\)/);
  assert.match(text, /selector-widened suites not run here \(2\)/);
  assert.match(text, /text-changed lines: likely new_uncovered/);
  assert.match(text, /unchanged finer arms: likely new_uncovered/);
  assert.match(text, /not measured \(production files no selected suite loads\): 1/);
});

function observerReleaseArgs(descriptor) {
  return ["--qualification-stage", "release", "--policy-stage", "release", "--qualification-mode", "full",
    "--engine-coverage", "--census-observer", descriptor];
}

test("COORD-1052: observer admission requires full release coverage and refuses external selection", () => {
  const good = observerReleaseArgs("/tmp/fixture-observer.json");
  assert.deepEqual(runner.parseArgs(good).errors, []);
  assert.deepEqual(runner.parseArgs([...good, "--shards", "2"]).errors, []);
  for (const flag of ["--qualification-stage", "--policy-stage", "--qualification-mode"]) {
    const args = good.slice(); args[args.indexOf(flag) + 1] = flag === "--qualification-mode" ? "selection" : "pr";
    assert.match(runner.parseArgs(args).errors.join("; "), /full release qualification/, flag);
  }
  assert.match(runner.parseArgs(good.filter((arg) => arg !== "--engine-coverage")).errors.join("; "), /requires --engine-coverage/);
  assert.match(runner.parseArgs([...good, "--write-coverage-baseline"]).errors.join("; "), /cannot write a baseline/);
  for (const extra of [["--file", "example.test.js"], ["--module", "core"], ["--changed-since", "HEAD"], ["--list"], ["--", "--require=/tmp/other.js"]]) {
    assert.ok(runner.parseArgs([...good, ...extra]).errors.length > 0, extra.join(" "));
  }
  assert.ok(runner.parseArgs([...good, "--census-observer", "/tmp/second.json"]).errors.length > 0);
  assert.ok(runner.parseArgs(observerReleaseArgs("")).errors.length > 0, "empty descriptor must not silently disable observation");
  assert.deepEqual(runner.parseArgs([...good, "--shard-child", "--file", "coord/engine/scripts/fixture.test.js"]).errors, [],
    "only the internal child shape can carry its assigned files; runtime authority is checked by main");
});

function runnerObserverFixture(t) {
  const { createTempGitRepo } = require(resolveEngineModule(CONTENT_ROOT, "scripts/governance-test-utils.js"));
  const files = {
    // Resolve to the real canonical guard through the fixture path the runner
    // preloads; do not copy the guard implementation into this temporary repo.
    "coord/engine/scripts/test-isolation-guard.js": `require(${JSON.stringify(path.join(__dirname, "test-isolation-guard.js"))});\n`,
    "coord/engine/scripts/observer-subject.js": "module.exports = value => value ? 'yes' : 'no';\n",
    "coord/engine/scripts/observer-subject.test.js": [
      "const test = require('node:test'), assert = require('node:assert/strict');",
      "const subject = require('./observer-subject.js');",
      "test('real observer transport fixture', () => {",
      "assert.equal(globalThis.__observerTransportLoaded, true);",
      "assert.equal(subject(true), 'yes'); assert.equal(subject(false), 'no');",
      "});",
    ].join("\n"),
  };
  // Import actual implementations; do not copy their source or stub coverage.
  for (const name of ["engine-coverage.js", "coverage-source-provider.js", "coverage-aggregate.js"]) {
    files[`coord/engine/scripts/${name}`] = `module.exports = require(${JSON.stringify(path.join(__dirname, name))});\n`;
  }
  const repo = createTempGitRepo("coord1052-observer-runner-", files);
  const evidence = fs.realpathSync(mkTmp("coord1052-observer-evidence-"));
  t.after(() => { fs.rmSync(repo.repoRoot, { recursive: true, force: true }); fs.rmSync(evidence, { recursive: true, force: true }); });
  const outputRoot = path.join(evidence, "records"); fs.mkdirSync(outputRoot);
  const loggerPath = path.join(evidence, "fixture-observer.js");
  fs.writeFileSync(loggerPath, [
    "if (process.env.NODE_TEST_CONTEXT === 'child-v8') {",
    "globalThis.__observerTransportLoaded = true;",
    "const fs = require('node:fs'), path = require('node:path');",
    "const directory = process.env.COORD_TEST_CENSUS_DIR;",
    "if (!directory) throw new Error('missing generic observer directory');",
    "fs.writeFileSync(path.join(directory, process.pid + '.json'), JSON.stringify({file: process.argv[1], cwd: process.cwd(), observer_ran: true}));",
    "}",
  ].join("\n"));
  const hash = (file) => `sha256:${require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  const descriptor = { schema_version: 1, kind: "release-suite-census", mode: "serial", logger_path: loggerPath,
    logger_sha256: hash(loggerPath), output_root: outputRoot };
  const descriptorPath = path.join(evidence, "observer.json");
  const writeDescriptor = () => fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  writeDescriptor();
  const reportPath = path.join(evidence, "report.json");
  const options = { buildInventory: () => ({ layout: "engine", content_root: path.join(repo.repoRoot, "coord"),
    workspace_root: repo.repoRoot, modules: [{ name: "core", files: ["coord/engine/scripts/observer-subject.test.js"] }] }) };
  return { ...repo, evidence, outputRoot, loggerPath, descriptor, descriptorPath, reportPath, hash, writeDescriptor, options };
}

test("COORD-1052: real serial execution binds observer bytes and logs while missing coverage still fails", { skip: nativeCoverageUnsupported }, (t) => {
  const fx = runnerObserverFixture(t);
  const result = callRunnerMain([...observerReleaseArgs(fx.descriptorPath), "--report", fx.reportPath], fx.options);
  assert.equal(result.status, 1, "the fixture has no qualifying coverage baseline");
  const report = JSON.parse(fs.readFileSync(fx.reportPath, "utf8"));
  assert.equal(report.suite_result, "pass", result.stdout + result.stderr);
  assert.equal(report.totals.tests, 1);
  assert.equal(report.totals.pass, 1);
  assert.equal(report.result, "fail", "valid transport cannot waive a coverage failure");
  assert.ok(report.engine_coverage.error);
  assert.deepEqual(report.release_observer, fx.descriptor);
  assert.deepEqual(report.release_observer_binding, { path: fx.descriptorPath, sha256: fx.hash(fx.descriptorPath) });
  const names = fs.readdirSync(fx.outputRoot);
  assert.equal(names.length, 1, "only the actual suite process loads the observer");
  const logPath = path.join(fx.outputRoot, names[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(logPath, "utf8")), {
    file: path.join(fx.repoRoot, "coord/engine/scripts/observer-subject.test.js"), cwd: fx.repoRoot, observer_ran: true,
  });
  const manifest = JSON.parse(fs.readFileSync(report.run_manifest.path, "utf8"));
  assert.deepEqual(runner.loadRunManifest().validateManifest(manifest), []);
  for (const file of [fx.reportPath, fx.descriptorPath, logPath]) {
    const artifacts = manifest.artifacts.filter((entry) => entry.path === file);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].sha256, fx.hash(file));
    assert.equal(artifacts[0].bytes, fs.statSync(file).size);
  }
});

test("COORD-1052: serial observer rejects mode and byte mismatches before any suite runs", { skip: nativeCoverageUnsupported }, (t) => {
  const fx = runnerObserverFixture(t);
  for (const change of [() => { fx.descriptor.mode = "sharded"; }, () => {
    fx.descriptor.mode = "serial"; fx.descriptor.logger_sha256 = `sha256:${'0'.repeat(64)}`;
  }]) {
    change(); fx.writeDescriptor();
    const result = callRunnerMain([...observerReleaseArgs(fx.descriptorPath), "--report", fx.reportPath], fx.options);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /release census observer refused/);
    assert.deepEqual(fs.readdirSync(fx.outputRoot), []);
    assert.equal(fs.existsSync(fx.reportPath), false);
  }
});

// This test isolates the canonical parent writer from the executor. Worker
// results below are explicit fixtures, never evidence of a qualifying run.
// The separate executor test runs real child processes and dependency installs.
test("COORD-1052: parent runner binds worker index artifacts and preserves a missing-worker failure report", { skip: nativeCoverageUnsupported }, (t) => {
  const sharding = require("./test-sharding.js");
  const manifestApi = runner.loadRunManifest();
  const originals = { resolveShardCount: sharding.resolveShardCount, loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority, executeShards: sharding.executeShards,
    normalizeRawCoverageModules: sharding.normalizeRawCoverageModules };
  t.after(() => Object.assign(sharding, originals));
  for (const workerEvidence of ["complete", "missing report", "missing skip names"]) {
    const missingWorker = workerEvidence === "missing report";
    const fx = runnerObserverFixture(t);
    fx.descriptor.mode = "sharded"; fx.writeDescriptor();
    const assignment = ["coord/engine/scripts/observer-subject.test.js"];
    const inputs = manifestApi.collectInputs({ root: fx.repoRoot }).inputs;
    assert.equal(inputs.source.dirty, false);
    const workerReportPath = path.join(fx.outputRoot, "worker-1.report.json");
    const workerManifestPath = path.join(fx.outputRoot, "worker-1.manifest.json");
    let workerLogPath;
    Object.assign(sharding, {
      resolveShardCount: () => 1,
      loadTimingSensitiveSuites: () => [],
      resolveShardAuthority: () => ({ mode: "explicit parent-writer test fixture" }),
      executeShards: (options) => {
        assert.equal(options.censusObserverDescriptorPath, fx.descriptorPath);
        // Create outputs only after main has checked its initially empty root.
        const logDir = path.join(fx.outputRoot, "workers", "1"); fs.mkdirSync(logDir, { recursive: true });
        workerLogPath = path.join(logDir, "fixture.json");
        fs.writeFileSync(workerLogPath, JSON.stringify({ fixture_only: true, file: assignment[0] }));
        const child = { result: "partial", suite_result: "pass", workspace_root: path.join(fx.evidence, "removed-worker"),
          shard_assignment: assignment, execution_order: assignment, release_observer: fx.descriptor,
          release_observer_binding: { path: fx.descriptorPath, sha256: fx.hash(fx.descriptorPath) },
          results: [{ files: assignment, tests: 2, pass: 1, fail: 0, skipped: 1 }], engine_coverage: { raw_modules: [] } };
        if (workerEvidence === "complete") child.results[0].skipped_tests = ["parent > optional child"];
        if (!missingWorker) {
          const childManifest = manifestApi.buildManifest({ tool: "coord/scripts/test-runner.js", inputs,
            host: { tmpdir: os.tmpdir(), tmpdir_realpath: fs.realpathSync(os.tmpdir()), kernel: "parent-writer fixture" },
            lanes: [{ name: "fixture", exit_code: 0, signal: null, duration_ms: 1 }] });
          child.run_manifest = { path: workerManifestPath, input_digest: childManifest.input_digest };
          fs.writeFileSync(workerReportPath, JSON.stringify(child));
          manifestApi.writeManifest(workerManifestPath, manifestApi.finalizeManifest(childManifest,
            [workerReportPath, fx.descriptorPath, workerLogPath]));
        }
        return { sourceCommit: inputs.source.commit, sourceTree: inputs.source.tree,
          plan: { shard_count: 1, source_commit: inputs.source.commit, source_tree: inputs.source.tree,
            shards: [{ id: 1, suites: assignment.map((file) => ({ path: file, module: "core" })) }],
            assignments: [{ id: 1, suites: assignment }] },
          workers: [{ id: 1, result: missingWorker ? "fail" : "pass", exit_code: missingWorker ? 1 : 0,
            assigned: assignment, workspace: missingWorker ? undefined : child.workspace_root,
            report_path: missingWorker ? undefined : workerReportPath,
            manifest_path: missingWorker ? undefined : workerManifestPath, error: missingWorker ? "worker report unavailable: fixture worker failed" : null,
            report: missingWorker ? null : child }],
          rawModules: missingWorker ? [{ name: "fixture", rawDirectory: path.join(fx.evidence, "raw") }] : [], validationError: null };
      },
      normalizeRawCoverageModules: () => { throw new Error("failed workers must not enter raw path normalization"); },
    });
    const result = callRunnerMain([...observerReleaseArgs(fx.descriptorPath), "--shards", "1", "--report", fx.reportPath], fx.options);
    assert.equal(result.status, 1, "fixture worker records carry no qualifying coverage");
    const report = JSON.parse(fs.readFileSync(fx.reportPath, "utf8"));
    assert.equal(report.result, "fail");
    const manifest = JSON.parse(fs.readFileSync(report.run_manifest.path, "utf8"));
    assert.deepEqual(manifestApi.validateManifest(manifest), []);
    const assertBound = (file) => {
      const entries = manifest.artifacts.filter((entry) => entry.path === file);
      assert.equal(entries.length, 1, file);
      assert.equal(entries[0].sha256, fx.hash(file));
      assert.equal(entries[0].bytes, fs.statSync(file).size);
    };
    assertBound(fx.reportPath); assertBound(fx.descriptorPath); assertBound(workerLogPath);
    if (missingWorker) {
      assert.ok(report.census_error, "worker collection failure survives in the parent diagnostic report");
      assert.equal(report.census_index, null);
      assert.equal(report.shards[0].census, null);
      assert.equal(report.shards[0].result, "fail");
      assert.match(report.shards[0].error, /worker report unavailable/);
      assert.match(report.engine_coverage.error, /coverage aggregation requires every shard to pass/);
      assert.equal(fs.existsSync(path.join(fx.outputRoot, "index.json")), false);
    } else {
      assert.equal(report.census_error, null);
      assert.equal(report.results[0].skipped, 1);
      assert.deepEqual(report.results[0].skipped_tests, workerEvidence === "complete" ? ["parent > optional child"] : null);
      const indexPath = path.join(fx.outputRoot, "index.json");
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      assert.deepEqual(report.census_index, { path: indexPath, sha256: fx.hash(indexPath) });
      assert.equal(index.run_input_digest, manifest.input_digest);
      assert.equal(index.source_commit, inputs.source.commit);
      assert.equal(index.source_tree, inputs.source.tree);
      assert.equal(index.observer_sha256, fx.descriptor.logger_sha256);
      const { files, ...metadata } = index.workers[0];
      assert.deepEqual(metadata, report.shards[0].census);
      assert.deepEqual(metadata.assignment, assignment);
      assert.equal(metadata.report_sha256, fx.hash(workerReportPath));
      assert.equal(metadata.manifest_sha256, fx.hash(workerManifestPath));
      assert.deepEqual(files, [{ path: "fixture.json", sha256: fx.hash(workerLogPath), bytes: fs.statSync(workerLogPath).size }]);
      assertBound(indexPath); assertBound(workerReportPath); assertBound(workerManifestPath);
    }
  }
});

test("COORD-1052: sharded selection uses bounded worker count and bound duration history, without masking failures", () => {
  const sharding = require("./test-sharding.js");
  const original = { resolveShardCount: sharding.resolveShardCount, loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority, executeShards: sharding.executeShards,
    cleanupShardWorkers: sharding.cleanupShardWorkers };
  const root = mkTmp("coord1052-runner-shard-history-");
  const reportPath = path.join(root, "report.json"), historyPath = path.join(root, "history.json");
  const files = ["coord/engine/scripts/test-runner.test.js", "coord/engine/scripts/test-sharding.test.js",
    "coord/engine/scripts/test-policy-run.test.js"];
  const history = { suite_durations_ms: Object.fromEntries(files.map((file, index) => [file, (index + 1) * 100])) };
  fs.writeFileSync(historyPath, JSON.stringify(history));
  const calls = [], inventory = { layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
    modules: [{ name: "core", files }] };
  let cleanupCalled = false;
  try {
    sharding.resolveShardCount = (value) => { assert.equal(value, "auto"); return 8; };
    sharding.loadTimingSensitiveSuites = () => [];
    sharding.resolveShardAuthority = () => ({ authoritative: false, reason: "fixture authority is provisional" });
    sharding.executeShards = (options) => {
      calls.push(options);
      const shards = files.map((file, index) => ({ id: index + 1, suites: [{ module: "core", path: file }] }));
      return { plan: { shard_count: shards.length, shards }, rawModules: [], validationError: null,
        workers: shards.map((shard, index) => {
          const interrupted = index === 0;
          const failed = index === 1;
          return { id: shard.id, result: interrupted || failed ? "fail" : "pass",
            exit_code: interrupted ? null : failed ? 17 : 0, signal: interrupted ? "SIGKILL" : null, duration_ms: 1,
            assigned: [files[index]], report: interrupted ? null : { result: "partial", execution_order: [files[index]],
              results: [failed ? { tests: 1, fail: 1, failing_tests: ["fixture worker failure"] } : { tests: 1, pass: 1 }],
              governed_tree_violations: [], coverage_source_violations: [] } };
        }) };
    };
    sharding.cleanupShardWorkers = () => { cleanupCalled = true; return true; };
    const runWithHistory = () => callRunnerMain(["--shards", "auto", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "selection", "--module", "core", "--shard-history", historyPath, "--report", reportPath],
    { buildInventory: () => inventory, gitCheck: () => ({ ok: true }), runManifest: null });
    const result = runWithHistory();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].count, files.length, "auto selection is capped to the resolved suite count");
    assert.deepEqual(calls[0].durations, history.suite_durations_ms);
    assert.equal(calls[0].durationHistorySha256,
      require("node:crypto").createHash("sha256").update(fs.readFileSync(historyPath)).digest("hex"));
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "fail");
    assert.deepEqual(report.execution_order, files);
    assert.deepEqual(report.results.map((worker) => [worker.module, worker.exit_code, worker.pass, worker.fail]), [
      ["shard-01", -1, 0, 0], ["shard-02", 17, 0, 1], ["shard-03", 0, 1, 0],
    ]);
    assert.equal(report.results[0].signal, "SIGKILL");
    assert.deepEqual(report.results[0].failing_tests, []);
    assert.deepEqual(report.results[1].failing_tests, ["fixture worker failure"]);
    assert.deepEqual(report.totals.failed_modules, ["shard-01", "shard-02"]);
    assert.match(result.stdout, /execution=FAIL qualification=FAIL/);
    assert.equal(cleanupCalled, false, "failed diagnostics are retained, not cleaned as a green shard run");

    const compatibleInputs = [[{ suites: history.suite_durations_ms }, history.suite_durations_ms], [{}, {}]];
    for (const [historyInput, expectedDurations] of compatibleInputs) {
      const bytes = JSON.stringify(historyInput);
      fs.writeFileSync(historyPath, bytes);
      assert.equal(runWithHistory().status, 1, "history compatibility preserves the worker failure");
      assert.deepEqual(calls.at(-1).durations, expectedDurations);
      assert.equal(calls.at(-1).durationHistorySha256, require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
    }
  } finally {
    Object.assign(sharding, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1052: shard assignment integrity refusal dominates green worker reports", () => {
  const sharding = require("./test-sharding.js");
  const original = { resolveShardCount: sharding.resolveShardCount, loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority, executeShards: sharding.executeShards,
    cleanupShardWorkers: sharding.cleanupShardWorkers };
  const root = mkTmp("coord1052-runner-shard-integrity-");
  const reportPath = path.join(root, "report.json"), file = "coord/engine/scripts/test-runner.test.js";
  const inventory = { layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
    modules: [{ name: "core", files: [file] }] };
  let cleanupCalled = false;
  try {
    sharding.resolveShardCount = () => 1;
    sharding.loadTimingSensitiveSuites = () => [];
    sharding.resolveShardAuthority = () => ({ authoritative: false, reason: "fixture authority is provisional" });
    sharding.executeShards = () => ({ plan: { shard_count: 1, shards: [{ id: 1, suites: [{ module: "core", path: file }] }] },
      workers: [{ id: 1, result: "pass", exit_code: 0, signal: null, duration_ms: 1, assigned: [file],
        report: { result: "partial", execution_order: [file],
          results: [{ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, failing_tests: [] }],
          governed_tree_violations: [], coverage_source_violations: [] } }],
      rawModules: [], validationError: "worker 1 execution inventory differs from its immutable assignment" });
    sharding.cleanupShardWorkers = () => { cleanupCalled = true; return true; };
    const result = callRunnerMain(["--shards", "1", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "selection", "--module", "core", "--report", reportPath],
    { buildInventory: () => inventory, gitCheck: () => ({ ok: true }), runManifest: null });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "fail");
    assert.deepEqual(report.execution_order, [file]);
    assert.deepEqual(report.results.map((entry) => [entry.module, entry.exit_code, entry.fail]), [
      ["shard-01", 0, 0], ["shard-integrity", 1, 1],
    ]);
    assert.deepEqual(report.results.at(-1).failing_tests,
      ["worker 1 execution inventory differs from its immutable assignment"]);
    assert.deepEqual(report.totals.failed_modules, ["shard-integrity"]);
    assert.match(result.stdout, /execution=FAIL qualification=FAIL/);
    assert.equal(cleanupCalled, false, "an integrity refusal keeps worker diagnostics for investigation");

    const execute = sharding.executeShards;
    sharding.executeShards = () => {
      const run = execute();
      return { ...run, workers: [...run.workers, { id: 2, result: "fail", exit_code: null }],
        validationError: "expected 1 shard results, received 2" };
    };
    const malformed = callRunnerMain(["--shards", "1", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "selection", "--module", "core", "--report", reportPath],
    { buildInventory: () => inventory, gitCheck: () => ({ ok: true }), runManifest: null });
    assert.equal(malformed.status, 1, malformed.stderr + malformed.stdout);
    const malformedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(malformedReport.result, "fail");
    assert.equal(malformedReport.shard_error, "expected 1 shard results, received 2");
    assert.deepEqual(malformedReport.execution_order, [file]);
    const rejectedWorker = malformedReport.results.find((entry) => entry.module === "shard-02");
    assert.deepEqual(rejectedWorker.files, []);
    assert.deepEqual(rejectedWorker.suite_modules, {});
    assert.equal(rejectedWorker.exit_code, -1);
    assert.equal(cleanupCalled, false, "a malformed worker record still leaves a failure report and its diagnostics");
  } finally {
    Object.assign(sharding, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1052: malformed shard duration history refuses before worker dispatch", () => {
  const sharding = require("./test-sharding.js");
  const original = { resolveShardCount: sharding.resolveShardCount, loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority, executeShards: sharding.executeShards };
  const root = mkTmp("coord1052-runner-bad-history-");
  const historyPath = path.join(root, "history.json"), reportPath = path.join(root, "report.json");
  fs.writeFileSync(historyPath, JSON.stringify({ suite_durations_ms: [] }));
  let dispatches = 0;
  try {
    sharding.resolveShardCount = () => 1;
    sharding.loadTimingSensitiveSuites = () => [];
    sharding.resolveShardAuthority = () => ({ authoritative: false, reason: "fixture authority is provisional" });
    sharding.executeShards = () => { dispatches += 1; throw new Error("must not dispatch invalid duration evidence"); };
    const result = callRunnerMain(["--shards", "1", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "selection", "--module", "core", "--shard-history", historyPath, "--report", reportPath],
    { buildInventory: () => ({ layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
      modules: [{ name: "core", files: ["coord/engine/scripts/test-runner.test.js"] }] }),
      gitCheck: () => ({ ok: true }), runManifest: null });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sharded run failed closed: duration history must contain a suite_durations_ms map/);
    assert.equal(dispatches, 0);
    assert.equal(fs.existsSync(reportPath), false, "no run report is published for rejected dispatch input");
  } finally {
    Object.assign(sharding, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-1052: a shard child publishes only partial evidence after a real selected suite run", (t) => {
  const root = mkTmp("coord1052-runner-child-partial-");
  const reportPath = path.join(root, "worker-report.json");
  const file = "coord/scripts/file-ticket.test.js";
  t.after(() => {
    try {
      if (fs.existsSync(reportPath)) {
        const emitted = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        for (const module of emitted.engine_coverage?.raw_modules || []) {
          if (typeof module.rawDirectory !== "string") continue;
          const directory = path.resolve(module.rawDirectory);
          if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("concord-v8-core-")) continue;
          const stat = fs.lstatSync(directory);
          if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const result = callRunnerMain(["--shard-child", "--engine-coverage", "--module", "core", "--report", reportPath], {
    buildInventory: () => ({ layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
      modules: [{ name: "core", files: [file] }] }),
    gitCheck: () => ({ ok: true }), runManifest: null,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PARTIAL shard output; the aggregate ratchet has not run/);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.result, "partial");
  assert.equal(report.suite_result, "pass");
  assert.equal(report.engine_coverage.shard_partial, true);
  assert.equal(report.engine_coverage.measurement, null);
  assert.equal(report.engine_coverage.ratchet, null);
  assert.deepEqual(report.execution_order, [file]);
  assert.equal(report.results[0].exit_code, 0);
  assert.ok(report.engine_coverage.raw_modules.length > 0, "worker raw coverage is preserved for parent aggregation");
});


test("a terminated shard child records the signal and a failed profile", { skip: process.platform === "win32" }, (t) => {
  const dir = mkTmp("coord-runner-signaled-child-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "terminate.cjs");
  const reportPath = path.join(dir, "report.json");
  fs.writeFileSync(preload, 'if (process.execArgv.includes("--test")) process.kill(process.pid, "SIGTERM");\n');
  const originalOptions = process.env.NODE_OPTIONS;
  const { quoteNodeOption } = require("./test-node-options.js");
  try {
    process.env.NODE_OPTIONS = [originalOptions, `--require ${quoteNodeOption(preload)}`].filter(Boolean).join(" ");
    const result = callRunnerMain(["--shard-child", "--profile-costs", "--module", "core", "--report", reportPath], {
      buildInventory: () => ({ layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
        modules: [{ name: "core", files: ["coord/scripts/file-ticket.test.js"] }] }),
      gitCheck: () => ({ ok: true }), runManifest: null,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "fail");
    assert.equal(report.suite_result, "fail");
    assert.equal(report.results[0].signal, "SIGTERM");
    assert.equal(report.results[0].exit_code, -1);
    assert.equal(report.profile.files[0].exit_code, -1);
    assert.equal(report.totals.pass, 0);
  } finally {
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalOptions;
  }
});

test("COORD-1052: a green provisional shard run persists evidence before cleaning workers", () => {
  const sharding = require("./test-sharding.js");
  const originals = { resolveShardCount: sharding.resolveShardCount, loadTimingSensitiveSuites: sharding.loadTimingSensitiveSuites,
    resolveShardAuthority: sharding.resolveShardAuthority, executeShards: sharding.executeShards,
    cleanupShardWorkers: sharding.cleanupShardWorkers };
  const root = mkTmp("coord1052-runner-shard-green-cleanup-");
  const reportPath = path.join(root, "report.json");
  const file = "coord/engine/scripts/test-runner.test.js";
  const inventory = { layout: "engine", content_root: CONTENT_ROOT, workspace_root: WORKSPACE_ROOT,
    modules: [{ name: "core", files: [file] }] };
  let cleanupArgs = null;
  try {
    sharding.resolveShardCount = () => 1;
    sharding.loadTimingSensitiveSuites = () => [];
    sharding.resolveShardAuthority = () => ({ authoritative: false, reason: "fixture equivalence is pending" });
    sharding.executeShards = () => ({ plan: { shard_count: 1, shards: [{ id: 1, suites: [{ module: "core", path: file }] }] },
      workers: [{ id: 1, result: "pass", exit_code: 0, signal: null, duration_ms: 1, assigned: [file],
        report: { result: "partial", execution_order: [file],
          results: [{ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, failing_tests: [] }],
          governed_tree_violations: [], coverage_source_violations: [] } }], rawModules: [], validationError: null });
    sharding.cleanupShardWorkers = (run, options) => {
      const persisted = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(persisted.result, "provisional");
      assert.equal(persisted.suite_result, "pass");
      cleanupArgs = { run, options };
      return true;
    };
    const result = callRunnerMain(["--shards", "1", "--qualification-stage", "pr", "--policy-stage", "pr",
      "--qualification-mode", "selection", "--module", "core", "--report", reportPath],
    { buildInventory: () => inventory, gitCheck: () => ({ ok: true }), runManifest: null });
    assert.equal(result.status, 2, result.stderr + result.stdout);
    assert.match(result.stdout, /PRE-GATE only; sharded execution is not authorized/);
    assert.match(result.stdout, /execution=PASS qualification=PROVISIONAL/);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.result, "provisional");
    assert.equal(report.suite_result, "pass");
    assert.equal(report.shards[0].result, "pass");
    assert.deepEqual(cleanupArgs?.options, { reportPersisted: true, allGreen: true, censusObserver: null },
      "worker artifacts are cleaned only after a persisted, fully green provisional run");
  } finally {
    Object.assign(sharding, originals);
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("sharded native coverage stays provisional and preserves incomplete evidence", { skip: nativeCoverageUnsupported }, (t) => {
  const fixture = runnerObserverFixture(t);
  const { repoRoot, evidence, options } = fixture;
  const [file] = options.buildInventory().modules[0].files;
  const contentRoot = path.join(repoRoot, "coord");
  const writeFixtureTest = (flag, expected) => fs.writeFileSync(path.join(repoRoot, file), [
    "const test = require('node:test'), assert = require('node:assert/strict');",
    "const subject = require('./observer-subject.js');",
    `test('native coverage fixture', () => assert.equal(subject(${flag}), ${JSON.stringify(expected)}));`,
  ].join("\n"));
  writeFixtureTest(true, "yes");
  const baseline = callRunnerMain(["--write-coverage-baseline", "--report", path.join(evidence, "baseline.json")], options);
  assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
  const baselineFile = runner.coverageBaselinePathForNode(contentRoot);
  const baselineBytes = fs.readFileSync(baselineFile);

  const sharding = require("./test-sharding.js");
  t.mock.method(sharding, "loadTimingSensitiveSuites", () => []);
  t.mock.method(sharding, "executeShards", ({ outDir }) => {
    const childPath = path.join(outDir, "child.json");
    const child = callRunnerMain(["--shard-child", "--engine-coverage", "--module", "core", "--report", childPath], {
      ...options, runManifest: null,
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const report = JSON.parse(fs.readFileSync(childPath, "utf8"));
    const rawModules = report.engine_coverage.raw_modules;
    for (const artifact of rawModules) {
      t.after(() => fs.rmSync(artifact.rawDirectory, { recursive: true, force: true }));
    }
    const resultsPath = path.join(outDir, "results.json");
    fs.writeFileSync(resultsPath, JSON.stringify({ results: [{ id: 1, report }] }));
    return {
      resultsPath, rawModules, validationError: null,
      plan: { shard_count: 1, shards: [{ id: 1, suites: [{ module: "core", path: file }] }] },
      workers: [{ id: 1, result: "pass", exit_code: 0, assigned: [file], workspace: repoRoot, report_path: childPath, report }],
    };
  });
  const cleanup = t.mock.method(sharding, "cleanupShardWorkers", (_run, opts) => {
    assert.deepEqual(opts, { reportPersisted: true, allGreen: true, censusObserver: null });
    assert.ok(fs.existsSync(fixture.reportPath));
  });

  const args = ["--shards", "1", "--engine-coverage", "--qualification-mode", "full",
    "--qualification-stage", "pr", "--policy-stage", "pr", "--report", fixture.reportPath];
  for (const artifactComplete of [true, false]) {
    const result = callRunnerMain(args, artifactComplete ? options : { ...options, runManifest: null });
    assert.equal(result.status, artifactComplete ? 2 : 1, result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.engine_coverage.ratchet.result, "pass");
    assert.equal(report.suite_result, "pass");
    assert.equal(report.result, "provisional");
    assert.equal(report.gate_artifact_validation.complete, artifactComplete);
    assert.deepEqual(report.gate_artifact_validation.missing, artifactComplete ? [] : ["run_manifest"]);
    assert.match(result.stdout, /PRE-GATE only.*donor governance receipt is required/);
  }
  writeFixtureTest(false, "no");
  const failed = callRunnerMain(args, options);
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
  assert.equal(report.suite_result, "pass");
  assert.equal(report.result, "fail");
  assert.equal(report.engine_coverage.ratchet.result, "fail");
  assert.ok(report.engine_coverage.ratchet.new_uncovered.some(({ file: source }) => source.endsWith("/observer-subject.js")));
  assert.doesNotMatch(failed.stdout, /PRE-GATE only/);
  assert.equal(cleanup.mock.callCount(), 2, "the failing run preserves its worker evidence");
  assert.deepEqual(fs.readFileSync(baselineFile), baselineBytes);
});

test("COORD-1052: cost probe preserves execFileSync and asynchronous spawn results", async (t) => {
  const root = mkTmp("coord1052-cost-probe-api-coverage-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "cost.jsonl");
  const code = `
    const cp = require('node:child_process');
    const exec = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("exec-output")'], { encoding: 'utf8' });
    const child = cp.spawn(process.execPath, ['-e', 'process.stdout.write("spawn-output")'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.once('close', status => process.stdout.write(JSON.stringify({ exec, stdout, status })));
  `;
  const child = spawnSync(process.execPath, ["--require", PROBE, "-e", code], {
    encoding: "utf8", env: { ...process.env, COORD_TEST_COST_LOG: log }, timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { exec: "exec-output", stdout: "spawn-output", status: 0 });
  const records = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => [path.basename(record.cmd), record.status]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [[path.basename(process.execPath), null], [path.basename(process.execPath), 0]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
  assert.ok(records.every((record) => record.ms >= 0 && Array.isArray(record.args)));
});

test("coverage disk preflight checks scratch and shard output before running tests", { skip: nativeCoverageUnsupported }, (t) => {
  const fixture = runnerObserverFixture(t);
  const cutoff = "COORD_COVERAGE_MIN_FREE_GIB";
  const original = process.env[cutoff];
  delete process.env[cutoff];
  t.after(() => {
    if (original === undefined) delete process.env[cutoff];
    else process.env[cutoff] = original;
  });
  const reportDir = path.dirname(fixture.reportPath);
  const temp = path.resolve(os.tmpdir());
  const destination = path.join(reportDir, "nested", "runner.json");
  let lowDirectory = temp;
  let unreadableDirectory;
  const seen = [];
  t.mock.method(fs, "statfsSync", (directory, options) => {
    assert.equal(options.bigint, true);
    seen.push(directory);
    if (directory === unreadableDirectory) throw Object.assign(new Error("mount is unreadable"), { code: "EACCES" });
    if (directory === path.dirname(destination)) throw Object.assign(new Error("not created yet"), { code: "ENOENT" });
    const gib = directory === lowDirectory ? 4n : 100n;
    return { bsize: 4096n, bavail: gib * (1024n ** 3n / 4096n), bfree: 1000n };
  });

  const serial = callRunnerMain(["--engine-coverage", "--report", destination], fixture.options);
  assert.equal(serial.status, 2);
  assert.match(serial.stderr, /insufficient free disk space for coverage.*4\.0 GiB available, 8 GiB required/);
  assert.deepEqual(seen, [temp]);
  assert.doesNotMatch(serial.stdout, /authoritative governance test run/);

  seen.length = 0;
  lowDirectory = reportDir;
  const lowReport = callRunnerMain(["--engine-coverage", "--report", destination], fixture.options);
  assert.equal(lowReport.status, 2);
  assert.ok(lowReport.stderr.includes(path.dirname(destination)), lowReport.stderr);
  assert.match(lowReport.stderr, /4\.0 GiB available, 8 GiB required/);

  const sharded = callRunnerMain(["--engine-coverage", "--shards", "2", "--qualification-stage", "pr",
    "--policy-stage", "pr", "--qualification-mode", "full", "--report", destination], fixture.options);
  assert.equal(sharded.status, 2);
  assert.ok(sharded.stderr.includes(path.dirname(destination)), sharded.stderr);
  assert.match(sharded.stderr, /4\.0 GiB available, 32 GiB required/);
  assert.deepEqual(seen.slice(-2), [path.dirname(destination), reportDir]);
  assert.equal(fs.existsSync(path.dirname(destination)), false);
  assert.doesNotMatch(sharded.stdout, /authoritative governance test run/);

  lowDirectory = fixture.outputRoot;
  const census = callRunnerMain([...observerReleaseArgs(fixture.descriptorPath), "--report", destination], fixture.options);
  assert.equal(census.status, 2);
  assert.ok(census.stderr.includes(fixture.outputRoot), census.stderr);
  assert.deepEqual(fs.readdirSync(fixture.outputRoot), []);

  const { coverageSpaceError } = require("./coverage-aggregate.js");
  process.env[cutoff] = "4";
  assert.equal(coverageSpaceError([reportDir], { sharded: true }), null, "the configured boundary is inclusive");
  unreadableDirectory = reportDir;
  assert.match(coverageSpaceError([reportDir]), /cannot check free disk space.*mount is unreadable/);
  process.env[cutoff] = "zero";
  assert.match(coverageSpaceError([reportDir]), /must be a positive integer/);
});
