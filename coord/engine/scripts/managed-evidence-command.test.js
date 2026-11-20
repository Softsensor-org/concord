// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntime();
"use strict";

// COORD-860: production-path tests for `gov record-managed-evidence` and the
// review/landing gate it feeds. Every scenario drives the real CLI dispatcher
// against a sandboxed governed fixture (board, plan record, journal), a real
// temporary Git worktree, the production managed session recorder and the
// shared review readiness collector.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { state: governanceState } = require("./governance-context.js");
const testUtils = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const lifecycle = require("./lifecycle.js");
const { startManagedSession, managedEvidencePaths } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/managed-auto-runner.js"));
const { CapabilityBroker } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/capability-broker.js"));
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

const { __testing, executeCommand, withRegisterPromptHarness, createTempGitRepo } = testUtils;
const TICKET = "IMP-860";
const OWNER = "claudea11";
const CANARY = "cnry-860-cli-secret-7d2e94";

function run(args, session = "c860-owner") {
  return executeCommand(args, { env: { ...process.env, COORD_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, CLAUDE_CODE_SESSION_ID: session } });
}
function runSigned(args, verb, ticket) {
  const fixture = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    const first = run(args);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(first.error || ""));
    assert.equal(first.ok, false, "bare override text must be refused");
    assert.ok(digest, first.error);
    fixture.login({ verb, ticket, subject_sha256: digest[1] });
    return withApprovalTestClient(path.resolve(__dirname, "..", ".."), fixture.client(), () => run(args));
  } finally { fixture.cleanup(); }
}

function events(command) {
  return fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((event) => !command || event.command === command);
}

function plan() {
  return JSON.parse(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${TICKET}.json`), "utf8"));
}

function managedIssues() {
  const row = JSON.parse(fs.readFileSync(governanceState.BOARD_PATH, "utf8")).sections[0].rows[0];
  return lifecycle.collectReviewPlanReadinessIssues(TICKET, row).filter((issue) => /^managed_evidence/.test(issue.code));
}

function withManagedFixture(prefix, body) {
  withRegisterPromptHarness(prefix, { ticketId: TICKET, status: "doing" }, (fixture) => {
    const repo = createTempGitRepo(`${prefix}repo-`, { "a.txt": "1\n" });
    try {
      const board = JSON.parse(fs.readFileSync(fixture.boardPath, "utf8"));
      board.sections[0].rows[0].Owner = OWNER;
      fs.writeFileSync(fixture.boardPath, `${JSON.stringify(board, null, 2)}\n`);
      __testing.advanceGovernanceProvenanceBaseline("COORD-860 managed evidence fixture setup");
      assert.equal(run(["agentid", "--owner", OWNER]).ok, true);
      assert.equal(run(["plan", TICKET, "--seed"]).ok, true);
      const files = run(["update-plan", TICKET, "--files", "a.txt"]);
      assert.equal(files.ok, true, files.error);
      const start = (extra = {}) => startManagedSession({
        ticket: TICKET, session: "sess-cli", owner: OWNER, base_sha: repo.head, worktree: repo.repoRoot,
        provider: { name: "codex", version: "1.0.0", supported: true, enforceable: ["command", "read", "write"] },
        controls: { hooks: true, sandbox: true, environment: true }, environment: { PATH: process.env.PATH, API_TOKEN: CANARY },
        runtime_dir: governanceState.RUNTIME_DIR, broker_capabilities: ["scm.submit"],
        broker_targets: [{ capability: "scm.submit", target: "origin/agent-860" }], ...extra,
      });
      body({ ...fixture, repo, start, files: managedEvidencePaths(governanceState.RUNTIME_DIR, TICKET) });
    } finally {
      fs.rmSync(repo.repoRoot, { recursive: true, force: true });
    }
  });
}

test("COORD-860: an ordinary ticket stays unmanaged — the writer refuses and the gate adds nothing", () => {
  withManagedFixture("c860-unmanaged-", () => {
    const refused = run(["record-managed-evidence", TICKET]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /stays unmanaged and keeps its existing gates/);
    assert.equal(events("record-managed-evidence").length, 0);
    assert.equal(plan().managed_execution, undefined);
    assert.deepEqual(managedIssues(), []);
    assert.match(run(["record-managed-evidence"]).error, /requires <ticket-id>/);
    // The collapsed createGates wiring still routes refusals through lifecycle's fail.
    assert.throws(() => lifecycle.commands.addRepoGateCommand(), /add-repo-gate requires <ticket-id>/);
    assert.throws(() => lifecycle.commands.addRepoGateCommand(TICKET, { commandText: "npm test", gateBaseResult: "pass" }), /--base-result requires --result/);
  });
});

test("COORD-860: a complete managed session records only the redacted summary in plan and journal, once", () => {
  withManagedFixture("c860-complete-", ({ repo, start, files }) => {
    const session = start();
    session.writeFile("a.txt", "2\n", { action_id: "edit" });
    session.commit("edit a", { action_id: "commit" });
    session.requestCapability(new CapabilityBroker({ ticket: TICKET, execute: () => ({ result: "completed", external_id: "pr-42" }) }),
      { capability: "scm.submit", target: "origin/agent-860", approved: true }, { action_id: "submit" });
    assert.deepEqual(managedIssues().map((issue) => issue.code), ["managed_evidence_missing"], "a session with no summary blocks review");
    session.end("done");
    const dry = run(["record-managed-evidence", TICKET, "--dry-run"]);
    assert.equal(dry.ok, true, dry.error);
    assert.equal(JSON.parse(dry.stdout).status, "dry-run");
    assert.equal(events("record-managed-evidence").length, 0);
    const recorded = run(["record-managed-evidence", TICKET]);
    assert.equal(recorded.ok, true, recorded.error);
    const output = JSON.parse(recorded.stdout);
    assert.equal(output.status, "recorded");
    assert.match(output.claim_limit, /not a legal waiver or a universal observation guarantee/);
    const stored = plan().managed_execution;
    assert.equal(stored.summary.verdict, "complete", JSON.stringify(stored.summary));
    assert.equal(stored.exception, null);
    assert.equal(stored.actor, OWNER);
    const [event] = events("record-managed-evidence");
    assert.deepEqual(event.details.summary, stored.summary, "the journal carries the same summary anchored to the chain root");
    assert.equal(event.details.summary.chain_root, JSON.parse(fs.readFileSync(files.ledger, "utf8").trim().split("\n").at(-1)).hash);
    for (const text of [JSON.stringify(stored), JSON.stringify(event), fs.readFileSync(governanceState.PLAN_PATH, "utf8")]) {
      for (const leak of [CANARY, "pr-42", "origin/agent-860", "a.txt\"", repo.repoRoot]) assert.equal(text.includes(leak), false, leak);
    }
    assert.match(fs.readFileSync(governanceState.PLAN_PATH, "utf8"), /- Managed execution:/);
    assert.deepEqual(managedIssues(), []);
    // Identical retry: unchanged, no second journal event.
    assert.equal(JSON.parse(run(["record-managed-evidence", TICKET]).stdout).status, "unchanged");
    assert.equal(events("record-managed-evidence").length, 1);
    // Changed Git state after recording stales the summary until it is reconciled again.
    fs.writeFileSync(path.join(repo.repoRoot, "stray.txt"), "s\n");
    assert.deepEqual(managedIssues().map((issue) => issue.code), ["managed_evidence_stale"]);
    const rerecorded = JSON.parse(run(["record-managed-evidence", TICKET]).stdout);
    assert.equal(rerecorded.summary.verdict, "unexplained");
    assert.deepEqual(rerecorded.summary.unexplained, ["out_of_scope_file:file", "unexplained_file_change:file"]);
    assert.deepEqual(managedIssues().map((issue) => issue.code), ["managed_evidence_incomplete"]);
    // Returning to the earlier evidence is a new write, not a replay of the first one.
    fs.rmSync(path.join(repo.repoRoot, "stray.txt"));
    assert.equal(JSON.parse(run(["record-managed-evidence", TICKET]).stdout).status, "recorded");
    assert.equal(plan().managed_execution.summary.summary_digest, stored.summary.summary_digest);
    assert.deepEqual(managedIssues(), []);
  });
});

test("COORD-860: a human-admin technical exception binds exactly the named gaps, reason and residual risk", () => {
  withManagedFixture("c860-exception-", ({ start, files }) => {
    const session = start();
    session.writeFile("a.txt", "2\n", { action_id: "edit" });
    session.interrupt("adapter crashed");
    assert.equal(JSON.parse(run(["record-managed-evidence", TICKET]).stdout).summary.verdict, "incomplete");
    const named = plan().managed_execution.summary.gaps.join(",");
    assert.ok(named.includes("coverage_interrupted"));
    const base = ["record-managed-evidence", TICKET, "--human-admin-override", "human admin approved the adapter outage"];
    assert.match(run([...base, "--gaps", named]).error, /requires --reason and --risk/);
    assert.match(run([...base, "--reason", "outage", "--risk", "unobserved tail", "--gaps", "coverage_interrupted"]).error, /must name exactly the current gaps/);
    assert.match(run([...base, "--reason", "outage", "--risk", "unobserved tail"]).error, /must name exactly the current gaps/);
    assert.match(run([...base, "--reason", `token=${CANARY}`, "--risk", "r", "--gaps", named]).error, /no secret or credential shape/);
    assert.match(run(["record-managed-evidence", TICKET, "--reason", "r", "--risk", "r", "--gaps", named]).error, /requires --human-admin-override/);
    assert.equal(events("record-managed-evidence").length, 1);
    const excepted = runSigned([...base, "--reason", "adapter outage during a docs-only edit", "--risk", "an unobserved write after the crash", "--gaps", named],
      "record-managed-evidence technical exception", TICKET);
    assert.equal(excepted.ok, true, excepted.error);
    const stored = plan().managed_execution;
    assert.equal(stored.summary.verdict, "incomplete", "the exception never rewrites the verdict");
    assert.equal(stored.exception.legal_waiver, false);
    assert.equal(stored.exception.summary_digest, stored.summary.summary_digest);
    assert.equal(stored.exception.residual_risk, "an unobserved write after the crash");
    assert.deepEqual(managedIssues(), []);
    const [, event] = events("record-managed-evidence");
    assert.deepEqual(event.details.exception, stored.exception);
    assert.ok(event.details.approval_record);
    // Re-running the same exception is unchanged; a plain re-record keeps it.
    assert.equal(JSON.parse(run([...base, "--reason", "adapter outage during a docs-only edit", "--risk", "an unobserved write after the crash", "--gaps", named]).stdout).status, "unchanged");
    assert.equal(JSON.parse(run(["record-managed-evidence", TICKET]).stdout).status, "unchanged");
    // New evidence invalidates the exception; it is not carried to a new summary.
    fs.appendFileSync(files.ledger, "");
    session.recorder.heartbeat();
    const fresh = JSON.parse(run(["record-managed-evidence", TICKET]).stdout);
    assert.equal(fresh.status, "recorded");
    assert.equal(plan().managed_execution.exception, null);
    assert.equal(managedIssues()[0].code, "managed_evidence_incomplete");
  });
});

test("COORD-860: an exception on complete evidence and a failed plan write leave nothing behind", () => {
  withManagedFixture("c860-refusals-", ({ start }) => {
    const session = start();
    session.writeFile("a.txt", "2\n", { action_id: "edit" });
    session.end("done");
    const exception = run(["record-managed-evidence", TICKET, "--human-admin-override", "x", "--reason", "r", "--risk", "r", "--gaps", "none"]);
    assert.match(exception.error, /is complete; there is nothing to except/);
    const before = fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${TICKET}.json`), "utf8");
    const journalBefore = fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    fs.chmodSync(governanceState.PLAN_RECORDS_DIR, 0o555);
    let failed;
    try {
      failed = run(["record-managed-evidence", TICKET]);
    } finally {
      fs.chmodSync(governanceState.PLAN_RECORDS_DIR, 0o755);
    }
    assert.equal(failed.ok, false);
    assert.equal(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${TICKET}.json`), "utf8"), before, "the plan record rolled back");
    assert.equal(events("record-managed-evidence").length, 0);
    assert.equal(fs.readFileSync(governanceState.GOVERNANCE_EVENT_LOG_PATH, "utf8").split("\n").filter((line) => line.includes("record-managed-evidence") && line.includes('"succeeded"')).length,
      journalBefore.split("\n").filter((line) => line.includes("record-managed-evidence") && line.includes('"succeeded"')).length);
  });
});

test("COORD-860: evidence that changes during the write, unknown tickets and plan writer refusals fail closed", () => {
  const createCommand = require("./managed-evidence-command.js");
  const os = require("node:os");
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "c860-unit-"));
  const files = managedEvidencePaths(runtime, "COORD-1");
  fs.mkdirSync(path.dirname(files.policy), { recursive: true });
  fs.writeFileSync(files.policy, "{}");
  let planReads = 0;
  const identity = { agent: { handle: "claudea12" } };
  const make = (over = {}) => createCommand({
    fail: (message) => { throw new Error(message); },
    readBoard: () => ({}),
    getTicketRef: () => ({ row: { Owner: "claudea12" } }),
    // The second read happens under the mutex: a concurrent append lands first.
    readPlanState: () => {
      if (planReads++) fs.appendFileSync(files.ledger, `${JSON.stringify({ schema: "coord.auto-mode.ledger/v1", sequence: planReads })}\n`);
      return { ticket_id: "COORD-1" };
    },
    updateCanonicalPlanState: () => ({}),
    withGovernanceMutation: (_mutation, fn) => fn(),
    inferTicketStatus: () => "doing",
    ensureCurrentAgentIdentity: () => identity,
    ensureTicketMutationOwnership: () => identity,
    resolveHumanAdminOverride: () => ({ reason: "approved" }),
    state: { RUNTIME_DIR: runtime },
    ...over,
  }).recordManagedEvidenceCommand;
  const log = console.log;
  console.log = () => {};
  try {
    assert.throws(() => make({ readPlanState: () => null })("COORD-1"), /requires an existing plan record/);
    planReads = 0;
    assert.throws(() => make()("COORD-1"), /changed during the write/);
    planReads = 0;
    assert.throws(() => make({ getTicketRef: () => null })("COORD-1"), /unknown ticket COORD-1/);
    planReads = 0;
    const steady = { readPlanState: () => ({ ticket_id: "COORD-1" }) };
    assert.throws(() => make({ ...steady, updateCanonicalPlanState: () => { throw new Error("stale raw token"); } })("COORD-1"), /record-managed-evidence: stale raw token/);
    const value = make(steady)("COORD-1");
    assert.equal(value.summary.verdict, "invalid");
    assert.equal(value.exception, null);
    assert.throws(() => make(steady)("COORD-1", { humanAdminOverride: "x", reason: "r", risk: "x".repeat(501), gaps: [...value.summary.gaps].join(",") }), /at most 500 characters/);
  } finally {
    console.log = log;
  }
});
