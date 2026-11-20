"use strict";
const governanceCommands = require("./lifecycle.js").commands;

// Wave 2 (COORD-057): runtime-cleanup tests relocated out of the governance.test.js
// monolith into a module-owned file. They exercise the runtime lock status/break,
// rollback-drift, and clean-runtime behavior via the governance __testing surface.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");

// COORD-951 (4): a dead pid is a reaped child, never a constant that may be live.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}
const { __testing, GovernanceError, executeCommand, withCleanRuntimeFixture, withGovernedSurfaceSandbox, withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const createRuntimeCleanup = require("./runtime-cleanup.js");
const governanceContext = require("./governance-context.js");
const { DEFAULT_PATHS, state } = governanceContext;
const { remoteBehindReason } = createRuntimeCleanup;
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function seedJournaledSnapshot(logPath, command = "finalize") {
  const snapshot = __testing.buildGovernanceSnapshot();
  __testing.writeGovernanceSnapshotArtifact(snapshot);
  __testing.writeGovernanceSnapshotCheckpoint(snapshot, { ts: new Date().toISOString(), command });
  fs.writeFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), command, snapshot_digest: snapshot.digest })}\n`);
  return snapshot;
}

test("describeDirectoryLockHolder reports pid liveness and age for runtime lock diagnostics", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-lock-holder-"));
  const lockDir = path.join(tempDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: deadPid(),
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-runtime-lock-status-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: deadPid(),
    cwd: "/tmp/runtime-lock-status",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  const originalLog = console.log;
  let output = "";
  console.log = (value) => {
    output += `${String(value)}\n`;
  };
  withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
  try {
    governanceCommands.runtimeLockStatus();
    const payload = JSON.parse(output.trim());
    assert.equal(payload.exists, true);
    assert.equal(payload.reclaimable_now, true);
    assert.match(payload.description, /owner_alive=no/);
    assert.equal(fs.existsSync(lockDir), true);

    const ownerFile = path.join(lockDir, "lock-owner.json");
    for (const [host, reclaimable] of [["", false], [`${os.hostname()}-foreign`, true]]) {
      const bytes = JSON.stringify({ host, kind: "governance-runtime" });
      fs.writeFileSync(ownerFile, bytes);
      output = "";
      governanceCommands.runtimeLockStatus();
      const reported = JSON.parse(output);
      assert.equal(reported.holder.host, host);
      assert.equal(reported.live_local_holder, false);
      assert.equal(reported.reclaimable_now, reclaimable);
      assert.equal(fs.readFileSync(ownerFile, "utf8"), bytes);
    }
  } finally {
    console.log = originalLog;
  }
  });
});

test("runtimeLockStatus does not mark unknown-owner governance runtime locks reclaimable by age", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-runtime-lock-unknown-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const oldAt = new Date(Date.now() - 600_000);
  fs.utimesSync(lockDir, oldAt, oldAt);

  const originalLog = console.log;
  let output = "";
  console.log = (value) => {
    output += `${String(value)}\n`;
  };
  withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
  try {
    governanceCommands.runtimeLockStatus();
    const payload = JSON.parse(output.trim());
    assert.equal(payload.exists, true);
    assert.equal(payload.holder, null);
    assert.equal(payload.live_local_holder, false);
    assert.equal(payload.reclaimable_now, false);
    assert.equal(fs.existsSync(lockDir), true);
  } finally {
    console.log = originalLog;
  }
  });
});

test("breakRuntimeLock removes the runtime lock directory only with explicit yes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-runtime-lock-break-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: deadPid(),
    cwd: "/tmp/runtime-lock-break",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
    assert.throws(
      () => governanceCommands.breakRuntimeLock({}),
      (error) => error instanceof GovernanceError && /destructive; rerun with --yes/i.test(error.message)
    );
    assert.equal(fs.existsSync(lockDir), true);
    governanceCommands.breakRuntimeLock({ yes: true });
    assert.equal(fs.existsSync(lockDir), false);
  });
});

test("COORD-570 runtime recovery reports an absent governance lock without mutating state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-missing-runtime-lock-"));
  const lockDir = path.join(tempDir, "governance.lock");
  const originalLog = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
  try {
    governanceCommands.breakRuntimeLock({ yes: true });
    assert.match(output.at(-1), /No governance runtime lock exists/);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-570 reports unknown age and empty-holder fallbacks when lock stats race", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-lock-stat-race-"));
  const agentLock = path.join(tempDir, ".agent-state.lock");
  const runtimeLock = path.join(tempDir, "governance.lock");
  withScopedGovernanceTestContext({ AGENT_STATE_LOCK_DIR: agentLock, GOVERNANCE_EVENT_LOCK_DIR: runtimeLock }, () => {
  fs.mkdirSync(agentLock);
  fs.writeFileSync(path.join(agentLock, "lock-owner.json"), JSON.stringify({ pid: "invalid", host: os.hostname() }));
  fs.mkdirSync(runtimeLock);
  const originalStat = fs.statSync;
  // COORD-931: lock entries are read with lstat, so the injected race covers both.
  const racing = (target) => [agentLock, runtimeLock].includes(path.resolve(String(target)));
  const raceError = () => { const error = new Error("simulated lock metadata race"); error.code = "ENOENT"; return error; };
  fs.statSync = function (target, ...args) {
    if (racing(target)) throw raceError();
    return originalStat.call(this, target, ...args);
  };
  // Presence is read with lstat, so only the age read (readLockAgeMs) is raced.
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function (target, ...args) {
    if (racing(target) && new Error().stack.includes("readLockAgeMs")) throw raceError();
    return originalLstat.call(this, target, ...args);
  };
  const originalLog = console.log;
  const output = [];
  console.log = (value) => output.push(String(value));
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); },
    resolveHumanAdminOverride: (...args) => require("./lifecycle.js").__testing.resolveHumanAdminOverride(...args),
    appendGovernanceEvent: (event) => require("./lifecycle.js").__testing.appendGovernanceEvent(event) });
  try {
    recovery.runtimeLockStatus({ kind: "agent-state" });
    assert.match(JSON.parse(output.at(-1)).description, /age_ms=unknown/);
    assert.throws(
      () => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }),
      /unknown ownership.*wait 60000ms for the 60s stale-owner threshold/
    );
    assert.equal(fs.existsSync(agentLock), true, "an unstatable lock is retained");

    recovery.breakRuntimeLock({ yes: true });
    assert.equal(JSON.parse(output.at(-1)).holder, null,
      "the status report preserves a null holder when the lock disappears during stat");
  } finally {
    console.log = originalLog;
    fs.statSync = originalStat;
    fs.lstatSync = originalLstat;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-570 explicit state-lock recovery reclaims dead local owners and stale unknown owners, never live local owners", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-state-lock-recovery-"));
  withScopedGovernanceTestContext({
    AGENT_STATE_LOCK_DIR: path.join(tempDir, ".agent-state.lock"),
    COORD_STATE_LOCK_DIR: path.join(tempDir, ".coord-state.lock"),
  }, () => {
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); } });
  const lockDir = governanceContext.state.AGENT_STATE_LOCK_DIR;
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
      pid: deadPid(),
      host: os.hostname(),
      kind: "agent-state",
    }));
    assert.doesNotThrow(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }));
    assert.equal(fs.existsSync(lockDir), false, "known dead local owner is immediately reclaimable");

    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      kind: "agent-state",
    }));
    assert.throws(
      () => recovery.breakRuntimeLock({ kind: "agent-state", yes: true, humanAdminOverride: "approved" }),
      /confirmed live local.*never removed|refuses to remove the confirmed live local/i,
    );
    assert.equal(fs.existsSync(lockDir), true, "confirmed live local holder is never removed, even with override");
    fs.rmSync(lockDir, { recursive: true, force: true });

    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({ pid: process.pid, kind: "agent-state" }));
    const hostlessStatusOutput = [];
    const originalLog = console.log;
    console.log = (value) => hostlessStatusOutput.push(String(value));
    try {
      recovery.runtimeLockStatus({ kind: "agent-state" });
    } finally {
      console.log = originalLog;
    }
    assert.equal(JSON.parse(hostlessStatusOutput.at(-1)).owner_state, "live-local",
      "a hostless PID that is alive locally remains protected");
    assert.throws(
      () => recovery.breakRuntimeLock({ kind: "agent-state", yes: true, humanAdminOverride: "approved" }),
      /confirmed live local.*never removed|refuses to remove the confirmed live local/i,
    );
    assert.equal(fs.existsSync(lockDir), true, "hostless live PID metadata is not reclaimed");
    fs.rmSync(lockDir, { recursive: true, force: true });

    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({ pid: deadPid(), kind: "agent-state" }));
    const staleHostless = new Date(Date.now() - 61_000);
    fs.utimesSync(lockDir, staleHostless, staleHostless);
    assert.doesNotThrow(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }));
    assert.equal(fs.existsSync(lockDir), false, "a dead hostless PID falls back to stale-age recovery");

    fs.mkdirSync(lockDir);
    const recent = new Date();
    fs.utimesSync(lockDir, recent, recent);
    assert.throws(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }), /wait .* stale-owner threshold/i);
    assert.equal(fs.existsSync(lockDir), true, "unknown owner is retained before 60 seconds");
    const stale = new Date(Date.now() - 61_000);
    fs.utimesSync(lockDir, stale, stale);
    assert.doesNotThrow(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }));
    assert.equal(fs.existsSync(lockDir), false, "unknown owner becomes reclaimable after the stale threshold");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
});

test("COORD-570 direct recovery recheck never reclaims stale live local or hostless PIDs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-explicit-live-recheck-"));
  const stale = new Date(Date.now() - 120_000);
  try {
    for (const [name, owner] of [
      ["local", { pid: process.pid, host: os.hostname() }],
      ["hostless", { pid: process.pid }],
    ]) {
      const lockDir = path.join(tempDir, `${name}.lock`);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify(owner));
      fs.utimesSync(lockDir, stale, stale);
      assert.equal(governanceContext.tryReclaimStaleDirectoryLock(lockDir, 60_000, { explicitRecovery: true }), false);
      assert.equal(fs.existsSync(lockDir), true, `${name} live process remains protected after the stale threshold`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 recovery rechecks unknown-owner age after claiming and preserves a refreshed lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-state-lock-refresh-race-"));
  const lockDir = path.join(tempDir, ".agent-state.lock");
  const contextOverrides = { AGENT_STATE_LOCK_DIR: lockDir };
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); } });
  const originalRenameSync = fs.renameSync;
  let claimedPath = null;
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    fs.mkdirSync(lockDir);
    const stale = new Date(Date.now() - 61_000);
    fs.utimesSync(lockDir, stale, stale);
    fs.renameSync = function (source, destination) {
      const result = originalRenameSync.call(fs, source, destination);
      if (source === lockDir && destination.startsWith(`${lockDir}.reclaim-`)) {
        claimedPath = destination;
        const fresh = new Date();
        fs.utimesSync(destination, fresh, fresh);
      }
      return result;
    };

    assert.throws(
      () => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }),
      /changed or is not safely reclaimable/i,
      "a lock refreshed after the initial age check must be refused",
    );
    assert.ok(claimedPath);
    assert.equal(fs.existsSync(lockDir), true, "the refreshed lock is restored at its canonical path");
    assert.equal(fs.existsSync(claimedPath), false, "the refreshed lock is not stranded in quarantine");
    assert.ok(Date.now() - fs.statSync(lockDir).mtimeMs < 60_000);
    });
  } finally {
    fs.renameSync = originalRenameSync;

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 status and repair agree at the exact unknown-owner stale threshold", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-state-lock-boundary-"));
  const lockDir = path.join(tempDir, ".agent-state.lock");
  const contextOverrides = { AGENT_STATE_LOCK_DIR: lockDir };
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); } });
  const originalLog = console.log;
  const originalNow = Date.now;
  const originalStatSync = fs.statSync;
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    fs.mkdirSync(lockDir);
    // COORD-952: the clock is derived from the stored mtime instead of sampled before the
    // utimes/stat calls, so host load between those calls cannot push the boundary off by
    // a millisecond. The boundary is still exact: age == 60000 ms at the stale threshold.
    const exactBoundary = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, exactBoundary, exactBoundary);
    const now = fs.statSync(lockDir).mtimeMs + 60_000;
    fs.statSync = function (target, ...args) {
      const stat = Reflect.apply(originalStatSync, this, [target, ...args]);
      if (String(target) === lockDir || String(target).startsWith(`${lockDir}.reclaim-`)) {
        return new Proxy(stat, { get: (value, key, receiver) => key === "mtimeMs" ? now - 60_000 : Reflect.get(value, key, receiver) });
      }
      return stat;
    };
    Date.now = () => now;
    let output = "";
    console.log = (value) => { output += `${String(value)}\n`; };
    recovery.runtimeLockStatus({ kind: "agent-state" });
    assert.equal(JSON.parse(output.trim()).reclaimable_now, true, output);
    assert.doesNotThrow(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }));
    assert.equal(fs.existsSync(lockDir), false);
    });
  } finally {
    Date.now = originalNow;
    fs.statSync = originalStatSync;
    console.log = originalLog;

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 foreign state-lock recovery reports unknown and requires human-admin authority", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-foreign-lock-recovery-"));
  const contextOverrides = {
    AGENT_STATE_LOCK_DIR: path.join(tempDir, ".agent-state.lock"),
    RUNTIME_DIR: path.join(tempDir, "runtime"),
    GOVERNANCE_EVENT_LOG_PATH: path.join(tempDir, "runtime", "governance-events.ndjson"),
  };
  let mutateOnApproval = false;
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); },
    resolveHumanAdminOverride: (...args) => require("./lifecycle.js").__testing.resolveHumanAdminOverride(...args),
    appendGovernanceEvent: (event) => {
      const file = governanceContext.state.GOVERNANCE_EVENT_LOG_PATH;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ...event, details: event })}\n`);
      if (event.event === "approval.verified" && mutateOnApproval) {
        const lock = governanceContext.state.AGENT_STATE_LOCK_DIR;
        fs.unlinkSync(path.join(lock, "lock-owner.json"));
      }
    } });
  const originalLog = console.log;
  let output = "";
  console.log = (value) => { output += `${String(value)}\n`; };
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    const lockDir = governanceContext.state.AGENT_STATE_LOCK_DIR;
    fs.mkdirSync(lockDir);
    const ownerFile = path.join(lockDir, "lock-owner.json");
    const ownerBytes = JSON.stringify({
      pid: process.pid, // local PID collision must not be read as a foreign owner being live or dead
      host: `${os.hostname()}-foreign`,
      kind: "agent-state",
    });
    fs.writeFileSync(ownerFile, ownerBytes);
    recovery.runtimeLockStatus({ kind: "agent-state" });
    const status = JSON.parse(output.trim());
    assert.equal(status.owner_state, "foreign-host-unknown");
    assert.equal(status.reclaimable_now, false);
    assert.equal(status.requires_human_admin_override, true);
    assert.throws(() => recovery.breakRuntimeLock({ kind: "agent-state", yes: true }), /owner is unknown, not presumed dead/i);
    assert.equal(fs.existsSync(lockDir), true);
    assert.throws(
      () => recovery.breakRuntimeLock({ kind: "agent-state", humanAdminOverride: "approved foreign recovery" }),
      /destructive; rerun for agent-state with --yes and --human-admin-override/
    );
    const approval = createApprovalFixture({ allowedVerbs: ["break-runtime-lock"] });
    try {
      withApprovalTestClient(path.resolve(__dirname, "..", ".."), approval.client(), () => {
        const authorize = (options) => {
          assert.throws(() => recovery.breakRuntimeLock(options), (error) => {
            const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
            assert.ok(digest, error.message);
            assert.match(error.message, /requires a signed human-admin approval/);
            assert.equal(fs.readFileSync(ownerFile, "utf8"), ownerBytes);
            approval.login({ verb: "break-runtime-lock", ticket: "agent-state", subject_sha256: digest[1] });
            return true;
          });
        };
        const changed = { kind: "agent-state", yes: true, humanAdminOverride: "approved recovery before concurrent change" };
        authorize(changed);
        const protectedFile = path.join(lockDir, "recovery-evidence");
        fs.writeFileSync(protectedFile, "preserved on refusal");
        mutateOnApproval = true;
        assert.throws(() => recovery.breakRuntimeLock(changed), /lock changed after human approval/);
        assert.equal(fs.readFileSync(protectedFile, "utf8"), "preserved on refusal");
        assert.equal(fs.existsSync(ownerFile), false, "the approved owner record changed before removal");
        assert.equal(fs.existsSync(path.join(contextOverrides.RUNTIME_DIR, "recovery-receipts")), false);
        mutateOnApproval = false;
        fs.writeFileSync(ownerFile, ownerBytes);
        const options = { kind: "agent-state", yes: true, humanAdminOverride: "approved stale foreign host lock recovery" };
        authorize(options);
        assert.doesNotThrow(() => recovery.breakRuntimeLock(options));
      });
    } finally { approval.cleanup(); }
    assert.equal(fs.existsSync(lockDir), false);
    });
  } finally {
    console.log = originalLog;

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 recovery preserves and identifies a live claimed lock when a new canonical lock wins the race", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-state-lock-claim-race-"));
  const lockDir = path.join(tempDir, ".agent-state.lock");
  const contextOverrides = { AGENT_STATE_LOCK_DIR: lockDir };
  const recovery = createRuntimeCleanup({ fail: (message) => { throw new GovernanceError(message); } });
  const initialOwner = JSON.stringify({ pid: deadPid(), host: os.hostname(), kind: "agent-state" });
  const claimedOwner = JSON.stringify({ pid: process.pid, host: os.hostname(), kind: "agent-state" });
  const canonicalOwner = JSON.stringify({ pid: process.pid, host: os.hostname(), kind: "agent-state", marker: "new-canonical" });
  const claimedPayload = "claimed-owner-payload";
  const canonicalPayload = "new-canonical-payload";
  let claimPath = null;
  const originalRenameSync = fs.renameSync;
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "lock-owner.json"), initialOwner);
    fs.writeFileSync(path.join(lockDir, "payload.txt"), "original-payload");
    fs.renameSync = function (source, destination) {
      const result = originalRenameSync.call(fs, source, destination);
      if (source === lockDir && destination.startsWith(`${lockDir}.reclaim-`)) {
        claimPath = destination;
        fs.writeFileSync(path.join(claimPath, "lock-owner.json"), claimedOwner);
        fs.writeFileSync(path.join(claimPath, "payload.txt"), claimedPayload);
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, "lock-owner.json"), canonicalOwner);
        fs.writeFileSync(path.join(lockDir, "payload.txt"), canonicalPayload);
      }
      return result;
    };

    let refusal;
    try {
      recovery.breakRuntimeLock({ kind: "agent-state", yes: true });
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal instanceof GovernanceError);
    assert.ok(claimPath, "the race must move the original lock into quarantine");
    assert.ok(refusal.message.includes(claimPath), "the refusal should identify the retained quarantine path");
    assert.match(refusal.message, /Retained claim preserved at/);
    assert.deepEqual(fs.readFileSync(path.join(claimPath, "lock-owner.json")), Buffer.from(claimedOwner));
    assert.deepEqual(fs.readFileSync(path.join(claimPath, "payload.txt")), Buffer.from(claimedPayload));
    assert.deepEqual(fs.readFileSync(path.join(lockDir, "lock-owner.json")), Buffer.from(canonicalOwner));
    assert.deepEqual(fs.readFileSync(path.join(lockDir, "payload.txt")), Buffer.from(canonicalPayload));
    });
  } finally {
    fs.renameSync = originalRenameSync;

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 public CLI selects coord/agent state locks and enforces explicit recovery flags", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-public-cli-lock-recovery-"));
  const agentPath = path.join(tempDir, ".agent-state.lock");
  const coordPath = path.join(tempDir, ".coord-state.lock");
  const runtimeDir = path.join(tempDir, "runtime");
  const contextOverrides = {
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-latest-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "governance-snapshots"),
    COORD_STATE_LOCK_DIR: coordPath,
    AGENT_STATE_LOCK_DIR: agentPath,
    MEMORY_DIR: path.join(tempDir, "memory"),
  };
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    assert.equal(path.resolve(governanceContext.state.RUNTIME_DIR), runtimeDir,
      "the signed-approval journal uses this fixture's disposable runtime");
    assert.equal(path.resolve(governanceContext.state.GOVERNANCE_EVENT_LOG_PATH), contextOverrides.GOVERNANCE_EVENT_LOG_PATH,
      "the fixture approval event cannot target canonical governance state");
    fs.mkdirSync(coordPath);
    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(coordPath, old, old);
    const coordStatus = executeCommand(["runtime-lock-status", "--kind", "coord-state"]);
    assert.equal(coordStatus.ok, true, coordStatus.error);
    assert.equal(JSON.parse(coordStatus.stdout).kind, "coord-state");
    assert.equal(JSON.parse(coordStatus.stdout).reclaimable_now, true);
    const needsYes = executeCommand(["break-runtime-lock", "--kind", "coord-state"]);
    assert.equal(needsYes.ok, false);
    assert.match(needsYes.error, /destructive.*--yes/i);
    assert.equal(fs.existsSync(coordPath), true);
    const coordBreak = executeCommand(["break-runtime-lock", "--kind", "coord-state", "--yes"]);
    assert.equal(coordBreak.ok, true, coordBreak.error);
    assert.equal(fs.existsSync(coordPath), false);

    fs.mkdirSync(agentPath);
    fs.writeFileSync(path.join(agentPath, "lock-owner.json"), JSON.stringify({
      pid: process.pid,
      host: `${os.hostname()}-foreign`,
      kind: "agent-state",
    }));
    const agentStatus = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(agentStatus.ok, true, agentStatus.error);
    assert.equal(JSON.parse(agentStatus.stdout).owner_state, "foreign-host-unknown");
    const refused = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unknown, not presumed dead/i);
    assert.equal(fs.existsSync(agentPath), true);
    const unsignedApprovalAttempt = executeCommand([
      "break-runtime-lock", "--kind", "agent-state", "--yes",
      "--human-admin-override", "approved foreign lock recovery",
    ]);
    assert.equal(unsignedApprovalAttempt.ok, false);
    assert.match(unsignedApprovalAttempt.error, /requires a signed human-admin approval/);
    assert.equal(fs.existsSync(agentPath), true, "unsigned text cannot remove a foreign lock");
    const approval = createApprovalFixture({ allowedVerbs: ["break-runtime-lock"] });
    let approved;
    try {
      withApprovalTestClient(path.resolve(__dirname, "..", ".."), approval.client(), () => {
        const request = ["break-runtime-lock", "--kind", "agent-state", "--yes",
          "--human-admin-override", "approved foreign lock recovery"];
        const refusedWithoutSession = executeCommand(request);
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(refusedWithoutSession.error);
        assert.equal(refusedWithoutSession.ok, false);
        assert.ok(digest, refusedWithoutSession.error);
        assert.equal(fs.existsSync(agentPath), true, "the refusal leaves the foreign lock unchanged");
        approval.login({ verb: "break-runtime-lock", ticket: "agent-state", subject_sha256: digest[1] });
        approved = executeCommand(request);
      });
    } finally { approval.cleanup(); }
    assert.equal(approved.ok, true, approved.error);
    assert.equal(fs.existsSync(agentPath), false);

    fs.mkdirSync(agentPath);
    fs.writeFileSync(path.join(agentPath, "lock-owner.json"), JSON.stringify({
      host: `${os.hostname()}-foreign`,
      kind: "agent-state",
    }));
    const pidlessForeignStatus = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(JSON.parse(pidlessForeignStatus.stdout).owner_state, "foreign-host-unknown",
      "a foreign host remains unknown even when its PID metadata is missing");
    const pidlessForeignRefused = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
    assert.equal(pidlessForeignRefused.ok, false);
    assert.match(pidlessForeignRefused.error, /human-admin-override/);
    const pidlessRequest = [
      "break-runtime-lock", "--kind", "agent-state", "--yes",
      "--human-admin-override", "approved pidless foreign lock recovery",
    ];
    const pidlessApproval = createApprovalFixture({ allowedVerbs: ["break-runtime-lock"] });
    let pidlessForeignApproved;
    try {
      withApprovalTestClient(path.resolve(__dirname, "..", ".."), pidlessApproval.client(), () => {
        const refusedWithoutSession = executeCommand(pidlessRequest);
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(refusedWithoutSession.error);
        assert.equal(refusedWithoutSession.ok, false);
        assert.ok(digest, refusedWithoutSession.error);
        assert.equal(fs.existsSync(agentPath), true, "the refusal leaves the pidless foreign lock unchanged");
        pidlessApproval.login({ verb: "break-runtime-lock", ticket: "agent-state", subject_sha256: digest[1] });
        pidlessForeignApproved = executeCommand(pidlessRequest);
      });
    } finally { pidlessApproval.cleanup(); }
    assert.equal(pidlessForeignApproved.ok, true, pidlessForeignApproved.error);
    assert.equal(fs.existsSync(agentPath), false);

    const outsideTarget = path.join(tempDir, "outside-owner-target");
    fs.mkdirSync(outsideTarget);
    const markerPath = path.join(outsideTarget, "preserve-me.txt");
    fs.writeFileSync(markerPath, "outside target remains intact\n");
    fs.writeFileSync(path.join(outsideTarget, "lock-owner.json"), JSON.stringify({
      pid: deadPid(),
      host: os.hostname(),
      kind: "agent-state",
    }));
    fs.symlinkSync(outsideTarget, agentPath, "dir");
    const symlinkBreak = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
    assert.equal(symlinkBreak.ok, true, symlinkBreak.error);
    assert.equal(fs.existsSync(agentPath), false, "the selected recovery link is removed");
    assert.equal(fs.readFileSync(markerPath, "utf8"), "outside target remains intact\n",
      "recovery must not traverse or delete the symlink target outside the state-lock path");
    });
  } finally {

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-570 state-lock CLI classifies missing, ownerless, unknown, live, and dead locks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord570-state-lock-status-states-"));
  const agentPath = path.join(tempDir, ".agent-state.lock");
  const runtimePath = path.join(tempDir, "governance.lock");
  const contextOverrides = { AGENT_STATE_LOCK_DIR: agentPath, GOVERNANCE_EVENT_LOCK_DIR: runtimePath };
  try {
    withScopedGovernanceTestContext(contextOverrides, () => {
    const missingRuntime = executeCommand(["runtime-lock-status"]);
    assert.equal(missingRuntime.ok, true, missingRuntime.error);
    assert.equal(JSON.parse(missingRuntime.stdout).exists, false);
    assert.equal(JSON.parse(missingRuntime.stdout).description, "");
    assert.equal(JSON.parse(missingRuntime.stdout).live_local_holder, false);
    assert.equal(JSON.parse(missingRuntime.stdout).reclaimable_now, false);

    const missing = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(missing.ok, true, missing.error);
    const missingStatus = JSON.parse(missing.stdout);
    assert.equal(missingStatus.exists, false);
    assert.equal(missingStatus.holder, null);
    assert.equal(missingStatus.description, "");
    assert.equal(missingStatus.owner_state, "ownerless");
    assert.equal(missingStatus.age_ms, null);
    assert.equal(missingStatus.reclaimable_now, false);
    assert.equal(missingStatus.requires_human_admin_override, false);
    assert.equal(missingStatus.reclaimable_after_ms, null);

    const missingBreak = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
    assert.equal(missingBreak.ok, true, missingBreak.error);
    assert.match(missingBreak.stdout, /No agent-state lock exists/);

    const unsupported = executeCommand(["runtime-lock-status", "--kind", "unknown-kind"]);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error, /Unsupported runtime lock kind/);

    fs.mkdirSync(agentPath);
    let status = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(JSON.parse(status.stdout).owner_state, "ownerless");
    assert.equal(JSON.parse(status.stdout).reclaimable_now, false);

    fs.writeFileSync(path.join(agentPath, "lock-owner.json"), JSON.stringify({ pid: "invalid", host: os.hostname() }));
    status = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(JSON.parse(status.stdout).owner_state, "unknown");
    assert.equal(JSON.parse(status.stdout).reclaimable_now, false);
    assert.ok(JSON.parse(status.stdout).reclaimable_after_ms >= 0);

    fs.writeFileSync(path.join(agentPath, "lock-owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname() }));
    status = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(JSON.parse(status.stdout).owner_state, "live-local");
    assert.equal(JSON.parse(status.stdout).reclaimable_now, false);

    fs.writeFileSync(path.join(agentPath, "lock-owner.json"), JSON.stringify({ pid: deadPid(), host: os.hostname() }));
    status = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
    assert.equal(JSON.parse(status.stdout).owner_state, "dead-local");
    assert.equal(JSON.parse(status.stdout).reclaimable_now, true);
    });
  } finally {

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("breakRuntimeLock refuses to remove a live local holder unless force-live is explicit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-governance-runtime-lock-live-break-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const lockDir = path.join(runtimeDir, "governance.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "lock-owner.json"), JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    cwd: "/tmp/runtime-lock-live-break",
    kind: "governance-runtime",
    created_at: new Date().toISOString(),
  }, null, 2));

  withScopedGovernanceTestContext({ GOVERNANCE_EVENT_LOCK_DIR: lockDir }, () => {
    assert.throws(
      () => governanceCommands.breakRuntimeLock({ yes: true }),
      (error) => error instanceof GovernanceError && /refuses to remove a live local holder/i.test(error.message)
    );
    assert.equal(fs.existsSync(lockDir), true);

    governanceCommands.breakRuntimeLock({ yes: true, forceLive: true });
    assert.equal(fs.existsSync(lockDir), false);
  });
});

test("detectRollbackDrift reports no drift when journal is empty and git/remote absent", () => {
  withCleanRuntimeFixture(() => {
    const result = __testing.detectRollbackDrift();
    assert.equal(result.drift, false);
    assert.deepEqual(result.reasons, []);
  });
});

test("remote ancestry warning still fires only when HEAD is verifiably behind origin/main", () => {
  const calls = [];
  const behindGit = (_root, args) => {
    calls.push(args);
    return args[0] === "rev-parse"
      ? { status: 0, stdout: "abc\n" }
      : { status: 0, stdout: "3\n" };
  };
  // COORD-967: the board branch is injected explicitly, never read from the live config.
  assert.match(remoteBehindReason(behindGit, "/coord", "main"), /3 commit\(s\) behind origin\/main/);
  assert.deepEqual(calls.map((args) => args[0]), ["rev-parse", "rev-list"]);
  assert.match(remoteBehindReason(behindGit, "/coord", "dev"), /3 commit\(s\) behind origin\/dev/);
  assert.equal(remoteBehindReason(() => ({ status: 128 }), "/coord", "main"), null);
  assert.equal(remoteBehindReason(() => { throw new Error("git unavailable"); }, "/coord", "main"), null);
  const gitWithCount = (count) => (_root, args) => args[0] === "rev-parse"
    ? { status: 0, stdout: "abc\n" } : count;
  assert.equal(remoteBehindReason(gitWithCount({ status: 128 }), "/coord", "main"), null);
  assert.equal(remoteBehindReason(gitWithCount({ status: 0, stdout: "" }), "/coord", "main"), null);
  assert.equal(remoteBehindReason(gitWithCount({ status: 0, stdout: "0\n" }), "/coord", "dev"), null);
});

test("COORD-967 guard: runtime-cleanup tests never read the live board branch", () => {
  const source = fs.readFileSync(__filename, "utf8");
  assert.doesNotMatch(source, /DEFAULT_PATHS\.boardBranch/, "tests must inject a board branch, not read the live default");
  // Every remoteBehindReason call in this suite must pass an explicit quoted branch literal.
  const callToken = `remoteBehindReason${"("}`;
  const unpinned = source.split("\n")
    .filter((line) => line.includes(callToken) && !/,\s*"[a-z][a-z-]*"\)/.test(line));
  assert.deepEqual(unpinned, [], "remoteBehindReason calls must pass an explicit board branch");
});

test("COORD-967 guard: branch-dependent governance suites load the hermetic fixture, never the live project config", () => {
  // Each suite must point the COORD_PROJECT_CONFIG seam at the fixture BEFORE its first
  // require (paths.js captures the config at load), so DEFAULT_PATHS is fixture-derived.
  const SUITES = [
    "governance-plan-shape", "closeout", "plan-records", "plan-command",
    "worktree-ops", "runtime-authority-lifecycle",
  ];
  const SEAM = "process.env.COORD_PROJECT_CONFIG = ";
  const FIXTURE = `"fixtures", "hermetic-project.config.js"`;
  const LIVE_CONFIG = /(?<!-)project\.config\.js/; // the live file, not the hermetic fixture
  for (const name of SUITES) {
    const source = fs.readFileSync(path.join(__dirname, `${name}.test.js`), "utf8");
    const seamAt = source.indexOf(SEAM);
    const firstRequire = source.indexOf("require(");
    assert.ok(seamAt >= 0 && seamAt < firstRequire, `${name}: set COORD_PROJECT_CONFIG to the hermetic fixture before the first require`);
    assert.ok(source.slice(seamAt, seamAt + 200).includes(FIXTURE), `${name}: the seam must name the hermetic fixture`);
    // A suite may write or read its own synthetic sandbox config (path.join(dir|coordDir, "project.config.js")).
    const withoutSynthetic = source
      .split('path.join(dir, "project.config.js")').join("")
      .split('path.join(coordDir, "project.config.js")').join("")
      .split('path.join(target, "project.config.js")').join("");
    assert.doesNotMatch(withoutSynthetic, LIVE_CONFIG, `${name}: must not reference the live coord/project.config.js`);
  }
  assert.ok(fs.existsSync(path.join(__dirname, "fixtures", "hermetic-project.config.js")), "the hermetic fixture must exist");
});

test("COORD-895: the remote-behind warning follows the configured board branch", () => {
  const calls = [];
  const git = (_root, args) => {
    calls.push(args);
    return args[0] === "rev-parse" ? { status: 0, stdout: "abc\n" } : { status: 0, stdout: "2\n" };
  };
  assert.match(remoteBehindReason(git, "/coord", "governance"), /2 commit\(s\) behind origin\/governance/);
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--quiet", "origin/governance"],
    ["rev-list", "--count", "HEAD..origin/governance"],
  ]);
});

test("detectRollbackDrift checks remote ancestry only for the default installed runtime", () => {
  // COORD-967: the board branch is injected per case, never read from the live config.
  for (const boardBranch of ["main", "dev"]) {
    const calls = [];
    const cleanup = createRuntimeCleanup({
      boardBranch,
      gitTry: (_root, args) => {
        calls.push(args);
        return args[0] === "rev-parse"
          ? { status: 0, stdout: "abc\n" }
          : { status: 0, stdout: "2\n" };
      },
      readGovernanceEventLog: () => [],
    });
    withScopedGovernanceTestContext({
      BOARD_PATH: DEFAULT_PATHS.boardPath,
      RUNTIME_DIR: DEFAULT_PATHS.runtimeDir,
      GOVERNANCE_EVENT_LOG_PATH: DEFAULT_PATHS.governanceEventLogPath,
    }, () => {
      assert.match(cleanup.detectRollbackDrift().reasons.join("\n"), new RegExp(`2 commit\\(s\\) behind origin/${boardBranch}\\b`));
      assert.deepEqual(calls.map((args) => args[0]), ["rev-parse", "rev-list"]);
      assert.deepEqual(calls[0], ["rev-parse", "--verify", "--quiet", `origin/${boardBranch}`]);
    });

    calls.length = 0;
    withScopedGovernanceTestContext({
      BOARD_PATH: "/tmp/nondefault-coord/board/tasks.json",
      RUNTIME_DIR: "/tmp/nondefault-coord/.runtime",
      GOVERNANCE_EVENT_LOG_PATH: "/tmp/nondefault-coord/.runtime/events.ndjson",
    }, () => {
      assert.deepEqual(cleanup.detectRollbackDrift().reasons, []);
      assert.deepEqual(calls, [], "isolated project runtimes do not consult the installed repo remote");
    });
  }
});

test("detectRollbackDrift uses journaled board bytes across plan-only events, touches, and clock jumps", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const snapshot = seedJournaledSnapshot(logPath);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: future, command: "update-plan", snapshot_digest: snapshot.digest })}\n`);
    fs.utimesSync(boardPath, new Date(0), new Date(0));
    assert.deepEqual(__testing.detectRollbackDrift().reasons, []);
    fs.utimesSync(boardPath, new Date(Date.now() + 2 * 60 * 60 * 1000), new Date(Date.now() + 2 * 60 * 60 * 1000));
    assert.deepEqual(__testing.detectRollbackDrift().reasons, []);
  });
});

test("detectRollbackDrift reports actual board byte drift and unverified missing evidence", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    const snapshot = seedJournaledSnapshot(logPath);
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ name: "todo", rows: [] }] }));
    assert.match(__testing.detectRollbackDrift().reasons.join("\n"), /board content differs from the latest journaled/);
    fs.rmSync(__testing.governanceSnapshotArtifactPath(snapshot.digest));
    assert.match(__testing.detectRollbackDrift().reasons.join("\n"), /board freshness unverified/);
  });
});

test("detectRollbackDrift reports uninitialized and initialized provenance branches", () => {
  withGovernedSurfaceSandbox(({ boardPath }) => {
    let provenance = { uninitialized: true };
    const cleanup = createRuntimeCleanup({
      readGovernanceEventLog: () => [{ command: "fixture" }],
      relativeCoordPath: () => "board/tasks.json",
      detectGovernanceProvenanceDrift: () => provenance,
    });
    const uninitialized = cleanup.detectRollbackDrift();
    assert.match(uninitialized.reasons.join("\n"), /no journaled snapshot baseline is available/);

    provenance = { uninitialized: false, drift: [] };
    assert.deepEqual(cleanup.detectRollbackDrift().reasons, []);

    provenance = { uninitialized: false, drift: ["board/tasks.json"] };
    assert.match(cleanup.detectRollbackDrift().reasons.join("\n"), /board content differs from the latest journaled/);
  });
});

test("detectRollbackDrift fails closed when provenance omits its drift inventory", () => {
  withGovernedSurfaceSandbox(() => {
    const cleanup = createRuntimeCleanup({
      readGovernanceEventLog: () => [{ command: "fixture" }],
      relativeCoordPath: () => "board/tasks.json",
      detectGovernanceProvenanceDrift: () => ({ uninitialized: false, snapshotPruned: false }),
    });
    assert.match(cleanup.detectRollbackDrift().reasons.join("\n"), /provenance check failed/);
    const failed = createRuntimeCleanup({
      readGovernanceEventLog: () => [{ command: "fixture" }],
      detectGovernanceProvenanceDrift: () => { throw "fixture adapter unavailable"; },
    });
    assert.match(failed.detectRollbackDrift().reasons.join("\n"), /provenance check failed \(fixture adapter unavailable\)/);

  });
});

test("detectRollbackDrift accepts a matching digest after the snapshot artifact is pruned", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    const snapshot = seedJournaledSnapshot(logPath);
    fs.rmSync(__testing.governanceSnapshotArtifactPath(snapshot.digest));
    assert.deepEqual(__testing.detectRollbackDrift().reasons, []);
  });
});

test("detectRollbackDrift reports a corrupt journal without silently allowing cleanup", () => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    fs.writeFileSync(logPath, "invalid entry\nsecond invalid entry\n");
    assert.match(__testing.detectRollbackDrift().reasons.join("\n"), /provenance check failed/);
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
    const plans = path.join(runtimeDir, "plans");
    fs.renameSync(plans, path.join(runtimeDir, "saved-plans-fixture"));
    fs.writeFileSync(plans, "an untracked file obstructs the plans directory");
    const { candidates } = __testing.collectCleanRuntimeTargets({ includeTicketState: true });
    assert.equal(candidates.find(({ path: candidate }) => candidate === plans)?.kind, "file");

  });
});

test("cleanRuntime dry-run lists candidates and deletes nothing", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const summary = governanceCommands.cleanRuntime({});
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
    const summary = governanceCommands.cleanRuntime({ yes: true });
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
    governanceCommands.cleanRuntime({ yes: true, includeTicketState: true });
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
      () => governanceCommands.cleanRuntime({ yes: true }),
      /clean-runtime refused: governance freshness is unverified or rollback evidence exists/
    );
    // Nothing deleted on a refused run.
    assert.ok(fs.existsSync(path.join(runtimeDir, "tmp-render")));
    assert.ok(fs.existsSync(path.join(runtimeDir, "stale.tmp")));

    // --force overrides and proceeds with the safe deletion.
    const forced = governanceCommands.cleanRuntime({ yes: true, force: true });
    assert.equal(forced.forced, true);
    assert.equal(forced.removed.length, 2);
    assert.ok(!fs.existsSync(path.join(runtimeDir, "tmp-render")));
  });
});

// COORD-931: a dangling agent-state link is reported, removed only through the
// checked break (with a receipt), and staging artifacts are swept dry-run first.
test("COORD-931: a dangling agent-state link is reported explicitly and break removes it with a receipt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord931-cli-dangling-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentPath = path.join(runtimeDir, ".agent-state.lock");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const danglingTarget = path.join(runtimeDir, ".agent-state.lock.acquire-gone");
  fs.symlinkSync(danglingTarget, agentPath, "dir");
  const old = new Date(Date.now() - 120_000);
  fs.lutimesSync(agentPath, old, old);
  try {
    withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, AGENT_STATE_LOCK_DIR: agentPath }, () => {
      const status = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
      assert.equal(status.ok, true, status.error);
      const report = JSON.parse(status.stdout);
      assert.equal(report.exists, true, "a dangling link is not reported as absent");
      assert.equal(report.dangling, true);
      assert.equal(report.target_exists, false);
      assert.equal(report.target, danglingTarget, "the link target is reported");
      assert.ok(report.link_age_ms >= 119_000, "link age is reported");
      assert.equal(report.holder, null, "no owner metadata is readable through a dangling link");

      const needsYes = executeCommand(["break-runtime-lock", "--kind", "agent-state"]);
      assert.equal(needsYes.ok, false);
      assert.match(needsYes.error, /destructive.*--yes/i);
      assert.equal(fs.lstatSync(agentPath).isSymbolicLink(), true, "nothing is removed without --yes");

      const broke = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
      assert.equal(broke.ok, true, broke.error);
      const payload = JSON.parse(broke.stdout);
      assert.equal(payload.removed, true);
      assert.equal(payload.dangling, true);
      assert.equal(payload.observed.target, report.target);
      assert.equal(fs.existsSync(agentPath), false, "lstat sees no link after removal");
      const receiptDir = path.join(runtimeDir, "recovery-receipts");
      const receipts = fs.readdirSync(receiptDir);
      assert.equal(receipts.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receipts[0]), "utf8"));
      assert.equal(receipt.action, "removed-dangling-link");
      assert.equal(receipt.observed.target, report.target);
      assert.ok(Number.isInteger(receipt.observed.link_ino));

      const again = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
      assert.equal(again.ok, true);
      assert.match(again.stdout, /No agent-state lock exists/);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("COORD-931: staging sweep is dry-run by default and removes only aged unreferenced artifacts with --yes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord931-cli-sweep-"));
  const runtimeDir = path.join(tempDir, ".runtime");
  const agentPath = path.join(runtimeDir, ".agent-state.lock");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  const aged = path.join(runtimeDir, ".agent-state.lock.acquire-aged");
  const agedReclaim = path.join(runtimeDir, ".agent-state.lock.reclaim-9-x-y");
  const fresh = path.join(runtimeDir, ".agent-state.lock.acquire-fresh");
  for (const dir of [aged, agedReclaim]) { fs.mkdirSync(dir); fs.utimesSync(dir, old, old); }
  fs.mkdirSync(fresh);
  try {
    withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, AGENT_STATE_LOCK_DIR: agentPath }, () => {
      const dry = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--sweep-staging"]);
      assert.equal(dry.ok, true, dry.error);
      const dryPayload = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("{"))); // text summary precedes the JSON
      assert.equal(dryPayload.dry_run, true);
      assert.equal(dryPayload.candidates.length, 2);
      assert.equal(fs.existsSync(aged), true, "a dry run deletes nothing");

      const applied = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--sweep-staging", "--yes"]);
      assert.equal(applied.ok, true, applied.error);
      const appliedPayload = JSON.parse(applied.stdout);
      assert.equal(appliedPayload.removed.length, 2);
      assert.equal(fs.existsSync(aged), false);
      assert.equal(fs.existsSync(agedReclaim), false);
      assert.equal(fs.existsSync(fresh), true, "a fresh staging directory may be a live acquire and is kept");
      assert.ok(fs.existsSync(path.join(runtimeDir, "recovery-receipts")), "the sweep writes a receipt");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("COORD-1052: dangling lock replacement during checked removal is refused without a receipt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-dangling-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, ".runtime");
  const lockPath = path.join(runtimeDir, ".agent-state.lock");
  const observedTarget = path.join(runtimeDir, ".agent-state.lock.acquire-observed");
  const replacementTarget = path.join(runtimeDir, ".agent-state.lock.acquire-replacement");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.symlinkSync(observedTarget, lockPath, "dir");
  const originalRename = fs.renameSync;
  let replaced = false;
  let wonRestorationRace = false;
  let claimPath;
  fs.renameSync = function (source, destination, ...rest) {
    if (!replaced && source === lockPath) {
      replaced = true;
      claimPath = destination;
      fs.unlinkSync(lockPath);
      fs.symlinkSync(replacementTarget, lockPath, "dir");
      Reflect.apply(originalRename, this, [source, destination, ...rest]);
      if (wonRestorationRace) fs.symlinkSync(observedTarget, lockPath, "dir");
      return;
    }
    return Reflect.apply(originalRename, this, [source, destination, ...rest]);
  };
  try {
    withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, AGENT_STATE_LOCK_DIR: lockPath }, () => {
      const result = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
      assert.equal(result.ok, false, result.stdout);
      assert.match(result.error, /changed or was already removed since it was observed/);
      assert.equal(replaced, true, "the fixture replaces the link between observation and atomic claim");
      assert.equal(fs.readlinkSync(lockPath), replacementTarget, "the concurrently replaced link remains canonical");
      assert.equal(fs.existsSync(path.join(runtimeDir, "recovery-receipts")), false, "a refused removal writes no success receipt");
      assert.deepEqual(fs.readdirSync(runtimeDir).sort(), [".agent-state.lock"], "no claim artifact is stranded");
      fs.unlinkSync(lockPath);
      fs.symlinkSync(observedTarget, lockPath, "dir");
      replaced = false;
      wonRestorationRace = true;
      const retained = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--yes"]);
      assert.equal(retained.ok, false, retained.stdout);
      assert.ok(retained.error.includes(`Retained claim preserved at ${claimPath}.`), retained.error);
      assert.equal(fs.readlinkSync(lockPath), observedTarget, "the canonical entry created during recovery wins");
      assert.equal(fs.readlinkSync(claimPath), replacementTarget, "the concurrently claimed link remains for inspection");
      assert.equal(fs.existsSync(path.join(runtimeDir, "recovery-receipts")), false);

    });
  } finally {
    fs.renameSync = originalRename;
  }
});

test("COORD-1052: staging sweep retains a stale staging directory whose owner is still live", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-staging-live-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, ".runtime");
  const lockPath = path.join(runtimeDir, ".agent-state.lock");
  const staging = `${lockPath}.acquire-live-owner`;
  fs.mkdirSync(staging, { recursive: true });
  const ownerBytes = `${JSON.stringify({ pid: process.pid, host: os.hostname(), kind: "agent-state" })}\n`;
  fs.writeFileSync(path.join(staging, "lock-owner.json"), ownerBytes);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(staging, old, old);
  withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, AGENT_STATE_LOCK_DIR: lockPath }, () => {
    const result = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--sweep-staging", "--yes"]);
    assert.equal(result.ok, true, result.error);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.dry_run, false);
    assert.deepEqual(summary.removed, [], "an aged staging entry is not removed while its owner process is live");
    assert.equal(summary.skipped.length, 1);
    assert.equal(path.resolve(path.resolve(__dirname, "..", ".."), summary.skipped[0].path), staging);
    assert.equal(summary.skipped[0].reason, "owner is live; retained for explicit repair");
    assert.equal(summary.recovery_receipt, null, "a sweep with no removals writes no success receipt");
    assert.deepEqual(fs.readFileSync(path.join(staging, "lock-owner.json"), "utf8"), ownerBytes);
    assert.equal(fs.existsSync(path.join(runtimeDir, "recovery-receipts")), false);
    assert.deepEqual(fs.readdirSync(runtimeDir), [path.basename(staging)]);
  });
});


test("COORD-1052: clean-runtime deletes only confirmed untracked scratch and preserves unknown Git results", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-clean-git-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, ".runtime");
  const boardPath = path.join(root, "board", "tasks.json");
  const plansDir = path.join(runtimeDir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [] }));
  fs.writeFileSync(path.join(plansDir, "COORD-1.json"), "plan evidence\n");
  const scratch = {
    untracked: path.join(runtimeDir, "tmp-confirmed-untracked"),
    tracked: path.join(runtimeDir, "tmp-confirmed-tracked"),
    unavailable: path.join(runtimeDir, "tmp-git-unavailable"),
    failed: path.join(runtimeDir, "tmp-git-failed"),
    threw: path.join(runtimeDir, "tmp-git-runner-threw"),
    signaled: path.join(runtimeDir, "tmp-git-signaled"),
    uncleanExitOne: path.join(runtimeDir, "tmp-git-exit-one-with-error"),
  };
  for (const file of Object.values(scratch)) fs.writeFileSync(file, `preserve-or-delete:${path.basename(file)}\n`);
  const unrelated = path.join(runtimeDir, "operator-notes.txt");
  fs.writeFileSync(unrelated, "retain operator notes");

  const responseByName = {
    [path.basename(scratch.untracked)]: { status: 1, stdout: "", stderr: "", error: null, signal: null },
    [path.basename(scratch.tracked)]: { status: 0, stdout: "tracked\n", stderr: "", error: null, signal: null },
    [path.basename(scratch.unavailable)]: { status: null, stdout: null, stderr: null, error: new Error("git executable unavailable"), signal: null },
    [path.basename(scratch.failed)]: { status: 128, stdout: "", stderr: "not a repository", error: null, signal: null },
    [path.basename(scratch.signaled)]: { status: null, stdout: null, stderr: null, error: null, signal: "SIGTERM" },
    [path.basename(scratch.uncleanExitOne)]: { status: 1, stdout: "", stderr: "fixture error", error: new Error("spawn error"), signal: null },
    plans: { status: 1, stdout: "", stderr: "", error: null, signal: null },
  };
  const recovery = createRuntimeCleanup({
    gitTry(cwd, args, options) {
      assert.equal(cwd, path.resolve(__dirname, "..", ".."));
      assert.deepEqual(args.slice(0, 2), ["ls-files", "--error-unmatch"]);
      if (path.basename(args.at(-1)) === "tmp-git-runner-threw") throw new Error("git runner could not start");
      return responseByName[path.basename(args.at(-1))] || { status: 1, stdout: "", stderr: "", error: null, signal: null };
    },
    fail: (message) => { throw new GovernanceError(message); },
    readGovernanceEventLog: () => [],
    relativeCoordPath: (file) => path.relative(root, file).replace(/\\/g, "/"),
    detectGovernanceProvenanceDrift: () => ({ drift: [], uninitialized: false, snapshotPruned: false, snapshotMatchesCurrent: true }),
  });
  withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir, BOARD_PATH: boardPath,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson") }, () => {
    const dry = recovery.collectCleanRuntimeTargets({ includeTicketState: true });
    assert.deepEqual(dry.candidates.map((entry) => entry.path).sort(), [scratch.untracked, plansDir].sort(),
      "only a clean exit-1 response is evidence that a path is untracked");
    const protectedByPath = new Map(dry.protected.map((entry) => [entry.path, entry.reason]));
    assert.equal(protectedByPath.get(unrelated), "not on the conservative scratch allowlist");
    assert.equal(protectedByPath.get(scratch.tracked), "git-tracked (canonical)");
    assert.equal(protectedByPath.get(scratch.unavailable), "git tracking status unavailable; preserving path");
    assert.equal(protectedByPath.get(scratch.threw), "git tracking status unavailable; preserving path");
    assert.equal(protectedByPath.get(scratch.failed), "git tracking status unavailable; preserving path");
    assert.equal(protectedByPath.get(scratch.signaled), "git tracking status unavailable; preserving path");
    assert.equal(protectedByPath.get(scratch.uncleanExitOne), "git tracking status unavailable; preserving path");

    responseByName.plans = { status: null, stdout: null, stderr: null, error: new Error("git executable unavailable"), signal: null };
    const planBytes = fs.readFileSync(path.join(plansDir, "COORD-1.json"));
    const preservedBytes = new Map(Object.values(scratch).filter((file) => file !== scratch.untracked)
      .map((file) => [file, fs.readFileSync(file)]));
    const defaultCleanup = recovery.cleanRuntime({ yes: true });
    assert.deepEqual(defaultCleanup.removed.map((entry) => entry.path).sort(), [path.relative(root, scratch.untracked)].sort());
    assert.ok(!fs.existsSync(scratch.untracked), "confirmed untracked scratch remains eligible for cleanup");
    for (const [file, bytes] of preservedBytes) assert.deepEqual(fs.readFileSync(file), bytes, `${path.basename(file)} bytes survive uncertain Git status`);
    assert.deepEqual(fs.readFileSync(path.join(plansDir, "COORD-1.json")), planBytes, "the default policy preserves ticket-local plan evidence");
    assert.equal(fs.readFileSync(unrelated, "utf8"), "retain operator notes");
    const reasons = new Map(defaultCleanup.skipped_protected.map((entry) => [entry.path, entry.reason]));
    assert.equal(reasons.get(".runtime/plans"), "ticket-local state (requires --include-ticket-state)");

    responseByName.plans = { status: 1, stdout: "", stderr: "", error: null, signal: null };
    const optedIn = recovery.cleanRuntime({ yes: true, includeTicketState: true });
    assert.ok(!fs.existsSync(plansDir), "a clean exit-1 permits deleting plans only after explicit opt-in");
    assert.ok(optedIn.removed.some((entry) => entry.path === ".runtime/plans"));

    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "COORD-1.json"), planBytes);
    responseByName.plans = { status: 128, stdout: "", stderr: "not a repository", error: null, signal: null };
    const refusedPlanCleanup = recovery.cleanRuntime({ yes: true, includeTicketState: true });
    assert.deepEqual(fs.readFileSync(path.join(plansDir, "COORD-1.json")), planBytes, "an operational Git failure preserves opted-in plan evidence");
    const refusedReasons = new Map(refusedPlanCleanup.skipped_protected.map((entry) => [entry.path, entry.reason]));
    assert.equal(refusedReasons.get(".runtime/plans"), "git tracking status unavailable; preserving path");
  });
});

test("COORD-1052: state lock status and recovery honor the lease for a different PID namespace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-owner-namespace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, ".agent-state.lock");
  const ownerPath = path.join(lockPath, "lock-owner.json");
  const ownerBytes = JSON.stringify({
    pid: process.pid, host: os.hostname(),
    boot_id: "50d52eed-0547-4b74-a367-9c40d49e9dc1", pid_ns: "pid:[4026531836]",
  });
  fs.mkdirSync(lockPath);
  fs.writeFileSync(ownerPath, ownerBytes);

  withScopedGovernanceTestContext({ RUNTIME_DIR: root, AGENT_STATE_LOCK_DIR: lockPath }, () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lockPath, minutesAgo, minutesAgo);
    const status = () => {
      const result = executeCommand(["runtime-lock-status", "--kind", "agent-state"]);
      assert.equal(result.ok, true, result.error);
      return JSON.parse(result.stdout);
    };
    const args = ["break-runtime-lock", "--kind", "agent-state", "--yes"];
    const fresh = status();
    assert.equal(fresh.owner_state, "unverifiable");
    assert.equal(fresh.reclaimable_now, false);
    assert.ok(fresh.reclaimable_after_ms > 23 * 60 * 60_000);
    const refused = executeCommand(args);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unknown ownership/);
    assert.equal(fs.readFileSync(ownerPath, "utf8"), ownerBytes);

    const expired = new Date(Date.now() - 25 * 60 * 60_000);
    fs.utimesSync(lockPath, expired, expired);
    const stale = status();
    assert.equal(stale.reclaimable_now, true);
    assert.equal(stale.reclaimable_after_ms, 0);
    const removed = executeCommand(args);
    assert.equal(removed.ok, true, removed.error);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("COORD-1052: staging sweep reports an empty dry run when there are no abandoned entries", () => {
  withCleanRuntimeFixture(({ runtimeDir }) => {
    const lockPath = path.join(runtimeDir, ".agent-state.lock");
    withScopedGovernanceTestContext({ AGENT_STATE_LOCK_DIR: lockPath }, () => {
      const result = executeCommand(["break-runtime-lock", "--kind", "agent-state", "--sweep-staging"]);
      assert.equal(result.ok, true, result.error);
      assert.match(result.stdout, /no abandoned staging artifacts/);
      assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))), {
        kind: "agent-state", dry_run: true, candidates: [],
      });
      assert.equal(fs.existsSync(path.join(runtimeDir, "recovery-receipts")), false);
    });
  });
});

test("COORD-1052: target collection is a no-op when the runtime is absent or obstructed by a file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-runtime-obstructed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, ".runtime");
  withScopedGovernanceTestContext({ RUNTIME_DIR: runtimeDir }, () => {
    assert.deepEqual(__testing.collectCleanRuntimeTargets(), { candidates: [], protected: [] });
    fs.writeFileSync(runtimeDir, "operator recovery data");
    assert.deepEqual(__testing.collectCleanRuntimeTargets(), { candidates: [], protected: [] });
    assert.equal(fs.readFileSync(runtimeDir, "utf8"), "operator recovery data");
  });
});
