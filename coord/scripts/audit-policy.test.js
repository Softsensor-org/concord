"use strict";

// COORD-076 (QGATE-002): dependency/security audit threshold-policy tests.
// Pure-policy + npm-audit parsing + CLI behavior. No board/runtime side effects.

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SEVERITY_ORDER,
  DEFAULT_AUDIT_THRESHOLD,
  parseAuditCounts,
  classifyAudit,
  formatAuditSummary,
  runCli,
} = require("./audit-policy.js");

const CLI = path.join(__dirname, "audit-policy.js");

test("DEFAULT_AUDIT_THRESHOLD is high and severity ladder ascends", () => {
  assert.equal(DEFAULT_AUDIT_THRESHOLD, "high");
  assert.deepEqual(SEVERITY_ORDER, ["info", "low", "moderate", "high", "critical"]);
});

test("parseAuditCounts reads modern npm-audit metadata.vulnerabilities shape", () => {
  const counts = parseAuditCounts({
    metadata: { vulnerabilities: { info: 0, low: 2, moderate: 1, high: 1, critical: 0, total: 4 } },
  });
  assert.equal(counts.high, 1);
  assert.equal(counts.low, 2);
  assert.equal(counts.total, 4);
});

test("parseAuditCounts 0-fills missing severities and derives total", () => {
  const counts = parseAuditCounts({ metadata: { vulnerabilities: { high: 2 } } });
  assert.equal(counts.high, 2);
  assert.equal(counts.critical, 0);
  assert.equal(counts.info, 0);
  assert.equal(counts.total, 2);
});

test("parseAuditCounts handles a bare counts object and empty input", () => {
  assert.equal(parseAuditCounts({ moderate: 3 }).moderate, 3);
  assert.equal(parseAuditCounts({}).total, 0);
  assert.equal(parseAuditCounts(null).total, 0);
});

test("classifyAudit: no vulns => pass", () => {
  const c = classifyAudit({ counts: parseAuditCounts({}), threshold: "high" });
  assert.equal(c.result, "pass");
  assert.equal(c.total, 0);
  assert.equal(c.highestSeverity, null);
});

test("classifyAudit: high vuln at threshold=high => fail (blocking)", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { high: 1, total: 1 } } }),
    threshold: "high",
  });
  assert.equal(c.result, "fail");
  assert.equal(c.blocking, 1);
  assert.equal(c.highestSeverity, "high");
});

test("classifyAudit: critical vuln always fails at threshold=high", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { critical: 1, total: 1 } } }),
    threshold: "high",
  });
  assert.equal(c.result, "fail");
  assert.equal(c.highestSeverity, "critical");
});

test("classifyAudit: moderate-only at threshold=high => warn (below threshold)", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { moderate: 2, total: 2 } } }),
    threshold: "high",
  });
  assert.equal(c.result, "warn");
  assert.equal(c.blocking, 0);
  assert.equal(c.highestSeverity, "moderate");
});

test("classifyAudit: threshold is configurable — moderate threshold fails on moderate", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { moderate: 1, total: 1 } } }),
    threshold: "moderate",
  });
  assert.equal(c.result, "fail");
  assert.equal(c.blocking, 1);
});

test("classifyAudit: critical threshold lets a high vuln only warn", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { high: 1, total: 1 } } }),
    threshold: "critical",
  });
  assert.equal(c.result, "warn");
});

test("classifyAudit: unknown threshold falls back to the default", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { high: 1, total: 1 } } }),
    threshold: "bogus",
  });
  assert.equal(c.threshold, DEFAULT_AUDIT_THRESHOLD);
  assert.equal(c.result, "fail");
});

test("formatAuditSummary is a grep-friendly one-liner with per-severity counts", () => {
  const c = classifyAudit({
    counts: parseAuditCounts({ metadata: { vulnerabilities: { high: 1, moderate: 1, low: 1, total: 3 } } }),
    threshold: "high",
  });
  const s = formatAuditSummary(c);
  assert.match(s, /^audit: fail threshold=high total=3 /);
  assert.match(s, /high=1/);
  assert.match(s, /moderate=1/);
  assert.match(s, /blocking=1/);
});

test("runCli classify: high vuln returns exit 1 and prints fail summary", () => {
  const chunks = [];
  const rc = runCli(["classify", "--threshold", "high"], {
    stdin: JSON.stringify({ metadata: { vulnerabilities: { high: 1, total: 1 } } }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 1);
  assert.match(chunks.join(""), /audit: fail/);
});

test("runCli classify: moderate-only at high threshold returns exit 0 (warn)", () => {
  const chunks = [];
  const rc = runCli(["classify"], {
    stdin: JSON.stringify({ metadata: { vulnerabilities: { moderate: 1, total: 1 } } }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0);
  assert.match(chunks.join(""), /audit: warn/);
});

test("runCli: bad subcommand and unparseable JSON return usage/parse error (2)", () => {
  assert.equal(runCli(["nope"], { stdout: { write: () => {} }, stderr: { write: () => {} } }), 2);
  assert.equal(
    runCli(["classify"], { stdin: "{not json", stdout: { write: () => {} }, stderr: { write: () => {} } }),
    2
  );
});

test("audit-policy CLI classify path fails on a critical vulnerability", () => {
  const chunks = [];
  const rc = runCli(["classify", "--threshold", "high"], {
    stdin: JSON.stringify({ metadata: { vulnerabilities: { critical: 1, total: 1 } } }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 1, "critical vuln must exit non-zero");
  assert.match(chunks.join(""), /audit: fail threshold=high/);
});

test("audit-policy CLI classify path exits 0 (pass) on clean audit JSON", () => {
  const chunks = [];
  const rc = runCli(["classify"], {
    stdin: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }),
    stdout: { write: (s) => chunks.push(s) },
    stderr: { write: () => {} },
  });
  assert.equal(rc, 0);
  assert.match(chunks.join(""), /audit: pass/);
});

// --- Template gate.sh runner integration (COORD-076) -----------------------
// Build a throwaway sandbox that mirrors the template layout (repo dir alongside
// coord/scripts/audit-policy.js) and exercise the real gate.sh audit branch with
// a stub `npm` on PATH. Proves: audit absent on default; graceful skip with no
// lockfile; fail on a high vuln at the default threshold; warn (gate passes) for
// a sub-threshold vuln; config-driven threshold via GATE_AUDIT_THRESHOLD. Never
// touches the live repo or board.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function buildGateSandbox(repo, npmAuditBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord076-gate-${repo}-`));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, repo), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, "coord", "scripts", "audit-policy.js"));
  // Copy the real template repo tree so the pre-audit steps pass.
  fs.cpSync(path.join(REPO_ROOT, repo, "scripts"), path.join(root, repo, "scripts"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, repo, "src"), path.join(root, repo, "src"), { recursive: true });
  const repoTests = path.join(REPO_ROOT, repo, "tests");
  if (fs.existsSync(repoTests)) {
    fs.cpSync(repoTests, path.join(root, repo, "tests"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(root, repo, "tests"), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO_ROOT, repo, "package.json"), path.join(root, repo, "package.json"));
  // Stub npm on PATH (only used when a lockfile is present).
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/usr/bin/env bash\nif [ "$1" = "audit" ]; then cat <<'JSON'\n${npmAuditBody}\nJSON\n  exit 1\nfi\nexit 0\n`,
    { mode: 0o755 }
  );
  return { root, binDir, gateScript: path.join(root, repo, "scripts", "gate.sh") };
}

// COORD-129: every gate subprocess is bounded AND the WHOLE process tree is
// killed on timeout. COORD-122 used spawnSync({timeout}), but the `full` lane
// runs `node --test` GRANDCHILDREN under `bash gate.sh`; spawnSync's timeout
// only SIGTERMs the direct `bash` child. A surviving `node` grandchild keeps
// the inherited stdout pipe open, so spawnSync blocks reading that pipe
// indefinitely — the timeout never fires and the suite hangs forever.
//
// The fix: spawn `bash` with { detached: true } so it becomes a process-GROUP
// LEADER (its PGID == its PID). On timeout we `process.kill(-child.pid,
// "SIGKILL")` — the NEGATIVE pid signals the entire group, killing `bash` AND
// the `node`/`npm` grandchildren, which releases the pipe so the runner
// resolves immediately. A timeout surfaces as a clear, fast test FAILURE
// (timedOut === true), never a hang.
//
// The audit lane is also forced offline (GATE_AUDIT_OFFLINE=1 +
// npm_config_offline) so the synthetic-audit tests can NEVER touch the network
// — gate.sh runs `npm audit --offline` and the stub npm reads the injected
// fixture. (Defense in depth — the process-group kill is the real guarantee.)
const GATE_SPAWN_TIMEOUT_MS = 60000;

function runGate(sandbox, lane, { withLockfile, env, timeoutMs } = {}) {
  const repoDir = path.dirname(path.dirname(sandbox.gateScript));
  if (withLockfile) fs.writeFileSync(path.join(repoDir, "package-lock.json"), "{}\n");
  const bound = timeoutMs || GATE_SPAWN_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn("bash", [sandbox.gateScript, lane], {
      detached: true, // own process group → negative-pid kill reaches grandchildren
      env: {
        ...process.env,
        PATH: `${sandbox.binDir}:${process.env.PATH}`,
        GATE_AUDIT_OFFLINE: "1",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        ...(env || {}),
      },
    });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the whole process group: kills bash AND the node/npm
      // grandchildren, releasing the inherited stdout pipe so we never block.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, bound);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, timedOut, bound });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, out: `${out}\n${err}`, timedOut, bound });
    });
  });
}

// Asserts the gate did not blow past its bound. A process-group SIGKILL on a
// hung grandchild surfaces here as a clear, fast FAILURE — never a hang.
function assertNotTimedOut(r, lane, repo) {
  assert.ok(
    !r.timedOut,
    `gate.sh ${lane} (${repo}) exceeded ${r.bound}ms and its process group was killed (SIGKILL) — possible network/registry/grandchild hang`
  );
}

for (const repo of ["backend", "frontend"]) {
  test(`gate.sh (${repo}): audit step is absent on the default lane`, async () => {
    const sb = buildGateSandbox(repo, '{"metadata":{"vulnerabilities":{"high":1,"total":1}}}');
    try {
      const r = await runGate(sb, "default", { withLockfile: true });
      assertNotTimedOut(r, "default", repo);
      assert.equal(r.status, 0, r.out);
      assert.doesNotMatch(r.out, /dependency audit/);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane degrades gracefully when no lockfile`, async () => {
    const sb = buildGateSandbox(repo, '{"metadata":{"vulnerabilities":{"high":1,"total":1}}}');
    try {
      const r = await runGate(sb, "full", { withLockfile: false });
      assertNotTimedOut(r, "full", repo);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /dependency audit/);
      assert.match(r.out, /SKIP: no npm lockfile/);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane FAILS on a high vuln at the default threshold`, async () => {
    const sb = buildGateSandbox(repo, '{"metadata":{"vulnerabilities":{"high":1,"moderate":1,"total":2}}}');
    try {
      const r = await runGate(sb, "full", { withLockfile: true });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /audit: fail threshold=high/);
      assert.match(r.out, /AUDIT FAILED/);
      assert.notEqual(r.status, 0, "gate must fail on a blocking vuln");
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane WARNS (passes) on a sub-threshold vuln`, async () => {
    const sb = buildGateSandbox(repo, '{"metadata":{"vulnerabilities":{"moderate":2,"total":2}}}');
    try {
      const r = await runGate(sb, "full", { withLockfile: true });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /audit: warn threshold=high/);
      assert.equal(r.status, 0, r.out);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): GATE_AUDIT_THRESHOLD is config-driven (critical lets a high vuln pass)`, async () => {
    const sb = buildGateSandbox(repo, '{"metadata":{"vulnerabilities":{"high":1,"total":1}}}');
    try {
      const r = await runGate(sb, "full", { withLockfile: true, env: { GATE_AUDIT_THRESHOLD: "critical" } });
      assertNotTimedOut(r, "full", repo);
      assert.match(r.out, /audit: warn threshold=critical/);
      assert.equal(r.status, 0, r.out);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
}

// COORD-129 PROOF: a gate whose grandchild sleeps effectively forever must be
// killed (whole process group) within a SHORT injected bound — proving the
// process-group SIGKILL terminates a hung grandchild and runGate NEVER blocks.
// This is exactly the failure mode spawnSync({timeout}) could not handle: the
// SIGTERM-to-bash-only left the node grandchild holding the stdout pipe.
test("gate.sh: a hung grandchild is killed (process group) within the bound — runGate never blocks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord129-hang-"));
  try {
    const repoDir = path.join(root, "backend", "scripts");
    fs.mkdirSync(repoDir, { recursive: true });
    // A stub gate.sh that backgrounds a never-exiting node grandchild whose
    // stdout is inherited — i.e. it holds the pipe open exactly like a stalled
    // `node --test`. Without a process-GROUP kill this would hang forever.
    const gateScript = path.join(repoDir, "gate.sh");
    fs.writeFileSync(
      gateScript,
      '#!/usr/bin/env bash\n' +
        'echo "stub gate starting"\n' +
        // grandchild that never exits and keeps stdout open:
        'node -e "setInterval(()=>{},1e9)" &\n' +
        'wait\n',
      { mode: 0o755 }
    );
    const sandbox = { root, binDir: root, gateScript };
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
