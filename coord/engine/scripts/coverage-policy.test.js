"use strict";

// COORD-077 (QGATE-003): test-coverage threshold-policy tests.
// Pure-policy + Node test-coverage report parsing + CLI behavior, plus template
// gate.sh runner integration. No board/runtime side effects (temp fixtures only).

const test = require("node:test");
const { performance } = require("node:perf_hooks");
const assert = require("node:assert");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  METRICS,
  DEFAULT_COVERAGE_MIN,
  COVERAGE_WARN_BAND,
  NON_PASSING_RESULTS,
  isNonPassing,
  parseCoverageReport,
  parseTestTotal,
  classifyCoverage,
  formatCoverageSummary,
  runCli,
} = require("./coverage-policy.js");

const CLI = path.join(__dirname, "coverage-policy.js");

// A realistic Node `--experimental-test-coverage` summary block (the "all files"
// aggregate row is what the policy reads).
function coverageReport({ lines, branches, functions }) {
  return [
    "ℹ tests 3",
    "ℹ pass 3",
    "ℹ start of coverage report",
    "ℹ ----------------------------------------------------------",
    "ℹ file      | line % | branch % | funcs % | uncovered lines",
    "ℹ ----------------------------------------------------------",
    "ℹ src/m.js  |  90.00 |   80.00 |  100.00 | 12-14",
    "ℹ ----------------------------------------------------------",
    `ℹ all files | ${lines.toFixed(2)} |   ${branches.toFixed(2)} |  ${functions.toFixed(2)} | `,
    "ℹ ----------------------------------------------------------",
    "ℹ end of coverage report",
  ].join("\n");
}

test("DEFAULT_COVERAGE_MIN is 80 and METRICS are line/branch/func", () => {
  assert.equal(DEFAULT_COVERAGE_MIN, 80);
  assert.equal(COVERAGE_WARN_BAND, 0);
  assert.deepEqual(METRICS, ["lines", "branches", "functions"]);
});

test("parseCoverageReport reads the 'all files' aggregate row", () => {
  const m = parseCoverageReport(coverageReport({ lines: 92.31, branches: 85, functions: 100 }));
  assert.equal(m.lines, 92.31);
  assert.equal(m.branches, 85);
  assert.equal(m.functions, 100);
});

test("parseCoverageReport returns null when no coverage report is present", () => {
  assert.equal(parseCoverageReport("ℹ tests 0\nℹ pass 0\n"), null);
  assert.equal(parseCoverageReport(""), null);
  assert.equal(parseCoverageReport(null), null);
});

test("parseCoverageReport tolerates rows without the info marker and clamps range", () => {
  const m = parseCoverageReport("all files | 150.00 | -5.00 | 50.00 |");
  assert.equal(m.lines, 100); // clamped to 100
  assert.equal(m.branches, 0); // clamped to 0
  assert.equal(m.functions, 50);
});

test("parseCoverageReport reads Node 22 TAP-comment coverage rows", () => {
  const m = parseCoverageReport("# all files | 97.67 | 93.02 | 100.00 |");
  assert.deepEqual(m, { lines: 97.67, branches: 93.02, functions: 100 });
});

test("classifyCoverage: all metrics at/above min => pass", () => {
  const c = classifyCoverage({ metrics: { lines: 90, branches: 85, functions: 100 }, threshold: 80 });
  assert.equal(c.result, "pass");
  assert.equal(c.lowest, 85);
  assert.equal(c.available, true);
});

test("classifyCoverage: a metric below min => fail (hard cliff, band=0)", () => {
  const c = classifyCoverage({ metrics: { lines: 90, branches: 70, functions: 100 }, threshold: 80 });
  assert.equal(c.result, "fail");
  assert.equal(c.lowest, 70);
});

test("classifyCoverage: exactly at min => pass (>= boundary)", () => {
  const c = classifyCoverage({ metrics: { lines: 80, branches: 80, functions: 80 }, threshold: 80 });
  assert.equal(c.result, "pass");
});

test("classifyCoverage: warn band lets a near-miss warn instead of fail", () => {
  const c = classifyCoverage({ metrics: { lines: 78, branches: 90, functions: 90 }, threshold: 80, warnBand: 5 });
  assert.equal(c.result, "warn");
  assert.equal(c.lowest, 78);
});

test("classifyCoverage: below the warn band still fails", () => {
  const c = classifyCoverage({ metrics: { lines: 60, branches: 90, functions: 90 }, threshold: 80, warnBand: 5 });
  assert.equal(c.result, "fail");
});

test("classifyCoverage: no coverage data => warn (graceful skip, never fail)", () => {
  const c = classifyCoverage({ metrics: {}, threshold: 80 });
  assert.equal(c.result, "warn");
  assert.equal(c.available, false);
  assert.equal(c.lowest, null);
});

// --- COORD-705: absence of measurement must not satisfy a threshold ---------
// Before this ticket every "no coverage data" outcome collapsed into one green
// "warn", so `min=101` — a minimum no real measurement can meet — was reported
// PASS. These cases pin the discriminator (the test-count line) and the new
// non-passing "missing" outcome.

test("COORD-705 parseTestTotal reads the spec-reporter and TAP test-count lines", () => {
  assert.equal(parseTestTotal("ℹ tests 12\nℹ pass 12\n"), 12);
  assert.equal(parseTestTotal("TAP version 13\n1..0\n# tests 0\n# pass 0\n"), 0);
  assert.equal(parseTestTotal("ℹ suites 4\nℹ tests 29\n"), 29);
});

test("COORD-705 parseTestTotal returns null when the run emitted no test count", () => {
  // An empty/aborted nested run: the report carries no summary at all, which is
  // itself evidence that measurement never completed.
  assert.equal(parseTestTotal(""), null);
  assert.equal(parseTestTotal(null), null);
  assert.equal(parseTestTotal("some unrelated stderr noise\n"), null);
  // Must not be fooled by a coverage row or a partial word.
  assert.equal(parseTestTotal("ℹ all files | 90.00 | 90.00 | 90.00 |"), null);
  assert.equal(parseTestTotal("ℹ tests failed 3"), null);
});

test("COORD-705 classifyCoverage: tests ran but no coverage data => missing (NOT passing)", () => {
  const c = classifyCoverage({ metrics: {}, threshold: 101, testsTotal: 29 });
  assert.equal(c.result, "missing");
  assert.equal(c.measured, false);
  assert.equal(c.reason, "measurement-expected-but-absent");
  assert.equal(isNonPassing(c.result), true, "missing must be a non-passing result");
  assert.ok(NON_PASSING_RESULTS.includes("fail"), "fail stays non-passing");
});

test("COORD-705 classifyCoverage: an explicitly requested minimum expects measurement even with no test count", () => {
  // The nested run produced nothing at all — not even a test-count line.
  const expected = classifyCoverage({ metrics: {}, threshold: 80, expectMeasurement: true });
  assert.equal(expected.result, "missing");
  assert.equal(expected.testsTotal, null);
  // Without that signal the historical graceful green is preserved.
  const unexpected = classifyCoverage({ metrics: {}, threshold: 80 });
  assert.equal(unexpected.result, "warn");
  assert.equal(unexpected.reason, "no-coverage-data");
});

test("COORD-705 classifyCoverage: zero tests stays GREEN and is a DISTINCT result from missing", () => {
  const noTests = classifyCoverage({ metrics: {}, threshold: 80, testsTotal: 0, expectMeasurement: true });
  assert.equal(noTests.result, "warn", "a skeleton with no tests must not fail the gate");
  assert.equal(noTests.reason, "no-tests");
  assert.equal(noTests.measured, false);
  const absent = classifyCoverage({ metrics: {}, threshold: 80, testsTotal: 4, expectMeasurement: true });
  assert.notEqual(noTests.result, absent.result, "the two cases must be distinguishable");
  assert.notEqual(formatCoverageSummary(noTests), formatCoverageSummary(absent));
});

test("COORD-705 classifyCoverage: a zero-test suite cannot CLEAR a minimum on its vacuous 100% report", () => {
  // Node emits an all-100% report for an empty suite. Treating that as
  // "measured and met" is the same false green in a different costume.
  const c = classifyCoverage({
    metrics: { lines: 100, branches: 100, functions: 100 },
    threshold: 80,
    testsTotal: 0,
  });
  assert.equal(c.result, "warn");
  assert.equal(c.measured, false, "nothing was measured, so measured must be false");
  assert.equal(c.reason, "no-tests");
});

test("COORD-705 classifyCoverage: a zero-test suite never UPGRADES a real fail (no threshold weakened)", () => {
  const c = classifyCoverage({
    metrics: { lines: 10, branches: 10, functions: 10 },
    threshold: 80,
    testsTotal: 0,
  });
  assert.equal(c.result, "fail", "a below-minimum measurement must stay a fail");
});

test("COORD-705 classifyCoverage: measured-and-met still reports measured=true", () => {
  const c = classifyCoverage({ metrics: { lines: 90, branches: 90, functions: 90 }, threshold: 80, testsTotal: 7 });
  assert.equal(c.result, "pass");
  assert.equal(c.measured, true);
  assert.equal(c.reason, null);
});

test("COORD-705 formatCoverageSummary makes never-measured textually distinct from measured-and-met", () => {
  const met = formatCoverageSummary(
    classifyCoverage({ metrics: { lines: 90, branches: 90, functions: 90 }, threshold: 80, testsTotal: 7 })
  );
  const never = formatCoverageSummary(classifyCoverage({ metrics: {}, threshold: 80, testsTotal: 7 }));
  assert.match(met, /measured=yes/);
  assert.match(never, /^coverage: missing min=80 /);
  assert.match(never, /measured=no/);
  assert.match(never, /reason=measurement-expected-but-absent/);
});

test("COORD-705 runCli: --expect-coverage turns an empty report into a non-zero missing", () => {
  const chunks = [];
  const rc = runCli(["classify", "--min", "101", "--expect-coverage"], {
    stdin: "ℹ tests 29\nℹ pass 29\n",
    stdout: { write: (s2) => chunks.push(s2) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 1, "an impossible minimum must never exit 0 against no data");
  assert.match(chunks.join(""), /coverage: missing min=101/);
});

test("COORD-705 runCli: --expect-coverage still exits 0 for a suite with zero tests", () => {
  const chunks = [];
  const rc = runCli(["classify", "--min", "80", "--expect-coverage"], {
    stdin: "TAP version 13\n1..0\n# tests 0\n# pass 0\n",
    stdout: { write: (s2) => chunks.push(s2) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0, "the graceful zero-test contract is preserved");
  assert.match(chunks.join(""), /coverage: warn .*reason=no-tests/);
});

test("classifyCoverage: threshold is configurable", () => {
  const lowCoverage = { lines: 55, branches: 55, functions: 55 };
  assert.equal(classifyCoverage({ metrics: lowCoverage, threshold: 80 }).result, "fail");
  assert.equal(classifyCoverage({ metrics: lowCoverage, threshold: 50 }).result, "pass");
});

test("formatCoverageSummary is a grep-friendly one-liner with per-metric %", () => {
  const c = classifyCoverage({ metrics: { lines: 92.31, branches: 85, functions: 100 }, threshold: 80 });
  const s = formatCoverageSummary(c);
  assert.match(s, /^coverage: pass min=80 /);
  assert.match(s, /lines=92\.31/);
  assert.match(s, /branches=85\.00/);
  assert.match(s, /functions=100\.00/);
  assert.match(s, /lowest=85\.00/);
});

test("formatCoverageSummary marks the no-data skip case", () => {
  const c = classifyCoverage({ metrics: {}, threshold: 80 });
  const s = formatCoverageSummary(c);
  assert.match(s, /^coverage: warn min=80 \(no coverage data\) lowest=n\/a/);
});

test("runCli classify: below-min report returns exit 1 and prints fail summary", () => {
  const chunks = [];
  const rc = runCli(["classify", "--min", "80"], {
    stdin: coverageReport({ lines: 50, branches: 50, functions: 50 }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 1);
  assert.match(chunks.join(""), /coverage: fail/);
});

test("runCli classify: passing report returns exit 0", () => {
  const chunks = [];
  const rc = runCli(["classify", "--min", "80"], {
    stdin: coverageReport({ lines: 90, branches: 90, functions: 90 }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0);
  assert.match(chunks.join(""), /coverage: pass/);
});

test("runCli classify: empty input warns (graceful skip) and exits 0", () => {
  const chunks = [];
  const rc = runCli(["classify"], {
    stdin: "ℹ tests 0\n",
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0);
  assert.match(chunks.join(""), /coverage: warn .*no coverage data/);
});

test("runCli: bad subcommand returns usage error (2)", () => {
  assert.equal(runCli(["nope"], { stdout: { write: () => {} }, stderr: { write: () => {} } }), 2);
});

test("coverage-policy CLI classify path fails below the minimum", () => {
  const chunks = [];
  const rc = runCli(["classify", "--min", "80"], {
    stdin: coverageReport({ lines: 50, branches: 50, functions: 50 }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 1, "below-min coverage must exit non-zero");
  assert.match(chunks.join(""), /coverage: fail min=80/);
});

test("coverage-policy CLI classify path exits 0 (warn) on no coverage data", () => {
  const chunks = [];
  const rc = runCli(["classify"], {
    stdin: "ℹ tests 0\n",
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0);
  assert.match(chunks.join(""), /coverage: warn/);
});

// --- Template gate.sh runner integration (COORD-077) -----------------------
// Build a throwaway sandbox mirroring the template layout (repo dir alongside
// coord/engine/scripts/coverage-policy.js) and exercise the real gate.sh coverage
// branch. Proves: coverage absent on default; runs on full; artifact written
// under coord/artifacts/gates/<repo>/; threshold is config-driven via
// GATE_COVERAGE_MIN (a high min fails; a low min passes); graceful skip (warn,
// gate stays green) when there are no tests. Never touches the live repo/board.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function buildGateSandbox(repo, { withTests = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord077-gate-${repo}-`));
  fs.mkdirSync(path.join(root, "coord", "engine", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, repo), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, "coord", "engine", "scripts", "coverage-policy.js"));
  // Copy the real template repo tree so the pre-coverage steps pass.
  fs.cpSync(path.join(REPO_ROOT, repo, "scripts"), path.join(root, repo, "scripts"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, repo, "src"), path.join(root, repo, "src"), { recursive: true });
  const repoTests = path.join(REPO_ROOT, repo, "tests");
  fs.mkdirSync(path.join(root, repo, "tests"), { recursive: true });
  if (withTests) {
    if (fs.existsSync(repoTests)) {
      fs.cpSync(repoTests, path.join(root, repo, "tests"), { recursive: true });
    }
    // Guarantee at least one passing test so coverage is emitted.
    fs.writeFileSync(
      path.join(root, repo, "tests", "coord077-cov.test.js"),
      'const t=require("node:test");const a=require("assert");' +
        'const env=require("../src/config/env.js");' +
        't("env module loads",()=>{a.ok(env);});\n'
    );
  }
  fs.copyFileSync(path.join(REPO_ROOT, repo, "package.json"), path.join(root, repo, "package.json"));
  return { root, gateScript: path.join(root, repo, "scripts", "gate.sh"), repo };
}

// COORD-129: every gate subprocess is bounded AND the WHOLE process tree is
// killed on timeout. COORD-122 used spawnSync({timeout}), but the coverage lane
// runs a nested `node --test --experimental-test-coverage` GRANDCHILD under
// `bash gate.sh`; spawnSync's timeout only SIGTERMs the direct `bash` child. A
// surviving `node` grandchild keeps the inherited stdout pipe open, so
// spawnSync blocks reading that pipe indefinitely — the timeout never fires and
// the suite hangs forever.
//
// The fix: spawn `bash` with { detached: true } so it becomes a process-GROUP
// LEADER (its PGID == its PID). On timeout we `process.kill(-child.pid,
// "SIGKILL")` — the NEGATIVE pid signals the entire group, killing `bash` AND
// the `node` grandchildren, releasing the pipe so the runner resolves
// immediately. A timeout surfaces as a clear, fast test FAILURE (timedOut ===
// true), never a hang. GATE_AUDIT_OFFLINE=1 + npm_config_offline keep any audit
// step in the same lane off the network (defense in depth).
const GATE_SPAWN_TIMEOUT_MS = 60000;

// COORD-705(b)(d): gate.sh resolves its nested `node --test
// --experimental-test-coverage` from PATH, NOT from whatever runtime is running
// this suite. That variable went uncontrolled for two sessions and produced four
// contradictory "standalone passes" results. Every gate spawn below therefore
// pins PATH's `node` to `process.execPath`, so running this file under Node
// 22.19 proves the Node 22 release path and running it under Node 25.8 proves
// the Node 25 one — the runtime under test is the runtime being asserted about.
function pinnedNodeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord705-nodebin-"));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}

// A PATH `node` that answers a coverage run with a completed test summary and NO
// coverage report — the observed shape of "the coverage run silently produced
// nothing". Every other invocation (the policy classify, the unit-test step)
// delegates to the real runtime, so only the measurement disappears.
function coverageBlindNodeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord705-blindnode-"));
  fs.writeFileSync(
    path.join(dir, "node"),
    "#!/usr/bin/env bash\n" +
      'for a in "$@"; do\n' +
      '  if [ "$a" = "--experimental-test-coverage" ]; then\n' +
      "    printf 'TAP version 13\\n1..3\\n# tests 3\\n# pass 3\\n# fail 0\\n'\n" +
      "    exit 0\n" +
      "  fi\n" +
      "done\n" +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 }
  );
  return dir;
}

// A PATH `node` whose coverage run fails outright and emits NOTHING — not even a
// test-count line (an unsupported `--experimental-test-coverage`, a crashed
// runner). gate.sh swallows the failure with `|| true`, so the ONLY signal left
// that measurement was expected is the operator's explicit GATE_COVERAGE_MIN,
// which gate.sh forwards as `--expect-coverage`.
function silentlyFailingNodeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord705-silentnode-"));
  fs.writeFileSync(
    path.join(dir, "node"),
    "#!/usr/bin/env bash\n" +
      'for a in "$@"; do\n' +
      '  if [ "$a" = "--experimental-test-coverage" ]; then\n' +
      "    exit 9\n" +
      "  fi\n" +
      "done\n" +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 }
  );
  return dir;
}

function readGateArtifact(sandbox, lane) {
  const p = path.join(sandbox.root, sandbox.repo, "artifacts", "gates", `${lane}.latest.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function runGate(sandbox, lane, { env, timeoutMs, nodeBinDir } = {}) {
  // Strip the node:test worker context so the gate's nested `node --test` runs
  // for real instead of refusing to recurse (a harness-only artifact — gate.sh
  // is normally invoked standalone via bash, not nested under a test runner).
  const binDir = nodeBinDir || pinnedNodeBinDir();
  const childEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    GATE_AUDIT_OFFLINE: "1",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...(env || {}),
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const bound = timeoutMs || GATE_SPAWN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("bash", [sandbox.gateScript, lane], {
      detached: true, // own process group → negative-pid kill reaches grandchildren
      env: childEnv,
    });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills bash AND the node
      // grandchildren, releasing the inherited stdout pipe so we never block.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, timedOut, bound, root: sandbox.root });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, out: `${out}\n${err}`, timedOut, bound, root: sandbox.root });
    });
  });
}

// Asserts the gate did not blow past its bound. A process-group SIGKILL on a
// hung grandchild surfaces here as a clear, fast FAILURE — never a hang.
function assertNotTimedOut(r, lane, repo) {
  assert.ok(
    !r.timedOut,
    `gate.sh ${lane} (${repo}) exceeded ${r.bound}ms and its process group was killed (SIGKILL) — possible grandchild/coverage hang`
  );
}

for (const repo of ["backend", "frontend"]) {
  test(`gate.sh (${repo}): coverage step is absent on the default lane`, async () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = await runGate(sb, "default");
      assertNotTimedOut(r, "default", repo);
      assert.equal(r.status, 0, r.out);
      assert.doesNotMatch(r.out, /test coverage/);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane runs coverage and writes the artifact`, async () => {
    const sb = buildGateSandbox(repo);
    try {
      // min=0 guarantees pass regardless of skeleton coverage level.
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "0" } });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /test coverage/);
      assert.match(r.out, /coverage: (pass|warn) min=0/);
      const artifact = path.join(sb.root, "coord", "artifacts", "gates", repo, "coverage-full.txt");
      assert.ok(fs.existsSync(artifact), `coverage artifact must exist at ${artifact}`);
      assert.match(r.out, /report: .*coverage-full\.txt/);
      assert.equal(r.status, 0, r.out);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): GATE_COVERAGE_MIN is config-driven (impossible min fails the gate)`, async () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "101" } });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /coverage: fail min=101/);
      assert.match(r.out, /COVERAGE FAILED/);
      assert.notEqual(r.status, 0, "gate must fail when coverage is below an impossible min");
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane degrades gracefully (green, never fail) when there are no tests`, async () => {
    const sb = buildGateSandbox(repo, { withTests: false });
    try {
      // With zero tests Node still emits a (vacuous) coverage report, so the
      // step runs but must never FAIL the gate — the graceful contract is
      // "stay green for minimal skeletons", not a specific pass/warn label.
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "80" } });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /test coverage/);
      assert.match(r.out, /coverage: (pass|warn)/);
      assert.doesNotMatch(r.out, /COVERAGE FAILED/);
      assert.equal(r.status, 0, `no tests must not fail the coverage gate: ${r.out}`);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
}

// --- COORD-705 (d): the four-outcome matrix, on whichever runtime runs this ---
// Four outcomes through the REAL gate.sh with the nested `node` pinned to
// process.execPath: (1) coverage present and above the minimum, (2) coverage
// present and below it, (3) coverage EXPECTED and absent, (4) no tests at all.
// Each asserts the outcome on stdout AND in the gate artifact, because an exit
// code alone does not let a consumer reading the artifact tell measured-and-met
// from never-measured.
for (const repo of ["backend", "frontend"]) {
  test(`COORD-705 (${repo}) matrix 1/4: coverage present and above the minimum => measured pass`, async () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "1" } });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /coverage: pass min=1 .*measured=yes/);
      assert.equal(r.status, 0, r.out);
      const a = readGateArtifact(sb, "full");
      assert.equal(a.coverage_status, "pass");
      assert.equal(a.coverage_measured, true);
      assert.equal(a.result, "pass");
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`COORD-705 (${repo}) matrix 2/4: coverage present and below the minimum => measured fail`, async () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "101" } });
      assertNotTimedOut(r, "full", repo);
      // The regression this ticket exists to prevent: an impossible minimum
      // cannot be met by any real measurement, so a PASS here would be proof the
      // threshold was never evaluated against data.
      assert.match(r.out, /coverage: fail min=101 .*measured=yes/);
      assert.match(r.out, /COVERAGE FAILED/);
      assert.notEqual(r.status, 0, r.out);
      const a = readGateArtifact(sb, "full");
      assert.equal(a.coverage_status, "fail");
      assert.equal(a.coverage_measured, true, "the threshold WAS evaluated against real data");
      assert.equal(a.result, "fail");
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`COORD-705 (${repo}) matrix 3/4: coverage EXPECTED and absent => missing, never PASS`, async () => {
    const sb = buildGateSandbox(repo);
    const blind = coverageBlindNodeBinDir();
    try {
      const r = await runGate(sb, "full", {
        env: { GATE_COVERAGE_MIN: "101" },
        nodeBinDir: blind,
      });
      assertNotTimedOut(r, "full", repo);
      assert.doesNotMatch(r.out, /\[gate:full\] PASS/, "absence of measurement must not satisfy a threshold");
      assert.match(r.out, /coverage: missing min=101/);
      assert.match(r.out, /measured=no/);
      assert.match(r.out, /reason=measurement-expected-but-absent/);
      assert.match(r.out, /COVERAGE MISSING/);
      assert.notEqual(r.status, 0, r.out);
      const a = readGateArtifact(sb, "full");
      assert.equal(a.coverage_status, "missing", "the artifact must name the outcome, not just the exit code");
      assert.equal(a.coverage_measured, false);
      assert.equal(a.coverage_reason, "measurement-expected-but-absent");
      assert.equal(a.result, "fail");
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
      fs.rmSync(blind, { recursive: true, force: true });
    }
  });

  test(`COORD-705 (${repo}) matrix 4/4: no tests at all => still GREEN, and distinct from missing`, async () => {
    const sb = buildGateSandbox(repo, { withTests: false });
    try {
      const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "80" } });
      assertNotTimedOut(r, "full", repo);
      assert.equal(r.status, 0, `a skeleton with no tests must not fail the gate: ${r.out}`);
      assert.match(r.out, /\[gate:full\] PASS/);
      assert.doesNotMatch(r.out, /COVERAGE FAILED/);
      assert.doesNotMatch(r.out, /COVERAGE MISSING/);
      assert.match(r.out, /reason=no-tests/);
      const a = readGateArtifact(sb, "full");
      assert.equal(a.result, "pass");
      assert.equal(a.coverage_reason, "no-tests");
      assert.notEqual(a.coverage_status, "missing", "zero-tests must be a DISTINCT result from never-measured");
      assert.equal(
        a.coverage_measured,
        false,
        "a zero-test suite must not claim it measured and met the minimum"
      );
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
}

// COORD-705 (a): the empty-report half of the same false green. When the nested
// coverage run dies without printing anything at all, the report carries no test
// count either — the ONLY remaining evidence that measurement was expected is the
// operator's explicitly configured GATE_COVERAGE_MIN, which gate.sh must forward
// to the policy. Deleting that forwarding must break this test.
test("COORD-705 an explicitly configured GATE_COVERAGE_MIN makes a silent coverage-run failure non-passing", async () => {
  const sb = buildGateSandbox("backend");
  const silent = silentlyFailingNodeBinDir();
  try {
    const r = await runGate(sb, "full", {
      env: { GATE_COVERAGE_MIN: "101" },
      nodeBinDir: silent,
    });
    assertNotTimedOut(r, "full", "backend");
    const report = fs.readFileSync(
      path.join(sb.root, "coord", "artifacts", "gates", "backend", "coverage-full.txt"),
      "utf8"
    );
    assert.equal(parseTestTotal(report), null, "precondition: the report must carry no test count");
    assert.doesNotMatch(r.out, /\[gate:full\] PASS/);
    assert.match(r.out, /coverage: missing min=101 .*tests=unknown/);
    assert.match(r.out, /COVERAGE MISSING/);
    assert.notEqual(r.status, 0, r.out);
    const a = readGateArtifact(sb, "full");
    assert.equal(a.coverage_status, "missing");
    assert.equal(a.coverage_measured, false);
    assert.equal(a.result, "fail");
  } finally {
    fs.rmSync(sb.root, { recursive: true, force: true });
    fs.rmSync(silent, { recursive: true, force: true });
  }
});

// COORD-705 (b): the nested gate run on THIS runtime must actually produce
// coverage the policy can parse and must actually evaluate the threshold against
// it. Run under Node 22.19 this is the Node 22 release-path proof; run under
// Node 25.8 it is the Node 25 one. It fails loudly if a future runtime stops
// emitting a parseable "all files" row — the condition that turned the gate into
// a false green in the first place.
test("COORD-705 the nested gate run on this runtime emits parseable coverage and evaluates the threshold", async () => {
  const sb = buildGateSandbox("backend");
  try {
    const r = await runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "1" } });
    assertNotTimedOut(r, "full", "backend");
    const report = fs.readFileSync(
      path.join(sb.root, "coord", "artifacts", "gates", "backend", "coverage-full.txt"),
      "utf8"
    );
    const parsed = parseCoverageReport(report);
    assert.ok(parsed, `nested ${process.version} run produced no parseable 'all files' row:\n${report}`);
    assert.ok(parseTestTotal(report) > 0, "the nested run must actually have executed tests");
    const a = readGateArtifact(sb, "full");
    assert.equal(a.coverage_measured, true, `${process.version}: threshold was not evaluated against data`);
    assert.equal(a.coverage_status, "pass");
  } finally {
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});

// COORD-129 PROOF: a gate whose grandchild sleeps effectively forever must be
// killed (whole process group) within a SHORT injected bound — proving the
// process-group SIGKILL terminates a hung grandchild and runGate NEVER blocks.
test("gate.sh: a hung grandchild is killed (process group) within the bound — runGate never blocks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord129cov-hang-"));
  const originalWallClock = Date.now;
  try {
    const repoDir = path.join(root, "backend", "scripts");
    fs.mkdirSync(repoDir, { recursive: true });
    const gateScript = path.join(repoDir, "gate.sh");
    fs.writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\n' +
        'echo "stub gate starting"\n' +
        // grandchild that never exits and keeps stdout open (like a stalled
        // `node --test --experimental-test-coverage`):
        'node -e "setInterval(()=>{},1e9)" &\n' +
        'wait\n',
      { mode: 0o755 }
    );
    const sandbox = { root, gateScript, repo: "backend" };
    const t0 = performance.now();
    // COORD-753: elapsed deadlines must survive a forward wall-clock adjustment.
    Date.now = () => originalWallClock() + 60000;
    const r = await runGate(sandbox, "full", { timeoutMs: 1500 });
    const elapsed = performance.now() - t0;
    assert.equal(r.timedOut, true, "hung grandchild must trip the timeout (timedOut)");
    assert.ok(elapsed < 8000, `runGate must return promptly after the kill, took ${elapsed}ms`);
    assert.equal(r.bound, 1500);
  } finally {
    Date.now = originalWallClock;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-810: exercise the shipped gate, not a duplicated coverage command.
// Imported sibling code must execute, but coverage belongs to the gated repo.
for (const lane of ["full", "ci"]) {
  for (const external of [true, false]) {
    test(`COORD-810 frontend ${lane}: ${external ? "sibling import stays outside denominator" : "uncovered frontend import still fails"}`, async () => {
      const sb = buildGateSandbox("frontend", { withTests: false });
      try {
        const location = external ? "coord" : "frontend";
        const modulePath = path.join(sb.root, location, "coord810-boundary.js");
        const unused = Array.from({ length: 40 }, (_, i) =>
          `exports.unused${i} = function () {\n  return ${i};\n};`).join("\n");
        fs.writeFileSync(modulePath, `exports.live = () => 42;\n${unused}\n`);
        // A nested app dependency must not become frontend-owned coverage when
        // Node 24 sees an explicit include pattern.
        const dependency = path.join(sb.root, "frontend", "apps", "demo", "node_modules", "vendor");
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(path.join(dependency, "index.js"), `exports.live = () => 42;\n${unused}\n`);
        fs.writeFileSync(path.join(sb.root, "frontend", "tests", "boundary.test.js"),
          'const test = require("node:test");\n' +
          'const assert = require("node:assert/strict");\n' +
          `const imported = require("${external ? "../../coord" : ".."}/coord810-boundary.js");\n` +
          'const vendor = require("../apps/demo/node_modules/vendor");\n' +
          'test("real imported function executes", () => { assert.equal(imported.live(), 42); assert.equal(vendor.live(), 42); });\n');
        const result = await runGate(sb, lane, { env: { GATE_COVERAGE_MIN: "80" } });
        assertNotTimedOut(result, lane, "frontend");
        const report = fs.readFileSync(path.join(sb.root, "coord", "artifacts", "gates", "frontend", `coverage-${lane}.txt`), "utf8");
        assert.match(report, /real imported function executes/);
        assert.doesNotMatch(report, /node_modules/);
        const artifact = readGateArtifact(sb, lane);
        assert.equal(artifact.coverage_measured, true);
        if (external) {
          assert.equal(result.status, 0, result.out);
          assert.equal(artifact.coverage_status, "pass");
          assert.doesNotMatch(report, /coord810-boundary\.js/);
        } else {
          assert.notEqual(result.status, 0, result.out);
          assert.equal(artifact.coverage_status, "fail");
          assert.match(report, /coord810-boundary\.js/);
        }
      } finally {
        fs.rmSync(sb.root, { recursive: true, force: true });
      }
    });
  }
}
