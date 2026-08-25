"use strict";

// COORD-480 contract tests for the ONE authoritative test entrypoint.
// These lock the execution contract itself: root normalization, recursive
// deterministic discovery (a nested suite cannot dodge the inventory), serial
// identity-free execution, isolation-guard preloading, machine-readable
// inventory/summary, and the single-entrypoint wiring of npm / PR CI /
// public-cut hygiene / binary verification.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runner = require("./test-runner.js");

const CONTENT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.dirname(CONTENT_ROOT);
const RUNNER_PATH = path.join(CONTENT_ROOT, "scripts", "test-runner.js");

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

// --- root normalization ------------------------------------------------------

test("test root is resolved from the runner's own location, not the caller cwd", () => {
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
  assert.equal(
    runner.classifyContentTest("scripts/enterprise/deploy/x.test.js"),
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

// --- packed-artifact layout ---------------------------------------------------

test("a packed artifact (content root == package root) still resolves and discovers", () => {
  const packed = mkTmp("coord480-packed-");
  try {
    fs.mkdirSync(path.join(packed, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(packed, "board"), { recursive: true });
    fs.writeFileSync(path.join(packed, "scripts", "x.test.js"), "");
    fs.writeFileSync(path.join(packed, "board", "board.test.js"), "");
    const inv = runner.buildInventory({ contentRoot: packed });
    assert.equal(inv.workspace_root, packed);
    assert.equal(inv.layout, "engine");
    const all = inv.modules.flatMap((m) => m.files);
    assert.ok(all.includes("scripts/x.test.js"));
    assert.ok(all.includes("board/board.test.js"));
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
  assert.equal(guard, path.join(CONTENT_ROOT, "scripts", "test-isolation-guard.js"));
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

test("module output streams live (the runner does not buffer a long module)", () => {
  // spawnSync with stdio:"inherit" is what makes a 20-minute module visible in
  // CI as it runs; the machine-readable half comes from the TAP side-channel.
  const src = fs.readFileSync(RUNNER_PATH, "utf8");
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
    path.join(CONTENT_ROOT, "scripts", "governance-session.js"),
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
  const missing = [...declared].filter((n) => !runner.STRIPPED_ENV_VARS.includes(n));
  assert.deepEqual(
    missing,
    [],
    `provider identity variables missing from STRIPPED_ENV_VARS: ${missing}`
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
    "coord/scripts/test-runner.js",
    "coord/scripts/test-runner.test.js",
    "coord/scripts/test-isolation-guard.js",
    "coord/scripts/test-isolation-guard.test.js",
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
