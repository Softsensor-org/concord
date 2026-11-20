"use strict";
const { resolveEngineModule } = require("../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..");

const { state: governanceState } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));

// COORD-723: one canonical context_pack_ack contract across every lifecycle
// consumer. The CLI tests drive the real public verbs against a disposable
// workspace; nothing overrides a validator or reaches into a module.
// The in-process dispatcher test at the end runs the real writer, so this
// worker's runtime, lock and seal surfaces are relocated to os.tmpdir() first.
require("./governance-test-utils.js").sandboxProcessRuntime();

const test = require("node:test");
const assert = require("node:assert/strict");
const { retryTransferWithLogin } = require("../engine/scripts/__fixtures__/approval-fixture.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { VALID_ACK, fixture } = require("./fixtures/context-pack-ack-workspace.js");
const contract = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/context-pack-ack-contract.js"));
const { createContextPackAcknowledgementGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/context-pack-ack.js"));
const { withScopedGovernanceTestContext } = require("./governance-test-utils.js");

const CONSIDERED_FIELDS = ["active_constraints", "adrs", "business_rules", "conflicts", "stale_warnings", "open_questions"];
// The exact shape an older writer sealed: one considered.* field as a string.
const legacyAck = (field) => ({ ...VALID_ACK, considered: { ...VALID_ACK.considered, [field]: "No entry applies" } });
const canonicalViolation = (field) => `Plan record context_pack_ack.considered.${field} must be an array of strings.`;

function gate(overrides = {}) {
  return createContextPackAcknowledgementGate({
    isMeaningfulText: (value) => typeof value === "string" && value.trim() !== "",
    readBusinessContextEvidence: () => ({ refs: [], hasContextRef: false }),
    readBusinessContextPack: () => ({ ok: false, error: "unused" }),
    ticketRequiresAdrDecision: () => false,
    ticketTouchesBusinessContextRisk: () => false,
    toArray: (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]),
    ...overrides,
  });
}

// A schema-valid acknowledgement can still fail review: the shape contract says
// what an acknowledgement IS, the gate says whether it is complete and whether
// the packs it cites can be read. These run on a ticket that requires one.
test("COORD-723 a schema-valid acknowledgement is still held to its considered sections and readable pack refs", () => {
  const writer = "Rewrite the whole object through the sanctioned writer: coord/scripts/gov update-plan T-1 --context-pack-ack '<json>'";
  const sectionsSteps = [
    "Complete context_pack_ack.considered for active_constraints, adrs, business_rules, conflicts, stale_warnings, and open_questions.",
    writer,
  ];
  const requiring = (overrides = {}) => gate({ ticketTouchesBusinessContextRisk: () => true, ...overrides }).collectContextPackAcknowledgementIssues;

  // considered is optional in the schema, so an acknowledgement without it is
  // not a shape violation; the gate reports every section as unaddressed.
  const { considered, ...withoutConsidered } = VALID_ACK;
  assert.equal(contract.contextPackAckViolation(withoutConsidered), null);
  assert.deepEqual(requiring()("T-1", {}, { context_pack_ack: withoutConsidered }), [{
    code: "context_pack_ack_sections",
    message: `Plan state for T-1 context_pack_ack must explicitly say which ${CONSIDERED_FIELDS.join(", ")} were considered.`,
    next_steps: sectionsSteps,
  }]);

  // Present but incomplete: only the unaddressed sections are named, and an
  // empty or blank-only array does not count as an answer.
  const partial = { ...VALID_ACK, considered: { ...considered, conflicts: [], open_questions: ["  "] } };
  delete partial.considered.adrs;
  assert.equal(contract.contextPackAckViolation(partial), null);
  assert.deepEqual(requiring()("T-1", {}, { context_pack_ack: partial }), [{
    code: "context_pack_ack_sections",
    message: "Plan state for T-1 context_pack_ack must explicitly say which adrs, conflicts, open_questions were considered.",
    next_steps: sectionsSteps,
  }]);

  // A cited pack that cannot be read is reported by ref with the reader's own
  // error. Refs from the acknowledgement and from the plan's business-context
  // evidence are merged and each is read once.
  const reads = [];
  const packs = {
    "coord/context/readable.json": { ok: true, value: { sections: {} } },
    "coord/context/missing.json": { ok: false, error: "ENOENT: no such file" },
  };
  const withRefs = requiring({
    readBusinessContextEvidence: () => ({ refs: ["coord/context/missing.json", "coord/context/readable.json"], hasContextRef: true }),
    readBusinessContextPack: (ref) => { reads.push(ref); return packs[ref]; },
  });
  assert.deepEqual(withRefs("T-1", {}, { context_pack_ack: { ...VALID_ACK, refs: ["coord/context/readable.json"] } }), [{
    code: "context_pack_ack_ref",
    message: "Plan state for T-1 context_pack_ack references coord/context/missing.json, but it could not be read: ENOENT: no such file.",
    next_steps: ["coord/scripts/coord business-context-pack --ticket T-1 --write-default"],
  }]);
  assert.deepEqual(reads, ["coord/context/readable.json", "coord/context/missing.json"]);

  // The same complete acknowledgement passes once every cited pack is readable.
  const allReadable = requiring({ readBusinessContextPack: () => ({ ok: true, value: { sections: {} } }) });
  assert.deepEqual(allReadable("T-1", {}, { context_pack_ack: { ...VALID_ACK, refs: ["coord/context/readable.json"] } }), []);
});

test("COORD-723 the review gate and the contract reject each string-valued considered.* field with the writer's own message", () => {
  const { collectContextPackAcknowledgementIssues } = gate();
  assert.equal(contract.contextPackAckViolation(VALID_ACK), null);
  assert.deepEqual(collectContextPackAcknowledgementIssues("T-1", {}, { context_pack_ack: VALID_ACK }), []);
  assert.deepEqual(collectContextPackAcknowledgementIssues("T-1", {}, {}), [], "a ticket with no stored acknowledgement is untouched");
  for (const field of CONSIDERED_FIELDS) {
    const violation = contract.contextPackAckViolation(legacyAck(field));
    assert.ok(violation.startsWith(canonicalViolation(field)), violation);
    // This ticket does NOT require an acknowledgement (every trigger is false):
    // a malformed stored ack is rejected regardless, and reported alone.
    const issues = collectContextPackAcknowledgementIssues("T-1", {}, { context_pack_ack: legacyAck(field) });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "context_pack_ack_shape");
    assert.ok(issues[0].message.includes(violation), "the gate reports the canonical violation verbatim");
    assert.match(issues[0].next_steps.join("\n"), /repair-context-pack-ack T-1/);
    assert.deepEqual(issues[0].next_steps, [
      `${contract.repairCommand("T-1")}   # dry-run report; add --confirm to write`,
      "coord/scripts/gov scan-context-pack-acks   # read-only: every malformed acknowledgement in this workspace",
    ]);
  }
  for (const value of [{ notes: "old" }, { authority: { rejected_authority: [] } }, { closeout_learning: { decision: ["none"] } }, [], "ack"]) {
    assert.equal(collectContextPackAcknowledgementIssues("T-1", {}, { context_pack_ack: value })[0].code, "context_pack_ack_shape", JSON.stringify(value));
  }
});

test("COORD-723 scan is deterministic, read-only, and reports instead of coercing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-scan-"));
  try {
    const runtime = path.join(root, "runtime"), legacy = path.join(root, "legacy");
    fs.mkdirSync(runtime); fs.mkdirSync(legacy);
    const put = (dir, id, value) => fs.writeFileSync(path.join(dir, `${id}.json`), typeof value === "string" ? value : JSON.stringify(value));
    put(runtime, "T-3", { context_pack_ack: legacyAck("adrs") });
    put(runtime, "T-1", { context_pack_ack: VALID_ACK });
    put(runtime, "T-2", { ticket_id: "T-2" });
    put(runtime, "T-9", "{ not json");
    put(legacy, "T-0", { context_pack_ack: { notes: "old writer" } });
    // The runtime copy wins, exactly as the plan-record reader resolves it.
    put(legacy, "T-1", { context_pack_ack: legacyAck("conflicts") });
    const bytes = () => [runtime, legacy].flatMap((dir) => fs.readdirSync(dir).sort().map((name) => `${name}:${fs.readFileSync(path.join(dir, name), "utf8")}:${fs.statSync(path.join(dir, name)).mtimeMs}`));
    const before = bytes();
    const first = contract.scanContextPackAcks([runtime, legacy]);
    assert.deepEqual(contract.scanContextPackAcks([runtime, legacy]), first, "two scans of the same state are identical");
    assert.deepEqual(bytes(), before, "scan must not write, touch or normalize any record");
    assert.equal(first.records_scanned, 5);
    assert.equal(first.acknowledgements, 3);
    assert.deepEqual(first.malformed.map((entry) => entry.ticket), ["T-0", "T-3", "T-9"]);
    assert.match(first.malformed[0].violation, /unknown field "notes"/);
    assert.ok(first.malformed[1].violation.startsWith(canonicalViolation("adrs")));
    assert.deepEqual(first.malformed[1].stored, legacyAck("adrs"), "the stored value is reported as stored");
    assert.match(first.malformed[2].violation, /not valid JSON/);
    for (const entry of first.malformed) assert.match(entry.repair, new RegExp(`repair-context-pack-ack ${entry.ticket} `));
    assert.equal(contract.scanContextPackAcks([path.join(root, "absent")]).malformed_count, 0);
    // A record that parses but is not an object carries no acknowledgement: it
    // is counted, never dereferenced, and never reported as malformed.
    put(runtime, "T-5", "null");
    put(runtime, "T-6", '"a string"');
    const withScalars = contract.scanContextPackAcks([runtime, legacy]);
    assert.equal(withScalars.records_scanned, 7);
    assert.equal(withScalars.acknowledgements, first.acknowledgements);
    assert.deepEqual(withScalars.malformed, first.malformed);
    assert.deepEqual(contract.readStoredContextPackAck("T-5", [runtime, legacy]), { filePath: path.join(runtime, "T-5.json"), present: false, ack: undefined, violation: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const refusal = (f, id, before, field) => (label, result) => {
  const violation = canonicalViolation(field);
  assert.notEqual(result.status, 0, `${label} must refuse considered.${field} as a string\n${result.stdout}`);
  assert.ok(`${result.stdout}\n${result.stderr}`.includes(violation), `${label} must report the canonical violation for ${field}:\n${result.stderr}`);
  assert.deepEqual(f.snapshot(id), before, `${label} must leave plan, projection, board, journal, lock, sessions, provider log and remote untouched (${field})`);
};

test("COORD-723 writer, readiness, claim, transfer and submit refuse each string-valued considered.* field identically and before any effect", { timeout: 300000 }, () => {
  const f = fixture();
  try {
    const { cli, ok } = f.ownerSession;
    const other = f.transfereeSession;
    const id = "LANE-001";
    f.lane(id, "X");
    // Bound only now: a second live session in one runtime would otherwise trip
    // the co-located-writer guard during lane setup.
    other.ok("agentid", "--owner", f.transferee);

    for (const field of CONSIDERED_FIELDS) {
      f.sealLegacyAck(id, legacyAck(field));
      const before = f.snapshot(id);
      const refused = refusal(f, id, before, field);
      // Writer: an unrelated plan write cannot ride over the malformed ack.
      refused("update-plan (writer)", cli("update-plan", id, "--summary", "unrelated change"));
      // Readiness evaluation: read-only, so it reports rather than exits non-zero.
      const readiness = cli("guided-closeout", id, "--json");
      assert.equal(readiness.status, 0, readiness.stderr);
      assert.equal(JSON.parse(readiness.stdout).ready, false, `guided-closeout must not report ready over a malformed ${field}`);
      assert.ok(readiness.stdout.includes(canonicalViolation(field)));
      assert.ok(readiness.stdout.includes("context_pack_ack_shape"));
      assert.ok(cli("explain", id).stdout.includes(canonicalViolation(field)), "explain must surface the same blocker");
      assert.deepEqual(f.snapshot(id), before);
      // Transfer / claim: no session claim, no lock rebind, no owner write.
      refused("claim --transfer-to", other.cli("claim", id, "--transfer-to", f.transferee, "--human-admin-override", "authorized fixture transfer"));
      refused("claim", cli("claim", id));
      assert.equal(f.rowOf(id).Owner, f.owner);
      assert.equal(f.read(`.runtime/locks/${id}.lock`).owner, f.owner);
      refused("submit", cli("submit", id, "--pr", "local-review (no PR)"));
      assert.equal(f.rowOf(id).Status, "doing");
    }

    // Read-only scan: finds exactly the malformed record, changes nothing.
    const beforeScan = f.snapshot(id);
    const scan = cli("scan-context-pack-acks", "--json");
    assert.equal(scan.status, 1, "a scan that finds malformed records is a failed verdict");
    const scanned = JSON.parse(scan.stdout);
    assert.deepEqual(scanned.malformed.map((entry) => entry.ticket), [id]);
    assert.deepEqual(scanned, JSON.parse(cli("scan-context-pack-acks", "--json").stdout));
    assert.match(cli("scan-context-pack-acks").stdout, /1 malformed/);

    // Repair: dry-run by default, never derives the replacement, validates it.
    const replacement = JSON.stringify(VALID_ACK);
    const missing = cli("repair-context-pack-ack", id);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Nothing is derived from the stored value/);
    const stillInvalid = cli("repair-context-pack-ack", id, "--context-pack-ack", JSON.stringify(legacyAck("adrs")), "--confirm");
    assert.equal(stillInvalid.status, 1);
    assert.ok(stillInvalid.stderr.includes(canonicalViolation("adrs")));
    const dryRun = cli("repair-context-pack-ack", id, "--context-pack-ack", replacement);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.written, false);
    assert.deepEqual(plan.stored, legacyAck(CONSIDERED_FIELDS.at(-1)), "dry-run reports the stored value verbatim");
    assert.deepEqual(plan.replacement, VALID_ACK);
    assert.deepEqual(f.snapshot(id), beforeScan, "scan, refused repair and dry-run repair write nothing");

    // A non-owner cannot repair without separate authority; with it, the repair
    // is one journaled plan mutation and the previously refused paths open.
    assert.notEqual(other.cli("repair-context-pack-ack", id, "--context-pack-ack", replacement, "--confirm").status, 0);
    assert.deepEqual(f.snapshot(id), beforeScan);
    const applied = other.ok("repair-context-pack-ack", id, "--context-pack-ack", replacement, "--confirm", "--human-admin-override", "authorized fixture repair before transfer");
    assert.equal(JSON.parse(applied.stdout).written, true);
    assert.deepEqual(f.read(`.runtime/plans/${id}.json`).context_pack_ack, VALID_ACK);
    const events = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.at(-1).command, "update-plan");
    assert.equal(events.at(-1).ticket, id);
    const already = cli("repair-context-pack-ack", id, "--context-pack-ack", replacement);
    assert.equal(already.status, 1);
    assert.match(already.stderr, /no malformed context_pack_ack to repair/);
    assert.equal(cli("scan-context-pack-acks", "--json").status, 0);

    // Positive controls: the same commands succeed once the ack is valid, so the
    // refusals above were caused by the acknowledgement and nothing else.
    assert.equal(JSON.parse(ok("guided-closeout", id, "--json").stdout).ready, true);
    const transferred = retryTransferWithLogin(f.approval, id, () => other.approvalCli("claim", id, "--transfer-to", f.transferee, "--human-admin-override", "authorized fixture transfer"));
    assert.equal(transferred.status, 0, `${transferred.stdout}\n${transferred.stderr}`);
    assert.equal(f.rowOf(id).Owner, f.transferee);
    other.ok("submit", id, "--pr", "local-review (no PR)");
    assert.equal(f.rowOf(id).Status, "review");
  } catch (error) {
    console.error("RETAINED SANDBOX", f.root);
    throw error;
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

test("COORD-723 PR creation and PR-lane submit refuse each string-valued considered.* field before any push or provider call", { timeout: 300000 }, () => {
  const f = fixture();
  try {
    const { cli, ok } = f.ownerSession;
    const id = "BACK-001";
    f.lane(id, "B");
    for (const field of CONSIDERED_FIELDS) {
      f.sealLegacyAck(id, legacyAck(field));
      const refused = refusal(f, id, f.snapshot(id), field);
      refused("pr-create --push", cli("pr-create", id, "--title", "t", "--body", "b", "--push"));
      refused("submit (PR lane)", cli("submit", id, "--title", "t", "--body", "b"));
      assert.equal(fs.existsSync(f.ghLog), false, "gh must never be invoked for a malformed acknowledgement");
      assert.equal(f.git(f.remote, "branch", "--list").includes("agent/"), false, "no ticket branch may be published");
      assert.equal(f.rowOf(id).Status, "doing");
    }
    // Positive control: with a valid ack the SAME command reaches the provider
    // and publishes the branch, so the recording gh and the remote are live.
    ok("repair-context-pack-ack", id, "--context-pack-ack", JSON.stringify(VALID_ACK), "--confirm");
    ok("pr-create", id, "--title", "t", "--body", "b", "--push");
    assert.match(fs.readFileSync(f.ghLog, "utf8"), /^pr create /m);
    assert.ok(f.git(f.remote, "branch", "--list").includes("agent/"));
  } catch (error) {
    console.error("RETAINED SANDBOX", f.root);
    throw error;
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

// In-process contract of the scan/repair commands, so each branch is exercised
// without a child process. The CLI tests above prove the wiring.
test("COORD-723 scan and repair commands report, refuse and delegate without coercing", () => {
  const { repairContextPackAckCommand, scanContextPackAcksCommand } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/context-pack-ack-commands.js"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-unit-"));
  const fail = (message) => { throw new Error(message); };
  const captured = (fn) => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      return { result: fn(), output: lines.join("\n") };
    } finally {
      console.log = original;
    }
  };
  const priorExitCode = process.exitCode;
  try {
    const recordsDirs = [root];
    fs.writeFileSync(path.join(root, "T-1.json"), JSON.stringify({ context_pack_ack: VALID_ACK }));
    const clean = captured(() => scanContextPackAcksCommand({ recordsDirs }));
    assert.match(clean.output, /^Scanned 1 plan record\(s\); 1 carry a context_pack_ack; 0 malformed\.$/);
    assert.equal(process.exitCode, priorExitCode, "a clean scan does not fail the process");

    fs.writeFileSync(path.join(root, "T-2.json"), JSON.stringify({ context_pack_ack: legacyAck("adrs") }));
    const text = captured(() => scanContextPackAcksCommand({ recordsDirs }));
    assert.equal(process.exitCode, 1);
    assert.match(text.output, /1 malformed\.\n- T-2: Plan record context_pack_ack\.considered\.adrs must be an array of strings\..*\n {2}Record: .*T-2\.json\n {2}Repair: coord\/scripts\/gov repair-context-pack-ack T-2 /);
    const json = captured(() => scanContextPackAcksCommand({ recordsDirs, json: true }));
    assert.deepEqual(JSON.parse(json.output), json.result);

    const writes = [];
    const deps = { fail, updatePlanBlock: (ticketId, update, render) => { writes.push([ticketId, update]); render({}); } };
    const repair = (ticketId, options) => captured(() => repairContextPackAckCommand(ticketId, { recordsDirs, ...options }, deps));
    assert.throws(() => repair(undefined, {}), /requires <ticket-id>/);
    assert.throws(() => repair("T-2", {}), /Nothing is derived from the stored value/);
    assert.throws(() => repair("T-404", { contextPackAck: "none" }), /No plan record found for T-404/);
    assert.throws(() => repair("T-1", { contextPackAck: "none" }), /no malformed context_pack_ack to repair/);
    assert.throws(() => repair("T-2", { contextPackAck: "{ not json" }), /expects a JSON object \(or "none"\)/);
    assert.throws(() => repair("T-2", { contextPackAck: "[]", confirm: true }), /replacement is itself invalid/);
    assert.deepEqual(writes, [], "no refused repair reaches the writer");

    const dryRun = repair("T-2", { contextPackAck: VALID_ACK });
    assert.equal(dryRun.result.mode, "dry-run");
    assert.equal(dryRun.result.written, false);
    assert.match(dryRun.result.apply, /repair-context-pack-ack T-2 .* --confirm$/);
    assert.deepEqual(dryRun.result.stored, legacyAck("adrs"));
    assert.deepEqual(writes, [], "a dry-run never reaches the writer");

    const applied = repair("T-2", { contextPackAck: JSON.stringify(VALID_ACK), confirm: true, humanAdminOverride: "authorized" });
    assert.equal(applied.result.written, true);
    assert.deepEqual(writes.pop(), ["T-2", { contextPackAck: VALID_ACK, humanAdminOverride: "authorized" }]);
    const cleared = repair("T-2", { contextPackAck: " None ", confirm: true });
    assert.equal(cleared.result.replacement, null);
    assert.deepEqual(writes.pop(), ["T-2", { contextPackAck: "none" }], "removal is explicit, never inferred");
  } finally {
    process.exitCode = priorExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-723 the claim pre-effect assertion refuses a malformed stored acknowledgement and nothing else", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-claim-"));
  try {
    const state = { PLAN_RECORDS_DIR: path.join(root, "runtime"), LEGACY_PLAN_RECORDS_DIR: path.join(root, "legacy") };
    fs.mkdirSync(state.PLAN_RECORDS_DIR);
    const failures = [];
    const check = (ticketId, verb = "claim") => contract.assertStoredContextPackAckValid(ticketId, { state, verb, fail: (message) => failures.push(message) });
    fs.writeFileSync(path.join(state.PLAN_RECORDS_DIR, "T-1.json"), JSON.stringify({ context_pack_ack: VALID_ACK }));
    fs.writeFileSync(path.join(state.PLAN_RECORDS_DIR, "T-2.json"), JSON.stringify({ ticket_id: "T-2" }));
    check("T-1"); check("T-2"); check("T-404");
    assert.deepEqual(failures, [], "valid, absent and unrecorded acknowledgements do not block a claim");
    fs.writeFileSync(path.join(state.PLAN_RECORDS_DIR, "T-3.json"), JSON.stringify({ context_pack_ack: legacyAck("conflicts") }));
    check("T-3", "claim --transfer-to");
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes(canonicalViolation("conflicts")));
    assert.match(failures[0], /Refusing claim --transfer-to before any ownership, lock, or session change\. Repair it first: coord\/scripts\/gov repair-context-pack-ack T-3 .* --confirm$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-723 only a schema violation is reported as one; any other fault propagates", () => {
  // A fault that is not the validator's own refusal must never be flattened into
  // "malformed acknowledgement": that would send an operator to repair a record
  // that is not the problem.
  const hostile = Object.defineProperty({}, "considered", { enumerable: true, get() { throw new RangeError("unrelated fault"); } });
  assert.throws(() => contract.contextPackAckViolation(hostile), (error) => error instanceof RangeError && error.message === "unrelated fault");
  const { collectContextPackAcknowledgementIssues } = gate();
  assert.throws(() => collectContextPackAcknowledgementIssues("T-1", {}, { context_pack_ack: hostile }), RangeError);
});

// The public dispatcher in this process, against this worker's own sandboxed
// plan-record directories: default directory resolution, the default refusal
// type, and the real journaled writer behind --confirm.
test("COORD-723 scan and repair dispatch through the workspace's own records and the real plan writer", () => {
  const { __testing } = require("./governance-test-utils.js");
  const { GovernanceError } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
  const { dispatchCommand } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli.js")).__testing;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-dispatch-"));
  const runtimeDir = path.join(root, ".runtime");
  const sandbox = {
    BOARD_PATH: path.join(root, "tasks.json"),
    PLAN_PATH: path.join(root, "PLAN.md"),
    PLAN_RECORDS_DIR: path.join(root, "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(root, "legacy-plans"),
    AGENT_SESSIONS_PATH: path.join(runtimeDir, "agent_sessions.json"),
    QUESTIONS_PATH: path.join(root, "QUESTIONS.md"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  };
  fs.mkdirSync(sandbox.PLAN_RECORDS_DIR);
  fs.mkdirSync(sandbox.LEGACY_PLAN_RECORDS_DIR);
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(sandbox.BOARD_PATH, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(sandbox.PLAN_PATH, "");
  fs.writeFileSync(sandbox.AGENT_SESSIONS_PATH, "[]\n");
  fs.writeFileSync(sandbox.QUESTIONS_PATH, "## Instructions\n");
  return withScopedGovernanceTestContext(sandbox, () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  const dispatch = (...argv) => { lines.length = 0; dispatchCommand(argv[0], argv.slice(1)); return lines.join("\n"); };
  const priorExitCode = process.exitCode;
  try {
    __testing.ensureGovernanceJournalBaseline("coord723-dispatch-seed");
    __testing.ensurePlanStub("ACK-1", "X", "codexa02");
    __testing.ensurePlanStub("ACK-2", "X", "codexa02");
    const recordPath = (id) => path.join(sandbox.PLAN_RECORDS_DIR, `${id}.json`);
    // Model a record admitted by an older writer: bytes placed directly, then
    // the isolated baseline re-sealed.
    const sealed = JSON.parse(fs.readFileSync(recordPath("ACK-1"), "utf8"));
    sealed.context_pack_ack = legacyAck("adrs");
    fs.writeFileSync(recordPath("ACK-1"), `${JSON.stringify(sealed, null, 2)}\n`);
    // A legacy-directory copy of a ticket the runtime directory also holds is
    // shadowed; one that exists only there is still found.
    fs.writeFileSync(path.join(sandbox.LEGACY_PLAN_RECORDS_DIR, "ACK-2.json"), JSON.stringify({ context_pack_ack: legacyAck("conflicts") }));
    fs.writeFileSync(path.join(sandbox.LEGACY_PLAN_RECORDS_DIR, "ACK-0.json"), JSON.stringify({ context_pack_ack: { notes: "old writer" } }));
    __testing.advanceGovernanceProvenanceBaseline("coord723-dispatch-sealed-legacy-ack");
    const tracked = [recordPath("ACK-1"), recordPath("ACK-2"), path.join(sandbox.LEGACY_PLAN_RECORDS_DIR, "ACK-0.json"), sandbox.PLAN_PATH, sandbox.BOARD_PATH, sandbox.GOVERNANCE_EVENT_LOG_PATH];
    const bytes = () => tracked.map((file) => fs.readFileSync(file, "utf8"));
    const before = bytes();

    // With no directories supplied, the scan reads this workspace's runtime and
    // legacy plan-record directories, in that precedence.
    const scanned = JSON.parse(dispatch("scan-context-pack-acks", "--json"));
    assert.equal(process.exitCode, 1, "a malformed record is a failed verdict");
    assert.equal(scanned.kind, "concord.context_pack_ack_scan");
    assert.equal(scanned.records_scanned, 3);
    assert.deepEqual(scanned.malformed.map((entry) => [entry.ticket, entry.path]), [
      ["ACK-0", path.join(sandbox.LEGACY_PLAN_RECORDS_DIR, "ACK-0.json")],
      ["ACK-1", recordPath("ACK-1")],
    ]);
    assert.match(dispatch("scan-context-pack-acks"), /^Scanned 3 plan record\(s\); 2 carry a context_pack_ack; 2 malformed\.\n- ACK-0: /);

    // Refusals raise the governance error the CLI maps to exit 1.
    const refuses = (argv, pattern) => assert.throws(() => dispatch("repair-context-pack-ack", ...argv), (error) => {
      assert.ok(error instanceof GovernanceError, String(error && error.stack));
      assert.match(error.message, pattern);
      return true;
    });
    const replacement = JSON.stringify(VALID_ACK);
    refuses([], /requires <ticket-id>/);
    refuses(["ACK-1"], /Nothing is derived from the stored value/);
    refuses(["ACK-404", "--context-pack-ack", replacement, "--confirm"], /No plan record found for ACK-404/);
    refuses(["ACK-2", "--context-pack-ack", replacement, "--confirm"], /no malformed context_pack_ack to repair/);
    refuses(["ACK-1", "--context-pack-ack", JSON.stringify(legacyAck("conflicts")), "--confirm"], /replacement is itself invalid: Plan record context_pack_ack\.considered\.conflicts must be an array of strings/);
    refuses(["ACK-1", "--context-pack-ack", "{ not json", "--confirm"], /expects a JSON object \(or "none"\)/);

    const dryRun = JSON.parse(dispatch("repair-context-pack-ack", "ACK-1", "--context-pack-ack", replacement));
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.written, false);
    assert.equal(dryRun.path, recordPath("ACK-1"));
    assert.deepEqual(dryRun.stored, legacyAck("adrs"));
    assert.deepEqual(dryRun.replacement, VALID_ACK);
    assert.deepEqual(bytes(), before, "scan, every refused repair and the dry-run leave record, projection, board and journal byte-identical");

    const journal = () => fs.readFileSync(sandbox.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const eventsBefore = journal().length;
    const applied = JSON.parse(dispatch("repair-context-pack-ack", "ACK-1", "--context-pack-ack", replacement, "--confirm"));
    assert.equal(applied.mode, "apply");
    assert.equal(applied.written, true);
    assert.equal(applied.apply, undefined, "an applied repair does not advertise itself as pending");
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath("ACK-1"), "utf8")).context_pack_ack, VALID_ACK);
    const events = journal();
    assert.equal(events.length, eventsBefore + 1, "exactly one journaled mutation");
    assert.equal(events.at(-1).command, "update-plan");
    assert.equal(events.at(-1).ticket, "ACK-1");
    assert.equal(bytes()[1], before[1], "the neighbouring ticket's record is untouched");
    refuses(["ACK-1", "--context-pack-ack", replacement], /no malformed context_pack_ack to repair/);

    // "none" removes the acknowledgement of a record the scan still reports.
    fs.rmSync(path.join(sandbox.LEGACY_PLAN_RECORDS_DIR, "ACK-0.json"));
    sealed.context_pack_ack = legacyAck("open_questions");
    fs.writeFileSync(recordPath("ACK-1"), `${JSON.stringify(sealed, null, 2)}\n`);
    __testing.advanceGovernanceProvenanceBaseline("coord723-dispatch-resealed-legacy-ack");
    const cleared = JSON.parse(dispatch("repair-context-pack-ack", "ACK-1", "--context-pack-ack", "none", "--confirm"));
    assert.equal(cleared.replacement, null);
    assert.equal(cleared.written, true);
    assert.equal("context_pack_ack" in JSON.parse(fs.readFileSync(recordPath("ACK-1"), "utf8")), false);

    process.exitCode = priorExitCode;
    assert.equal(JSON.parse(dispatch("scan-context-pack-acks", "--json")).malformed_count, 0);
    assert.equal(process.exitCode, priorExitCode, "a clean workspace scan does not fail the process");
  } finally {
    console.log = originalLog;
    process.exitCode = priorExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  }
  });
});
