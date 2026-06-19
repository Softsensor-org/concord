"use strict";

// Wave 2 (COORD-057): runtime-cleanup tests relocated out of the governance.test.js
// monolith into a module-owned file. They exercise the runtime lock status/break,
// rollback-drift, and clean-runtime behavior via the governance __testing surface.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { __testing, GovernanceError, withCleanRuntimeFixture } = require("./governance-test-utils.js");

test("describeDirectoryLockHolder reports pid liveness and age for runtime lock diagnostics", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-lock-holder-"));
  const lockDir = path.join(tempDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    cwd: "/tmp/gov-holder",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  const description = __testing.describeDirectoryLockHolder(lockDir);
  assert.match(description, /governance-runtime/);
  assert.match(description, /owner_alive=no/);
  assert.match(description, /cwd=\/tmp\/gov-holder/);
  assert.match(description, /age_ms=/);
});

test("runtimeLockStatus reports a wedged governance lock without mutating it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-runtime-lock-status-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    cwd: "/tmp/runtime-lock-status",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  const originalRuntimeDir = __testing.paths.RUNTIME_DIR;
  const originalLockDir = __testing.paths.GOVERNANCE_EVENT_LOCK_DIR;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;

  const originalLog = console.log;
  let output = "";
  console.log = (value) => {
    output += `${String(value)}\n`;
  };
  try {
    __testing.runtimeLockStatus();
    const payload = JSON.parse(output.trim());
    assert.equal(payload.exists, true);
    assert.equal(payload.reclaimable_now, true);
    assert.match(payload.description, /owner_alive=no/);
    assert.equal(fs.existsSync(lockDir), true);
  } finally {
    console.log = originalLog;
    __testing.paths.RUNTIME_DIR = originalRuntimeDir;
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = originalLockDir;
  }
});

test("breakRuntimeLock removes the runtime lock directory only with explicit yes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-runtime-lock-break-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: 999999,
    cwd: "/tmp/runtime-lock-break",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  const originalLockDir = __testing.paths.GOVERNANCE_EVENT_LOCK_DIR;
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = lockDir;
  try {
    assert.throws(
      () => __testing.breakRuntimeLock({}),
      (error) => error instanceof GovernanceError && /destructive; rerun with --yes/i.test(error.message)
    );
    assert.equal(fs.existsSync(lockDir), true);
    __testing.breakRuntimeLock({ yes: true });
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = originalLockDir;
  }
});

test("detectRollbackDrift reports no drift when journal is empty and git/remote absent", () => {
  withCleanRuntimeFixture(() => {
    const result = __testing.detectRollbackDrift();
    assert.equal(result.drift, false);
    assert.deepEqual(result.reasons, []);
  });
});

test("detectRollbackDrift flags a journal newer than the tracked board snapshot", () => {
  withCleanRuntimeFixture(({ eventLogPath }) => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      eventLogPath,
      JSON.stringify({ ts: future, command: "land", ticket: "B-001" }) + "\n",
      "utf8"
    );
    const result = __testing.detectRollbackDrift();
    assert.equal(result.drift, true);
    assert.ok(
      result.reasons.some((reason) => /predates the governance journal/.test(reason)),
      `expected journal-newer reason, got ${JSON.stringify(result.reasons)}`
    );
  });
});

test("detectRollbackDrift never throws when git binary / remote are unavailable", () => {
  withCleanRuntimeFixture(() => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      assert.doesNotThrow(() => {
        const result = __testing.detectRollbackDrift();
        assert.equal(typeof result.drift, "boolean");
        assert.ok(Array.isArray(result.reasons));
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test("collectCleanRuntimeTargets protects ticket-local + runtime state and only lists safe scratch", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const { candidates, protected: protectedPaths } = __testing.collectCleanRuntimeTargets();
    const candidatePaths = candidates.map((entry) => entry.path).sort();
    assert.deepEqual(candidatePaths, [
      path.join(runtimeDir, "stale.tmp"),
      path.join(runtimeDir, "tmp-render"),
    ]);
    const protectedSet = new Set(protectedPaths.map((entry) => entry.path));
    assert.ok(protectedSet.has(path.join(runtimeDir, "plans")));
    assert.ok(protectedSet.has(path.join(runtimeDir, "locks")));
    assert.ok(protectedSet.has(path.join(runtimeDir, "session-threads")));
    assert.ok(protectedSet.has(path.join(runtimeDir, "governance-events.ndjson")));
    assert.ok(protectedSet.has(path.join(runtimeDir, "governance-latest-snapshot.json")));
  });
});

test("collectCleanRuntimeTargets only opts plans/ in with --include-ticket-state", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const opted = __testing.collectCleanRuntimeTargets({ includeTicketState: true });
    const optedCandidates = opted.candidates.map((entry) => entry.path);
    assert.ok(optedCandidates.includes(path.join(runtimeDir, "plans")));
    // locks/ stays protected even with the override.
    const optedProtected = new Set(opted.protected.map((entry) => entry.path));
    assert.ok(optedProtected.has(path.join(runtimeDir, "locks")));
  });
});

test("cleanRuntime dry-run lists candidates and deletes nothing", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const summary = __testing.cleanRuntime({});
    assert.equal(summary.applied, false);
    assert.equal(summary.removed.length, 0);
    assert.equal(summary.candidates.length, 2);
    assert.ok(fs.existsSync(path.join(runtimeDir, "tmp-render")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "stale.tmp")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "plans", "B-001.json")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "locks", "B-001.json")));
  });
});

test("cleanRuntime --yes removes only safe scratch and never protected paths", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const summary = __testing.cleanRuntime({ yes: true });
    assert.equal(summary.applied, true);
    assert.equal(summary.removed.length, 2);
    assert.ok(!fs.existsSync(path.join(runtimeDir, "tmp-render")));
    assert.ok(!fs.existsSync(path.join(runtimeDir, "stale.tmp")));
    // Protected ticket-local / runtime state survives --yes.
    assert.ok(fs.existsSync(path.join(runtimeDir, "plans", "B-001.json")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "locks", "B-001.json")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "session-threads")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "governance-events.ndjson")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "governance-latest-snapshot.json")));
  });
});

test("cleanRuntime --include-ticket-state --yes also removes plans/ but keeps locks/", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    __testing.cleanRuntime({ yes: true, includeTicketState: true });
    assert.ok(!fs.existsSync(path.join(runtimeDir, "plans")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "locks", "B-001.json")));
  });
});

test("cleanRuntime refuses on simulated rollback drift without --force", () => {
  withCleanRuntimeFixture(({ runtimeDir, eventLogPath }) => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      eventLogPath,
      JSON.stringify({ ts: future, command: "land", ticket: "B-001" }) + "\n",
      "utf8"
    );
    assert.throws(
      () => __testing.cleanRuntime({ yes: true }),
      /clean-runtime refused: rollback drift detected/
    );
    // Nothing deleted on a refused run.
    assert.ok(fs.existsSync(path.join(runtimeDir, "tmp-render")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "stale.tmp")));

    // --force overrides and proceeds with the safe deletion.
    const forced = __testing.cleanRuntime({ yes: true, force: true });
    assert.equal(forced.forced, true);
    assert.equal(forced.removed.length, 2);
    assert.ok(!fs.existsSync(path.join(runtimeDir, "tmp-render")));
  });
});
