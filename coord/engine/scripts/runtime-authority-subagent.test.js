"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// COORD-930: the barrier's canonical coord dir is its own install location, so a
// fixture installs a copy of the entry hook under coord/engine/scripts. Other engine
// modules are symlinks to the real files.
function installAuthorityHook(coordDir) {
  const scripts = path.join(coordDir, "engine", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const entry of fs.readdirSync(__dirname)) {
    if (entry !== "runtime-authority-hook.js") fs.symlinkSync(path.join(__dirname, entry), path.join(scripts, entry));
  }
  fs.copyFileSync(path.join(__dirname, "runtime-authority-hook.js"), path.join(scripts, "runtime-authority-hook.js"));
  fs.symlinkSync(path.join(__dirname, "..", "..", "paths.js"), path.join(coordDir, "paths.js"));
  return path.join(scripts, "runtime-authority-hook.js");
}

function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-subagent-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  const HOOK = installAuthorityHook(coord);
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  const write = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); };
  const lock = { ticket: "TEST-652", owner: "claudea1", status: "doing", worktree,
    session_id: legacy ? "obsolete-session" : null, identity_model: legacy ? null : "v2" };
  write(path.join(coord, ".runtime/locks/TEST-652.lock"), lock);
  const registryFile = path.join(coord, ".runtime/identity/instances.json");
  const registry = { version: 1, instances: [{ instance_id: "live-instance", owner: lock.owner,
    provider: "claude", status: "active", heartbeat_at: new Date().toISOString() }],
    leases: { [lock.owner]: { instance_id: "live-instance" } } };
  const env = { ...process.env, COORD_PROVIDER: "claude",
    COORD_INSTANCE_ID: "live-instance", COORD_PROVIDER_SESSION_ID: "diagnostic-session", COORD_INSTANCE_TTL: "900" };
  delete env.TOOL_INPUT;
  const supervisor = path.join(coord, ".runtime/subagents/TEST-652.json");
  const ledger = path.join(coord, ".runtime/action-ledgers/TEST-652.ndjson");
  const bytes = p => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  return { registry, registryFile, coord, env, supervisor, ledger, save: () => write(registryFile, registry),
    snapshot: () => [registryFile, supervisor, ledger].map(bytes),
    run: event => spawnSync(process.execPath, [HOOK, `--subagent-${event}`], { cwd: worktree, env,
      input: JSON.stringify({ agent_id: "child", summary: "Completed bounded work" }), encoding: "utf8", timeout: 10000 }) };
}

for (const legacy of [false, true]) test(`real hook records start and stop through owner lease (${legacy ? "legacy" : "v2 null-session"} lock)`, t => {
  const f = fixture(t, legacy); f.save();
  const registryBefore = f.snapshot()[0];
  for (const event of ["start", "stop"]) {
    const result = f.run(event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.snapshot()[0], registryBefore, "hook must not claim or refresh identity");
  }
  const child = JSON.parse(fs.readFileSync(f.supervisor)).subagents.child;
  assert.equal(child.parent_session, "live-instance");
  assert.equal(child.status, "finished");
  assert.equal(child.explained, true);
  const entries = fs.readFileSync(f.ledger, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.map(e => e.type), ["subagent_start", "subagent_stop"]);
  assert.ok(entries.every(e => e.parent_session === "live-instance"));
});

const cases = {
  missing_channel: f => { delete f.env.COORD_INSTANCE_ID; },
  unregistered: f => { f.registry.instances = []; },
  wrong_provider: f => { f.registry.instances[0].provider = "codex"; },
  wrong_owner: f => { f.registry.instances[0].owner = "claudea2"; },
  stale: f => { f.registry.instances[0].heartbeat_at = "2000-01-01T00:00:00Z"; },
  revoked: f => { f.registry.instances[0].status = "revoked"; },
  missing_lease: f => { f.registry.leases = {}; },
  moved_lease: f => { f.registry.leases.claudea1.instance_id = "another-instance"; },
  split_brain: f => { f.registry.instances.push({ ...f.registry.instances[0], instance_id: "another-instance" }); },
  duplicate_instance: f => { f.registry.instances.push({ ...f.registry.instances[0] }); },
  invalid_registry: f => { f.registry.instances.push(null); },
};
for (const [name, invalidate] of Object.entries(cases)) test(`real hook refuses ${name} before topology writes on start and stop`, t => {
  const f = fixture(t, true); f.save();
  const start = f.run("start"); assert.equal(start.status, 0, start.stderr);
  invalidate(f); f.save();
  const before = f.snapshot();
  for (const event of ["start", "stop"]) {
    const result = f.run(event);
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /CONCORD DENY \[subagent_identity_/);
    assert.match(result.stderr, /gov claim TEST-652 --owner claudea1/);
    assert.doesNotMatch(result.stderr, /BARRIER ERROR/);
    assert.deepEqual(f.snapshot(), before, "refusal must preserve registry and topology bytes");
  }
});

test("missing or malformed registry refuses legacy token fallback without writing state", t => {
  const f = fixture(t, true); f.save();
  for (const contents of [null, "{broken", "null"]) {
    if (contents === null) fs.rmSync(f.registryFile);
    else fs.writeFileSync(f.registryFile, contents);
    const before = f.snapshot();
    for (const event of ["start", "stop"]) {
      const result = f.run(event);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /subagent_identity_invalid_registry/);
      assert.deepEqual(f.snapshot(), before);
    }
  }
});

test("a stale competing instance does not block the fresh holder and diagnostic tokens are ignored", t => {
  const f = fixture(t);
  f.registry.instances.push({ ...f.registry.instances[0], instance_id: "old", heartbeat_at: "2000-01-01T00:00:00Z" });
  delete f.env.COORD_PROVIDER_SESSION_ID;
  f.save();
  const result = f.run("start");
  assert.equal(result.status, 0, result.stderr);
});

test("no governed lock preserves the outside-ticket hook no-op", t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.coord, ".runtime/locks/TEST-652.lock"));
  delete f.env.COORD_INSTANCE_ID;
  for (const event of ["start", "stop"]) assert.equal(f.run(event).status, 0);
  assert.deepEqual(f.snapshot(), [null, null, null]);
});
