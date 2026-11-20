"use strict";

// COORD-492 slice 1: redacted, hash-chained managed-auto action ledger and its
// coverage verifier. Every fixture is synthetic and lives under os.tmpdir().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const ledger = require("./managed-auto-ledger.js");
const v1 = require("./auto-mode-ledger.js");

const {
  COVERAGE_STATES, LEDGER_SCHEMA, LedgerNormalizationError, appendManagedEvent, createManagedEntry,
  createSessionRecorder, normalizeManagedEvent, readManagedLedger, secretValuesFromEnvironment,
  verifyManagedLedger, verifyManagedLedgerFile,
} = ledger;

const DIGEST = crypto.createHash("sha256").update("policy").digest("hex");
const BEFORE = crypto.createHash("sha256").update("before").digest("hex");
const AFTER = crypto.createHash("sha256").update("after").digest("hex");
const CANARY_ENV = "cnry-env-7f3a91c2e4";
const CANARY_INPUT = "cnry-input-58b2d07a1f";
const CANARY_OUTPUT = "cnry-output-c41e9b6d33";
const CANARY_BEARER = "cnry-bearer-0a9d7e2f61";
const CANARY_USERINFO = "cnry-userinfo-6b1f04c8a2";
// Assembled at runtime so the release secret scanner does not see a token-shaped literal.
const CANARY_TOKEN_SHAPE = ["ghp", "CnryTokenShape0123456789abcd"].join("_");
const ALL_CANARIES = [CANARY_ENV, CANARY_INPUT, CANARY_OUTPUT, CANARY_BEARER, CANARY_USERINFO, CANARY_TOKEN_SHAPE];

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-492-"))); }

function clock(start = Date.UTC(2026, 9, 21, 12, 0, 0), stepMs = 1000) {
  let tick = 0;
  return () => new Date(start + stepMs * tick++).toISOString();
}

function context(root, overrides = {}) {
  return {
    ticket: "COORD-492", session: "sess-1", provider: "claude", policy_digest: DIGEST,
    worktree: path.join(root, "wt"), secrets: [], now: clock(), ...overrides,
  };
}

function recorder(root, overrides = {}) {
  return createSessionRecorder({ file: path.join(root, "COORD-492.ndjson"), ...context(root, overrides) });
}

// The complete in-envelope edit/test/commit/submit fixture.
function completeSession(root, overrides = {}) {
  const rec = recorder(root, overrides);
  rec.start("1.4.0");
  rec.action({ kind: "file", tool: "Edit", decision: "allow", rule: "write-roots", result: "completed", path: "src/app.js", before_digest: BEFORE, after_digest: AFTER, duration_ms: 12 });
  rec.action({ kind: "command", tool: "Bash", decision: "allow", rule: "command-classes", result: "completed", command: "npm test -- --runInBand", command_class: "test", duration_ms: 4100 });
  rec.heartbeat();
  rec.action({ kind: "git", tool: "Bash", decision: "allow", rule: "git-local", result: "completed", operation: "commit", commit: "a".repeat(40) });
  rec.action({ kind: "governance", tool: "gov", decision: "allow", rule: "governance-submit", result: "completed", operation: "submit" });
  rec.end("clean");
  return { rec, file: path.join(root, "COORD-492.ndjson") };
}

test("schema and coverage vocabulary are versioned and distinct", () => {
  assert.equal(LEDGER_SCHEMA, "coord.auto-mode.ledger/v2");
  assert.deepEqual([...COVERAGE_STATES], ["complete", "partial", "interrupted", "bypassed", "unmanaged"]);
});

test("a complete in-envelope session yields a deterministic chain root for both provider adapters", () => {
  const roots = [];
  for (const provider of ["claude", "codex"]) {
    const first = completeSession(tmp(), { provider });
    const second = completeSession(tmp(), { provider });
    const a = verifyManagedLedgerFile(first.file, { ticket: "COORD-492", max_gap_ms: 60000 });
    const b = verifyManagedLedgerFile(second.file, { ticket: "COORD-492", max_gap_ms: 60000 });
    assert.equal(a.ok, true, JSON.stringify(a.issues));
    assert.equal(a.integrity, "valid");
    assert.equal(a.coverage, "complete");
    assert.equal(a.provider, provider);
    assert.equal(a.policy_digest, DIGEST);
    assert.match(a.chain_root, /^[0-9a-f]{64}$/);
    assert.equal(a.chain_root, b.chain_root, "same inputs and clock must replay to the same root");
    assert.equal(a.session_head, a.chain_root);
    assert.equal(a.counts.session_events, 7);
    assert.deepEqual(a.counts.by_type, { action: 4, heartbeat: 1, session_end: 1, session_start: 1 });
    assert.deepEqual(a.counts.by_class, { command: 1, file: 1, git: 1, governance: 1 });
    roots.push(a.chain_root);
  }
  assert.notEqual(roots[0], roots[1], "provider is part of the hashed evidence");
});

test("recorded fields are normalized and carry redaction metadata", () => {
  const root = tmp();
  const { file } = completeSession(root);
  const [start, edit, command, , gitEvent] = readManagedLedger(file).entries;
  assert.equal(start.adapter_version, "1.4.0");
  assert.equal(edit.resource, "src/app.js");
  assert.equal(edit.resource_scope, "worktree");
  assert.equal(edit.before_digest, BEFORE);
  assert.equal(edit.after_digest, AFTER);
  assert.equal(edit.operation_class, "file");
  assert.equal(command.command_class, "test");
  assert.equal(command.summary, "npm test");
  assert.match(command.command_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(command.duration_ms, 4100);
  assert.equal(command.resource, ".");
  assert.equal(gitEvent.commit, "a".repeat(40));
  assert.equal(gitEvent.resource, "commit");
  assert.deepEqual(edit.redaction, { schema: "coord.auto-mode.redaction/v1", redacted_fields: [], dropped_field_count: 0 });
});

test("network, secret-reference and outside-worktree evidence is reduced to safe identifiers", () => {
  const root = tmp();
  const rec = recorder(root, { provider: "codex" });
  rec.start("2.0.0");
  const net = rec.action({ kind: "network", tool: "fetch", decision: "deny", rule: "egress", result: "denied", destination: `https://user:${CANARY_USERINFO}@Registry.Example.com:8443/path?token=abc` });
  const bare = rec.action({ kind: "network", tool: "fetch", decision: "allow", result: "completed", destination: "api.example.com" });
  const secretRef = rec.action({ kind: "secret", tool: "broker", decision: "allow", result: "completed", secret_ref: "vault:npm-publish", purpose: "publish package" });
  const outside = rec.action({ kind: "file", tool: "Write", decision: "deny", result: "denied", path: path.join(os.homedir(), ".ssh", "config") });
  const absInside = rec.action({ kind: "file", tool: "Write", decision: "allow", result: "completed", path: path.join(root, "wt", "lib", "x.js"), after_digest: AFTER });
  const cwd = rec.action({ kind: "command", tool: "Bash", decision: "allow", result: "completed", command: "/usr/bin/node --version", command_class: "other", cwd: "lib" });
  const quoted = rec.action({ kind: "command", tool: "Bash", decision: "allow", result: "completed", command: 'echo "free text body"', command_class: "other" });
  assert.equal(quoted.summary, "echo [arg]");
  const mcp = rec.action({ kind: "mcp", tool: "mcp__docs__read", decision: "approval_required", result: "attempted", operation: "read" });
  assert.equal(net.resource, "registry.example.com:8443");
  assert.equal(net.decision, "deny");
  assert.equal(bare.resource, "api.example.com");
  assert.equal(secretRef.resource, "vault:npm-publish");
  assert.equal(secretRef.purpose, "publish package");
  assert.equal(outside.resource, "[outside-worktree]");
  assert.equal(outside.resource_scope, "outside");
  assert.equal(outside.before_digest, null);
  assert.equal(absInside.resource, "lib/x.js");
  assert.equal(cwd.resource, "lib");
  assert.equal(cwd.summary, "node --version");
  assert.equal(mcp.decision, "approval_required");
  assert.equal(mcp.duration_ms, null);
  rec.end();
  const verdict = verifyManagedLedgerFile(path.join(root, "COORD-492.ndjson"));
  assert.equal(verdict.coverage, "complete");
  assert.equal(verdict.session, "sess-1");
  assert.equal(JSON.stringify(readManagedLedger(path.join(root, "COORD-492.ndjson"))).includes(CANARY_USERINFO), false);
});

test("canary secrets in tool input, output and environment never reach the ledger or diagnostics", () => {
  const root = tmp();
  const env = { PATH: "/usr/bin", API_TOKEN: CANARY_ENV, SHORT_SECRET: "abc", LANG: "C" };
  const secrets = secretValuesFromEnvironment(env);
  assert.deepEqual(secrets, [CANARY_ENV]);
  const rec = recorder(root, { secrets: [...secrets, CANARY_INPUT, 42, ""] });
  rec.start("1.0.0");
  const command = `API_TOKEN=${CANARY_ENV} curl -H "Authorization: Bearer ${CANARY_BEARER}" https://user:${CANARY_USERINFO}@example.com/?q=${CANARY_INPUT} ${CANARY_TOKEN_SHAPE}`;
  const event = rec.action({
    kind: "command", tool: "Bash", decision: "deny", rule: "egress", result: "denied", command, command_class: "other",
    input: { command, env, password: CANARY_INPUT }, output: `${CANARY_OUTPUT} ${CANARY_TOKEN_SHAPE}`, environment: env,
  });
  assert.equal(event.summary, "curl -H");
  assert.equal(event.redaction.dropped_field_count, 3);
  assert.deepEqual(event.redaction.redacted_fields, ["command"]);
  rec.action({ kind: "secret", tool: "broker", decision: "allow", result: "completed", secret_ref: "vault:deploy", purpose: `rotate password=${CANARY_OUTPUT} via ${CANARY_INPUT}` });
  rec.interrupt(`adapter saw ${CANARY_ENV} and token: ${CANARY_BEARER}`);
  const failures = [];
  for (const bad of [
    { kind: "file", tool: "Edit", decision: "allow", result: "completed", path: `src/${CANARY_INPUT}.js` },
    { kind: "network", tool: "fetch", decision: "allow", result: "completed", destination: `${CANARY_ENV}.example.com` },
    { kind: "secret", tool: "broker", decision: "allow", result: "completed", secret_ref: CANARY_INPUT, purpose: "x" },
  ]) {
    assert.throws(() => rec.action(bad), (error) => { failures.push(`${error.message} ${error.code} ${error.field}`); return error instanceof LedgerNormalizationError; });
  }
  const file = path.join(root, "COORD-492.ndjson");
  const verdict = verifyManagedLedgerFile(file);
  const exported = [fs.readFileSync(file, "utf8"), JSON.stringify(verdict), failures.join("\n")].join("\n");
  for (const canary of ALL_CANARIES) assert.equal(exported.includes(canary), false, `canary leaked: ${canary.slice(0, 10)}`);
  assert.equal(verdict.coverage, "interrupted");
  assert.equal(readManagedLedger(file).entries.length, 4, "refused events write nothing");
});

test("required fields that cannot be safely normalized fail the managed action closed", () => {
  const root = tmp();
  const ctx = context(root);
  const action = { type: "action", kind: "command", tool: "Bash", decision: "allow", result: "completed", command: "npm test", command_class: "test" };
  const refusals = [
    [{ ...action }, { worktree: "relative/wt" }, "invalid_worktree"],
    [{ ...action }, { ticket: "coord-492" }, "invalid_ticket"],
    [{ ...action }, { session: "has space" }, "invalid_session"],
    [{ ...action }, { provider: "gemini" }, "invalid_provider"],
    [{ ...action }, { policy_digest: "abc" }, "invalid_policy_digest"],
    [{ ...action }, { now: () => "not-a-time" }, "invalid_ts"],
    [{ ...action }, { now: () => new Date(0) }, "invalid_ts"],
    [{ ...action, type: "note" }, {}, "invalid_type"],
    [{ type: "session_start" }, {}, "invalid_adapter_version"],
    [{ ...action, kind: "telepathy" }, {}, "invalid_kind"],
    [{ ...action, tool: "bad tool!" }, {}, "invalid_tool"],
    [{ ...action, decision: "maybe" }, {}, "invalid_decision"],
    [{ ...action, result: "ok" }, {}, "invalid_result"],
    [{ ...action, rule: "rule with spaces" }, {}, "invalid_rule"],
    [{ ...action, duration_ms: -1 }, {}, "invalid_duration_ms"],
    [{ ...action, duration_ms: 1.5 }, {}, "invalid_duration_ms"],
    [{ ...action, command: "   " }, {}, "invalid_command"],
    [{ ...action, command_class: "rocket" }, {}, "invalid_command_class"],
    [{ ...action, cwd: "" }, {}, "invalid_cwd"],
    [{ ...action, kind: "file", path: 7 }, {}, "invalid_path"],
    [{ ...action, kind: "file", path: "a.js", before_digest: "xyz" }, {}, "invalid_before_digest"],
    [{ ...action, kind: "network", destination: "" }, {}, "invalid_destination"],
    [{ ...action, kind: "network", destination: "http://[bad" }, {}, "invalid_destination"],
    [{ ...action, kind: "network", destination: "tcp://" }, {}, "invalid_destination"],
    [{ ...action, kind: "network", destination: 42 }, {}, "invalid_destination"],
    [{ ...action, kind: "secret", secret_ref: "has space", purpose: "x" }, {}, "invalid_secret_ref"],
    [{ ...action, kind: "secret", secret_ref: "vault:x" }, {}, "invalid_purpose"],
    [{ ...action, kind: "git", operation: "" }, {}, "invalid_operation"],
    [{ ...action, kind: "git", operation: "commit", commit: "zz" }, {}, "invalid_commit"],
    [{ ...action }, { session: "sess-canary-1", secrets: ["sess-canary-1"] }, "residual_secret"],
  ];
  for (const [input, overrides, code] of refusals) {
    assert.throws(() => normalizeManagedEvent(input, { ...ctx, ...overrides }), (error) => error instanceof LedgerNormalizationError && error.code === code, code);
  }
  assert.throws(() => normalizeManagedEvent(null, ctx), /invalid_type/);
  assert.throws(() => normalizeManagedEvent(action), /invalid_worktree/);
  const file = path.join(root, "refused.ndjson");
  assert.throws(() => appendManagedEvent(file, { ...action, decision: "maybe" }, ctx), LedgerNormalizationError);
  assert.equal(fs.existsSync(file), false, "a refused event must not create or touch the ledger");
});

test("markers carry an optional bounded reason and default clock is ISO time", () => {
  const root = tmp();
  const body = normalizeManagedEvent({ type: "heartbeat" }, { ...context(root), now: undefined, secrets: undefined });
  assert.ok(!Number.isNaN(Date.parse(body.ts)));
  assert.equal(body.reason, null);
  const long = normalizeManagedEvent({ type: "bypass", reason: "x".repeat(500) }, context(root));
  assert.equal(long.reason.length, 160);
});

test("tamper, reorder, deletion, duplicate sequence and corrupt lines are invalid", () => {
  const { file } = completeSession(tmp());
  const entries = readManagedLedger(file).entries;
  const cases = {
    tamper: entries.map((entry, index) => (index === 2 ? { ...entry, summary: "npm publish" } : entry)),
    reorder: [entries[0], entries[2], entries[1], ...entries.slice(3)],
    deletion: [...entries.slice(0, 3), ...entries.slice(4)],
    duplicate: [...entries.slice(0, 3), { ...entries[3], sequence: entries[2].sequence }, ...entries.slice(4)],
    foreignSchema: entries.map((entry, index) => (index === 1 ? { ...entry, schema: "other/v9" } : entry)),
  };
  for (const [name, mutated] of Object.entries(cases)) {
    const verdict = verifyManagedLedger(mutated);
    assert.equal(verdict.integrity, "invalid", name);
    assert.equal(verdict.ok, false, name);
    assert.notEqual(verdict.coverage, "complete", name);
  }
  assert.ok(verifyManagedLedger(cases.duplicate).issues.some((issue) => issue.code === "duplicate_sequence"));
  assert.ok(verifyManagedLedger(cases.foreignSchema).issues.some((issue) => issue.code === "unknown_schema"));
  // A crash mid-write leaves a torn final line; it must be reported, not skipped silently.
  const torn = path.join(path.dirname(file), "torn.ndjson");
  fs.writeFileSync(torn, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{"schema":"coord.auto-\n42\n`);
  const tornVerdict = verifyManagedLedgerFile(torn);
  assert.equal(tornVerdict.integrity, "invalid");
  assert.deepEqual(tornVerdict.issues.filter((issue) => issue.code === "unparseable_line").map((issue) => issue.line), [8, 9]);
  assert.throws(() => appendManagedEvent(torn, { type: "heartbeat" }, context(tmp())), (error) => error.code === "unreadable_ledger");
});

test("missing start, missing end, adapter crash and interruption are never complete", () => {
  const { file } = completeSession(tmp());
  const entries = readManagedLedger(file).entries;
  const rechain = (list) => list.reduce((out, entry) => {
    const body = { ...entry };
    delete body.sequence; delete body.previous_hash; delete body.hash;
    out.push(createManagedEntry(body, out.at(-1) || null));
    return out;
  }, []);
  const noStart = verifyManagedLedger(rechain(entries.slice(1)));
  assert.equal(noStart.integrity, "valid");
  assert.equal(noStart.coverage, "partial");
  assert.ok(noStart.issues.some((issue) => issue.code === "missing_start"));
  const noEnd = verifyManagedLedger(entries.slice(0, -1));
  assert.equal(noEnd.integrity, "valid");
  assert.equal(noEnd.coverage, "interrupted");
  assert.ok(noEnd.issues.some((issue) => issue.code === "missing_end"));

  const root = tmp();
  const crash = recorder(root);
  crash.start("1.0.0");
  crash.action({ kind: "command", tool: "Bash", decision: "allow", result: "attempted", command: "npm test", command_class: "test" });
  crash.adapterFailure("hook process exited 137");
  const crashed = verifyManagedLedgerFile(path.join(root, "COORD-492.ndjson"));
  assert.equal(crashed.coverage, "interrupted");
  assert.equal(crashed.ok, false);

  const root2 = tmp();
  const cut = recorder(root2);
  cut.start("1.0.0");
  cut.interrupt("operator cancelled");
  cut.end();
  assert.equal(verifyManagedLedgerFile(path.join(root2, "COORD-492.ndjson")).coverage, "interrupted");
});

test("bypassed and unmanaged stay distinct from partial and interrupted", () => {
  const bypassRoot = tmp();
  const bypass = recorder(bypassRoot);
  bypass.start("1.0.0");
  bypass.bypass("hook disabled by settings change");
  bypass.end();
  const bypassed = verifyManagedLedgerFile(path.join(bypassRoot, "COORD-492.ndjson"));
  assert.equal(bypassed.coverage, "bypassed");

  const unmanagedRoot = tmp();
  const plain = recorder(unmanagedRoot);
  plain.unmanaged("provider has no enforceable hooks");
  assert.equal(verifyManagedLedgerFile(path.join(unmanagedRoot, "COORD-492.ndjson")).coverage, "unmanaged");

  const missing = verifyManagedLedgerFile(path.join(tmp(), "absent.ndjson"));
  assert.equal(missing.coverage, "unmanaged");
  assert.equal(missing.integrity, "valid");
  assert.equal(missing.ok, false, "absence of events is never success");
  assert.equal(missing.chain_root, null);
  assert.ok(missing.issues.some((issue) => issue.code === "no_managed_session"));

  const verdicts = new Set([bypassed.coverage, "unmanaged", "interrupted", "partial", "complete"]);
  assert.equal(verdicts.size, 5);
});

test("session-level gaps, drift and out-of-order markers degrade coverage to partial", () => {
  const root = tmp();
  const rec = recorder(root, { now: clock(Date.UTC(2026, 9, 21), 10 * 60 * 1000) });
  rec.start("1.0.0");
  rec.heartbeat();
  rec.end();
  const file = path.join(root, "COORD-492.ndjson");
  const gapped = verifyManagedLedgerFile(file, { max_gap_ms: 60000 });
  assert.equal(gapped.coverage, "partial");
  assert.equal(gapped.gaps.length, 2);
  assert.deepEqual(gapped.gaps[0], { code: "heartbeat_gap", from_sequence: 1, to_sequence: 2 });
  assert.equal(verifyManagedLedgerFile(file, { ticket: "COORD-999" }).issues.filter((issue) => issue.code === "ticket_mismatch").length, 3);

  const drift = tmp();
  const file2 = path.join(drift, "COORD-492.ndjson");
  const base = context(drift);
  appendManagedEvent(file2, { type: "session_start", adapter_version: "1" }, base);
  appendManagedEvent(file2, { type: "session_start", adapter_version: "1" }, base);
  appendManagedEvent(file2, { type: "heartbeat" }, { ...base, policy_digest: AFTER, provider: "codex", now: () => "2020-01-01T00:00:00.000Z" });
  appendManagedEvent(file2, { type: "session_end" }, base);
  appendManagedEvent(file2, { type: "session_end" }, base);
  appendManagedEvent(file2, { type: "heartbeat" }, base);
  const verdict = verifyManagedLedgerFile(file2);
  assert.equal(verdict.integrity, "valid");
  assert.equal(verdict.coverage, "partial");
  const codes = new Set(verdict.issues.map((issue) => issue.code));
  for (const code of ["duplicate_start", "policy_digest_changed", "provider_changed", "clock_regression", "duplicate_end", "events_after_end"]) {
    assert.ok(codes.has(code), code);
  }

  const late = tmp();
  const file3 = path.join(late, "COORD-492.ndjson");
  appendManagedEvent(file3, { type: "heartbeat" }, context(late));
  appendManagedEvent(file3, { type: "session_start", adapter_version: "1" }, context(late));
  appendManagedEvent(file3, { type: "session_end" }, context(late));
  assert.ok(verifyManagedLedgerFile(file3).issues.some((issue) => issue.code === "events_before_start"));
});

test("v2 events extend the existing v1 action-ledger chain in the same store", () => {
  const root = tmp();
  const file = path.join(root, "COORD-492.ndjson");
  v1.appendEntry(file, { type: "action", ticket: "COORD-492", action_id: "barrier-1", tool: "Bash", decision: "deny", code: "destructive_shell" });
  const rec = createSessionRecorder({ file, ...context(root, { session: "sess-2" }) });
  rec.start("1.0.0");
  rec.end();
  // An older session in the same store is ignored unless selected explicitly.
  const entries = readManagedLedger(file).entries;
  assert.equal(entries[0].schema, "coord.auto-mode.ledger/v1");
  assert.equal(entries[1].previous_hash, entries[0].hash);
  assert.equal(v1.verifyLedger(entries).ok, true, "the v1 verifier still accepts the extended chain");
  const verdict = verifyManagedLedgerFile(file);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.counts.legacy_v1, 1);
  assert.equal(verdict.session, "sess-2");
  assert.equal(verifyManagedLedgerFile(file, { session: "sess-other" }).coverage, "unmanaged");
  // A v1 append after v2 events still continues the same chain.
  v1.appendEntry(file, { type: "action", ticket: "COORD-492", action_id: "barrier-2", tool: "Bash", decision: "deny", code: "delete_tool" });
  const after = verifyManagedLedgerFile(file);
  assert.equal(after.integrity, "valid");
  assert.equal(after.session_head, entries[2].hash);
  assert.notEqual(after.chain_root, after.session_head);
});

test("verifier tolerates a ledger with only foreign-session or v1 entries", () => {
  const root = tmp();
  const file = path.join(root, "COORD-492.ndjson");
  v1.appendEntry(file, { type: "action", ticket: "COORD-492", action_id: "b1", decision: "deny" });
  const onlyV1 = verifyManagedLedgerFile(file);
  assert.equal(onlyV1.coverage, "unmanaged");
  assert.equal(onlyV1.session, null);
  assert.equal(onlyV1.provider, null);
  appendManagedEvent(file, { type: "heartbeat" }, context(root, { session: "orphan" }));
  const orphan = verifyManagedLedgerFile(file);
  assert.equal(orphan.session, "orphan");
  assert.equal(orphan.coverage, "interrupted");
  assert.equal(verifyManagedLedger().coverage, "unmanaged");
});

test("a held ledger lock refuses the append instead of interleaving writers", () => {
  const root = tmp();
  const file = path.join(root, "COORD-492.ndjson");
  fs.writeFileSync(`${file}.lock`, "");
  assert.throws(() => appendManagedEvent(file, { type: "heartbeat" }, context(root)), /EEXIST/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.lock`), true, "a foreign lock is never removed by the refused writer");
});

// COORD-860 (accepted ADR-0017 amendment): attempt/result correlation, the
// closed receipt projection and replay rules on the same v2 chain.
const RECEIPT = { receipt_id: "rcpt-1", ticket: "COORD-492", capability: "scm.submit", target_class: "scm-ref", target_digest: AFTER, result: "completed" };

test("COORD-860 correlation fields are all-or-nothing and the receipt projection is closed", () => {
  const root = tmp();
  const ctx = context(root);
  const base = { type: "action", kind: "git", tool: "capability-broker", decision: "allow", operation: "scm.submit" };
  const result = normalizeManagedEvent({ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "result", receipt: { ...RECEIPT, raw_body: "x", target: "origin/dev" } }, ctx);
  assert.equal(result.receipt_id, "rcpt-1");
  assert.equal(result.receipt_external_id_digest, null);
  assert.equal(result.receipt_digest, ledger.receiptDigest(ledger.receiptProjection(result)));
  assert.equal(result.redaction.dropped_field_count, 2, "unknown receipt fields are dropped and counted, never kept");
  assert.equal(JSON.stringify(result).includes("origin/dev"), false);
  const refusals = [
    [{ ...base, result: "completed", receipt: RECEIPT }, "invalid_receipt"],
    [{ ...base, result: "attempted", action_id: "a1" }, "invalid_correlation"],
    [{ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "attempt" }, "invalid_phase"],
    [{ ...base, result: "attempted", action_id: "a1", attempt_id: "1", phase: "result" }, "invalid_phase"],
    [{ ...base, result: "attempted", action_id: "a1", attempt_id: "1", phase: "attempt", receipt: RECEIPT }, "invalid_receipt"],
    [{ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "result", receipt: "rcpt" }, "invalid_receipt"],
    [{ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "result", receipt: { ...RECEIPT, ticket: "COORD-1" } }, "invalid_receipt_ticket"],
    [{ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "result", receipt: { ...RECEIPT, result: "attempted" } }, "invalid_receipt_result"],
    [{ ...base, result: "completed", action_id: "a1", attempt_id: "1", phase: "result", receipt: { ...RECEIPT, receipt_id: CANARY_ENV } }, "unsafe_value"],
  ];
  for (const [input, code] of refusals) {
    assert.throws(() => normalizeManagedEvent(input, { ...ctx, secrets: [CANARY_ENV] }), (error) => error instanceof LedgerNormalizationError && error.code === code, code);
  }
});

test("COORD-860 begin/complete replay is idempotent, conflicts refuse, and retries follow terminal outcomes only", () => {
  const root = tmp();
  const file = path.join(root, "COORD-492.ndjson");
  const rec = recorder(root);
  rec.start("1.0.0");
  const attempt = { kind: "command", tool: "Bash", decision: "allow", command: "npm test", command_class: "test", action_id: "act", attempt_id: "1" };
  const first = rec.beginAction(attempt);
  assert.equal(first.replayed, false);
  assert.equal(first.entry.phase, "attempt");
  assert.equal(first.entry.result, "attempted");
  const again = rec.beginAction(attempt);
  assert.equal(again.replayed, true);
  assert.equal(again.entry.hash, first.entry.hash);
  const codeOf = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };
  assert.equal(codeOf(() => rec.beginAction({ ...attempt, command: "npm run lint" })), "conflicting_replay");
  assert.equal(codeOf(() => rec.beginAction({ ...attempt, attempt_id: "2" })), "unknown_outcome", "no new attempt while the outcome is unknown");
  assert.equal(codeOf(() => rec.completeAction({ action_id: "act", attempt_id: "9", result: "completed" })), "result_without_attempt");
  assert.equal(codeOf(() => rec.completeAction(null)), "invalid_action_id");
  const done = rec.completeAction({ action_id: "act", attempt_id: "1", result: "failed", duration_ms: 3, extra: "dropped" });
  assert.equal(done.entry.phase, "result");
  assert.equal(done.entry.summary, first.entry.summary, "a result inherits its attempt's normalized fields");
  assert.equal(done.entry.redaction.dropped_field_count, 1);
  // Replay compares the normalized semantic body; the writer clock is excluded.
  assert.equal(rec.completeAction({ action_id: "act", attempt_id: "1", result: "failed", duration_ms: 3, extra: "dropped" }).replayed, true);
  assert.equal(codeOf(() => rec.completeAction({ action_id: "act", attempt_id: "1", result: "completed" })), "conflicting_replay");
  // Retries after a failed terminal result are new attempts, up to the limit.
  for (const id of ["2", "3"]) {
    rec.beginAction({ ...attempt, attempt_id: id });
    rec.completeAction({ action_id: "act", attempt_id: id, result: "failed" });
  }
  assert.equal(codeOf(() => rec.beginAction({ ...attempt, attempt_id: "4" })), "retry_limit");
  // A completed effect is never attempted again.
  rec.beginAction({ ...attempt, action_id: "once", attempt_id: "1" });
  rec.completeAction({ action_id: "once", attempt_id: "1", result: "completed" });
  assert.equal(codeOf(() => rec.beginAction({ ...attempt, action_id: "once", attempt_id: "2" })), "duplicate_effect");
  // A denied attempt can only end denied.
  rec.beginAction({ ...attempt, action_id: "deny", decision: "deny" });
  assert.equal(codeOf(() => rec.completeAction({ action_id: "deny", attempt_id: "1", result: "completed" })), "denied_dispatch");
  assert.equal(rec.completeAction({ action_id: "deny", attempt_id: "1", result: "denied" }).entry.result, "denied");
  // Git results may name the commit they created.
  rec.beginAction({ kind: "git", tool: "Bash", decision: "allow", operation: "commit", action_id: "c", attempt_id: "1" });
  assert.equal(rec.completeAction({ action_id: "c", attempt_id: "1", result: "completed", commit: "b".repeat(40) }).entry.commit, "b".repeat(40));
  rec.beginAction({ kind: "git", tool: "Bash", decision: "allow", operation: "status", action_id: "s", attempt_id: "1" });
  assert.equal(rec.completeAction({ action_id: "s", attempt_id: "1", result: "completed" }).entry.commit, null);
  // A result written without its attempt (hand-edited chain) blocks the attempt.
  const head = readManagedLedger(file).entries.at(-1);
  const orphan = createManagedEntry({ ...done.entry, sequence: undefined, previous_hash: undefined, hash: undefined, action_id: "orphan" }, head);
  fs.appendFileSync(file, `${JSON.stringify(orphan)}\n`);
  assert.equal(codeOf(() => rec.beginAction({ ...attempt, action_id: "orphan" })), "result_before_attempt");
  assert.equal(createSessionRecorder({ file, ...context(root), max_attempts: 1 }).beginAction({ ...attempt, action_id: "fresh" }).replayed, false);
  rec.end("done");
  assert.equal(verifyManagedLedgerFile(file).integrity, "valid");
});

test("COORD-860 a waiting writer serializes across processes on the shared lock and secrets stay out", async () => {
  const root = tmp();
  const file = path.join(root, "COORD-492.ndjson");
  recorder(root).start("1.0.0");
  const script = `
    const ledger = require(${JSON.stringify(path.join(__dirname, "managed-auto-ledger.js"))});
    const [file, worktree, digest, id] = process.argv.slice(1);
    const rec = ledger.createSessionRecorder({ file, ticket: "COORD-492", session: "sess-1", provider: "claude", policy_digest: digest, worktree, lock_wait_ms: 10000 });
    for (let i = 0; i < 15; i += 1) rec.heartbeat();
    process.stdout.write(String(rec.beginAction({ kind: "command", tool: "Bash", decision: "allow", command: "npm test", command_class: "test", action_id: "same", attempt_id: "1" }).replayed));
  `;
  const { spawn } = require("node:child_process");
  const runs = [1, 2, 3].map((id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script, file, path.join(root, "wt"), DIGEST, String(id)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  }));
  const results = await Promise.all(runs);
  assert.deepEqual(results.map((entry) => entry.code), [0, 0, 0]);
  assert.deepEqual(results.map((entry) => entry.out).sort(), ["false", "true", "true"], "exactly one concurrent caller dispatches");
  const verdict = verifyManagedLedgerFile(file);
  assert.equal(verdict.integrity, "valid", JSON.stringify(verdict.issues));
  assert.equal(readManagedLedger(file).entries.length, 1 + 45 + 1);
  assert.equal(ledger.isSensitiveText(`token=${CANARY_INPUT}`), true);
  assert.equal(ledger.isSensitiveText(`plain ${CANARY_INPUT}`, [CANARY_INPUT]), true);
  assert.equal(ledger.isSensitiveText("plain words"), false);
});
