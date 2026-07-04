"use strict";

// COORD-077 (QGATE-003): test-coverage threshold-policy tests.
// Pure-policy + Node test-coverage report parsing + CLI behavior, plus template
// gate.sh runner integration. No board/runtime side effects (temp fixtures only).

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  METRICS,
  DEFAULT_COVERAGE_MIN,
  COVERAGE_WARN_BAND,
  parseCoverageReport,
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
// coord/scripts/coverage-policy.js) and exercise the real gate.sh coverage
// branch. Proves: coverage absent on default; runs on full; artifact written
// under coord/artifacts/gates/<repo>/; threshold is config-driven via
// GATE_COVERAGE_MIN (a high min fails; a low min passes); graceful skip (warn,
// gate stays green) when there are no tests. Never touches the live repo/board.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function buildGateSandbox(repo, { withTests = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord077-gate-${repo}-`));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, repo), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, "coord", "scripts", "coverage-policy.js"));
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

function runGate(sandbox, lane, { env, timeoutMs } = {}) {
  // Strip the node:test worker context so the gate's nested `node --test` runs
  // for real instead of refusing to recurse (a harness-only artifact — gate.sh
  // is normally invoked standalone via bash, not nested under a test runner).
  const childEnv = {
    ...process.env,
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

// COORD-129 PROOF: a gate whose grandchild sleeps effectively forever must be
// killed (whole process group) within a SHORT injected bound — proving the
// process-group SIGKILL terminates a hung grandchild and runGate NEVER blocks.
test("gate.sh: a hung grandchild is killed (process group) within the bound — runGate never blocks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord129cov-hang-"));
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
    const t0 = Date.now();
    const r = await runGate(sandbox, "full", { timeoutMs: 1500 });
    const elapsed = Date.now() - t0;
    assert.equal(r.timedOut, true, "hung grandchild must trip the timeout (timedOut)");
    assert.ok(elapsed < 8000, `runGate must return promptly after the kill, took ${elapsed}ms`);
    assert.equal(r.bound, 1500);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
