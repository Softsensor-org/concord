"use strict";

// COORD-860: managed-auto reconciliation through the production session
// recorder, the real capability broker, a real Git worktree and the existing
// v2 ledger/verifier. Every fixture is synthetic and lives under os.tmpdir().

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COORD = path.resolve(__dirname, "../..");
const { startManagedSession, managedEvidencePaths } = require(path.join(COORD, "engine/scripts/managed-auto-runner.js"));
const { CapabilityBroker } = require(path.join(COORD, "engine/scripts/capability-broker.js"));
const ledger = require(path.join(COORD, "engine/scripts/managed-auto-ledger.js"));
const { policyDigest } = require(path.join(COORD, "engine/scripts/managed-auto-policy.js"));
const reconcile = require("./managed-auto-reconcile.js");

const TICKET = "COORD-860";
const CANARY = "cnry-860-secret-4f1c9a2b7d";
const CANARY_EXTERNAL = "cnry-860-external-9e3b11";

const { gitFixture } = require("./test-git-fixture.js");

function git(dir, ...args) {
  return gitFixture(dir, args);
}

function fixture(t, { provider = "codex", networkAllow = ["api.example.com"], egress } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-860-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "wt");
  fs.mkdirSync(worktree);
  gitFixture(worktree, ["init", "-q"]);
  git(worktree, "config", "user.email", "fixture@example.invalid");
  git(worktree, "config", "user.name", "fixture");
  fs.writeFileSync(path.join(worktree, "a.txt"), "1\n");
  fs.writeFileSync(path.join(worktree, "keep.txt"), "k\n");
  git(worktree, "add", ".");
  gitFixture(worktree, ["commit", "-qm", "init"]);
  const base = git(worktree, "rev-parse", "HEAD");
  const runtimeDir = path.join(root, "runtime");
  const options = {
    ticket: TICKET, session: "sess-860", owner: "claudea12", base_sha: base, worktree,
    provider: { name: provider, version: "1.0.0", supported: true, enforceable: ["command", "read", "write"] },
    controls: { hooks: true, sandbox: true, environment: true },
    environment: { PATH: process.env.PATH, API_TOKEN: CANARY },
    runtime_dir: runtimeDir, network_allow: networkAllow,
    secret_references: [{ ref: "vault:npm-publish", purposes: ["publish"] }],
    broker_capabilities: ["scm.submit"],
    broker_targets: ["origin/agent-860", "origin/a", "origin/b", "origin/c", "origin/z"].map((target) => ({ capability: "scm.submit", target })),
    ...(egress ? { network_allow: egress } : {}),
  };
  return { root, worktree, base, runtimeDir, options, files: managedEvidencePaths(runtimeDir, TICKET) };
}

function broker(execute = () => ({ result: "completed", external_id: CANARY_EXTERNAL })) {
  return new CapabilityBroker({ ticket: TICKET, execute });
}

// A complete session that exercises every effect class inside its scope.
function completeSession(fx) {
  const session = startManagedSession(fx.options);
  session.writeFile("a.txt", "2\n", { action_id: "write-a" });
  session.runCommand("node --version", { action_id: "test-1", command_class: "test" });
  session.commit("change a", { action_id: "commit-1" });
  session.egress("https://api.example.com/v1", () => "ok", { action_id: "egress-1" });
  session.useSecretReference("vault:npm-publish", "publish", () => CANARY, { action_id: "secret-1" });
  session.requestCapability(broker(), { capability: "scm.submit", target: "origin/agent-860", approved: true }, { action_id: "submit-1" });
  return session;
}

function run(fx, extra = {}) {
  return reconcile.reconcileManagedExecution({ ticketId: TICKET, runtimeDir: fx.runtimeDir, declaredFiles: ["a.txt"], ...extra });
}

function appendRaw(fx, body) {
  const { entries } = ledger.readManagedLedger(fx.files.ledger);
  const entry = ledger.createManagedEntry(body, entries.at(-1) || null);
  fs.appendFileSync(fx.files.ledger, `${JSON.stringify(entry)}\n`);
  return entry;
}

function lastAction(fx) {
  return ledger.readManagedLedger(fx.files.ledger).entries.filter((entry) => entry.type === "action").at(-1);
}

test("a complete in-scope managed session reconciles every class to a complete, redacted summary", (t) => {
  const fx = fixture(t);
  completeSession(fx).end("done");
  const { summary, diagnostics } = run(fx);
  assert.equal(summary.verdict, "complete", JSON.stringify(summary));
  assert.deepEqual(summary.gaps, []);
  assert.deepEqual(summary.unexplained, []);
  assert.deepEqual(diagnostics, []);
  assert.equal(summary.integrity, "valid");
  assert.equal(summary.coverage, "complete");
  assert.equal(summary.chain_root, ledger.verifyManagedLedgerFile(fx.files.ledger).chain_root);
  assert.equal(summary.policy_digest, JSON.parse(fs.readFileSync(fx.files.policy, "utf8")).digest);
  assert.equal(summary.base_commit, fx.base);
  assert.equal(summary.head_commit, git(fx.worktree, "rev-parse", "HEAD"));
  assert.match(summary.diff_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(summary.summary_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.counts.by_class, { command: 1, file: 1, git: 2, network: 1, secret: 1 });
  assert.equal(summary.counts.changed_paths, 1);
  assert.equal(summary.counts.commits, 1);
  const serialized = JSON.stringify(summary);
  for (const leak of [CANARY, CANARY_EXTERNAL, "a.txt", "origin/agent-860", "node --version", "api.example.com", "vault:npm-publish", fx.worktree]) {
    assert.equal(serialized.includes(leak), false, `summary must not carry ${leak}`);
  }
  assert.equal(fs.readFileSync(fx.files.ledger, "utf8").includes(CANARY), false);
  assert.equal(fs.readFileSync(fx.files.ledger, "utf8").includes(CANARY_EXTERNAL), false);
  // Deterministic: the same evidence reconciles to the same digest.
  assert.equal(run(fx).summary.summary_digest, summary.summary_digest);
  assert.deepEqual(reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: { intended_files: ["a.txt"], managed_execution: { summary } }, runtimeDir: fx.runtimeDir }), { label: "complete", issues: [] });
});

test("unexplained Git, file and commit effects are named, and changed Git state stales a recorded summary", (t) => {
  const fx = fixture(t);
  const session = completeSession(fx);
  session.end("done");
  const recorded = run(fx).summary;
  // Unrecorded write, untracked file, deletion and an unrecorded commit.
  fs.writeFileSync(path.join(fx.worktree, "a.txt"), "tampered\n");
  fs.writeFileSync(path.join(fx.worktree, "new.txt"), "n\n");
  fs.rmSync(path.join(fx.worktree, "keep.txt"));
  const { summary, diagnostics } = run(fx);
  assert.equal(summary.verdict, "unexplained");
  assert.deepEqual(summary.unexplained, ["file_digest_mismatch:file", "out_of_scope_file:file", "unexplained_file_change:file"]);
  assert.ok(diagnostics.every((entry) => Object.keys(entry).join() === "code,class,sequence"));
  const gate = reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: { intended_files: ["a.txt"], managed_execution: { summary: recorded } }, runtimeDir: fx.runtimeDir });
  assert.equal(gate.label, "blocked");
  assert.equal(gate.issues[0].code, "managed_evidence_stale");
  assert.match(gate.issues[0].message, /not a legal waiver/);
  git(fx.worktree, "checkout", "--", "a.txt", "keep.txt");
  fs.rmSync(path.join(fx.worktree, "new.txt"));
  fs.writeFileSync(path.join(fx.worktree, "a.txt"), "3\n");
  git(fx.worktree, "commit", "-qam", "unrecorded");
  const afterCommit = run(fx).summary;
  assert.ok(afterCommit.unexplained.includes("unexplained_commit:git"));
  assert.ok(afterCommit.unexplained.includes("file_digest_mismatch:file"));
});

test("session-enforced policy denies out-of-scope secret and broker use before dispatch", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  let resolved = 0;
  assert.equal(session.useSecretReference("vault:npm-publish", "deploy", () => { resolved += 1; }, { action_id: "s-purpose" }).status, "denied");
  assert.equal(session.useSecretReference("vault:unknown", "publish", () => { resolved += 1; }, { action_id: "s-unknown" }).status, "denied");
  assert.equal(session.requestCapability(broker(), { capability: "package.registry", target: "left-pad", approved: true }, { action_id: "pkg" }).status, "denied");
  assert.equal(session.egress("https://evil.example.net/", () => { resolved += 1; }, { action_id: "e-out" }).status, "denied");
  assert.equal(resolved, 0, "denied effects never dispatch");
  // An out-of-scope command class still runs (the class is the caller's claim) and is unexplained.
  session.runCommand("node --version", { action_id: "other-cmd", command_class: "other" });
  // Adapter-observed secret use the session did not authorize.
  session.recorder.beginAction({ kind: "secret", tool: "codex-env", decision: "allow", secret_ref: "vault:unknown", purpose: "publish", action_id: "obs-secret", attempt_id: "1" });
  session.recorder.completeAction({ action_id: "obs-secret", attempt_id: "1", result: "completed" });
  session.recorder.beginAction({ kind: "mcp", tool: "capability-broker", decision: "allow", operation: "package.registry", action_id: "obs-broker", attempt_id: "1" });
  session.recorder.completeAction({ action_id: "obs-broker", attempt_id: "1", result: "completed", receipt: {
    receipt_id: "r1", ticket: TICKET, capability: "package.registry", target_class: "package", target_digest: "a".repeat(64), result: "completed",
  } });
  session.end("done");
  const { summary } = run(fx);
  assert.equal(summary.integrity, "valid");
  assert.deepEqual(summary.unexplained, ["out_of_scope_command:command", "out_of_scope_remote_target:mcp", "unexplained_remote_effect:mcp", "unexplained_secret_use:secret"]);
});

test("each non-file class reconciles allowed effects and names unexplained ones on a valid chain", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  const rec = session.recorder;
  const ids = (id) => ({ action_id: id, attempt_id: "1" });
  // Adapter-observed effects recorded through the production recorder.
  rec.beginAction({ kind: "network", tool: "codex-net", decision: "allow", destination: "https://evil.example.net/x", ...ids("net-out") });
  rec.completeAction({ ...ids("net-out"), result: "completed" });
  rec.beginAction({ kind: "network", tool: "codex-net", decision: "allow", destination: "api.example.com:8443", ...ids("net-port") });
  rec.completeAction({ ...ids("net-port"), result: "completed" });
  rec.beginAction({ kind: "git", tool: "Bash", decision: "allow", operation: "push", ...ids("push") });
  rec.completeAction({ ...ids("push"), result: "completed" });
  rec.beginAction({ kind: "mcp", tool: "mcp__x__write", decision: "allow", operation: "write", ...ids("mcp-1") });
  rec.completeAction({ ...ids("mcp-1"), result: "completed" });
  rec.beginAction({ kind: "governance", tool: "gov", decision: "allow", operation: "submit", ...ids("gov-1") });
  rec.completeAction({ ...ids("gov-1"), result: "completed" });
  // Denied actions never dispatch and are not effects.
  const denied = session.runCommand("git push origin dev", { action_id: "deny-1", command_class: "git-local" });
  assert.equal(denied.status, "denied");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord860-outside-"));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outsideFile = path.join(outsideDir, "outside-860.txt");
  const deniedWrite = session.writeFile(outsideFile, "x", { action_id: "deny-2" });
  assert.equal(deniedWrite.status, "denied");
  session.end("done");
  const { summary } = run(fx, { declaredFiles: ["a.txt"] });
  assert.equal(summary.integrity, "valid");
  assert.equal(summary.verdict, "unexplained");
  assert.deepEqual(summary.unexplained, ["unattributed_remote_effect:mcp", "unexplained_egress:network", "unexplained_remote_effect:git"]);
  assert.equal(fs.existsSync(outsideFile), false);
});

test("missing receipts, missing results, interruption and missing adapter coverage are explicit gaps", (t) => {
  const fx = fixture(t, { provider: "claude" });
  const session = startManagedSession({ ...fx.options, spawn: () => { const error = new Error("killed"); error.signal = "SIGTERM"; throw error; } });
  const rec = session.recorder;
  // Broker attempt with an unknown outcome: no terminal result, never retried.
  const unknown = session.requestCapability(broker(() => { throw new Error("network down"); }), { capability: "scm.submit", target: "origin/a", approved: true }, { action_id: "submit-unknown" });
  assert.equal(unknown.status, "unknown");
  assert.throws(() => session.requestCapability(broker(), { capability: "scm.submit", target: "origin/a", approved: true }, { action_id: "submit-unknown" }), /unknown_outcome/);
  assert.throws(() => session.requestCapability(broker(), { capability: "scm.submit", target: "origin/a", approved: true }, { action_id: "submit-unknown", attempt_id: "2" }), /unknown_outcome/);
  // A broker result recorded without its receipt.
  rec.beginAction({ kind: "git", tool: "capability-broker", decision: "allow", operation: "scm.submit", action_id: "no-receipt", attempt_id: "1" });
  rec.completeAction({ action_id: "no-receipt", attempt_id: "1", result: "completed" });
  // An interrupted process (the spawn reports a signal).
  assert.throws(() => session.runCommand("node -e 1", { action_id: "proc-1", command_class: "test" }), /killed/);
  session.end("done");
  const { summary } = run(fx);
  assert.equal(summary.verdict, "incomplete");
  assert.deepEqual(summary.gaps, ["adapter_coverage_missing:network", "interrupted_effect:command", "receipt_missing:git", "result_missing:git"]);
});

test("a failing process records a failed result and its retry never repeats a completed effect", (t) => {
  const fx = fixture(t);
  let calls = 0;
  const session = startManagedSession({ ...fx.options, spawn: () => { calls += 1; if (calls === 1) throw new Error("exit 1"); return "ok"; } });
  assert.throws(() => session.runCommand("node -e 1", { action_id: "proc", command_class: "test" }), /exit 1/);
  const retry = session.runCommand("node -e 1", { action_id: "proc", attempt_id: "2", command_class: "test" });
  assert.equal(retry.status, "completed");
  const replay = session.runCommand("node -e 1", { action_id: "proc", attempt_id: "2", command_class: "test" });
  assert.equal(replay.status, "replayed");
  assert.equal(calls, 2, "a replayed attempt never dispatches again");
  assert.throws(() => session.runCommand("node -e 1", { action_id: "proc", attempt_id: "3", command_class: "test" }), /duplicate_effect/);
  // Broker replay returns the same receipt and executes once.
  let executed = 0;
  const shared = broker(() => { executed += 1; return { result: "completed" }; });
  const first = session.requestCapability(shared, { capability: "scm.submit", target: "origin/b", approved: true }, { action_id: "submit-r" });
  const second = session.requestCapability(shared, { capability: "scm.submit", target: "origin/b", approved: true }, { action_id: "submit-r" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "replayed");
  assert.equal(executed, 1);
  // A broker denial is a denied result without dispatch.
  const refused = session.requestCapability(shared, { capability: "scm.submit", target: "origin/b" }, { action_id: "submit-unapproved" });
  assert.equal(refused.status, "denied");
  const undeclared = session.requestCapability(shared, { capability: "package.registry", target: "x" }, { action_id: "undeclared" });
  assert.equal(undeclared.status, "denied");
  assert.throws(() => session.requestCapability(shared, { capability: "scm.submit", target: `origin/${CANARY}`, approved: true }, { action_id: "unsafe" }), /unsafe_value/);
  assert.equal(session.requestCapability(broker(() => ({ result: "completed", external_id: CANARY })), { capability: "scm.submit", target: "origin/c", approved: true }, { action_id: "unsafe-ext" }).status, "unknown");
  session.end("done");
  const { summary } = run(fx, { declaredFiles: [] });
  assert.equal(summary.counts.by_class.command, 2);
  assert.ok(summary.gaps.includes("declared_scope_missing:file"));
  assert.ok(summary.gaps.includes("result_missing:git"), "the unsafe external id left an attempt without a result");
});

test("tampered, truncated, corrupt and policy-mismatched evidence is invalid, never complete", (t) => {
  const fx = fixture(t);
  completeSession(fx).end("done");
  const pristine = fs.readFileSync(fx.files.ledger, "utf8");
  const lines = pristine.trim().split("\n");
  // Tamper one recorded field.
  fs.writeFileSync(fx.files.ledger, `${pristine.replace('"command_class":"test"', '"command_class":"other"')}`);
  assert.equal(run(fx).summary.verdict, "invalid");
  // Truncated tail: no session_end.
  fs.writeFileSync(fx.files.ledger, `${lines.slice(0, -1).join("\n")}\n`);
  const truncated = run(fx).summary;
  assert.equal(truncated.verdict, "incomplete");
  assert.ok(truncated.gaps.includes("coverage_interrupted"));
  assert.ok(truncated.gaps.includes("missing_end"));
  // Corrupt line.
  fs.writeFileSync(fx.files.ledger, `${pristine}{not json\n`);
  assert.equal(run(fx).summary.verdict, "invalid");
  fs.writeFileSync(fx.files.ledger, pristine);
  // A nested policy change (secret reference purposes) changes the digest and unbinds the chain.
  const policy = JSON.parse(fs.readFileSync(fx.files.policy, "utf8"));
  policy.secret_references[0].purposes.push("deploy");
  assert.notEqual(policyDigest(policy), policy.digest);
  policy.digest = policyDigest(policy);
  fs.writeFileSync(fx.files.policy, JSON.stringify(policy));
  const mismatch = run(fx).summary;
  assert.equal(mismatch.verdict, "invalid");
  assert.ok(mismatch.gaps.includes("policy_digest_mismatch"));
  assert.equal(mismatch.diff_digest, null);
  // An edited policy that keeps its stale digest is also unbound.
  policy.digest = "0".repeat(64);
  fs.writeFileSync(fx.files.policy, JSON.stringify(policy));
  assert.ok(run(fx).summary.gaps.includes("policy_digest_mismatch"));
  fs.writeFileSync(fx.files.policy, "{");
  assert.ok(run(fx).summary.gaps.includes("policy_missing"));
  for (const shape of [null, { worktree: fx.worktree }, { ...policy, secret_references: [{ ref: "vault:a" }] }]) {
    fs.writeFileSync(fx.files.policy, JSON.stringify(shape));
    assert.ok(run(fx).summary.gaps.includes("policy_missing"), "a policy missing a declared list is not an empty scope");
  }
  fs.rmSync(fx.files.policy);
  assert.equal(run(fx).summary.verdict, "invalid");
});

test("hand-written correlation faults are named even when the chain itself is valid", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  session.runCommand("node --version", { action_id: "dup", command_class: "test" });
  const attempt = ledger.readManagedLedger(fx.files.ledger).entries.find((entry) => entry.action_id === "dup" && entry.phase === "attempt");
  const result = lastAction(fx);
  const strip = ({ sequence, previous_hash, hash, ...body }) => body;
  // A second completed attempt of the same logical action, a conflicting extra
  // result, a result without an attempt, a dispatched deny and a legacy action.
  appendRaw(fx, { ...strip(attempt), attempt_id: "2" });
  appendRaw(fx, { ...strip(result), attempt_id: "2" });
  appendRaw(fx, { ...strip(result), attempt_id: "2", result: "failed" });
  appendRaw(fx, { ...strip(result), action_id: "orphan" });
  appendRaw(fx, { ...strip(attempt), action_id: "deny", decision: "deny" });
  appendRaw(fx, { ...strip(result), action_id: "deny", decision: "deny" });
  session.recorder.action({ kind: "file", tool: "Edit", decision: "allow", result: "completed", path: "a.txt", after_digest: "f".repeat(64) });
  session.end("done");
  const { summary } = run(fx);
  assert.equal(summary.integrity, "valid");
  assert.deepEqual(summary.unexplained, [
    "conflicting_result:command", "denied_action_dispatched:command", "duplicate_effect:command", "result_without_attempt:command",
  ]);
  assert.ok(summary.gaps.includes("correlation_missing:file"));
  assert.ok(summary.gaps.includes("file_write_without_git_effect:file"));
});

test("receipt tampering and recorded commits that Git no longer has are not attributable", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  session.requestCapability(broker(), { capability: "scm.submit", target: "origin/z", approved: true }, { action_id: "submit-z" });
  const result = lastAction(fx);
  const strip = ({ sequence, previous_hash, hash, ...body }) => body;
  appendRaw(fx, { ...strip(result), action_id: "forged", attempt_id: "1", phase: "attempt", result: "attempted", receipt_id: undefined });
  appendRaw(fx, { ...strip(result), action_id: "forged", receipt_target_class: "package" });
  session.recorder.beginAction({ kind: "git", tool: "Bash", decision: "allow", operation: "commit", action_id: "ghost", attempt_id: "1" });
  session.recorder.completeAction({ action_id: "ghost", attempt_id: "1", result: "completed", commit: "a".repeat(40) });
  session.end("done");
  const { summary } = run(fx);
  assert.ok(summary.unexplained.includes("receipt_mismatch:git"));
  assert.ok(summary.gaps.includes("recorded_commit_missing:git"));
});

test("an unavailable Git worktree is a gap; unmanaged tickets carry no summary and no gate issue", (t) => {
  const fx = fixture(t);
  completeSession(fx).end("done");
  const failing = run(fx, { git: () => ({ status: 1, stdout: "" }) }).summary;
  assert.equal(failing.verdict, "incomplete");
  assert.deepEqual(failing.gaps, ["git_unavailable"]);
  assert.equal(failing.diff_digest, null);
  const nested = fs.mkdtempSync(path.join(fx.worktree, "sub-"));
  assert.equal(reconcile.observeGit(nested, fx.base).ok, false, "a subdirectory is not the reconciled worktree root");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "coord-860-unmanaged-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(reconcile.isManagedTicket(managedEvidencePaths(empty, TICKET), undefined), false);
  assert.deepEqual(reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: { intended_files: [] }, runtimeDir: empty }), { label: "unmanaged", issues: [] });
  assert.deepEqual(reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: null, runtimeDir: empty }), { label: "unmanaged", issues: [] });
  // A v1-only barrier ledger is still an ordinary ticket.
  const v1 = require(path.join(COORD, "engine/scripts/auto-mode-ledger.js"));
  v1.appendEntry(managedEvidencePaths(empty, TICKET).ledger, { type: "deny", rule: "barrier" });
  assert.equal(reconcile.isManagedTicket(managedEvidencePaths(empty, TICKET), undefined), false);
  assert.equal(reconcile.inDeclaredScope("coord/x/y.js", ["coord/x/**"]), true);
  assert.equal(reconcile.inDeclaredScope("coord/x/y.js", ["coord/x/*"]), true);
  assert.equal(reconcile.inDeclaredScope("coord/xy.js", ["coord/x/"]), false);
  assert.equal(reconcile.inDeclaredScope("coord/x.js", ["coord/x.js"]), true);
});

test("the gate requires a summary, then a complete verdict or an exception naming exactly its gaps", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  session.writeFile("a.txt", "2\n", { action_id: "w" });
  session.end("done");
  const plan = { intended_files: ["a.txt"] };
  const evaluate = (record) => reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: { ...plan, ...(record ? { managed_execution: record } : {}) }, runtimeDir: fx.runtimeDir });
  const missing = evaluate();
  assert.equal(missing.issues[0].code, "managed_evidence_missing");
  assert.deepEqual(missing.issues[0].next_steps, [`coord/scripts/gov record-managed-evidence ${TICKET}`]);
  // Uncommitted but recorded write: complete. Remove the session end -> interrupted.
  const { summary } = run(fx);
  assert.equal(summary.verdict, "complete");
  const lines = fs.readFileSync(fx.files.ledger, "utf8").trim().split("\n");
  fs.writeFileSync(fx.files.ledger, `${lines.slice(0, -1).join("\n")}\n`);
  const partial = run(fx).summary;
  const incomplete = evaluate({ summary: partial, exception: null });
  assert.equal(incomplete.issues[0].code, "managed_evidence_incomplete");
  assert.match(incomplete.issues[0].message, /coverage_interrupted/);
  const named = [...partial.gaps, ...partial.unexplained].sort();
  const exception = { summary_digest: partial.summary_digest, gaps: named };
  assert.deepEqual(evaluate({ summary: partial, exception }), { label: "technical-exception", issues: [] });
  assert.equal(evaluate({ summary: partial, exception: { ...exception, gaps: named.slice(1) } }).label, "blocked");
  assert.equal(evaluate({ summary: partial, exception: { ...exception, summary_digest: "0".repeat(64) } }).label, "blocked");
  // Recording against an explicit base commit.
  const explicit = reconcile.reconcileManagedExecution({ ticketId: TICKET, runtimeDir: fx.runtimeDir, baseCommit: fx.base, declaredFiles: ["a.txt"], maxGapMs: 1 }).summary;
  assert.ok(explicit.gaps.includes("heartbeat_gap") || explicit.gaps.includes("coverage_interrupted"));
});

test("a policy with no recorded session still scopes Git and blocks as missing evidence", (t) => {
  const fx = fixture(t);
  startManagedSession(fx.options);
  fs.rmSync(fx.files.ledger);
  fs.writeFileSync(path.join(fx.worktree, "a.txt"), "x\n");
  const { summary } = run(fx);
  assert.equal(summary.chain_root, null);
  assert.equal(summary.coverage, "unmanaged");
  assert.equal(summary.verdict, "unexplained");
  assert.ok(summary.gaps.includes("no_managed_session"));
  assert.ok(summary.unexplained.includes("unexplained_file_change:file"));
  assert.equal(reconcile.VERDICTS.includes(summary.verdict), true);
  assert.equal(reconcile.SUMMARY_SCHEMA, summary.schema);
  assert.equal(crypto.createHash("sha256").update("x").digest("hex").length, 64);
});

test("recorded deletions, rewrites, port-443 egress and observed outside writes reconcile precisely", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  const rec = session.recorder;
  session.writeFile("a.txt", "2\n", { action_id: "w1" });
  session.writeFile("a.txt", "3\n", { action_id: "w2" });
  rec.beginAction({ kind: "file", tool: "Bash", decision: "allow", path: "keep.txt", before_digest: crypto.createHash("sha256").update("k\n").digest("hex"), action_id: "rm", attempt_id: "1" });
  fs.rmSync(path.join(fx.worktree, "keep.txt"));
  rec.completeAction({ action_id: "rm", attempt_id: "1", result: "completed" });
  rec.beginAction({ kind: "network", tool: "codex-net", decision: "allow", destination: "api.example.com:443", action_id: "n443", attempt_id: "1" });
  rec.completeAction({ action_id: "n443", attempt_id: "1", result: "completed" });
  rec.beginAction({ kind: "file", tool: "Write", decision: "allow", path: path.join(os.tmpdir(), "elsewhere.txt"), action_id: "out", attempt_id: "1" });
  rec.completeAction({ action_id: "out", attempt_id: "1", result: "completed" });
  session.end("done");
  const { summary } = run(fx, { declaredFiles: ["a.txt", "keep.txt"] });
  assert.deepEqual(summary.unexplained, ["out_of_scope_file:file"]);
  assert.deepEqual(summary.gaps, []);
  assert.equal(summary.counts.changed_paths, 2);
});

test("a hand-bound minimal policy reconciles with empty declared scopes", (t) => {
  const fx = fixture(t);
  const policy = { ticket: TICKET, worktree: fx.worktree, base_sha: fx.base, command_classes: ["test"], child_process_egress: "deny", network_allow: [], secret_references: [], broker_capabilities: [], broker_targets: [] };
  policy.digest = policyDigest(policy);
  fs.mkdirSync(path.dirname(fx.files.policy), { recursive: true });
  fs.writeFileSync(fx.files.policy, JSON.stringify(policy));
  const rec = ledger.createSessionRecorder({ file: fx.files.ledger, ticket: TICKET, session: "hand", provider: "claude", policy_digest: policy.digest, worktree: fx.worktree });
  rec.start("1.0.0");
  for (const [kind, extra] of [["network", { destination: "api.example.com" }], ["secret", { secret_ref: "vault:a", purpose: "x" }], ["mcp", { operation: "custom.cap", tool: "capability-broker" }]]) {
    rec.beginAction({ kind, tool: "obs", decision: "allow", ...extra, action_id: kind, attempt_id: "1" });
    const receipt = { receipt_id: "r1", ticket: TICKET, capability: "custom.cap", target_class: "other", target_digest: "c".repeat(64), result: "completed" };
    rec.completeAction({ action_id: kind, attempt_id: "1", result: "completed", ...(kind === "mcp" ? { receipt } : {}) });
  }
  rec.end("done");
  const { summary } = run(fx);
  assert.equal(summary.integrity, "valid");
  assert.deepEqual(summary.unexplained, ["out_of_scope_remote_target:mcp", "unexplained_egress:network", "unexplained_remote_effect:mcp", "unexplained_secret_use:secret"]);
  assert.deepEqual(summary.gaps, [], "claude without required egress observation has no network gap when egress is denied");
  // A summary recorded while Git was unavailable re-verifies against the policy base.
  const offline = reconcile.reconcileManagedExecution({ ticketId: TICKET, runtimeDir: fx.runtimeDir, git: () => ({ status: 1 }) }).summary;
  assert.equal(offline.base_commit, null);
  const gate = reconcile.evaluateManagedEvidence({ ticketId: TICKET, plan: { managed_execution: { summary: offline } }, runtimeDir: fx.runtimeDir, git: () => ({ status: 1 }) });
  assert.equal(gate.issues[0].code, "managed_evidence_incomplete");
});

test("COORD-860 review F1: an `allowed` result is never a completed process or a settled remote outcome", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  const rec = session.recorder;
  // The ledger refuses `allowed` (and any non-process outcome) for a command.
  rec.beginAction({ kind: "command", tool: "Bash", decision: "allow", command: "node -e 1", command_class: "test", action_id: "p1", attempt_id: "1" });
  assert.throws(() => rec.completeAction({ action_id: "p1", attempt_id: "1", result: "allowed" }), /invalid_process_result/);
  assert.throws(() => rec.completeAction({ action_id: "p1", attempt_id: "1", result: "allowed" }), /invalid_process_result/);
  rec.completeAction({ action_id: "p1", attempt_id: "1", result: "completed" });
  // A broker executor that reports `allowed` leaves the remote outcome unknown and blocks retry.
  const allowed = broker(() => ({ result: "allowed" }));
  assert.equal(session.requestCapability(allowed, { capability: "scm.submit", target: "origin/a", approved: true }, { action_id: "b-allowed" }).status, "allowed");
  assert.throws(() => session.requestCapability(allowed, { capability: "scm.submit", target: "origin/a", approved: true }, { action_id: "b-allowed", attempt_id: "2" }), /duplicate_effect/);
  // A hand-written chain with an `allowed` command result and a retry is reconciled as incomplete and duplicated.
  const strip = ({ sequence, previous_hash, hash, ...body }) => body;
  const entries = ledger.readManagedLedger(fx.files.ledger).entries;
  const attempt = entries.find((entry) => entry.action_id === "p1" && entry.phase === "attempt");
  const done = entries.find((entry) => entry.action_id === "p1" && entry.phase === "result");
  appendRaw(fx, { ...strip(attempt), action_id: "p2" });
  appendRaw(fx, { ...strip(done), action_id: "p2", result: "allowed" });
  appendRaw(fx, { ...strip(attempt), action_id: "p2", attempt_id: "2" });
  appendRaw(fx, { ...strip(done), action_id: "p2", attempt_id: "2", result: "completed" });
  session.end("done");
  const { summary } = run(fx, { declaredFiles: ["a.txt"] });
  assert.equal(summary.integrity, "valid");
  assert.notEqual(summary.verdict, "complete");
  assert.ok(summary.gaps.includes("process_result_missing:command"));
  assert.ok(summary.gaps.includes("outcome_unknown:git"));
  assert.ok(summary.unexplained.includes("duplicate_effect:command"));
});

test("COORD-860 review F2: broker targets are matched against the declared target scope", (t) => {
  const fx = fixture(t);
  const session = startManagedSession(fx.options);
  let executed = 0;
  const counting = broker(() => { executed += 1; return { result: "completed" }; });
  assert.equal(session.requestCapability(counting, { capability: "scm.submit", target: "origin/undeclared", approved: true }, { action_id: "t-out" }).status, "denied");
  assert.equal(executed, 0, "an undeclared target never dispatches");
  // An adapter-observed broker effect on an undeclared target is unexplained.
  session.recorder.beginAction({ kind: "git", tool: "capability-broker", decision: "allow", operation: "scm.submit", action_id: "t-obs", attempt_id: "1" });
  session.recorder.completeAction({ action_id: "t-obs", attempt_id: "1", result: "completed", receipt: {
    receipt_id: "r-obs", ticket: TICKET, capability: "scm.submit", target_class: "scm-ref", target_digest: crypto.createHash("sha256").update("origin/undeclared").digest("hex"), result: "completed",
  } });
  session.end("done");
  assert.deepEqual(run(fx).summary.unexplained, ["out_of_scope_remote_target:git"]);
});
