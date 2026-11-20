"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canEstablishContainment, prepareManagedAuto, runManagedAuto } = require("./managed-auto-runner.js");
const { evaluateSensitivePath } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/sensitive-path-policy.js"));

const base = { ticket: "COORD-491", session: "s1", owner: "a1", base_sha: "abc", worktree: "/repo/.worktrees/t", provider: { name: "codex", version: "1", supported: true, enforceable: ["command", "read", "write"] }, controls: { hooks: true, sandbox: true, environment: true } };

test("managed-auto refuses incomplete provider or OS containment", () => {
  assert.equal(canEstablishContainment({ provider: { supported: true }, controls: { hooks: true, sandbox: false, environment: true } }), false);
  assert.throws(() => prepareManagedAuto({ ...base, controls: { hooks: true, sandbox: false, environment: true } }), /cannot be established/);
});

test("runner strips ambient secrets and keeps ordinary commands in the worktree", () => {
  const syntheticHome = ["/home", "user"].join("/");
  const syntheticSshKey = `${syntheticHome}/${[".ssh", "id_ed25519"].join("/")}`;
  const prepared = prepareManagedAuto({ ...base, environment: { PATH: "/bin", API_TOKEN: "raw", HOME: syntheticHome } });
  assert.equal(prepared.runtime_enforcement, "unimplemented");
  assert.deepEqual(prepared.environment, { PATH: "/bin" });
  assert.deepEqual(prepared.removed_environment_keys, ["API_TOKEN", "HOME"]);
  const run = runManagedAuto({ ...base, command: "node --version", spawn: (cmd, opts) => ({ cmd, opts }) });
  assert.equal(run.status, "completed");
  assert.equal(run.result.opts.cwd, base.worktree);
  assert.throws(() => runManagedAuto({ ...base, command: "git push origin main" }), /denied command/);
  assert.equal(evaluateSensitivePath("/repo/.worktrees/t/.env", { worktree: base.worktree }).decision, "deny");
  assert.equal(evaluateSensitivePath("/repo/.worktrees/t/.env.example", { worktree: base.worktree }).decision, "allow");
  assert.equal(evaluateSensitivePath(syntheticSshKey, { worktree: base.worktree }).decision, "deny");
});

// COORD-860: the recorded session is the production path that writes the
// action ledger and its digest-bound policy.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startManagedSession, managedEvidencePaths } = require("./managed-auto-runner.js");
const { CapabilityBroker } = require("./capability-broker.js");
const { readManagedLedger, verifyManagedLedgerFile } = require("./managed-auto-ledger.js");
const { policyDigest } = require("./managed-auto-policy.js");

function sessionFixture(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-860-run-")));
  const worktree = path.join(root, "wt");
  fs.mkdirSync(worktree);
  return { root, worktree, runtime: path.join(root, "runtime"), options: { ...base, worktree, runtime_dir: path.join(root, "runtime"), ...extra } };
}

test("COORD-860 runManagedAuto with a runtime directory records a complete single-command session", () => {
  const fx = sessionFixture({ environment: { PATH: "/bin" } });
  const run = runManagedAuto({ ...fx.options, command: "node --version", command_class: "test", spawn: () => "v" });
  assert.equal(run.status, "completed");
  assert.equal(run.evidence, "recorded");
  assert.equal(run.result, "v");
  const files = managedEvidencePaths(fx.runtime, base.ticket);
  const verdict = verifyManagedLedgerFile(files.ledger, { ticket: base.ticket });
  assert.equal(verdict.coverage, "complete");
  const policy = JSON.parse(fs.readFileSync(files.policy, "utf8"));
  assert.equal(policy.digest, policyDigest(policy));
  assert.equal(verdict.policy_digest, policy.digest);
  assert.throws(() => runManagedAuto({ ...fx.options, session: "s2", command: "git push origin dev", spawn: () => "x" }), /denied command/);
  assert.equal(runManagedAuto({ ...base, command: "node --version", spawn: () => "x" }).evidence, "unrecorded");
});

test("COORD-860 session defaults, unknown capabilities and nested policy fields are bound", () => {
  const fx = sessionFixture({ secrets: ["cnry-860-registered-1"], secret_references: [{ ref: "vault:x" }], broker_capabilities: ["custom.cap"], broker_targets: [{ capability: "custom.cap", target: "thing" }] });
  delete fx.options.environment;
  const session = startManagedSession(fx.options);
  assert.deepEqual(session.policy.secret_references, [{ ref: "vault:x", purposes: [] }]);
  const custom = new CapabilityBroker({ ticket: base.ticket, capabilities: ["custom.cap"], execute: () => ({ result: "completed" }) });
  const response = session.requestCapability(custom, { capability: "custom.cap", target: "thing", approved: true }, { action_id: "cap" });
  assert.equal(response.status, "completed");
  assert.equal(response.entry.receipt_target_class, "other");
  assert.equal(session.requestCapability(custom, {}, { action_id: "empty" }).status, "denied");
  assert.equal(readManagedLedger(session.files.ledger).entries.at(-1).resource, "unknown");
  session.heartbeat();
  session.interrupt("operator stop");
  assert.equal(verifyManagedLedgerFile(session.files.ledger).coverage, "interrupted");
  // The digest is deep: a nested change moves it, the derived field does not.
  const policy = session.policy;
  assert.equal(policyDigest({ ...policy, digest: "x" }), policy.digest);
  assert.notEqual(policyDigest({ ...policy, limits: { max_duration_ms: 1 } }), policy.digest);
  assert.match(policyDigest(undefined), /^[0-9a-f]{64}$/);
});

test("COORD-860 broker replays an idempotency key without executing again", () => {
  let calls = 0;
  const broker = new CapabilityBroker({ ticket: base.ticket, execute: () => { calls += 1; return { result: "completed" }; } });
  const first = broker.request({ capability: "scm.read", target: "origin/dev", approved: true, idempotency_key: "k1" });
  const second = broker.request({ capability: "scm.read", target: "origin/dev", approved: true, idempotency_key: "k1" });
  assert.equal(calls, 1);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(broker.request({ capability: "scm.read", target: "origin/dev", approved: true }).receipt.target_class, "scm-ref");
  const failing = new CapabilityBroker({ ticket: base.ticket, execute: () => { throw new Error("boom"); } });
  assert.deepEqual(failing.request({ capability: "scm.read", target: "origin/dev", approved: true }), { decision: "deny", reason: "broker execution failed", outcome: "unknown" });
});

test("COORD-860 policy, broker and path guards fail closed on every malformed input", () => {
  const { createManagedAutoPolicy, evaluateManagedAction } = require("./managed-auto-policy.js");
  const { requestCapability } = require("./capability-broker.js");
  assert.throws(() => createManagedAutoPolicy({ worktree: "/" }), /approved worktree/);
  assert.throws(() => createManagedAutoPolicy({ worktree: "/repo/wt" }), /are required/);
  assert.throws(() => createManagedAutoPolicy({}), /are required/);
  const unmanaged = createManagedAutoPolicy({ ticket: "T-1", session: "s", owner: "o", base_sha: "b", worktree: "/repo/wt", provider_name: "codex", provider: { version: "1" } });
  assert.equal(unmanaged.provider, "codex");
  assert.equal(unmanaged.evidence_coverage, "unmanaged");
  assert.equal(unmanaged.label, undefined);
  const partial = createManagedAutoPolicy({ ...base, controls: undefined, secret_references: [{ ref: "vault:b", purposes: ["x"] }, { ref: "vault:a", purposes: ["y"] }] });
  assert.equal(partial.evidence_coverage, "partial");
  assert.deepEqual(partial.secret_references.map((entry) => entry.ref), ["vault:a", "vault:b"]);
  assert.deepEqual(evaluateManagedAction(unmanaged, { kind: "command", command: "ls" }), { decision: "deny", reason: "containment unavailable" });
  const policy = prepareManagedAuto(base).policy;
  assert.equal(evaluateManagedAction(policy, { kind: "git", verb: "push", branch: "dev" }).decision, "deny");
  assert.equal(evaluateManagedAction(policy, { kind: "teleport" }).reason, "unsupported action");
  assert.equal(evaluateManagedAction(policy, { kind: "write", path: "/elsewhere/x.txt" }).decision, "deny");
  assert.equal(evaluateSensitivePath("/srv/vault/x", { sensitiveRoots: ["/srv/vault"] }).reason, "configured sensitive root");
  assert.equal(runManagedAuto({ ...base, command: "node --version" }).status, "prepared");
  // Broker construction and request validation.
  assert.throws(() => new CapabilityBroker({ execute: () => ({}) }), /ticket and broker executor/);
  const broker = new CapabilityBroker({ ticket: base.ticket, execute: () => ({}) });
  assert.equal(broker.request({ target: "origin/dev", approved: true }).decision, "deny");
  assert.equal(broker.request({ capability: "scm.read", target: "origin/dev", ticket: "OTHER-1", approved: true }).reason, "ticket mismatch");
  assert.equal(requestCapability(broker, { capability: "scm.read", target: "origin/dev", approved: true }).receipt.result, "completed");
  assert.throws(() => requestCapability(null, {}), /CapabilityBroker is required/);
});
