"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveCoordDir } = require("./runtime-authority-hook.js");
const HOOK = path.join(__dirname, "runtime-authority-hook.js");

function fixture(t, active = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-hook-behavior-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, ".runtime");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  if (active) write(path.join(runtime, "locks", "TEST-1052.lock"), {
    ticket: "TEST-1052", owner: "claudea1", status: "doing", worktree, identity_model: "v2",
  });
  const registry = path.join(runtime, "identity", "instances.json");
  write(registry, { version: 1, instances: [{ instance_id: "fixture-instance", owner: "claudea1", provider: "claude", status: "active", heartbeat_at: new Date().toISOString() }], leases: { claudea1: { instance_id: "fixture-instance" } } });
  const preload = path.join(root, "runtime-view.cjs");
  fs.writeFileSync(preload, `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const original = Module._load;
const entry = process.argv[1];
function redirect(file) {
  const marker = path.sep + ".runtime";
  const value = String(file);
  const at = value.indexOf(marker);
  if (at < 0) throw Error("unexpected state access: " + value);
  const suffix = value.slice(at + marker.length);
  const target = path.resolve(process.env.CONCORD_HOOK_RUNTIME, "." + suffix);
  const base = path.resolve(process.env.CONCORD_HOOK_RUNTIME);
  if (target !== base && !target.startsWith(base + path.sep)) throw Error("fixture state escape");
  return target;
}
const view = { ...fs };
for (const name of ["existsSync", "readdirSync", "readFileSync", "mkdirSync"]) {
  view[name] = (file, ...args) => fs[name](redirect(file), ...args);
}
Module._load = function(request, parent, isMain) {
  if (!parent || parent.filename !== entry) return original.call(this, request, parent, isMain);
  if (request === "node:fs") return view;
  const actual = original.call(this, request, parent, isMain);
  if (request === "./runtime-authority.js") return {
    ...actual,
    registerSubagent: (file, ...args) => actual.registerSubagent(redirect(file), ...args),
    finishSubagent: (file, ...args) => actual.finishSubagent(redirect(file), ...args),
  };
  if (path.basename(request) === "auto-mode-ledger.js") return {
    ...actual,
    appendEntry(file, ...args) {
      if (process.env.CONCORD_HOOK_FAULT === "audit") throw Error("fixture audit unavailable");
      return actual.appendEntry(redirect(file), ...args);
    },
  };
  if (request === "./runtime-authority-decision.js" && process.env.CONCORD_HOOK_FAULT === "decision") return {
    ...actual, decide() { throw Error("fixture decision unavailable"); },
  };
  if (request === "./runtime-authority-decision.js" && process.env.CONCORD_HOOK_FAULT === "enumeration") return {
    ...actual, enumerateLocks() { throw "fixture lock enumeration unavailable"; },
  };
  if (request === "./hooks/hook-stdin.js" && process.env.CONCORD_HOOK_FAULT === "stdin") return {
    ...actual, async acquireHookPayload() { throw Error("fixture stdin unavailable"); },
  };
  return actual;
};
`);
  function run(payload, { event, fault = "", invalidActor = false } = {}) {
    const env = { ...process.env, COORD_PROVIDER: "claude", COORD_INSTANCE_ID: invalidActor ? "missing-instance" : "fixture-instance", COORD_INSTANCE_TTL: "900", CONCORD_HOOK_RUNTIME: runtime, CONCORD_HOOK_FAULT: fault };
    delete env.TOOL_INPUT;
    const args = ["--require", preload, HOOK];
    if (event) args.push(`--subagent-${event}`);
    const result = spawnSync(process.execPath, args, { cwd: worktree, env, input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  function entries(name = "TEST-1052") {
    const file = path.join(runtime, "action-ledgers", `${name}.ndjson`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  }
  return { run, entries, registry, runtime, worktree };
}

test("canonical authority hook refuses malformed payloads and keeps refusal when auditing fails", (t) => {
  const f = fixture(t);
  for (const payload of ["{broken", "[]", "null", "42"]) {
    const result = f.run(payload);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CONCORD DENY \[payload_unavailable\]/);
    assert.match(result.stderr, /OUT-OF-BAND RECOVERY/);
  }
  assert.equal(f.entries("_authority-barrier").length, 4);
  assert.ok(f.entries("_authority-barrier").every(e => e.code === "payload_unavailable" && e.decision === "deny"));
  const failedAudit = f.run("{broken", { fault: "audit" });
  assert.equal(failedAudit.status, 2, failedAudit.stderr);
  assert.equal(f.entries("_authority-barrier").length, 4);
});

test("canonical authority hook scopes decision and acquisition crashes to active governed work", (t) => {
  for (const active of [true, false]) {
    const f = fixture(t, active);
    for (const fault of ["decision", "stdin"]) {
      const result = f.run({ tool_name: "Bash", tool_input: { command: "git status" } }, { fault });
      assert.equal(result.status, active ? 2 : 0, result.stderr);
      assert.match(result.stderr, /CONCORD BARRIER ERROR: fixture/);
      if (active) assert.match(result.stderr, /OUT-OF-BAND RECOVERY/);
      else assert.doesNotMatch(result.stderr, /OUT-OF-BAND RECOVERY/);
    }
  }
});

test("canonical authority hook reports a lock enumerator crash even when the recovery probe also fails", (t) => {
  const f = fixture(t, false);
  const result = f.run({ tool_name: "Bash", tool_input: { command: "git status" } }, { fault: "enumeration" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CONCORD BARRIER ERROR: fixture lock enumeration unavailable/);
  assert.doesNotMatch(result.stderr, /OUT-OF-BAND RECOVERY/);
});

test("a hook installed in a ticket worktree reads the canonical workspace locks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-hook-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  const checkout = path.join(coord, ".worktrees", "claudea1", "TEST-1052");
  const installed = path.join(checkout, "coord");
  const scripts = path.join(installed, "engine", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  assert.equal(resolveCoordDir(scripts), coord);
  const hook = path.join(scripts, path.basename(HOOK));
  fs.copyFileSync(HOOK, hook);
  fs.copyFileSync(path.resolve(__dirname, "../../paths.js"), path.join(installed, "paths.js"));
  for (const name of ["runtime-authority.js", "runtime-authority-decision.js", "runtime-authority-subagent.js", "auto-mode-ledger.js", "hooks"]) {
    fs.symlinkSync(path.join(__dirname, name), path.join(scripts, name));
  }
  const locks = path.join(coord, ".runtime", "locks");
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(path.join(locks, "TEST-1052.lock"), JSON.stringify({ ticket: "TEST-1052", status: "doing", worktree: checkout }));
  const env = { ...process.env };
  delete env.TOOL_INPUT;
  const result = spawnSync(process.execPath, [hook], { cwd: checkout, env, input: "{broken", encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /CONCORD DENY \[payload_unavailable\]/);
  const ledger = path.join(".runtime", "action-ledgers", "_authority-barrier.ndjson");
  const entry = JSON.parse(fs.readFileSync(path.join(coord, ledger), "utf8"));
  assert.equal(entry.code, "payload_unavailable");
  assert.equal(fs.existsSync(path.join(installed, ledger)), false);
});

test("canonical authority hook records allowed ticket writes and blocks unresolved canonical writes", (t) => {
  const f = fixture(t);
  const payload = { tool_use_id: "fixture-action", tool_name: "Write", tool_input: { file_path: path.join(f.worktree, "output.txt"), content: "example" } };
  const allowed = f.run(payload);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.ok(f.entries().some(e => e.action_id === "fixture-action" && e.decision === "allow" && e.actor_resolved));
  const canonicalQuestions = path.join(path.resolve(__dirname, "../../.."), "QUESTIONS.md");
  const denied = f.run({ ...payload, tool_input: { ...payload.tool_input, file_path: canonicalQuestions } }, { invalidActor: true });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /CONCORD DENY/);
  assert.equal(fs.existsSync(path.join(f.worktree, "output.txt")), false, "a policy hook never executes the proposed write");
});

test("canonical subagent hook preserves the parent registry and records actual start and stop state", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.registry, "utf8");
  const payload = { agent_id: "fixture-child", summary: "Completed bounded work" };
  for (const event of ["start", "stop"]) {
    const result = f.run(payload, { event });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.registry, "utf8"), before);
  }
  const topology = JSON.parse(fs.readFileSync(path.join(f.runtime, "subagents", "TEST-1052.json")));
  assert.equal(topology.subagents["fixture-child"].status, "finished");
  assert.equal(topology.subagents["fixture-child"].explained, true);
  assert.deepEqual(f.entries().map(e => e.type), ["subagent_start", "subagent_stop"]);
  const unknownStop = f.run({ agent_id: "unknown-child" }, { event: "stop" });
  assert.equal(unknownStop.status, 2, unknownStop.stderr);
  assert.match(unknownStop.stderr, /unknown subagent session/);
  const missingStop = f.run({}, { event: "stop" });
  assert.equal(missingStop.status, 2, missingStop.stderr);
  assert.match(missingStop.stderr, /unknown subagent session/);
  assert.deepEqual(f.entries().map(e => e.type), ["subagent_start", "subagent_stop"]);
  const missingIdentity = f.run({}, { event: "start" });
  assert.equal(missingIdentity.status, 2, missingIdentity.stderr);
  assert.match(missingIdentity.stderr, /no stable identity/);
});


test("canonical subagent hook refuses an unresolved live parent without changing fixture state", (t) => {
  const f = fixture(t);
  const registryBefore = fs.readFileSync(f.registry, "utf8");
  const lockPath = path.join(f.runtime, "locks", "TEST-1052.lock");
  const lockBefore = fs.readFileSync(lockPath, "utf8");
  const denied = f.run({ agent_id: "child-without-parent" }, { event: "start", invalidActor: true });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /subagent_identity_unresolved_instance/);
  assert.equal(fs.readFileSync(f.registry, "utf8"), registryBefore, "refusal must not change owner registry bytes");
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockBefore, "refusal must not change lock evidence");
  assert.equal(fs.existsSync(path.join(f.runtime, "subagents", "TEST-1052.json")), false);
  assert.equal(fs.existsSync(path.join(f.runtime, "action-ledgers", "TEST-1052.ndjson")), false);
});

test("canonical subagent stop records an unexplained completion when the summary is empty", (t) => {
  const f = fixture(t);
  const started = f.run({ session_id: "fixture-child" }, { event: "start" });
  assert.equal(started.status, 0, started.stderr);
  const stopped = f.run({ session_id: "fixture-child", summary: "  " }, { event: "stop" });
  assert.equal(stopped.status, 0, stopped.stderr);
  const topology = JSON.parse(fs.readFileSync(path.join(f.runtime, "subagents", "TEST-1052.json"), "utf8"));
  assert.equal(topology.subagents["fixture-child"].status, "finished");
  assert.equal(topology.subagents["fixture-child"].explained, false);
  const stopEvent = f.entries().at(-1);
  assert.equal(stopEvent.type, "subagent_stop");
  assert.equal(stopEvent.actor_session, "fixture-child");
  assert.equal(stopEvent.explained, false);
});
